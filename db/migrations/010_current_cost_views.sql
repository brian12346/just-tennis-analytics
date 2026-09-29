-- Shopify sales re-costed with today's Shopify unit costs.
--
-- Shopify stores the cost of goods on each order as it was when the order was placed, so a cost that was wrong at the
-- time stays wrong in every past order even after it is fixed. These views put the variant's current Shopify cost on
-- every past sale instead (Jan 2025 on). The dashboard reads them by default ("Costs: current"); the tables keep what
-- Shopify recorded ("Costs: as recorded").
--
-- Rule per sales row: a row for a variant that has a cost in Shopify today gets units × today's cost and no longer
-- counts as sold without a cost. Custom items and variants that still have no cost keep what Shopify recorded.
-- Saved per-order costs (jt.cost_overrides) are applied on top by the dashboard, exactly as before.

create or replace view jt.v_shopify_sales_costed as
select s.day, s.order_id, s.order_name, s.variant_id, s.product_id, s.product_title, s.variant_title, s.sku,
       s.product_type, s.vendor, s.sales_channel, s.units, s.gross, s.discounts, s.returns, s.net,
       case when v.unit_cost is not null and s.variant_id <> 0 then round(s.units * v.unit_cost, 2) else s.cogs end as cogs,
       case when v.unit_cost is not null and s.variant_id <> 0 then 0 else s.net_no_cost end as net_no_cost,
       s.synced_at,
       s.cogs as cogs_recorded, s.net_no_cost as net_no_cost_recorded
from jt.shopify_sales s
left join jt.variants v on v.variant_id = s.variant_id;

-- Daily totals: Shopify's own daily figures, moved by the difference the re-costed rows make that day.
create or replace view jt.v_shopify_daily_costed as
with d as (
  select day, sum(cogs - cogs_recorded) as dcogs, sum(net_no_cost_recorded - net_no_cost) as dnc
  from jt.v_shopify_sales_costed group by day
)
select s.day, s.orders, s.gross, s.discounts, s.returns, s.net, s.shipping, s.taxes, s.total,
       round(s.cogs + coalesce(d.dcogs, 0), 2)          as cogs,
       round(s.gross_profit - coalesce(d.dcogs, 0), 2)  as gross_profit,
       round(s.net_no_cost - coalesce(d.dnc, 0), 2)     as net_no_cost,
       s.synced_at
from jt.shopify_daily s
left join d using (day);

-- Product sales tab, re-costed (same shape as jt.v_product_sales_daily; saved order costs applied the same way).
create or replace view jt.v_product_sales_daily_costed as
with s as (select * from jt.v_shopify_sales_costed),
o as (select order_id, sum(cogs) as cogs, sum(net_no_cost) as net_no_cost from s group by order_id),
a as (
  select s.*,
         case when ov.order_id is not null or abs(o.net_no_cost) < 0.01 then 0 else s.net_no_cost end as net_no_cost_adj,
         case when ov.order_id is not null and abs(o.net_no_cost) >= 0.01
              then (ov.cost - coalesce(ov.shopify_cogs, o.cogs)) * s.net_no_cost / o.net_no_cost else 0 end as cost_added
  from s join o using (order_id) left join jt.cost_overrides ov using (order_id)
)
select day, product_type, vendor, product_title, product_id, sales_channel,
       sum(units) as units, sum(gross) as gross, sum(discounts) as discounts, sum(returns) as returns,
       sum(net) as net, sum(cogs + cost_added) as cogs, sum(net - cogs - cost_added) as gross_profit,
       sum(net_no_cost_adj) as net_no_cost
from a
group by 1, 2, 3, 4, 5, 6;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.v_shopify_sales_costed, jt.v_shopify_daily_costed, jt.v_product_sales_daily_costed to jt_reader;
  end if;
end $$;
