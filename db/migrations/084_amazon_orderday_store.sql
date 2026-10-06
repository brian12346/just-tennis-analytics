-- Amazon tab "By order date": store the day documents (jt.docs collection amzodays, one per Pacific purchase day)
-- instead of building them on every page view, and make building them cheap.
--   jt.amazon_orderday_docs(first, last)  rebuilt below: once the payments history reached back to Jan 2025, the old
--                                         version read every payment line (~690K) on each call, and the tab's calls
--                                         ran the database out of memory (the restarts on Oct 5). Same results.
--   jt.amazon_orderday_save(first, last)  builds and stores those days (a day with nothing gets an empty document)
--   jt.amazon_orderday_refresh(14)        hourly (cron :28): the last 14 days, plus the purchase days of orders refunded
--                                         or paid in the last 2 days (an old order's refund lands on its purchase day)
--   jt.amazon_orderday_refresh(60)        nightly (cron 12:15 UTC)
--   jt.amazon_orderday_backfill_step()    every minute until done: Jan 1, 2025 → yesterday, 7 days a step (~5 s)
--                                         (progress in jt.settings 'odays_backfill')
-- The tab reads stored days and builds only today and yesterday live.
-- Payments and refunds are read by order id (index) and the per-SKU fee rates once per call.
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
o2 as (select o.*, round(sales + ship + promo + sellfees + fbafees, 2) as net from o),
pids as (      -- every order bought in the range (any status): its refunds count on its purchase day
  select order_id, min((purchase_at at time zone 'America/Los_Angeles')::date) as d from jt.amazon_order_lines
  where (purchase_at at time zone 'America/Los_Angeles')::date between p_first and p_last group by 1
),
rf as (
  select p.d as day, f.hm, f.order_id, f.sku, f.posted_at as at, f.qty, f.sales, f.ship, f.promo, f.sellfees, f.fbafees, f.total, f.transaction_id, f.item
  from jt.v_amazon_fin_lines f join pids p on p.order_id = f.order_id
  where f.kind = 'refund' and f.order_id = any(array(select order_id from pids)) and f.day >= p_first
  union all     -- refunds of orders we have no order line for stay on the day Amazon posted them
  select f.day, f.hm, f.order_id, f.sku, f.posted_at, f.qty, f.sales, f.ship, f.promo, f.sellfees, f.fbafees, f.total, f.transaction_id, f.item
  from jt.v_amazon_fin_lines f
  where f.kind = 'refund' and f.day between p_first and p_last
    and not exists (select 1 from jt.amazon_order_lines l where l.order_id = f.order_id)
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

create or replace function jt.amazon_orderday_save(p_first date, p_last date) returns int
language plpgsql security definer set search_path = '' as $$
declare v_docs jsonb;
begin
  v_docs := coalesce(jt.amazon_orderday_docs(p_first, p_last), '[]'::jsonb);
  -- every day in the range gets a document; a day with nothing (no orders, refunds or charges) gets an empty one
  insert into jt.docs (collection, id, data, updated_at)
  select 'amzodays', to_char(g.day, 'YYYY-MM-DD'),
         coalesce(d.doc, jsonb_build_object('date', to_char(g.day, 'YYYY-MM-DD'), 'skus', '[]'::jsonb, 'orders', '[]'::jsonb,
                  'refunds', '[]'::jsonb, 'other', '{}'::jsonb, 'totals', '{}'::jsonb, 'basis', 'order')), now()
  from generate_series(p_first, p_last, interval '1 day') g(day)
  left join (select x->>'date' as id, x as doc from jsonb_array_elements(v_docs) x) d on d.id = to_char(g.day, 'YYYY-MM-DD')
  on conflict (collection, id) do update set data = excluded.data, updated_at = now();
  return jsonb_array_length(v_docs);
end $$;

create or replace function jt.amazon_orderday_refresh(p_days int default 14) returns int
language plpgsql security definer set search_path = '' as $$
declare t date := (now() at time zone 'America/Los_Angeles')::date; n int := 0; d date;
begin
  n := jt.amazon_orderday_save(t - (p_days - 1), t);
  if p_days < 60 then
    for d in
      select distinct (l.purchase_at at time zone 'America/Los_Angeles')::date
      from jt.amazon_order_lines l
      where l.order_id in (select f.order_id from jt.amazon_fin_lines f where f.posted_at > now() - interval '2 days')
        and (l.purchase_at at time zone 'America/Los_Angeles')::date < t - (p_days - 1)
      order by 1 desc limit 40
    loop
      n := n + jt.amazon_orderday_save(d, d);
    end loop;
  end if;
  return n;
end $$;

create or replace function jt.amazon_orderday_backfill_step() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st jsonb; nxt date; fin date; n int;
begin
  select value into st from jt.settings where key = 'odays_backfill';
  if st is null or coalesce((st->>'done')::boolean, false) then return st; end if;
  nxt := (st->>'next')::date; fin := (st->>'end')::date;
  if nxt > fin then
    st := st || jsonb_build_object('done', true, 'finished_at', now());
  else
    n := jt.amazon_orderday_save(nxt, least(nxt + 6, fin));
    st := st || jsonb_build_object('next', least(nxt + 6, fin) + 1, 'days', coalesce((st->>'days')::int, 0) + n, 'at', now());
  end if;
  update jt.settings set value = st, updated_at = now() where key = 'odays_backfill';
  return st;
end $$;
revoke all on function jt.amazon_orderday_save(date, date), jt.amazon_orderday_refresh(int), jt.amazon_orderday_backfill_step() from public;

insert into jt.settings (key, value)
values ('odays_backfill', jsonb_build_object('next', '2025-01-01', 'end', ((now() at time zone 'America/Los_Angeles')::date - 1)::text, 'done', false))
on conflict (key) do nothing;

create index if not exists amazon_fin_lines_posted on jt.amazon_fin_lines (posted_at);

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'jt-amazon-odays-hourly') then
      perform cron.schedule('jt-amazon-odays-hourly', '28 * * * *', 'select jt.amazon_orderday_refresh(14)');
    end if;
    if not exists (select 1 from cron.job where jobname = 'jt-amazon-odays-nightly') then
      perform cron.schedule('jt-amazon-odays-nightly', '15 12 * * *', 'select jt.amazon_orderday_refresh(60)');
    end if;
    if not exists (select 1 from cron.job where jobname = 'jt-amazon-odays-backfill') then
      perform cron.schedule('jt-amazon-odays-backfill', '* * * * *', 'select jt.amazon_orderday_backfill_step()');
    end if;
  end if;
end $$;
