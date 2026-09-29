"""The profit math in the views: saved costs, returns on later days, cost history."""
import json
from decimal import Decimal as D
import pytest

SALES_COLS = "day, order_id, order_name, variant_id, product_title, units, net, cogs, net_no_cost"


def add_daily(cur, day, net, cogs, nc, gp=None):
    cur.execute("insert into jt.shopify_daily (day, net, cogs, gross_profit, net_no_cost) values (%s,%s,%s,%s,%s)",
                (day, net, cogs, net - cogs if gp is None else gp, nc))


def daily(cur, day):
    cur.execute("select cogs, net_no_cost, gross_profit from jt.v_daily where day = %s", (day,))
    return cur.fetchone()


def test_migrations_are_repeatable(conn):
    from sync import migrate
    migrate.main()  # second run is a no-op


def test_saved_cost_covers_the_order_and_adds_only_the_difference(conn):
    cur = conn.cursor()
    add_daily(cur, "2026-08-25", 771.69 + 100, 387.6, 771.69)
    cur.execute(f"insert into jt.shopify_sales ({SALES_COLS}) values "
                "('2026-08-25', 1, '#21391', 11, 'Agassi Pro V', 2, 771.69, 387.6, 771.69)")
    cur.execute("select jt.save_cost_override(%s::jsonb)",
                (json.dumps({"order_id": 1, "order_name": "#21391", "cost": 802, "shopify_cogs": 387.6}),))
    cogs, nc, gp = daily(cur, "2026-08-25")
    assert cogs == D("802.00")            # 387.60 recorded + 414.40 entered
    assert nc == D("0.00")
    assert gp == D("69.69")               # 871.69 net - 802 cost


def test_sold_then_returned_is_not_flagged_on_either_day(conn):
    cur = conn.cursor()
    add_daily(cur, "2026-09-04", 39.95, 0, 39.95)
    add_daily(cur, "2026-09-10", -39.95, 0, -39.95)
    cur.execute(f"insert into jt.shopify_sales ({SALES_COLS}) values "
                "('2026-09-04', 2, '#21678', 22, 'Vision II Backpack', 1, 39.95, 0, 39.95),"
                "('2026-09-10', 2, '#21678', 22, 'Vision II Backpack', -1, -39.95, 0, -39.95)")
    assert daily(cur, "2026-09-04")[1] == D("0.00")
    assert daily(cur, "2026-09-10")[1] == D("0.00")
    cur.execute("select count(*) from jt.v_costmap_orders")
    assert cur.fetchone()[0] == 0


def test_partial_return_moves_its_share_of_the_added_cost(conn):
    cur = conn.cursor()
    add_daily(cur, "2026-09-01", 200, 0, 200)
    add_daily(cur, "2026-09-05", -50, 0, -50)
    cur.execute(f"insert into jt.shopify_sales ({SALES_COLS}) values "
                "('2026-09-01', 3, '#1', 33, 'Bag', 4, 200, 0, 200),"
                "('2026-09-05', 3, '#1', 33, 'Bag', -1, -50, 0, -50)")
    cur.execute("select jt.save_cost_override(%s::jsonb)",
                (json.dumps({"order_id": 3, "cost": 60, "shopify_cogs": 0}),))   # 3 bags kept x $20
    assert daily(cur, "2026-09-01")[0] == D("80.00")    # 4 bags on the sale day
    assert daily(cur, "2026-09-05")[0] == D("-20.00")   # one comes back
    cur.execute("select cogs from jt.v_order_profit where order_id = 3")


def test_open_orders_and_lines_for_cost_mapping(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.shopify_orders (order_id, name, created_at, order_day) values (4, '#4', now(), current_date)")
    cur.execute("insert into jt.shopify_order_lines (line_id, order_id, variant_id, title, quantity, current_quantity)"
                " values (40, 4, 44, 'Grip', 2, 2), (41, 4, 45, 'String', 1, 1), (42, 4, null, 'Custom', 1, 1)")
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost) values (44, 1, 3.5)")
    cur.execute(f"insert into jt.shopify_sales ({SALES_COLS}) values "
                "(current_date, 4, '#4', 44, 'Grip', 2, 20, 0, 20),"
                "(current_date, 4, '#4', 45, 'String', 1, 10, 6, 0),"
                "(current_date, 4, '#4', 0, '', 1, 5, 0, 5)")
    cur.execute("select line_id, shopify_cost_now from jt.v_costmap_lines order by line_id")
    assert cur.fetchall() == [(40, D("3.50")), (42, None)]
    cur.execute("select net_no_cost from jt.v_costmap_orders")
    assert cur.fetchone()[0] == D("25.00")


def test_cost_history_corrections_vs_real_changes(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost) values (5, 1, 6.83)")
    cur.execute("select jt.set_setting('costs', '{\"history_start\": \"2026-09-24\"}'::jsonb)")
    # edited on Sep 22 (before clean data): a correction, today's cost applies to all history
    cur.execute("insert into jt.variant_cost_changes (changed_on, variant_id, old_cost, new_cost) values ('2026-09-22', 5, 8.50, 6.83)")
    cur.execute("select jt.variant_cost_on(5, '2026-08-17')")
    assert cur.fetchone()[0] == D("6.83")
    # a real price rise on Oct 1: earlier sales keep 6.83
    cur.execute("update jt.variants set unit_cost = 7.25 where variant_id = 5")
    cur.execute("insert into jt.variant_cost_changes (changed_on, variant_id, old_cost, new_cost) values ('2026-10-01', 5, 6.83, 7.25)")
    cur.execute("select jt.variant_cost_on(5, '2026-09-30'), jt.variant_cost_on(5, '2026-10-02')")
    assert cur.fetchone() == (D("6.83"), D("7.25"))
    # marking the Sep 22 edit as real brings back the old cost for sales before it
    cur.execute("select id from jt.variant_cost_changes where changed_on = '2026-09-22'")
    cur.execute("select jt.set_cost_change_kind(%s, 'real')", (cur.fetchone()[0],))
    cur.execute("select jt.variant_cost_on(5, '2026-08-17')")
    assert cur.fetchone()[0] == D("8.50")


