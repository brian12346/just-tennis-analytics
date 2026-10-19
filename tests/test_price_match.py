from sync.price_match import plan, lower_target, map_floor, norm_sku

CFG = {"map_floor": True, "cost_floor": True, "min_margin": 5, "max_drop": 40, "amazon": True}


def V(vid, sku, price, vendor="Wilson", cmp=None, cost=None, barcode=""):
    return {"vid": vid, "pid": 100 + vid, "title": f"P{vid}", "vtitle": "", "sku": sku, "barcode": barcode, "vendor": vendor,
            "price": price, "cmp": cmp, "cost": cost}


def B(prices, prefix=9, vendors=("wilson",)):
    return {"Wilson": {"prefix": prefix, "vendors": set(vendors), "prices": prices}}


def bp(price, lst, avail=True):
    return {"price": price, "list": lst, "title": "Brand thing", "available": avail, "url": "u"}


def test_lower_to_brand_price_with_compare_at_list():
    ch, st = plan([V(1, "WR1234567U2", 249.0)], B({"WR1234567": bp(199.0, 249.0)}), None, {}, {}, CFG, set())
    assert len(ch) == 1 and ch[0]["new"] == 199.0 and ch[0]["new_cmp"] == 249.0 and ch[0]["reason"] == "lower"
    assert st["Wilson"]["lowered"] == 1


def test_no_change_when_cheaper_or_unavailable():
    ch, _ = plan([V(1, "WR1234567U2", 189.0), V(2, "WR7654321U2", 249.0)],
                 B({"WR1234567": bp(199.0, 249.0), "WR7654321": bp(150.0, 249.0, avail=False)}), None, {}, {}, CFG, set())
    assert ch == []


def test_cost_floor_and_map_floor():
    t, f = lower_target(100.0, 60.0, None, 59.0, CFG)
    assert (t, f) == (61.95, "cost")
    t, f = lower_target(150.0, 110.0, 130.0, 50.0, CFG)
    assert (t, f) == (130.0, "map")
    t, f = lower_target(130.0, 110.0, 130.0, None, CFG)   # floor = current price: no change
    assert t is None


def test_map_longest_prefix():
    fl = {"kswiss": {"04603": 100.0, "04603-002-M": 130.0}}
    assert map_floor(fl, "K Swiss", "04603-002-M-10") == 130.0
    assert map_floor(fl, "K-Swiss", "04603-999") == 100.0
    assert map_floor(fl, "Wilson", "04603") is None


def test_restore_when_sale_over_and_not_above_original():
    state = {1: {"orig_price": 249.0, "orig_cmp": None, "source": "Wilson"}}
    ch, _ = plan([V(1, "WR1234567U2", 199.0, cmp=249.0)], B({"WR1234567": bp(229.0, 229.0)}), None, state, {}, CFG, set())
    assert ch[0]["reason"] == "restore" and ch[0]["new"] == 229.0 and ch[0]["new_cmp"] is None
    ch, _ = plan([V(1, "WR1234567U2", 199.0)], B({}), None, state, {}, CFG, set())   # gone from the site
    assert ch[0]["new"] == 249.0


def test_not_covered_source_never_restores():
    state = {1: {"orig_price": 249.0, "orig_cmp": None, "source": "Wilson"}}
    ch, _ = plan([V(1, "WR1234567U2", 199.0)], B(None), None, state, {}, CFG, set())
    assert ch == []


def test_amazon_lower_restore_and_brand_wins():
    amz = {"0001": {"asin": "B0A", "price": 180.0}, "0002": {"asin": "B0B", "price": 260.0}}
    vs = [V(1, "WR1234567U2", 249.0, barcode="0001"), V(2, "X", 200.0, barcode="0002"), V(3, "WR1111111U2", 249.0, barcode="0001")]
    state = {2: {"orig_price": 240.0, "orig_cmp": 260.0, "source": "Amazon"}}
    ch, st = plan(vs, B({"WR1111111": bp(219.0, 249.0)}), amz, state, {}, CFG, set())
    by = {c["vid"]: c for c in ch}
    assert by[1]["source"] == "Amazon" and by[1]["new"] == 180.0 and by[1]["new_cmp"] == 249.0
    assert by[2]["reason"] == "restore" and by[2]["new"] == 240.0 and by[2]["new_cmp"] == 260.0
    assert by[3]["source"] == "Wilson" and by[3]["new"] == 219.0
    assert st["Amazon"]["lowered"] == 1 and st["Amazon"]["restored"] == 1


