-- Amazon.com.mx in fees, refunds and profit. Amazon's payments for Mexico were already being saved (the Finances API
-- sync reads every marketplace) but the Amazon tab used Amazon.com only. jt.v_amazon_fin_lines now has both, with money
-- in dollars (jt.settings amazon_fx, e.g. MXN 0.054 — the rate ordered sales already use) and a marketplace column mk;
-- the day documents (by ship date: jt_amazon_fin_build; by order date: jt.amazon_orderday_docs) total Mexico separately
-- as mx_orders / mx_sales / mx_net. amounts keeps Amazon's original currency.
create or replace view jt.v_amazon_fin_lines as
with fxs as (select value as v from jt.settings where key = 'amazon_fx')
select l.transaction_id, l.item, l.posted_at, l.type, l.description, l.status, l.order_id, l.marketplace, l.currency,
       l.sku, l.qty, l.fulfillment, round(l.total * c.fx, 2)::numeric(12,2) as total, l.amounts, l.updated_at,
       (l.posted_at at time zone 'America/Los_Angeles')::date as day,
       to_char(l.posted_at at time zone 'America/Los_Angeles', 'HH24:MI') as hm,
       case when l.release_of <> '' then 'release'
            when l.type = 'Transfer' then 'transfer'
            when l.type = 'Shipment' then 'order' when l.type = 'Refund' then 'refund' else 'other' end as kind,
       case
         when l.type in ('Shipment', 'Refund', 'Transfer') or l.release_of <> '' then null
         when l.description ~* 'storage' or l.type ~* 'storage' then 'storage'
         when l.type ~* 'shipping|label' or l.description ~* 'label' then 'labels'
         when l.type = 'ServiceFee' and l.description ~* '^(FBA|AWD)' then 'fbaother'
         when l.type = 'ServiceFee' then 'service'
         when l.type ~* '^FBA' and l.type !~* 'reimburse' then 'fbaother'
         else 'adjust'
       end as cat,
       round(jt.fin_sum(l.amounts, '^ProductCharges') * c.fx, 2)                                 as sales,
       round(jt.fin_sum(l.amounts, '^(Shipping|GiftWrap)') * c.fx, 2)                            as ship,
       round(jt.fin_sum(l.amounts, '^(Promotion|PromoRebates)') * c.fx, 2)                       as promo,
       round(jt.fin_sum(l.amounts, '^AmazonFees/(?!FBA|ShippingChargeback)') * c.fx, 2)          as sellfees,
       round(jt.fin_sum(l.amounts, '^(AmazonFees/(FBA|ShippingChargeback)|FBAFees/)') * c.fx, 2) as fbafees,
       l.release_of,
       case l.marketplace when 'ATVPDKIKX0DER' then 'us' when 'A1AM78C64UM0Y8' then 'mx' when 'A2EUQ1WTGCTBG2' then 'ca' else l.marketplace end as mk
from jt.amazon_fin_lines l
cross join lateral (select coalesce((select (v ->> l.currency)::numeric from fxs), case when l.currency in ('', 'USD') then 1 end) as fx) c
where l.marketplace in ('ATVPDKIKX0DER', 'A1AM78C64UM0Y8') and c.fx is not null;

