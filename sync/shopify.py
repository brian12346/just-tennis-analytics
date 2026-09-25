"""Shopify Admin API client (GraphQL + ShopifyQL) and the Shopify sync jobs.

Auth: a Dev Dashboard app installed on the store, using the client credentials grant
(SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET), or a legacy custom-app token (SHOPIFY_ACCESS_TOKEN).
Scopes needed: read_orders, read_products, read_inventory, read_reports (+ protected customer data level 2
for ShopifyQL), read_all_orders to reach orders older than 60 days.
"""
from __future__ import annotations

import datetime as dt
import time

import requests

from .common import env, gid_num, money, store_day

API_VERSION = "2026-07"


class Shopify:
    def __init__(self) -> None:
        self.shop = env("SHOPIFY_SHOP").replace(".myshopify.com", "")
        self.base = f"https://{self.shop}.myshopify.com"
        self.session = requests.Session()
        self._token = env("SHOPIFY_ACCESS_TOKEN", required=False)
        self._token_exp = float("inf") if self._token else 0.0

    # -------------------------------------------------------------- auth
    def token(self) -> str:
        if self._token and time.time() < self._token_exp - 300:
            return self._token
        r = self.session.post(f"{self.base}/admin/oauth/access_token", timeout=30, data={
            "grant_type": "client_credentials",
            "client_id": env("SHOPIFY_CLIENT_ID"),
            "client_secret": env("SHOPIFY_CLIENT_SECRET"),
        })
        if r.status_code != 200:
            raise RuntimeError(f"Shopify token request failed ({r.status_code}): {r.text[:300]}")
        body = r.json()
        self._token = body["access_token"]
        self._token_exp = time.time() + int(body.get("expires_in", 86399))
        return self._token

    # -------------------------------------------------------------- GraphQL
    def graphql(self, query: str, variables: dict | None = None) -> dict:
        url = f"{self.base}/admin/api/{API_VERSION}/graphql.json"
        for attempt in range(8):
            r = self.session.post(url, json={"query": query, "variables": variables or {}}, timeout=120,
                                  headers={"X-Shopify-Access-Token": self.token()})
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(min(2 ** attempt, 30))
                continue
            if r.status_code == 401 and attempt == 0:
                self._token_exp = 0  # expired token: fetch a new one once
                continue
            r.raise_for_status()
            body = r.json()
            errs = body.get("errors") or []
            if any((e.get("extensions") or {}).get("code") == "THROTTLED" for e in errs):
                time.sleep(2 + attempt * 2)
                continue
            if errs:
                raise RuntimeError(f"Shopify GraphQL error: {errs[0].get('message')}")
            self._respect_throttle(body)
            return body["data"]
        raise RuntimeError("Shopify kept throttling or failing; try again later")

    @staticmethod
    def _respect_throttle(body: dict) -> None:
        cost = ((body.get("extensions") or {}).get("cost") or {})
        ts = cost.get("throttleStatus") or {}
        avail, rate = ts.get("currentlyAvailable"), ts.get("restoreRate") or 50
        need = cost.get("requestedQueryCost") or 0
        if avail is not None and avail < max(need, 200):
            time.sleep(min((max(need, 200) - avail) / rate, 20))

    def shopifyql(self, q: str) -> list[dict]:
        data = self.graphql("""query($q: String!) { shopifyqlQuery(query: $q) {
                                 tableData { columns { name dataType } rows } parseErrors } }""", {"q": q})
        res = data["shopifyqlQuery"]
        if res.get("parseErrors"):
            raise RuntimeError(f"ShopifyQL error: {res['parseErrors'][0]} in: {q}")
        table = res.get("tableData") or {}
        cols = [c["name"] for c in table.get("columns") or []]
        rows = table.get("rows") or []
        # Rows come back as objects keyed by column name; accept lists too.
        return [r if isinstance(r, dict) else dict(zip(cols, r)) for r in rows]


def _date_chunks(start: dt.date, end: dt.date, days: int):
    d = start
    while d <= end:
        e = min(end, d + dt.timedelta(days=days - 1))
        yield d, e
        d = e + dt.timedelta(days=1)


def _int(x) -> int:
    try:
        return int(str(x or 0))
    except ValueError:
        return 0


# ================================================================ jobs
def sync_daily(shop: Shopify, conn, start: dt.date, end: dt.date) -> int:
    rows = shop.shopifyql(
        "FROM sales SHOW orders, gross_sales, discounts, sales_reversals, net_sales, shipping_charges, taxes, "
        "total_sales, cost_of_goods_sold, gross_profit, net_sales_without_cost_recorded "
        f"TIMESERIES day SINCE {start} UNTIL {end}")
    out = [(str(r["day"])[:10], _int(r.get("orders")), money(r.get("gross_sales")), money(r.get("discounts")),
            money(r.get("sales_reversals")), money(r.get("net_sales")), money(r.get("shipping_charges")),
            money(r.get("taxes")), money(r.get("total_sales")), money(r.get("cost_of_goods_sold")),
            money(r.get("gross_profit")), money(r.get("net_sales_without_cost_recorded"))) for r in rows]
    from .common import replace_where
    return replace_where(conn, "jt.shopify_daily", "day between %s and %s", (start, end),
                         ["day", "orders", "gross", "discounts", "returns", "net", "shipping", "taxes", "total",
                          "cogs", "gross_profit", "net_no_cost"], out)