def test_big_drop_flag_and_skip():
    ch, _ = plan([V(1, "WR1234567U2", 300.0)], B({"WR1234567": bp(150.0, 300.0)}), None, {}, {}, CFG, set())
    assert ch[0]["big"] is True
    ch, _ = plan([V(1, "WR1234567U2", 300.0)], B({"WR1234567": bp(150.0, 300.0)}), None, {}, {}, CFG, {1})
    assert ch == []


def test_norm_sku():
    assert norm_sku(" wr1234567u2 ", 9) == "WR1234567"
    assert norm_sku("abc", 0) == "ABC"


class PMShop:
    """Fake Shopify: a small catalog; records price updates and serves current prices."""
    def __init__(self):
        self.v = {1: (249.0, None, "WR1234567U2", "", "Wilson", []), 2: (100.0, None, "WR7777777U2", "0002", "Wilson", ["JTonly"]),
                  3: (300.0, 320.0, "XYZ", "0003", "Wilson", [])}
        self.updates = []

    def graphql(self, q, v=None, version=None):
        if "productVariants(first" in q:
            return {"productVariants": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": [
                {"id": f"gid://shopify/ProductVariant/{i}", "sku": s, "barcode": b, "title": "Default Title", "price": str(p),
                 "compareAtPrice": None if c is None else str(c),
                 "product": {"id": f"gid://shopify/Product/{100 + i}", "title": f"P{i}", "vendor": ven, "productType": "Racquets",
                             "status": "ACTIVE", "tags": tags, "handle": f"p{i}"},
                 "inventoryItem": {"unitCost": {"amount": "120.00"}}} for i, (p, c, s, b, ven, tags) in self.v.items()]}}
        if "nodes(ids" in q:
            return {"nodes": [{"id": g, "price": str(self.v[int(g.split("/")[-1])][0]),
                               "compareAtPrice": self.v[int(g.split("/")[-1])][1], "product": {"id": "x"}} for g in v["ids"]]}
        if "productVariantsBulkUpdate" in q:
            self.updates.append(v)
            for x in v["v"]:
                i = int(x["id"].split("/")[-1]); old = self.v[i]
                self.v[i] = (float(x["price"]), None if x["compareAtPrice"] is None else float(x["compareAtPrice"])) + old[2:]
            return {"productVariantsBulkUpdate": {"productVariants": [], "userErrors": []}}
        raise AssertionError(q)


def test_run_review_approve_apply_rollback(conn, monkeypatch):
    from sync import price_match as pm
    with conn.cursor() as cur:
        cur.execute("update jt.pm_sources set enabled = (name = 'Wilson')")
        cur.execute("insert into jt.pm_upc_asin (upc, asin) values ('0003', 'B03')")
        cur.execute("insert into jt.pm_amazon_prices (asin, price) values ('B03', 250)")      # Amazon: not used for Shopify prices
        cur.execute("insert into jt.pm_state (variant_id, product_id, orig_price, orig_compare_at, source) values (3, 103, 330, null, 'Amazon')")
    conn.commit()
    monkeypatch.setattr(pm, "read_source", lambda s, sess=None, keys=None: ({"WR1234567": {"price": 199.0, "list": 249.0, "title": "Blade", "available": True, "url": "u"},
                                                                  "WR7777777": {"price": 50.0, "list": 100.0, "title": "x", "available": True, "url": ""}}, None))
    shop = PMShop()
    out = pm.run(shop, conn)
    assert out["lowered"] == 1 and out["restored"] == 1 and shop.updates == []     # review mode: nothing written; JTonly skipped
    with conn.cursor() as cur:
        cur.execute("select variant_id, source, reason, new_price, new_compare_at, status from jt.pm_changes order by variant_id")
        rows = cur.fetchall()
    assert [(r[0], r[1], r[2], float(r[3]), r[5]) for r in rows] == [(1, "Wilson", "lower", 199.0, "proposed"), (3, "Amazon", "restore", 330.0, "proposed")]
    with conn.cursor() as cur:
        cur.execute("""select jt.pm_decide('{"ids": [1, 2], "action": "approve", "by": "t"}'::jsonb)""")
    conn.commit()
    res = pm.apply(shop, conn)
    assert res == {"applied": 2, "rolled_back": 0, "failed": 0}
    assert shop.v[1][:2] == (199.0, 249.0) and shop.v[3][0] == 330.0
    with conn.cursor() as cur:
        cur.execute("select variant_id, orig_price, active from jt.pm_state order by 1")
        assert [(r[0], float(r[1]), r[2]) for r in cur.fetchall()] == [(1, 249.0, True), (3, 330.0, False)]
        cur.execute("select jt.pm_decide('{\"run_id\": 1, \"action\": \"rollback_run\"}'::jsonb)")
    conn.commit()
    res = pm.apply(shop, conn)
    assert res["rolled_back"] == 2 and shop.v[1][:2] == (249.0, None) and shop.v[3][:2] == (300.0, 320.0)
    with conn.cursor() as cur:
        cur.execute("select variant_id from jt.pm_state where active")
        assert [r[0] for r in cur.fetchall()] == [3]                                # the restore rolled back: lowered again


