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

### Shipment exceptions (dashboard only)

Each open or started shipment is checked in the page (`issuesOf` in `dashboard/src/js/prep.js`, shared as
`window.JTIssues`): short on stock (blocks Mark shipped), units also held by another shipment, no Shopify cost,
no Amazon listing mapped, started without a shipment ID, started 7+ days ago and not shipped, open 14+ days.
Cards turn amber (warning) or red (blocking); the shipment popup lists each exception with fix buttons.
New checks are one more entry in `issuesOf`.

## Incoming Inventory: vendor orders (migration 015)

- `jt.prep_orders` (vendor, PO #, status draft → ordered → invoice → packing_slip → received → shipped, linked
  `invoice_id` on `jt.invoices`, `expected_on`, `short_ok`, `stage_at` = when each status was reached) and
  `jt.prep_order_lines` (variant, Amazon SKU earmark, qty ordered / received, unit cost from the invoice).
- `jt.prep_order_receive` adds units to `jt.prep_items` (partial receipts add up; moves have kind `receive` and
  `order_id`). Received orders can't be deleted and their lines are locked.
- "Shipped" = the received stock went back out: an Amazon Outgoing shipment made from the order carries
  `prep_shipments.order_id`, and marking it shipped marks the order shipped. `prep_order_status('shipped')` also
  closes it by hand (no stock change).
- Exceptions on the card / in the popup: not received in full (until closed short), late vs. expected date,
  no invoice linked from the Invoice stage on, invoice total ≠ order total, missing cost, no PO #, received 14+ days
  and not on an Amazon shipment.
- Web wrappers: `public.jt_prep_order_save / _status / _receive / _delete`.
- Step back (migration 016): shipments shipped → started put the units back (moves `unship`) and send a linked order
  back to received; orders received → an earlier stage take the received units back out (moves `unreceive`,
  refused if the prep center no longer has them), shipped → received changes no stock.

## On The List (migration 017)

- `jt.prep_list`: products marked for re-order (variant, Amazon SKU, dest `prep` | `shopify`, qty, source,
  `order_id`, `closed_at`). One open item per variant / Amazon SKU / dest.
- `jt.prep_list_add` marks (or updates qty/note, and the draft order line with it); `jt.prep_list_assign` puts items
  on a draft order or a new one (`prep_orders.kind` = `order` | `booking`, `place_by`); only drafts take list items;
  `jt.prep_list_remove` takes one off (and off its draft). An item's status follows its order; receiving closes it,
  stepping the order back from received reopens it.
- Order lines carry `dest`: receiving a `shopify` line records it but doesn't add to the prep center.
- Marked from: Prep center stock rows, Amazon inventory rows (mapped listings, for that seller SKU), Inventory value
  rows (for the Shopify store) and the search box on the list.

## Shipping cost entered by hand (migration 018)

- `jt.ship_cost_overrides` (order_id, cost, combined_with, note): for shipped orders with no ShipStation label —
  a label bought elsewhere, or an order that went in the same box as another (`combined_with` = that order, cost
  usually 0). The Shopify tab uses it only when the order has no label of its own; it counts toward label cost coverage.
- Tracking numbers (migration 019): the orders sync stores each order's fulfillment tracking numbers in
  `jt.shopify_order_tracking` (normalized, no spaces). `jt.v_combined_shipments` lists orders with no label of their
  own whose tracking number is on another order's ShipStation label (ShipStation combined them); the Shopify tab
  counts those as combined at $0 automatically. A hand-entered cost wins over the automatic match.

## Purchase orders (migration 020)

The **Purchase orders** tab is the full-page home for vendor orders — the same `jt.prep_orders` rows that
Incoming Inventory shows on the Prep center tab (one set of orders, same stages).

- Upload a vendor invoice PDF (on the list, or onto an open PO). It's read in the browser
  (`dashboard/src/js/invparse.js`, shared with the Invoices tab): vendor, invoice #, date, PO #, subtotal and item lines.
  An open PO from the same vendor with the invoice's PO # takes the invoice; otherwise a new PO starts.
- Each line gets a Shopify product: sure matches (a code remembered for this vendor in `jt.vendor_items`, the SKU,
  the UPC) or a guess from the product words (`window.JTMatch`, the Amazon matching scorer) to confirm or change.
  Lines like freight or fees are marked "not a product" (`match_how = 'skip'`).
- `jt.po_save(p)` saves in one transaction: the invoice (`jt.save_invoice`: every line as read, matched or not,
  with `dest` / `amazon_sku`), the order (`jt.prep_order_save`: the matched lines, linked by `invoice_id`) and the
  confirmed matches (`jt.remember_vendor_items`). Saving a newly attached invoice moves a draft/ordered PO to "invoice".
