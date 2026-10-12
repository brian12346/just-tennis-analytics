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


def _shop_po(cur, spo, name, lines):
    cur.execute("set constraints all deferred")   # like the sync: the PO and its lines, then commit
    cur.execute("""insert into jt.shopify_pos (id, name, status, supplier, created_at, lines, units, lines_synced)
                   values (%s, %s, 'ORDERED', 'Wilson', now(), %s, %s, now())""", (spo, name, len(lines), sum(q for _, q in lines)))
    for i, (vid, q) in enumerate(lines):
        cur.execute("insert into jt.shopify_po_lines (po_id, line_id, variant_id, qty, cost) values (%s, %s, %s, %s, 10)", (spo, str(i), vid, q))
    cur.execute("set constraints all immediate")


def test_shopify_po_links_to_the_seller_sage_po_waiting_for_it(conn):
    """Migration 131: a PO made in Seller Sage first is linked when its Shopify PO comes in — no second PO."""
    import json
    cur = conn.cursor()
    cur.execute("insert into jt.app_users (user_id, email) values ('11111111-1111-1111-1111-111111111111', 'b@x.com') on conflict do nothing")
    cur.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"email": "b@x.com", "sub": "11111111-1111-1111-1111-111111111111"}),))
    cur.execute("""insert into jt.variants (variant_id, product_id, inventory_item_id, sku, display_name, inventory_qty, vendor) values
                   (41, 51, 941, 'R1', 'Racquet 1', 0, 'Wilson'), (42, 52, 942, 'R2', 'Racquet 2', 0, 'Wilson'), (43, 53, 943, 'R3', 'Racquet 3', 0, 'Wilson')""")
    # Seller Sage PO 30 (from ordering ideas): R1 x6, R2 x4, to the Shopify store, no Shopify link yet
    cur.execute("insert into jt.prep_orders (id, vendor, po_no, status, receive_into) values (30, 'Wilson', 'Oct racquets', 'ordered', 'shopify')")
    cur.execute("insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered) values (30, 41, '', 'shopify', 6), (30, 42, '', 'shopify', 4)")
    # the matching Shopify PO (one quantity differs — the Shopify check shows it)
    _shop_po(cur, 901, '#PO1250', [(41, 6), (42, 5)])
    cur.execute("select ss_order_id from jt.shopify_pos where id = 901")
    assert cur.fetchone()[0] == 30
    cur.execute("select count(*) from jt.prep_orders")
    assert cur.fetchone()[0] == 1
    cur.execute("select shopify_po_url like '%%/purchase_orders/901', shopify_check->>'name' from jt.prep_orders where id = 30")
    assert cur.fetchone() == (True, "#PO1250")

    # two waiting POs that look alike: suggested, nothing made
    cur.execute("insert into jt.prep_orders (id, vendor, po_no, status, receive_into) values (31, 'Wilson', 'A', 'ordered', 'shopify'), (32, 'Wilson', 'B', 'ordered', 'shopify')")
    cur.execute("insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered) values (31, 43, '', 'shopify', 2), (32, 43, '', 'shopify', 3)")
    _shop_po(cur, 902, '#PO1251', [(43, 2)])
    cur.execute("select ss_order_id, ss_suggest from jt.shopify_pos where id = 902")
    assert cur.fetchone() == (None, [31, 32])
    # "Not this one" on 31, then Link on 32
    cur.execute("select public.jt_po_shopify_link(%s::jsonb)", (json.dumps({"order_id": 31, "shopify_po_id": 902, "action": "reject"}),))
    cur.execute("select ss_order_id, ss_suggest, ss_rejected from jt.shopify_pos where id = 902")
    assert cur.fetchone() == (32, [], [31])   # only 32 left and it matches exactly: linked
    cur.execute("select count(*) from jt.prep_orders")
    assert cur.fetchone()[0] == 3


def test_linking_by_hand_catches_up(conn):
    """Migration 132: pasting a Shopify PO link on a Seller Sage PO receives what Shopify already has."""
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, inventory_item_id, sku, display_name, inventory_qty, vendor) values (61, 71, 961, 'B1', 'Blade', 0, 'Wilson')")
    _shop_po(cur, 990, '#PO1125', [(61, 10)])           # older, made in Shopify; nothing waiting, so it's brought in…
    cur.execute("update jt.shopify_pos set ss_imported_at = null, ss_order_id = null where id = 990")   # …pretend it predates auto-import
    cur.execute("delete from jt.prep_orders")
    cur.execute("update jt.shopify_po_lines set qty_received = 7 where po_id = 990")
    cur.execute("insert into jt.prep_orders (id, vendor, po_no, status, receive_into) values (40, 'Wilson', 'PO1125', 'ordered', 'shopify')")
    cur.execute("insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered) values (40, 61, '', 'shopify', 10)")
    cur.execute("update jt.prep_orders set shopify_po_url = 'https://admin.shopify.com/store/x/purchase_orders/990' where id = 40")
    cur.execute("select qty_received from jt.prep_order_lines where order_id = 40")
    assert cur.fetchone()[0] == 7
    cur.execute("select ss_order_id from jt.shopify_pos where id = 990")
    assert cur.fetchone()[0] == 40
