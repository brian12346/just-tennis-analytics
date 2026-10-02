"""Finance dashboard: separate allow-list, payables save from QuickBooks, bill status/aging."""
import json

import pytest

BRIAN = "11111111-1111-1111-1111-111111111111"
SALES_ONLY = "22222222-2222-2222-2222-222222222222"


def as_user(cur, uid):
    cur.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": uid}),))


def test_payables_save_and_access(conn):
    cur = conn.cursor()
    cur.execute("insert into fin.users (user_id, email) values (%s, 'b@x.com')", (BRIAN,))
    cur.execute("insert into jt.app_users (user_id, email) values (%s, 's@x.com')", (SALES_ONLY,))
    p = {"vendors": [{"id": "12", "name": "Wilson", "balance": 150}],
         "bills": [{"id": "1", "vendor_id": "12", "vendor_name": "Wilson", "doc": "A1", "date": "2026-01-01", "due": "2026-01-31", "total": 100, "balance": 100},
                   {"id": "2", "vendor_id": "12", "vendor_name": "Wilson", "doc": "A2", "date": "2026-09-01", "due": "2099-01-01", "total": 50, "balance": 50},
                   {"id": "3", "vendor_id": "12", "vendor_name": "Wilson", "doc": "A3", "date": "2026-01-01", "due": "2026-01-31", "total": 70, "balance": 0}],
         "payments": [{"id": "9", "vendor_id": "12", "vendor_name": "Wilson", "date": "2026-02-01", "total": 70, "pay_type": "Check", "bills": [{"bill_id": "3", "amount": 70}]}]}
    cur.execute("select public.fin_qbo_payables_save(%s::jsonb)", (json.dumps(p),))
    assert cur.fetchone()[0] == 5
    cur.execute("select id, status, aging from fin.v_bills order by id")
    assert cur.fetchall() == [("1", "overdue", "90+"), ("2", "open", "current"), ("3", "paid", None)]
    # a full pass that no longer sees bill 2: zeroed, not removed
    cur.execute("select now()")
    started = cur.fetchone()[0]
    cur.execute("update fin.qbo_bills set synced_at = now() - interval '1 hour' where id = '2'")
    cur.execute("select public.fin_qbo_payables_save(%s::jsonb)", (json.dumps({"finished": {"full": True, "started": started.isoformat()}}),))
    cur.execute("select balance, memo from fin.qbo_bills where id = '2'")
    assert cur.fetchone() == (0, "[deleted in QuickBooks] ")
    # finance list only: the sales dashboard's user can't read finance, and the finance user is let in
    cur.execute("savepoint s")
    cur.execute("set local role authenticated")
    as_user(cur, SALES_ONLY)
    with pytest.raises(Exception, match="not allowed"):
        cur.execute("select public.fin_sql('select count(*) from fin.qbo_bills')")
    cur.execute("rollback to savepoint s")
    cur.execute("set local role authenticated")
    as_user(cur, BRIAN)
    cur.execute("select public.fin_sql('select count(*) n from fin.v_bills')")
    assert cur.fetchone()[0] == [{"n": 3}]
    cur.execute("select public.fin_whoami()")
    assert cur.fetchone()[0] == {"allowed": True}
    cur.execute("reset role")


def test_sales_reader_cannot_read_finance(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.app_users (user_id, email) values (%s, 's@x.com')", (SALES_ONLY,))
    cur.execute("set local role authenticated")
    as_user(cur, SALES_ONLY)
    with pytest.raises(Exception, match="permission denied"):
        cur.execute("select public.jt_sql('select count(*) from fin.qbo_bills')")


class PayoutShop:
    def __init__(self, denied=False):
        self.denied = denied

    def graphql(self, q, v=None, version=None):
        if self.denied:
            raise RuntimeError("Shopify GraphQL error: Access denied for payouts field. Required access: `read_shopify_payments_payouts` access scope.")
        return {"shopifyPaymentsAccount": {"payouts": {"nodes": [
            {"id": "gid://shopify/ShopifyPaymentsPayout/5", "issuedAt": "2026-09-28T07:00:00Z", "status": "PAID", "net": {"amount": "31234.50", "currencyCode": "USD"}},
            {"id": "gid://shopify/ShopifyPaymentsPayout/4", "issuedAt": "2026-09-21T07:00:00Z", "status": "PAID", "net": {"amount": "29000.00", "currencyCode": "USD"}}],
            "pageInfo": {"hasNextPage": False, "endCursor": None}}}}


def test_shopify_payouts_sync(conn):
    from sync import shopify as sh
    assert sh.sync_shopify_payouts(PayoutShop(denied=True), conn) == 0
    assert sh.sync_shopify_payouts(PayoutShop(), conn) == 2
    cur = conn.cursor()
    cur.execute("select id, amount, status from fin.shopify_payouts order by id")
    assert cur.fetchall() == [("4", 29000, "PAID"), ("5", 31234.5, "PAID")]


def test_forecast_set(conn):
    cur = conn.cursor()
    q = lambda p: (cur.execute("select fin.forecast_set(%s::jsonb)", (json.dumps(p),)), cur.fetchone()[0])[1]
    q({"op": "set", "stream": "shopify", "expected_on": "2026-10-05", "amount": 25000})
    q({"op": "set", "stream": "shopify", "expected_on": "2026-10-05", "amount": 27000})
    r = q({"op": "add", "kind": "other_out", "expected_on": "2026-10-15", "amount": -5000, "note": "Payroll"})
    q({"op": "set", "stream": "shopify", "expected_on": "2026-10-05", "amount": None})
    q({"op": "remove", "id": r["id"]})
    cur.execute("select kind, amount, active from fin.forecast order by id")
    assert cur.fetchall() == [("payout", 27000, False), ("other_out", 5000, False)]
    cur.execute("select fin.settings_set('{\"key\": \"cash\", \"value\": {\"balance\": 120000, \"as_of\": \"2026-10-02\"}}')")
    assert cur.fetchone()[0] == {"balance": 120000, "as_of": "2026-10-02"}


def test_accounts_save_marks_missing_inactive(conn):
    cur = conn.cursor()
    acc = lambda *xs: json.dumps({"accounts": [{"id": i, "name": n, "type": "Bank", "subtype": "Checking", "balance": b} for i, n, b in xs]})
    cur.execute("select public.fin_qbo_accounts_save(%s::jsonb)", (acc(("1", "BofA", 100.5), ("2", "Chase", 20)),))
    cur.execute("select public.fin_qbo_accounts_save(%s::jsonb)", (acc(("1", "BofA", 150),),))
    cur.execute("select id, balance, active from fin.qbo_accounts order by id")
    assert cur.fetchall() == [("1", 150, True), ("2", 20, False)]
