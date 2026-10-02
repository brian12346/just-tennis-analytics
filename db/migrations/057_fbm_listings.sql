-- FBM listings that Shopify has stock for: every merchant-fulfilled listing (channel DEFAULT in the All Listings
-- report uploaded on the Amazon mapping tab, jt.docs 'amzlistings') mapped to a Shopify variant with stock.
-- Shows on the FBM tab, so listings that are inactive or out of stock on Amazon while Shopify has the product stand out.
-- shopify_qty is the variant's total across Shopify locations (jt.variants.inventory_qty); packs = how many Amazon
-- units that makes when the listing is a multi-pack (map units > 1).
create or replace view jt.v_fbm_listings as
with lst as (
  select r->>0 as sku, coalesce(r->>1, '') as asin, coalesce(r->>2, '') as title,
         nullif(r->>3, '')::numeric as amazon_price, nullif(r->>4, '')::int as amazon_qty, coalesce(r->>6, '') as amazon_status,
         d.data->>'file' as report_file, (d.data->>'uploadedAt')::timestamptz as report_at
  from jt.docs d, jsonb_array_elements(d.data->'rows') r
  where d.collection = 'amzlistings' and r->>5 = 'DEFAULT'
),
maps as materialized (
  select data->>'sku' as sku,
         nullif(regexp_replace(coalesce(data->>'variantId', ''), '^.*/', ''), '')::bigint as variant_id,
         greatest(coalesce(nullif(data->>'units', '')::numeric, 1), 1) as map_units
  from jt.docs where collection = 'amzmap' and data->>'kind' = 'shopify'
)
select l.sku, l.asin, l.title, l.amazon_status, l.amazon_qty, l.amazon_price, l.report_file, l.report_at,
       m.variant_id, m.map_units, v.product_id, v.display_name as shopify_title, v.sku as shopify_sku,
       v.inventory_qty as shopify_qty, floor(v.inventory_qty / m.map_units)::int as packs, v.price as shopify_price
from lst l
join maps m on m.sku = l.sku
join jt.variants v on v.variant_id = m.variant_id
where v.inventory_qty > 0 and v.removed_at is null;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.v_fbm_listings to jt_reader;
  end if;
end $$;