def test_amazon_cost_uses_mapping(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost) values (6, 1, 2.00)")
    cur.execute("select jt.save_amazon_map(%s::jsonb)", (json.dumps({"sku": "A-12PK", "kind": "shopify", "variant_id": 6, "units": 12}),))
    cur.execute("insert into jt.amazon_transactions (row_hash, posted_at, day, type, sku, quantity, product_sales, total)"
                " values ('h1', '2026-09-01 10:00', '2026-09-01', 'Order', 'A-12PK', 2, 60, 45),"
                "        ('h2', '2026-09-01 11:00', '2026-09-01', 'Order', 'UNMAPPED', 1, 10, 7)")
    cur.execute("select units, sales, product_cost, sales_without_cost from jt.v_amazon_daily")
    assert cur.fetchone() == (3, D("70.00"), D("48.0000"), D("10.00"))


def test_current_cost_views_recost_past_sales(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, sku, product_title, unit_cost) values (21, 9, 'AC102-3W', 'Super Grap', 4.00), (22, 9, 'X', 'No cost yet', null)")
    add_daily(cur, "2026-03-02", 100, 9.02 + 5, 20)
    cur.execute(f"insert into jt.shopify_sales ({SALES_COLS}) values "
                "('2026-03-02', 1, '#1', 21, 'Super Grap', 2, 16, 9.02, 0),"      # recorded at the old $4.51
                "('2026-03-02', 2, '#2', 21, 'Super Grap', 1, 8, 0, 8),"          # sold before it had a cost
                "('2026-03-02', 3, '#3', 22, 'No cost yet', 1, 12, 0, 12),"       # still no cost: unchanged
                "('2026-03-02', 4, '#4', 0, 'Custom item', 1, 64, 5, 0)")         # custom item: unchanged
    cur.execute("select order_id, cogs, net_no_cost from jt.v_shopify_sales_costed order by order_id")
    assert cur.fetchall() == [(1, D("8.00"), D("0")), (2, D("4.00"), D("0")), (3, D("0.00"), D("12.00")), (4, D("5.00"), D("0.00"))]
    cur.execute("select cogs, gross_profit, net_no_cost from jt.v_shopify_daily_costed where day = '2026-03-02'")
    assert cur.fetchone() == (D("17.00"), D("83.00"), D("12.00"))      # 14.02 + 2.98; 20 - 8 no-cost now costed
    cur.execute("select sum(cogs), sum(net_no_cost) from jt.v_product_sales_daily_costed where day = '2026-03-02'")
    assert cur.fetchone() == (D("17.00"), D("12.00"))


def test_amazon_sku_fees_last_180_days(conn):
    cur = conn.cursor()
    day = lambda d, skus, orders: cur.execute("insert into jt.docs (collection, id, data) values ('amzdays', %s, %s::jsonb)",
                                              (d, json.dumps({"date": d, "skus": skus, "orders": orders})))
    # [time, orderId, skuIdx, qty, sales, ship, promo, sellfees, fbafees, total, fba]
    day("2026-09-01", ["A", "B"], [["10:00", "o1", 0, 2, 40, 0, 0, -6, -8, 26, 1], ["11:00", "o2", 1, 1, 20, 0, 0, -3, 0, 17, 0]])
    day("2026-09-20", ["A"], [["09:00", "o3", 0, 1, 20, 0, 0, -3, -4.5, 12.5, 1]])
    day("2025-12-01", ["A"], [["09:00", "o0", 0, 5, 100, 0, 0, -50, -50, 0, 1]])   # more than 180 days before the last day: left out
    cur.execute("select sku, units, sales, sell_fees, fba_units, fba_fees, last_sold from jt.v_amz_sku_fees order by sku")
    assert cur.fetchall() == [("A", D(3), D("60.00"), D("-9.00"), D(3), D("-12.50"), "2026-09-20"),
                              ("B", D(1), D("20.00"), D("-3.00"), D(0), D("0.00"), "2026-09-01")]


def test_prep_center_count_ship_and_seed(conn):
    import pytest
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost) values (501, 50, 10.68), (502, 50, 21.18)")
    adj = lambda body: (cur.execute("select jt.prep_adjust(%s::jsonb)", (json.dumps(body),)), cur.fetchone()[0])[1]
    ship = lambda body: (cur.execute("select jt.prep_ship(%s::jsonb)", (json.dumps(body),)), cur.fetchone()[0])[1]
    assert adj({"by": "b@x.com", "lines": [{"variant_id": 501, "amazon_sku": "001WILPOG12", "qty": 100, "note": "count"},
                                            {"variant_id": 502, "qty": 5}]}) == 2
    assert adj({"lines": [{"variant_id": 501, "amazon_sku": "001WILPOG12", "qty": 100}]}) == 0      # same count: nothing logged
    assert ship({"shipment": "FBA1", "dest": "fba", "lines": [{"variant_id": 501, "amazon_sku": "001WILPOG12", "qty": 40}]}) == 1
    cur.execute("select variant_id, amazon_sku, qty from jt.prep_items order by variant_id")
    assert cur.fetchall() == [(501, "001WILPOG12", 60), (502, "", 5)]
    cur.execute("savepoint s")
    with pytest.raises(Exception, match="only 5"):
        ship({"lines": [{"variant_id": 502, "qty": 6}]})
    cur.execute("rollback to savepoint s")
    ship({"dest": "AWD", "lines": [{"variant_id": 502, "qty": 5}]})                                  # emptied: row removed
    cur.execute("select kind, variant_id, qty_change, qty_after, dest, by_user from jt.prep_moves order by id")
    assert cur.fetchall() == [("adjust", 501, 100, 100, "", "b@x.com"), ("adjust", 502, 5, 5, "", "b@x.com"),
                              ("ship", 501, -40, 60, "FBA", ""), ("ship", 502, -5, 0, "AWD", "")]
    cur.execute("select jt.prep_seed(%s::jsonb)", (json.dumps({"lines": [{"variant_id": 502, "qty": 7}, {"variant_id": 502, "qty": 3}]}),))
    cur.execute("select variant_id, amazon_sku, qty from jt.prep_items")
    assert cur.fetchall() == [(502, "", 10)]


