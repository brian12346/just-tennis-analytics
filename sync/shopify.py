"""Shopify Admin API client (GraphQL + ShopifyQL) and the Shopify sync jobs.

Auth: a Dev Dashboard app installed on the store, using the client credentials grant
(SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET), or a legacy custom-app token (SHOPIFY_ACCESS_TOKEN).
Scopes needed: read_orders, read_products, read_inventory, read_reports (+ protected customer data level 2
for ShopifyQL), read_all_orders to reach orders older than 60 days, and write_inventory to write costs typed in
the dashboard back to Shopify (apply_cost_updates).
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
    def graphql(self, query: str, variables: dict | None = None, version: str = API_VERSION) -> dict:
        url = f"{self.base}/admin/api/{version}/graphql.json"
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
      fulfillments(first: 10) { trackingInfo(first: 10) { number company } }
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
        orders, lines, tracks = [], [], []
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
            # tracking numbers from the order's fulfillments (to match combined shipments to their label)
            for f in o.get("fulfillments") or []:
                for ti in f.get("trackingInfo") or []:
                    num = "".join(str(ti.get("number") or "").split()).upper()
                    if num:
                        tracks.append((oid, num, ti.get("company") or ""))
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
                cur.execute("delete from jt.shopify_order_tracking where order_id = any(%s)", ([r[0] for r in orders],))
        upsert(conn, "jt.shopify_order_lines", lcols, lines, ["line_id"])
        upsert(conn, "jt.shopify_order_tracking", ["order_id", "tracking", "company"], tracks, ["order_id", "tracking"])
        conn.commit()
        n += len(orders)
        if not page["pageInfo"]["hasNextPage"]:
            return n
        after = page["pageInfo"]["endCursor"]


VARIANTS_Q = """query($first: Int!, $after: String) {
  productVariants(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id sku barcode title displayName price updatedAt inventoryQuantity
            product { id title vendor productType status }
            inventoryItem { id tracked unitCost { amount } } }
  }
}"""


def sync_catalog(shop: Shopify, conn, today: dt.date) -> dict:
    """Snapshot every variant's cost; record cost changes against the previous snapshot."""
    from .common import upsert
    with conn.cursor() as cur:
        cur.execute("""select variant_id, unit_cost, sku, product_title, variant_title, vendor, product_type, status, price,
                              inventory_qty, barcode from jt.variants""")
        snap = {r[0]: r for r in cur.fetchall()}
        prev = {v: (float(r[1]) if r[1] is not None else None) for v, r in snap.items()}
    baseline = not prev
    rows, changes, log, after = [], [], [], None
    now = dt.datetime.now(dt.timezone.utc)
    while True:
        page = shop.graphql(VARIANTS_Q, {"first": 200, "after": after})["productVariants"]
        for v in page["nodes"]:
            vid, p = gid_num(v["id"]), v.get("product") or {}
            inv = v.get("inventoryItem") or {}
            uc = (inv.get("unitCost") or {}).get("amount")
            cost = money(uc) if uc is not None else None
            price = money(v.get("price")) if v.get("price") not in (None, "") else None
            rows.append((vid, gid_num(p.get("id")), v.get("sku") or "", p.get("title") or "",
                         "" if v.get("title") == "Default Title" else (v.get("title") or ""), v.get("displayName") or "",
                         p.get("vendor") or "", p.get("productType") or "", p.get("status") or "", price, cost,
                         v.get("updatedAt"), now, gid_num(inv.get("id")) if inv.get("id") else None,
                         v.get("inventoryQuantity"), inv.get("tracked"), (v.get("barcode") or "").strip()))
            if baseline:
                continue
            log_changes(log, now, snap.get(vid), rows[-1])
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
                                 "vendor", "product_type", "status", "price", "unit_cost", "updated_at", "seen_at",
                                 "inventory_item_id", "inventory_qty", "tracked", "barcode"],
           rows, ["variant_id"])
    upsert(conn, "jt.variant_cost_changes", ["changed_on", "variant_id", "old_cost", "new_cost", "price", "flag"],
           changes, ["changed_on", "variant_id"], update=["new_cost", "price", "flag"])
    # Variants Shopify no longer has (deleted there): mark removed, keep the row for history. Skipped if this fetch
    # returned under half of what we had, which would mean a partial fetch rather than a cleanup.
    removed = restored = 0
    with conn.cursor() as cur:
        cur.execute("update jt.variants set removed_at = null where seen_at >= %s and removed_at is not null returning variant_id", (now,))
        back = [r[0] for r in cur.fetchall()]; restored = len(back)
        gone = []
        if len(rows) >= 0.5 * len(prev):
            cur.execute("update jt.variants set removed_at = now() where seen_at < %s and removed_at is null returning variant_id", (now,))
            gone = [r[0] for r in cur.fetchall()]; removed = len(gone)
        if not baseline:
            log += [(now, v, "restored", None, None) for v in back] + [(now, v, "removed", None, None) for v in gone]
            if log:
                cur.executemany("insert into jt.catalog_changes (synced_at, variant_id, kind, old, new) values (%s, %s, %s, %s, %s)", log)
            cur.execute("delete from jt.catalog_changes where synced_at < now() - interval '120 days'")
    return {"variants": len(rows), "changes": len(changes), "baseline": baseline,
            "no_cost": sum(1 for r in rows if r[10] is None), "removed": removed, "restored": restored, "logged": len(log)}


