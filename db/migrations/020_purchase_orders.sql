-- Purchase orders tab: one place to build a vendor order (jt.prep_orders, the same orders Incoming Inventory shows)
-- and fill it from the vendor's invoice PDF. The PDF is read in the browser; its lines are saved as the order's
-- invoice (jt.invoices / jt.invoice_lines, linked by prep_orders.invoice_id), each with the Shopify product it was
-- matched to, and the matched lines become the order's lines. Lines that couldn't be matched stay on the invoice only.
--
--   jt.invoice_lines.dest / amazon_sku   where that line's stock goes (prep center + listing, or the Shopify store)
--   jt.invoice_files                     the PDF itself, stored base64 in parts small enough for one database reply
--   jt.po_save                           order + invoice + remembered matches, in one transaction
--   jt.remember_vendor_items             vendor item code -> variant, so the next invoice matches by itself
--   jt.po_delete                         a draft order, and its invoice if nothing else uses it

alter table jt.invoice_lines add column if not exists dest text not null default 'prep';
alter table jt.invoice_lines add column if not exists amazon_sku text not null default '';
alter table jt.invoice_lines drop constraint if exists invoice_lines_dest_check;
alter table jt.invoice_lines add constraint invoice_lines_dest_check check (dest in ('prep', 'shopify'));

alter table jt.invoices add column if not exists file_type text not null default '';
alter table jt.invoices add column if not exists file_size integer;
alter table jt.invoices add column if not exists file_parts integer not null default 0;   -- parts stored (0 = no file)

create table if not exists jt.invoice_files (
  invoice_id  bigint not null references jt.invoices (id) on delete cascade,
  part        integer not null check (part >= 0),
  data        text not null,                                -- base64
  primary key (invoice_id, part)
);

-- Invoice save now keeps each line's destination.
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
      subtotal = nullif(p->>'subtotal', '')::numeric, notes = coalesce(p->>'notes', ''), po_no = coalesce(p->>'po_no', po_no),
      stage_at = case when stage is distinct from coalesce(nullif(p->>'stage', ''), stage) then now() else stage_at end,
      stage = coalesce(nullif(p->>'stage', ''), stage), updated_at = now()
    where id = v_id;
    delete from jt.invoice_lines where invoice_id = v_id;
  else
    insert into jt.invoices (vendor, invoice_no, invoice_date, file_name, subtotal, notes, po_no, stage)
    values (coalesce(p->>'vendor', ''), coalesce(p->>'invoice_no', ''), nullif(p->>'invoice_date', '')::date,
            coalesce(p->>'file_name', ''), nullif(p->>'subtotal', '')::numeric, coalesce(p->>'notes', ''),
            coalesce(p->>'po_no', ''), coalesce(nullif(p->>'stage', ''), 'new'))
    returning id into v_id;
  end if;
  insert into jt.invoice_lines (invoice_id, line_no, item_code, upc, description, qty, unit_cost, amount,
                                variant_id, match_how, update_cost, new_price, dest, amazon_sku)
  select v_id, x.n::int, coalesce(x.e->>'item_code', ''), coalesce(x.e->>'upc', ''), coalesce(x.e->>'description', ''),
         nullif(x.e->>'qty', '')::numeric, nullif(x.e->>'unit_cost', '')::numeric, nullif(x.e->>'amount', '')::numeric,
         nullif(x.e->>'variant_id', '')::bigint, coalesce(x.e->>'match_how', ''),
         coalesce((x.e->>'update_cost')::boolean, true), nullif(x.e->>'new_price', '')::numeric,
         case when x.e->>'dest' = 'shopify' then 'shopify' else 'prep' end, coalesce(x.e->>'amazon_sku', '')
  from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) with ordinality x(e, n);
  return v_id;
end $$;

