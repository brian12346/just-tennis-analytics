(() => {
  // ===================== FBA inventory =====================
  // Units sitting in (or on the way to) Amazon's warehouses, from the FBA Inventory report
  // (Seller Central → Reports → Fulfillment → Inventory → FBA Inventory; the CSV with snapshot-date, sku, fnsku, asin…).
  // Each seller SKU is costed through its Amazon mapping (amzmap: Shopify variant × units, or a manual cost),
  // priced at its Amazon price, and given an estimated Amazon fee from that SKU's own recent sales (jt.v_amz_sku_fees).
  // The report is stored in jt.docs collection "fbainv" (latest upload only). window.JT.fba is shared with the
  // Product costs tab, which adds FBA to the inventory total.
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m = (n) => n == null || isNaN(n) ? "—" : usd.format(n), m0 = (n) => n == null || isNaN(n) ? "—" : usd0.format(n);
  const pct = (x) => x == null || !isFinite(x) ? "—" : (x * 100).toFixed(0) + "%";
  const n0 = (x) => Math.round(x || 0).toLocaleString();
  const JT = window.JT;
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const PER = 100, CHUNK = 150;
  const DEFAULT_REF = 0.15;            // Amazon's referral fee for most sports items

  // ---------- the report ----------
  function parseCSV(text) {
    const rows = []; let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true; else if (c === "," || c === "\t") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
      else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.some(x => String(x).trim() !== ""));
  }
  // Stored row: [sku, fnsku, asin, name, available, transfer, inbound, reservedForOrders, unfulfillable,
  //              yourPrice, featuredPrice, shippedT30, shippedT90, daysOfSupply, health, storageType, storageNextMonth, agedOver180]
  // transfer = moving between Amazon warehouses or being processed (fc-transfer + reserved FC processing + staging).
  // reservedForOrders = units customers already bought (not ours to count). Rows with no units anywhere are dropped.
  function parse(text) {
    const rows = parseCSV(String(text || "").replace(/^﻿/, ""));
    if (rows.length < 2) throw new Error("That file has no rows.");
    const H = rows[0].map(h => h.trim().toLowerCase()), ix = (n) => H.indexOf(n);
    for (const n of ["sku", "asin", "available", "inbound-quantity"]) if (ix(n) < 0) throw new Error(`This doesn't look like the FBA Inventory report (no "${n}" column). Download Reports → Fulfillment → Inventory → FBA Inventory.`);
    const num = (r, n) => { const i = ix(n); if (i < 0) return 0; const v = parseFloat(String(r[i] || "").replace(/[$,]/g, "")); return isNaN(v) ? 0 : v; };
    const str = (r, n) => { const i = ix(n); return i < 0 ? "" : String(r[i] || "").trim(); };
    const out = []; let snapshot = "";
    for (const r of rows.slice(1)) {
      const sku = str(r, "sku"); if (!sku) continue;
      snapshot = snapshot || str(r, "snapshot-date");
      const avail = num(r, "available"), transfer = num(r, "fc-transfer") + num(r, "reserved fc processing") + num(r, "reserved staging");
      const inbound = num(r, "inbound-quantity"), resv = num(r, "reserved customer order"), unf = num(r, "unfulfillable-quantity");
      if (avail + transfer + inbound + resv + unf <= 0) continue;
      const aged = num(r, "inv-age-181-to-270-days") + num(r, "inv-age-271-to-365-days") + num(r, "inv-age-366-to-455-days") + num(r, "inv-age-456-plus-days");
      out.push([sku, str(r, "fnsku"), str(r, "asin"), str(r, "product-name").slice(0, 140), avail, transfer, inbound, resv, unf,
        num(r, "your-price"), num(r, "featuredoffer-price"), num(r, "units-shipped-t30"), num(r, "units-shipped-t90"),
        str(r, "days-of-supply") === "" ? null : num(r, "days-of-supply"), str(r, "fba-inventory-level-health-status"), str(r, "storage-type"),
        num(r, "estimated-storage-cost-next-month"), aged]);
    }
    if (!out.length) throw new Error("No SKUs with units in that report.");
    return { snapshot, rows: out };
  }
  // AWD inventory report (Seller Central → Inventory → AWD → Inventory → download): a few "Timestamp / Merchant ID" lines,
  // then one row per SKU. Stored row: [sku, fnsku, asin, name, inboundToAwd, availableInAwd, reservedInAwd, researching, outboundToFba].
  // Units reserved for / on their way to FBA are already in the FBA report's inbound, so they're kept for reference only.
  function parseAwd(text) {
    const rows = parseCSV(String(text || "").replace(/^\uFEFF/, ""));
    const hi = rows.findIndex(r => r.some(c => /^available in awd \(units\)$/i.test(String(c).trim())));
    if (hi < 0) throw new Error("This doesn't look like the AWD inventory report.");
    const H = rows[hi].map(h => h.trim().toLowerCase()), ix = (n) => H.indexOf(n);
    const num = (r, n) => { const i = ix(n); if (i < 0) return 0; const v = parseFloat(String(r[i] || "").replace(/[$,]/g, "")); return isNaN(v) ? 0 : v; };
    const str = (r, n) => { const i = ix(n); return i < 0 ? "" : String(r[i] || "").trim(); };
    const ts = rows.slice(0, hi).find(r => /^timestamp$/i.test(String(r[0]).trim()));
    const m = ts && /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(ts[1] || "");
    const snapshot = m ? `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
    const out = [];
    for (const r of rows.slice(hi + 1)) {
      const sku = str(r, "sku"); if (!sku) continue;
      const v = [num(r, "inbound to awd (units)"), num(r, "available in awd (units)"), num(r, "reserved in awd (units)"), num(r, "researching (units)"), num(r, "outbound to fba (units)")];
      if (v.every(x => x <= 0)) continue;
      out.push([sku, str(r, "fnsku"), str(r, "asin"), str(r, "product name").slice(0, 140), ...v]);
    }
    if (!out.length) throw new Error("No SKUs with units in that AWD report.");
    return { snapshot, rows: out, kind: "awd" };
  }
  // One upload button for both reports: the columns tell them apart.
  async function upload(file) {
    const text = await file.text();
    const awd = /available in awd \(units\)/i.test(text.slice(0, 5000));
    const rep = awd ? parseAwd(text) : Object.assign(parse(text), { kind: "fba" });
    const coll = awd ? "awdinv" : "fbainv";
    const db = await JT.docStore(); if (!db) throw new Error("The database isn't available in this view.");
    const now = new Date().toISOString(), n = Math.ceil(rep.rows.length / CHUNK);
    for (let i = 0; i < n; i++) {
      await db.collection(coll).doc("c" + String(i).padStart(3, "0")).set({ file: file.name, snapshot: rep.snapshot, uploadedAt: now, total: rep.rows.length, rows: rep.rows.slice(i * CHUNK, (i + 1) * CHUNK) });
    }
    const old = await db.collection(coll).get();
    for (const d of old.docs) if (+d.id.slice(1) >= n) await db.collection(coll).doc(d.id).delete();
    return rep;
  }

  // ---------- loading and costing ----------
  let cache = null, loading = null;
  function median(a) { const s = a.filter(x => x > 0).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; }
  async function load(refresh) {
    if (loading) return loading;
    if (cache && !refresh) return cache;
    loading = (async () => {
      const [docs, adocs, maps, fees, av] = await Promise.all([
        JT.rowsSplit(["id", "data"], "from jt.docs where collection = 'fbainv'", "id", 2, refresh),
        JT.rowsSplit(["id", "data"], "from jt.docs where collection = 'awdinv'", "id", 1, refresh),
        JT.rowsSplit(["m.data->>'sku'", "m.data->>'kind'", "coalesce(m.data->>'units', '1')", "m.data->>'manualCost'", "v.variant_id::text", "v.product_id::text", "v.sku",
          "coalesce(nullif(v.display_name, ''), v.product_title, m.data->>'vtitle')", "v.vendor", "v.product_type", "v.unit_cost", "v.price", "v.status", "m.data->>'vsku'"],
          "from jt.docs m left join jt.variants v on v.variant_id = (regexp_match(m.data->>'variantId', '(\\d+)$'))[1]::bigint where m.collection = 'amzmap'", "m.id", 4, refresh),
        JT.rows(["sku", "units", "sales", "sell_fees", "fba_units", "fba_fees"], "from jt.v_amz_sku_fees", refresh),
        JT.rows(["sku", "vendor"], "from jt.amazon_vendors", refresh),
      ]);
      const meta = { file: "", snapshot: "", uploadedAt: "" }, awdMeta = { file: "", snapshot: "", uploadedAt: "" }; const raw = [], awdRaw = [];
      for (const [, d] of docs.sort((a, b) => a[0].localeCompare(b[0]))) { if (!meta.file) Object.assign(meta, { file: d.file, snapshot: d.snapshot, uploadedAt: d.uploadedAt }); raw.push(...(d.rows || [])); }
      for (const [, d] of adocs.sort((a, b) => a[0].localeCompare(b[0]))) { if (!awdMeta.file) Object.assign(awdMeta, { file: d.file, snapshot: d.snapshot, uploadedAt: d.uploadedAt }); awdRaw.push(...(d.rows || [])); }
      const awd = new Map(awdRaw.map(r => [r[0], r]));
      // SKUs only in AWD (none in FBA yet): an empty FBA row, priced from the All Listings report
      const onlyAwd = awdRaw.filter(r => !raw.some(x => x[0] === r[0]));
      let lprice = new Map();
      if (onlyAwd.length) {
        const lp = await JT.rows(["r->>0", "r->>3"], `from jt.docs d, jsonb_array_elements(d.data->'rows') r where d.collection = 'amzlistings' and r->>0 in (${onlyAwd.map(r => JT.q(r[0])).join(",")})`, refresh);
        lprice = new Map(lp.map(([k, v]) => [k, v == null ? null : +v]));
      }
      for (const r of onlyAwd) raw.push([r[0], r[1], r[2], r[3], 0, 0, 0, 0, 0, lprice.get(r[0]) || 0, 0, 0, 0, null, "", "", 0, 0]);
      const mp = new Map(maps.map(x => [x[0], { kind: x[1], units: +x[2] || 1, manual: x[3] == null ? null : +x[3], vid: x[4], pid: x[5], vsku: x[6] || x[13] || "", title: x[7] || "",
        vendor: x[8] || "", type: x[9] || "", unitCost: x[10] == null ? null : +x[10], vprice: x[11] == null ? null : +x[11], status: x[12] || "" }]));
      const fe = new Map(fees.map(x => [x[0], { units: +x[1], sales: +x[2], sell: -x[3], fbaUnits: +x[4], fba: -x[5] }]));
      const avm = new Map(av);
      const items = raw.map(r => {
        const [sku, fnsku, asin, name, avail, transfer, inbound, resv, unf, yp, fp, t30, t90, days, health, storage, storNext, aged] = r;
        const map = mp.get(sku) || null;
        const cost = !map ? null : map.kind === "manual" ? map.manual : map.unitCost == null ? null : Math.round(map.unitCost * map.units * 100) / 100;
        const f = fe.get(sku), a = awd.get(sku) || [];
        return { sku, fnsku, asin, name, avail, transfer, inbound, resv, unf, awdIn: a[4] || 0, awdAvail: (a[5] || 0) + (a[7] || 0), awdResv: a[6] || 0, awdOut: a[8] || 0, price: yp > 0 ? yp : fp > 0 ? fp : null, t30, t90, days, health, storage, storNext, aged,
          map, cost, vendor: (map && map.vendor) || (avm.get(sku) && avm.get(sku) !== "-" ? avm.get(sku) : ""), type: (map && map.type) || "",
          hRef: f && f.sales >= 50 ? f.sell / f.sales : null, hFba: f && f.fbaUnits >= 2 && f.fba > 0 ? f.fba / f.fbaUnits : null };
      });
      // SKUs without enough sales history: the median FBA fee of the same storage type (else of everything)
      const byStore = new Map(), all = [];
      for (const it of items) if (it.hFba != null) { all.push(it.hFba); const l = byStore.get(it.storage) || []; l.push(it.hFba); byStore.set(it.storage, l); }
      const fallAll = median(all);
      for (const it of items) {
        const ref = it.hRef != null ? Math.min(Math.max(it.hRef, 0.05), 0.35) : DEFAULT_REF;
        const fba = it.hFba != null ? it.hFba : (median(byStore.get(it.storage) || []) ?? fallAll ?? 0);
        it.feeSrc = it.hRef != null && it.hFba != null ? "history" : "estimate";
        it.refRate = ref; it.fbaFee = Math.round(fba * 100) / 100;
        it.fees = it.price != null ? Math.round((it.price * ref + it.fbaFee) * 100) / 100 : null;
        it.profit = it.price != null && it.cost != null ? Math.round((it.price - it.fees - it.cost) * 100) / 100 : null;
      }
      cache = { meta, awdMeta, items, loadedAt: Date.now() };
      return cache;
    })();
    try { return await loading; } finally { loading = null; }
  }
  // Units counted for value. FBA: available + in transfer / processing (+ inbound). AWD: available + researching
  // (+ inbound to AWD). AWD units reserved for or shipping to FBA are left out: the FBA report already counts them as inbound.
  const fbaUnits = (it, inbound = true) => it.avail + it.transfer + (inbound ? it.inbound : 0);
  const awdUnits = (it, inbound = true) => (it.awdAvail || 0) + (inbound ? it.awdIn || 0 : 0);
  const unitsOf = (it, inbound = true, where = "all") => where === "fba" ? fbaUnits(it, inbound) : where === "awd" ? awdUnits(it, inbound) : fbaUnits(it, inbound) + awdUnits(it, inbound);
  function totals(items, inbound = true, where = "all") {
    const t = { units: 0, avail: 0, transfer: 0, inbound: 0, awd: 0, awdIn: 0, fbaU: 0, awdU: 0, fbaCost: 0, awdCost: 0, unf: 0, cost: 0, price: 0, fees: 0, profit: 0, skus: 0, noCost: 0, noCostUnits: 0, noCostPrice: 0, storNext: 0, aged: 0 };
    for (const it of items) {
      const u = unitsOf(it, inbound, where); t.unf += it.unf; t.storNext += it.storNext || 0; t.aged += it.aged || 0;
      if (u <= 0) continue;
      const fu = where === "awd" ? 0 : fbaUnits(it, inbound), au = where === "fba" ? 0 : awdUnits(it, inbound);
      t.skus++; t.units += u; t.fbaU += fu; t.awdU += au;
      if (where !== "awd") { t.avail += it.avail; t.transfer += it.transfer; t.inbound += inbound ? it.inbound : 0; }
      if (where !== "fba") { t.awd += it.awdAvail || 0; t.awdIn += inbound ? it.awdIn || 0 : 0; }
      if (it.cost != null) { t.fbaCost += fu * it.cost; t.awdCost += au * it.cost; }
      t.price += u * (it.price || 0);
      if (it.cost == null) { t.noCost++; t.noCostUnits += u; t.noCostPrice += u * (it.price || 0); continue; }
      t.cost += u * it.cost; t.fees += u * (it.fees || 0); t.profit += u * (it.profit || 0);
    }
    return t;
  }
  JT.fba = { parse, parseAwd, upload, load, totals, unitsOf, get data() { return cache; }, clear() { cache = null; } };

  // ---------- the tab ----------
  const F = { shown: false, loading: false, err: null, inbound: true, where: "all", vendor: "all", cat: "all", show: "all", health: "all", q: "", sort: "cost", page: 0, downloads: null };
  const note = (kind, html) => { const n = $("fba-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; };

  async function refresh(force) {
    F.loading = true; F.err = null; render();
    try { await load(force); fillFilters(); } catch (e) { F.err = e; note("bad", esc(JT.message(e))); }
    finally { F.loading = false; render(); }
  }
  function fillFilters() {
    const d = JT.fba.data; if (!d) return;
    const opt = (id, vals, cur, all) => { $(id).innerHTML = `<option value="all">${all}</option>` + vals.map(v => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(v || "(none)")}</option>`).join(""); };
    const live = d.items.filter(it => unitsOf(it, F.inbound, F.where) > 0);
    opt("fba-vendor", [...new Set(live.map(i => i.vendor))].sort((a, b) => a.localeCompare(b)), F.vendor, "All vendors");
    opt("fba-cat", [...new Set(live.filter(i => F.vendor === "all" || i.vendor === F.vendor).map(i => i.type))].sort((a, b) => a.localeCompare(b)), F.cat, "All categories");
  }
  function visible() {
    const d = JT.fba.data; if (!d) return [];
    const q = F.q.trim().toLowerCase();
    const key = { cost: (i) => unitsOf(i, F.inbound, F.where) * (i.cost ?? 0), price: (i) => unitsOf(i, F.inbound, F.where) * (i.price || 0), profit: (i) => unitsOf(i, F.inbound, F.where) * (i.profit ?? -1e9),
      units: (i) => unitsOf(i, F.inbound, F.where), margin: (i) => i.profit != null && i.price ? i.profit / i.price : -1e9, days: (i) => i.days ?? -1 }[F.sort];
    return d.items.filter(i => unitsOf(i, F.inbound, F.where) > 0 && (F.vendor === "all" || i.vendor === F.vendor) && (F.cat === "all" || i.type === F.cat)
      && (F.health === "all" || (i.health || "Unknown") === F.health)
      && (F.show === "all" || (F.show === "nocost" ? i.cost == null : F.show === "loss" ? i.profit != null && i.profit < 0 : F.show === "low" ? i.profit != null && i.price && i.profit / i.price < 0.1 : F.show === "aged" ? i.aged > 0 : true))
      && (!q || [i.name, i.sku, i.asin, i.fnsku, i.map && i.map.title, i.map && i.map.vsku, i.vendor].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => key(b) - key(a) || a.sku.localeCompare(b.sku));
  }

  function renderKpis(rows) {
    const t = totals(rows, F.inbound, F.where), mg = t.price - t.noCostPrice > 0 ? t.profit / (t.price - t.noCostPrice) : null;
    $("fba-kpis").innerHTML = [
      { l: F.where === "fba" ? "Units at FBA" : F.where === "awd" ? "Units in AWD" : "Units at Amazon", v: n0(t.units),
        s: [F.where !== "awd" ? `FBA ${n0(t.avail)} available · ${n0(t.transfer)} transfer${F.inbound ? ` · ${n0(t.inbound)} inbound` : ""}` : "",
            F.where !== "fba" ? `AWD ${n0(t.awd)}${F.inbound && t.awdIn ? ` · ${n0(t.awdIn)} inbound` : ""}` : ""].filter(Boolean).join("<br>") },
      { c: "cost", l: "Inventory at cost", v: m0(t.cost), s: `${t.skus.toLocaleString()} SKUs${t.noCost ? ` · ${t.noCost} without a cost` : ""}` },
      { c: "sales", l: "Value at Amazon price", v: m0(t.price), s: "units × your Amazon price" },
      { l: "Est. Amazon fees", v: m0(t.fees), s: t.price - t.noCostPrice > 0 ? `${pct(t.fees / (t.price - t.noCostPrice))} of price · referral + FBA fee` : "" },
      { c: "sales", l: "Est. profit when sold", v: `<span class="${t.profit < 0 ? "neg" : ""}">${m0(t.profit)}</span>`, s: mg != null ? `${pct(mg)} margin after fees and cost` : "" },
      { l: "Not costed", v: n0(t.noCostUnits), s: t.noCost ? `units · ${m0(t.noCostPrice)} at Amazon price · map them in Amazon matching` : "every SKU has a cost" },
    ].map(k => `<div class="kpi ${k.c || ""}"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
  }

  // Inventory at cost by vendor: one bar per vendor (top 12, the rest folded into "Other").
  function renderVendors(rows) {
    const by = new Map();
    for (const i of rows) {
      const u = unitsOf(i, F.inbound, F.where); if (u <= 0) continue;
      const k = i.vendor || "(no vendor)", a = by.get(k) || { v: k, cost: 0, profit: 0, units: 0, price: 0, fees: 0 };
      a.units += u; a.price += u * (i.price || 0); if (i.cost != null) { a.cost += u * i.cost; a.profit += u * (i.profit || 0); a.fees += u * (i.fees || 0); }
      by.set(k, a);
    }
    let list = [...by.values()].filter(a => a.cost > 0).sort((a, b) => b.cost - a.cost);
    if (list.length > 12) {
      const rest = list.slice(11), o = { v: `Other (${rest.length} vendors)`, cost: 0, profit: 0, units: 0, price: 0, fees: 0, other: true };
      for (const a of rest) for (const k of ["cost", "profit", "units", "price", "fees"]) o[k] += a[k];
      list = list.slice(0, 11).concat([o]);
    }
    const max = Math.max(1, ...list.map(a => a.cost));
    $("fba-vbars").innerHTML = list.map((a, i) => `<button class="vbar ${F.vendor === a.v ? "on" : ""}" data-vi="${i}" ${a.other ? "disabled" : ""} aria-label="${esc(a.v)}: ${m0(a.cost)} at cost">
        <span class="vb-name">${esc(a.v)}</span>
        <span class="vb-track"><i style="width:${(a.cost / max * 100).toFixed(1)}%"></i></span>
        <span class="vb-val num">${m0(a.cost)}</span>
        <span class="vb-sub num">${n0(a.units)} units · <span class="${a.profit < 0 ? "neg" : ""}">${m0(a.profit)}</span> profit</span></button>`).join("") || '<div class="muted small">No FBA units.</div>';
    $("fba-vbars")._list = list;
  }

  const HEALTH = { "Healthy": "ok", "Low stock": "warn", "Excess": "warn", "Out of stock": "miss" };
  let pageRows = [];
  function render() {
    if ($("tab-fba").hidden) return;
    const d = JT.fba.data, st = $("fba-status");
    document.querySelectorAll("#fba-inb button").forEach(b => b.setAttribute("aria-pressed", String((b.dataset.inb === "1") === F.inbound)));
    document.querySelectorAll("#fba-where button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.w === F.where)));
    if (!d) { st.textContent = F.loading ? "Loading Amazon inventory…" : F.err ? "" : ""; $("fba-table").innerHTML = ""; $("fba-kpis").innerHTML = ""; return; }
    if (!d.items.length) { st.textContent = "No Amazon inventory yet. Upload the FBA Inventory report (Reports → Fulfillment → Inventory → FBA Inventory) and the AWD inventory report."; $("fba-table").innerHTML = ""; $("fba-kpis").innerHTML = ""; $("fba-vbars").innerHTML = ""; return; }
    const snap = d.meta.snapshot ? new Date(d.meta.snapshot + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
    const asnap = d.awdMeta && d.awdMeta.snapshot ? new Date(d.awdMeta.snapshot + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
    st.textContent = `FBA report of ${snap || "?"} · AWD report of ${asnap || "(not uploaded)"} · ${d.items.length.toLocaleString()} SKUs with units${F.loading ? " · refreshing…" : ""} · costs from Amazon mappings and today's Shopify costs · fees from each SKU's last 180 days of sales`;
    const rows = visible();
    renderKpis(rows);
    // vendor bars follow every filter except vendor itself
    const q = F.q.trim().toLowerCase();
    renderVendors(d.items.filter(i => (F.cat === "all" || i.type === F.cat) && (F.health === "all" || (i.health || "Unknown") === F.health)
      && (!q || [i.name, i.sku, i.asin, i.map && i.map.title, i.map && i.map.vsku, i.vendor].join(" ").toLowerCase().includes(q))));
    const pages = Math.max(1, Math.ceil(rows.length / PER)); if (F.page >= pages) F.page = pages - 1;
    pageRows = rows.slice(F.page * PER, F.page * PER + PER);
    const t = totals(rows, F.inbound, F.where);
    const dash = '<span class="dim">—</span>';
    $("fba-table").innerHTML = `<thead><tr><th class="l">Amazon listing</th><th class="l">Shopify product</th><th>Units</th><th>Cost</th><th>Ext. cost</th><th>Price</th><th>Ext. price</th><th>Est. fees</th><th>Profit / unit</th><th>Ext. profit</th><th class="l">Supply</th></tr></thead><tbody>${
      pageRows.map(i => {
        const u = unitsOf(i, F.inbound, F.where), mp = i.map, mg = i.profit != null && i.price ? i.profit / i.price : null;
        const shop = !mp ? `<span class="pill miss">Not mapped</span><div class="meta">${esc(i.vendor || "no vendor")}</div>`
          : mp.kind === "manual" ? `<span class="pill manual">Manual cost</span><div class="meta">${esc(i.vendor || "")}</div>`
          : `${mp.pid ? `<a class="olink" href="${ADMIN}/products/${esc(mp.pid)}/variants/${esc(mp.vid)}" target="_blank" rel="noopener">${esc(mp.title)}</a>` : esc(mp.title || "(removed from Shopify)")}
             <div class="meta"><span class="mono">${esc(mp.vsku) || "no SKU"}</span>${mp.units !== 1 ? ` · ×${mp.units} per Amazon unit` : ""}</div><div class="meta">${esc(i.vendor)}${i.type ? " · " + esc(i.type) : ""}</div>`;
        const fb = F.where !== "awd", aw = F.where !== "fba";
        const unitsMeta = [fb && i.transfer ? n0(i.transfer) + " transfer" : "", fb && F.inbound && i.inbound ? n0(i.inbound) + " inbound" : "",
          aw && (i.awdAvail || (F.inbound && i.awdIn)) ? `<span class="awd">${n0(i.awdAvail)} AWD${F.inbound && i.awdIn ? ` +${n0(i.awdIn)} inbound` : ""}</span>` : "",
          fb && i.unf ? n0(i.unf) + " unfulfillable" : ""].filter(Boolean).join(" · ");
        const hp = i.health ? `<span class="pill ${HEALTH[i.health] || "pos"}">${esc(i.health)}</span>` : "";
        return `<tr class="${i.cost == null ? "flag-bad" : i.profit != null && i.profit < 0 ? "flag-warn" : ""}">
          <td class="l">${i.asin ? `<a class="olink" href="https://www.amazon.com/dp/${encodeURIComponent(i.asin)}" target="_blank" rel="noopener">${esc(i.name || i.sku)}</a>` : esc(i.name || i.sku)}<div class="meta">${esc(i.asin)} · <span class="mono">${esc(i.sku)}</span></div></td>
          <td class="l">${shop}</td>
          <td><b>${n0(u)}</b><div class="meta">${fb ? n0(i.avail) + " FBA available" : ""}${unitsMeta ? (fb ? "<br>" : "") + unitsMeta : ""}</div></td>
          <td>${i.cost == null ? dash : m(i.cost)}</td>
          <td>${i.cost == null ? dash : m0(u * i.cost)}</td>
          <td>${m(i.price)}</td>
          <td>${i.price == null ? dash : m0(u * i.price)}</td>
          <td>${m(i.fees)}<div class="meta" title="${i.feeSrc === "history" ? "From this SKU's own Amazon sales" : "No recent sales history: 15% referral and the typical FBA fee for its size"}">${pct(i.refRate)} + ${m(i.fbaFee)} FBA${i.feeSrc === "history" ? "" : " · est."}</div></td>
          <td class="${i.profit != null && i.profit < 0 ? "neg" : ""}">${i.profit == null ? dash : m(i.profit)}<div class="meta">${mg == null ? "" : pct(mg) + " margin"}</div></td>
          <td class="${i.profit != null && i.profit < 0 ? "neg" : ""}"><b>${i.profit == null ? dash : m0(u * i.profit)}</b></td>
          <td class="l">${hp}<div class="meta">${i.days != null ? n0(i.days) + " days" : ""}${i.t30 ? ` · ${n0(i.t30)} sold/30d` : ""}${i.aged ? ` · ${n0(i.aged)} over 180 days old` : ""}</div></td></tr>`;
      }).join("") || `<tr><td class="l muted" colspan="11">No SKUs match these filters.</td></tr>`}</tbody>${rows.length ? `<tfoot><tr>
        <td class="l">Total · ${rows.length.toLocaleString()} SKUs</td><td></td><td>${n0(t.units)}</td><td></td><td>${m0(t.cost)}</td><td></td><td>${m0(t.price)}</td><td>${m0(t.fees)}</td><td></td>
        <td class="${t.profit < 0 ? "neg" : ""}">${m0(t.profit)}</td><td></td></tr></tfoot>` : ""}`;
    $("fba-prev").hidden = F.page === 0; $("fba-next").hidden = F.page >= pages - 1;
    $("fba-count").textContent = rows.length ? `${F.page * PER + 1}–${F.page * PER + pageRows.length} of ${rows.length.toLocaleString()}` : "";
    $("fba-dl").hidden = !F.downloads || !rows.length;
  }

  async function download() {
    const rows = visible(), q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["seller_sku", "asin", "fnsku", "amazon_title", "shopify_product", "mfg_sku", "vendor", "category", "units_per_amazon_unit", "fba_available", "fba_transfer", "fba_inbound", "awd_available", "awd_inbound", "units_counted",
      "unit_cost", "ext_cost", "amazon_price", "ext_price", "referral_rate", "fba_fee", "est_fees", "profit_per_unit", "ext_profit", "fee_source", "health", "days_of_supply"];
    const lines = [head.join(",")];
    for (const i of rows) {
      const u = unitsOf(i, F.inbound, F.where), mp = i.map || {};
      lines.push([i.sku, i.asin, i.fnsku, i.name, mp.title || "", mp.vsku || "", i.vendor, i.type, mp.units || "", i.avail, i.transfer, i.inbound, i.awdAvail || 0, i.awdIn || 0, u,
        i.cost ?? "", i.cost == null ? "" : (u * i.cost).toFixed(2), i.price ?? "", i.price == null ? "" : (u * i.price).toFixed(2), i.refRate.toFixed(4), i.fbaFee, i.fees ?? "",
        i.profit ?? "", i.profit == null ? "" : (u * i.profit).toFixed(2), i.feeSrc, i.health, i.days ?? ""].map(q).join(","));
    }
    const d = JT.fba.data;
    try { await F.downloads.save({ filename: `just-tennis-amazon-inventory_${(d && d.meta.snapshot) || "latest"}.csv`, data: lines.join("\n") }); } catch (_) {}
  }

  function bind() {
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on("fba-vendor", "change", (e) => { F.vendor = e.target.value; F.page = 0; fillFilters(); render(); });
    on("fba-cat", "change", (e) => { F.cat = e.target.value; F.page = 0; render(); });
    on("fba-show", "change", (e) => { F.show = e.target.value; F.page = 0; render(); });
    on("fba-health", "change", (e) => { F.health = e.target.value; F.page = 0; render(); });
    on("fba-sort", "change", (e) => { F.sort = e.target.value; F.page = 0; render(); });
    on("fba-q", "input", (e) => { F.q = e.target.value; F.page = 0; clearTimeout(e.target._t); e.target._t = setTimeout(render, 200); });
    on("fba-refresh", "click", () => refresh(true));
    on("fba-prev", "click", () => { F.page--; render(); $("fba-table").scrollIntoView({ block: "start" }); });
    on("fba-next", "click", () => { F.page++; render(); $("fba-table").scrollIntoView({ block: "start" }); });
    on("fba-dl", "click", download);
    on("fba-where", "click", (e) => { const b = e.target.closest("button[data-w]"); if (!b) return; F.where = b.dataset.w; F.page = 0; fillFilters(); render(); });
    on("fba-inb", "click", (e) => { const b = e.target.closest("button[data-inb]"); if (!b) return; F.inbound = b.dataset.inb === "1"; F.page = 0; fillFilters(); render(); });
    on("fba-vbars", "click", (e) => {
      const b = e.target.closest("button[data-vi]"); if (!b) return;
      const a = $("fba-vbars")._list[+b.dataset.vi]; if (!a || a.other) return;
      F.vendor = F.vendor === a.v ? "all" : a.v; F.page = 0; fillFilters(); render();
    });
    on("fba-file", "change", async (e) => {
      const file = e.target.files[0]; e.target.value = ""; if (!file) return;
      note("info", `Reading ${esc(file.name)}…`);
      try {
        const rep = await upload(file);
        const kind = rep.kind === "awd" ? "AWD" : "FBA";
        note("info", `Loaded ${rep.rows.length.toLocaleString()} SKUs from ${esc(file.name)} (${kind} report, ${esc(rep.snapshot)}). It replaces the previous ${kind} report.`);
        await refresh(true);
      } catch (err) { note("bad", esc(err && err.message ? err.message : JT.message(err))); }
    });
  }

  bind();
  window.fbaShow = () => { if (!F.shown) { F.shown = true; refresh(false); } else render(); };
  window.JTFba = { _state: F, parse, parseAwd };
  const use = window.claude && window.claude.use ? window.claude.use.bind(window.claude) : null;
  if (use) use("downloads").then(d => { F.downloads = d; render(); }).catch(() => {});
  if ((location.hash || "") === "#fba") setTimeout(() => window.fbaShow(), 0);
})();
