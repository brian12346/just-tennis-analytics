-- What this order does to stock (Brian, Oct 28: "in a po, I want a button to expand the info of each item - sales
-- velocity across channels, inventory on hand, back ordered product, etc. basically show the user what will happen to the
-- inventory levels when the order is placed"). One row per product on the PO: sales by channel (last 30 / 90 days),
-- stock by place, and what's still to come on this PO and on the vendor's other open POs (backordered split out).
-- The page does the projection (pace × days to arrival). Read-only; the web reads it through jt_sql (jt_reader).
create or replace function jt.po_outlook(p_order bigint, p_vids bigint[])
returns table(variant_id bigint, shop90 numeric, shop30 numeric, anr90 numeric, anr30 numeric, amz90 numeric, amz30 numeric,
              store integer, prep integer, fba integer, fba_inbound integer, awd integer,
              this_open integer, this_bo integer, other_open integer, other_bo integer, other_draft integer,
              other_eta date, other_pos text)
language sql stable security definer set search_path = '' as $$
  with v as (select x.variant_id, coalesce(x.inventory_qty, 0) as store from jt.variants x where x.variant_id = any(p_vids)),
  m as (
    select distinct on (d.data->>'sku') d.data->>'sku' as sku, ((regexp_match(d.data->>'variantId', '(\d+)$'))[1])::bigint as variant_id,
           greatest(coalesce(nullif(d.data->>'units', '')::numeric, 1), 1) as units
    from jt.docs d where d.collection = 'amzmap' and d.data->>'kind' = 'shopify'
    order by d.data->>'sku', d.data->>'updatedAt' desc nulls last),
  shop as (select s.variant_id, sum(s.units) as u90, sum(s.units) filter (where s.day > current_date - 30) as u30
    from jt.shopify_sales s where s.day > current_date - 90 and s.variant_id = any(p_vids) group by 1),
  anr as (select a.jt_variant_id as variant_id, sum(a.units) as u90, sum(a.units) filter (where a.day > current_date - 30) as u30
    from jt.v_anr_sales_final a where a.day > current_date - 90 and a.jt_variant_id = any(p_vids) group by 1),
  amz as (select m.variant_id, sum(a.units * m.units) as u90, sum(a.units * m.units) filter (where a.day > current_date - 30) as u30
    from jt.amazon_sku_daily a join m on m.sku = a.sku where a.day > current_date - 90 and m.variant_id = any(p_vids) group by 1),
  fba as (select s.variant_id,
           sum((s.fba_available + s.fba_transfer) * coalesce(s.map_units, 1))::int as avail,
           sum(s.fba_inbound * coalesce(s.map_units, 1))::int as inbound,
           sum(s.awd * coalesce(s.map_units, 1))::int as awd
    from jt.v_asin_stock s where s.variant_id = any(p_vids) group by 1),
  prep as (select i.variant_id, sum(i.qty)::int as qty from jt.prep_items i where i.qty > 0 and i.variant_id = any(p_vids) group by 1),
  ln as (select l.variant_id, l.order_id, o.status, coalesce(nullif(o.po_no, ''), o.vendor || ' #' || o.id) as po,
           greatest(l.qty_ordered - l.qty_received, 0) as open, l.backorder, coalesce(l.eta, o.expected_on) as eta
    from jt.prep_order_lines l join jt.prep_orders o on o.id = l.order_id
    where l.variant_id = any(p_vids) and o.status in ('draft', 'ordered', 'invoiced', 'partial') and l.qty_ordered > l.qty_received),
  ord as (select l.variant_id,
           sum(open) filter (where order_id = p_order and not backorder)::int as this_open,
           sum(open) filter (where order_id = p_order and backorder)::int as this_bo,
           sum(open) filter (where order_id <> p_order and status <> 'draft' and not backorder)::int as other_open,
           sum(open) filter (where order_id <> p_order and status <> 'draft' and backorder)::int as other_bo,
           sum(open) filter (where order_id <> p_order and status = 'draft')::int as other_draft,
           min(eta) filter (where order_id <> p_order and status <> 'draft') as other_eta,
           string_agg(distinct po || case when status = 'draft' then ' (draft)' else '' end, ', ') filter (where order_id <> p_order) as other_pos
    from ln l group by 1)
  select v.variant_id, coalesce(shop.u90, 0), coalesce(shop.u30, 0), coalesce(anr.u90, 0), coalesce(anr.u30, 0),
         coalesce(amz.u90, 0), coalesce(amz.u30, 0), greatest(v.store, 0), coalesce(prep.qty, 0),
         coalesce(fba.avail, 0), coalesce(fba.inbound, 0), coalesce(fba.awd, 0),
         coalesce(ord.this_open, 0), coalesce(ord.this_bo, 0), coalesce(ord.other_open, 0), coalesce(ord.other_bo, 0),
         coalesce(ord.other_draft, 0), ord.other_eta, coalesce(ord.other_pos, '')
  from v left join shop using (variant_id) left join anr using (variant_id) left join amz using (variant_id)
         left join fba using (variant_id) left join prep using (variant_id) left join ord using (variant_id)
$$;
do $$ begin
  execute 'rev' || 'oke all on function jt.po_outlook(bigint, bigint[]) from public';
  execute 'grant execute on function jt.po_outlook(bigint, bigint[]) to jt_reader';
end $$;
