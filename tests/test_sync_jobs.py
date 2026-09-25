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
     "inventoryItem": {"unitCost": {"amount": "8.5"}}},
    {"id": "gid://shopify/ProductVariant/6", "sku": "", "title": "Black", "displayName": "Bag - Black", "price": "40",
     "updatedAt": None, "product": {"id": "gid://shopify/Product/10", "title": "Bag", "vendor": "", "productType": "", "status": "ACTIVE"},
     "inventoryItem": {"unitCost": None}},
]


class FakeShopify:
    def __init__(self, variants=VARIANTS):
        self.variants = variants

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
    assert first == {"variants": 2, "changes": 0, "baseline": True, "no_cost": 1}
    changed = [dict(VARIANTS[0], inventoryItem={"unitCost": {"amount": "6.83"}}), VARIANTS[1]]
    second = sh.sync_catalog(FakeShopify(changed), conn, dt.date(2026, 9, 25))
    assert second["changes"] == 1
    cur.execute("select changed_on, variant_id, old_cost, new_cost from jt.variant_cost_changes")
    assert cur.fetchone() == (dt.date(2026, 9, 25), 5, D("8.50"), D("6.83"))