def _txt(v):
    if v is None:
        return None
    if isinstance(v, float) or hasattr(v, "quantize"):
        return f"{float(v):.2f}"
    return str(v)


def log_changes(log: list, now, old, new) -> None:
    """One catalog change row per field that changed: (synced_at, variant_id, kind, old, new)."""
    vid = new[0]
    if old is None:
        log.append((now, vid, "new", None, None))
        return
    # old: variant_id, unit_cost, sku, product_title, variant_title, vendor, product_type, status, price, inventory_qty, barcode
    # new: vid, pid, sku, ptitle, vtitle, display, vendor, ptype, status, price, cost, updated, now, item, qty, tracked, barcode
    num = lambda x: None if x is None else round(float(x), 2)  # noqa: E731
    title = lambda t, v: t + (" - " + v if v else "")  # noqa: E731
    pairs = [("cost", num(old[1]), num(new[10])), ("price", num(old[8]), num(new[9])),
             ("stock", old[9], new[14]), ("status", old[7] or "", new[8] or ""),
             ("title", title(old[3] or "", old[4] or ""), title(new[3] or "", new[4] or "")),
             ("sku", old[2] or "", new[2] or ""), ("barcode", old[10] or "", new[16] or ""),
             ("vendor", old[5] or "", new[6] or ""), ("type", old[6] or "", new[7] or "")]
    for kind, a, b in pairs:
        if kind == "stock" and b is None:
            continue
        if a != b:
            log.append((now, vid, kind, _txt(a), _txt(b)))


COST_UPDATE_M = """mutation($id: ID!, $input: InventoryItemInput!) {
  inventoryItemUpdate(id: $id, input: $input) {
    inventoryItem { id unitCost { amount } }
    userErrors { field message }
  }
}"""


PRICE_UPDATE_M = """mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price }
    userErrors { field message }
  }
}"""


