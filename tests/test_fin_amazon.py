"""Finance › Amazon payouts: settlement save, mapping, journal entries split by month, cost of goods."""
import json


def save(cur, p):
    cur.execute("select public.fin_amz_settlement_save(%s::jsonb)", (json.dumps(p),))
    return cur.fetchone()[0]


def entry(cur, sid):
    cur.execute("select fin.amz_entry(%s)", (sid,))
    return cur.fetchone()[0]


def test_settlement_entry_split_and_cogs(conn):
    cur = conn.cursor()
    S = {"id": "123456789", "report_id": "r1", "market": "US", "currency": "USD", "start": "2026-08-29T16:54:04Z",
         "end": "2026-09-12T16:54:04Z", "deposit": "2026-09-14T00:00:00Z", "total": 102.0, "rows": 9}
    sums = [
        # August part: a sale and its fees
        {"part": "2026-08-01", "tt": "Order", "at": "ItemPrice", "ad": "Principal", "mk": "Amazon.com", "ful": "AFN", "amount": 26.46, "n": 1},
        {"part": "2026-08-01", "tt": "Order", "at": "ItemFees", "ad": "Commission", "mk": "Amazon.com", "ful": "AFN", "amount": -3.97, "n": 1},
        {"part": "2026-08-01", "tt": "Order", "at": "ItemFees", "ad": "FBAPerUnitFulfillmentFee", "mk": "Amazon.com", "ful": "AFN", "amount": -3.54, "n": 1},
        # September part
        {"part": "2026-09-01", "tt": "Order", "at": "ItemPrice", "ad": "Principal", "mk": "Amazon.com", "ful": "MFN", "amount": 100.0, "n": 1},
        {"part": "2026-09-01", "tt": "Order", "at": "ItemPrice", "ad": "Tax", "mk": "Amazon.com", "ful": "MFN", "amount": 8.0, "n": 1},
        {"part": "2026-09-01", "tt": "Order", "at": "ItemWithheldTax", "ad": "MarketplaceFacilitatorTax-Principal", "mk": "Amazon.com", "ful": "MFN", "amount": -8.0, "n": 1},
        {"part": "2026-09-01", "tt": "Refund", "at": "ItemPrice", "ad": "Principal", "mk": "Amazon.com", "ful": "AFN", "amount": -10.0, "n": 1},
        {"part": "2026-09-01", "tt": "other-transaction", "at": "other-transaction", "ad": "Storage Fee", "mk": "", "ful": "", "amount": -2.0, "n": 1},
        {"part": "2026-09-01", "tt": "other-transaction", "at": "other-transaction", "ad": "Something New", "mk": "", "ful": "", "amount": -4.95, "n": 1},
    ]
    units = [{"part": "2026-08-01", "ful": "AFN", "sku": "SKU-A", "qty": 1}, {"part": "2026-09-01", "ful": "MFN", "sku": "SKU-B", "qty": 2}]
    assert save(cur, {"settlement": S, "sums": sums, "units": units}) == 11
    e = entry(cur, "123456789")
    assert e["problems"][0]["kind"] == "cost"          # no product costs in the test database
    mains = [p for p in e["parts"] if p["kind"] == "main"]
    assert [(p["doc"], p["date"]) for p in mains] == [("SSPUS-29Aug-12Sep-789", "2026-08-29"), ("SSPUS-01Sep-12Sep-789", "2026-09-01")]
    aug = {l["account"]: l["amount"] for l in mains[0]["lines"]}
    assert aug == {"Amazon Sales": -26.46, "Amazon Seller Fees and Charges": 3.97, "Amazon FBA Fees": 3.54, "Amazon Carried Balances": 18.95}
    sep = mains[1]["lines"]
    assert sep[0]["account"] == "Amazon Carried Balances" and sep[0]["amount"] == -18.95
    assert sep[-1]["account"] == "BofA (0140)" and float(sep[-1]["amount"]) == 102.0
    for p in mains:
        assert round(sum(float(l["amount"]) for l in p["lines"]), 2) == 0
    accts = {}
    for l in sep:
        accts[l["account"]] = round(accts.get(l["account"], 0) + float(l["amount"]), 2)
    assert accts["Amazon Sales Tax Collected"] == 0 and accts["Amazon Sales:Amazon Refunds"] == 10.0 and accts["Amazon FBA Fees"] == 2.0
    review = [l for l in sep if l.get("review")]
    assert len(review) == 1 and review[0]["account"] == "Amazon Seller Fees and Charges" and "Something New" in review[0]["description"]

    # a payout that doesn't match its lines is flagged
    S2 = dict(S, id="999", total=50)
    save(cur, {"settlement": S2, "sums": sums[:1], "units": []})
    assert any(p["kind"] == "total" for p in entry(cur, "999")["problems"])

    # posted entries are remembered by number
    cur.execute("select public.fin_amz_posted(%s::jsonb)", (json.dumps({"settlement_id": "123456789", "doc": "SSPUS-01Sep-12Sep-789", "id": "77", "by": "b"}),))
    assert entry(cur, "123456789")["parts"][1]["posted"]["id"] == "77"


def test_a2x_compare(conn):
    cur = conn.cursor()
    S = {"id": "555000111", "report_id": "r9", "market": "US", "currency": "USD", "start": "2026-09-09T16:54:04Z",
         "end": "2026-09-23T16:54:04Z", "deposit": "2026-09-24T00:00:00Z", "total": 90.0, "rows": 2}
    sums = [{"part": "2026-09-01", "tt": "Order", "at": "ItemPrice", "ad": "Principal", "mk": "Amazon.com", "ful": "AFN", "amount": 100.0, "n": 1},
            {"part": "2026-09-01", "tt": "Order", "at": "ItemFees", "ad": "Commission", "mk": "Amazon.com", "ful": "AFN", "amount": -10.0, "n": 1}]
    save(cur, {"settlement": S, "sums": sums, "units": []})
    cur.execute("select public.fin_amz_posted(%s::jsonb)", (json.dumps({"settlement_id": "555000111", "a2x": ["A2XUS-09Sep-23Sep-111"]}),))
    a2x = {"settlement_id": "555000111", "entries": [{"doc": "A2XUS-09Sep-23Sep-111", "id": "9", "date": "2026-09-09", "currency": "USD", "fx": 1, "lines": [
        {"account": "Amazon Sales", "description": "Principal", "amount": -100.0},
        {"account": "Amazon FBA Fees", "description": "Commission", "amount": 10.0},     # A2X put it elsewhere
        {"account": "BofA (0140)", "description": "Balance", "amount": 90.0}]}]}
    cur.execute("select public.fin_amz_a2x_save(%s::jsonb)", (json.dumps(a2x),))
    assert cur.fetchone()[0] == 3
    cur.execute("select account, a2x, ours, diff from fin.v_amz_compare where settlement_id = '555000111' order by account")
    rows = {r[0]: tuple(float(x) for x in r[1:]) for r in cur.fetchall()}
    assert rows["Amazon Sales"] == (-100.0, -100.0, 0.0)
    assert rows["BofA (0140)"] == (90.0, 90.0, 0.0)
    assert rows["Amazon FBA Fees"] == (10.0, 0.0, -10.0)
    assert rows["Amazon Seller Fees and Charges"] == (0.0, 10.0, 10.0)
    cur.execute("select public.fin_amz_a2x_todo()")
    assert "555000111" not in cur.fetchone()[0]
