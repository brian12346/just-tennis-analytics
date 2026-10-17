"""Brand-site readers for price match (Brian, Oct 17: "build special connectors for the non-shopify brands").

Each reader returns ({key: {price, list, title, available, url}}, None) or (None, reason). Keys are upper-case and
compared with Just Tennis's keys for the same variant (see jt_keys): the SKU (optionally its first N characters), the
SKU's base code (before the first "-", "(" or "_"), or the barcode.

Readers (jt.pm_sources.kind):
  shopify_site     /products.json, key = variant SKU (or the product handle: options.key = "handle")   Wilson, Selkirk, K-Swiss …
  shopify_barcode  /products.json + /products/<handle>.js per product, key = variant barcode            Yonex (us.yonex.com)
  sfcc_grid        Salesforce Commerce Cloud category grid (Search-UpdateGrid), key = product id         Babolat
  sfcc_search      SFCC search for each Just Tennis key; only a single hit counts                        New Balance, Dunlop US
  head_next        head.com (Next.js + Adobe Commerce): /_next/data/<build>/<locale>/<category>.json     Head
"""
from __future__ import annotations

import html as _html
import re
import time

import requests

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "text/html,application/json;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9"}
BUDGET = 6 * 60          # seconds per brand site at most (retailers: their own, below)


def _f(x):
    try:
        return None if x in (None, "") else round(float(x), 2)
    except (TypeError, ValueError):
        return None


def base_code(s: str) -> str:
    return re.split(r"[-(_\s]", (s or "").strip().upper(), maxsplit=1)[0]


def strip0(b: str) -> str:
    return re.sub(r"\D", "", b or "").lstrip("0")


def jt_keys(match: str, prefix: int, sku: str, barcode: str) -> list[str]:
    """Just Tennis's keys for one variant under a source's match rule."""
    if match == "base":
        k = base_code(sku)
        return [k] if k else []
    if match == "barcode":
        d = re.sub(r"\D", "", barcode or "")
        if len(d) < 8:
            return []
        out = [d.lstrip("0")]
        if len(d) == 12:
            out.append(d[1:11].lstrip("0"))   # a 10-digit dealer code: the UPC without its number-system and check digits
        return out
    s = (sku or "").strip().upper()
    return [s[:prefix] if prefix else s] if s else []


def _add(out: dict, k: str, price, lst, title: str, avail: bool, url: str):
    if not k or price is None or price <= 0:
        return
    lst = lst if lst and lst > price else price
    cur = out.get(k)
    if cur is None or (avail and (not cur["available"] or price < cur["price"])):
        out[k] = {"price": round(price, 2), "list": round(lst, 2), "title": (title or "")[:200], "available": bool(avail), "url": url or ""}


def _session(sess=None):
    s = sess or requests.Session()
    s.headers.update(UA)
    return s


def _get(s, url, **kw):
    for i in range(3):
        r = s.get(url, timeout=40, **kw)
        if r.status_code == 429:
            time.sleep(5 * (i + 1))
            continue
        return r
    return r


# ---------------------------------------------------------------- Shopify stores
def shopify_site(src: dict, sess=None, keys=None, pause=0.4):
    out, seen = {}, set()
    s = _session(sess)
    base = src["base_url"].rstrip("/")
    opt = src.get("options") or {}
    by_handle = opt.get("key") == "handle"
    for coll in src.get("collections") or ["all"]:
        path = "/products.json" if coll == "all" else f"/collections/{coll}/products.json"
        for page in range(1, 60):
            try:
                r = _get(s, f"{base}{path}?limit=250&page={page}")
            except requests.RequestException as e:
                return None, f"network error: {str(e)[:160]}"
            if r.status_code == 404 and page == 1 and coll != "all":
                break
            if r.status_code != 200 or "json" not in r.headers.get("content-type", ""):
                return None, f"HTTP {r.status_code} on {path} (not a Shopify store's products.json)"
            prods = r.json().get("products", [])
            if not prods:
                break
            for p in prods:
                if p.get("id") in seen:
                    continue
                seen.add(p.get("id"))
                url = f"{base}/products/{p.get('handle')}" if p.get("handle") else ""
                for v in p.get("variants", []):
                    k = (p.get("handle") or "").upper() if by_handle else (v.get("sku") or "").strip().upper()
                    if not by_handle and src.get("sku_prefix"):
                        k = k[:src["sku_prefix"]]
                    _add(out, k, _f(v.get("price")), _f(v.get("compare_at_price")), p.get("title"), bool(v.get("available")), url)
            time.sleep(pause)
    return out, None


