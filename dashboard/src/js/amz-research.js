(() => {
  // ===================== Buying › Amazon Research =====================
  // SKUs sent to Amazon (FBA and AWD inbound shipments) in a date range: how many shipments and units, and what
  // Amazon has received. jt.v_amz_shipped (migration 134) over jt.inbound_shipments / jt.inbound_shipment_items.
  // More columns will be added as this is built out (Brian, Oct 13).
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const n0 = (x) => Math.round(Number(x) || 0).toLocaleString();
  const JT = window.JT, PER = 200;
  const fmt = (d) => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";

  const addDays = window.JTDate.addDays;
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  // Amazon sales by SKU (jt.amazon_sku_daily, order date, Pacific) for fixed windows ending today: [key, days back from, to)
  const SALES = [["7", 0, 7], ["30", 0, 30], ["90", 0, 90], ["365", 0, 365], ["730", 365, 730]];
  // profit for one window (Brian, Oct 13): picked above the profit columns
  const PWIN = [["7", "7d"], ["30", "30d"], ["90", "90d"], ["365", "12m"], ["730", "13–24m"]];
  const INBOUND_FEES = ["FBAPostInboundTransportation", "FBAInboundConvenience", "AWDTransportationFee", "AWDMcdTransportationFee", "AWDProcessingFee"];
  const R = { pw: "365", profId: 0, prof: null, profErr: null, inRate: null, preset: "90", start: null, end: null, kind: "all", q: "", sort: ["u", -1], shown: PER, rows: null, err: null, loading: false, reqId: 0, since: null, shown0: false };

  window.JTRange.seg("ar-rangeseg", "r");
  function setRange(r) {
    R.preset = r; [R.start, R.end] = window.JTRange.of(r);
    $("ar-start").value = R.start; $("ar-end").value = R.end;
    document.querySelectorAll("#ar-rangeseg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.r === r)));
  }

  async function load(refresh) {
    const id = ++R.reqId; R.loading = true; R.err = null; render();
    loadProfit(refresh);
    try {
      const k = (kind, col, agg) => `${agg}(${col}) filter (where kind = '${kind}')`;
      const T = window.JTDate.today();
      const [rows, sd, meta] = await Promise.all([
        JT.rows(["a.sku", "coalesce(l.title, f.name, '')", "coalesce(l.asin, f.asin, '')",
          "a.nf", "a.uf", "a.rf", "a.na", "a.ua", "a.ra", "a.last_f::text", "a.last_a::text",
          "f.fulfillable", "coalesce(f.inbound_working, 0) + coalesce(f.inbound_shipped, 0) + coalesce(f.inbound_receiving, 0)",
          "d.u7", "d.u30", "d.u90", "d.u365", "d.u730", "d.s7", "d.s30", "d.s90", "d.s365", "d.s730"],
          `from (select sku, count(distinct shipment_id) filter (where kind = 'FBA') nf, ${k("FBA", "units_sent", "sum")} uf, ${k("FBA", "units_received", "sum")} rf,
                   count(distinct shipment_id) filter (where kind = 'AWD') na, ${k("AWD", "units_sent", "sum")} ua, ${k("AWD", "units_received", "sum")} ra,
                   ${k("FBA", "sent_on", "max")} last_f, ${k("AWD", "sent_on", "max")} last_a
                 from jt.v_amz_shipped where sent_on between ${JT.day(R.start)} and ${JT.day(R.end)} group by sku) a
           left join lateral (select x.title, x.asin from jt.amazon_listings x where x.sku = a.sku order by x.uploaded_at desc nulls last limit 1) l on true
           left join jt.fba_inventory f on f.sku = a.sku
           left join (select sku, ${SALES.map(([k, a, b]) => `coalesce(sum(units) filter (where day between ${JT.day(addDays(T, -b + 1))} and ${JT.day(addDays(T, -a))}), 0) u${k}, coalesce(sum(sales) filter (where day between ${JT.day(addDays(T, -b + 1))} and ${JT.day(addDays(T, -a))}), 0) s${k}`).join(", ")}
                      from jt.amazon_sku_daily where day > ${JT.day(addDays(T, -730))} group by sku) d on d.sku = a.sku`, refresh),
        JT.rows(["min(day)::text"], "from jt.amazon_sku_daily", refresh),
        JT.rows(["min(sent_on)::text", "max(s.synced_at)::text"], "from jt.v_amz_shipped v join jt.inbound_shipments s on s.id = v.shipment_id", refresh),
      ]);
      if (id !== R.reqId) return;
      const N = (x) => Number(x) || 0;
      R.rows = rows.map(r => ({ sku: r[0], title: r[1], asin: r[2], nf: N(r[3]), uf: N(r[4]), rf: N(r[5]), na: N(r[6]), ua: N(r[7]), ra: N(r[8]),
        lastF: r[9] || "", lastA: r[10] || "", avail: r[11] == null ? null : N(r[11]), inbound: N(r[12]),
        u7: N(r[13]), u30: N(r[14]), u90: N(r[15]), u365: N(r[16]), u730: N(r[17]), s7: N(r[18]), s30: N(r[19]), s90: N(r[20]), s365: N(r[21]), s730: N(r[22]) }));
      R.salesFrom = sd[0] ? sd[0][0] : null; R.today = T;
      R.since = meta[0] ? meta[0][0] : null; R.synced = meta[0] ? meta[0][1] : null;
    } catch (e) { if (id === R.reqId) { R.err = e; R.rows = null; } }
    if (id !== R.reqId) return;
    R.loading = false; render();
  }

  // Profit per SKU for the picked window: Amazon's numbers by order date (jt.amazon_sku_daily, migration 136), product cost
  // from the Amazon → Shopify cost map (jt.mv_amz_sku_cost: Shopify unit cost × units per Amazon unit, or a manual cost),
  // and inbound fees per unit = Amazon's inbound fees (no SKU on them) ÷ units sent to Amazon, both over the last 12 months.
  async function loadProfit(refresh) {
    const id = ++R.profId; R.profErr = null;
    try {
      const T = window.JTDate.today(), [a, b] = (SALES.find(x => x[0] === R.pw) || SALES[3]).slice(1);
      const from = addDays(T, -b + 1), to = addDays(T, -a), y0 = addDays(T, -364);
      const [pr, inb] = await Promise.all([
        JT.rowsSplit(["d.sku", "sum(d.units)", "sum(d.sales)", "sum(d.ship)", "sum(d.promo)", "sum(d.sellfees)", "sum(d.fbafees)", "sum(d.labels)",
          "sum(d.refund_units)", "sum(d.refund_net)", "max(c.cost)", "bool_or(c.cost is not null)"],
          `from jt.amazon_sku_daily d left join lateral (select m.cost from jt.mv_amz_sku_cost m where m.sku = d.sku and m.cost is not null limit 1) c on true
           where d.day between ${JT.day(from)} and ${JT.day(to)} group by d.sku`, "d.sku", 2, refresh),
        JT.rows(["(select -coalesce(sum(total), 0) from jt.v_amazon_fin_lines where kind = 'other' and description in (" + INBOUND_FEES.map(x => `'${x}'`).join(", ") + ") and day between " + JT.day(y0) + " and " + JT.day(T) + ")",
          "(select coalesce(sum(units_sent), 0) from jt.v_amz_shipped where sent_on between " + JT.day(y0) + " and " + JT.day(T) + ")"], "", refresh),
      ]);
      if (id !== R.profId) return;
      const N = (x) => Number(x) || 0;
      const fees = N(inb[0] && inb[0][0]), sent = N(inb[0] && inb[0][1]);
      R.inRate = sent > 0 ? { rate: fees / sent, fees, sent } : null;
      R.prof = new Map(pr.map(r => [r[0], { units: N(r[1]), sales: N(r[2]), ship: N(r[3]), promo: N(r[4]), sellfees: N(r[5]), fbafees: N(r[6]), labels: N(r[7]),
        ru: N(r[8]), rnet: N(r[9]), cost: r[10] == null ? null : N(r[10]), hasCost: r[11] === true || r[11] === "t" || r[11] === "true" }]));
    } catch (e) { if (id === R.profId) { R.profErr = e; R.prof = null; } }
    if (id === R.profId) render();
  }
  // a SKU's profit for the picked window (signs: money out is negative)
  function profitOf(sku) {
    const p = R.prof && R.prof.get(sku); if (!p || (!p.units && !p.rnet)) return null;
    const cogs = p.cost == null ? null : -p.cost * p.units;
    const inbound = R.inRate ? -R.inRate.rate * p.units : 0;
    const other = p.ship + p.promo;
    const profit = p.sales + other + p.sellfees + p.fbafees - p.labels + p.rnet + (cogs || 0) + inbound;
    return { ...p, cogs, inbound, other, profit, margin: p.sales ? profit / p.sales : null, perUnit: p.units ? profit / p.units : null };
  }

  // the row as the FBA / AWD / both toggle sees it
  function view(r) {
    const f = R.kind !== "AWD", a = R.kind !== "FBA";
    const last = [f && r.lastF, a && r.lastA].filter(Boolean).sort().pop() || "";
    const pf = profitOf(r.sku);
    return { ...r, n: (f ? r.nf : 0) + (a ? r.na : 0), u: (f ? r.uf : 0) + (a ? r.ua : 0), rec: (f ? r.rf : 0) + (a ? r.ra : 0), last, pf,
      p_sales: pf ? pf.sales : 0, p_profit: pf ? pf.profit : null, p_margin: pf ? pf.margin : null, p_unit: pf ? pf.perUnit : null,
      p_sell: pf ? pf.sellfees : null, p_fba: pf ? pf.fbafees : null, p_lab: pf ? -pf.labels : null, p_other: pf ? pf.other : null, p_ref: pf ? pf.rnet : null,
      p_cogs: pf ? pf.cogs : null, p_in: pf ? pf.inbound : null, p_ads: null };
  }

  const mny = (x) => x == null ? '<span class="dim">—</span>' : Math.abs(x) < 0.5 ? '<span class="dim">$0</span>' : `<span class="${x < 0 ? "neg" : ""}">${x < 0 ? "−" : ""}${usd0.format(Math.abs(x))}</span>`;
  function profCells(pf) {
    if (!R.prof) return `<td class="bl dim" colspan="${NPROF}">${R.profErr ? "—" : "…"}</td>`;
    if (!pf) return `<td class="bl"><span class="dim">no sales</span></td>` + `<td></td>`.repeat(NPROF - 1);
    const pct = pf.margin == null ? "—" : Math.round(pf.margin * 100) + "%";
    return `<td class="bl"><b>${mny(pf.sales)}</b><div class="meta">${n0(pf.units)} unit${pf.units === 1 ? "" : "s"}</div></td><td>${mny(pf.sellfees)}</td><td>${mny(pf.fbafees)}</td><td>${mny(-pf.labels)}</td><td>${mny(pf.other)}</td>
      <td>${mny(pf.rnet)}${pf.ru ? `<div class="meta">${n0(pf.ru)} returned</div>` : ""}</td>
      <td>${pf.cogs == null ? '<span class="pill miss" title="No product cost: map this SKU on Setup › Amazon mapping">no cost</span>' : mny(pf.cogs)}${pf.cost != null ? `<div class="meta">${usd0.format(pf.cost)}/unit</div>` : ""}</td>
      <td>${mny(pf.inbound)}</td><td><span class="dim" title="Waiting on the Amazon Ads API">—</span></td>
      <td><b>${mny(pf.profit)}</b>${pf.cogs == null ? '<div class="meta">before COGS</div>' : ""}</td><td>${pct}</td><td>${pf.perUnit == null ? "—" : mny(pf.perUnit)}</td>`;
  }
  const COLS = [["sku", "SKU", 0], ["title", "Product", 0], ["n", "Shipments", 1], ["u", "Units sent", 1], ["rec", "Received", 1], ["last", "Last sent", 0], ["avail", "FBA available now", 1], ["inbound", "Inbound now", 1],
    ["u7", "Sold 7d", 1], ["u30", "Sold 30d", 1], ["u90", "Sold 90d", 1], ["u365", "Sold 12m", 1], ["u730", "Sold 13–24m", 1],
    ["p_sales", "Sales", 1], ["p_sell", "Referral & selling fees", 1], ["p_fba", "FBA fees", 1], ["p_lab", "FBM labels", 1], ["p_other", "Ship credits & promos", 1],
    ["p_ref", "Refunds", 1], ["p_cogs", "COGS", 1], ["p_in", "Inbound", 1], ["p_ads", "Ads", 1], ["p_profit", "Profit", 1], ["p_margin", "Margin", 1], ["p_unit", "Profit / unit", 1]];
  const NSHIP = 8, NSOLD = 5, NPROF = 12;
  function render() {
    if ($("tab-amzres").hidden) return;
    const st = $("ar-status");
    st.textContent = R.loading ? "Loading shipments…" : R.err ? "" : R.rows ? `${window.JTRange.label(R.start, R.end)}` : "";
    if (R.err) { st.innerHTML = `<span class="warnt">Couldn't load shipments: ${esc(JT.message(R.err))}</span>`; }
    document.querySelectorAll("#ar-kind button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.k === R.kind)));
    document.querySelectorAll("#ar-pw button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.pw === R.pw)));
    $("ar-help").innerHTML = `Each SKU on an FBA or AWD shipment sent to Amazon in the range (not drafts or cancelled ones). FBA shipments are dated by the date in their name (when the shipment was created); AWD by Amazon's created date.${R.since ? ` Shipment history starts ${esc(fmt(R.since))}.` : ""} Synced from Amazon hourly.
      <br><b>Sold</b>: Amazon units ordered (and product sales) for each SKU in the last 7, 30 and 90 days, the last 12 months, and the 12 months before that, by order date, ending today — the same whatever range is picked above.${R.salesFrom && R.today && R.salesFrom > addDays(R.today, -729) ? ` Amazon sales history starts ${esc(fmt(R.salesFrom))}, so 13–24m covers only part of that year for now.` : ""}
      <br><b>Profit</b> for the window picked above it, by order date: sales + shipping credits & promos + Amazon's referral/selling and FBA fees (actual where Amazon has paid, estimated for the rest) − FBM labels (Veeqo, split by units) + refunds − COGS (Amazon mapping cost × units sold) − inbound.
      ${R.inRate ? `Inbound = ${esc(usd0.format(R.inRate.fees))} of Amazon inbound fees ÷ ${n0(R.inRate.sent)} units sent in the last 12 months = <b>$${R.inRate.rate.toFixed(2)}</b> per unit sold.` : ""} Ads stay blank until the Amazon Ads API is connected.`;
    const t = $("ar-table");
    if (!R.rows) { t.innerHTML = `<tbody><tr><td class="l muted">${R.loading ? "Loading…" : ""}</td></tr></tbody>`; $("ar-kpis").innerHTML = ""; $("ar-count").textContent = ""; $("ar-more").hidden = true; return; }
    const q = R.q.trim().toLowerCase();
    const all = R.rows.map(view).filter(r => r.n > 0);
    const list = all.filter(r => !q || `${r.sku} ${r.asin} ${r.title}`.toLowerCase().includes(q));
    const [sk, dir] = R.sort;
    list.sort((a, b) => { const x = a[sk], y = b[sk]; const c = typeof x === "number" || typeof y === "number" ? (x ?? -1) - (y ?? -1) : String(x || "").localeCompare(String(y || "")); return c * dir || b.u - a.u || a.sku.localeCompare(b.sku); });
    $("ar-kpis").innerHTML = [
      { l: "SKUs shipped", v: n0(all.length), s: q ? `${n0(list.length)} match the search` : "with at least one shipment in the range" },
      { l: "Units sent", v: n0(all.reduce((a, r) => a + r.u, 0)), s: `${n0(all.reduce((a, r) => a + r.rec, 0))} received by Amazon so far` },
      { l: "Avg units per SKU", v: all.length ? n0(all.reduce((a, r) => a + r.u, 0) / all.length) : "—", s: "units sent ÷ SKUs shipped" },
    ].map(k => `<div class="kpi"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
    const pwl = (PWIN.find(x => x[0] === R.pw) || [, ""])[1];
    t.innerHTML = `<thead><tr class="grp"><th class="l" colspan="${NSHIP}">Shipped in the range</th><th colspan="${NSOLD}" class="bl">Units sold (Amazon)</th><th colspan="${NPROF}" class="bl">Profit · last ${esc(pwl)}${R.prof ? "" : R.profErr ? " — couldn't load" : " — loading…"}</th></tr><tr>${COLS.map(([k, l, num]) => `<th class="${num ? "" : "l"} sortable" data-sort="${k}" aria-sort="${sk === k ? (dir > 0 ? "ascending" : "descending") : "none"}">${l}${sk === k ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead><tbody>${
      list.slice(0, R.shown).map(r => `<tr><td class="l mono" style="white-space:nowrap">${esc(r.sku)}</td>
        <td class="l">${esc(r.title) || '<span class="dim">—</span>'}${r.asin ? `<div class="meta"><a href="https://www.amazon.com/dp/${encodeURIComponent(r.asin)}" target="_blank" rel="noopener">${esc(r.asin)} ↗</a></div>` : ""}</td>
        <td>${n0(r.n)}${R.kind === "all" && r.nf && r.na ? `<div class="meta">${n0(r.nf)} FBA · ${n0(r.na)} AWD</div>` : R.kind === "all" ? `<div class="meta">${r.na ? "AWD" : "FBA"}</div>` : ""}</td>
        <td><b>${n0(r.u)}</b></td>
        <td>${n0(r.rec)}${r.u ? `<div class="meta">${Math.round(r.rec / r.u * 100)}%</div>` : ""}</td>
        <td class="l" style="white-space:nowrap">${esc(fmt(r.last))}</td>
        <td>${r.avail == null ? '<span class="dim">—</span>' : n0(r.avail)}</td>
        <td>${r.inbound ? n0(r.inbound) : '<span class="dim">0</span>'}</td>
        ${SALES.map(([k]) => `<td class="${k === "7" ? "bl" : ""}">${r["u" + k] ? `<b>${n0(r["u" + k])}</b><div class="meta">${usd0.format(r["s" + k])}</div>` : '<span class="dim">0</span>'}</td>`).join("")}
        ${profCells(r.pf)}</tr>`).join("")
      || `<tr><td class="l muted" colspan="${COLS.length}">${R.rows.length ? "No SKUs match." : "Nothing was sent to Amazon in this range."}</td></tr>`}</tbody>`;
    $("ar-more").hidden = list.length <= R.shown;
    $("ar-count").textContent = list.length > R.shown ? `${n0(R.shown)} of ${n0(list.length)} SKUs` : list.length ? `${n0(list.length)} SKU${list.length === 1 ? "" : "s"}` : "";
  }

  function bind() {
    $("ar-rangeseg").addEventListener("click", (e) => { const b = e.target.closest("button[data-r]"); if (!b) return; setRange(b.dataset.r); R.shown = PER; load(false); });
    const onDate = () => { const s = $("ar-start").value, e = $("ar-end").value; if (!s || !e || s > e) return; R.start = s; R.end = e; R.preset = null;
      document.querySelectorAll("#ar-rangeseg button").forEach(b => b.setAttribute("aria-pressed", "false")); R.shown = PER; load(false); };
    $("ar-start").addEventListener("change", onDate); $("ar-end").addEventListener("change", onDate);
    $("ar-refresh").addEventListener("click", () => load(true));
    $("ar-kind").addEventListener("click", (e) => { const b = e.target.closest("button[data-k]"); if (!b) return; R.kind = b.dataset.k; R.shown = PER; render(); });
    $("ar-q").addEventListener("input", (e) => { R.q = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(() => { R.shown = PER; render(); }, 150); });
    $("ar-table").addEventListener("click", (e) => { const h = e.target.closest("th[data-sort]"); if (!h) return; const k = h.dataset.sort;
      R.sort = R.sort[0] === k ? [k, -R.sort[1]] : [k, ["sku", "title"].includes(k) ? 1 : -1]; render(); });
    $("ar-pw").addEventListener("click", (e) => { const b = e.target.closest("button[data-pw]"); if (!b || b.dataset.pw === R.pw) return; R.pw = b.dataset.pw; R.prof = null; render(); loadProfit(false); });
    $("ar-more").addEventListener("click", () => { R.shown += PER; render(); });
  }

  bind();
  setRange(R.preset);
  window.arShow = () => { if (!R.shown0) { R.shown0 = true; load(false); } else render(); };
  if ((location.hash || "") === "#amzres") setTimeout(() => window.arShow(), 0);
})();
