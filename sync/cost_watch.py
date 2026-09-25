"""Daily product-cost check, written to jt.docs for the dashboard's Cost watch panel and Amazon cost history.

Runs in the nightly job right after the catalog sync (which records cost changes in jt.variant_cost_changes).
Replaces the Claude scheduled task that did this against the old artifact storage; document shapes are unchanged:

  costs/catalog      variants with no cost / cost above price (current catalog)
  costalerts/<DAY>   yesterday's Shopify sales with no cost, change counts, unmapped Amazon sales (latest month)
  costlog/<DAY>      cost changes found this morning (only written when there are some)
"""
from __future__ import annotations

import datetime as dt
import json

TITLE = 120


def _f(x):
    return float(x) if x is not None else None


def build(conn, day: dt.date, run_on: dt.date) -> dict:
    """Compute the three documents for sales `day`, with cost changes recorded on `run_on`."""
    with conn.cursor() as cur:
        cur.execute("""select variant_id, product_id, sku, coalesce(nullif(display_name, ''), product_title), price, unit_cost
                       from jt.variants where removed_at is null and (status <> 'ARCHIVED' or status is null)""")
        variants = cur.fetchall()
        cur.execute("""select c.variant_id, v.product_id, coalesce(v.sku, ''), coalesce(nullif(v.display_name, ''), v.product_title, ''),
                              c.old_cost, c.new_cost, c.price, c.flag
                       from jt.variant_cost_changes c left join jt.variants v using (variant_id)
                       where c.changed_on = %s order by c.variant_id""", (run_on,))
        change_rows = cur.fetchall()
        cur.execute("select exists (select 1 from jt.variant_cost_changes where changed_on < %s)", (run_on,))
        had_history = cur.fetchone()[0]
        cur.execute("""select s.variant_id, s.product_id, s.product_title, s.variant_title, s.sku,
                              sum(s.net_no_cost), sum(s.units),
                              array_agg(distinct s.order_name) filter (where s.net_no_cost > 0.005),
                              max(v.unit_cost)
                       from jt.shopify_sales s left join jt.variants v on v.variant_id = s.variant_id
                       where s.day = %s
                       group by 1, 2, 3, 4, 5 having sum(s.net_no_cost) > 0.005
                       order by 6 desc""", (day,))
        missing_rows = cur.fetchall()
        cur.execute("select data from jt.docs where collection = 'amzmonths' order by id desc limit 1")
        month = (cur.fetchone() or [{}])[0] or {}
        cur.execute("select coalesce(data ->> 'sku', '') from jt.docs where collection = 'amzmap'")
        mapped = {r[0] for r in cur.fetchall()}

    no_cost, above = [], []
    for vid, pid, sku, title, price, cost in variants:
        meta = {"vid": str(vid), "pid": str(pid), "sku": sku or "", "title": (title or "")[:TITLE]}
        if cost is None:
            no_cost.append({**meta, "price": _f(price)})
        elif price and cost > price:
            above.append({**meta, "cost": _f(cost), "price": _f(price)})
    no_cost.sort(key=lambda x: x["title"])
    above.sort(key=lambda x: -(x["cost"] - x["price"]))

    changes = []
    for vid, pid, sku, title, old, new, price, flag in change_rows:
        old, new = _f(old), _f(new)
        pct = round((new - old) / old, 4) if old and new is not None else None
        changes.append({"vid": str(vid), "pid": str(pid or ""), "sku": sku, "title": (title or "")[:TITLE], "old": old, "new": new,
                        "pct": pct, "price": _f(price), "src": "new variant" if flag == "new variant" else "shopify catalog",
                        "flag": "" if flag == "new variant" else (flag or "")})

    missing = []
    for vid, pid, ptitle, vtitle, sku, amount, units, orders, cost_now in missing_rows:
        title = (ptitle or "Custom item") + ("" if vtitle in (None, "", "Default Title") else " - " + vtitle)
        missing.append({"vid": str(vid) if vid else "", "pid": str(pid) if pid else "", "title": title[:TITLE], "sku": sku or "",
                        "amount": round(float(amount), 2), "units": float(units), "orders": sorted(o for o in (orders or []) if o),
                        "costNow": _f(cost_now)})

    unmapped = sorted(([s, v[0], round(v[1], 2)] for s, v in (month.get("skus") or {}).items()
                       if s not in mapped and isinstance(v, list) and len(v) > 1 and v[1] > 0), key=lambda x: -x[2])

    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    d = day.isoformat()
    catalog = {"date": d, "variants": len(variants), "noCost": no_cost[:1500], "noCostCount": len(no_cost),
               "abovePrice": above[:500], "abovePriceCount": len(above), "updatedAt": now}
    alerts = {"date": d, "baseline": not had_history and not changes, "missing": missing,
              "missingTotal": round(sum(m["amount"] for m in missing), 2), "changes": len(changes),
              "flagged": sum(1 for c in changes if c["flag"]), "noCostCount": len(no_cost), "abovePriceCount": len(above),
              "amazon": {"month": month.get("month"), "unmappedSkus": len(unmapped),
                         "unmappedSales": round(sum(x[2] for x in unmapped), 2), "top": unmapped[:25]},
              "updatedAt": now}
    log = {"date": d, "changes": changes[:1500], "updatedAt": now}
    return {"catalog": catalog, "alerts": alerts, "log": log}


def run(conn, day: dt.date, run_on: dt.date) -> dict:
    docs = build(conn, day, run_on)
    writes = [("costs", "catalog", docs["catalog"]), ("costalerts", day.isoformat(), docs["alerts"])]
    if docs["log"]["changes"]:
        writes.append(("costlog", day.isoformat(), docs["log"]))
    with conn.cursor() as cur:
        for c, i, body in writes:
            cur.execute("""insert into jt.docs (collection, id, data) values (%s, %s, %s::jsonb)
                           on conflict (collection, id) do update set data = excluded.data, updated_at = now()""",
                        (c, i, json.dumps(body)))
    conn.commit()
    a = docs["alerts"]
    return {"variants": docs["catalog"]["variants"], "changes": a["changes"], "flagged": a["flagged"],
            "sold_without_cost": a["missingTotal"], "no_cost_variants": a["noCostCount"],
            "amazon_unmapped_sales": a["amazon"]["unmappedSales"]}
