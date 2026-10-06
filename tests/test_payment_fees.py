"""Shopify Payments fees (migration 094): balance transactions land in jt.shopify_payment_tx, count on the order's
day, and come off the channel's profit."""
from sync import shopify


class FakeShop:
    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def graphql(self, q, v=None, **kw):
        self.calls.append(v)
        return {"shopifyPaymentsAccount": {"balanceTransactions": self.pages[len(self.calls) - 1]}}


def node(i, typ, amount, fee, order=None, when="2026-10-02T03:00:00Z", test=False):
    return {"id": f"gid://shopify/ShopifyPaymentsBalanceTransaction/{i}", "type": typ, "test": test, "transactionDate": when,
            "sourceType": typ.lower(), "amount": {"amount": str(amount), "currencyCode": "USD"}, "fee": {"amount": str(fee)},
            "net": {"amount": str(amount - fee)}, "associatedOrder": {"id": f"gid://shopify/Order/{order}", "name": f"#{order}"} if order else None}


def test_fees_sync_and_channel_profit(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.shopify_orders (order_id, name, created_at, order_day) values (7, '#7', now(), '2026-10-01')")
    cur.execute("insert into jt.shopify_daily (day, net, cogs, gross_profit, net_no_cost, shipping) values ('2026-10-01', 100, 40, 60, 0, 10)")
    shop = FakeShop([
        {"nodes": [node(1, "CHARGE", 110, 3.49, order=7), node(2, "CHARGE", 50, 1.75, test=True)], "pageInfo": {"hasNextPage": True, "endCursor": "c1"}},
        {"nodes": [node(3, "DISPUTE_WITHDRAWAL", -20, 15, when="2026-10-03T20:00:00Z")], "pageInfo": {"hasNextPage": False, "endCursor": "c2"}},
    ])
    assert shopify.sync_payment_fees(shop, conn, "justtennis") == 3
    assert shop.calls[0]["q"] == "processed_at:>=2025-01-01" and shop.calls[1]["after"] == "c1"
    cur.execute("select day, fee from jt.v_shopify_payment_fees order by day")
    assert [(str(d), float(f)) for d, f in cur.fetchall()] == [("2026-10-01", 3.49), ("2026-10-03", 15)]   # test charge left out
    cur.execute("select pay_fees, profit from jt.v_sales_channels_daily where channel = 'justtennis' and day = '2026-10-01'")
    assert tuple(map(float, cur.fetchone())) == (3.49, 60 + 10 - 3.49)
    # next run starts a week before the newest transaction
    shop2 = FakeShop([{"nodes": [], "pageInfo": {"hasNextPage": False}}])
    assert shopify.sync_payment_fees(shop2, conn, "justtennis") == 0
    assert shop2.calls[0]["q"] == "processed_at:>=2026-09-26"


def test_fees_scope_missing_is_skipped(conn):
    class Denied:
        def graphql(self, *a, **k):
            raise RuntimeError("Shopify GraphQL error: Access denied for shopifyPaymentsAccount field.")
    assert "skipped" in shopify.sync_payment_fees(Denied(), conn, "acenrally")