def test_apply_refuses_when_price_changed(conn):
    from sync import price_match as pm
    with conn.cursor() as cur:
        cur.execute("insert into jt.pm_runs (mode) values ('review')")
        cur.execute("""insert into jt.pm_changes (run_id, product_id, variant_id, source, old_price, new_price, reason, status)
                       values (1, 101, 1, 'Wilson', 259, 199, 'lower', 'approved')""")
    conn.commit()
    shop = PMShop()
    assert pm.apply(shop, conn)["failed"] == 1 and shop.updates == []
    with conn.cursor() as cur:
        cur.execute("select status, error from jt.pm_changes")
        st, err = cur.fetchone()
    assert st == "failed" and "249.00" in err


def test_restore_after_sale_ends(conn, monkeypatch):
    from sync import price_match as pm
    with conn.cursor() as cur:
        cur.execute("update jt.pm_sources set enabled = (name = 'Wilson')")
        cur.execute("insert into jt.pm_state (variant_id, product_id, orig_price, source) values (1, 101, 269, 'Wilson')")
        cur.execute("""update jt.settings set value = value || '{"mode": "auto", "amazon": false}' where key = 'price_match'""")
    conn.commit()
    monkeypatch.setattr(pm, "read_source", lambda s, sess=None, keys=None: ({"WR1234567": {"price": 259.0, "list": 259.0, "title": "Blade", "available": True, "url": "u"}}, None))
    shop = PMShop()
    out = pm.run(shop, conn)
    assert out["restored"] == 1 and out["applied"] == 1 and shop.v[1][0] == 259.0   # min(original 269, brand list 259)


# ---------------------------------------------------------------- brand-site readers
from sync import price_sources as ps


def test_jt_keys():
    assert ps.jt_keys("base", 0, "101531-2", "") == ["101531"]
    assert ps.jt_keys("base", 0, "32S24883-6018(1.5)", "") == ["32S24883"]
    assert ps.jt_keys("sku", 11, "04603-162-M-085", "") == ["04603-162-M"]
    assert ps.jt_keys("barcode", 0, "x", "008235873291") == ["8235873291", "823587329"]
    assert ps.jt_keys("barcode", 0, "x", "") == []


class FakeResp:
    def __init__(self, status=200, text="", js=None, ctype="text/html"):
        self.status_code, self.text, self._js, self.headers = status, text, js, {"content-type": ctype}

    def json(self):
        if self._js is None:
            raise ValueError("no json")
        return self._js


class FakeSess:
    def __init__(self, fn):
        self.fn, self.headers, self.calls = fn, {}, []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, params))
        return self.fn(url, params or {})


TILE = '''<div class="product" data-pid="{pid}"><div class="price"><span>{strike}<span class="c-price__sales sales "><span class="c-price__value value" content="{sale}">${sale}</span></span></span></div></div>'''


def test_sfcc_grid_pages_and_prices(monkeypatch):
    monkeypatch.setattr(ps.time, "sleep", lambda *_: None)
    pages = {0: TILE.format(pid="101531", sale="249.00", strike='<del><span class="strike-through list"><span class="value" content="299.00">$299</span></span></del>')
             + TILE.format(pid="3A0S26B752", sale="140.00", strike=""), 2: ""}
    sess = FakeSess(lambda url, p: FakeResp(text=pages.get(p.get("start"), "")))
    out, err = ps.sfcc_grid({"base_url": "https://www.babolat.com", "options": {"site": "babolatus"}}, sess)
    assert err is None and out["101531"]["price"] == 249.0 and out["101531"]["list"] == 299.0 and out["3A0S26B752"]["list"] == 140.0
    assert "Sites-babolatus-Site/en_US/Search-UpdateGrid" in sess.calls[0][0]


