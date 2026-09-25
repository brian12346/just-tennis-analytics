"""Amazon Seller Central report loaders (until SP-API access is sorted out).

  python -m sync.run amazon-transactions <Date Range report .csv>   (Reports -> Payments -> Date Range Reports)
  python -m sync.run amazon-listings <All Listings report .txt>      (Inventory -> Inventory Reports)
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import pathlib
import re

from .common import money, upsert

MON = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}


def parse_posted(s: str) -> dt.datetime:
    """'Mar 2, 2026 1:05:33 PM PST' -> naive datetime as printed (Pacific)."""
    m = re.match(r"(\w{3}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)", s.strip())
    if not m:
        raise ValueError(f"Unrecognized date/time: {s!r}")
    mo, d, y, h, mi, sec, ap = m.groups()
    return dt.datetime(int(y), MON[mo], int(d), int(h) % 12 + (12 if ap == "PM" else 0), int(mi), int(sec))


TX_COLS = ["row_hash", "posted_at", "day", "type", "settlement_id", "order_id", "sku", "description", "quantity",
           "fulfillment", "product_sales", "shipping_credits", "gift_wrap_credits", "promo_rebates", "selling_fees",
           "fba_fees", "other_fees", "other", "total", "report_file"]


def transaction_rows(text: str, report_file: str) -> list[tuple]:
    lines = text.lstrip("﻿").splitlines()
    head = next(i for i, l in enumerate(lines) if l.startswith('"date/time"'))
    out, seen = [], {}
    for r in csv.DictReader(io.StringIO("\n".join(lines[head:]))):
        raw = "|".join(r.get(k) or "" for k in r)
        # identical lines can legitimately repeat (two identical fees on one day): number them
        n = seen.get(raw, 0)
        seen[raw] = n + 1
        h = hashlib.md5(f"{raw}|{n}".encode()).hexdigest()
        posted = parse_posted(r["date/time"])
        out.append((h, posted, posted.date(), r.get("type") or "", r.get("settlement id") or "",
                    r.get("order id") or "", r.get("sku") or "", (r.get("description") or "")[:300],
                    int(money(r.get("quantity"))), r.get("fulfillment") or "", money(r.get("product sales")),
                    money(r.get("shipping credits")), money(r.get("gift wrap credits")),
                    money(r.get("promotional rebates")), money(r.get("selling fees")), money(r.get("fba fees")),
                    money(r.get("other transaction fees")), money(r.get("other")), money(r.get("total")), report_file))
    return out


def load_transactions(conn, path: str) -> int:
    p = pathlib.Path(path)
    return upsert(conn, "jt.amazon_transactions", TX_COLS, transaction_rows(p.read_text(encoding="utf-8-sig"), p.name),
                  ["row_hash"])


LISTING_COLS = ["sku", "asin", "title", "price", "quantity", "channel", "status", "open_date", "report_file",
                "uploaded_at"]


def listing_rows(text: str, report_file: str) -> list[tuple]:
    rows = list(csv.DictReader(io.StringIO(text.lstrip("﻿")), delimiter="\t"))
    now = dt.datetime.now(dt.timezone.utc)
    out = []
    for r in rows:
        sku = (r.get("seller-sku") or "").strip()
        if not sku:
            continue
        qty = (r.get("quantity") or "").strip()
        opened = (r.get("open-date") or "")[:10]
        out.append((sku, r.get("asin1") or r.get("product-id") or "", (r.get("item-name") or "")[:300],
                    money(r.get("price")) if (r.get("price") or "").strip() else None,
                    int(float(qty)) if qty else None, r.get("fulfillment-channel") or "", r.get("status") or "Active",
                    opened if re.match(r"\d{4}-\d{2}-\d{2}", opened) else None, report_file, now))
    return out


def load_listings(conn, path: str) -> int:
    p = pathlib.Path(path)
    return upsert(conn, "jt.amazon_listings", LISTING_COLS, listing_rows(p.read_text(encoding="utf-8-sig",
                                                                                       errors="replace"), p.name), ["sku"])
