// FBM → Shopify tab: Amazon FBM orders ship from the Shopify store's stock, so each shipped FBM order is taken out
// of Shopify's inventory once someone confirms it here (jt.fbm_decide; the sync job then adjusts Shopify).
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const S = { msg: null, lines: null, lst: null, lstErr: null, lv: "all", lq: "", lsort: ["shopify_qty", -1], lshown: 150, downloads: null, cfg: {}, view: "confirm", q: "", sel: new Set(), busy: false, err: null, loading: false, timer: null, shown: 150 };
  const COLS = ["order_id", "sku", "asin", "product_name", "quantity", "order_status", "purchased", "shipped", "cancelled", "map_kind",
    "variant_id", "map_units", "units", "shopify_title", "shopify_sku", "shopify_qty", "product_id", "tracked",
    "decision", "status", "error", "decided_by", "decided_at", "applied_at", "shopify_before", "decided_units", "location_id"];
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
    "product_id", "shopify_title", "shopify_sku", "shopify_qty", "packs"];

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
      const o = m.get(l.order_id) || { id: l.order_id, purchased: l.purchased, status: l.order_status, shipped: l.shipped, cancelled: l.cancelled, lines: [] };
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
      const lp = window.JT.fbm.listings(refresh).then(r => { S.lst = r.map(x => Object.fromEntries(LCOLS.map((c, i) => [c, x[i]]))); S.lstErr = null; }, e => { S.lstErr = e; });
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
        <td class="l">${esc(fmtDT(o.purchased))}</td><td class="l">${pill}</td><td class="l items">${items}</td><td class="act">${acts}</td></tr>`;
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

  // ---------- FBM listings Shopify has stock for ----------
  const num = (v) => v == null || v === "" ? "" : Number(v).toLocaleString();
  const money = (v) => v == null || v === "" ? "" : "$" + Number(v).toFixed(2);
  function listingsShown() {
    const q = S.lq, [k, dir] = S.lsort;
    return (S.lst || []).filter(l => (S.lv === "all" || l.amazon_status === S.lv) &&
        (!q || [l.asin, l.sku, l.title, l.shopify_title, l.shopify_sku].some(x => String(x || "").toLowerCase().includes(q))))
      .sort((a, b) => {
        const x = a[k], y = b[k];
        const c = typeof x === "number" || typeof y === "number" ? (Number(x) || 0) - (Number(y) || 0) : String(x || "").localeCompare(String(y || ""));
        return c * dir || String(a.sku).localeCompare(String(b.sku));
      });
  }
  function renderListings() {
    const sub = $("fbl-sub"), tb = $("fbl-table");
    if (S.lstErr && !S.lst) { sub.textContent = "Couldn't load FBM listings: " + (window.JT.message ? window.JT.message(S.lstErr) : (S.lstErr.message || S.lstErr)); tb.innerHTML = ""; return; }
    if (!S.lst) { sub.textContent = "Loading FBM listings…"; tb.innerHTML = ""; return; }
    const all = S.lst, act = all.filter(l => l.amazon_status === "Active").length, f = all[0];
    sub.innerHTML = `${all.length.toLocaleString()} merchant-fulfilled listings (${new Set(all.map(l => l.asin)).size.toLocaleString()} ASINs) mapped to a Shopify product with stock · ${act.toLocaleString()} active, ${(all.length - act).toLocaleString()} inactive on Amazon${f ? ` · from ${esc(f.report_file || "the All Listings report")}${f.report_at ? `, ${/Amazon API/.test(f.report_file || "") ? "fetched" : "uploaded"} ${esc(fmtDT(f.report_at))}` : ""} (refreshed from Amazon daily)` : ""} · Shopify stock is the total across locations`;
    const list = listingsShown();
    const th = (k, label, cls) => `<th class="${cls || ""} sort" data-lsort="${k}" ${S.lsort[0] === k ? `aria-sort="${S.lsort[1] > 0 ? "ascending" : "descending"}"` : ""}>${label}</th>`;
    const body = list.slice(0, S.lshown).map(l => {
      const pill = l.amazon_status === "Active" ? '<span class="pill ok">Active</span>' : `<span class="pill pos">${esc(l.amazon_status || "?")}</span>`;
      const shop = l.product_id ? `<a class="olink" href="${esc(shopUrl(l.product_id, l.variant_id))}" target="_blank" rel="noopener">${esc(l.shopify_title || l.shopify_sku || "Shopify product")}</a>` : esc(l.shopify_title || "");
      return `<tr><td class="l mono"><a class="olink" href="https://www.amazon.com/dp/${encodeURIComponent(l.asin)}" target="_blank" rel="noopener">${esc(l.asin)}</a></td>
        <td class="l t"><div>${esc(l.title || l.sku)}</div><div class="meta mono">${esc(l.sku)}</div></td>
        <td class="l">${pill}</td><td>${num(l.amazon_qty) || '<span class="dim">—</span>'}</td><td>${money(l.amazon_price)}</td>
        <td class="l t"><div>${shop}</div>${l.shopify_sku ? `<div class="meta mono">${esc(l.shopify_sku)}</div>` : ""}</td>
        <td>${num(l.shopify_qty)}</td><td>${l.map_units > 1 ? `${num(l.packs)} <span class="dim small">(${num(l.map_units)}/pack)</span>` : num(l.packs)}</td></tr>`;
    }).join("");
    tb.innerHTML = `<thead><tr>${th("asin", "ASIN", "l")}${th("title", "Amazon listing", "l")}${th("amazon_status", "Amazon status", "l")}${th("amazon_qty", "Amazon qty")}${th("amazon_price", "Price")}${th("shopify_title", "Shopify product", "l")}${th("shopify_qty", "Shopify stock")}${th("packs", "Amazon units it covers")}</tr></thead>
      <tbody>${body || `<tr><td class="l dim" colspan="8">${all.length ? "No listings match." : "No FBM listings with Shopify stock. Upload the All Listings report on Amazon mapping, and map FBM listings to Shopify products."}</td></tr>`}</tbody>`;
    $("fbl-count").innerHTML = list.length > S.lshown ? `Showing ${S.lshown} of ${list.length.toLocaleString()} listings <button class="mini" type="button" id="fbl-more">Show more</button>` : list.length ? `${list.length.toLocaleString()} listing${list.length > 1 ? "s" : ""}` : "";
    $("fbl-csv").hidden = !S.downloads || !list.length;
  }
  async function downloadListings() {
    const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [["asin", "seller_sku", "amazon_title", "amazon_status", "amazon_qty", "amazon_price", "shopify_product", "shopify_sku", "shopify_stock", "units_per_listing", "amazon_units_covered"].join(",")];
    for (const l of listingsShown()) lines.push([l.asin, l.sku, l.title, l.amazon_status, l.amazon_qty, l.amazon_price, l.shopify_title, l.shopify_sku, l.shopify_qty, l.map_units, l.packs].map(q).join(","));
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
  $("fbl-q").addEventListener("input", (ev) => { S.lq = ev.target.value.trim().toLowerCase(); S.lshown = 150; renderListings(); });
  tab.addEventListener("change", (ev) => {
    const t = ev.target;
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
  window.fbmShow = () => { if (!S.lines && !S.loading) load(false); else { render(); if (!S.loading) load(true); } };
  if (!$("tab-fbm").hidden) window.fbmShow();
})();
