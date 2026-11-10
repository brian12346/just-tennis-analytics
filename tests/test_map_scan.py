"""MAP scan (migration 216): our ASINs of a MAP brand, every offer saved, those under MAP in jt.v_map_violations."""
import json


def test_map_scan(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.pm_map_files (id, brand, file_name, dates, items) values (1, 'Wilson', 'q4.xlsx', '{2026-01-01}', 2)")
    cur.execute("""insert into jt.pm_map_items (file_id, sku, upc, description, prev_map, maps) values
                   (1, 'WR1', '0097512451185', 'Overgrip', 9.00, '[{"d": "2026-01-01", "p": 10}, {"d": "2099-01-01", "p": 12}]'),
                   (1, 'WR2', '097512451161', 'Ball can', 5.00, '[]')""")
    cur.execute("insert into jt.pm_upc_asin (upc, asin, title) values ('97512451185', 'B01', 'Pro Overgrip 3pk'), ('97512451161', 'B02', 'Balls')")
    cur.execute("select count(*) from jt.map_now('wilson')")
    assert cur.fetchone()[0] == 2
    cur.execute("select map_price from jt.map_now('Wilson') where item_sku = 'WR1'")
    assert float(cur.fetchone()[0]) == 10.0            # today's step, not the 2099 one
    # only ASINs we sell on: make B01 ours (an FBA SKU), B02 not
    cur.execute("insert into jt.fba_inventory (sku, asin, active, fulfillable, total) values ('WR1-FBA', 'B01', true, 5, 5)")
    cur.execute("select public.jt_map_scan('{\"op\": \"start\", \"brand\": \"Wilson\"}')")
    st = cur.fetchone()[0]
    assert st["asins"] == 1
    sid = st["scan_id"]
    cur.execute("select public.jt_map_scan(%s::jsonb)", (json.dumps({"op": "todo", "scan_id": sid}),))
    assert cur.fetchone()[0] == ["B01"]
    cur.execute("select public.jt_map_scan(%s::jsonb)", (json.dumps({"op": "save", "scan_id": sid, "rows": [{"asin": "B01", "offers_total": 3, "offers": [
        {"seller_id": "A1BAD", "fba": True, "listing_price": 8.00, "shipping": 0, "buybox": True},
        {"seller_id": "A1BAD", "fba": True, "listing_price": 8.50, "shipping": 0},
        {"seller_id": "AJPAM6HXYXK3Y", "fba": True, "listing_price": 10.00, "shipping": 0},
        {"seller_id": "A2CHEAP", "fba": False, "listing_price": 9.99, "shipping": 4.99}]}]}),))
    assert cur.fetchone()[0] == {"left": 0}
    cur.execute("select finished_at is not null from jt.map_scans where id = %s", (sid,))
    assert cur.fetchone()[0]
    cur.execute("select seller_id, under_by, ours from jt.v_map_violations order by under_by desc")
    rows = [(a, float(b), c) for a, b, c in cur.fetchall()]
    assert rows == [("A1BAD", 2.0, False), ("A2CHEAP", 0.01, False)]   # shipping doesn't count; we're at MAP
