# First-time setup

About 30 minutes. Steps 1–4 are clicks in web pages; Claude can do steps 5–7 once the Supabase connector is on.

## 1. Supabase project
1. supabase.com → New project → name `just-tennis`, region **West US (North California)**, strong database password (save it in your password manager).
2. Project Settings → Database → Connection string → **Session pooler** → copy the URI and put your password in it.
   This is `DATABASE_URL`.

## 2. Shopify app (read-only)
1. Shopify admin → Settings → Apps → Develop apps → **Build apps in Dev Dashboard**.
2. Create app `Just Tennis Analytics`. Under the app's version, choose Admin API scopes:
   `read_orders`, `read_all_orders`, `read_products`, `read_inventory`, `write_inventory` (lets the dashboard save product costs to Shopify), `read_reports`.
   Under API access, request **protected customer data** access (needed for Shopify Analytics queries).
3. Release the version and install the app on **justtennis-822**.
4. App → Settings: copy **Client ID** and **Client secret** (`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`).

## 2b. Ace n Rally (second store, sales only)
1. In the Ace n Rally Shopify admin: Settings → Apps → Develop apps → **Build apps in Dev Dashboard**.
2. Create app `Seller Sage` with Admin API scopes `read_orders`, `read_all_orders`, `read_products`, `read_reports`;
   request **protected customer data** access (Shopify Analytics needs it). Release the version and install it on the store.
