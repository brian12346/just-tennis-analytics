"""Command line for every sync job.

  python -m sync.run hourly                    # recent sales, orders and labels (GitHub Actions, every hour)
  python -m sync.run nightly                   # catalog costs + cost check + a 35-day re-sync to catch returns and edits
  python -m sync.run backfill --since 2025-01-01
  python -m sync.run shopify-sales --since 2026-09-01 [--until 2026-09-24]
  python -m sync.run shopify-daily | shopify-orders | catalog | labels  (same --since/--until)
  python -m sync.run amazon-transactions path/to/report.csv
  python -m sync.run amazon-listings path/to/All+Listings+Report.txt
"""
from __future__ import annotations

import argparse
import datetime as dt

from .common import connect, load_env, store_today, sync_run


def _utc(d: dt.date) -> dt.datetime:
    return dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc)


def main(argv: list[str] | None = None) -> None:
    load_env()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("job", choices=["hourly", "nightly", "backfill", "shopify-daily", "shopify-sales", "shopify-orders",
                                    "catalog", "cost-watch", "cost-updates", "labels", "amazon-transactions", "amazon-listings"])
    ap.add_argument("file", nargs="?", help="report file for amazon-* jobs")
    ap.add_argument("--since", type=dt.date.fromisoformat)
    ap.add_argument("--until", type=dt.date.fromisoformat)
    a = ap.parse_args(argv)

    today = store_today()
    until = a.until or today
    conn = connect()
    failed = []

    def run(name: str, fn):
        try:
            with sync_run(conn, name) as r:
                out = fn()
                r["rows"] = out if isinstance(out, int) else out.get("variants", 0)
                r["detail"] = "" if isinstance(out, int) else str(out)
        except Exception:  # noqa: BLE001 - keep going with the other jobs, fail the run at the end
            failed.append(name)

    def shopify():
        from .shopify import Shopify
        return Shopify()

    if a.job in ("hourly", "nightly", "backfill", "shopify-daily", "shopify-sales", "shopify-orders", "catalog"):
        from . import shopify as sh
        shop = shopify()
        days = {"hourly": 3, "nightly": 35}.get(a.job, 7)
        since = a.since or (today - dt.timedelta(days=days - 1))
        if a.job == "backfill" and not a.since:
            ap.error("backfill needs --since")
        if a.job in ("hourly", "nightly", "backfill", "shopify-daily"):
            run("shopify_daily", lambda: sh.sync_daily(shop, conn, since, until))
        if a.job in ("hourly", "nightly", "backfill", "shopify-sales"):
            run("shopify_sales", lambda: sh.sync_sales(shop, conn, since, until))
        if a.job in ("hourly", "nightly", "backfill", "shopify-orders"):
            # orders changed since the start of the window (one day of overlap for safety)
            run("shopify_orders", lambda: sh.sync_orders(shop, conn, _utc(since - dt.timedelta(days=1))))
        if a.job in ("nightly", "catalog"):
            run("catalog", lambda: sh.sync_catalog(shop, conn, today))

    if a.job in ("hourly", "nightly", "cost-updates"):
        # costs typed in the dashboard -> Shopify (a save starts job cost-updates right away; hourly catches any missed)
        from . import shopify as sh2
        run("cost_updates", lambda: sh2.apply_cost_updates(shopify(), conn, today))

    if a.job in ("nightly", "cost-watch"):
        # after the catalog sync: yesterday's sales without cost + this morning's cost changes -> jt.docs
        from . import cost_watch
        run("cost_watch", lambda: cost_watch.run(conn, today - dt.timedelta(days=1), today))

    if a.job in ("hourly", "nightly", "backfill", "labels"):
        from .shipstation import sync_labels
        back = {"hourly": 3, "nightly": 14}.get(a.job, 7)
        since = a.since or (today - dt.timedelta(days=back))
        run("shipstation_labels", lambda: sync_labels(conn, _utc(since - dt.timedelta(days=1))))

    if a.job.startswith("amazon-"):
        if not a.file:
            ap.error(f"{a.job} needs a report file")
        from . import amazon
        fn = amazon.load_transactions if a.job == "amazon-transactions" else amazon.load_listings
        run(a.job.replace("-", "_"), lambda: fn(conn, a.file))

    conn.close()
    if failed:
        raise SystemExit(f"Failed: {', '.join(failed)} (details in jt.sync_runs)")


if __name__ == "__main__":
    main()
