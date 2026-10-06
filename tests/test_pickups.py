"""In-store pickup orders (migration 096): the sync marks them from Shopify's delivery_method:pick-up search."""
from sync import shopify


class FakeShop:
    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def graphql(self, q, v=None, **kw):
        self.calls.append(v)
        return {"orders": self.pages[len(self.calls) - 1]}


def test_pickups_marked(conn):
    cur = conn.cursor()
    for i in (1, 2, 3):
        cur.execute("insert into jt.shopify_orders (order_id, name, created_at, order_day) values (%s, %s, now(), current_date)", (i, f"#{i}"))
    shop = FakeShop([{"nodes": [{"id": "gid://shopify/Order/1"}], "pageInfo": {"hasNextPage": True, "endCursor": "c"}},
                     {"nodes": [{"id": "gid://shopify/Order/3"}], "pageInfo": {"hasNextPage": False, "endCursor": None}}])
    assert shopify.sync_pickups(shop, conn) == 2
    assert "delivery_method:pick-up updated_at:>='2025-01-01" in shop.calls[0]["q"]
    cur.execute("select order_id from jt.shopify_orders where pickup order by 1")
    assert [r[0] for r in cur.fetchall()] == [1, 3]
    shop2 = FakeShop([{"nodes": [], "pageInfo": {"hasNextPage": False}}])
    shopify.sync_pickups(shop2, conn)
    assert "2025-01-01" not in shop2.calls[0]["q"]          # later runs: the last 3 days
