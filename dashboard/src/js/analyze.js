(() => {
  // ===================== Prep center › Analyze: what to send to Amazon =====================
  // For every FBA listing mapped to a Shopify product: Amazon's sales pace (last 30 days, else 90) against what Amazon
  // has or has coming (FBA available + transfer + inbound, AWD, prep shipments not yet in Seller Central). Below the
  // target days of cover, it needs stock; that comes from the prep center first (stock earmarked for the listing, then
  // not earmarked, less what's on open shipments), then the Shopify store (keeping a few in the store). Each product's
  // stock is shared between its listings, most urgent first. Rows can go on a new shipment or be ignored (migration 108).
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const n0 = (n) => Math.round(n || 0).toLocaleString();
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const JT = window.JT;
  const note = (kind, html) => { const n = $("an-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; };
  const saved = (() => { try { return JSON.parse(localStorage.getItem("jt-an") || "{}") || {}; } catch (_) { return {}; } })();
  const A = { shown: false, loading: false, ran: null, rows: null, short: [], ignored: [], target: saved.target || 45, keep: saved.keep ?? 2,
    sel: new Set(), send: new Map(), view: "send", q: "", vendor: "all" };
  const keepSettings = () => { try { localStorage.setItem("jt-an", JSON.stringify({ target: A.target, keep: A.keep })); } catch (_) {} };

  async function run(refresh) {
    A.loading = true; render();
    $("an-status").textContent = "Looking through the prep center, the Shopify store and Amazon…";
    try {
      const P = window.JTPrep;
      const [pd, , lst, sales, vars, ign] = await Promise.all([
        P.load(refresh),
        JT.fba ? JT.fba.load(refresh).catch(() => null) : null,
        JT.rowsSplit(["r->>0", "r->>1", "r->>2", "r->>5", "r->>6"], "from jt.docs d, jsonb_array_elements(d.data->'rows') r where d.collection = 'amzlistings'", "d.id", 2, refresh),
        JT.rows(["sku", "coalesce(sum(units) filter (where day > current_date - 30), 0)", "sum(units)"], "from jt.amazon_sku_daily where day > current_date - 90 group by sku", refresh),
        JT.rowsSplit(["variant_id::text", "coalesce(nullif(display_name, ''), product_title)", "sku", "vendor", "coalesce(inventory_qty, 0)", "unit_cost", "status"],
          "from jt.variants where removed_at is null and variant_id in (select (regexp_match(data->>'variantId', '(\\d+)$'))[1]::bigint from jt.docs where collection = 'amzmap' and data->>'kind' = 'shopify')", "variant_id", 2, refresh),
        JT.rows(["amazon_sku", "until::text", "added_by", "added_at"], "from jt.send_finder_ignore where cleared_at is null and (until is null or until >= current_date)", true).catch(() => []),
      ]);
      const fd = JT.fba && JT.fba.data;
      // listings (the All Listings report): FBA ones only (AMAZON_NA)
      const listings = new Map();
      for (const [sku, asin, title, ch, st] of lst) if (!listings.has(sku) || st === "Active") listings.set(sku, { sku, asin: asin || "", title: title || "", fba: /AMAZON/i.test(ch || ""), status: st || "" });
      const sold = new Map(sales.map(([k, a, b]) => [k, [+a || 0, +b || 0]]));
      const V = new Map(vars.map(x => [x[0], { vid: x[0], title: x[1] || "", sku: x[2] || "", vendor: x[3] || "", store: +x[4] || 0, cost: x[5] == null ? null : +x[5], status: x[6] || "" }]));
      const ignored = new Map(ign.map(([k, u, by, at]) => [k, { until: u, by: by || "", at }]));
      const items = new Map(fd ? fd.items.map(i => [i.sku, i]) : []);
      // prep center: free stock per product + listing key (less what's on open shipments), and units on open shipments
      // that aren't in Seller Central yet (they'll arrive at Amazon too)
      const free = new Map(), onWay = new Map();
      for (const r of pd.rows) if (r.qty > 0) { const k = r.vid + "|" + r.asku; free.set(k, (free.get(k) || 0) + r.qty - (pd.alloc.get(k) || 0)); }
      for (const sh of pd.shipments) if (sh.status !== "shipped" && !(sh.amz || []).length) for (const l of sh.lines) if (l.asku && l.qty > 0) onWay.set(l.asku, (onWay.get(l.asku) || 0) + l.qty);
      // candidate listings: FBA, mapped to a Shopify product, selling
      const cands = [];
      for (const [sku, m] of pd.skuUnits) {
        const L = listings.get(sku) || { sku, asin: "", title: "", fba: items.has(sku), status: "" };
        if (!L.fba && !items.has(sku)) continue;
        const v = V.get(String(m.vid)); if (!v) continue;
        const [s30, s90] = sold.get(sku) || [0, 0];
        const rate = s30 > 0 ? s30 / 30 : s90 / 90;
        if (!(rate > 0)) continue;
        const it = items.get(sku), pack = m.units || 1;
        const fba = it ? JT.fba.unitsOf(it, true, "fba") : 0, awd = it ? JT.fba.unitsOf(it, true, "awd") : 0, way = Math.floor((onWay.get(sku) || 0) / pack);
        const have = fba + awd + way, cover = have / rate, need = Math.ceil(rate * A.target - have);
        cands.push({ sku, asin: L.asin || (it && it.asin) || "", title: L.title || (it && it.name) || v.title, status: L.status, vid: v.vid, v, pack, s30, s90, rate,
          fba, fbaAvail: it ? it.avail : 0, inbound: it ? it.inbound + it.transfer : 0, awd, way, have, cover, need, price: it && it.price, ignored: ignored.get(sku) || null });
      }
      // most urgent first takes the shared stock
      cands.sort((a, b) => a.cover - b.cover || b.rate - a.rate);
      const storeLeft = new Map(), prepLeft = new Map(free);
      for (const c of cands) {
        if (c.need <= 0 || c.ignored) { c.fromPrep = c.fromStore = 0; continue; }
        const ke = c.vid + "|" + c.sku, ka = c.vid + "|";
        const pe = Math.max(0, prepLeft.get(ke) || 0), pa = Math.max(0, prepLeft.get(ka) || 0);
        const prepUnits = Math.floor((pe + pa) / c.pack);
        c.fromPrep = Math.min(c.need, prepUnits);
        let use = c.fromPrep * c.pack; const e = Math.min(use, pe); prepLeft.set(ke, pe - e); prepLeft.set(ka, pa - (use - e));
        c.prepEarmarked = e; c.prepAny = use - e;
        if (!storeLeft.has(c.vid)) storeLeft.set(c.vid, Math.max(0, c.v.store - A.keep));
        const st = storeLeft.get(c.vid), rest = c.need - c.fromPrep;
        c.fromStore = Math.max(0, Math.min(rest, Math.floor(st / c.pack)));
        storeLeft.set(c.vid, st - c.fromStore * c.pack);
        c.prepAvail = prepUnits; c.storeAvail = Math.floor(st / c.pack);
      }
      A.rows = cands.filter(c => c.need > 0 && !c.ignored && c.fromPrep + c.fromStore > 0);
      A.short = cands.filter(c => c.need > 0 && !c.ignored && c.fromPrep + c.fromStore === 0);
      A.ignored = cands.filter(c => c.ignored);
      A.send = new Map(A.rows.map(c => [c.sku, c.fromPrep + c.fromStore]));
      A.sel = new Set([...A.sel].filter(k => A.send.has(k)));
      A.ran = new Date();
      const snap = fd && fd.meta && fd.meta.snapshot ? ` · FBA report of ${new Date(fd.meta.snapshot + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : " · no FBA report loaded";
      $("an-status").textContent = `${cands.length.toLocaleString()} selling FBA listings checked · ${A.rows.length} can be sent now · ${A.short.length} low with nothing on hand${snap} · run ${A.ran.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
      note(null);
    } catch (e) { note("bad", esc(JT.message(e))); $("an-status").textContent = ""; }
    finally { A.loading = false; render(); }
  }

  const coverTxt = (c) => !isFinite(c.cover) ? "—" : c.cover < 1 ? "<1 day" : n0(c.cover) + " days";
  function render() {
    if ($("tab-analyze").hidden) return;
    $("an-run").disabled = A.loading; $("an-run").textContent = A.loading ? "Looking…" : A.rows ? "Run again" : "Find items to send";
    $("an-target").value = A.target; $("an-keep").value = A.keep;
    document.querySelectorAll("#an-view button").forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.v === A.view)); const c = b.querySelector(".cnt"); if (c) c.textContent = A.rows ? { send: A.rows.length, short: A.short.length, ignored: A.ignored.length }[b.dataset.v] : 0; });
    const t = $("an-table");
    if (!A.rows) { t.innerHTML = `<tbody><tr><td class="l muted">${A.loading ? "Looking…" : "Press <b>Find items to send</b> to look through the prep center and the Shopify store for stock Amazon is running low on."}</td></tr></tbody>`; $("an-kpis").innerHTML = ""; $("an-bar").hidden = true; return; }
    const q = A.q.trim().toLowerCase();
    const vend = [...new Set([...A.rows, ...A.short, ...A.ignored].map(c => c.v.vendor))].filter(Boolean).sort();
    $("an-vendor").innerHTML = `<option value="all">All vendors</option>` + vend.map(v => `<option ${v === A.vendor ? "selected" : ""}>${esc(v)}</option>`).join("");
    const list = ({ send: A.rows, short: A.short, ignored: A.ignored }[A.view] || []).filter(c => (A.vendor === "all" || c.v.vendor === A.vendor) && (!q || [c.title, c.sku, c.asin, c.v.title, c.v.sku, c.v.vendor].join(" ").toLowerCase().includes(q)));
    // KPIs over everything that can be sent
    const units = A.rows.reduce((a, c) => a + (A.send.get(c.sku) || 0), 0), prepU = A.rows.reduce((a, c) => a + c.fromPrep, 0), storeU = A.rows.reduce((a, c) => a + c.fromStore, 0);
    const cost = A.rows.reduce((a, c) => a + (A.send.get(c.sku) || 0) * c.pack * (c.v.cost || 0), 0), oos = A.rows.filter(c => c.fba <= 0).length;
    $("an-kpis").innerHTML = [
      { l: "Listings to send", v: n0(A.rows.length), s: `${oos} out of stock at FBA · below ${A.target} days of cover` },
      { l: "Amazon units", v: n0(units), s: `${n0(prepU)} from the prep center · ${n0(storeU)} from the Shopify store` },
      { c: "cost", l: "At cost", v: usd0.format(cost), s: "suggested units × Shopify cost" },
      { l: "Low, nothing on hand", v: n0(A.short.length), s: A.short.length ? '<button class="linkbtn small" data-anv="short">see them</button> · reorder from the vendor' : "nothing to reorder" },
    ].map(k => `<div class="kpi ${k.c || ""}"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
    const sendView = A.view === "send";
    const row = (c) => {
      const send = A.send.get(c.sku) ?? 0, pk = c.pack !== 1 ? ` · ${c.pack}-pack` : "";
      return `<tr class="${c.fba <= 0 ? "flag-bad" : c.cover < 14 ? "flag-warn" : ""}">
        ${sendView ? `<td><input type="checkbox" data-ansel="${esc(c.sku)}" ${A.sel.has(c.sku) ? "checked" : ""} aria-label="Select ${esc(c.sku)}"></td>` : ""}
        <td class="l"><div class="iname">${esc(c.v.title)}</div><div class="meta"><span class="mono">${c.asin ? `<a class="olink" href="https://www.amazon.com/dp/${encodeURIComponent(c.asin)}" target="_blank" rel="noopener">${esc(c.asin)}</a>` : "no ASIN"}</span> · <span class="mono">${esc(c.sku)}</span>${pk} · ${esc(c.v.vendor || "—")}${c.status && c.status !== "Active" ? ` · <span class="dim">${esc(c.status.toLowerCase())}</span>` : ""}</div></td>
        <td>${n0(c.s30)}<div class="meta">${c.rate >= 1 ? c.rate.toFixed(1) : c.rate.toFixed(2)}/day${c.s30 ? "" : " (90d)"}</div></td>
        <td>${n0(c.fbaAvail)}<div class="meta">${c.inbound ? n0(c.inbound) + " inbound" : ""}${c.awd ? `${c.inbound ? " · " : ""}${n0(c.awd)} AWD` : ""}${c.way ? ` · ${n0(c.way)} on open shipments` : ""}</div></td>
        <td class="${c.cover < 14 ? "neg" : ""}"><b>${coverTxt(c)}</b></td>
        <td>${n0(Math.max(0, c.need))}</td>
        ${A.view === "ignored" ? "" : `<td>${n0(c.prepAvail || 0)}${c.pack !== 1 && c.prepAvail ? `<div class="meta">${n0(c.prepAvail * c.pack)} singles</div>` : ""}</td><td>${n0(c.storeAvail || 0)}<div class="meta">${n0(c.v.store)} in store</div></td>`}
        ${sendView ? `<td><input class="inp num sm an-send" data-ansend="${esc(c.sku)}" value="${send}" inputmode="numeric" aria-label="Units to send for ${esc(c.sku)}"><div class="meta">${c.fromStore ? `${n0(c.fromStore)} from store` : "prep center"}</div></td>` : ""}
        <td class="l"><span class="rbtns">${sendView ? `<button class="mini primary" data-anship="${esc(c.sku)}">Ship</button><button class="mini" data-anign="${esc(c.sku)}" title="Leave it out of the next 30 days of runs">Ignore</button>`
          : A.view === "ignored" ? `<span class="small muted">${c.ignored.until ? "until " + esc(c.ignored.until) : "until cleared"}</span> <button class="mini" data-anunign="${esc(c.sku)}">Un-ignore</button>`
          : `<button class="mini" data-anlist="${esc(c.sku)}" title="Put it on On The List to re-order">+ List</button><button class="mini" data-anign="${esc(c.sku)}">Ignore</button>`}</span></td></tr>`;
    };
    const head = `<thead><tr>${sendView ? `<th><input type="checkbox" id="an-all" aria-label="Select all" ${list.length && list.every(c => A.sel.has(c.sku)) ? "checked" : ""}></th>` : ""}<th class="l">Product · Amazon listing</th><th title="Units sold on this listing, last 30 days">Sold 30d</th><th title="FBA available; inbound, AWD and open prep shipments under it">At Amazon</th><th title="Amazon stock (FBA + inbound + AWD + open shipments) ÷ daily sales">Cover</th><th title="Amazon units to reach the target days of cover">Need</th>${A.view === "ignored" ? "" : `<th title="Amazon units the prep center can make (earmarked + not earmarked, less open shipments)">Prep center</th><th title="Amazon units the Shopify store can spare (keeping ${A.keep} in the store)">Store</th>`}${sendView ? "<th>Send</th>" : ""}<th class="l"></th></tr></thead>`;
    t.innerHTML = head + `<tbody>${list.map(row).join("") || `<tr><td class="l muted" colspan="11">${{ send: "Nothing to send right now — every selling listing has enough cover, or there's no stock to send.", short: "No listings are low without stock on hand.", ignored: "Nothing ignored." }[A.view]}</td></tr>`}</tbody>`;
    const n = [...A.sel].filter(k => A.send.has(k)).length;
    $("an-bar").hidden = !sendView || !A.rows.length;
    $("an-ship-sel").disabled = !n; $("an-ship-sel").textContent = n ? `Start a shipment with ${n} selected` : "Start a shipment with selected";
    $("an-ign-sel").disabled = !n;
  }

  // a new shipment: Shopify units per listing (earmarked to that listing); store units are noted for pulling
  async function ship(skus) {
    const rows = skus.map(k => A.rows.find(c => c.sku === k)).filter(Boolean).filter(c => (A.send.get(c.sku) || 0) > 0);
    if (!rows.length) { note("warn", "Enter how many to send first."); return; }
    const pull = [];
    const lines = rows.map(c => {
      const amz = A.send.get(c.sku), fromStore = Math.max(0, amz - c.fromPrep);
      if (fromStore) pull.push(`${c.v.sku || c.v.title} ×${fromStore * c.pack}`);
      return { vid: c.vid, asku: c.sku, qty: amz * c.pack, title: c.v.title, sku: c.v.sku, vendor: c.v.vendor, cost: c.v.cost };
    });
    await window.JTPrep.startShipment({ lines, note: `From Analyze${pull.length ? ` · pull from the Shopify store: ${pull.join(", ")}` : ""}` });
  }
  async function ignore(skus, clear) {
    try {
      await JT.prep.finderIgnore({ skus, days: clear ? null : 30, clear: !!clear });
      for (const k of skus) A.sel.delete(k);
      note("info", clear ? "Back in the list." : `${skus.length} listing${skus.length === 1 ? "" : "s"} ignored for 30 days (see Ignored).`);
      await run(false);
    } catch (e) { note("bad", "Couldn't save: " + esc(JT.message(e))); }
  }

  function bind() {
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on("an-run", "click", () => run(true));
    on("an-target", "change", (e) => { const v = Math.round(Number(e.target.value)); if (v > 0 && v < 400) { A.target = v; keepSettings(); if (A.rows) run(false); } });
    on("an-keep", "change", (e) => { const v = Math.round(Number(e.target.value)); if (v >= 0 && v < 1000) { A.keep = v; keepSettings(); if (A.rows) run(false); } });
    on("an-view", "click", (e) => { const b = e.target.closest("button[data-v]"); if (b) { A.view = b.dataset.v; render(); } });
    on("an-vendor", "change", (e) => { A.vendor = e.target.value; render(); });
    on("an-q", "input", (e) => { A.q = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(render, 200); });
    on("an-ship-sel", "click", () => ship([...A.sel]));
    on("an-ign-sel", "click", () => ignore([...A.sel]));
    on("an-kpis", "click", (e) => { const b = e.target.closest("[data-anv]"); if (b) { A.view = b.dataset.anv; render(); } });
    const t = $("an-table");
    t.addEventListener("change", (e) => {
      if (e.target.id === "an-all") { const vis = [...t.querySelectorAll("input[data-ansel]")].map(x => x.dataset.ansel); for (const k of vis) e.target.checked ? A.sel.add(k) : A.sel.delete(k); render(); return; }
      if (e.target.dataset.ansel) { e.target.checked ? A.sel.add(e.target.dataset.ansel) : A.sel.delete(e.target.dataset.ansel); render(); return; }
      if (e.target.dataset.ansend) { const v = Math.max(0, Math.round(Number(e.target.value) || 0)); A.send.set(e.target.dataset.ansend, v); render(); }
    });
    t.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.anship) ship([b.dataset.anship]);
      if (b.dataset.anign) ignore([b.dataset.anign]);
      if (b.dataset.anunign) ignore([b.dataset.anunign], true);
      if (b.dataset.anlist) { const c = A.short.find(x => x.sku === b.dataset.anlist); if (!c) return; b.disabled = true;
        window.JTPrep.addToList({ variant_id: Number(c.vid), amazon_sku: c.sku, dest: "prep", source: "analyze" })
          .then(r => note("info", `Added ${esc(c.v.title)} to ${r.where}.`), err => { b.disabled = false; note("bad", "Couldn't add it: " + esc(JT.message(err))); }); }
    });
  }
  bind();
  window.anShow = () => { if (!A.shown) { A.shown = true; render(); } else render(); };
  if ((location.hash || "") === "#analyze") setTimeout(() => window.anShow(), 0);
})();
