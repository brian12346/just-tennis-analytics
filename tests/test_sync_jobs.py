"""Sync jobs end to end against a fake Shopify API (response shapes copied from real calls)."""
import datetime as dt
from decimal import Decimal as D

from sync import shopify as sh

SALES_ROWS = [  # shopifyqlQuery rows are objects keyed by column name
    {"day": "2026-09-10", "order_id": "7799823401245", "order_name": "#21830", "product_variant_id": "52677997986077",
     "product_id": "10338740764957", "product_title": "Pure Drive Team Gen11", "product_variant_title": "4-1/4 (#2)",
     "product_variant_sku": "101585-100-2", "product_type": "Tennis Racquet", "product_vendor": "Babolat",
     "sales_channel": "Online Store", "net_items_sold": "2", "gross_sales": "578", "discounts": "0",
     "sales_reversals": "0", "net_sales": "578", "cost_of_goods_sold": "272", "net_sales_without_cost_recorded": "0"},
    {"day": "2026-09-10", "order_id": "7788625494301", "order_name": "#21678", "product_variant_id": "51062252273949",
     "product_id": "10118248333597", "product_title": "Vision II Backpack", "product_variant_title": "Black",
     "product_variant_sku": "15386", "product_type": "Bags", "product_vendor": "Vision", "sales_channel": "Online Store",
     "net_items_sold": "-1", "gross_sales": "0", "discounts": "0", "sales_reversals": "-39.95", "net_sales": "-39.95",
     "cost_of_goods_sold": "0", "net_sales_without_cost_recorded": "-39.95"},
    # two custom items on one order share a key: they are added together
    {"day": "2026-09-10", "order_id": "1", "order_name": "#1", "product_variant_id": "0", "product_id": "0",
     "product_title": "", "sales_channel": "Point of Sale", "net_items_sold": "1", "net_sales": "20",
     "net_sales_without_cost_recorded": "20"},
    {"day": "2026-09-10", "order_id": "1", "order_name": "#1", "product_variant_id": "0", "product_id": "0",
     "product_title": "", "sales_channel": "Point of Sale", "net_items_sold": "1", "net_sales": "5",
     "net_sales_without_cost_recorded": "5"},
]

ORDER = {"id": "gid://shopify/Order/7788625494301", "name": "#21678", "createdAt": "2026-09-04T21:40:04Z",
         "updatedAt": "2026-09-10T18:00:00Z", "cancelledAt": None, "test": False, "sourceName": "web",
         "displayFinancialStatus": "REFUNDED", "displayFulfillmentStatus": "FULFILLED", "subtotalLineItemsQuantity": 1,
         "currentSubtotalPriceSet": {"shopMoney": {"amount": "0.0"}}, "totalDiscountsSet": {"shopMoney": {"amount": "0.0"}},
         "totalShippingPriceSet": {"shopMoney": {"amount": "8.0"}}, "totalTaxSet": {"shopMoney": {"amount": "3.1"}},
         "totalPriceSet": {"shopMoney": {"amount": "51.05"}}, "totalRefundedSet": {"shopMoney": {"amount": "43.05"}},
         "currentTotalPriceSet": {"shopMoney": {"amount": "8.0"}},
         "lineItems": {"pageInfo": {"hasNextPage": True, "endCursor": "c1"}, "nodes": [
             {"id": "gid://shopify/LineItem/18780475293981", "title": "Vision II Backpack", "variantTitle": "Black",
              "sku": "15386", "quantity": 1, "currentQuantity": 0, "product": {"id": "gid://shopify/Product/10118248333597"},
              "variant": {"id": "gid://shopify/ProductVariant/51062252273949"},
              "discountedUnitPriceAfterAllDiscountsSet": {"shopMoney": {"amount": "39.95"}}}]}}
MORE = {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": [
    {"id": "gid://shopify/LineItem/2", "title": "Custom restring", "variantTitle": None, "sku": None, "quantity": 1,
     "currentQuantity": 1, "product": None, "variant": None,
     "discountedUnitPriceAfterAllDiscountsSet": {"shopMoney": {"amount": "25.0"}}}]}

