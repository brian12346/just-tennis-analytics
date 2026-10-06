-- Shopify payment processing fees (Brian, Oct 6): every Shopify Payments balance transaction (charges, refunds,
-- chargebacks, adjustments) for Just Tennis and Ace n Rally, from the payments account (sync job shopify-fees,
-- hourly; needs the app's Shopify Payments scope — a store without it is skipped and says why in jt.sync_runs).
-- Fees count on the order's day (the day it was placed), else the day Shopify processed the transaction.
-- Other gateways (PayPal etc.) aren't in Shopify Payments and aren't counted.

create table if not exists jt.shopify_payment_tx (
  store        text not null,               -- justtennis | acenrally
  id           bigint not null,
  type         text not null default '',    -- CHARGE, REFUND, DISPUTE_WITHDRAWAL, ADJUSTMENT, ...
  source_type  text not null default '',
  processed_at timestamptz not null,
  amount       numeric not null default 0,
  fee          numeric not null default 0,  -- what Shopify kept (positive = a cost)
  net          numeric not null default 0,
  currency     text not null default 'USD',
  order_id     bigint,
  order_name   text not null default '',
  test         boolean not null default false,
  synced_at    timestamptz not null default now(),
  primary key (store, id)
);
create index if not exists shopify_payment_tx_order on jt.shopify_payment_tx (store, order_id);

create or replace view jt.v_shopify_payment_fees as
select t.store, coalesce(case t.store when 'justtennis' then o.order_day else a.order_day end,
                         (t.processed_at at time zone 'America/Los_Angeles')::date) as day,
       t.type, t.order_id, t.amount, t.fee, t.net
from jt.shopify_payment_tx t
left join jt.shopify_orders o on t.store = 'justtennis' and o.order_id = t.order_id
left join jt.anr_orders a on t.store = 'acenrally' and a.order_id = t.order_id
where not t.test;

-- channels: profit is after payment fees; pay_fees is its own column (new columns go last)
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
                   from jt.amazon_sku_daily k left join jt.v_amz_sku_cost m on m.sku = k.sku where k.day = a.day) c on true
left join veeqo v on v.day = a.day;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.shopify_payment_tx, jt.v_shopify_payment_fees, jt.v_sales_channels_daily to jt_reader;
  end if;
end $$;