def test_sfcc_search_needs_a_single_hit_and_reads_the_colorway(monkeypatch):
    monkeypatch.setattr(ps.time, "sleep", lambda *_: None)

    def fn(url, p):
        if "Search-UpdateGrid" in url:
            q = p["q"]
            if q == "WCHRALC2":
                return FakeResp(text=TILE.format(pid="WCHRALV2-51723", sale="149.99", strike=""))
            if q == "MANY":
                return FakeResp(text=TILE.format(pid="A", sale="1", strike="") + TILE.format(pid="B", sale="2", strike=""))
            return FakeResp(text="")
        return FakeResp(js={"product": {"variationAttributes": [{"id": "style", "values": [{"id": "WCHRALC2"}]}],
                                        "price": {"sales": {"value": 119.99}, "list": {"value": 149.99}}}}, ctype="application/json")
    out, err = ps.sfcc_search({"base_url": "https://www.newbalance.com", "options": {"site": "NBUS", "variation": "style"}},
                              FakeSess(fn), keys={"WCHRALC2", "MANY", "NONE"})
    assert err is None and list(out) == ["WCHRALC2"] and out["WCHRALC2"]["price"] == 119.99 and out["WCHRALC2"]["list"] == 149.99


def test_head_next(monkeypatch):
    monkeypatch.setattr(ps.time, "sleep", lambda *_: None)

    def item(sku, fin, reg):
        return {"product": {"sku": sku, "name": "R", "price_range": {"minimum_price": {"final_price": {"value": fin}, "regular_price": {"value": reg}}}},
                "productView": {"inStock": True, "url": "u"}}

    def fn(url, p):
        if url.endswith("/en_US/"):
            return FakeResp(text='<script id="__NEXT_DATA__">{"buildId":"B1"}</script>')
        assert "/_next/data/B1/en_US/" in url
        page = (p or {}).get("page", 1)
        items = [item("232016", 199.0, 249.0)] if page == 1 else [item("236103", 269.0, 269.0)]
        return FakeResp(js={"pageProps": {"runtimeData": {"categorySSRData": {"catalogServiceData": {"productSearch": {
            "page_info": {"total_pages": 2}, "items": items}}}}}}, ctype="application/json")
    out, err = ps.head_next({"base_url": "https://www.head.com/en_US", "options": {"categories": ["shop-tennis"]}}, FakeSess(fn))
    assert err is None and out["232016"] == {"price": 199.0, "list": 249.0, "title": "R", "available": True, "url": "u"} and "236103" in out


def test_shopify_barcode_and_handle(monkeypatch):
    monkeypatch.setattr(ps.time, "sleep", lambda *_: None)

    def fn(url, p):
        if "products.json" in url:
            pg = int(url.split("page=")[1])
            return FakeResp(js={"products": [{"id": 1, "handle": "ezone-98", "title": "EZONE 98", "variants": [
                {"sku": "08EZ98", "price": "240.00", "compare_at_price": None, "available": True}]}] if pg == 1 else []}, ctype="application/json")
        return FakeResp(js={"title": "EZONE 98", "variants": [{"barcode": "8235873291", "price": 21600, "compare_at_price": 24000, "available": True}]})
    out, err = ps.shopify_barcode({"base_url": "https://us.yonex.com"}, FakeSess(fn))
    assert err is None and out["8235873291"]["price"] == 216.0 and out["8235873291"]["list"] == 240.0
    out, err = ps.shopify_site({"base_url": "https://x", "options": {"key": "handle"}, "collections": ["all"]}, FakeSess(fn))
    assert err is None and "EZONE-98" in out


def test_plan_matches_by_base_and_barcode():
    brands = {"Babolat": {"prefix": 0, "match": "base", "vendors": {"babolat"}, "prices": {"101531": bp(199.0, 249.0)}},
              "Yonex": {"prefix": 0, "match": "barcode", "vendors": {"yonex"}, "prices": {"8235873291": bp(200.0, 240.0)}}}
    vs = [V(1, "101531-2", 249.0, vendor="Babolat"), V(2, "EZ0898L1", 240.0, vendor="Yonex", barcode="008235873291")]
    ch, st = plan(vs, brands, None, {}, {}, CFG, set())
    assert {c["vid"]: c["new"] for c in ch} == {1: 199.0, 2: 200.0} and st["Yonex"]["matched"] == 1


