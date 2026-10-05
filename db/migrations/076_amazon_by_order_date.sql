-- Amazon tab "By order date": fees, refunds and profit grouped by the day each order was bought (Pacific), so they line
-- up with ordered sales. Amazon's payments (jt.v_amazon_fin_lines) post when an order ships, so for each order line
-- bought in the range this uses what Amazon has paid on it so far (any posting day), and estimates the part that
-- hasn't shipped/posted yet: the order report's price, shipping and promotion, the SKU's own referral rate and FBA fee per
-- unit from its last 180 days (jt.v_amz_sku_fees; 15% and the store's average FBA fee when it has no history).
-- Refunds count on their order's purchase day; other charges (storage, inbound…) stay on the day Amazon posted them.
-- Amazon.com only, like the payments data. Returns the Amazon tab's day documents (the shape jt_amazon_fin_build saves to
-- jt.docs amzdays): order rows carry a 12th element, 1 = estimated (not paid by Amazon yet).
create index if not exists amazon_fin_lines_order on jt.amazon_fin_lines (order_id);

create or replace function jt.amazon_orderday_docs(p_first date, p_last date) returns jsonb
language sql stable set search_path = '' as $$
with ol as (   -- Amazon.com order lines bought in the range
  select l.order_id, l.sku, l.quantity as qty, coalesce(l.item_price, 0) as price,
         coalesce(l.shipping_price, 0) + coalesce(l.gift_wrap_price, 0) as ship, coalesce(l.item_promo, 0) + coalesce(l.ship_promo, 0) as promo,
         l.fulfillment, l.purchase_at, (l.purchase_at at time zone 'America/Los_Angeles')::date as day,
         to_char(l.purchase_at at time zone 'America/Los_Angeles', 'HH24:MI') as hm
  from jt.amazon_order_lines l
  where l.marketplace = 'us' and l.order_status <> 'Cancelled' and l.item_status <> 'Cancelled' and l.sku <> ''
    and (l.purchase_at at time zone 'America/Los_Angeles')::date between p_first and p_last
),
fo as (        -- what Amazon has paid on those lines so far
  select f.order_id, f.sku, sum(f.qty) as qty, sum(f.sales) as sales, sum(f.ship) as ship, sum(f.promo) as promo,
         sum(f.sellfees) as sellfees, sum(f.fbafees) as fbafees, sum(f.total) as total
  from jt.v_amazon_fin_lines f
  where f.kind = 'order' and f.order_id in (select order_id from ol) group by 1, 2
),
rate as (
  select sku, case when sales >= 50 and sell_fees < 0 then -sell_fees / sales end as ref,
         case when fba_units >= 2 and fba_fees < 0 then -fba_fees / fba_units end as fba
  from jt.v_amz_sku_fees
),
dflt as (select coalesce(sum(-fba_fees) / nullif(sum(fba_units), 0), 5) as fba from jt.v_amz_sku_fees where fba_units > 0 and fba_fees < 0),
x as (
  select ol.*, coalesce(fo.qty, 0) as fqty,
         case when ol.qty > 0 then greatest(ol.qty - coalesce(fo.qty, 0), 0)::numeric / ol.qty else case when fo.order_id is null then 1 else 0 end end as left_share,
         greatest(ol.qty - coalesce(fo.qty, 0), 0) as left_units,
         fo.sales as fsales, fo.ship as fship, fo.promo as fpromo, fo.sellfees as fsell, fo.fbafees as ffba, fo.total as ftotal,
         coalesce(r.ref, 0.15) as ref, coalesce(r.fba, d.fba) as fba
  from ol left join fo on fo.order_id = ol.order_id and fo.sku = ol.sku left join rate r on r.sku = ol.sku cross join dflt d
),
o as (         -- one row per order line: paid + estimated remainder
  select day, hm, order_id, sku, purchase_at as at, qty,
         round(coalesce(fsales, 0) + price * left_share, 2) as sales,
         round(coalesce(fship, 0) + ship * left_share, 2) as ship,
         round(coalesce(fpromo, 0) + promo * left_share, 2) as promo,
         round(coalesce(fsell, 0) - (price + ship + promo) * left_share * ref, 2) as sellfees,
         round(coalesce(ffba, 0) - case when fulfillment = 'Amazon' then fba * left_units else 0 end, 2) as fbafees,
         case when fulfillment = 'Amazon' then 1 else 0 end as afn,
         case when left_share > 0 then 1 else 0 end as est
  from x
),
o2 as (select o.*, round(sales + ship + promo + sellfees + fbafees, 2) as net from o),
pday as (      -- purchase day of the orders refunded in the range
  select order_id, min((purchase_at at time zone 'America/Los_Angeles')::date) as d from jt.amazon_order_lines
  where order_id in (select order_id from jt.v_amazon_fin_lines where kind = 'refund' and day >= p_first) group by 1
),
rf as (
  select coalesce(p.d, f.day) as day, f.hm, f.order_id, f.sku, f.posted_at as at, f.qty, f.sales, f.ship, f.promo, f.sellfees, f.fbafees, f.total, f.transaction_id, f.item
  from jt.v_amazon_fin_lines f left join pday p on p.order_id = f.order_id
  where f.kind = 'refund' and f.day >= p_first and coalesce(p.d, f.day) between p_first and p_last
),
ot as (select day, cat, total from jt.v_amazon_fin_lines where kind = 'other' and day between p_first and p_last),
sk as (
  select day, sku, (row_number() over (partition by day order by min(at), sku) - 1)::int as ix
  from (select day, sku, at from o2 union all select day, sku, at from rf where sku <> '') u group by day, sku
),
days as (select day from o2 union select day from rf union select day from ot),
d as (
  select dd.day,
    coalesce((select jsonb_agg(s.sku order by s.ix) from sk s where s.day = dd.day), '[]'::jsonb) as skus,
    coalesce((select jsonb_agg(jsonb_build_array(o2.hm, o2.order_id, s.ix, o2.qty, o2.sales, o2.ship, o2.promo, o2.sellfees, o2.fbafees, o2.net, o2.afn, o2.est)
                               order by o2.at, o2.order_id, o2.sku)
              from o2 join sk s on s.day = o2.day and s.sku = o2.sku where o2.day = dd.day), '[]'::jsonb) as orders,
    coalesce((select jsonb_agg(jsonb_build_array(rf.hm, rf.order_id, coalesce(s.ix, -1), abs(rf.qty), round(rf.sales + rf.ship + rf.promo, 2),
                                                 round(rf.sellfees + rf.fbafees, 2), round(rf.total, 2)) order by rf.at, rf.transaction_id, rf.item)
              from rf left join sk s on s.day = rf.day and s.sku = rf.sku where rf.day = dd.day), '[]'::jsonb) as refunds,
    coalesce((select jsonb_object_agg(cat, v) from (select cat, round(sum(total), 2) as v from ot where ot.day = dd.day group by cat) c), '{}'::jsonb) as other,
    (select jsonb_strip_nulls(jsonb_build_object(
        'orders', count(distinct order_id), 'units', coalesce(sum(qty), 0),
        'sales', coalesce(sum(sales), 0), 'ship', coalesce(sum(ship), 0), 'promo', coalesce(sum(promo), 0),
        'sellfees', coalesce(sum(sellfees), 0), 'fbafees', coalesce(sum(fbafees), 0), 'orders_net', coalesce(sum(net), 0),
        'est_orders', count(distinct order_id) filter (where est = 1), 'est_sales', coalesce(sum(sales) filter (where est = 1), 0)))
     from o2 where o2.day = dd.day) as t,
    (select jsonb_strip_nulls(jsonb_build_object('refunds_net', round(sum(total), 2), 'refund_sales', round(sum(sales + ship + promo), 2),
        'refund_units', sum(abs(qty)))) from rf where rf.day = dd.day) as tr,
    (select round(sum(total), 2) from ot where ot.day = dd.day) as tother
  from days dd
)
select coalesce(jsonb_agg(jsonb_build_object('date', to_char(day, 'YYYY-MM-DD'), 'skus', skus, 'orders', orders, 'refunds', refunds,
         'other', other, 'totals', t || coalesce(tr, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('other', tother)), 'basis', 'order')
         order by day), '[]'::jsonb)
from d
$$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant execute on function jt.amazon_orderday_docs(date, date) to jt_reader; end if;
end $$;