def test_asin_mapping_fill(conn):
    cur = conn.cursor()
    doc = lambda c, i, d: cur.execute("insert into jt.docs (collection, id, data) values (%s, %s, %s::jsonb) "
                                      "on conflict (collection, id) do update set data = excluded.data", (c, i, json.dumps(d)))
    doc("amzlistings", "c000", {"rows": [["A-FBA", "B000000001", "Grip"], ["A-FBM", "B000000001", "Grip"], ["A(2)", "B000000001", "Grip"],
                                         ["B-FBA", "B000000002", "Bag"], ["B-FBM", "B000000002", "Bag"]]})
    m = lambda sku, vid, **kw: doc("amzmap", "s_" + sku.replace("(", "~28").replace(")", "~29"),
                                   {"sku": sku, "kind": "shopify", "variantId": f"gid://shopify/ProductVariant/{vid}", "units": 1, **kw})
    m("A-FBA", 11)                       # trigger copies it to A-FBM and A(2)
    m("B-FBA", 21); m("B-FBM", 22, via="match")   # hand-made sibling mapping is left alone
    cur.execute("select id, data->>'variantId', data->>'via', data->>'fromSku' from jt.docs where collection = 'amzmap' order by id")
    got = {r[0]: r[1:] for r in cur.fetchall()}
    assert got["s_A~282~29"] == ("gid://shopify/ProductVariant/11", "asin", "A-FBA")
    assert got["s_A-FBM"] == ("gid://shopify/ProductVariant/11", "asin", "A-FBA")
    assert got["s_B-FBM"] == ("gid://shopify/ProductVariant/22", "match", None)
    m("A-FBA", 12)                       # a change follows to the automatic copies
    cur.execute("select data->>'variantId' from jt.docs where collection = 'amzmap' and id = 's_A-FBM'")
    assert cur.fetchone()[0] == "gid://shopify/ProductVariant/12"


def test_prep_shipment_workflow(conn):
    import pytest
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost) values (601, 60, 5), (602, 60, 7)")
    call = lambda fn, body: (cur.execute(f"select jt.{fn}(%s::jsonb)", (json.dumps(body),)), cur.fetchone()[0])[1]
    call("prep_adjust", {"lines": [{"variant_id": 601, "amazon_sku": "X-FBA", "qty": 50}, {"variant_id": 602, "qty": 8}]})
    sid = call("prep_shipment_save", {"name": "FBA1", "dest": "fba", "by": "b@x.com",
                                      "lines": [{"variant_id": 601, "amazon_sku": "X-FBA", "qty": 20}, {"variant_id": 602, "qty": 3}]})
    assert call("prep_shipment_status", {"id": sid, "status": "started"}) == "started"
    cur.execute("select sum(qty) from jt.prep_items"); assert cur.fetchone()[0] == 58          # nothing leaves until shipped
    call("prep_shipment_save", {"id": sid, "name": "FBA1", "dest": "FBA", "lines": [{"variant_id": 601, "amazon_sku": "X-FBA", "qty": 20}, {"variant_id": 602, "qty": 9}]})
    cur.execute("savepoint s")
    with pytest.raises(Exception, match="only 8"):
        call("prep_shipment_status", {"id": sid, "status": "shipped"})
    cur.execute("rollback to savepoint s")
    call("prep_shipment_save", {"id": sid, "lines": [{"variant_id": 601, "amazon_sku": "X-FBA", "qty": 20}, {"variant_id": 602, "qty": 8}]})
    assert call("prep_shipment_status", {"id": sid, "status": "shipped", "by": "b@x.com"}) == "shipped"
    cur.execute("select variant_id, qty from jt.prep_items order by 1"); assert cur.fetchall() == [(601, 30)]
    cur.execute("select count(*), min(shipment_id), min(shipment) from jt.prep_moves where kind = 'ship'"); assert cur.fetchone() == (2, sid, "FBA1")
    cur.execute("select status, shipped_by from jt.prep_shipments where id = %s", (sid,)); assert cur.fetchone() == ("shipped", "b@x.com")
    cur.execute("savepoint t")
    with pytest.raises(Exception, match="already shipped"):
        call("prep_shipment_save", {"id": sid, "lines": []})
    cur.execute("rollback to savepoint t")
    other = call("prep_shipment_save", {"name": "", "lines": [{"variant_id": 601, "amazon_sku": "X-FBA", "qty": 1}]})
    assert call("prep_shipment_delete", {"id": other}) is True


