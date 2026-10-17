"""Price match (migration 152; Brian, Oct 17 — ported from the jt-price-match package's price_match.py).

Every day, for each enabled brand (jt.pm_sources): the brand's own website prices (Shopify stores' /products.json,
matched by SKU) and the Amazon Buy Box (jt.pm_amazon_prices, filled by the "amazon" edge function's "buybox" action,
matched by UPC) are compared with Just Tennis's Shopify prices.

  * Lower: Just Tennis above the competitor -> the competitor's price, but never below the brand's MAP
    (jt.pm_map_floors) or cost x (1 + min margin %); compare-at = the brand's list price (or the original price).
  * Restore: a price this feature lowered (jt.pm_state) goes back once the brand's sale ends / Amazon is back up.
  * Never above the original price; one change per variant per run (the brand pass wins).

Review mode (default): changes are proposed on Sales > Price match; approving them starts job "price-match-apply".
Auto mode: applied at once, except drops over max_drop % (bad-data guard), which wait for review.
Writing prices needs the Shopify app's write_products scope; the run reports it if it's missing.
"""
from __future__ import annotations

import datetime as dt
import json
import time

import requests

from .common import gid_num

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "application/json"}

CATALOG_Q = """query($after: String) {
  productVariants(first: 200, after: $after, query: "product_status:active") {
    pageInfo { hasNextPage endCursor }
    nodes { id sku barcode title price compareAtPrice
            product { id title vendor productType status tags handle }
            inventoryItem { unitCost { amount } } }
  }
}"""
CURRENT_Q = """query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price compareAtPrice product { id } } } }"""
UPDATE_M = """mutation($pid: ID!, $v: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $pid, variants: $v) { productVariants { id price compareAtPrice } userErrors { field message } }
}"""
SCOPES_Q = """{ currentAppInstallation { accessScopes { handle } } }"""

EPS = 0.005


def _f(x):
    return None if x in (None, "") else round(float(x), 2)


def norm_sku(s, prefix=0):
    s = (s or "").strip().upper()
    return s[:prefix] if prefix else s


def _vkey(v):
    return "".join(ch for ch in (v or "").lower() if ch.isalpha())


# ---------------------------------------------------------------- brand sites (sync/price_sources.py)
from .price_sources import jt_keys, read as read_source  # noqa: E402


def fetch_brand(src: dict, session=None):
    """Kept for the package's original name: a Shopify-built brand site."""
    return read_source({**src, "kind": "shopify_site"}, session)


# ---------------------------------------------------------------- rules
def map_floor(floors: dict, vendor: str, sku: str):
    """MAP for this variant: the longest SKU prefix listed for its brand (floors = {brand key: {prefix: map}})."""
    table = floors.get(_vkey(vendor))
    if not table:
        return None
    sku = (sku or "").upper()
    best = None
    for pre, m in table.items():
        if sku.startswith(pre) and (best is None or len(pre) > best[0]):
            best = (len(pre), m)
    return best[1] if best else None


def lower_target(price: float, comp: float, floor_map, cost, cfg: dict):
    """(target, floor_applied) for lowering `price` toward competitor `comp`; target None = no change."""
    target, floor = comp, None
    if cfg.get("map_floor", True) and floor_map is not None and target < floor_map - EPS:
        target, floor = floor_map, "map"
    if cfg.get("cost_floor", True) and cost:
        cf = round(cost * (1 + float(cfg.get("min_margin", 5)) / 100), 2)
        if target < cf - EPS:
            target, floor = cf, "cost"
    target = round(target, 2)
    return (target, floor) if target < price - EPS else (None, floor)


