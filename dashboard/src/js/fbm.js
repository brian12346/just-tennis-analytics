// FBM → Shopify tab: Amazon FBM orders ship from the Shopify store's stock, so each shipped FBM order is taken out
// of Shopify's inventory once someone confirms it here (jt.fbm_decide; the sync job then adjusts Shopify).
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const S = { msg: null, lines: null, lst: null, lstErr: null, lsel: new Set(), lqty: new Map(), fba: new Map(), lfba: "all", lres: new Map(), lnote: "", lconfirm: false, sending: false, lv: "all", lq: "", lsort: ["shopify_qty", -1], lshown: 150, downloads: null, cfg: {}, view: "confirm", q: "", sel: new Set(), busy: false, err: null, loading: false, timer: null, shown: 150 };
  const COLS = ["order_id", "sku", "asin", "product_name", "quantity", "order_status", "purchased", "shipped", "cancelled", "map_kind",
    "variant_id", "map_units", "units", "shopify_title", "shopify_sku", "shopify_qty", "product_id", "tracked",
    "decision", "status", "error", "decided_by", "decided_at", "applied_at", "shopify_before", "decided_units", "location_id", "label_cost"];
  // the Shopify location stock comes out of (jt.settings fbm_sync.location_id); its name is typed in on this page,
  // because the Shopify app can't read location names
  const locNum = (gid) => String(gid || "").split("/").pop();
  const locUrl = (gid) => `https://admin.shopify.com/store/justtennis-822/settings/locations/${encodeURIComponent(locNum(gid))}`;
  const locName = (gid) => {
    const known = (S.cfg.locations || []).find(x => x.id === gid);
    if (known && known.name) return known.name;
    return gid && gid === S.cfg.location_id && S.cfg.location_name ? S.cfg.location_name : gid ? `location #${locNum(gid)}` : "";
  };
  const fmtDT = (s) => { if (!s) return ""; const [d, t] = s.split(" "); return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) + (t ? " " + t : ""); };
  const shopUrl = (pid, vid) => pid ? `https://admin.shopify.com/store/justtennis-822/products/${encodeURIComponent(pid)}${vid ? "/variants/" + encodeURIComponent(vid) : ""}` : "";
  const note = (kind, html) => { const n = $("fbm-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; };

  const LCOLS = ["sku", "asin", "title", "amazon_status", "amazon_qty", "amazon_price", "report_file", "report_at", "variant_id", "map_units",
    "product_id", "shopify_title", "shopify_sku", "shopify_qty", "packs", "shopify_total", "stock_source", "amazon_qty_now", "pushed_qty", "pushed_status",
    "pushed_at", "pushed_by", "pushed_error", "stock_at"];

  // a line's state on this page
  function lineState(l) {
    const st = l.status === "undone" ? null : l.status;
    if (st === "done") return "done";
    if (st === "pending") return "pending";
    if (st === "failed") return "failed";
    if (st === "skipped") return "skipped";
    if (l.cancelled) return "cancelled";
    if (l.units == null) return l.shipped ? "unmapped" : "waiting";
    return l.shipped ? "ready" : "waiting";
  }
  function orders() {
    const m = new Map();
    for (const l of S.lines || []) {
      const o = m.get(l.order_id) || { id: l.order_id, purchased: l.purchased, status: l.order_status, shipped: l.shipped, cancelled: l.cancelled, label: l.label_cost == null ? null : +l.label_cost, lines: [] };
      l.state = lineState(l); o.lines.push(l); m.set(l.order_id, o);
    }
    for (const o of m.values()) {
      const st = o.lines.map(l => l.state);
      o.open = st.some(s => s === "ready" || s === "failed" || s === "unmapped");   // needs a decision now
      o.ready = o.lines.filter(l => l.state === "ready" || l.state === "failed");
      o.waiting = !o.cancelled && !o.shipped && st.some(s => s === "waiting");
      o.sent = st.some(s => s === "done" || s === "pending");
      o.skipped = st.length && st.every(s => s === "skipped" || s === "cancelled") && st.includes("skipped");
      o.units = o.ready.reduce((a, l) => a + (l.units || 0), 0);
    }
    return [...m.values()];
  }
  const inView = (o) => S.view === "all" || (S.view === "confirm" && o.open) || (S.view === "waiting" && o.waiting) || (S.view === "sent" && o.sent) || (S.view === "skipped" && o.skipped);
  const matches = (o) => !S.q || o.id.toLowerCase().includes(S.q) || o.lines.some(l => [l.sku, l.product_name, l.shopify_title, l.shopify_sku, l.asin].some(x => String(x || "").toLowerCase().includes(S.q)));

  async function load(refresh) {
    if (!window.JT || !window.JT.fbm) return;
    S.loading = true; render();
    try {
      const lp = Promise.all([window.JT.fbm.listings(refresh), window.JT.fbm.fba(refresh).catch(() => [])]).then(([r, fr]) => { setFba(fr); S.lst = r.map(x => Object.fromEntries(LCOLS.map((c, i) => [c, x[i]]))); S.lstErr = null; }, e => { S.lstErr = e; });
      const [rows, cfg] = await Promise.all([window.JT.fbm.lines(refresh), window.JT.fbm.settings(refresh)]);
      S.lines = rows.map(r => Object.fromEntries(COLS.map((c, i) => [c, r[i]])));
      S.cfg = cfg || {}; S.err = null;
      render();
      await lp;
    } catch (e) { S.err = e; }
    S.loading = false;
    for (const id of [...S.sel]) if (!(S.lines || []).some(l => l.order_id === id)) S.sel.delete(id);
    render();
    // while Shopify changes are on their way, look again every 15 seconds
    clearTimeout(S.timer);
    if ((S.lines || []).some(l => l.status === "pending") && !$("tab-fbm").hidden) S.timer = setTimeout(() => load(true), 15000);
  }

  function render() {
    if ($("tab-fbm").hidden) return;
    const st = $("fbm-status");
    if (S.cfg.start && !$("fbm-start").value) $("fbm-start").value = S.cfg.start;
    if (S.err && !S.lines) { st.textContent = ""; note("bad", "Couldn't load FBM orders: " + esc(window.JT.message ? window.JT.message(S.err) : (S.err.message || S.err))); return; }
    if (!S.lines) { st.textContent = "Loading FBM orders…"; return; }
    const all = orders();
    const pend = (S.lines || []).filter(l => l.status === "pending").length;
    st.textContent = `${all.length.toLocaleString()} FBM orders since ${fmtDT(S.cfg.start || "")}${pend ? ` · ${pend} change${pend > 1 ? "s" : ""} on the way to Shopify…` : ""}${S.loading ? " · refreshing…" : ""}`;
    const lb = $("fbm-loc");
    if (S.editLoc) lb.innerHTML = `<span class="eyebrow">Shopify location</span><input class="inp" id="fbm-locname" maxlength="80" placeholder="Name, e.g. Warehouse" value="${esc(S.cfg.location_name || "")}"> <button class="mini primary" type="button" data-loc="save">Save</button> <button class="mini" type="button" data-loc="cancel">Cancel</button>`;
    else if ((S.cfg.locations || []).length) lb.innerHTML = `<span class="eyebrow">Stock comes out of</span>
      <select class="inp" id="fbm-locsel" aria-label="Shopify location FBM orders ship from">${S.cfg.location_id ? "" : '<option value="">The product\'s only location</option>'}${S.cfg.locations.map(x => `<option value="${esc(x.id)}" ${x.id === S.cfg.location_id ? "selected" : ""}>${esc(x.name || "location #" + locNum(x.id))}</option>`).join("")}</select>
      ${S.cfg.location_id ? `<a class="olink small" href="${esc(locUrl(S.cfg.location_id))}" target="_blank" rel="noopener">open in Shopify</a>` : ""}`;
    else lb.innerHTML = S.cfg.location_id
      ? `<span class="eyebrow">Stock comes out of</span> <b>${esc(locName(S.cfg.location_id))}</b> <a class="olink small" href="${esc(locUrl(S.cfg.location_id))}" target="_blank" rel="noopener">open in Shopify</a> <button class="mini" type="button" data-loc="edit">${S.cfg.location_name ? "Rename" : "Name it"}</button>`
      : `<span class="eyebrow">Stock comes out of</span> <span class="muted">the product's only Shopify location (if a product is stocked at more than one, it'll ask which)</span>`;
    const failed = (S.lines || []).filter(l => l.status === "failed");
    const notes = [];
    if (S.msg) notes.push(S.msg);
    if (failed.length) notes.push(["bad", `Shopify didn't take ${failed.length} change${failed.length > 1 ? "s" : ""}: ${esc(failed[0].error)}${failed.length > 1 ? " (and others)" : ""}. They're back in To confirm — try again, or don't take them out.`]);
    const nn = $("fbm-note"); nn.hidden = !notes.length; nn.innerHTML = notes.map(([k, h]) => `<div class="note ${k}">${h}</div>`).join("");

    // KPIs
    const conf = all.filter(o => o.open), wait = all.filter(o => o.waiting);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const sentLines = (S.lines || []).filter(l => l.status === "done" && (l.applied_at || "") >= weekAgo);
    const um = unmappedSkus(), umSet = new Set(um.map(l => l.sku));
    const umOrders = all.filter(o => o.lines.some(l => umSet.has(l.sku) && (l.state === "unmapped" || l.state === "waiting"))).length;
    const k = [
      { c: "sales", l: "To confirm", v: conf.length.toLocaleString(), s: `${conf.reduce((a, o) => a + o.units, 0).toLocaleString()} Shopify units shipped` },
      { l: "Waiting to ship", v: wait.length.toLocaleString(), s: "Confirm once Amazon shows them shipped" },
      { l: "Taken out, last 7 days", v: sentLines.reduce((a, l) => a + (l.decided_units || 0), 0).toLocaleString(), s: `units across ${new Set(sentLines.map(l => l.order_id)).size} orders` },
      { c: um.length ? "warnk" : "", l: "Listings not mapped", v: um.length ? `<button class="kpilink" type="button" data-mapall title="Open Amazon mapping with just these listings">${um.length.toLocaleString()}</button>` : "0", s: um.length ? `On ${umOrders} order${umOrders > 1 ? "s" : ""} · click the number to map ${um.length > 1 ? "them" : "it"}` : "Every FBM item has a Shopify product" },
    ];
    $("fbm-kpis").innerHTML = k.map(x => `<div class="kpi ${x.c || ""}"><span class="eyebrow">${x.l}</span><span class="v">${x.v}</span><span class="s">${x.s}</span></div>`).join("");
    $("fbm-title").textContent = { confirm: "Shipped — confirm each order", waiting: "Not shipped yet", sent: "Taken out of Shopify", skipped: "Not taken out", all: "All FBM orders" }[S.view];

    const list = all.filter(inView).filter(matches);
    const selectable = list.filter(o => o.ready.length);
    for (const id of [...S.sel]) if (!selectable.some(o => o.id === id)) S.sel.delete(id);
    const allSel = selectable.length && selectable.every(o => S.sel.has(o.id));
    const body = list.slice(0, S.shown).map(o => {
      const can = o.ready.length > 0;
      const items = o.lines.map(l => {
        const shop = l.units != null
          ? `→ ${l.product_id ? `<a class="olink" href="${esc(shopUrl(l.product_id, l.variant_id))}" target="_blank" rel="noopener">${esc(l.shopify_title || l.shopify_sku || "Shopify product")}</a>` : esc(l.shopify_title || "")}${l.shopify_sku ? ` <span class="mono">${esc(l.shopify_sku)}</span>` : ""}${l.map_units > 1 ? ` · ${l.quantity} × ${l.map_units}` : ""} · Shopify has ${l.shopify_qty == null ? "?" : Number(l.shopify_qty).toLocaleString()}${l.tracked === false ? " (not tracked)" : ""}`
          : l.map_kind && l.map_kind !== "shopify" ? `<span class="warnt">Mapped to a manual cost, not a Shopify product</span> <button class="mini" type="button" data-map="${esc(l.sku)}">Map</button>`
          : `<span class="warnt">Not mapped to a Shopify product</span> <button class="mini" type="button" data-map="${esc(l.sku)}">Map</button>`;
        const state = { done: `<span class="pill ok" title="${esc(l.location_id ? "From " + locName(l.location_id) : "")}">Taken out ${esc(fmtDT(l.applied_at))}${l.location_id ? " · " + esc(locName(l.location_id)) : ""}</span>`, pending: `<span class="pill web">Sending to Shopify…</span>`,
          failed: `<span class="pill cx">Shopify refused</span>`, skipped: `<span class="pill pos">Not taken out</span>`, cancelled: `<span class="pill pos">Cancelled</span>` }[l.state] || "";
        return `<div class="fl"><div><div class="iname">${esc(l.product_name || l.sku)}</div><div class="meta"><span class="mono">${esc(l.sku)}</span> ${shop}</div>${l.state === "failed" ? `<div class="err">${esc(l.error)}</div>` : ""}${l.decided_by && (l.state === "done" || l.state === "skipped") ? `<div class="meta">by ${esc(l.decided_by)}</div>` : ""}</div><div class="u">${l.units != null ? `−${l.units}` : ""} ${state}</div></div>`;
      }).join("");
      const decided = o.lines.filter(l => l.state === "skipped" || l.state === "failed");
      const acts = can
        ? `<div class="dbtns"><button class="mini primary" type="button" data-act="decrement" data-o="${esc(o.id)}">Take out of Shopify</button><button class="mini" type="button" data-act="skip" data-o="${esc(o.id)}">Don't take out</button></div>`
        : o.lines.some(l => l.state === "unmapped") && !o.lines.some(l => l.state === "skipped") ? `<div class="dbtns"><button class="mini" type="button" data-act="skip" data-o="${esc(o.id)}">Don't take out</button></div>`
        : decided.length ? `<div class="dbtns"><button class="mini" type="button" data-act="undo" data-o="${esc(o.id)}">Undo</button></div>` : "";
      const pill = o.cancelled ? '<span class="pill cx">Cancelled</span>' : o.shipped ? `<span class="pill ok">${esc(o.status)}</span>` : `<span class="pill pos">${esc(o.status || "Not shipped")}</span>`;
      return `<tr class="${S.sel.has(o.id) ? "sel" : ""}"><td>${can ? `<input type="checkbox" data-sel="${esc(o.id)}" ${S.sel.has(o.id) ? "checked" : ""} aria-label="Select order ${esc(o.id)}">` : ""}</td>
        <td class="l mono"><a class="olink" href="https://sellercentral.amazon.com/orders-v3/order/${encodeURIComponent(o.id)}" target="_blank" rel="noopener">${esc(o.id)}</a></td>
        <td class="l">${esc(fmtDT(o.purchased))}</td><td class="l">${pill}${o.label != null ? `<div class="meta" title="Shipping label bought in Veeqo">Label $${o.label.toFixed(2)}</div>` : ""}</td><td class="l items">${items}</td><td class="act">${acts}</td></tr>`;
    }).join("");
    $("fbm-table").innerHTML = `<thead><tr><th>${selectable.length ? `<input type="checkbox" data-selall ${allSel ? "checked" : ""} aria-label="Select all">` : ""}</th><th class="l">Order</th><th class="l">Ordered</th><th class="l">Amazon status</th><th class="l">Items → Shopify</th><th></th></tr></thead>
      <tbody>${body || `<tr><td class="l dim" colspan="6">${S.view === "confirm" ? "Nothing to confirm — every shipped FBM order has been decided." : "No orders here."}</td></tr>`}</tbody>`;
    $("fbm-count").innerHTML = list.length > S.shown ? `Showing ${S.shown} of ${list.length.toLocaleString()} orders <button class="mini" type="button" id="fbm-more">Show more</button>` : list.length ? `${list.length.toLocaleString()} order${list.length > 1 ? "s" : ""}` : "";
    const selOrders = selectable.filter(o => S.sel.has(o.id));
    const bulk = $("fbm-bulk");
    bulk.hidden = !selOrders.length;
    if (selOrders.length) bulk.innerHTML = `<span><b>${selOrders.length}</b> order${selOrders.length > 1 ? "s" : ""} selected · ${selOrders.reduce((a, o) => a + o.units, 0).toLocaleString()} Shopify units</span>
      <span class="dbtns"><button class="mini primary" type="button" data-bulk="decrement" ${S.busy ? "disabled" : ""}>Take ${selOrders.length > 1 ? "them" : "it"} out of Shopify</button><button class="mini" type="button" data-bulk="skip" ${S.busy ? "disabled" : ""}>Don't take out</button><button class="mini" type="button" data-bulk="clear">Clear</button></span>`;
    renderListings();
  }

  // ---------- FBM listings Shopify has stock for (stock at the FBM location), and sending quantities to Amazon ----------
  const num = (v) => v == null || v === "" ? "" : Number(v).toLocaleString();
  const money = (v) => v == null || v === "" ? "" : "$" + Number(v).toFixed(2);
  // FBA / AWD stock for the ASIN (Amazon inventory tab's latest reports). If Amazon holds the ASIN at FBA, FBA should
  // carry it and the FBM listing stays at 0.
  const fbaOf = (asin) => S.fba.get(asin) || null;
  const sendQty = (l) => { const v = S.lqty.get(l.sku); if (v != null) return v; const f = fbaOf(l.asin); return f && f.stocked ? 0 : (l.packs || 0); };
  function setFba(rows) {
    const m = new Map();
    for (const [sku, asin, title, avail, inbound, t30, kind, snap] of rows) {
      const g = m.get(asin) || { rows: [], avail: 0, inbound: 0, awd: 0, t30: 0, snapshot: "" };
      g.rows.push({ sku, title, avail: +avail || 0, inbound: +inbound || 0, t30: +t30 || 0, kind });
      if (kind === "awd") g.awd += (+avail || 0) + (+inbound || 0); else { g.avail += +avail || 0; g.inbound += +inbound || 0; g.t30 += +t30 || 0; }
      if (snap && kind === "fba") g.snapshot = snap;
      m.set(asin, g);
    }
    for (const g of m.values()) g.stocked = g.avail + g.inbound + g.awd > 0;
    S.fba = m;
  }
  function listingsShown() {
    const q = S.lq, [k, dir] = S.lsort;
    return (S.lst || []).filter(l => (S.lv === "all" || (S.lv === "zero" ? !Number(l.amazon_qty_now) : l.amazon_status === S.lv)) &&
        (S.lfba === "all" || (S.lfba === "fba") === !!(fbaOf(l.asin) || {}).stocked) &&
        (!q || [l.asin, l.sku, l.title, l.shopify_title, l.shopify_sku, ...((fbaOf(l.asin) || {}).rows || []).map(r => r.sku)].some(x => String(x || "").toLowerCase().includes(q))))
      .sort((a, b) => {
        const x = a[k], y = b[k];
        const c = typeof x === "number" || typeof y === "number" ? (Number(x) || 0) - (Number(y) || 0) : String(x || "").localeCompare(String(y || ""));
        return c * dir || String(a.asin).localeCompare(String(b.asin)) || String(a.sku).localeCompare(String(b.sku));
      });
  }
  // the shown listings as ASIN groups, in sort order of their first listing
  function groupsShown(list) {
    const m = new Map();
    for (const l of list) { if (!m.has(l.asin)) m.set(l.asin, []); m.get(l.asin).push(l); }
    return [...m.entries()].map(([asin, fbm]) => ({ asin, fbm, fba: fbaOf(asin) }));
  }
  function renderListings() {
    const sub = $("fbl-sub"), tb = $("fbl-table");
    if (S.lstErr && !S.lst) { sub.textContent = "Couldn't load FBM listings: " + (window.JT.message ? window.JT.message(S.lstErr) : (S.lstErr.message || S.lstErr)); tb.innerHTML = ""; return; }
    if (!S.lst) { sub.textContent = "Loading FBM listings…"; tb.innerHTML = ""; return; }
    const all = S.lst, f = all[0];
    const loc = locName(S.cfg.location_id) || "the FBM location";
    const asins = new Set(all.map(l => l.asin)), atFba = [...asins].filter(a => (fbaOf(a) || {}).stocked).length;
    const snap = [...S.fba.values()].map(g => g.snapshot).find(Boolean);
    const fromLoc = f && f.stock_source === "location";
    sub.innerHTML = `${asins.size.toLocaleString()} ASINs (${all.length.toLocaleString()} FBM listings) with Shopify stock at <b>${esc(loc)}</b> · <b>${atFba.toLocaleString()}</b> also stocked at FBA${snap ? ` (FBA report ${esc(fmtDT(snap))})` : ""} — those stay at 0 on FBM` +
      (fromLoc ? ` · stock as of ${esc(fmtDT(f.stock_at))} <button class="mini" type="button" id="fbl-stock">Refresh stock</button>` : ` · <span class="warnt">stock shown is the total across locations until the first ${esc(loc)} stock sync</span> <button class="mini" type="button" id="fbl-stock">Get ${esc(loc)} stock</button>`) +
      `${f ? ` · listings ${/Amazon API/.test(f.report_file || "") ? "fetched" : "uploaded"} ${esc(fmtDT(f.report_at))}` : ""}`;
    const list = listingsShown(), groups = groupsShown(list);
    for (const k of [...S.lsel]) if (!list.some(l => l.sku === k)) S.lsel.delete(k);
    const th = (k, label, cls) => `<th class="${cls || ""} sort" data-lsort="${k}" ${S.lsort[0] === k ? `aria-sort="${S.lsort[1] > 0 ? "ascending" : "descending"}"` : ""}>${label}</th>`;
    const shownGroups = groups.slice(0, S.lshown), shownRows = shownGroups.flatMap(g => g.fbm);
    const body = shownGroups.map(g => {
      const fb = g.fba, gsel = g.fbm.every(l => S.lsel.has(l.sku));
      const fbaTxt = fb && fb.stocked
        ? `<span class="pill ok">${fb.avail || fb.inbound ? "At FBA" : "At AWD"}</span> <b>${num(fb.avail)}</b> available${fb.inbound ? ` · ${num(fb.inbound)} inbound` : ""}${fb.awd ? ` · ${num(fb.awd)} at AWD` : ""}${fb.t30 ? ` · ${num(fb.t30)} sold in 30 days` : ""} <span class="muted">— FBA carries this ASIN, keep FBM at 0</span>`
        : fb ? `<span class="pill pos">FBA empty</span> <span class="muted">FBA SKU${fb.rows.length > 1 ? "s" : ""} on this ASIN have no stock — FBM can carry it</span>`
        : `<span class="pill pos">Not at FBA</span>`;
      const head = `<tr class="asin-head${fb && fb.stocked ? " atfba" : ""}"><td><input type="checkbox" data-lgsel="${esc(g.asin)}" ${gsel ? "checked" : ""} aria-label="Select the FBM listings of ${esc(g.asin)}"></td>
        <td class="l mono"><a class="olink" href="https://www.amazon.com/dp/${encodeURIComponent(g.asin)}" target="_blank" rel="noopener">${esc(g.asin)}</a></td>
        <td class="l t" colspan="7"><div class="aname">${esc(g.fbm[0].title || g.fbm[0].sku)}</div><div class="meta">${fbaTxt}</div></td></tr>`;
      const fbmRows = g.fbm.map(l => {
        const pill = l.amazon_status === "Active" ? '<span class="pill ok">Active</span>' : `<span class="pill pos">${esc(l.amazon_status || "?")}</span>`;
        const shop = l.product_id ? `<a class="olink" href="${esc(shopUrl(l.product_id, l.variant_id))}" target="_blank" rel="noopener">${esc(l.shopify_title || l.shopify_sku || "Shopify product")}</a>` : esc(l.shopify_title || "");
        const res = S.lres.get(l.sku);
        const sent = res ? (res.status === "ACCEPTED" ? `<span class="pill ok">Sent ${num(res.quantity)}</span>` : `<span class="pill cx" title="${esc(res.error)}">Not sent</span><div class="err">${esc(res.error)}</div>`)
          : l.pushed_status === "ACCEPTED" ? `<span class="pill ok" title="${esc(l.pushed_by ? "by " + l.pushed_by : "")}">Sent ${num(l.pushed_qty)} · ${esc(fmtDT(l.pushed_at))}</span>`
          : l.pushed_status ? `<span class="pill cx">Last send failed</span><div class="err">${esc(l.pushed_error || "")}</div>` : "";
        const q = sendQty(l), over = q > (l.packs || 0), fbaWarn = q > 0 && fb && fb.stocked;
        const amz = Number(l.amazon_qty_now) || 0;
        return `<tr class="sku-row${S.lsel.has(l.sku) ? " sel" : ""}"><td><input type="checkbox" data-lsel="${esc(l.sku)}" ${S.lsel.has(l.sku) ? "checked" : ""} aria-label="Select ${esc(l.sku)}"></td>
          <td class="l"><span class="chan fbm">FBM</span></td>
          <td class="l t"><div class="meta mono">${esc(l.sku)}</div>${g.fbm.length > 1 || l.title !== g.fbm[0].title ? `<div class="meta">${esc(l.title)}</div>` : ""}</td>
          <td class="l">${pill}</td><td>${amz ? `<b class="${fb && fb.stocked ? "warnt" : ""}">${num(amz)}</b>` : '<span class="dim">0</span>'}</td>
          <td class="l t"><div>${shop}</div>${l.shopify_sku ? `<div class="meta mono">${esc(l.shopify_sku)}</div>` : ""}</td>
          <td><b>${num(l.shopify_qty)}</b>${l.stock_source === "location" && Number(l.shopify_total) !== Number(l.shopify_qty) ? `<div class="meta">${num(l.shopify_total)} all locations</div>` : ""}</td>
          <td>${l.map_units > 1 ? `${num(l.packs)} <span class="dim small">(${num(l.map_units)}/pack)</span>` : num(l.packs)}</td>
          <td class="send"><input class="inp qty${over || fbaWarn ? " over" : ""}" type="number" min="0" max="9999" step="1" inputmode="numeric" data-lqty="${esc(l.sku)}" value="${esc(q)}" aria-label="Quantity to put on Amazon for ${esc(l.sku)}" title="${fbaWarn ? "FBA has stock for this ASIN" : over ? "More than Shopify stock at " + esc(loc) + " covers" : ""}"><button class="mini primary" type="button" data-lsend="${esc(l.sku)}" ${S.sending ? "disabled" : ""}>Send</button>${fbaWarn ? '<div class="err">FBA has stock — usually 0</div>' : ""}${sent ? `<div>${sent}</div>` : ""}</td></tr>`;
      }).join("");
      const fbaRows = (fb ? fb.rows : []).filter(r => r.avail || r.inbound || S.lq).map(r => `<tr class="sku-row fba-row"><td></td>
          <td class="l"><span class="chan ${r.kind}">${r.kind === "awd" ? "AWD" : "FBA"}</span></td>
          <td class="l t"><div class="meta mono">${esc(r.sku)}</div></td>
          <td class="l"><span class="dim">Amazon fulfils</span></td>
          <td><b>${num(r.avail)}</b>${r.inbound ? `<div class="meta">+${num(r.inbound)} ${r.kind === "awd" ? "inbound / to FBA" : "inbound"}</div>` : ""}</td>
          <td class="l" colspan="4">${r.t30 ? `<span class="meta">${num(r.t30)} shipped in 30 days</span>` : ""}</td></tr>`).join("");
      return head + fbmRows + fbaRows;
    }).join("");
    const allSel = shownRows.length && shownRows.every(l => S.lsel.has(l.sku));
    tb.innerHTML = `<thead><tr><th><input type="checkbox" data-lselall ${allSel ? "checked" : ""} aria-label="Select all shown"></th>${th("asin", "ASIN", "l")}${th("title", "Listing", "l")}${th("amazon_status", "Amazon status", "l")}${th("amazon_qty_now", "On Amazon")}${th("shopify_title", "Shopify product", "l")}${th("shopify_qty", esc(loc.split(/\s+/).filter(w => /^[a-z]+$/i.test(w)).sort((a, b) => b.length - a.length)[0] || "Location") + " stock")}${th("packs", "Covers")}<th class="l">Put on Amazon (FBM)</th></tr></thead>
      <tbody>${body || `<tr><td class="l dim" colspan="9">${all.length ? "No listings match." : "No FBM listings with Shopify stock. Map FBM listings to Shopify products on Amazon mapping."}</td></tr>`}</tbody>`;
    $("fbl-count").innerHTML = groups.length > S.lshown ? `Showing ${S.lshown} of ${groups.length.toLocaleString()} ASINs <button class="mini" type="button" id="fbl-more">Show more</button>` : groups.length ? `${groups.length.toLocaleString()} ASIN${groups.length > 1 ? "s" : ""} · ${list.length.toLocaleString()} FBM listing${list.length > 1 ? "s" : ""}` : "";
    $("fbl-csv").hidden = !S.downloads || !list.length;
    // bulk bar
    const sel = list.filter(l => S.lsel.has(l.sku)), bar = $("fbl-bulk");
    bar.hidden = !sel.length && !S.lnote;
    const units = sel.reduce((a, l) => a + sendQty(l), 0), overN = sel.filter(l => sendQty(l) > (l.packs || 0)).length;
    const fbaN = sel.filter(l => sendQty(l) > 0 && (fbaOf(l.asin) || {}).stocked).length;
    bar.innerHTML = (S.lnote ? `<span>${S.lnote}</span>` : "") + (sel.length ? `<span><b>${sel.length}</b> listing${sel.length > 1 ? "s" : ""} selected · ${units.toLocaleString()} units to put on Amazon${overN ? ` · <span class="warnt">${overN} above what ${esc(loc)} stock covers</span>` : ""}${fbaN ? ` · <span class="warnt">${fbaN} on ASINs stocked at FBA</span>` : ""}</span>
      <span class="dbtns">${S.lconfirm ? `<button class="mini primary" type="button" data-lbulk="go" ${S.sending ? "disabled" : ""}>Yes, send ${sel.length} to Amazon</button><button class="mini" type="button" data-lbulk="no">Cancel</button>`
        : `<button class="mini primary" type="button" data-lbulk="ask" ${S.sending ? "disabled" : ""}>Send to Amazon</button><button class="mini" type="button" data-lbulk="fill">Suggested (0 if at FBA)</button><button class="mini" type="button" data-lbulk="zero">Set to 0</button><button class="mini" type="button" data-lbulk="clear">Clear</button>`}</span>` : "");
  }
  // send quantities to Amazon (the amazon function works through them, about 3 a second, picking up where it stopped)
  async function sendListings(skus) {
    if (S.sending) return;
    const items = skus.map(k => (S.lst || []).find(l => l.sku === k)).filter(Boolean).map(l => ({ sku: l.sku, quantity: sendQty(l) }));
    if (!items.length) return;
    S.sending = true; S.lconfirm = false; S.lnote = `Sending ${items.length} to Amazon…`; renderListings();
    let todo = items, ok = 0, bad = 0;
    try {
      while (todo.length) {
        const r = await window.JT.amazon({ action: "fbm_qty", items: todo });
        if (!r || r.ok === false) throw new Error((r && r.error) || "Amazon didn't answer");
        for (const x of r.results || []) { S.lres.set(x.sku, x); if (x.status === "ACCEPTED") { ok++; S.lsel.delete(x.sku); } else bad++; }
        if (!r.next || !r.next.length || r.next.length === todo.length) break;
        todo = r.next; S.lnote = `Sent ${ok + bad} of ${items.length}…`; renderListings();
      }
      S.lnote = `${ok ? `<b>${ok}</b> quantit${ok > 1 ? "ies" : "y"} sent to Amazon (live in a few minutes).` : ""}${bad ? ` <span class="warnt">${bad} not sent — see the rows.</span>` : ""}`;
    } catch (e) {
      S.lnote = `<span class="warnt">Couldn't send: ${esc(window.JT.message ? window.JT.message(e) : (e.message || e))}</span>`;
    }
    S.sending = false;
    if (window.JTWeb) window.JTWeb.clearCache();
    try { const r = await window.JT.fbm.listings(true); S.lst = r.map(x => Object.fromEntries(LCOLS.map((c, i) => [c, x[i]]))); for (const x of S.lst) if (x.pushed_status) S.lres.delete(x.sku); } catch (_) {}
    renderListings();
  }
  async function refreshStock() {
    try { await window.JT.fbm.refreshStock(); S.lnote = "Getting stock from Shopify — this takes a minute or two; the list reloads when it's in."; }
    catch (e) { S.lnote = `<span class="warnt">Couldn't start the stock sync: ${esc(window.JT.message ? window.JT.message(e) : (e.message || e))}</span>`; renderListings(); return; }
    renderListings();
    const before = (S.lst && S.lst[0] && S.lst[0].stock_at) || "";
    for (let i = 0; i < 16; i++) {
      await new Promise(f => setTimeout(f, 15000));
      if (window.JTWeb) window.JTWeb.clearCache();
      try {
        const r = await window.JT.fbm.listings(true), rows = r.map(x => Object.fromEntries(LCOLS.map((c, j) => [c, x[j]])));
        if (rows.length && (rows[0].stock_at || "") !== before) { S.lst = rows; S.lnote = "Stock updated from Shopify."; renderListings(); return; }
      } catch (_) {}
    }
    S.lnote = "Shopify stock is taking longer than usual — press Refresh in a few minutes."; renderListings();
  }
  async function downloadListings() {
    const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [["asin", "seller_sku", "amazon_title", "amazon_status", "amazon_qty", "amazon_price", "shopify_product", "shopify_sku", "shopify_stock_fbm_location", "shopify_stock_all_locations", "units_per_listing", "amazon_units_covered", "on_amazon_now", "fba_available", "fba_inbound", "awd", "fba_shipped_30d"].join(",")];
    for (const l of listingsShown()) { const f = fbaOf(l.asin) || {}; lines.push([l.asin, l.sku, l.title, l.amazon_status, l.amazon_qty, l.amazon_price, l.shopify_title, l.shopify_sku, l.shopify_qty, l.shopify_total, l.map_units, l.packs, l.amazon_qty_now, f.avail || 0, f.inbound || 0, f.awd || 0, f.t30 || 0].map(q).join(",")); }
    try { await S.downloads.save({ filename: `just-tennis-fbm-listings-in-stock_${new Date().toISOString().slice(0, 10)}.csv`, data: lines.join("\n") }); } catch (_) {}
  }

  // Amazon listings on this page that aren't mapped to a Shopify product (any order still undecided)
  function unmappedSkus() {
    const m = new Map();
    for (const o of orders()) for (const l of o.lines) if (l.state === "unmapped" || (l.state === "waiting" && l.units == null)) m.set(l.sku, l);
    return [...m.values()];
  }
  function openMapping(lines, label) {
    if (!window.amzMapOnly) return;
    window.amzMapOnly({ skus: lines.map(l => l.sku), titles: Object.fromEntries(lines.map(l => [l.sku, l.product_name || l.sku])),
      asins: Object.fromEntries(lines.map(l => [l.sku, l.asin || ""])), label, back: "fbm", backLabel: "FBM stock" });
  }

  async function saveLocName() {
    const v = ($("fbm-locname") || {}).value || "";
    try { await window.JT.fbm.setLocationName(v.trim()); S.editLoc = false; S.msg = null; }
    catch (e) { S.msg = ["bad", "Couldn't save the name: " + esc(e.message || e)]; }
    if (window.JTWeb) window.JTWeb.clearCache();
    load(true);
  }
  async function decide(orderIds, decision) {
    if (S.busy) return;
    const all = orders().filter(o => orderIds.includes(o.id));
    const ds = [];
    for (const o of all) for (const l of o.lines) {
      if (decision === "decrement" && (l.state === "ready" || l.state === "failed")) ds.push({ order_id: o.id, sku: l.sku, decision });
      else if (decision === "skip" && (l.state === "ready" || l.state === "failed" || l.state === "unmapped" || l.state === "waiting")) ds.push({ order_id: o.id, sku: l.sku, decision });
      else if (decision === "undo" && (l.state === "skipped" || l.state === "failed")) ds.push({ order_id: o.id, sku: l.sku, decision });
    }
    if (!ds.length) return;
    S.busy = true; render();
    try {
      const r = await window.JT.fbm.decide(ds);
      const ref = (r && r.refused) || [];
      if (ref.length) S.msg = ["warn", `${ref.length} item${ref.length > 1 ? "s" : ""} not changed: ${esc(ref[0].why)}${ref.length > 1 ? " (and others)" : ""}.`];
      else if (r && r.queued) S.msg = ["info", `${r.queued} item${r.queued > 1 ? "s are" : " is"} on the way to Shopify — this takes about a minute.`];
      else S.msg = null;
      for (const id of orderIds) S.sel.delete(id);
    } catch (e) {
      S.msg = ["bad", "Couldn't save: " + esc(window.JT.message ? window.JT.message(e) : (e.message || e))];
    }
    S.busy = false;
    if (window.JTWeb) window.JTWeb.clearCache();
    await load(true);
  }

  const tab = $("tab-fbm");
  tab.addEventListener("click", (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.act) decide([b.dataset.o], b.dataset.act);
    else if (b.dataset.bulk === "clear") { S.sel.clear(); render(); }
    else if (b.dataset.bulk) decide([...S.sel], b.dataset.bulk);
    else if (b.dataset.map) { const l = (S.lines || []).find(x => x.sku === b.dataset.map); openMapping([l || { sku: b.dataset.map }], "FBM listing to map"); }
    else if (b.hasAttribute("data-mapall")) { const u = unmappedSkus(); openMapping(u, `${u.length} FBM listing${u.length > 1 ? "s" : ""} not mapped to Shopify`); }
    else if (b.id === "fbm-more") { S.shown += 150; render(); }
    else if (b.id === "fbl-more") { S.lshown += 150; renderListings(); }
    else if (b.id === "fbl-csv") downloadListings();
    else if (b.id === "fbl-stock") refreshStock();
    else if (b.dataset.lsend) { S.lconfirm = false; sendListings([b.dataset.lsend]); }
    else if (b.dataset.lbulk === "ask") { S.lconfirm = true; renderListings(); }
    else if (b.dataset.lbulk === "no") { S.lconfirm = false; renderListings(); }
    else if (b.dataset.lbulk === "go") sendListings([...S.lsel]);
    else if (b.dataset.lbulk === "clear") { S.lsel.clear(); S.lconfirm = false; S.lnote = ""; renderListings(); }
    else if (b.dataset.lbulk === "fill") { for (const k of S.lsel) S.lqty.delete(k); renderListings(); }
    else if (b.dataset.lbulk === "zero") { for (const k of S.lsel) S.lqty.set(k, 0); renderListings(); }
    else if (b.dataset.loc === "edit") { S.editLoc = true; render(); const i = $("fbm-locname"); if (i) i.focus(); }
    else if (b.dataset.loc === "cancel") { S.editLoc = false; render(); }
    else if (b.dataset.loc === "save") saveLocName();
  });
  tab.addEventListener("click", (ev) => {
    const h = ev.target.closest("th[data-lsort]"); if (!h) return;
    const k = h.dataset.lsort;
    S.lsort = S.lsort[0] === k ? [k, -S.lsort[1]] : [k, /qty|price|packs/.test(k) ? -1 : 1];
    renderListings();
  });
  $("fbl-seg").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-v]"); if (!b) return;
    S.lv = b.dataset.v; S.lshown = 150;
    $("fbl-seg").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    renderListings();
  });
  $("fbl-fba").addEventListener("change", (ev) => { S.lfba = ev.target.value; S.lshown = 150; renderListings(); });
  $("fbl-q").addEventListener("input", (ev) => { S.lq = ev.target.value.trim().toLowerCase(); S.lshown = 150; renderListings(); });
  tab.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t.dataset.lsel != null) { t.checked ? S.lsel.add(t.dataset.lsel) : S.lsel.delete(t.dataset.lsel); S.lconfirm = false; renderListings(); return; }
    if (t.hasAttribute("data-lselall")) { groupsShown(listingsShown()).slice(0, S.lshown).flatMap(g => g.fbm).forEach(l => t.checked ? S.lsel.add(l.sku) : S.lsel.delete(l.sku)); S.lconfirm = false; renderListings(); return; }
    if (t.dataset.lgsel != null) { listingsShown().filter(l => l.asin === t.dataset.lgsel).forEach(l => t.checked ? S.lsel.add(l.sku) : S.lsel.delete(l.sku)); S.lconfirm = false; renderListings(); return; }
    if (t.dataset.lqty != null) {
      const v = Math.max(0, Math.min(9999, Math.floor(Number(t.value) || 0)));
      S.lqty.set(t.dataset.lqty, v); S.lconfirm = false; renderListings(); return;
    }
    if (t.dataset.sel != null) { t.checked ? S.sel.add(t.dataset.sel) : S.sel.delete(t.dataset.sel); render(); }
    else if (t.hasAttribute("data-selall")) {
      const ids = orders().filter(inView).filter(matches).filter(o => o.ready.length).map(o => o.id);
      if (t.checked) ids.forEach(i => S.sel.add(i)); else ids.forEach(i => S.sel.delete(i));
      render();
    }
  });
  $("fbm-seg").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-v]"); if (!b) return;
    S.view = b.dataset.v; S.msg = null; S.shown = 150; S.sel.clear();
    $("fbm-seg").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    render();
  });
  $("fbm-loc").addEventListener("change", async (ev) => {
    if (ev.target.id !== "fbm-locsel" || !ev.target.value) return;
    try { await window.JT.fbm.setLocation(ev.target.value); S.msg = ["info", `FBM orders now come out of ${esc(locName(ev.target.value))}.`]; }
    catch (e) { S.msg = ["bad", "Couldn't change the location: " + esc(window.JT.message ? window.JT.message(e) : (e.message || e))]; }
    if (window.JTWeb) window.JTWeb.clearCache();
    load(true);
  });
  $("fbm-loc").addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.id === "fbm-locname") { ev.preventDefault(); saveLocName(); } });
  $("fbm-q").addEventListener("input", (ev) => { S.q = ev.target.value.trim().toLowerCase(); S.shown = 150; render(); });
  $("fbm-refresh").addEventListener("click", () => { if (window.JTWeb) window.JTWeb.clearCache(); load(true); });
  $("fbm-start").addEventListener("change", async (ev) => {
    const v = ev.target.value; if (!v || v === S.cfg.start) return;
    try { await window.JT.fbm.setStart(v); } catch (e) { S.msg = ["bad", "Couldn't change the date: " + esc(e.message || e)]; render(); return; }
    if (window.JTWeb) window.JTWeb.clearCache();
    load(true);
  });

  const use = window.claude && window.claude.use ? window.claude.use.bind(window.claude) : null;
  if (use) use("downloads").then(d => { S.downloads = d; renderListings(); }).catch(() => {});
  // from the Alerts tab: open the listings panel with a filter (e.g. "0 on Amazon") or a search
  window.fbmFocus = ({ filter, q } = {}) => {
    if (filter) { S.lv = filter; $("fbl-seg").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.v === filter))); }
    if (q != null) { S.lq = String(q).toLowerCase(); $("fbl-q").value = q; }
    S.lshown = 150; renderListings();
    setTimeout(() => { const t = $("fbl-table"); if (t) t.closest(".panel").scrollIntoView({ behavior: "smooth", block: "start" }); }, 300);
  };
  window.fbmShow = () => { if (!S.lines && !S.loading) load(false); else { render(); if (!S.loading) load(true); } };
  if (!$("tab-fbm").hidden) window.fbmShow();
})();
