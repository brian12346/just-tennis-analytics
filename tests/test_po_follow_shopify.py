"""Migration 129: a Seller Sage PO linked to a Shopify PO picks up what Shopify received on its Shopify-store lines."""


def test_po_follows_shopify_receipts(conn):
    cur = conn.cursor()
    cur.execute("""insert into jt.variants (variant_id, product_id, inventory_item_id, sku, display_name, inventory_qty) values
                   (7, 11, 999, 'A', 'String A', 0), (8, 12, 998, 'B', 'String B', 0), (9, 13, 997, 'C', 'Grip C', 0)""")
    cur.execute("""insert into jt.prep_orders (id, vendor, po_no, status, shopify_po_url) values
                   (17, 'Wilson', 'PO1244', 'invoiced', 'https://admin.shopify.com/store/justtennis-822/purchase_orders/555')""")
    # Shopify-store lines A (5) and B (3); a prep-center line C (10) that Shopify knows nothing about
    cur.execute("""insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, qty_received) values
                   (17, 7, '', 'shopify', 5, 0), (17, 8, '', 'shopify', 3, 0), (17, 9, 'C-AMZ', 'prep', 10, 0)""")
    cur.execute("insert into jt.shopify_pos (id, name, recv_status, recv_units) values (555, '#PO1244', 'partial', 0)")
    # the Shopify PO orders more of A than the Seller Sage PO does
    cur.execute("""insert into jt.shopify_po_lines (po_id, line_id, variant_id, qty, qty_received) values
                   (555, '1', 7, 9, 0), (555, '2', 8, 3, 0)""")

    def recv():
        cur.execute("select variant_id, dest, qty_received from jt.prep_order_lines where order_id = 17 order by variant_id")
        return cur.fetchall()

    # the sync saves a partial receipt: 2 of A
    cur.execute("update jt.shopify_po_lines set qty_received = 2 where po_id = 555 and line_id = '1'")
    assert recv() == [(7, "shopify", 2), (8, "shopify", 0), (9, "prep", 0)]
    cur.execute("select status, shopify_received_at from jt.prep_orders where id = 17")
    assert cur.fetchone() == ("partial", None)
    # then everything: Shopify got 9 of A (capped at the 5 this PO ordered) and 3 of B
    cur.execute("update jt.shopify_po_lines set qty_received = case line_id when '1' then 9 else 3 end where po_id = 555")
    cur.execute("update jt.shopify_pos set recv_status = 'received', recv_units = 12 where id = 555")
    assert recv() == [(7, "shopify", 5), (8, "shopify", 3), (9, "prep", 0)]
    cur.execute("select status, shopify_received_at is not null, shopify_received_by from jt.prep_orders where id = 17")
    assert cur.fetchone() == ("partial", True, "Shopify")   # the prep line is still to come
    # running again changes nothing
    cur.execute("select jt.po_follow_shopify('555')")
    assert cur.fetchone()[0] == 0
    assert recv() == [(7, "shopify", 5), (8, "shopify", 3), (9, "prep", 0)]


def test_new_shopify_po_comes_in(conn):
    """Migration 130: a new Shopify PO becomes a Seller Sage PO once its lines are read; received ones follow Shopify."""
    cur = conn.cursor()
    cur.execute("""insert into jt.variants (variant_id, product_id, inventory_item_id, sku, display_name, inventory_qty, vendor) values
                   (21, 31, 991, 'S1', 'Shoe 1', 0, 'Babolat'), (22, 32, 992, 'S2', 'Shoe 2', 0, 'Babolat')""")
    # the sync writes the PO and its lines in one transaction; the import runs when it commits
    cur.execute("""insert into jt.shopify_pos (id, name, status, supplier, created_at, expected_at, total, lines, units, lines_synced)
                   values (777, '#PO1242', 'ORDERED', 'Babolat Inc', '2026-10-06T17:00:00Z', '2026-10-20T17:00:00Z', 475.2, 3, 7, now())""")
    cur.execute("""insert into jt.shopify_po_lines (po_id, line_id, variant_id, sku, title, qty, cost) values
                   (777, '1', 21, 'S1', 'Shoe 1', 4, 79.2), (777, '2', 22, 'S2', 'Shoe 2', 2, 79.2), (777, '3', null, 'ZZ', 'Mystery', 1, 0)""")
    cur.execute("set constraints all immediate")   # what commit does
    cur.execute("select ss_order_id from jt.shopify_pos where id = 777")
    ord_ = cur.fetchone()[0]
    assert ord_ is not None
    cur.execute("select vendor, po_no, status, receive_into, expected_on::text, created_by, shopify_po_url like '%%/purchase_orders/777', note <> '' from jt.prep_orders where id = %s", (ord_,))
    assert cur.fetchone() == ("Babolat", "PO1242", "ordered", "shopify", "2026-10-20", "Shopify (auto)", True, True)
    cur.execute("select variant_id, dest, qty_ordered, unit_cost from jt.prep_order_lines where order_id = %s order by variant_id", (ord_,))
    assert [(a, b, c, float(d)) for a, b, c, d in cur.fetchall()] == [(21, "shopify", 4, 79.2), (22, "shopify", 2, 79.2)]
    # it's brought in once: running again (or after the Seller Sage PO is deleted) makes nothing new
    cur.execute("select jt.po_import_shopify(777)")
    assert cur.fetchone()[0] is None
    # receiving in Shopify follows
    cur.execute("update jt.shopify_po_lines set qty_received = qty where po_id = 777")
    cur.execute("select sum(qty_received) from jt.prep_order_lines where order_id = %s", (ord_,))
    assert cur.fetchone()[0] == 6


def test_older_po_comes_in_when_more_is_received(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, inventory_item_id, sku, display_name, inventory_qty, vendor) values (23, 33, 993, 'G1', 'Grip', 0, 'Wilson')")
    cur.execute("""insert into jt.shopify_pos (id, name, status, supplier, created_at, lines, units, lines_synced)
                   values (888, '#PO1100', 'ORDERED', 'Wilson', '2026-06-01T17:00:00Z', 1, 100, now())""")
    cur.execute("insert into jt.shopify_po_lines (po_id, line_id, variant_id, qty) values (888, '1', 23, 100)")
    cur.execute("set constraints all immediate")
    cur.execute("select ss_imported_at from jt.shopify_pos where id = 888")
    assert cur.fetchone()[0] is None          # older: not brought in just for being read
    # first receipt check: 40 already in — that's where it stands, nothing comes in
    cur.execute("update jt.shopify_po_lines set qty_received = 40 where po_id = 888")
    cur.execute("update jt.shopify_pos set recv_units = 40, recv_status = 'partial', recv_synced = now() where id = 888")
    cur.execute("select ss_imported_at from jt.shopify_pos where id = 888")
    assert cur.fetchone()[0] is None
    # more received: it comes in, with what Shopify has received so far
    cur.execute("update jt.shopify_po_lines set qty_received = 70 where po_id = 888")
    cur.execute("update jt.shopify_pos set recv_units = 70, recv_synced = now() where id = 888")
    cur.execute("select ss_order_id from jt.shopify_pos where id = 888")
    ord_ = cur.fetchone()[0]
    assert ord_ is not None
    cur.execute("select o.status, l.qty_ordered, l.qty_received from jt.prep_orders o join jt.prep_order_lines l on l.order_id = o.id where o.id = %s", (ord_,))
    assert cur.fetchone() == ("partial", 100, 70)
