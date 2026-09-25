(() => {
  // ===================== Shopify cost mapping =====================
  // Finds order lines Shopify sold without a recorded cost (ShopifyQL net_sales_without_cost_recorded),
  // lets you type a unit cost per line, and saves an order cost override (db costoverrides/<order id>),
  // the same record the Shopify tab's per-order cost editor uses. Data comes from Supabase (jt schema).
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m = (n) => usd.format(Math.round((n || 0) * 100) / 100 || 0), m0 = (n) => usd0.format(n || 0);
  const money = (s) => { let t = String(s ?? "").trim(); if (!t) return null; t = t.replace(/[$,\s]/g, ""); if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return NaN; return Number(t); };
  const TZ = "America/Los_Angeles";
  const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const addDays = (ds, n) => { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const num = (g) => g ? String(g).split("/").pop() : "";
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";

  const C = {
    mcp: null, db: null, preset: "ytd", start: null, end: null, reqId: 0,
    loading: false, err: null,
    orders: null,          // [{sid, name, nocost, cogs, net, items:[{vid,pid,title,variant,sku,qty,net,nocost}]}]
    lines: new Map(),      // sid -> {loading} | {error} | {created, items:[{id,title,variant,sku,qty,price,unit,pid,vid,custom}]}
    overrides: new Map(),  // sid -> {cost, lines, src}
    drafts: {},            // "sid|lineId" -> text
    page: 0, show: "open", sort: "amt", q: "", saving: false,
    has: "all", perPage: 40,   // filter on current Shopify cost; orders per page (0 = all)
    vcost: new Map(), vcostReady: false,   // variant id -> current Shopify unit cost (null = none)
    bulk: null,                // progress text while filling or saving in bulk
    mode: "orders",            // "orders" | "products"
    pcost: {},                 // products view: product key -> typed unit cost
  };

  function note(kind, html) { const n = $("cm-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; }
  const JT = window.JT, n0 = (x) => Number(x) || 0;
  const errMsg = (e) => JT.message(e);

  function setRange(r) {
    const t = today(); C.preset = r;
    if (r === "ytd") { C.start = t.slice(0, 4) + "-01-01"; C.end = t; }
    else if (r === "ly") { const y = +t.slice(0, 4) - 1; C.start = y + "-01-01"; C.end = y + "-12-31"; }
    else { C.start = addDays(t, -(Number(r) - 1)); C.end = t; }
    $("cm-start").value = C.start; $("cm-end").value = C.end;
    document.querySelectorAll("#cm-rangeseg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.r === r)));
  }

  // ---------- load ----------
  async function load(refresh) {
    if (!C.mcp) return;
    const id = ++C.reqId; C.loading = true; C.err = null; C.page = 0; C.vcostReady = false; render();
    try {
      const where = `from jt.shopify_sales s where s.day between ${JT.day(C.start)} and ${JT.day(C.end)} and s.order_id <> 0`;
      const [or, lr] = await Promise.all([
        JT.rowsSplit(["s.order_id::text", "s.order_name", "sum(s.net)", "sum(s.cogs)", "sum(s.net_no_cost)"], `${where} group by s.order_id, s.order_name having sum(s.net_no_cost) > 0.005`, "s.order_id", 1, refresh),
        JT.rowsSplit(["s.order_id::text", "s.variant_id::text", "s.product_id::text", "s.product_title", "s.variant_title", "s.sku", "sum(s.units)", "sum(s.net)", "sum(s.net_no_cost)", "max(v.unit_cost)", "bool_or(v.variant_id is not null)", "max(s.vendor)", "max(s.product_type)"],
          `from jt.shopify_sales s left join jt.variants v on v.variant_id = s.variant_id where s.day between ${JT.day(C.start)} and ${JT.day(C.end)} and s.order_id <> 0 group by s.order_id, s.variant_id, s.product_id, s.product_title, s.variant_title, s.sku having sum(s.net_no_cost) > 0.005`,
          "s.order_id", 2, refresh),
      ]);
      if (id !== C.reqId) return;
      const by = new Map();
      for (const [sid, name, net, cogs, nc] of or) by.set(sid, { sid, name: name || "", nocost: n0(nc), cogs: n0(cogs), net: n0(net), items: [] });
      for (const [sid, vid, pid, title, variant, sku, units, net, nc, uc, known, vendor, ptype] of lr) {
        const o = by.get(sid); if (!o) continue;
        const v = vid === "0" ? "" : vid;
        o.items.push({ vid: v, pid: pid === "0" ? "" : pid, title: title || "", variant: variant || "", sku: sku || "", qty: n0(units), net: n0(net), nocost: n0(nc), vendor: vendor || "", ptype: ptype || "" });
        if (v && known) C.vcost.set(v, uc == null ? null : Number(uc));
        else if (v) C.vcost.set(v, null);
      }
      C.orders = [...by.values()];
      C.vcostReady = true;
    } catch (e) { if (id === C.reqId) { C.err = e; C.orders = null; } }
    if (id !== C.reqId) return;
    C.loading = false; render();
  }

  // Line items (names of custom items, line ids, current Shopify cost) for the orders on screen.
  async function loadLines(sids, onProgress) {
    const need = sids.filter(s => !C.lines.has(s) || C.lines.get(s).error);
    if (!need.length) return;
    need.forEach(s => C.lines.set(s, { loading: true }));
    const chunks = []; for (let i = 0; i < need.length; i += 150) chunks.push(need.slice(i, i + 150));
    let done = 0;
    await pool(chunks, 3, async (ch) => {
      try {
        const r = await JT.rowsSplit(["l.order_id::text", "o.created_at", "l.line_id::text", "l.title", "l.variant_title", "l.sku", "l.current_quantity", "l.unit_price", "v.unit_cost", "l.product_id::text", "l.variant_id::text"],
          `from jt.shopify_order_lines l join jt.shopify_orders o on o.order_id = l.order_id left join jt.variants v on v.variant_id = l.variant_id where l.order_id in (${ch.map(JT.int).join(",")})`, "l.order_id", 1);
        const by = new Map();
        for (const x of r.sort((a, b) => a[2].localeCompare(b[2]))) {
          const e = by.get(x[0]) || { created: x[1], items: [] }; by.set(x[0], e);
          e.items.push({ id: x[2], title: x[3] || "Item", variant: x[4] && x[4] !== "Default Title" ? x[4] : "", sku: x[5] || "", qty: n0(x[6]), price: n0(x[7]),
            unit: x[8] == null ? null : Number(x[8]), pid: x[9] && x[9] !== "0" ? x[9] : "", vid: x[10] || "", custom: !x[10] });
        }
        ch.forEach(s => C.lines.set(s, by.get(s) || { error: { code: "tool_error", message: "items haven't synced yet" } }));
      } catch (e) { ch.forEach(s => C.lines.set(s, { error: e })); }
      done += ch.length; if (onProgress) onProgress(done, need.length); else if (need.length > 20) soon();
    });
    soon();
  }
  // Run fn over items with at most n in flight.
  async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
  }
  // Coalesce renders (big lists re-render slowly).
  let soonT = null;
  function soon() { if (soonT) return; soonT = setTimeout(() => { soonT = null; render(); }, 120); }

  // "ready": every item missing a cost is a product that has a cost in Shopify now; "none": at least one doesn't (or is a custom item).
  function costClass(o) {
    if (!o.items.length) return "none";
    for (const i of o.items) { if (!i.vid) return "none"; const c = C.vcost.get(i.vid); if (c == null) return C.vcost.has(i.vid) ? "none" : "unknown"; }
    return "ready";
  }
  const estCost = (o) => o.items.reduce((a, i) => a + (C.vcost.get(i.vid) || 0) * i.qty, 0);

  // Rows to fill for one order: Shopify line items that match a sold-without-cost row.
  function needRows(o) {
    const L = C.lines.get(o.sid); if (!L || !L.items) return null;
    const vids = new Set(o.items.filter(i => i.vid).map(i => i.vid)), hasCustom = o.items.some(i => !i.vid);
    return L.items.filter(it => it.qty > 0 && (it.vid ? vids.has(it.vid) : hasCustom));
  }
  const dkey = (sid, id) => sid + "|" + id;
  function draftOf(sid, it) {
    const v = C.drafts[dkey(sid, it.id)];
    if (v != null) return v;
    const ov = C.overrides.get(sid);
    return ov && ov.lines && ov.lines[it.id] ? String(ov.lines[it.id].unit) : "";
  }
  function orderCalc(o) {
    const rows = needRows(o); if (!rows) return null;
    let add = 0, filled = 0, bad = 0;
    for (const it of rows) { const v = money(draftOf(o.sid, it)); if (v == null) continue; if (Number.isNaN(v) || v < 0) { bad++; continue; } filled++; add += it.qty * v; }
    return { rows, add, filled, bad, complete: rows.length > 0 && filled === rows.length && !bad, total: Math.round((o.cogs + add) * 100) / 100 };
  }
  const isDirty = (o) => { const rows = needRows(o); return !!rows && rows.some(it => C.drafts[dkey(o.sid, it.id)] != null); };

  // ---------- filter ----------
  function view() {
    let list = C.orders || [];
    if (C.show === "open") list = list.filter(o => !C.overrides.has(o.sid));
    else if (C.show === "saved") list = list.filter(o => C.overrides.has(o.sid));
    if (C.has !== "all" && C.vcostReady) list = list.filter(o => (costClass(o) === "ready") === (C.has === "ready"));
    const q = C.q.trim().toLowerCase().replace(/^#/, "");
    if (q) list = list.filter(o => o.name.toLowerCase().includes(q) || o.items.some(i => (i.title + " " + i.variant + " " + i.sku).toLowerCase().includes(q))
      || ((C.lines.get(o.sid) || {}).items || []).some(i => (i.title + " " + i.sku).toLowerCase().includes(q)));
    const onum = (o) => Number(o.name.replace(/\D/g, "")) || 0;
    if (C.sort === "amt") list = [...list].sort((a, b) => b.nocost - a.nocost);
    else list = [...list].sort((a, b) => C.sort === "new" ? onum(b) - onum(a) : onum(a) - onum(b));
    return list;
  }

  // ---------- render ----------
  function renderKpis() {
    const all = C.orders || [];
    const open = all.filter(o => !C.overrides.has(o.sid)), saved = all.filter(o => C.overrides.has(o.sid));
    const sum = (l) => l.reduce((a, o) => a + o.nocost, 0);
    const added = saved.reduce((a, o) => a + (C.overrides.get(o.sid).cost - o.cogs), 0);
    const k = [
      { l: "Sales without cost", v: m0(sum(all)), s: `${all.length.toLocaleString()} orders in this range` },
      { l: "Still needs cost", v: m0(sum(open)), s: `${open.length.toLocaleString()} orders`, c: open.length ? "warnk" : "" },
      { l: "Costs entered", v: m0(sum(saved)), s: `${saved.length.toLocaleString()} orders of sales covered` },
      { l: "Cost added", v: m0(added), s: "Product cost you've entered for these orders" },
    ];
    $("cm-kpis").innerHTML = k.map(x => `<div class="kpi ${x.c || ""}"><span class="eyebrow">${x.l}</span><span class="v">${x.v}</span><span class="s">${x.s}</span></div>`).join("");
  }

  function render() {
    if ($("tab-costmap").hidden) return;
    const st = $("cm-status");
    if (!C.mcp) st.textContent = window.claude && window.claude.use ? "Connecting to the database…" : "Open this dashboard in claude.ai to load data.";
    else if (C.loading) st.textContent = "Finding orders sold without a cost…";
    else if (C.err) st.textContent = errMsg(C.err);
    else if (C.orders) st.textContent = `${C.orders.length.toLocaleString()} orders with items sold without a cost · ${C.start} to ${C.end}` + (C.db ? "" : " · saving isn't available in this view");
    renderKpis();

    document.querySelectorAll("#cm-mode button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === C.mode)));
    $("cm-hint").textContent = C.mode === "products"
      ? "Every product in Shopify. A new cost is saved to the product in Shopify, and also fills this date range's orders that sold it without a cost."
      : "Type the cost of one unit. Enter moves to the next box. When you enter a cost, other empty rows with the same item fill in too.";
    $("cm-pfilters").hidden = C.mode !== "products"; $("cm-ofilters").hidden = C.mode === "products";
    $("cm-useshop").hidden = C.mode === "products";
    $("cm-catsync").hidden = C.mode !== "products";
    if (C.mode === "products") { $("cm-bulk").hidden = true; renderProducts(); return; }
    const t = $("cm-table");
    const ae = document.activeElement, activeId = ae && ae.id && ae.id.startsWith("cmi-") && t.contains(ae) ? ae.id : null;
    const sel = activeId ? [ae.selectionStart, ae.selectionEnd] : null;
    const list = view();
    const per = C.perPage || Math.max(1, list.length);
    const pages = Math.max(1, Math.ceil(list.length / per));
    if (C.page >= pages) C.page = pages - 1;
    const pageOrders = list.slice(C.page * per, (C.page + 1) * per);
    renderBulk(list);
    if (C.mcp && pageOrders.some(o => !C.lines.has(o.sid))) loadLines(pageOrders.map(o => o.sid));

    const head = `<thead><tr><th class="l">Order</th><th class="l">Item</th><th>Qty</th><th>Sold for</th><th>Shopify cost</th><th>Your cost</th><th>Line cost</th><th class="l"></th></tr></thead>`;
    let body = "";
    if (!C.orders) body = `<tr><td class="l dim" colspan="8">${C.loading ? '<span class="skel">Loading…</span>' : C.err ? esc(errMsg(C.err)) : ""}</td></tr>`;
    else if (!pageOrders.length) body = `<tr><td class="l dim" colspan="8">${C.show === "open" && !C.q ? "Every order in this range has a cost. Nice." : "No orders match."}</td></tr>`;
    for (const o of pageOrders) {
      const L = C.lines.get(o.sid), saved = C.overrides.get(o.sid);
      const created = L && L.created ? new Date(L.created).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: TZ }) : "";
      const ordCell = (span) => `<td class="l ocell" rowspan="${span}"><a class="olink" href="${ADMIN}/orders/${encodeURIComponent(o.sid)}" target="_blank" rel="noopener">${esc(o.name)}</a><div class="small dim">${created}</div><div class="small dim">${m(o.nocost)} without cost</div></td>`;
      if (!L || L.loading) { body += `<tr class="ogrp">${ordCell(1)}<td class="l dim" colspan="7"><span class="skel">Loading items…</span></td></tr>`; continue; }
      if (L.error) { body += `<tr class="ogrp">${ordCell(1)}<td class="l" colspan="7"><span class="neg small">${esc(errMsg(L.error))}</span> <button class="mini" data-cm="retry" data-sid="${o.sid}">Try again</button></td></tr>`; continue; }
      const rows = needRows(o);
      if (!rows.length) { body += `<tr class="ogrp">${ordCell(1)}<td class="l dim" colspan="7">Items were returned or edited. Nothing to enter.</td></tr>`; continue; }
      const c = orderCalc(o), dirty = isDirty(o);
      const action = saved && !dirty
        ? `<span class="pill ok">Saved · ${m(saved.cost)}</span> <button class="mini" data-cm="undo" data-sid="${o.sid}" ${C.saving ? "disabled" : ""}>Undo</button>`
        : `<button class="mini ${c.complete ? "primary" : ""}" data-cm="save" data-sid="${o.sid}" ${!c.complete || C.saving || !C.db ? "disabled" : ""}>Save</button><div class="small dim">${c.complete ? "Order cost " + m(c.total) : c.bad ? '<span class="neg">Check amounts</span>' : `${rows.length - c.filled} to fill`}</div>`;
      rows.forEach((it, i) => {
        const d = draftOf(o.sid, it), v = money(d), bad = Number.isNaN(v) || v < 0;
        const name = it.pid ? `<a class="olink" href="${ADMIN}/products/${encodeURIComponent(it.pid)}${it.vid ? "/variants/" + encodeURIComponent(it.vid) : ""}" target="_blank" rel="noopener">${esc(it.title)}</a>` : `${esc(it.title)} <span class="pill pos">custom</span>`;
        body += `<tr class="${i === 0 ? "ogrp" : ""}">${i === 0 ? ordCell(rows.length) : ""}
          <td class="l"><div class="iname">${name}</div>${it.variant || it.sku ? `<div class="small dim">${esc([it.variant, it.sku].filter(Boolean).join(" · "))}</div>` : ""}</td>
          <td>${it.qty}</td><td>${m(it.price)}</td>
          <td>${it.unit == null ? '<span class="dim">—</span>' : `<button class="linkbtn" data-cm="use" data-k="${esc(dkey(o.sid, it.id))}" title="Use this cost">${m(it.unit)}</button>`}</td>
          <td><input id="cmi-${o.sid}-${it.id}" class="cmin ${bad ? "bad" : v != null ? "ok" : ""}" data-k="${esc(dkey(o.sid, it.id))}" data-same="${esc(it.vid || "t:" + it.title.toLowerCase())}" type="text" inputmode="decimal" placeholder="${it.unit != null ? it.unit.toFixed(2) : "0.00"}" aria-label="Cost each for ${esc(it.title)} on ${esc(o.name)}" value="${esc(d)}"></td>
          <td id="cml-${o.sid}-${it.id}">${v != null && !bad ? m(v * it.qty) : '<span class="dim">—</span>'}</td>
          ${i === 0 ? `<td class="l acell" rowspan="${rows.length}" id="cma-${o.sid}">${action}</td>` : ""}</tr>`;
      });
    }
    t.innerHTML = head + `<tbody>${body}</tbody>`;
    $("cm-prev").hidden = C.page === 0;
    $("cm-next").hidden = C.page >= pages - 1;
    $("cm-count").textContent = list.length ? `Orders ${C.page * per + 1}–${Math.min(list.length, (C.page + 1) * per)} of ${list.length.toLocaleString()}` : "";
    const ready = readyOrders();
    const sa = $("cm-saveall"); sa.disabled = !ready.length || C.saving || !C.db; sa.textContent = C.saving ? "Saving…" : ready.length ? `Save ${ready.length} filled order${ready.length > 1 ? "s" : ""}` : "Save filled orders";
    if (activeId && $(activeId)) { const i = $(activeId); i.focus(); try { i.setSelectionRange(sel[0], sel[1]); } catch (_) {} }
  }
  function renderBulk(list) {
    const el = $("cm-bulk");
    if (C.has !== "ready" || C.show === "saved") { el.hidden = true; return; }
    el.hidden = false;
    if (!C.vcostReady) { el.innerHTML = '<span class="skel">Checking current Shopify costs…</span>'; return; }
    const open = list.filter(o => !C.overrides.has(o.sid));
    const sales = open.reduce((a, o) => a + o.nocost, 0), cost = open.reduce((a, o) => a + estCost(o), 0);
    el.innerHTML = C.bulk ? `<span><b>${esc(C.bulk)}</b></span>`
      : open.length ? `<span>${open.length.toLocaleString()} order${open.length > 1 ? "s" : ""} where every item without a cost has a cost in Shopify now · ${m0(sales)} of sales · about <b>${m0(cost)}</b> of cost at today's Shopify costs</span>
        <span class="dbtns right"><button class="btn" data-bulk="fill" ${C.saving ? "disabled" : ""}>Fill all ${open.length.toLocaleString()} (review first)</button><button class="btn primary" data-bulk="save" ${C.saving || !C.db ? "disabled" : ""}>${C.armed ? `Click again to save ${open.length.toLocaleString()} orders` : `Fill &amp; save all ${open.length.toLocaleString()}`}</button></span>`
      : "<span>All orders with a current Shopify cost are saved.</span>";
  }
  async function bulkFill(save) {
    const list = view().filter(o => !C.overrides.has(o.sid) && costClass(o) === "ready");
    if (!list.length) return;
    // Two clicks to save in bulk (page dialogs can be blocked inside claude.ai).
    if (save && C.armed !== list.length) { C.armed = list.length; render(); setTimeout(() => { if (C.armed) { C.armed = null; render(); } }, 6000); return; }
    C.armed = null;
    C.saving = true; C.bulk = "Loading order items…"; render();
    await loadLines(list.map(o => o.sid), (d, n) => { C.bulk = `Loading order items… ${d} of ${n}`; const el = $("cm-bulk"); if (el) el.innerHTML = `<span><b>${esc(C.bulk)}</b></span>`; });
    let filled = 0;
    for (const o of list) {
      const rows = needRows(o) || [];
      for (const it of rows) { const k = dkey(o.sid, it.id); if (it.unit != null && (C.drafts[k] == null || C.drafts[k] === "")) { C.drafts[k] = it.unit.toFixed(2); filled++; } }
    }
    C.saving = false; C.bulk = null;
    if (save) { await saveMany(list.filter(o => (orderCalc(o) || {}).complete)); return; }
    note(filled ? "info" : "warn", filled ? `Filled ${filled} item${filled > 1 ? "s" : ""} from Shopify. Review them, then press Save filled orders.` : "Nothing to fill.");
    if (!C.perPage) render(); else { C.perPage = 0; $("cm-per").value = "0"; C.page = 0; render(); }
  }
  const readyOrders = () => (C.orders || []).filter(o => isDirty(o) && (orderCalc(o) || {}).complete);

  // Refresh only the pieces that change while typing, so focus stays put.
  function refreshOrder(sid) {
    const o = (C.orders || []).find(x => x.sid === sid); if (!o) return;
    const c = orderCalc(o); if (!c) return;
    for (const it of c.rows) {
      const v = money(draftOf(sid, it)), bad = Number.isNaN(v) || v < 0;
      const cell = $(`cml-${sid}-${it.id}`); if (cell) cell.innerHTML = v != null && !bad ? m(v * it.qty) : '<span class="dim">—</span>';
      const inp = $(`cmi-${sid}-${it.id}`); if (inp) { inp.classList.toggle("bad", bad); inp.classList.toggle("ok", v != null && !bad); if (document.activeElement !== inp) inp.value = draftOf(sid, it); }
    }
    const a = $("cma-" + sid);
    if (a) a.innerHTML = `<button class="mini ${c.complete ? "primary" : ""}" data-cm="save" data-sid="${sid}" ${!c.complete || C.saving || !C.db ? "disabled" : ""}>Save</button><div class="small dim">${c.complete ? "Order cost " + m(c.total) : c.bad ? '<span class="neg">Check amounts</span>' : `${c.rows.length - c.filled} to fill`}</div>`;
    const ready = readyOrders(), sa = $("cm-saveall");
    sa.disabled = !ready.length || C.saving || !C.db; sa.textContent = ready.length ? `Save ${ready.length} filled order${ready.length > 1 ? "s" : ""}` : "Save filled orders";
  }

  // Same item elsewhere on screen: copy the cost into empty boxes.
  function fillSame(src) {
    const v = src.value.trim(); if (!v || Number.isNaN(money(v))) return;
    const touched = new Set();
    document.querySelectorAll("#cm-table input.cmin").forEach(i => {
      if (i === src || i.dataset.same !== src.dataset.same) return;
      const k = i.dataset.k; if (C.drafts[k] != null && C.drafts[k] !== "") return;
      const sid = k.split("|")[0]; if (C.overrides.has(sid) && C.drafts[k] == null) return;
      C.drafts[k] = v; touched.add(sid);
    });
    touched.forEach(refreshOrder);
  }

  // ---------- products view: the whole Shopify catalog (jt.variants, synced nightly) ----------
  // A cost typed here is sent to Shopify (jt.cost_updates -> sync job cost-updates, seconds) and also fills the
  // orders in this date range that sold the product without a cost.
  async function loadCatalog(refresh) {
    if (!C.mcp || C.catLoading) return;
    C.catLoading = true; C.catErr = null; if (C.mode === "products") render();
    try {
      const [r, last] = await Promise.all([JT.rowsSplit(["v.variant_id::text", "v.product_id::text", "v.product_title", "v.variant_title", "v.sku", "v.vendor", "v.product_type",
        "v.status", "v.inventory_qty", "v.tracked", "v.price", "v.unit_cost", "u.new_cost", "u.status", "u.error", "v.removed_at is not null"],
        `from jt.variants v left join lateral (select c.new_cost, c.status, c.error from jt.cost_updates c
           where c.variant_id = v.variant_id and c.status <> 'replaced' order by c.id desc limit 1) u on true
         where true`, "v.variant_id", 4, refresh),   // "where true": the part filter must land here, not inside the join
        JT.rows(["finished_at"], "from jt.sync_runs where job = 'catalog' and ok order by started_at desc limit 1", refresh)]);
      C.catSynced = last[0] ? last[0][0] : null;
      C.cat = r.map(x => ({ vid: x[0], pid: x[1] && x[1] !== "0" ? x[1] : "", title: x[2] || "", variant: x[3] || "", sku: x[4] || "", vendor: x[5] || "", ptype: x[6] || "",
        status: x[15] ? "REMOVED" : (x[7] || ""), onhand: x[8] == null ? null : Number(x[8]), tracked: x[9], price: x[10] == null ? null : Number(x[10]), cost: x[11] == null ? null : Number(x[11]),
        upd: x[13] === "pending" || x[13] === "failed" ? { cost: Number(x[12]), status: x[13], error: x[14] || "" } : null }));
      for (const v of C.cat) C.vcost.set(v.vid, v.cost);
    } catch (e) { C.catErr = e; }
    C.catLoading = false; render();
  }
  // Uncosted sales in open orders, by variant (from the orders list for this date range).
  function uncostedByVariant() {
    const by = new Map();
    for (const o of C.orders || []) {
      if (C.overrides.has(o.sid)) continue;
      for (const i of o.items) {
        if (!i.vid) continue;
        const u = by.get(i.vid) || { open: new Set(), qty: 0, nocost: 0 };
        u.open.add(o.sid); u.qty += i.qty; u.nocost += i.nocost; by.set(i.vid, u);
      }
    }
    return by;
  }
  function productList() {
    const unc = uncostedByVariant(), st = $("cm-pstatus").value, cf = $("cm-pcost").value, sort = $("cm-psort").value;
    let list = (C.cat || []).map(v => ({ ...v, key: v.vid, unc: unc.get(v.vid) || null }));
    if (st !== "all") list = list.filter(v => v.status === st || (v.unc && st === "ACTIVE" && v.status !== "REMOVED"));   // sold-without-cost items show under Active
    if (cf === "missing") list = list.filter(v => v.cost == null);
    else if (cf === "has") list = list.filter(v => v.cost != null);
    else if (cf === "sold") list = list.filter(v => v.unc);
    else if (cf === "above") list = list.filter(v => v.cost != null && v.price != null && v.cost > v.price);
    const q = C.q.trim().toLowerCase();
    if (q) list = list.filter(v => [v.title, v.variant, v.sku, v.vendor, v.ptype].join(" ").toLowerCase().includes(q));
    const name = (v) => (v.title + " " + v.variant).toLowerCase();
    const cmp = {
      need: (a, b) => (b.unc ? b.unc.nocost : 0) - (a.unc ? a.unc.nocost : 0) || (a.cost == null ? 0 : 1) - (b.cost == null ? 0 : 1) || name(a).localeCompare(name(b)),
      title: (a, b) => name(a).localeCompare(name(b)),
      vendor: (a, b) => a.vendor.localeCompare(b.vendor) || name(a).localeCompare(name(b)),
      onhand: (a, b) => (b.onhand ?? -1e9) - (a.onhand ?? -1e9),
      cost: (a, b) => (b.cost ?? -1) - (a.cost ?? -1),
    }[sort] || ((a, b) => 0);
    return list.sort(cmp);
  }
  const pcostOf = (key) => { const v = money(C.pcost[key]); return v == null || Number.isNaN(v) || v < 0 ? null : Math.round(v * 100) / 100; };
  const typedProducts = () => (C.cat || []).filter(v => pcostOf(v.vid) != null);

  function renderProducts() {
    const t = $("cm-table");
    const ae = document.activeElement, activeId = ae && ae.id && ae.id.startsWith("cmp-") && t.contains(ae) ? ae.id : null;
    const sel = activeId ? [ae.selectionStart, ae.selectionEnd] : null;
    if (!C.cat && !C.catLoading && !C.catErr) loadCatalog(false);
    const list = C.cat ? productList() : [];
    const per = C.perPage || Math.max(1, list.length);
    const pages = Math.max(1, Math.ceil(list.length / per));
    if (C.page >= pages) C.page = pages - 1;
    const page = list.slice(C.page * per, (C.page + 1) * per);
    const cols = 11;
    const head = `<thead><tr><th class="l">Product</th><th class="l wrapc">Vendor</th><th class="l wrapc">Category</th><th class="l">Status</th><th>On hand</th><th>Price</th><th>Shopify cost</th><th>Margin</th><th>Sold - no cost</th><th>New cost</th><th class="l"></th></tr></thead>`;
    let body = "";
    if (!C.cat) body = `<tr><td class="l dim" colspan="${cols}">${C.catErr ? esc(errMsg(C.catErr)) : '<span class="skel">Loading the Shopify catalog…</span>'}</td></tr>`;
    else if (!page.length) body = `<tr><td class="l dim" colspan="${cols}">No products match.</td></tr>`;
    for (const v of page) {
      const typed = C.pcost[v.key] ?? "", n = money(typed), bad = Number.isNaN(n) || n < 0;
      const eff = v.upd && v.upd.status === "pending" ? v.upd.cost : v.cost;
      const mg = eff != null && v.price ? (v.price - eff) / v.price : null;
      const name = v.pid ? `<a class="olink" href="${ADMIN}/products/${encodeURIComponent(v.pid)}/variants/${encodeURIComponent(v.vid)}" target="_blank" rel="noopener">${esc(v.title || "(untitled)")}</a>` : esc(v.title);
      const u = v.unc;
      const stat = v.upd && v.upd.status === "pending" ? `<span class="pill warn">Updating Shopify → ${m(v.upd.cost)}</span>`
        : v.upd && v.upd.status === "failed" ? `<span class="pill miss" title="${esc(v.upd.error)}">Shopify update failed</span> <span class="small neg">${esc(v.upd.error.slice(0, 80))}</span>`
        : u ? `<span class="small dim">${u.open.size.toLocaleString()} order${u.open.size > 1 ? "s" : ""} need${u.open.size > 1 ? "" : "s"} a cost</span>` : "";
      body += `<tr>
        <td class="l"><div class="iname">${name}</div>${v.variant || v.sku ? `<div class="small dim">${esc([v.variant, v.sku].filter(Boolean).join(" · "))}</div>` : ""}</td>
        <td class="l wrapc">${esc(v.vendor) || '<span class="dim">—</span>'}</td><td class="l wrapc">${esc(v.ptype) || '<span class="dim">—</span>'}</td>
        <td class="l small">${v.status === "REMOVED" ? '<span class="pill miss" title="Deleted in Shopify; kept here for sales history">Removed</span>' : esc(v.status.charAt(0) + v.status.slice(1).toLowerCase())}</td>
        <td>${v.onhand == null ? '<span class="dim">—</span>' : v.tracked === false ? '<span class="dim" title="Inventory not tracked in Shopify">not tracked</span>' : v.onhand.toLocaleString()}</td>
        <td>${v.price == null ? '<span class="dim">—</span>' : m(v.price)}</td>
        <td>${v.cost == null ? '<span class="pill miss">No cost</span>' : m(v.cost)}</td>
        <td class="${mg != null && mg < 0 ? "neg" : "dim"}">${mg == null ? "—" : (mg * 100).toFixed(1) + "%"}</td>
        <td>${u ? `${m(u.nocost)}<div class="small dim">${Math.round(u.qty * 100) / 100} sold</div>` : '<span class="dim">—</span>'}</td>
        <td><input id="cmp-${esc(v.key)}" class="cmin cmp ${bad ? "bad" : n != null ? "ok" : ""}" data-p="${esc(v.key)}" type="text" inputmode="decimal" placeholder="${v.cost != null ? v.cost.toFixed(2) : "0.00"}" aria-label="New cost each for ${esc(v.title)}" value="${esc(typed)}"></td>
        <td class="l statc" id="cmps-${esc(v.key)}">${stat}</td></tr>`;
    }
    t.innerHTML = head + `<tbody>${body}</tbody>`;
    $("cm-prev").hidden = C.page === 0;
    $("cm-next").hidden = C.page >= pages - 1;
    $("cm-count").textContent = list.length ? `Products ${C.page * per + 1}–${Math.min(list.length, (C.page + 1) * per)} of ${list.length.toLocaleString()}` + (C.cat ? ` · ${C.cat.filter(v => v.status !== "REMOVED").length.toLocaleString()} variants in Shopify` : "")
      + (C.catSynced ? ` · synced from Shopify ${new Date(C.catSynced).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "") : "";
    saveProductsButton();
    if (activeId && $(activeId)) { const i = $(activeId); i.focus(); try { i.setSelectionRange(sel[0], sel[1]); } catch (_) {} }
  }
  function saveProductsButton() {
    const r = typedProducts(), sa = $("cm-saveall");
    sa.disabled = !r.length || C.saving || !C.db;
    sa.textContent = C.saving ? (C.bulk || "Saving…") : r.length ? `Save ${r.length} cost${r.length > 1 ? "s" : ""} to Shopify` : "Save costs to Shopify";
  }
  // Send typed costs to Shopify, then use them for this range's orders that sold the product without a cost.
  async function saveProducts() {
    const prods = typedProducts(); if (!prods.length || !C.db) return;
    const cost = new Map(prods.map(v => [v.vid, pcostOf(v.vid)]));
    C.saving = true; C.bulk = "Sending costs to Shopify…"; saveProductsButton();
    const changed = prods.filter(v => v.cost == null || Math.abs(v.cost - cost.get(v.vid)) >= 0.005);
    let queued = 0, qErr = null;
    if (changed.length) {
      try { queued = await JT.queueCostUpdates(changed.map(v => ({ variant_id: Number(v.vid), cost: cost.get(v.vid) }))); }
      catch (e) { qErr = e; }
      if (!qErr) for (const v of changed) v.upd = { cost: cost.get(v.vid), status: "pending", error: "" };
    }
    // Orders in this range that sold these products without a cost.
    const unc = uncostedByVariant();
    const sids = [...new Set(prods.flatMap(v => unc.has(v.vid) ? [...unc.get(v.vid).open] : []))];
    let complete = [], partial = 0;
    if (sids.length) {
      C.bulk = "Loading order items…"; saveProductsButton();
      await loadLines(sids, (d, n) => { C.bulk = `Loading order items… ${d} of ${n}`; saveProductsButton(); });
      const touched = [];
      for (const sid of sids) {
        const o = (C.orders || []).find(x => x.sid === sid); if (!o) continue;
        for (const it of needRows(o) || []) {
          const k = dkey(sid, it.id);
          if (it.vid && cost.has(it.vid) && (C.drafts[k] == null || C.drafts[k] === "")) C.drafts[k] = cost.get(it.vid).toFixed(2);
        }
        touched.push(o);
      }
      complete = touched.filter(o => (orderCalc(o) || {}).complete); partial = touched.length - complete.length;
    }
    C.saving = false; C.bulk = null;
    if (complete.length) await saveMany(complete);
    const failedOrders = complete.filter(o => !C.overrides.has(o.sid)).length;
    if (!qErr) for (const v of prods) delete C.pcost[v.vid];
    const parts = [];
    if (qErr) parts.push(`Couldn't send costs to Shopify: ${esc(errMsg(qErr))}`);
    else if (queued) parts.push(`Sent ${queued} cost${queued > 1 ? "s" : ""} to Shopify; the update runs now and shows as done here within a minute.`);
    else if (changed.length === 0) parts.push("Those costs already match Shopify.");
    if (complete.length && !failedOrders) parts.push(`Saved ${complete.length.toLocaleString()} past order${complete.length > 1 ? "s" : ""} that sold without a cost.`);
    if (partial) parts.push(`${partial.toLocaleString()} order${partial > 1 ? "s have" : " has"} other items without a cost: finish ${partial > 1 ? "them" : "it"} in the Orders view.`);
    note(qErr ? "bad" : partial ? "warn" : "info", parts.join(" "));
    render();
    if (queued) { setTimeout(() => loadCatalog(true), 20000); setTimeout(() => loadCatalog(true), 60000); }
  }

  // "Sync from Shopify": start the catalog job, wait for it to finish (about 30 seconds), reload the list.
  async function syncCatalog() {
    const btn = $("cm-catsync"); if (btn.disabled) return;
    btn.disabled = true; btn.textContent = "Syncing from Shopify…";
    const t0 = new Date(Date.now() - 5000).toISOString();
    try {
      const started = await JT.requestCatalogSync();
      note("info", started ? "Pulling the latest products from Shopify… (about 30 seconds)" : "A sync from Shopify is already running; waiting for it…");
      let run = null;
      for (let i = 0; i < 40 && !run; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const r = await JT.rows(["ok", "detail", "finished_at"], `from jt.sync_runs where job = 'catalog' and started_at > ${JT.q(t0)}::timestamptz and finished_at is not null order by started_at desc limit 1`, true);
        if (r.length) run = r[0];
      }
      if (!run) note("warn", "The sync from Shopify is taking longer than usual. The list will update when it finishes; press Refresh in a minute.");
      else if (!run[0]) note("bad", "The sync from Shopify failed: " + esc(String(run[1] || "").slice(-200)));
      else {
        const d = {}; String(run[1] || "").replace(/'(\w+)': (\w+)/g, (_, k, v) => { d[k] = v; });
        note("info", `Synced ${Number(d.variants || 0).toLocaleString()} products from Shopify` +
          (+d.removed ? ` · ${d.removed} no longer in Shopify (hidden; see Status: Removed from Shopify)` : "") +
          (+d.restored ? ` · ${d.restored} back in Shopify` : "") + (+d.changes ? ` · ${d.changes} cost change${+d.changes > 1 ? "s" : ""}` : "") + ".");
        C.cat = null; await loadCatalog(true);
      }
    } catch (e) { note("bad", "Couldn't start a sync from Shopify: " + esc(errMsg(e))); }
    btn.disabled = false; btn.textContent = "Sync from Shopify";
  }

  // ---------- save ----------
  function bodyFor(o) {
    const c = orderCalc(o); if (!c || !c.complete) return null;
    const lines = {};
    for (const it of c.rows) lines[it.id] = { unit: Math.round(money(draftOf(o.sid, it)) * 100) / 100, title: it.title.slice(0, 80), qty: it.qty };
    return { order_id: o.sid, order_name: o.name, cost: c.total, shopify_cogs: Math.round(o.cogs * 100) / 100, lines, src: "costmap", rows: c.rows };
  }
  async function saveMany(list) {
    if (!C.db || !list.length) return;
    const bodies = list.map(o => ({ o, b: bodyFor(o) })).filter(x => x.b);
    C.saving = true; if (bodies.length > 1) C.bulk = `Saving 0 of ${bodies.length}…`; render();
    let ok = 0, fail = 0, lastErr = null;
    for (let i = 0; i < bodies.length; i += 50) {
      const part = bodies.slice(i, i + 50);
      try {
        await JT.saveCostOverrides(part.map(({ b }) => { const { rows, ...rest } = b; return rest; }));
        for (const { o, b } of part) {
          JT.overrides.set(o.sid, { cost: b.cost, lines: b.lines, src: b.src, shopifyCogs: b.shopify_cogs });
          for (const it of b.rows) delete C.drafts[dkey(o.sid, it.id)];
        }
        ok += part.length;
      } catch (e) { fail += part.length; lastErr = e; }
      if (bodies.length > 1) { C.bulk = `Saving ${ok + fail} of ${bodies.length}…`; const el = $("cm-bulk"); if (el && !el.hidden) el.innerHTML = `<span><b>${esc(C.bulk)}</b></span>`; else $("cm-status").textContent = C.bulk; }
    }
    C.saving = false; C.bulk = null;
    note(fail ? "bad" : bodies.length > 1 ? "info" : "", fail ? `Saved ${ok} order${ok === 1 ? "" : "s"}. ${fail} couldn't be saved: ${esc(errMsg(lastErr))}` : bodies.length > 1 ? `Saved ${ok} orders.` : "");
    render();
  }
  async function undo(sid) {
    if (!C.db) return;
    C.saving = true; render();
    try { await JT.deleteCostOverride(sid); JT.overrides.set(sid, null); }
    catch (e) { note("bad", "Couldn't remove that cost: " + esc(errMsg(e))); }
    C.saving = false; render();
  }

  // ---------- events ----------
  document.querySelectorAll("#cm-rangeseg button").forEach(b => b.addEventListener("click", () => { setRange(b.dataset.r); load(false); }));
  ["cm-start", "cm-end"].forEach(id => $(id).addEventListener("change", () => {
    const s = $("cm-start").value, e = $("cm-end").value; if (!s || !e || s > e) return;
    C.start = s; C.end = e; C.preset = null;
    document.querySelectorAll("#cm-rangeseg button").forEach(b => b.setAttribute("aria-pressed", "false"));
    load(false);
  }));
  $("cm-refresh").addEventListener("click", () => { C.lines.clear(); C.vcost.clear(); C.vcostReady = false; load(true); if (C.cat || C.mode === "products") { C.cat = null; loadCatalog(true); } });
  $("cm-show").addEventListener("change", (e) => { C.show = e.target.value; C.page = 0; render(); });
  $("cm-has").addEventListener("change", (e) => { C.has = e.target.value; C.page = 0; render(); });
  $("cm-per").addEventListener("change", (e) => { C.perPage = Number(e.target.value); C.page = 0; render(); });
  $("cm-bulk").addEventListener("click", (e) => { const b = e.target.closest("[data-bulk]"); if (b) bulkFill(b.dataset.bulk === "save"); });
  $("cm-sort").addEventListener("change", (e) => { C.sort = e.target.value; C.page = 0; render(); });
  $("cm-q").addEventListener("input", (e) => { C.q = e.target.value; C.page = 0; render(); });
  $("cm-prev").addEventListener("click", () => { C.page = Math.max(0, C.page - 1); render(); $("cm-table").closest(".tbl-wrap").scrollTop = 0; });
  $("cm-next").addEventListener("click", () => { C.page++; render(); $("cm-table").closest(".tbl-wrap").scrollTop = 0; });
  $("cm-saveall").addEventListener("click", () => C.mode === "products" ? saveProducts() : saveMany(readyOrders()));
  document.querySelectorAll("#cm-mode button").forEach(b => b.addEventListener("click", () => { C.mode = b.dataset.mode; C.page = 0; render(); }));
  ["cm-pstatus", "cm-pcost", "cm-psort"].forEach(id => $(id).addEventListener("change", () => { C.page = 0; render(); }));
  $("cm-catsync").addEventListener("click", syncCatalog);
  $("cm-useshop").addEventListener("click", () => {
    const touched = new Set();
    document.querySelectorAll("#cm-table input.cmin").forEach(i => {
      const k = i.dataset.k, sid = k.split("|")[0];
      if (i.value.trim() || !i.placeholder || C.overrides.has(sid)) return;
      const o = (C.orders || []).find(x => x.sid === sid), it = o && (needRows(o) || []).find(x => dkey(sid, x.id) === k);
      if (it && it.unit != null) { C.drafts[k] = it.unit.toFixed(2); touched.add(sid); }
    });
    if (!touched.size) note("info", "No empty boxes on this page have a current Shopify cost to copy.");
    else note("", "");
    touched.forEach(refreshOrder);
  });

  const tbl = $("cm-table");
  tbl.addEventListener("input", (ev) => {
    const i = ev.target;
    if (i.classList && i.classList.contains("cmp")) {
      C.pcost[i.dataset.p] = i.value;
      const v = money(i.value), bad = Number.isNaN(v) || v < 0;
      i.classList.toggle("bad", bad); i.classList.toggle("ok", v != null && !bad);
      saveProductsButton(); return;
    }
    if (!i.classList || !i.classList.contains("cmin")) return;
    C.drafts[i.dataset.k] = i.value; refreshOrder(i.dataset.k.split("|")[0]);
  });
  tbl.addEventListener("change", (ev) => { const i = ev.target; if (i.classList && i.classList.contains("cmin") && !i.classList.contains("cmp")) fillSame(i); });
  tbl.addEventListener("keydown", (ev) => {
    const i = ev.target; if (!i.classList || !i.classList.contains("cmin") || ev.key !== "Enter") return;
    ev.preventDefault();
    if (!i.classList.contains("cmp")) fillSame(i);
    const all = [...tbl.querySelectorAll("input.cmin")], k = all.indexOf(i);
    const nx = all.slice(k + 1).find(x => !x.value.trim()) || all[k + 1];
    if (nx) { nx.focus(); nx.select(); } else i.blur();
  });
  tbl.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-cm]"); if (!b) return;
    const a = b.dataset.cm, sid = b.dataset.sid;
    if (a === "save") { const o = (C.orders || []).find(x => x.sid === sid); if (o) saveMany([o]); }
    else if (a === "undo") undo(sid);
    else if (a === "retry") { C.lines.delete(sid); render(); }
    else if (a === "use") { const k = b.dataset.k, o = (C.orders || []).find(x => x.sid === k.split("|")[0]), it = o && (needRows(o) || []).find(x => dkey(o.sid, x.id) === k); if (it) { C.drafts[k] = it.unit.toFixed(2); refreshOrder(o.sid); const inp = $(`cmi-${o.sid}-${it.id}`); if (inp) { inp.value = C.drafts[k]; fillSame(inp); } } }
  });

  // ---------- boot ----------
  window.cmRender = () => { if (!C.orders && !C.loading && C.mcp) load(false); render(); };
  setRange("ytd");
  const use = window.claude && window.claude.use ? window.claude.use.bind(window.claude) : null;
  if (!use) return;
  JT.overrides.subscribe((mm) => { C.overrides = mm; if (!C.saving) soon(); });
  JT.getMcp().then(mcp => { C.mcp = mcp; C.db = mcp; if (!$("tab-costmap").hidden) load(false); else render(); }).catch(() => {});
})();