def test_plan_retailers_lowest_wins_and_restore():
    brands = {"Head": {"prefix": 0, "match": "base", "vendors": {"head"}, "prices": None}}      # Head's site not read today
    markets = {"Tennis Warehouse": {"prices": {"198772071516": {"price": 189.0, "list": 199.0, "title": "PWR", "available": True, "url": "tw"}}},
               "Tennis Express": {"prices": {"198772071516": {"price": 185.0, "list": None, "title": "PWR", "available": True, "url": "te"},
                                             "111": {"price": 50.0, "list": None, "title": "x", "available": True, "url": "te2"}}}}
    amz = {"198772071516": {"asin": "B1", "price": 187.0}}
    state = {2: {"orig_price": 60.0, "orig_cmp": None, "source": "Tennis Express"}}
    vs = [V(1, "232316-3", 199.0, vendor="Head", barcode="198772071516"), V(2, "x", 50.0, vendor="Head", barcode="000000000111")]
    markets["Tennis Express"]["prices"]["111"]["price"] = 65.0                                   # back above the original 60
    ch, st = plan(vs, brands, amz, state, {}, CFG, set(), markets, {"head"})
    by = {c["vid"]: c for c in ch}
    assert by[1]["source"] == "Tennis Express" and by[1]["new"] == 185.0 and st["Tennis Warehouse"]["matched"] == 1
    assert by[2]["reason"] == "restore" and by[2]["new"] == 60.0


def test_tennis_express_reader_caches_the_lookup(conn, monkeypatch):
    monkeypatch.setattr(ps.time, "sleep", lambda *_: None)
    calls = {"suggest": 0}

    def fn(url, p):
        if "suggest.json" in url:
            calls["suggest"] += 1
            hit = [{"handle": "pwr-110"}] if p["q"] == "198772071516" else []
            return FakeResp(js={"resources": {"results": {"products": hit}}}, ctype="application/json")
        return FakeResp(js={"title": "PWR 110", "variants": [{"barcode": "198772071516", "price": 18500, "compare_at_price": 19900, "available": True}]})
    src = {"name": "Tennis Express", "base_url": "https://www.tennisexpress.com", "_conn": conn}
    out, err = ps.shopify_upc_search(src, FakeSess(fn), keys={"198772071516", "999999999999"})
    assert err is None and out["198772071516"]["price"] == 185.0 and calls["suggest"] == 2
    out, err = ps.shopify_upc_search(src, FakeSess(fn), keys={"198772071516", "999999999999"})
    assert out["198772071516"]["price"] == 185.0 and calls["suggest"] == 2             # remembered: no new lookups


def test_tennis_warehouse_reader(conn, monkeypatch):
    monkeypatch.setattr(ps.time, "sleep", lambda *_: None)
    cat = ('<div class="cattable-wrap-cell-inner"><a href="\nhttps://www.tennis-warehouse.com/Head_PWR_110/descpageRCHEAD-HPWR10.html?color=WB\r\n">'
           '<div class="cattable-wrap-cell-info-price is-sale">$179.00</div><div class="cattable-wrap-cell-info-price-msrp">MSRP $199.00</div></a></div>'
           '<div class="cattable-wrap-cell-inner"><a href="/x/descpageOTHER-1.html"><span class="cattable-wrap-cell-info-price">$9.00</span></a></div>')
    page = ('<div itemprop="offers" itemscope><meta itemprop="price" content="179.00"><meta content="0198772071493" itemprop="gtin13">'
            '<link itemprop="availability" href="http://schema.org/InStock"></div>'
            '<div itemprop="offers" itemscope><meta itemprop="price" content="179.00"><meta itemprop="gtin13" content="0198772071516">'
            '<link itemprop="availability" href="http://schema.org/OutOfStock"></div>')

    def fn(url, p):
        if url.endswith("sitemap.xml"):
            return FakeResp(text="<loc>https://www.tennis-warehouse.com/Head_Tennis_Racquets/catpage-HEADRAC.html</loc>"
                                 "<loc>https://www.tennis-warehouse.com/Nike_Mens/catpage-NIKE.html</loc>")
        if "catpage" in url:
            assert "Nike" not in url
            return FakeResp(text=cat)
        return FakeResp(text=page if "HPWR10" in url else "")
    src = {"name": "Tennis Warehouse", "base_url": "https://www.tennis-warehouse.com", "options": {"brands": ["head"]}, "_conn": conn}
    out, err = ps.tw_catalog(src, FakeSess(fn), keys=set())
    assert err is None and out["198772071493"]["price"] == 179.0 and out["198772071493"]["list"] == 199.0
    assert out["198772071516"]["available"] is False
    with conn.cursor() as cur:
        cur.execute("select count(*) from jt.pm_retail_map where source = 'Tennis Warehouse' and ref = 'RCHEAD-HPWR10'")
        assert cur.fetchone()[0] == 2


