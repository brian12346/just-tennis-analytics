# Just Tennis analytics

Sales and profit reporting for Just Tennis (Shopify Plus + Amazon), with ShipStation label costs.

```
Shopify Admin API ─┐
ShipStation API  ──┼─► sync jobs (GitHub Actions, hourly + nightly) ─► Supabase Postgres (schema jt) ─► dashboard
Amazon reports ────┘                                                   views do the profit math          (Claude artifact)
```

The dashboard used to pull every order live from Shopify on each page load. Now the numbers are
synced into Postgres once and the dashboard reads summarized views, so it loads in about a second.

## Layout

| Path | What it is |
|---|---|
| `db/migrations/` | Database schema. Numbered SQL files, applied once each, in order. Never edit an applied file: add `003_...sql`. |
| `sync/` | Python sync jobs: `shopify.py` (daily totals, sales by order/variant, orders + line items, catalog costs), `shipstation.py` (labels), `amazon.py` (report uploads), `run.py` (command line), `migrate.py`. |
| `scripts/import_artifact_export.py` | One-time import of the data saved in the old artifact dashboard. |
| `dashboard/src/` | Dashboard source: `index.html` shell, `css/app.css`, one JS file per tab. `python dashboard/build.py` writes `dashboard/dist/just-tennis-sales.html`. |
| `tests/` | `pytest`: parsers, and the profit math in the views against a real Postgres. |
| `.github/workflows/` | `sync.yml` (scheduled syncs), `ci.yml` (tests on every push). |
| `docs/` | `setup.md` (first-time setup), `data-model.md` (tables, views, cost rules). |

## Everyday use

```bash
python -m sync.run hourly                         # what the hourly schedule runs
python -m sync.run nightly                        # catalog costs + 35-day re-sync
python -m sync.run backfill --since 2025-01-01
python -m sync.run amazon-transactions ~/Downloads/2026Sep1-2026Sep30CustomUnifiedTransaction.csv
python -m sync.run amazon-listings ~/Downloads/All+Listings+Report.txt
```

Any job can also be started from GitHub: **Actions → Sync data → Run workflow**.
Check job health with `select * from jt.v_sync_status;`.

## Making changes

1. Branch, edit, `pytest -q` (set `TEST_DATABASE_URL` to a throwaway database), `python dashboard/build.py`.
2. Commit and push; CI runs the tests.
3. Merge to `main`. New migrations are applied automatically at the start of the next sync.
4. Republish `dashboard/dist/just-tennis-sales.html` to the dashboard artifact (ask Claude to do it).

Secrets (database URL, Shopify app credentials, ShipStation key) live only in GitHub Actions secrets
and your local `.env`, never in the repo.
