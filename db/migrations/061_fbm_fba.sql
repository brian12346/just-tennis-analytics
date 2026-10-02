-- FBA stock per ASIN, for the FBM stock tab (listings grouped by ASIN: if Amazon holds the ASIN at FBA, the FBM
-- listing should stay at 0) and two alert changes: "stock not listed on Amazon" skips ASINs stocked at FBA, and a new
-- rule flags FBM listings with quantity while FBA has stock. FBA/AWD numbers come from the latest FBA Inventory and
-- AWD reports uploaded on the Amazon inventory tab (jt.docs 'fbainv' / 'awdinv').
create or replace view jt.v_asin_fba as
with f as (
  select r->>2 as asin, sum((r->>4)::numeric) as avail, sum((r->>5)::numeric + (r->>6)::numeric + (r->>7)::numeric) as inbound,
         sum((r->>11)::numeric) as t30, count(*) as skus, max(d.data->>'snapshot') as snapshot
  from jt.docs d, jsonb_array_elements(d.data->'rows') r where d.collection = 'fbainv' group by 1
),
a as (
  select r->>2 as asin, sum((r->>4)::numeric + (r->>5)::numeric + (r->>6)::numeric + (r->>8)::numeric) as awd
  from jt.docs d, jsonb_array_elements(d.data->'rows') r where d.collection = 'awdinv' group by 1
)
select coalesce(f.asin, a.asin) as asin,
       coalesce(f.avail, 0)::int as fba_available, coalesce(f.inbound, 0)::int as fba_inbound, coalesce(a.awd, 0)::int as awd,
       coalesce(f.t30, 0)::int as fba_t30, coalesce(f.skus, 0)::int as fba_skus,
       coalesce(f.avail, 0) + coalesce(f.inbound, 0) + coalesce(a.awd, 0) > 0 as stocked
from f full join a on a.asin = f.asin
where coalesce(f.asin, a.asin) <> '';

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.v_asin_fba to jt_reader; end if;
end $$;

insert into jt.alert_rules (code, category, title, description, action, params, sort) values
  ('fbm_listed_with_fba', 'inventory', 'Listed FBM while FBA has stock',
   'An active FBM listing has quantity on Amazon while Amazon holds the same ASIN at FBA (or AWD). FBA should carry it.',
   'Set the FBM quantity to 0 on the FBM stock tab.', '{}', 45)
on conflict (code) do nothing;

create or replace function jt.alert_candidates()
returns table (rule text, key text, title text, detail text, severity text, link jsonb, data jsonb)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  p jsonb;
  loc text := (select value->>'location_id' from jt.settings where key = 'fbm_sync');
  synced boolean := exists (select 1 from jt.location_stock s where s.location_id = loc);