def test_prep_order_receive_and_ship(conn):
    import pytest
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost) values (701, 70, 5), (702, 70, 7)")
    cur.execute("insert into jt.invoices (vendor, invoice_no) values ('Wilson', 'INV-9') returning id"); inv = cur.fetchone()[0]
    call = lambda fn, body: (cur.execute(f"select jt.{fn}(%s::jsonb)", (json.dumps(body),)), cur.fetchone()[0])[1]
    oid = call("prep_order_save", {"vendor": "Wilson", "po_no": "PO-1", "by": "b@x.com",
                                   "lines": [{"variant_id": 701, "amazon_sku": "W-FBA", "qty": 48, "unit_cost": 4.5}, {"variant_id": 702, "qty": 10}]})
    for st in ["ordered", "invoiced", "draft", "ordered"]:                 # any direction before receiving
        assert call("prep_order_status", {"id": oid, "status": st}) == st
    call("prep_order_save", {"id": oid, "invoice_id": inv, "expected_on": "2026-10-05"})
    cur.execute("select invoice_id, expected_on::text, stage_at ? 'invoiced' from jt.prep_orders where id = %s", (oid,))
    assert cur.fetchone() == (inv, "2026-10-05", True)
    cur.execute("savepoint a")
    with pytest.raises(Exception, match="QB ready once"):
        call("prep_order_status", {"id": oid, "status": "qb_ready"})
    cur.execute("rollback to savepoint a")
    # part of it arrives, then the rest
    assert call("prep_order_receive", {"id": oid, "lines": [{"variant_id": 701, "amazon_sku": "W-FBA", "qty": 40}, {"variant_id": 702, "qty": 10}]}) == 50
    cur.execute("select status from jt.prep_orders where id = %s", (oid,)); assert cur.fetchone()[0] == "partial"
    call("prep_order_receive", {"id": oid, "lines": [{"variant_id": 701, "amazon_sku": "W-FBA", "qty": 8}]})
    cur.execute("select status, stage_at ? 'partial', stage_at ? 'received' from jt.prep_orders where id = %s", (oid,)); assert cur.fetchone() == ("received", True, True)
    cur.execute("select variant_id, amazon_sku, qty from jt.prep_items order by 1"); assert cur.fetchall() == [(701, "W-FBA", 48), (702, "", 10)]
    cur.execute("select variant_id, qty_ordered, qty_received from jt.prep_order_lines where order_id = %s order by 1", (oid,)); assert cur.fetchall() == [(701, 48, 48), (702, 10, 10)]
    cur.execute("select count(*), sum(qty_change), min(order_id), min(shipment) from jt.prep_moves where kind = 'receive'"); assert cur.fetchone() == (3, 58, oid, "PO-1")
    # lines are locked once received; notes are not
    call("prep_order_save", {"id": oid, "note": "all in", "lines": []})
    cur.execute("select count(*) from jt.prep_order_lines where order_id = %s", (oid,)); assert cur.fetchone()[0] == 2
    cur.execute("savepoint b")
    with pytest.raises(Exception, match="can't be deleted"):
        call("prep_order_delete", {"id": oid})
    cur.execute("rollback to savepoint b")
    # an outgoing shipment made from the order takes the stock out; the PO's stage doesn't change
    sid = call("prep_shipment_save", {"name": "FBA2", "order_id": oid, "lines": [{"variant_id": 701, "amazon_sku": "W-FBA", "qty": 48}, {"variant_id": 702, "qty": 10}]})
    call("prep_shipment_status", {"id": sid, "status": "shipped"})
    cur.execute("select status from jt.prep_orders where id = %s", (oid,)); assert cur.fetchone()[0] == "received"
    # QB ready, complete, and back
    for st in ["qb_ready", "complete", "qb_ready", "received"]: assert call("prep_order_status", {"id": oid, "status": st}) == st
    cur.execute("select coalesce(sum(qty), 0) from jt.prep_items"); assert cur.fetchone()[0] == 0
    draft = call("prep_order_save", {"vendor": "Head", "lines": [{"variant_id": 701, "qty": 1}]})
    assert call("prep_order_delete", {"id": draft}) is True


def test_prep_step_back(conn):
    import pytest
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost) values (801, 80, 5), (802, 80, 7)")
    call = lambda fn, body: (cur.execute(f"select jt.{fn}(%s::jsonb)", (json.dumps(body),)), cur.fetchone()[0])[1]
    stock = lambda: (cur.execute("select variant_id, qty from jt.prep_items order by 1"), cur.fetchall())[1]
    oid = call("prep_order_save", {"vendor": "Head", "lines": [{"variant_id": 801, "qty": 10}, {"variant_id": 802, "qty": 4}]})
    call("prep_order_status", {"id": oid, "status": "invoiced"})
    call("prep_order_receive", {"id": oid, "lines": [{"variant_id": 801, "qty": 10}, {"variant_id": 802, "qty": 4}]})
    assert stock() == [(801, 10), (802, 4)]
    # outgoing shipment from the order: ship, then step back -> stock returns
    sid = call("prep_shipment_save", {"name": "FBA3", "order_id": oid, "lines": [{"variant_id": 801, "qty": 6}]})
    call("prep_shipment_status", {"id": sid, "status": "shipped"})
    assert stock() == [(801, 4), (802, 4)]
    cur.execute("select status from jt.prep_orders where id = %s", (oid,)); assert cur.fetchone()[0] == "received"
    assert call("prep_shipment_status", {"id": sid, "status": "started"}) == "started"
    assert stock() == [(801, 10), (802, 4)]
    cur.execute("select status, shipped_at from jt.prep_shipments where id = %s", (sid,)); assert cur.fetchone() == ("started", None)
    cur.execute("select count(*), sum(qty_change) from jt.prep_moves where kind = 'unship'"); assert cur.fetchone() == (1, 6)
    assert call("prep_shipment_status", {"id": sid, "status": "open"}) == "open"
    call("prep_shipment_delete", {"id": sid})
    # order: complete -> back to received (no stock change), received -> invoiced takes the units back out
    call("prep_order_status", {"id": oid, "status": "qb_ready"}); call("prep_order_status", {"id": oid, "status": "complete"})
    cur.execute("savepoint b")
    with pytest.raises(Exception, match="back to received first"):
        call("prep_order_status", {"id": oid, "status": "invoiced"})
    cur.execute("rollback to savepoint b")
    assert call("prep_order_status", {"id": oid, "status": "received"}) == "received"
    assert stock() == [(801, 10), (802, 4)]
    assert call("prep_order_status", {"id": oid, "status": "invoiced"}) == "invoiced"
    assert stock() == []
    cur.execute("select sum(qty_received) from jt.prep_order_lines where order_id = %s", (oid,)); assert cur.fetchone()[0] == 0
    cur.execute("select count(*) from jt.prep_moves where kind = 'unreceive'"); assert cur.fetchone()[0] == 2
    # can't un-receive stock that already went out
    call("prep_order_receive", {"id": oid, "lines": [{"variant_id": 801, "qty": 10}]})
    s2 = call("prep_shipment_save", {"name": "FBA4", "lines": [{"variant_id": 801, "qty": 8}]})
    call("prep_shipment_status", {"id": s2, "status": "shipped"})
    cur.execute("savepoint a")
    with pytest.raises(Exception, match="only 2"):
        call("prep_order_status", {"id": oid, "status": "invoiced"})
    cur.execute("rollback to savepoint a")