SALES_Q = ("FROM sales SHOW net_items_sold, gross_sales, discounts, sales_reversals, net_sales, cost_of_goods_sold, "
           "net_sales_without_cost_recorded GROUP BY day, order_id, order_name, product_variant_id, product_id, "
           "product_title, product_variant_title, product_variant_sku, product_type, product_vendor, sales_channel "
           "SINCE {s} UNTIL {e} LIMIT {lim}")
SALES_LIMIT = 20000


def _sales_rows(shop: Shopify, s: dt.date, e: dt.date) -> list[dict]:
    rows = shop.shopifyql(SALES_Q.format(s=s, e=e, lim=SALES_LIMIT))
    if len(rows) >= SALES_LIMIT:
        if s == e:
            raise RuntimeError(f"More than {SALES_LIMIT} sales rows on {s}; raise SALES_LIMIT")
        mid = s + (e - s) // 2
        return _sales_rows(shop, s, mid) + _sales_rows(shop, mid + dt.timedelta(days=1), e)
    return rows


def sync_sales(shop: Shopify, conn, start: dt.date, end: dt.date) -> int:
    from .common import replace_where
    cols = ["day", "order_id", "order_name", "variant_id", "product_id", "product_title", "variant_title", "sku",
            "product_type", "vendor", "sales_channel", "units", "gross", "discounts", "returns", "net", "cogs",
            "net_no_cost"]
    total = 0
    for s, e in _date_chunks(start, end, 14):
        agg: dict[tuple, list] = {}
        for r in _sales_rows(shop, s, e):
            key = (str(r["day"])[:10], _int(r.get("order_id")), _int(r.get("product_variant_id")),
                   r.get("product_title") or "", r.get("sales_channel") or "")
            vals = [money(r.get(k)) for k in ("net_items_sold", "gross_sales", "discounts", "sales_reversals",
                                               "net_sales", "cost_of_goods_sold", "net_sales_without_cost_recorded")]
            if key in agg:  # same key twice (e.g. two custom items): add them up
                agg[key][11:] = [round(a + b, 2) for a, b in zip(agg[key][11:], vals)]
                continue
            agg[key] = [key[0], key[1], r.get("order_name") or "", key[2], _int(r.get("product_id")), key[3],
                        r.get("product_variant_title") or "", r.get("product_variant_sku") or "",
                        r.get("product_type") or "", r.get("product_vendor") or "", key[4], *vals]
        total += replace_where(conn, "jt.shopify_sales", "day between %s and %s", (s, e), cols,
                               [tuple(v) for v in agg.values()])
        conn.commit()
    return total


ORDERS_Q = """query($first: Int!, $after: String, $q: String) {
  orders(first: $first, after: $after, query: $q, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt updatedAt cancelledAt test sourceName displayFinancialStatus displayFulfillmentStatus
      subtotalLineItemsQuantity
      currentSubtotalPriceSet { shopMoney { amount } } totalDiscountsSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } } totalRefundedSet { shopMoney { amount } }
      currentTotalPriceSet { shopMoney { amount } }
      lineItems(first: 30) {
        pageInfo { hasNextPage endCursor }
        nodes { id title variantTitle sku quantity currentQuantity product { id } variant { id }
                discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } } }
      }
    }
  }
}"""

MORE_LINES_Q = """query($id: ID!, $after: String) { order(id: $id) { lineItems(first: 100, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { id title variantTitle sku quantity currentQuantity product { id } variant { id }
          discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } } } } } }"""


def _amt(o, k):
    return money(((o.get(k) or {}).get("shopMoney") or {}).get("amount"))


def _line_row(order_id: int, li: dict) -> tuple:
    return (gid_num(li["id"]), order_id, gid_num((li.get("product") or {}).get("id")),
            gid_num((li.get("variant") or {}).get("id")), li.get("title") or "",
            "" if li.get("variantTitle") in (None, "Default Title") else li["variantTitle"], li.get("sku") or "",
            li.get("quantity") or 0, li.get("currentQuantity") if li.get("currentQuantity") is not None else (li.get("quantity") or 0),
            _amt(li, "discountedUnitPriceAfterAllDiscountsSet"))


