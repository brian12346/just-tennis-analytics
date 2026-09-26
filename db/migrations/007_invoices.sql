-- Vendor invoices: upload a PDF in the dashboard's Invoices tab, match its lines to Shopify variants, and use the
-- invoice costs to update Shopify costs (and, when approved, retail prices).
--
--   jt.invoices / jt.invoice_lines   one saved invoice and its lines (as read from the PDF, corrected by hand)
--   jt.vendor_items                  remembered matches: vendor + vendor item code -> variant (reused on later invoices)
--   jt.price_rules                   per-vendor pricing: target margin and rounding for suggested prices
--   jt.cost_updates.new_price        price changes ride the same queue the sync writes to Shopify

alter table jt.variants add column if not exists barcode text;                -- UPC/EAN from Shopify (catalog sync)
create index if not exists variants_barcode_idx on jt.variants (barcode) where barcode is not null and barcode <> '';

create table if not exists jt.invoices (
  id            bigserial primary key,
  vendor        text not null default '',
  invoice_no    text not null default '',
  invoice_date  date,
  file_name     text not null default '',
  subtotal      numeric(12,2),
  status        text not null default 'draft' check (status in ('draft', 'applied')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  applied_at    timestamptz,
  notes         text not null default ''
);
create unique index if not exists invoices_vendor_no_idx on jt.invoices (lower(vendor), lower(invoice_no)) where invoice_no <> '';

create table if not exists jt.invoice_lines (
  invoice_id      bigint not null references jt.invoices (id) on delete cascade,
  line_no         integer not null,
  item_code       text not null default '',
  upc             text not null default '',
  description     text not null default '',
  qty             numeric(12,2),
  unit_cost       numeric(12,4),
  amount          numeric(12,2),
  variant_id      bigint,                     -- matched Shopify variant (null = not matched)
  match_how       text not null default '',   -- remembered | sku | upc | title | manual
  update_cost     boolean not null default true,
  new_price       numeric(12,2),              -- retail price to set in Shopify (null = leave the price alone)
  primary key (invoice_id, line_no)
);
create index if not exists invoice_lines_variant_idx on jt.invoice_lines (variant_id);

create table if not exists jt.vendor_items (
  vendor      text not null,
  item_code   text not null,                  -- normalized: upper case, letters and digits only
  variant_id  bigint not null,
  updated_at  timestamptz not null default now(),
  primary key (vendor, item_code)
);

create table if not exists jt.price_rules (
  vendor      text primary key,               -- '*' = default for vendors without their own rule
  margin      numeric(5,4),                   -- target gross margin, e.g. 0.4000; null = keep each item's current margin
  rounding    text not null default '.99' check (rounding in ('.99', '.95', '.00', 'none')),
  updated_at  timestamptz not null default now()
);
insert into jt.price_rules (vendor, margin, rounding) values ('*', null, '.99') on conflict do nothing;

-- Price changes use the cost queue: a row can carry a new cost, a new price, or both.
alter table jt.cost_updates add column if not exists new_price numeric(12,2) check (new_price is null or new_price >= 0);
alter table jt.cost_updates add column if not exists product_id bigint;
alter table jt.cost_updates add column if not exists invoice_id bigint;
alter table jt.cost_updates alter column new_cost drop not null;
do $$ begin
  alter table jt.cost_updates add constraint cost_updates_something check (new_cost is not null or new_price is not null);
exception when duplicate_object then null; end $$;

create or replace function jt.norm_code(t text) returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(t, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- Save an invoice with its lines (new, or replacing the lines of an existing draft). Returns the invoice id.
-- p = {id?, vendor, invoice_no, invoice_date, file_name, subtotal, notes,
--      lines: [{item_code, upc, description, qty, unit_cost, amount, variant_id, match_how, update_cost, new_price}]}
create or replace function jt.save_invoice(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint := nullif(p->>'id', '')::bigint; v_status text;
begin
  if v_id is not null then
    select status into v_status from jt.invoices where id = v_id;
    if v_status is null then raise exception 'invoice % not found', v_id; end if;
    if v_status = 'applied' then raise exception 'invoice % was already applied; it can''t be changed', v_id; end if;
    update jt.invoices set vendor = coalesce(p->>'vendor', ''), invoice_no = coalesce(p->>'invoice_no', ''),
      invoice_date = nullif(p->>'invoice_date', '')::date, file_name = coalesce(p->>'file_name', file_name),
      subtotal = nullif(p->>'subtotal', '')::numeric, notes = coalesce(p->>'notes', ''), updated_at = now()
    where id = v_id;
    delete from jt.invoice_lines where invoice_id = v_id;
  else
    insert into jt.invoices (vendor, invoice_no, invoice_date, file_name, subtotal, notes)
    values (coalesce(p->>'vendor', ''), coalesce(p->>'invoice_no', ''), nullif(p->>'invoice_date', '')::date,
            coalesce(p->>'file_name', ''), nullif(p->>'subtotal', '')::numeric, coalesce(p->>'notes', ''))
    returning id into v_id;
  end if;
  insert into jt.invoice_lines (invoice_id, line_no, item_code, upc, description, qty, unit_cost, amount,
                                variant_id, match_how, update_cost, new_price)
  select v_id, x.n::int, coalesce(x.e->>'item_code', ''), coalesce(x.e->>'upc', ''), coalesce(x.e->>'description', ''),
         nullif(x.e->>'qty', '')::numeric, nullif(x.e->>'unit_cost', '')::numeric, nullif(x.e->>'amount', '')::numeric,
         nullif(x.e->>'variant_id', '')::bigint, coalesce(x.e->>'match_how', ''),
         coalesce((x.e->>'update_cost')::boolean, true), nullif(x.e->>'new_price', '')::numeric
  from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) with ordinality x(e, n);
  return v_id;
end $$;

-- Apply a saved invoice: remember its matches, queue cost (and approved price) updates for Shopify, mark it applied.
-- Returns the number of variants queued.
create or replace function jt.apply_invoice(p_id bigint) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_vendor text; v_status text; n integer;
begin
  select vendor, status into v_vendor, v_status from jt.invoices where id = p_id for update;
  if v_status is null then raise exception 'invoice % not found', p_id; end if;
  if v_status = 'applied' then raise exception 'invoice % was already applied', p_id; end if;

  -- remember vendor item code -> variant for the next invoice
  insert into jt.vendor_items (vendor, item_code, variant_id)
  select distinct on (jt.norm_code(l.item_code)) v_vendor, jt.norm_code(l.item_code), l.variant_id
  from jt.invoice_lines l
  where l.invoice_id = p_id and l.variant_id is not null and jt.norm_code(l.item_code) <> '' and v_vendor <> ''
  order by jt.norm_code(l.item_code), l.line_no desc
  on conflict (vendor, item_code) do update set variant_id = excluded.variant_id, updated_at = now();

  -- one queued update per variant (a variant on two lines: the last line wins)
  with pick as (
    select distinct on (l.variant_id) l.variant_id,
           case when l.update_cost and l.unit_cost is not null then round(l.unit_cost, 2) end as new_cost,
           l.new_price
    from jt.invoice_lines l
    where l.invoice_id = p_id and l.variant_id is not null
      and ((l.update_cost and l.unit_cost is not null) or l.new_price is not null)
    order by l.variant_id, l.line_no desc
  ), rep as (
    update jt.cost_updates u set status = 'replaced'
    where u.status = 'pending' and u.variant_id in (select variant_id from pick)
  )
  insert into jt.cost_updates (variant_id, inventory_item_id, product_id, old_cost, new_cost, new_price, invoice_id)
  select v.variant_id, v.inventory_item_id, v.product_id, v.unit_cost, p.new_cost, p.new_price, p_id
  from pick p join jt.variants v on v.variant_id = p.variant_id;
  get diagnostics n = row_count;

  update jt.invoices set status = 'applied', applied_at = now(), updated_at = now() where id = p_id;
  if n > 0 and to_regprocedure('jt.dispatch_sync(text)') is not null then
    perform jt.dispatch_sync('cost-updates');
  end if;
  return n;
end $$;

create or replace function jt.delete_invoice(p_id bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from jt.invoices where id = p_id and status = 'draft';
  return found;
end $$;

-- p = {vendor, margin (0..1 or null), rounding}
create or replace function jt.save_price_rule(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p->>'vendor', '') = '' then raise exception 'vendor is required'; end if;
  insert into jt.price_rules (vendor, margin, rounding)
  values (p->>'vendor', nullif(p->>'margin', '')::numeric, coalesce(nullif(p->>'rounding', ''), '.99'))
  on conflict (vendor) do update set margin = excluded.margin, rounding = excluded.rounding, updated_at = now();
  return true;
end $$;

revoke all on function jt.save_invoice(jsonb), jt.apply_invoice(bigint), jt.delete_invoice(bigint), jt.save_price_rule(jsonb) from public;

-- Web dashboard entry points (same access rule as the other jt_* functions).
create or replace function public.jt_save_invoice(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.save_invoice(p);
end $$;
create or replace function public.jt_apply_invoice(p_id bigint) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.apply_invoice(p_id);
end $$;
create or replace function public.jt_delete_invoice(p_id bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.delete_invoice(p_id);
end $$;
create or replace function public.jt_save_price_rule(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.save_price_rule(p);
end $$;
revoke all on function public.jt_save_invoice(jsonb), public.jt_apply_invoice(bigint), public.jt_delete_invoice(bigint),
  public.jt_save_price_rule(jsonb) from public, anon;
grant execute on function public.jt_save_invoice(jsonb), public.jt_apply_invoice(bigint), public.jt_delete_invoice(bigint),
  public.jt_save_price_rule(jsonb) to authenticated;

-- Dashboard reads (jt_sql runs as jt_reader).
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.invoices, jt.invoice_lines, jt.vendor_items, jt.price_rules to jt_reader;
  end if;
end $$;