def test_on_the_list(conn):
    import pytest
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost, vendor) values (901, 90, 5, 'Babolat'), (902, 90, 7, 'Babolat'), (903, 91, 3, 'Babolat')")
    call = lambda fn, body: (cur.execute(f"select jt.{fn}(%s::jsonb)", (json.dumps(body),)), cur.fetchone()[0])[1]
    a = call("prep_list_add", {"variant_id": 901, "amazon_sku": "B-FBA", "dest": "prep", "qty": 24, "source": "amazon"})
    assert call("prep_list_add", {"variant_id": 901, "amazon_sku": "B-FBA", "dest": "prep", "qty": 36}) == a      # same item, qty updated
    b = call("prep_list_add", {"variant_id": 902, "dest": "shopify", "source": "inventory"})
    c = call("prep_list_add", {"variant_id": 903, "dest": "prep", "qty": 6})
    # a + b onto a new booking order, c onto a normal draft
    book = call("prep_list_assign", {"ids": [a, b], "new": {"vendor": "Babolat", "kind": "booking", "place_by": "2026-11-01"}})
    draft = call("prep_list_assign", {"ids": [c], "new": {"vendor": "Babolat"}})
    cur.execute("select kind, place_by::text, status from jt.prep_orders where id = %s", (book,)); assert cur.fetchone() == ("booking", "2026-11-01", "draft")
    cur.execute("select variant_id, dest, qty_ordered from jt.prep_order_lines where order_id = %s order by 1", (book,)); assert cur.fetchall() == [(901, "prep", 36), (902, "shopify", 0)]
    # move c onto the booking order: it leaves the other draft
    call("prep_list_assign", {"ids": [c], "order_id": book})
    cur.execute("select count(*) from jt.prep_order_lines where order_id = %s", (draft,)); assert cur.fetchone()[0] == 0
    # list qty follows onto the draft line
    call("prep_list_add", {"variant_id": 902, "dest": "shopify", "qty": 12})
    cur.execute("select qty_ordered from jt.prep_order_lines where order_id = %s and variant_id = 902", (book,)); assert cur.fetchone()[0] == 12
    # taking a line off the order in the order popup puts the item back to "needs an order"
    call("prep_order_save", {"id": book, "lines": [{"variant_id": 901, "amazon_sku": "B-FBA", "qty": 36}, {"variant_id": 902, "dest": "shopify", "qty": 12}]})
    cur.execute("select order_id from jt.prep_list where id = %s", (c,)); assert cur.fetchone()[0] is None
    # placed orders don't take list items
    call("prep_order_status", {"id": book, "status": "ordered"})
    cur.execute("savepoint a")
    with pytest.raises(Exception, match="already been placed"):
        call("prep_list_assign", {"ids": [c], "order_id": book})
    cur.execute("rollback to savepoint a")
    # receiving: prep line into the prep center, shopify line only recorded; list items close
    call("prep_order_receive", {"id": book, "lines": [{"variant_id": 901, "amazon_sku": "B-FBA", "qty": 36}, {"variant_id": 902, "dest": "shopify", "qty": 12}]})
    cur.execute("select variant_id, qty from jt.prep_items"); assert cur.fetchall() == [(901, 36)]
    cur.execute("select id from jt.prep_list where closed_at is null"); assert cur.fetchall() == [(c,)]
    # stepping back reopens them
    call("prep_order_status", {"id": book, "status": "invoiced"})
    cur.execute("select count(*) from jt.prep_list where closed_at is null"); assert cur.fetchone()[0] == 3
    cur.execute("select count(*) from jt.prep_items"); assert cur.fetchone()[0] == 0
    assert call("prep_list_remove", {"id": c}) is True


