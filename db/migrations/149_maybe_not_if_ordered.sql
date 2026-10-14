-- Inventory › Discontinued: "Maybe discontinued" (missing from the vendor's latest complete pricelist) leaves out
-- products ordered from the vendor in the last 6 months — they're still carried even when the portal's main catalog
-- doesn't list them (Head's Ti.S6 and GrapheneXT come from another HEAD program).
create or replace function jt.discontinued_view()
returns table (variant_id bigint, product_id bigint, title text, sku text, vendor text, shop_status text, unit_cost numeric,
               store integer, prep integer, amazon integer, sold90 numeric, last_sale date, kind text,
               disc_since date, disc_source text, disc_by text, note text, availability text, list_cost numeric, msrp numeric)
language sql stable security definer set search_path = '' as $$
  with latest as (select distinct on (lower(l.vendor)) l.id, lower(l.vendor) as vendor from jt.vendor_price_lists l where l.full_list order by lower(l.vendor), l.uploaded_at desc),
  maybe as (
    select v.variant_id from jt.variants v join latest on latest.vendor = lower(v.vendor)
    where v.removed_at is null and v.status = 'ACTIVE'
      and not exists (select 1 from jt.vendor_price_rows r where r.list_id = latest.id and r.variant_id = v.variant_id)
      and not exists (select 1 from jt.product_status s where s.variant_id = v.variant_id and (s.discontinued or s.disc_source = 'manual'))
      -- ordered from the vendor in the last 6 months: still carried (e.g. Head's Ti.S6 isn't in its main OMS catalog)
      -- (by product or base SKU: an order may point at another record of the same product)
      and not exists (select 1 from jt.prep_order_lines l join jt.prep_orders o on o.id = l.order_id join jt.variants ov on ov.variant_id = l.variant_id
                      where o.created_at > now() - interval '180 days'
                        and (ov.product_id = v.product_id or (split_part(ov.sku, '-', 1) = split_part(v.sku, '-', 1) and length(split_part(v.sku, '-', 1)) >= 5)))
      and not exists (select 1 from jt.shopify_po_lines l join jt.shopify_pos sp on sp.id = l.po_id join jt.variants ov on ov.variant_id = l.variant_id
                      where sp.created_at > now() - interval '180 days'
                        and (ov.product_id = v.product_id or (split_part(ov.sku, '-', 1) = split_part(v.sku, '-', 1) and length(split_part(v.sku, '-', 1)) >= 5)))),
  k as (select s.variant_id, 'disc'::text as kind from jt.product_status s where s.discontinued
        union all select m.variant_id, 'maybe' from maybe m),
  m as (select distinct on (d.data->>'sku') d.data->>'sku' as sku, ((regexp_match(d.data->>'variantId', '(\d+)$'))[1])::bigint as variant_id,
               greatest(coalesce(nullif(d.data->>'units', '')::numeric, 1), 1) as units
        from jt.docs d where d.collection = 'amzmap' and d.data->>'kind' = 'shopify' order by d.data->>'sku', d.data->>'updatedAt' desc nulls last),
  sales as (
    select x.variant_id, sum(x.units) filter (where x.day > current_date - 90) as u90, max(x.day) as last_day from (
      select s.variant_id, s.day, s.units from jt.shopify_sales s where s.variant_id in (select variant_id from k) and s.units > 0
      union all
      select m.variant_id, a.day, a.units * m.units from jt.amazon_sku_daily a join m on m.sku = a.sku where m.variant_id in (select variant_id from k) and a.units > 0) x
    group by 1)
  select v.variant_id, v.product_id, coalesce(nullif(v.display_name, ''), v.product_title), v.sku, v.vendor, v.status, v.unit_cost,
         st.store, st.prep, st.amazon, coalesce(sales.u90, 0), sales.last_day, k.kind,
         ps.disc_since, coalesce(ps.disc_source, ''), coalesce(ps.disc_by, ''), coalesce(ps.note, ''), coalesce(ps.availability, ''), ps.list_cost, ps.msrp
  from k join jt.variants v on v.variant_id = k.variant_id and v.removed_at is null
    left join jt.v_variant_stock st on st.variant_id = v.variant_id
    left join sales on sales.variant_id = v.variant_id
    left join jt.product_status ps on ps.variant_id = v.variant_id
$$;
