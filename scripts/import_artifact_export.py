"""One-time import of the data saved in the old Claude-artifact dashboard into Supabase.

  python scripts/import_artifact_export.py data/export

The export folder holds one sub-folder per artifact collection (costoverrides, amzmap, amzlistings,
shipments, costlog, settings), one JSON file per document. Safe to run more than once.
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from sync.common import connect, gid_num, load_env, money, upsert  # noqa: E402


def docs(folder: pathlib.Path, name: str):
    d = folder / name
    for p in sorted(d.glob("*.json")) if d.exists() else []:
        body = json.loads(p.read_text())
        if isinstance(body, dict) and set(body) >= {"data"} and isinstance(body["data"], dict) and len(body) <= 4:
            body = body["data"]
        yield p.stem, body


def main(folder: str) -> None:
    load_env()
    src = pathlib.Path(folder)
    conn = connect()
    counts = {}

    rows = []
    for sid, b in docs(src, "costoverrides"):
        if not isinstance(b.get("cost"), (int, float)):
            continue
        rows.append((int(b.get("sid") or sid), b.get("order") or "", round(float(b["cost"]), 2),
                     b.get("shopifyCogs") if isinstance(b.get("shopifyCogs"), (int, float)) else None,
                     json.dumps(b.get("lines") or {}), b.get("src") or "shopify-tab", b.get("note") or "",
                     b.get("updatedAt") or dt.datetime.now(dt.timezone.utc).isoformat()))
    counts["cost_overrides"] = upsert(conn, "jt.cost_overrides", ["order_id", "order_name", "cost", "shopify_cogs",
                                                                  "lines", "src", "note", "updated_at"], rows, ["order_id"])

    rows = []
    for _, b in docs(src, "amzmap"):
        manual = b.get("kind") == "manual"
        rows.append((b["sku"], b.get("asin") or "", "manual" if manual else "shopify",
                     None if manual else gid_num(b.get("variantId")), None if manual else gid_num(b.get("productId")),
                     b.get("vsku") or "", b.get("vtitle") or "", b.get("vendor") or "", b.get("units") or 1,
                     b.get("manualCost") if manual else None, b.get("unitCost"), b.get("updatedAt")))
    counts["amazon_map"] = upsert(conn, "jt.amazon_map", ["sku", "asin", "kind", "variant_id", "product_id", "vsku",
                                                          "vtitle", "vendor", "units", "manual_cost", "unit_cost_at_map",
                                                          "updated_at"], rows, ["sku"])

    rows, now = {}, dt.datetime.now(dt.timezone.utc)
    for _, b in docs(src, "amzlistings"):
        for r in b.get("rows") or []:
            sku, asin, title, price, qty, chan, status, opened = (list(r) + [None] * 8)[:8]
            rows[sku] = (sku, asin or "", title or "", price, qty, chan or "", status or "", opened, b.get("file") or "", now)
    counts["amazon_listings"] = upsert(conn, "jt.amazon_listings", ["sku", "asin", "title", "price", "quantity",
                                                                    "channel", "status", "open_date", "report_file",
                                                                    "uploaded_at"], list(rows.values()), ["sku"])

    rows = []
    for day, b in docs(src, "shipments"):
        if day.startswith("_"):
            continue
        for trk, r in (b.get("rows") or {}).items():
            rows.append((r.get("lid") or f"trk:{trk}", trk, int(r["sid"]) if str(r.get("sid") or "").isdigit() else None,
                         b.get("date") or day, r.get("v") or "", money(r.get("c")), False, None, now))
    counts["shipstation_labels"] = upsert(conn, "jt.shipstation_labels", ["label_id", "tracking", "order_id", "ship_date",
                                                                          "service", "cost", "voided", "created_at",
                                                                          "synced_at"], rows, ["label_id"])

    rows = []
    for day, b in docs(src, "costlog"):
        for c in b.get("changes") or []:
            if c.get("vid"):
                rows.append((b.get("date") or day, int(c["vid"]), c.get("old"), c.get("new"), c.get("price"), c.get("flag") or ""))
    counts["variant_cost_changes"] = upsert(conn, "jt.variant_cost_changes", ["changed_on", "variant_id", "old_cost",
                                                                              "new_cost", "price", "flag"], rows,
                                            ["changed_on", "variant_id"])

    for key, b in docs(src, "settings"):
        if key == "costs":
            with conn.cursor() as cur:
                cur.execute("select jt.set_setting('costs', %s::jsonb)",
                            (json.dumps({"history_start": b.get("historyStart"), "note": b.get("note") or ""}),))
                for k, kind in (b.get("overrides") or {}).items():   # "YYYY-MM-DD|variant id" -> real | correction
                    d, vid = k.split("|")
                    cur.execute("update jt.variant_cost_changes set kind = %s where changed_on = %s and variant_id = %s",
                                (kind, d, int(vid)))
            counts["settings"] = 1

    conn.commit()
    conn.close()
    for k, v in counts.items():
        print(f"{k:24} {v}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/export")