-- by ship date: the same documents as before, plus Mexico's share
create or replace function public.jt_amazon_fin_build(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $function$
declare
  tgt text := coalesce(p->>'target', 'amzdays');
  days jsonb;
begin
  if tgt not in ('amzdays', 'amzdays_api') then raise exception 'unknown target %', tgt; end if;
  with l as (
    select * from jt.v_amazon_fin_lines where day between (p->>'first')::date and (p->>'last')::date
      and kind in ('order', 'refund', 'other')
  ),
  sk as (
    select day, sku, (row_number() over (partition by day order by min(posted_at), sku) - 1)::int as ix
    from l where kind in ('order', 'refund') and sku <> '' group by day, sku
  ),
  d as (
    select l.day,
      coalesce((select jsonb_agg(s.sku order by s.ix) from sk s where s.day = l.day), '[]'::jsonb) as skus,
      coalesce(jsonb_agg(jsonb_build_array(l.hm, l.order_id, s.ix, l.qty, round(l.sales, 2), round(l.ship, 2), round(l.promo, 2),
                                           round(l.sellfees, 2), round(l.fbafees, 2), round(l.total, 2), case when l.fulfillment = 'AFN' then 1 else 0 end)
                         order by l.posted_at, l.transaction_id, l.item) filter (where l.kind = 'order'), '[]'::jsonb) as orders,
      coalesce(jsonb_agg(jsonb_build_array(l.hm, l.order_id, coalesce(s.ix, -1), abs(l.qty), round(l.sales + l.ship + l.promo, 2),
                                           round(l.sellfees + l.fbafees, 2), round(l.total, 2))
                         order by l.posted_at, l.transaction_id, l.item) filter (where l.kind = 'refund'), '[]'::jsonb) as refunds,
      coalesce((select jsonb_object_agg(o.cat, o.v) from (select cat, round(sum(total), 2) v from l l2 where l2.day = l.day and l2.kind = 'other' group by cat) o), '{}'::jsonb) as other,
      jsonb_strip_nulls(jsonb_build_object(
        'orders', count(distinct l.order_id) filter (where l.kind = 'order'),
        'units', coalesce(sum(l.qty) filter (where l.kind = 'order'), 0),
        'sales', round(coalesce(sum(l.sales) filter (where l.kind = 'order'), 0), 2),
        'ship', round(coalesce(sum(l.ship) filter (where l.kind = 'order'), 0), 2),
        'promo', round(coalesce(sum(l.promo) filter (where l.kind = 'order'), 0), 2),
        'sellfees', round(coalesce(sum(l.sellfees) filter (where l.kind = 'order'), 0), 2),
        'fbafees', round(coalesce(sum(l.fbafees) filter (where l.kind = 'order'), 0), 2),
        'orders_net', round(coalesce(sum(l.total) filter (where l.kind = 'order'), 0), 2),
        'refunds_net', round(sum(l.total) filter (where l.kind = 'refund'), 2),
        'refund_sales', round(sum(l.sales + l.ship + l.promo) filter (where l.kind = 'refund'), 2),
        'refund_units', sum(abs(l.qty)) filter (where l.kind = 'refund'),
        'other', round(sum(l.total) filter (where l.kind = 'other'), 2),
        'mx_orders', count(distinct l.order_id) filter (where l.kind = 'order' and l.mk = 'mx'),
        'mx_sales', round(coalesce(sum(l.sales) filter (where l.kind = 'order' and l.mk = 'mx'), 0), 2),
        'mx_net', round(coalesce(sum(l.total) filter (where l.kind = 'order' and l.mk = 'mx'), 0), 2))) as totals
    from l left join sk s on s.day = l.day and s.sku = l.sku
    group by l.day
  )
  select coalesce(jsonb_agg(jsonb_build_object('date', to_char(day, 'YYYY-MM-DD'), 'skus', skus, 'orders', orders, 'refunds', refunds,
           'other', other, 'totals', totals, 'file', coalesce(p->>'file', 'SP-API Finances'),
           'uploadedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))), '[]'::jsonb)
  into days from d;
  if jsonb_array_length(days) = 0 then return 0; end if;
  return public.jt_amazon_fin_save(jsonb_build_object('target', tgt, 'days', days));
end $function$;

-- by order date: Amazon.com and Amazon.com.mx orders
create or replace function jt.amazon_orderday_docs(p_first date, p_last date) returns jsonb
language sql stable set search_path = '' as $$
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
        'est_orders', count(distinct order_id) filter (where est = 1), 'est_sales', coalesce(sum(sales) filter (where est = 1), 0),
        'mx_orders', count(distinct order_id) filter (where mk = 'mx'), 'mx_sales', coalesce(sum(sales) filter (where mk = 'mx'), 0),
        'mx_net', coalesce(sum(net) filter (where mk = 'mx'), 0)))
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

