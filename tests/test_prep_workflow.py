"""Prep center workflow (migration 090): invoice arrival dates, the shipment checklist, last backordered."""
import json

import psycopg
import pytest


def flow(cur, p):
    cur.execute("select jt.prep_ship_flow(%s::jsonb)", (json.dumps({"by": "t", **p}),))
    return cur.fetchone()[0]


def test_checklist_and_close(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.prep_shipments (id, name, dest, status) values (1, '', 'FBA', 'started')")
    s = flow(cur, {"id": 1, "placement": "fees_ok", "check": {"counted": True, "combined": True}})
    assert s["placement"] == "fees_ok" and set(s["checks"]) == {"counted", "combined"}
    assert set(flow(cur, {"id": 1, "check": {"combined": False}})["checks"]) == {"counted"}
    s = flow(cur, {"id": 1, "exception": "3 short"})
    assert s["exception"] == "3 short" and s["exception_at"]
    assert flow(cur, {"id": 1, "exception": ""})["exception_at"] is None
    with pytest.raises(psycopg.errors.RaiseException):
        flow(cur, {"id": 1, "close": True})          # not shipped yet
    conn.rollback()


def test_close_shipped_and_arrival(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.prep_shipments (id, name, dest, status) values (2, '', 'FBA', 'shipped')")
    assert flow(cur, {"id": 2, "close": True})["closed_at"]
    cur.execute("insert into jt.invoices (id, vendor, invoice_no) values (5, 'Head', 'X')")
    cur.execute("select jt.invoice_set_arrival('{\"id\": 5, \"arrival_on\": \"2026-10-20\"}')")
    cur.execute("select arrival_on::text from jt.invoices where id = 5")
    assert cur.fetchone()[0] == "2026-10-20"


def test_backorder_at(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.prep_orders (id, vendor) values (7, 'Head')")
    cur.execute("insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered) values (7, 1, '', 'prep', 5)")
    cur.execute("select backorder_at from jt.prep_order_lines where order_id = 7")
    assert cur.fetchone()[0] is None
    cur.execute("update jt.prep_order_lines set backorder = true where order_id = 7")
    cur.execute("select backorder_at from jt.prep_order_lines where order_id = 7")
    assert cur.fetchone()[0] is not None
