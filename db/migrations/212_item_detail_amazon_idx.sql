-- Item detail (Nov 4, Brian: "include sales for all channels including fba … and for all asins"). The popup reads one
-- variant's Amazon sales: its seller SKUs from jt.mv_amz_sku_cost (variant_id), then each SKU's days in
-- jt.amazon_sku_daily (keyed day, sku, so a SKU's rows were a full scan, ~1.8 s).
create index if not exists amazon_sku_daily_sku on jt.amazon_sku_daily (sku, day);
create index if not exists mv_amz_sku_cost_variant on jt.mv_amz_sku_cost (variant_id);
