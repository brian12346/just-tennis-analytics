# Data model (schema `jt`)

## Tables

| Table | Grain | Filled by |
|---|---|---|
| `shopify_daily` | day | Shopify Analytics daily totals (exactly what Shopify reports) |
| `shopify_sales` | day × order × variant × channel | Shopify Analytics. Returns land on the return day. `cogs` is the cost Shopify recorded at the time of sale; `net_no_cost` is sales with no cost recorded. `variant_id = 0` means custom item. |
| `shopify_orders`, `shopify_order_lines` | order, line item | Admin API (orders changed since the last run) |
| `variants` | variant | Nightly full catalog snapshot, with today's cost |
| `variant_cost_changes` | day × variant | Nightly: every cost that changed since the previous snapshot |
| `cost_overrides` | order | Costs typed in the dashboard's cost-mapping tab |
| `shipstation_labels` | label | ShipStation API; `order_id` is the Shopify order id |
| `amazon_transactions` | report line | Seller Central Date Range report (re-uploading the same file adds nothing) |
| `amazon_listings`, `amazon_map` | Amazon SKU | All Listings report; mapping to Shopify variants from the dashboard |
| `settings`, `sync_runs` | — | Cost settings; one row per sync job run |

## Views the dashboard reads

| View | Use |
|---|---|
| `v_daily` | Shopify tab: daily totals with entered costs applied, label cost, profit after shipping |
| `v_order_profit` | Shopify tab orders table |
| `v_product_sales_daily` | Product sales tab (sum over the chosen dates) |
| `v_costmap_orders`, `v_costmap_lines` | Cost-mapping tab: orders still missing a cost and the lines to fill |
| `v_amazon_daily`, `v_amazon_lines` | Amazon tab, with product cost from the mapping |
| `v_sync_status` | Last run of each sync job |

## Cost rules

**Entered costs** (`cost_overrides`): `cost` is the order's full product cost; `shopify_cogs` is the Shopify
cost it was built on, so the amount added is `cost - shopify_cogs`. That amount is spread across the order's
no-cost sales rows in proportion, on the day Shopify recorded each row, so a later return takes its share back.
An order whose no-cost items were all returned nets to zero and is not flagged.

**Cost history** (`variant_cost_on(variant, day)`): today's Shopify cost applies to all history, except where a
change counts as *real*; then sales before the change keep the old cost. A change is real when its `kind` is
`'real'`, or when `kind` is empty and it was made on/after `settings.costs.history_start` (earlier edits were
corrections while costs were being cleaned up). Changes take effect the day after they were detected.

## Vendor invoices (Invoices tab)

- The tab is a board: one swimlane per stage (`jt.invoices.stage`; lane keys and names in `dashboard/src/js/invoices.js`,
  STAGES). Cards move by drag and drop or the Stage menu in the invoice popup (`jt.update_invoice_card`, allowed even
  after costs were applied). `stage_at` = when it entered its current stage; `po_no` = PO / booking reference.

- `jt.invoices`, `jt.invoice_lines` — invoices uploaded as PDFs (read in the browser with pdf.js), with each line's
  matched Shopify variant. Drafts can be edited; `jt.apply_invoice(id)` locks one and queues its updates.
- `jt.vendor_items` — remembered matches (vendor + normalized item code → variant), filled when an invoice is applied
  and used first when matching the next invoice from that vendor.
- `jt.price_rules` — (not used yet: price updates from invoices are turned off in the dashboard) suggested-price rule per vendor (`*` = default): target margin, or null to keep each item's
  current margin; rounding `.99` / `.95` / `.00` / `none`.
- Applying queues rows in `jt.cost_updates` (new cost and/or `new_price`, `invoice_id`); the sync job `cost-updates`
  writes costs with `inventoryItemUpdate` (write_inventory) and prices with `productVariantsBulkUpdate` (write_products).
- Matching order: remembered code → exact SKU → UPC (`jt.variants.barcode`, from the catalog sync) → SKU containing the
  code (same vendor) → title words (same vendor, shown as a guess to confirm).

## Amazon matching tab

- Step 1 · Vendors: each Amazon listing gets a Shopify vendor (`jt.amazon_vendors`, written with
  `jt.set_amazon_vendors`; `-` = not sold in Shopify). Guessed from the brand in the title or the seller-SKU prefix,
  confirmed one by one or in bulk per vendor filter.
- Step 2 · Products: guesses only consider the confirmed vendor's Shopify products.

- Suggests a Shopify variant for each unmapped Amazon listing (`dashboard/src/js/amz-match.js`): Shopify SKU written in
  the listing, brand, product words weighted by rarity, and attributes that must agree (pack size, string gauge / mm,
  grip size, colour, junior length, racquet model number / year, product kind). "2 Packs of <string>" = 2 units.
- Approve writes `amzmap/<sku>` (same shape as the Amazon mapping tab, plus `via: "match"`); Deny adds the variant to
  `amzdeny/<sku>.variants` so the next guess shows; "No match" sets `amzdeny/<sku>.none`.
- Checked against the 85 hand-made mappings (Sep 25): top guess agreed on 77; most of the rest are duplicate products
  in Shopify (e.g. two Hyper-G set products).

## Cost basis for past Shopify sales