def shopify_barcode(src: dict, sess=None, keys=None, pause=0.25):
    """Barcodes aren't in /products.json, so each product's /products/<handle>.js is read (prices there are in cents)."""
    s = _session(sess)
    base = src["base_url"].rstrip("/")
    handles, t0 = [], time.time()
    for page in range(1, 60):
        try:
            r = _get(s, f"{base}/products.json?limit=250&page={page}")
        except requests.RequestException as e:
            return None, f"network error: {str(e)[:160]}"
        if r.status_code != 200 or "json" not in r.headers.get("content-type", ""):
            return None, f"HTTP {r.status_code} on /products.json"
        prods = r.json().get("products", [])
        if not prods:
            break
        handles += [p["handle"] for p in prods if p.get("handle")]
        time.sleep(pause)
    out, failed = {}, 0
    for h in dict.fromkeys(handles):
        if time.time() - t0 > BUDGET:
            break
        try:
            r = _get(s, f"{base}/products/{h}.js")
            p = r.json() if r.status_code == 200 else None
        except (requests.RequestException, ValueError):
            p = None
        if not p:
            failed += 1
            continue
        for v in p.get("variants", []):
            pr = v.get("price")
            cmp_ = v.get("compare_at_price")
            _add(out, strip0(v.get("barcode")), pr / 100 if isinstance(pr, (int, float)) else None,
                 cmp_ / 100 if isinstance(cmp_, (int, float)) else None, p.get("title"), bool(v.get("available")), f"{base}/products/{h}")
        time.sleep(pause)
    if not out:
        return None, f"no barcodes read ({failed} product pages failed)"
    return out, None


# ---------------------------------------------------------------- Salesforce Commerce Cloud
_PID = re.compile(r'data-pid="([^"]+)"')


def _sfcc_tiles(page: str) -> list[tuple[str, float | None, float | None]]:
    """(product id, sale price, list price) per product tile of a Search-UpdateGrid answer."""
    marks = [(m.start(), m.group(1)) for m in _PID.finditer(page)]
    out, seen = [], set()
    for i, (pos, pid) in enumerate(marks):
        seg = page[pos: marks[i + 1][0] if i + 1 < len(marks) else len(page)]
        sale = re.search(r'class="[^"]*\bsales\b[^"]*"[\s\S]{0,400}?content="([\d.]+)"', seg)
        lst = re.search(r'class="[^"]*\b(?:strike-through|list)\b[^"]*"[\s\S]{0,400}?content="([\d.]+)"', seg)
        if not sale:
            sale = re.search(r'class="[^"]*\bvalue\b[^"]*"[^>]*content="([\d.]+)"', seg)
        if not sale or pid in seen:
            continue
        seen.add(pid)
        out.append((_html.unescape(pid), _f(sale.group(1)), _f(lst.group(1)) if lst else None))
    return out


def _sfcc_base(src):
    opt = src.get("options") or {}
    return f"{src['base_url'].rstrip('/')}/on/demandware.store/Sites-{opt['site']}-Site/{opt.get('locale', 'en_US')}/"


def sfcc_grid(src: dict, sess=None, keys=None, pause=0.6):
    s = _session(sess)
    opt = src.get("options") or {}
    base, out, t0 = _sfcc_base(src), {}, time.time()
    for cgid in opt.get("cgids", ["root"]):
        start, size = 0, 24
        while time.time() - t0 < BUDGET:
            try:
                r = _get(s, f"{base}Search-UpdateGrid", params={"cgid": cgid, "start": start, "sz": size})
            except requests.RequestException as e:
                return None, f"network error: {str(e)[:160]}"
            if r.status_code != 200:
                if out:
                    break
                return None, f"HTTP {r.status_code} on the product grid"
            tiles = _sfcc_tiles(r.text)
            if not tiles:
                break
            for pid, sale, lst in tiles:
                _add(out, pid.upper(), sale, lst, "", True, f"{src['base_url'].rstrip('/')}/search?q={pid}")
            start += len(tiles)
            time.sleep(pause)
    if not out:
        return None, "no products on the grid"
    return out, None