def apply_cost_updates(shop: Shopify, conn, today: dt.date) -> int:
    """Write costs and prices set in the dashboard (jt.cost_updates, status pending) to Shopify.

    A row carries a new cost, a new retail price, or both (prices come from approved invoice lines).
    On success the catalog copy is updated at once and cost changes are logged in jt.variant_cost_changes.
    Costs need the app's write_inventory scope, prices write_products; a rejected update is marked failed
    with Shopify's message.
    """
    with conn.cursor() as cur:
        cur.execute("""select u.id, u.variant_id, coalesce(u.inventory_item_id, v.inventory_item_id), v.unit_cost, u.new_cost, v.price,
                              u.new_price, coalesce(u.product_id, v.product_id)
                       from jt.cost_updates u left join jt.variants v using (variant_id)
                       where u.status = 'pending' order by u.id""")
        todo = cur.fetchall()
    done = 0
    for uid, vid, item_id, old, new, price, new_price, pid in todo:
        errs, cost_ok, price_ok = [], False, False
        if new is not None:
            try:
                if not item_id:
                    raise RuntimeError("no Shopify inventory item for this variant yet (it appears after the nightly catalog sync)")
                out = shop.graphql(COST_UPDATE_M, {"id": f"gid://shopify/InventoryItem/{item_id}", "input": {"cost": str(new)}})
                ue = out["inventoryItemUpdate"]["userErrors"]
                if ue:
                    raise RuntimeError("; ".join(e["message"] for e in ue))
                cost_ok = True
            except Exception as e:  # noqa: BLE001 - record and carry on with the rest
                errs.append("cost: " + str(e)[:240])
        if new_price is not None:
            try:
                if not pid:
                    raise RuntimeError("no Shopify product for this variant")
                out = shop.graphql(PRICE_UPDATE_M, {"productId": f"gid://shopify/Product/{pid}",
                                                    "variants": [{"id": f"gid://shopify/ProductVariant/{vid}", "price": str(new_price)}]})
                ue = out["productVariantsBulkUpdate"]["userErrors"]
                if ue:
                    raise RuntimeError("; ".join(e["message"] for e in ue))
                price_ok = True
            except Exception as e:  # noqa: BLE001
                errs.append("price: " + str(e)[:240])
        with conn.cursor() as cur:
            if errs:
                cur.execute("update jt.cost_updates set status = 'failed', error = %s, applied_at = now() where id = %s", ("; ".join(errs)[:500], uid))
            else:
                cur.execute("update jt.cost_updates set status = 'done', error = '', applied_at = now() where id = %s", (uid,))
                done += 1
            if price_ok:
                cur.execute("update jt.variants set price = %s where variant_id = %s", (new_price, vid))
                price = new_price
            if cost_ok:
                cur.execute("update jt.variants set unit_cost = %s where variant_id = %s", (new, vid))
                if old is None or float(old) != float(new):
                    flag = "cost above price" if price is not None and new > price else "set in dashboard"
                    cur.execute("""insert into jt.variant_cost_changes (changed_on, variant_id, old_cost, new_cost, price, flag)
                                   values (%s, %s, %s, %s, %s, %s)
                                   on conflict (changed_on, variant_id) do update set new_cost = excluded.new_cost, price = excluded.price, flag = excluded.flag""",
                                (today, vid, old, new, price, flag))
        conn.commit()
    return done


# ---------------------------------------------------------------- Amazon FBM orders -> Shopify stock
# Amazon FBM orders ship from the store's stock. When an order is confirmed on the dashboard's FBM tab
# (jt.fbm_decide -> jt.fbm_decisions, status pending), the units come off Shopify's "available" quantity at the
# store's location. Newer API versions want the quantity we expect to change from and an idempotency key (so a
# retried request can't take the units twice); older ones refuse those, so each is dropped if Shopify rejects it.
# Where the units come from: the location the item is stocked at. The app has no read_locations scope, so locations
# are only seen through the item's inventory levels (ids, no names). With one location that's it; with several,
# jt.settings fbm_sync.location_id says which one FBM orders ship from.
LEVELS_Q = """query($item: ID!) { inventoryItem(id: $item) { tracked inventoryLevels(first: 10) { nodes {
  location { id } quantities(names: ["available"]) { name quantity } } } } }"""
ADJUST_M = """mutation($input: InventoryAdjustQuantitiesInput!{IDEM}) {
  inventoryAdjustQuantities(input: $input){IDEMUSE} {
    inventoryAdjustmentGroup { id changes { name delta quantityAfterChange } }
    userErrors { field message code }
  }
}"""


LOCATIONS_Q = """{ locations(first: 50) { nodes { id name isActive } } }"""


