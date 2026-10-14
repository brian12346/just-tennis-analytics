"""Finance › credit cards (migration 127): statement close / due days, the day a charge is paid, and each open bill's
payment method and the day its cash goes out."""
import datetime as dt
import json

import pytest

U = "11111111-1111-1111-1111-111111111111"


def pay_date(cur, close, due, d):
    cur.execute("select fin.card_pay_date(%s, %s, %s::date)", (close, due, d))
    return str(cur.fetchone()[0])


@pytest.mark.parametrize("close,due,charge,paid", [
    (7, 2, "2026-10-05", "2026-11-02"),    # before the close: this month's statement, due early next month
    (7, 2, "2026-10-07", "2026-11-02"),    # on the close day: still this statement
    (7, 2, "2026-10-08", "2026-12-02"),    # after the close: next statement
    (20, 15, "2026-10-12", "2026-11-15"),
    (3, 28, "2026-10-01", "2026-10-28"),   # due later the same month as the close
    (3, 28, "2026-10-04", "2026-11-28"),
    (31, 25, "2026-02-27", "2026-03-25"),  # 31 = the month's last day (Feb 28)
    (31, 25, "2026-09-30", "2026-10-25"),
])
def test_card_pay_date(conn, close, due, charge, paid):
    assert pay_date(conn.cursor(), close, due, charge) == paid


def test_bill_methods_and_cards(conn):
    cur = conn.cursor()
    cur.execute("insert into fin.users (user_id, email) values (%s, 'b@x.com') on conflict do nothing", (U,))
    cur.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": U, "email": "b@x.com"}),))
    cur.execute("""insert into fin.qbo_accounts (id, name, type, subtype, balance) values
                   ('10', 'JT - Amex Platinum', 'Credit Card', 'CreditCard', -5000), ('20', 'BofA (0140)', 'Bank', 'Checking', 90000),
                   ('30', 'Chase Charge Card (4715)', 'Credit Card', 'CreditCard', -100), ('40', 'Inventory', 'Other Current Asset', '', 0)""")
    cur.execute("select (now() at time zone 'America/Los_Angeles')::date")   # the views' "today" is Pacific, not the runner's
    today = cur.fetchone()[0]
    later = today + dt.timedelta(days=20)
    cur.execute("""insert into fin.qbo_bills (id, vendor_name, due_date, total, balance) values
                   ('b1', 'Wilson', %s, 500, 500), ('b2', 'Babolat', %s, 300, 300), ('b3', 'Yonex', %s, 200, 200), ('b4', 'Head', null, 50, 50)""",
                (later, today - dt.timedelta(days=3), later))
    # methods: Amex for b1, b2; the bank for b3; Chase (no terms yet) for b4
    cur.execute("select public.fin_bill_method_set(%s::jsonb)", (json.dumps({"bill_ids": ["b1", "b2"], "account_id": "10"}),))
    assert cur.fetchone()[0] == 2
    cur.execute("select public.fin_bill_method_set(%s::jsonb)", (json.dumps({"bill_ids": ["b3"], "account_id": "20"}),))
    cur.execute("select public.fin_bill_method_set(%s::jsonb)", (json.dumps({"bill_ids": ["b4"], "account_id": "30"}),))
    with pytest.raises(Exception):
        cur.execute("savepoint s")
        cur.execute("select public.fin_bill_method_set(%s::jsonb)", (json.dumps({"bill_ids": ["b4"], "account_id": "40"}),))
    cur.execute("rollback to savepoint s")
    cur.execute("select public.fin_card_terms_set(%s::jsonb)", (json.dumps({"account_id": "10", "close_day": 7, "due_day": 2}),))
    cur.execute("select bill_id, account_name, pay_on, cash_on, card_needs_terms from fin.v_bill_plan order by bill_id")
    rows = {r[0]: r[1:] for r in cur.fetchall()}
    cur.execute("select fin.card_pay_date(7, 2, %s::date), fin.card_pay_date(7, 2, %s::date)", (later, today))
    amex_later, amex_today = cur.fetchone()
    assert rows["b1"] == ("JT - Amex Platinum", later, amex_later, False)
    assert rows["b2"] == ("JT - Amex Platinum", today, amex_today, False)      # overdue: charged today
    assert rows["b3"] == ("BofA (0140)", later, later, False)
    assert rows["b4"] == ("Chase Charge Card (4715)", today, today, True)      # no due date, card without terms
    # the card: owed (QuickBooks keeps it negative), when the balance is due
    cur.execute("select owed, close_day, due_day, balance_due_on, next_close from fin.v_cards where account_id = '10'")
    owed, c, d, due_on, next_close = cur.fetchone()
    assert (float(owed), c, d) == (5000.0, 7, 2)
    assert due_on >= today and next_close > today
    # clearing a method; removing a card's terms
    cur.execute("select public.fin_bill_method_set(%s::jsonb)", (json.dumps({"bill_ids": ["b3"], "account_id": ""}),))
    cur.execute("select account_id from fin.v_bill_plan where bill_id = 'b3'")
    assert cur.fetchone()[0] is None
    cur.execute("select public.fin_card_terms_set(%s::jsonb)", (json.dumps({"account_id": "10", "close_day": None}),))
    cur.execute("select close_day from fin.v_cards where account_id = '10'")
    assert cur.fetchone()[0] is None


def test_bill_submitted(conn):
    """Payables › Payment submitted (migration 133): mark, re-mark, clear; only finance users."""
    cur = conn.cursor()
    cur.execute("insert into fin.users (user_id, email) values (%s, 'b@x.com') on conflict do nothing", (U,))
    cur.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": U, "email": "b@x.com"}),))
    cur.execute("select public.fin_bill_submitted_set(%s::jsonb)", (json.dumps({"bill_ids": ["b1", "b2"], "note": "check 1043"}),))
    assert cur.fetchone()[0] == 2
    cur.execute("select bill_id, note, submitted_by, submitted_on = (now() at time zone 'America/Los_Angeles')::date from fin.bill_submitted order by 1")
    assert cur.fetchall() == [("b1", "check 1043", "b@x.com", True), ("b2", "check 1043", "b@x.com", True)]
    cur.execute("select public.fin_bill_submitted_set(%s::jsonb)", (json.dumps({"bill_ids": ["b2"], "submitted_on": "2026-10-01", "note": "ACH"}),))
    cur.execute("select submitted_on::text, note from fin.bill_submitted where bill_id = 'b2'")
    assert cur.fetchone() == ("2026-10-01", "ACH")
    cur.execute("select public.fin_bill_submitted_set(%s::jsonb)", (json.dumps({"bill_ids": ["b1"], "clear": True}),))
    assert cur.fetchone()[0] == 1
    cur.execute("select array_agg(bill_id) from fin.bill_submitted")
    assert cur.fetchone()[0] == ["b2"]
    cur.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": "22222222-2222-2222-2222-222222222222"}),))
    with pytest.raises(Exception, match="not allowed"):
        cur.execute("select public.fin_bill_submitted_set(%s::jsonb)", (json.dumps({"bill_ids": ["b3"]}),))
