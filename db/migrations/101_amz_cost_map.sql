-- All sales was timing out on long ranges (12 months: 4.6 s, over the web role's statement timeout): Amazon's product
-- cost per day rebuilt the SKU -> cost map (jt.v_amz_sku_cost: every amzmap doc, regex on the variant id) once per day.
-- The map is now a materialized view, refreshed whenever the mappings (jt.docs 'amzmap') or Shopify costs
-- (jt.variants) change, so a day's cost is a few index lookups.

create materialized view if not exists jt.mv_amz_sku_cost as select sku, variant_id, map_units, cost from jt.v_amz_sku_cost;
create index if not exists mv_amz_sku_cost_sku on jt.mv_amz_sku_cost (sku);

create or replace function jt.refresh_amz_sku_cost() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  refresh materialized view jt.mv_amz_sku_cost;
  return null;
end $$;
revoke all on function jt.refresh_amz_sku_cost() from public;
-- mappings: only statements that touch amzmap docs (checked per row; refresh once per statement)
create or replace function jt.docs_amzmap_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from changed where collection = 'amzmap') then refresh materialized view jt.mv_amz_sku_cost; end if;
  return null;
end $$;
revoke all on function jt.docs_amzmap_changed() from public;
create or replace trigger docs_amzmap_ins after insert on jt.docs referencing new table as changed
  for each statement execute function jt.docs_amzmap_changed();
create or replace trigger docs_amzmap_upd after update on jt.docs referencing new table as changed
  for each statement execute function jt.docs_amzmap_changed();
create or replace trigger docs_amzmap_del after delete on jt.docs referencing old table as changed
  for each statement execute function jt.docs_amzmap_changed();
-- Shopify costs: only when a mapped variant's cost changes (the catalog sync writes variants one row per statement)
create or replace function jt.variants_amz_cost_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from new_rows n join old_rows o using (variant_id)
             where n.unit_cost is distinct from o.unit_cost
               and exists (select 1 from jt.mv_amz_sku_cost m where m.variant_id = n.variant_id)) then
    refresh materialized view jt.mv_amz_sku_cost;
  end if;
  return null;
end $$;
revoke all on function jt.variants_amz_cost_changed() from public;
create or replace trigger variants_amz_cost after update on jt.variants referencing old table as old_rows new table as new_rows
  for each statement execute function jt.variants_amz_cost_changed();

create or replace view jt.v_sales_channels_daily as
with anr_orders as (select distinct order_id from jt.anr_sales where order_id <> 0),
jt_labels as (
  select coalesce(o.order_day, l.ship_date) as day, sum(l.cost) as cost
  from jt.shipstation_labels l left join jt.shopify_orders o on o.order_id = l.order_id
  where not l.voided and (l.order_id is null or l.order_id not in (select order_id from anr_orders))
  group by 1),
anr_labels as (select order_day as day, sum(label_cost) as cost from jt.v_anr_order_shipping group by 1),
veeqo as (select (v.order_created_at at time zone 'America/Los_Angeles')::date as day, sum(v.cost) as cost
          from jt.veeqo_shipments v where v.cost is not null and v.amazon_order_id <> '' group by 1),
units_jt as (select day, sum(units) as units from jt.v_product_sales_daily_costed group by day),
units_anr as (select day, sum(units) as units from jt.v_anr_sales_costed group by day),
pay as (select store, day, sum(fee) as fee from jt.v_shopify_payment_fees group by 1, 2)
select s.day, 'justtennis'::text as channel, s.orders::numeric as orders, coalesce(u.units, 0) as units, s.net as net_sales,
       s.cogs, s.gross_profit, s.net_no_cost as sales_no_cost,
       s.shipping as ship_charged, coalesce(l.cost, 0) as labels, 0::numeric as amz_fees, 0::numeric as fba_fees, 0::numeric as other_fees,
       s.gross_profit + s.shipping - coalesce(l.cost, 0) - coalesce(p.fee, 0) as profit, coalesce(p.fee, 0) as pay_fees
from jt.v_shopify_daily_costed s left join units_jt u on u.day = s.day left join jt_labels l on l.day = s.day
left join pay p on p.store = 'justtennis' and p.day = s.day
union all
select a.day, 'acenrally', a.orders::numeric, coalesce(u.units, 0), a.net, a.cogs, a.gross_profit, a.net_no_cost,
       a.shipping, coalesce(l.cost, 0), 0, 0, 0, a.gross_profit + a.shipping - coalesce(l.cost, 0) - coalesce(p.fee, 0), coalesce(p.fee, 0)
from jt.v_anr_daily_costed a left join units_anr u on u.day = a.day left join anr_labels l on l.day = a.day
left join pay p on p.store = 'acenrally' and p.day = a.day
union all
select a.day, 'amazon', a.orders, a.units, a.sales, coalesce(c.cogs, 0), a.sales - coalesce(c.cogs, 0), coalesce(c.no_cost, 0),
       a.ship, -a.other_labels + coalesce(v.cost, 0), -a.sellfees, -a.fbafees, -(a.promo + a.refunds_net + a.other_rest),
       a.orders_net + a.refunds_net + a.other_labels + a.other_rest - coalesce(c.cogs, 0) - coalesce(v.cost, 0), 0::numeric
from jt.amazon_order_daily a
left join lateral (select sum(k.units * m.cost) as cogs, sum(case when m.cost is null then k.sales else 0 end) as no_cost
                   from jt.amazon_sku_daily k left join jt.mv_amz_sku_cost m on m.sku = k.sku where k.day = a.day) c on true
left join veeqo v on v.day = a.day;

create or replace view jt.v_sales_products_daily as
select day, 'justtennis'::text as channel, product_id, product_title as title, vendor, product_type, units, net as net_sales, cogs, gross_profit,
       0::numeric as amz_fees
from jt.v_product_sales_daily_costed
union all
select s.day, 'acenrally', coalesce(v.product_id, s.product_id), coalesce(nullif(v.product_title, ''), s.product_title), coalesce(nullif(v.vendor, ''), s.vendor),
       coalesce(nullif(v.product_type, ''), s.product_type), s.units, s.net, s.cogs, s.net - s.cogs, 0
from jt.v_anr_sales_costed s left join jt.variants v on v.variant_id = s.jt_variant_id
union all
select k.day, 'amazon', v.product_id, coalesce(nullif(v.product_title, ''), k.sku), coalesce(v.vendor, ''), coalesce(v.product_type, ''),
       k.units * coalesce(m.map_units, 1), k.sales, coalesce(k.units * m.cost, 0), k.sales - coalesce(k.units * m.cost, 0), k.sales - k.net
from jt.amazon_sku_daily k left join jt.mv_amz_sku_cost m on m.sku = k.sku left join jt.variants v on v.variant_id = m.variant_id
where k.lines > 0;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.mv_amz_sku_cost, jt.v_sales_channels_daily, jt.v_sales_products_daily to jt_reader;
  end if;
end $$;
