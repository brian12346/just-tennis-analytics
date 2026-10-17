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
        cur.execute("insert into jt.pm_amazon_prices (asin, price) values ('B03', 250)")
    conn.commit()
    monkeypatch.setattr(pm, "fetch_brand", lambda s, sess=None: ({"WR1234567": {"price": 199.0, "list": 249.0, "title": "Blade", "available": True, "url": "u"},
                                                                  "WR7777777": {"price": 50.0, "list": 100.0, "title": "x", "available": True, "url": ""}}, None))
    shop = PMShop()
    out = pm.run(shop, conn)
    assert out["lowered"] == 2 and shop.updates == []           # review mode: nothing written; JTonly skipped
    with conn.cursor() as cur:
        cur.execute("select variant_id, source, new_price, new_compare_at, status from jt.pm_changes order by variant_id")
        rows = cur.fetchall()
    assert [(r[0], r[1], float(r[2]), r[4]) for r in rows] == [(1, "Wilson", 199.0, "proposed"), (3, "Amazon", 250.0, "proposed")]
    assert float(rows[1][3]) == 320.0                            # Amazon: compare-at stays the higher existing one
    with conn.cursor() as cur:
        cur.execute("""select jt.pm_decide('{"ids": [1, 2], "action": "approve", "by": "t"}'::jsonb)""")
    conn.commit()
    res = pm.apply(shop, conn)
    assert res == {"applied": 2, "rolled_back": 0, "failed": 0}
    assert shop.v[1][:2] == (199.0, 249.0)
    with conn.cursor() as cur:
        cur.execute("select variant_id, orig_price, active from jt.pm_state order by 1")
        assert [(r[0], float(r[1]), r[2]) for r in cur.fetchall()] == [(1, 249.0, True), (3, 300.0, True)]
        cur.execute("select jt.pm_decide('{\"run_id\": 1, \"action\": \"rollback_run\"}'::jsonb)")
    conn.commit()
    res = pm.apply(shop, conn)
    assert res["rolled_back"] == 2 and shop.v[1][:2] == (249.0, None) and shop.v[3][:2] == (300.0, 320.0)
    with conn.cursor() as cur:
        cur.execute("select count(*) from jt.pm_state where active")
        assert cur.fetchone()[0] == 0


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
    monkeypatch.setattr(pm, "fetch_brand", lambda s, sess=None: ({"WR1234567": {"price": 259.0, "list": 259.0, "title": "Blade", "available": True, "url": "u"}}, None))
    shop = PMShop()
    out = pm.run(shop, conn)
    assert out["restored"] == 1 and out["applied"] == 1 and shop.v[1][0] == 259.0   # min(original 269, brand list 259)