def _fbm_save_locations(shop: "Shopify", conn) -> dict:
    """The store's active locations (needs read_locations) -> jt.settings fbm_sync.locations, for names on the page.
    Returns {id: name}; {} when Shopify won't say (the job still works with ids)."""
    import json
    try:
        nodes = [n for n in shop.graphql(LOCATIONS_Q)["locations"]["nodes"] if n.get("isActive")]
    except Exception:  # noqa: BLE001 - no read_locations scope: carry on without names
        return {}
    locs = [{"id": n["id"], "name": n.get("name") or ""} for n in nodes]
    with conn.cursor() as cur:
        cur.execute("""insert into jt.settings (key, value) values ('fbm_sync', %s::jsonb)
                       on conflict (key) do update set value = jt.settings.value || excluded.value, updated_at = now()""",
                    (json.dumps({"locations": locs}),))
    conn.commit()
    return {x["id"]: x["name"] for x in locs}


def _fbm_location_setting(conn) -> str | None:
    with conn.cursor() as cur:
        cur.execute("select value->>'location_id' from jt.settings where key = 'fbm_sync'")
        row = cur.fetchone()
    return row[0] if row and row[0] else None


def apply_fbm_adjustments(shop: "Shopify", conn) -> int:
    """Take confirmed Amazon FBM orders out of Shopify's available stock (jt.fbm_decisions, status pending)."""
    with conn.cursor() as cur:
        cur.execute("""select order_id, sku, inventory_item_id, units, extract(epoch from decided_at)::bigint
                       from jt.fbm_decisions where decision = 'decrement' and status = 'pending' order by decided_at""")
        todo = cur.fetchall()
    names = _fbm_save_locations(shop, conn)
    if not todo:
        return 0
    loc_setting = _fbm_location_setting(conn)
    done = 0
    for oid, sku, item, units, stamp in todo:
        before, err, loc = None, "", None
        try:
            lv = shop.graphql(LEVELS_Q, {"item": f"gid://shopify/InventoryItem/{item}"})["inventoryItem"]
            if not lv:
                raise RuntimeError("Shopify doesn't have this inventory item any more")
            if not lv.get("tracked"):
                raise RuntimeError("Shopify doesn't track inventory for this product, so there's nothing to take out")
            levels = (lv.get("inventoryLevels") or {}).get("nodes") or []
            if loc_setting:
                level = next((x for x in levels if x["location"]["id"] == loc_setting), None)
                if not level:
                    raise RuntimeError("this product isn't stocked at the Shopify location FBM orders ship from")
            elif len(levels) == 1:
                level = levels[0]
            elif not levels:
                raise RuntimeError("this product isn't stocked at any Shopify location")
            else:
                where = ", ".join(names.get(x["location"]["id"], x["location"]["id"].split("/")[-1]) for x in levels)
                raise RuntimeError(f"this product is stocked at {len(levels)} Shopify locations ({where}); choose the one FBM "
                                   "orders ship from at the top of this page")
            loc = level["location"]["id"]
            before = next((q["quantity"] for q in level["quantities"] if q["name"] == "available"), None)
            change = {"inventoryItemId": f"gid://shopify/InventoryItem/{item}", "locationId": loc, "delta": -int(units)}
            key = f"jt-fbm-{oid}-{sku}-{stamp}"[:255]
            attempts = [(True, True), (False, True), (True, False), (False, False)]   # (changeFromQuantity, idempotency key)
            last = None
            for with_from, with_key in attempts:
                ch = dict(change, **({"changeFromQuantity": before} if with_from and before is not None else {}))
                q = ADJUST_M.replace("{IDEM}", ", $key: String!" if with_key else "").replace("{IDEMUSE}", " @idempotent(key: $key)" if with_key else "")
                vars_ = {"input": {"reason": "correction", "name": "available",
                                   "referenceDocumentUri": f"gid://just-tennis/AmazonOrder/{oid}", "changes": [ch]}}
                if with_key:
                    vars_["key"] = key
                try:
                    out = shop.graphql(q, vars_)["inventoryAdjustQuantities"]
                except RuntimeError as e:
                    m = str(e).lower()
                    # the API version doesn't know the field/directive: try the next form; anything else is real
                    if ("changefromquantity" in m or "idempotent" in m or "directive" in m) and (with_from or with_key):
                        last = e
                        continue
                    raise
                ue = out.get("userErrors") or []
                if ue:
                    msg = "; ".join(x["message"] for x in ue)
                    if ("changeFromQuantity" in msg or "idempot" in msg.lower()) and (with_from or with_key):
                        last = RuntimeError(msg)
                        continue
                    raise RuntimeError(msg)
                last = None
                break
            if last is not None:
                raise last
        except Exception as e:  # noqa: BLE001 - record it on the order and carry on
            err = str(e)[:500]
        with conn.cursor() as cur:
            if err:
                cur.execute("""update jt.fbm_decisions set status = 'failed', error = %s, applied_at = now(), shopify_before = %s
                               where order_id = %s and sku = %s and status = 'pending'""", (err, before, oid, sku))
            else:
                cur.execute("""update jt.fbm_decisions set status = 'done', error = '', applied_at = now(), shopify_before = %s,
                               location_id = %s where order_id = %s and sku = %s and status = 'pending'""", (before, loc, oid, sku))
                cur.execute("update jt.variants set inventory_qty = coalesce(inventory_qty, 0) - %s where inventory_item_id = %s", (units, item))
                cur.execute("""update jt.location_stock set available = available - %s, updated_at = now()
                               where location_id = %s and inventory_item_id = %s""", (units, loc, item))
                done += 1
        conn.commit()
    return done


