// FBM → Shopify tab: Amazon FBM orders ship from the Shopify store's stock, so each shipped FBM order is taken out
// of Shopify's inventory once someone confirms it here (jt.fbm_decide; the sync job then adjusts Shopify).
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const S = { msg: null, lines: null, cfg: {}, view: "confirm", q: "", sel: new Set(), busy: false, err: null, loading: false, timer: null, shown: 150 };
  const COLS = ["order_id", "sku", "asin", "product_name", "quantity", "order_status", "purchased", "shipped", "cancelled", "map_kind",
    "variant_id", "map_units", "units", "shopify_title", "shopify_sku", "shopify_qty", "product_id", "tracked",
    "decision", "status", "error", "decided_by", "decided_at", "applied_at", "shopify_before", "decided_units"];
  const fmtDT = (s) => { if (!s) return ""; const [d, t] = s.split(" "); return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) + (t ? " " + t : ""); };
  const shopUrl = (pid, vid) => pid ? `https://admin.shopify.com/store/justtennis-822/products/${encodeURIComponent(pid)}${vid ? "/variants/" + encodeURIComponent(vid) : ""}` : "";
  const note = (kind, html) => { const n = $("fbm-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; };

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
      const [rows, cfg] = await Promise.all([window.JT.fbm.lines(refresh), window.JT.fbm.settings(refresh)]);
      S.lines = rows.map(r => Object.fromEntries(COLS.map((c, i) => [c, r[i]])));
      S.cfg = cfg || {}; S.err = null;
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
    st.textContent = `${all.length.toLocaleString()} FBM orders since ${fmtDT(S.cfg.start || "")}${S.cfg.location_name ? ` · Shopify location: ${S.cfg.location_name}` : ""}${pend ? ` · ${pend} change${pend > 1 ? "s" : ""} on the way to Shopify…` : ""}${S.loading ? " · refreshing…" : ""}`;
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
        const state = { done: `<span class="pill ok">Taken out ${esc(fmtDT(l.applied_at))}</span>`, pending: `<span class="pill web">Sending to Shopify…</span>`,
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
  });
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
  $("fbm-q").addEventListener("input", (ev) => { S.q = ev.target.value.trim().toLowerCase(); S.shown = 150; render(); });
  $("fbm-refresh").addEventListener("click", () => { if (window.JTWeb) window.JTWeb.clearCache(); load(true); });
  $("fbm-start").addEventListener("change", async (ev) => {
    const v = ev.target.value; if (!v || v === S.cfg.start) return;
    try { await window.JT.fbm.setStart(v); } catch (e) { S.msg = ["bad", "Couldn't change the date: " + esc(e.message || e)]; render(); return; }
    if (window.JTWeb) window.JTWeb.clearCache();
    load(true);
  });

  window.fbmShow = () => { if (!S.lines && !S.loading) load(false); else { render(); if (!S.loading) load(true); } };
  if (!$("tab-fbm").hidden) window.fbmShow();
})();