def plan(variants: list[dict], brands: dict, amazon: dict | None, state: dict, floors: dict, cfg: dict, skip: set, markets: dict | None = None,
         market_vendors: set | None = None):
    """The changes for one run. Pure: no I/O.

    variants: [{vid, pid, title, vtitle, sku, barcode, vendor, price, cmp, cost}]
    brands:   {source name: {"prefix": n, "match": sku|base|barcode, "vendors": set(vendor keys), "prices": {...} or None}}
    amazon:   {upc: {asin, price}} or None when Amazon isn't covered this run
    markets:  retailers {name: {"prices": {barcode key: {...}} or None}} (Tennis Warehouse, Tennis Express)
    state:    {vid: {orig_price, orig_cmp, source}}   (active rows of jt.pm_state)
    skip:     variant ids not to touch (an approved change is still waiting to be applied)
    Returns (changes, stats).
    """
    changes, touched = [], set()
    stats = {name: {"matched": 0, "lowered": 0, "restored": 0, "floored": 0} for name in brands}
    stats["Amazon"] = {"matched": 0, "lowered": 0, "restored": 0, "floored": 0, "no_upc": 0}
    max_drop = float(cfg.get("max_drop", 40))

    def add(v, source, reason, new, new_cmp, comp=None, lst=None, ref="", url="", floor=None, mp=None):
        drop = (v["price"] - new) / v["price"] * 100 if v["price"] else 0
        changes.append({"vid": v["vid"], "pid": v["pid"], "title": v["title"], "vtitle": v["vtitle"], "sku": v["sku"], "vendor": v["vendor"],
                        "source": source, "comp": comp, "list": lst, "ref": ref, "url": url, "old": v["price"], "old_cmp": v["cmp"],
                        "new": round(new, 2), "new_cmp": None if new_cmp is None else round(new_cmp, 2), "cost": v["cost"], "map": mp,
                        "reason": reason, "floor": floor, "big": reason == "lower" and drop > max_drop + 1e-9})
        touched.add(v["vid"])

    # brand sites
    by_vendor = {}
    for name, b in brands.items():
        for vk in b["vendors"]:
            by_vendor[vk] = name
    for v in variants:
        if v["vid"] in skip:
            continue
        name = by_vendor.get(_vkey(v["vendor"]))
        if not name:
            continue
        b = brands[name]
        if b["prices"] is None:
            continue  # not covered this run: no lowering, and no restoring on missing data
        st = state.get(v["vid"])
        hit = next((b["prices"][k] for k in jt_keys(b.get("match", "sku"), b["prefix"], v["sku"], v["barcode"]) if k in b["prices"]), None)
        if hit:
            stats[name]["matched"] += 1
        P = v["price"]
        if hit and hit["available"] and P > hit["price"] + EPS:
            mp = map_floor(floors, v["vendor"], v["sku"])
            target, floor = lower_target(P, hit["price"], mp, v["cost"], cfg)
            if target is not None:
                orig = st["orig_price"] if st else P
                add(v, name, "lower", target, max(hit["list"], orig), hit["price"], hit["list"], hit["title"], hit["url"], floor, mp)
                stats[name]["lowered"] += 1
                stats[name]["floored"] += 1 if floor else 0
        elif st and st["source"] == name and (not hit or not hit["available"] or hit["price"] >= hit["list"] - EPS):
            target = min(st["orig_price"], hit["list"]) if hit else st["orig_price"]
            if abs(target - P) > EPS:
                add(v, name, "restore", target, st["orig_cmp"], hit["price"] if hit else None, hit["list"] if hit else None,
                    hit["title"] if hit else "", hit["url"] if hit else "")
                stats[name]["restored"] += 1

    # Retailers and Amazon (after the brand pass; never a variant the brand pass changed): matched by UPC; the lowest
    # available price among them is the one to meet. Same rules as the spec's Amazon rule: compare-at = max(existing
    # compare-at, original price); restore once the lowest of them is back at/above the original price.
    mk = {name: m for name, m in (markets or {}).items()}
    if amazon is not None and cfg.get("amazon", True):
        mk["Amazon"] = {"prices": {u: {"price": a["price"], "list": None, "title": a.get("asin", ""), "available": True,
                                       "url": f"https://www.amazon.com/dp/{a['asin']}", "ref": a.get("asin", "")} for u, a in amazon.items()},
                        "exact": True}
    for name in mk:
        stats.setdefault(name, {"matched": 0, "lowered": 0, "restored": 0, "floored": 0})
    stats["Amazon"].setdefault("no_upc", 0)
    covered = {n for n, m in mk.items() if m.get("prices") is not None}
    if covered:
        vendors = market_vendors if market_vendors is not None else {vk for b in brands.values() for vk in b["vendors"]}
        for v in variants:
            if v["vid"] in skip or v["vid"] in touched or _vkey(v["vendor"]) not in vendors:
                continue
            st = state.get(v["vid"])
            if not v["barcode"]:
                stats["Amazon"]["no_upc"] += 1
                if not (st and st["source"] in mk):
                    continue
            keys = jt_keys("barcode", 0, "", v["barcode"])
            hits = []
            for n in covered:
                m = mk[n]
                h = m["prices"].get(v["barcode"]) if m.get("exact") else next((m["prices"][k] for k in keys if k in m["prices"]), None)
                if h:
                    stats[n]["matched"] += 1
                    if h.get("available", True):
                        hits.append((h["price"], n, h))
            P = v["price"]
            best = min(hits, key=lambda x: x[0]) if hits else None
            if best and P > best[0] + EPS:
                comp, n, h = best
                mp = map_floor(floors, v["vendor"], v["sku"])
                target, floor = lower_target(P, comp, mp, v["cost"], cfg)
                if target is not None:
                    orig = st["orig_price"] if st else P
                    add(v, n, "lower", target, max(v["cmp"] or 0, orig) or None, comp, h.get("list"), h.get("ref") or h.get("title", ""),
                        h.get("url", ""), floor, mp)
                    stats[n]["lowered"] += 1
                    stats[n]["floored"] += 1 if floor else 0
            elif st and st["source"] in covered and (not best or best[0] >= st["orig_price"] - EPS):
                if abs(st["orig_price"] - P) > EPS:
                    n = st["source"]
                    add(v, n, "restore", st["orig_price"], st["orig_cmp"], best[0] if best else None, None,
                        (best[2].get("ref") or best[2].get("title", "")) if best else "", best[2].get("url", "") if best else "")
                    stats[n]["restored"] += 1
    return changes, stats


