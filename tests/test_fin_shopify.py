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


def test_other_payments_week(conn):
    """Manual / cash / PayPal payments: synced from Shopify, booked a week at a time against each gateway's clearing
    account; QuickBooks deposits on that account clear it; orders still owing are listed."""
    cur = conn.cursor()
    cur.execute("""insert into jt.shopify_orders (order_id, name, created_at, order_day, subtotal, shipping, tax, total)
                   values (21, '#21', now(), '2026-09-20', 1000, 0, 0, 1000), (22, '#22', now(), '2026-10-06', 90, 0, 9, 99),
                          (23, '#23', now(), '2026-10-07', 200, 20, 0, 220)""")

    def o(oid, name, status, total, outstanding, txs, gws):
        return {"id": f"gid://shopify/Order/{oid}", "name": name, "createdAt": "2026-10-06T18:00:00Z", "sourceName": "shopify_draft_order",
                "displayFinancialStatus": status, "test": False, "cancelledAt": None, "paymentGatewayNames": gws,
                "totalPriceSet": {"shopMoney": {"amount": str(total)}}, "totalOutstandingSet": {"shopMoney": {"amount": str(outstanding)}},
                "transactions": [{"id": f"gid://shopify/OrderTransaction/{i}", "kind": k, "status": "SUCCESS", "gateway": g, "test": False,
                                  "processedAt": when, "amountSet": {"shopMoney": {"amount": str(a)}}} for i, k, g, a, when in txs]}
    nodes = [
        o(21, "#21", "PAID", 1000, 0, [(1, "SALE", "manual", 1000, "2026-10-06T20:00:00Z")], ["manual"]),            # A2X booked the order (Sep 20)
        o(22, "#22", "PAID", 99, 0, [(2, "SALE", "cash", 99, "2026-10-06T21:00:00Z")], ["cash"]),
        o(23, "#23", "PARTIALLY_PAID", 220, 120, [(3, "SALE", "manual", 100, "2026-10-08T21:00:00Z"),
                                                  (4, "AUTHORIZATION", "shopify_payments", 5, "2026-10-08T21:00:00Z")], ["manual"]),
    ]

    class Shop:
        calls = []

        def graphql(self, q, v=None, **kw):
            self.calls.append(v)
            return {"orders": {"nodes": nodes, "pageInfo": {"hasNextPage": False}}}
    assert shopify.sync_order_payments(Shop(), conn, "justtennis") == 3
    cur.execute("select count(*) from jt.shopify_order_payments")
    assert cur.fetchone()[0] == 3                       # the authorization isn't a payment
    cur.execute("select fin.shop_pay_entry('2026-10-11')")
    e = cur.fetchone()[0]
    acct = {}
    for l in e["parts"][0]["lines"]:
        acct[l["account"]] = round(acct.get(l["account"], 0) + float(l["amount"]), 2)
    assert e["parts"][0]["doc"] == "SSPSH-11Oct-PAY"
    assert acct == {"Manual Clearing Account - Shopify": 1100.0, "Cash:Cash Clearing - Shopify": 99.0, "Shopify Pending Balances": -1000.0,
                    "Shopify Sales": -180.91,
                    "Shopify Sales:Shopify Shipping": -9.09, "Shopify Sales Tax Collected": -9.0}
    assert round(sum(acct.values()), 2) == 0
    # a deposit categorized to the manual clearing account in QuickBooks clears it
    cur.execute("select public.fin_qbo_clearing_save(%s::jsonb)", (json.dumps({"from": "2026-09-28", "to": "2026-10-11", "rows": [
        {"txn_type": "Deposit", "txn_id": "9", "line_id": "1", "account": "Manual Clearing Account - Shopify", "date": "2026-10-09", "amount": -1000, "doc": "", "memo": "check 1182"}],
        "balances": [{"account": "Manual Clearing Account - Shopify", "balance": 100}]}),))
    cur.execute("select paid, deposited, open_balance, qbo_balance from fin.v_shop_clearing where account = 'Manual Clearing Account - Shopify'")
    assert tuple(map(float, cur.fetchone())) == (1100.0, -1000.0, 100.0, 100.0)
    cur.execute("select name, outstanding from fin.v_shop_due")
    assert [(n, float(a)) for n, a in cur.fetchall()] == [("#23", 120.0)]


