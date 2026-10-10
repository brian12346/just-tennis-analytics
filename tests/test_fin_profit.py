"""Finance › Profit: QuickBooks P&L by month, account defaults and rules, expenses by group."""
import json

import pytest

BRIAN = "11111111-1111-1111-1111-111111111111"


def save(cur, rows, start="2025-01-01", end="2025-02-28"):
    cur.execute("select public.fin_qbo_pl_save(%s::jsonb)", (json.dumps({"start": start, "end": end, "rows": rows}),))
    return cur.fetchone()[0]


def test_pl_save_defaults_rules(conn):
    cur = conn.cursor()
    rows = [
        {"section": "Income", "key": "1", "account": "Sales", "month": "2025-01-01", "amount": 1000},
        {"section": "COGS", "key": "2", "account": "Cost of goods sold", "month": "2025-01-01", "amount": 400},
        {"section": "COGS", "key": "3", "account": "Tariffs", "month": "2025-01-01", "amount": 50},
        {"section": "Expenses", "key": "4", "account": "Wages", "parent": "Payroll expenses", "month": "2025-01-01", "amount": 300},
        {"section": "Expenses", "key": "4", "account": "Wages", "parent": "Payroll expenses", "month": "2025-02-01", "amount": 310},
        {"section": "Expenses", "key": "5", "account": "Amazon Advertising", "parent": "Advertising & marketing", "month": "2025-01-01", "amount": 80},
        {"section": "Expenses", "key": "6", "account": "Building & land rent", "parent": "Rent", "month": "2025-01-01", "amount": 120},
        {"section": "OtherIncome", "key": "7", "account": "Interest earned", "month": "2025-01-01", "amount": 5},
    ]
    assert save(cur, rows) == 8
    cur.execute("select account_key, include, grp from fin.pl_account_class order by account_key")
    assert cur.fetchall() == [("1", False, "In dashboard profit"), ("2", False, "In dashboard profit"), ("3", False, "In dashboard profit"),
                              ("4", True, "Payroll"), ("5", False, "Advertising"), ("6", False, "Rent & facilities"), ("7", False, "Other income")]
    # only payroll is counted until other costs are switched on
    cur.execute("select month::text, sum(amount) from fin.v_pl_expenses group by 1 order by 1")
    assert [(m, float(v)) for m, v in cur.fetchall()] == [("2025-01-01", 300.0), ("2025-02-01", 310.0)]

    # a rule from the page: tariffs count as an expense
    cur.execute("insert into fin.users (user_id, email) values (%s, 'b@x.com')", (BRIAN,))
    cur.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": BRIAN, "email": "b@x.com"}),))
    cur.execute("select public.fin_pl_rule_set('{\"account_key\":\"3\",\"include\":true,\"grp\":\"Landed costs\"}')")
    cur.execute("select include, grp, rule_by from fin.pl_account_class where account_key = '3'")
    assert cur.fetchone() == (True, "Landed costs", "b@x.com")
    # back to the default
    cur.execute("select public.fin_pl_rule_set('{\"account_key\":\"3\"}')")
    cur.execute("select include, grp from fin.pl_account_class where account_key = '3'")
    assert cur.fetchone() == (False, "In dashboard profit")

    # the next pass no longer has the rent: zeroed, not removed; other months outside the pass are kept
    assert save(cur, [r for r in rows if r["key"] != "6" and r["month"] == "2025-01-01"], end="2025-01-31") == 6
    cur.execute("select amount from fin.qbo_pl where account_key = '6'")
    assert cur.fetchone()[0] == 0
    cur.execute("select amount from fin.qbo_pl where account_key = '4' and month = '2025-02-01'")
    assert cur.fetchone()[0] == 310
    cur.execute("select value->>'rows' from fin.sync_state where key = 'qbo_pl'")
    assert cur.fetchone()[0] == "6"


def test_rule_set_needs_finance(conn):
    cur = conn.cursor()
    cur.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": "22222222-2222-2222-2222-222222222222"}),))
    with pytest.raises(Exception, match="not allowed"):
        cur.execute("select public.fin_pl_rule_set('{\"account_key\":\"3\"}')")