# ---------------------------------------------------------------- I/O
def _settings(conn) -> dict:
    with conn.cursor() as cur:
        cur.execute("select value from jt.settings where key = 'price_match'")
        r = cur.fetchone()
    return (r[0] if r else {}) or {}


def _excluded(p: dict, cfg: dict) -> bool:
    tags = {t.lower() for t in (p.get("tags") or [])}
    if tags & {t.lower() for t in cfg.get("exclude_tags", ["JTonly", "no-price-match"])}:
        return True
    title, ptype = (p.get("title") or "").lower(), (p.get("productType") or "").lower()
    if title.startswith("used"):
        return True
    return any(w.lower() in ptype for w in cfg.get("exclude_types", ["Used", "Service", "Gift"]))


def load_catalog(shop, vendor_keys: set, cfg: dict) -> list[dict]:
    out, after = [], None
    while True:
        page = shop.graphql(CATALOG_Q, {"after": after})["productVariants"]
        for v in page["nodes"]:
            p = v.get("product") or {}
            if _vkey(p.get("vendor")) not in vendor_keys or (p.get("status") or "").upper() != "ACTIVE" or _excluded(p, cfg):
                continue
            price = _f(v.get("price"))
            if price is None or price <= 0:
                continue
            uc = ((v.get("inventoryItem") or {}).get("unitCost") or {}).get("amount")
            out.append({"vid": gid_num(v["id"]), "pid": gid_num(p.get("id")), "title": p.get("title") or "",
                        "vtitle": "" if v.get("title") == "Default Title" else (v.get("title") or ""), "sku": v.get("sku") or "",
                        "barcode": (v.get("barcode") or "").strip(), "vendor": p.get("vendor") or "", "price": price,
                        "cmp": _f(v.get("compareAtPrice")), "cost": _f(uc) or None})
        if not page["pageInfo"]["hasNextPage"]:
            break
        after = page["pageInfo"]["endCursor"]
    return out


def _scopes(shop) -> set:
    try:
        return {s["handle"] for s in shop.graphql(SCOPES_Q)["currentAppInstallation"]["accessScopes"]}
    except Exception:  # noqa: BLE001 - only used to explain a failure
        return set()


