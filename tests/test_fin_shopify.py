"""Finance › Shopify payouts (migration 118): balance transactions tagged with their payout, one simple journal entry per
payout (sales / shipping / tax / refunds / fees / … / bank) plus cost of goods."""
import json
from sync import shopify
from tests.test_payment_fees import FakeShop, node


def entry(cur, pid):
    cur.execute("select fin.shop_entry(%s)", (pid,))
    return cur.fetchone()[0]


def test_payout_entry(conn):
    cur = conn.cursor()
    # order 7: 100 of goods after discounts + 10 shipping + 8.80 tax = 118.80; order 8: 50 (no tax, no shipping)
    cur.execute("""insert into jt.shopify_orders (order_id, name, created_at, order_day, subtotal, shipping, tax, total)
                   values (7, '#7', now(), '2026-10-01', 100, 10, 8.80, 118.80), (8, '#8', now(), '2026-10-01', 50, 0, 0, 50)""")
    P = "gid://shopify/ShopifyPaymentsPayout/147136413981"
    nodes = [node(1, "CHARGE", 118.80, 3.75, order=7), node(2, "CHARGE", 50, 1.75, order=8),
             node(3, "REFUND", -59.40, 0, order=7), node(4, "TAX_ADJUSTMENT_DEBIT", -1.20, 0), node(5, "DISPUTE_WITHDRAWAL", -20, 15),
             node(6, "CHARGE", 30, 1.17, order=8)]
    for n in nodes[:5]:
        n["associatedPayout"] = {"id": P}
    shop = FakeShop([{"nodes": nodes, "pageInfo": {"hasNextPage": False}}])
    assert shopify.sync_payment_fees(shop, conn, "justtennis") == 6
    net = round(118.80 - 3.75 + 50 - 1.75 - 59.40 - 1.20 - 20 - 15, 2)   # 67.70
    cur.execute("insert into fin.shopify_payouts (id, issued_at, status, amount) values ('147136413981', '2026-10-05T00:00:00Z', 'PAID', %s)", (net,))
    e = entry(cur, "147136413981")
    assert e["problems"] == []
    main = e["parts"][0]
    assert main["doc"] == "SSPSH-05Oct-981" and main["date"] == "2026-10-05" and main["kind"] == "main"
    acct = {}
    for l in main["lines"]:
        acct[l["account"]] = round(acct.get(l["account"], 0) + float(l["amount"]), 2)
    assert acct == {"Shopify Sales": -150.0, "Shopify Sales:Shopify Shipping": -10.0, "Shopify Sales Tax Collected": round(-8.80 + 4.40 + 1.20, 2),
                    "Shopify Sales:Shopify Refunds": 55.0, "Cost of goods sold:Shopify Fees": round(3.75 + 1.75 + 15 + 20, 2), "BofA (0364)": net}
    assert round(sum(float(l["amount"]) for l in main["lines"]), 2) == 0
    cur.execute("select sales, shipping, tax, refunds, fees, other, net, orders from fin.v_shop_payouts where id = '147136413981'")
    assert tuple(map(float, cur.fetchone())) == (150.0, 10.0, 3.2, -55.0, -20.5, -20.0, net, 2)
    # a payout whose transactions don't add up is flagged; posting is remembered by number
    cur.execute("update fin.shopify_payouts set amount = 70 where id = '147136413981'")
    assert any(p["kind"] == "total" for p in entry(cur, "147136413981")["problems"])
    cur.execute("select public.fin_shop_posted(%s::jsonb)", (json.dumps({"payout_id": "147136413981", "doc": "SSPSH-05Oct-981", "id": "55", "by": "b"}),))
    assert entry(cur, "147136413981")["parts"][0]["posted"]["id"] == "55"


def test_a2x_cutover(conn):
    """Orders A2X already booked (on or before a2x_until) aren't sales again: their payments clear Shopify Pending Balances."""
    cur = conn.cursor()
    cur.execute("""insert into jt.shopify_orders (order_id, name, created_at, order_day, subtotal, shipping, tax, total)
                   values (7, '#7', now(), '2026-09-26', 100, 10, 8.80, 118.80), (8, '#8', now(), '2026-09-29', 50, 0, 0, 50)""")
    P = "gid://shopify/ShopifyPaymentsPayout/147136413981"
    nodes = [node(1, "CHARGE", 118.80, 3.75, order=7, when="2026-09-28T18:00:00Z"), node(2, "CHARGE", 50, 1.75, order=8, when="2026-09-29T18:00:00Z"),
             node(3, "REFUND", -10, 0, order=8, when="2026-09-27T18:00:00Z")]
    for n in nodes:
        n["associatedPayout"] = {"id": P}
    assert shopify.sync_payment_fees(FakeShop([{"nodes": nodes, "pageInfo": {"hasNextPage": False}}]), conn, "justtennis") == 3
    net = round(118.80 - 3.75 + 50 - 1.75 - 10, 2)
    cur.execute("insert into fin.shopify_payouts (id, issued_at, status, amount) values ('147136413981', '2026-10-05T00:00:00Z', 'PAID', %s)", (net,))
    e = entry(cur, "147136413981")
    assert e["problems"] == []
    acct = {}
    for l in e["parts"][0]["lines"]:
        acct[l["account"]] = round(acct.get(l["account"], 0) + float(l["amount"]), 2)
    # order 7 (Sep 26) and the Sep 27 refund were A2X's; only order 8 is a sale
    assert acct == {"Shopify Sales": -50.0, "Shopify Pending Balances": round(-118.80 + 10, 2), "Cost of goods sold:Shopify Fees": 5.5, "BofA (0364)": net}
    cur.execute("select orders, sales, a2x_pending, a2x_tx from fin.v_shop_payouts where id = '147136413981'")
    assert tuple(map(float, cur.fetchone())) == (1, 50.0, 108.8, 2)