- The PDF is kept in `jt.invoice_files` (base64, ~66 KB of file per row so one row fits one database reply),
  written with `jt.invoice_file_put`; `jt.invoices.file_parts` says how many parts are stored.
- `jt.po_delete` deletes a draft order and its draft invoice when no other order uses it.
- `match_how` values: remembered, sku, upc, manual, confirmed (sure); skupart, guess-high/medium/low (to check); skip.

## Assigning prep stock to a listing later (migration 021)

Stock can come into the prep center for "any listing" (receiving a PO line left on "any ASIN", or a count) and be
earmarked later: Prep center → Stock → **Assign** splits a row's units across the product's mapped listings (ASIN,
pack size), or moves earmarked units to another listing / back to any. `jt.prep_assign(p)` =
`{variant_id, from_sku, moves: [{to_sku, qty}], note}`, in Shopify units (a 2-pack listing takes 2 per Amazon unit);
logged as two `prep_moves` of kind `assign`. PO lines pick the listing by ASIN, and can still be changed at receive time.

## Invoice money for QuickBooks (migration 022)

`jt.invoices` has `due_date`, `total` and `terms`; every `jt.invoice_lines` row has an `account`: `inventory`
(products) or `inbound_shipping` (freight in). The PDF reader picks up the invoice total, the due date (or terms like
"Net 30" + the invoice date) and freight / shipping / handling amounts in the totals area; those charges are saved as
invoice lines (`match_how = 'skip'`, account `inbound_shipping`), so the lines add up to the invoice total. The
Purchase orders tab shows the bill "For QuickBooks": vendor, bill no., bill date, due date, terms, PO as memo, and
one amount per account, checked against the invoice total.

## Several invoices per PO, backorders (migration 023)

