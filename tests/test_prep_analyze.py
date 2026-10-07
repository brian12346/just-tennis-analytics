"""Prep center Analyze lane (migration 107): one open flag per product + listing, a note, closed with done."""
import json


def setf(cur, p):
    cur.execute("select jt.prep_analyze_set(%s::jsonb)", (json.dumps({"by": "t", **p}),))
    return cur.fetchone()[0]


def test_analyze_flag(conn):
    cur = conn.cursor()
    assert setf(cur, {"variant_id": 5, "amazon_sku": "A-FBA", "on": True})
    assert setf(cur, {"variant_id": 5, "amazon_sku": "A-FBA", "on": True, "note": "check price"})   # same flag, note updated
    cur.execute("select count(*), max(note) from jt.prep_analyze where done_at is null"); assert cur.fetchone() == (1, "check price")
    assert setf(cur, {"variant_id": 5, "amazon_sku": "A-FBA", "on": False})
    cur.execute("select count(*) filter (where done_at is null), count(*) from jt.prep_analyze"); assert cur.fetchone() == (0, 1)
    setf(cur, {"variant_id": 5, "amazon_sku": "A-FBA", "on": True})                                 # can be set aside again
    cur.execute("select count(*) from jt.prep_analyze where done_at is null"); assert cur.fetchone()[0] == 1
