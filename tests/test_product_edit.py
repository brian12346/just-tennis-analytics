"""Inventory › Products › edit (migration 221): jt.product_edit queues Shopify changes; apply_product_updates writes them."""
import json

import pytest

from sync import shopify as sh


def _seed(cur):
    cur.execute("""insert into jt.variants (variant_id, product_id, sku, product_title, variant_title, display_name, vendor, product_type, status,
                   price, unit_cost, inventory_item_id, inventory_qty, barcode)
                   values (11, 100, 'SPD-1', 'Speed MP 2026', '4 1/4', 'Speed MP 2026 - 4 1/4', 'Head', 'Tennis Racquet', 'ACTIVE', 279, 150, 911, 5, ''),
                          (12, 100, 'SPD-2', 'Speed MP 2026', '4 3/8', 'Speed MP 2026 - 4 3/8', 'Head', 'Tennis Racquet', 'ACTIVE', 279, 150, 912, 3, '')""")


class FakeShop:
    def __init__(self, fail=None):
        self.calls, self.fail = [], fail

    def graphql(self, query, variables=None):
        self.calls.append((query, variables))
        if query is sh.PRODUCT_UPDATE_M:
            return {"productUpdate": {"product": {"id": variables["p"]["id"]}, "userErrors": [{"field": ["title"], "message": self.fail}] if self.fail else []}}
        return {"productVariantsBulkUpdate": {"productVariants": [], "userErrors": []}}


def test_product_edit_queues_and_applies(conn):
    cur = conn.cursor()
    _seed(cur)
    p = {"product_id": 100, "by": "b@x.com", "product": {"title": " Speed MP 2026 (Black) ", "status": "draft"},
         "variants": [{"variant_id": 11, "sku": "SPD-1B", "barcode": "0123", "price": "289", "cost": ""},
                      {"variant_id": 12, "cost": "155", "count": 7}]}
    cur.execute("select jt.product_edit(%s::jsonb)", (json.dumps(p),))
    assert cur.fetchone()[0] == {"product": 1, "variants": 1, "prices_costs": 2, "counts": 1}
    cur.execute("select fields from jt.shopify_product_updates where variant_id is null")
    assert cur.fetchone()[0] == {"title": "Speed MP 2026 (Black)", "status": "DRAFT"}
    cur.execute("select variant_id, new_cost, new_price from jt.cost_updates order by variant_id")
    rows = cur.fetchall()
    assert [(r[0], r[1] and float(r[1]), r[2] and float(r[2])) for r in rows] == [(11, None, 289.0), (12, 155.0, None)]
    cur.execute("select variant_id, set_to from jt.shopify_stock_moves")
    assert cur.fetchall() == [(12, 7)]
    conn.commit()

    shop = FakeShop()
    assert sh.apply_product_updates(shop, conn) == 2
    prod = next(v for q, v in shop.calls if q is sh.PRODUCT_UPDATE_M)
    assert prod["p"] == {"id": "gid://shopify/Product/100", "title": "Speed MP 2026 (Black)", "status": "DRAFT"}
    var = next(v for q, v in shop.calls if q is sh.VARIANT_FIELDS_M)
    assert var["variants"] == [{"id": "gid://shopify/ProductVariant/11", "barcode": "0123", "inventoryItem": {"sku": "SPD-1B"}}]
    cur.execute("select variant_id, sku, barcode, status, display_name from jt.variants order by variant_id")
    assert cur.fetchall() == [(11, "SPD-1B", "0123", "DRAFT", "Speed MP 2026 (Black) - 4 1/4"), (12, "SPD-2", "", "DRAFT", "Speed MP 2026 (Black) - 4 3/8")]


def test_product_edit_rejects_and_records_failures(conn):
    cur = conn.cursor()
    _seed(cur)
    with pytest.raises(Exception, match="needs a name"):
        cur.execute("select jt.product_edit('{\"product_id\": 100, \"product\": {\"title\": \"  \"}}')")
    conn.rollback()
    _seed(cur)
    with pytest.raises(Exception, match="isn't part of this product"):
        cur.execute("select jt.product_edit('{\"product_id\": 100, \"variants\": [{\"variant_id\": 99, \"sku\": \"X\"}]}')")
    conn.rollback()
    _seed(cur)
    cur.execute("select jt.product_edit('{\"product_id\": 100, \"product\": {\"vendor\": \"HEAD\"}}')")
    # a newer edit of the same fields replaces a pending one
    cur.execute("select jt.product_edit('{\"product_id\": 100, \"product\": {\"vendor\": \"Head\"}}')")
    cur.execute("select status, fields->>'vendor' from jt.shopify_product_updates order by id")
    assert cur.fetchall() == [("replaced", "HEAD"), ("pending", "Head")]
    conn.commit()
    assert sh.apply_product_updates(FakeShop(fail="Title can't be blank"), conn) == 0
    cur.execute("select status, error from jt.shopify_product_updates where status <> 'replaced'")
    assert cur.fetchone() == ("failed", "Title can't be blank")
