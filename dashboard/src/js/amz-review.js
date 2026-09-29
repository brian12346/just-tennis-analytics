(() => {
  // ===================== Amazon matching (review suggested ASIN -> Shopify matches) =====================
  // Suggests a Shopify variant for every unmapped Amazon listing (window.JTMatch) and lets you approve,
  // deny (next guess) or mark "no match in Shopify". Approvals are saved as amzmap/<sku> — the same record
  // the Amazon mapping tab writes, so Amazon profit picks them up. Denials are kept in amzdeny/<sku>.
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m = (n) => n == null || isNaN(n) ? "—" : usd.format(n), m0 = (n) => usd0.format(n || 0);
  const JT = window.JT, MT = window.JTMatch;
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const PER = 25;
  const docId = (sku) => "s_" + String(sku).replace(/[^A-Za-z0-9_\-.:@+]/g, c => "~" + c.charCodeAt(0).toString(16).padStart(2, "0")).slice(0, 190);
  const gidV = (id) => "gid://shopify/ProductVariant/" + id, gidP = (id) => id ? "gid://shopify/Product/" + id : null;
  const CONF = { high: "Likely", medium: "Maybe", low: "Unsure" };

  const A = {
    shown: false, loading: false, err: null, db: null,
    listings: null,          // [{sku, asin, title, status, units, sales}]
    maps: new Map(),         // sku -> amzmap body
    deny: new Map(),         // sku -> {variants:Set, none:bool}
    ix: null, byVid: null,
    guesses: new Map(),      // sku -> guess result (without denied variants)
    state: new Map(),        // sku -> {done:"approved"|"none", units, pick}
    conf: "all", scope: "selling", q: "", page: 0, cur: 0, busy: new Set(), search: null,
    mode: "vendors",         // "vendors" (step 1) | "products" (step 2)
    vend: new Map(),         // sku -> confirmed vendor ("-" = not sold in Shopify)
    vguess: new Map(),       // sku -> guessed vendor ("" = unknown)
    vendors: [],             // Shopify vendor names
    vf: "all", vs: "guessed", sel: new Set(), vsaving: false,
  };
  const NONE = "-";
  const PER_V = 100;
  const note = (kind, html) => { const n = $("am-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; };
  const setStatus = (t) => { $("am-status").textContent = t; };

  // ---------- loading ----------
  async function load(refresh) {
    if (A.loading) return;
    A.loading = true; A.err = null; setStatus("Loading listings and the product catalog…"); render();
    try {
      A.db = await JT.docStore();
      const [ls, mp, dn, cat, av] = await Promise.all([
        // Listings from the All Listings report, plus seller SKUs that sold (Transaction reports) but are no longer
        // in that report — old or deleted listings still need a mapping for their past sales.
        JT.rowsSplit(["sku", "coalesce(l.asin, '')", "coalesce(l.title, t.title, '')", "coalesce(l.status, 'Not in listings report')", "coalesce(s.units, 0)", "coalesce(s.sales, 0)"],
          `from (select distinct on (r->>0) r->>0 as sku, r->>1 as asin, r->>2 as title, r->>6 as status
                 from jt.docs d, jsonb_array_elements(d.data->'rows') r where d.collection = 'amzlistings' order by r->>0, d.id desc) l
           full join (select distinct on (k) k as sku, sum((v->>0)::numeric) over (partition by k) as units, sum((v->>1)::numeric) over (partition by k) as sales
                      from jt.docs d, jsonb_each(d.data->'skus') e(k, v) where d.collection = 'amzmonths') s using (sku)
           left join (select distinct on (key) key as sku, value as title from jt.docs d, jsonb_each_text(d.data->'titles') where d.collection = 'amzmeta') t using (sku)
           where true`, "sku", 2, refresh),   // no "group by" here: the reply may be split by a filter added at the end
        JT.rowsSplit(["data->>'sku'", "data"], "from jt.docs where collection = 'amzmap'", "id", 4, refresh),
        JT.rows(["data->>'sku'", "coalesce(data->'variants', '[]'::jsonb)", "coalesce((data->>'none')::boolean, false)"], "from jt.docs where collection = 'amzdeny'", refresh),
        JT.rowsSplit(["variant_id::text", "product_id::text", "sku", "coalesce(nullif(display_name, ''), product_title)", "vendor", "status", "product_type", "price", "unit_cost", "coalesce(barcode, '')", "product_title", "variant_title"],
          "from jt.variants where removed_at is null", "variant_id", 4, refresh),
        JT.rows(["sku", "vendor"], "from jt.amazon_vendors", refresh),
      ]);
      A.vend = new Map(av.map(([k, v]) => [k, v]));
      A.listings = ls.map(x => ({ sku: x[0], asin: x[1], title: x[2] || "", status: x[3] || "", units: +x[4] || 0, sales: +x[5] || 0 }));
      A.maps = new Map(mp.map(([k, d]) => [k, d]));
      A.deny = new Map(dn.map(([k, v, none]) => [k, { variants: new Set((v || []).map(String)), none: !!none }]));
      const catalog = cat.map(x => ({ vid: x[0], pid: x[1], sku: x[2] || "", title: x[3] || "", vendor: x[4] || "", status: x[5] || "", type: x[6] || "",
        price: x[7] == null ? null : +x[7], cost: x[8] == null ? null : +x[8], barcode: x[9] || "", product: x[10] || "", variant: x[11] || "" }));
      A.ix = MT.buildIndex(catalog); A.byVid = new Map(catalog.map(v => [v.vid, v]));
      A.guesses.clear();
      A.vendors = [...new Set(catalog.map(v => v.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      A.vguess = new Map(A.listings.map(l => [l.sku, (MT.brandsOf(l.title, l.sku)[0]) || ""]));
      fillVendorSelects();
      setStatus(`${A.listings.length.toLocaleString()} Amazon listings · ${catalog.length.toLocaleString()} Shopify variants`);
    } catch (e) { A.err = e; setStatus(""); note("bad", esc(JT.message(e))); }
    finally { A.loading = false; render(); }
  }

  function guessFor(l) {
    let g = A.guesses.get(l.sku);
    if (!g) {
      const d = A.deny.get(l.sku);
      const cv = A.vend.get(l.sku);
      const probe = l.title ? l : { sku: l.sku, title: skuWords(l.sku) };
      g = MT.guess(A.ix, probe, { limit: 14, vendor: cv && cv !== NONE ? cv : undefined });
      if (d && d.variants.size) {
        g.top = g.top.filter(c => !d.variants.has(c.v.vid));
        // confidence again without the denied ones
        const [b, s] = g.top; const gap = b ? b.score - (s ? s.score : 0) : 0;
        g.conf = !b ? "low" : b.why.includes("SKU in listing") && gap > 0.2 ? "high" : b.score >= 0.95 && gap >= 0.15 ? "high" : b.score >= 0.7 && gap >= 0.08 ? "medium" : "low";
      }
      g.top = g.top.slice(0, 6);
      A.guesses.set(l.sku, g);
    }
    return g;
  }
  // "WIL-BLADE16X19(03)V9-FBM" -> "WIL BLADE 16X19 (03) V9": something to guess from when a listing has no title
  function skuWords(sku) {
    return String(sku || "").replace(/-(FBA|FBM)\b.*$/i, "").replace(/[-_]/g, " ").replace(/([A-Za-z]{3,})(\d)/g, "$1 $2").replace(/\(/g, " (").replace(/\s+/g, " ").trim();
  }
  const amzLink = (l, inner) => l.asin ? `<a class="olink" href="https://www.amazon.com/dp/${encodeURIComponent(l.asin)}" target="_blank" rel="noopener">${inner}</a>` : inner;
  const st = (sku) => { let s = A.state.get(sku); if (!s) { s = {}; A.state.set(sku, s); } return s; };

  function inScope(l) {
    const d = A.deny.get(l.sku);
    if (A.vend.get(l.sku) === NONE && A.scope !== "denied") return false;
    if (A.scope === "denied") return !!(d && d.none);
    if (A.maps.has(l.sku) && !st(l.sku).done) return false;
    if (d && d.none && !st(l.sku).done) return false;
    if (A.scope === "selling") return l.sales > 0 || !!st(l.sku).done;
    if (A.scope === "active") return /active/i.test(l.status) || l.sales > 0 || !!st(l.sku).done;
    return true;
  }
  function visible() {
    if (!A.listings) return [];
    const q = A.q.trim().toLowerCase();
    let rows = A.listings.filter(l => inScope(l) && (!q || (l.title + " " + l.asin + " " + l.sku).toLowerCase().includes(q)));
    if (A.conf !== "all" && A.scope !== "denied") rows = rows.filter(l => st(l.sku).done || guessFor(l).conf === A.conf);
    return rows.sort((a, b) => b.sales - a.sales || a.sku.localeCompare(b.sku));
  }

  // ---------- step 1: vendors ----------
  const vendorOf = (l) => A.vend.has(l.sku) ? A.vend.get(l.sku) : (A.vguess.get(l.sku) || "");
  function fillVendorSelects() {
    const counts = new Map(); let unk = 0;
    for (const l of A.listings || []) { if (!scopeV(l)) continue; const v = vendorOf(l); if (!v) unk++; else counts.set(v, (counts.get(v) || 0) + 1); }
    const opts = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    $("am-vf").innerHTML = `<option value="all">All vendors</option><option value="">Unknown (${unk})</option>` +
      opts.map(([v, n]) => `<option value="${esc(v)}">${v === NONE ? "Not sold in Shopify" : esc(v)} (${n})</option>`).join("");
    $("am-vf").value = A.vf === "all" || A.vf === "" || counts.has(A.vf) ? A.vf : "all";
    $("am-setv").innerHTML = `<option value="">Vendor for ticked…</option>` + vendorOptions("");
  }
  function vendorOptions(cur) {
    return A.vendors.map(v => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join("") +
      `<option value="${NONE}" ${cur === NONE ? "selected" : ""}>— not sold in Shopify —</option>`;
  }
  function scopeV(l) {
    if (A.scope === "selling") return l.sales > 0;
    if (A.scope === "active") return /active/i.test(l.status) || l.sales > 0;
    if (A.scope === "denied") return A.vend.get(l.sku) === NONE;
    return true;
  }
  function visibleV() {
    if (!A.listings) return [];
    const q = A.q.trim().toLowerCase();
    return A.listings.filter(l => scopeV(l) && (!q || (l.title + " " + l.asin + " " + l.sku).toLowerCase().includes(q))
      && (A.vf === "all" || vendorOf(l) === A.vf)
      && (A.vs === "all" || (A.vs === "confirmed" ? A.vend.has(l.sku) : !A.vend.has(l.sku))))
      .sort((a, b) => b.sales - a.sales || a.sku.localeCompare(b.sku));
  }
  async function saveVendors(list, msg) {
    if (!list.length) return;
    A.vsaving = true; render();
    try {
      for (let i = 0; i < list.length; i += 500) await JT.setAmazonVendors(list.slice(i, i + 500));
      for (const { sku, vendor } of list) { if (vendor) A.vend.set(sku, vendor); else A.vend.delete(sku); A.guesses.delete(sku); }
      if (msg) note("info", msg); else note(null);
    } catch (e) { note("bad", "Couldn't save: " + esc(JT.message(e))); }
    finally { A.vsaving = false; fillVendorSelects(); render(); }
  }
  let vRows = [];
  function renderVendors() {
    const list = $("am-list");
    const rows = visibleV();
    const pages = Math.max(1, Math.ceil(rows.length / PER_V)); if (A.page >= pages) A.page = pages - 1;
    vRows = rows.slice(A.page * PER_V, A.page * PER_V + PER_V);
    list.innerHTML = vRows.length ? `<div class="tbl-wrap"><table class="amv"><thead><tr><th><input type="checkbox" id="am-selall" aria-label="Tick all on this page"></th><th class="l">Amazon listing</th><th>Sales</th><th class="l">Shopify vendor</th><th class="l"></th></tr></thead><tbody>${
      vRows.map((l, i) => { const conf = A.vend.has(l.sku), v = vendorOf(l);
        return `<tr class="${conf ? "conf" : "guess"}"><td><input type="checkbox" data-sel="${i}" ${A.sel.has(l.sku) ? "checked" : ""}></td>
          <td class="l">${amzLink(l, esc(l.title || l.sku))}<div class="meta">${l.asin ? esc(l.asin) + " · " : ""}<span class="mono">${esc(l.sku)}</span>${/active/i.test(l.status) ? "" : " · " + esc((l.status || "inactive").toLowerCase())}</div></td>
          <td>${l.sales ? m0(l.sales) : '<span class="dim">—</span>'}</td>
          <td class="l"><select class="inp sm" data-v="${i}" ${A.vsaving ? "disabled" : ""}><option value="" ${v ? "" : "selected"}>— unknown —</option>${vendorOptions(v)}</select></td>
          <td class="l">${conf ? '<span class="pill ok">Confirmed</span>' : v ? '<span class="pill warn">Guess</span>' : '<span class="pill miss">Unknown</span>'}</td></tr>`; }).join("")}</tbody></table></div>`
      : `<div class="muted" style="padding:12px">${A.vs === "guessed" ? "Nothing left to confirm here." : "No listings here."}</div>`;
    $("am-prev").hidden = A.page === 0; $("am-next").hidden = A.page >= pages - 1;
    $("am-count").textContent = rows.length ? `${A.page * PER_V + 1}–${A.page * PER_V + vRows.length} of ${rows.length.toLocaleString()}` : "";
    const guessesShown = rows.filter(l => !A.vend.has(l.sku) && vendorOf(l));
    const b = $("am-confirm"); b.disabled = !guessesShown.length || A.vsaving;
    b.textContent = guessesShown.length ? `Confirm ${guessesShown.length.toLocaleString()} guess${guessesShown.length === 1 ? "" : "es"} shown` : "Confirm guesses shown";
    $("am-setsel").disabled = !A.sel.size || !$("am-setv").value || A.vsaving;
    $("am-setsel").textContent = A.sel.size ? `Set ${A.sel.size} ticked` : "Set ticked";
  }

  // ---------- saving ----------
  async function approve(l, c, units) {
    const v = c.v; const s = st(l.sku);
    if (!(units > 0) || units > 1000) { note("bad", "Units per Amazon sale must be a number like 1, 2 or 12."); return; }
    const body = { sku: l.sku, asin: l.asin, title: l.title, updatedAt: new Date().toISOString(), kind: "shopify",
      variantId: gidV(v.vid), productId: gidP(v.pid), vsku: v.sku, vtitle: v.title, vendor: v.vendor, units, unitCost: v.cost, via: "match" };
    A.busy.add(l.sku); render();
    try { await A.db.collection("amzmap").doc(docId(l.sku)).set(body); A.maps.set(l.sku, body); s.done = "approved"; s.pick = c; s.units = units; note(null); }
    catch (e) { note("bad", "Couldn't save: " + esc(JT.message(e))); }
    finally { A.busy.delete(l.sku); render(); }
  }
  async function saveDeny(l, patch) {
    const cur = A.deny.get(l.sku) || { variants: new Set(), none: false };
    const next = { variants: new Set(cur.variants), none: cur.none };
    if (patch.vid) next.variants.add(String(patch.vid));
    if (patch.none != null) next.none = patch.none;
    A.busy.add(l.sku); render();
    try {
      await A.db.collection("amzdeny").doc(docId(l.sku)).set({ sku: l.sku, asin: l.asin, variants: [...next.variants], none: next.none, updatedAt: new Date().toISOString() });
      A.deny.set(l.sku, next); A.guesses.delete(l.sku);
      if (patch.none) st(l.sku).done = "none"; else if (patch.none === false) delete st(l.sku).done;
      note(null);
    } catch (e) { note("bad", "Couldn't save: " + esc(JT.message(e))); }
    finally { A.busy.delete(l.sku); render(); }
  }
  async function undo(l) {
    const s = st(l.sku);
    A.busy.add(l.sku); render();
    try {
      if (s.done === "approved") { await A.db.collection("amzmap").doc(docId(l.sku)).delete(); A.maps.delete(l.sku); }
      else if (s.done === "none" || (A.deny.get(l.sku) || {}).none) { A.busy.delete(l.sku); await saveDeny(l, { none: false }); return; }
      delete s.done; delete s.pick;
    } catch (e) { note("bad", "Couldn't undo: " + esc(JT.message(e))); }
    finally { A.busy.delete(l.sku); render(); }
  }

  // ---------- rendering ----------
  function renderKpis() {
    const el = $("am-kpis"); if (!el || !A.listings) { if (el) el.innerHTML = ""; return; }
    if (A.mode === "vendors") {
      const sc = A.listings.filter(scopeV), tot = sc.reduce((a, l) => a + l.sales, 0);
      const conf = sc.filter(l => A.vend.has(l.sku)), guess = sc.filter(l => !A.vend.has(l.sku) && A.vguess.get(l.sku)), unk = sc.length - conf.length - guess.length;
      const cs = conf.reduce((a, l) => a + l.sales, 0);
      el.innerHTML = [
        { l: "Vendor confirmed", v: conf.length.toLocaleString() + " of " + sc.length.toLocaleString(), s: tot ? `${(cs / tot * 100).toFixed(1)}% of these listings' Amazon sales` : "listings" },
        { l: "Guessed, to confirm", v: guess.length.toLocaleString(), s: "from the brand in the title or seller SKU" },
        { l: "Unknown vendor", v: unk.toLocaleString(), s: "pick one, or “not sold in Shopify”" },
      ].map(k => `<div class="kpi"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
      return;
    }
    const selling = A.listings.filter(l => l.sales > 0);
    const total = selling.reduce((a, l) => a + l.sales, 0);
    const mapped = selling.filter(l => A.maps.has(l.sku));
    const mSales = mapped.reduce((a, l) => a + l.sales, 0);
    const open = selling.filter(l => !A.maps.has(l.sku) && !((A.deny.get(l.sku) || {}).none));
    const byConf = { high: 0, medium: 0, low: 0 }; for (const l of open) byConf[guessFor(l).conf]++;
    const none = selling.filter(l => (A.deny.get(l.sku) || {}).none).length;
    el.innerHTML = [
      { l: "Amazon sales mapped", v: total ? (mSales / total * 100).toFixed(1) + "%" : "—", s: `${m0(mSales)} of ${m0(total)} · ${mapped.length} of ${selling.length} selling listings` },
      { l: "To review", v: open.length.toLocaleString(), s: `${byConf.high} likely · ${byConf.medium} maybe · ${byConf.low} unsure` },
      { l: "No match in Shopify", v: none.toLocaleString(), s: "marked by you" },
    ].map(k => `<div class="kpi"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
  }
  function shopLine(v) {
    return `<a class="olink" href="${ADMIN}/products/${esc(v.pid)}/variants/${esc(v.vid)}" target="_blank" rel="noopener"><b>${esc(v.title)}</b></a>
      <div class="meta"><span class="mono">${esc(v.sku) || "no SKU"}</span> · ${esc(v.vendor)} · cost ${v.cost == null ? '<span class="pill miss">none</span>' : m(v.cost)} · price ${m(v.price)}${v.status && v.status !== "ACTIVE" ? " · " + esc(v.status.toLowerCase()) : ""}</div>`;
  }
  function rowHtml(l, i) {
    const s = st(l.sku), busy = A.busy.has(l.sku);
    const amz = `<div class="amz">${amzLink(l, `<b>${esc(l.title || l.sku)}</b>`)}
      <div class="meta">${l.asin ? esc(l.asin) + " · " : ""}<span class="mono">${esc(l.sku)}</span>${l.sales ? ` · ${m0(l.sales)} · ${l.units.toLocaleString()} sold` : " · no sales yet"}${/active/i.test(l.status) ? "" : " · " + esc(l.status.toLowerCase() || "inactive")}</div></div>`;
    if (s.done === "approved") {
      const v = s.pick ? s.pick.v : A.byVid.get(String(A.maps.get(l.sku).variantId).split("/").pop());
      return `<div class="amrow done" data-i="${i}">${amz}<div class="arrow">→</div><div class="shop">${v ? shopLine(v) : "—"}<div class="meta">× ${s.units || 1} per Amazon sale</div></div>
        <div class="acts"><span class="pill conf-high">Approved</span><button class="mini" data-act="undo" ${busy ? "disabled" : ""}>Undo</button></div></div>`;
    }
    if (s.done === "none" || A.scope === "denied") {
      return `<div class="amrow done" data-i="${i}">${amz}<div class="arrow">→</div><div class="shop"><span class="muted">No match in Shopify</span></div>
        <div class="acts"><button class="mini" data-act="undo" ${busy ? "disabled" : ""}>Undo</button></div></div>`;
    }
    const g = guessFor(l);
    const pick = s.pick || g.top[0];
    const units = s.units != null ? s.units : g.units;
    const alts = g.top.filter(c => c !== pick).slice(0, 3);
    const searchOpen = A.search && A.search.sku === l.sku;
    const res = searchOpen && A.search.q.trim().length >= 2 ? MT.guess(A.ix, { title: A.search.q, sku: "" }, { limit: 8 }).top : [];
    const shop = pick ? `${shopLine(pick.v)}
        <div class="meta"><span class="pill conf-${g.conf}">${s.pick && s.pick !== g.top[0] ? "Your pick" : CONF[g.conf]}</span> ${esc(pick.why.join(" · "))}</div>
        <div class="meta units">× <input class="inp num sm" data-units="${i}" value="${esc(units)}" inputmode="numeric"> per Amazon sale${units > 1 ? " · cost " + m(pick.v.cost != null ? pick.v.cost * units : null) : ""}</div>`
      : `<span class="muted">No guess — search for the product below.</span>`;
    return `<div class="amrow ${i === A.cur ? "cur" : ""}" data-i="${i}">${amz}<div class="arrow">→</div>
      <div class="shop">${shop}
        <div class="alts">${alts.map(c => `<button data-alt="${esc(c.v.vid)}">${esc(c.v.title)} <span class="dim">· ${esc(c.v.sku)} · ${m(c.v.cost)}</span></button>`).join("")}
          ${searchOpen ? `<input class="inp" id="am-sq" data-i="${i}" value="${esc(A.search.q)}" placeholder="Search Shopify: product words or SKU" autocomplete="off">
            ${res.map(c => `<button data-alt="${esc(c.v.vid)}">${esc(c.v.title)} <span class="dim">· ${esc(c.v.sku)} · ${esc(c.v.vendor)} · ${m(c.v.cost)}</span></button>`).join("")}`
          : `<button class="linkbtn small" data-act="search" style="border:0;padding:0">Search for another product…</button>`}
        </div></div>
      <div class="acts">
        <button class="btn primary" data-act="approve" ${pick && !busy ? "" : "disabled"}>Approve</button>
        <div class="row2"><button class="btn" data-act="deny" ${pick && !busy ? "" : "disabled"} title="Not this product — show the next guess">Deny</button>
        <button class="btn" data-act="none" ${busy ? "disabled" : ""} title="This listing has no product in Shopify">No match</button></div>
      </div></div>`;
  }
  let pageRows = [];
  function render() {
    if ($("tab-amzmatch").hidden) return;
    renderKpis();
    const vm = A.mode === "vendors";
    $("am-vfilters").hidden = !vm; $("am-vbar").hidden = !vm; $("am-conf").hidden = vm; $("am-pbar").hidden = vm;
    $("am-h2").textContent = vm ? "Vendor for each Amazon listing" : "Suggested product matches";
    const list = $("am-list");
    if (!A.listings) { list.innerHTML = `<div class="muted">${A.loading ? "Loading…" : ""}</div>`; return; }
    if (vm) { renderVendors(); return; }
    const rows = visible();
    const pages = Math.max(1, Math.ceil(rows.length / PER)); if (A.page >= pages) A.page = pages - 1;
    pageRows = rows.slice(A.page * PER, A.page * PER + PER);
    if (A.cur >= pageRows.length) A.cur = Math.max(0, pageRows.length - 1);
    const keep = document.activeElement && document.activeElement.id === "am-sq" ? document.activeElement.selectionStart : null;
    list.innerHTML = pageRows.map(rowHtml).join("") || `<div class="muted" style="padding:12px">${A.scope === "denied" ? "Nothing marked as no match." : "Nothing left to review here."}</div>`;
    if (keep != null && $("am-sq")) { $("am-sq").focus(); $("am-sq").setSelectionRange(keep, keep); }
    $("am-prev").hidden = A.page === 0; $("am-next").hidden = A.page >= pages - 1;
    $("am-count").textContent = rows.length ? `${A.page * PER + 1}–${A.page * PER + pageRows.length} of ${rows.length.toLocaleString()}` : "";
    const likely = pageRows.filter(l => !st(l.sku).done && A.scope !== "denied" && guessFor(l).conf === "high" && guessFor(l).top[0]);
    const b = $("am-bulk"); b.disabled = !likely.length || A.busy.size > 0; b.textContent = `Approve all "Likely" on this page (${likely.length})`;
  }

  // ---------- events ----------
  function rowOf(el) { const r = el.closest(".amrow"); return r ? { i: +r.dataset.i, l: pageRows[+r.dataset.i] } : null; }
  function currentPick(l) { const s = st(l.sku); return s.pick || guessFor(l).top[0]; }
  function unitsOf(l) { const s = st(l.sku); return Number(s.units != null ? s.units : guessFor(l).units) || 0; }
  function advance(i) { A.cur = Math.min(i + 1, pageRows.length - 1); render(); const r = document.querySelector(`.amrow[data-i="${A.cur}"]`); if (r) r.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  async function act(kind, i) {
    const l = pageRows[i]; if (!l) return; A.cur = i;
    if (kind === "approve") { const c = currentPick(l); if (c) { await approve(l, c, unitsOf(l)); advance(i); } }
    else if (kind === "deny") { const c = currentPick(l); if (c) { delete st(l.sku).pick; await saveDeny(l, { vid: c.v.vid }); } }
    else if (kind === "none") { await saveDeny(l, { none: true }); advance(i); }
    else if (kind === "undo") await undo(l);
    else if (kind === "search") { A.search = { sku: l.sku, q: "" }; render(); const s = $("am-sq"); if (s) s.focus(); }
  }
  function bind() {
    const list = $("am-list");
    $("am-mode").addEventListener("click", (e) => { const b = e.target.closest("button[data-m]"); if (!b) return; A.mode = b.dataset.m; A.page = 0; A.cur = 0; A.sel.clear(); document.querySelectorAll("#am-mode button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); note(null); render(); });
    $("am-vf").addEventListener("change", (e) => { A.vf = e.target.value; A.page = 0; A.sel.clear(); render(); });
    $("am-vs").addEventListener("change", (e) => { A.vs = e.target.value; A.page = 0; A.sel.clear(); render(); });
    $("am-setv").addEventListener("change", () => render());
    $("am-setsel").addEventListener("click", () => { const v = $("am-setv").value; if (!v) return; const l = [...A.sel].map(sku => ({ sku, vendor: v })); A.sel.clear(); saveVendors(l, `Set ${l.length} listing${l.length === 1 ? "" : "s"} to ${v === NONE ? "not sold in Shopify" : v}.`); });
    $("am-confirm").addEventListener("click", () => { const l = visibleV().filter(x => !A.vend.has(x.sku) && vendorOf(x)).map(x => ({ sku: x.sku, vendor: vendorOf(x) })); saveVendors(l, `Confirmed ${l.length.toLocaleString()} vendor${l.length === 1 ? "" : "s"}.`); });
    list.addEventListener("change", (e) => {
      if (A.mode !== "vendors") return;
      const t = e.target;
      if (t.dataset.v != null) { const l = vRows[+t.dataset.v]; saveVendors([{ sku: l.sku, vendor: t.value }]); }
      if (t.dataset.sel != null) { const l = vRows[+t.dataset.sel]; if (t.checked) A.sel.add(l.sku); else A.sel.delete(l.sku); render(); }
      if (t.id === "am-selall") { for (const l of vRows) { if (t.checked) A.sel.add(l.sku); else A.sel.delete(l.sku); } render(); }
    });
    list.addEventListener("click", (e) => {
      if (A.mode !== "products") return;
      const b = e.target.closest("button"); const r = rowOf(e.target); if (!r) return;
      A.cur = r.i;
      if (!b) { render(); return; }
      if (b.dataset.act) { act(b.dataset.act, r.i); return; }
      if (b.dataset.alt) { const v = A.byVid.get(b.dataset.alt); const g = guessFor(r.l); st(r.l.sku).pick = g.top.find(c => c.v === v) || { v, score: 0, why: ["picked by you"] }; A.search = null; render(); }
    });
    list.addEventListener("input", (e) => {
      if (e.target.id === "am-sq") { A.search.q = e.target.value; clearTimeout(list._t); list._t = setTimeout(render, 200); }
      if (A.mode === "products" && e.target.dataset.units != null) { const l = pageRows[+e.target.dataset.units]; st(l.sku).units = e.target.value; }
    });
    list.addEventListener("change", (e) => { if (A.mode === "products" && e.target.dataset.units != null) render(); });
    list.addEventListener("keydown", (e) => { if (e.target.id === "am-sq" && e.key === "Escape") { A.search = null; render(); } });
    $("am-q").addEventListener("input", (e) => { A.q = e.target.value; A.page = 0; A.cur = 0; clearTimeout($("am-q")._t); $("am-q")._t = setTimeout(render, 200); });
    $("am-scope").addEventListener("change", (e) => { A.scope = e.target.value; A.page = 0; A.cur = 0; A.sel.clear(); fillVendorSelects(); render(); });
    $("am-conf").addEventListener("click", (e) => { const b = e.target.closest("button[data-c]"); if (!b) return; A.conf = b.dataset.c; A.page = 0; A.cur = 0; document.querySelectorAll("#am-conf button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); render(); });
    $("am-refresh").addEventListener("click", () => { A.state.clear(); load(true); });
    $("am-prev").addEventListener("click", () => { A.page--; A.cur = 0; render(); window.scrollTo({ top: $("am-list").offsetTop - 120 }); });
    $("am-next").addEventListener("click", () => { A.page++; A.cur = 0; render(); window.scrollTo({ top: $("am-list").offsetTop - 120 }); });
    $("am-bulk").addEventListener("click", async () => {
      const todo = pageRows.map((l, i) => ({ l, i })).filter(({ l }) => !st(l.sku).done && guessFor(l).conf === "high" && guessFor(l).top[0]);
      for (const { l } of todo) await approve(l, currentPick(l), unitsOf(l));
      note("info", `Approved ${todo.length} likely match${todo.length === 1 ? "" : "es"}. Each one has an Undo button.`);
    });
    document.addEventListener("keydown", (e) => {
      if ($("tab-amzmatch").hidden || A.mode !== "products" || !pageRows.length) return;
      if (/INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || "") || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "a") { e.preventDefault(); act("approve", A.cur); }
      else if (k === "d") { e.preventDefault(); act("deny", A.cur); }
      else if (k === "n") { e.preventDefault(); act("none", A.cur); }
      else if (e.key === "ArrowDown") { e.preventDefault(); advance(A.cur); }
      else if (e.key === "ArrowUp") { e.preventDefault(); A.cur = Math.max(0, A.cur - 1); render(); }
    });
  }

  bind();
  window.addEventListener("jt:catalog", () => { if (!$("tab-amzmatch").hidden) load(true); else A.shown = false; });
  window.amShow = () => { if (!A.shown) { A.shown = true; load(false); } else render(); };
  window.JTAmReview = { _state: A };
  if ((location.hash || "") === "#amzmatch") setTimeout(() => window.amShow(), 0);
})();
