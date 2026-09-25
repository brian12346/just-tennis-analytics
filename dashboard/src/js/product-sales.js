(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m = (n) => usd.format(n || 0), m0 = (n) => usd0.format(n || 0);
  const pct = (n) => isFinite(n) ? (n * 100).toFixed(1) + "%" : "—";
  const TZ = "America/Los_Angeles";
  const today = window.JTDate.today, addDays = window.JTDate.addDays;
  const lyDate = (ds) => { const y = +ds.slice(0, 4) - 1; let md = ds.slice(5); if (md === "02-29") md = "02-28"; return y + "-" + md; };
  const shortDay = (ds) => new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const LABEL = { type: "Category", vendor: "Vendor", title: "Model" };
  const BLANK = { type: "(No category)", vendor: "(No vendor)", title: "(Custom items & gift cards)" };

  const P = { mcp: null, downloads: null, start: null, end: null, preset: "ytd", rows: null, ly: null, err: null, lyErr: null, loading: false, open: new Set(), reqId: 0 };

  function setRange(r) {
    const t = today();
    P.preset = r;
    if (r === "ytd") { P.start = t.slice(0, 4) + "-01-01"; P.end = t; }
    else if (r === "ly") { const y = +t.slice(0, 4) - 1; P.start = y + "-01-01"; P.end = y + "-12-31"; }
    else { P.start = addDays(t, -(Number(r) - 1)); P.end = t; }
    $("ps-start").value = P.start; $("ps-end").value = P.end;
    document.querySelectorAll("#ps-rangeseg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.r === r)));
  }

  // Product totals from Supabase (costs include ones entered on the cost-mapping and Shopify tabs).
  async function fetchRange(st, en, refresh) {
    const JT = window.JT, n = (x) => Number(x) || 0;
    const r = await JT.rowsSplit(["product_type", "vendor", "product_title", "product_id::text", "sales_channel", "sum(units)", "sum(gross)", "sum(discounts)", "sum(net)", "sum(cogs)", "sum(gross_profit)", "sum(net_no_cost)"],
      `from jt.v_product_sales_daily where day between ${JT.day(st)} and ${JT.day(en)} group by 1, 2, 3, 4, 5`, "product_title", 1, refresh);
    return r.map(x => {
      const gross = n(x[6]), disc = n(x[7]), net = n(x[8]);
      return { type: x[0] || "", vendor: x[1] || "", title: x[2] || "", pid: x[3] && x[3] !== "0" ? x[3] : "", chan: x[4] || "(Unknown)",
        units: n(x[5]), gross, disc, ret: Math.round((net - gross - disc) * 100) / 100, net, cogs: n(x[9]), gp: n(x[10]), nocost: n(x[11]) };
    });
  }
  const errMsg = (e) => window.JT.message(e);

  async function load(refresh) {
    if (!P.mcp) return;
    const id = ++P.reqId; P.loading = true; P.err = null; P.lyErr = null; render();
    const cur = fetchRange(P.start, P.end, refresh).then(r => { if (id === P.reqId) P.rows = r; }).catch(e => { if (id === P.reqId) { P.err = e; P.rows = null; } });
    const ly = fetchRange(lyDate(P.start), lyDate(P.end), refresh).then(r => { if (id === P.reqId) P.ly = r; }).catch(e => { if (id === P.reqId) { P.lyErr = e; P.ly = null; } });
    await cur; if (id === P.reqId) render();
    await ly; if (id !== P.reqId) return;
    P.loading = false; render();
  }

  // ---------- tree ----------
  const levels = () => $("ps-group").value.split(",");
  const blank = () => ({ units: 0, gross: 0, disc: 0, ret: 0, net: 0, cogs: 0, gp: 0, nocost: 0, lyNet: 0, lyUnits: 0 });
  function addTo(a, r, ly) {
    if (ly) { a.lyNet += r.net; a.lyUnits += r.units; return; }
    a.units += r.units; a.gross += r.gross; a.disc += r.disc; a.ret += r.ret; a.net += r.net; a.cogs += r.cogs; a.gp += r.gp; a.nocost += r.nocost;
  }
  function build() {
    const L = levels(), chan = $("ps-chan").value, q = $("ps-q").value.trim().toLowerCase();
    const root = { key: "", name: "All", depth: -1, kids: new Map(), ...blank() };
    const feed = (rows, ly) => {
      for (const r of rows || []) {
        if (chan !== "all" && r.chan !== chan) continue;
        if (q && !L.some(l => (r[l] || BLANK[l]).toLowerCase().includes(q))) continue;
        addTo(root, r, ly);
        let node = root, key = "";
        L.forEach((l, d) => {
          const name = r[l] || BLANK[l]; key += "\u0001" + name;
          if (!node.kids.has(name)) node.kids.set(name, { key, name, level: l, depth: d, kids: new Map(), ...blank() });
          node = node.kids.get(name); addTo(node, r, ly);
          if (l === "title" && r.pid && !node.pid) node.pid = r.pid;
        });
      }
    };
    feed(P.rows, false); feed(P.ly, true);
    return root;
  }
  const margin = (n) => (n.net - n.nocost) > 0 ? n.gp / (n.net - n.nocost) : NaN;
  const growth = (n) => n.lyNet > 0 ? (n.net - n.lyNet) / n.lyNet : (n.net > 0 ? Infinity : NaN);
  function sorter() {
    const s = $("ps-sort").value;
    const key = { net: n => n.net, units: n => n.units, gp: n => n.gp, margin: n => isFinite(margin(n)) ? margin(n) : -9, growth: n => { const g = growth(n); return isFinite(g) ? g : (g === Infinity ? 1e9 : -9); } }[s];
    return (a, b) => key(b) - key(a);
  }

  function renderKpis(root) {
    const lyOk = !!P.ly;
    const g = growth(root);
    const k = [
      { c: "sales", l: "Net sales", v: m0(root.net), s: lyOk ? `<span class="${g < 0 ? "neg" : "pos"}">${isFinite(g) ? (g >= 0 ? "+" : "") + pct(g) : "—"}</span> vs ${m0(root.lyNet)} last year` : (P.lyErr ? "Last year didn't load" : "Loading last year…") },
      { l: "Units sold", v: root.units.toLocaleString(), s: lyOk ? `${root.lyUnits.toLocaleString()} last year` : "" },
      { l: "Discounts", v: m0(-root.disc), s: `${pct(-root.disc / (root.gross || 1))} of gross sales` },
      { l: "Returns", v: `<span class="${root.ret < 0 ? "neg" : ""}">${m0(root.ret)}</span>`, s: `${pct(-root.ret / (root.gross || 1))} of gross sales` },
      { c: "cost", l: "Product cost", v: m0(root.cogs), s: root.nocost ? `<span style="color:var(--warn)">${m0(root.nocost)} of sales have no cost</span>` : "All sales have a cost" },
      { l: "Gross profit", v: `<span class="${root.gp < 0 ? "neg" : ""}">${m0(root.gp)}</span>`, s: `${pct(margin(root))} margin` },
    ];
    $("ps-kpis").innerHTML = k.map(x => `<div class="kpi ${x.c || ""}"><span class="eyebrow">${x.l}</span><span class="v">${x.v}</span><span class="s">${x.s}</span></div>`).join("");
  }

  function render() {
    if ($("tab-psales").hidden) return;
    const st = $("ps-status"), note = $("ps-note");
    if (!P.mcp) { st.textContent = ""; note.hidden = false; note.innerHTML = '<div class="note warn">Live data isn\'t available in this view. Open the dashboard in claude.ai.</div>'; return; }
    if (P.err) { st.textContent = ""; note.hidden = false; note.innerHTML = `<div class="note bad">${esc(errMsg(P.err))}</div>`; $("ps-table").innerHTML = ""; $("ps-kpis").innerHTML = ""; return; }
    note.hidden = true;
    if (!P.rows) { st.textContent = "Loading product sales…"; return; }
    st.textContent = `${shortDay(P.start)} – ${shortDay(P.end)} · compared with ${shortDay(lyDate(P.start))} – ${shortDay(lyDate(P.end))}${P.loading ? " · loading last year…" : ""}${P.rows.length >= 20000 ? " · results hit Shopify's row limit, narrow the dates" : ""}`;
    // channel options
    const sel = $("ps-chan"), chans = [...new Set(P.rows.map(r => r.chan))].sort();
    const want = ["all", ...chans].join("|");
    if (sel.dataset.opts !== want) { const cur = sel.value; sel.innerHTML = `<option value="all">All channels</option>` + chans.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join(""); sel.value = chans.includes(cur) ? cur : "all"; sel.dataset.opts = want; }
    const L = levels();
    $("ps-h").textContent = "By " + L.map(l => LABEL[l].toLowerCase()).join(", ").replace(/, ([^,]*)$/, " and $1");
    const root = build();
    renderKpis(root);
    const cmp = sorter(), q = $("ps-q").value.trim();
    const out = [];
    const walk = (node) => {
      for (const k of [...node.kids.values()].sort(cmp)) {
        out.push(k);
        if (k.kids.size && (P.open.has(k.key) || q)) walk(k);
      }
    };
    walk(root);
    const tot = root.net || 1;
    const lyOk = !!P.ly;
    const body = out.slice(0, 1500).map(n => {
      const mg = margin(n), g = growth(n), share = n.net / tot;
      const hasKids = n.kids.size > 0, open = P.open.has(n.key) || !!q;
      const name = `<span class="tree" style="padding-left:${n.depth * 20}px">${hasKids ? `<button class="caret" data-k="${esc(n.key)}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${esc(n.name)}">${open ? "▾" : "▸"}</button>` : '<span class="caret-sp"></span>'}<span class="tname lvl${n.depth}">${n.level === "title" && n.pid ? `<a class="olink" href="https://admin.shopify.com/store/justtennis-822/products/${encodeURIComponent(n.pid)}" target="_blank" rel="noopener" title="Open in Shopify">${esc(n.name)}</a>` : esc(n.name)}</span>${hasKids ? `<span class="dim small"> ${n.kids.size}</span>` : ""}</span>`;
      return `<tr class="d${n.depth}"><td class="l">${name}</td><td>${n.units.toLocaleString()}</td><td>${m(n.gross)}</td><td class="${n.disc < -0.005 ? "neg" : "dim"}">${Math.abs(n.disc) >= 0.005 ? m(n.disc) : "—"}</td><td class="${n.ret < -0.005 ? "neg" : "dim"}">${Math.abs(n.ret) >= 0.005 ? m(n.ret) : "—"}</td><td><b>${m(n.net)}</b></td>
        <td class="l"><span class="sharecell"><span class="sharebar"><i style="width:${Math.max(0, Math.min(100, share * 100)).toFixed(1)}%"></i></span><span class="dim small">${pct(share)}</span></span></td>
        <td>${m(n.cogs)}${n.nocost > 0.005 ? ` <span class="pill miss" title="${m(n.nocost)} of sales have no product cost in Shopify">No cost</span>` : ""}</td><td class="${n.gp < 0 ? "neg" : ""}">${m(n.gp)}</td><td class="${mg < 0 ? "neg" : "dim"}">${pct(mg)}</td>
        <td class="dim">${lyOk ? m(n.lyNet) : "…"}</td><td class="${!lyOk ? "dim" : g < 0 ? "neg" : g > 0 ? "pos" : "dim"}">${!lyOk ? "" : g === Infinity ? "New" : isFinite(g) ? (g >= 0 ? "+" : "") + pct(g) : "—"}</td></tr>`;
    }).join("");
    $("ps-table").innerHTML = `<thead><tr><th class="l">${L.map(l => LABEL[l]).join(" › ")}</th><th>Units</th><th>Gross sales</th><th>Discounts</th><th>Returns</th><th>Net sales</th><th class="l">Share</th><th>Product cost</th><th>Gross profit</th><th>Margin</th><th>Last year</th><th>Change</th></tr></thead>
      <tbody>${body || '<tr><td class="l dim" colspan="12">No sales match.</td></tr>'}${out.length > 1500 ? `<tr><td class="l dim" colspan="12">Showing 1,500 of ${out.length.toLocaleString()} rows. Collapse groups or search to narrow.</td></tr>` : ""}</tbody>
      <tfoot><tr><td class="l">Total</td><td>${root.units.toLocaleString()}</td><td>${m(root.gross)}</td><td>${m(root.disc)}</td><td>${m(root.ret)}</td><td>${m(root.net)}</td><td></td><td>${m(root.cogs)}</td><td>${m(root.gp)}</td><td>${pct(margin(root))}</td><td>${lyOk ? m(root.lyNet) : ""}</td><td>${lyOk && isFinite(growth(root)) ? (growth(root) >= 0 ? "+" : "") + pct(growth(root)) : ""}</td></tr></tfoot>`;
    $("ps-dl").hidden = !P.downloads;
  }
  window.psRender = () => { render(); renderCW(); };

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

  async function download() {
    const L = levels(), chan = $("ps-chan").value;
    const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const agg = new Map();
    const feed = (rows, ly) => { for (const r of rows || []) { if (chan !== "all" && r.chan !== chan) continue; const k = [r.type, r.vendor, r.title].join("\u0001"); const a = agg.get(k) || { type: r.type || BLANK.type, vendor: r.vendor || BLANK.vendor, title: r.title || BLANK.title, ...blank() }; addTo(a, r, ly); agg.set(k, a); } };
    feed(P.rows, false); feed(P.ly, true);
    const lines = [["category", "vendor", "model", "units", "gross_sales", "discounts", "returns", "net_sales", "product_cost", "gross_profit", "sales_without_cost", "last_year_net_sales", "last_year_units"].join(",")];
    for (const a of [...agg.values()].sort((x, y) => y.net - x.net)) lines.push([a.type, a.vendor, a.title, a.units, a.gross.toFixed(2), a.disc.toFixed(2), a.ret.toFixed(2), a.net.toFixed(2), a.cogs.toFixed(2), a.gp.toFixed(2), a.nocost.toFixed(2), a.lyNet.toFixed(2), a.lyUnits].map(q).join(","));
    try { await P.downloads.save({ filename: `just-tennis-product-sales_${P.start}_to_${P.end}${chan !== "all" ? "_" + chan.replace(/\W+/g, "-") : ""}.csv`, data: lines.join("\n") }); } catch (_) {}
  }

  // ---------- events ----------
  document.querySelectorAll("#ps-rangeseg button").forEach(b => b.addEventListener("click", () => { setRange(b.dataset.r); load(false); }));
  const onDate = () => { const s = $("ps-start").value, e = $("ps-end").value; if (!s || !e || s > e) return; P.start = s; P.end = e; document.querySelectorAll("#ps-rangeseg button").forEach(b => b.setAttribute("aria-pressed", "false")); load(false); };
  $("ps-start").addEventListener("change", onDate); $("ps-end").addEventListener("change", onDate);
  $("ps-refresh").addEventListener("click", () => load(true));
  $("ps-group").addEventListener("change", () => { P.open.clear(); render(); });
  ["ps-chan", "ps-sort"].forEach(id => $(id).addEventListener("change", render));
  let qt; $("ps-q").addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(render, 200); });
  $("ps-table").addEventListener("click", (ev) => { const b = ev.target.closest(".caret"); if (!b) return; const k = b.dataset.k; if (P.open.has(k)) P.open.delete(k); else P.open.add(k); render(); });
  $("ps-expand").addEventListener("click", () => { const root = build(); const w = (n) => { for (const k of n.kids.values()) if (k.kids.size) { P.open.add(k.key); if (k.depth < 1) w(k); } }; w(root); render(); });
  $("ps-collapse").addEventListener("click", () => { P.open.clear(); render(); });
  $("ps-dl").addEventListener("click", download);

  setRange("ytd");
  const use = window.claude && window.claude.use ? window.claude.use.bind(window.claude) : null;
  if (!use) { render(); renderCW(); return; }
  use("downloads").then(d => { P.downloads = d; render(); }).catch(() => {});
  window.JT.docStore().then(db => {
    CW.db = db; if (!db) { renderCW(); return; }
    let n = 0; const done = () => { if (++n >= 3) CW.ready = true; renderCW(); };
    db.doc("settings/costs").onSnapshot(d => { CW.set = d.exists ? { historyStart: null, overrides: {}, ...d.data() } : { historyStart: null, overrides: {} }; renderCW(); }, () => {});
    db.doc("costs/catalog").onSnapshot(d => { CW.catalog = d.exists ? d.data() : null; done(); }, done);
    db.collection("costalerts").orderBy("date", "desc").limit(14).onSnapshot(s => { CW.alerts = s.docs.map(d => d.data()); done(); }, done);
    db.collection("costlog").orderBy("date", "desc").limit(90).onSnapshot(s => { CW.log = s.docs.map(d => d.data()); done(); }, done);
  }).catch(() => {});
  window.JT.getMcp().then(mcp => { P.mcp = mcp; if (mcp) load(false); else render(); }).catch(() => render());
})();
