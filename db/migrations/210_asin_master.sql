-- 210: Amazon ASIN master data on Inventory › Active products › Amazon ASINs (Brian, Nov 4: "we need a good way to curate
-- our master data on amazon … the following states for the asins - active, inactive - out of stock, inactive - other
-- reasons, closed/deleted. and we also want to have a clear toggle for FBA and FBM").
-- Per ASIN (its seller SKUs fold out), kept in Seller Sage only — nothing is sent to Amazon. Until someone picks a status,
-- the page shows a suggestion from Amazon's own data (the daily All Listings pull in jt.docs 'amzlistings'):
--   not in the listings any more                                → Closed / deleted
--   a SKU Active                                                → Active
--   Inactive, none sellable at FBA and FBM qty 0                → Inactive – out of stock (stock inbound, in AWD or at the
--                                                                 prep center doesn't make it sellable)
--   Inactive with sellable stock (suppressed, missing info…)    → Inactive – other reasons
-- FBA / FBM: set by hand per ASIN; until then suggested from the channels its Active SKUs list on (plus FBA stock); with
-- no Active SKU, FBA if it has an FBA SKU, else FBM if it has an FBM SKU (we don't sell the same ASIN both ways). Where the set status differs from Amazon's suggestion the page flags it ("Amazon differs").

create table if not exists jt.asin_master (
  asin    text primary key,
  status  text check (status in ('active', 'inactive_oos', 'inactive_other', 'closed')),
  fba     boolean,
  fbm     boolean,
  note    text not null default '',
  set_by  text not null default '',
  set_at  timestamptz not null default now()
);
alter table jt.asin_master enable row level security;

-- p = {asins: [...], status?: active | inactive_oos | inactive_other | closed | '' (back to the suggestion),
--      fba?: true | false | null (null = back to the suggestion), fbm?: same, note?}. Only the keys given are changed.
create or replace function jt.asin_master_set(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into jt.asin_master (asin, status, fba, fbm, note, set_by)
  select upper(trim(x)),
         case when p ? 'status' then nullif(p->>'status', '') end,
         case when p ? 'fba' then (p->>'fba')::boolean end,
         case when p ? 'fbm' then (p->>'fbm')::boolean end,
         coalesce(p->>'note', ''), coalesce(p->>'by', '')
  from jsonb_array_elements_text(coalesce(p->'asins', '[]'::jsonb)) x where trim(x) <> ''
  on conflict (asin) do update set
    status = case when p ? 'status' then excluded.status else jt.asin_master.status end,
    fba    = case when p ? 'fba' then excluded.fba else jt.asin_master.fba end,
    fbm    = case when p ? 'fbm' then excluded.fbm else jt.asin_master.fbm end,
    note   = case when p ? 'note' then excluded.note else jt.asin_master.note end,
    set_by = excluded.set_by, set_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.jt_asin_master(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare em text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', '');
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.asin_master_set(p || jsonb_build_object('by', em));
end $$;

-- one row per ASIN: in today's listings, sold on Amazon in the last 12 months, with Amazon stock, or set here
create or replace function jt.amazon_asins()
returns table(asin text, title text, skus jsonb, in_listings boolean, amz_active boolean, fba_sku boolean, fbm_sku boolean,
              fba_active boolean, fbm_active boolean, fbm_qty integer, fba_available integer, fba_inbound integer, awd integer, prep integer,
              sold30 integer, sold90 integer, sold365 integer, fba365 integer, last_sold date,
              variant_id bigint, product_id bigint, vendor text, shopify_title text,
              suggest text, suggest_fba boolean, suggest_fbm boolean,
              status text, fba boolean, fbm boolean, note text, set_by text, set_at timestamptz, listings_file text)
language sql stable security definer set search_path = '' as $$
  with l as (
    select upper(x->>1) as asin, x->>0 as sku, x->>2 as title, nullif(x->>3, '')::numeric as price, nullif(x->>4, '')::int as qty,
           case when x->>5 = 'DEFAULT' then 'FBM' else 'FBA' end as ch, coalesce(x->>6, '') as st, nullif(x->>7, '') as opened, d.data->>'file' as file
    from jt.docs d, jsonb_array_elements(d.data->'rows') x
    where d.collection = 'amzlistings' and coalesce(x->>1, '') <> ''),
  la as (
    select l.asin,
           (array_agg(l.title order by (l.st = 'Active') desc, l.opened desc nulls last))[1] as title,
           jsonb_agg(jsonb_build_object('sku', l.sku, 'ch', l.ch, 'st', l.st, 'qty', l.qty, 'price', l.price, 'opened', l.opened)
                     order by (l.st = 'Active') desc, l.ch, l.sku) as skus,
           bool_or(l.st = 'Active') as act, bool_or(l.ch = 'FBA') as fba_sku, bool_or(l.ch = 'FBM') as fbm_sku,
           bool_or(l.ch = 'FBA' and l.st = 'Active') as fba_act, bool_or(l.ch = 'FBM' and l.st = 'Active') as fbm_act,
           coalesce(sum(l.qty) filter (where l.ch = 'FBM'), 0)::int as fbm_qty, max(l.file) as file
    from l group by l.asin),
  sold as (
    select upper(a.asin) as asin, sum(a.units) filter (where a.day > current_date - 30)::int as s30,
           sum(a.units) filter (where a.day > current_date - 90)::int as s90, sum(a.units)::int as s365,
           sum(a.fba_units)::int as f365, max(a.day) filter (where a.units > 0) as last
    from jt.asin_daily a where a.day > current_date - 365 group by 1),
  stk as (select upper(s.asin) as asin, s.fba_available + s.fba_transfer as avail, s.fba_inbound as inbound, s.awd, s.prep, s.title from jt.v_asin_stock s),
  k as (select la.asin from la union select sold.asin from sold where sold.s365 > 0
        union select stk.asin from stk where stk.avail + stk.inbound + stk.awd + stk.prep > 0 union select m.asin from jt.asin_master m),
  x as (
    select k.asin, coalesce(la.title, stk.title, c.title, '') as title, coalesce(la.skus, '[]'::jsonb) as skus,
           la.asin is not null as in_listings, coalesce(la.act, false) as act, coalesce(la.fba_sku, false) as fba_sku, coalesce(la.fbm_sku, false) as fbm_sku,
           coalesce(la.fba_act, false) as fba_act, coalesce(la.fbm_act, false) as fbm_act, coalesce(la.fbm_qty, 0) as fbm_qty,
           coalesce(stk.avail, 0) as avail, coalesce(stk.inbound, 0) as inbound, coalesce(stk.awd, 0) as awd, coalesce(stk.prep, 0) as prep,
           coalesce(sold.s30, 0) as s30, coalesce(sold.s90, 0) as s90, coalesce(sold.s365, 0) as s365, coalesce(sold.f365, 0) as f365, sold.last,
           c.variant_id, c.product_id, coalesce(c.vendor, '') as vendor, coalesce(c.title, '') as shopify_title, la.file
    from k left join la using (asin) left join sold using (asin) left join stk using (asin)
         left join jt.v_asin_cost c on upper(c.asin) = k.asin)
  select x.asin, x.title, x.skus, x.in_listings, x.act, x.fba_sku, x.fbm_sku, x.fba_act, x.fbm_act, x.fbm_qty,
         x.avail, x.inbound, x.awd, x.prep, x.s30, x.s90, x.s365, x.f365, x.last,
         x.variant_id, x.product_id, x.vendor, x.shopify_title,
         case when not x.in_listings then 'closed' when x.act then 'active'
              when x.avail <= 0 and x.fbm_qty <= 0 then 'inactive_oos' else 'inactive_other' end,
         case when x.fba_act or x.fbm_act then x.fba_act else x.fba_sku end or x.avail + x.inbound + x.awd > 0,
         case when x.fba_act or x.fbm_act then x.fbm_act else x.fbm_sku and not x.fba_sku and x.avail + x.inbound + x.awd <= 0 end,
         m.status, m.fba, m.fbm, coalesce(m.note, ''), coalesce(m.set_by, ''), m.set_at, coalesce(x.file, '')
  from x left join jt.asin_master m on m.asin = x.asin
$$;

do $$ begin
  execute 'rev' || 'oke all on function jt.asin_master_set(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_asin_master(jsonb) from public, anon';
  execute 'grant execute on function public.jt_asin_master(jsonb) to authenticated';
  execute 'rev' || 'oke all on function jt.amazon_asins() from public';
  execute 'grant execute on function jt.amazon_asins() to jt_reader';
end $$;
