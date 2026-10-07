"""Google Ads spend (migration 105): the Google Ads script's daily rows land in jt.google_ads_daily and come off the
store's profit in All sales."""
import json


def ingest(cur, p):
    cur.execute("select jt.google_ads_ingest(%s::jsonb)", (json.dumps(p),))
    return cur.fetchone()[0]


def test_ingest_and_profit(conn):
    cur = conn.cursor()
    cur.execute("insert into jt.shopify_daily (day, net, cogs, gross_profit, net_no_cost, shipping) values ('2026-10-01', 100, 40, 60, 0, 10)")
    p = {"store": "justtennis", "account": {"id": "123-456-7890", "name": "Just Tennis"}, "from": "2026-09-30", "to": "2026-10-02",
         "rows": [{"day": "2026-10-01", "campaign_id": "1", "campaign": "Shopping", "type": "SHOPPING", "cost": 12.5, "clicks": 30, "impressions": 900, "conversions": 2, "conv_value": 180},
                  {"day": "2026-10-01", "campaign_id": "2", "campaign": "Brand", "type": "SEARCH", "cost": 2.25, "clicks": 4, "impressions": 50},
                  {"day": "2026-09-01", "campaign_id": "2", "cost": 99}]}          # outside from/to: ignored
    assert ingest(cur, p) == {"ok": True, "rows": 2}
    cur.execute("select ad_spend, profit from jt.v_sales_channels_daily where channel = 'justtennis' and day = '2026-10-01'")
    assert tuple(map(float, cur.fetchone())) == (14.75, 60 + 10 - 14.75)
    # resend without the Brand campaign: it goes to zero, nothing is deleted
    p["rows"] = p["rows"][:1]
    ingest(cur, p)
    cur.execute("select campaign_id, cost from jt.google_ads_daily order by campaign_id")
    assert [(c, float(x)) for c, x in cur.fetchall()] == [("1", 12.5), ("2", 0)]
    cur.execute("select value->'justtennis'->>'rows', value->'justtennis'->'account'->>'id' from jt.settings where key = 'google_ads'")
    assert cur.fetchone() == ("1", "123-456-7890")
    cur.execute("select ad_spend from jt.v_sales_channels_daily where channel = 'amazon' limit 1")


def test_bad_store(conn):
    import psycopg, pytest
    cur = conn.cursor()
    with pytest.raises(psycopg.errors.RaiseException):
        ingest(cur, {"store": "other", "from": "2026-10-01", "to": "2026-10-01", "rows": []})
    conn.rollback()
