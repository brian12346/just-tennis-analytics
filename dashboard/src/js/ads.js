// Sales › Ads (Brian, Oct 15): Google Ads for Just Tennis and Ace n Rally in one place — spend, Google's conversion
// value and ROAS by campaign, compared with the period before, next to each store's sales and profit after ads.
// Data: jt.google_ads_daily (the "Seller Sage - ad spend" script in each Google Ads account posts hourly, migration
// 105) and jt.mv_sales_channels_daily (store sales, profit after ads). Conversion value is Google's own attribution,
// so it can overlap between campaigns and differ from Shopify sales: the store-level "ads as % of sales" is the check.
(() => {
  const $ = (id) => document.getElementById(id);
  if (!$("tab-ads")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const m0 = (n) => usd0.format(n || 0), m2 = (n) => usd2.format(n || 0);
  const n0 = (x) => Math.round(x || 0).toLocaleString();
  const pct = (n) => isFinite(n) ? (n * 100).toFixed(1) + "%" : "—";
  const roasT = (v, c) => c > 0 ? (v / c).toFixed(1) + "×" : "—";
  const addDays = window.JTDate.addDays;
  const shortDay = (ds) => new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const wkDay = (ds) => new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const ST = [["justtennis", "Just Tennis"], ["acenrally", "Ace n Rally"]], SNAME = Object.fromEntries(ST);
  const TYPE = { PERFORMANCE_MAX: "PMax", SHOPPING: "Shopping", SEARCH: "Search", DISPLAY: "Display", VIDEO: "Video", DEMAND_GEN: "Demand Gen", DISCOVERY: "Discovery" };
  const A = { start: null, end: null, preset: "30", store: "all", sort: "spend", camps: null, prev: null, days: null, sales: null, sync: null, err: null, loading: false, req: 0 };

  window.JTRange.seg("ad-rangeseg", "r");
  function setRange(r) {
    A.preset = r; [A.start, A.end] = window.JTRange.of(r);
    $("ad-start").value = A.start; $("ad-end").value = A.end;
    document.querySelectorAll("#ad-rangeseg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.r === r)));
  }
  const spanDays = () => Math.round((Date.parse(A.end) - Date.parse(A.start)) / 864e5) + 1;

  async function load(refresh) {
    const JT = window.JT, id = ++A.req; A.loading = true; A.err = null; render();
    const n = spanDays(), p1 = addDays(A.start, -1), p0 = addDays(A.start, -n);
    const W = (a, b) => `where day between ${JT.day(a)} and ${JT.day(b)}`;
    const C = ["store", "campaign_id", "max(campaign)", "max(channel_type)", "sum(cost)", "sum(clicks)", "sum(impressions)", "sum(conversions)", "sum(conv_value)", "max(day)::text"];
    try {
      const [camps, prev, days, sales, sync] = await Promise.all([
        JT.rows(C, `from jt.google_ads_daily ${W(A.start, A.end)} group by store, campaign_id`, refresh),
        JT.rows(["store", "campaign_id", "sum(cost)", "sum(conv_value)"], `from jt.google_ads_daily ${W(p0, p1)} group by store, campaign_id`, refresh),
        JT.rows(["day::text", "store", "sum(cost)", "sum(conv_value)"], `from jt.google_ads_daily ${W(A.start, A.end)} group by day, store order by day`, refresh),
        JT.rows(["channel", "sum(net_sales)", "sum(profit)", "sum(ad_spend)", "sum(gross_profit)"], `from jt.mv_sales_channels_daily ${W(A.start, A.end)} and channel in ('justtennis', 'acenrally') group by channel`, refresh),
        JT.rows(["value::text"], "from jt.settings where key = 'google_ads'", refresh).catch(() => []),
      ]);
      if (id !== A.req) return;
      A.camps = camps.map(x => ({ store: x[0], id: x[1], name: x[2] || "(no name)", type: x[3] || "", cost: +x[4] || 0, clicks: +x[5] || 0, impr: +x[6] || 0, conv: +x[7] || 0, val: +x[8] || 0, last: x[9] || "" }));
      A.prev = new Map(prev.map(x => [x[0] + "|" + x[1], { cost: +x[2] || 0, val: +x[3] || 0 }]));
      A.days = days.map(x => ({ day: x[0], store: x[1], cost: +x[2] || 0, val: +x[3] || 0 }));
      A.sales = Object.fromEntries(sales.map(x => [x[0], { net: +x[1] || 0, profit: +x[2] || 0, ads: +x[3] || 0, gp: +x[4] || 0 }]));
      try { A.sync = sync[0] && sync[0][0] ? JSON.parse(sync[0][0]) : null; } catch (_) { A.sync = null; }
    } catch (e) { if (id === A.req) { A.err = e; A.camps = null; } }
    if (id === A.req) { A.loading = false; render(); }
  }

  const inStore = (s) => A.store === "all" || s === A.store;
  function render() {
    const st = $("ad-status");
    if (A.err) { st.textContent = "Couldn't load ads: " + (window.JT.message ? window.JT.message(A.err) : A.err.message); return; }
    if (!A.camps) { st.textContent = A.loading ? "Loading ads…" : ""; return; }
    const syncs = A.sync ? ST.filter(([k]) => A.sync[k]).map(([k, nm]) => `${nm} ${new Date(A.sync[k].at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`) : [];
    st.textContent = `${window.JTRange.label(A.start, A.end)} · Google Ads${syncs.length ? " · updated " + syncs.join(" · ") : " · no data yet"}${A.loading ? " · refreshing…" : ""}`;
    renderKpis(); renderChart(); renderCamps();
  }
  function totals() {
    const t = { cost: 0, val: 0, clicks: 0, conv: 0, pcost: 0, pval: 0, net: 0, profit: 0 };
    for (const c of A.camps) if (inStore(c.store)) { t.cost += c.cost; t.val += c.val; t.clicks += c.clicks; t.conv += c.conv; }
    for (const [k, p] of A.prev) if (inStore(k.split("|")[0])) { t.pcost += p.cost; t.pval += p.val; }
    for (const [k] of ST) if (inStore(k) && A.sales[k]) { t.net += A.sales[k].net; t.profit += A.sales[k].profit; }
    return t;
  }
  const delta = (cur, prev, money) => {
    if (!prev) return cur ? '<span class="dim">new</span>' : "";
    const d = (cur - prev) / prev; return `<span class="${d > 0.005 ? "up" : d < -0.005 ? "down" : "dim"}">${d > 0 ? "+" : ""}${(d * 100).toFixed(0)}%</span>${money ? ` <span class="dim">vs ${m0(prev)}</span>` : ""}`;
  };
  function renderKpis() {
    const t = totals(), losing = A.camps.filter(c => inStore(c.store) && c.cost > 0 && c.val < c.cost), lose = losing.reduce((s, c) => s + c.cost, 0);
    const k = [
      { c: "sales", l: "Ad spend", v: m0(t.cost), s: `${delta(t.cost, t.pcost, true)} · previous ${spanDays()} days${A.store === "all" ? " · " + ST.map(([k2, nm]) => `${nm} ${m0(A.camps.filter(c => c.store === k2).reduce((s, c) => s + c.cost, 0))}`).join(" · ") : ""}` },
      { l: "Conversion value", v: m0(t.val), s: `Google's attribution · ${n0(t.conv)} conversions · ${n0(t.clicks)} clicks · ${t.clicks ? m2(t.cost / t.clicks) : "—"} a click` },
      { l: "ROAS", v: roasT(t.val, t.cost), s: `conversion value ÷ spend · was ${roasT(t.pval, t.pcost)}` },
      { l: "Ads % of store sales", v: t.net ? pct(t.cost / t.net) : "—", s: `${m0(t.net)} store sales (Shopify, all orders)${t.cost && t.net ? " · $" + (t.net / t.cost).toFixed(1) + " of sales per ad dollar" : ""}` },
      { c: "sales", l: "Profit after ads", v: `<span class="${t.profit < 0 ? "neg" : ""}">${m0(t.profit)}</span>`, s: `${t.net ? pct(t.profit / t.net) : "—"} of sales · after product cost, shipping, fees and ads` },
      { l: "Spending more than it returns", v: `<span class="${lose ? "neg" : ""}">${m0(lose)}</span>`, s: losing.length ? `${losing.length} campaign${losing.length === 1 ? "" : "s"} under 1× ROAS: ${losing.sort((a, b) => b.cost - a.cost).slice(0, 3).map(c => esc(c.name)).join(", ")}${losing.length > 3 ? "…" : ""}` : "every campaign returns at least its spend" },
    ];
    $("ad-kpis").innerHTML = k.map(x => `<div class="kpi ${x.c || ""}"><span class="eyebrow">${x.l}</span><span class="v">${x.v}</span><span class="s">${x.s}</span></div>`).join("");
  }
  function renderChart() {
    const host = $("ad-chart");
    const days = []; for (let d = A.start; d <= A.end; d = addDays(d, 1)) { days.push(d); if (days.length > 400) break; }
    if (days.length < 2) { host.innerHTML = ""; host.hidden = true; $("ad-legend").hidden = true; return; }
    host.hidden = false; $("ad-legend").hidden = false;
    const by = new Map(days.map(d => [d, { justtennis: 0, acenrally: 0, val: 0 }]));
    for (const r of A.days) { const x = by.get(r.day); if (x && inStore(r.store)) { x[r.store] += r.cost; x.val += r.val; } }
    const rows = days.map(d => ({ day: d, ...by.get(d) })), tot = (r) => r.justtennis + r.acenrally;
    const W = Math.max(320, host.clientWidth || 900), H = W < 560 ? 180 : 220, pad = { l: 52, r: 12, t: 12, b: 26 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, raw = Math.max(1, ...rows.map(tot));
    const mag = Math.pow(10, Math.floor(Math.log10(raw))), max = Math.ceil(raw / mag * 2) / 2 * mag;
    const y = (v) => pad.t + ih - (v / max) * ih, bw = iw / rows.length, w = Math.max(2, Math.min(22, bw * 0.7));
    const fmt = (v) => v >= 1000 ? "$" + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k" : "$" + Math.round(v);
    const every = Math.ceil(rows.length / Math.max(2, Math.floor(iw / 60)));
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ad spend per day by store">`;
    for (const f of [0, .5, 1]) { const v = f * max; s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line-soft)"/><text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--faint)" font-family="var(--mono)">${fmt(v)}</text>`; }
    rows.forEach((r, i) => {
      const x = pad.l + i * bw + (bw - w) / 2; let base = 0;
      for (const [k] of ST) { if (!r[k]) continue; const top = y(base + r[k]), h = Math.max(0, y(base) - top); base += r[k]; s += `<rect class="bar ch-${k}" x="${x}" y="${top}" width="${w}" height="${h}" rx="${Math.min(3, w / 3)}"/>`; }
      if (i % every === 0 || i === rows.length - 1) s += `<text x="${pad.l + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${shortDay(r.day)}</text>`;
    });
    rows.forEach((r, i) => { s += `<rect data-i="${i}" x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${ih}" fill="transparent"/>`; });
    host.innerHTML = s + `</svg><div class="tip" hidden></div>`;
    const tip = host.querySelector(".tip"), svg = host.querySelector("svg");
    svg.addEventListener("pointermove", (ev) => {
      const t = ev.target.closest("rect[data-i]"); if (!t) { tip.hidden = true; return; }
      const i = +t.dataset.i, r = rows[i], box = host.getBoundingClientRect(), sb = svg.getBoundingClientRect();
      tip.innerHTML = `<b>${wkDay(r.day)} ${shortDay(r.day)} · ${m0(tot(r))} spend</b><br>${ST.filter(([k]) => inStore(k)).map(([k, nm]) => `${nm} ${m0(r[k])}`).join("<br>")}<br>Conversion value ${m0(r.val)} · ROAS ${roasT(r.val, tot(r))}`;
      tip.hidden = false;
      tip.style.left = Math.min(Math.max((pad.l + i * bw + bw / 2) * (sb.width / W), 100), box.width - 100) + "px";
      tip.style.top = (y(tot(r)) * (sb.height / H) - 8) + "px";
    });
    svg.addEventListener("pointerleave", () => { tip.hidden = true; });
  }
  function roasCell(v, c) {
    if (!c) return '<span class="dim">—</span>';
    const r = v / c; return `<span class="roas ${r < 1 ? "bad" : r < 3 ? "mid" : "good"}">${r.toFixed(1)}×</span>`;
  }
  function renderCamps() {
    const SORTS = { spend: (a, b) => b.cost - a.cost, roas: (a, b) => (b.cost ? b.val / b.cost : -1) - (a.cost ? a.val / a.cost : -1), worst: (a, b) => (a.cost ? a.val / a.cost : 99) - (b.cost ? b.val / b.cost : 99) || b.cost - a.cost, value: (a, b) => b.val - a.val };
    // campaigns with spend in the range, plus ones that only spent in the period before (stopped)
    const list = A.camps.filter(c => inStore(c.store) && (c.cost > 0 || c.val > 0));
    const stopped = [...A.prev].filter(([k, p]) => p.cost > 0 && inStore(k.split("|")[0]) && !A.camps.some(c => c.store + "|" + c.id === k && c.cost > 0)).length;
    list.sort(SORTS[A.sort] || SORTS.spend);
    const t = totals();
    const row = (c) => {
      const p = A.prev.get(c.store + "|" + c.id) || { cost: 0, val: 0 };
      return `<tr class="${c.cost > 0 && c.val < c.cost ? "lose" : ""}"><td class="l"><b>${esc(c.name)}</b><div class="meta"><i class="chsw ch-${c.store}" aria-hidden="true"></i>${esc(SNAME[c.store] || c.store)} · ${esc(TYPE[c.type] || c.type.toLowerCase())}${c.cost === 0 ? " · no spend" : ""}</div></td>
        <td>${m0(c.cost)}<div class="meta">${t.cost ? pct(c.cost / t.cost) + " of spend" : ""}</div></td>
        <td>${delta(c.cost, p.cost)}</td>
        <td>${n0(c.clicks)}<div class="meta">${c.clicks ? m2(c.cost / c.clicks) + " a click" : ""}</div></td>
        <td>${c.conv ? (c.conv < 10 ? c.conv.toFixed(1) : n0(c.conv)) : '<span class="dim">0</span>'}<div class="meta">${c.conv ? m2(c.cost / c.conv) + " each" : ""}</div></td>
        <td>${m0(c.val)}</td>
        <td>${roasCell(c.val, c.cost)}</td>
        <td>${p.cost ? roasCell(p.val, p.cost) : '<span class="dim">—</span>'}</td></tr>`;
    };
    $("ad-camps").innerHTML = `<thead><tr><th class="l">Campaign</th><th>Spend</th><th>vs before</th><th>Clicks</th><th>Conversions</th><th>Conv. value</th><th>ROAS</th><th>ROAS before</th></tr></thead>
      <tbody>${list.map(row).join("") || `<tr><td class="l muted" colspan="8">No ad spend in this range${A.store !== "all" ? " for " + esc(SNAME[A.store]) : ""}.</td></tr>`}</tbody>
      ${list.length ? `<tfoot><tr><td class="l"><b>Total</b> <span class="meta">${list.length} campaign${list.length === 1 ? "" : "s"}</span></td><td>${m0(t.cost)}</td><td>${delta(t.cost, t.pcost)}</td><td>${n0(t.clicks)}</td><td>${n0(t.conv)}</td><td>${m0(t.val)}</td><td>${roasCell(t.val, t.cost)}</td><td>${t.pcost ? roasCell(t.pval, t.pcost) : ""}</td></tr></tfoot>` : ""}`;
    $("ad-foot").innerHTML = `Before = the ${spanDays()} days before this range. ROAS under 1× is shaded: the campaign spent more than Google says it brought back.${stopped ? ` ${stopped} campaign${stopped === 1 ? "" : "s"} spent before but not in this range.` : ""}`;
  }

  window.adsShow = () => { if (!A.camps && !A.loading) load(false); else render(); };
  document.querySelectorAll("#ad-rangeseg button").forEach(b => b.addEventListener("click", () => { setRange(b.dataset.r); load(false); }));
  const onDate = () => { const s = $("ad-start").value, e = $("ad-end").value; if (!s || !e || s > e) return; A.start = s; A.end = e; document.querySelectorAll("#ad-rangeseg button").forEach(b => b.setAttribute("aria-pressed", "false")); load(false); };
  $("ad-start").addEventListener("change", onDate); $("ad-end").addEventListener("change", onDate);
  $("ad-refresh").addEventListener("click", () => load(true));
  $("ad-store").addEventListener("click", (e) => { const b = e.target.closest("[data-st]"); if (!b) return; A.store = b.dataset.st; document.querySelectorAll("#ad-store button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); if (A.camps) render(); });
  $("ad-sort").addEventListener("change", (e) => { A.sort = e.target.value; if (A.camps) renderCamps(); });
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (!$("tab-ads").hidden && A.camps) renderChart(); }, 150); });
  setRange("30");
})();
