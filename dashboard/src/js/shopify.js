(() => {
  const TZ = "America/Los_Angeles";
  const SERVER = "Shopify";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const usd = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"});
  const usd0 = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0});
  const m = (n) => usd.format(n || 0);
  const m0 = (n) => usd0.format(n || 0);
  const pct = (n) => isFinite(n) ? (n*100).toFixed(1) + "%" : "—";
  const laDay = window.JTDate.laDay, addDays = window.JTDate.addDays;
  const offFmt = new Intl.DateTimeFormat("en-US",{timeZone:TZ,timeZoneName:"shortOffset"});
  const tzOff = (ds) => {
    const p = offFmt.formatToParts(new Date(ds + "T12:00:00Z")).find(x => x.type === "timeZoneName");
    const mt = /GMT([+-])(\d+)(?::(\d+))?/.exec(p ? p.value : "");
    if (!mt) return "-08:00";
    return mt[1] + String(mt[2]).padStart(2,"0") + ":" + (mt[3] || "00");
  };
  const shortDay = (ds) => { const d = new Date(ds + "T12:00:00Z"); return d.toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"}); };
  const wkDay = (ds) => new Date(ds + "T12:00:00Z").toLocaleDateString("en-US",{weekday:"short",timeZone:"UTC"});
  const orderKey = (s) => String(s ?? "").trim().replace(/^#/, "").trim();
  const amt = (x) => Number(x && x.shopMoney ? x.shopMoney.amount : 0) || 0;

  const state = {
    start: null, end: null,
    daily: null, dailyErr: null,
    orders: null, ordersErr: null, ordersTruncated: false,
    ship: new Map(),   // order name key -> {cost, labels, services:Set}  (CSV uploads)
    shipSid: new Map(), // Shopify order id -> same (ShipStation API sync)
    lastSync: null,
    overrides: new Map(), // Shopify order id -> {cost, note} entered on this dashboard
    editing: null, drafts: {}, saving: false, lines: new Map(), // sid -> {loading, error, items}
    costs: null, costsErr: null, // order name -> {net, cogs, gp, nocost} from Shopify Analytics
    shipDocs: 0, shipLabels: 0,
    dbReady: false, db: null, mcp: null, downloads: null,
    loading: false, loadedAt: null, fromCache: false,
    parsed: null,
  };

  function setRange(days) {
    const today = laDay(Date.now());
    let start;
    if (days === "mtd") start = today.slice(0,8) + "01";
    else if (days === "ytd") start = today.slice(0,5) + "01-01";
    else start = addDays(today, -(Number(days) - 1));
    state.start = start; state.end = today;
    $("d-start").value = start; $("d-end").value = today;
    document.querySelectorAll("#rangeseg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.days === String(days))));
  }

  // ---------- MCP errors ----------
  const mcpMessage = (e) => window.JT.message(e);
  const isDenial = (e) => ["needs_reauth","server_not_connected","not_in_manifest","blocked_by_policy","approval_required","selection_required","not_granted","capability_disabled"].includes(e && e.code);

  // ---------- loads (Supabase, kept current by the hourly GitHub sync) ----------
  const JT = window.JT;
  const num = (x) => Number(x) || 0;
  // Date chunks of `days` so each reply stays small; run a few at once.
  async function byChunks(days, fn) {
    const chunks = [];
    for (let s = state.start; s <= state.end; s = addDays(s, days)) { const e = addDays(s, days - 1); chunks.push([s, e < state.end ? e : state.end]); }
    const out = []; let next = 0;
    const worker = async () => { while (next < chunks.length) { const [s, e] = chunks[next++]; out.push(...await fn(s, e)); } };
    await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));
    return out;
  }
  const spanDays = () => Math.round((new Date(state.end) - new Date(state.start)) / 864e5) + 1;

  async function loadDaily(refresh) {
    const r = await JT.rowsSplit(["day", "orders", "gross", "discounts", "returns", "net", "shipping", "taxes", "total", "cogs", "gross_profit", "net_no_cost"],
      `from jt.shopify_daily where day between ${JT.day(state.start)} and ${JT.day(state.end)}`, "day", 1, refresh);
    const byDay = new Map();
    for (const x of r) byDay.set(x[0], { day:x[0], orders:num(x[1]), gross:num(x[2]), discounts:num(x[3]), returns:num(x[4]), net:num(x[5]), shipping:num(x[6]), taxes:num(x[7]), total:num(x[8]), cogs:num(x[9]), gp:num(x[10]), nocost:num(x[11]) });
    const out = [];
    for (let d = state.start; d <= state.end; d = addDays(d, 1)) {
      out.push(byDay.get(d) || { day:d, orders:0, gross:0, discounts:0, returns:0, net:0, shipping:0, taxes:0, total:0, cogs:0, gp:0, nocost:0 });
    }
    return out;
  }

  async function loadOrderCosts(refresh) {
    const r = await JT.rowsSplit(["order_name", "sum(net)", "sum(cogs)", "sum(net_no_cost)"],
      `from jt.shopify_sales where day between ${JT.day(state.start)} and ${JT.day(state.end)} group by order_name`,
      "order_name", Math.max(1, Math.ceil(spanDays() / 90)), refresh);
    const map = new Map();
    for (const [name, net, cogs, nc] of r) map.set(String(name), { net: num(net), cogs: num(cogs), gp: num(net) - num(cogs), nocost: num(nc) });
    return map;
  }

  // Sales without a cost, by the day Shopify records them (a return lands on the return day) and order.
  async function loadNoCostRows(refresh) {
    const r = await JT.rowsSplit(["day", "order_id::text", "sum(net_no_cost)", "sum(cogs)"],
      `from jt.shopify_sales where day between ${JT.day(state.start)} and ${JT.day(state.end)} and order_id <> 0 group by day, order_id having abs(sum(net_no_cost)) >= 0.005`, "order_id", 1, refresh);
    const by = new Map();   // order id -> [{day, nc, cogs}]
    for (const [day, sid, nc, cogs] of r) { const l = by.get(sid) || []; l.push({ day, nc: num(nc), cogs: num(cogs) }); by.set(sid, l); }
    return by;
  }

  const ORDER_COLS = ["order_id::text", "name", "created_at", "order_day", "source_name", "channel", "financial_status", "fulfillment_status", "cancelled_at is not null", "subtotal", "discounts", "shipping", "tax", "total", "refunded", "item_qty"];
  const toOrder = (x) => ({ id: "gid://shopify/Order/" + x[0], sid: x[0], name: x[1], key: orderKey(x[1]), created: x[2], day: x[3], source: x[4], chan: x[5],
    fin: x[6], ful: x[7], cancelled: !!x[8], subtotal: num(x[9]), discounts: num(x[10]), shipping: num(x[11]), tax: num(x[12]), total: num(x[13]), refunded: num(x[14]), qty: num(x[15]) });
  async function loadOrders(refresh, onPage) {
    let n = 0;
    const all = await byChunks(60, async (s, e) => {
      const r = await JT.rowsSplit(ORDER_COLS, `from jt.shopify_orders where not test and order_day between ${JT.day(s)} and ${JT.day(e)}`, "order_id", 1, refresh);
      n += r.length; onPage && onPage(n);
      return r.map(toOrder);
    });
    state.ordersTruncated = false;
    return all.sort((a, b) => a.created.localeCompare(b.created));
  }

  // ShipStation label costs for the orders in range (voided labels left out), plus when the last sync ran.
  async function loadLabels(refresh) {
    const [r, sync] = await Promise.all([
      JT.rowsSplit(["l.order_id::text", "sum(l.cost)", "count(*)", "coalesce(json_agg(distinct l.service) filter (where l.service <> ''), '[]')"],
        `from jt.shipstation_labels l join jt.shopify_orders o on o.order_id = l.order_id where not l.voided and o.order_day between ${JT.day(state.start)} and ${JT.day(state.end)} group by l.order_id`, "l.order_id", 1, refresh),
      JT.rows(["job", "finished_at", "ok"], "from jt.v_sync_status", refresh),
    ]);
    const bySid = new Map(); let labels = 0;
    for (const [sid, cost, n, sv] of r) { bySid.set(sid, { cost: num(cost), labels: num(n), services: new Set(sv || []) }); labels += num(n); }
    state.shipSid = bySid; state.shipLabels = labels; state.syncs = sync;
    state.lastSync = (sync.find(x => x[0] === "shipstation_labels") || [])[1] || null;
    state.dbReady = true;
  }

  // Render without letting a display error stop loading (it's shown on the page instead).
  function safeRender() { try { render(); } catch (e) { window.JT.showError && window.JT.showError(e); } }
  async function loadAll(refresh) {
    if (!state.mcp) return;
    // A range picked while a load is running: finish that load, then load the new range.
    // A load running over 40 seconds is abandoned (its results are ignored) and the new one starts now.
    if (state.loading && Date.now() - state.loadStarted < 40000) { state.pending = { refresh: !!refresh || !!(state.pending && state.pending.refresh) }; setStatus("Loading…"); return; }
    const id = state.loadId = (state.loadId || 0) + 1, cur = () => id === state.loadId;
    state.loading = true; state.loadStarted = Date.now(); state.pending = null; state.fromCache = false;
    $("refresh").disabled = true;
    setStatus("Loading daily sales…");
    try {
      if (refresh) JT.overrides.reload();
      const dailyP = loadDaily(refresh).then(d => { if (cur()) { state.daily = d; state.dailyErr = null; } }).catch(e => { if (cur()) { state.dailyErr = e; if (isDenial(e)) state.daily = null; } });
      const ordersP = loadOrders(refresh, (n) => cur() && setStatus(`Loading orders… ${n} so far`)).then(o => { if (cur()) { state.orders = o; state.ordersErr = null; } }).catch(e => { if (cur()) { state.ordersErr = e; if (isDenial(e)) state.orders = null; } });
      const costsP = loadOrderCosts(refresh).then(c => { if (cur()) { state.costs = c; state.costsErr = null; } }).catch(e => { if (cur()) { state.costsErr = e; if (isDenial(e)) state.costs = null; } });
      const ncP = loadNoCostRows(refresh).then(r => { if (cur()) state.ncRows = r; }).catch(() => { if (cur()) state.ncRows = null; });
      const shipP = loadLabels(refresh).catch(() => { if (cur()) { state.dbReady = true; state.shipErr = true; } });
      await dailyP; if (cur() && !state.pending) safeRender();
      await Promise.all([ordersP, costsP, ncP, shipP]);
    } catch (e) { window.JT.showError && window.JT.showError(e); }
    finally { if (cur()) { state.loading = false; $("refresh").disabled = false; } }
    if (!cur()) return;                                   // a newer load took over
    state.loadedAt = new Date();
    if (state.pending) { const p = state.pending; state.pending = null; return loadAll(p.refresh); }
    safeRender();
    const errs = [state.dailyErr, state.ordersErr, state.costsErr].filter(Boolean);
    if (errs.length) setStatus("");
    else setStatus(`Updated ${state.loadedAt.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})} · ${state.orders ? state.orders.length : 0} orders`);
  }

  function setStatus(t) { $("status").textContent = t; }

  // ---------- derived ----------
  function shipFor(o) { return state.shipSid.get(o.sid) || state.ship.get(o.key) || null; }

  function shopifyCostFor(o) { return state.costs ? (state.costs.get(o.name) || null) : null; }
  // Effective product cost: a manual entry replaces Shopify's cost for that order.
  function costFor(o) {
    const k = shopifyCostFor(o); if (!k) return null;
    const ov = state.overrides.get(o.sid);
    if (!ov) return k;
    // Cost-mapping saves record the Shopify cost they were built on, so only the added amount is applied
    // (keeps the order right when this page's date range cuts a return off from its sale).
    const cogs = ov.shopifyCogs != null ? Math.round((k.cogs + ov.cost - ov.shopifyCogs) * 100) / 100 : ov.cost;
    return { net: k.net, cogs, gp: k.net - cogs, nocost: 0, manual: true, shopCogs: k.cogs, note: ov.note || "" };
  }
  function adjustedDaily(dv) {
    return (state.daily || []).map(r => { const a = dv.perDay.get(r.day) || {}; return { ...r, cogs: r.cogs + (a.dc || 0), gp: r.gp + (a.dg || 0), nocost: Math.max(0, r.nocost + (a.dn || 0)) }; });
  }
  const profitAfterShip = (gp, shipCharged, label) => gp + shipCharged - label;

  function derive() {
    const perDay = new Map();
    let webShipped = 0, webShippedWithCost = 0;
    for (const o of state.orders || []) {
      const s = shipFor(o);
      const d = perDay.get(o.day) || { cost:0, labels:0, costOrders:0, dc:0, dg:0, dn:0 };
      if (s) { d.cost += s.cost; d.labels += s.labels; d.costOrders++; }
      if (!state.ncRows) {
        const k = shopifyCostFor(o), ov = state.overrides.get(o.sid);
        if (k && ov) { const c = costFor(o); d.dc += c.cogs - k.cogs; d.dg -= c.cogs - k.cogs; d.dn -= k.nocost; }
      }
      perDay.set(o.day, d);
      const shipped = o.chan !== "pos" && /FULFILLED/.test(o.ful) && !/UNFULFILLED/.test(o.ful);
      if (shipped) { webShipped++; if (s) webShippedWithCost++; }
    }
    if (state.ncRows) {
      // Adjust each day where Shopify recorded sales without a cost:
      //  - order with a saved cost: that day's no-cost sales are covered, and the added cost is spread over
      //    those days in proportion (a later return takes its share back);
      //  - order whose no-cost items were all returned (nets to zero): nothing to cost, so drop it too.
      const get = (day) => { const d = perDay.get(day) || { cost:0, labels:0, costOrders:0, dc:0, dg:0, dn:0 }; perDay.set(day, d); return d; };
      for (const [sid, rows] of state.ncRows) {
        const net = rows.reduce((a, r) => a + r.nc, 0), ov = state.overrides.get(sid);
        if (!ov && Math.abs(net) >= 0.01) continue;
        let extra = 0;
        if (ov) {
          if (ov.shopifyCogs != null) extra = ov.cost - ov.shopifyCogs;
          else { const o = (state.orders || []).find(x => x.sid === sid), k = o && shopifyCostFor(o); extra = k ? ov.cost - k.cogs : 0; }
        }
        for (const r of rows) {
          const d = get(r.day), share = Math.abs(net) >= 0.01 ? extra * r.nc / net : 0;
          d.dn -= r.nc; d.dc += share; d.dg -= share;
        }
      }
    }
    return { perDay, webShipped, webShippedWithCost };
  }

  // ---------- render ----------
  function note(el, kind, html) {
    const n = $(el);
    if (!html) { n.hidden = true; n.innerHTML = ""; return; }
    n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`;
  }

  function render() {
    const dv = derive();
    renderKpis(dv); renderChart(dv); renderDaily(dv); renderOrders(); renderShipSummary();
    note("daily-note", "bad", state.dailyErr ? esc(mcpMessage(state.dailyErr)) : "");
    note("orders-note", state.ordersErr ? "bad" : "warn",
      state.ordersErr ? esc(mcpMessage(state.ordersErr)) :
      state.costsErr ? "Product costs didn't load: " + esc(mcpMessage(state.costsErr)) :
      state.ordersTruncated ? `Some two-week stretches had more than 3,000 orders, so ${state.orders.length.toLocaleString()} orders are shown. Narrow the dates to see the rest.` : "");
    if (state.dailyErr && state.ordersErr && state.dailyErr.code === state.ordersErr.code) {
      note("page-note", "bad", esc(mcpMessage(state.dailyErr)));
      note("daily-note", "", ""); note("orders-note", "", "");
    } else note("page-note", "", "");
  }

  function renderKpis(dv) {
    const d = state.daily ? adjustedDaily(dv) : [];
    const sum = (k) => d.reduce((a, r) => a + r[k], 0);
    const net = sum("net"), orders = sum("orders"), shipCh = sum("shipping");
    let cost = 0, labels = 0; for (const v of dv.perDay.values()) { cost += v.cost; labels += v.labels; }
    const haveOrders = !!state.orders, haveDaily = !!state.daily;
    const dash = '<span class="dim">—</span>';
    const k = [
      { c:"sales", l:"Net sales", v: haveDaily ? m0(net) : dash, s: haveDaily ? `${m0(sum("gross"))} gross · ${m0(-sum("discounts"))} discounts` : "" },
      { c:"", l:"Orders", v: haveDaily ? orders.toLocaleString() : dash, s: haveDaily && orders ? `AOV ${m(net/orders)}` : "" },
      { c:"", l:"Product cost", v: haveDaily ? m0(sum("cogs")) : dash, s: haveDaily ? (sum("nocost") ? `<span style="color:var(--warn)">${m0(sum("nocost"))} of sales have no cost set</span>` : "All items have a cost set") : "" },
      { c:"", l:"Gross profit", v: haveDaily ? m0(sum("gp")) : dash, s: haveDaily && (net - sum("nocost")) ? `${pct(sum("gp")/(net - sum("nocost")))} margin` : "" },
      { c:"cost", l:"Label cost", v: haveOrders ? m0(cost) : dash, s: haveOrders ? `${labels} labels · ${m0(shipCh)} charged to customers` : "" },
      { c:"sales", l:"Profit after shipping", v: haveOrders && haveDaily ? `<span class="${profitAfterShip(sum("gp"), shipCh, cost) < 0 ? "neg" : ""}">${m0(profitAfterShip(sum("gp"), shipCh, cost))}</span>` : dash, s: haveOrders && haveDaily && net ? `${pct(profitAfterShip(sum("gp"), shipCh, cost)/net)} of net sales` : "Gross profit + shipping charged − labels" },
      { c:"", l:"Cost coverage", v: haveOrders ? (dv.webShipped ? pct(dv.webShippedWithCost/dv.webShipped) : dash) : dash, s: haveOrders ? `${dv.webShippedWithCost} of ${dv.webShipped} shipped orders matched` : "" },
    ];
    $("kpis").innerHTML = k.map(x => `<div class="kpi ${x.c}"><span class="eyebrow">${x.l}</span><span class="v">${x.v}</span><span class="s">${x.s}</span></div>`).join("");
  }

  const axisFmt = (v) => v >= 1000 ? "$" + (+(v/1000).toFixed(1)) + "k" : "$" + Math.round(v);
  function niceMax(v) {
    if (v <= 0) return 100;
    const e = Math.pow(10, Math.floor(Math.log10(v)));
    for (const f of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (f*e >= v) return f*e;
    return 10*e;
  }

  function renderChart(dv) {
    const host = $("chart");
    if (!state.daily) { host.innerHTML = `<div class="skel">${state.dailyErr ? "No data" : "Loading…"}</div>`; return; }
    const rows = state.daily.map(r => ({ ...r, cost: (dv.perDay.get(r.day) || {}).cost || 0 }));
    const W = Math.max(320, host.clientWidth || 800), H = W < 560 ? 220 : 280;
    const pad = { l: 56, r: 12, t: 12, b: 28 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const max = niceMax(Math.max(...rows.map(r => Math.max(r.net, r.cost)), 1));
    const y = (v) => pad.t + ih - (Math.max(v,0) / max) * ih;
    const bw = iw / rows.length;
    const ticks = [0, .25, .5, .75, 1].map(f => f * max);
    const labelEvery = Math.ceil(rows.length / Math.max(2, Math.floor(iw / 58)));
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily net sales and label cost">`;
    for (const t of ticks) s += `<line x1="${pad.l}" x2="${W-pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line-soft)" stroke-width="1"/><text x="${pad.l-8}" y="${y(t)+4}" text-anchor="end" font-size="11" fill="var(--faint)" font-family="var(--mono)">${axisFmt(t)}</text>`;
    rows.forEach((r, i) => {
      const x = pad.l + i*bw, w = Math.max(2, bw*0.62);
      s += `<rect x="${x + (bw-w)/2}" y="${y(r.net)}" width="${w}" height="${pad.t+ih-y(r.net)}" fill="var(--sales)" rx="2"/>`;
      if (i % labelEvery === 0 || i === rows.length-1) s += `<text x="${x+bw/2}" y="${H-8}" text-anchor="middle" font-size="11" fill="var(--muted)">${shortDay(r.day)}</text>`;
    });
    const pts = rows.map((r,i) => `${pad.l + i*bw + bw/2},${y(r.cost)}`).join(" ");
    s += `<polyline points="${pts}" fill="none" stroke="var(--cost)" stroke-width="2" stroke-linejoin="round"/>`;
    rows.forEach((r,i) => { s += `<circle cx="${pad.l + i*bw + bw/2}" cy="${y(r.cost)}" r="${i===rows.length-1?3.5:2.2}" fill="var(--cost)"/>`; });
    rows.forEach((r,i) => { s += `<rect data-i="${i}" x="${pad.l + i*bw}" y="${pad.t}" width="${bw}" height="${ih}" fill="transparent"/>`; });
    s += `</svg><div class="tip" hidden></div>`;
    host.innerHTML = s;
    const tip = host.querySelector(".tip"), svg = host.querySelector("svg");
    svg.addEventListener("pointermove", (ev) => {
      const t = ev.target.closest("rect[data-i]"); if (!t) { tip.hidden = true; return; }
      const r = rows[+t.dataset.i];
      const box = host.getBoundingClientRect(), sb = svg.getBoundingClientRect();
      const cx = (pad.l + (+t.dataset.i)*bw + bw/2) * (sb.width / W);
      tip.innerHTML = `<b>${wkDay(r.day)} ${shortDay(r.day)}</b><br>Net sales ${m(r.net)} · ${r.orders} orders<br>Label cost ${m(r.cost)}`;
      tip.hidden = false;
      tip.style.left = Math.min(Math.max(cx, 110), box.width - 110) + "px";
      tip.style.top = (y(r.net) * (sb.height / H) - 8) + "px";
    });
    svg.addEventListener("pointerleave", () => { tip.hidden = true; });
  }

  function renderDaily(dv) {
    const t = $("daily");
    if (!state.daily) { t.innerHTML = `<tbody><tr><td class="l skel">${state.dailyErr ? "No data" : "Loading…"}</td></tr></tbody>`; return; }
    const cols = ["Day","Orders","Gross sales","Discounts","Returns","Net sales","Product cost","Gross profit","Shipping charged","Label cost","Profit after shipping","Margin","Taxes","Total sales"];
    const rows = adjustedDaily(dv).reverse();
    const tot = { orders:0, gross:0, discounts:0, returns:0, net:0, cogs:0, gp:0, shipping:0, taxes:0, total:0, cost:0 };
    const cell = (v, cls) => `<td class="${cls || (v < 0 ? "neg" : "")}">${m(v)}</td>`;
    const body = rows.map(r => {
      const c = (dv.perDay.get(r.day) || {}).cost || 0;
      for (const k in tot) tot[k] += k === "cost" ? c : r[k];
      const pas = profitAfterShip(r.gp, r.shipping, c);
      return `<tr><td class="l">${wkDay(r.day)} ${shortDay(r.day)}</td><td>${r.orders}</td>${cell(r.gross)}${cell(r.discounts)}${cell(r.returns)}<td><b>${m(r.net)}</b></td><td>${m(r.cogs)}${r.nocost ? ' <span class="pill miss" title="Sales with no product cost set in Shopify">' + m0(r.nocost) + ' no cost</span>' : ""}</td>${cell(r.gp)}<td>${m(r.shipping)}</td><td>${state.orders ? m(c) : '<span class="dim">…</span>'}</td>${state.orders ? `<td class="${pas<0?"neg":""}"><b>${m(pas)}</b></td>` : "<td></td>"}<td class="dim">${state.orders && r.net ? pct(pas/r.net) : ""}</td><td>${m(r.taxes)}</td><td>${m(r.total)}</td></tr>`;
    }).join("");
    const tpas = profitAfterShip(tot.gp, tot.shipping, tot.cost);
    t.innerHTML = `<thead><tr>${cols.map((c,i)=>`<th class="${i===0?"l":""}">${c}</th>`).join("")}</tr></thead><tbody>${body}</tbody>
      <tfoot><tr><td class="l">Total</td><td>${tot.orders}</td><td>${m(tot.gross)}</td><td>${m(tot.discounts)}</td><td>${m(tot.returns)}</td><td>${m(tot.net)}</td><td>${m(tot.cogs)}</td><td>${m(tot.gp)}</td><td>${m(tot.shipping)}</td><td>${m(tot.cost)}</td><td class="${tpas<0?"neg":""}">${m(tpas)}</td><td>${tot.net ? pct(tpas/tot.net) : ""}</td><td>${m(tot.taxes)}</td><td>${m(tot.total)}</td></tr></tfoot>`;
  }

  function filteredOrders() {
    const chan = $("f-chan").value, miss = $("f-miss").checked, nocost = $("f-nocost").checked;
    return (state.orders || []).filter(o => {
      if (chan !== "all" && o.chan !== chan) return false;
      if (nocost) { const k = costFor(o); if (!k || !(k.nocost > 0)) return false; }
      if (miss) { const shipped = o.chan !== "pos" && /FULFILLED/.test(o.ful) && !/UNFULFILLED/.test(o.ful); if (!shipped || shipFor(o)) return false; }
      return true;
    }).sort((a,b) => b.created.localeCompare(a.created));
  }

  const chanPill = (o) => `<span class="pill ${o.chan}">${o.chan === "web" ? "Online" : o.chan === "pos" ? "POS" : esc(o.source || "Other")}</span>`;
  const title = (s) => String(s||"").toLowerCase().replace(/_/g," ").replace(/^\w/, c=>c.toUpperCase());

  function renderOrders() {
    const t = $("orders");
    const ae = document.activeElement, active = ae && ae.id && ae.id.startsWith("lc-") ? ae.id : null;
    const selS = active ? ae.selectionStart : 0, selE = active ? ae.selectionEnd : 0;
    $("dl").hidden = !(state.orders && state.orders.length && state.downloads);
    if (!state.orders) { t.innerHTML = `<tbody><tr><td class="l skel">${state.ordersErr ? "No data" : "Loading…"}</td></tr></tbody>`; return; }
    const rows = filteredOrders();
    const LIMIT = 600;
    const costsReady = !!state.costs;
    const tot = { net:0, discounts:0, cogs:0, gp:0, shipping:0, label:0, pas:0, refunded:0, total:0 };
    const body = rows.slice(0, LIMIT).map(o => {
      const s = shipFor(o); const c = s ? s.cost : 0;
      const k = costFor(o);
      const shipped = o.chan !== "pos" && /FULFILLED/.test(o.ful) && !/UNFULFILLED/.test(o.ful);
      const costCell = s ? `${m(c)}${s.labels > 1 ? ` <span class="dim">×${s.labels}</span>` : ""}` : shipped ? `<span class="pill miss">No label</span>` : `<span class="dim">—</span>`;
      const load = '<span class="dim">…</span>';
      let cogsCell;
      if (!costsReady) cogsCell = load;
      else if (!k) cogsCell = '<span class="dim">—</span>';
      else {
        const open = state.editing === o.sid;
        const tag = k.manual ? ' <span class="pill manual">Entered</span>' : k.nocost > 0 ? ' <span class="pill miss">Enter cost</span>' : "";
        cogsCell = `<button class="costbtn${open ? " open" : ""}" data-act="${open ? "cancel" : "edit"}" data-sid="${o.sid}" aria-expanded="${open}" title="${open ? "Close" : "Show items and edit product cost"}">${m(k.cogs)}${tag} <span class="chev">${open ? "▴" : "▾"}</span></button>`;
      }
      const pas = k ? profitAfterShip(k.gp, o.shipping, c) : null;
      const base = k ? k.net : null;
      return `<tr><td class="l mono"><a class="olink" href="https://admin.shopify.com/store/justtennis-822/orders/${encodeURIComponent(o.sid)}" target="_blank" rel="noopener">${esc(o.name)}</a>${o.cancelled ? ' <span class="pill cx">Cancelled</span>' : ""}</td><td class="l">${shortDay(o.day)} <span class="dim">${new Date(o.created).toLocaleTimeString("en-US",{timeZone:TZ,hour:"numeric",minute:"2-digit"})}</span></td><td class="l">${chanPill(o)}</td><td class="l dim">${esc(title(o.fin))} · ${esc(title(o.ful))}</td><td>${!costsReady ? load : k ? m(k.net) : '<span class="dim">—</span>'}</td><td class="${o.discounts?"neg":"dim"}">${o.discounts ? m(-o.discounts) : "—"}</td><td>${cogsCell}</td><td class="${k && k.gp < 0 ? "neg" : ""}">${!costsReady ? load : k ? m(k.gp) : '<span class="dim">—</span>'}</td><td>${m(o.shipping)}</td><td>${costCell}</td><td class="${pas != null && pas < 0 ? "neg" : ""}">${pas == null ? '<span class="dim">—</span>' : "<b>" + m(pas) + "</b>"}</td><td class="dim">${pas != null && base ? pct(pas/base) : ""}</td><td class="${o.refunded?"neg":"dim"}">${o.refunded ? m(-o.refunded) : "—"}</td><td>${m(o.total)}</td><td class="l dim">${s ? esc([...s.services].join(", ")) : ""}</td></tr>${state.editing === o.sid && k ? detailRow(o, k) : ""}`;
    }).join("");
    for (const o of rows) {
      const s = shipFor(o), k = costFor(o), c = s ? s.cost : 0;
      tot.discounts += o.discounts; tot.shipping += o.shipping; tot.label += c; tot.refunded += o.refunded; tot.total += o.total;
      if (k) { tot.net += k.net; tot.cogs += k.cogs; tot.gp += k.gp; tot.pas += profitAfterShip(k.gp, o.shipping, c); }
    }
    const cols = ["Order","Placed","Channel","Status","Net sales","Discounts","Product cost","Gross profit","Shipping charged","Label cost","Profit after shipping","Margin","Refunded","Order total","Service"];
    const left = new Set([0,1,2,3,14]);
    const n = cols.length;
    t.innerHTML = `<thead><tr>${cols.map((c,i)=>`<th class="${left.has(i)?"l":""}">${c}</th>`).join("")}</tr></thead>
      <tbody>${body || `<tr><td class="l dim" colspan="${n}">No orders match these filters.</td></tr>`}${rows.length > LIMIT ? `<tr><td class="l dim" colspan="${n}">Showing ${LIMIT} of ${rows.length} orders. Totals below include all ${rows.length}. Download the CSV for the full list.</td></tr>` : ""}</tbody>
      <tfoot><tr><td class="l">${rows.length} orders</td><td></td><td></td><td></td><td>${m(tot.net)}</td><td>${m(-tot.discounts)}</td><td>${m(tot.cogs)}</td><td>${m(tot.gp)}</td><td>${m(tot.shipping)}</td><td>${m(tot.label)}</td><td class="${tot.pas<0?"neg":""}">${m(tot.pas)}</td><td>${tot.net ? pct(tot.pas/tot.net) : ""}</td><td>${m(-tot.refunded)}</td><td>${m(tot.total)}</td><td></td></tr></tfoot>`;
    if (active && $(active)) { const i = $(active); i.focus(); try { i.setSelectionRange(selS, selE); } catch (_) {} }
  }

  function renderShipSummary() {
    const el = $("ss-summary");
    if (!state.dbReady) { el.textContent = "Loading label costs…"; return; }
    if (state.shipErr) { el.textContent = "Label costs couldn't load. Press Refresh."; return; }
    const when = (t) => t && !isNaN(window.JTDate.parseTime(t)) ? window.JTDate.parseTime(t).toLocaleString("en-US",{timeZone:TZ,month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}) : "never";
    const sales = (state.syncs || []).find(x => x[0] === "shopify_sales");
    el.textContent = `${state.shipLabels.toLocaleString()} ShipStation labels for orders in this range · labels synced ${when(state.lastSync)} · sales synced ${when(sales && sales[1])} (both sync hourly)`;
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    const rows = []; let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i+1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i+1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
      else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.some(x => String(x).trim() !== ""));
  }
  const money = (s) => { let t = String(s ?? "").trim(); const neg = /^\(.*\)$/.test(t) || t.startsWith("-"); t = t.replace(/[^0-9.]/g, ""); const n = parseFloat(t); return isNaN(n) ? null : (neg ? -n : n); };
  function toISODate(s) {
    const t = String(s ?? "").trim(); if (!t) return null;
    let mt = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); if (mt) return `${mt[1]}-${mt[2]}-${mt[3]}`;
    mt = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(t);
    if (mt) { let yy = mt[3].length === 2 ? "20" + mt[3] : mt[3]; return `${yy}-${mt[1].padStart(2,"0")}-${mt[2].padStart(2,"0")}`; }
    return laDay(t);
  }
  function guess(headers) {
    const H = headers.map(h => h.toLowerCase().trim());
    const find = (tests, not) => { for (const re of tests) { const i = H.findIndex(h => re.test(h) && !(not && not.test(h))); if (i >= 0) return i; } return -1; };
    return {
      order: find([/^order\s*(#|number|no\.?)$/, /order.*(#|number|no\b)/, /^order$/]),
      cost: find([/shipment.*cost/, /^shipping\s*cost$/, /label.*cost/, /carrier.*fee/, /^cost$/, /cost/], /insur|paid|amount|price|charged|order\s*total|item/),
      insurance: find([/insur.*cost/, /insurance/], /paid/),
      date: find([/ship\s*date/, /date.*ship/, /label.*date|create.*date/, /^date$/, /date/], /order\s*date|deliver/),
      tracking: find([/tracking/]),
      service: find([/service/, /carrier/], /fee|cost/),
      voided: find([/void/]),
    };
  }

  function handleFile(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      const rows = parseCSV(String(r.result || "").replace(/^﻿/, ""));
      if (rows.length < 2) { note("ss-note", "bad", "That file has no data rows. Export shipments from ShipStation as CSV and try again."); return; }
      state.parsed = { name: file.name, headers: rows[0], rows: rows.slice(1), map: guess(rows[0]) };
      renderMap();
    };
    r.onerror = () => note("ss-note", "bad", "Couldn't read that file. Try exporting it again.");
    r.readAsText(file);
  }

  function buildShipments() {
    const P = state.parsed, mp = P.map;
    const out = []; let skipped = 0, voided = 0;
    for (const r of P.rows) {
      const ord = mp.order >= 0 ? orderKey(r[mp.order]) : "";
      let cost = mp.cost >= 0 ? money(r[mp.cost]) : null;
      if (!ord || cost == null) { skipped++; continue; }
      if (mp.voided >= 0 && /^(true|yes|y|1|voided)$/i.test(String(r[mp.voided]).trim())) { voided++; continue; }
      if (mp.insurance >= 0) cost += money(r[mp.insurance]) || 0;
      const date = (mp.date >= 0 && toISODate(r[mp.date])) || laDay(Date.now());
      const trk = mp.tracking >= 0 ? String(r[mp.tracking]).trim() : "";
      const svc = mp.service >= 0 ? String(r[mp.service]).trim() : "";
      const key = (trk || `${ord}|${date}|${cost.toFixed(2)}|${svc}`).replace(/[.\s$\[\]\/#]/g, "_").slice(0, 120);
      out.push({ key, o: ord, c: Math.round(cost*100)/100, v: svc.slice(0, 60), date });
    }
    return { out, skipped, voided };
  }

  function renderMap() {
    const P = state.parsed; const box = $("ss-map");
    if (!P) { box.hidden = true; box.innerHTML = ""; return; }
    const opt = (sel) => `<option value="-1">— none —</option>` + P.headers.map((h,i) => `<option value="${i}" ${i===sel?"selected":""}>${esc(h)}</option>`).join("");
    const fields = [["order","Order number (required)"],["cost","Label cost (required)"],["insurance","Insurance cost (added)"],["date","Ship date"],["tracking","Tracking number"],["service","Carrier / service"],["voided","Voided flag"]];
    const { out, skipped, voided } = buildShipments();
    const keys = new Set((state.orders || []).map(o => o.key));
    const matched = out.filter(s => keys.has(s.o)).length;
    const total = out.reduce((a,s) => a + s.c, 0);
    box.hidden = false;
    box.innerHTML = `<div class="row"><b>${esc(P.name)}</b><span class="muted">${P.rows.length} rows · ${out.length} labels · ${m(total)}${voided ? ` · ${voided} voided skipped` : ""}${skipped ? ` · ${skipped} rows missing order # or cost` : ""}</span></div>
      <div class="map">${fields.map(([k,l]) => `<label for="map-${k}">${l}<select id="map-${k}" data-k="${k}">${opt(P.map[k])}</select></label>`).join("")}</div>
      <div class="row"><span class="muted">${matched} of ${out.length} labels match orders in the current date range${state.orders ? "" : " (orders still loading)"}. Labels outside the range are saved too and appear when you change the dates.</span></div>
      <div class="row"><button class="btn primary" id="ss-save" ${out.length && state.db ? "" : "disabled"}>Save ${out.length} labels</button><button class="btn" id="ss-cancel">Cancel</button></div>`;
    box.querySelectorAll("select").forEach(s => s.addEventListener("change", () => { P.map[s.dataset.k] = +s.value; renderMap(); }));
    $("ss-cancel").onclick = () => { state.parsed = null; renderMap(); $("file").value = ""; };
    $("ss-save").onclick = saveShipments;
    note("ss-note", "", "");
  }

  async function saveShipments() {
    const { out } = buildShipments();
    const btn = $("ss-save"); btn.disabled = true;
    const byDate = new Map();
    for (const s of out) { if (!byDate.has(s.date)) byDate.set(s.date, {}); byDate.get(s.date)[s.key] = { o: s.o, c: s.c, v: s.v }; }
    const dates = [...byDate.keys()].sort();
    let done = 0;
    try {
      for (const d of dates) {
        btn.textContent = `Saving ${++done} of ${dates.length} days…`;
        const ref = state.db.collection("shipments").doc(d);
        const cur = await ref.get();
        const rows = Object.assign({}, cur.exists ? (cur.data().rows || {}) : {}, byDate.get(d));
        await ref.set({ date: d, rows, updatedAt: new Date().toISOString() });
      }
      state.parsed = null; renderMap(); $("file").value = "";
      note("ss-note", "info", `Saved ${out.length} labels across ${dates.length} ship dates.`);
    } catch (e) {
      const msg = e && e.code === "quota_exceeded" ? "Storage is full. Contact the dashboard owner to clear old shipments." :
                  e && e.code === "invalid_argument" ? "You don't have permission to save shipping costs on this dashboard." :
                  "Saving stopped partway. Upload the same file again — labels already saved won't double count.";
      note("ss-note", "bad", `${esc(msg)} (${Math.max(0, done - 1)} of ${dates.length} days saved)`);
      btn.disabled = false; btn.textContent = "Try again";
    }
  }

  function applyShipSnapshot(snap) {
    const map = new Map(), bySid = new Map(); let labels = 0, last = null;
    const add = (m, k, r) => { const e = m.get(k) || { cost: 0, labels: 0, services: new Set() }; e.cost += Number(r.c) || 0; e.labels++; if (r.v) e.services.add(r.v); m.set(k, e); };
    for (const doc of snap.docs) {
      const body = doc.data() || {};
      if (body.syncedAt && (!last || body.syncedAt > last)) last = body.syncedAt;
      const rows = body.rows || {};
      for (const k in rows) {
        const r = rows[k]; labels++;
        if (r.sid) add(bySid, String(r.sid), r); else if (r.o) add(map, r.o, r);
      }
    }
    state.ship = map; state.shipSid = bySid; state.lastSync = last; state.shipDocs = snap.size; state.shipLabels = labels; state.dbReady = true;
    render();
  }

  // ---------- CSV download ----------
  async function downloadCSV() {
    const rows = filteredOrders();
    const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
    const head = ["order","placed_pt","day","channel","source","financial_status","fulfillment_status","cancelled","subtotal","discounts","shipping_charged","tax","total","refunded","net_sales","product_cost","gross_profit","sales_without_cost","cost_source","label_cost","labels","shipping_net","profit_after_shipping","service"];
    const lines = [head.join(",")];
    for (const o of rows) {
      const s = shipFor(o);
      const k = costFor(o), c = s ? s.cost : 0;
      lines.push([o.name, window.JTDate.parseTime(o.created).toLocaleString("en-US",{timeZone:TZ}), o.day, o.chan, o.source, o.fin, o.ful, o.cancelled, o.subtotal.toFixed(2), o.discounts.toFixed(2), o.shipping.toFixed(2), o.tax.toFixed(2), o.total.toFixed(2), o.refunded.toFixed(2), k ? k.net.toFixed(2) : "", k ? k.cogs.toFixed(2) : "", k ? k.gp.toFixed(2) : "", k ? k.nocost.toFixed(2) : "", k ? (k.manual ? "entered" : "shopify") : "", s ? c.toFixed(2) : "", s ? s.labels : "", s ? (o.shipping - c).toFixed(2) : "", k ? profitAfterShip(k.gp, o.shipping, c).toFixed(2) : "", s ? [...s.services].join("; ") : ""].map(q).join(","));
    }
    try { await state.downloads.save({ filename: `just-tennis-orders_${state.start}_to_${state.end}.csv`, data: lines.join("\n") }); }
    catch (e) { if (e && e.code !== "cancelled" && e.code !== "declined") note("orders-note", "bad", "Download didn't start. Try again."); }
  }

  // ---------- wiring ----------
  document.querySelectorAll("#rangeseg button").forEach(b => b.addEventListener("click", () => { setRange(b.dataset.days); loadAll(false); }));
  const onDate = () => {
    const s = $("d-start").value, e = $("d-end").value;
    if (!s || !e || s > e) return;
    state.start = s; state.end = e;
    document.querySelectorAll("#rangeseg button").forEach(b => b.setAttribute("aria-pressed", "false"));
    loadAll(false);
  };
  $("d-start").addEventListener("change", onDate); $("d-end").addEventListener("change", onDate);
  $("refresh").addEventListener("click", () => loadAll(true));
  $("f-chan").addEventListener("change", renderOrders);
  $("f-miss").addEventListener("change", renderOrders);
  $("f-nocost").addEventListener("change", renderOrders);

  // ---------- manual product cost entry ----------
  async function loadLines(sid) {
    state.lines.set(sid, { loading: true });
    renderOrders();
    try {
      const r = await JT.rows(["l.line_id::text", "l.title", "l.variant_title", "l.sku", "l.current_quantity", "l.quantity", "l.unit_price", "v.unit_cost", "l.product_id::text", "l.variant_id::text"],
        `from jt.shopify_order_lines l left join jt.variants v on v.variant_id = l.variant_id where l.order_id = ${JT.int(sid)}`, true);
      const items = r.sort((a, b) => a[0].localeCompare(b[0])).map(x => ({ id: x[0], title: x[1], variant: x[2] || "", sku: x[3] || "", qty: num(x[4]), origQty: num(x[5]),
        price: num(x[6]), unit: x[7] == null ? null : Number(x[7]), custom: !x[9], pid: x[8] && x[8] !== "0" ? x[8] : null, vid: x[9] || null }));
      if (!items.length) throw { code: "tool_error", message: "This order's items haven't synced yet. Try again after the next hourly sync." };
      state.lines.set(sid, { items });
    } catch (e) {
      state.lines.set(sid, { error: e });
    }
    renderOrders();
  }

  function draftUnit(it) { const v = state.drafts[it.id]; if (v == null || String(v).trim() === "") return null; const n = money(v); return n == null || n < 0 ? NaN : n; }
  function calc(o) {
    const L = state.lines.get(o.sid), base = (shopifyCostFor(o) || {}).cogs || 0;
    let delta = 0, missing = 0, bad = 0;
    for (const it of (L && L.items) || []) {
      const d = draftUnit(it);
      if (Number.isNaN(d)) { bad++; continue; }
      if (d == null) { if (it.unit == null && it.qty > 0) missing++; continue; }
      delta += it.qty * (d - (it.unit || 0));
    }
    return { base, delta, total: Math.round((base + delta) * 100) / 100, missing, bad };
  }

  function detailRow(o, k) {
    const L = state.lines.get(o.sid);
    let inner;
    if (!L || L.loading) inner = '<div class="skel">Loading items from Shopify…</div>';
    else if (L.error) inner = `<div class="note bad">${esc(mcpMessage(L.error))} <button class="mini" data-act="reload" data-sid="${o.sid}">Try again</button></div>`;
    else {
      const rowsH = L.items.map(it => {
        const d = draftUnit(it);
        const eff = d != null && !Number.isNaN(d) ? d : (it.unit || 0);
        const shopCell = it.unit == null ? `<span class="pill miss">${it.custom ? "Custom item · no cost" : "No cost"}</span>` : m(it.unit);
        const need = it.unit == null && it.qty > 0;
        const qtyH = it.qty !== it.origQty ? `${it.qty} <span class="dim">(of ${it.origQty})</span>` : it.qty;
        return `<tr class="${need ? "need" : ""}"><td class="l"><div class="iname">${it.pid ? `<a class="olink" href="https://admin.shopify.com/store/justtennis-822/products/${encodeURIComponent(it.pid)}${it.vid ? "/variants/" + encodeURIComponent(it.vid) : ""}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title)}</div>${it.variant || it.sku ? `<div class="dim small">${esc([it.variant, it.sku].filter(Boolean).join(" · "))}</div>` : ""}</td><td>${qtyH}</td><td>${m(it.price)}</td><td>${shopCell}</td><td><input id="lc-${it.id}" data-line="${it.id}" type="text" inputmode="decimal" placeholder="${need ? "Required" : "Keep"}" aria-label="Your unit cost for ${esc(it.title)}" value="${esc(state.drafts[it.id] ?? "")}"></td><td id="lcl-${it.id}">${m(it.qty * eff)}</td></tr>`;
      }).join("");
      inner = `<table class="lines"><thead><tr><th class="l">Item</th><th>Qty</th><th>Price each</th><th>Shopify cost each</th><th>Your cost each</th><th>Line cost</th></tr></thead><tbody>${rowsH}</tbody></table>
        <div class="dfoot"><span id="lc-summary">${summaryHTML(o)}</span>
        <span class="dbtns"><button class="mini primary" data-act="save" data-sid="${o.sid}" ${state.saving ? "disabled" : ""}>Save cost</button><button class="mini" data-act="cancel">Cancel</button>${k.manual ? `<button class="mini" data-act="clear" data-sid="${o.sid}">Use Shopify's cost</button>` : ""}</span></div>
        <div class="dim small">Fill in every item marked No cost. Leave other items blank to keep Shopify's cost, or type a cost to replace it (e.g. a $0.01 placeholder). Quantities are after returns.</div>`;
    }
    return `<tr class="detail"><td colspan="15"><div class="dpanel">${inner}</div></td></tr>`;
  }

  function summaryHTML(o) {
    const c = calc(o);
    const warn = c.bad ? ` · <span class="neg">${c.bad} cost${c.bad > 1 ? "s aren't" : " isn't"} a dollar amount</span>` : c.missing ? ` · <span style="color:var(--warn)">${c.missing} item${c.missing > 1 ? "s" : ""} still need${c.missing > 1 ? "" : "s"} a cost</span>` : "";
    return `Shopify recorded ${m(c.base)}${c.delta ? ` · your changes ${c.delta > 0 ? "+" : "−"}${m(Math.abs(c.delta))}` : ""} · <b>Order product cost ${m(c.total)}</b>${warn}`;
  }

  async function saveOverride(sid, clear) {
    const o = (state.orders || []).find(x => x.sid === sid); if (!o) return;
    let body = null;
    if (!clear) {
      const c = calc(o), L = state.lines.get(sid);
      if (!L || !L.items) return;
      if (c.bad) { note("orders-note", "bad", "Enter each cost as a dollar amount, like 42.50."); return; }
      if (c.missing) { note("orders-note", "warn", "Fill in a cost for every item marked No cost (enter 0 if it really cost nothing)."); return; }
      const lines = {};
      for (const it of L.items) { const d = draftUnit(it); if (d != null) lines[it.id] = { unit: Math.round(d * 100) / 100, title: it.title.slice(0, 80), qty: it.qty }; }
      if (!Object.keys(lines).length) { note("orders-note", "warn", "Nothing to save. Enter a cost for at least one item."); return; }
      body = { order_id: sid, order_name: o.name, cost: c.total, shopify_cogs: c.base, lines, src: "shopify-tab" };
    }
    state.saving = true; renderOrders();
    try {
      if (clear) await JT.deleteCostOverride(sid); else await JT.saveCostOverride(body);
      JT.overrides.set(sid, clear ? null : { cost: body.cost, lines: body.lines, src: body.src, shopifyCogs: body.shopify_cogs });
      state.editing = null; state.drafts = {};
      note("orders-note", "", "");
    } catch (e) {
      note("orders-note", "bad", "Couldn't save that cost: " + esc(mcpMessage(e)));
    }
    state.saving = false; render();
  }

  function openEditor(sid) {
    if (!state.mcp) { note("orders-note", "warn", "Saving costs isn't available in this view. Open the dashboard in claude.ai."); return; }
    state.editing = sid;
    const ov = state.overrides.get(sid); state.drafts = {};
    if (ov && ov.lines) for (const id in ov.lines) state.drafts[id] = String(ov.lines[id].unit);
    note("orders-note", "", "");
    const L = state.lines.get(sid);
    if (!L || L.error) loadLines(sid); else renderOrders();
  }
  function closeEditor() { state.editing = null; state.drafts = {}; renderOrders(); }

  $("orders").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-act]"); if (!b) return;
    const act = b.dataset.act, sid = b.dataset.sid;
    if (act === "edit") openEditor(sid);
    else if (act === "cancel") closeEditor();
    else if (act === "reload") loadLines(sid);
    else if (act === "save") saveOverride(sid, false);
    else if (act === "clear") saveOverride(sid, true);
  });
  $("orders").addEventListener("input", (ev) => {
    const id = ev.target.dataset && ev.target.dataset.line; if (!id) return;
    state.drafts[id] = ev.target.value;
    const o = (state.orders || []).find(x => x.sid === state.editing); if (!o) return;
    const L = state.lines.get(o.sid), it = L && L.items && L.items.find(x => x.id === id);
    if (it) { const d = draftUnit(it); const cell = $("lcl-" + id); if (cell) cell.textContent = m(it.qty * (d != null && !Number.isNaN(d) ? d : (it.unit || 0))); }
    const sm = $("lc-summary"); if (sm) sm.innerHTML = summaryHTML(o);
  });
  $("orders").addEventListener("keydown", (ev) => {
    if (!(ev.target.dataset && ev.target.dataset.line)) return;
    if (ev.key === "Enter") { ev.preventDefault(); saveOverride(state.editing, false); }
    if (ev.key === "Escape") closeEditor();
  });
  $("dl").addEventListener("click", downloadCSV);
  $("file").addEventListener("change", (e) => handleFile(e.target.files[0]));
  const drop = $("drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); handleFile(e.dataTransfer.files[0]); });
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => renderChart(derive()), 150); });

  setRange(14);
  render();


  const use = window.claude && window.claude.use ? window.claude.use.bind(window.claude) : null;
  if (!use) { setStatus(""); note("page-note", "warn", "Open this dashboard in claude.ai to load live Shopify data."); return; }

  use("downloads").then(d => { state.downloads = d; renderOrders(); }).catch(() => {});
  $("drop").hidden = true;
  JT.overrides.subscribe((mm) => { state.overrides = mm; render(); });
  JT.getMcp().then(mcp => {
    if (!mcp) { setStatus(""); note("page-note", "warn", "Live data isn't available in this view. Open the dashboard in claude.ai."); return; }
    state.mcp = mcp; loadAll(false);
  }).catch(() => { setStatus(""); note("page-note", "warn", "Live data isn't available in this view."); });
})();
