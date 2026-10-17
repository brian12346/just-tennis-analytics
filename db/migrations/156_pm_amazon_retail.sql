-- Price match › Amazon: is Amazon.com itself selling on the listing, now or lately? (Brian, Oct 17). The pm-amazon step
-- marks offers from Amazon.com (seller id ATVPDKIKX0DER) on each ASIN it prices, and every sighting is logged per day,
-- so the page can show "on the listing now" and "seen in the last 90 days" (the log starts Oct 17, 2026).
alter table jt.pm_amazon_prices add column if not exists amazon_retail boolean not null default false;   -- Amazon.com has an offer now
alter table jt.pm_amazon_prices add column if not exists amazon_retail_price numeric(12,2);
alter table jt.pm_amazon_prices add column if not exists amazon_retail_buybox boolean not null default false;

create table if not exists jt.pm_amazon_retail_log (
  asin    text not null,
  day     date not null,
  price   numeric(12,2),
  buybox  boolean not null default false,
  primary key (asin, day)
);

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
  insert into jt.pm_amazon_prices (asin, price, buybox_price, own_buybox, amazon_fulfilled, offers, error, own_price, lowest_other,
                                   amazon_retail, amazon_retail_price, amazon_retail_buybox, checked_at)
  select x->>'asin', nullif(x->>'price', '')::numeric, nullif(x->>'buybox_price', '')::numeric, coalesce((x->>'own_buybox')::boolean, false),
         coalesce((x->>'amazon_fulfilled')::boolean, false), nullif(x->>'offers', '')::int, left(coalesce(x->>'error', ''), 300),
         nullif(x->>'own_price', '')::numeric, nullif(x->>'lowest_other', '')::numeric,
         coalesce((x->>'amazon_retail')::boolean, false), nullif(x->>'amazon_retail_price', '')::numeric, coalesce((x->>'amazon_retail_buybox')::boolean, false), now()
  from jsonb_array_elements(coalesce(p->'prices', '[]')) x
  where coalesce(x->>'error', '') = '' or not exists (select 1 from jt.pm_amazon_prices o where o.asin = x->>'asin')
  on conflict (asin) do update set price = excluded.price, buybox_price = excluded.buybox_price, own_buybox = excluded.own_buybox,
    amazon_fulfilled = excluded.amazon_fulfilled, offers = excluded.offers, error = excluded.error, own_price = excluded.own_price,
    lowest_other = excluded.lowest_other, amazon_retail = excluded.amazon_retail, amazon_retail_price = excluded.amazon_retail_price,
    amazon_retail_buybox = excluded.amazon_retail_buybox, checked_at = now();
  get diagnostics np = row_count;
  insert into jt.pm_amazon_retail_log (asin, day, price, buybox)
  select x->>'asin', (now() at time zone 'America/Los_Angeles')::date, nullif(x->>'amazon_retail_price', '')::numeric, coalesce((x->>'amazon_retail_buybox')::boolean, false)
  from jsonb_array_elements(coalesce(p->'prices', '[]')) x where coalesce((x->>'amazon_retail')::boolean, false)
  on conflict (asin, day) do update set price = excluded.price, buybox = jt.pm_amazon_retail_log.buybox or excluded.buybox;
  return jsonb_build_object('upcs', nu, 'prices', np);
end $$;

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
       p.buybox_price, p.own_buybox, p.amazon_fulfilled, p.lowest_other, p.offers, p.price as match_price, p.error, p.checked_at,
       coalesce(p.amazon_retail, false) as amazon_now, p.amazon_retail_price as amazon_price, coalesce(p.amazon_retail_buybox, false) as amazon_buybox,
       r.last_seen as amazon_last_seen, coalesce(r.days, 0) as amazon_days_90, coalesce(r.bb_days, 0) as amazon_bb_days_90
from mine m
left join jt.amazon_listings l on l.sku = m.sku
left join jt.pm_amazon_prices p on p.asin = m.asin
left join (select asin, max(day) as last_seen, count(*)::int as days, count(*) filter (where buybox)::int as bb_days
           from jt.pm_amazon_retail_log where day > current_date - 90 group by asin) r on r.asin = m.asin;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.v_pm_amazon_stock, jt.pm_amazon_retail_log to jt_reader;
  end if;
end $$;