def test_map_file_queue_due_and_apply(conn):
    """A MAP file (migration 160): floors saved, queue built per date, the due step makes approved changes, apply writes."""
    from sync import price_match as pm
    import json
    with conn.cursor() as cur:
        cur.execute("""insert into jt.variants (variant_id, product_id, sku, product_title, variant_title, vendor, status, price, barcode)
                       values (1, 101, 'WR1234567U2', 'Blade', '1/4', 'Wilson', 'ACTIVE', 249, '097512000001'),
                              (2, 102, 'OTHER-SKU', 'Clash', '', 'Wilson', 'ACTIVE', 180, '097512000002'),
                              (3, 103, 'WR3333333U2', 'RF', '', 'Wilson', 'ACTIVE', 300, '')""")
        rows = [{"sku": "WR1234567U2", "upc": "00097512000001", "prev": 219, "maps": [{"d": "2099-10-26", "p": 219}, {"d": "2099-11-01", "p": 199}]},
                {"sku": "WR2222222U2", "upc": "00097512000002", "prev": 219, "maps": [{"d": "2099-10-26", "p": 219}, {"d": "2099-11-01", "p": 219}]},
                {"sku": "WR3333333U2", "upc": "", "prev": 279, "maps": [{"d": "2099-10-26", "p": 279}, {"d": "2099-11-01", "p": None}]}]
        cur.execute("select jt.pm_map_upload(%s::jsonb)", (json.dumps({"brand": "Wilson", "file_name": "w.xlsx", "rows": rows, "by": "t"}),))
        out = cur.fetchone()[0]
        assert out["items"] == 3 and out["dates"] == ["2099-10-26", "2099-11-01"]
        cur.execute("select effective_from::text, key, reason, old_map::float, new_map::float from jt.pm_map_queue order by 1, 2")
        assert cur.fetchall() == [("2099-10-26", "2", "map_below", 219.0, 219.0), ("2099-11-01", "1", "map_down", 219.0, 199.0),
                                  ("2099-11-01", "2", "map_below", 219.0, 219.0)]
        # floors under the item SKU and the matched Shopify SKU (variant 2 is matched by UPC only); OFF = 0
        cur.execute("select sku_prefix, map_price::float from jt.pm_map_floors where effective_from = '2099-11-01' order by 1")
        assert cur.fetchall() == [("OTHER-SKU", 219.0), ("WR1234567U2", 199.0), ("WR2222222U2", 219.0), ("WR3333333U2", 0.0)]
        cur.execute("select jt.pm_map_skip('{\"ids\": [3], \"skip\": true}'::jsonb)")
        cur.execute("update jt.pm_map_queue set effective_from = current_date - 1 where effective_from = '2099-11-01'")
        cur.execute("select jt.pm_map_due()")
        assert cur.fetchone()[0]["shopify"] == 1
        cur.execute("select variant_id, old_price::float, new_price::float, reason, map_kind, status from jt.pm_changes")
        assert cur.fetchall() == [(1, 249.0, 199.0, "restore", "map_down", "approved")]
    conn.commit()
    shop = PMShop()
    shop.v[1] = (259.0, 289.0) + shop.v[1][2:]          # changed in Shopify since: a MAP change is written anyway
    assert pm.apply(shop, conn)["applied"] == 1
    assert shop.v[1][:2] == (199.0, 289.0)
    with conn.cursor() as cur:
        cur.execute("select old_price::float, old_compare_at::float, status from jt.pm_changes")
        assert cur.fetchone() == (259.0, 289.0, "applied")
        cur.execute("select status from jt.v_pm_map_queue where id <= 3 order by id")   # (the dates moved: the due step re-adds 2099 rows)
        assert [r[0] for r in cur.fetchall()] == ["queued", "applied", "skipped"]