def sfcc_search(src: dict, sess=None, keys=None, pause=0.6):
    """Search the site for each Just Tennis key; a key counts only when the search finds exactly one product.
    options.variation (e.g. New Balance's "style"): read that colorway's own price with Product-Variation."""
    s = _session(sess)
    opt = src.get("options") or {}
    base, out, t0, n, errs = _sfcc_base(src), {}, time.time(), 0, 0
    var = opt.get("variation")
    for k in sorted(set(keys or [])):
        if time.time() - t0 > BUDGET:
            break
        try:
            r = _get(s, f"{base}Search-UpdateGrid", params={"q": k, "start": 0, "sz": 6})
        except requests.RequestException:
            errs += 1
            continue
        n += 1
        if r.status_code != 200:
            errs += 1
            if errs >= 5 and not out:
                return None, f"HTTP {r.status_code} on search"
            continue
        tiles = _sfcc_tiles(r.text)
        if len(tiles) != 1:
            time.sleep(pause)
            continue
        pid, sale, lst = tiles[0]
        if var:
            try:
                j = _get(s, f"{base}Product-Variation", params={"pid": pid, f"dwvar_{pid}_{var}": k, "quantity": 1}).json()
                p = j.get("product") or {}
                vals = [str(x.get("id", "")).upper() for a in p.get("variationAttributes") or [] if a.get("id") == var for x in a.get("values") or []]
                if vals and k not in vals:
                    time.sleep(pause)
                    continue
                pr = p.get("price") or {}
                sale = _f((pr.get("sales") or {}).get("value")) or sale
                lst = _f((pr.get("list") or {}).get("value")) or lst
            except (requests.RequestException, ValueError):
                pass
        _add(out, k, sale, lst, pid, True, f"{src['base_url'].rstrip('/')}/search?q={k}")
        time.sleep(pause)
    if not out and n and errs == n:
        return None, "every search failed"
    return out, None


# ---------------------------------------------------------------- head.com
def head_next(src: dict, sess=None, keys=None, pause=0.8):
    s = _session(sess)
    opt = src.get("options") or {}
    base = src["base_url"].rstrip("/")                    # https://www.head.com/en_US
    root, loc = base.rsplit("/", 1)
    try:
        r = _get(s, base + "/")
    except requests.RequestException as e:
        return None, f"network error: {str(e)[:160]}"
    m = re.search(r'"buildId":"([^"]+)"', r.text or "")
    if r.status_code != 200 or not m:
        return None, f"HTTP {r.status_code} on the home page (no Next.js build id)"
    bid, out, t0 = m.group(1), {}, time.time()
    for cat in opt.get("categories", ["shop-tennis", "shop-pickleball", "shop-padel", "shop-footwear", "shop-racquetball"]):
        page, pages = 1, 1
        while page <= pages and time.time() - t0 < BUDGET:
            try:
                r = _get(s, f"{root}/_next/data/{bid}/{loc}/{cat}.json", params={"page": page} if page > 1 else None)
                ps = r.json()["pageProps"]["runtimeData"]["categorySSRData"]["catalogServiceData"]["productSearch"]
            except (requests.RequestException, ValueError, KeyError, TypeError):
                break
            pages = min(int((ps.get("page_info") or {}).get("total_pages") or 1), 60)
            for it in ps.get("items") or []:
                p, pv = it.get("product") or {}, it.get("productView") or {}
                pr = ((p.get("price_range") or {}).get("minimum_price") or {})
                sale = _f((pr.get("final_price") or {}).get("value"))
                lst = _f((pr.get("regular_price") or {}).get("value"))
                _add(out, (p.get("sku") or "").upper(), sale, lst, p.get("name"), pv.get("inStock", True) is not False, pv.get("url") or "")
            page += 1
            time.sleep(pause)
    if not out:
        return None, "no products read from head.com"
    return out, None


# ---------------------------------------------------------------- retailers (Tennis Warehouse, Tennis Express)
# Retailers are matched by UPC across every brand. What maps a UPC to the retailer's product is cached in
# jt.pm_retail_map (src["_conn"]), filled a little each run, so a daily run only reads prices.
def _map_load(conn, source):
    with conn.cursor() as cur:
        cur.execute("select key, ref, checked_at from jt.pm_retail_map where source = %s", (source,))
        return {k: (r, t) for k, r, t in cur.fetchall()}


def _map_save(conn, source, rows):
    if not rows:
        return
    with conn.cursor() as cur:
        cur.executemany("""insert into jt.pm_retail_map (source, key, ref, checked_at) values (%s, %s, %s, now())
                           on conflict (source, key) do update set ref = excluded.ref, checked_at = now()""",
                        [(source, k, r) for k, r in rows])
    conn.commit()


