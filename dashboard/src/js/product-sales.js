(() => {
  // ===================== Product sales: all sales in one place =====================
  // Just Tennis (Shopify), Ace n Rally (Shopify, costed at Just Tennis cost) and Amazon (US + MX, by order date,
  // after Amazon fees) side by side: totals, a channel table, sales by day and products across all three.
  // Data: jt.v_sales_channels_daily and jt.v_sales_products_daily (migration 092). Cost watch sits below.
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m = (n) => usd.format(n || 0), m0 = (n) => usd0.format(n || 0);
  const pct = (n) => isFinite(n) ? (n * 100).toFixed(1) + "%" : "—";
  const n0 = (x) => Math.round(x || 0).toLocaleString();
  const today = window.JTDate.today, addDays = window.JTDate.addDays;
  const shortDay = (ds) => new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const wkDay = (ds) => new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const CH = [["justtennis", "Just Tennis", "Shopify"], ["acenrally", "Ace n Rally", "Shopify"], ["amazon", "Amazon", "US + MX"]];
  const CHNAME = Object.fromEntries(CH.map(c => [c[0], c[1]]));
  const P = { start: null, end: null, preset: "today", days: null, prods: null, err: null, loading: false, reqId: 0, q: "", sort: "net", limit: 50 };

  window.JTRange.seg("ps-rangeseg", "r");
  function setRange(r) {
    P.preset = r; [P.start, P.end] = window.JTRange.of(r);
    $("ps-start").value = P.start; $("ps-end").value = P.end;
    document.querySelectorAll("#ps-rangeseg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.r === r)));
  }
  async function load(refresh) {
    const JT = window.JT, id = ++P.reqId; P.loading = true; P.err = null; render();
    const W = `where day between ${JT.day(P.start)} and ${JT.day(P.end)}`;
    try {
      const [days, prods] = await Promise.all([
        JT.rows(["day::text", "channel", "orders", "units", "net_sales", "cogs", "gross_profit", "sales_no_cost", "ship_charged", "labels", "amz_fees", "fba_fees", "other_fees", "profit", "pay_fees"],
          `from jt.v_sales_channels_daily ${W} order by day`, refresh),
        JT.rowsSplit(["coalesce(product_id::text, '')", "max(title)", "max(vendor)", "channel", "sum(units)", "sum(net_sales)", "sum(cogs)", "sum(gross_profit)", "sum(amz_fees)"],
          `from jt.v_sales_products_daily ${W} group by coalesce(product_id::text, title), coalesce(product_id::text, ''), channel`, "coalesce(product_id::text, title)", 2, refresh),
      ]);
      if (id !== P.reqId) return;
      P.days = days.map(x => ({ day: x[0], ch: x[1], orders: +x[2] || 0, units: +x[3] || 0, net: +x[4] || 0, cogs: +x[5] || 0, gp: +x[6] || 0, nocost: +x[7] || 0,
        shipIn: +x[8] || 0, labels: +x[9] || 0, refFees: +x[10] || 0, fbaFees: +x[11] || 0, other: +x[12] || 0, profit: +x[13] || 0, payFees: +x[14] || 0 }));
      const pm = new Map();
      for (const [pid, title, vendor, ch, units, net, cogs, gp, fee] of prods) {
        const k = pid || "t:" + title; let p = pm.get(k);
        if (!p) { p = { pid, title: title || "(no name)", vendor: vendor || "", units: 0, net: 0, cogs: 0, gp: 0, fees: 0, by: {} }; pm.set(k, p); }
        p.units += +units || 0; p.net += +net || 0; p.cogs += +cogs || 0; p.gp += +gp || 0; p.fees += +fee || 0;
        const b = p.by[ch] || (p.by[ch] = { units: 0, net: 0, gp: 0 }); b.units += +units || 0; b.net += +net || 0; b.gp += +gp || 0;
        if (!p.vendor && vendor) p.vendor = vendor;
      }
      P.prods = [...pm.values()];
    } catch (e) { if (id === P.reqId) { P.err = e; P.days = null; P.prods = null; } }
    if (id === P.reqId) { P.loading = false; render(); }
  }

  function totals() {
    const F = ["orders", "units", "net", "cogs", "gp", "nocost", "shipIn", "labels", "refFees", "fbaFees", "other", "payFees", "profit"], z = () => Object.fromEntries(F.map(f => [f, 0]));
    const t = {}; for (const [k] of CH) t[k] = z();
    const all = z();
    for (const r of P.days || []) { const a = t[r.ch]; if (!a) continue; for (const f of F) { a[f] += r[f]; all[f] += r[f]; } }
    return { t, all };
  }
  const marginOf = (x) => (x.net - x.nocost) > 0 ? x.gp / (x.net - x.nocost) : NaN;
  const sw = (k) => `<i class="chsw ch-${k}" aria-hidden="true"></i>`;

  const fees = (x) => x.refFees + x.fbaFees + x.other, allFees = (x) => fees(x) + x.payFees;
  function renderKpis(T) {
    const a = T.all, amz = T.t.amazon;
    const k = [
      { c: "sales", l: "Sales · all channels", v: m0(a.net), s: CH.map(([k2, n]) => `${n} ${m0(T.t[k2].net)}`).join(" · ") + ` · ${n0(a.orders)} orders · ${n0(a.units)} units` },
      { l: "Gross profit", v: `<span class="${a.gp < 0 ? "neg" : ""}">${m0(a.gp)}</span>`, s: `${pct(marginOf(a))} margin · sales − product cost${a.nocost > 0.5 ? ` · <span style="color:var(--warn)">${m0(a.nocost)} of sales have no cost</span>` : ""}` },
      { l: "Shipping labels", v: m0(a.labels), s: `${m0(a.shipIn)} charged to customers · net ${m0(a.labels - a.shipIn)}` },
      { l: "Fees", v: m0(allFees(a)), s: `Amazon referral ${m0(amz.refFees)} · FBA ${m0(amz.fbaFees)} · other ${m0(amz.other)} · Shopify payments ${m0(a.payFees)}` },
      { c: "sales", l: "Profit", v: `<span class="${a.profit < 0 ? "neg" : ""}">${m0(a.profit)}</span>`, s: `${a.net ? pct(a.profit / a.net) : "—"} of sales · after product cost, shipping and fees` },
    ];
    $("ps-kpis").innerHTML = k.map(x => `<div class="kpi ${x.c || ""}"><span class="eyebrow">${x.l}</span><span class="v">${x.v}</span><span class="s">${x.s}</span></div>`).join("");
  }
  function renderChannels(T) {
    const a = T.all, d = (v) => Math.abs(v) < 0.005 ? '<span class="dim">—</span>' : m(v), neg = (v) => Math.abs(v) < 0.005 ? '<span class="dim">—</span>' : `<span class="neg">−${m(v).replace("-", "")}</span>`;
    const row = (name, x, k) => `<tr><td class="l">${k ? sw(k) : ""}<b>${name}</b>${k ? `<div class="meta">${esc(CH.find(c => c[0] === k)[2])} · ${n0(x.orders)} orders</div>` : `<div class="meta">${n0(x.orders)} orders</div>`}</td>
      <td>${m(x.net)}<div class="meta">${a.net > 0 ? pct(x.net / a.net) + " of sales" : ""}</div></td>
      <td>${neg(x.cogs)}${x.nocost > 0.5 ? `<div class="meta"><span class="pill miss" title="Sales with no product cost">${m0(x.nocost)} no cost</span></div>` : ""}</td>
      <td class="${x.gp < 0 ? "neg" : ""}">${m(x.gp)}<div class="meta">${pct(marginOf(x))}</div></td>
      <td>${d(x.shipIn)}</td><td>${neg(x.labels)}</td><td>${neg(x.refFees)}</td><td>${neg(x.fbaFees)}</td><td>${neg(x.other)}</td><td>${neg(x.payFees)}</td>
      <td class="${x.profit < 0 ? "neg" : ""}"><b>${m(x.profit)}</b><div class="meta">${x.net ? pct(x.profit / x.net) : "—"}</div></td></tr>`;
    $("ps-chans").innerHTML = `<thead><tr><th class="l">Channel</th><th>Sales</th><th>Product cost</th><th>Gross profit</th><th title="Shipping customers paid">Shipping charged</th><th title="ShipStation labels; Amazon: labels bought in Seller Central and Veeqo (FBM)">Shipping labels</th><th title="Amazon referral (selling) fees">Referral fees</th><th title="Amazon FBA fulfillment fees">FBA fees</th><th title="Amazon promotions, refunds, storage, inbound and adjustments">Other fees</th><th title="Shopify Payments processing fees and chargeback fees (other gateways like PayPal aren't included)">Payment fees</th><th>Profit</th></tr></thead>
      <tbody>${CH.map(([k, n]) => row(n, T.t[k], k)).join("")}</tbody><tfoot>${row("All channels", a, null)}</tfoot>`;
  }
  // stacked bars: sales per day by channel (one y axis, dollars)
  function renderChart() {
    const host = $("ps-chart"); if (!host) return;
    const days = []; for (let d = P.start; d <= P.end; d = addDays(d, 1)) { days.push(d); if (days.length > 400) break; }
    if (days.length < 2) { host.innerHTML = ""; host.hidden = true; $("ps-legend").hidden = true; return; }
    host.hidden = false; $("ps-legend").hidden = false;
    const by = new Map(days.map(d => [d, { justtennis: 0, acenrally: 0, amazon: 0, gp: 0 }]));
    for (const r of P.days || []) { const x = by.get(r.day); if (x) { x[r.ch] = (x[r.ch] || 0) + r.net; x.gp += r.gp; } }
    const rows = days.map(d => ({ day: d, ...by.get(d) })), tot = (r) => r.justtennis + r.acenrally + r.amazon;
    const W = Math.max(320, host.clientWidth || 900), H = W < 560 ? 220 : 280, pad = { l: 58, r: 12, t: 14, b: 28 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, raw = Math.max(1, ...rows.map(tot));
    const mag = Math.pow(10, Math.floor(Math.log10(raw))), max = Math.ceil(raw / mag * 2) / 2 * mag;
    const y = (v) => pad.t + ih - (v / max) * ih, bw = iw / rows.length, w = Math.max(2, Math.min(28, bw * 0.7));
    const fmt = (v) => v >= 1e6 ? "$" + (v / 1e6).toFixed(1) + "M" : v >= 1000 ? "$" + Math.round(v / 1000) + "k" : "$" + Math.round(v);
    const every = Math.ceil(rows.length / Math.max(2, Math.floor(iw / 60)));
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sales per day by channel">`;
    for (const f of [0, .25, .5, .75, 1]) { const v = f * max; s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line-soft)" stroke-width="1"/><text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--faint)" font-family="var(--mono)">${fmt(v)}</text>`; }
    rows.forEach((r, i) => {
      const x = pad.l + i * bw + (bw - w) / 2; let base = 0;
      const segs = CH.map(([k]) => k).filter(k => r[k] > 0);
      segs.forEach((k, j) => {
        const v0 = base, v1 = base + r[k]; base = v1;
        const top = y(v1), h = Math.max(0, y(v0) - top - (j > 0 ? 2 : 0)), last = j === segs.length - 1, rr = last ? Math.min(4, w / 2, h) : 0;
        s += last ? `<path class="bar ch-${k}" d="M${x},${top + h} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + w - rr} Q${x + w},${top} ${x + w},${top + rr} V${top + h} Z"/>`
          : `<rect class="bar ch-${k}" x="${x}" y="${top}" width="${w}" height="${h}"/>`;
      });
      if (i % every === 0 || i === rows.length - 1) s += `<text x="${pad.l + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${shortDay(r.day)}</text>`;
    });
    rows.forEach((r, i) => { s += `<rect data-i="${i}" x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${ih}" fill="transparent"/>`; });
    s += `</svg><div class="tip" hidden></div>`;
    host.innerHTML = s;
    const tip = host.querySelector(".tip"), svg = host.querySelector("svg");
    svg.addEventListener("pointermove", (ev) => {
      const t = ev.target.closest("rect[data-i]"); if (!t) { tip.hidden = true; return; }
      const i = +t.dataset.i, r = rows[i], box = host.getBoundingClientRect(), sb = svg.getBoundingClientRect();
      tip.innerHTML = `<b>${wkDay(r.day)} ${shortDay(r.day)} · ${m0(tot(r))}</b><br>${CH.map(([k, n]) => `${n} ${m0(r[k])}`).join("<br>")}<br>Gross profit ${m0(r.gp)}`;
      tip.hidden = false;
      tip.style.left = Math.min(Math.max((pad.l + i * bw + bw / 2) * (sb.width / W), 90), box.width - 90) + "px";
      tip.style.top = (y(tot(r)) * (sb.height / H) - 8) + "px";
    });
    svg.addEventListener("pointerleave", () => { tip.hidden = true; });
  }
  function renderDays() {
    const by = new Map();
    for (const r of P.days || []) { const x = by.get(r.day) || { day: r.day, justtennis: 0, acenrally: 0, amazon: 0, net: 0, gp: 0, nocost: 0, orders: 0, labels: 0, fees: 0, profit: 0 }; x[r.ch] += r.net; x.net += r.net; x.gp += r.gp; x.nocost += r.nocost; x.orders += r.orders; x.labels += r.labels; x.fees += allFees(r); x.profit += r.profit; by.set(r.day, x); }
    const rows = [...by.values()].sort((a, b) => b.day.localeCompare(a.day));
    $("ps-days").innerHTML = `<thead><tr><th class="l">Day</th>${CH.map(([k, n]) => `<th>${sw(k)}${n}</th>`).join("")}<th>All sales</th><th>Orders</th><th>Gross profit</th><th>Shipping labels</th><th title="Amazon fees and Shopify payment fees">Fees</th><th>Profit</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td class="l">${wkDay(r.day)} ${shortDay(r.day)}</td>${CH.map(([k]) => `<td>${r[k] ? m(r[k]) : '<span class="dim">—</span>'}</td>`).join("")}<td><b>${m(r.net)}</b></td><td>${n0(r.orders)}</td><td class="${r.gp < 0 ? "neg" : ""}">${m(r.gp)}<div class="meta">${pct(marginOf(r))}</div></td><td>${r.labels ? m(r.labels) : '<span class="dim">—</span>'}</td><td>${r.fees ? m(r.fees) : '<span class="dim">—</span>'}</td><td class="${r.profit < 0 ? "neg" : ""}"><b>${m(r.profit)}</b></td></tr>`).join("") || '<tr><td class="l dim" colspan="10">No sales in this range.</td></tr>'}</tbody>`;
  }
  function renderProducts() {
    const q = P.q.trim().toLowerCase(), key = { net: (p) => p.net, gp: (p) => p.gp, profit: (p) => p.gp - p.fees, units: (p) => p.units }[P.sort] || ((p) => p.net);
    const list = (P.prods || []).filter(p => !q || (p.title + " " + p.vendor).toLowerCase().includes(q)).sort((a, b) => key(b) - key(a));
    const tot = (P.prods || []).reduce((t, p) => t + p.net, 0) || 1;
    const ADM = "https://admin.shopify.com/store/justtennis-822/products/";
    const cell = (p, k) => { const b = p.by[k]; return b && (b.net || b.units) ? `<td>${m0(b.net)}<div class="meta">${n0(b.units)} units</div></td>` : '<td class="dim">—</td>'; };
    $("ps-prods").innerHTML = `<thead><tr><th class="l">Product</th>${CH.map(([k, n]) => `<th>${sw(k)}${n}</th>`).join("")}<th>All sales</th><th class="l">Share</th><th>Units</th><th>Gross profit</th><th title="Amazon referral and FBA fees and promotions on these sales">Amazon fees</th><th title="Gross profit less Amazon fees; shipping labels aren't split by product">After fees</th></tr></thead>
      <tbody>${list.slice(0, P.limit).map(p => `<tr><td class="l">${p.pid ? `<a class="olink" href="${ADM}${encodeURIComponent(p.pid)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : `${esc(p.title)} <span class="pill miss" title="Not matched to a Just Tennis product">not mapped</span>`}<div class="meta">${esc(p.vendor)}</div></td>
        ${CH.map(([k]) => cell(p, k)).join("")}<td><b>${m(p.net)}</b></td>
        <td class="l"><span class="sharecell"><span class="sharebar"><i style="width:${Math.max(0, Math.min(100, p.net / tot * 100)).toFixed(1)}%"></i></span><span class="dim small">${pct(p.net / tot)}</span></span></td>
        <td>${n0(p.units)}</td><td class="${p.gp < 0 ? "neg" : ""}">${m(p.gp)}<div class="meta">${p.net > 0 ? pct(p.gp / p.net) : "—"}</div></td>
        <td>${Math.abs(p.fees) >= 0.005 ? `<span class="neg">−${m(Math.abs(p.fees))}</span>` : '<span class="dim">—</span>'}</td>
        <td class="${p.gp - p.fees < 0 ? "neg" : ""}"><b>${m(p.gp - p.fees)}</b><div class="meta">${p.net > 0 ? pct((p.gp - p.fees) / p.net) : "—"}</div></td></tr>`).join("") || '<tr><td class="l dim" colspan="10">No products match.</td></tr>'}</tbody>`;
    $("ps-more").innerHTML = list.length > P.limit ? `<button class="btn" data-more>Show ${Math.min(50, list.length - P.limit)} more</button> <span class="muted small">${P.limit} of ${n0(list.length)} products</span>` : `<span class="muted small">${n0(list.length)} product${list.length === 1 ? "" : "s"}</span>`;
  }
  function render() {
    if ($("tab-psales").hidden) return;
    const st = $("ps-status"), note = $("ps-note");
    if (P.err) { st.textContent = ""; note.hidden = false; note.innerHTML = `<div class="note bad">${esc(window.JT.message(P.err))}</div>`; return; }
    note.hidden = true;
    if (!P.days) { st.textContent = "Loading sales…"; return; }
    st.textContent = `${window.JTRange.label(P.start, P.end)} · Amazon by order date, after Amazon fees (unshipped orders estimated) · Ace n Rally at Just Tennis cost${P.loading ? " · refreshing…" : ""}`;
    const T = totals();
    renderKpis(T); renderChannels(T); renderChart(); renderDays(); renderProducts();
  }
  // ---------- cost watch ----------
  const ADM = "https://admin.shopify.com/store/justtennis-822/";
  const CW = { alerts: [], log: [], catalog: null, ready: false, db: null, showAllNo: false, showAllAbove: false, set: { historyStart: null, overrides: {} }, saving: false };
  const effDate = (d) => addDays(d, 1);
  const isReal = (date, vid) => { const ov = (CW.set.overrides || {})[date + "|" + vid]; return ov ? ov === "real" : !!(CW.set.historyStart && date >= CW.set.historyStart); };
  async function saveSet(patch) {
    if (!CW.db || CW.saving) return; CW.saving = true; renderCW();
    const next = { historyStart: CW.set.historyStart || null, overrides: { ...(CW.set.overrides || {}) }, ...patch, updatedAt: new Date().toISOString() };
    try { await CW.db.doc("settings/costs").set(next); CW.set = next; } catch (e) { const b = $("cw-hist"); if (b) b.insertAdjacentHTML("beforeend", '<div class="note bad">Couldn\'t save that setting. Try again.</div>'); }
    CW.saving = false; renderCW();
  }
  const prodLink = (pid, vid, text) => pid ? `<a class="olink" href="${ADM}products/${encodeURIComponent(pid)}${vid ? "/variants/" + encodeURIComponent(vid) : ""}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text);
  const orderLink = (name) => `<a class="olink mono" href="${ADM}orders?query=${encodeURIComponent(name)}" target="_blank" rel="noopener">${esc(name)}</a>`;
  const dshort = (ds) => new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  function renderCW() {
    if ($("tab-psales").hidden) return;
    const box = $("cw-alert"), tbl = $("cw-changes");
    if (!CW.db) { box.innerHTML = '<div class="note info">Cost watch needs the database. Reload the page, or sign in again.</div>'; tbl.innerHTML = ""; return; }
    if (!CW.ready) { box.innerHTML = '<div class="skel">Loading…</div>'; return; }
    const a = CW.alerts[0];
    if (!a) { box.innerHTML = '<div class="note info">No daily check has run yet. The first one runs tomorrow morning.</div>'; }
    else {
      $("cw-sub").textContent = `Last check ${dshort(a.date)}${CW.catalog ? " · " + (CW.catalog.variants || 0).toLocaleString() + " variants checked" : ""} · ${CW.alerts.length} day${CW.alerts.length > 1 ? "s" : ""} on record`;
      const miss = (a.missing || []).map(x => `<tr><td class="l">${prodLink(x.pid, x.vid, x.title)}${x.sku ? ` <span class="mono dim small">${esc(x.sku)}</span>` : ""}</td><td>${x.units}</td><td class="neg">${m(x.amount)}</td><td class="l">${(x.orders || []).map(orderLink).join(", ") || '<span class="dim">—</span>'}</td></tr>`).join("");
      const cat = CW.catalog || {};
      const noList = (cat.noCost || []).slice(0, CW.showAllNo ? 1500 : 12).map(x => `<tr><td class="l">${prodLink(x.pid, x.vid, x.title)}${x.sku ? ` <span class="mono dim small">${esc(x.sku)}</span>` : ""}</td><td>${x.price != null ? m(x.price) : "—"}</td></tr>`).join("");
      const aboveCat = (cat.abovePrice || []).slice(0, CW.showAllAbove ? 500 : 12).map(x => `<tr><td class="l">${prodLink(x.pid, x.vid, x.title)}${x.sku ? ` <span class="mono dim small">${esc(x.sku)}</span>` : ""}</td><td class="neg">${m(x.cost)}</td><td>${m(x.price)}</td></tr>`).join("");
      const above = (a.above || []).map(x => `<tr><td class="l">${prodLink(x.pid, x.vid, x.title)}${x.sku ? ` <span class="mono dim small">${esc(x.sku)}</span>` : ""}</td><td>${m(x.cost)}</td><td>${m(x.price)}</td></tr>`).join("");
      const az = a.amazon || {};
      box.innerHTML = `<div class="cwgrid">
        <div class="cwcard ${a.missingTotal ? "warn" : "ok"}"><span class="eyebrow">Sold with no cost · ${dshort(a.date)}</span><span class="v">${a.missingTotal ? m(a.missingTotal) : "None"}</span>${miss ? `<div class="tbl-wrap"><table class="lines"><thead><tr><th class="l">Product</th><th>Units</th><th>Sales</th><th class="l">Orders</th></tr></thead><tbody>${miss}</tbody></table></div><span class="muted small">Set the cost in Shopify for future sales, and use Enter cost on the Shopify tab for these orders.</span>` : '<span class="muted small">Every item sold had a product cost.</span>'}</div>
        <div class="cwcard ${cat.noCostCount ? "warn" : "ok"}"><span class="eyebrow">Products with no cost in Shopify</span><span class="v">${cat.noCostCount != null ? (cat.noCostCount || "None") : "…"}</span>${noList ? `<div class="tbl-wrap"><table class="lines"><thead><tr><th class="l">Variant</th><th>Price</th></tr></thead><tbody>${noList}</tbody></table></div>${cat.noCostCount > 12 ? `<button class="mini" data-cw="no">${CW.showAllNo ? "Show fewer" : "Show all " + cat.noCostCount}</button>` : ""}<span class="muted small">Every sale of these will be missing a cost until one is set.</span>` : '<span class="muted small">Every variant in the catalog has a cost.</span>'}</div>
        <div class="cwcard ${cat.abovePriceCount ? "warn" : "ok"}"><span class="eyebrow">Cost higher than selling price</span><span class="v">${cat.abovePriceCount != null ? (cat.abovePriceCount || "None") : "…"}</span>${aboveCat ? `<div class="tbl-wrap"><table class="lines"><thead><tr><th class="l">Variant</th><th>Cost</th><th>Price</th></tr></thead><tbody>${aboveCat}</tbody></table></div>${cat.abovePriceCount > 12 ? `<button class="mini" data-cw="above">${CW.showAllAbove ? "Show fewer" : "Show all " + cat.abovePriceCount}</button>` : ""}<span class="muted small">Usually a case or pack cost entered on a single-unit variant. Biggest gaps first.</span>` : '<span class="muted small">No variant costs more than its price.</span>'}</div>
        <div class="cwcard ${az.unmappedSkus ? "warn" : "ok"}"><span class="eyebrow">Amazon listings not mapped${az.month ? " · " + esc(az.month) : ""}</span><span class="v">${az.unmappedSkus ? az.unmappedSkus.toLocaleString() : "None"}</span><span class="muted small">${az.unmappedSkus ? m(az.unmappedSales) + " of sales without a product cost." : "Every Amazon listing that sold has a cost."}</span>${az.unmappedSkus ? '<button class="mini" data-go-map>Open Amazon mapping</button>' : ""}</div>
      </div>`;
    }
    const hs = CW.set.historyStart;
    const status = hs
      ? `<div class="histbar on"><span><b>Cost history is on for edits made from ${dshort(hs)}.</b> Those changes keep the old cost for earlier Amazon sales. Edits before that date count as corrections, so Amazon history uses the corrected Shopify cost.</span><span class="dbtns"><button class="mini" data-hist="today">Restart from tomorrow</button><button class="mini" data-hist="off">Turn off</button></span></div>`
      : `<div class="histbar"><span><b>Cleanup mode:</b> every cost edit counts as a correction, so Amazon profit uses today's Shopify cost for all past sales. When your costs are clean, turn on cost history so future price changes only apply from the day they happen.</span><span class="dbtns"><button class="mini primary" data-hist="today" ${CW.saving ? "disabled" : ""}>Costs are clean — track changes from tomorrow</button></span></div>`;
    const rows = [];
    for (const d of CW.log) for (const c of d.changes || []) rows.push({ ...c, date: d.date });
    $("cw-hist").innerHTML = status;
    tbl.innerHTML = `<thead><tr><th class="l">Date</th><th class="l">Product</th><th class="l">SKU</th><th>Old cost</th><th>New cost</th><th>Change</th><th class="l">Treated as</th><th class="l"></th></tr></thead><tbody>${rows.slice(0, 300).map(c => { const real = isReal(c.date, c.vid); const ov = (CW.set.overrides || {})[c.date + "|" + c.vid]; return `<tr><td class="l">${dshort(c.date)}</td><td class="l">${prodLink(c.pid, c.vid, c.title)}</td><td class="l mono dim small">${esc(c.sku || "")}</td><td>${c.old == null ? "—" : m(c.old)}</td><td><b>${c.new == null ? "—" : m(c.new)}</b></td><td class="${c.pct > 0 ? "neg" : c.pct < 0 ? "pos" : "dim"}">${c.pct == null ? "—" : (c.pct > 0 ? "+" : "") + pct(c.pct)}</td><td class="l"><button class="pill ${real ? "web" : "pos"} tog" data-ov="${esc(c.date + "|" + c.vid)}" data-real="${real ? 1 : 0}" title="${real ? "Earlier Amazon sales keep the old cost. Click to treat as a correction instead." : "Applies to all past Amazon sales. Click to treat as a real price change instead."}">${real ? "Real change" : "Correction"}${ov ? " ·" : ""}</button></td><td class="l">${c.flag ? `<span class="pill miss">${esc(c.flag)}</span>` : ""}</td></tr>`; }).join("") || `<tr><td class="l dim" colspan="8">No cost changes recorded yet.</td></tr>`}</tbody>`;
  }
  $("cw").addEventListener("click", (ev) => {
    const h = ev.target.closest("[data-hist]"); if (h) { saveSet({ historyStart: h.dataset.hist === "off" ? null : addDays(today(), 1) }); return; }
    const o = ev.target.closest("[data-ov]"); if (o) { const ov = { ...(CW.set.overrides || {}) }; ov[o.dataset.ov] = o.dataset.real === "1" ? "correction" : "real"; saveSet({ overrides: ov }); return; }
    const t = ev.target.closest("[data-cw]"); if (t) { if (t.dataset.cw === "no") CW.showAllNo = !CW.showAllNo; else CW.showAllAbove = !CW.showAllAbove; renderCW(); return; } if (ev.target.closest("[data-go-map]")) { const b = document.querySelector('.tabs button[data-tab="amzmap"]'); if (b) b.click(); } });

  window.psRender = () => { render(); renderCW(); };

  // ---------- events ----------
  document.querySelectorAll("#ps-rangeseg button").forEach(b => b.addEventListener("click", () => { setRange(b.dataset.r); load(false); }));
  const onDate = () => { const s = $("ps-start").value, e = $("ps-end").value; if (!s || !e || s > e) return; P.start = s; P.end = e; document.querySelectorAll("#ps-rangeseg button").forEach(b => b.setAttribute("aria-pressed", "false")); load(false); };
  $("ps-start").addEventListener("change", onDate); $("ps-end").addEventListener("change", onDate);
  $("ps-refresh").addEventListener("click", () => load(true));
  let qt; $("ps-q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => { P.q = e.target.value; P.limit = 50; renderProducts(); }, 200); });
  $("ps-sort").addEventListener("change", (e) => { P.sort = e.target.value; renderProducts(); });
  $("ps-more").addEventListener("click", (e) => { if (e.target.closest("[data-more]")) { P.limit += 50; renderProducts(); } });
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (!$("tab-psales").hidden && P.days) renderChart(); }, 150); });

  setRange("today");
  window.JT.docStore().then(db => {
    CW.db = db; if (!db) { renderCW(); return; }
    let n = 0; const done = () => { if (++n >= 3) CW.ready = true; renderCW(); };
    db.doc("settings/costs").onSnapshot(d => { CW.set = d.exists ? { historyStart: null, overrides: {}, ...d.data() } : { historyStart: null, overrides: {} }; renderCW(); }, () => {});
    db.doc("costs/catalog").onSnapshot(d => { CW.catalog = d.exists ? d.data() : null; done(); }, done);
    db.collection("costalerts").orderBy("date", "desc").limit(14).onSnapshot(s => { CW.alerts = s.docs.map(d => d.data()); done(); }, done);
    db.collection("costlog").orderBy("date", "desc").limit(90).onSnapshot(s => { CW.log = s.docs.map(d => d.data()); done(); }, done);
  }).catch(() => {});
  window.JT.getMcp().then(() => load(false)).catch(() => load(false));
})();