begin
  -- ---------- shipping
  p := (select r.params from jt.alert_rules r where r.code = 'amazon_fbm_late');
  return query
    select 'amazon_fbm_late', l.order_id,
           format('Amazon %s order unshipped for %s h', upper(min(l.marketplace)), floor(extract(epoch from now() - min(l.purchase_at)) / 3600)::int),
           string_agg(format('%s × %s', l.quantity, coalesce(nullif(l.product_name, ''), l.sku)), '; ' order by l.sku),
           case when min(l.purchase_at) < now() - make_interval(hours => coalesce((p->>'crit_hours')::int, 48)) then 'critical' else 'warning' end,
           jsonb_build_object('url', 'https://sellercentral.amazon.com/orders-v3/order/' || l.order_id),
           jsonb_build_object('purchased', min(l.purchase_at), 'skus', jsonb_agg(l.sku))
    from (select * from jt.amazon_order_lines l0 where l0.purchase_at > now() - interval '30 days' offset 0) l   -- recent lines first
    where l.fulfillment = 'Merchant' and l.item_status = 'Unshipped' and l.order_status not in ('Cancelled')
      and l.purchase_at < now() - make_interval(hours => coalesce((p->>'warn_hours')::int, 24))
    group by l.order_id;

  p := (select r.params from jt.alert_rules r where r.code = 'shopify_unfulfilled');
  return query
    select 'shopify_unfulfilled', o.order_id::text,
           format('Shopify order %s not fulfilled after %s days', o.name, floor(extract(epoch from now() - o.created_at) / 86400)::int),
           format('%s item%s · $%s · %s', o.item_qty, case when o.item_qty = 1 then '' else 's' end, to_char(o.total, 'FM999,990.00'), initcap(lower(o.financial_status))),
           case when o.created_at < now() - make_interval(days => coalesce((p->>'crit_days')::int, 4)) then 'critical' else 'warning' end,
           jsonb_build_object('url', 'https://admin.shopify.com/store/justtennis-822/orders/' || o.order_id),
           jsonb_build_object('created', o.created_at, 'name', o.name)
    from jt.shopify_orders o
    where o.cancelled_at is null and not coalesce(o.test, false)
      and o.fulfillment_status in ('UNFULFILLED', 'PARTIALLY_FULFILLED', 'IN_PROGRESS', 'ON_HOLD')
      and o.financial_status in ('PAID', 'PARTIALLY_PAID', 'AUTHORIZED', 'PARTIALLY_REFUNDED')
      and coalesce(o.channel, '') not in ('pos')
      and o.created_at < now() - make_interval(days => coalesce((p->>'warn_days')::int, 2))
      and o.created_at > now() - interval '60 days';

  p := (select r.params from jt.alert_rules r where r.code = 'po_overdue');
  return query
    select 'po_overdue', po.id::text,
           format('%s PO %s is %s day%s late', po.vendor, coalesce(nullif(po.po_no, ''), '#' || po.id),
                  current_date - po.expected_on, case when current_date - po.expected_on = 1 then '' else 's' end),
           format('Expected %s · %s', to_char(po.expected_on, 'Mon DD'), case po.status when 'partial' then 'partly received' else po.status end),
           case when current_date - po.expected_on > coalesce((p->>'crit_days')::int, 7) then 'critical' else 'warning' end,
           jsonb_build_object('tab', 'po', 'id', po.id),
           jsonb_build_object('expected_on', po.expected_on, 'vendor', po.vendor)
    from jt.prep_orders po
    where po.status in ('ordered', 'invoiced', 'partial') and po.expected_on is not null
      and po.expected_on < current_date - coalesce((p->>'grace_days')::int, 0);

  -- ---------- inventory: FBM listings against FBM location stock
  return query
    with lst as (
      select r->>0 as sku, coalesce(r->>1, '') as asin, coalesce(r->>2, '') as ltitle, nullif(r->>4, '')::int as q, r->>6 as st,
             (d.data->>'uploadedAt')::timestamptz as report_at
      from jt.docs d, jsonb_array_elements(d.data->'rows') r
      where d.collection = 'amzlistings' and r->>5 = 'DEFAULT'
    ),
    maps as materialized (
      select m.data->>'sku' as sku, m.data->>'kind' as kind,
             nullif(regexp_replace(coalesce(m.data->>'variantId', ''), '^.*/', ''), '')::bigint as vid,
             greatest(coalesce(nullif(m.data->>'units', '')::numeric, 1), 1) as mu
      from jt.docs m where m.collection = 'amzmap'
    ),
    pushed as (select distinct on (f.sku) f.sku, f.quantity, f.status, f.requested_at from jt.fbm_pushes f where not f.preview order by f.sku, f.requested_at desc),
    x as (
      select l.*, m.kind, m.mu, v.variant_id, v.product_id, v.display_name,
             case when pu.status = 'ACCEPTED' and (l.report_at is null or pu.requested_at > l.report_at) then pu.quantity else l.q end as qnow,
             floor(greatest(case when synced then coalesce(ls.available, 0) else v.inventory_qty end, 0) / m.mu)::int as covers
      from lst l
      left join maps m on m.sku = l.sku
      left join jt.variants v on v.variant_id = m.vid and m.kind = 'shopify'
      left join jt.location_stock ls on ls.location_id = loc and ls.inventory_item_id = v.inventory_item_id
      left join pushed pu on pu.sku = l.sku
    )
    select 'fbm_oversell', x.sku,
           format('Amazon shows %s, stock covers %s', x.qnow, x.covers),
           format('%s (%s) → %s', x.ltitle, x.asin, x.display_name),
           case when x.covers = 0 then 'critical' else 'warning' end,
           jsonb_build_object('tab', 'fbm', 'q', x.sku),
           jsonb_build_object('asin', x.asin, 'amazon_qty', x.qnow, 'covers', x.covers, 'variant_id', x.variant_id, 'product_id', x.product_id)
    from x where x.st = 'Active' and x.variant_id is not null and coalesce(x.qnow, 0) > x.covers
    union all
    select 'fbm_unmapped_listed', 'all',
           format('%s FBM listings with quantity on Amazon aren''t mapped', count(*)),
           'Their stock can''t be checked against Shopify.', 'info',
           jsonb_build_object('tab', 'amzmap', 'skus', jsonb_agg(x.sku order by x.sku)),
           jsonb_build_object('count', count(*))
    from x where coalesce(x.qnow, 0) > 0 and x.kind is null
    having count(*) > 0
    union all
    select 'fbm_idle_stock', 'all',
           format('%s FBM listings have stock but 0 on Amazon', count(*)),
           format('%s units of Amazon quantity could be listed.', sum(x.covers)), 'info',
           jsonb_build_object('tab', 'fbm', 'filter', 'zero'),
           jsonb_build_object('count', count(*), 'units', sum(x.covers))
    from x where x.variant_id is not null and x.covers > 0 and coalesce(x.qnow, 0) = 0
      and not exists (select 1 from jt.v_asin_fba f where f.asin = x.asin and f.stocked)
    having count(*) > 0
    union all
    select 'fbm_listed_with_fba', x.sku,
           format('FBM shows %s while FBA has %s', x.qnow, f.fba_available + f.fba_inbound + f.awd),
           format('%s (%s) · FBA %s available, %s inbound, AWD %s', x.ltitle, x.asin, f.fba_available, f.fba_inbound, f.awd),
           'warning',
           jsonb_build_object('tab', 'fbm', 'q', x.asin),
           jsonb_build_object('asin', x.asin, 'amazon_qty', x.qnow, 'fba_available', f.fba_available, 'fba_inbound', f.fba_inbound, 'awd', f.awd)
    from x join jt.v_asin_fba f on f.asin = x.asin and f.stocked
    where x.st = 'Active' and coalesce(x.qnow, 0) > 0;

  p := (select r.params from jt.alert_rules r where r.code = 'fbm_not_taken_out');
  return query
    select 'fbm_not_taken_out', 'all',
           format('%s shipped FBM order%s not taken out of Shopify', count(distinct f.order_id), case when count(distinct f.order_id) = 1 then '' else 's' end),
           format('%s Shopify units; oldest from %s', coalesce(sum(f.units), 0), to_char(min(f.purchase_at) at time zone 'America/Los_Angeles', 'Mon DD')),
           case when min(f.purchase_at) < now() - interval '3 days' then 'warning' else 'info' end,
           jsonb_build_object('tab', 'fbm'),
           jsonb_build_object('orders', count(distinct f.order_id), 'units', coalesce(sum(f.units), 0))
    from jt.v_fbm_lines f
    where f.shipped and not f.cancelled and f.units is not null and (f.status is null or f.status = 'undone')
      and f.purchase_at < now() - make_interval(hours => coalesce((p->>'hours')::int, 24))
    having count(*) > 0;

  return query
    select 'fbm_sync_failed', 'shopify:' || d.order_id || ':' || d.sku,
           format('Shopify didn''t take FBM order %s', d.order_id), d.error, 'warning',
           jsonb_build_object('tab', 'fbm'), jsonb_build_object('order_id', d.order_id, 'sku', d.sku)
    from jt.fbm_decisions d where d.status = 'failed'
    union all
    select 'fbm_sync_failed', 'amazon:' || pu.sku,
           format('Amazon refused quantity %s for %s', pu.quantity, pu.sku),
           coalesce(nullif(pu.error, ''), 'Amazon said ' || pu.status), 'warning',
           jsonb_build_object('tab', 'fbm', 'q', pu.sku), jsonb_build_object('sku', pu.sku, 'asin', pu.asin)
    from (select distinct on (f.sku) f.* from jt.fbm_pushes f where not f.preview order by f.sku, f.requested_at desc) pu
    where pu.status <> 'ACCEPTED' and pu.requested_at > now() - interval '14 days';

  -- ---------- inventory: Shopify stock against sales pace
  return query
    with sh as (select s.variant_id, sum(s.units) as u from jt.shopify_sales s where s.day >= current_date - 30 and s.variant_id is not null group by 1),
    maps as (
      select m.data->>'sku' as sku, nullif(regexp_replace(coalesce(m.data->>'variantId', ''), '^.*/', ''), '')::bigint as vid,
             greatest(coalesce(nullif(m.data->>'units', '')::numeric, 1), 1) as mu
      from jt.docs m where m.collection = 'amzmap' and m.data->>'kind' = 'shopify'
    ),
    fl as materialized (   -- FBM units by seller SKU, last 30 days (filtered first: joining every mapping to the lines is slow)
      select l.sku, sum(l.quantity) as q from jt.amazon_order_lines l
      where l.purchase_at >= now() - interval '30 days' and l.fulfillment = 'Merchant' and l.order_status <> 'Cancelled' group by 1
    ),
    fbm as (select m.vid as variant_id, sum(fl.q * m.mu) as u from fl join maps m on m.sku = fl.sku group by 1),
    v as (
      select v.variant_id, v.product_id, v.display_name, v.sku, v.inventory_qty as q, (coalesce(sh.u, 0) + coalesce(fbm.u, 0))::numeric as u
      from jt.variants v left join sh on sh.variant_id = v.variant_id left join fbm on fbm.variant_id = v.variant_id
      where v.removed_at is null and coalesce(v.tracked, true) and coalesce(nullif(v.status, ''), 'ACTIVE') ilike 'active'
    ),
    po as (   -- units on open POs, so "reorder" alerts say if something's already coming
      select pl.variant_id, sum(greatest(coalesce(pl.qty_ordered, 0) - coalesce(pl.qty_received, 0), 0)) as incoming
      from jt.prep_order_lines pl join jt.prep_orders o on o.id = pl.order_id
      where o.status in ('ordered', 'invoiced', 'partial') group by 1
    ),
    pr as (
      select (select r.params from jt.alert_rules r where r.code = 'out_of_stock_selling') as oos,
             (select r.params from jt.alert_rules r where r.code = 'low_cover') as low
    )
    select 'out_of_stock_selling', v.variant_id::text,
           format('Out of stock: %s', v.display_name),
           format('%s sold in 30 days · Shopify shows %s%s', v.u::int, v.q, case when po.incoming > 0 then format(' · %s on open POs', po.incoming) else '' end),
           case when v.u >= coalesce((pr.oos->>'crit_units_30d')::int, 10) and coalesce(po.incoming, 0) = 0 then 'critical' else 'warning' end,
           jsonb_build_object('shopify', jsonb_build_object('product_id', v.product_id, 'variant_id', v.variant_id)),
           jsonb_build_object('sku', v.sku, 'units_30d', v.u, 'qty', v.q, 'incoming', coalesce(po.incoming, 0))
    from v cross join pr left join po on po.variant_id = v.variant_id
    where v.q <= 0 and v.u >= coalesce((pr.oos->>'min_units_30d')::int, 4)
    union all
    select 'low_cover', v.variant_id::text,
           format('%s days left: %s', floor(v.q * 30 / v.u)::int, v.display_name),
           format('%s in stock · %s sold in 30 days%s', v.q, v.u::int, case when po.incoming > 0 then format(' · %s on open POs', po.incoming) else '' end),
           case when v.q * 30 / v.u < coalesce((pr.low->>'crit_days')::int, 7) and coalesce(po.incoming, 0) = 0 then 'warning' else 'info' end,
           jsonb_build_object('shopify', jsonb_build_object('product_id', v.product_id, 'variant_id', v.variant_id)),
           jsonb_build_object('sku', v.sku, 'units_30d', v.u, 'qty', v.q, 'days', round(v.q * 30 / v.u, 1), 'incoming', coalesce(po.incoming, 0))
    from v cross join pr left join po on po.variant_id = v.variant_id
    where v.q > 0 and v.u >= coalesce((pr.low->>'min_units_30d')::int, 3) and v.q * 30 / v.u < coalesce((pr.low->>'days')::int, 14)
    union all
    select 'negative_stock', v.variant_id::text,
           format('Negative stock: %s', v.display_name), format('Shopify shows %s', v.q), 'warning',
           jsonb_build_object('shopify', jsonb_build_object('product_id', v.product_id, 'variant_id', v.variant_id)),
           jsonb_build_object('sku', v.sku, 'qty', v.q)
    from v cross join pr where v.q < 0 and v.u < coalesce((pr.oos->>'min_units_30d')::int, 4);   -- selling ones are under out_of_stock_selling
end $$;
