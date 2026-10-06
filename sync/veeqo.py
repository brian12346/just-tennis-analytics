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


def _save_state(conn, state: dict) -> None:
    with conn.cursor() as cur:
        cur.execute("""insert into jt.settings (key, value, updated_at) values ('veeqo_sync', %s::jsonb, now())
                       on conflict (key) do update set value = excluded.value, updated_at = now()""", (json.dumps(state),))
    conn.commit()


def _load_state(conn) -> dict:
    with conn.cursor() as cur:
        cur.execute("select value from jt.settings where key = 'veeqo_sync'")
        r = cur.fetchone()
    return (r and r[0]) or {}


def label_channels(s: requests.Session) -> list[dict]:
    """Veeqo's sales channels that can have labels: all but Amazon FBA (Veeqo lists FBA orders too, and they're
    most of the orders — about 20 to every FBM order — with nothing to ship)."""
    out, page = [], 1
    while page < 20:
        batch = _get(s, "/channels", {"page_size": 100, "page": page}).json() or []
        out += [{"id": c.get("id"), "name": c.get("name"), "type": c.get("type_code")} for c in batch if c.get("id")]
        if len(batch) < 100:
            break
        page += 1
    return [c for c in out if str(c.get("type") or "") != "amazon_fba"]


def _pages(conn, s: requests.Session, since: dt.datetime, start_page: int, deadline: float, stats: dict) -> tuple[int, bool]:
    """Shipped orders updated since `since`, from page `start_page`, saved every 10 pages, until done or `deadline`.
    Returns (next page, finished). Veeqo lists newest first, so orders arriving meanwhile only push others to later
    pages (read twice, never skipped)."""
    params = {"status": "shipped", "updated_at_min": since.strftime("%Y-%m-%d %H:%M:%S"), "page_size": PAGE}
    if stats.get("channel_ids"):
        params["channel_ids[]"] = stats["channel_ids"]
    now = dt.datetime.now(dt.timezone.utc)
    page, rows = start_page, []

    def flush():
        if rows:
            stats["saved"] = stats.get("saved", 0) + upsert(conn, "jt.veeqo_shipments", COLS, rows, ["shipment_id"])
            conn.commit()
            rows.clear()

    while True:
        r = _get(s, "/orders", {**params, "page": page})
        batch = r.json() or []
        stats["pages"] = stats.get("pages", 0) + 1
        if r.headers.get("X-Total-Pages-Count"):
            stats["total_pages"] = int(r.headers["X-Total-Pages-Count"])
        for o in batch:
            stats["orders"] = stats.get("orders", 0) + 1
            stats.setdefault("order_fields", set()).update(o.keys())
            ck = _name(o.get("channel")) + " · " + str((o.get("channel") or {}).get("type_code") or "")
            chs = stats.setdefault("channels", {})
            chs[ck] = chs.get(ck, 0) + 1
            for al in o.get("allocations") or []:
                if isinstance((al or {}).get("shipment"), dict):
                    stats.setdefault("shipment_fields", set()).update(al["shipment"].keys())
            got = shipment_rows(o, now)
            stats["shipments"] = stats.get("shipments", 0) + len(got)
            stats["with_cost"] = stats.get("with_cost", 0) + sum(1 for x in got if x[9] is not None)
            rows += got
        if len(batch) < PAGE or page >= 5000:
            flush()
            return page + 1, True
        page += 1
        if page % 10 == 0:
            flush()
        if time.monotonic() > deadline:
            flush()
            return page, False
        time.sleep(0.25)   # Veeqo allows a few requests a second


def sync_shipments(conn, since: dt.datetime, budget: int = 240, backfill: bool = False) -> dict:
    """Shipped orders updated since `since` -> one row per shipment (upsert), saved as it goes.
    A long history load (`backfill`) runs `budget` seconds at a time: where it stopped is kept in jt.settings
    'veeqo_sync' and every later run (hourly too) continues it for another `budget` seconds until it's done."""
    s = requests.Session()
    s.headers.update({"x-api-key": env("VEEQO_ID"), "Accept": "application/json"})
    t0 = time.monotonic()
    st = _load_state(conn)
    stats: dict = {}
    try:
        chans = label_channels(s)
        stats["channels_read"] = [f"{c['name']} ({c['type']})" for c in chans]
        if chans:
            stats["channel_ids"] = [c["id"] for c in chans]
    except RuntimeError as e:   # no channel list: read every channel (slower, same result)
        stats["channels_error"] = str(e)[:200]
    # 1) recent changes (the hourly / nightly window)
    if not backfill:
        _pages(conn, s, since, 1, t0 + budget, stats)
    # 2) a history load: start one, or continue the one in progress
    bf = st.get("backfill") or {}
    if backfill:
        bf = {"since": since.isoformat(), "page": 1, "started_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    if bf and not bf.get("done") and bf.get("channels") != stats.get("channel_ids"):
        bf.update(page=1, channels=stats.get("channel_ids"))   # a different channel list pages differently: start over
    if bf and not bf.get("done"):   # gets its own `budget` seconds after the recent changes
        nxt, done = _pages(conn, s, dt.datetime.fromisoformat(bf["since"]), int(bf.get("page") or 1), time.monotonic() + budget, stats)
        bf.update(page=nxt, done=done, pages_total=stats.get("total_pages"), at=dt.datetime.now(dt.timezone.utc).isoformat())
        if done:
            bf["finished_at"] = bf["at"]
    state = {"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(), "since": since.isoformat(),
             "seconds": round(time.monotonic() - t0, 1), "backfill": bf or None,
             **{k: (sorted(v) if isinstance(v, set) else v) for k, v in stats.items()}}
    _save_state(conn, state)
    return {"variants": stats.get("saved", 0), **{k: state[k] for k in ("seconds",) }, "orders": stats.get("orders", 0),
            "shipments": stats.get("shipments", 0), "with_cost": stats.get("with_cost", 0), "backfill": bf or None}