`jt.invoices.order_id` links each invoice to its purchase order (a PO can have many; `prep_orders.invoice_id` is
kept as the latest, for the Prep center). PO lines (`jt.prep_order_lines`) are what was ordered and what receiving
is against; each has `backorder` and `eta` (expected arrival, null = unknown). In the app a line's status comes
from ordered vs. invoiced (matched, confirmed lines on the order's invoices) vs. received: On order, Backordered ·
ETA, Invoiced, Partly received, Received. An invoiced product that wasn't on the PO is added as a line.
`jt.po_save` now takes `{order, lines, invoices: [...], remove_invoices, remember}` and returns
`{order_id, invoice_ids}`; lines can be changed at any stage but shipped, and a received line can't be removed.

### PO stages and invoice payments (024)

- `jt.prep_orders.status`: draft → ordered → invoiced → partial → received → qb_ready → complete.
  - Receiving sets partial or received by itself. Received means every line arrived in full, or the PO was closed short (`short_ok`).
  - QB ready and complete are set by hand. Complete requires QB ready.
  - Stepping back from partial or received to an earlier stage takes the received units back out.
  - Old stages were mapped: invoice and packing_slip became invoiced, and shipped became complete.
  - Outgoing Amazon shipments no longer change a PO's stage.
- `jt.invoices` payment columns: `paid_on` (null means unpaid), `pay_method` (ach, check, credit_card, wire, cash, other), `pay_ref`, `paid_from` and `paid_amount`.
  - Set them with `jt.invoice_set_payment(inv, p)`, which changes only the keys given.
  - `jt.po_save` applies each invoice's payment fields. This works on applied invoices and on complete POs too.

### Shopify PO link (025)

- `jt.prep_orders.shopify_po_url` (text, '' = not linked): the same PO in Shopify admin. Shopify's API can't create POs, so they're kept in step by hand and this is the cross-reference.
- The dashboard accepts a pasted admin link or just the PO number, and flags non-draft POs that aren't linked.
- Invoices are added from inside a PO (the list page no longer has an upload button).

### Receive into (026)

- `jt.prep_orders.receive_into`: 'shopify', 'prep', 'both', or '' (not set, worked out from the lines). The PO-level choice.
- Each line's `dest` decides where it's received.
- A product can be split: one line with dest 'shopify' and one with dest 'prep' (the unique key includes dest).

### Shopify PO check (027)

- `jt.prep_orders.shopify_check` (jsonb, null = not checked): a snapshot of the Shopify PO the order was checked against — {checked_at, source 'pdf' | 'api', file_name, name, supplier, total, subtotal, shipping, scope 'all' | 'shopify', diffs, lines: [{sku, supplier_sku, title, qty, cost, amount, variant_id, how}]}.
- Where Shopify's side comes from:
  - Today: the PO's PDF from Shopify admin, read in the dashboard.
  - Later: Shopify's Admin API (`inventoryPurchaseOrders`, preview in 2026-10), once it's open to live stores. The sync can fill the same snapshot with source 'api'.
- The dashboard compares product by product against the PO as it is now:
  - Split products are added up.
  - scope 'shopify' compares only the Shopify-store lines.
  - It checks quantity, cost, products missing on either side, lines it can't match, and the supplier.
  - `diffs` is the count when last saved (for the list).

### PO costs to Shopify and cost layers (028)

- `jt.prep_order_lines.update_cost` marks a line whose PO cost should go to Shopify. `cost_applied` / `cost_applied_at` record what was sent.
- **Apply to Shopify** on a PO covers only received products.
  - Shopify gets the weighted average of everything on hand (Shopify store + prep center + Amazon): older units at their cost, received units at the PO cost.
  - The dashboard computes it and `jt.po_apply_costs` queues it in `jt.cost_updates` (the cost-updates sync sends it).
- **Inventory value uses FIFO cost layers.**
  - `jt.cost_layers` holds one opening layer per product (what was on hand before the first applied PO, at its old cost, and the time layers start).
  - `jt.v_cost_layers` adds a layer per PO receipt since then, at the PO cost; it's worked out from the PO lines, so later receipts and un-receipts count.
  - Stock is valued newest layer first. Anything beyond the layers is at the opening cost.
  - Products without layers are valued at the Shopify cost, as before.
- `window.JTCost` (costlayers.js) applies this on the Inventory value tab, the prep center totals and Amazon totals.

### Sales costed by layer (029)

- For products with cost layers, `jt.fifo_sale_costs` holds a FIFO cost for each Shopify sales row. `jt.refresh_fifo_costs()` rebuilds it; the hourly and nightly syncs and Apply to Shopify call it.
  - Sales before the layers started are costed at the opening cost.
  - Later sales take units oldest layer first.
  - Amazon monthly units (through the Shopify mappings) take units too, dated the 15th.
  - Returns go back at the cost they left at.
- `jt.v_shopify_sales_costed` uses it, so the daily totals and the Product sales tab ("Current cost · FIFO layers") follow.
- `jt.prep_orders.shopify_received_at` / `_by` records "Received in Shopify", set with `jt.po_shopify_received`, which starts a catalog sync. `jt.po_apply_costs` refuses a PO with received Shopify-store products until it's set and Shopify's stock has synced after it (max `jt.variants.seen_at`).

### Shopify PO status (030)

- `jt.prep_orders.shopify_po_status` / `shopify_po_status_at`: the linked Shopify PO's own status, read by the nightly and catalog syncs (`sync_po_status`) with `inventoryPurchaseOrders` on API 2026-10 or unstable.
- That API is preview-only for now. Until a live store is allowed, the sync records why in `jt.settings['shopify_po_api']` and the dashboard says "not available yet".
- A Shopify status of received or closed marks the PO "Received in Shopify" (by 'Shopify') if it wasn't already.
- Needs the scope `read_inventory_purchase_orders` on the Shopify app once Shopify offers it.

### Catalog change log (031)

- `jt.catalog_changes` records what each catalog sync changed per product: new, removed, restored, cost, price, stock, status, title, sku, barcode, vendor, type.
  - Each change has its old and new value as text.
  - `synced_at` is the sync's run time.
  - Kept 120 days.
- The dashboard's "What changed" pop-up (changes.js) shows one sync at a time. It opens by itself after Sync from Shopify on the Shopify cost mapping tab, and from the What changed button next to it.

### No bare DELETEs in functions (032)

- Supabase's API connection runs pg_safeupdate, which refuses a DELETE or UPDATE without a WHERE clause, even inside a security-definer function.
- `jt.refresh_fifo_costs()` and `jt.prep_seed()` now use `where true`. Before this, Apply to Shopify failed with "DELETE requires a WHERE clause".
- Any new function that clears a table needs the same.

### Removing a product from Incoming products (033)

- `jt.prep_order_lines.incoming_hidden_qty` is how many had been received when the product was taken off the prep center's Incoming products list; null means it isn't hidden.
- Set with `jt.prep_incoming_hide`. The product shows again if more arrive, and the PO itself is unchanged.

### Un-receive one product (034)

- `jt.prep_order_unreceive_line(p)` takes some or all of one PO line back off its received count. Prep-center units come back out of the prep center, logged as 'unreceive'.
- The PO's stage follows: invoiced or ordered when nothing's received, otherwise partly received.
- Refused once the PO is QB ready or complete.

## 035 — receiving against an invoice

- `jt.invoice_receipts (invoice_id, variant_id, qty)`: units received against each invoice, by product. Kept apart from `jt.invoice_lines` so re-saving an invoice doesn't lose it.
- `jt.invoices.received_at` is set once every product on the invoice has come in (or it was marked by hand: `received_manual`).
- `jt.po_receive_invoice(p {id, invoice_id, lines, note, by})` receives into the PO as `jt.prep_order_receive` does, and also counts the units on that invoice, up to what it billed.
- `jt.invoice_set_received(p {invoice_id, received})` marks an invoice received by hand, or undoes that.
- `jt.prep_order_unreceive_line` also takes units off the order's invoices, newest invoice first.
- The PO keeps its own status: it stays partly received while backordered products are still to come.
- Web wrappers: `public.jt_po_receive_invoice`, `public.jt_invoice_set_received`.

## 036 — QuickBooks Online connection

- The credentials live in Supabase Vault: `qbo_client_id`, `qbo_client_secret`, `qbo_refresh_token` and `qbo_realm_id`.
- The `qbo` edge function maintains three more Vault entries itself: `qbo_access_token`, `qbo_access_expires` and `qbo_env`.
- The edge function source is in `supabase/functions/qbo`. Its actions:
  - `status`: company, accounts and vendor count.
  - `query`: a read-only QuickBooks query.
- The function refreshes the access token when needed and saves the new tokens back through `public.jt_qbo_save_tokens`.
- Who can call the function:
  - a signed-in app user;
  - SQL, through `jt.qbo_call(p)` → request id, then `jt.qbo_result(id)`. SQL authenticates with the function key in Vault `jt_fn_key`.
- `jt.settings.fn_base` holds the project URL and the public anon key.

## 037 — invoices to QuickBooks bills

- `jt.invoices` gains `qbo_bill_id`, `qbo_doc`, `qbo_sent_at`, `qbo_sent_by` and `qbo_how` (`created` or `linked`).
- `jt.qbo_vendors (vendor, qbo_id, qbo_name)` remembers which QuickBooks vendor each vendor name matches.
- `jt.settings.qbo_accounts` holds the QuickBooks account ids for the bill lines. They're looked up by name on first use: Inventory, and Inbound Shipping.
- The `qbo` edge function's `create_bill` action enters an invoice as a bill once. It does the following, in order:
  1. Refuses if the invoice is already linked to a bill.
  2. Asks for the vendor match the first time.
  3. Links instead of creating when a bill with the same number already exists for that vendor.
  4. Refuses when the lines don't add up to the invoice total, unless called with `force`.
- Service-role helpers: `public.jt_qbo_bill_data`, `public.jt_qbo_bill_saved` and `public.jt_qbo_setting`.
- `public.jt_invoice_qbo_unlink(p {invoice_id})` lets an app user unlink an invoice from its bill.

## 038 — the invoice PDF on the QuickBooks bill

- `jt.invoices` gains `qbo_attach_id` and `qbo_attach_at`.
- `create_bill` uploads the stored invoice PDF to the new bill, using QuickBooks' Attachable upload.
- For a bill that was linked rather than created, the PDF is uploaded only if that bill has no attachments yet.
- The `attach` action attaches the PDF to a bill sent earlier.
- Service-role helpers: `public.jt_qbo_invoice_file` and `public.jt_qbo_attached`.

## 039 — invoices live on the Invoices tab

- Invoices are uploaded on the Invoices tab.
- Each uploaded invoice goes onto its purchase order:
  - automatically, when the vendor and the PO # printed on the invoice match an open PO;
  - otherwise you pick a PO, or start a new one.
- The Invoices tab shows an invoice's details, lines, PDF, payment and QuickBooks.
- The purchase order keeps the invoice chips, a summary line and the "Receive this invoice" section.
- `jt.invoice_move(p {invoice_id, order_id})` puts a saved invoice on another PO, or links an older invoice that has none. It is refused once anything was received against the invoice, or when either PO is complete.
- Web wrapper: `public.jt_invoice_move`.
- The old swimlane board (`js/invoices.js`) was removed.

## 040 — invoice receipts stay in step with the PO

- `jt.invoice_receipts_sync(order)` adds units the PO received that no invoice has counted yet to the PO's invoices. It fills the oldest invoice first, up to what each billed.
- A trigger on `jt.prep_order_lines.qty_received` runs it whenever the received count goes up. This covers receiving done without naming an invoice: "Receive without an invoice", older dashboard versions, and the Prep center.
- `jt.po_receive_invoice` turns the trigger off while it counts units on the chosen invoice.
- On Oct 1, 2026 this caught up PO1233, whose invoice had shown "not received" on a fully received PO.
