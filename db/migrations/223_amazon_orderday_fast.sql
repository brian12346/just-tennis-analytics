-- Faster Amazon order-day documents (Nov 19, Brian: "please make the amazon job faster"). The hourly
-- jt-amazon-odays-hourly job (jt.amazon_orderday_refresh(14), at :28) took 81 seconds and slowed every page while it ran.
--   jt.amazon_orderday_docs: each day's orders, refunds and totals are now built with one join and a group by
--     (it was a correlated subquery per day joining every order line to every SKU): 14 days 21.5 s -> 2.5 s, same documents
--     (checked equal on the last 14 days, a single day and a 16-day range).
--   jt.amazon_orderday_refresh: older days Amazon paid on in the last 2 days are rebuilt in runs of consecutive days
--     (was one call per day, up to 40).
create or replace function jt.amazon_orderday_docs(p_first date, p_last date) returns jsonb
language sql stable set search_path to '' as $fn$
with fxs as (select value as v from jt.settings where key = 'amazon_fx'),
ol as (   -- Amazon.com and Amazon.com.mx order lines bought in the range, in dollars
  select l.order_id, l.sku, l.quantity as qty, l.marketplace as mk,
         round(coalesce(l.item_price, 0) * c.fx, 2) as price,
         round((coalesce(l.shipping_price, 0) + coalesce(l.gift_wrap_price, 0)) * c.fx, 2) as ship,
         round((coalesce(l.item_promo, 0) + coalesce(l.ship_promo, 0)) * c.fx, 2) as promo,
         l.fulfillment, l.purchase_at, (l.purchase_at at time zone 'America/Los_Angeles')::date as day,
         to_char(l.purchase_at at time zone 'America/Los_Angeles', 'HH24:MI') as hm
  from jt.amazon_order_lines l
  cross join lateral (select coalesce((select (v ->> l.currency)::numeric from fxs), case when l.currency in ('', 'USD') then 1 end) as fx) c
  where l.marketplace in ('us', 'mx') and l.order_status <> 'Cancelled' and l.item_status <> 'Cancelled' and l.sku <> '' and c.fx is not null
    and (l.purchase_at at time zone 'America/Los_Angeles')::date between p_first and p_last
),
fo as (        -- what Amazon has paid on those lines so far
  select f.order_id, f.sku, sum(f.qty) as qty, sum(f.sales) as sales, sum(f.ship) as ship, sum(f.promo) as promo,
         sum(f.sellfees) as sellfees, sum(f.fbafees) as fbafees, sum(f.total) as total
  from jt.v_amazon_fin_lines f
  where f.kind = 'order' and f.order_id = any(array(select distinct order_id from ol)) group by 1, 2   -- by index, not a scan
),
sf as materialized (select * from jt.v_amz_sku_fees),   -- read once (it unpacks 180 days of day documents)
rate as (
  select sku, case when sales >= 50 and sell_fees < 0 then -sell_fees / sales end as ref,
         case when fba_units >= 2 and fba_fees < 0 then -fba_fees / fba_units end as fba
  from sf
),
dflt as (select coalesce(sum(-fba_fees) / nullif(sum(fba_units), 0), 5) as fba from sf where fba_units > 0 and fba_fees < 0),
x as (
  select ol.*, coalesce(fo.qty, 0) as fqty,
         case when ol.qty > 0 then greatest(ol.qty - coalesce(fo.qty, 0), 0)::numeric / ol.qty else case when fo.order_id is null then 1 else 0 end end as left_share,
         greatest(ol.qty - coalesce(fo.qty, 0), 0) as left_units,
         fo.sales as fsales, fo.ship as fship, fo.promo as fpromo, fo.sellfees as fsell, fo.fbafees as ffba, fo.total as ftotal,
         coalesce(r.ref, 0.15) as ref, coalesce(r.fba, d.fba) as fba
  from ol left join fo on fo.order_id = ol.order_id and fo.sku = ol.sku left join rate r on r.sku = ol.sku cross join dflt d
),
o as (         -- one row per order line: paid + estimated remainder
  select day, hm, order_id, sku, mk, purchase_at as at, qty,
         round(coalesce(fsales, 0) + price * left_share, 2) as sales,
         round(coalesce(fship, 0) + ship * left_share, 2) as ship,
         round(coalesce(fpromo, 0) + promo * left_share, 2) as promo,
         round(coalesce(fsell, 0) - (price + ship + promo) * left_share * ref, 2) as sellfees,
         round(coalesce(ffba, 0) - case when fulfillment = 'Amazon' then fba * left_units else 0 end, 2) as fbafees,
         case when fulfillment = 'Amazon' then 1 else 0 end as afn,
         case when left_share > 0 then 1 else 0 end as est
  from x
),
o2 as materialized (select o.*, round(sales + ship + promo + sellfees + fbafees, 2) as net from o),
pids as (      -- every order bought in the range (any status): its refunds count on its purchase day
  select order_id, min((purchase_at at time zone 'America/Los_Angeles')::date) as d from jt.amazon_order_lines
  where (purchase_at at time zone 'America/Los_Angeles')::date between p_first and p_last group by 1
),
rf as materialized (
  select p.d as day, f.hm, f.order_id, f.sku, f.posted_at as at, f.qty, f.sales, f.ship, f.promo, f.sellfees, f.fbafees, f.total, f.transaction_id, f.item
  from jt.v_amazon_fin_lines f join pids p on p.order_id = f.order_id
  where f.kind = 'refund' and f.order_id = any(array(select order_id from pids)) and f.day >= p_first
  union all     -- refunds of orders we have no order line for stay on the day Amazon posted them
  select f.day, f.hm, f.order_id, f.sku, f.posted_at, f.qty, f.sales, f.ship, f.promo, f.sellfees, f.fbafees, f.total, f.transaction_id, f.item
  from jt.v_amazon_fin_lines f
  where f.kind = 'refund' and f.day between p_first and p_last
    and not exists (select 1 from jt.amazon_order_lines l where l.order_id = f.order_id)
),
ot as materialized (select day, cat, total from jt.v_amazon_fin_lines where kind = 'other' and day between p_first and p_last),
sk as materialized (
  select day, sku, (row_number() over (partition by day order by min(at), sku) - 1)::int as ix
  from (select day, sku, at from o2 union all select day, sku, at from rf where sku <> '') u group by day, sku
),
-- Nov 19: built with one join and a group by per part (was a correlated subquery per day joining every order line to
-- every SKU: 20 seconds for 14 days); same documents
ds as (select day, jsonb_agg(sku order by ix) as skus from sk group by day),
dor as (
  select o2.day,
    jsonb_agg(jsonb_build_array(o2.hm, o2.order_id, s.ix, o2.qty, o2.sales, o2.ship, o2.promo, o2.sellfees, o2.fbafees, o2.net, o2.afn, o2.est)
              order by o2.at, o2.order_id, o2.sku) as orders,
    jsonb_strip_nulls(jsonb_build_object(
        'orders', count(distinct o2.order_id), 'units', coalesce(sum(o2.qty), 0),
        'sales', coalesce(sum(o2.sales), 0), 'ship', coalesce(sum(o2.ship), 0), 'promo', coalesce(sum(o2.promo), 0),
        'sellfees', coalesce(sum(o2.sellfees), 0), 'fbafees', coalesce(sum(o2.fbafees), 0), 'orders_net', coalesce(sum(o2.net), 0),
        'est_orders', count(distinct o2.order_id) filter (where o2.est = 1), 'est_sales', coalesce(sum(o2.sales) filter (where o2.est = 1), 0),
        'mx_orders', count(distinct o2.order_id) filter (where o2.mk = 'mx'), 'mx_sales', coalesce(sum(o2.sales) filter (where o2.mk = 'mx'), 0),
        'mx_net', coalesce(sum(o2.net) filter (where o2.mk = 'mx'), 0))) as t
  from o2 join sk s on s.day = o2.day and s.sku = o2.sku group by o2.day
),
drf as (
  select rf.day,
    jsonb_agg(jsonb_build_array(rf.hm, rf.order_id, coalesce(s.ix, -1), abs(rf.qty), round(rf.sales + rf.ship + rf.promo, 2),
                                round(rf.sellfees + rf.fbafees, 2), round(rf.total, 2)) order by rf.at, rf.transaction_id, rf.item) as refunds,
    jsonb_strip_nulls(jsonb_build_object('refunds_net', round(sum(rf.total), 2), 'refund_sales', round(sum(rf.sales + rf.ship + rf.promo), 2),
        'refund_units', sum(abs(rf.qty)))) as tr
  from rf left join sk s on s.day = rf.day and s.sku = rf.sku group by rf.day
),
dot as (select day, jsonb_object_agg(cat, v) as other from (select day, cat, round(sum(total), 2) as v from ot group by 1, 2) c group by day),
dtot as (select day, round(sum(total), 2) as tother from ot group by day),
days as (select day from o2 union select day from rf union select day from ot),
d as (
  select dd.day, coalesce(ds.skus, '[]'::jsonb) as skus, coalesce(dor.orders, '[]'::jsonb) as orders, coalesce(drf.refunds, '[]'::jsonb) as refunds,
    coalesce(dot.other, '{}'::jsonb) as other,
    coalesce(dor.t, jsonb_build_object('orders', 0, 'units', 0, 'sales', 0, 'ship', 0, 'promo', 0, 'sellfees', 0, 'fbafees', 0, 'orders_net', 0,
                                       'est_orders', 0, 'est_sales', 0, 'mx_orders', 0, 'mx_sales', 0, 'mx_net', 0)) as t,
    drf.tr, dtot.tother
  from days dd left join ds using (day) left join dor using (day) left join drf using (day) left join dot using (day) left join dtot using (day)
)
select coalesce(jsonb_agg(jsonb_build_object('date', to_char(day, 'YYYY-MM-DD'), 'skus', skus, 'orders', orders, 'refunds', refunds,
         'other', other, 'totals', t || coalesce(tr, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('other', tother)), 'basis', 'order')
         order by day), '[]'::jsonb)
from d
$fn$;

create or replace function jt.amazon_orderday_refresh(p_days integer default 14) returns integer
language plpgsql security definer set search_path to '' as $$
declare t date := (now() at time zone 'America/Los_Angeles')::date; n int := 0; r record;
begin
  n := jt.amazon_orderday_save(t - (p_days - 1), t);
  if p_days < 60 then
    for r in
      with d as (
        select distinct (l.purchase_at at time zone 'America/Los_Angeles')::date as day
        from jt.amazon_order_lines l
        where l.order_id in (select f.order_id from jt.amazon_fin_lines f where f.posted_at > now() - interval '2 days')
          and (l.purchase_at at time zone 'America/Los_Angeles')::date < t - (p_days - 1)
        order by 1 desc limit 40),
      g as (select day, day - (row_number() over (order by day))::int as grp from d)
      select min(day) as a, max(day) as b from g group by grp order by 1 desc
    loop
      n := n + jt.amazon_orderday_save(r.a, r.b);
    end loop;
  end if;
  return n;
end $$;
