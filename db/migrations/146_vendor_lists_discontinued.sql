-- Vendor pricelists, availability and discontinued products (Brian, Oct 14: "vendor pricelist and product
-- availability … easily flag low inventory items that are discontinued and not show them … a different bucket
-- altogether — track their inventory value and when they truly go out of stock so you know to discontinue the product").
--
-- Sources: uploaded vendor files (Excel / CSV), dealer portals read by Claude through Chrome, and marking a product in
-- Seller Sage. Each pricelist is kept (jt.vendor_price_lists + rows); jt.product_status holds each product's current
-- state: discontinued or not (and who / what said so), the vendor's list cost, MSRP and availability.
-- A product marked discontinued by hand stays so until someone unmarks it; one a pricelist called discontinued goes back
-- to active when a later list says it's available again.
-- jt.v_variant_stock: on hand per product (Shopify store, prep center, Amazon FBA + transfer + inbound + AWD).
-- jt.discontinued_view(): the Discontinued page — discontinued products (selling through / sold out) and "maybe"
-- ones (missing from the vendor's latest complete pricelist). Sold out = nothing on hand anywhere; once that's so and
-- the product is still active in Shopify, the to do list suggests archiving it (jt.todo_suggestions, kind 'discont').

create table if not exists jt.vendor_price_lists (
  id           bigserial primary key,
  vendor       text not null,
  name         text not null default '',
  file_name    text not null default '',
  source       text not null default 'file',          -- file | portal | manual
  full_list    boolean not null default false,         -- the vendor's complete list: products missing from it may be discontinued
  effective_on date,
  rows         integer not null default 0,
  matched      integer not null default 0,
  uploaded_at  timestamptz not null default now(),
  uploaded_by  text not null default ''
);
create table if not exists jt.vendor_price_rows (
  list_id      bigint not null references jt.vendor_price_lists (id) on delete cascade,
  line_no      integer not null,
  item_code    text not null default '',
  upc          text not null default '',
  description  text not null default '',
  cost         numeric(12,4),
  msrp         numeric(12,2),
  status       text not null default '',                -- active | discontinued | backorder | unavailable | '' (not given)
  avail_qty    integer,
  eta          date,
  variant_id   bigint,
  match_how    text not null default '',
  primary key (list_id, line_no)
);
create index if not exists vendor_price_rows_variant on jt.vendor_price_rows (variant_id);

create table if not exists jt.product_status (
  variant_id    bigint primary key,
  discontinued  boolean not null default false,
  disc_since    date,
  disc_source   text not null default '',               -- manual | pricelist | portal
  disc_by       text not null default '',
  note          text not null default '',
  list_cost     numeric(12,4),
  msrp          numeric(12,2),
  availability  text not null default '',
  avail_qty     integer,
  eta           date,
  list_id       bigint,
  list_at       timestamptz,
  updated_at    timestamptz not null default now()
);

-- save a pricelist (rows already matched by the page, variant_id set where it found the product)
create or replace function jt.price_list_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare lid bigint; who text := coalesce(p->>'by', ''); src text := coalesce(nullif(p->>'source', ''), 'file');
        n int; nm int; ndisc int := 0; nback int := 0;
begin
  if coalesce(btrim(p->>'vendor'), '') = '' then raise exception 'a pricelist needs its vendor'; end if;
  insert into jt.vendor_price_lists (vendor, name, file_name, source, full_list, effective_on, uploaded_by)
  values (btrim(p->>'vendor'), coalesce(p->>'name', ''), coalesce(p->>'file_name', ''), src, coalesce((p->>'full_list')::boolean, false),
          nullif(p->>'effective_on', '')::date, who)
  returning id into lid;
  insert into jt.vendor_price_rows (list_id, line_no, item_code, upc, description, cost, msrp, status, avail_qty, eta, variant_id, match_how)
  select lid, (r.ord)::int, coalesce(r.x->>'item_code', ''), coalesce(r.x->>'upc', ''), coalesce(r.x->>'description', ''),
         nullif(r.x->>'cost', '')::numeric, nullif(r.x->>'msrp', '')::numeric, coalesce(r.x->>'status', ''),
         nullif(r.x->>'avail_qty', '')::numeric::int, nullif(r.x->>'eta', '')::date, nullif(r.x->>'variant_id', '')::bigint, coalesce(r.x->>'match_how', '')
  from jsonb_array_elements(coalesce(p->'rows', '[]')) with ordinality r(x, ord);
  select count(*), count(variant_id) into n, nm from jt.vendor_price_rows where list_id = lid;
  update jt.vendor_price_lists set rows = n, matched = nm where id = lid;
  -- remember vendor item codes for invoices too
  insert into jt.vendor_items (vendor, item_code, variant_id)
  select distinct on (r.item_code) l.vendor, r.item_code, r.variant_id from jt.vendor_price_rows r join jt.vendor_price_lists l on l.id = r.list_id
  where r.list_id = lid and r.variant_id is not null and r.item_code <> '' and r.match_how in ('picked', 'sku', 'upc', 'code')
  on conflict do nothing;
  -- each matched product's current state (one row per product: the last line for it on this list)
  with r as (select distinct on (variant_id) * from jt.vendor_price_rows where list_id = lid and variant_id is not null order by variant_id, line_no desc)
  insert into jt.product_status as s (variant_id, discontinued, disc_since, disc_source, disc_by, list_cost, msrp, availability, avail_qty, eta, list_id, list_at, updated_at)
  select r.variant_id, r.status = 'discontinued', case when r.status = 'discontinued' then current_date end, case when r.status = 'discontinued' then src else '' end,
         case when r.status = 'discontinued' then who else '' end, r.cost, r.msrp, r.status, r.avail_qty, r.eta, lid, now(), now()
  from r
  on conflict (variant_id) do update set
    list_cost = coalesce(excluded.list_cost, s.list_cost), msrp = coalesce(excluded.msrp, s.msrp), availability = excluded.availability,
    avail_qty = excluded.avail_qty, eta = excluded.eta, list_id = excluded.list_id, list_at = excluded.list_at, updated_at = now(),
    discontinued = case when excluded.availability = 'discontinued' then true when s.disc_source = 'manual' then s.discontinued
                        when excluded.availability in ('active', 'backorder', 'unavailable') then false else s.discontinued end,
    disc_since = case when excluded.availability = 'discontinued' then coalesce(case when s.discontinued then s.disc_since end, current_date)
                      when s.disc_source = 'manual' then s.disc_since when excluded.availability in ('active', 'backorder', 'unavailable') then null else s.disc_since end,
    disc_source = case when excluded.availability = 'discontinued' then case when s.discontinued then s.disc_source else excluded.disc_source end
                       when s.disc_source = 'manual' then s.disc_source when excluded.availability in ('active', 'backorder', 'unavailable') then '' else s.disc_source end,
    disc_by = case when excluded.availability = 'discontinued' then case when s.discontinued then s.disc_by else excluded.disc_by end
                   when s.disc_source = 'manual' then s.disc_by when excluded.availability in ('active', 'backorder', 'unavailable') then '' else s.disc_by end;
  select count(*) filter (where discontinued and list_id = lid), count(*) filter (where availability in ('backorder', 'unavailable') and list_id = lid)
    into ndisc, nback from jt.product_status;
  return jsonb_build_object('list_id', lid, 'rows', n, 'matched', nm, 'discontinued', ndisc, 'backorder', nback);
end $$;

-- mark (or unmark) products discontinued by hand: {variant_ids: [...], discontinued: true|false, note, by, source}
create or replace function jt.product_status_set(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare yes boolean := coalesce((p->>'discontinued')::boolean, true); src text := coalesce(nullif(p->>'source', ''), 'manual'); n int;
begin
  insert into jt.product_status as s (variant_id, discontinued, disc_since, disc_source, disc_by, note, updated_at)
  select v::bigint, yes, case when yes then current_date end, case when yes then src else 'manual' end, coalesce(p->>'by', ''), coalesce(p->>'note', ''), now()
  from jsonb_array_elements_text(coalesce(p->'variant_ids', '[]')) v
  on conflict (variant_id) do update set discontinued = yes,
    disc_since = case when yes then coalesce(case when s.discontinued then s.disc_since end, current_date) end,
    disc_source = case when yes then src else 'manual' end,          -- unmarked by hand: stays active until marked again
    disc_by = coalesce(p->>'by', ''), note = case when p ? 'note' then coalesce(p->>'note', '') else s.note end, updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function jt.price_list_save(jsonb), jt.product_status_set(jsonb) from public;

-- on hand per product: Shopify store, prep center, Amazon (FBA + transfer + inbound + AWD, in Shopify units)
create or replace view jt.v_variant_stock as
  with a as (select s.variant_id, sum((s.fba_available + s.fba_transfer + s.fba_inbound + s.awd) * coalesce(s.map_units, 1))::int as qty
             from jt.v_asin_stock s where s.variant_id is not null group by 1),
       p as (select i.variant_id, sum(i.qty)::int as qty from jt.prep_items i where i.qty > 0 and i.variant_id is not null group by 1)
  select v.variant_id, greatest(coalesce(v.inventory_qty, 0), 0) as store, coalesce(p.qty, 0) as prep, coalesce(a.qty, 0) as amazon
  from jt.variants v left join p using (variant_id) left join a using (variant_id)
  where v.removed_at is null;

-- the Discontinued page: discontinued products, plus "maybe" ones missing from the vendor's latest complete pricelist
create or replace function jt.discontinued_view()
returns table (variant_id bigint, product_id bigint, title text, sku text, vendor text, shop_status text, unit_cost numeric,
               store integer, prep integer, amazon integer, sold90 numeric, last_sale date, kind text,
               disc_since date, disc_source text, disc_by text, note text, availability text, list_cost numeric, msrp numeric)
language sql stable security definer set search_path = '' as $$
  with latest as (select distinct on (lower(l.vendor)) l.id, lower(l.vendor) as vendor from jt.vendor_price_lists l where l.full_list order by lower(l.vendor), l.uploaded_at desc),
  maybe as (
    select v.variant_id from jt.variants v join latest on latest.vendor = lower(v.vendor)
    where v.removed_at is null and v.status = 'ACTIVE'
      and not exists (select 1 from jt.vendor_price_rows r where r.list_id = latest.id and r.variant_id = v.variant_id)
      and not exists (select 1 from jt.product_status s where s.variant_id = v.variant_id and (s.discontinued or s.disc_source = 'manual'))),
  k as (select s.variant_id, 'disc'::text as kind from jt.product_status s where s.discontinued
        union all select m.variant_id, 'maybe' from maybe m),
  m as (select distinct on (d.data->>'sku') d.data->>'sku' as sku, ((regexp_match(d.data->>'variantId', '(\d+)$'))[1])::bigint as variant_id,
               greatest(coalesce(nullif(d.data->>'units', '')::numeric, 1), 1) as units
        from jt.docs d where d.collection = 'amzmap' and d.data->>'kind' = 'shopify' order by d.data->>'sku', d.data->>'updatedAt' desc nulls last),
  sales as (
    select x.variant_id, sum(x.units) filter (where x.day > current_date - 90) as u90, max(x.day) as last_day from (
      select s.variant_id, s.day, s.units from jt.shopify_sales s where s.variant_id in (select variant_id from k) and s.units > 0
      union all
      select m.variant_id, a.day, a.units * m.units from jt.amazon_sku_daily a join m on m.sku = a.sku where m.variant_id in (select variant_id from k) and a.units > 0) x
    group by 1)
  select v.variant_id, v.product_id, coalesce(nullif(v.display_name, ''), v.product_title), v.sku, v.vendor, v.status, v.unit_cost,
         st.store, st.prep, st.amazon, coalesce(sales.u90, 0), sales.last_day, k.kind,
         ps.disc_since, coalesce(ps.disc_source, ''), coalesce(ps.disc_by, ''), coalesce(ps.note, ''), coalesce(ps.availability, ''), ps.list_cost, ps.msrp
  from k join jt.variants v on v.variant_id = k.variant_id and v.removed_at is null
    left join jt.v_variant_stock st on st.variant_id = v.variant_id
    left join sales on sales.variant_id = v.variant_id
    left join jt.product_status ps on ps.variant_id = v.variant_id
$$;
revoke all on function jt.discontinued_view() from public;

-- the to do list: a discontinued product that's sold out everywhere and still active in Shopify → archive it
create or replace function jt.todo_suggestions()
returns table (key text, kind text, title text, link text, detail text, since timestamptz)
language sql stable security definer set search_path = '' as $$
  with po as (
    select o.id, o.vendor, o.status, o.approved_at, o.created_at, o.updated_at,
           case when o.po_no ~* '^\s*po' then o.po_no else 'PO ' || coalesce(nullif(o.po_no, ''), '#' || o.id) end as name
    from jt.prep_orders o where o.status = 'draft'),
  iv as (
    select i.id, i.vendor, i.invoice_no, i.created_at, i.received_at, i.qbo_bill_id,
           coalesce(i.order_id, (select o.id from jt.prep_orders o where o.invoice_id = i.id limit 1)) as oid,
           (select count(*) from jt.invoice_lines l where l.invoice_id = i.id and ((l.variant_id is null and l.match_how <> 'skip') or l.match_how like 'guess%')) as issues,
           (select coalesce(sum(l.qty), 0) from jt.invoice_lines l where l.invoice_id = i.id and l.variant_id is not null and l.match_how <> 'skip') as billed
    from jt.invoices i where i.created_at > now() - interval '120 days'),
  disc as (
    select v.variant_id, v.product_id, coalesce(nullif(v.display_name, ''), v.product_title) as title, v.vendor, s.disc_since
    from jt.product_status s join jt.variants v on v.variant_id = s.variant_id and v.removed_at is null and v.status = 'ACTIVE'
    join jt.v_variant_stock st on st.variant_id = v.variant_id
    where s.discontinued and st.store + st.prep + st.amazon = 0)
  select 'approve:' || id, 'approve', 'Approve ' || vendor || ' ' || name, 'po:' || id, 'Order ready to approve', created_at from po where approved_at is null
  union all
  select 'submit:' || id, 'submit', 'Give ' || vendor || ' ' || name || ' to the vendor', 'po:' || id, 'Approved — mark it ordered once it''s placed', approved_at from po where approved_at is not null
  union all
  select 'invfix:' || id, 'invfix', 'Fix invoice ' || coalesce(nullif(invoice_no, ''), '#' || id) || ' from ' || vendor, 'invoice:' || id,
         issues || ' line' || case when issues = 1 then '' else 's' end || ' to check', created_at from iv where issues > 0
  union all
  select 'invpo:' || id, 'invpo', 'Build the PO for ' || vendor || ' invoice ' || coalesce(nullif(invoice_no, ''), '#' || id), 'invoice:' || id,
         'No PO yet — Shopify import CSV', created_at from iv where issues = 0 and oid is null
  union all
  select 'receive:' || id, 'receive', 'Receive ' || vendor || ' invoice ' || coalesce(nullif(invoice_no, ''), '#' || id), 'invoice:' || id,
         billed::int || ' unit' || case when billed = 1 then '' else 's' end || ' to receive', created_at from iv where issues = 0 and oid is not null and received_at is null and billed > 0
  union all
  select 'qbo:' || id, 'qbo', 'Enter ' || vendor || ' bill ' || coalesce(nullif(invoice_no, ''), '#' || id) || ' in QuickBooks', 'invoice:' || id,
         'Received, not in QuickBooks', received_at from iv where issues = 0 and oid is not null and received_at is not null and qbo_bill_id is null
  union all
  select 'discont:' || variant_id, 'discont', 'Archive ' || title || ' in Shopify', 'discontinued',
         'Discontinued' || coalesce(' since ' || to_char(disc_since, 'Mon FMDD'), '') || ' and sold out everywhere', disc_since::timestamptz from disc
$$;

-- the web app's writes (who's signed in does it)
create or replace function public.jt_price_list_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if jt.me() is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.price_list_save(p || jsonb_build_object('by', jt.me()));
end $$;
create or replace function public.jt_product_status_set(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if jt.me() is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.product_status_set(p || jsonb_build_object('by', jt.me(), 'source', 'manual'));
end $$;
revoke all on function public.jt_price_list_save(jsonb), public.jt_product_status_set(jsonb) from public, anon;
grant execute on function public.jt_price_list_save(jsonb), public.jt_product_status_set(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.vendor_price_lists, jt.vendor_price_rows, jt.product_status, jt.v_variant_stock to jt_reader;
    grant execute on function jt.discontinued_view() to jt_reader;
  end if;
end $$;
