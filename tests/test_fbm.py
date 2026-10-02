"""Amazon FBM orders -> Shopify stock: which lines can be taken out of Shopify, and the decisions."""
import json


def setup(cur):
    cur.execute("insert into jt.variants (variant_id, product_id, inventory_item_id, sku, display_name, inventory_qty) "
                "values (7, 11, 999, 'SG17', 'Synthetic Gut 17', 40)")
    cur.execute("insert into jt.docs (collection, id, data) values ('amzmap', 's_A3', %s), ('amzmap', 's_A1', %s)",
                (json.dumps({"sku": "A-3PK", "kind": "shopify", "variantId": "gid://shopify/ProductVariant/7", "units": 3}),
                 json.dumps({"sku": "A-1", "kind": "shopify", "variantId": "gid://shopify/ProductVariant/7", "units": 1})))
    rows = [("111-1", "A-3PK", "Shipped", 2), ("111-2", "A-1", "Pending", 1), ("111-3", "NOMAP", "Shipped", 1),
            ("111-4", "A-1", "Cancelled", 1)]
    for oid, sku, st, q in rows:
        cur.execute("insert into jt.amazon_order_lines (order_id, sku, purchase_at, order_status, fulfillment, marketplace, quantity) "
                    "values (%s, %s, '2026-09-30T18:00:00Z', %s, 'Merchant', 'us', %s)", (oid, sku, st, q))
    # an FBA line never shows up
    cur.execute("insert into jt.amazon_order_lines (order_id, sku, purchase_at, order_status, fulfillment, marketplace, quantity) "
                "values ('111-9', 'A-1', '2026-09-30T18:00:00Z', 'Shipped', 'Amazon', 'us', 1)")


def decide(cur, *ds):
    cur.execute("select jt.fbm_decide(%s::jsonb)", (json.dumps({"decisions": [dict(zip(("order_id", "sku", "decision"), d)) for d in ds], "by": "t"}),))
    return cur.fetchone()[0]


def test_lines_units_and_who_can_be_decremented(conn):
    cur = conn.cursor()
    setup(cur)
    cur.execute("select order_id, units, shipped, cancelled from jt.v_fbm_lines order by order_id")
    assert cur.fetchall() == [("111-1", 6, True, False), ("111-2", 1, False, False), ("111-3", None, True, False), ("111-4", 1, False, True)]
    out = decide(cur, ("111-1", "A-3PK", "decrement"), ("111-2", "A-1", "decrement"), ("111-3", "NOMAP", "decrement"),
                 ("111-4", "A-1", "decrement"))
    assert out["queued"] == 1
    assert sorted(r["why"] for r in out["refused"]) == ["not shipped yet", "the Amazon listing isn't mapped to a Shopify product",
                                                        "the order is cancelled"]
    cur.execute("select units, inventory_item_id, status from jt.fbm_decisions where order_id = '111-1'")
    assert cur.fetchone() == (6, 999, "pending")
    # can't be sent twice, or skipped once sent
    out = decide(cur, ("111-1", "A-3PK", "decrement"), ("111-1", "A-3PK", "skip"))
    assert out["queued"] == 0 and [r["why"] for r in out["refused"]] == ["already sent to Shopify"] * 2


def test_skip_and_undo(conn):
    cur = conn.cursor()
    setup(cur)
    assert decide(cur, ("111-3", "NOMAP", "skip"))["skipped"] == 1
    cur.execute("select status from jt.v_fbm_lines where order_id = '111-3'")
    assert cur.fetchone()[0] == "skipped"
    assert decide(cur, ("111-3", "NOMAP", "undo"))["undone"] == 1
    cur.execute("select status from jt.v_fbm_lines where order_id = '111-3'")
    assert cur.fetchone()[0] == "undone"
    assert decide(cur, ("111-1", "A-3PK", "decrement"))["queued"] == 1


class FbmShop:
    """Fake Shopify for the FBM job: one location, 40 available, and an API version that refuses the idempotency key."""
    def __init__(self, locations=1):
        self.locations, self.adjusts = locations, []

    def graphql(self, q, v=None, version=None):
        if "inventoryLevels(" in q:
            return {"inventoryItem": {"tracked": True, "inventoryLevels": {"nodes": [
                {"location": {"id": f"gid://shopify/Location/{i}"}, "quantities": [{"name": "available", "quantity": 40 - i}]} for i in range(self.locations)]}}}
        if "@idempotent" in q:
            raise RuntimeError("Shopify GraphQL error: Directive 'idempotent' is not defined")
        self.adjusts.append(v)
        return {"inventoryAdjustQuantities": {"inventoryAdjustmentGroup": {"id": "g"}, "userErrors": []}}


def test_job_takes_units_out_of_shopify(conn):
    from sync import shopify as sh
    cur = conn.cursor()
    setup(cur)
    decide(cur, ("111-1", "A-3PK", "decrement"))
    conn.commit()
    shop = FbmShop()
    assert sh.apply_fbm_adjustments(shop, conn) == 1
    ch = shop.adjusts[0]["input"]["changes"][0]
    assert ch == {"inventoryItemId": "gid://shopify/InventoryItem/999", "locationId": "gid://shopify/Location/0",
                  "delta": -6, "changeFromQuantity": 40}
    assert shop.adjusts[0]["input"]["referenceDocumentUri"] == "gid://just-tennis/AmazonOrder/111-1"
    cur.execute("select status, shopify_before from jt.fbm_decisions")
    assert cur.fetchone() == ("done", 40)
    cur.execute("select inventory_qty from jt.variants where variant_id = 7")
    assert cur.fetchone()[0] == 34
    assert sh.apply_fbm_adjustments(shop, conn) == 0                     # nothing pending: nothing sent again


def test_job_needs_a_location_when_there_are_several(conn):
    from sync import shopify as sh
    cur = conn.cursor()
    setup(cur)
    decide(cur, ("111-1", "A-3PK", "decrement"))
    conn.commit()
    assert sh.apply_fbm_adjustments(FbmShop(locations=2), conn) == 0
    cur.execute("select status, error like '%stocked at 2 Shopify locations%' from jt.fbm_decisions")
    assert cur.fetchone() == ("failed", True)
    # once the location is set, the units come from that one
    cur.execute("""update jt.settings set value = value || '{"location_id": "gid://shopify/Location/1"}' where key = 'fbm_sync'""")
    decide(cur, ("111-1", "A-3PK", "decrement"))
    conn.commit()
    shop = FbmShop(locations=2)
    assert sh.apply_fbm_adjustments(shop, conn) == 1
    ch = shop.adjusts[0]["input"]["changes"][0]
    assert (ch["locationId"], ch["changeFromQuantity"]) == ("gid://shopify/Location/1", 39)
