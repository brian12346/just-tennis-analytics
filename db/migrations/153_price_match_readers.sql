-- Price match: readers for brand sites that aren't plain Shopify stores (Brian, Oct 17: "build special connectors for
-- the non-shopify brands"). See sync/price_sources.py. Each brand has a reader (kind), how Just Tennis's variants are
-- matched to it (match: sku = the SKU or its first sku_prefix characters, base = the SKU's code before the first
-- "-" "(" "_", barcode = the UPC), and reader options.
--   Head        head.com (Next.js + Adobe Commerce) category data, matched by base code (232016-4 -> 232016)
--   Yonex       us.yonex.com is a Shopify store, but its SKUs aren't ours: matched by barcode (10-digit dealer codes too)
--   Babolat     babolat.com/us (Salesforce Commerce Cloud) product grid, matched by base code (101531-2 -> 101531)
--   K-Swiss     kswiss.com variant SKUs are UPCs: the product handle (04603-162-M) is matched to our SKU's first 11 characters
--   New Balance newbalance.com search for each colorway code (first 8 characters of our SKU), its own price
--   Dunlop      us.dunlopsports.com (SFCC, US prices) search by our article number (10369909)
--   Tecnifibre  tecnifibre.com shows euro prices (no US store): off; Amazon still covers it
alter table jt.pm_sources add column if not exists match text not null default 'sku';
alter table jt.pm_sources add column if not exists options jsonb not null default '{}'::jsonb;

update jt.pm_sources set kind = 'head_next', match = 'base', base_url = 'https://www.head.com/en_US',
  options = '{"categories": ["shop-tennis", "shop-pickleball", "shop-padel", "shop-footwear", "shop-racquetball"]}' where name = 'Head';
update jt.pm_sources set kind = 'shopify_barcode', match = 'barcode', base_url = 'https://us.yonex.com' where name = 'Yonex';
update jt.pm_sources set kind = 'sfcc_grid', match = 'base', base_url = 'https://www.babolat.com',
  options = '{"site": "babolatus", "locale": "en_US", "cgids": ["root"]}' where name = 'Babolat';
update jt.pm_sources set kind = 'shopify_site', match = 'sku', sku_prefix = 11, options = '{"key": "handle"}' where name = 'K-Swiss';
update jt.pm_sources set kind = 'sfcc_search', match = 'sku', sku_prefix = 8, base_url = 'https://www.newbalance.com',
  options = '{"site": "NBUS", "locale": "en_US", "variation": "style"}' where name = 'New Balance';
update jt.pm_sources set kind = 'sfcc_search', match = 'base', base_url = 'https://us.dunlopsports.com',
  options = '{"site": "DunlopSportsUS", "locale": "en_US"}' where name = 'Dunlop';
update jt.pm_sources set enabled = false, last_error = 'tecnifibre.com shows euro prices (no US store) — off; Amazon still covers Tecnifibre'
  where name = 'Tecnifibre';
