# First-time setup

About 30 minutes. Steps 1–4 are clicks in web pages; Claude can do steps 5–7 once the Supabase connector is on.

## 1. Supabase project
1. supabase.com → New project → name `just-tennis`, region **West US (North California)**, strong database password (save it in your password manager).
2. Project Settings → Database → Connection string → **Session pooler** → copy the URI and put your password in it.
   This is `DATABASE_URL`.

## 2. Shopify app (read-only)
1. Shopify admin → Settings → Apps → Develop apps → **Build apps in Dev Dashboard**.
2. Create app `Just Tennis Analytics`. Under the app's version, choose Admin API scopes:
   `read_orders`, `read_all_orders`, `read_products`, `read_inventory`, `read_reports`.
   Under API access, request **protected customer data** access (needed for Shopify Analytics queries).
3. Release the version and install the app on **justtennis-822**.
4. App → Settings: copy **Client ID** and **Client secret** (`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`).

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