def test_ship_cost_overrides(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.shopify_orders (order_id, name, created_at, order_day) values (5001, '#5001', now(), current_date)")
    call = lambda fn, body: (cur.execute(f"select jt.{fn}(%s::jsonb)", (json.dumps(body),)), cur.fetchone()[0])[1]
    assert call("save_ship_cost", {"order_id": 5001, "cost": 0, "combined_with": "#5000", "by": "b@x.com"}) is True
    assert call("save_ship_cost", {"order_id": 5001, "cost": 8.4, "note": "USPS label bought on the site"}) is True
    cur.execute("select cost::float, combined_with, note from jt.ship_cost_overrides"); assert cur.fetchone() == (8.4, "", "USPS label bought on the site")
    assert call("delete_ship_cost", {"order_id": 5001}) is True


def test_purchase_order_save(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost, vendor) values (911, 91, 5, 'Head'), (912, 91, 7, 'Head')")
    call = lambda fn, body: (cur.execute(f"select jt.{fn}(%s::jsonb)", (json.dumps(body),)), cur.fetchone()[0])[1]
    inv = {"vendor": "Head", "invoice_no": "H-100", "invoice_date": "2026-09-20", "file_name": "h.pdf", "subtotal": 110, "stage": "new",
           "lines": [{"item_code": "abc-1", "description": "Speed MP", "qty": 2, "unit_cost": 40, "amount": 80, "variant_id": 911, "match_how": "manual", "dest": "shopify"},
                     {"item_code": "FRT", "description": "Freight", "qty": 1, "unit_cost": 10, "amount": 10, "variant_id": None, "match_how": ""},
                     {"item_code": "x-9", "description": "Grip", "qty": 4, "unit_cost": 5, "amount": 20, "variant_id": 912, "match_how": "guess-high", "dest": "prep", "amazon_sku": "HG-FBA"}]}
    order = {"vendor": "Head", "po_no": "4471"}
    lines = [{"variant_id": 911, "dest": "shopify", "qty": 2, "unit_cost": 40}, {"variant_id": 912, "amazon_sku": "HG-FBA", "dest": "prep", "qty": 4, "unit_cost": 5}]
    r = call("po_save", {"order": order, "lines": lines, "invoices": [inv], "remember": [{"item_code": "abc-1", "variant_id": 911}], "by": "t"})
    oid, iid = r["order_id"], r["invoice_ids"][0]
    cur.execute("select invoice_id, po_no, vendor from jt.prep_orders where id = %s", (oid,)); assert cur.fetchone() == (iid, "4471", "Head")
    cur.execute("select po_no from jt.invoices where id = %s", (iid,)); assert cur.fetchone()[0] == "4471"
    cur.execute("select line_no, variant_id, dest, amazon_sku from jt.invoice_lines where invoice_id = %s order by 1", (iid,))
    assert cur.fetchall() == [(1, 911, "shopify", ""), (2, None, "prep", ""), (3, 912, "prep", "HG-FBA")]
    cur.execute("select variant_id, dest, qty_ordered from jt.prep_order_lines where order_id = %s order by 1", (oid,)); assert cur.fetchall() == [(911, "shopify", 2), (912, "prep", 4)]
    cur.execute("select item_code, variant_id from jt.vendor_items where vendor = 'Head'"); assert cur.fetchall() == [("ABC1", 911)]
    # saving again keeps the same invoice (lines replaced)
    inv2 = dict(inv, id=iid, lines=inv["lines"][:1])
    r2 = call("po_save", {"order": dict(order, id=oid), "lines": lines, "invoices": [inv2], "remember": []})
    assert r2 == {"order_id": oid, "invoice_ids": [iid]}
    # the Shopify PO link: set, kept when not sent, cleared with ''
    url = "https://admin.shopify.com/store/x/purchase_orders/123"
    call("po_save", {"order": dict(order, id=oid, shopify_po_url=url), "invoices": []})
    call("po_save", {"order": dict(order, id=oid), "invoices": []})
    cur.execute("select shopify_po_url from jt.prep_orders where id = %s", (oid,)); assert cur.fetchone()[0] == url
    call("po_save", {"order": dict(order, id=oid, shopify_po_url=""), "invoices": []})
    cur.execute("select shopify_po_url from jt.prep_orders where id = %s", (oid,)); assert cur.fetchone()[0] == ""
    # receive into both, with one product split between the Shopify store and the prep center
    split = [{"variant_id": 911, "dest": "shopify", "qty": 1, "unit_cost": 40}, {"variant_id": 911, "dest": "prep", "qty": 1, "unit_cost": 40},
             {"variant_id": 912, "amazon_sku": "HG-FBA", "dest": "prep", "qty": 4, "unit_cost": 5}]
    call("po_save", {"order": dict(order, id=oid, receive_into="both"), "lines": split, "invoices": []})
    cur.execute("select receive_into from jt.prep_orders where id = %s", (oid,)); assert cur.fetchone()[0] == "both"
    cur.execute("select variant_id, dest, qty_ordered from jt.prep_order_lines where order_id = %s order by 1, 2", (oid,))
    assert cur.fetchall() == [(911, "prep", 1), (911, "shopify", 1), (912, "prep", 4)]
    call("po_save", {"order": dict(order, id=oid, receive_into="nonsense"), "invoices": []})
    cur.execute("select receive_into from jt.prep_orders where id = %s", (oid,)); assert cur.fetchone()[0] == "both"
    # the Shopify PO check snapshot: kept when not sent, replaced, cleared with null
    chk = {"source": "pdf", "name": "#PO12", "diffs": 1, "lines": [{"sku": "ABC-1", "qty": 2, "cost": 40, "variant_id": 911}]}
    call("po_save", {"order": dict(order, id=oid, shopify_check=chk), "invoices": []})
    call("po_save", {"order": dict(order, id=oid), "invoices": []})
    cur.execute("select shopify_check->>'name', shopify_check->'lines'->0->>'qty' from jt.prep_orders where id = %s", (oid,)); assert cur.fetchone() == ("#PO12", "2")
    call("po_save", {"order": dict(order, id=oid, shopify_check=None), "invoices": []})
    cur.execute("select shopify_check from jt.prep_orders where id = %s", (oid,)); assert cur.fetchone()[0] is None
    cur.execute("select count(*) from jt.invoice_lines where invoice_id = %s", (iid,)); assert cur.fetchone()[0] == 1
    # the PDF in two parts; part 0 replaces an older file
    call("invoice_file_put", {"invoice_id": iid, "part": 0, "parts": 2, "data": "QUJD", "name": "h.pdf", "type": "application/pdf", "size": 6})
    cur.execute("select file_parts from jt.invoices where id = %s", (iid,)); assert cur.fetchone()[0] == 0
    call("invoice_file_put", {"invoice_id": iid, "part": 1, "parts": 2, "data": "REVG"})
    cur.execute("select file_parts, file_size from jt.invoices where id = %s", (iid,)); assert cur.fetchone() == (2, 6)
    cur.execute("select string_agg(data, '' order by part) from jt.invoice_files where invoice_id = %s", (iid,)); assert cur.fetchone()[0] == "QUJDREVG"
    # deleting the draft order takes its draft invoice (and file) with it
    assert call("po_delete", {"id": oid}) is True
    cur.execute("select count(*) from jt.invoices where id = %s", (iid,)); assert cur.fetchone()[0] == 0
    cur.execute("select count(*) from jt.invoice_files where invoice_id = %s", (iid,)); assert cur.fetchone()[0] == 0


def test_prep_assign(conn):
    import pytest
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost) values (921, 92, 5)")
    call = lambda fn, body: (cur.execute(f"select jt.{fn}(%s::jsonb)", (json.dumps(body),)), cur.fetchone()[0])[1]
    call("prep_adjust", {"lines": [{"variant_id": 921, "qty": 30}]})
    # 10 to the single listing, 12 (6 two-packs) to the 2-pack listing; 8 stay unassigned
    assert call("prep_assign", {"variant_id": 921, "moves": [{"to_sku": "ONE-FBA", "qty": 10}, {"to_sku": "TWO-FBA", "qty": 12}], "by": "t"}) == 22
    cur.execute("select amazon_sku, qty from jt.prep_items where variant_id = 921 order by 1"); assert cur.fetchall() == [("", 8), ("ONE-FBA", 10), ("TWO-FBA", 12)]
    cur.execute("select amazon_sku, qty_change, note from jt.prep_moves where kind = 'assign' order by id")
    assert cur.fetchall() == [("", -10, "to ONE-FBA"), ("ONE-FBA", 10, "from any listing"), ("", -12, "to TWO-FBA"), ("TWO-FBA", 12, "from any listing")]
    # back to any listing; the emptied row goes away
    call("prep_assign", {"variant_id": 921, "from_sku": "ONE-FBA", "moves": [{"to_sku": "", "qty": 10}]})
    cur.execute("select amazon_sku, qty from jt.prep_items where variant_id = 921 order by 1"); assert cur.fetchall() == [("", 18), ("TWO-FBA", 12)]
    cur.execute("savepoint a")
    with pytest.raises(Exception, match="only 12"):
        call("prep_assign", {"variant_id": 921, "from_sku": "TWO-FBA", "moves": [{"to_sku": "", "qty": 13}]})
    cur.execute("rollback to savepoint a")


