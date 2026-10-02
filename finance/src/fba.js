// FBA forecast page: per ASIN, the next 26 weeks of Amazon sales, when FBA stock (and all stock: FBA + inbound + AWD +
// prep center) runs out, and what it costs to stock up.
//
// Forecast = recent pace × seasonality. Recent pace = units in the last 8 weeks / 8. Seasonality for week k = last
// year's units in that week / last year's weekly average over the same 8 weeks (364 days back, so weekdays line up).
// When an ASIN sold steadily last year that's simply "last year's same weeks × this year's trend". When its own
// history is thin or broken (out of stock last year, or new), its brand's seasonality (or the whole catalog's) fills in.
// Data: jt.fba_demand (units per ASIN), jt.v_asin_stock (FBA from the Amazon API hourly, AWD from the uploaded report,
// prep center), jt.v_asin_cost (Shopify cost of the mapped variant × units). Settings in fin.settings 'fba'.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const money = (v) => (v < 0 ? "−" : "") + "$" + Math.abs(Math.round(Number(v) || 0)).toLocaleString("en-US");
  const short = (v) => { const a = Math.abs(v); return a >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : a >= 1e4 ? "$" + Math.round(v / 1e3) + "K" : a >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "K" : money(v); };
  const n0 = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");
  const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + Math.round(n)); return d.toISOString().slice(0, 10); };
  const dnum = (s) => Math.round(new Date(s + "T12:00:00Z").getTime() / 86400000);
  const fmtD = (s) => s ? new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
  const WEEKS = 26;
  const OWN_MIN = 24;      // last year's 8-week units an ASIN needs before its own seasonality counts at all
  const OWN_FULL = 150;    // ... and to count as much as it can
  const OWN_MAX = 0.8;     // an ASIN's own pattern is noisy: its brand always keeps at least 20%
  const STOCKOUT = 0.3;    // a week last year below 30% of what the brand's pattern says = probably out of stock
  const GROUP_MIN = 150;   // a brand needs this many units in last year's 8 weeks for its own seasonality

  const S = { rows: [], loaded: false, loading: false, err: null, q: "", view: "all", sort: ["runAll", 1], open: new Set(), shown: 150,
    cfg: { cover_weeks: 12, lead_weeks: 4 }, synced: null };

  async function load(refresh) {
    S.loading = true; render();
    try {
      const [dem, st, co, set, sy] = await Promise.all([
        FIN.sql("select * from jt.fba_demand(26)", refresh),
        FIN.sql("select * from jt.v_asin_stock", refresh),
        FIN.sql("select asin, unit_cost, vendor, title from jt.v_asin_cost", refresh),
        FIN.sql("select value from fin.settings where key = 'fba'", refresh),
        FIN.sql("select value from jt.settings where key = 'fba_inventory'", refresh),
      ]);
      S.cfg = { cover_weeks: 12, lead_weeks: 4, ...((set[0] || {}).value || {}) };
      S.synced = ((sy[0] || {}).value || {}).synced_at || null;
      build(dem, st, co);
      S.err = null; S.loaded = true;
    } catch (e) { S.err = e; }
    S.loading = false; render();
  }

  // ---------- the model ----------
  function smooth(a) { return a.map((v, i) => { const p = a[i - 1] ?? v, n = a[i + 1] ?? v; return 0.25 * p + 0.5 * v + 0.25 * n; }); }
  function build(dem, st, co) {
    const cost = new Map(co.map(c => [c.asin, c]));
    const stock = new Map(st.map(s => [s.asin, s]));
    const demand = new Map(dem.map(d => [d.asin, d]));
    const vendorOf = (a) => ((stock.get(a) || {}).vendor || (cost.get(a) || {}).vendor || "").trim();
    // seasonality for every brand and for everything: week k / (last year's 8-week units / 8)
    const groups = new Map(); const all = { ly8: 0, w: new Array(WEEKS).fill(0) };
    for (const d of dem) {
      const v = vendorOf(d.asin) || "—";
      if (!groups.has(v)) groups.set(v, { ly8: 0, w: new Array(WEEKS).fill(0) });
      const g = groups.get(v);
      g.ly8 += d.ly8; all.ly8 += d.ly8;
      (d.ly_weeks || []).forEach((u, k) => { g.w[k] += u; all.w[k] += u; });
    }
    const idx = (g) => g.w.map(u => g.ly8 > 0 ? u / (g.ly8 / 8) : 1);
    const allIdx = all.ly8 > 0 ? smooth(idx(all)) : new Array(WEEKS).fill(1);
    const groupIdx = new Map([...groups].map(([v, g]) => [v, g.ly8 >= GROUP_MIN ? smooth(idx(g)) : null]));
    S.overallTrend = all.ly8 > 0 ? dem.reduce((a, d) => a + d.r8, 0) / all.ly8 : null;

    const rows = [];
    for (const s of st) {
      const d = demand.get(s.asin) || { u30: 0, r8: 0, ly8: 0, r8_fba: 0, u365: 0, last_sale: null, ly_weeks: new Array(WEEKS).fill(0) };
      const fbaNow = s.fba_available + s.fba_transfer, pipe = fbaNow + s.fba_inbound + s.awd + s.prep;
      if (pipe <= 0 && d.u365 <= 0) continue;                       // an old FBA listing with nothing going on
      const c = cost.get(s.asin) || {};
      const vendor = vendorOf(s.asin);
      const gIdx = groupIdx.get(vendor || "—") || allIdx, gName = groupIdx.get(vendor || "—") ? vendor + "'s" : "all products'";
      // own seasonality, with last year's stockouts (weeks far below the brand's pattern) and spikes replaced
      // Its own index for week k = last year's units / its baseline, where the baseline is last year's weekly level
      // measured against the brand's pattern over all 34 weeks (the 8 before and the 26 ahead), leaving out weeks it
      // was probably out of stock. So a stockout last year, in those weeks or in the 8 weeks before, doesn't skew it.
      let I = gIdx.slice(), w = 0, basis, outs = 0;
      if (d.ly8 >= OWN_MIN) {
        const ly = d.ly_weeks, sum = (a) => a.reduce((x, y) => x + y, 0);
        let b = (d.ly8 + sum(ly)) / (8 + sum(gIdx));
        const ok = ly.map((u, k) => u >= STOCKOUT * gIdx[k] * b);
        b = (d.ly8 + sum(ly.filter((_, k) => ok[k]))) / (8 + sum(gIdx.filter((_, k) => ok[k])));
        outs = ok.filter(x => !x).length;
        const own = smooth(ly.map((u, k) => ok[k] && b > 0 ? u / b : gIdx[k]));
        w = Math.min(OWN_MAX, d.ly8 / OWN_FULL);
        I = own.map((o, k) => { const g = gIdx[k]; return w * Math.min(Math.max(o, g / 3), 3 * g) + (1 - w) * g; });
        basis = `${Math.round(w * 100)}% its own last year, ${Math.round((1 - w) * 100)}% ${gName} last year` +
          (outs ? ` (${outs} week${outs === 1 ? "" : "s"} last year looked out of stock: brand pattern used there)` : "");
      } else basis = `${gName} last year`;
      // pace: last 8 weeks; an ASIN that only started selling recently uses its last 30 days
      const isNew = d.u365 > 0 && d.u365 === d.r8 && d.u30 > 0;
      const pace = isNew ? Math.max(d.r8 / 8, d.u30 / 30 * 7) : d.r8 / 8;
      const f = I.map(x => pace * Math.max(0, x));
      rows.push({
        asin: s.asin, title: s.title || c.title || "", vendor, unit_cost: s.unit_cost != null ? +s.unit_cost : (c.unit_cost != null ? +c.unit_cost : null),
        product_id: s.product_id, avail: s.fba_available, transfer: s.fba_transfer, inbound: s.fba_inbound, awd: s.awd, prep: s.prep,
        fbaNow, pipe, u30: d.u30, r8: d.r8, ly8: d.ly8, u365: d.u365, last_sale: d.last_sale, ly: d.ly_weeks, f, pace, isNew,
        trend: d.ly8 > 0 ? d.r8 / d.ly8 : null, basis: (isNew ? "new: last 30 days' pace · " : "") + "seasonality from " + basis,
      });
    }
    S.rows = rows;
    derive();
  }
  // run-out date for a stock level against the weekly forecast (null = lasts past the 26 weeks)
  function runOut(f, stock) {
    if (!f.some(x => x > 0)) return { day: null, weeks: null };   // no sales expected
    if (stock <= 0) return { day: today(), weeks: 0 };
    let cum = 0;
    for (let k = 0; k < f.length; k++) {
      if (f[k] > 0 && cum + f[k] >= stock) { const wk = k + (stock - cum) / f[k]; return { day: addDays(today(), wk * 7), weeks: wk }; }
      cum += f[k];
    }
    return { day: null, weeks: null };
  }
  function derive() {
    const N = Math.max(1, Math.min(WEEKS, Number(S.cfg.cover_weeks) || 12)), L = Math.max(0, Math.min(20, Number(S.cfg.lead_weeks) || 0));
    for (const r of S.rows) {
      const a = runOut(r.f, r.fbaNow), b = runOut(r.f, r.pipe);
      r.runFba = a.day; r.wkFba = a.weeks; r.runAll = b.day; r.wkAll = b.weeks;
      r.next4 = r.f.slice(0, 4).reduce((x, y) => x + y, 0);
      r.nextN = r.f.slice(0, N).reduce((x, y) => x + y, 0);
      r.need = Math.max(0, Math.ceil(r.nextN - r.pipe));
      r.needCost = r.unit_cost != null ? r.need * r.unit_cost : null;
      r.orderBy = r.runAll ? addDays(r.runAll, -7 * L) : null;
      r.value = r.unit_cost != null ? r.pipe * r.unit_cost : null;
      r.noSales = r.pipe > 0 && r.r8 === 0;
    }
  }

  // ---------- views ----------
  const VIEWS = [
    ["all", "All"], ["order", "Order now"], ["fba4", "FBA out within 4 weeks"], ["need", "Needs stock"], ["idle", "Stock, no sales in 8 weeks"], ["nocost", "No cost"],
  ];
  function filtered() {
    const t = today(), q = S.q;
    return S.rows.filter(r => {
      if (q && !(`${r.title} ${r.asin} ${r.vendor}`.toLowerCase().includes(q))) return false;
      switch (S.view) {
        case "order": return r.orderBy && r.orderBy <= t && r.f.some(x => x > 0);
        case "fba4": return r.wkFba != null && r.wkFba < 4 && r.next4 > 0;
        case "need": return r.need > 0;
        case "idle": return r.noSales;
        case "nocost": return r.unit_cost == null && (r.pipe > 0 || r.need > 0);
      }
      return true;
    });
  }
  const COLS = [
    ["title", "Product"], ["u30", "Sold 30d", 1], ["trend", "vs last yr", 1], ["next4", "Next 4 wks", 1], ["nextN", "Next N wks", 1],
    ["fbaNow", "FBA now", 1], ["inbound", "Inbound", 1], ["other", "AWD + prep", 1], ["runFba", "FBA runs out", 1], ["runAll", "All stock runs out", 1],
    ["orderBy", "Order by", 1], ["need", "Need", 1], ["needCost", "Cost", 1],
  ];
  function sortRows(rows) {
    const [k, dir] = S.sort;
    const val = (r) => k === "other" ? r.awd + r.prep : r[k];
    return rows.sort((a, b) => {
      let x = val(a), y = val(b);
      const nx = x == null || x === "", ny = y == null || y === "";
      if (nx || ny) return nx === ny ? 0 : nx ? 1 : -1;   // empty last either way
      if (typeof x === "string") return dir * x.localeCompare(y);
      return dir * (x - y);
    });
  }

  function render() {
    const main = $("fba"); if (!main || main.hidden) return;
    const N = Number(S.cfg.cover_weeks) || 12;
    $("fb-sub").textContent = S.loading && !S.loaded ? "Loading…" : S.err ? "" :
      `${S.rows.length} ASINs · FBA stock from Amazon${S.synced ? " " + new Date(S.synced).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""} · sales through yesterday`;
    const note = $("fb-note");
    if (S.err) { note.hidden = false; note.className = "note bad"; note.textContent = "Couldn't load: " + (S.err.message || S.err); }
    else note.hidden = true;
    $("fb-cover").value = S.cfg.cover_weeks; $("fb-lead").value = S.cfg.lead_weeks;
    if (!S.loaded) { $("fb-cards").innerHTML = ""; $("fb-table").innerHTML = S.loading ? '<div class="empty">Loading…</div>' : ""; return; }
    const t = today(), rs = S.rows;
    const order = rs.filter(r => r.orderBy && r.orderBy <= t && r.f.some(x => x > 0));
    const fba4 = rs.filter(r => r.wkFba != null && r.wkFba < 4 && r.next4 > 0);
    const need = rs.filter(r => r.need > 0), needCost = need.reduce((a, r) => a + (r.needCost || 0), 0), noCost = need.filter(r => r.unit_cost == null).length;
    const value = rs.reduce((a, r) => a + (r.value || 0), 0), next4 = rs.reduce((a, r) => a + r.next4, 0);
    const card = (k, v, s, cls, view) => `<button class="card ${cls || ""}${view && S.view === view ? " on" : ""}" ${view ? `data-view="${view}"` : "disabled"}><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s}</span></button>`;
    $("fb-cards").innerHTML =
      card("Next 4 weeks", n0(next4) + " units", `forecast across ${rs.filter(r => r.next4 > 0).length} ASINs`, "") +
      card("FBA runs out < 4 wks", fba4.length, "ASINs, counting FBA + transfers", fba4.length ? "red" : "", "fba4") +
      card("Order now", order.length, `all stock runs out within ${S.cfg.lead_weeks} wk${S.cfg.lead_weeks == 1 ? "" : "s"} lead time`, order.length ? "amber" : "", "order") +
      card(`Stock for ${N} weeks`, short(needCost), `${n0(need.reduce((a, r) => a + r.need, 0))} units · ${need.length} ASINs${noCost ? ` · ${noCost} without a cost` : ""}`, "green", "need") +
      card("Stock on hand", short(value), "FBA + inbound + AWD + prep, at cost", "");
    $("fb-views").innerHTML = VIEWS.map(([v, l]) => `<button role="tab" data-view="${v}" aria-selected="${S.view === v}">${l}</button>`).join("");
    table();
  }

  function table() {
    const N = Number(S.cfg.cover_weeks) || 12;
    const rows = sortRows(filtered()), t = today();
    const shown = rows.slice(0, S.shown);
    const th = ([k, l, n]) => `<th data-sort="${k}" class="${n ? "n" : ""}" ${S.sort[0] === k ? `aria-sort="${S.sort[1] > 0 ? "ascending" : "descending"}"` : ""}>${k === "nextN" ? `Next ${N} wks` : l}</th>`;
    let r0;
    const dcell = (day, wk, lim) => {
      if (day == null) return `<td class="n"><span class="m">${r0.f.some(x => x > 0) ? "26+ wks" : "no sales"}</span></td>`;
      const cls = wk != null && wk < lim[0] ? "over" : wk != null && wk < lim[1] ? "soon" : "open";
      return `<td class="n"><span class="pill ${cls}">${wk === 0 ? "Out now" : fmtD(day)}</span>${wk ? `<div class="m">${wk < 1 ? Math.round(wk * 7) + " days" : wk.toFixed(1) + " wks"}</div>` : ""}</td>`;
    };
    const body = shown.map(r => {
      const trend = r.trend == null ? '<span class="m">new</span>' : `<span class="${r.trend < 0.8 ? "negt" : ""}">${r.trend >= 1 ? "+" : "−"}${Math.abs(Math.round((r.trend - 1) * 100))}%</span>`;
      const ob = r.orderBy ? `<span class="pill ${r.orderBy <= t ? "over" : dnum(r.orderBy) - dnum(t) <= 14 ? "soon" : "open"}">${r.orderBy <= t ? "Now" : fmtD(r.orderBy)}</span>` : '<span class="m">—</span>';
      const open = S.open.has(r.asin); r0 = r;
      return `<tr class="row" data-asin="${esc(r.asin)}"><td><b>${esc(r.title || r.asin)}</b><div class="m">${esc(r.asin)}${r.vendor ? " · " + esc(r.vendor) : ""}${r.noSales ? ' · <span class="negt">no sales in 8 weeks</span>' : ""}</div></td>
        <td class="n">${n0(r.u30)}</td><td class="n">${trend}</td><td class="n">${n0(r.next4)}</td><td class="n">${n0(r.nextN)}</td>
        <td class="n">${n0(r.fbaNow)}</td><td class="n">${r.inbound ? n0(r.inbound) : '<span class="m">—</span>'}</td><td class="n">${r.awd + r.prep ? n0(r.awd + r.prep) : '<span class="m">—</span>'}</td>
        ${dcell(r.runFba, r.wkFba, [2, 4])}${dcell(r.runAll, r.wkAll, [Number(S.cfg.lead_weeks) || 0, (Number(S.cfg.lead_weeks) || 0) + 4])}
        <td class="n">${ob}</td><td class="n">${r.need ? n0(r.need) : '<span class="m">—</span>'}</td>
        <td class="n">${r.need ? (r.needCost == null ? '<span class="m">no cost</span>' : money(r.needCost)) : ""}</td></tr>
        ${open ? `<tr class="detail"><td colspan="${COLS.length}">${detail(r)}</td></tr>` : ""}`;
    }).join("");
    $("fb-table").innerHTML = rows.length ? `<table><thead><tr>${COLS.map(th).join("")}</tr></thead><tbody>${body}</tbody></table>` : '<div class="empty">Nothing here.</div>';
    $("fb-foot").innerHTML = `<span>${rows.length} ASIN${rows.length === 1 ? "" : "s"}${rows.length > shown.length ? ` · showing ${shown.length} <button class="link" data-more>Show more</button>` : ""}</span>
      <span>Units are Amazon units (a 3-pack is 1). Sales include FBA and FBM orders in every marketplace Amazon fills from US stock.</span>`;
  }

  function detail(r) {
    const t = today(), N = Number(S.cfg.cover_weeks) || 12;
    let fbaLeft = r.fbaNow, allLeft = r.pipe;
    const cells = r.f.map((f, k) => {
      fbaLeft -= f; allLeft -= f;
      return { wk: addDays(t, 7 * k), ly: r.ly[k] || 0, f, fbaLeft, allLeft };
    });
    const row = (label, fn) => `<tr><th>${label}</th>${cells.map((c, k) => `<td class="n${k === N - 1 ? " cut" : ""}">${fn(c)}</td>`).join("")}</tr>`;
    const left = (v) => v <= 0 ? `<span class="negt">${v < -0.5 ? "−" + n0(-v) : "0"}</span>` : n0(v);
    return `<div class="fb-det">
      <div class="fb-facts">
        <div><span class="m">Pace</span> ${r.pace.toFixed(1)} a week <span class="m">(last 8 weeks: ${n0(r.r8)}${r.ly8 ? `; same weeks last year: ${n0(r.ly8)}` : ""})</span></div>
        <div><span class="m">Forecast</span> ${esc(r.basis)}</div>
        <div><span class="m">Stock</span> FBA ${n0(r.avail)} available${r.transfer ? ` + ${n0(r.transfer)} moving between warehouses` : ""} · inbound ${n0(r.inbound)} · AWD ${n0(r.awd)} · prep center ${n0(r.prep)}</div>
        <div><span class="m">Cost</span> ${r.unit_cost == null ? "no Shopify cost mapped (map the SKU on the sales dashboard's Amazon mapping tab)" : money(r.unit_cost) + " per unit"}${r.value ? ` · ${money(r.value)} on hand` : ""}</div>
        <div><a href="https://www.amazon.com/dp/${encodeURIComponent(r.asin)}" target="_blank" rel="noopener">Amazon listing ↗</a> · <a href="https://sellercentral.amazon.com/myinventory/inventory?searchTerm=${encodeURIComponent(r.asin)}" target="_blank" rel="noopener">Seller Central inventory ↗</a></div>
      </div>
      <div class="tbl fb-weeks"><table><thead><tr><th>Week of</th>${cells.map(c => `<th class="n">${fmtD(c.wk)}</th>`).join("")}</tr></thead><tbody>
        ${row("Last year", c => n0(c.ly))}${row("Forecast", c => n0(c.f))}${row("FBA left", c => left(c.fbaLeft))}${row("All stock left", c => left(c.allLeft))}
      </tbody></table></div></div>`;
  }

  function csv() {
    const N = Number(S.cfg.cover_weeks) || 12;
    const head = ["ASIN", "Product", "Brand", "Sold 30d", "Last 8 wks", "Same 8 wks last yr", "Next 4 wks", `Next ${N} wks`, "FBA available", "FBA transfer", "Inbound", "AWD", "Prep", "FBA runs out", "All stock runs out", "Order by", "Need units", "Unit cost", "Need cost", ...Array.from({ length: WEEKS }, (_, k) => "Wk " + addDays(today(), 7 * k))];
    const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [head.join(",")].concat(sortRows(filtered()).map(r => [r.asin, r.title, r.vendor, r.u30, r.r8, r.ly8, Math.round(r.next4), Math.round(r.nextN), r.avail, r.transfer, r.inbound, r.awd, r.prep,
      r.runFba || "", r.runAll || "", r.orderBy || "", r.need, r.unit_cost ?? "", r.needCost == null ? "" : r.needCost.toFixed(2), ...r.f.map(x => x.toFixed(1))].map(q).join(",")));
    FIN.download(`fba-forecast-${today()}.csv`, lines.join("\n"));
  }

  async function saveCfg(patch) {
    S.cfg = { ...S.cfg, ...patch }; derive(); render();
    try { await FIN.write("fin_settings_set", { p: { key: "fba", value: patch } }); } catch (e) { const n = $("fb-note"); n.hidden = false; n.className = "note bad"; n.textContent = "Couldn't save: " + (e.message || e); }
  }

  window.FIN_FBA = { build, rows: () => S.rows };   // for checks from the console
  document.addEventListener("DOMContentLoaded", () => {
    const main = $("fba"); if (!main) return;
    main.addEventListener("click", (ev) => {
      const v = ev.target.closest("[data-view]");
      if (v) { S.view = S.view === v.dataset.view && v.classList.contains("card") ? "all" : v.dataset.view; S.shown = 150; render(); return; }
      const h = ev.target.closest("th[data-sort]");
      if (h) { const k = h.dataset.sort; S.sort = [k, S.sort[0] === k ? -S.sort[1] : (k === "title" || /^run|orderBy/.test(k) ? 1 : -1)]; table(); return; }
      if (ev.target.closest("[data-more]")) { S.shown += 300; table(); return; }
      if (ev.target.closest("a")) return;
      const tr = ev.target.closest("tr.row");
      if (tr) { const a = tr.dataset.asin; if (S.open.has(a)) S.open.delete(a); else S.open.add(a); table(); }
    });
    $("fb-q").addEventListener("input", (ev) => { S.q = ev.target.value.trim().toLowerCase(); S.shown = 150; table(); });
    $("fb-csv").addEventListener("click", csv);
    $("fb-refresh").addEventListener("click", () => { FIN.clear(); load(true); });
    $("fb-cover").addEventListener("change", (ev) => { const v = Math.round(Number(ev.target.value)); if (v >= 1 && v <= WEEKS) saveCfg({ cover_weeks: v }); else render(); });
    $("fb-lead").addEventListener("change", (ev) => { const v = Math.round(Number(ev.target.value)); if (v >= 0 && v <= 20) saveCfg({ lead_weeks: v }); else render(); });
    window.addEventListener("fin:page", (e) => { if (e.detail === "fba") { if (!S.loaded && !S.loading) FIN.ready.then(() => load(false)); else render(); } });
  });
})();
