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


def fin(cur, lines):
    cur.execute("select public.jt_amazon_fin_lines_save(%s::jsonb)", (json.dumps({"lines": lines}),))


def fl(tid, type_, total, amounts=None, **kw):
    base = {"transaction_id": tid, "item": 0, "posted_at": "2026-09-15T17:00:00Z", "type": type_, "description": type_,
            "status": "RELEASED", "marketplace": "ATVPDKIKX0DER", "total": total, "amounts": amounts or {}}
    base.update(kw)
    return base


def test_finances_build_a_day_like_the_transaction_report(conn):
    cur = conn.cursor()
    fin(cur, [
        # an FBA order, posted deferred, and the later release copy of it (left out)
        fl("o1", "Shipment", 8.35, {"ProductCharges/OurPricePrincipal": 13.99, "AmazonFees/Commission/Base": -2.1,
                                    "AmazonFees/FBAPerUnitFulfillmentFee/Base": -3.54, "Shipping/ShippingPrincipal": 1.5,
                                    "PromoRebates/ShippingDiscount": -1.5}, status="DEFERRED_RELEASED", order_id="111-1",
           sku="A", qty=1, fulfillment="AFN"),
        fl("o1r", "Shipment", 8.35, {"ProductCharges/OurPricePrincipal": 13.99}, order_id="111-1", sku="A", qty=1,
           fulfillment="AFN", release_of="o1", posted_at="2026-09-22T17:00:00Z"),
        fl("o2", "Shipment", 233.34, {"ProductCharges/Principal": 306, "AmazonFees/Commission": -45.9,
                                      "FBAFees/FBAPerUnitFulfillmentFee": -26.76}, order_id="113-2", sku="B", qty=1, fulfillment="AFN"),
        fl("r1", "Refund", -8.79, {"ProductCharges/OurPricePrincipal": -9.99, "AmazonFees/Commission/Base": 1.5,
                                   "AmazonFees/RefundCommission/Base": -0.3}, order_id="112-9", sku="A", qty=1),
        fl("s1", "ServiceFee", -141.41, description="FBAPostInboundTransportation"),
        fl("s2", "ServiceFee", -12.6, description="AWDProcessingFee"),
        fl("t1", "Transfer", 178915.8, description="Disbursement"),
        fl("mx", "Shipment", 50, {"ProductCharges/OurPricePrincipal": 60}, marketplace="A1AM78C64UM0Y8", order_id="701-1", sku="C", qty=1),
    ])
    cur.execute("select public.jt_amazon_fin_build('{\"first\": \"2026-09-15\", \"last\": \"2026-09-22\", \"target\": \"amzdays_api\"}')")
    assert cur.fetchone()[0] == 1          # only Sep 15 has anything (the release copy on Sep 22 doesn't count)
    cur.execute("select data from jt.docs where collection = 'amzdays_api' and id = '2026-09-15'")
    d = cur.fetchone()[0]
    t = d["totals"]
    assert (t["orders"], t["units"]) == (2, 2)
    assert D(str(t["sales"])) == D("319.99") and D(str(t["orders_net"])) == D("241.69")
    assert D(str(t["sellfees"])) == D("-48.00") and D(str(t["fbafees"])) == D("-30.30")
    assert D(str(t["ship"])) == D("1.50") and D(str(t["promo"])) == D("-1.50")
    assert D(str(t["refunds_net"])) == D("-8.79") and D(str(t["refund_sales"])) == D("-9.99")
    assert {k: D(str(v)) for k, v in d["other"].items()} == {"fbaother": D("-154.01")}
    assert d["skus"] == ["A", "B"] and d["orders"][0][1] == "111-1" and d["refunds"][0][2] == 0
    cur.execute("select data->'skus', data->'totals'->>'sales' from jt.docs where collection = 'amzmonths_api' and id = '2026-09'")
    skus, sales = cur.fetchone()
    assert skus["B"][0] == 1 and D(sales) == D("319.99")
