"""Prep center › Analyze ignore list (migration 108)."""
import json


def test_ignore_and_clear(conn):
    cur = conn.cursor()
    call = lambda p: (cur.execute("select jt.send_finder_ignore_set(%s::jsonb)", (json.dumps({"by": "t", **p}),)), cur.fetchone()[0])[1]
    assert call({"skus": ["A", "B"], "days": 30}) == 2
    cur.execute("select amazon_sku, until - current_date from jt.send_finder_ignore where cleared_at is null order by 1")
    assert [(k, d) for k, d in cur.fetchall()] in ([("A", 30), ("B", 30)], [("A", 29), ("B", 29)], [("A", 31), ("B", 31)])
    call({"skus": ["A"], "days": None})                       # re-ignore: replaces the open one (until cleared)
    cur.execute("select count(*), max(until) from jt.send_finder_ignore where cleared_at is null and amazon_sku = 'A'"); assert cur.fetchone() == (1, None)
    call({"skus": ["A", "B"], "clear": True})
    cur.execute("select count(*) from jt.send_finder_ignore where cleared_at is null"); assert cur.fetchone()[0] == 0
