# Daily Sales tab: load profile (Oct 2026)

Measured on the production database (39k sales rows, 17k orders, 12k labels) for the default **Today** range,
plus a 90-day range. Client side measured with `scripts/profile_dashboard_boot.mjs`, which runs the built
artifact in headless Chromium with a stand-in connector where every call takes the same time (one "round trip").

## Where the time goes

**Round trips dominate.** Inside Claude every query is one `execute_sql` connector call, at most 2 in flight
(`LIMIT` in `js/db.js`), and the first call runs alone. The database work is small by comparison.

| Step | Round trips (Today) |
|---|---|
| `cost_overrides` (first call, runs alone) | 1 |
| Daily numbers on screen (`v_shopify_daily_costed`) | +1 → **2** |
| Orders, costs, labels, sync status, ship overrides, combined shipments (7 more queries, 2 at a time) | +3–4 → **~6** for the full tab |
| Hidden tabs preloaded at startup (All sales, Amazon, cost check, alerts badge): 20 queries, ~2 MB | +10 more |

The queue is first come, first served, and the Daily Sales queries go in first, so the hidden-tab preloads don't
delay the first load. They do hold the connector for about 10 more round trips. A range change or Refresh made in
that window waits behind them.

## Database time per query (warm cache; cold cache in brackets)

| Query | Today | 90 days | Note |
|---|---|---|---|
| `v_shopify_daily_costed` | 50 ms [1,090 ms] | same | Aggregates **all** 39k `shopify_sales` rows whatever the range: the `day` filter isn't pushed into the view's grouped CTE. Grows with history. |
| `v_shopify_sales_costed` by order | 20 ms | 170 ms | Uses the `day` index. |
| `v_shopify_sales_costed` no-cost rows | 1 ms | — | |
| `shopify_orders` | <1 ms | 371 kB reply (2.3k orders) | |
| labels join | <1 ms | — | |
| `v_sync_status` | 60 ms [230 ms] | same | `distinct on (job)` reads all 6.3k `sync_runs` rows. |
| `v_combined_shipments` | 40 ms [540 ms] | same | Anti-join over all tracking numbers and labels before the date filter applies. |
| `cost_overrides` | 2 ms | same | |
| `v_sales_products_daily` (hidden All sales tab, ×2 parts) | ~390 ms each | | Materializes every sale in a CTE. |

## What to work on, in order

1. **Fewer round trips for the tab.** Send the 9 startup reads as one SQL statement that returns one JSON object
   (or 2: daily first, the rest second). That takes the full tab from ~6 round trips to 2–3. Also let the daily
   query be the first ("gate") call instead of `cost_overrides`, which saves one round trip before the first numbers.
2. **Don't preload hidden tabs at startup.** `product-sales.js`, `amazon.js` (listings, ~2,000 `amzmap` docs, months,
   cost log) and the cost-check docs load right away even when the Daily Sales tab is showing. Load them when their
   tab opens, or after the visible tab has finished.
3. **Make `v_shopify_daily_costed` respect the date range** (e.g. a function taking start/end, or a correlated
   per-day aggregate) so it reads only the days asked for. This is the slowest server query, about 1 s on a cold cache.
4. Smaller items: `v_sync_status` → one indexed `limit 1` lookup per job (or prune old `sync_runs`);
   date-filter `v_combined_shipments` before the anti-join; `docRef.get` in `js/db.js` always passes
   `refresh = true`, so single-doc reads (e.g. `settings/costs`, `costs/catalog`) never hit the connector cache.

The real connector round trip wasn't measured here. Time one `execute_sql` call in the browser console inside
Claude to turn the round-trip counts above into seconds.