VARIANTS = [
    {"id": "gid://shopify/ProductVariant/5", "sku": "HG17", "title": "Default Title", "displayName": "Hyper G Set",
     "price": "13.99", "updatedAt": "2026-09-01T00:00:00Z",
     "product": {"id": "gid://shopify/Product/9", "title": "Hyper G Set", "vendor": "Solinco", "productType": "String", "status": "ACTIVE"},
     "inventoryQuantity": 14, "inventoryItem": {"id": "gid://shopify/InventoryItem/705", "tracked": True, "unitCost": {"amount": "8.5"}}},
    {"id": "gid://shopify/ProductVariant/6", "sku": "", "title": "Black", "displayName": "Bag - Black", "price": "40",
     "updatedAt": None, "product": {"id": "gid://shopify/Product/10", "title": "Bag", "vendor": "", "productType": "", "status": "ACTIVE"},
     "inventoryItem": {"unitCost": None}},
]


class FakeShopify:
    def __init__(self, variants=VARIANTS):
        self.variants = variants
        self.cost_calls = []

    def shopifyql(self, q):
        if "TIMESERIES day" in q:
            return [{"day": "2026-09-10", "orders": "12", "gross_sales": "1000", "discounts": "-50", "sales_reversals": "-39.95",
                     "net_sales": "910.05", "shipping_charges": "40", "taxes": "70", "total_sales": "1020.05",
                     "cost_of_goods_sold": "400", "gross_profit": "510.05", "net_sales_without_cost_recorded": "-14.95"}]
        return SALES_ROWS

    def graphql(self, query, variables=None):
        if query is sh.ORDERS_Q:
            return {"orders": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": [ORDER]}}
        if query is sh.MORE_LINES_Q:
            return {"order": {"lineItems": MORE}}
        if query is sh.COST_UPDATE_M:
            self.cost_calls.append(variables)
            if variables["id"].endswith("/999"):
                return {"inventoryItemUpdate": {"inventoryItem": None, "userErrors": [{"field": ["id"], "message": "Inventory item does not exist"}]}}
            return {"inventoryItemUpdate": {"inventoryItem": {"id": variables["id"], "unitCost": {"amount": variables["input"]["cost"]}}, "userErrors": []}}
        if query is sh.VARIANTS_Q:
            return {"productVariants": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": self.variants}}
        raise AssertionError("unexpected query")


def test_sales_daily_orders_and_catalog(conn):
    shop, day = FakeShopify(), dt.date(2026, 9, 10)
    assert sh.sync_daily(shop, conn, day, day) == 1
    assert sh.sync_sales(shop, conn, day, day) == 3
    assert sh.sync_sales(shop, conn, day, day) == 3            # re-sync replaces, never duplicates
    assert sh.sync_orders(shop, conn, dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc)) == 1
    cur = conn.cursor()
    cur.execute("select units, net, net_no_cost from jt.shopify_sales where order_id = 1")
    assert cur.fetchone() == (D("2.00"), D("25.00"), D("25.00"))
    cur.execute("select order_day, channel, shipping from jt.shopify_orders")
    assert cur.fetchone() == (dt.date(2026, 9, 4), "web", D("8.00"))   # 21:40 UTC = Sep 4 Pacific
    cur.execute("select line_id, variant_id, current_quantity from jt.shopify_order_lines order by line_id")
    assert cur.fetchall() == [(2, None, 1), (18780475293981, 51062252273949, 0)]

    first = sh.sync_catalog(shop, conn, dt.date(2026, 9, 24))
    assert first == {"variants": 2, "changes": 0, "baseline": True, "no_cost": 1, "removed": 0, "restored": 0}
    changed = [dict(VARIANTS[0], inventoryItem={"unitCost": {"amount": "6.83"}}), VARIANTS[1]]
    second = sh.sync_catalog(FakeShopify(changed), conn, dt.date(2026, 9, 25))
    assert second["changes"] == 1
    cur.execute("select changed_on, variant_id, old_cost, new_cost from jt.variant_cost_changes")
    assert cur.fetchone() == (dt.date(2026, 9, 25), 5, D("8.50"), D("6.83"))


def test_cost_watch_docs(conn):
    from sync import cost_watch
    shop, day = FakeShopify(), dt.date(2026, 9, 10)
    sh.sync_sales(shop, conn, day, day)
    sh.sync_catalog(shop, conn, dt.date(2026, 9, 10))                                   # baseline
    changed = [dict(VARIANTS[0], inventoryItem={"unitCost": {"amount": "20"}}), VARIANTS[1]]
    sh.sync_catalog(FakeShopify(changed), conn, dt.date(2026, 9, 11))                   # 8.50 -> 20 (above 13.99 price)
    cur = conn.cursor()
    cur.execute("""insert into jt.docs (collection, id, data) values
                   ('amzmonths', '2026-09', '{"month": "2026-09", "skus": {"A1": [2, 30.5], "B2": [1, 10]}}'),
                   ('amzmap', 's_B2', '{"sku": "B2"}')""")
    out = cost_watch.run(conn, day, dt.date(2026, 9, 11))
    assert out["changes"] == 1 and out["flagged"] == 1 and out["no_cost_variants"] == 1
    cur.execute("select collection, id, data from jt.docs where collection in ('costs', 'costalerts', 'costlog') order by 1, 2")
    docs = {(c, i): d for c, i, d in cur.fetchall()}
    assert set(docs) == {("costalerts", "2026-09-10"), ("costlog", "2026-09-10"), ("costs", "catalog")}
    ch = docs[("costlog", "2026-09-10")]["changes"][0]
    assert (ch["vid"], ch["old"], ch["new"], ch["flag"]) == ("5", 8.5, 20.0, "cost above price")
    al = docs[("costalerts", "2026-09-10")]
    assert al["missingTotal"] == 25.0 and al["missing"][0]["orders"] == ["#1"]      # the two custom items on order #1
    assert al["amazon"] == {"month": "2026-09", "unmappedSkus": 1, "unmappedSales": 30.5, "top": [["A1", 2, 30.5]]}
    cat = docs[("costs", "catalog")]
    assert cat["noCostCount"] == 1 and cat["abovePriceCount"] == 1 and cat["abovePrice"][0]["vid"] == "5"


def test_catalog_inventory_and_cost_updates(conn):
    shop = FakeShopify()
    sh.sync_catalog(shop, conn, dt.date(2026, 9, 24))
    cur = conn.cursor()
    cur.execute("select variant_id, inventory_item_id, inventory_qty, tracked from jt.variants order by variant_id")
    assert cur.fetchall() == [(5, 705, 14, True), (6, None, None, None)]
    cur.execute("insert into jt.variants (variant_id, product_id, inventory_item_id, unit_cost) values (7, 11, 999, 1)")
    cur.execute("""select jt.queue_cost_updates('[{"variant_id": 5, "cost": 9.99}, {"variant_id": 6, "cost": 3},
                                                  {"variant_id": 7, "cost": 2}, {"variant_id": 404, "cost": 1}]')""")
    assert cur.fetchone()[0] == 3                                                # unknown variant 404 is skipped
    cur.execute("""select jt.queue_cost_updates('[{"variant_id": 5, "cost": 9.5}]')""")   # newer request wins
    conn.commit()
    assert sh.apply_cost_updates(shop, conn, dt.date(2026, 9, 25)) == 1
    assert shop.cost_calls == [{"id": "gid://shopify/InventoryItem/999", "input": {"cost": "2.00"}},   # queue order
                               {"id": "gid://shopify/InventoryItem/705", "input": {"cost": "9.50"}}]
    cur.execute("select variant_id, new_cost, status, left(error, 20) from jt.cost_updates order by id")
    assert cur.fetchall() == [(5, D("9.99"), "replaced", ""), (6, D("3.00"), "failed", "no Shopify inventory"),
                              (7, D("2.00"), "failed", "Inventory item does "), (5, D("9.50"), "done", "")]
    cur.execute("select unit_cost from jt.variants where variant_id = 5")
    assert cur.fetchone()[0] == D("9.50")
    cur.execute("select old_cost, new_cost, flag from jt.variant_cost_changes where variant_id = 5 and changed_on = '2026-09-25'")
    assert cur.fetchone() == (D("8.50"), D("9.50"), "set in dashboard")


def test_catalog_marks_removed_variants(conn):
    many = [dict(VARIANTS[0], id=f"gid://shopify/ProductVariant/{100 + i}") for i in range(10)]
    sh.sync_catalog(FakeShopify(many), conn, dt.date(2026, 9, 24))
    out = sh.sync_catalog(FakeShopify(many[:8]), conn, dt.date(2026, 9, 25))           # two deleted in Shopify
    assert (out["removed"], out["restored"]) == (2, 0)
    cur = conn.cursor()
    cur.execute("select variant_id from jt.variants where removed_at is not null order by 1")
    assert cur.fetchall() == [(108,), (109,)]
    out = sh.sync_catalog(FakeShopify(many[:9]), conn, dt.date(2026, 9, 26))           # one came back
    assert (out["removed"], out["restored"]) == (0, 1)
    out = sh.sync_catalog(FakeShopify(many[:2]), conn, dt.date(2026, 9, 27))           # partial fetch: remove nothing
    assert out["removed"] == 0
    cur.execute("select count(*) from jt.variants where removed_at is not null")
    assert cur.fetchone()[0] == 1