def run(shop, conn, preview: bool = False, started_by: str = "schedule") -> dict:
    """One price match run. preview=True (Run now): propose only, whatever the mode."""
    cfg = _settings(conn)
    mode = "review" if preview or cfg.get("mode", "review") != "auto" else "auto"
    with conn.cursor() as cur:
        cur.execute("insert into jt.pm_runs (mode, started_by) values (%s, %s) returning id", (mode, started_by))
        run_id = cur.fetchone()[0]
    conn.commit()
    summary = {"sources": {}, "amazon": {}}
    try:
        with conn.cursor() as cur:
            cur.execute("""select name, kind, base_url, collections, sku_prefix, vendors, match, options
                           from jt.pm_sources where enabled order by sort, name""")
            sources = [dict(zip(["name", "kind", "base_url", "collections", "sku_prefix", "vendors", "match", "options"], r)) for r in cur.fetchall()]
            cur.execute("""select distinct on (brand, sku_prefix) brand, sku_prefix, map_price from jt.pm_map_floors
                           where active and effective_from <= (now() at time zone 'America/Los_Angeles')::date
                           order by brand, sku_prefix, effective_from desc""")
            floors: dict = {}
            for brand, pre, mp in cur.fetchall():
                floors.setdefault(_vkey(brand), {})[pre.upper()] = float(mp)
            cur.execute("select variant_id, orig_price, orig_compare_at, source from jt.pm_state where active")
            state = {r[0]: {"orig_price": float(r[1]), "orig_cmp": _f(r[2]), "source": r[3]} for r in cur.fetchall()}
            cur.execute("select distinct variant_id from jt.pm_changes where status in ('approved', 'rollback')")
            skip = {r[0] for r in cur.fetchall()}
            # Amazon prices are fresh if most were checked in the last 30 hours (the edge function runs before this job)
            cur.execute("""select u.upc, u.asin, a.price from jt.pm_upc_asin u join jt.pm_amazon_prices a on a.asin = u.asin
                           where u.asin <> '' and a.price is not null and a.checked_at > now() - interval '30 hours'""")
            amazon_rows = cur.fetchall()
            cur.execute("select count(*), count(*) filter (where checked_at > now() - interval '30 hours') from jt.pm_amazon_prices")
            n_amz, n_fresh = cur.fetchone()
        # every brand's products (a brand whose own site is off, e.g. Tecnifibre, is still matched to retailers and Amazon)
        with conn.cursor() as cur:
            cur.execute("select coalesce(array_agg(v), '{}') from jt.pm_sources s, unnest(s.vendors) v where not coalesce((s.options->>'retail')::boolean, false)")
            vendor_keys = {_vkey(v) for v in cur.fetchone()[0]}
        variants = load_catalog(shop, vendor_keys, cfg)

        brands, markets = {}, {}
        sess = requests.Session()
        for s in sources:
            retail = bool((s.get("options") or {}).get("retail"))
            vk = {_vkey(v) for v in s["vendors"]} if not retail else vendor_keys
            keys = {k for v in variants if _vkey(v["vendor"]) in vk for k in jt_keys(s["match"], s["sku_prefix"], v["sku"], v["barcode"])}
            prices, err = read_source({**s, "_conn": conn}, sess, keys)
            if retail:
                markets[s["name"]] = {"prices": prices}
            else:
                brands[s["name"]] = {"prefix": s["sku_prefix"], "match": s["match"], "vendors": vk, "prices": prices}
            st = "ok" if prices is not None else "not covered"
            summary["sources"][s["name"]] = {"status": st, "skus": len(prices or {}), "error": err or ""}
            with conn.cursor() as cur:
                cur.execute("update jt.pm_sources set status = %s, last_error = %s, last_count = %s, checked_at = now() where name = %s",
                            (st, err or "", len(prices) if prices is not None else None, s["name"]))
            conn.commit()

        amazon = None
        if not cfg.get("amazon", True):
            summary["amazon"] = {"status": "off"}
        elif n_amz and n_fresh >= 0.5 * n_amz:
            amazon = {upc: {"asin": asin, "price": float(price)} for upc, asin, price in amazon_rows}
            summary["amazon"] = {"status": "ok", "prices": len(amazon)}
        else:
            summary["amazon"] = {"status": "not covered", "error": "no fresh Amazon prices (the buybox step hasn't run today)" if n_amz else "no Amazon prices yet"}

        changes, stats = plan(variants, brands, amazon, state, floors, cfg, skip, markets, vendor_keys)
        for name, s in stats.items():
            (summary["amazon"] if name == "Amazon" else summary["sources"].setdefault(name, {})).update(s)

        with conn.cursor() as cur:
            # yesterday's proposals that weren't decided give way to today's
            cur.execute("update jt.pm_changes set status = 'superseded' where status in ('proposed', 'failed') and run_id <> %s", (run_id,))
            for c in changes:
                st = "approved" if mode == "auto" and not c["big"] else "proposed"
                cur.execute("""insert into jt.pm_changes (run_id, product_id, variant_id, product_title, variant_title, sku, vendor, source,
                                 competitor_price, competitor_list, competitor_ref, competitor_url, old_price, old_compare_at, new_price,
                                 new_compare_at, cost, map_price, reason, floor_applied, big_drop, status, decided_by, decided_at)
                               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, case when %s = 'approved' then now() end)""",
                            (run_id, c["pid"], c["vid"], c["title"], c["vtitle"], c["sku"], c["vendor"], c["source"], c["comp"], c["list"],
                             c["ref"][:300], c["url"][:500], c["old"], c["old_cmp"], c["new"], c["new_cmp"], c["cost"], c["map"], c["reason"],
                             c["floor"], c["big"], st, "auto" if st == "approved" else "", st))
        conn.commit()

        applied = apply(shop, conn) if mode == "auto" else {}
        tot = {"lowered": sum(1 for c in changes if c["reason"] == "lower"), "restored": sum(1 for c in changes if c["reason"] == "restore"),
               "big": sum(1 for c in changes if c["big"]), "variants": len(variants),
               "not_covered": sorted([n for n, s in summary["sources"].items() if s.get("status") != "ok"]
                                     + (["Amazon"] if summary["amazon"].get("status") == "not covered" else []))}
        if mode == "auto":
            tot.update(applied)
        summary["totals"] = tot
        with conn.cursor() as cur:
            cur.execute("update jt.pm_runs set status = 'done', finished_at = now(), summary = %s where id = %s", (json.dumps(summary), run_id))
        conn.commit()
        return {"run": run_id, **tot}
    except Exception as e:
        conn.rollback()
        with conn.cursor() as cur:
            cur.execute("update jt.pm_runs set status = 'failed', finished_at = now(), error = %s, summary = %s where id = %s",
                        (str(e)[:500], json.dumps(summary), run_id))
        conn.commit()
        raise


