(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const usd = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"});
  const m = (n) => usd.format(n || 0);
  const money = (s) => { let t = String(s ?? "").trim(); if (!t) return null; const neg = t.startsWith("-"); t = t.replace(/[^0-9.]/g, ""); const n = parseFloat(t); return isNaN(n) ? null : (neg ? -n : n); };
  const SERVER = "Shopify";
  const PAGE = 100;
  const S = {
    listings: [], listMeta: null, listReady: false,
    maps: new Map(), mapsReady: false,
    costs: new Map(),              // variant gid -> {cost, displayName, sku}
    db: null, mcp: null, shown: PAGE,
    open: null, mode: "shopify", q: "", results: null, searching: false, searchErr: null,
    pick: null, units: "1", manual: "", saving: false,
  };

  // ---------- tabs ----------
  function showTab(t) {
    if (window.JT && window.JT.checkCatalog) window.JT.checkCatalog().catch(() => {});      // a sync from Shopify since? every tab reloads
    if (!["amzmap", "amazon", "psales", "costmap", "invoices", "amzmatch", "costs", "fba", "prep", "po", "fbm", "alerts"].includes(t)) t = "shopify";
    $("tab-fbm").hidden = t !== "fbm";
    $("tab-alerts").hidden = t !== "alerts";
    $("tab-po").hidden = t !== "po";
    $("tab-costs").hidden = t !== "costs";
    $("tab-fba").hidden = t !== "fba";
    $("tab-prep").hidden = t !== "prep";
    $("tab-invoices").hidden = t !== "invoices";
    $("tab-amzmatch").hidden = t !== "amzmatch";
    $("tab-psales").hidden = t !== "psales";
    $("tab-costmap").hidden = t !== "costmap";
    $("tab-shopify").hidden = t !== "shopify";
    $("tab-amazon").hidden = t !== "amazon";
    $("tab-amzmap").hidden = t !== "amzmap";
    document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
    try { history.replaceState(null, "", "#" + t); } catch (_) {}
    if (t === "amzmap") render(); else if (t === "amazon") renderSales(); else if (t === "psales") { if (window.psRender) window.psRender(); } else if (t === "costmap") { if (window.cmRender) window.cmRender(); } else if (t === "invoices") { if (window.invShow) window.invShow(); } else if (t === "amzmatch") { if (window.amShow) window.amShow(); } else if (t === "costs") { if (window.pcShow) window.pcShow(); } else if (t === "fba") { if (window.fbaShow) window.fbaShow(); } else if (t === "prep") { if (window.prepShow) window.prepShow(); } else if (t === "po") { if (window.poShow) window.poShow(); } else if (t === "fbm") { if (window.fbmShow) window.fbmShow(); } else if (t === "alerts") { if (window.alertsShow) window.alertsShow(); } else window.dispatchEvent(new Event("resize"));
  }
  document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));

  // ---------- helpers ----------
  const docId = (sku) => "s_" + String(sku).replace(/[^A-Za-z0-9_\-.:@+]/g, c => "~" + c.charCodeAt(0).toString(16).padStart(2, "0")).slice(0, 190);
  const packOf = (title) => { const mt = /(\d+)\s*[- ]?\s*(pack|pk|count|ct|pcs|pieces)\b/i.exec(title || ""); return mt ? Math.min(+mt[1], 500) : null; };
  const isFBA = (l) => /AMAZON/i.test(l.channel);
  function note(kind, html) { const n = $("amz-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; }
  function mcpMsg(e) {
    const c = e && e.code;
    if (c === "server_not_connected") return "Shopify isn't connected for your account. Add it in claude.ai Settings → Connectors.";
    if (c === "needs_reauth") return "Reconnect Shopify in claude.ai Settings → Connectors.";
    if (c === "not_in_manifest") return "Shopify access is turned off for this page.";
    return window.JT.message(e);
  }

  const gidNum = (g) => g ? String(g).split("/").pop() : "";
  function shopLink(pid, vid, html) {
    if (!pid) return html;
    return `<a class="olink" href="https://admin.shopify.com/store/justtennis-822/products/${encodeURIComponent(gidNum(pid))}${vid ? "/variants/" + encodeURIComponent(gidNum(vid)) : ""}" target="_blank" rel="noopener" title="Open in Shopify">${html}</a>`;
  }
  // effective cost per Amazon unit
  // Cost history from the daily cost check (db costlog): variant id -> [{date, old, new}] sorted by date
  S.hist = new Map();
  function histUnit(variantId, day) {
    const list = S.hist.get(gidNum(variantId)); if (!list || !day) return undefined;
    for (const c of list) if (c.date > day) return c.old == null ? undefined : c.old;   // cost before the first change after this sale
    return undefined;
  }
  function costOf(map, day) {
    if (!map) return null;
    if (map.kind === "manual") return typeof map.manualCost === "number" ? { cost: map.manualCost, src: "manual" } : null;
    const cur = S.costs.get(map.variantId);
    const h = histUnit(map.variantId, day);
    const unit = h !== undefined ? h : cur && cur.cost != null ? cur.cost : map.unitCost;
    if (unit == null) return { cost: null, src: "shopify" };
    return { cost: Math.round(unit * (map.units || 1) * 100) / 100, unit, src: "shopify", stale: !cur };
  }

  // ---------- data: listings ----------
  function applyListings(snap) {
    const docs = snap.docs.slice().sort((a, b) => a.id.localeCompare(b.id));
    const out = []; let meta = null;
    for (const d of docs) {
      const b = d.data() || {};
      if (!meta && b.file) meta = { file: b.file, uploadedAt: b.uploadedAt, total: b.total };
      for (const r of b.rows || []) out.push({ sku: r[0], asin: r[1], title: r[2], price: r[3], qty: r[4], channel: r[5], status: r[6], opened: r[7] });
    }
    S.listings = out; S.listMeta = meta; S.listReady = true; allCache = null; render(); renderSales();
  }

  function parseListings(text) {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error("That file has no listings.");
    const head = lines[0].split("\t").map(h => h.trim().toLowerCase());
    const ix = (n) => head.indexOf(n);
    const need = ["seller-sku", "item-name"];
    for (const n of need) if (ix(n) < 0) throw new Error("This doesn't look like an All Listings report (no " + n + " column). Download Inventory → Inventory Reports → All Listings Report.");
    const col = { sku: ix("seller-sku"), asin: ix("asin1") >= 0 ? ix("asin1") : ix("product-id"), title: ix("item-name"), price: ix("price"), qty: ix("quantity"), channel: ix("fulfillment-channel"), status: ix("status"), opened: ix("open-date") };
    const rows = [];
    for (const line of lines.slice(1)) {
      const f = line.split("\t"); const g = (k) => col[k] >= 0 ? (f[col[k]] || "").trim() : "";
      if (!g("sku")) continue;
      rows.push([g("sku"), g("asin"), g("title").slice(0, 160), money(g("price")), g("qty") === "" ? null : Number(g("qty")), g("channel"), g("status") || "Active", g("opened").slice(0, 10)]);
    }
    return rows;
  }

  async function uploadListings(file) {
    if (!file || !S.db) return;
    let rows;
    try { rows = parseListings(await file.text()); } catch (e) { note("bad", esc(e.message)); return; }
    const CH = 450, n = Math.ceil(rows.length / CH), now = new Date().toISOString();
    $("amz-status").textContent = `Saving ${rows.length} listings…`;
    try {
      for (let i = 0; i < n; i++) {
        await S.db.collection("amzlistings").doc("c" + String(i).padStart(3, "0")).set({ file: file.name, uploadedAt: now, total: rows.length, rows: rows.slice(i * CH, (i + 1) * CH) });
      }
      const old = await S.db.collection("amzlistings").get();
      for (const d of old.docs) if (+d.id.slice(1) >= n) await S.db.collection("amzlistings").doc(d.id).delete();
      note("info", `Loaded ${rows.length} listings from ${esc(file.name)}. Your mappings are kept.`);
    } catch (e) {
      note("bad", e && e.code === "invalid_argument" ? "You don't have permission to upload listings on this dashboard." : "Upload stopped partway. Try again.");
    }
    $("amz-lfile").value = "";
  }
  $("amz-lfile").addEventListener("change", (e) => uploadListings(e.target.files[0]));
  // the All Listings report from the SP-API (the amazon function also fetches it once a day): ask for it, then keep
  // collecting until Amazon has it ready (usually a few minutes) and reload the listings
  async function getListings() {
    const b = $("amz-lget"); if (!window.JT || !window.JT.amazon || b.disabled) return;
    b.disabled = true; const label = b.textContent;
    const say = (t) => { b.textContent = t; };
    try {
      say("Asking Amazon…");
      const r = await window.JT.amazon({ action: "listings" });
      if (!r || r.ok === false) throw new Error((r && r.error) || "Amazon didn't take the request");
      for (let i = 0; i < 30; i++) {
        say(`Waiting for Amazon… ${Math.floor(i / 2)} min`);
        await new Promise(f => setTimeout(f, 30000));
        const x = await window.JT.amazon({ action: "sync" });
        const got = ((x && x.collected) || []).find(d => d.report_id === r.report_id && d.status !== "waiting");
        if (got) {
          if (got.status !== "done") throw new Error(got.detail || "Amazon couldn't make the report");
          const snap = await S.db.collection("amzlistings").get(); applyListings(snap);
          note("info", `Got ${Number(got.listings || 0).toLocaleString()} listings from Amazon. Your mappings are kept.`);
          return;
        }
      }
      note("warn", "Amazon is still making the listings report. It'll be saved automatically in the next few minutes — reload the page later.");
    } catch (e) {
      note("bad", "Couldn't get listings from Amazon: " + esc(window.JT.message ? window.JT.message(e) : (e.message || e)));
    } finally { b.disabled = false; b.textContent = label; }
  }
  $("amz-lget").addEventListener("click", getListings);

  // ---------- data: mappings + current Shopify costs ----------
  function applyMaps(snap) {
    const mp = new Map();
    for (const d of snap.docs) { const b = d.data() || {}; if (b.sku) mp.set(b.sku, b); }
    S.maps = mp; S.mapsReady = true; refreshCosts(); render(); renderSales();
  }
  let costBusy = false;
  // Current Shopify cost of each mapped variant, from the catalog synced nightly into Supabase (jt.variants).
  const gidV = (n) => "gid://shopify/ProductVariant/" + n, gidP = (n) => "gid://shopify/Product/" + n;
  async function refreshCosts() {
    if (!S.mcp || costBusy) return;
    const ids = [...new Set([...S.maps.values()].filter(x => x.kind === "shopify" && x.variantId && !S.costs.has(x.variantId)).map(x => x.variantId))];
    if (!ids.length) return;
    costBusy = true;
    try {
      const nums = ids.map(g => gidNum(g)).filter(n => /^\d+$/.test(n));
      const r = await window.JT.rows(["variant_id::text", "sku", "display_name", "product_id::text", "unit_cost"], `from jt.variants where variant_id in (${nums.join(",")})`);
      for (const [v, sku, dn, pid, uc] of r) S.costs.set(gidV(v), { cost: uc == null ? null : Number(uc), displayName: dn, sku, pid: gidP(pid) });
    } catch (_) { /* fall back to cost saved with the mapping */ }
    costBusy = false; render(); renderSales();
  }

  // ---------- Shopify catalog search (jt.variants) ----------
  // Brands: Amazon titles lead with the brand, Shopify titles don't (it's the vendor field instead).
  const BRANDS = ["head", "yonex", "wilson", "babolat", "tecnifibre", "luxillon", "dunlop", "selkirk", "joola", "solinco", "new balance", "lacoste", "penn", "pro penn", "propenn",
    "k swiss", "k-swiss", "kswiss", "diadem", "crbn", "slazenger", "tifosi", "gearbox", "tenx", "road to pro", "engage", "kirschbaum", "gexco", "gamma", "prince", "asics", "adidas",
    "nike", "volkl", "völkl", "pacific", "tourna", "unique", "gosen", "signum pro", "polyfibre", "isospeed", "mizuno", "under armour", "fila", "hydrogen", "vision", "franklin", "onix", "paddletek"];
  const STOP = new Set(["tennis", "the", "for", "with", "and", "of", "a", "by", "new", "pack", "pk", "count", "ct", "pcs", "pieces", "piece", "set", "sets", "string", "strings", "racquet", "racket", "racquets", "rackets", "gauge", "mm", "adult", "unisex", "men", "mens", "women", "womens", "pickleball"]);
  function splitBrand(text) {
    let t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9ö\- ]/g, " ").replace(/\s+/g, " ") + " ";
    const brands = [];
    for (const b of BRANDS.slice().sort((x, y) => y.length - x.length)) { if (t.includes(" " + b + " ")) { brands.push(b); t = t.replace(" " + b + " ", " "); } }
    return { brands, rest: t.trim() };
  }
  function tokens(text) {
    const { brands, rest } = splitBrand(text);
    const all = rest.split(/\s+/).filter(Boolean);
    const partNo = w => w.length >= 6 && /\d/.test(w) && /[a-z]/.test(w);  // e.g. wrz4016wh: Amazon part numbers, not in Shopify titles
    const words = all.filter(w => !STOP.has(w) && !/^\d/.test(w) && w.length > 1 && !partNo(w));
    const nums = all.filter(w => /^\d/.test(w)).map(w => w.replace(/[^0-9lL]/g, "").toLowerCase()).filter(Boolean);
    return { brands, words, nums };
  }

  async function search() {
    const q = S.q.trim(); if (!q || !S.mcp) return;
    S.searching = true; S.searchErr = null; S.results = null; render();
    const skuLike = !/\s/.test(q) && /\d/.test(q) && !/^\d{1,3}$/.test(q);
    const { brands, words, nums } = tokens(q);
    const found = new Map();
    const add = (v, p) => { if (!found.has(v.id)) found.set(v.id, { id: v.id, pid: p.id || null, sku: v.sku || "", name: v.displayName || ((p.title || "") + (v.title && v.title !== "Default Title" ? " - " + v.title : "")), vendor: p.vendor || "", status: p.status || "", cost: v.inventoryItem && v.inventoryItem.unitCost ? Number(v.inventoryItem.unitCost.amount) : null }); };
    const J = window.JT;
    const COLS = ["variant_id::text", "product_id::text", "sku", "display_name", "product_title", "variant_title", "vendor", "status", "unit_cost"];
    const addRows = (rows) => rows.forEach(x => add({ id: gidV(x[0]), sku: x[2], displayName: x[3], title: x[5], inventoryItem: x[8] == null ? null : { unitCost: { amount: x[8] } } },
      { id: gidP(x[1]), title: x[4], vendor: x[6], status: x[7] }));
    const like = (w) => J.q("%" + w.replace(/[%_\\]/g, m => "\\" + m) + "%");
    const vendorSql = brands.length ? " and (" + brands.map(b => `vendor ilike ${J.q(b)}`).join(" or ") + ")" : "";
    const titleSql = (ws) => ws.slice(0, 5).map(w => `(product_title ilike ${like(w)} or variant_title ilike ${like(w)})`).join(" and ");
    try {
      const jobs = [];
      if (skuLike) jobs.push(J.rows(COLS, `from jt.variants where removed_at is null and sku ilike ${J.q(q.replace(/[^A-Za-z0-9\-_.()\/]/g, "") + "%")} order by sku limit 25`).then(addRows));
      if (words.length) {
        jobs.push((async () => {
          // Title words without the brand; the brand filters on the vendor field. Drop trailing words until something matches.
          for (let n = Math.min(words.length, 5); n >= 1; n--) {
            for (const vq of vendorSql ? [vendorSql, ""] : [""]) {
              const r = await J.rows(COLS, `from jt.variants where removed_at is null and ${titleSql(words.slice(0, n))}${vq} order by status, product_title, variant_title limit 150`);
              if (r.length) { addRows(r); return; }
            }
          }
        })());
      } else if (brands.length) {
        jobs.push(J.rows(COLS, `from jt.variants where removed_at is null${vendorSql} order by status, product_title limit 150`).then(addRows));
      }
      await Promise.all(jobs);
      // Rank variants that contain the gauge/size numbers from the search (e.g. "17", "16L") first.
      const score = (r) => { const n = r.name.toLowerCase(); return nums.reduce((a, x) => a + (new RegExp("(^|[^0-9])" + x.replace(/[^0-9a-z]/g, "") + "(?![0-9])", "i").test(n) ? 1 : 0), 0); };
      S.results = [...found.values()].map(r => ({ r, s: score(r) })).sort((a, b) => b.s - a.s).map(x => x.r).slice(0, 80);
    } catch (e) { S.searchErr = e; }
    S.searching = false; render();
    const i = $("amz-sq"); if (i) i.focus();
  }

  // Initial search from the Amazon title: drop the brand, pack counts and filler words; keep model words plus gauge/size numbers.
  function suggestQuery(title) {
    const base = String(title || "").replace(/,.*$/, "").replace(/\([^)]*\)/g, " ").replace(/\b\d+\s*[- ]?\s*(pack|pk|count|ct|pcs)\b/ig, " ");
    const { words, nums } = tokens(base);
    return words.slice(0, 3).concat(nums.slice(0, 1)).join(" ");
  }

  // ---------- editor ----------
  // a listing by seller SKU, including the rows a fixed SKU list adds (SKUs not in the listings report)
  const findListing = (sku) => allListings().find(x => x.sku === sku) || (S.only ? filtered().find(x => x.sku === sku) : null);
  function openEditor(sku) {
    const l = findListing(sku); if (!l) return;
    if (!S.db) { note("warn", "Saving mappings isn't available until the database connects. Reload the page."); return; }
    const mp = S.maps.get(sku);
    S.open = sku; S.results = null; S.searchErr = null;
    S.mode = mp && mp.kind === "manual" ? "manual" : "shopify";
    S.pick = mp && mp.kind === "shopify" ? { id: mp.variantId, pid: mp.productId || (S.costs.get(mp.variantId) || {}).pid || null, sku: mp.vsku, name: mp.vtitle, vendor: mp.vendor || "", cost: (S.costs.get(mp.variantId) || {}).cost ?? mp.unitCost } : null;
    S.units = String(mp && mp.units ? mp.units : 1);
    S.manual = mp && typeof mp.manualCost === "number" ? mp.manualCost.toFixed(2) : "";
    S.q = mp && mp.vsku ? mp.vsku : suggestQuery(l.title);
    note("", "");
    render();
    if (S.mode === "shopify" && !S.pick && S.q) search();
    setTimeout(() => { const r = document.querySelector("#amz-table tr.openrow"); if (r) r.scrollIntoView({ block: "start", behavior: "smooth" }); const i = $(S.mode === "manual" ? "amz-manual" : "amz-sq"); if (i) i.focus({ preventScroll: true }); }, 0);
  }
  function pickResult(id) {
    const r = (S.results || []).find(x => x.id === id); if (!r) return false;
    S.pick = r; const l = findListing(S.open); const pk = l && packOf(l.title);
    if (S.units === "1" && pk && !/\d+\s*[- ]?\s*(pack|pk|count|ct)/i.test(r.name)) S.units = String(pk);
    return true;
  }
  function closeEditor() { S.open = null; S.results = null; S.pick = null; render(); }

  async function save(next) {
    const l = findListing(S.open); if (!l) return;
    let body = { sku: l.sku, asin: l.asin, title: l.title, updatedAt: new Date().toISOString() };
    if (S.mode === "manual") {
      const c = money(S.manual);
      if (c == null || c < 0) { note("bad", "Enter the cost per Amazon unit as a dollar amount, like 12.50."); return; }
      body = { ...body, kind: "manual", manualCost: Math.round(c * 100) / 100 };
    } else {
      if (!S.pick) { note("warn", "Pick a Shopify product from the search results first."); return; }
      const u = Number(S.units);
      if (!(u > 0) || u > 1000) { note("bad", "Units per Amazon listing must be a number like 1, 3 or 12."); return; }
      body = { ...body, kind: "shopify", variantId: S.pick.id, productId: S.pick.pid || null, vsku: S.pick.sku, vtitle: S.pick.name, vendor: S.pick.vendor, units: u, unitCost: S.pick.cost };
      if (S.pick.cost != null) S.costs.set(S.pick.id, { cost: S.pick.cost, displayName: S.pick.name, sku: S.pick.sku });
    }
    S.saving = true; render();
    try {
      await S.db.collection("amzmap").doc(docId(l.sku)).set(body);
      S.maps.set(l.sku, body); S.open = null; S.pick = null; S.results = null; renderSales();
      note("", "");
      if (next) {
        // Open the next unmapped listing below this one in the current list.
        const rows = filtered(), i = rows.findIndex(x => x.sku === l.sku);
        const nx = rows.slice(i + 1).concat(rows.slice(0, Math.max(i, 0))).find(x => !S.maps.has(x.sku));
        S.saving = false;
        if (nx) { const k = rows.indexOf(nx); if (k >= S.shown) S.shown = k + 1; openEditor(nx.sku); return; }
      }
    } catch (e) { note("bad", e && e.code === "invalid_argument" ? "You don't have permission to save mappings on this dashboard." : "Couldn't save that mapping. Try again."); }
    S.saving = false; render();
  }
  async function removeMap() {
    const sku = S.open; if (!sku) return;
    S.saving = true; render();
    try { await S.db.collection("amzmap").doc(docId(sku)).delete(); S.maps.delete(sku); S.open = null; renderSales(); }
    catch (_) { note("bad", "Couldn't remove that mapping. Try again."); }
    S.saving = false; render();
  }

  // ---------- render ----------
  let allCache = null;
  function allListings() {
    const sales = skuSales();
    const key = S.listings.length + ":" + sales.size + ":" + Object.keys(A.titles).length + ":" + S.maps.size;
    if (allCache && allCache.key === key) return allCache.list;
    const have = new Set(S.listings.map(l => l.sku));
    const extra = [...sales.keys()].filter(k => k && !have.has(k)).map(k => { const mp = S.maps.get(k) || {}; return { sku: k, asin: mp.asin || "", title: A.titles[k] || mp.title || k, price: null, qty: null, channel: "", status: "Sold · not in listings report", extra: true }; });
    // mapped SKUs known only from the FBA / AWD / prep-center files
    for (const [k, mp] of S.maps) if (k && !have.has(k) && !sales.has(k)) extra.push({ sku: k, asin: mp.asin || "", title: mp.title || k, price: null, qty: null, channel: /FBA/i.test(k) ? "AMAZON_NA" : "", status: "Not in listings report", extra: true });
    const list = S.listings.concat(extra);
    for (const l of list) { const a = sales.get(l.sku); l.units = a ? a[0] : 0; l.sales = a ? a[1] : 0; }
    allCache = { key, list }; return list;
  }
  // ASINs whose seller SKUs are mapped to different products (one ASIN should be one product)
  const sigOf = (mp) => !mp ? null : mp.kind === "manual" ? "m:" + mp.manualCost : "s:" + gidNum(mp.variantId) + "x" + (mp.units || 1);
  function conflictAsins() {
    const by = new Map();
    for (const l of allListings()) { const mp = S.maps.get(l.sku), a = l.asin || (mp && mp.asin); if (!a || !mp) continue; const s = by.get(a) || new Set(); s.add(sigOf(mp)); by.set(a, s); }
    return new Set([...by].filter(([, s]) => s.size > 1).map(([a]) => a));
  }
  // A fixed list of seller SKUs from another tab (e.g. the FBM tab's unmapped listings): only those show, with a
  // banner to go back to the normal filters. SKUs not in the listings report still get a row so they can be mapped.
  function filtered() {
    if (S.only) {
      const L = allListings(), have = new Set(L.map(l => l.sku));
      const extra = [...S.only.skus].filter(k => !have.has(k)).map(k => ({ sku: k, asin: S.only.asins[k] || "", title: S.only.titles[k] || k, price: null, qty: null, channel: "DEFAULT", status: "Not in listings report", extra: true, units: 0, sales: 0 }));
      return L.filter(l => S.only.skus.has(l.sku)).concat(extra).sort((a, b) => a.title.localeCompare(b.title));
    }
    const q = $("amz-q").value.trim().toLowerCase(), st = $("amz-fstatus").value, fm = $("amz-fmap").value, fc = $("amz-fchan").value;
    const conf = fm === "conflict" ? conflictAsins() : null;
    return allListings().filter(l => {
      if (fm === "conflict") {
        const mp = S.maps.get(l.sku);
        if (fm === "conflict" && !conf.has(l.asin || (mp && mp.asin) || "")) return false;
        if (fc === "fba" && !isFBA(l)) return false;
        if (fc === "fbm" && isFBA(l)) return false;
        return !q || l.title.toLowerCase().includes(q) || l.sku.toLowerCase().includes(q) || (l.asin || "").toLowerCase().includes(q);
      }
      if (st !== "all" && l.status !== st && !(st === "Active" && l.extra)) return false;
      const mapped = S.maps.has(l.sku);
      if (fm === "mapped" && !mapped) return false;
      if (fm === "unmapped" && mapped && l.sku !== S.open) return false;
      if (fc === "fba" && !isFBA(l)) return false;
      if (fc === "fbm" && isFBA(l)) return false;
      if (q && !(l.title.toLowerCase().includes(q) || l.sku.toLowerCase().includes(q) || (l.asin || "").toLowerCase().includes(q))) return false;
      return true;
    }).sort((a, b) => (b.sales - a.sales) || ((a.status === "Active" ? 0 : 1) - (b.status === "Active" ? 0 : 1)) || a.title.localeCompare(b.title));
  }

  function renderKpis() {
    const act = S.listings.filter(l => l.status === "Active");
    const actMapped = act.filter(l => S.maps.has(l.sku)).length;
    const fba = act.filter(isFBA), fbaMapped = fba.filter(l => S.maps.has(l.sku)).length;
    const k = [
      { l: "Active listings", v: act.length.toLocaleString(), s: `${S.listings.length.toLocaleString()} in the report` },
      { l: "Active mapped", v: act.length ? Math.round(actMapped / act.length * 100) + "%" : "—", s: `${actMapped} of ${act.length}`, c: "sales" },
      { l: "FBA mapped", v: fba.length ? Math.round(fbaMapped / fba.length * 100) + "%" : "—", s: `${fbaMapped} of ${fba.length} active FBA` },
      { l: "Sales mapped", v: (() => { const L = allListings(); const tot = L.reduce((a, l) => a + l.sales, 0); const mp = L.filter(l => S.maps.has(l.sku)).reduce((a, l) => a + l.sales, 0); return tot ? Math.round(mp / tot * 100) + "%" : "—"; })(), s: "Share of Amazon sales in the loaded reports", c: "sales" },
      { l: "Total mappings", v: S.maps.size.toLocaleString(), s: "Includes inactive listings" },
    ];
    $("amz-kpis").innerHTML = k.map(x => `<div class="kpi ${x.c || ""}"><span class="eyebrow">${x.l}</span><span class="v">${x.v}</span><span class="s">${x.s}</span></div>`).join("");
  }

  function editorRow(l) {
    const pk = packOf(l.title);
    const modeBtns = `<div class="seg" role="group" aria-label="Cost source"><button data-a="mode" data-v="shopify" aria-pressed="${S.mode === "shopify"}">Shopify product</button><button data-a="mode" data-v="manual" aria-pressed="${S.mode === "manual"}">Enter cost</button></div>`;
    let body;
    if (S.mode === "manual") {
      body = `<div class="row"><label class="stack" for="amz-manual">Cost per Amazon unit (what one sale of this listing costs you)<input id="amz-manual" class="inp num" type="text" inputmode="decimal" value="${esc(S.manual)}" placeholder="0.00"></label>${l.price ? `<span class="muted small">Listing price ${m(l.price)}</span>` : ""}</div>`;
    } else {
      const res = S.searching ? '<div class="skel">Searching Shopify…</div>'
        : S.searchErr ? `<div class="note bad">${esc(mcpMsg(S.searchErr))}</div>`
        : !S.results ? '<div class="muted small">Search by product name or Shopify SKU.</div>'
        : !S.results.length ? '<div class="muted small">No Shopify products match. Try fewer words, or the SKU.</div>'
        : `<div class="tbl-wrap res"><table class="lines"><thead><tr><th class="l">Shopify product</th><th class="l">SKU</th><th class="l">Vendor</th><th>Cost</th><th></th></tr></thead><tbody>${S.results.map(r => `<tr class="${S.pick && S.pick.id === r.id ? "picked" : ""}"><td class="l iname">${shopLink(r.pid, r.id, esc(r.name))}${r.status && r.status !== "ACTIVE" ? ` <span class="pill pos">${esc(r.status.toLowerCase())}</span>` : ""}</td><td class="l mono">${esc(r.sku) || '<span class="dim">—</span>'}</td><td class="l dim">${esc(r.vendor)}</td><td>${r.cost == null ? '<span class="pill miss">No cost</span>' : m(r.cost)}</td><td class="rbtns"><button class="mini ${S.pick && S.pick.id === r.id ? "primary" : ""}" data-a="pick" data-id="${esc(r.id)}" title="Select, then adjust units before saving">${S.pick && S.pick.id === r.id ? "Picked" : "Pick"}</button><button class="mini" data-a="picksave" data-id="${esc(r.id)}" title="Save this product and open the next unmapped listing" ${S.saving ? "disabled" : ""}>Save &amp; next</button></td></tr>`).join("")}</tbody></table></div>`;
      const u = Number(S.units) || 0;
      const picked = S.pick ? `<div class="pickbox"><b>${shopLink(S.pick.pid, S.pick.id, esc(S.pick.name))}</b> <span class="mono dim">${esc(S.pick.sku || "")}</span> · ${S.pick.cost == null ? '<span class="pill miss">No cost in Shopify</span>' : m(S.pick.cost) + " each"}
          <label class="inline" for="amz-units">× <input id="amz-units" class="inp num sm" type="text" inputmode="numeric" value="${esc(S.units)}"> per Amazon unit</label>
          <span id="amz-calc">${S.pick.cost != null && u > 0 ? "= <b>" + m(S.pick.cost * u) + "</b> per Amazon sale" : ""}</span>
          ${pk && pk !== u ? `<span class="pill miss">Title says ${pk}-pack</span>` : ""}</div>` : "";
      body = `<form class="row" id="amz-sform"><input id="amz-sq" class="inp grow" type="search" value="${esc(S.q)}" placeholder="Product name or SKU" aria-label="Search Shopify products"><button class="btn" type="submit">Search</button></form>${picked}${res}`;
    }
    return `<tr class="detail"><td colspan="11"><div class="dpanel wide">
      <div class="row edhead">${modeBtns}<span class="muted small">${l.asin ? "ASIN " + esc(l.asin) + " · " : ""}Amazon SKU <span class="mono">${esc(l.sku)}</span></span>
        <span class="dbtns right"><button class="mini primary" data-a="save" ${S.saving ? "disabled" : ""}>${S.saving ? "Saving…" : "Save"}</button><button class="mini" data-a="savenext" ${S.saving ? "disabled" : ""}>Save &amp; next</button><button class="mini" data-a="cancel">Cancel</button>${S.maps.has(l.sku) ? '<button class="mini" data-a="remove">Remove</button>' : ""}</span></div>
      ${body}
    </div></td></tr>`;
  }

  function render() {
    if ($("tab-amzmap").hidden) return;
    const st = $("amz-status");
    if (!S.db) st.textContent = "Mappings need the database. Reload the page, or sign in again.";
    else if (!S.listReady) st.textContent = "Loading listings…";
    else if (!allListings().length) st.textContent = "No listings yet. Upload your All Listings report (Inventory → Inventory Reports → All Listings Report).";
    else st.textContent = `${S.listings.length.toLocaleString()} listings from ${S.listMeta ? S.listMeta.file : "report"}${S.listMeta && S.listMeta.uploadedAt ? (/Amazon API/.test(S.listMeta.file || "") ? " · fetched " : " · uploaded ") + new Date(S.listMeta.uploadedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""} · refreshed from Amazon daily`;
    renderKpis();
    const t = $("amz-table");
    const ae = document.activeElement, activeId = ae && ae.id && ae.id.startsWith("amz-") && t.contains(ae) ? ae.id : null;
    const sel = activeId ? [ae.selectionStart, ae.selectionEnd] : null;
    const rows = filtered();
    const ob = $("amz-only");
    if (S.only) {
      const left = [...S.only.skus].filter(k => !S.maps.has(k)).length;
      ob.hidden = false;
      ob.innerHTML = `<span><b>${esc(S.only.label)}</b> · ${left ? `${left} still not mapped` : "all mapped now"}</span><span class="dbtns">${S.only.back ? `<button class="mini" type="button" data-only="back">Back to ${esc(S.only.backLabel || "the list")}</button>` : ""}<button class="mini" type="button" data-only="clear">Show all listings</button></span>`;
    } else { ob.hidden = true; ob.innerHTML = ""; }
    const shown = rows.slice(0, S.shown);
    const body = shown.map(l => {
      const mp = S.maps.get(l.sku), c = costOf(mp), open = S.open === l.sku;
      const mapped = !mp ? '<span class="pill miss">Not mapped</span>'
        : mp.kind === "manual" ? '<span class="pill manual">Manual cost</span>'
        : `<div class="iname">${shopLink(mp.productId || (S.costs.get(mp.variantId) || {}).pid, mp.variantId, esc((S.costs.get(mp.variantId) || {}).displayName || mp.vtitle))}</div><div class="mono dim small">${esc(mp.vsku || "")}</div>`;
      const pctv = c && c.cost != null && l.price ? Math.round(c.cost / l.price * 100) : null;
      return `<tr class="${open ? "openrow" : ""}"><td class="l"><div class="iname">${esc(l.title)}</div><div class="small dim">${l.asin ? `<a class="olink" href="https://www.amazon.com/dp/${encodeURIComponent(l.asin)}" target="_blank" rel="noopener">${esc(l.asin)}</a> · ` : ""}<span class="mono">${esc(l.sku)}</span></div></td>
        <td><button class="mini ${mp ? "" : "primary"}" data-a="${open ? "cancel" : "edit"}" data-sku="${esc(l.sku)}">${open ? "Close" : mp ? "Edit" : "Map"}</button></td>
        <td class="l">${isFBA(l) ? '<span class="pill web">FBA</span>' : '<span class="pill pos">Merchant</span>'}</td>
        <td>${l.price != null ? m(l.price) : '<span class="dim">—</span>'}</td>
        <td class="l ${l.status === "Active" ? "" : "dim"}">${esc(l.status)}</td>
        <td>${l.units ? l.units.toLocaleString() : '<span class="dim">—</span>'}</td><td>${l.sales ? m(l.sales) : '<span class="dim">—</span>'}</td>
        <td class="l">${mapped}</td>
        <td>${mp && mp.kind === "shopify" ? "×" + mp.units : '<span class="dim">—</span>'}</td>
        <td>${!c ? '<span class="dim">—</span>' : c.cost == null ? '<span class="pill miss">No cost</span>' : m(c.cost)}</td>
        <td class="dim">${pctv != null ? pctv + "%" : ""}</td>
        </tr>${open ? editorRow(l) : ""}`;
    }).join("");
    t.innerHTML = `<thead><tr><th class="l">Amazon listing</th><th></th><th class="l">Fulfillment</th><th>Price</th><th class="l">Status</th><th>Units sold</th><th>Sales</th><th class="l">Shopify product</th><th>Units</th><th>Cost per sale</th><th>Cost % of price</th></tr></thead>
      <tbody>${body || `<tr><td class="l dim" colspan="11">${S.listings.length ? "No listings match these filters." : "Upload your All Listings report to start mapping."}</td></tr>`}</tbody>`;
    $("amz-more").hidden = rows.length <= S.shown;
    $("amz-count").textContent = rows.length ? `Showing ${Math.min(S.shown, rows.length)} of ${rows.length}` : "";
    if (activeId && $(activeId)) { const i = $(activeId); i.focus(); try { i.setSelectionRange(sel[0], sel[1]); } catch (_) {} }
  }

  // ---------- events ----------
  ["amz-q", "amz-fstatus", "amz-fmap", "amz-fchan"].forEach(id => $(id).addEventListener(id === "amz-q" ? "input" : "change", () => { S.only = null; S.shown = PAGE; render(); }));
  $("amz-only").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-only]"); if (!b) return;
    const back = S.only && S.only.back;
    S.only = null; S.shown = PAGE;
    if (b.dataset.only === "back" && back) showTab(back); else render();
  });
  // Open the mapping tab showing only these seller SKUs: {skus: [...], titles: {sku: title}, asins: {sku: asin},
  // label, back: tab to return to, backLabel}. With one SKU its editor opens straight away.
  window.amzMapOnly = (o) => {
    S.only = { skus: new Set(o.skus || []), titles: o.titles || {}, asins: o.asins || {}, label: o.label || "Selected listings", back: o.back || null, backLabel: o.backLabel || "" };
    S.shown = PAGE; S.open = null;
    showTab("amzmap");
    if (o.skus && o.skus.length === 1) openEditor(o.skus[0]);
  };
  $("amz-more").addEventListener("click", () => { S.shown += PAGE; render(); });
  const tbl = $("amz-table");
  tbl.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-a]"); if (!b) return;
    const a = b.dataset.a;
    if (a === "edit") openEditor(b.dataset.sku);
    else if (a === "cancel") closeEditor();
    else if (a === "mode") { S.mode = b.dataset.v; render(); if (S.mode === "shopify" && !S.results && S.q) search(); }
    else if (a === "pick") { if (pickResult(b.dataset.id)) render(); }
    else if (a === "picksave") { if (pickResult(b.dataset.id)) save(true); }
    else if (a === "save") save(false);
    else if (a === "savenext") save(true);
    else if (a === "remove") removeMap();
  });
  tbl.addEventListener("submit", (ev) => { if (ev.target.id === "amz-sform") { ev.preventDefault(); search(); } });
  tbl.addEventListener("input", (ev) => {
    const id = ev.target.id;
    if (id === "amz-sq") S.q = ev.target.value;
    else if (id === "amz-manual") S.manual = ev.target.value;
    else if (id === "amz-units") { S.units = ev.target.value; const u = Number(S.units) || 0; const c = $("amz-calc"); if (c && S.pick && S.pick.cost != null) c.innerHTML = u > 0 ? "= <b>" + m(S.pick.cost * u) + "</b> per Amazon sale" : ""; }
  });
  tbl.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && S.open) closeEditor();
    if (ev.key === "Enter" && (ev.target.id === "amz-manual" || ev.target.id === "amz-units")) { ev.preventDefault(); save(ev.shiftKey); }
  });

  // =====================================================================
  // Amazon sales & profit
  // =====================================================================
  const A = { months: new Map(), titles: {}, start: null, end: null, preset: "30", days: null, loading: false, err: null, skuShown: 100, oShown: 200, reqId: 0, uploading: false,
    // orders straight from Amazon (SP-API): status = jt.v_amazon_api_status, days = day -> {mk -> [orders, units, sales, pending]}
    api: { status: null, days: new Map(), err: null, busy: false, msg: "" } };
  const addDays = window.JTDate.addDays;
  const shortDay = (ds) => new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const wkDay = (ds) => new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const m0f = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m0 = (n) => m0f.format(n || 0);
  const pct = (n) => isFinite(n) ? (n * 100).toFixed(1) + "%" : "—";
  const azNote = (kind, html) => { const n = $("az-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; };
  const titleOf = (sku) => { const l = S.listings.find(x => x.sku === sku); return l ? l.title : (A.titles[sku] || ""); };
  let listingIndex = null;
  function listingBySku(sku) { if (!listingIndex || listingIndex.n !== S.listings.length) { listingIndex = { n: S.listings.length, map: new Map(S.listings.map(l => [l.sku, l])) }; } return listingIndex.map.get(sku); }
  const unitCost = (sku, day) => { const c = costOf(S.maps.get(sku), day); return c && c.cost != null ? c.cost : null; };

  // Days with Amazon data: uploaded Transaction reports, and orders synced from Amazon.
  function dataBounds() {
    const ms = [...A.months.values()], st = A.api.status;
    const firsts = ms.map(x => x.firstDay), lasts = ms.map(x => x.lastDay);
    if (st && st.first_day) { firsts.push(st.first_day); lasts.push(st.last_day); }
    if (!firsts.length) return null;
    return { first: firsts.sort()[0], last: lasts.sort().pop(), txLast: ms.length ? ms.map(x => x.lastDay).sort().pop() : null };
  }
  window.JTRange.seg("az-rangeseg", "days");
  // Presets count back from the last day of Amazon data (reports are uploaded, so "today" is usually not in yet).
  function setAzRange(preset) {
    const b = dataBounds(); if (!b) return;
    A.preset = preset; [A.start, A.end] = window.JTRange.of(preset, b.last);
    if (A.start < b.first) A.start = b.first;
    if (A.end > b.last) A.end = b.last;
    $("az-start").value = A.start; $("az-end").value = A.end;
    document.querySelectorAll("#az-rangeseg button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.days === preset)));
    loadDays();
  }
  document.querySelectorAll("#az-rangeseg button").forEach(b => b.addEventListener("click", () => setAzRange(b.dataset.days)));
  const onAzDate = () => { const s = $("az-start").value, e = $("az-end").value; if (!s || !e || s > e) return; A.start = s; A.end = e; A.preset = null; document.querySelectorAll("#az-rangeseg button").forEach(x => x.setAttribute("aria-pressed", "false")); loadDays(); };
  $("az-start").addEventListener("change", onAzDate); $("az-end").addEventListener("change", onAzDate);

  async function loadDays() {
    if (!S.db || !A.start) return;
    const id = ++A.reqId; A.loading = true; A.err = null; renderSales();
    try {
      const [snap] = await Promise.all([
        S.db.collection("amzdays").where("date", ">=", A.start).where("date", "<=", A.end).limit(400).get(),
        loadApiDays(A.start, A.end).catch(e => { A.api.err = e; }),
      ]);
      if (id !== A.reqId) return;
      A.days = snap.docs.map(d => d.data()).sort((a, b) => a.date.localeCompare(b.date));
    } catch (e) { if (id === A.reqId) A.err = e; }
    if (id === A.reqId) { A.loading = false; A.skuShown = 100; A.oShown = 200; renderSales(); }
  }

  // ---------- orders straight from Amazon (SP-API) ----------
  const MK = { us: "Amazon.com", mx: "Amazon.com.mx", ca: "Amazon.ca" };
  async function loadApiStatus(refresh) {
    try {
      const r = await window.JT.rows(["as_of::text", "last_saved::text", "waiting", "failed_today", "first_day::text", "last_day::text", "fin_as_of::text"], "from jt.v_amazon_api_status", refresh);
      const x = r[0] || [];
      A.api.status = { as_of: x[0], last_saved: x[1], waiting: +x[2] || 0, failed: +x[3] || 0, first_day: x[4], last_day: x[5], fin_as_of: x[6] };
      A.api.err = null;
    } catch (e) { A.api.err = e; }
  }
  async function loadApiDays(start, end, refresh) {
    const r = await window.JT.rows(["day::text", "marketplace", "orders", "units", "sales", "pending_orders"],
      `from jt.v_amazon_api_daily where day between ${window.JT.q(start)} and ${window.JT.q(end)}`, refresh);
    const m = new Map();
    for (const [day, mk, o, u, sa, pe] of r) { const d = m.get(day) || {}; d[mk] = [+o || 0, +u || 0, +sa || 0, +pe || 0]; m.set(day, d); }
    A.api.days = m; A.api.range = start + "|" + end;
  }
  const apiDay = (day) => { const d = A.api.days.get(day); if (!d) return null; const t = [0, 0, 0, 0]; for (const k in d) d[k].forEach((v, i) => t[i] += v); return t; };
  const ago = (ts) => {
    if (!ts) return "";
    const t = new Date(ts.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")), min = Math.round((Date.now() - t.getTime()) / 60000);
    if (!isFinite(min)) return "";
    if (min < 1) return "just now"; if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60); if (h < 24) return `${h} hour${h > 1 ? "s" : ""} ago`;
    return t.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  function renderLive() {
    const st = A.api.status, el = $("az-live-status"), host = $("az-live-kpis");
    $("az-refresh").disabled = A.api.busy;
    $("az-refresh").textContent = A.api.busy ? "Refreshing…" : "Refresh from Amazon";
    if (A.api.busy) { el.textContent = A.api.msg; }
    else if (A.api.err && !st) { el.textContent = "Couldn't load orders from Amazon. Reload the page."; }
    else if (!st || !st.first_day) { el.textContent = st && st.waiting ? "Amazon is preparing the first order reports…" : "No orders from Amazon yet."; }
    else el.textContent = `Orders synced ${ago(st.as_of)}${st.fin_as_of ? ` · fees & profit ${ago(st.fin_as_of)}` : ""}${st.waiting ? ` · ${st.waiting} report${st.waiting > 1 ? "s" : ""} on the way from Amazon` : ""}${A.api.msg ? " · " + A.api.msg : ""}`;
    if (!st || !st.first_day || !A.start) { host.innerHTML = ""; return; }
    const T = { all: [0, 0, 0, 0] }, todayPT = window.JTDate.today();
    for (const [day, d] of A.api.days) {
      if (day < A.start || day > A.end) continue;
      for (const k in d) { T[k] = T[k] || [0, 0, 0, 0]; d[k].forEach((v, i) => { T[k][i] += v; T.all[i] += v; }); }
    }
    const today = apiDay(todayPT);
    const k = [
      { c: "sales", l: "Ordered sales", v: m0(T.all[2]), s: `${T.all[0].toLocaleString()} orders · ${T.all[1].toLocaleString()} units` },
      ...["us", "mx", "ca"].filter(x => T[x]).map(x => ({ l: MK[x], v: m0(T[x][2]), s: `${T[x][0].toLocaleString()} orders · ${pct(T.all[2] ? T[x][2] / T.all[2] : 0)} of sales` })),
      { l: "Not shipped yet", v: T.all[3].toLocaleString(), s: "Pending orders in this range" },
    ];
    if (A.end >= todayPT && today) k.splice(1, 0, { l: "Today so far", v: m0(today[2]), s: `${today[0].toLocaleString()} orders · ${today[1].toLocaleString()} units` });
    host.innerHTML = k.map(x => `<div class="kpi ${x.c || ""}"><span class="eyebrow">${x.l}</span><span class="v">${x.v}</span><span class="s">${x.s}</span></div>`).join("");
  }
  // Refresh: today's and yesterday's money (fees, refunds, profit) from Amazon's Finances API, then a new report of
  // recent orders, waiting for it (usually 1-3 minutes).
  async function refreshOrders() {
    if (A.api.busy) return;
    A.api.busy = true; A.api.msg = "Getting today's fees and payments from Amazon…"; renderLive();
    try {
      const f = await window.JT.amazon({ action: "fin_recent" });
      if (!f || !f.ok) throw new Error((f && f.error) || "Amazon didn't answer.");
      if (window.JTWeb) window.JTWeb.clearCache();
      if (A.start) loadDays();
      A.api.msg = "Asking Amazon for the latest orders…"; renderLive();
      const r = await window.JT.amazon({ action: "sync", force: true });
      if (!r || !r.ok) throw new Error((r && r.error) || "Amazon didn't answer.");
      if (r.throttled) throw new Error("Amazon only allows a few report requests at a time. Try again in a minute.");
      const want = new Set(r.requested || []);
      let got = false;
      for (let i = 0; i < 12 && want.size && !got; i++) {
        A.api.msg = `Amazon is preparing the report… (${i ? "still working, " : ""}usually 1–3 minutes)`; renderLive();
        await new Promise(f => setTimeout(f, 20000));
        const x = await window.JT.amazon({ action: "sync" });
        if (x && x.ok) for (const c of x.collected || []) if (want.has(c.report_id) && c.status !== "waiting") { got = true; if (c.status === "failed") throw new Error("Amazon couldn't make the report: " + (c.detail || "unknown reason")); }
      }
      A.api.msg = got ? "" : "Amazon is still working on it — the orders will show up on the next hourly sync.";
    } catch (e) {
      A.api.msg = "couldn't refresh: " + (e && e.message ? e.message : String(e));
    }
    if (window.JTWeb) window.JTWeb.clearCache();
    await loadApiStatus(true);
    A.api.busy = false;
    const b = dataBounds();
    if (b && A.preset) setAzRange(A.preset); else if (A.start) { await loadApiDays(A.start, A.end, true).catch(() => {}); renderSales(); } else renderLive();
  }
  $("az-refresh").addEventListener("click", refreshOrders);

  // aggregate current range
  function aggregate() {
    const byDay = [], bySku = new Map(), orders = new Map();
    let unmappedSales = 0, totalSales = 0;
    for (const d of A.days || []) {
      const t = d.totals || {};
      let cogs = 0, mappedSales = 0;
      for (const o of d.orders || []) {
        const sku = d.skus[o[2]], uc = unitCost(sku, d.date), c = uc != null ? uc * o[3] : 0;
        cogs += c; if (uc != null) mappedSales += o[4];
        const s = bySku.get(sku) || { sku, units: 0, sales: 0, promo: 0, fees: 0, net: 0, cogs: 0, refunds: 0, refundUnits: 0, orders: 0 };
        s.units += o[3]; s.sales += o[4]; s.promo += o[6]; s.fees += o[7] + o[8]; s.net += o[9]; s.cogs += c; s.orders++;
        bySku.set(sku, s);
        const k = o[1];
        const ord = orders.get(k) || { id: k, day: d.date, time: o[0], fba: o[10], lines: [], units: 0, sales: 0, ship: 0, promo: 0, sellfees: 0, fbafees: 0, net: 0, cogs: 0, unmapped: 0 };
        ord.lines.push(sku); ord.units += o[3]; ord.sales += o[4]; ord.ship += o[5]; ord.promo += o[6]; ord.sellfees += o[7]; ord.fbafees += o[8]; ord.net += o[9]; ord.cogs += c; if (uc == null) ord.unmapped++;
        orders.set(k, ord);
      }
      for (const r of d.refunds || []) {
        if (r[2] < 0) continue;
        const sku = d.skus[r[2]]; const s = bySku.get(sku) || { sku, units: 0, sales: 0, promo: 0, fees: 0, net: 0, cogs: 0, refunds: 0, refundUnits: 0, orders: 0 };
        s.refunds += r[6]; s.refundUnits += r[3]; bySku.set(sku, s);
      }
      const oth = t.other || 0;
      const gp = (t.orders_net || 0) + (t.refunds_net || 0) - cogs;
      totalSales += t.sales || 0; unmappedSales += (t.sales || 0) - mappedSales;
      byDay.push({ day: d.date, orders: t.orders || 0, units: t.units || 0, sales: t.sales || 0, ship: t.ship || 0, promo: t.promo || 0, sellfees: t.sellfees || 0, fbafees: t.fbafees || 0, ordersNet: t.orders_net || 0, refunds: t.refunds_net || 0, cogs, gp, other: oth, profit: gp + oth, mappedSales, otherBreak: d.other || {} });
    }
    return { byDay, bySku, orders, coverage: totalSales ? 1 - unmappedSales / totalSales : 0 };
  }

  function renderSales() {
    if ($("tab-amazon").hidden) return;
    const st = $("az-status");
    const b = dataBounds();
    renderLive();
    if (!S.db) { st.textContent = "Amazon data needs the database. Reload the page, or sign in again."; return; }
    if (!b) { st.textContent = A.monthsReady ? "No Amazon data yet. Upload a Transaction report (Payments → Reports Repository → Transaction)." : "Loading Amazon data…"; ["az-kpis","az-chart","az-daily","az-skus","az-orders"].forEach(id => $(id).innerHTML = ""); return; }
    if (A.err) { st.textContent = ""; azNote("bad", "Couldn't load Amazon days. Reload the page."); return; }
    st.textContent = A.loading ? "Loading…" : `${b.txLast ? `Fees & profit through ${shortDay(b.txLast)}, ${b.txLast.slice(0, 4)}` : "No fees & profit data yet"} · showing ${shortDay(A.start)} – ${shortDay(A.end)}${A.days && A.days.length > 100 ? " · large range, may be slow" : ""}`;
    if (!A.days) return;
    const ag = aggregate();
    // days in the range with orders from Amazon but no Transaction report yet: ordered sales only
    const txDays = new Set(ag.byDay.map(r => r.day));
    for (const r of ag.byDay) { const a = apiDay(r.day); r.ordered = a ? a[2] : null; r.orderedOrders = a ? a[0] : null; }
    const gap = [];
    for (const day of [...A.api.days.keys()].sort()) {
      if (day < A.start || day > A.end || txDays.has(day)) continue;
      const a = apiDay(day); gap.push(day);
      ag.byDay.push({ day, apiOnly: true, ordered: a[2], orderedOrders: a[0], orders: 0, units: 0, sales: 0, ship: 0, promo: 0, sellfees: 0, fbafees: 0, ordersNet: 0, refunds: 0, cogs: 0, gp: 0, other: 0, profit: 0, mappedSales: 0, otherBreak: {} });
    }
    ag.byDay.sort((x, y) => x.day.localeCompare(y.day));
    const gapNote = gap.length ? `${gap.length === 1 ? shortDay(gap[0]) + " isn't" : `${shortDay(gap[0])} – ${shortDay(gap[gap.length - 1])} aren't`} in Amazon's payments data yet, so ${gap.length === 1 ? "it shows" : "they show"} ordered sales only (no fees or profit). Fees and profit come in every hour.` : "";
    const sum = (k) => ag.byDay.reduce((a, r) => a + r[k], 0);
    const sales = sum("sales"), fees = -(sum("sellfees") + sum("fbafees")), cogs = sum("cogs"), profit = sum("profit"), gp = sum("gp"), other = sum("other"), refunds = sum("refunds");
    const k = [
      { c: "sales", l: "Product sales", v: m0(sales), s: `${sum("orders").toLocaleString()} orders · ${sum("units").toLocaleString()} units` },
      { l: "Amazon fees", v: m0(fees), s: `${pct(fees / sales)} of sales · referral ${m0(-sum("sellfees"))} · FBA ${m0(-sum("fbafees"))}` },
      { l: "Refunds", v: `<span class="neg">${m0(refunds)}</span>`, s: "Net of fees Amazon returns" },
      { c: "cost", l: "Product cost", v: m0(cogs), s: `<span style="color:${ag.coverage < 0.95 ? "var(--warn)" : "inherit"}">${pct(ag.coverage)} of sales mapped</span>` },
      { l: "Gross profit", v: `<span class="${gp < 0 ? "neg" : ""}">${m0(gp)}</span>`, s: `${pct(gp / sales)} margin · after fees, refunds & cost` },
      { l: "Other Amazon charges", v: `<span class="${other < 0 ? "neg" : ""}">${m0(other)}</span>`, s: "Storage, inbound, labels, reimbursements" },
      { c: "sales", l: "Profit", v: `<span class="${profit < 0 ? "neg" : ""}">${m0(profit)}</span>`, s: `${pct(profit / sales)} of sales` },
    ];
    $("az-kpis").innerHTML = k.map(x => `<div class="kpi ${x.c || ""}"><span class="eyebrow">${x.l}</span><span class="v">${x.v}</span><span class="s">${x.s}</span></div>`).join("");
    if (!txDays.size && gap.length) $("az-kpis").innerHTML = `<div class="kpi"><span class="eyebrow">Fees &amp; profit</span><span class="v dimv">—</span><span class="s">Amazon's payments data doesn't cover these days yet.</span></div>`;
    const notes = [];
    if (txDays.size && ag.coverage < 0.95) notes.push(["warn", `Only ${pct(ag.coverage)} of these sales are mapped to a product cost, so profit is overstated. <button class="mini" data-go="amzmap">Map listings</button>`]);
    if (gapNote) notes.push(["info", gapNote]);
    if (notes.length) { const n = $("az-note"); n.hidden = false; n.innerHTML = notes.map(([k, h]) => `<div class="note ${k}">${h}</div>`).join(""); } else azNote("", "");
    renderAzChart(ag.byDay); renderAzDaily(ag.byDay); renderAzSkus(ag); renderAzOrders(ag);
  }

  function renderAzChart(rows) {
    const host = $("az-chart");
    if (!rows.length) { host.innerHTML = '<div class="skel">No Amazon activity in this range.</div>'; return; }
    const W = Math.max(320, host.clientWidth || 800), H = W < 560 ? 220 : 280, pad = { l: 60, r: 12, t: 12, b: 28 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const bar = (r) => r.apiOnly ? r.ordered || 0 : r.sales;
    const hi = Math.max(1, ...rows.map(r => Math.max(bar(r), r.profit))), lo = Math.min(0, ...rows.map(r => r.profit));
    const nice = (v) => { const e = Math.pow(10, Math.floor(Math.log10(v))); for (const f of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (f * e >= v) return f * e; return 10 * e; };
    const max = nice(hi), min = lo < 0 ? -nice(-lo) : 0;
    const y = (v) => pad.t + ih - ((v - min) / (max - min)) * ih;
    const bw = iw / rows.length, fmt = (v) => Math.abs(v) >= 1000 ? (v < 0 ? "-" : "") + "$" + (+(Math.abs(v) / 1000).toFixed(1)) + "k" : "$" + Math.round(v);
    const ticks = []; for (let i = 0; i <= 4; i++) ticks.push(min + (max - min) * i / 4);
    const every = Math.ceil(rows.length / Math.max(2, Math.floor(iw / 58)));
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily Amazon product sales and profit">`;
    for (const t of ticks) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line-soft)"/><text x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="var(--faint)" font-family="var(--mono)">${fmt(t)}</text>`;
    if (min < 0) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/>`;
    rows.forEach((r, i) => { const x = pad.l + i * bw, w = Math.max(2, bw * 0.62); s += `<rect x="${x + (bw - w) / 2}" y="${y(bar(r))}" width="${w}" height="${Math.max(0, y(0) - y(bar(r)))}" fill="var(--sales)" ${r.apiOnly ? 'fill-opacity="0.4" stroke="var(--sales)" stroke-dasharray="3 2"' : ""} rx="2"/>`; if (i % every === 0 || (i === rows.length - 1 && i % every >= every / 2)) s += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${shortDay(r.day)}</text>`; });
    s += `<polyline points="${rows.map((r, i) => r.apiOnly ? null : `${pad.l + i * bw + bw / 2},${y(r.profit)}`).filter(Boolean).join(" ")}" fill="none" stroke="var(--good)" stroke-width="2" stroke-linejoin="round"/>`;
    rows.forEach((r, i) => { s += `<rect data-i="${i}" x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${ih}" fill="transparent"/>`; });
    s += `</svg><div class="tip" hidden></div>`;
    host.innerHTML = s;
    const tip = host.querySelector(".tip"), svg = host.querySelector("svg");
    svg.addEventListener("pointermove", (ev) => {
      const t = ev.target.closest("rect[data-i]"); if (!t) { tip.hidden = true; return; }
      const r = rows[+t.dataset.i], sb = svg.getBoundingClientRect(), box = host.getBoundingClientRect();
      tip.innerHTML = r.apiOnly ? `<b>${wkDay(r.day)} ${shortDay(r.day)}</b><br>Ordered ${m(r.ordered)} · ${r.orderedOrders} orders<br><span class="dim">No fees &amp; profit yet</span>`
        : `<b>${wkDay(r.day)} ${shortDay(r.day)}</b><br>Sales ${m(r.sales)} · ${r.orders} orders${r.ordered != null ? `<br>Ordered ${m(r.ordered)}` : ""}<br>Profit ${m(r.profit)}`;
      tip.hidden = false; tip.style.left = Math.min(Math.max((pad.l + (+t.dataset.i) * bw + bw / 2) * sb.width / W, 110), box.width - 110) + "px"; tip.style.top = (y(Math.max(bar(r), r.profit)) * sb.height / H - 8) + "px";
    });
    svg.addEventListener("pointerleave", () => { tip.hidden = true; });
  }

  function renderAzDaily(rows) {
    const cols = ["Day", "Orders", "Units", "Product sales", "Ordered (Amazon)", "Promos", "Referral fees", "FBA fees", "Order proceeds", "Refunds", "Product cost", "Gross profit", "Other charges", "Profit", "Margin", "Mapped"];
    const T = {}; const keys = ["orders", "units", "sales", "promo", "sellfees", "fbafees", "ordersNet", "refunds", "cogs", "gp", "other", "profit", "mappedSales"];
    keys.forEach(k => T[k] = 0); T.ordered = 0; let anyOrdered = false;
    const cell = (v) => `<td class="${v < 0 ? "neg" : ""}">${m(v)}</td>`;
    const body = [...rows].reverse().map(r => {
      if (r.ordered != null) { T.ordered += r.ordered; anyOrdered = true; }
      const ordCell = `<td class="${r.ordered == null ? "dim" : ""}" title="Ordered product sales by purchase date, from Amazon">${r.ordered == null ? "—" : m(r.ordered)}</td>`;
      if (r.apiOnly) return `<tr class="apionly"><td class="l">${wkDay(r.day)} ${shortDay(r.day)}</td><td class="dim">${(r.orderedOrders || 0).toLocaleString()}</td><td class="dim">—</td><td class="dim">—</td>${ordCell}${'<td class="dim">—</td>'.repeat(11)}</tr>`;
      keys.forEach(k => T[k] += r[k]);
      const ob = Object.entries(r.otherBreak).map(([k, v]) => `${({ storage: "Storage", fbaother: "FBA other", service: "Service", labels: "Labels", adjust: "Adjustments" })[k] || k} ${m(v)}`).join(" · ");
      return `<tr class="${r.profit < 0 ? "lossday" : r.sales && r.mappedSales / r.sales < 0.95 ? "flag" : ""}"><td class="l">${wkDay(r.day)} ${shortDay(r.day)}</td><td>${r.orders.toLocaleString()}</td><td>${r.units.toLocaleString()}</td><td><b>${m(r.sales)}</b></td>${ordCell}${cell(r.promo)}${cell(r.sellfees)}${cell(r.fbafees)}<td>${m(r.ordersNet)}</td>${cell(r.refunds)}<td>${m(r.cogs)}</td>${cell(r.gp)}<td class="${r.other < 0 ? "neg" : ""}" title="${esc(ob)}">${m(r.other)}</td><td class="${r.profit < 0 ? "neg" : ""}"><b>${m(r.profit)}</b></td><td class="dim">${r.sales ? pct(r.profit / r.sales) : ""}</td><td class="dim">${r.sales ? pct(r.mappedSales / r.sales) : ""}</td></tr>`;
    }).join("");
    $("az-daily").innerHTML = `<thead><tr>${cols.map((c, i) => `<th class="${i === 0 ? "l" : ""}">${c}</th>`).join("")}</tr></thead><tbody>${body}</tbody>
      <tfoot><tr><td class="l">Total</td><td>${T.orders.toLocaleString()}</td><td>${T.units.toLocaleString()}</td><td>${m(T.sales)}</td><td>${anyOrdered ? m(T.ordered) : "—"}</td><td>${m(T.promo)}</td><td>${m(T.sellfees)}</td><td>${m(T.fbafees)}</td><td>${m(T.ordersNet)}</td><td>${m(T.refunds)}</td><td>${m(T.cogs)}</td><td>${m(T.gp)}</td><td>${m(T.other)}</td><td class="${T.profit < 0 ? "neg" : ""}">${m(T.profit)}</td><td>${T.sales ? pct(T.profit / T.sales) : ""}</td><td>${T.sales ? pct(T.mappedSales / T.sales) : ""}</td></tr></tfoot>`;
    window.jtLabelCells($("az-daily"));
  }

  function renderAzSkus(ag) {
    const q = $("az-skuq").value.trim().toLowerCase(), onlyUn = $("az-skumap").checked;
    const rows = [...ag.bySku.values()].filter(s => {
      if (onlyUn && S.maps.has(s.sku)) return false;
      if (q && !(s.sku.toLowerCase().includes(q) || titleOf(s.sku).toLowerCase().includes(q))) return false;
      return true;
    }).sort((a, b) => b.sales - a.sales);
    const body = rows.slice(0, A.skuShown).map(s => {
      const mp = S.maps.get(s.sku), mapped = unitCost(s.sku) != null, profit = s.net + s.refunds - s.cogs;
      const l = listingBySku(s.sku);
      return `<tr><td class="l"><div class="iname">${esc(titleOf(s.sku) || s.sku)}</div><div class="small dim">${l && l.asin ? `<a class="olink" href="https://www.amazon.com/dp/${encodeURIComponent(l.asin)}" target="_blank" rel="noopener">${esc(l.asin)}</a> · ` : ""}<span class="mono">${esc(s.sku)}</span>${mp && mp.kind === "shopify" ? ` · → ${shopLink(mp.productId || (S.costs.get(mp.variantId) || {}).pid, mp.variantId, esc(mp.vsku || mp.vtitle))}${mp.units > 1 ? " ×" + mp.units : ""}` : ""}</div></td>
        <td>${s.units.toLocaleString()}</td><td><b>${m(s.sales)}</b></td><td class="neg">${m(s.fees)}</td><td>${m(s.net)}</td><td class="${s.refunds < 0 ? "neg" : "dim"}">${s.refunds ? m(s.refunds) : "—"}</td>
        <td>${mapped ? m(s.cogs) : `<button class="pill miss" data-map="${esc(s.sku)}">Map</button>`}</td>
        <td class="${profit < 0 ? "neg" : ""}">${mapped ? "<b>" + m(profit) + "</b>" : '<span class="dim">—</span>'}</td><td class="dim">${mapped && s.sales ? pct(profit / s.sales) : ""}</td>
        <td>${mapped ? `<button class="mini" data-map="${esc(s.sku)}">Edit</button>` : ""}</td></tr>`;
    }).join("");
    $("az-skus").innerHTML = `<thead><tr><th class="l">Listing</th><th>Units</th><th>Product sales</th><th>Amazon fees</th><th>Order proceeds</th><th>Refunds</th><th>Product cost</th><th>Profit</th><th>Margin</th><th></th></tr></thead><tbody>${body || '<tr><td class="l dim" colspan="10">No listings match.</td></tr>'}</tbody>`;
    $("az-skumore").hidden = rows.length <= A.skuShown;
    $("az-skucount").textContent = rows.length ? `Showing ${Math.min(A.skuShown, rows.length)} of ${rows.length} listings` : "";
  }

  function renderAzOrders(ag) {
    const q = $("az-oq").value.trim().toLowerCase(), ch = $("az-ochan").value;
    const rows = [...ag.orders.values()].filter(o => {
      if (ch === "fba" && !o.fba) return false; if (ch === "fbm" && o.fba) return false;
      if (q && !(o.id.includes(q) || o.lines.some(sku => sku.toLowerCase().includes(q) || titleOf(sku).toLowerCase().includes(q)))) return false;
      return true;
    }).sort((a, b) => (b.day + b.time).localeCompare(a.day + a.time));
    const body = rows.slice(0, A.oShown).map(o => {
      const profit = o.unmapped ? null : o.net - o.cogs;
      const first = o.lines[0], more = new Set(o.lines).size - 1;
      return `<tr><td class="l mono"><a class="olink" href="https://sellercentral.amazon.com/orders-v3/order/${encodeURIComponent(o.id)}" target="_blank" rel="noopener">${esc(o.id)}</a></td><td class="l">${shortDay(o.day)} <span class="dim">${o.time}</span></td><td class="l">${o.fba ? '<span class="pill web">FBA</span>' : '<span class="pill pos">Merchant</span>'}</td>
        <td class="l"><div class="iname">${esc(titleOf(first) || first)}</div>${more > 0 ? `<div class="small dim">+${more} more</div>` : ""}</td><td>${o.units}</td><td>${m(o.sales)}</td><td class="${o.promo < 0 ? "neg" : "dim"}">${o.promo ? m(o.promo) : "—"}</td><td class="neg">${m(o.sellfees)}</td><td class="neg">${m(o.fbafees)}</td><td>${m(o.net)}</td>
        <td>${o.unmapped ? `<button class="pill miss" data-map="${esc(o.lines.find(sku => unitCost(sku) == null))}">Map</button>` : m(o.cogs)}</td><td class="${profit != null && profit < 0 ? "neg" : ""}">${profit == null ? '<span class="dim">—</span>' : "<b>" + m(profit) + "</b>"}</td><td class="dim">${profit != null && o.sales ? pct(profit / o.sales) : ""}</td></tr>`;
    }).join("");
    $("az-orders").innerHTML = `<thead><tr><th class="l">Order</th><th class="l">Posted</th><th class="l">Fulfillment</th><th class="l">Item</th><th>Units</th><th>Product sales</th><th>Promos</th><th>Referral fee</th><th>FBA fee</th><th>Proceeds</th><th>Product cost</th><th>Profit</th><th>Margin</th></tr></thead><tbody>${body || '<tr><td class="l dim" colspan="13">No orders match.</td></tr>'}</tbody>`;
    $("az-omore").hidden = rows.length <= A.oShown;
    $("az-ocount").textContent = rows.length ? `Showing ${Math.min(A.oShown, rows.length)} of ${rows.length.toLocaleString()} orders` : "";
  }

  ["az-skuq", "az-skumap"].forEach(id => $(id).addEventListener(id === "az-skuq" ? "input" : "change", () => { A.skuShown = 100; renderSales(); }));
  ["az-oq", "az-ochan"].forEach(id => $(id).addEventListener(id === "az-oq" ? "input" : "change", () => { A.oShown = 200; renderSales(); }));
  $("az-skumore").addEventListener("click", () => { A.skuShown += 100; renderSales(); });
  $("az-omore").addEventListener("click", () => { A.oShown += 200; renderSales(); });
  $("tab-amazon").addEventListener("click", (ev) => {
    const g = ev.target.closest("[data-go]"); if (g) { showTab(g.dataset.go); return; }
    const b = ev.target.closest("[data-map]"); if (!b) return;
    jumpToMap(b.dataset.map);
  });
  function jumpToMap(sku) {
    showTab("amzmap");
    $("amz-fstatus").value = "all"; $("amz-fmap").value = "all"; $("amz-fchan").value = "all"; $("amz-q").value = sku; S.shown = PAGE;
    openEditor(sku);
  }

  // ---------- Transaction report upload (in page) ----------
  function parseCSVLine(text) {
    const rows = []; let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
      else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  function parseDT(s) {
    const mt = /(\w{3}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}):\d{2} (AM|PM)/.exec(s || ""); if (!mt) return null;
    let h = +mt[4] % 12 + (mt[6] === "PM" ? 12 : 0);
    return [`${mt[3]}-${String(MON[mt[1]]).padStart(2, "0")}-${mt[2].padStart(2, "0")}`, `${String(h).padStart(2, "0")}:${mt[5]}`];
  }
  const CAT = { "FBA Inventory Fee": "storage", "FBA Inventory Fee - Correction": "storage", "FBA Inventory Fee - Reversal": "storage", "FBA Transaction fees": "fbaother", "Service Fee": "service", "Shipping Services": "labels" };
  const r2 = (x) => Math.round(x * 100) / 100;

  async function uploadTransactions(file) {
    if (!file || !S.db || A.uploading) return;
    A.uploading = true; $("az-status").textContent = `Reading ${file.name}…`;
    try {
      const rows = parseCSVLine((await file.text()).replace(/^﻿/, ""));
      const hi = rows.findIndex(r => (r[0] || "").trim().toLowerCase() === "date/time");
      if (hi < 0) throw new Error("This doesn't look like a Transaction report. Download Payments → Reports Repository → Transaction.");
      const H = rows[hi].map(h => h.trim().toLowerCase()), ix = (n) => H.indexOf(n);
      const need = ["type", "order id", "sku", "quantity", "product sales", "selling fees", "fba fees", "total"];
      for (const n of need) if (ix(n) < 0) throw new Error(`The report is missing the "${n}" column.`);
      const num = (r, n) => { const i = ix(n); if (i < 0) return 0; const v = parseFloat(String(r[i] || "0").replace(/,/g, "")); return isNaN(v) ? 0 : v; };
      const str = (r, n) => { const i = ix(n); return i < 0 ? "" : String(r[i] || "").trim(); };
      const days = new Map();
      const D = (day) => { if (!days.has(day)) days.set(day, { skus: [], ski: new Map(), orders: [], refunds: [], other: {}, tot: {} }); return days.get(day); };
      const si = (d, sku) => { if (!d.ski.has(sku)) { d.ski.set(sku, d.skus.length); d.skus.push(sku); } return d.ski.get(sku); };
      const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
      for (const r of rows.slice(hi + 1)) {
        const type = str(r, "type"); if (!type || type === "Transfer") continue;
        const dt = parseDT(str(r, "date/time")); if (!dt) continue;
        const d = D(dt[0]), tot = num(r, "total");
        if (type === "Order") {
          const s = num(r, "product sales"), sh = num(r, "shipping credits") + num(r, "gift wrap credits"), pr = num(r, "promotional rebates"), sf = num(r, "selling fees"), ff = num(r, "fba fees"), q = Math.round(num(r, "quantity"));
          d.orders.push([dt[1], str(r, "order id"), si(d, str(r, "sku")), q, r2(s), r2(sh), r2(pr), r2(sf), r2(ff), r2(tot), str(r, "fulfillment") === "Amazon" ? 1 : 0]);
          add(d.tot, "orders_net", tot); add(d.tot, "sales", s); add(d.tot, "ship", sh); add(d.tot, "promo", pr); add(d.tot, "sellfees", sf); add(d.tot, "fbafees", ff); add(d.tot, "units", q);
        } else if (type === "Refund") {
          const s = num(r, "product sales") + num(r, "shipping credits") + num(r, "gift wrap credits") + num(r, "promotional rebates"), q = Math.round(num(r, "quantity"));
          const sku = str(r, "sku");
          d.refunds.push([dt[1], str(r, "order id"), sku ? si(d, sku) : -1, q, r2(s), r2(num(r, "selling fees") + num(r, "fba fees") + num(r, "other transaction fees")), r2(tot)]);
          add(d.tot, "refunds_net", tot); add(d.tot, "refund_sales", s); add(d.tot, "refund_units", q);
        } else { add(d.other, CAT[type] || "adjust", tot); add(d.tot, "other", tot); }
      }
      if (!days.size) throw new Error("No transactions found in that file.");
      const now = new Date().toISOString(), list = [...days.keys()].sort();
      let n = 0;
      for (const day of list) {
        const d = days.get(day);
        d.tot.orders = new Set(d.orders.map(o => o[1])).size;
        const totals = {}; for (const k in d.tot) totals[k] = r2(d.tot[k]);
        const other = {}; for (const k in d.other) other[k] = r2(d.other[k]);
        $("az-status").textContent = `Saving day ${++n} of ${list.length}…`;
        await S.db.collection("amzdays").doc(day).set({ date: day, skus: d.skus, orders: d.orders, refunds: d.refunds, other, totals, file: file.name, uploadedAt: now });
      }
      // rebuild month summaries for the months touched
      const months = [...new Set(list.map(d => d.slice(0, 7)))];
      for (const mo of months) {
        $("az-status").textContent = `Updating ${mo} summary…`;
        const snap = await S.db.collection("amzdays").where("date", ">=", mo + "-01").where("date", "<=", mo + "-31").limit(40).get();
        const skus = {}, T = {}; const ds = [];
        for (const doc of snap.docs) {
          const d = doc.data(); ds.push(d.date);
          for (const o of d.orders || []) { const k = d.skus[o[2]]; const a = skus[k] || (skus[k] = [0, 0, 0]); a[0] += o[3]; a[1] += o[4]; a[2] += o[9]; }
          for (const k in d.totals || {}) T[k] = (T[k] || 0) + d.totals[k];
        }
        ds.sort();
        for (const k in skus) skus[k] = [skus[k][0], r2(skus[k][1]), r2(skus[k][2])];
        for (const k in T) T[k] = r2(T[k]);
        await S.db.collection("amzmonths").doc(mo).set({ month: mo, firstDay: ds[0], lastDay: ds[ds.length - 1], days: ds.length, skus, totals: T, updatedAt: now });
      }
      azNote("info", `Loaded ${list.length} days (${shortDay(list[0])} – ${shortDay(list[list.length - 1])}) from ${esc(file.name)}. Days in this file replaced any earlier upload of the same days.`);
    } catch (e) {
      azNote("bad", esc(e && e.message ? e.message : e && e.code === "invalid_argument" ? "You don't have permission to upload on this dashboard." : "Upload stopped partway. Upload the same file again."));
    }
    A.uploading = false; $("az-tfile").value = ""; renderSales();
  }
  $("az-tfile").addEventListener("change", (e) => uploadTransactions(e.target.files[0]));

  function applyMonths(snap) {
    const mp = new Map(); for (const d of snap.docs) { const b = d.data() || {}; if (b.month) mp.set(b.month, b); }
    const had = A.months.size; A.months = mp; A.monthsReady = true;
    if (!A.start || !had) setAzRange(A.preset || "30"); else renderSales();
    render(); // mapping tab uses sales totals
  }
  function skuSales() {
    const out = new Map();
    for (const mo of A.months.values()) for (const k in mo.skus || {}) { const a = out.get(k) || [0, 0]; a[0] += mo.skus[k][0]; a[1] += mo.skus[k][1]; out.set(k, a); }
    return out;
  }

  // ---------- boot ----------
  const use = window.claude && window.claude.use ? window.claude.use.bind(window.claude) : null;
  showTab((location.hash || "").replace("#", ""));
  if (!use) { render(); return; }
  window.JT.docStore().then(db => {
    S.db = db; if (!db) { render(); return; }
    db.collection("amzlistings").onSnapshot(applyListings, () => { S.listReady = true; render(); });
    // All mappings (there are well over 1,000 now; the old query stopped at 1,000, so sales of the rest showed as
    // unmapped). Read in parts so a big reply is never cut off; re-read whenever a mapping is saved anywhere on the page.
    let mapsLoad = 0;
    const loadMaps = async () => {
      const id = ++mapsLoad;
      try {
        const r = await window.JT.rowsSplit(["id", "data"], "from jt.docs where collection = 'amzmap'", "id", 4, true);
        if (id !== mapsLoad) return;
        applyMaps({ docs: r.map(([i, d]) => ({ id: i, data: () => d })) });
      } catch (e) { S.mapsReady = true; render(); }
    };
    db.collection("amzmap").limit(1).onSnapshot(() => loadMaps(), () => loadMaps());
    db.collection("amzmonths").limit(120).onSnapshot(applyMonths, () => { A.monthsReady = true; renderSales(); });
    loadApiStatus().then(() => { if (A.preset) setAzRange(A.preset); else renderSales(); });
    // Cost history: only changes treated as real price changes keep the old cost for earlier sales.
    // Changes before the "clean costs" date (db settings/costs.historyStart) are corrections and apply to all history.
    let logDocs = [], costSet = { historyStart: null, overrides: {} };
    const rebuildHist = () => {
      const h = new Map();
      for (const b of logDocs) {
        const eff = addDays(b.date, 1);   // the check runs the morning after DAY, so a change takes effect on the run date
        for (const c of b.changes || []) {
          if (!c.vid) continue;
          const ov = (costSet.overrides || {})[b.date + "|" + c.vid];
          const real = ov ? ov === "real" : !!(costSet.historyStart && b.date >= costSet.historyStart);   // b.date = day the edit was made
          if (!real) continue;
          const l = h.get(String(c.vid)) || []; l.push({ date: eff, old: c.old, new: c.new }); h.set(String(c.vid), l);
        }
      }
      for (const l of h.values()) l.sort((x, y) => x.date.localeCompare(y.date));
      S.hist = h; renderSales();
    };
    db.collection("costlog").orderBy("date", "desc").limit(400).onSnapshot((snap) => { logDocs = snap.docs.map(d => d.data() || {}); rebuildHist(); }, () => {});
    db.doc("settings/costs").onSnapshot((d) => { costSet = d.exists ? { historyStart: null, overrides: {}, ...d.data() } : { historyStart: null, overrides: {} }; rebuildHist(); }, () => {});
    db.doc("amzmeta/titles").get().then(d => { if (d.exists) { A.titles = (d.data() || {}).titles || {}; allCache = null; render(); renderSales(); } }).catch(() => {});
  }).catch(() => render());
  use("mcp").then(mcp => { S.mcp = mcp; refreshCosts(); }).catch(() => {});
})();
