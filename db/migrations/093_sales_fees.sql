-- All sales: shipping and fees as their own columns (Brian, Oct 6).
--   ship_charged  shipping customers paid (Shopify shipping; Amazon shipping credits)
--   labels        shipping labels bought: ShipStation for Just Tennis and Ace n Rally (each label counted once, on its
--                 own store), and for Amazon the labels bought in Seller Central plus Veeqo labels for FBM orders
--   amz_fees      Amazon referral (selling) fees
--   fba_fees      Amazon FBA fulfillment fees
--   other_fees    Amazon promotions, refunds, and other charges (storage, inbound, adjustments)
--   profit        after product cost, shipping and fees
-- All costs are positive numbers. Shopify payment processing fees aren't in the data yet.

alter table jt.amazon_order_daily add column if not exists ship numeric not null default 0;
alter table jt.amazon_order_daily add column if not exists promo numeric not null default 0;
alter table jt.amazon_order_daily add column if not exists sellfees numeric not null default 0;
alter table jt.amazon_order_daily add column if not exists fbafees numeric not null default 0;
alter table jt.amazon_order_daily add column if not exists other_labels numeric not null default 0;   -- Seller Central labels (negative)
alter table jt.amazon_order_daily add column if not exists other_rest numeric not null default 0;     -- the rest of "other" (negative)

create or replace function jt.amazon_sku_daily_fill(p_day date, p_data jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; k text[]; ord jsonb := coalesce(p_data->'orders', '[]'::jsonb); t jsonb := coalesce(p_data->'totals', '{}'::jsonb);
  oth jsonb := coalesce(p_data->'other', '{}'::jsonb); lab numeric; rest numeric;
begin
  k := array(select jsonb_array_elements_text(coalesce(p_data->'skus', '[]'::jsonb)));   -- once: indexing the jsonb per line is slow
  -- SKUs no longer in the day go to zero (no bare deletes through the API's pg-safeupdate), the rest are upserted
  update jt.amazon_sku_daily set lines = 0, units = 0, sales = 0, net = 0 where day = p_day and lines <> 0;
  insert into jt.amazon_sku_daily as t (day, sku, lines, units, sales, net)
  select p_day, coalesce(k[(o->>2)::int + 1], '?'), count(*), sum((o->>3)::numeric), sum((o->>4)::numeric), sum((o->>9)::numeric)
  from jsonb_array_elements(ord) o
  group by 2
  on conflict (day, sku) do update set lines = excluded.lines, units = excluded.units, sales = excluded.sales, net = excluded.net;
  get diagnostics n = row_count;
  lab := coalesce((oth->>'labels')::numeric, 0);
  select coalesce(sum(v::numeric), 0) - lab into rest from jsonb_each_text(oth) x(k2, v) where v ~ '^-?[0-9.]+$';
  insert into jt.amazon_order_daily (day, orders, units, sales, orders_net, refunds_net, ship, promo, sellfees, fbafees, other_labels, other_rest)
  values (p_day, coalesce((t->>'orders')::numeric, 0), coalesce((t->>'units')::numeric, 0), coalesce((t->>'sales')::numeric, 0),
          coalesce((t->>'orders_net')::numeric, 0), coalesce((t->>'refunds_net')::numeric, 0), coalesce((t->>'ship')::numeric, 0),
          coalesce((t->>'promo')::numeric, 0), coalesce((t->>'sellfees')::numeric, 0), coalesce((t->>'fbafees')::numeric, 0), lab, rest)
  on conflict (day) do update set orders = excluded.orders, units = excluded.units, sales = excluded.sales,
    orders_net = excluded.orders_net, refunds_net = excluded.refunds_net, ship = excluded.ship, promo = excluded.promo,
    sellfees = excluded.sellfees, fbafees = excluded.fbafees, other_labels = excluded.other_labels, other_rest = excluded.other_rest;
  return n;
end $$;
revoke all on function jt.amazon_sku_daily_fill(date, jsonb) from public;

do $$ declare d record; begin
  for d in select id, data from jt.docs where collection = 'amzodays' and id ~ '^\d{4}-\d{2}-\d{2}$' loop
    perform jt.amazon_sku_daily_fill(d.id::date, d.data);
  end loop;
end $$;

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
units_anr as (select day, sum(units) as units from jt.v_anr_sales_costed group by day)
select s.day, 'justtennis'::text as channel, s.orders::numeric as orders, coalesce(u.units, 0) as units, s.net as net_sales,
       s.cogs, s.gross_profit, s.net_no_cost as sales_no_cost,
       s.shipping as ship_charged, coalesce(l.cost, 0) as labels, 0::numeric as amz_fees, 0::numeric as fba_fees, 0::numeric as other_fees,
       s.gross_profit + s.shipping - coalesce(l.cost, 0) as profit
from jt.v_shopify_daily_costed s left join units_jt u on u.day = s.day left join jt_labels l on l.day = s.day
union all
select a.day, 'acenrally', a.orders::numeric, coalesce(u.units, 0), a.net, a.cogs, a.gross_profit, a.net_no_cost,
       a.shipping, coalesce(l.cost, 0), 0, 0, 0, a.gross_profit + a.shipping - coalesce(l.cost, 0)
from jt.v_anr_daily_costed a left join units_anr u on u.day = a.day left join anr_labels l on l.day = a.day
union all
select a.day, 'amazon', a.orders, a.units, a.sales, coalesce(c.cogs, 0), a.sales - coalesce(c.cogs, 0), coalesce(c.no_cost, 0),
       a.ship, -a.other_labels + coalesce(v.cost, 0), -a.sellfees, -a.fbafees, -(a.promo + a.refunds_net + a.other_rest),
       a.orders_net + a.refunds_net + a.other_labels + a.other_rest - coalesce(c.cogs, 0) - coalesce(v.cost, 0)
from jt.amazon_order_daily a
left join lateral (select sum(k.units * m.cost) as cogs, sum(case when m.cost is null then k.sales else 0 end) as no_cost
                   from jt.amazon_sku_daily k left join jt.v_amz_sku_cost m on m.sku = k.sku where k.day = a.day) c on true
left join veeqo v on v.day = a.day;

-- products: gross profit = sales − product cost on every channel (Amazon was after fees in 092); Amazon fees (referral,
-- FBA, promotions on the order lines) in their own column
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
from jt.amazon_sku_daily k left join jt.v_amz_sku_cost m on m.sku = k.sku left join jt.variants v on v.variant_id = m.variant_id
where k.lines > 0;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.v_sales_channels_daily, jt.v_sales_products_daily to jt_reader; end if;
end $$;