def test_invoice_finance_fields(conn):
    cur = conn.cursor()
    call = lambda fn, body: (cur.execute(f"select jt.{fn}(%s::jsonb)", (json.dumps(body),)), cur.fetchone()[0])[1]
    iid = call("save_invoice", {"vendor": "Wilson", "invoice_no": "W-1", "invoice_date": "2026-09-18", "due_date": "2026-10-18", "total": 1474, "terms": "Net 30",
        "lines": [{"description": "Pro Staff", "qty": 6, "unit_cost": 155, "amount": 930},
                  {"description": "Freight", "qty": 1, "unit_cost": 25, "amount": 25, "match_how": "skip", "account": "inbound_shipping"}]})
    cur.execute("select due_date::text, total::float, terms from jt.invoices where id = %s", (iid,)); assert cur.fetchone() == ("2026-10-18", 1474.0, "Net 30")
    cur.execute("select account, sum(amount)::float from jt.invoice_lines where invoice_id = %s group by 1 order by 1", (iid,))
    assert cur.fetchall() == [("inbound_shipping", 25.0), ("inventory", 930.0)]
    # a save that doesn't send the money fields keeps them (the Invoices tab)
    call("save_invoice", {"id": iid, "vendor": "Wilson", "invoice_no": "W-1", "lines": []})
    cur.execute("select due_date::text, total::float from jt.invoices where id = %s", (iid,)); assert cur.fetchone() == ("2026-10-18", 1474.0)


def test_po_multiple_invoices(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost, vendor) values (931, 93, 5, 'Babolat'), (932, 93, 7, 'Babolat'), (933, 93, 9, 'Babolat')")
    call = lambda fn, body: (cur.execute(f"select jt.{fn}(%s::jsonb)", (json.dumps(body),)), cur.fetchone()[0])[1]
    lines = [{"variant_id": 931, "dest": "shopify", "qty": 10}, {"variant_id": 932, "dest": "shopify", "qty": 6}, {"variant_id": 933, "dest": "shopify", "qty": 4}]
    inv1 = {"vendor": "Babolat", "invoice_no": "B-1", "lines": [{"description": "a", "qty": 10, "unit_cost": 5, "variant_id": 931}]}
    r = call("po_save", {"order": {"vendor": "Babolat", "po_no": "77"}, "lines": lines, "invoices": [inv1]})
    oid, (i1,) = r["order_id"], r["invoice_ids"]
    # the rest is backordered, one line with an ETA
    lines[1].update(backorder=True, eta="2026-11-01"); lines[2].update(backorder=True)
    inv2 = {"vendor": "Babolat", "invoice_no": "B-2", "lines": [{"description": "b", "qty": 6, "unit_cost": 7, "variant_id": 932}]}
    r = call("po_save", {"order": {"id": oid, "vendor": "Babolat", "po_no": "77"}, "lines": lines, "invoices": [dict(inv1, id=i1), inv2]})
    i2 = r["invoice_ids"][1]
    cur.execute("select id from jt.invoices where order_id = %s order by id", (oid,)); assert [x[0] for x in cur.fetchall()] == [i1, i2]
    cur.execute("select invoice_id from jt.prep_orders where id = %s", (oid,)); assert cur.fetchone()[0] == i2
    cur.execute("select variant_id, backorder, eta::text from jt.prep_order_lines where order_id = %s order by 1", (oid,))
    assert cur.fetchall() == [(931, False, None), (932, True, "2026-11-01"), (933, True, None)]
    # receive the first invoice; a received line can't be dropped, others can
    call("prep_order_receive", {"id": oid, "lines": [{"variant_id": 931, "dest": "shopify", "qty": 10}]})
    call("po_save", {"order": {"id": oid, "vendor": "Babolat", "po_no": "77"}, "lines": [lines[1]], "invoices": []})
    cur.execute("select variant_id, qty_received from jt.prep_order_lines where order_id = %s order by 1", (oid,)); assert cur.fetchall() == [(931, 10), (932, 0)]
    # taking an invoice off: the draft is deleted
    call("po_save", {"order": {"id": oid}, "remove_invoices": [i2]})
    cur.execute("select count(*) from jt.invoices where id = %s", (i2,)); assert cur.fetchone()[0] == 0
    cur.execute("select invoice_id from jt.prep_orders where id = %s", (oid,)); assert cur.fetchone()[0] == i1