def sync_orders(shop: Shopify, conn, updated_since: dt.datetime) -> int:
    """Orders (and their line items) created or changed since `updated_since`."""
    from .common import upsert
    q = f"updated_at:>='{updated_since.strftime('%Y-%m-%dT%H:%M:%SZ')}'"
    after, n = None, 0
    ocols = ["order_id", "name", "created_at", "order_day", "source_name", "channel", "financial_status",
             "fulfillment_status", "cancelled_at", "test", "subtotal", "discounts", "shipping", "tax", "total",
             "refunded", "current_total", "item_qty", "updated_at", "synced_at"]
    lcols = ["line_id", "order_id", "product_id", "variant_id", "title", "variant_title", "sku", "quantity",
             "current_quantity", "unit_price"]
    while True:
        page = shop.graphql(ORDERS_Q, {"first": 25, "after": after, "q": q})["orders"]
        orders, lines = [], []
        now = dt.datetime.now(dt.timezone.utc)
        for o in page["nodes"]:
            oid = gid_num(o["id"])
            src = (o.get("sourceName") or "").lower()
            orders.append((oid, o["name"], o["createdAt"], store_day(o["createdAt"]), o.get("sourceName") or "",
                           "web" if src == "web" else "pos" if src == "pos" else "other",
                           o.get("displayFinancialStatus") or "", o.get("displayFulfillmentStatus") or "",
                           o.get("cancelledAt"), bool(o.get("test")), _amt(o, "currentSubtotalPriceSet"),
                           _amt(o, "totalDiscountsSet"), _amt(o, "totalShippingPriceSet"), _amt(o, "totalTaxSet"),
                           _amt(o, "totalPriceSet"), _amt(o, "totalRefundedSet"), _amt(o, "currentTotalPriceSet"),
                           o.get("subtotalLineItemsQuantity") or 0, o.get("updatedAt"), now))
            lis = o["lineItems"]
            lines += [_line_row(oid, li) for li in lis["nodes"]]
            cursor, more = lis["pageInfo"]["endCursor"], lis["pageInfo"]["hasNextPage"]
            while more:
                extra = shop.graphql(MORE_LINES_Q, {"id": o["id"], "after": cursor})["order"]["lineItems"]
                lines += [_line_row(oid, li) for li in extra["nodes"]]
                cursor, more = extra["pageInfo"]["endCursor"], extra["pageInfo"]["hasNextPage"]
        upsert(conn, "jt.shopify_orders", ocols, orders, ["order_id"])
        if orders:
            with conn.cursor() as cur:  # replace these orders' lines (items can be removed by order edits)
                cur.execute("delete from jt.shopify_order_lines where order_id = any(%s)", ([r[0] for r in orders],))
        upsert(conn, "jt.shopify_order_lines", lcols, lines, ["line_id"])
        conn.commit()
        n += len(orders)
        if not page["pageInfo"]["hasNextPage"]:
            return n
        after = page["pageInfo"]["endCursor"]


VARIANTS_Q = """query($first: Int!, $after: String) {
  productVariants(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id sku title displayName price updatedAt
            product { id title vendor productType status }
            inventoryItem { unitCost { amount } } }
  }
}"""


def sync_catalog(shop: Shopify, conn, today: dt.date) -> dict:
    """Snapshot every variant's cost; record cost changes against the previous snapshot."""
    from .common import upsert
    with conn.cursor() as cur:
        cur.execute("select variant_id, unit_cost from jt.variants")
        prev = {v: (float(c) if c is not None else None) for v, c in cur.fetchall()}
    baseline = not prev
    rows, changes, after = [], [], None
    now = dt.datetime.now(dt.timezone.utc)
    while True:
        page = shop.graphql(VARIANTS_Q, {"first": 200, "after": after})["productVariants"]
        for v in page["nodes"]:
            vid, p = gid_num(v["id"]), v.get("product") or {}
            uc = ((v.get("inventoryItem") or {}).get("unitCost") or {}).get("amount")
            cost = money(uc) if uc is not None else None
            price = money(v.get("price")) if v.get("price") not in (None, "") else None
            rows.append((vid, gid_num(p.get("id")), v.get("sku") or "", p.get("title") or "",
                         "" if v.get("title") == "Default Title" else (v.get("title") or ""), v.get("displayName") or "",
                         p.get("vendor") or "", p.get("productType") or "", p.get("status") or "", price, cost,
                         v.get("updatedAt"), now))
            if baseline:
                continue
            if vid not in prev:
                if cost is not None:
                    changes.append((today, vid, None, cost, price, "new variant"))
            elif prev[vid] != cost:
                old = prev[vid]
                pct = (cost - old) / old if old and cost is not None else None
                flag = ("cost removed" if cost is None else "cost added" if old is None
                        else "cost above price" if price and cost > price
                        else "big change" if pct is not None and abs(pct) >= 0.4 else "")
                changes.append((today, vid, old, cost, price, flag))
        if not page["pageInfo"]["hasNextPage"]:
            break
        after = page["pageInfo"]["endCursor"]
    upsert(conn, "jt.variants", ["variant_id", "product_id", "sku", "product_title", "variant_title", "display_name",
                                 "vendor", "product_type", "status", "price", "unit_cost", "updated_at", "seen_at"],
           rows, ["variant_id"])
    upsert(conn, "jt.variant_cost_changes", ["changed_on", "variant_id", "old_cost", "new_cost", "price", "flag"],
           changes, ["changed_on", "variant_id"], update=["new_cost", "price", "flag"])
    return {"variants": len(rows), "changes": len(changes), "baseline": baseline,
            "no_cost": sum(1 for r in rows if r[10] is None)}