def apply(shop, conn) -> dict:
    """Write approved changes (status approved) and rollbacks (status rollback) to Shopify, one call per product.

    Before writing, each variant's price must still be what the change expects (old price for a change, new price for
    a rollback); otherwise it's marked failed — someone changed the price in Shopify in the meantime.
    """
    with conn.cursor() as cur:
        cur.execute("""select id, product_id, variant_id, status, reason, source, old_price, old_compare_at, new_price, new_compare_at
                       from jt.pm_changes where status in ('approved', 'rollback') order by id""")
        cols = ["id", "pid", "vid", "status", "reason", "source", "old", "old_cmp", "new", "new_cmp"]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    if not rows:
        return {"applied": 0, "rolled_back": 0, "failed": 0}
    for r in rows:
        for k in ("old", "old_cmp", "new", "new_cmp"):
            r[k] = _f(r[k])
    # what Shopify has now
    now = {}
    ids = [f"gid://shopify/ProductVariant/{r['vid']}" for r in rows]
    for i in range(0, len(ids), 100):
        for n in shop.graphql(CURRENT_Q, {"ids": ids[i:i + 100]})["nodes"]:
            if n:
                now[gid_num(n["id"])] = (_f(n["price"]), _f(n.get("compareAtPrice")))
    res = {"applied": 0, "rolled_back": 0, "failed": 0}
    scopes = None
    by_pid: dict = {}
    for r in rows:
        if r["vid"] in {x["vid"] for x in by_pid.get(r["pid"], [])}:
            _mark(conn, r, "failed", "another change for this variant is being applied")
            res["failed"] += 1
            continue
        by_pid.setdefault(r["pid"], []).append(r)
    for pid, rs in by_pid.items():
        ok_rows, payload = [], []
        for r in rs:
            rb = r["status"] == "rollback"
            expect = r["new"] if rb else r["old"]
            cur_p = now.get(r["vid"], (None, None))[0]
            if cur_p is None:
                _mark(conn, r, "failed" if not rb else "applied", "variant not found in Shopify (deleted or not active)")
                res["failed"] += 1
                continue
            if abs(cur_p - expect) > EPS:
                _mark(conn, r, "failed" if not rb else "applied",
                      f"the price in Shopify is now ${cur_p:.2f}, not ${expect:.2f} — changed since this was proposed")
                res["failed"] += 1
                continue
            price, cmp_ = (r["old"], r["old_cmp"]) if rb else (r["new"], r["new_cmp"])
            if cmp_ is not None and cmp_ <= price + EPS:
                cmp_ = None  # a compare-at at or under the price shows no sale; clear it
            payload.append({"id": f"gid://shopify/ProductVariant/{r['vid']}", "price": f"{price:.2f}",
                            "compareAtPrice": f"{cmp_:.2f}" if cmp_ is not None else None})
            ok_rows.append((r, price))
        if not payload:
            continue
        try:
            out = shop.graphql(UPDATE_M, {"pid": f"gid://shopify/Product/{pid}", "v": payload})["productVariantsBulkUpdate"]
            if out["userErrors"]:
                raise RuntimeError("; ".join(e["message"] for e in out["userErrors"]))
        except Exception as e:  # noqa: BLE001 - record and carry on
            msg = str(e)[:400]
            if "access" in msg.lower() or "scope" in msg.lower() or "denied" in msg.lower():
                scopes = scopes if scopes is not None else _scopes(shop)
                if scopes and "write_products" not in scopes:
                    msg = "the Shopify app needs the write_products scope to change prices — " + msg
            for r, _ in ok_rows:
                _mark(conn, r, "failed" if r["status"] == "approved" else "applied", msg)
                res["failed"] += 1
            continue
        for r, price in ok_rows:
            with conn.cursor() as cur:
                if r["status"] == "rollback":
                    cur.execute("update jt.pm_changes set status = 'rolled_back', rolled_back_at = now(), error = '' where id = %s", (r["id"],))
                    if r["reason"] == "lower":
                        cur.execute("update jt.pm_state set active = false where variant_id = %s and change_id = %s", (r["vid"], r["id"]))
                    else:  # a restore rolled back: the price is lowered again
                        cur.execute("update jt.pm_state set active = true where variant_id = %s", (r["vid"],))
                    res["rolled_back"] += 1
                else:
                    cur.execute("update jt.pm_changes set status = 'applied', applied_at = now(), error = '' where id = %s", (r["id"],))
                    if r["reason"] == "lower":
                        cur.execute("""insert into jt.pm_state (variant_id, product_id, orig_price, orig_compare_at, source, change_id)
                                       values (%s, %s, %s, %s, %s, %s)
                                       on conflict (variant_id) do update set
                                         orig_price = case when jt.pm_state.active then jt.pm_state.orig_price else excluded.orig_price end,
                                         orig_compare_at = case when jt.pm_state.active then jt.pm_state.orig_compare_at else excluded.orig_compare_at end,
                                         change_id = case when jt.pm_state.active then jt.pm_state.change_id else excluded.change_id end,
                                         lowered_at = case when jt.pm_state.active then jt.pm_state.lowered_at else now() end,
                                         source = excluded.source, product_id = excluded.product_id, active = true""",
                                    (r["vid"], r["pid"], r["old"], r["old_cmp"], r["source"], r["id"]))
                    else:
                        cur.execute("update jt.pm_state set active = false where variant_id = %s", (r["vid"],))
                    res["applied"] += 1
                cur.execute("update jt.variants set price = %s where variant_id = %s", (price, r["vid"]))
            conn.commit()
        time.sleep(0.2)
    return res


def _mark(conn, r, status, err):
    with conn.cursor() as cur:
        cur.execute("update jt.pm_changes set status = %s, error = %s where id = %s", (status, err[:500], r["id"]))
    conn.commit()