# Stock at the FBM location, for the FBM stock tab's listings panel (jt.location_stock). One page of 250 inventory
# levels per call; items no longer stocked there are set to 0.
LOCATION_STOCK_Q = """query($loc: ID!, $after: String) { location(id: $loc) { inventoryLevels(first: 250, after: $after) {
  nodes { item { id } quantities(names: ["available"]) { name quantity } } pageInfo { hasNextPage endCursor } } } }"""


def sync_location_stock(shop: "Shopify", conn) -> int:
    """Available stock per inventory item at the FBM location (jt.settings fbm_sync.location_id) -> jt.location_stock."""
    loc = _fbm_location_setting(conn)
    if not loc:
        return 0
    rows, after = [], None
    while True:
        lv = (shop.graphql(LOCATION_STOCK_Q, {"loc": loc, "after": after}).get("location") or {}).get("inventoryLevels") or {}
        for n in lv.get("nodes") or []:
            item = int(str(n["item"]["id"]).split("/")[-1])
            qty = next((q["quantity"] for q in n.get("quantities") or [] if q["name"] == "available"), 0) or 0
            rows.append((loc, item, int(qty)))
        page = lv.get("pageInfo") or {}
        if not page.get("hasNextPage"):
            break
        after = page["endCursor"]
    with conn.cursor() as cur:
        cur.execute("create temp table _ls (location_id text, inventory_item_id bigint, available int) on commit drop")
        cur.executemany("insert into _ls values (%s, %s, %s)", rows)
        cur.execute("""insert into jt.location_stock (location_id, inventory_item_id, available, updated_at)
                       select location_id, inventory_item_id, available, now() from _ls
                       on conflict (location_id, inventory_item_id) do update set available = excluded.available, updated_at = now()""")
        cur.execute("""update jt.location_stock s set available = 0, updated_at = now()
                       where s.location_id = %s and s.available <> 0
                         and not exists (select 1 from _ls x where x.inventory_item_id = s.inventory_item_id)""", (loc,))
    conn.commit()
    return len(rows)


# ---------------------------------------------------------------- Shopify Payments payouts (finance dashboard)
# Needs the read_shopify_payments_payouts scope; without it the job records why and does nothing else.
PAYOUTS_Q = """query($after: String) { shopifyPaymentsAccount { payouts(first: 100, after: $after, sortKey: ISSUED_AT, reverse: true) {
  nodes { id issuedAt status net { amount currencyCode } } pageInfo { hasNextPage endCursor } } } }"""