def shopify_upc_search(src: dict, sess=None, keys=None, pause=0.35):
    """A Shopify store with its own SKUs (Tennis Express): each of our UPCs is looked up once with the store's
    predictive search (it searches barcodes) and remembered (rechecked monthly); every day each product found is read
    from /products/<handle>.js and the variant with that barcode gives the price."""
    import datetime as dt
    s, conn = _session(sess), src.get("_conn")
    base, name = src["base_url"].rstrip("/"), src["name"]
    t0, budget = time.time(), 8 * 60
    known = _map_load(conn, name) if conn else {}
    stale = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30)
    todo = [k for k in sorted(keys or []) if k not in known or (known[k][1] and known[k][1] < stale)]
    found, looked = [], 0
    for k in todo:                                     # look up new UPCs for half the time at most
        if time.time() - t0 > budget / 2:
            break
        r = None
        try:
            r = _get(s, f"{base}/search/suggest.json", params={"q": k.zfill(12), "resources[type]": "product", "resources[limit]": 1})
            ps = ((r.json().get("resources") or {}).get("results") or {}).get("products") or [] if r.status_code == 200 else None
        except (requests.RequestException, ValueError):
            ps = None
        if ps is None:
            if looked == 0 and r is not None and r.status_code in (401, 403, 406, 429):
                return None, f"HTTP {r.status_code} on search"
            continue
        looked += 1
        found.append((k, ps[0]["handle"] if ps else ""))
        if len(found) >= 50:
            _map_save(conn, name, found) if conn else None
            for kk, h in found:
                known[kk] = (h, None)
            found = []
        time.sleep(pause)
    if conn:
        _map_save(conn, name, found)
    for kk, h in found:
        known[kk] = (h, None)
    wanted = set(keys or [])
    handles = sorted({h for k, (h, _) in known.items() if h and k in wanted})
    out, read = {}, 0
    for h in handles:
        if time.time() - t0 > budget:
            break
        try:
            r = _get(s, f"{base}/products/{h}.js")
            p = r.json() if r.status_code == 200 else None
        except (requests.RequestException, ValueError):
            p = None
        if not p:
            continue
        read += 1
        for v in p.get("variants", []):
            pr, cmp_ = v.get("price"), v.get("compare_at_price")
            _add(out, strip0(v.get("barcode")), pr / 100 if isinstance(pr, (int, float)) else None,
                 cmp_ / 100 if isinstance(cmp_, (int, float)) else None, p.get("title"), bool(v.get("available")), f"{base}/products/{h}")
        time.sleep(pause)
    if not out and not read:
        return None, f"no products read ({len(handles)} known, {looked} looked up)"
    return out, None


TW_BUDGET = 12 * 60
_TW_CELL = re.compile(r'descpage([A-Z0-9][A-Z0-9-]+)\.html')


