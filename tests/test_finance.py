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
