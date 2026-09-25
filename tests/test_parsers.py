"""Report and API parsers (no database needed)."""
import datetime as dt

from sync.amazon import listing_rows, parse_posted, transaction_rows
from sync.shipstation import label_row

TX = '''"Includes Amazon Marketplace, Fulfillment by Amazon (FBA), and Amazon Webstore transactions"
"All amounts in USD, unless specified"
"date/time","settlement id","type","order id","sku","description","quantity","marketplace","account type","fulfillment","order city","order state","order postal","tax collection model","product sales","product sales tax","shipping credits","shipping credits tax","gift wrap credits","giftwrap credits tax","Regulatory Fee","Tax On Regulatory Fee","promotional rebates","promotional rebates tax","marketplace withheld tax","selling fees","fba fees","other transaction fees","other","total","Transaction Status","Transaction Release Date"
"Mar 2, 2026 1:05:33 PM PST","123","Order","111-1","SKU1","Grip","2","amazon.com","Standard Orders","Amazon","","","","","1,024.50","0","0","0","0","0","0","0","-5","0","0","-150.10","-20","0","0","849.40","Released",""
"Mar 2, 2026 1:05:33 PM PST","123","Service Fee","","","Subscription","","","","","","","","","0","0","0","0","0","0","0","0","0","0","0","0","0","0","-39.99","-39.99","Released",""
"Mar 2, 2026 1:05:33 PM PST","123","Service Fee","","","Subscription","","","","","","","","","0","0","0","0","0","0","0","0","0","0","0","0","0","0","-39.99","-39.99","Released",""
'''


def test_parse_posted():
    assert parse_posted("Mar 2, 2026 12:05:33 AM PST") == dt.datetime(2026, 3, 2, 0, 5, 33)
    assert parse_posted("Dec 31, 2025 12:00:00 PM PST") == dt.datetime(2025, 12, 31, 12, 0, 0)


def test_transactions_keep_identical_lines_and_are_stable():
    rows = transaction_rows(TX, "r.csv")
    assert len(rows) == 3 and len({r[0] for r in rows}) == 3      # duplicate fee lines both kept
    assert rows[0][10] == 1024.5 and rows[0][18] == 849.4 and rows[0][8] == 2
    assert [r[0] for r in transaction_rows(TX, "again.csv")] == [r[0] for r in rows]   # re-upload -> same keys


def test_listing_rows():
    txt = "item-name\tseller-sku\tprice\tquantity\topen-date\tasin1\tfulfillment-channel\tstatus\n" \
          "Wilson Pro Overgrip\tWILPOG25\t19.99\t\t2021-03-08 10:00:00 PST\tB0959SF7SN\tAMAZON_NA\tActive\n"
    (r,) = listing_rows(txt, "l.txt")
    assert r[:8] == ("WILPOG25", "B0959SF7SN", "Wilson Pro Overgrip", 19.99, None, "AMAZON_NA", "Active", "2021-03-08")


def test_label_row():
    now = dt.datetime.now(dt.timezone.utc)
    r = label_row({"label_id": "se-1", "tracking_number": "1Z", "external_shipment_id": "7822677115165-1",
                   "shipment_cost": {"amount": 9.5}, "insurance_cost": {"amount": 0.54}, "service_code": "ups_ground",
                   "ship_date": "2026-09-22T00:00:00Z", "created_at": "2026-09-22T15:00:00Z"}, now)
    assert r[:7] == ("se-1", "1Z", 7822677115165, "2026-09-22", "ups ground", 10.04, False)
    assert label_row({"label_id": "se-2", "external_shipment_id": "amazon-xyz", "voided": True}, now)[2:7:4] == (None, True)
