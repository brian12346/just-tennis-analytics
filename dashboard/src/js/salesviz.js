(() => {
  // ===================== Shared sales charts (Just Tennis, Ace n Rally) =====================
  // Nov 17, Brian: "add some of those same charts onto the just tennis and ace n' rally pages" — the Amazon page's
  // "where it went" chart and its Brands & categories comparison, generalized.
  //
  // JTViz.where(host, rows, segs, opts): rows = [{day, orders, sales, profit, <seg key>: amount…}] by day; segs =
  //   [[key, label, color]] bottom to top, the last one is profit. 1 day → a waterfall; more → stacked bars (at most
  //   44px wide; weeks past 60 days, months past ~6 months) with the whole range as one 100% strip above them.
  // JTViz.groups(host, cfg): the Brands & categories panel. cfg = {key (localStorage), store (label),
  //   load(start, end, unit) → [{b, brand, cat, units, sales, cogs, costed}] (b = the day/week/month the row is in),
  //   note}. Call .render(start, end, refresh) whenever the range changes.
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }), usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m = (n) => usd.format(n || 0), m0 = (n) => usd0.format(n || 0);
  const pct = (n) => n != null && isFinite(n) ? (n * 100).toFixed(1) + "%" : "—";
  const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const shortDay = (ds) => new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const wkDay = (ds) => new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const monLab = (ds) => new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
  const fmtAx = (v) => Math.abs(v) >= 1000 ? (v < 0 ? "-" : "") + "$" + (+(Math.abs(v) / 1000).toFixed(1)) + "k" : (v < 0 ? "-$" : "$") + Math.round(Math.abs(v));
  const nice = (v) => { if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))); for (const f of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (f * e >= v) return f * e; return 10 * e; };
  const unitFor = (start, end) => { const n = Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1; return n <= 45 ? "day" : n <= 182 ? "week" : "month"; };
  const bucketOf = (day, unit) => unit === "day" ? day : unit === "month" ? day.slice(0, 7) + "-01" : addDays(day, -((new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7));
  const bucketEnd = (b, unit) => unit === "day" ? b : unit === "week" ? addDays(b, 6) : addDays(addDays(b, 32).slice(0, 7) + "-01", -1);
  const yTicks = (lo, hi) => { const step = nice((hi - lo) / 4), max = Math.ceil(hi / step) * step, min = Math.floor(lo / step) * step, t = []; for (let v = min; v <= max + step / 2; v += step) t.push(Math.abs(v) < 1e-6 ? 0 : v); return { min, max: max > min ? max : min + step, t }; };
  const axis = (W, pad, y, ticks, f) => ticks.map(t => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line-soft)"/><text x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="var(--faint)" font-family="var(--mono)">${f(t)}</text>`).join("");
  const posTip = (tip, host, svg, cx, W, cy, H) => { const sb = svg.getBoundingClientRect(), box = host.getBoundingClientRect(); tip.hidden = false; tip.style.left = Math.min(Math.max(cx * sb.width / W, 120), box.width - 120) + "px"; tip.style.top = (svg.offsetTop + cy * sb.height / H) + "px"; };

  // ---------- where the sales went ----------
  function where(host, all, segs, opts = {}) {
    if (!host) return;
    const salesL = opts.salesLabel || "Net sales", prof = segs[segs.length - 1][0];
    if (!all.length || !all.some(r => r.sales || r.orders)) { host.innerHTML = `<div class="skel">${opts.empty || "No sales in this range."}</div>`; return; }
    const W = Math.max(320, host.clientWidth || 800);
    if (all.length === 1) return waterfall(host, all[0], segs, salesL, W);
    // roll up to weeks or months on long ranges
    const unit = all.length > 182 ? "month" : all.length > 60 ? "week" : "day";
    let rows = all;
    if (unit !== "day") {
      const mp = new Map();
      for (const r of all) {
        const b = bucketOf(r.day, unit), o = mp.get(b) || { day: b, n: 0, orders: 0, sales: 0 };
        o.n++; o.orders += r.orders || 0; o.sales += r.sales || 0; for (const [k] of segs) o[k] = (o[k] || 0) + (r[k] || 0);
        mp.set(b, o);
      }
      rows = [...mp.values()].sort((a, b) => a.day.localeCompare(b.day));
      for (const o of rows) o.partial = o.n < (unit === "week" ? 7 : +bucketEnd(o.day, "month").slice(8));
    }
    const H = W < 560 ? 220 : 280, pad = { l: 60, r: 12, t: 12, b: 28 }, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const top = (r) => segs.reduce((a, [k]) => a + Math.max(0, r[k] || 0), 0);
    const hi = Math.max(1, ...rows.map(r => Math.max(top(r), r.sales))), lo = Math.min(0, ...rows.map(r => r[prof] || 0));
    const Y = yTicks(lo, hi), y = (v) => pad.t + ih - ((v - Y.min) / (Y.max - Y.min)) * ih, bw = iw / rows.length;
    const lab = (d) => unit === "month" ? monLab(d) : shortDay(d), every = Math.ceil(rows.length / Math.max(2, Math.floor(iw / 58)));
    let s = strip(all, segs, salesL) + `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(salesL)} by ${unit}, split into ${esc(segs.map(x => x[1]).join(", "))}">` + axis(W, pad, y, Y.t, fmtAx);
    rows.forEach((r, i) => {
      const x = pad.l + i * bw, w = Math.max(2, Math.min(44, bw * 0.66)), bx = x + (bw - w) / 2, gap = w > 6 ? 1 : 0, op = r.partial ? ' fill-opacity="0.45"' : "";
      let base = 0;
      for (const [k, , c] of segs) { const v = r[k] || 0; if (!(v > 0)) continue; const h = y(base) - y(base + v); s += `<rect x="${bx}" y="${y(base + v)}" width="${w}" height="${Math.max(0, h - (h > 2 ? gap : 0))}" fill="${c}"${op}/>`; base += v; }
      if ((r[prof] || 0) < 0) s += `<rect x="${bx}" y="${y(0)}" width="${w}" height="${Math.max(1, y(r[prof]) - y(0))}" fill="var(--bad)"${op}/>`;
      if (i % every === 0 || (i === rows.length - 1 && i % every >= every / 2)) s += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${lab(r.day)}</text>`;
    });
    s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/>`;
    rows.forEach((r, i) => { s += `<rect data-i="${i}" x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${ih}" fill="transparent"/>`; });
    host.innerHTML = s + `</svg><div class="tip" hidden></div>`;
    const tip = host.querySelector(".tip"), svg = host.querySelector("svg");
    const head = (r) => unit === "week" ? `Week of ${shortDay(r.day)}` : unit === "month" ? monLab(r.day) : `${wkDay(r.day)} ${shortDay(r.day)}`;
    svg.addEventListener("pointermove", (ev) => {
      const t = ev.target.closest("rect[data-i]"); if (!t) { tip.hidden = true; return; }
      const i = +t.dataset.i, r = rows[i];
      tip.innerHTML = `<b>${head(r)}</b>${r.partial ? ` <span class="dim">(${r.n} day${r.n === 1 ? "" : "s"} in range)</span>` : ""} · ${(r.orders || 0).toLocaleString()} orders<br>${esc(salesL)} <b>${m(r.sales)}</b>`
        + [...segs].reverse().map(([k, l, c]) => { const v = r[k] || 0; return `<br><span class="gsw" style="background:${k === prof && v < 0 ? "var(--bad)" : c}"></span>${esc(l)} <b>${m(v)}</b> <span class="dim">${r.sales ? pct(v / r.sales) : ""}</span>`; }).join("");
      posTip(tip, host, svg, pad.l + i * bw + bw / 2, W, pad.t + ih * 0.55, H);
    });
    svg.addEventListener("pointerleave", () => { tip.hidden = true; });
  }
  function strip(rows, segs, salesL) {
    const prof = segs[segs.length - 1][0], T = { sales: 0 };
    for (const r of rows) { T.sales += r.sales || 0; for (const [k] of segs) T[k] = (T[k] || 0) + (r[k] || 0); }
    if (!(T.sales > 0)) return "";
    const list = segs.map(([k, l, c]) => [k, l, k === prof && T[k] < 0 ? "var(--bad)" : c, T[k] || 0]).filter(x => x[3] > 0.005 || x[0] === prof);
    const tot = list.reduce((a, x) => a + Math.max(0, x[3]), 0) || 1;
    return `<div class="azstrip" aria-label="Where the range's ${esc(salesL.toLowerCase())} went"><div class="azs-bar">${list.filter(x => x[3] > 0).map(([, l, c, v]) => `<i style="width:${(v / tot * 100).toFixed(2)}%;background:${c}" title="${esc(l)} ${m(v)}"></i>`).join("")}</div>
      <div class="azs-keys">${list.map(([, l, c, v]) => `<span><b style="background:${c}"></b>${esc(l)} <strong>${pct(v / T.sales)}</strong> <span class="dim">${m0(v)}</span></span>`).join("")}</div></div>`;
  }
  function waterfall(host, r, segs, salesL, W) {
    const prof = segs[segs.length - 1][0], H = W < 560 ? 240 : 280, pad = { l: 60, r: 12, t: 28, b: 34 }, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const steps = [[salesL, r.sales, "var(--azs-sales)", Math.min(0, r.sales), Math.max(0, r.sales)]];
    let run = r.sales;
    for (const [k, l, c] of segs.slice(0, -1)) { const v = r[k] || 0; if (!(v > 0.005)) continue; steps.push([l, -v, c, run - v, run]); run -= v; }
    const p = r[prof] || 0, pl = segs[segs.length - 1][1];
    steps.push([pl, p, p < 0 ? "var(--bad)" : segs[segs.length - 1][2], Math.min(0, p), Math.max(0, p)]);
    const Y = yTicks(Math.min(0, ...steps.map(x => x[3])), Math.max(1, ...steps.map(x => x[4]))), y = (v) => pad.t + ih - ((v - Y.min) / (Y.max - Y.min)) * ih;
    const bw = iw / steps.length, w = Math.min(84, bw * 0.6);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(shortDay(r.day))}: ${esc(salesL.toLowerCase())} stepping down through costs to ${esc(pl.toLowerCase())}">` + axis(W, pad, y, Y.t, fmtAx);
    steps.forEach(([l, v, c, a, b], i) => {
      const cx = pad.l + i * bw + bw / 2;
      s += `<rect x="${cx - w / 2}" y="${y(b)}" width="${w}" height="${Math.max(1, y(a) - y(b))}" fill="${c}" rx="3"/>`;
      if (i < steps.length - 1) { const nx = pad.l + (i + 1) * bw + bw / 2, lv = i === 0 ? r.sales : a; s += `<line x1="${cx + w / 2}" x2="${nx - w / 2}" y1="${y(lv)}" y2="${y(lv)}" stroke="var(--faint)" stroke-dasharray="3 3"/>`; }
      s += `<text x="${cx}" y="${y(b) - 7}" text-anchor="middle" font-size="12" font-weight="600" fill="var(--ink)" font-family="var(--mono)">${m0(v)}</text>`;
      s += `<text x="${cx}" y="${H - 18}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(l)}</text><text x="${cx}" y="${H - 5}" text-anchor="middle" font-size="11" fill="var(--faint)">${i ? pct(Math.abs(v) / (r.sales || 1)) : (r.orders || 0) + " orders"}</text>`;
    });
    host.innerHTML = s + `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/></svg>`;
  }

  // ---------- Brands & categories ----------
  const SLOTS = ["line", "A", "B", "C", "D"], SLOTL = { line: "Own line", A: "Set A", B: "Set B", C: "Set C", D: "Set D" };
  function groups(host, cfg) {
    const G = (() => { let v = null; try { v = JSON.parse(localStorage.getItem(cfg.key) || "null"); } catch (_) {} return Object.assign({ dim: "brand", metric: "sales", sel: { brand: null, cat: null } }, v || {}); })();
    const save = () => { try { localStorage.setItem(cfg.key, JSON.stringify({ dim: G.dim, metric: G.metric, sel: G.sel })); } catch (_) {} };
    const P = { start: null, end: null, unit: "day", lines: null, err: null, req: 0, q: "" };
    host.innerHTML = `<div class="panel-head"><h2>Brands &amp; categories</h2><div class="filters">
        <div class="seg" data-g="dim" role="group" aria-label="Group by"><button type="button" data-v="brand">Brands</button><button type="button" data-v="cat">Categories</button></div>
        <div class="seg" data-g="metric" role="group" aria-label="Measure"><button type="button" data-v="sales">Sales</button><button type="button" data-v="profit">Gross profit</button><button type="button" data-v="units">Units</button><button type="button" data-v="margin">Margin</button><button type="button" data-v="share">Share</button></div>
      </div></div>
      <p class="muted small">${esc(cfg.note || "Brand is the Shopify vendor; category is the Shopify product type.")} Pick lines in the table: each one on its own, or combined into Set A–D to compare groups of brands or categories.</p>
      <div class="legend" data-r="legend" style="margin:6px 0"></div><div class="chart" data-r="chart"><div class="skel">Loading…</div></div>
      <div class="grp-two"><div><h3 class="eyebrow" data-r="toth">Total in range</h3><div data-r="tot"></div></div><div><h3 class="eyebrow">Gross margin</h3><div data-r="mgn"></div></div></div>
      <div class="row" style="margin:10px 0 4px"><input class="inp" type="search" data-r="q" placeholder="Filter brands or categories" style="max-width:240px" autocomplete="off" data-jtnofill="1"><button class="mini" type="button" data-a="top">Top 5</button><button class="mini" type="button" data-a="clear">Clear</button><span class="muted small" data-r="count"></span></div>
      <div class="tbl-wrap tall"><table class="grp-tbl" data-r="tbl"></table></div>`;
    const $r = (k) => host.querySelector(`[data-r="${k}"]`);
    const sync = () => host.querySelectorAll(".seg[data-g]").forEach(sg => sg.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === G[sg.dataset.g]))));

    async function load(start, end, refresh) {
      P.start = start; P.end = end; P.unit = unitFor(start, end);
      const id = ++P.req; P.err = null; if (!P.lines || refresh !== "quiet") draw();
      try { const l = await cfg.load(start, end, P.unit, refresh === true); if (id !== P.req) return; P.lines = l; }
      catch (e) { if (id === P.req) P.err = e; }
      if (id === P.req) draw();
    }
    function agg() {
      const groups = new Map(), tot = new Map(), bset = new Set();
      const blank = () => ({ units: 0, sales: 0, cogs: 0, costed: 0, n: 0 });
      for (const l of P.lines || []) {
        const k = G.dim === "brand" ? (l.brand || "Unknown brand") : (l.cat || "No category"); bset.add(l.b);
        let g = groups.get(k); if (!g) { g = { name: k, t: blank(), by: new Map() }; groups.set(k, g); }
        let c = g.by.get(l.b); if (!c) { c = blank(); g.by.set(l.b, c); }
        for (const x of [g.t, c]) { x.units += l.units; x.sales += l.sales; x.cogs += l.cogs; x.costed += l.costed; }
        tot.set(l.b, (tot.get(l.b) || 0) + l.sales);
      }
      for (let d = P.start; d && d <= P.end; d = addDays(d, 1)) bset.add(bucketOf(d, P.unit));
      const buckets = [...bset].sort(), partial = new Set(buckets.filter(b => P.unit !== "day" && (b < P.start || bucketEnd(b, P.unit) > P.end)));
      let total = 0; for (const v of tot.values()) total += v;
      return { groups, tot, total, buckets, partial };
    }
    const gp = (x) => x.costed - x.cogs;
    const val = (x, mt, tb) => !x ? 0 : mt === "sales" ? x.sales : mt === "units" ? x.units : mt === "profit" ? gp(x) : mt === "margin" ? (x.costed > 0.005 ? gp(x) / x.costed : null) : (tb ? x.sales / tb : null);
    const fmt = (v, mt) => v == null ? "—" : mt === "units" ? Math.round(v).toLocaleString() : mt === "margin" || mt === "share" ? pct(v) : m0(v);
    const fax = (v, mt) => mt === "units" ? (Math.abs(v) >= 1000 ? +(v / 1000).toFixed(1) + "k" : String(Math.round(v))) : mt === "margin" || mt === "share" ? Math.round(v * 100) + "%" : fmtAx(v);
    function series(ag) {
      let sel = G.sel[G.dim];
      if (!sel) { sel = {}; [...ag.groups.values()].sort((a, b) => b.t.sales - a.t.sales).slice(0, 5).forEach(g => { sel[g.name] = "line"; }); if (ag.groups.size) { G.sel[G.dim] = sel; save(); } }
      const out = [];
      for (const [n, sl] of Object.entries(sel)) if (sl === "line") out.push({ label: n, members: [n] });
      for (const s of ["A", "B", "C", "D"]) { const mem = Object.entries(sel).filter(([, v]) => v === s).map(([k]) => k); if (mem.length) out.push({ label: `Set ${s}: ${mem.slice(0, 3).join(" + ")}${mem.length > 3 ? ` + ${mem.length - 3} more` : ""}`, short: `Set ${s}`, members: mem }); }
      const blank = () => ({ units: 0, sales: 0, cogs: 0, costed: 0 }), add = (a, x) => { for (const k of Object.keys(a)) a[k] += x[k] || 0; };
      for (const s of out) { s.t = blank(); s.by = new Map(); for (const n of s.members) { const g = ag.groups.get(n); if (!g) continue; add(s.t, g.t); for (const [b, c] of g.by) { const x = s.by.get(b) || blank(); add(x, c); s.by.set(b, x); } } }
      out.sort((a, b) => b.t.sales - a.t.sales); out.forEach((s, i) => { s.color = `var(--g${(i % 8) + 1})`; });
      return out;
    }
    function draw() {
      sync();
      if (P.err) { $r("chart").innerHTML = `<div class="skel">Couldn't load: ${esc((window.JT && window.JT.message) ? window.JT.message(P.err) : P.err)}</div>`; return; }
      if (!P.lines) { $r("chart").innerHTML = '<div class="skel">Loading brands and categories…</div>'; return; }
      const ag = agg(), S = series(ag), M = G.metric;
      $r("legend").innerHTML = S.map(s => `<span title="${esc(s.members.join(", "))}"><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join("");
      chart(ag, S); bars(ag, S); table(ag, S);
      $r("toth").textContent = M === "share" ? "Share of sales" : M === "units" ? "Units in range" : M === "sales" ? "Sales in range" : "Gross profit in range";
    }
    function chart(ag, S) {
      const host2 = $r("chart"), M = G.metric, B = ag.buckets;
      if (!S.length) { host2.innerHTML = '<div class="skel">Pick brands or categories in the table below to chart them.</div>'; return; }
      if (B.length === 1) { host2.innerHTML = ""; return; }      // one day: the bars below say it all
      const W = Math.max(320, host2.clientWidth || 800), H = W < 560 ? 220 : 280, pad = { l: 60, r: 28, t: 12, b: 28 }, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
      const v = (s, b) => val(s.by.get(b), M, ag.tot.get(b)), vs = [];
      for (const s of S) for (const b of B) { const x = v(s, b); if (x != null) vs.push(x); }
      let hi = Math.max(0, ...vs), lo = Math.min(0, ...vs), min, max, ticks;
      if (M === "margin" || M === "share") { max = Math.min(1, Math.max(0.2, Math.ceil(hi * 5 - 1e-9) / 5)); min = lo < 0 ? Math.max(-1, Math.floor(lo * 5) / 5) : 0; ticks = []; for (let i = 0; i <= 4; i++) ticks.push(min + (max - min) * i / 4); }
      else { const Y = yTicks(lo, Math.max(hi, 1)); min = Y.min; max = Y.max; ticks = Y.t; }
      const y = (x) => pad.t + ih - ((x - min) / (max - min || 1)) * ih, step = B.length > 1 ? iw / (B.length - 1) : 0, X = (i) => B.length > 1 ? pad.l + i * step : pad.l + iw / 2;
      const every = Math.ceil(B.length / Math.max(2, Math.floor(iw / 64))), lab = (b) => P.unit === "month" ? monLab(b) : P.unit === "week" ? "wk " + shortDay(b) : shortDay(b);
      let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${G.dim === "brand" ? "Brands" : "Categories"} over time">` + axis(W, pad, y, ticks, (t) => fax(t, M));
      if (min < 0) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/>`;
      B.forEach((b, i) => { if (i % every === 0) s += `<text x="${X(i)}" y="${H - 8}" text-anchor="${B.length > 1 && i === B.length - 1 ? "end" : "middle"}" font-size="11" fill="var(--muted)">${lab(b)}</text>`; });
      for (const se of S) {
        let path = "", dash = "", prev = null;
        B.forEach((b, i) => {
          const x = v(se, b); if (x == null) { prev = null; return; }
          const pt = `${X(i).toFixed(1)},${y(x).toFixed(1)}`, part = ag.partial.has(b) || (prev && prev.part);
          if (prev && part) dash += `M${prev.pt}L${pt}`; else path += `${prev ? "L" : "M"}${pt}`;
          if (prev && part && !ag.partial.has(b)) path += `M${pt}`;
          prev = { pt, part: ag.partial.has(b) };
        });
        s += `<path d="${path}" fill="none" stroke="${se.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
        if (dash) s += `<path d="${dash}" fill="none" stroke="${se.color}" stroke-width="2" stroke-dasharray="4 3" opacity="0.8"/>`;
        if (B.length === 1 || B.length <= 40) B.forEach((b, i) => { const x = v(se, b); if (x != null) s += `<circle cx="${X(i)}" cy="${y(x)}" r="${B.length === 1 ? 5 : 2.5}" fill="${se.color}"/>`; });
      }
      s += `<line class="gcur" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" stroke="var(--faint)" stroke-dasharray="3 3" visibility="hidden"/><rect x="${pad.l - (step / 2 || iw / 2)}" y="${pad.t}" width="${iw + (step || iw)}" height="${ih}" fill="transparent"/></svg><div class="tip" hidden></div>`;
      host2.innerHTML = s;
      const svg = host2.querySelector("svg"), tip = host2.querySelector(".tip"), cur = svg.querySelector(".gcur");
      svg.addEventListener("pointermove", (ev) => {
        const sb = svg.getBoundingClientRect(), px = (ev.clientX - sb.left) * W / sb.width, i = B.length > 1 ? Math.max(0, Math.min(B.length - 1, Math.round((px - pad.l) / step))) : 0, b = B[i];
        cur.setAttribute("x1", X(i)); cur.setAttribute("x2", X(i)); cur.setAttribute("visibility", "visible");
        const rows = S.map(se => [se, v(se, b)]).sort((p, q) => (q[1] ?? -1e15) - (p[1] ?? -1e15));
        tip.innerHTML = `<b>${P.unit === "week" ? "Week of " + shortDay(b) : P.unit === "month" ? monLab(b) : wkDay(b) + " " + shortDay(b)}</b>${ag.partial.has(b) ? ' <span class="dim">partial</span>' : ""}` + rows.map(([se, x]) => `<br><span class="gsw" style="background:${se.color}"></span>${esc(se.short || se.label)} <b>${fmt(x, M)}</b>`).join("");
        posTip(tip, host2, svg, X(i), W, pad.t + ih / 3, H);
      });
      svg.addEventListener("pointerleave", () => { tip.hidden = true; cur.setAttribute("visibility", "hidden"); });
    }
    function bars(ag, S) {
      const M = G.metric, tm = M === "margin" ? "profit" : M;
      const row = (s, v, w, c, f) => `<div class="gbar" title="${esc(s.members.join(", "))}"><span class="gn"><span class="gsw" style="background:${s.color}"></span>${esc(s.short || s.label)}</span><span class="gt"><i style="width:${w}%;background:${c}"></i></span><span class="gv ${v < 0 ? "neg" : ""}">${f}</span></div>`;
      const tv = S.map(s => [s, tm === "profit" && !(s.t.costed > 0.005) ? null : val(s.t, tm, ag.total)]), max = Math.max(1e-9, ...tv.map(([, v]) => Math.abs(v || 0)));
      $r("tot").innerHTML = tv.length ? tv.map(([s, v]) => row(s, v, (Math.abs(v || 0) / max * 100).toFixed(1), s.color, fmt(v, tm) + (tm === "sales" && ag.total ? ` <span class="dim">${pct(v / ag.total)}</span>` : ""))).join("") : '<p class="muted small">Nothing picked.</p>';
      const mv = S.map(s => [s, val(s.t, "margin")]), mm = Math.max(0.05, ...mv.map(([, v]) => Math.abs(v || 0)));
      $r("mgn").innerHTML = mv.map(([s, v]) => row(s, v, (Math.abs(v || 0) / mm * 100).toFixed(1), v < 0 ? "var(--bad)" : s.color, fmt(v, "margin"))).join("");
    }
    function table(ag, S) {
      const sel = G.sel[G.dim] || {}, q = P.q.trim().toLowerCase(), col = new Map();
      for (const s of S) for (const n of s.members) col.set(n, s.color);
      const all = [...ag.groups.values()].sort((a, b) => b.t.sales - a.t.sales), rows = all.filter(g => !q || g.name.toLowerCase().includes(q) || sel[g.name]);
      const T = all.reduce((a, g) => { for (const k of ["units", "sales", "cogs", "costed"]) a[k] += g.t[k]; return a; }, { units: 0, sales: 0, cogs: 0, costed: 0 });
      $r("tbl").innerHTML = `<thead><tr><th class="l">${G.dim === "brand" ? "Brand" : "Category"}</th><th class="l">Chart as</th><th>Units</th><th>Net sales</th><th>Share</th><th>Product cost</th><th>Gross profit</th><th>Margin</th><th>Costed</th></tr></thead><tbody>${
        rows.map(g => { const t = g.t, p = gp(t), on = sel[g.name], cov = t.sales ? t.costed / t.sales : 0;
          return `<tr class="${on ? "gon" : ""}"><td class="l">${on ? `<span class="gsw" style="background:${col.get(g.name) || "var(--faint)"}"></span>` : ""}${esc(g.name)}</td>
            <td class="l"><select data-gsel="${esc(g.name)}" aria-label="Chart ${esc(g.name)}"><option value="">—</option>${SLOTS.map(k => `<option value="${k}" ${on === k ? "selected" : ""}>${SLOTL[k]}</option>`).join("")}</select></td>
            <td>${Math.round(t.units).toLocaleString()}</td><td><b>${m0(t.sales)}</b></td><td class="dim">${ag.total ? pct(t.sales / ag.total) : ""}</td><td>${t.costed > 0.005 ? m0(t.cogs) : "—"}</td>
            <td class="${p < 0 ? "neg" : ""}">${t.costed > 0.005 ? "<b>" + m0(p) + "</b>" : '<span class="dim">—</span>'}</td><td class="dim">${t.costed > 0.005 ? pct(p / t.costed) : ""}</td><td class="${t.sales > 0 && cov < 0.95 ? "warnt" : "dim"}">${t.sales > 0 ? pct(cov) : ""}</td></tr>`; }).join("")
        || '<tr><td class="l dim" colspan="9">Nothing matches.</td></tr>'}</tbody>
        <tfoot><tr><td class="l">All ${G.dim === "brand" ? "brands" : "categories"}</td><td></td><td>${Math.round(T.units).toLocaleString()}</td><td>${m0(T.sales)}</td><td></td><td>${m0(T.cogs)}</td><td>${m0(gp(T))}</td><td>${T.costed > 0.005 ? pct(gp(T) / T.costed) : ""}</td><td>${T.sales ? pct(T.costed / T.sales) : ""}</td></tr></tfoot>`;
      $r("count").textContent = `${all.length} ${G.dim === "brand" ? "brands" : "categories"} · gross profit and margin count sales with a cost`;
    }
    host.addEventListener("click", (e) => {
      const b = e.target.closest(".seg[data-g] button"); if (b) { G[b.closest(".seg").dataset.g] = b.dataset.v; save(); draw(); return; }
      const a = e.target.closest("[data-a]"); if (!a) return;
      G.sel[G.dim] = a.dataset.a === "clear" ? {} : null; save(); draw();
    });
    host.addEventListener("change", (e) => {
      const t = e.target.closest("select[data-gsel]"); if (!t) return;
      const sel = Object.assign({}, G.sel[G.dim] || {}); if (t.value) sel[t.dataset.gsel] = t.value; else delete sel[t.dataset.gsel];
      G.sel[G.dim] = sel; save(); draw();
    });
    host.addEventListener("input", (e) => { if (e.target.matches('[data-r="q"]')) { P.q = e.target.value; draw(); } });
    return { render: load, redraw: draw };
  }

  // rows for groups(): one SQL over a Shopify sales view, grouped by the chart's day/week/month, vendor and product type
  function shopifyLines(view) {
    return async (start, end, unit, refresh) => {
      const JT = window.JT, b = unit === "day" ? "day::date::text" : `date_trunc('${unit}', day::date)::date::text`;
      const r = await JT.rowsSplit([b, "coalesce(nullif(trim(vendor), ''), 'Unknown brand')", "coalesce(nullif(trim(product_type), ''), 'No category')", "sum(units)", "sum(net)", "sum(cogs)", "sum(net) - sum(net_no_cost)"],
        `from ${view} where day between ${JT.day(start)} and ${JT.day(end)} group by 1, 2, 3`, "vendor", unit === "day" ? 2 : 1, refresh);
      return r.map(x => ({ b: x[0], brand: x[1], cat: x[2], units: +x[3] || 0, sales: +x[4] || 0, cogs: +x[5] || 0, costed: +x[6] || 0 }));
    };
  }

  window.JTViz = { where, groups, shopifyLines };
})();