def sync_shopify_payouts(shop: "Shopify", conn, months: int = 15) -> int:
    """Shopify Payments payouts from the last `months` months -> fin.shopify_payouts."""
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=31 * months)).isoformat()
    rows, after = [], None
    while True:
        try:
            acct = (shop.graphql(PAYOUTS_Q, {"after": after}) or {}).get("shopifyPaymentsAccount") or {}
        except RuntimeError as e:   # scope not granted yet: not a failure of the sync, just nothing to read
            if any(w in str(e).lower() for w in ("access denied", "scope", "not approved", "unauthorized")):
                print("shopify payouts: skipped —", str(e)[:200])
                return 0
            raise
        po = acct.get("payouts") or {}
        nodes = po.get("nodes") or []
        for n in nodes:
            net = n.get("net") or {}
            rows.append((n["id"].split("/")[-1], n.get("issuedAt"), n.get("status") or "", float(net.get("amount") or 0), net.get("currencyCode") or "USD"))
        page = po.get("pageInfo") or {}
        if not page.get("hasNextPage") or not nodes or (nodes[-1].get("issuedAt") or "") < cutoff:
            break
        after = page["endCursor"]
    if rows:
        with conn.cursor() as cur:
            cur.executemany("""insert into fin.shopify_payouts (id, issued_at, status, amount, currency, synced_at)
                               values (%s, %s, %s, %s, %s, now())
                               on conflict (id) do update set issued_at = excluded.issued_at, status = excluded.status,
                                 amount = excluded.amount, currency = excluded.currency, synced_at = now()""", rows)
        conn.commit()
    return len(rows)


# ---------------------------------------------------------------- Shopify purchase order status
# Shopify's purchase orders API (inventoryPurchaseOrders, scope read_inventory_purchase_orders) is a preview that
# live stores can't use yet. Try it: when the store is refused, record why and carry on; when it works, each linked
# PO (jt.prep_orders.shopify_po_url ends in /purchase_orders/<id>) gets Shopify's status.
PO_API_VERSIONS = ("2026-10", "unstable")
PO_QUERY = """query($after: String) { inventoryPurchaseOrders(first: 100, after: $after) {
  nodes { id name status } pageInfo { hasNextPage endCursor } } }"""


def sync_po_status(shop: Shopify, conn) -> int:
    import json
    import re
    with conn.cursor() as cur:
        cur.execute("select id, shopify_po_url from jt.prep_orders where shopify_po_url ~ '/purchase_orders/[0-9]+'")
        linked = {int(re.search(r"/purchase_orders/(\d+)", u).group(1)): oid for oid, u in cur.fetchall()}
    if not linked:
        return 0
    found, why, used = {}, "", ""
    for version in PO_API_VERSIONS:
        try:
            found, after = {}, None
            while True:
                data = shop.graphql(PO_QUERY, {"after": after}, version=version)
                conn_ = data["inventoryPurchaseOrders"]
                for n in conn_["nodes"]:
                    found[gid_num(n["id"])] = (n.get("status") or "", n.get("name") or "")
                if not conn_["pageInfo"]["hasNextPage"]:
                    break
                after = conn_["pageInfo"]["endCursor"]
            used, why = version, ""
            break
        except Exception as e:  # noqa: BLE001 - not open to this store (yet): note it and move on
            why = str(e)[:300]
    with conn.cursor() as cur:
        state = {"ok": bool(used), "version": used, "why": why, "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(), "pos": len(found)}
        cur.execute("""insert into jt.settings (key, value, updated_at) values ('shopify_po_api', %s::jsonb, now())
                       on conflict (key) do update set value = excluded.value, updated_at = now()""", (json.dumps(state),))
        n = 0
        for sid, oid in linked.items():
            if sid not in found:
                continue
            status = found[sid][0]
            cur.execute("""update jt.prep_orders set shopify_po_status = %s, shopify_po_status_at = now() where id = %s""", (status, oid))
            if re.search(r"RECEIVED|CLOSED", status or "") and "PARTIAL" not in (status or ""):
                cur.execute("""update jt.prep_orders set shopify_received_at = now(), shopify_received_by = 'Shopify'
                               where id = %s and shopify_received_at is null""", (oid,))
            n += 1
    conn.commit()
    return n
