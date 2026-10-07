"""Ace n Rally entered costs (migration 103): a cost entered for an order covers its uncosted items."""
import json

COLS = "day, order_id, order_name, variant_id, product_title, units, net, cogs, net_no_cost"


def test_anr_entered_cost(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.anr_daily (day, net, cogs, gross_profit, net_no_cost) values ('2026-09-10', 300, 40, 60, 200)")
    cur.execute(f"""insert into jt.anr_sales ({COLS}) values
        ('2026-09-10', 5, '#AR5', 0, '', 2, 150, 0, 150),           -- custom item, no cost
        ('2026-09-10', 5, '#AR5', 77, 'Used racket', 1, 50, 0, 50), -- unmatched used racket
        ('2026-09-10', 6, '#AR6', 88, 'Grip', 1, 100, 40, 0)""")
    cur.execute("select order_name, net_no_cost, items, cost from jt.v_anr_orders_nocost")
    name, nc, items, cost = cur.fetchone()
    assert (name, float(nc), cost) == ("#AR5", 200, None) and items == "Custom item ×2, Used racket"
    q = "select cogs, sales_no_cost, gross_profit from jt.v_sales_channels_daily where channel = 'acenrally' and day = '2026-09-10'"
    cur.execute(q); assert tuple(map(float, cur.fetchone())) == (40, 200, 60)        # no-cost sales left out of gross profit
    cur.execute("select jt.save_anr_cost(%s::jsonb)", (json.dumps({"order_id": 5, "order_name": "#AR5", "cost": 120, "note": "demo"}),))
    cur.execute(q); assert tuple(map(float, cur.fetchone())) == (160, 0, 140)        # 300 - 0 - (40 + 120)
    cur.execute("select cogs, net_no_cost from jt.v_anr_daily_final where day = '2026-09-10'")
    assert tuple(map(float, cur.fetchone())) == (160, 0)
    cur.execute("select cost from jt.v_anr_orders_nocost where order_id = 5"); assert float(cur.fetchone()[0]) == 120
    cur.execute("select jt.save_anr_cost(%s::jsonb)", (json.dumps({"order_id": 5, "cost": ""}),))   # cleared
    cur.execute(q); assert tuple(map(float, cur.fetchone())) == (40, 200, 60)