def tw_catalog(src: dict, sess=None, keys=None, pause=1.2):
    """tennis-warehouse.com: brand category pages (from the sitemap) give each product's price; product pages give
    the UPCs of its sizes (schema.org offers: gtin13, price, availability), cached in jt.pm_retail_map and refreshed a
    few hundred pages a day. Search pages are off limits in robots.txt, so they aren't used."""
    import datetime as dt
    s, conn = _session(sess), src.get("_conn")
    base, name = src["base_url"].rstrip("/"), src["name"]
    opt = src.get("options") or {}
    brands = [b.lower() for b in opt.get("brands", [])]
    t0 = time.time()
    try:
        sm = _get(s, f"{base}/sitemap.xml")
    except requests.RequestException as e:
        return None, f"network error: {str(e)[:160]}"
    if sm.status_code != 200:
        return None, f"HTTP {sm.status_code} on sitemap.xml"
    cats = [u for u in re.findall(r"<loc>([^<]+catpage[^<]+)</loc>", sm.text)
            if any(re.sub(r"^https?://[^/]+/", "", u).lower().startswith(b) for b in brands)]
    prices = {}                                         # product id -> (price, msrp, url)
    for u in cats:
        if time.time() - t0 > TW_BUDGET * 0.6:
            break
        try:
            r = _get(s, u)
        except requests.RequestException:
            continue
        if r.status_code != 200:
            if not prices and r.status_code in (401, 403, 429):
                return None, f"HTTP {r.status_code} on category pages"
            continue
        for cell in r.text.split('cattable-wrap-cell-inner')[1:]:
            m = _TW_CELL.search(cell)
            pr = re.search(r'cattable-wrap-cell-info-price(?!-)[^"]*"[\s\S]{0,200}?\$\s*([\d,]+\.\d\d)', cell)
            if not m or not pr:
                continue
            msrp = re.search(r'cattable-wrap-cell-info-price-msrp[^"]*"[\s\S]{0,200}?\$\s*([\d,]+\.\d\d)', cell)
            pid = m.group(1)
            if pid not in prices:
                prices[pid] = (_f(pr.group(1).replace(",", "")), _f(msrp.group(1).replace(",", "")) if msrp else None, f"{base}/descpage{pid}.html")
        time.sleep(pause)
    if not prices:
        return None, "no products on the category pages"
    # UPC -> product id, from product pages (cached; new and month-old products first, as time allows)
    known = _map_load(conn, name) if conn else {}
    with (conn.cursor() if conn else _Null()) as cur:
        if conn:
            cur.execute("select ref, checked_at from jt.pm_retail_pages where source = %s", (name,))
            seen = dict(cur.fetchall())
        else:
            seen = {}
    stale = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30)
    queue = sorted(prices, key=lambda pid: (pid in seen, seen.get(pid) or stale))
    queue = [pid for pid in queue if pid not in seen or seen[pid] < stale]
    fresh = {}                                          # UPC -> exact offer from a page read today
    for pid in queue:
        if time.time() - t0 > TW_BUDGET:
            break
        try:
            r = _get(s, f"{base}/descpage{pid}.html")
        except requests.RequestException:
            continue
        if r.status_code != 200:
            continue
        rows = []
        for off in re.split(r'itemprop=["\']offers["\']', r.text)[1:]:
            props = _itemprops(off)
            g, p, a = props.get("gtin13") or props.get("gtin12") or props.get("gtin"), props.get("price"), props.get("availability", "")
            if not g or not re.sub(r"\D", "", g):
                continue
            k = strip0(g)
            rows.append((k, pid))
            if p:
                fresh[k] = (_f(p), not a or a.rsplit("/", 1)[-1] in ("InStock", "LimitedAvailability", "PreOrder"))
        if conn:
            _map_save(conn, name, rows)
            with conn.cursor() as cur:
                cur.execute("""insert into jt.pm_retail_pages (source, ref, checked_at, n_keys) values (%s, %s, now(), %s)
                               on conflict (source, ref) do update set checked_at = now(), n_keys = excluded.n_keys""", (name, pid, len(rows)))
            conn.commit()
        for k, _ in rows:
            known[k] = (pid, None)
        time.sleep(pause)
    out = {}
    for k, (pid, _) in known.items():
        if pid not in prices:
            continue                                    # not in today's category pages: not counted
        price, msrp, url = prices[pid]
        if k in fresh and fresh[k][0]:
            _add(out, k, fresh[k][0], msrp, pid, fresh[k][1], url)
        else:
            _add(out, k, price, msrp, pid, True, url)
    if not out:
        return None, f"no UPCs mapped yet ({len(prices)} products listed; product pages are read a few hundred a day)"
    return out, None


def _itemprops(chunk: str) -> dict:
    """First value of each schema.org itemprop in a piece of HTML (content=, href= or the element's text), any order."""
    out = {}
    for tag in re.finditer(r"<[^>]*\bitemprop=[\"']([\w]+)[\"'][^>]*>([^<]{0,80})", chunk):
        name = tag.group(1)
        if name in out:
            continue
        t = tag.group(0)
        v = re.search(r"\b(?:content|href)=[\"']([^\"']*)[\"']", t)
        out[name] = (v.group(1) if v else tag.group(2)).strip()
    return out


class _Null:
    def __enter__(self):
        return None

    def __exit__(self, *a):
        return False


READERS = {"shopify_site": shopify_site, "shopify_barcode": shopify_barcode, "sfcc_grid": sfcc_grid,
           "sfcc_search": sfcc_search, "head_next": head_next, "shopify_upc_search": shopify_upc_search, "tw_catalog": tw_catalog}


def read(src: dict, sess=None, keys=None):
    fn = READERS.get(src.get("kind") or "shopify_site")
    if not fn:
        return None, f"no reader for kind {src.get('kind')!r}"
    try:
        return fn(src, sess, keys)
    except Exception as e:  # noqa: BLE001 - a broken reader leaves the brand "not covered" for the day
        return None, f"reader error: {str(e)[:200]}"
