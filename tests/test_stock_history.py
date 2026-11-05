"""Item detail › Inventory by location (migration 214): month-end on hand in the store, prep center, FBA (ledger) and AWD."""
import datetime as dt
import json


def test_item_stock_months(conn):
    cur = conn.cursor()
    cur.execute("select date_trunc('month', (now() at time zone 'America/Los_Angeles')::date)::date")
    cur_m = cur.fetchone()[0]
    last = (cur_m - dt.timedelta(days=1)).replace(day=1)
    two = (last - dt.timedelta(days=1)).replace(day=1)
    cur.execute("insert into jt.variants (variant_id, product_id, inventory_item_id, sku, display_name, inventory_qty) values (7, 11, 999, 'SG17', 'Gut 17', 4)")
    # store history: last month only
    cur.execute("insert into jt.inventory_monthly (variant_id, month, start_units, end_units, sold) values (7, %s, 10, 6, 4)", (last,))
    # prep: two SKU rows; the later move in each counts
    cur.execute("""insert into jt.prep_moves (at, kind, variant_id, amazon_sku, qty_change, qty_after) values
                   (%s, 'seed', 7, '', 5, 5), (%s, 'adjust', 7, '', -2, 3), (%s, 'seed', 7, 'A1', 8, 8)""",
                (dt.datetime.combine(two, dt.time(12)), dt.datetime.combine(last, dt.time(12)), dt.datetime.combine(last, dt.time(13))))
    cur.execute("insert into jt.prep_items (variant_id, amazon_sku, qty) values (7, 'A1', 2)")
    # FBA: the ledger through a 2-pack SKU mapped to the variant
    cur.execute("""insert into jt.docs (collection, id, data) values ('amzmap', 'm1', %s)""",
                (json.dumps({"sku": "SG17-2PK", "kind": "shopify", "variantId": "gid://shopify/ProductVariant/7", "units": 2}),))
    cur.execute("refresh materialized view jt.mv_amz_sku_cost")
    cur.execute("select public.jt_fba_ledger_save(%s::jsonb)", (json.dumps({"first": True, "months": [str(last)], "rows": [
        {"month": str(last), "sku": "SG17-2PK", "fnsku": "X0", "disposition": "SELLABLE", "start": 3, "shipments": -1, "end": 2},
        {"month": str(last), "sku": "SG17-2PK", "fnsku": "X0", "disposition": "CUSTOMER_DAMAGED", "end": 1}]}),))
    assert cur.fetchone()[0] == 2
    cur.execute("select month, store, prep, fba, awd from jt.item_stock_months(7, 3)")
    rows = cur.fetchall()
    assert rows[0] == (two, None, 5, None, None)       # no store / ledger / snapshot data at all that month: unknown
    assert rows[1] == (last, 6, 11, 4, None)           # 3 + 8 at the prep center; 2 sellable 2-packs = 4
    assert rows[2][:3] == (cur_m, 4, 2)                # this month: on hand now
    # snapshot
    cur.execute("select jt.stock_snapshot()")
    assert cur.fetchone()[0] == 1
    cur.execute("select store, prep from jt.stock_daily where variant_id = 7")
    assert cur.fetchone() == (4, 2)
    # report bookkeeping
    cur.execute("select public.jt_fba_ledger_report('{\"op\":\"requested\",\"report_id\":\"r1\",\"start\":\"2025-11-01\",\"end\":\"2026-11-04\"}')")
    cur.execute("select public.jt_fba_ledger_report('{\"op\":\"state\"}')")
    st = cur.fetchone()[0]
    assert st["pending"] == "r1" and st["fresh"] and st["have"] == 1


def test_oos_note(conn):
    """Out of stock › Notes (migration 215): set, replace, clear with an empty note."""
    cur = conn.cursor()
    cur.execute("select jt.oos_note('{\"variant_id\": 7, \"note\": \"  vendor says Dec  \", \"by\": \"b@x.com\"}')")
    assert cur.fetchone()[0] is True
    cur.execute("select jt.oos_note('{\"variant_id\": 7, \"note\": \"ships 11/12\", \"by\": \"brit@x.com\"}')")
    cur.execute("select note, by from jt.oos_notes where variant_id = 7")
    assert cur.fetchone() == ("ships 11/12", "brit@x.com")
    cur.execute("select jt.oos_note('{\"variant_id\": 7, \"note\": \"\"}')")
    assert cur.fetchone()[0] is False
    cur.execute("select count(*) from jt.oos_notes")
    assert cur.fetchone()[0] == 0
