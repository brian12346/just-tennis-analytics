-- FBM listings with stock on Amazon but none in Shopify are listed too (Brian, Oct 28: "show ASINs where Amazon has more
-- stock assigned than we have in stock" — the worst case is Amazon showing units while the FBM location has none; before,
-- the list only had listings with Shopify stock or a send from here).
create or replace view jt.v_fbm_listings as
 WITH cfg AS (
         SELECT ( SELECT (settings.value ->> 'location_id'::text)
                   FROM jt.settings
                  WHERE (settings.key = 'fbm_sync'::text)) AS loc
        ), lst AS (
         SELECT (r.value ->> 0) AS sku,
            COALESCE((r.value ->> 1), ''::text) AS asin,
            COALESCE((r.value ->> 2), ''::text) AS title,
            (NULLIF((r.value ->> 3), ''::text))::numeric AS amazon_price,
            (NULLIF((r.value ->> 4), ''::text))::integer AS amazon_qty,
            COALESCE((r.value ->> 6), ''::text) AS amazon_status,
            (d.data ->> 'file'::text) AS report_file,
            ((d.data ->> 'uploadedAt'::text))::timestamp with time zone AS report_at
           FROM jt.docs d,
            LATERAL jsonb_array_elements((d.data -> 'rows'::text)) r(value)
          WHERE ((d.collection = 'amzlistings'::text) AND ((r.value ->> 5) = 'DEFAULT'::text))
        ), maps AS MATERIALIZED (
         SELECT (docs.data ->> 'sku'::text) AS sku,
            (NULLIF(regexp_replace(COALESCE((docs.data ->> 'variantId'::text), ''::text), '^.*/'::text, ''::text), ''::text))::bigint AS variant_id,
            GREATEST(COALESCE((NULLIF((docs.data ->> 'units'::text), ''::text))::numeric, (1)::numeric), (1)::numeric) AS map_units
           FROM jt.docs
          WHERE ((docs.collection = 'amzmap'::text) AND ((docs.data ->> 'kind'::text) = 'shopify'::text))
        ), synced AS (
         SELECT (EXISTS ( SELECT 1
                   FROM jt.location_stock s,
                    cfg cfg_1
                  WHERE (s.location_id = cfg_1.loc))) AS yes
        ), pushed AS (
         SELECT DISTINCT ON (fbm_pushes.sku) fbm_pushes.sku,
            fbm_pushes.quantity,
            fbm_pushes.status,
            fbm_pushes.issues,
            fbm_pushes.error,
            fbm_pushes.requested_at,
            fbm_pushes.requested_by
           FROM jt.fbm_pushes
          WHERE (NOT fbm_pushes.preview)
          ORDER BY fbm_pushes.sku, fbm_pushes.requested_at DESC
        )
 SELECT l.sku,
    l.asin,
    l.title,
    l.amazon_status,
    l.amazon_qty,
    l.amazon_price,
    l.report_file,
    l.report_at,
    m.variant_id,
    m.map_units,
    v.product_id,
    v.display_name AS shopify_title,
    v.sku AS shopify_sku,
        CASE
            WHEN synced.yes THEN COALESCE(ls.available, 0)
            ELSE v.inventory_qty
        END AS shopify_qty,
    (floor(((GREATEST(
        CASE
            WHEN synced.yes THEN COALESCE(ls.available, 0)
            ELSE v.inventory_qty
        END, 0))::numeric / m.map_units)))::integer AS packs,
    v.price AS shopify_price,
    v.inventory_qty AS shopify_total,
        CASE
            WHEN synced.yes THEN 'location'::text
            ELSE 'total'::text
        END AS stock_source,
        CASE
            WHEN ((pu.status = 'ACCEPTED'::text) AND ((l.report_at IS NULL) OR (pu.requested_at > l.report_at))) THEN pu.quantity
            ELSE l.amazon_qty
        END AS amazon_qty_now,
    pu.quantity AS pushed_qty,
    pu.status AS pushed_status,
    pu.requested_at AS pushed_at,
    pu.requested_by AS pushed_by,
    COALESCE(NULLIF(pu.error, ''::text), ( SELECT string_agg((i.value ->> 'message'::text), '; '::text) AS string_agg
           FROM jsonb_array_elements(pu.issues) i(value)
          WHERE ((i.value ->> 'severity'::text) = 'ERROR'::text))) AS pushed_error
   FROM ((((((lst l
     CROSS JOIN cfg)
     CROSS JOIN synced)
     JOIN maps m ON ((m.sku = l.sku)))
     JOIN jt.variants v ON (((v.variant_id = m.variant_id) AND (v.removed_at IS NULL))))
     LEFT JOIN jt.location_stock ls ON (((ls.location_id = cfg.loc) AND (ls.inventory_item_id = v.inventory_item_id))))
     LEFT JOIN pushed pu ON ((pu.sku = l.sku)))
  WHERE ((
        CASE
            WHEN synced.yes THEN COALESCE(ls.available, 0)
            ELSE v.inventory_qty
        END > 0) OR (pu.sku IS NOT NULL) OR (COALESCE(l.amazon_qty, 0) > 0));
