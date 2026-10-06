"""On The List: adding doesn't place an order; "Add to PO" puts an item on its vendor's draft PO (migrations 089, 091)."""
import json


def add(cur, vid, sku=""):
    cur.execute("select jt.prep_list_add(%s::jsonb)", (json.dumps({"variant_id": vid, "amazon_sku": sku, "dest": "prep", "by": "t"}),))
    lid = cur.fetchone()[0]
    cur.execute("select order_id from jt.prep_list where id = %s", (lid,))
    assert cur.fetchone()[0] is None                   # just on the list
    cur.execute("select jt.prep_list_to_po(%s::jsonb)", (json.dumps({"id": lid, "by": "t"}),))
    cur.execute("select i.order_id, o.vendor, o.status from jt.prep_list i join jt.prep_orders o on o.id = i.order_id where i.id = %s", (lid,))
    return cur.fetchone()


def test_one_draft_per_vendor(conn):
    cur = conn.cursor()
    cur.execute("""insert into jt.variants (variant_id, product_id, sku, vendor) values
                   (1, 10, 'A', 'Wilson'), (2, 20, 'B', 'wilson'), (3, 30, 'C', 'Head')""")
    a, b, c = add(cur, 1), add(cur, 2), add(cur, 3)
    assert a[0] == b[0] and a[2] == "draft"          # same vendor (any case) -> same draft
    assert c[0] != a[0] and c[1] == "Head"
    cur.execute("update jt.prep_orders set status = 'ordered' where id = %s", (a[0],))
    assert add(cur, 1, "X")[0] not in (a[0], c[0])   # placed order: a new draft for the vendor
    cur.execute("select count(*), sum(qty_ordered) from jt.prep_order_lines where order_id = %s", (a[0],))
    assert cur.fetchone() == (2, 0)                  # no quantity needed