def test_paypal_fees_and_check(conn):
    """PayPal's activity download: fees booked a week at a time; the Paypal Clearing Account checked against PayPal's balance."""
    cur = conn.cursor()
    cur.execute("insert into fin.users (user_id, email) values ('11111111-1111-1111-1111-111111111111', 'b@x.com') on conflict do nothing")
    cur.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": "11111111-1111-1111-1111-111111111111", "email": "b@x.com"}),))
    cur.execute("""insert into jt.shopify_orders (order_id, name, created_at, order_day, subtotal, shipping, tax, total)
                   values (31, '#31', now(), '2026-10-06', 100, 0, 0, 100), (32, '#32', now(), '2026-10-07', 50, 0, 0, 50)""")
    cur.execute("""insert into jt.shopify_order_payments (store, id, order_id, kind, gateway, amount, processed_at)
                   values ('justtennis', 1, 31, 'CAPTURE', 'paypal', 100, '2026-10-06T18:00:00Z'), ('justtennis', 2, 32, 'CAPTURE', 'paypal', 50, '2026-10-07T18:00:00Z')""")
    R = lambda i, day, typ, gross, fee, bal, impact="Credit": {"txn_id": i, "at": day + "T12:00:00-07:00", "day": day, "type": typ, "status": "Completed",
                                                            "gross": gross, "fee": fee, "net": round(gross + fee, 2), "balance": bal, "impact": impact}
    rows = [R("A", "2026-10-06", "Express Checkout Payment", 100, -3.98, 96.02), R("B", "2026-10-08", "Express Checkout Payment", 75, -2.98, 168.04),
            R("H", "2026-10-08", "Authorization", 75, 0, None, "Memo"), R("W", "2026-10-09", "General Withdrawal - Bank Account", -150, 0, 18.04, "Debit")]
    cur.execute("select public.fin_paypal_save(%s::jsonb)", (json.dumps({"file": "pp.csv", "rows": rows}),))
    assert cur.fetchone()[0] == 4
    cur.execute("select fin.paypal_fee_entry('2026-10-31')")
    e = cur.fetchone()[0]
    assert {l["account"]: float(l["amount"]) for l in e["parts"][0]["lines"]} == {"Cost of goods sold:PayPal Fees": 6.96, "Paypal Clearing Account": -6.96}
    assert e["parts"][0]["doc"] == "SSPPP-31Oct-FEE" and e["parts"][0]["date"] == "2026-10-31"
    cur.execute("select status, amount from fin.v_paypal_match order by amount")
    assert [(s, float(a)) for s, a in cur.fetchall()] == [("shopify_only", 50.0), ("paypal_only", 75.0), ("matched", 100.0)]
    cur.execute("select public.fin_qbo_clearing_save(%s::jsonb)", (json.dumps({"from": "2026-10-01", "to": "2026-10-11", "rows": [
        {"txn_type": "Deposit", "txn_id": "7", "line_id": "1", "account": "Paypal Clearing Account", "date": "2026-10-10", "amount": -150}],
        "balances": [{"account": "Paypal Clearing Account", "balance": 25}]}),))
    cur.execute("""select paypal_balance, qbo_balance, difference, qb_sales, pp_sales, sales_unposted, qb_fees, pp_fees, qb_to_bank, pp_to_bank,
                          paypal_only, shopify_only from fin.v_paypal_check""")
    assert tuple(map(float, cur.fetchone())) == (18.04, 25.0, 6.96, 0, 175.0, 150.0, 0, -6.96, -150.0, -150.0, 1, 1)
