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
