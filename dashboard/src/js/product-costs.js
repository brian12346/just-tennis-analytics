(() => {
  // ===================== Inventory value (was Product costs) =====================
  // Every Shopify variant with its unit cost and its units in each place we hold stock: the Shopify store, the prep
  // center, Amazon FBA and Amazon AWD, valued at cost (Brian, Oct 7: units and cost, not price or sales).
  // Edited costs are queued in jt.cost_updates and written to Shopify by the sync.
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m = (n) => n == null || isNaN(n) ? "—" : usd.format(n), m0 = (n) => usd0.format(n || 0);
  const pct = (x) => x == null || !isFinite(x) ? "—" : (x * 100).toFixed(0) + "%";
  const JT = window.JT;
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const PER = 100;
  const money = (s) => { const t = String(s ?? "").trim().replace(/[$,\s]/g, ""); if (!t) return null; return /^\d*\.?\d+$/.test(t) ? Number(t) : NaN; };

  const P = {
    shown: false, loading: false, reqId: 0,
    rows: null,             // [{vid, pid, sku, title, vendor, type, status, price, cost, qty}]
    pending: new Map(),     // vid -> queued cost not yet in Shopify
    edits: new Map(),       // vid -> typed text
    vendor: "all", cat: "all", status: "all", issue: "all", where: "stock", q: "", sort: "cost", page: 0,
    asOf: null,             // last catalog sync (inventory quantities are as of then)
    saving: false, confirm: false,
  };
  const note = (kind, html) => { const n = $("pc-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; };

  async function load(refresh) {
    const id = ++P.reqId; P.loading = true; render();
    $("pc-status").textContent = "Loading products and stock…";
    try {
      const [cat, pend, asof] = await Promise.all([
        JT.rowsSplit(["variant_id::text", "product_id::text", "sku", "coalesce(nullif(display_name, ''), product_title)", "vendor", "product_type", "status", "price", "unit_cost", "inventory_qty"],
          "from jt.variants where removed_at is null", "variant_id", 4, refresh),
        JT.rows(["variant_id::text", "new_cost"], "from jt.cost_updates where status = 'pending' and new_cost is not null", true),
        JT.rows(["extract(epoch from max(seen_at))"], "from jt.variants", refresh),
      ]);
      if (id !== P.reqId) return;
      P.asOf = asof && asof[0] && asof[0][0] ? new Date(+asof[0][0] * 1000) : null;
      P.rows = cat.map(x => ({ vid: x[0], pid: x[1], sku: x[2] || "", title: x[3] || "", vendor: x[4] || "", type: x[5] || "", status: x[6] || "",
        price: x[7] == null ? null : +x[7], cost: x[8] == null ? null : +x[8], qty: x[9] == null ? null : +x[9] }));
      P.pending = new Map(pend.map(([v, c]) => [v, +c]));
      fillFilters();
      loadHist(refresh);
      if (JT.fba) JT.fba.load(refresh).then(() => { if (id === P.reqId) render(); }).catch(() => {});
      if (window.JTPrep) window.JTPrep.load(refresh).then(() => { if (id === P.reqId) render(); }).catch(() => {});
      if (window.JTCost) window.JTCost.load(refresh).then(() => { if (id === P.reqId) render(); }).catch(() => {});
      const when = P.asOf ? P.asOf.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
      $("pc-status").textContent = `${P.rows.length.toLocaleString()} Shopify variants${when ? ` · Shopify stock as of ${when}` : ""}`;
    } catch (e) { note("bad", esc(JT.message(e))); $("pc-status").textContent = ""; }
    finally { if (id === P.reqId) { P.loading = false; render(); } }
  }

  function fillFilters() {
    const opt = (sel, vals, cur, all) => { $(sel).innerHTML = `<option value="all">${all}</option>` + vals.map(v => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(v || "(none)")}</option>`).join(""); };
    const vend = [...new Set(P.rows.map(r => r.vendor))].sort((a, b) => a.localeCompare(b));
    const cats = [...new Set(P.rows.filter(r => P.vendor === "all" || r.vendor === P.vendor).map(r => r.type))].sort((a, b) => a.localeCompare(b));
    if (P.cat !== "all" && !cats.includes(P.cat)) P.cat = "all";
    opt("pc-vendor", vend, P.vendor, "All vendors"); opt("pc-cat", cats, P.cat, "All categories");
  }

  const costOf = (r) => r.extra ? r.unit : P.edits.has(r.vid) ? money(P.edits.get(r.vid)) : P.pending.has(r.vid) ? P.pending.get(r.vid) : r.cost;
  const noCost = (c) => c == null || isNaN(c);
  // the cost stock is valued at: FIFO cost layers where a purchase order set the cost (JTCost), else the unit cost
  const layered = (r) => !r.extra && !P.edits.has(r.vid) && window.JTCost && window.JTCost.has(r.vid);
  const valCost = (r) => layered(r) ? window.JTCost.unit(r.vid, costOf(r)) : costOf(r);
  // the saved cost (sorting uses it, so a row doesn't jump while its cost is being typed)
  const savedCost = (r) => { if (r.extra) return r.unit; const c = P.pending.has(r.vid) ? P.pending.get(r.vid) : r.cost; return window.JTCost && window.JTCost.has(r.vid) ? window.JTCost.unit(r.vid, c) : c; };

  // ---- Units by location, in Shopify units ----
  // Shopify store: on hand in Shopify (last catalog sync; negative counts are shown but count as 0).
  // Prep center: the Prep center tab's stock. FBA / AWD: the Amazon inventory reports (FBA available + in transfer +
  // inbound; AWD available + inbound to AWD), turned into Shopify units through each listing's mapping (a 3-pack = 3).
  // Prep center and Amazon stock that isn't tied to a Shopify product is kept apart ("not tied to a product").
  const LOCS = [["shop", "Shopify store"], ["prep", "Prep center"], ["fba", "Amazon FBA"], ["awd", "Amazon AWD"]];
  let LC = { rows: null, fd: null, pd: null, by: new Map(), extra: [] };
  function locs() {
    const fd = JT.fba && JT.fba.data, pd = window.JTPrep && window.JTPrep.data;
    if (LC.rows === P.rows && LC.fd === fd && LC.pd === pd) return LC;
    const known = new Set((P.rows || []).map(r => r.vid)), by = new Map(), extra = [];
    const get = (v) => { let x = by.get(v); if (!x) by.set(v, x = { prep: 0, fba: 0, awd: 0, skus: [] }); return x; };
    // stock not tied to a Shopify product: a row of its own (no editable cost; Amazon listings use their manual cost)
    const ex = (key, o) => { const r = { extra: true, vid: key, pid: "", status: "", qty: 0, price: null, cost: o.unit, u: { shop: 0, prep: 0, fba: 0, awd: 0 }, ...o }; extra.push(r); return r; };
    if (pd) for (const r of pd.rows) {
      if (!(r.qty > 0)) continue;
      const v = String(r.vid);
      if (known.has(v)) get(v).prep += r.qty;
      else ex("p:" + v + "|" + r.asku, { src: "prep", title: r.title, sku: r.sku, vendor: r.vendor, type: r.type, unit: r.cost }).u.prep = r.qty;
    }
    if (fd) for (const it of fd.items) {
      const fu = JT.fba.unitsOf(it, true, "fba"), au = JT.fba.unitsOf(it, true, "awd");
      if (fu + au <= 0) continue;
      const v = it.map && it.map.vid ? String(it.map.vid) : null;
      if (v && known.has(v)) { const x = get(v), k = it.map.units || 1; x.fba += fu * k; x.awd += au * k; x.skus.push(it.sku); continue; }
      const r = ex("a:" + it.sku, { src: "amazon", title: it.name || it.sku, sku: it.sku, asin: it.asin, vendor: it.vendor, type: it.type, unit: it.cost, manual: !!(it.map && it.map.kind === "manual") });
      r.u.fba = fu; r.u.awd = au;
    }
    LC = { rows: P.rows, fd, pd, by, extra };
    return LC;
  }
  const NONE = { prep: 0, fba: 0, awd: 0, skus: [] };
  const unitsAt = (r) => { if (r.extra) return r.u; const x = locs().by.get(r.vid) || NONE; return { shop: r.qty > 0 ? r.qty : 0, prep: x.prep, fba: x.fba, awd: x.awd }; };
  const totalUnits = (u) => u.shop + u.prep + u.fba + u.awd;

  const matchesBase = (r, q) => (P.vendor === "all" || r.vendor === P.vendor) && (P.cat === "all" || r.type === P.cat)
    && (!q || [r.title, r.sku, r.vendor, r.asin || ""].join(" ").toLowerCase().includes(q));
  function visible() {
    if (!P.rows) return [];
    const q = P.q.trim().toLowerCase();
    const key = (r) => { const u = unitsAt(r); return P.sort === "cost" ? totalUnits(u) * (savedCost(r) || 0) : P.sort === "units" ? totalUnits(u) : u[P.sort] || 0; };
    const rows = P.rows.concat(locs().extra).filter(r => {
      if (!matchesBase(r, q) || (P.status !== "all" && r.status !== P.status)) return false;
      if (P.issue === "missing" && !noCost(costOf(r))) return false;
      if (P.issue === "edited" && !P.edits.has(r.vid)) return false;
      if (P.issue === "extra" && !r.extra) return false;
      if (P.where === "all") return true;
      const u = unitsAt(r);
      return P.where === "stock" ? totalUnits(u) > 0 || r.qty < 0 : u[P.where] > 0;
    });
    const k = new Map(rows.map(r => [r.vid, key(r)]));
    return P.sort === "name" ? rows.sort((a, b) => a.title.localeCompare(b.title))
      : rows.sort((a, b) => k.get(b.vid) - k.get(a.vid) || a.title.localeCompare(b.title));
  }

  // per-location units and cost for a set of product rows (+ optional stock not tied to a product)
  function sumUp(rows) {
    const t = { units: 0, cost: 0, noCost: 0, noCostUnits: 0, neg: 0, n: 0 };
    for (const [l] of LOCS) t[l] = { units: 0, cost: 0, noCostUnits: 0 };
    for (const r of rows) {
      if (r.qty < 0) t.neg++;
      const u = unitsAt(r), tu = totalUnits(u); if (!tu) continue;
      const c = valCost(r); t.n++;
      if (noCost(c)) { t.noCost++; t.noCostUnits += tu; }
      for (const [l] of LOCS) { t[l].units += u[l]; if (noCost(c)) t[l].noCostUnits += u[l]; else t[l].cost += u[l] * c; }
    }
    for (const [l] of LOCS) { t.units += t[l].units; t.cost += t[l].cost; }
    return t;
  }

  // Totals: every product with stock anywhere (any status), narrowed only by vendor, category and search
  function renderInv() {
    const el = $("pc-inv"); if (!P.rows) { el.innerHTML = ""; return; }
    const q = P.q.trim().toLowerCase();
    const scoped = P.vendor !== "all" || P.cat !== "all" || !!q;
    const L = locs(), every = P.rows.concat(L.extra), ex = L.extra.filter(x => matchesBase(x, q));
    const t = sumUp(every.filter(r => matchesBase(r, q)));
    const all = scoped ? sumUp(every) : t;
    const fd = L.fd, pd = L.pd;
    const scope = [P.vendor !== "all" ? esc(P.vendor || "(no vendor)") : "", P.cat !== "all" ? esc(P.cat || "(no category)") : "", q ? `“${esc(P.q.trim())}”` : ""].filter(Boolean).join(" · ");
    const day = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const when = P.asOf ? P.asOf.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    $("pc-inv-scope").innerHTML = (scoped ? `Filtered to ${scope} · all stock ${m0(all.cost)} at cost` : "All stock at cost: Shopify store, prep center, Amazon FBA and AWD")
      + (when ? ` · Shopify as of ${when}` : "") + (fd && fd.meta.snapshot ? ` · FBA report of ${day(fd.meta.snapshot)}` : "") + (fd && fd.awdMeta && fd.awdMeta.snapshot ? ` · AWD report of ${day(fd.awdMeta.snapshot)}` : "");
    const n = (x) => Math.round(x).toLocaleString();
    const loaded = { shop: true, prep: !!pd, fba: !!fd, awd: !!fd };
    const go = { prep: `<button class="linkbtn small" data-go-prep>open prep center</button>`, fba: `<button class="linkbtn small" data-go-fba>open Amazon inventory</button>`, awd: "" };
    const loc = (l, label) => {
      const x = t[l], exU = ex.reduce((a, e) => a + e.u[l], 0);
      const s = !loaded[l] ? (l === "prep" ? "loading…" : `No Amazon report loaded · ${go.fba}`)
        : [`${n(x.units)} units`, x.noCostUnits ? `${n(x.noCostUnits)} with no cost` : "", exU ? `<button class="linkbtn small" data-extra>${n(exU)} not tied to a Shopify product</button>` : "", go[l] || ""].filter(Boolean).join(" · ");
      return { l: `${label} at cost`, v: loaded[l] ? m0(x.cost) : "—", s };
    };
    const sh = (l) => t.cost ? ` (${pct(t[l].cost / t.cost)})` : "";
    el.innerHTML = [
      { c: "cost", l: "Total inventory at cost", v: m0(t.cost), s: `${n(t.units)} units · ` + LOCS.map(([l, lb]) => `${lb.replace("Amazon ", "")} ${m0(t[l].cost)}${sh(l)}`).join(" · ") },
      ...LOCS.map(([l, lb]) => loc(l, lb)),
      { l: "Not valued", v: n(t.noCostUnits), s: `units with no cost · ${t.noCost.toLocaleString()} product${t.noCost === 1 ? "" : "s"}${t.neg ? ` · ${t.neg} with negative Shopify on-hand` : ""} · <button class="linkbtn small" data-nocost>show them</button>` },
    ].map(k => `<div class="kpi ${k.c || ""}"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
  }

  // ---------- Over time (Nov 19, Brian: "a graph to show inventory over time … break down by vendor and category") ----------
  // jt.stock_value_history (migration 220): each month end's units and value at today's cost, by vendor, category and
  // location. Follows the page's Vendor and Category filters; split into locations, or the top 7 vendors/categories + Other.
  const H = (() => { let v = null; try { v = JSON.parse(localStorage.getItem("jt-pc-hist") || "null"); } catch (_) {} return Object.assign({ split: "loc", meas: "v" }, v || {}); })();
  let HD = null, HERR = null;
  async function loadHist(refresh) {
    try {
      const r = await JT.rows(["month::text", "vendor", "category", "store_u", "store_v", "prep_u", "prep_v", "fba_u", "fba_v", "awd_u", "awd_v", "has_store", "has_prep", "has_fba", "has_awd"],
        "from jt.stock_value_history(13)", refresh);
      const num = (x) => Number(x) || 0, b = (x) => x === true || x === "t" || x === "true";
      HD = r.map(x => ({ month: x[0], vendor: x[1], cat: x[2], u: { shop: num(x[3]), prep: num(x[5]), fba: num(x[7]), awd: num(x[9]) }, v: { shop: num(x[4]), prep: num(x[6]), fba: num(x[8]), awd: num(x[10]) },
        has: { shop: b(x[11]), prep: b(x[12]), fba: b(x[13]), awd: b(x[14]) } }));
      HERR = null;
    } catch (e) { HERR = e; }
    renderHist();
  }
  const HCOL = { shop: "var(--ch-jt)", prep: "var(--brand-gold)", fba: "var(--ch-amz)", awd: "color-mix(in srgb,var(--ch-amz) 45%,var(--panel))" };
  function renderHist() {
    const host = $("pc-hchart"); if (!host) return;
    document.querySelectorAll("#pc-hsplit button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === H.split)));
    document.querySelectorAll("#pc-hmeas button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === H.meas)));
    if (HERR) { host.innerHTML = `<div class="skel">Couldn't load the history: ${esc(JT.message(HERR))}</div>`; return; }
    if (!HD) { host.innerHTML = '<div class="skel">Loading…</div>'; return; }
    P.histKey = P.vendor + "|" + P.cat;
    const rows = HD.filter(r => (P.vendor === "all" || r.vendor === P.vendor) && (P.cat === "all" || r.cat === P.cat));
    const months = [...new Set(HD.map(r => r.month))].sort(), has = new Map();
    for (const r of HD) has.set(r.month, r.has);
    const K = H.meas === "v" ? "v" : "u", fmt = (x) => K === "v" ? m0(x) : Math.round(x).toLocaleString();
    const ax = (x) => K === "v" ? (Math.abs(x) >= 1e6 ? "$" + +(x / 1e6).toFixed(2) + "M" : Math.abs(x) >= 1000 ? "$" + +(x / 1000).toFixed(0) + "k" : "$" + Math.round(x)) : Math.abs(x) >= 1000 ? +(x / 1000).toFixed(1) + "k" : String(Math.round(x));
    const tot = (r) => r[K].shop + r[K].prep + r[K].fba + r[K].awd;
    // series: locations, or the top 7 groups (by the latest month) + Other
    let series;
    if (H.split === "loc") series = LOCS.map(([l, lb]) => ({ key: l, label: lb, color: HCOL[l], val: (mo) => rows.filter(r => r.month === mo).reduce((a, r) => a + r[K][l], 0), known: (mo) => (has.get(mo) || {})[l] }));
    else {
      const g = (r) => H.split === "vendor" ? r.vendor : r.cat, last = months[months.length - 1], score = new Map();
      for (const r of rows) if (r.month === last) score.set(g(r), (score.get(g(r)) || 0) + tot(r));
      for (const r of rows) if (!score.has(g(r))) score.set(g(r), 0);
      const top = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(x => x[0]), topS = new Set(top);
      series = top.map((name, i) => ({ key: name, label: name, color: `var(--g${i + 1})`, val: (mo) => rows.filter(r => r.month === mo && g(r) === name).reduce((a, r) => a + tot(r), 0) }));
      if (score.size > top.length) series.push({ key: "__other", label: `Other (${score.size - top.length})`, color: "var(--g8)", val: (mo) => rows.filter(r => r.month === mo && !topS.has(g(r))).reduce((a, r) => a + tot(r), 0) });
    }
    const data = months.map(mo => ({ mo, vals: series.map(s => s.val(mo)) })), sumOf = (d) => d.vals.reduce((a, x) => a + x, 0);
    const miss = (l) => months.filter(mo => !(has.get(mo) || {})[l]);
    const lab = (mo) => new Date(mo + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) + " ’" + mo.slice(2, 4);
    const gaps = [["prep", "Prep center"], ["awd", "AWD"]].map(([l, lb]) => { const ms = miss(l); return ms.length ? `${lb} history starts ${lab(months.find(mo => !ms.includes(mo)) || months[months.length - 1])}` : ""; }).filter(Boolean);
    $("pc-hnote").textContent = `Each month's end (this month: now), valued at today's Shopify unit cost. Store from Shopify's inventory history, FBA from Amazon's inventory ledger.${gaps.length ? " " + gaps.join("; ") + " (earlier months count it as unknown, not zero)." : ""}${P.vendor !== "all" || P.cat !== "all" ? ` Filtered to ${[P.vendor !== "all" ? P.vendor : "", P.cat !== "all" ? P.cat : ""].filter(Boolean).join(" · ")}.` : ""}`;
    $("pc-hlegend").innerHTML = series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join("");
    const W = Math.max(320, host.clientWidth || 800), Hh = W < 560 ? 220 : 280, pad = { l: 64, r: 12, t: 12, b: 28 }, iw = W - pad.l - pad.r, ih = Hh - pad.t - pad.b;
    const nice = (v) => { if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))); for (const f of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (f * e >= v) return f * e; return 10 * e; };
    const step = nice(Math.max(1, ...data.map(sumOf)) / 4), max = Math.ceil(Math.max(1, ...data.map(sumOf)) / step) * step, y = (v) => pad.t + ih - v / max * ih, bw = iw / Math.max(1, data.length);
    let s = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Inventory ${K === "v" ? "value" : "units"} at each month end">`;
    for (let t = 0; t <= max + step / 2; t += step) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line-soft)"/><text x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="var(--faint)" font-family="var(--mono)">${ax(t)}</text>`;
    data.forEach((d, i) => {
      const x = pad.l + i * bw, w = Math.min(48, bw * 0.66), bx = x + (bw - w) / 2; let base = 0;
      d.vals.forEach((v, j) => { if (!(v > 0)) return; const h = y(base) - y(base + v); s += `<rect x="${bx}" y="${y(base + v)}" width="${w}" height="${Math.max(0, h - (h > 2 ? 1 : 0))}" fill="${series[j].color}"/>`; base += v; });
      s += `<text x="${x + bw / 2}" y="${Hh - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${lab(d.mo)}</text>`;
    });
    data.forEach((d, i) => { s += `<rect data-i="${i}" x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${ih}" fill="transparent"/>`; });
    host.innerHTML = s + `</svg><div class="tip" hidden></div>`;
    const svg = host.querySelector("svg"), tip = host.querySelector(".tip");
    svg.addEventListener("pointermove", (ev) => {
      const t = ev.target.closest("rect[data-i]"); if (!t) { tip.hidden = true; return; }
      const i = +t.dataset.i, d = data[i], prev = data[i - 1], sb = svg.getBoundingClientRect(), box = host.getBoundingClientRect();
      tip.innerHTML = `<b>${i === data.length - 1 ? "Now" : "End of " + lab(d.mo)}</b> · ${fmt(sumOf(d))}${prev ? ` <span class="dim">(${sumOf(d) - sumOf(prev) >= 0 ? "+" : ""}${fmt(sumOf(d) - sumOf(prev))})</span>` : ""}`
        + series.map((se, j) => ({ se, v: d.vals[j] })).reverse().map(({ se, v }) => `<br><span class="gsw" style="background:${se.color}"></span>${esc(se.label)} <b>${se.known && !se.known(d.mo) ? "no data" : fmt(v)}</b>`).join("");
      tip.hidden = false; tip.style.left = Math.min(Math.max((pad.l + i * bw + bw / 2) * sb.width / W, 120), box.width - 120) + "px"; tip.style.top = (svg.offsetTop + (pad.t + ih * 0.3) * sb.height / Hh) + "px";
    });
    svg.addEventListener("pointerleave", () => { tip.hidden = true; });
    // table: each series, 12 months ago / 3 months ago / now, and the change
    const at = (k) => data[Math.max(0, data.length - 1 - k)], cols = [[12, "12 months ago"], [6, "6 months ago"], [3, "3 months ago"], [1, "Last month"], [0, "Now"]].filter(([k]) => k < data.length);
    const cell = (j, d, se) => se.known && !se.known(d.mo) ? '<td class="dim">no data</td>' : `<td>${fmt(d.vals[j])}</td>`;
    const first = at(cols[0][0]), now = at(0), chg = (j) => now.vals[j] - first.vals[j];
    $("pc-htbl").innerHTML = `<thead><tr><th class="l">${H.split === "loc" ? "Location" : H.split === "vendor" ? "Vendor" : "Category"}</th>${cols.map(([k, l]) => `<th>${l}<div class="meta">${lab(at(k).mo)}</div></th>`).join("")}<th>Change</th></tr></thead><tbody>${
      series.map((se, j) => `<tr><td class="l"><span class="gsw" style="background:${se.color}"></span>${esc(se.label)}</td>${cols.map(([k]) => cell(j, at(k), se)).join("")}<td class="${chg(j) < 0 ? "neg" : ""}">${se.known && !se.known(first.mo) ? "—" : (chg(j) >= 0 ? "+" : "") + fmt(chg(j))}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td class="l">Total</td>${cols.map(([k]) => `<td>${fmt(sumOf(at(k)))}</td>`).join("")}<td>${(sumOf(now) - sumOf(first) >= 0 ? "+" : "") + fmt(sumOf(now) - sumOf(first))}</td></tr></tfoot>`;
  }
  ["pc-hsplit", "pc-hmeas"].forEach(id => $(id).addEventListener("click", (e) => { const b = e.target.closest("button[data-v]"); if (!b) return;
    H[id === "pc-hsplit" ? "split" : "meas"] = b.dataset.v; try { localStorage.setItem("jt-pc-hist", JSON.stringify(H)); } catch (_) {} renderHist(); }));

  // move stock between the store, the prep center and Amazon (stockmove.js); nothing in the store but stock in the
  // prep center gets the one-click "→ Store" (Brian, Oct 23)
  function moveBtn(r, u) {
    if (!window.JTMove || !(u.shop > 0 || u.prep > 0)) return "";
    const empty = !(r.qty > 0) && u.prep > 0;
    return ` <button class="mini ${empty ? "primary" : ""}" type="button" data-move="${esc(r.vid)}" title="${empty ? "Nothing in the Shopify store — move some from the prep center so it sells online" : "Move units between the Shopify store, the prep center and Amazon"}">${empty ? "→ Store" : "Move"}</button>`;
  }
  let pageRows = [];
  function render() {
    if ($("tab-costs").hidden) return;
    const t = $("pc-table");
    if (!P.rows) { t.innerHTML = `<tbody><tr><td class="l muted">${P.loading ? "Loading…" : ""}</td></tr></tbody>`; $("pc-inv").innerHTML = ""; return; }
    const rows = visible();
    renderInv();
    if (P.histKey !== P.vendor + "|" + P.cat) { P.histKey = P.vendor + "|" + P.cat; renderHist(); }
    const vt = sumUp(rows);
    const pages = Math.max(1, Math.ceil(rows.length / PER)); if (P.page >= pages) P.page = pages - 1;
    pageRows = rows.slice(P.page * PER, P.page * PER + PER);
    const ae = document.activeElement, keep = ae && ae.dataset && ae.dataset.vid, sel = keep ? [ae.selectionStart, ae.selectionEnd] : null;
    const cell = (u, c) => !u ? '<span class="dim">—</span>' : `${Math.round(u).toLocaleString()}${noCost(c) ? "" : `<div class="meta">${m0(u * c)}</div>`}`;
    t.innerHTML = `<thead><tr><th class="l">Product</th><th class="l">Vendor · category</th><th>Unit cost</th><th title="Shopify store on hand">Store</th><th title="Prep center">Prep</th><th title="Amazon FBA (incl. inbound)">FBA</th><th title="Amazon AWD (incl. inbound)">AWD</th><th>Total units</th><th>Ext. cost</th><th class="l">Status</th></tr></thead><tbody>${
      pageRows.map((r) => {
        if (r.extra) {
          const tu = totalUnits(r.u);
          return `<tr class="${r.unit == null ? "flag-bad" : r.manual ? "" : "flag-warn"}">
          <td class="l">${esc(r.title)}<div class="meta"><span class="mono">${esc(r.sku) || "no SKU"}</span>${r.asin ? ` · ${esc(r.asin)}` : ""}</div></td>
          <td class="l">${esc(r.vendor)}<div class="meta">${esc(r.type || "—")}</div></td>
          <td>${r.unit == null ? '<span class="dim">no cost</span>' : m(r.unit)}${r.manual ? '<div class="meta">Amazon cost</div>' : ""}</td>
          <td><span class="dim">—</span></td><td>${cell(r.u.prep, r.unit)}</td><td>${cell(r.u.fba, r.unit)}</td><td>${cell(r.u.awd, r.unit)}</td>
          <td><b>${Math.round(tu).toLocaleString()}</b></td>
          <td><b>${r.unit == null ? '<span class="dim">no cost</span>' : m0(tu * r.unit)}</b></td>
          <td class="l">${r.manual ? '<span class="pill manual" title="Marked as having no Shopify product, with an Amazon cost (Amazon mapping)">No Shopify product</span>'
            : `<span class="pill ${r.unit == null ? "miss" : "warn"}" title="${r.src === "amazon" ? "This Amazon listing isn't mapped to a Shopify product" : "This prep center product isn't in Shopify"}">Not tied to Shopify</span>${r.src === "amazon" ? ' <button class="mini" data-go="amzmap">Map it</button>' : ""}`}</td></tr>`;
        }
        const c = costOf(r), vc = valCost(r), edited = P.edits.has(r.vid), v = edited ? P.edits.get(r.vid) : c == null ? "" : c.toFixed(2);
        const bad = edited && (noCost(c) || c < 0);
        const u = unitsAt(r), tu = totalUnits(u), x = locs().by.get(r.vid);
        const pill = P.pending.has(r.vid) && !edited ? '<span class="pill warn">Saving to Shopify</span>' : noCost(c) ? (tu ? '<span class="pill miss">No cost</span>' : '<span class="pill">No cost</span>') : "";
        return `<tr data-item-row="${esc(r.vid)}" title="Click for sales, cost and inventory history" class="${noCost(c) && tu ? "flag-bad" : ""}">
          <td class="l"><a class="olink" href="${ADMIN}/products/${esc(r.pid)}/variants/${esc(r.vid)}" target="_blank" rel="noopener">${esc(r.title)}</a><div class="meta"><span class="mono">${esc(r.sku) || "no SKU"}</span>${r.status !== "ACTIVE" ? " · " + esc(r.status.toLowerCase()) : ""}${x && x.skus.length ? ` · <span title="Amazon seller SKUs">${esc(x.skus.slice(0, 3).join(", "))}${x.skus.length > 3 ? "…" : ""}</span>` : ""}</div></td>
          <td class="l">${esc(r.vendor)}<div class="meta">${esc(r.type || "—")}</div></td>
          <td><input class="pcin ${edited ? "edited" : ""} ${bad ? "bad" : ""}" data-vid="${esc(r.vid)}" value="${esc(v)}" inputmode="decimal" aria-label="Unit cost for ${esc(r.title)}">${edited && r.cost != null ? `<div class="meta">was ${m(r.cost)}</div>` : layered(r) ? `<div class="meta" title="${esc(window.JTCost.describe(r.vid))}">FIFO ${m(vc)}</div>` : ""}</td>
          <td class="${r.qty < 0 ? "neg" : ""}">${r.qty < 0 ? r.qty.toLocaleString() : cell(u.shop, vc)}</td>
          <td>${cell(u.prep, vc)}</td><td>${cell(u.fba, vc)}</td><td>${cell(u.awd, vc)}</td>
          <td><b>${tu ? Math.round(tu).toLocaleString() : '<span class="dim">0</span>'}</b></td>
          <td><b>${!tu ? '<span class="dim">—</span>' : noCost(vc) ? '<span class="dim">no cost</span>' : m0(tu * vc)}</b></td>
          <td class="l">${pill}${moveBtn(r, u)}</td></tr>`;
      }).join("") || `<tr><td class="l muted" colspan="10">No products match these filters.</td></tr>`}</tbody>${rows.length ? `<tfoot><tr>
          <td class="l"><b>Total · ${rows.length.toLocaleString()} in view</b></td><td></td><td></td>
          ${LOCS.map(([l]) => `<td><b>${Math.round(vt[l].units).toLocaleString()}</b><div class="meta">${m0(vt[l].cost)}</div></td>`).join("")}
          <td><b>${Math.round(vt.units).toLocaleString()}</b></td><td><b>${m0(vt.cost)}</b>${vt.noCostUnits ? `<div class="meta">${Math.round(vt.noCostUnits).toLocaleString()} units not valued</div>` : ""}</td><td></td></tr></tfoot>` : ""}`;
    if (keep) { const el = t.querySelector(`input[data-vid="${CSS.escape(keep)}"]`); if (el) { el.focus(); try { el.setSelectionRange(sel[0], sel[1]); } catch (_) {} } }
    $("pc-prev").hidden = P.page === 0; $("pc-next").hidden = P.page >= pages - 1;
    $("pc-count").textContent = rows.length ? `${P.page * PER + 1}–${P.page * PER + pageRows.length} of ${rows.length.toLocaleString()}` : "";
    const valid = [...P.edits.entries()].filter(([, v]) => { const c = money(v); return c != null && !isNaN(c) && c >= 0; });
    $("pc-save").disabled = !valid.length || P.saving; $("pc-save").textContent = valid.length ? `Save ${valid.length} cost${valid.length === 1 ? "" : "s"} to Shopify` : "Save costs to Shopify";
    $("pc-discard").disabled = !P.edits.size || P.saving;
    $("pc-csv").disabled = !rows.length;
    const cf = $("pc-confirm");
    if (P.confirm && valid.length) {
      cf.hidden = false;
      cf.innerHTML = `<div class="note warn">Write ${valid.length} unit cost${valid.length === 1 ? "" : "s"} to Shopify? This changes the cost Shopify uses for new orders and profit reports. <span class="dbtns"><button class="mini primary" id="pc-yes">Yes, save</button><button class="mini" id="pc-no">Cancel</button></span></div>`;
    } else { cf.hidden = true; cf.innerHTML = ""; }
  }

  // CSV of every row in view (all pages): units and cost per location, at the cost stock is valued at (FIFO where set)
  async function saveFile(name, data, mimeType) {
    const d = window.claude && window.claude.use ? await window.claude.use("downloads").catch(() => null) : null;
    if (d) { try { await d.save({ filename: name, data, mimeType }); } catch (e) { if (e && e.code !== "declined") note("warn", esc(JT.message(e))); } return; }
    const a = document.createElement("a"), url = URL.createObjectURL(new Blob([data], { type: mimeType }));
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function csv() {
    const q = (x) => /[",\n]/.test(String(x ?? "")) ? `"${String(x).replace(/"/g, '""')}"` : String(x ?? "");
    const r2 = (x) => x == null || isNaN(x) ? "" : (Math.round(x * 100) / 100).toFixed(2);
    const lines = [["Product", "SKU", "Amazon SKUs", "ASIN", "Vendor", "Category", "Status", "Tied to Shopify", "Unit cost", "Cost basis",
      "Store units", "Store cost", "Prep units", "Prep cost", "FBA units", "FBA cost", "AWD units", "AWD cost", "Total units", "Ext. cost"].join(",")];
    for (const r of visible()) {
      const u = unitsAt(r), c = valCost(r), x = !r.extra && locs().by.get(r.vid);
      const at = (n) => noCost(c) ? "" : r2(n * c);
      lines.push([r.title, r.extra ? "" : r.sku, r.extra ? (r.src === "amazon" ? r.sku : "") : x ? x.skus.join(" ") : "", r.asin || "", r.vendor, r.type, r.status.toLowerCase(),
        r.extra ? "no" : "yes", r2(c), noCost(c) ? "no cost" : layered(r) ? "FIFO" : P.edits.has(r.vid) ? "edited, not saved" : r.manual ? "manual" : "unit cost",
        u.shop, at(u.shop), u.prep, at(u.prep), u.fba, at(u.fba), u.awd, at(u.awd), totalUnits(u), at(totalUnits(u))].map(q).join(","));
    }
    const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await saveFile(`inventory-value_${day}.csv`, lines.join("\n"), "text/csv");
  }

  async function save() {
    const list = [...P.edits.entries()].map(([vid, v]) => ({ variant_id: Number(vid), cost: money(v), vid })).filter(x => x.cost != null && !isNaN(x.cost) && x.cost >= 0);
    if (!list.length) return;
    P.saving = true; P.confirm = false; render();
    try {
      const n = await JT.queueCostUpdates(list.map(({ variant_id, cost }) => ({ variant_id, cost: Math.round(cost * 100) / 100 })));
      for (const x of list) { P.pending.set(x.vid, Math.round(x.cost * 100) / 100); P.edits.delete(x.vid); }
      note("info", `Saved ${n} cost${n === 1 ? "" : "s"}. The sync writes them to Shopify within about a minute; press Refresh after that to see them confirmed.`);
    } catch (e) { note("bad", "Couldn't save: " + esc(JT.message(e))); }
    finally { P.saving = false; render(); }
  }

  function bind() {
    const t = $("pc-table");
    t.addEventListener("input", (e) => {
      const el = e.target; if (!el.dataset.vid) return;
      const r = P.rows.find(x => x.vid === el.dataset.vid); const c = money(el.value);
      const orig = P.pending.has(r.vid) ? P.pending.get(r.vid) : r.cost;
      if (el.value.trim() === "" && orig == null || (c != null && !isNaN(c) && orig != null && Math.abs(c - orig) < 0.005)) P.edits.delete(r.vid); else P.edits.set(r.vid, el.value);
      clearTimeout(t._t); t._t = setTimeout(render, 500);
      el.classList.toggle("edited", P.edits.has(r.vid));
      $("pc-save").disabled = !P.edits.size;
    });
    t.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !e.target.dataset.vid) return;
      e.preventDefault(); const ins = [...t.querySelectorAll("input.pcin")]; const i = ins.indexOf(e.target);
      const next = ins[i + (e.shiftKey ? -1 : 1)]; clearTimeout(t._t); render();
      const el = next && t.querySelector(`input[data-vid="${CSS.escape(next.dataset.vid)}"]`); if (el) { el.focus(); el.select(); }
    });
    t.addEventListener("focusout", () => { clearTimeout(t._t); t._t = setTimeout(render, 150); });
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on("pc-vendor", "change", (e) => { P.vendor = e.target.value; P.page = 0; fillFilters(); render(); });
    on("pc-cat", "change", (e) => { P.cat = e.target.value; P.page = 0; render(); });
    on("pc-stat", "change", (e) => { P.status = e.target.value; P.page = 0; render(); });
    on("pc-issue", "change", (e) => { P.issue = e.target.value; P.page = 0; render(); });
    on("pc-where", "change", (e) => { P.where = e.target.value; P.page = 0; render(); });
    on("pc-sort", "change", (e) => { P.sort = e.target.value; P.page = 0; render(); });
    on("pc-q", "input", (e) => { P.q = e.target.value; P.page = 0; clearTimeout(e.target._t); e.target._t = setTimeout(render, 200); });
    on("pc-refresh", "click", () => load(true));
    on("pc-prev", "click", () => { P.page--; render(); $("pc-table").scrollIntoView({ block: "start" }); });
    on("pc-next", "click", () => { P.page++; render(); $("pc-table").scrollIntoView({ block: "start" }); });
    on("pc-csv", "click", () => csv());
    on("pc-discard", "click", () => { P.edits.clear(); P.confirm = false; render(); });
    on("pc-save", "click", () => { P.confirm = true; render(); });
    t.addEventListener("click", (e) => {
      const g = e.target.closest("button[data-go]"); if (g) { const b = document.querySelector(`.tabs button[data-tab="${g.dataset.go}"]`); if (b) b.click(); return; }
      const mv = e.target.closest("button[data-move]"); if (mv && window.JTMove) { window.JTMove.open(mv.dataset.move); return; }
      const row = e.target.closest("tr[data-item-row]");
      if (row && !e.target.closest("button, a, input, select, label, textarea") && !String(window.getSelection() || "") && window.JTItem) window.JTItem.open(row.dataset.itemRow);
    });
    $("pc-inv").addEventListener("click", (e) => {
      if (e.target.closest("[data-extra]")) { P.issue = "extra"; P.where = "stock"; P.page = 0; $("pc-issue").value = "extra"; $("pc-where").value = "stock"; render(); $("pc-table").scrollIntoView({ block: "start" }); return; }
      if (e.target.closest("[data-nocost]")) { P.issue = "missing"; P.where = "stock"; P.page = 0; $("pc-issue").value = "missing"; $("pc-where").value = "stock"; render(); $("pc-table").scrollIntoView({ block: "start" }); return; }
      const go = e.target.closest("[data-go-fba]") ? "fba" : e.target.closest("[data-go-prep]") ? "prep" : null;
      if (go) { const b = document.querySelector(`.tabs button[data-tab="${go}"]`); if (b) b.click(); }
    });
    $("pc-confirm").addEventListener("click", (e) => { if (e.target.id === "pc-yes") save(); if (e.target.id === "pc-no") { P.confirm = false; render(); } });
    window.addEventListener("beforeunload", (e) => { if (P.edits.size) { e.preventDefault(); e.returnValue = ""; } });
  }

  bind();
  window.pcRender = () => render();
  window.addEventListener("jt:catalog", () => { if (!$("tab-costs").hidden) load(true); else P.shown = false; });
  // a move made here: show the store number right away (Shopify itself updates in a minute or two)
  window.addEventListener("jt:stockmoved", (e) => { const d = e.detail || {}, r = P.rows && P.rows.find(x => x.vid === String(d.vid));
    if (r && d.shop) r.qty = (r.qty || 0) + d.shop; render(); });
  window.addEventListener("jt:changed", () => { if ($("tab-costs").hidden) P.stale = true; });
  window.pcShow = () => { if (!P.shown || P.stale) { P.shown = true; P.stale = false; load(true); } else render(); };
  window.JTCosts = { _state: P };
  if ((location.hash || "") === "#costs") setTimeout(() => window.pcShow(), 0);
})();
