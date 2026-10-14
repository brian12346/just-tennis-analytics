// Inventory › Discontinued (Brian, Oct 14): discontinued products in their own bucket — what's still on hand and its
// value at cost, how fast it's selling through, and when it's truly sold out (then the to do list suggests archiving it
// in Shopify). "Maybe" lists products missing from their vendor's latest complete pricelist. Vendor pricelists
// (Excel / CSV) are uploaded here: rows are matched to products by item code, SKU or UPC, and each product keeps the
// vendor's list cost, MSRP and availability (migration 146). Products can also be marked discontinued by hand, and
// Claude can fill these in from dealer portals.
(() => {
  const $ = (id) => document.getElementById(id);
  if (!$("tab-discontinued")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const n0 = (n) => Math.round(n || 0).toLocaleString();
  const m0 = (n) => (n || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m2 = (n) => n == null || isNaN(n) ? "—" : (+n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
  const shortDate = (s) => s ? new Date(String(s).slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: String(s).slice(0, 4) === String(new Date().getFullYear()) ? undefined : "numeric" }) : "";
  const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const normUpc = (s) => String(s || "").replace(/\D/g, "").replace(/^0+/, "");
  const D = { shown: false, loading: false, err: null, rows: null, view: "disc", show: "selling", vendor: "all", q: "", sel: new Set(), lists: null,
    mark: { q: "" }, up: null, cat: null };
  const note = (kind, html) => { const n = $("dc-note"); n.className = "note " + (kind || ""); n.innerHTML = html || ""; n.hidden = !html; };
  const me = () => ((($("whoami") || {}).textContent) || "").trim();

  // ---------- data ----------
  async function load(refresh) {
    D.loading = true; render();
    try {
      const [rows, lists] = await Promise.all([
        JT.rows(["variant_id::text", "product_id::text", "title", "sku", "vendor", "shop_status", "unit_cost", "store", "prep", "amazon", "sold90", "last_sale::text", "kind",
          "disc_since::text", "disc_source", "disc_by", "note", "availability", "list_cost", "msrp"], "from jt.discontinued_view()", refresh),
        JT.rows(["id::text", "vendor", "name", "file_name", "source", "full_list", "effective_on::text", "rows", "matched", "uploaded_at::text", "uploaded_by"],
          "from jt.vendor_price_lists order by uploaded_at desc limit 60", refresh),
      ]);
      D.rows = rows.map(x => { const r = { vid: x[0], pid: x[1], title: x[2] || "", sku: x[3] || "", vendor: x[4] || "", shop: x[5] || "", cost: x[6] == null ? null : +x[6],
        store: +x[7] || 0, prep: +x[8] || 0, amazon: +x[9] || 0, s90: +x[10] || 0, last: x[11] || "", kind: x[12], since: x[13] || "", source: x[14] || "", by: x[15] || "",
        note: x[16] || "", avail: x[17] || "", listCost: x[18] == null ? null : +x[18], msrp: x[19] == null ? null : +x[19] };
        r.have = r.store + r.prep + r.amazon; r.value = r.have * (r.cost || 0);
        r.bucket = r.kind === "maybe" ? "maybe" : r.shop !== "ACTIVE" ? "archived" : r.have > 0 ? "selling" : "soldout";
        r.weeks = r.have > 0 && r.s90 > 0 ? r.have / (r.s90 / 90 * 7) : null; return r; });
      D.lists = lists.map(x => ({ id: x[0], vendor: x[1], name: x[2] || "", file: x[3] || "", source: x[4] || "", full: !!x[5], eff: x[6] || "", rows: +x[7] || 0, matched: +x[8] || 0, at: x[9] || "", by: x[10] || "" }));
      D.err = null;
    } catch (e) { D.err = e; }
    D.loading = false; render();
  }
  // every product (for matching pricelists and marking by hand)
  async function catalog() {
    if (D.cat) return D.cat;
    const [vs, rem] = await Promise.all([
      JT.rowsSplit(["variant_id::text", "product_id::text", "sku", "coalesce(barcode, '')", "vendor", "coalesce(nullif(display_name, ''), product_title)", "unit_cost", "status"],
        "from jt.variants where removed_at is null", "variant_id", 4, false),
      JT.rows(["vendor", "item_code", "variant_id::text"], "from jt.vendor_items", false).catch(() => []),
    ]);
    const cat = vs.map(x => ({ vid: x[0], pid: x[1], sku: x[2] || "", bar: x[3] || "", vendor: x[4] || "", title: x[5] || "", cost: x[6] == null ? null : +x[6], status: x[7] || "" }));
    const bySku = new Map(), byBar = new Map(), byId = new Map(cat.map(v => [v.vid, v]));
    const add = (mp, k, v) => { if (!k) return; const l = mp.get(k) || []; l.push(v); mp.set(k, l); };
    for (const v of cat) { add(bySku, norm(v.sku), v); add(byBar, normUpc(v.bar), v); v.text = `${v.title} ${v.sku} ${v.vendor}`.toLowerCase(); }
    const rememb = new Map(rem.map(([vd, c, id]) => [String(vd).toLowerCase() + "|" + c, id]));
    D.cat = { all: cat, bySku, byBar, byId, rememb, vendors: [...new Set(cat.map(v => v.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b)) };
    return D.cat;
  }

  // ---------- Discontinued view ----------
  const BUCKETS = [["selling", "Selling through", "discontinued, still on hand"], ["soldout", "Sold out", "nothing left anywhere — archive it in Shopify"],
    ["maybe", "Maybe discontinued", "not on the vendor's latest complete pricelist"], ["archived", "Archived", "discontinued and no longer active in Shopify"]];
  function discHtml() {
    const rs = D.rows || [], vend = (r) => D.vendor === "all" || r.vendor === D.vendor, q = D.q.trim().toLowerCase();
    const inB = (b) => rs.filter(r => r.bucket === b && vend(r));
    const list = inB(D.show).filter(r => !q || `${r.title} ${r.sku}`.toLowerCase().includes(q))
      .sort((a, b) => D.show === "selling" ? b.value - a.value : D.show === "maybe" ? b.have - a.have || b.s90 - a.s90 : String(b.last || b.since).localeCompare(String(a.last || a.since)));
    const sel = list.filter(r => D.sel.has(r.vid));
    const sell = inB("selling"), vendors = [...new Set(rs.map(r => r.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const sum = `<div class="dc-sum"><span><b>${m0(sell.reduce((a, r) => a + r.value, 0))}</b> at cost in ${n0(sell.reduce((a, r) => a + r.have, 0))} units of ${n0(sell.length)} discontinued product${sell.length === 1 ? "" : "s"} still selling through</span>${inB("soldout").length ? ` · <b>${n0(inB("soldout").length)}</b> sold out — archive in Shopify` : ""}</div>`;
    const seg = `<div class="seg sm" role="group" aria-label="Which">${BUCKETS.map(([k, n, t]) => `<button type="button" data-dc-show="${k}" aria-pressed="${D.show === k}" title="${esc(t)}">${n} <span class="cnt">${n0(inB(k).length)}</span></button>`).join("")}</div>`;
    const filt = `<label class="small">Vendor <select class="inp sm" id="dc-vendor" style="width:auto"><option value="all">All vendors</option>${vendors.map(v => `<option value="${esc(v)}" ${D.vendor === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
      <input class="inp" type="search" id="dc-q" value="${esc(D.q)}" placeholder="Search product or SKU" style="width:200px">`;
    const acts = D.show === "maybe" ? `<button class="mini primary" type="button" data-dc-mark="1" ${sel.length ? "" : "disabled"}>Mark ${sel.length || ""} discontinued</button><button class="mini" type="button" data-dc-mark="0" ${sel.length ? "" : "disabled"} title="Still carried: stop asking">Still carried</button>`
      : `<button class="mini" type="button" data-dc-mark="0" ${sel.length ? "" : "disabled"}>Not discontinued${sel.length ? ` (${sel.length})` : ""}</button>`;
    const srcTxt = (r) => r.kind === "maybe" ? "missing from the latest list" : `${r.source === "manual" ? "marked" : r.source === "portal" ? "dealer portal" : "pricelist"}${r.since ? " " + shortDate(r.since) : ""}${r.by && r.source === "manual" ? " · " + esc(r.by.split("@")[0]) : ""}`;
    const head = `<tr><th><input type="checkbox" data-dc-all aria-label="Select all" ${list.length && sel.length === list.length ? "checked" : ""}></th><th class="l">Product</th><th class="l">Vendor</th><th title="Store · prep · Amazon">On hand</th><th>Value</th><th title="Units sold in the last 90 days">Sold 90d</th><th title="On hand at the 90-day pace">Sells out in</th><th class="l">Last sale</th><th class="l">Why</th></tr>`;
    const body = list.slice(0, 500).map(r => `<tr class="${D.sel.has(r.vid) ? "picked" : ""}"><td><input type="checkbox" data-dc-sel="${esc(r.vid)}" ${D.sel.has(r.vid) ? "checked" : ""} aria-label="Select ${esc(r.title)}"></td>
      <td class="l"><a class="olink" href="${ADMIN}/products/${esc(r.pid)}/variants/${esc(r.vid)}" target="_blank" rel="noopener">${esc(r.title)}</a> <span class="mono dim small">${esc(r.sku)}</span>${r.note ? `<div class="meta">${esc(r.note)}</div>` : ""}</td>
      <td class="l">${esc(r.vendor)}</td><td title="Store ${n0(r.store)} · prep ${n0(r.prep)} · Amazon ${n0(r.amazon)}">${r.have ? n0(r.have) : '<span class="dim">0</span>'}</td><td>${r.value ? m0(r.value) : '<span class="dim">—</span>'}</td>
      <td>${r.s90 ? n0(r.s90) : '<span class="dim">0</span>'}</td><td>${r.weeks == null ? (r.have ? '<span class="warnt">not selling</span>' : '<span class="dim">—</span>') : r.weeks < 1 ? "this week" : `${n0(r.weeks)} wk`}</td>
      <td class="l small">${r.last ? esc(shortDate(r.last)) : '<span class="dim">—</span>'}</td><td class="l small">${srcTxt(r)}</td></tr>`).join("");
    return `${sum}<div class="dc-bar">${seg}${filt}<span class="dbtns right">${acts}</span></div>
      <div class="muted small dc-what">${esc((BUCKETS.find(b => b[0] === D.show) || [])[2] || "")}${D.show === "soldout" ? " — they're on the to do list as suggestions" : ""}</div>
      ${list.length ? `<div class="tbl-wrap dc-tbl"><table class="prept po-t"><thead>${head}</thead><tbody>${body}</tbody></table></div>` : `<div class="il-empty">${D.loading ? "Loading…" : "Nothing here"}</div>`}
      <div class="dc-markrow"><b class="small">Mark a product discontinued</b> <input class="inp" type="search" id="dc-mq" value="${esc(D.mark.q)}" placeholder="Product, SKU or vendor" style="width:260px"><div id="dc-mres" class="dc-mres">${markResults()}</div></div>`;
  }
  function markResults() {
    const q = D.mark.q.trim().toLowerCase(); if (q.length < 2) return "";
    if (!D.cat) { catalog().then(() => { const h = $("dc-mres"); if (h) h.innerHTML = markResults(); }).catch(() => {}); return '<span class="muted small">Loading products…</span>'; }
    const disc = new Set((D.rows || []).filter(r => r.kind === "disc").map(r => r.vid));
    const words = q.split(/\s+/), hits = D.cat.all.filter(v => v.status === "ACTIVE" && words.every(w => v.text.includes(w))).slice(0, 12);
    return hits.map(v => `<div class="dc-mhit"><span>${esc(v.title)} <span class="mono dim small">${esc(v.sku)}</span> <span class="muted small">${esc(v.vendor)}</span></span>${disc.has(v.vid) ? '<span class="pill warn">discontinued</span>' : `<button class="mini" type="button" data-dc-one="${esc(v.vid)}">Mark discontinued</button>`}</div>`).join("") || '<span class="muted small">No active products match.</span>';
  }

  // ---------- Vendor pricelists ----------
  const FIELDS = [["item_code", "Item / style #", /^(item|style|sku|article|material|part|product ?(code|no|#|number)|model|code|item ?(no|#|number|code))/i],
    ["upc", "UPC / EAN", /(upc|ean|gtin|barcode)/i], ["description", "Description", /(desc|name|product$|title)/i],
    ["cost", "Cost", /(cost|dealer|wholesale|net|price ?to ?dealer|your ?price|^price$|unit ?price)/i], ["msrp", "MSRP", /(msrp|retail|srp|map\b|suggested)/i],
    ["status", "Status", /(status|avail|discontinu|lifecycle|stock ?status|active)/i], ["avail_qty", "Qty available", /(qty|quantity|on ?hand|available ?qty|inventory|stock$)/i],
    ["eta", "ETA", /(eta|due|expected|arrival|ship ?date|available ?date)/i]];
  const STATUS = (s) => { const t = String(s || "").trim().toLowerCase(); if (!t) return "";
    if (/disc|^dc$|^d$|obsolete|close.?out|end.?of.?life|eol|inactive|retired|no longer/.test(t)) return "discontinued";
    if (/back.?order|^bo$|pre.?order|coming|future|due/.test(t)) return "backorder";
    if (/out.?of.?stock|^oos$|sold.?out|unavail|not avail|^no$|^0$|^n$/.test(t)) return "unavailable";
    if (/avail|active|in.?stock|^yes$|^y$|current|^new$|^ok$|carry|stock/.test(t)) return "active";
    return "?"; };
  const num = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,\s]/g, "")); return isNaN(n) ? null : n; };
  const isoDate = (v) => { if (v == null || v === "") return ""; if (typeof v === "number" && v > 30000 && v < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + v * 864e5); return d.toISOString().slice(0, 10); }
    const d = new Date(String(v)); return isNaN(d) ? "" : d.toISOString().slice(0, 10); };
  async function xlsx() {
    if (window.XLSX) return window.XLSX;
    await new Promise((ok, bad) => { const s = document.createElement("script"); s.src = XLSX_URL; s.onload = ok; s.onerror = () => bad(new Error("Couldn't load the spreadsheet reader.")); document.head.appendChild(s); });
    return window.XLSX;
  }
  async function readFile(f) {
    const U = { file: f.name, vendor: D.up && D.up.vendor || "", full: D.up ? D.up.full : true, name: "", sheets: [], sheet: 0, header: 0, grid: [], map: {}, rows: null, err: null, saving: false, done: null };
    D.up = U; render();
    try {
      let grids = [];
      if (/\.csv$|\.txt$/i.test(f.name)) grids = [{ name: "CSV", grid: parseCsv(await f.text()) }];
      else { const X = await xlsx(); const wb = X.read(await f.arrayBuffer(), { type: "array", cellDates: false });
        grids = wb.SheetNames.map(n => ({ name: n, grid: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }) })).filter(g => g.grid.length); }
      if (!grids.length) throw new Error("No rows in that file.");
      U.sheets = grids; U.sheet = grids.reduce((b, g, i) => g.grid.length > grids[b].grid.length ? i : b, 0);
      pickSheet(U);
      const cat = await catalog();
      if (!U.vendor) { const guess = cat.vendors.find(v => f.name.toLowerCase().includes(v.toLowerCase())); if (guess) U.vendor = guess; }
      U.name = f.name.replace(/\.[^.]+$/, "");
      match(U);
    } catch (e) { U.err = e.message || String(e); }
    render();
  }
  function parseCsv(t) {
    const out = []; let row = [], cur = "", q = false;
    for (let i = 0; i < t.length; i++) { const c = t[i];
      if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true; else if (c === ",") { row.push(cur); cur = ""; } else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(cur); out.push(row); row = []; cur = ""; } else cur += c; }
    if (cur || row.length) { row.push(cur); out.push(row); }
    return out.filter(r => r.some(x => String(x).trim()));
  }
  // the header row: the first of the top 15 rows that names the most fields
  function pickSheet(U) {
    U.grid = U.sheets[U.sheet].grid; let best = 0, bestN = -1;
    for (let i = 0; i < Math.min(15, U.grid.length); i++) { const n = U.grid[i].filter(c => FIELDS.some(f => f[2].test(String(c).trim()))).length; if (n > bestN) { best = i; bestN = n; } }
    U.header = best; const hd = U.grid[best].map(c => String(c).trim()); U.map = {};
    for (const [k, , re] of FIELDS) { const i = hd.findIndex((h, j) => h && re.test(h) && !Object.values(U.map).includes(j)); if (i >= 0) U.map[k] = i; }
  }
  function match(U) {
    const cat = D.cat; if (!cat) return;
    const known = cat.vendors.find(v => v.toLowerCase() === String(U.vendor || "").trim().toLowerCase()); if (known) U.vendor = known;
    const vend = U.vendor.toLowerCase(), m = U.map, get = (r, k) => m[k] == null ? "" : r[m[k]];
    U.rows = U.grid.slice(U.header + 1).map((r, i) => {
      const code = String(get(r, "item_code") ?? "").trim(), upc = String(get(r, "upc") ?? "").trim();
      if (!code && !upc) return null;
      const x = { line: i + 1, item_code: code, upc, description: String(get(r, "description") ?? "").trim(), cost: num(get(r, "cost")), msrp: num(get(r, "msrp")),
        rawStatus: String(get(r, "status") ?? "").trim(), status: STATUS(get(r, "status")), avail_qty: num(get(r, "avail_qty")), eta: isoDate(get(r, "eta")), vid: null, how: "" };
      const rem = code && cat.rememb.get(vend + "|" + code);
      const own = (l) => (l || []).filter(v => v.vendor.toLowerCase() === vend);
      const pick = (l, how) => { if (!x.vid && l && l.length === 1) { x.vid = l[0].vid; x.how = how; } };
      if (rem && cat.byId.has(rem)) { x.vid = rem; x.how = "code"; }
      pick(own(cat.bySku.get(norm(code))), "sku");
      if (upc) pick(cat.byBar.get(normUpc(upc)), "upc");
      pick(cat.bySku.get(norm(code)), "sku");
      return x;
    }).filter(Boolean);
  }
  function uploadHtml() {
    const U = D.up;
    const hist = (D.lists || []).length ? `<div class="tbl-wrap dc-hist"><table class="prept"><thead><tr><th class="l">Vendor</th><th class="l">Pricelist</th><th class="l">From</th><th>Rows</th><th>Matched</th><th class="l">Added</th></tr></thead><tbody>${D.lists.map(l =>
      `<tr><td class="l">${esc(l.vendor)}</td><td class="l">${esc(l.name || l.file)}${l.full ? ' <span class="pill pos" title="The complete list: products missing from it show as Maybe discontinued">complete</span>' : ""}</td><td class="l small">${esc(l.source === "portal" ? "dealer portal" : l.source === "manual" ? "entered" : "file")}</td><td>${n0(l.rows)}</td><td>${n0(l.matched)}</td><td class="l small">${esc(shortDate(l.at))}${l.by ? " · " + esc(l.by.split("@")[0]) : ""}</td></tr>`).join("")}</tbody></table></div>` : '<div class="muted small">No pricelists yet.</div>';
    let body = "";
    if (U && U.err) body = `<div class="note bad">${esc(U.err)}</div>`;
    else if (U && U.file && !U.rows) body = '<div class="muted small">Reading the file…</div>';
    else if (U && U.done) body = `<div class="note info">Saved <b>${esc(U.name)}</b>: ${n0(U.done.matched)} of ${n0(U.done.rows)} rows matched to products · ${n0(U.done.discontinued)} discontinued · ${n0(U.done.backorder)} on backorder or unavailable. <button class="linkbtn" type="button" data-dc-go="disc">See discontinued →</button></div>`;
    else if (U && U.rows && D.cat) {
      const cat = D.cat, hd = U.grid[U.header] || [], rs = U.rows || [], matched = rs.filter(r => r.vid);
      const byV = (r) => cat.byId.get(r.vid);
      const newDisc = matched.filter(r => r.status === "discontinued" && !(D.rows || []).some(x => x.vid === r.vid && x.kind === "disc"));
      const costDiff = matched.filter(r => { const v = byV(r); return r.cost != null && v && v.cost != null && Math.abs(r.cost - v.cost) > Math.max(0.02, v.cost * 0.01); });
      const unk = [...new Set(rs.filter(r => r.status === "?").map(r => r.rawStatus))].slice(0, 8);
      const counts = ["active", "discontinued", "backorder", "unavailable"].map(k => [k, rs.filter(r => r.status === k).length]).filter(x => x[1]);
      body = `<div class="dc-map">${U.sheets.length > 1 ? `<label class="small">Sheet <select class="inp sm" id="dc-sheet" style="width:auto">${U.sheets.map((s, i) => `<option value="${i}" ${i === U.sheet ? "selected" : ""}>${esc(s.name)} (${n0(s.grid.length)})</option>`).join("")}</select></label>` : ""}
        ${FIELDS.map(([k, n]) => `<label class="small">${n}<select class="inp sm" data-dc-col="${k}" style="width:auto;max-width:150px"><option value="">—</option>${hd.map((h, i) => `<option value="${i}" ${U.map[k] === i ? "selected" : ""}>${esc(String(h).slice(0, 30) || "column " + (i + 1))}</option>`).join("")}</select></label>`).join("")}</div>
        <div class="dc-sum small"><b>${n0(matched.length)}</b> of ${n0(rs.length)} rows matched to ${esc(U.vendor || "?")} products${counts.length ? " · " + counts.map(([k, n]) => `${n0(n)} ${k}`).join(" · ") : U.map.status == null ? " · no status column (pick one, or every row counts as available)" : ""}${unk.length ? ` · <span class="warnt" title="Status words not understood: they're kept but don't change anything">unclear: ${esc(unk.join(", "))}</span>` : ""}</div>
        ${newDisc.length ? `<div class="dc-chg"><b>${n0(newDisc.length)} newly discontinued</b> ${newDisc.slice(0, 12).map(r => `<span class="pill warn">${esc((byV(r) || {}).title || r.description)}</span>`).join(" ")}${newDisc.length > 12 ? " …" : ""}</div>` : ""}
        ${costDiff.length ? `<details class="dc-chg"><summary><b>${n0(costDiff.length)} cost${costDiff.length === 1 ? "" : "s"} differ from Shopify</b> <span class="muted small">(the list cost is kept; Shopify costs aren't changed)</span></summary><div class="tbl-wrap dc-small"><table class="prept"><thead><tr><th class="l">Product</th><th>Shopify cost</th><th>List cost</th><th>Change</th></tr></thead><tbody>${costDiff.slice(0, 200).map(r => { const v = byV(r), d = r.cost - v.cost;
          return `<tr><td class="l">${esc(v.title)} <span class="mono dim small">${esc(v.sku)}</span></td><td>${m2(v.cost)}</td><td>${m2(r.cost)}</td><td class="${d > 0 ? "neg" : "pos"}">${d > 0 ? "+" : ""}${(d / v.cost * 100).toFixed(1)}%</td></tr>`; }).join("")}</tbody></table></div></details>` : ""}
        ${rs.length - matched.length ? `<details class="dc-chg"><summary><b>${n0(rs.length - matched.length)} rows not matched</b> <span class="muted small">— products not in Shopify, or a different item code</span></summary><div class="tbl-wrap dc-small"><table class="prept"><thead><tr><th class="l">Item</th><th class="l">UPC</th><th class="l">Description</th><th>Cost</th><th class="l">Status</th></tr></thead><tbody>${rs.filter(r => !r.vid).slice(0, 200).map(r =>
          `<tr><td class="l mono">${esc(r.item_code)}</td><td class="l mono small">${esc(r.upc)}</td><td class="l">${esc(r.description)}</td><td>${m2(r.cost)}</td><td class="l small">${esc(r.rawStatus)}</td></tr>`).join("")}</tbody></table></div></details>` : ""}
        <div class="row"><button class="btn primary" type="button" data-dc-save ${U.saving || !U.vendor || !rs.length ? "disabled" : ""}>${U.saving ? "Saving…" : `Save the pricelist (${n0(matched.length)} products)`}</button><button class="btn" type="button" data-dc-cancel>Cancel</button></div>`;
    }
    const vendors = D.cat ? D.cat.vendors : [...new Set((D.rows || []).map(r => r.vendor))];
    return `<section class="panel dc-up">
      <div class="dc-bar"><b>Upload a vendor pricelist</b>
        <label class="small">Vendor <input class="inp" id="dc-uvendor" list="dc-vendors" value="${esc(U ? U.vendor : "")}" placeholder="Vendor" style="width:150px"><datalist id="dc-vendors">${vendors.map(v => `<option value="${esc(v)}">`).join("")}</datalist></label>
        <label class="small" title="Products of this vendor missing from a complete list show as Maybe discontinued"><input type="checkbox" id="dc-ufull" ${!U || U.full ? "checked" : ""}> It's the complete list</label>
        <label class="btn sm" for="dc-file">Choose Excel or CSV…</label><input type="file" id="dc-file" accept=".xlsx,.xls,.csv,.txt" hidden>
        ${U && U.file ? `<span class="muted small">${esc(U.file)}</span>` : '<span class="muted small">Item # / UPC, cost, MSRP and status (available, discontinued, backorder) columns are found by their headings.</span>'}</div>
      ${body}</section>
      <section class="panel"><div class="panel-head"><h2>Pricelists</h2><span class="muted small">Claude can also read availability from a dealer portal (e.g. Head OMS) and add it here — ask in Claude.</span></div>${hist}</section>`;
  }

  // ---------- render ----------
  function render() {
    if ($("tab-discontinued").hidden) return;
    const keep = document.activeElement && $("tab-discontinued").contains(document.activeElement) && document.activeElement.id ? { id: document.activeElement.id, s: document.activeElement.selectionStart } : null;
    document.querySelectorAll("#dc-view button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.dcView === D.view)));
    $("dc-status").textContent = D.err ? "Couldn't load: " + JT.message(D.err) : D.loading && !D.rows ? "Loading…" : "";
    $("dc-body").innerHTML = D.view === "lists" ? uploadHtml() : discHtml();
    if (keep) { const el = $(keep.id); if (el) { el.focus(); try { el.setSelectionRange(keep.s, keep.s); } catch (_) {} } }
  }

  async function mark(ids, yes, msg) {
    if (!ids.length) return;
    try { await JT.vendorData.setDiscontinued(ids, yes, null, me()); D.sel.clear(); note("info", msg); await load(true); }
    catch (e) { note("bad", "Couldn't save: " + esc(JT.message(e))); }
  }
  const tab = $("tab-discontinued");
  tab.addEventListener("click", (e) => {
    const t = e.target, q = (s) => t.closest(s); let b;
    if ((b = q("[data-dc-view]"))) { D.view = b.dataset.dcView; if (D.view === "lists") catalog().then(render).catch(() => {}); render(); return; }
    if ((b = q("[data-dc-go]"))) { D.view = b.dataset.dcGo; D.up = null; render(); return; }
    if ((b = q("[data-dc-show]"))) { D.show = b.dataset.dcShow; D.sel.clear(); render(); return; }
    if ((b = q("[data-dc-sel]"))) { b.checked ? D.sel.add(b.dataset.dcSel) : D.sel.delete(b.dataset.dcSel); render(); return; }
    if ((b = q("[data-dc-all]"))) { const rows = (D.rows || []).filter(r => r.bucket === D.show && (D.vendor === "all" || r.vendor === D.vendor)); rows.forEach(r => b.checked ? D.sel.add(r.vid) : D.sel.delete(r.vid)); render(); return; }
    if ((b = q("[data-dc-mark]"))) { const ids = [...D.sel], yes = b.dataset.dcMark === "1";
      return mark(ids, yes, yes ? `${ids.length} marked discontinued.` : D.show === "maybe" ? `${ids.length} kept as carried — they won't show as maybe again.` : `${ids.length} no longer discontinued.`); }
    if ((b = q("[data-dc-one]"))) { const v = D.cat && D.cat.byId.get(b.dataset.dcOne); return mark([b.dataset.dcOne], true, `${esc(v ? v.title : "Product")} marked discontinued.`); }
    if (q("[data-dc-cancel]")) { D.up = null; render(); return; }
    if (q("[data-dc-save]")) return saveList();
  });
  tab.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "dc-vendor") { D.vendor = t.value; D.sel.clear(); render(); return; }
    if (t.id === "dc-file") { const f = t.files[0]; t.value = ""; if (f) readFile(f); return; }
    if (t.id === "dc-uvendor" && D.up) { D.up.vendor = t.value.trim(); if (D.cat) { const v = D.cat.vendors.find(x => x.toLowerCase() === D.up.vendor.toLowerCase()); if (v) D.up.vendor = v; } if (D.up.rows) match(D.up); render(); return; }
    if (t.id === "dc-uvendor") { D.up = { vendor: t.value.trim(), full: $("dc-ufull").checked }; D.up.rows = undefined; return; }
    if (t.id === "dc-ufull" && D.up) { D.up.full = t.checked; return; }
    if (t.id === "dc-sheet" && D.up) { D.up.sheet = +t.value; pickSheet(D.up); match(D.up); render(); return; }
    if (t.dataset.dcCol && D.up) { const v = t.value; if (v === "") delete D.up.map[t.dataset.dcCol]; else D.up.map[t.dataset.dcCol] = +v; match(D.up); render(); }
  });
  tab.addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "dc-q") { D.q = t.value; clearTimeout(t._t); t._t = setTimeout(render, 150); return; }
    if (t.id === "dc-mq") { D.mark.q = t.value; clearTimeout(t._t); t._t = setTimeout(() => { const h = $("dc-mres"); if (h) h.innerHTML = markResults(); }, 150); }
  });
  async function saveList() {
    const U = D.up; if (!U || !U.rows) return;
    U.saving = true; render();
    try {
      const r = await JT.vendorData.saveList({ vendor: U.vendor, name: U.name, file_name: U.file, full_list: !!U.full, source: "file", by: me(),
        rows: U.rows.map(x => ({ item_code: x.item_code, upc: x.upc, description: x.description, cost: x.cost, msrp: x.msrp, status: x.status === "?" ? "" : x.status,
          avail_qty: x.avail_qty, eta: x.eta, variant_id: x.vid, match_how: x.how })) });
      U.saving = false; U.done = r; await load(true);
    } catch (e) { U.saving = false; U.err = "Couldn't save the pricelist: " + JT.message(e); render(); }
  }
  $("dc-refresh").addEventListener("click", () => load(true));

  window.discShow = () => { if (!D.shown) { D.shown = true; load(false); } else { render(); load(true); } };
  if (!$("tab-discontinued").hidden) setTimeout(() => window.discShow(), 0);
})();
