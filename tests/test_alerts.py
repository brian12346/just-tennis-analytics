"""Operational alerts: the rules and the alert lifecycle (new, still there, cleared, resolved, snoozed)."""
import json


def act(cur, ids, action, **kw):
    cur.execute("select jt.alert_act(%s::jsonb)", (json.dumps(dict(ids=ids, action=action, by="t", **kw)),))
    return cur.fetchone()[0]


def refresh(cur):
    cur.execute("select jt.refresh_alerts()")
    return cur.fetchone()[0]


def alerts(cur, rule):
    cur.execute("select id, key, status, severity from jt.alerts where rule = %s order by id", (rule,))
    return cur.fetchall()


def test_negative_stock_lifecycle(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, inventory_item_id, sku, display_name, inventory_qty) values (7, 11, 999, 'SG17', 'Gut 17', -2)")
    assert refresh(cur)["new"] == 1
    [(aid, key, st, sev)] = alerts(cur, "negative_stock")
    assert (key, st, sev) == ("7", "open", "warning")
    assert refresh(cur) == {"new": 0, "updated": 1, "cleared": 0, "reopened": 0}
    # resolved while still negative: stays resolved, no new alert
    import pytest
    cur.execute("savepoint s")
    with pytest.raises(Exception):
        act(cur, [aid], "resolve")          # needs a note
    cur.execute("rollback to savepoint s")
    assert act(cur, [aid], "resolve", resolution="Counted, fixed in Shopify", cause="Count wrong") == 1
    refresh(cur)
    assert [a[2] for a in alerts(cur, "negative_stock")] == ["resolved"]
    # fixed, then negative again much later -> a new alert (a repeat)
    cur.execute("update jt.variants set inventory_qty = 3 where variant_id = 7")
    refresh(cur)
    cur.execute("update jt.alerts set last_seen = now() - interval '2 hours' where rule = 'negative_stock'")
    cur.execute("update jt.variants set inventory_qty = -1 where variant_id = 7")
    refresh(cur)
    assert [a[2] for a in alerts(cur, "negative_stock")] == ["resolved", "open"]
    # goes away on its own -> cleared
    cur.execute("update jt.variants set inventory_qty = 0 where variant_id = 7")
    cur.execute("update jt.alerts set last_seen = now() - interval '5 minutes' where status = 'open'")
    assert refresh(cur)["cleared"] == 1
    cur.execute("select status, resolution from jt.alerts where rule = 'negative_stock' order by id desc limit 1")
    assert cur.fetchone() == ("cleared", "Cleared on its own")


def test_snooze_and_owner(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, inventory_item_id, sku, display_name, inventory_qty) values (8, 12, 998, 'X', 'X', -1)")
    cur.execute("select jt.alert_rule_set('{\"code\": \"negative_stock\", \"owner\": \"ana@x.com\"}')")
    refresh(cur)
    [(aid, *_)] = alerts(cur, "negative_stock")
    cur.execute("select owner from jt.alerts where id = %s", (aid,))
    assert cur.fetchone()[0] == "ana@x.com"
    act(cur, [aid], "snooze", until="2000-01-01T00:00:00Z")
    assert refresh(cur)["reopened"] == 1
    assert alerts(cur, "negative_stock")[0][2] == "open"
    act(cur, [aid], "assign", owner="ryan@x.com")
    cur.execute("select owner from jt.alerts where id = %s", (aid,))
    assert cur.fetchone()[0] == "ryan@x.com"


def test_shipping_rules(conn):
    cur = conn.cursor()
    cur.execute("""insert into jt.amazon_order_lines (order_id, sku, purchase_at, order_status, item_status, fulfillment, marketplace, quantity, product_name)
                   values ('111-1', 'A', now() - interval '50 hours', 'Pending', 'Unshipped', 'Merchant', 'us', 1, 'Racket'),
                          ('111-2', 'A', now() - interval '30 hours', 'Pending', 'Unshipped', 'Merchant', 'us', 2, 'Racket'),
                          ('111-3', 'A', now() - interval '3 hours', 'Pending', 'Unshipped', 'Merchant', 'us', 1, 'Racket'),
                          ('111-4', 'A', now() - interval '60 hours', 'Shipped', 'Shipped', 'Merchant', 'us', 1, 'Racket')""")
    cur.execute("""insert into jt.prep_orders (id, vendor, po_no, status, expected_on, kind) values
                   (1, 'Wilson', 'W1', 'ordered', current_date - 10, 'order'), (2, 'Head', 'H1', 'ordered', current_date + 3, 'order'),
                   (3, 'Babolat', 'B1', 'complete', current_date - 30, 'order')""")
    refresh(cur)
    cur.execute("select key, severity from jt.alerts where rule = 'amazon_fbm_late' order by key")
    assert cur.fetchall() == [("111-1", "critical"), ("111-2", "warning")]
    cur.execute("select key, severity from jt.alerts where rule = 'po_overdue'")
    assert cur.fetchall() == [("1", "critical")]


def test_oversell(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, inventory_item_id, sku, display_name, inventory_qty) values (9, 13, 997, 'P', 'Paddle', 2)")
    cur.execute("insert into jt.docs (collection, id, data) values ('amzmap', 's_P', %s)",
                (json.dumps({"sku": "P-FBM", "kind": "shopify", "variantId": "gid://shopify/ProductVariant/9", "units": 1}),))
    cur.execute("insert into jt.docs (collection, id, data) values ('amzlistings', 'c000', %s)",
                (json.dumps({"file": "f", "total": 2, "rows": [["P-FBM", "B0P", "Paddle", 99, 5, "DEFAULT", "Active", "2020-01-01"],
                                                             ["U-FBM", "B0U", "Unmapped", 9, 3, "DEFAULT", "Active", "2020-01-01"]]}),))
    refresh(cur)
    cur.execute("select key, title, severity from jt.alerts where rule = 'fbm_oversell'")
    assert cur.fetchall() == [("P-FBM", "Amazon shows 5, stock covers 2", "warning")]
    cur.execute("select link->'skus' from jt.alerts where rule = 'fbm_unmapped_listed'")
    assert cur.fetchone()[0] == ["U-FBM"]
