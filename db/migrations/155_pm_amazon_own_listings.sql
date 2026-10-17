-- Price match › Amazon prices tab (Brian, Oct 17: "let's add a tab for amazon prices … based on our in stock asins").
-- Our in-stock Amazon listings (FBA: fulfillable units; FBM: listings with quantity on Amazon) are priced every morning
-- by the pm-amazon step too, first in line, and the page shows our price against the Buy Box and the other sellers.
alter table jt.pm_amazon_prices add column if not exists own_price numeric(12,2);      -- our offer (item + shipping), when Amazon lists it
alter table jt.pm_amazon_prices add column if not exists lowest_other numeric(12,2);   -- lowest new offer from another seller

create or replace view jt.v_pm_amazon_stock as
with fba as (
  select f.sku, f.asin, max(f.name) as title, sum(f.fulfillable)::int as qty, sum(f.inbound_shipped + f.inbound_receiving)::int as inbound
  from jt.fba_inventory f where f.active and f.asin <> '' and f.fulfillable > 0 group by f.sku, f.asin
), fbm as (
  select l.sku, l.asin, l.title, coalesce(l.amazon_qty_now, l.amazon_qty, 0)::int as qty, l.amazon_price
  from jt.v_fbm_listings l where coalesce(l.amazon_qty_now, l.amazon_qty, 0) > 0 and l.asin <> ''
), mine as (
  select sku, asin, title, 'FBA'::text as channel, qty, inbound from fba
  union all
  select sku, asin, title, 'FBM', qty, 0 from fbm where sku not in (select sku from fba)
)
select m.sku, m.asin, coalesce(nullif(m.title, ''), l.title, '') as title, m.channel, m.qty, m.inbound,
       l.price as listing_price, p.own_price, coalesce(p.own_price, l.price) as our_price,
       p.buybox_price, p.own_buybox, p.amazon_fulfilled, p.lowest_other, p.offers, p.price as match_price, p.error, p.checked_at
from mine m
left join jt.amazon_listings l on l.sku = m.sku
left join jt.pm_amazon_prices p on p.asin = m.asin;

-- the pm-amazon step prices our in-stock ASINs first, then the UPC-matched ones
create or replace function public.jt_pm_amazon_todo(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare n_upc int := coalesce((p->>'upcs')::int, 200); n_asin int := coalesce((p->>'asins')::int, 200); r jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  with vend as (select lower(regexp_replace(v, '[^a-zA-Z]', '', 'g')) v from jt.pm_sources s, unnest(s.vendors) v
                where not coalesce((s.options->>'retail')::boolean, false)),
  want as (
    select distinct btrim(x.barcode) upc from jt.variants x
    where x.status = 'ACTIVE' and btrim(coalesce(x.barcode, '')) ~ '^\d{12,14}$'
      and lower(regexp_replace(x.vendor, '[^a-zA-Z]', '', 'g')) in (select v from vend)
  ),
  asins as (
    select distinct s.asin, 0 as pri from jt.v_pm_amazon_stock s
    union select distinct u.asin, 1 from want w join jt.pm_upc_asin u on u.upc = w.upc where u.asin <> ''
  ),
  due as (
    select a.asin, min(a.pri) as pri, max(pr.checked_at) as checked from asins a left join jt.pm_amazon_prices pr on pr.asin = a.asin
    where pr.asin is null or pr.checked_at < now() - interval '18 hours' group by a.asin
  )
  select jsonb_build_object(
    'upcs', coalesce((select jsonb_agg(w.upc) from (select w.upc from want w left join jt.pm_upc_asin u on u.upc = w.upc
                       where u.upc is null or u.checked_at < now() - interval '30 days' order by u.checked_at nulls first limit n_upc) w), '[]'::jsonb),
    'asins', coalesce((select jsonb_agg(d.asin) from (select asin from due order by pri, checked nulls first limit n_asin) d), '[]'::jsonb),
    'left_upcs', (select count(*) from want w left join jt.pm_upc_asin u on u.upc = w.upc where u.upc is null or u.checked_at < now() - interval '30 days'),
    'left_asins', (select count(*) from due))
  into r;
  return r;
end $$;

-- save our own offer and the lowest other one too
create or replace function public.jt_pm_amazon_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare nu int := 0; np int := 0;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into jt.pm_upc_asin (upc, asin, title, checked_at)
  select x->>'upc', coalesce(x->>'asin', ''), left(coalesce(x->>'title', ''), 300), now() from jsonb_array_elements(coalesce(p->'upcs', '[]')) x
  on conflict (upc) do update set asin = excluded.asin, title = excluded.title, checked_at = now();
  get diagnostics nu = row_count;
  insert into jt.pm_amazon_prices (asin, price, buybox_price, own_buybox, amazon_fulfilled, offers, error, own_price, lowest_other, checked_at)
  select x->>'asin', nullif(x->>'price', '')::numeric, nullif(x->>'buybox_price', '')::numeric, coalesce((x->>'own_buybox')::boolean, false),
         coalesce((x->>'amazon_fulfilled')::boolean, false), nullif(x->>'offers', '')::int, left(coalesce(x->>'error', ''), 300),
         nullif(x->>'own_price', '')::numeric, nullif(x->>'lowest_other', '')::numeric, now()
  from jsonb_array_elements(coalesce(p->'prices', '[]')) x
  on conflict (asin) do update set price = excluded.price, buybox_price = excluded.buybox_price, own_buybox = excluded.own_buybox,
    amazon_fulfilled = excluded.amazon_fulfilled, offers = excluded.offers, error = excluded.error, own_price = excluded.own_price,
    lowest_other = excluded.lowest_other, checked_at = now();
  get diagnostics np = row_count;
  return jsonb_build_object('upcs', nu, 'prices', np);
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.v_pm_amazon_stock to jt_reader; end if;
end $$;
