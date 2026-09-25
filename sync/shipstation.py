"""ShipStation (API v2) shipping labels -> jt.shipstation_labels."""
from __future__ import annotations

import datetime as dt
import re
import time

import requests

from .common import env, money, upsert

API = "https://api.shipstation.com/v2/labels"
COLS = ["label_id", "tracking", "order_id", "ship_date", "service", "cost", "voided", "created_at", "synced_at"]


def _get(session: requests.Session, url: str) -> dict:
    for attempt in range(6):
        r = session.get(url, timeout=60)
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(int(r.headers.get("Retry-After") or 5) + attempt * 3)
            continue
        if r.status_code != 200:
            raise RuntimeError(f"ShipStation API error {r.status_code}: {r.text[:300]}")
        return r.json()
    raise RuntimeError("ShipStation kept failing (rate limit / server error)")


def label_row(l: dict, now: dt.datetime) -> tuple | None:
    lid = l.get("label_id")
    if not lid:
        return None
    m = re.match(r"^(\d{6,})-", l.get("external_shipment_id") or "")   # "<shopify order id>-..."
    cost = money((l.get("shipment_cost") or {}).get("amount")) + money((l.get("insurance_cost") or {}).get("amount"))
    svc = (l.get("service_code") or "").replace("_", " ")
    if l.get("is_return_label"):
        svc = "return · " + svc
    ship_date = (l.get("ship_date") or l.get("created_at") or "")[:10]
    return (lid, l.get("tracking_number") or "", int(m.group(1)) if m else None, ship_date, svc[:60],
            round(cost, 2), bool(l.get("voided")) or l.get("status") == "voided", l.get("created_at"), now)


def sync_labels(conn, since: dt.datetime) -> int:
    """Labels created since `since` (voided ones are kept, flagged, and left out of costs)."""
    s = requests.Session()
    s.headers.update({"API-Key": env("SHIPSTATION_API_KEY"), "Accept": "application/json"})
    start = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    page, rows = 1, []
    now = dt.datetime.now(dt.timezone.utc)
    while True:
        d = _get(s, f"{API}?created_at_start={start}&page_size=200&page={page}&sort_by=created_at&sort_dir=asc")
        rows += [r for r in (label_row(l, now) for l in d.get("labels", [])) if r]
        if page >= (d.get("pages") or 1):
            break
        page += 1
    return upsert(conn, "jt.shipstation_labels", COLS, rows, ["label_id"])