def test_invoice_payment(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost, vendor) values (941, 94, 5, 'Yonex')")
    call = lambda fn, body: (cur.execute(f"select jt.{fn}(%s::jsonb)", (json.dumps(body),)), cur.fetchone()[0])[1]
    inv = {"vendor": "Yonex", "invoice_no": "Y-1", "total": 50, "lines": [{"description": "x", "qty": 10, "unit_cost": 5, "variant_id": 941}]}
    r = call("po_save", {"order": {"vendor": "Yonex"}, "lines": [{"variant_id": 941, "dest": "shopify", "qty": 10}], "invoices": [inv]})
    oid, iid = r["order_id"], r["invoice_ids"][0]
    cur.execute("select paid_on, pay_method from jt.invoices where id = %s", (iid,)); assert cur.fetchone() == (None, "")
    paid = dict(inv, id=iid, paid_on="2026-10-01", pay_method="ach", pay_ref="CONF-77", paid_from="Chase checking", paid_amount=50)
    call("po_save", {"order": {"id": oid}, "invoices": [paid]})
    cur.execute("select paid_on::text, pay_method, pay_ref, paid_from, paid_amount::float from jt.invoices where id = %s", (iid,))
    assert cur.fetchone() == ("2026-10-01", "ach", "CONF-77", "Chase checking", 50.0)
    # an invoice applied on the Invoices tab can still be marked paid
    cur.execute("update jt.invoices set status = 'applied' where id = %s", (iid,))
    call("po_save", {"order": {"id": oid}, "invoices": [dict(paid, pay_method="credit_card", pay_ref="4242")]})
    cur.execute("select pay_method, pay_ref from jt.invoices where id = %s", (iid,)); assert cur.fetchone() == ("credit_card", "4242")


def test_po_apply_costs_and_layers(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost, vendor, inventory_item_id) values (931, 93, 5, 'Head', 9931)")
    call = lambda fn, body: (cur.execute(f"select jt.{fn}(%s::jsonb)", (json.dumps(body),)), cur.fetchone()[0])[1]
    # an older PO, received before the layers start: part of the opening stock, not a layer
    old = call("po_save", {"order": {"vendor": "Head", "po_no": "OLD"}, "lines": [{"variant_id": 931, "dest": "prep", "qty": 3, "unit_cost": 4}], "invoices": []})["order_id"]
    call("prep_order_receive", {"id": old, "lines": [{"variant_id": 931, "dest": "prep", "qty": 3}]})
    cur.execute("update jt.prep_orders set stage_at = jsonb_build_object('partial', now() - interval '10 days') where id = %s", (old,))
    r = call("po_save", {"order": {"vendor": "Head", "po_no": "NEW"}, "lines": [{"variant_id": 931, "dest": "prep", "qty": 10, "unit_cost": 6, "update_cost": True}], "invoices": []})
    oid = r["order_id"]
    cur.execute("select update_cost from jt.prep_order_lines where order_id = %s", (oid,)); assert cur.fetchone()[0] is True
    # not received yet: refused
    with pytest.raises(Exception):
        cur.execute("savepoint s"); call("po_apply_costs", {"order_id": oid, "items": [{"variant_id": 931, "cost": 5.6}]})
    cur.execute("rollback to savepoint s")
    call("prep_order_receive", {"id": oid, "lines": [{"variant_id": 931, "dest": "prep", "qty": 10}]})
    cur.execute("select (stage_at->>'partial') from jt.prep_orders where id = %s", (oid,)); at = cur.fetchone()[0]
    n = call("po_apply_costs", {"order_id": oid, "by": "t", "items": [{"variant_id": 931, "cost": 5.64, "opening": {"qty": 4, "unit_cost": 5, "at": at}}]})
    assert n == 1
    cur.execute("select new_cost, status from jt.cost_updates where variant_id = 931"); assert cur.fetchone() == (D("5.64"), "pending")
    cur.execute("select update_cost, cost_applied from jt.prep_order_lines where order_id = %s", (oid,)); assert cur.fetchone() == (False, D("5.6400"))
    cur.execute("select kind, qty, unit_cost from jt.v_cost_layers where variant_id = 931 order by at, kind")
    assert cur.fetchall() == [("opening", 4, D("5.0000")), ("po", 10, D("6.0000"))]
    # a second apply doesn't move the opening layer; a later PO receipt is another layer
    call("po_apply_costs", {"order_id": oid, "items": [{"variant_id": 931, "cost": 5.7, "opening": {"qty": 99, "unit_cost": 1, "at": at}}]})
    later = call("po_save", {"order": {"vendor": "Head", "po_no": "LATER"}, "lines": [{"variant_id": 931, "dest": "prep", "qty": 5, "unit_cost": 7}], "invoices": []})["order_id"]
    call("prep_order_receive", {"id": later, "lines": [{"variant_id": 931, "dest": "prep", "qty": 5}]})
    cur.execute("select kind, qty, unit_cost from jt.v_cost_layers where variant_id = 931 order by at, kind")
    assert cur.fetchall() == [("opening", 4, D("5.0000")), ("po", 10, D("6.0000")), ("po", 5, D("7.0000"))]
