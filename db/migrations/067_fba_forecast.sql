-- FBA forecast (finance site): units sold per ASIN per day, stock per ASIN (FBA from the API, AWD from the uploaded
-- report, prep center), and each ASIN's unit cost, so the page can forecast sales from last year's same weeks scaled
-- to the ASIN's recent trend, find when stock runs out, and price the replenishment.

-- Amazon units per ASIN per Pacific day (all channels and marketplaces; cancelled lines left out). A rollup of
-- jt.amazon_order_lines kept fresh by jt.refresh_asin_daily (hourly for the last few days, nightly for 5 weeks).
create table if not exists jt.asin_daily (
  asin      text not null,
  day       date not null,
  units     integer not null default 0,
  fba_units integer not null default 0,   -- fulfilled by Amazon
  primary key (asin, day)
);
create index if not exists asin_daily_day on jt.asin_daily (day);

create or replace function jt.refresh_asin_daily(p_since date, p_until date default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare n int; u date := coalesce(p_until, (now() at time zone 'America/Los_Angeles')::date + 1);
begin
  -- clear the range, then write it again (lines can be cancelled or change after the first sync)
  update jt.asin_daily set units = 0, fba_units = 0 where day >= p_since and day < u and (units <> 0 or fba_units <> 0);
  insert into jt.asin_daily (asin, day, units, fba_units)
  select x.asin, (x.purchase_at at time zone 'America/Los_Angeles')::date, sum(x.quantity)::int,
         coalesce(sum(x.quantity) filter (where x.fulfillment = 'Amazon'), 0)::int
  from jt.amazon_order_lines x
  where (x.purchase_at at time zone 'America/Los_Angeles')::date >= p_since
    and (x.purchase_at at time zone 'America/Los_Angeles')::date < u
    and x.order_status <> 'Cancelled' and x.item_status <> 'Cancelled' and x.asin <> ''
  group by 1, 2
  on conflict (asin, day) do update set units = excluded.units, fba_units = excluded.fba_units;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function jt.refresh_asin_daily(date, date) from public;

-- Demand per ASIN: units in the last 30 days, the last 8 weeks, the same 8 weeks last year, and last year's units for
-- each of the next p_weeks weeks (week k starts 364 - 7k days back, so weekdays line up).
create or replace function jt.fba_demand(p_weeks integer default 26)
returns table (asin text, u30 integer, r8 integer, ly8 integer, r8_fba integer, u365 integer, last_sale date, ly_weeks integer[])
language sql stable set search_path = '' as $$
  with t as (select (now() at time zone 'America/Los_Angeles')::date as d0),
  d as (
    select a.asin, a.day, a.units, a.fba_units from jt.asin_daily a, t
    where a.day >= t.d0 - 420 and a.day < t.d0 and a.units > 0   -- covers last year's next p_weeks too (p_weeks <= 52)
  ),
  w as (
    select d.asin, ((d.day - (t.d0 - 364)) / 7) as k, sum(d.units)::int as u
    from d, t where d.day >= t.d0 - 364 and d.day < t.d0 - 364 + 7 * p_weeks group by 1, 2
  ),
  wa as (   -- one array per ASIN, zeros for weeks without sales
    select a.asin, array_agg(coalesce(w.u, 0) order by g.k) as ly_weeks
    from (select distinct d.asin from d) a cross join generate_series(0, p_weeks - 1) g(k)
    left join w on w.asin = a.asin and w.k = g.k
    group by a.asin
  ),
  s as (
    select d.asin,
           coalesce(sum(d.units) filter (where d.day >= t.d0 - 30), 0)::int as u30,
           coalesce(sum(d.units) filter (where d.day >= t.d0 - 56), 0)::int as r8,
           coalesce(sum(d.units) filter (where d.day < t.d0 - 364), 0)::int as ly8,
           coalesce(sum(d.fba_units) filter (where d.day >= t.d0 - 56), 0)::int as r8_fba,
           coalesce(sum(d.units) filter (where d.day >= t.d0 - 365), 0)::int as u365,
           max(d.day) as last_sale
    from d, t group by d.asin
  )
  select s.asin, s.u30, s.r8, s.ly8, s.r8_fba, s.u365, s.last_sale, wa.ly_weeks
  from s join wa on wa.asin = s.asin
$$;

-- Stock and cost per ASIN. FBA: jt.fba_inventory (API). AWD: the latest uploaded AWD report (jt.v_asin_fba).
-- Prep center: jt.prep_items earmarked for a seller SKU, in Amazon units (Shopify units / the mapping's units).
-- Cost: the Shopify variant the ASIN is mapped to (jt.docs amzmap) × units, at today's Shopify cost.
create or replace view jt.v_asin_stock as
with m as (
  select distinct on (d.data->>'sku') d.data->>'sku' as sku, nullif(d.data->>'asin', '') as asin,
         (regexp_match(d.data->>'variantId', '(\d+)$'))[1]::bigint as variant_id,
         greatest(coalesce(nullif(d.data->>'units', '')::numeric, 1), 1) as units, d.data->>'title' as title,
         d.data->>'updatedAt' as mapped_at
  from jt.docs d where d.collection = 'amzmap' and d.data->>'kind' = 'shopify'
  order by d.data->>'sku', d.data->>'updatedAt' desc nulls last
),
sa as (   -- seller SKU -> ASIN
  select distinct on (sku) sku, asin from (
    select f.sku, f.asin, 1 as pr from jt.fba_inventory f where f.asin <> ''
    union all select m.sku, m.asin, 2 from m where m.asin is not null
  ) x order by sku, pr
),
fba as (
  select f.asin, sum(f.fulfillable) as avail, sum(f.reserved_transfer + f.reserved_processing) as transfer,
         sum(f.inbound_working + f.inbound_shipped + f.inbound_receiving) as inbound, sum(f.reserved_customer) as sold_pending,
         sum(f.unfulfillable) as unfulfillable, max(nullif(f.name, '')) as name, count(*) filter (where f.total > 0) as skus
  from jt.fba_inventory f where f.asin <> '' group by 1
),
prep as (
  select sa.asin, sum(i.qty / coalesce(m.units, 1)) as units
  from jt.prep_items i join sa on sa.sku = i.amazon_sku left join m on m.sku = i.amazon_sku
  where i.qty > 0 group by 1
),
cost as (
  select distinct on (m.asin) m.asin, round(v.unit_cost * m.units, 2) as unit_cost, m.units as map_units, v.variant_id,
         v.product_id, v.vendor, coalesce(nullif(v.display_name, ''), v.product_title) as shopify_title, m.title
  from m join jt.variants v on v.variant_id = m.variant_id
  where m.asin is not null
  order by m.asin, (v.unit_cost > 0) desc, m.mapped_at desc nulls last
),
awd as (select a.asin, a.awd from jt.v_asin_fba a where a.awd > 0),
k as (select asin from fba union select asin from prep union select asin from awd)
select k.asin,
       coalesce(fba.name, cost.title, cost.shopify_title, '') as title,
       coalesce(fba.avail, 0)::int as fba_available, coalesce(fba.transfer, 0)::int as fba_transfer,
       coalesce(fba.inbound, 0)::int as fba_inbound, coalesce(fba.sold_pending, 0)::int as fba_sold_pending,
       coalesce(fba.unfulfillable, 0)::int as fba_unfulfillable, coalesce(awd.awd, 0)::int as awd,
       floor(coalesce(prep.units, 0))::int as prep, cost.unit_cost, cost.map_units, cost.variant_id, cost.product_id,
       coalesce(cost.vendor, '') as vendor, coalesce(fba.skus, 0)::int as fba_skus
from k left join fba on fba.asin = k.asin left join prep on prep.asin = k.asin left join awd on awd.asin = k.asin
       left join cost on cost.asin = k.asin;

-- ASINs with sales but no stock anywhere still need a cost and a title: the same mapping lookup by ASIN.
create or replace view jt.v_asin_cost as
with m as (
  select distinct on (d.data->>'sku') nullif(d.data->>'asin', '') as asin,
         (regexp_match(d.data->>'variantId', '(\d+)$'))[1]::bigint as variant_id,
         greatest(coalesce(nullif(d.data->>'units', '')::numeric, 1), 1) as units, d.data->>'title' as title,
         d.data->>'updatedAt' as mapped_at
  from jt.docs d where d.collection = 'amzmap' and d.data->>'kind' = 'shopify'
  order by d.data->>'sku', d.data->>'updatedAt' desc nulls last
)
select distinct on (m.asin) m.asin, round(v.unit_cost * m.units, 2) as unit_cost, m.units as map_units, v.variant_id, v.product_id,
       coalesce(v.vendor, '') as vendor, coalesce(nullif(m.title, ''), nullif(v.display_name, ''), v.product_title) as title
from m join jt.variants v on v.variant_id = m.variant_id
where m.asin is not null
order by m.asin, (v.unit_cost > 0) desc, m.mapped_at desc nulls last;

-- forecast settings for the page: {cover_weeks, trend_weight, ...}
create or replace function fin.settings_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if p->>'key' not in ('cash', 'shopify', 'amazon', 'fba') then raise exception 'unknown setting %', p->>'key'; end if;
  insert into fin.settings (key, value) values (p->>'key', coalesce(p->'value', '{}'::jsonb))
  on conflict (key) do update set value = fin.settings.value || coalesce(p->'value', '{}'::jsonb), updated_at = now()
  returning value into v;
  return v;
end $$;
revoke all on function fin.settings_set(jsonb) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'fin_reader') then
    grant select on jt.asin_daily, jt.v_asin_stock, jt.v_asin_cost to fin_reader;
    grant execute on function jt.fba_demand(integer) to fin_reader;
  end if;
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.asin_daily, jt.v_asin_stock, jt.v_asin_cost to jt_reader;
    grant execute on function jt.fba_demand(integer) to jt_reader;
  end if;
end $$;

-- fill the rollup from the start of the order history (it's cheap to rerun)
select jt.refresh_asin_daily('2024-01-01');
