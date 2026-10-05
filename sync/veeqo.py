"""Veeqo shipping labels (Amazon FBM orders are mostly shipped with labels bought in Veeqo) -> jt.veeqo_shipments.

Read-only. Lists shipped orders changed since a date (GET /orders?status=shipped&updated_at_min=…) and keeps one row per
shipment: the order (Veeqo number, channel, and the Amazon order id when the order came from Amazon), tracking,
carrier/service, when it shipped and the label cost Veeqo charged (allocations[].shipment.outbound_label_charges — only
filled for labels bought with Veeqo's rates). No customer names or addresses are stored. The API key is the GitHub
secret VEEQO_ID (header x-api-key). What the API returned (field names only, counts, errors) goes to jt.settings
'veeqo_sync'.
"""
from __future__ import annotations

import datetime as dt
import json
import re
import time

import requests

from .common import env, upsert

API = "https://api.veeqo.com"
PAGE = 100
AMZ_ORDER = re.compile(r"\b\d{3}-\d{7}-\d{7}\b")
COLS = ["shipment_id", "order_id", "order_number", "channel", "channel_type", "amazon_order_id", "tracking", "carrier",
        "service", "cost", "currency", "weight", "shipped_at", "created_at", "order_created_at", "synced_at"]


def _get(s: requests.Session, path: str, params: dict) -> requests.Response:
    for attempt in range(6):
        r = s.get(API + path, params=params, timeout=60)
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(int(r.headers.get("Retry-After") or 2) + attempt * 2)
            continue
        if r.status_code != 200:
            raise RuntimeError(f"Veeqo API error {r.status_code}: {r.text[:300]}")
        return r
    raise RuntimeError("Veeqo kept failing (rate limit / server error)")


def _num(v) -> float | None:
    if isinstance(v, dict):
        v = v.get("value", v.get("amount"))
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


def _name(v) -> str:
    if isinstance(v, dict):
        return str(v.get("name") or v.get("title") or v.get("short_name") or v.get("code") or "")
    return "" if v is None else str(v)


def _tracking(sh: dict) -> str:
    t = sh.get("tracking_number")
    if isinstance(t, dict):
        t = t.get("tracking_number") or t.get("number")
    return str(t or sh.get("tracking") or "").strip()


def amazon_order_id(o: dict) -> str:
    """The Amazon order id of an order that came from Amazon (Veeqo keeps it as the order number / channel order code)."""
    for k in ("channel_order_code", "number", "external_id", "channel_order_id", "reference"):
        m = AMZ_ORDER.search(str(o.get(k) or ""))
        if m:
            return m.group(0)
    return ""


def shipment_rows(o: dict, now: dt.datetime) -> list[tuple]:
    ch = o.get("channel") or {}
    rows = []
    for al in o.get("allocations") or []:
        sh = (al or {}).get("shipment")
        if not isinstance(sh, dict) or not sh.get("id"):
            continue
        charge = sh.get("outbound_label_charges")
        charge = charge if isinstance(charge, dict) else {"value": charge}
        carrier = _name(sh.get("carrier")) or _name(sh.get("carrier_name"))
        service = _name(sh.get("service_name")) or _name(sh.get("short_service_name")) or _name(sh.get("service_type")) \
            or _name((o.get("delivery_method") or {}).get("name"))
        rows.append((int(sh["id"]), int(o.get("id") or 0), str(o.get("number") or "")[:60], _name(ch)[:80],
                     str(ch.get("type_code") or "")[:40], amazon_order_id(o), _tracking(sh)[:80], carrier[:60], service[:80],
                     _num(charge), str(charge.get("unit") or charge.get("currency") or "")[:8],
                     _num(sh.get("weight")), sh.get("shipped_at") or al.get("shipped_at") or o.get("shipped_at"),
                     sh.get("created_at"), o.get("created_at"), now))
    return rows


def sync_shipments(conn, since: dt.datetime) -> dict:
    """Shipped orders updated since `since` -> one row per shipment (upsert)."""
    s = requests.Session()
    s.headers.update({"x-api-key": env("VEEQO_ID"), "Accept": "application/json"})
    params = {"status": "shipped", "updated_at_min": since.strftime("%Y-%m-%d %H:%M:%S"), "page_size": PAGE}
    now = dt.datetime.now(dt.timezone.utc)
    rows, orders, page, pages = [], 0, 1, None
    order_keys, ship_keys, channels = set(), set(), {}
    while True:
        r = _get(s, "/orders", {**params, "page": page})
        batch = r.json() or []
        if pages is None:
            pages = int(r.headers.get("X-Total-Pages-Count") or 0) or None
        for o in batch:
            orders += 1
            order_keys.update(o.keys())
            ck = _name(o.get("channel")) + " · " + str((o.get("channel") or {}).get("type_code") or "")
            channels[ck] = channels.get(ck, 0) + 1
            for al in o.get("allocations") or []:
                if isinstance((al or {}).get("shipment"), dict):
                    ship_keys.update(al["shipment"].keys())
            rows += shipment_rows(o, now)
        if len(batch) < PAGE or (pages and page >= pages) or page >= 2000:
            break
        page += 1
        time.sleep(0.25)   # Veeqo allows a few requests a second
    n = upsert(conn, "jt.veeqo_shipments", COLS, rows, ["shipment_id"])
    with_cost = sum(1 for r in rows if r[9] is not None)
    state = {"checked_at": now.isoformat(), "since": since.isoformat(), "orders": orders, "shipments": len(rows),
             "with_cost": with_cost, "amazon": sum(1 for r in rows if r[5]), "channels": channels,
             "order_fields": sorted(order_keys), "shipment_fields": sorted(ship_keys)}
    with conn.cursor() as cur:
        cur.execute("""insert into jt.settings (key, value, updated_at) values ('veeqo_sync', %s::jsonb, now())
                       on conflict (key) do update set value = excluded.value, updated_at = now()""", (json.dumps(state),))
    conn.commit()
    return {"variants": n, "orders": orders, "shipments": len(rows), "with_cost": with_cost}
