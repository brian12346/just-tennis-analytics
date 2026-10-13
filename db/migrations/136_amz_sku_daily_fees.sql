-- Amazon Research › profit per SKU (Brian, Oct 13): jt.amazon_sku_daily also keeps each SKU's shipping credits,
-- promotions, selling (referral) fees, FBA fees, FBM label cost (Veeqo labels for the order, split across its lines by
-- units) and refunds (by purchase day, as the day documents have them). Filled from the order-date day documents
-- (jt.docs 'amzodays') like before; every stored day is filled again below.
--   orders line:  [hm, order_id, sku index, qty, sales, ship, promo, sellfees, fbafees, net, afn, est]
--   refunds line: [hm, order_id, sku index (-1 = none), qty, sales + ship + promo, fees, total]
alter table jt.amazon_sku_daily add column if not exists ship numeric not null default 0;
alter table jt.amazon_sku_daily add column if not exists promo numeric not null default 0;
alter table jt.amazon_sku_daily add column if not exists sellfees numeric not null default 0;
alter table jt.amazon_sku_daily add column if not exists fbafees numeric not null default 0;
alter table jt.amazon_sku_daily add column if not exists labels numeric not null default 0;
alter table jt.amazon_sku_daily add column if not exists refund_units numeric not null default 0;
alter table jt.amazon_sku_daily add column if not exists refund_sales numeric not null default 0;
alter table jt.amazon_sku_daily add column if not exists refund_net numeric not null default 0;

create or replace function jt.amazon_sku_daily_fill(p_day date, p_data jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; k text[]; ord jsonb := coalesce(p_data->'orders', '[]'::jsonb); t jsonb := coalesce(p_data->'totals', '{}'::jsonb);
  ref jsonb := coalesce(p_data->'refunds', '[]'::jsonb); oth jsonb := coalesce(p_data->'other', '{}'::jsonb); lab numeric; rest numeric;
begin
  k := array(select jsonb_array_elements_text(coalesce(p_data->'skus', '[]'::jsonb)));   -- once: indexing the jsonb per line is slow
  -- SKUs no longer in the day go to zero (no bare deletes through the API's pg-safeupdate), the rest are upserted
  update jt.amazon_sku_daily set lines = 0, units = 0, sales = 0, net = 0, ship = 0, promo = 0, sellfees = 0, fbafees = 0, labels = 0,
    refund_units = 0, refund_sales = 0, refund_net = 0
  where day = p_day and (lines <> 0 or refund_units <> 0 or refund_net <> 0);
  insert into jt.amazon_sku_daily as t (day, sku, lines, units, sales, net, ship, promo, sellfees, fbafees, labels, refund_units, refund_sales, refund_net)
  with o as (
    select o->>1 as oid, coalesce(k[(o->>2)::int + 1], '?') as sku, (o->>3)::numeric as qty, (o->>4)::numeric as sales, (o->>5)::numeric as ship,
           (o->>6)::numeric as promo, (o->>7)::numeric as sellfees, (o->>8)::numeric as fbafees, (o->>9)::numeric as net
    from jsonb_array_elements(ord) o),
  oq as (select oid, sum(qty) as q, count(*) as nl from o group by oid),
  lb as (select v.amazon_order_id as oid, sum(v.cost) as c from jt.veeqo_shipments v
         where v.cost is not null and v.amazon_order_id = any(array(select distinct oid from o)) group by 1),
  ol as (select o.sku, count(*) as lines, sum(o.qty) as units, sum(o.sales) as sales, sum(o.net) as net, sum(o.ship) as ship, sum(o.promo) as promo,
                sum(o.sellfees) as sellfees, sum(o.fbafees) as fbafees,
                round(sum(coalesce(lb.c * case when oq.q > 0 then o.qty / oq.q else 1.0 / oq.nl end, 0)), 2) as labels
         from o join oq on oq.oid = o.oid left join lb on lb.oid = o.oid group by o.sku),
  rf as (select k[(r->>2)::int + 1] as sku, sum(abs((r->>3)::numeric)) as ru, sum((r->>4)::numeric) as rs, sum((r->>6)::numeric) as rn
         from jsonb_array_elements(ref) r where (r->>2)::int >= 0 and k[(r->>2)::int + 1] is not null group by 1)
  select p_day, coalesce(ol.sku, rf.sku), coalesce(ol.lines, 0), coalesce(ol.units, 0), coalesce(ol.sales, 0), coalesce(ol.net, 0),
         coalesce(ol.ship, 0), coalesce(ol.promo, 0), coalesce(ol.sellfees, 0), coalesce(ol.fbafees, 0), coalesce(ol.labels, 0),
         coalesce(rf.ru, 0), coalesce(rf.rs, 0), coalesce(rf.rn, 0)
  from ol full join rf on rf.sku = ol.sku
  on conflict (day, sku) do update set lines = excluded.lines, units = excluded.units, sales = excluded.sales, net = excluded.net,
    ship = excluded.ship, promo = excluded.promo, sellfees = excluded.sellfees, fbafees = excluded.fbafees, labels = excluded.labels,
    refund_units = excluded.refund_units, refund_sales = excluded.refund_sales, refund_net = excluded.refund_net;
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
