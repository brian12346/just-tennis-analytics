-- Start an order (Brian, Oct 14: "a plus button on Ready to approve to start an order — a smooth way to start the
-- ordering process" → vendor + reorder list). For one vendor's active products: what sold in the last 90 and 30 days
-- (Just Tennis Shopify, Ace n Rally, Amazon — Amazon units × the mapping's units per listing), what's on hand (Shopify
-- store, prep center, Amazon FBA + transfer + inbound + AWD), and what's already on open orders (drafts included, so a
-- product isn't ordered twice). The page works out the quantity (days of stock to hold, rounded up to the case pack).
create or replace function jt.reorder_plan(p_vendor text)
returns table (variant_id bigint, product_id bigint, title text, sku text, unit_cost numeric, status text,
               shop90 numeric, shop30 numeric, anr90 numeric, anr30 numeric, amz90 numeric, amz30 numeric,
               store integer, prep integer, amazon integer, on_order integer)
language sql stable security definer set search_path = '' as $$
  with v as (
    select x.variant_id, x.product_id, coalesce(nullif(x.display_name, ''), x.product_title) as title, x.sku, x.unit_cost, x.status, coalesce(x.inventory_qty, 0) as store
    from jt.variants x where lower(x.vendor) = lower(p_vendor) and x.removed_at is null and x.status = 'ACTIVE'),
  m as (
    select distinct on (d.data->>'sku') d.data->>'sku' as sku, ((regexp_match(d.data->>'variantId', '(\d+)$'))[1])::bigint as variant_id,
           greatest(coalesce(nullif(d.data->>'units', '')::numeric, 1), 1) as units
    from jt.docs d where d.collection = 'amzmap' and d.data->>'kind' = 'shopify'
    order by d.data->>'sku', d.data->>'updatedAt' desc nulls last),
  shop as (select s.variant_id, sum(s.units) as u90, sum(s.units) filter (where s.day > current_date - 30) as u30
    from jt.shopify_sales s where s.day > current_date - 90 and s.variant_id in (select variant_id from v) group by 1),
  anr as (select a.jt_variant_id as variant_id, sum(a.units) as u90, sum(a.units) filter (where a.day > current_date - 30) as u30
    from jt.v_anr_sales_final a where a.day > current_date - 90 and a.jt_variant_id in (select variant_id from v) group by 1),
  amz as (select m.variant_id, sum(a.units * m.units) as u90, sum(a.units * m.units) filter (where a.day > current_date - 30) as u30
    from jt.amazon_sku_daily a join m on m.sku = a.sku where a.day > current_date - 90 and m.variant_id in (select variant_id from v) group by 1),
  fba as (select s.variant_id, sum((s.fba_available + s.fba_transfer + s.fba_inbound + s.awd) * coalesce(s.map_units, 1))::int as qty
    from jt.v_asin_stock s where s.variant_id in (select variant_id from v) group by 1),
  prep as (select i.variant_id, sum(i.qty)::int as qty from jt.prep_items i where i.qty > 0 and i.variant_id in (select variant_id from v) group by 1),
  ord as (select l.variant_id, sum(greatest(l.qty_ordered - l.qty_received, 0))::int as qty
    from jt.prep_order_lines l join jt.prep_orders o on o.id = l.order_id
    where o.status in ('draft', 'ordered', 'invoiced', 'partial') and l.variant_id in (select variant_id from v) group by 1)
  select v.variant_id, v.product_id, v.title, v.sku, v.unit_cost, v.status,
         coalesce(shop.u90, 0), coalesce(shop.u30, 0), coalesce(anr.u90, 0), coalesce(anr.u30, 0), coalesce(amz.u90, 0), coalesce(amz.u30, 0),
         v.store, coalesce(prep.qty, 0), coalesce(fba.qty, 0), coalesce(ord.qty, 0)
  from v left join shop using (variant_id) left join anr using (variant_id) left join amz using (variant_id)
         left join fba using (variant_id) left join prep using (variant_id) left join ord using (variant_id)
$$;
revoke all on function jt.reorder_plan(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant execute on function jt.reorder_plan(text) to jt_reader; end if;
end $$;
