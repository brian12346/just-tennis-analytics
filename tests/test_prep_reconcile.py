"""Linking a prep shipment to Seller Central (migrations 086, 087): Seller Central's quantities win, and the
difference stays in the prep center (earmarked) or goes back to Shopify."""
import json

V = 101


def setup(cur, status="started", stock=300, line=288):
    cur.execute("insert into jt.prep_shipments (id, name, dest, status) values (1, '', 'FBA', %s)", (status,))
    cur.execute("insert into jt.prep_shipment_lines (shipment_id, variant_id, amazon_sku, qty) values (1, %s, '', %s)", (V, line))
    if stock:
        cur.execute("insert into jt.prep_items (variant_id, amazon_sku, qty) values (%s, '', %s)", (V, stock))


def link(cur, qty, to):
    p = {"shipment_id": 1, "amazon_ids": ["FBA1A", "FBA1B"], "how": "match", "by": "t",
         "reconcile": {"lines": [{"variant_id": V, "amazon_sku": "SKU", "qty": qty}], "dispose": [{"variant_id": V, "to": to, "amazon_sku": "SKU"}]}}
    cur.execute("select jt.prep_ship_link2(%s::jsonb)", (json.dumps(p),))
    return cur.fetchone()[0]


def state(cur):
    cur.execute("select amazon_sku, qty from jt.prep_items where variant_id = %s order by 1", (V,))
    items = dict(cur.fetchall())
    cur.execute("select amazon_sku, qty from jt.prep_shipment_lines where shipment_id = 1")
    lines = dict(cur.fetchall())
    cur.execute("select coalesce(sum(delta), 0) from jt.shopify_stock_moves where status = 'pending'")
    return items, lines, cur.fetchone()[0]


def test_open_shipment_keeps_extra_earmarked(conn):
    cur = conn.cursor(); setup(cur)
    r = link(cur, 285, "prep")
    assert r["linked"] == 2 and r["reconcile"]["to_prep"] == 3
    assert state(cur) == ({"": 12, "SKU": 288}, {"SKU": 285}, 0)


def test_open_shipment_extra_back_to_shopify(conn):
    cur = conn.cursor(); setup(cur)
    assert link(cur, 285, "shopify")["reconcile"]["to_shopify"] == 3
    assert state(cur) == ({"": 12, "SKU": 285}, {"SKU": 285}, 3)


def test_shipped_shipment_extra_comes_back(conn):
    cur = conn.cursor(); setup(cur, "shipped", stock=12)
    link(cur, 285, "prep")
    assert state(cur) == ({"": 12, "SKU": 3}, {"SKU": 285}, 0)


def test_shipped_shipment_more_in_seller_central(conn):
    cur = conn.cursor(); setup(cur, "shipped", stock=1)
    r = link(cur, 290, "prep")["reconcile"]
    assert (r["taken"], r["short"]) == (1, 1)
    assert state(cur) == ({}, {"SKU": 290}, 0)
