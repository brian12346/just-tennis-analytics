"""Amazon orders from SP-API reports: saving lines, newer data winning, and the daily view."""
import json
from decimal import Decimal as D


def save(cur, report, lines):
    cur.execute("select public.jt_amazon_save(%s::jsonb)", (json.dumps({"op": "lines", "report_id": report, "lines": lines}),))
    return cur.fetchone()[0]


def line(order, sku, **kw):
    base = {"order_id": order, "sku": sku, "purchase_at": "2026-09-30T23:15:02+00:00", "last_updated_at": "2026-10-01T01:00:00+00:00",
            "order_status": "Shipped", "fulfillment": "Amazon", "sales_channel": "Amazon.com", "marketplace": "us",
            "quantity": 1, "currency": "USD", "item_price": 20}
    base.update(kw)
    return base


def test_an_older_report_never_overwrites_newer_order_state(conn):
    cur = conn.cursor()
    assert save(cur, "R2", [line("111-1", "A", order_status="Shipped")]) == 1
    assert save(cur, "R1", [line("111-1", "A", order_status="Pending", last_updated_at="2026-09-30T23:20:00+00:00")]) == 0
    cur.execute("select order_status, report_id from jt.amazon_order_lines where order_id = '111-1'")
    assert cur.fetchone() == ("Shipped", "R2")


def test_daily_view_uses_pacific_day_converts_currency_and_skips_cancelled_and_mcf(conn):
    cur = conn.cursor()
    save(cur, "R", [
        line("1", "A", quantity=2, item_price=40, item_promo=-5),                                    # 4:15pm Sep 30 Pacific
        line("2", "B", marketplace="mx", sales_channel="Amazon.com.mx", currency="MXN", item_price=1000),
        line("3", "C", order_status="Cancelled"),
        line("4", "D", marketplace="other", sales_channel="Non-Amazon", item_price=0, quantity=9),
        line("5", "E", purchase_at="2026-10-01T08:30:00+00:00", order_status="Pending"),             # 1:30am Oct 1 Pacific
    ])
    cur.execute("select day::text, marketplace, orders, units, sales, net_sales, pending_orders from jt.v_amazon_api_daily order by 1, 2")
    rows = cur.fetchall()
    assert rows == [("2026-09-30", "mx", 1, 1, D("54.00"), D("54.00"), 0),
                    ("2026-09-30", "us", 1, 2, D("40.00"), D("35.00"), 0),
                    ("2026-10-01", "us", 1, 1, D("20.00"), D("20.00"), 1)]


def test_report_bookkeeping_and_status(conn):
    cur = conn.cursor()
    cur.execute("select public.jt_amazon_save(%s::jsonb)", (json.dumps({"op": "request", "report_id": "9", "report_type": "T", "kind": "recent", "marketplaces": ["us", "mx"], "data_start": "2026-09-28T00:00:00Z"}),))
    cur.execute("select public.jt_amazon_state()")
    st = cur.fetchone()[0]
    assert [p["report_id"] for p in st["pending"]] == ["9"]
    cur.execute("select waiting, as_of from jt.v_amazon_api_status")
    assert cur.fetchone() == (1, None)
    cur.execute("select public.jt_amazon_save(%s::jsonb)", (json.dumps({"op": "report", "report_id": "9", "status": "done", "rows": 3}),))
    cur.execute("select waiting, as_of is not null from jt.v_amazon_api_status")
    assert cur.fetchone() == (0, True)
