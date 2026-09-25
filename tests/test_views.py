"""The profit math in the views: saved costs, returns on later days, cost history."""
import json
from decimal import Decimal as D

SALES_COLS = "day, order_id, order_name, variant_id, product_title, units, net, cogs, net_no_cost"


def add_daily(cur, day, net, cogs, nc, gp=None):
    cur.execute("insert into jt.shopify_daily (day, net, cogs, gross_profit, net_no_cost) values (%s,%s,%s,%s,%s)",
                (day, net, cogs, net - cogs if gp is None else gp, nc))


def daily(cur, day):
    cur.execute("select cogs, net_no_cost, gross_profit from jt.v_daily where day = %s", (day,))
    return cur.fetchone()


def test_migrations_are_repeatable(conn):
    from sync import migrate
    migrate.main()  # second run is a no-op


def test_saved_cost_covers_the_order_and_adds_only_the_difference(conn):
    cur = conn.cursor()
    add_daily(cur, "2026-08-25", 771.69 + 100, 387.6, 771.69)
    cur.execute(f"insert into jt.shopify_sales ({SALES_COLS}) values "
                "('2026-08-25', 1, '#21391', 11, 'Agassi Pro V', 2, 771.69, 387.6, 771.69)")
    cur.execute("select jt.save_cost_override(%s::jsonb)",
                (json.dumps({"order_id": 1, "order_name": "#21391", "cost": 802, "shopify_cogs": 387.6}),))
    cogs, nc, gp = daily(cur, "2026-08-25")
    assert cogs == D("802.00")            # 387.60 recorded + 414.40 entered
    assert nc == D("0.00")
    assert gp == D("69.69")               # 871.69 net - 802 cost


def test_sold_then_returned_is_not_flagged_on_either_day(conn):
    cur = conn.cursor()
    add_daily(cur, "2026-09-04", 39.95, 0, 39.95)
    add_daily(cur, "2026-09-10", -39.95, 0, -39.95)
    cur.execute(f"insert into jt.shopify_sales ({SALES_COLS}) values "
                "('2026-09-04', 2, '#21678', 22, 'Vision II Backpack', 1, 39.95, 0, 39.95),"
                "('2026-09-10', 2, '#21678', 22, 'Vision II Backpack', -1, -39.95, 0, -39.95)")
    assert daily(cur, "2026-09-04")[1] == D("0.00")
    assert daily(cur, "2026-09-10")[1] == D("0.00")
    cur.execute("select count(*) from jt.v_costmap_orders")
    assert cur.fetchone()[0] == 0


def test_partial_return_moves_its_share_of_the_added_cost(conn):
    cur = conn.cursor()
    add_daily(cur, "2026-09-01", 200, 0, 200)
    add_daily(cur, "2026-09-05", -50, 0, -50)
    cur.execute(f"insert into jt.shopify_sales ({SALES_COLS}) values "
                "('2026-09-01', 3, '#1', 33, 'Bag', 4, 200, 0, 200),"
                "('2026-09-05', 3, '#1', 33, 'Bag', -1, -50, 0, -50)")
    cur.execute("select jt.save_cost_override(%s::jsonb)",
                (json.dumps({"order_id": 3, "cost": 60, "shopify_cogs": 0}),))   # 3 bags kept x $20
    assert daily(cur, "2026-09-01")[0] == D("80.00")    # 4 bags on the sale day
    assert daily(cur, "2026-09-05")[0] == D("-20.00")   # one comes back
    cur.execute("select cogs from jt.v_order_profit where order_id = 3")


def test_open_orders_and_lines_for_cost_mapping(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.shopify_orders (order_id, name, created_at, order_day) values (4, '#4', now(), current_date)")
    cur.execute("insert into jt.shopify_order_lines (line_id, order_id, variant_id, title, quantity, current_quantity)"
                " values (40, 4, 44, 'Grip', 2, 2), (41, 4, 45, 'String', 1, 1), (42, 4, null, 'Custom', 1, 1)")
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost) values (44, 1, 3.5)")
    cur.execute(f"insert into jt.shopify_sales ({SALES_COLS}) values "
                "(current_date, 4, '#4', 44, 'Grip', 2, 20, 0, 20),"
                "(current_date, 4, '#4', 45, 'String', 1, 10, 6, 0),"
                "(current_date, 4, '#4', 0, '', 1, 5, 0, 5)")
    cur.execute("select line_id, shopify_cost_now from jt.v_costmap_lines order by line_id")
    assert cur.fetchall() == [(40, D("3.50")), (42, None)]
    cur.execute("select net_no_cost from jt.v_costmap_orders")
    assert cur.fetchone()[0] == D("25.00")


def test_cost_history_corrections_vs_real_changes(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost) values (5, 1, 6.83)")
    cur.execute("select jt.set_setting('costs', '{\"history_start\": \"2026-09-24\"}'::jsonb)")
    # edited on Sep 22 (before clean data): a correction, today's cost applies to all history
    cur.execute("insert into jt.variant_cost_changes (changed_on, variant_id, old_cost, new_cost) values ('2026-09-22', 5, 8.50, 6.83)")
    cur.execute("select jt.variant_cost_on(5, '2026-08-17')")
    assert cur.fetchone()[0] == D("6.83")
    # a real price rise on Oct 1: earlier sales keep 6.83
    cur.execute("update jt.variants set unit_cost = 7.25 where variant_id = 5")
    cur.execute("insert into jt.variant_cost_changes (changed_on, variant_id, old_cost, new_cost) values ('2026-10-01', 5, 6.83, 7.25)")
    cur.execute("select jt.variant_cost_on(5, '2026-09-30'), jt.variant_cost_on(5, '2026-10-02')")
    assert cur.fetchone() == (D("6.83"), D("7.25"))
    # marking the Sep 22 edit as real brings back the old cost for sales before it
    cur.execute("select id from jt.variant_cost_changes where changed_on = '2026-09-22'")
    cur.execute("select jt.set_cost_change_kind(%s, 'real')", (cur.fetchone()[0],))
    cur.execute("select jt.variant_cost_on(5, '2026-08-17')")
    assert cur.fetchone()[0] == D("8.50")


def test_amazon_cost_uses_mapping(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, unit_cost) values (6, 1, 2.00)")
    cur.execute("select jt.save_amazon_map(%s::jsonb)", (json.dumps({"sku": "A-12PK", "kind": "shopify", "variant_id": 6, "units": 12}),))
    cur.execute("insert into jt.amazon_transactions (row_hash, posted_at, day, type, sku, quantity, product_sales, total)"
                " values ('h1', '2026-09-01 10:00', '2026-09-01', 'Order', 'A-12PK', 2, 60, 45),"
                "        ('h2', '2026-09-01 11:00', '2026-09-01', 'Order', 'UNMAPPED', 1, 10, 7)")
    cur.execute("select units, sales, product_cost, sales_without_cost from jt.v_amazon_daily")
    assert cur.fetchone() == (3, D("70.00"), D("48.0000"), D("10.00"))
