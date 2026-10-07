-- Just Tennis in All sales: product cost and "no cost" sales now include costs entered by hand on the Just Tennis tab
-- (jt.cost_overrides, mostly POS custom items). The channel row took them from the daily totals, which don't know about
-- those entries: 12 months showed $48K of sales "with no cost" that had a cost, and $11.6K of cost was missing.
-- Product cost and no-cost sales now come from the product lines (v_product_sales_daily_costed, which applies them).

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
units_jt as (select day, sum(units) as units, sum(cogs) as cogs, sum(net_no_cost) as net_no_cost from jt.v_product_sales_daily_costed group by day),
units_anr as (select day, sum(units) as units from jt.v_anr_sales_costed group by day),
pay as (select store, day, sum(fee) as fee from jt.v_shopify_payment_fees group by 1, 2)
select s.day, 'justtennis'::text as channel, s.orders::numeric as orders, coalesce(u.units, 0) as units, s.net as net_sales,
       coalesce(u.cogs, s.cogs) as cogs, s.net - coalesce(u.cogs, s.cogs) as gross_profit, coalesce(u.net_no_cost, s.net_no_cost) as sales_no_cost,
       s.shipping as ship_charged, coalesce(l.cost, 0) as labels, 0::numeric as amz_fees, 0::numeric as fba_fees, 0::numeric as other_fees,
       s.net - coalesce(u.cogs, s.cogs) + s.shipping - coalesce(l.cost, 0) - coalesce(p.fee, 0) as profit, coalesce(p.fee, 0) as pay_fees
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

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.v_sales_channels_daily to jt_reader; end if;
end $$;