3. GitHub → Settings → Secrets and variables → Actions: `ACENRALLY_SHOP` (the store's `xxxx.myshopify.com` handle),
   `ACENRALLY_CLIENT_ID`, `ACENRALLY_CLIENT_SECRET`.
4. Actions → Sync data → job `acenrally`, since `2025-01-01` (history + catalog). Hourly and nightly syncs keep it current.

## 3. GitHub repository
1. github.com → New repository → `just-tennis-analytics`, **Private**.
2. Push this code (the bundle Claude gave you):
   ```bash
   git clone just-tennis-analytics.bundle just-tennis-analytics
   cd just-tennis-analytics
   git remote set-url origin https://github.com/<you>/just-tennis-analytics.git
   git push -u origin main
   ```
3. Settings → Secrets and variables → Actions → New repository secret, one each:
   `DATABASE_URL`, `SHOPIFY_SHOP` (= `justtennis-822`), `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
   `SHIPSTATION_API_KEY`.

## 4. Connect Supabase to Claude
claude.ai → Settings → Connectors → Supabase → Connect. The dashboard reads the database through it.

## 5. Create tables and load history
- Actions → **Sync data** → Run workflow → job `backfill`, since `2025-01-01`. This applies the migrations and
  loads Shopify sales, orders and ShipStation labels (takes 10–20 minutes).
- Then run job `catalog` once (baseline of every variant's cost).

## 6. Move over the data saved in the old dashboard
Locally (or ask Claude): `python scripts/import_artifact_export.py data/export`
then `python -m sync.run amazon-transactions <report.csv>` for each Amazon Date Range report.

## 7. Switch the dashboard and retire the old scheduled tasks
Claude republishes the dashboard reading from Supabase, then turns off the two old scheduled tasks
(daily cost check, ShipStation sync) that wrote to the artifact's storage.

## 8. Amazon orders (Selling Partner API)

Orders come straight from Amazon (US, Mexico, Canada) through the `amazon` edge function
(`supabase/functions/amazon`), which reads Amazon's flat-file order reports into `jt.amazon_order_lines`.

1. In Seller Central → Apps and Services → Develop Apps, the private app needs the **Inventory and Order Tracking** role.
   Its LWA client id and secret, and the refresh token from **Authorize**, go in Supabase Vault as
   `spapi_client_id`, `spapi_client_secret` and `spapi_refresh_token` (never in the repo).
2. Migrations 041–044 add the tables, views and the functions the edge function uses.
3. `db/supabase/amazon_scheduler.sql` schedules `jt.amazon_call('{"action":"sync"}')` every 10 minutes: each run
   saves the reports Amazon has finished, and about once an hour asks for orders changed in the last 3 days.
4. History: `select jt.amazon_call('{"action":"backfill","since":"2025-01-01T08:00:00Z"}')` asks for one report per
   30 days; what Amazon's quota turns away is queued and asked for by the next syncs. Progress: `jt.amazon_reports`.
5. Money (fees, refunds, other charges, payouts) comes from the Finances API (2024-06-19 listTransactions) instead of
   uploading the Transaction report (Amazon refuses GET_DATE_RANGE_FINANCIAL_TRANSACTION_DATA for this account).
   `{"action":"fin_days","first":"YYYY-MM-DD","last":"YYYY-MM-DD"}` saves every transaction item to
   `jt.amazon_fin_lines` and rebuilds those Pacific days as the Amazon tab's days (`jt.docs` amzdays/amzmonths), the
   same shape the upload writes. pg_cron runs `fin_recent` (yesterday + today) hourly at :20 and `fin_nightly` (last
   7 days) at 11:50 UTC. Release copies of deferred orders and bank payouts are left out (migrations 045–052).
   Checked against the uploaded September 2026 report: sales, units, orders, fees, refunds and other charges match to
   the cent (one $5.99 line sits under a different fee column). Add `"check": true` to write to amzdays_api /
   amzmonths_api instead, to compare. Uploading a Transaction report still works and replaces the days in it.
6. The dashboard's Amazon tab shows these orders (ordered sales by purchase day, Pacific time) next to the Transaction
   report numbers, and fills days no Transaction report covers yet. **Refresh orders** asks Amazon for a new report now.
   Mexico and Canada sales are converted with the rates in `jt.settings` key `amazon_fx`.

**Listings.** The same `sync` also asks once a day for the All Listings report (`GET_MERCHANT_LISTINGS_ALL_DATA`,
amazon.com) and saves it where the manual upload did (`jt.docs` collection `amzlistings`, via
`jt_amazon_listings_save`, which refuses a report with less than half the current listings). "Get listings from Amazon"
on the Amazon mapping tab asks right away (`{action: "listings"}`) and waits for it. Uploading the report by hand still works.

## 9. Amazon FBM orders → Shopify stock

FBM orders ship from the Shopify store's stock. The dashboard's **FBM stock** tab lists every FBM order since a start
day (`jt.settings` key `fbm_sync`, editable on the page) with the Shopify product each Amazon listing is mapped to.
Once Amazon shows an order shipped, someone confirms it: **Take out of Shopify** (`jt.fbm_decide` → `jt.fbm_decisions`,
status pending, and starts the `fbm-inventory` sync job) or **Don't take out**. The job (`sync/shopify.py`
`apply_fbm_adjustments`, also run hourly) lowers Shopify's *available* quantity at the store's location by
Amazon quantity × the mapping's units, with reason "correction" and the Amazon order as the reference. It needs the
app's `write_inventory` scope (already used for costs). If the store has more than one active location, set
`fbm_sync.location_id` to the one FBM orders ship from. Migration 054.

**FBM listings → Amazon quantity.** The FBM stock tab's listings panel shows stock at the FBM location
(`jt.location_stock`, from sync job `location-stock`, also run hourly/nightly) and sends quantities to Amazon with the
`amazon` function's `fbm_qty` action (Listings Items API, needs the Product Listing role on the SP-API app). Every send
is logged in `jt.fbm_pushes`. `{"action":"fbm_qty","preview":true,…}` checks with Amazon without changing anything.

## 9b. Veeqo shipping labels (Amazon FBM)

Amazon FBM orders are mostly shipped with labels bought in Veeqo. Add the Veeqo API key (Veeqo → Settings → API keys)
as the GitHub Actions secret `VEEQO_ID`. Sync job `veeqo` (also hourly: last 3 days; nightly: 14 days; `--since` starts a
history load that later runs continue 4 minutes at a time, saving as it goes) reads shipped orders and keeps one row per shipment in `jt.veeqo_shipments`: order, Amazon order id, tracking,
carrier/service, ship time and label cost (filled only for labels bought with Veeqo's rates). It is read-only and stores
no customer details. Each run's counts and the field names Veeqo returned are in `jt.settings` key `veeqo_sync`.
Migration 083. The cost shows on the Amazon tab (Shipping labels KPI, Labels column by day, Label per order; by order
date on the order's purchase day, by ship date on the day it shipped) and on each order on the FBM stock tab. Veeqo bills
these to a card, so they aren't in Amazon's payments; Amazon's own label adjustments stay in Other Amazon charges.

## 10. Alerts

The Alerts tab lists operational problems to act on: Amazon FBM orders not shipped, Shopify orders not fulfilled,
overdue POs, Amazon showing more FBM stock than we have, out-of-stock products that sell, low cover, negative stock.
Rules live in `jt.alert_rules` (owner, on/off, thresholds; editable on the tab's Rules view) and run in
`jt.alert_candidates()`; `jt.refresh_alerts()` (pg_cron `jt-alerts` every 15 minutes, see
`db/supabase/alerts_scheduler.sql`, and "Check now") keeps `jt.alerts` current. Resolving asks what was done and
why; the Patterns view summarises causes, fix times and repeat offenders. To add a rule: insert a row in
`jt.alert_rules` and a `return query` block in `jt.alert_candidates()` (in a new migration).