-- p = {vendor, items: [{item_code, variant_id}]}. Codes are normalized; the last one given for a code wins.
create or replace function jt.remember_vendor_items(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare v text := coalesce(p->>'vendor', ''); n integer;
begin
  if v = '' then return 0; end if;
  insert into jt.vendor_items (vendor, item_code, variant_id)
  select distinct on (jt.norm_code(x.e->>'item_code')) v, jt.norm_code(x.e->>'item_code'), (x.e->>'variant_id')::bigint
  from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) with ordinality x(e, i)
  where jt.norm_code(x.e->>'item_code') <> '' and nullif(x.e->>'variant_id', '') is not null
  order by jt.norm_code(x.e->>'item_code'), x.i desc
  on conflict (vendor, item_code) do update set variant_id = excluded.variant_id, updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Save a purchase order with its invoice. p = {order: {...jt.prep_order_save body}, invoice: {...jt.save_invoice body} | null,
-- remember: [{item_code, variant_id}], by}. An invoice already applied on the Invoices tab keeps its lines.
-- Returns {order_id, invoice_id}.
create or replace function jt.po_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o jsonb := coalesce(p->'order', '{}'::jsonb); i jsonb := p->'invoice'; inv bigint; ord bigint; st text;
begin
  if i is not null and jsonb_typeof(i) = 'object' then
    inv := nullif(i->>'id', '')::bigint;
    if inv is not null then select status into st from jt.invoices where id = inv; end if;
    if inv is null or st is distinct from 'applied' then
      inv := jt.save_invoice(i || jsonb_build_object('po_no', coalesce(o->>'po_no', i->>'po_no', '')));
    end if;
    o := o || jsonb_build_object('invoice_id', inv);
  end if;
  ord := jt.prep_order_save(o || jsonb_build_object('by', coalesce(p->>'by', '')));
  perform jt.remember_vendor_items(jsonb_build_object('vendor', (select vendor from jt.prep_orders where id = ord), 'items', coalesce(p->'remember', '[]'::jsonb)));
  return jsonb_build_object('order_id', ord, 'invoice_id', (select invoice_id from jt.prep_orders where id = ord));
end $$;

-- One part of an invoice's PDF. p = {invoice_id, part, parts, data (base64), name, type, size}.
-- Part 0 replaces whatever file the invoice had.
create or replace function jt.invoice_file_put(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare inv bigint := (p->>'invoice_id')::bigint; k integer := (p->>'part')::integer; n integer := (p->>'parts')::integer;
begin
  if not exists (select 1 from jt.invoices where id = inv) then raise exception 'invoice % not found', inv; end if;
  if k < 0 or n < 1 or k >= n or n > 400 then raise exception 'bad file part % of %', k, n; end if;
  if length(coalesce(p->>'data', '')) > 200000 then raise exception 'file part too large'; end if;
  if k = 0 then
    delete from jt.invoice_files where invoice_id = inv;
    update jt.invoices set file_parts = 0, file_name = coalesce(nullif(p->>'name', ''), file_name),
      file_type = coalesce(p->>'type', ''), file_size = nullif(p->>'size', '')::integer where id = inv;
  end if;
  insert into jt.invoice_files (invoice_id, part, data) values (inv, k, p->>'data')
  on conflict (invoice_id, part) do update set data = excluded.data;
  if k = n - 1 then update jt.invoices set file_parts = n, updated_at = now() where id = inv; end if;
  return k;
end $$;

-- Delete a draft (not yet received) order; its invoice goes too if it's a draft no other order uses.
create or replace function jt.po_delete(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; inv bigint;
begin
  select invoice_id into inv from jt.prep_orders where id = ord;
  if not jt.prep_order_delete(jsonb_build_object('id', ord)) then return false; end if;
  if inv is not null and not exists (select 1 from jt.prep_orders where invoice_id = inv) then
    delete from jt.invoices where id = inv and status = 'draft';
  end if;
  return true;
end $$;

revoke all on function jt.remember_vendor_items(jsonb), jt.po_save(jsonb), jt.invoice_file_put(jsonb), jt.po_delete(jsonb) from public;

create or replace function public.jt_po_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.po_save(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_invoice_file_put(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_file_put(p);
end $$;
create or replace function public.jt_po_delete(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.po_delete(p);
end $$;
revoke all on function public.jt_po_save(jsonb), public.jt_invoice_file_put(jsonb), public.jt_po_delete(jsonb) from public, anon;
grant execute on function public.jt_po_save(jsonb), public.jt_invoice_file_put(jsonb), public.jt_po_delete(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.invoice_files to jt_reader;
  end if;
end $$;
