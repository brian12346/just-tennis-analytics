"""All sales (migration 092): Amazon day documents fill jt.amazon_sku_daily / amazon_order_daily, and the channel
view costs Amazon lines through the SKU mapping."""
import json


def test_amazon_day_doc_feeds_channel_view(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.variants (variant_id, product_id, sku, vendor, unit_cost) values (1, 10, 'A', 'Wilson', 2.5)")
    cur.execute("insert into jt.docs (collection, id, data) values ('amzmap', 's_SKU1', %s::jsonb)",
                (json.dumps({"sku": "SKU1", "kind": "shopify", "variantId": "gid://shopify/ProductVariant/1", "units": 2}),))
    doc = {"date": "2026-10-01", "skus": ["SKU1", "SKU2"],
           "orders": [["10:00", "o1", 0, 3, 30.0, 0, 0, -4.5, -6, 19.5, 1, 0], ["11:00", "o2", 1, 1, 10.0, 0, 0, -1.5, -3, 5.5, 1, 0]],
           "totals": {"orders": 2, "units": 4, "sales": 40.0, "orders_net": 25.0, "refunds_net": -1.0}}
    cur.execute("insert into jt.docs (collection, id, data) values ('amzodays', '2026-10-01', %s::jsonb)", (json.dumps(doc),))
    cur.execute("select sku, units, sales, net from jt.amazon_sku_daily where day = '2026-10-01' order by sku")
    assert [(r[0], float(r[1]), float(r[2]), float(r[3])) for r in cur.fetchall()] == [("SKU1", 3, 30, 19.5), ("SKU2", 1, 10, 5.5)]
    cur.execute("select orders, units, net_sales, cogs, gross_profit, sales_no_cost from jt.v_sales_channels_daily where channel = 'amazon' and day = '2026-10-01'")
    o, u, net, cogs, gp, nocost = map(float, cur.fetchone())
    assert (o, u, net, cogs, nocost) == (2, 4, 40, 15, 10)        # 3 units x 2 per unit x $2.50; SKU2 unmapped
    assert gp == 40 - 15                                        # gross profit = sales - product cost
    # a Shopify cost change reaches the cached SKU cost map (migration 101)
    cur.execute("update jt.variants set unit_cost = 5 where variant_id = 1")
    cur.execute("select cogs from jt.v_sales_channels_daily where channel = 'amazon' and day = '2026-10-01'")
    assert float(cur.fetchone()[0]) == 30
    cur.execute("update jt.variants set unit_cost = 2.5 where variant_id = 1")
    cur.execute("select labels, amz_fees, fba_fees, other_fees, profit from jt.v_sales_channels_daily where channel = 'amazon' and day = '2026-10-01'")
    assert tuple(map(float, cur.fetchone())) == (0, 0, 0, 1, 25 - 1 - 15)   # refunds as other; profit after fees
    # a re-saved day replaces its lines
    doc["orders"] = doc["orders"][:1]
    cur.execute("update jt.docs set data = %s::jsonb where collection = 'amzodays' and id = '2026-10-01'", (json.dumps(doc),))
    cur.execute("select count(*) from jt.amazon_sku_daily where day = '2026-10-01' and lines > 0")
    assert cur.fetchone()[0] == 1
    cur.execute("select channel, units, net_sales, gross_profit, amz_fees from jt.v_sales_products_daily where channel = 'amazon'")
    assert [tuple([r[0]] + [float(v) for v in r[1:]]) for r in cur.fetchall()] == [("amazon", 6, 30, 15, 10.5)]