- Shopify stores the cost of goods on each order as it was when the order was placed. The dashboard instead uses the
  variant's **current** Shopify cost for every past sale by default (views `jt.v_shopify_sales_costed`,
  `jt.v_shopify_daily_costed`, `jt.v_product_sales_daily_costed`, migration 010), so fixing a wrong cost fixes history.
- Rule: a sales row for a variant with a cost today = units × today's cost, no longer "sold without cost". Custom items
  and variants still without a cost keep what Shopify recorded. Saved per-order costs still apply on top.
- The "Costs" switch (Shopify and Product sales tabs) flips to "As recorded on each order" (per viewer, stored in the
  browser). Amazon profit uses current costs for all history while `settings/costs.historyStart` is null (cleanup mode).

## Amazon inventory tab (FBA + AWD)

- Upload: Seller Central → Reports → Fulfillment → Inventory → **FBA Inventory** (CSV). Stored in `jt.docs` collection `fbainv`
  (`c000`, `c001`, … 150 rows each; the latest upload replaces the previous one). Rows with no units anywhere are dropped.
- Row: `[sku, fnsku, asin, name, available, transfer, inbound, reservedForOrders, unfulfillable, yourPrice, featuredPrice,
  shippedT30, shippedT90, daysOfSupply, health, storageType, storageNextMonth, agedOver180]`.
  `transfer` = fc-transfer + reserved FC processing + reserved staging. Units reserved for customer orders are already sold and not counted.
- Units valued = available + transfer (+ inbound, on by default). Cost per Amazon unit comes from the listing's mapping
  (`amzmap`: Shopify variant cost × units, or a manual cost). Price = your Amazon price (featured offer if blank).
- Estimated fees per unit = referral rate × price + FBA fee, from `jt.v_amz_sku_fees` (migration 011: each seller SKU's
  Transaction-report sales in the 180 days up to the latest day loaded). SKUs without history: 15% referral and the
  median FBA fee of SKUs with the same storage type. Profit = price − fees − cost (storage fees not included).
- The Product costs tab adds FBA at cost to the inventory total (Shopify and FBA shown separately). Shopify's on-hand
  counts don't include FBA units, so the two don't overlap.
- AWD: Seller Central AWD inventory report (CSV with "Timestamp / Merchant ID" lines, then one row per SKU), uploaded with the
  same button (the columns tell the reports apart). Stored in `jt.docs` collection `awdinv`; row
  `[sku, fnsku, asin, name, inboundToAwd, availableInAwd, reservedInAwd, researching, outboundToFba]`.
  AWD units valued = available + researching (+ inbound to AWD). Reserved-in-AWD and outbound-to-FBA units are left out because the
  FBA report already counts them as FBA inbound (checked on the Sep 28/29 reports: they match FBA inbound SKU by SKU).
  All / FBA / AWD switch on the tab; Product costs shows Amazon at cost split FBA vs AWD.

## Prep center (Prep center tab)

- The physical warehouse is two digital warehouses: Shopify inventory, and the prep center (stock set aside to send to Amazon).
- `jt.prep_items` (migration 012): on-hand per Shopify variant, optionally earmarked for one Amazon seller SKU (`amazon_sku`, '' = any).
  `jt.prep_moves`: every change (`adjust` = count, `ship` = shipment to FBA/AWD, `seed` = starting inventory), with before/after and who.
- `jt.prep_adjust(p)` sets counts (new on-hand, not a delta); `jt.prep_ship(p)` takes units out and fails if a line is short;
  `jt.prep_seed(p)` replaces everything (starting inventory, run by Claude). Web wrappers `public.jt_prep_adjust / jt_prep_ship` record the signed-in email.
- Value: units × Shopify cost; Amazon value uses the earmarked listing (or the only listing mapped to the product) and its units-per-Amazon-unit.
- The Inventory value tab shows Shopify, prep center and Amazon separately; shipped units reappear as Amazon inbound once the next FBA / AWD report is uploaded.

## One ASIN = one mapping (migration 013)

- `jt.v_amz_sku_asin`: seller SKU → ASIN from the listings, FBA, AWD and prep-center files and the mappings themselves.
- `jt.fill_asin_mappings(sku)`: copies a SKU's mapping to the other seller SKUs of its ASIN (`via: "asin"`, `fromSku`);
  with no argument, fills every ASIN whose mapped SKUs agree. A trigger on `jt.docs` runs it whenever a mapping is saved
  (hand-made sibling mappings are never overwritten; automatic copies follow changes) and whenever a listings / FBA / AWD /
  prep-center file is loaded. Backup of the mappings before the first fill: `jt.docs amzmapbak/before-asin-fill-2026-09-29`.

## Prep center shipments (migration 014)

- `jt.prep_shipments` (name, dest FBA/AWD, status open → started → shipped, who/when) and `jt.prep_shipment_lines`
  (variant, Amazon SKU, qty). Open and started shipments can be edited or deleted; units are reserved in the UI
  ("in shipments") but only leave the prep center when the shipment is marked shipped (`jt.prep_shipment_status` calls
  `jt.prep_ship`, which fails if a line is short). Shipped is final; moves carry `shipment_id`.
- Web wrappers: `public.jt_prep_shipment_save / jt_prep_shipment_status / jt_prep_shipment_delete`.
