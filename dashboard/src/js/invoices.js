(() => {
  // ===================== Vendor invoices =====================
  // Upload a vendor invoice PDF, read its lines (pdf.js, in the browser), match them to Shopify variants,
  // review, then apply: costs (and approved retail prices) are queued in jt.cost_updates and written to
  // Shopify by the sync. Matches are remembered per vendor item code (jt.vendor_items) for the next invoice.
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const m = (n) => n == null || isNaN(n) ? "—" : usd.format(n);
  const pct = (x) => x == null || !isFinite(x) ? "—" : (x * 100).toFixed(1) + "%";
  const JT = window.JT;
  const norm = (t) => String(t || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const numOf = (t) => { if (t == null) return null; let s = String(t).trim(); if (!s) return null; const neg = /^\(.*\)$/.test(s) || /-$/.test(s); s = s.replace(/[()$,\s]/g, "").replace(/-$/, ""); if (!/^-?\d*\.?\d+$/.test(s)) return null; const v = Number(s); return neg ? -Math.abs(v) : v; };
  const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";

  const I = {
    ready: false, loading: false, err: null, shown: false,
    list: null,                 // [{id, vendor, invoice_no, date, file, subtotal, status, created, applied, lines, matched, total}]
    cat: null, catAt: 0,        // [{vid, pid, sku, barcode, title, vendor, status, price, cost, qty}]
    idx: null,                  // lookup maps over cat
    vendors: [],                // Shopify vendor names
    rules: new Map(),           // vendor -> {margin, rounding}; "*" = default
    remembered: new Map(),      // vendor|CODE -> variant id
    ed: null,                   // invoice being edited: {id, vendor, invoice_no, invoice_date, file_name, subtotal, status, lines:[...], raw}
    searchLine: null, searchQ: "",
    busy: "", show: "all", q: "",
    updates: new Map(),         // for an applied invoice: variant id -> {status, error, new_cost, new_price}
  };

  function note(kind, html) { const n = $("inv-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; }
  const setStatus = (t) => { $("inv-status").textContent = t; };

  // ---------- loading ----------
  async function loadList(refresh) {
    const r = await JT.rows(["i.id::text", "i.vendor", "i.invoice_no", "i.invoice_date::text", "i.file_name", "i.subtotal", "i.status",
      "i.created_at", "i.applied_at", "(select count(*) from jt.invoice_lines l where l.invoice_id = i.id)",
      "(select count(*) from jt.invoice_lines l where l.invoice_id = i.id and l.variant_id is not null)",
      "(select sum(coalesce(l.amount, l.qty * l.unit_cost)) from jt.invoice_lines l where l.invoice_id = i.id)"],
      "from jt.invoices i order by coalesce(i.invoice_date, i.created_at::date) desc, i.id desc limit 500", refresh);
    const done = () => setStatus(`${I.list.length} invoice${I.list.length === 1 ? "" : "s"}${I.cat ? ` · ${I.cat.length.toLocaleString()} Shopify variants loaded for matching` : ""}`);
    setTimeout(done, 0);
    I.list = r.map(x => ({ id: x[0], vendor: x[1], invoice_no: x[2], date: x[3], file: x[4], subtotal: x[5], status: x[6], created: x[7], applied: x[8], lines: +x[9], matched: +x[10], total: x[11] }));
  }
  async function loadCatalog(refresh) {
    if (!refresh && I.cat && Date.now() - I.catAt < 1800000) return;
    const [r, rules, rem] = await Promise.all([
      JT.rowsSplit(["variant_id::text", "product_id::text", "sku", "coalesce(barcode, '')", "coalesce(nullif(display_name, ''), product_title)", "vendor", "status", "price", "unit_cost", "inventory_qty"],
        "from jt.variants where removed_at is null", "variant_id", 4, refresh),
      JT.rows(["vendor", "margin", "rounding"], "from jt.price_rules", refresh),
      JT.rows(["vendor", "item_code", "variant_id::text"], "from jt.vendor_items", refresh),
    ]);
    I.cat = r.map(x => ({ vid: x[0], pid: x[1], sku: x[2] || "", barcode: x[3] || "", title: x[4] || "", vendor: x[5] || "", status: x[6] || "", price: x[7] == null ? null : +x[7], cost: x[8] == null ? null : +x[8], qty: x[9] }));
    I.catAt = Date.now();
    I.rules = new Map(rules.map(([v, mg, rd]) => [v, { margin: mg == null ? null : +mg, rounding: rd || ".99" }]));
    I.remembered = new Map(rem.map(([v, c, id]) => [v.toLowerCase() + "|" + c, id]));
    const byVid = new Map(), bySku = new Map(), byBar = new Map(), vendors = new Set();
    const add = (mp, k, v) => { if (!k) return; const l = mp.get(k) || []; l.push(v); mp.set(k, l); };
    for (const v of I.cat) {
      byVid.set(v.vid, v); add(bySku, norm(v.sku), v); add(byBar, norm(v.barcode).replace(/^0+/, ""), v);
      if (v.vendor) vendors.add(v.vendor);
      v.words = new Set(words(v.title + " " + v.sku));
    }
    I.idx = { byVid, bySku, byBar };
    I.vendors = [...vendors].sort((a, b) => a.localeCompare(b));
  }
  async function loadUpdates(id) {
    const r = await JT.rows(["variant_id::text", "status", "error", "new_cost", "new_price"], `from jt.cost_updates where invoice_id = ${JT.int(id)} order by id`, true);
    I.updates = new Map(r.map(x => [x[0], { status: x[1], error: x[2], new_cost: x[3], new_price: x[4] }]));
  }
  async function refresh(force) {
    if (I.loading) return;
    I.loading = true; I.err = null; setStatus("Loading invoices and the product catalog…"); renderList();
    try {
      await Promise.all([loadList(force), loadCatalog(force)]);
      I.ready = true;
      setStatus(`${I.list.length} invoice${I.list.length === 1 ? "" : "s"} · ${I.cat.length.toLocaleString()} Shopify variants loaded for matching`);
    } catch (e) { I.err = e; setStatus(""); note("bad", esc(JT.message(e))); }
    finally { I.loading = false; renderList(); renderEditor(); }
  }

  // ---------- reading the PDF ----------
  let pdfjs = null;
  async function pdfLib() {
    if (pdfjs) return pdfjs;
    const lib = await import(PDFJS + "pdf.min.mjs");
    lib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs";
    pdfjs = lib; return lib;
  }
  // Rows of text as they appear on the page: items on one baseline, left to right. Big horizontal gaps become cell breaks.
  async function pdfRows(buf) {
    const lib = await pdfLib();
    const doc = await lib.getDocument({ data: buf, isEvalSupported: false }).promise;
    const rows = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const items = tc.items.filter(it => it.str && it.str.trim()).map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || 8 }));
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = [];
      for (const it of items) {
        const ln = lines.find(l => Math.abs(l.y - it.y) <= Math.max(2, it.h * 0.35));
        if (ln) ln.items.push(it); else lines.push({ y: it.y, items: [it] });
      }
      lines.sort((a, b) => b.y - a.y);
      for (const l of lines) {
        l.items.sort((a, b) => a.x - b.x);
        const cells = []; let cur = null, end = -1e9;
        for (const it of l.items) {
          const gap = it.x - end;
          if (cur && gap < Math.max(it.h * 0.9, 4)) { cur.t += (gap > it.h * 0.15 ? " " : "") + it.s; }
          else { cur = { t: it.s, x: it.x }; cells.push(cur); }
          end = it.x + it.w;
        }
        const keep = cells.filter(c => c.t.trim());
        rows.push({ page: p, y: l.y, cells: keep.map(c => c.t.trim()), xs: keep.map(c => c.x) });
      }
    }
    return rows;
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function parseDate(s) {
    let mt = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s);
    if (mt) return iso(+mt[1], +mt[2], +mt[3]);
    mt = /\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/.exec(s);
    if (mt) { let y = +mt[3]; if (y < 100) y += 2000; return iso(y, +mt[1], +mt[2]); }
    mt = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(s);
    if (mt) return iso(+mt[3], MONTHS[mt[1].toLowerCase()], +mt[2]);
    mt = /\b(\d{1,2})[\s-](jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*[\s-](\d{2,4})\b/i.exec(s);
    if (mt) { let y = +mt[3]; if (y < 100) y += 2000; return iso(y, MONTHS[mt[2].toLowerCase()], +mt[1]); }
    return "";
  }
  function iso(y, mo, d) { if (!(y > 2000 && y < 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return ""; return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }

  const MONEY = /^\(?-?\$?\s?\d{1,3}(,\d{3})*(\.\d{2,4})?\)?-?$|^\(?-?\$?\d+(\.\d{2,4})?\)?-?$/;
  const isNumTok = (t) => MONEY.test(t.replace(/\s/g, ""));
  const tokens = (cells) => cells.flatMap(c => c.split(/\s+/)).filter(Boolean);

  // Header fields and item lines from the PDF's rows.
  function parseInvoice(rows) {
    const text = rows.map(r => r.cells.join("  ")).join("\n");
    const out = { vendor: "", invoice_no: "", invoice_date: "", subtotal: null, lines: [] };
    // invoice number: the token after "invoice #/no/number" (on the same row or the row below)
    for (let i = 0; i < rows.length && !out.invoice_no; i++) {
      const t = rows[i].cells.join("  ");
      const mt = /invoice\s*(?:no\.?|number|num\.?|#|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i.exec(t);
      if (mt && /\d/.test(mt[1]) && !parseDate(mt[1])) out.invoice_no = mt[1];
      else if (/invoice\s*(no\.?|number|#)/i.test(t) && rows[i + 1]) {
        const k = rows[i].cells.findIndex(c => /invoice\s*(no\.?|number|#)/i.test(c));
        const below = cellBelow(rows[i], k, rows[i + 1]);
        const tok = (below.match(/[A-Z0-9][A-Z0-9\-\/]{2,}/i) || [])[0];
        if (tok && /\d/.test(tok) && !parseDate(below)) out.invoice_no = tok;
      }
    }
    // invoice date: a date on the "invoice date" row (or the row below), otherwise the first date on the page
    for (let i = 0; i < rows.length && !out.invoice_date; i++) {
      const t = rows[i].cells.join("  ");
      if (/(invoice|inv\.?)\s*date|date\s*(of\s*)?invoice/i.test(t)) out.invoice_date = parseDate(t) || (rows[i + 1] ? parseDate(cellBelow(rows[i], rows[i].cells.findIndex(c => /date/i.test(c)), rows[i + 1])) || parseDate(rows[i + 1].cells.join("  ")) : "");
      else if (!out.invoice_date && rows[i + 1] && rows[i].cells.some(c => /^date$/i.test(c.trim()))) out.invoice_date = parseDate(cellBelow(rows[i], rows[i].cells.findIndex(c => /^date$/i.test(c.trim())), rows[i + 1]));
    }
    if (!out.invoice_date) for (const r of rows) { const d = parseDate(r.cells.join("  ")); if (d) { out.invoice_date = d; break; } }
    const st = /sub\s*-?\s*total[^0-9\n]*\$?\s*([\d,]+\.\d{2})/i.exec(text) || /merchandise\s*total[^0-9\n]*\$?\s*([\d,]+\.\d{2})/i.exec(text);
    if (st) out.subtotal = numOf(st[1]);
    // vendor: the Shopify vendor named most often (first page counts double)
    if (I.vendors.length) {
      let best = "", bestN = 0;
      const low = text.toLowerCase(), first = rows.filter(r => r.page === 1).slice(0, 25).map(r => r.cells.join(" ")).join(" ").toLowerCase();
      for (const v of I.vendors) {
        const k = v.toLowerCase(); if (k.length < 3) continue;
        const re = new RegExp("\\b" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g");
        const n = (low.match(re) || []).length + (first.match(re) || []).length;
        if (n > bestN) { best = v; bestN = n; }
      }
      out.vendor = best;
    }
    // item lines: a row with a quantity, a unit price and an extended amount where qty × unit ≈ amount
    let last = null;
    for (const r of rows) {
      const tk = tokens(r.cells);
      const nums = tk.map((t, i) => ({ t, i, v: isNumTok(t) ? numOf(t) : null })).filter(x => x.v != null);
      const hit = findQtyPrice(nums);
      if (!hit) {
        // a text-only row right under an item line continues its description
        const priced = nums.some(x => /\.\d{2}/.test(x.t));
        if (last && !priced && nums.length < 3 && r.page === last.page && last.y - r.y < 16 && tk.length && tk.length < 14 && !/total|page|continued|freight|ship|tax/i.test(r.cells.join(" "))) {
          last.line.description = (last.line.description + " " + r.cells.join(" ")).trim().slice(0, 300);
        }
        if (priced) last = null;
        continue;
      }
      if (/\b(sub\s*total|total|freight|shipping|tax|balance|amount due|discount)\b/i.test(r.cells.join(" ")) && hit.qty === 1 && tk.length < 6) continue;
      const used = new Set([hit.qi, hit.ui, hit.ai]);
      const rest = tk.filter((t, i) => !used.has(i));
      const upc = rest.find(t => /^\d{11,14}$/.test(t)) || "";
      // item code: a token that is a known SKU / remembered code first, then the first code-like token
      const known = (t) => I.idx && (I.idx.bySku.has(norm(t)) || (out.vendor && I.remembered.has(out.vendor.toLowerCase() + "|" + norm(t))));
      const codeLike = (t) => t !== upc && t.length <= 30 && /\d/.test(t) && /^[A-Za-z0-9][A-Za-z0-9\-_.\/]*$/.test(t) && !/^\d{11,14}$/.test(t) && !/\.\d{2,4}$/.test(t)
        && (/^\d+$/.test(t) ? t.length >= 5 && t.length <= 10 : t.length >= 3);
      const code = rest.find(t => t !== upc && known(t)) || rest.find(codeLike) || "";
      // description: the words between the item code / UPC and the first price or quantity after them
      const ci = Math.max(tk.indexOf(code), upc ? tk.indexOf(upc) : -1);
      const from = ci >= 0 ? ci + 1 : 0;
      let to = tk.length;
      for (let i = from; i < tk.length; i++) if (i === hit.qi || i === hit.ui || i === hit.ai || /\.\d{2,4}\)?$/.test(tk[i]) || /^\d+(\.\d+)?%$/.test(tk[i])) { to = i; break; }
      let desc = tk.slice(from, to).filter(t => t !== code && t !== upc && !/^(ea|each|pc|pcs|bx|cs|dz|pr|pair|unit|units)$/i.test(t)).join(" ");
      if (!desc) desc = rest.filter(t => t !== upc && t !== code && !isNumTok(t) && !/^\d+(\.\d+)?%$/.test(t)).join(" ");
      desc = desc.slice(0, 300);
      const line = { item_code: code, upc, description: desc, qty: hit.qty, unit_cost: hit.unit, amount: hit.amount };
      out.lines.push(line); last = { line, y: r.y, page: r.page };
    }
    return out;
  }
  // The cell in the next row that sits under cell k of this row (closest left edge).
  function cellBelow(row, k, next) {
    if (!next || k < 0) return "";
    const x = row.xs ? row.xs[k] : null;
    if (x == null || !next.xs) return next.cells[k] || next.cells[0] || "";
    let best = "", bd = 1e9;
    next.cells.forEach((c, j) => { const d = Math.abs(next.xs[j] - x); if (d < bd) { bd = d; best = c; } });
    return bd < 60 ? best : "";
  }
  function findQtyPrice(nums) {
    if (nums.length < 3) return null;
    // amount = a number with cents, near the right; unit = a number to its left; qty = any other number with qty × unit ≈ amount
    for (let a = nums.length - 1; a >= 2; a--) {
      const A = nums[a]; if (!/\.\d{2}/.test(A.t) || A.v <= 0) continue;
      for (let u = a - 1; u >= 1; u--) {
        const U = nums[u]; if (U.v <= 0) continue;
        for (let q = u - 1; q >= 0; q--) {
          const Q = nums[q]; if (Q.v <= 0 || Q.v > 100000 || Q.t.replace(/\D/g, "").length > 7) continue;
          if (Math.abs(Q.v * U.v - A.v) <= Math.max(0.02, A.v * 0.005)) return { qty: Q.v, unit: U.v, amount: A.v, qi: Q.i, ui: U.i, ai: A.i };
        }
        // quantity after the prices (some layouts): qty to the right of amount is rare; skip
      }
    }
    return null;
  }

  // ---------- matching ----------
  const STOP = new Set(["THE", "AND", "WITH", "FOR", "NEW", "EACH", "PACK", "PK", "EA", "OF", "IN"]);
  function words(t) { return String(t || "").toUpperCase().split(/[^A-Z0-9]+/).filter(w => w.length >= 2 && !STOP.has(w)); }
  function matchLine(line, vendor) {
    const { byVid, bySku, byBar } = I.idx;
    const code = norm(line.item_code), upc = norm(line.upc).replace(/^0+/, "");
    const inV = (l) => l && (vendor ? l.filter(v => v.vendor.toLowerCase() === vendor.toLowerCase()) : l);
    const one = (l) => l && l.length === 1 ? l[0] : null;
    const rem = code && vendor ? I.remembered.get(vendor.toLowerCase() + "|" + code) : null;
    if (rem && byVid.get(rem)) return { v: byVid.get(rem), how: "remembered" };
    if (code) { const l = bySku.get(code); const v = one(inV(l)) || one(l); if (v) return { v, how: "sku" }; }
    if (upc) { const l = byBar.get(upc); const v = one(l); if (v) return { v, how: "upc" }; }
    if (upc) { const l = bySku.get(upc); const v = one(l); if (v) return { v, how: "upc" }; }
    // SKU that contains the code or the code that contains the SKU (same vendor, one clear hit)
    if (code.length >= 5 && vendor) {
      const hits = I.cat.filter(v => v.vendor.toLowerCase() === vendor.toLowerCase() && v.sku && (norm(v.sku).includes(code) || (norm(v.sku).length >= 5 && code.includes(norm(v.sku)))));
      if (hits.length === 1) return { v: hits[0], how: "title" };
    }
    // title words (same vendor), only when one product is clearly best
    const w = new Set(words(line.description + " " + line.item_code));
    if (w.size >= 2 && vendor) {
      let best = null, bs = 0, second = 0;
      for (const v of I.cat) {
        if (v.vendor.toLowerCase() !== vendor.toLowerCase()) continue;
        let n = 0; for (const x of w) if (v.words.has(x)) n++;
        const s = n / Math.max(w.size, 1);
        if (s > bs) { second = bs; bs = s; best = v; } else if (s > second) second = s;
      }
      if (best && bs >= 0.6 && bs - second >= 0.15) return { v: best, how: "title" };
    }
    return null;
  }
  function search(qs, vendor) {
    const w = words(qs); const code = norm(qs);
    if (!w.length && !code) return [];
    const scored = [];
    for (const v of I.cat) {
      let s = 0;
      if (code && norm(v.sku) === code) s += 10;
      else if (code.length >= 3 && norm(v.sku).includes(code)) s += 4;
      if (code && norm(v.barcode).replace(/^0+/, "") === code.replace(/^0+/, "")) s += 10;
      for (const x of w) if (v.words.has(x)) s += 1;
      if (!s) continue;
      if (vendor && v.vendor.toLowerCase() === vendor.toLowerCase()) s += 0.5;
      if (v.status === "ACTIVE") s += 0.2;
      scored.push([s, v]);
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, 10).map(x => x[1]);
  }

  // ---------- pricing ----------
  function ruleFor(vendor) { return I.rules.get(vendor) || I.rules.get("*") || { margin: null, rounding: ".99" }; }
  function roundPrice(p, how) {
    if (!(p > 0)) return null;
    if (how === ".99" || how === ".95") { const c = how === ".99" ? 0.01 : 0.05; let r = Math.ceil(p + c - 1e-9) - c; if (r < p - 1e-9) r += 1; return Math.round(r * 100) / 100; }
    if (how === ".00") return Math.ceil(p - 1e-9);
    return Math.round(p * 100) / 100;
  }
  // Suggested retail price for a matched line with a new cost: target margin, or keep the item's current margin.
  function suggest(line, v, vendor) {
    const cost = line.unit_cost;
    if (!v || !(cost > 0)) return null;
    const r = ruleFor(vendor);
    let target = null;
    if (r.margin != null && r.margin < 0.95) target = cost / (1 - r.margin);
    else if (v.price > 0 && v.cost > 0) target = v.price * cost / v.cost;
    const p = roundPrice(target, r.rounding);
    if (p == null || (v.price != null && Math.abs(p - v.price) < 0.005)) return null;
    return p;
  }

  // ---------- editing ----------
  const blankLine = () => ({ item_code: "", upc: "", description: "", qty: null, unit_cost: null, amount: null, variant_id: null, match_how: "", update_cost: true, update_price: false, new_price: null });
  function prepareLines(ed) {
    for (const l of ed.lines) {
      if (l.variant_id == null) {
        const hit = matchLine(l, ed.vendor);
        if (hit) { l.variant_id = hit.v.vid; l.match_how = hit.how; }
      }
      if (l.update_cost == null) l.update_cost = true;
      if (l.match_how === "title" && !l._reviewed) l.update_cost = false;   // a guess: tick it once it's confirmed
      const v = l.variant_id && I.idx.byVid.get(String(l.variant_id));
    }
  }
  async function onFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { note("warn", "That isn't a PDF. Choose the invoice's PDF file."); return; }
    if (!I.ready) await refresh(false);
    if (!I.cat) return;
    note(null); I.busy = "Reading " + file.name + "…"; renderEditor();
    try {
      const rows = await pdfRows(await file.arrayBuffer());
      const inv = parseInvoice(rows);
      I.ed = { id: null, status: "draft", vendor: inv.vendor, invoice_no: inv.invoice_no, invoice_date: inv.invoice_date, file_name: file.name,
               subtotal: inv.subtotal, notes: "", lines: inv.lines.map(l => Object.assign(blankLine(), l)), raw: rows, filter: "all" };
      prepareLines(I.ed);
      if (!rows.length) note("warn", "This PDF has no text in it (it's probably a scan or photo), so no lines could be read. Add the lines by hand with <b>Add line</b>, or ask the vendor for a digital invoice.");
      else if (!inv.lines.length) note("warn", "No item lines were recognised in this PDF. Add them with <b>Add line</b>, and use <b>Show PDF text</b> to see what was read. Send Claude a sample of this vendor's invoice to teach the reader its layout.");
      const dup = I.list && I.list.find(x => x.invoice_no && inv.invoice_no && x.invoice_no.toLowerCase() === inv.invoice_no.toLowerCase() && x.vendor.toLowerCase() === (inv.vendor || "").toLowerCase());
      if (dup) note("warn", `Invoice <b>${esc(inv.invoice_no)}</b> from ${esc(inv.vendor)} was already uploaded${dup.status === "applied" ? " and applied" : ""}. <button class="mini" data-open="${esc(dup.id)}">Open it</button>`);
    } catch (e) {
      console.error("[JT] invoice read failed", e);
      note("bad", "Couldn't read that PDF" + (e && e.message ? ": " + esc(e.message) : "") + ".");
    } finally { I.busy = ""; renderEditor(); if (I.ed) $("inv-edit").scrollIntoView({ behavior: "smooth", block: "start" }); }
  }
  async function openInvoice(id) {
    note(null); I.busy = "Opening invoice…"; renderEditor();
    try {
      if (!I.cat) await loadCatalog(false);
      const [h, ls] = await Promise.all([
        JT.rows(["id::text", "vendor", "invoice_no", "invoice_date::text", "file_name", "subtotal", "status", "notes"], `from jt.invoices where id = ${JT.int(id)}`, true),
        JT.rows(["line_no", "item_code", "upc", "description", "qty", "unit_cost", "amount", "variant_id::text", "match_how", "update_cost", "new_price"], `from jt.invoice_lines where invoice_id = ${JT.int(id)} order by line_no`, true),
      ]);
      if (!h[0]) throw { code: "tool_error", message: "That invoice no longer exists." };
      const [iid, vendor, no, date, file, sub, status, notes] = h[0];
      I.ed = { id: iid, vendor, invoice_no: no, invoice_date: date || "", file_name: file, subtotal: sub == null ? null : +sub, status, notes, raw: null, filter: "all",
               lines: ls.map(x => ({ item_code: x[1], upc: x[2], description: x[3], qty: x[4] == null ? null : +x[4], unit_cost: x[5] == null ? null : +x[5], amount: x[6] == null ? null : +x[6],
                                     variant_id: x[7], match_how: x[8], update_cost: !!x[9], new_price: x[10] == null ? null : +x[10], update_price: x[10] != null, _reviewed: true })) };
      I.updates = new Map();
      if (status === "applied") await loadUpdates(iid);
      else prepareLines(I.ed);
    } catch (e) { note("bad", esc(JT.message(e))); }
    finally { I.busy = ""; renderEditor(); if (I.ed) $("inv-edit").scrollIntoView({ behavior: "smooth", block: "start" }); }
  }
  function bodyOf(ed) {
    return { id: ed.id, vendor: ed.vendor || "", invoice_no: ed.invoice_no || "", invoice_date: ed.invoice_date || "", file_name: ed.file_name || "",
             subtotal: ed.subtotal, notes: ed.notes || "",
             lines: ed.lines.map(l => ({ item_code: l.item_code || "", upc: l.upc || "", description: l.description || "", qty: l.qty, unit_cost: l.unit_cost, amount: l.amount,
                                         variant_id: l.variant_id || null, match_how: l.match_how || "", update_cost: !!l.update_cost,
                                         new_price: null })) };   // prices aren't changed from invoices (for now)
  }
  async function save(andApply) {
    const ed = I.ed; if (!ed || ed.status === "applied") return;
    if (!ed.vendor) { note("warn", "Pick the vendor first — matches are remembered per vendor."); return; }
    I.busy = andApply ? "Applying…" : "Saving…"; renderEditor();
    try {
      ed.id = String(await JT.invoices.save(bodyOf(ed)));
      if (andApply) {
        const n = await JT.invoices.apply(ed.id);
        note("info", `Applied. ${n} product cost${n === 1 ? "" : "s"} queued for Shopify. The sync writes them within about a minute; this invoice shows each one's result.`);
        ed.status = "applied";
        await Promise.all([loadList(true), loadUpdates(ed.id), loadCatalog(true)]);
      } else {
        note("info", "Draft saved.");
        await loadList(true);
      }
    } catch (e) {
      const msg = (e && e.message) || "";
      if (/invoices_vendor_no_idx|duplicate key/i.test(msg)) note("bad", `Invoice ${esc(ed.invoice_no)} from ${esc(ed.vendor)} is already saved. Open it from the list below instead.`);
      else note("bad", esc(JT.message(e)));
    } finally { I.busy = ""; renderEditor(); renderList(); }
  }

  // ---------- rendering ----------
  function renderList() {
    const t = $("inv-list"); if (!t) return;
    if (!I.list) { t.innerHTML = `<tbody><tr><td class="l muted">${I.loading ? "Loading…" : "—"}</td></tr></tbody>`; return; }
    const qs = I.q.toLowerCase();
    const rows = I.list.filter(x => (I.show === "all" || x.status === I.show) && (!qs || (x.vendor + " " + x.invoice_no + " " + x.file).toLowerCase().includes(qs)));
    if (!rows.length) { t.innerHTML = `<tbody><tr><td class="l muted">${I.list.length ? "No invoices match." : "No invoices yet. Drop a PDF above to add the first one."}</td></tr></tbody>`; return; }
    t.innerHTML = `<thead><tr><th class="l">Date</th><th class="l">Vendor</th><th class="l">Invoice #</th><th>Lines</th><th>Matched</th><th>Total</th><th class="l">Status</th><th class="l">File</th><th></th></tr></thead><tbody>${
      rows.map(x => `<tr><td class="l">${esc(x.date || "")}</td><td class="l">${esc(x.vendor)}</td><td class="l mono">${esc(x.invoice_no)}</td><td>${x.lines}</td><td>${x.matched}/${x.lines}</td><td>${m(x.total == null ? null : +x.total)}</td>
        <td class="l">${x.status === "applied" ? '<span class="pill ok">Applied</span>' : '<span class="pill warn">Draft</span>'}</td><td class="l dim small">${esc(x.file)}</td>
        <td><button class="mini" data-open="${esc(x.id)}">${x.status === "applied" ? "View" : "Open"}</button></td></tr>`).join("")}</tbody>`;
  }

  function lineCells(l, i, ro) {
    const v = l.variant_id && I.idx && I.idx.byVid.get(String(l.variant_id));
    const newCost = l.unit_cost;
    const chg = v && v.cost > 0 && newCost != null ? (newCost - v.cost) / v.cost : null;
    const priceNow = v ? v.price : null;
    const priceAfter = priceNow;
    const marginAfter = priceAfter > 0 && newCost != null ? (priceAfter - newCost) / priceAfter : null;
    const inp = (f, val, cls = "", ph = "") => ro ? esc(val ?? "") : `<input class="inp ${cls}" data-f="${f}" data-i="${i}" value="${esc(val ?? "")}" placeholder="${ph}">`;
    const how = { remembered: "remembered", sku: "SKU", upc: "UPC", title: "guess — check", manual: "picked" }[l.match_how] || "";
    const upd = ro && v ? I.updates.get(String(v.vid)) : null;
    let match = "";
    if (I.searchLine === i && !ro) {
      const res = search(I.searchQ, I.ed.vendor);
      match = `<input class="inp" id="inv-sq" data-i="${i}" value="${esc(I.searchQ)}" placeholder="SKU, UPC or product words" autocomplete="off">
        <div class="mres">${res.map(r => `<button data-pick="${esc(r.vid)}" data-i="${i}"><b>${esc(r.title)}</b><br><span class="dim">${esc(r.sku)} · ${esc(r.vendor)} · ${m(r.price)}${r.status && r.status !== "ACTIVE" ? " · " + esc(r.status.toLowerCase()) : ""}</span></button>`).join("") || '<span class="muted small">No matches yet — type more.</span>'}</div>
        <div class="row"><button class="mini" data-cancel="${i}">Cancel</button>${l.variant_id ? `<button class="mini" data-unmatch="${i}">No match</button>` : ""}</div>`;
    } else if (v) {
      match = `<a class="olink" href="${ADMIN}/products/${esc(v.pid)}/variants/${esc(v.vid)}" target="_blank" rel="noopener">${esc(v.title)}</a><br><span class="dim small">${esc(v.sku)}${how ? " · " + how : ""}</span>${ro ? "" : ` <button class="linkbtn small" data-search="${i}">change</button>`}`;
    } else {
      match = ro ? '<span class="dim">not matched</span>' : `<button class="mini" data-search="${i}">Find product</button>`;
    }
    const dupOf = v ? I.ed.lines.findIndex((o, j) => j !== i && String(o.variant_id) === String(v.vid)) : -1;
    if (dupOf >= 0 && !(I.searchLine === i && !ro)) match += `<br><span class="small up">Same product as line ${dupOf + 1} — the later line's cost wins</span>`;
    const costCell = v ? `${m(v.cost)}${chg != null && Math.abs(chg) >= 0.0005 ? `<br><span class="small ${chg > 0 ? "up" : "down"}">${chg > 0 ? "+" : ""}${pct(chg)}</span>` : ""}` : "—";
    const priceCell = v ? m(priceNow) : "—";
    const mCell = marginAfter != null ? `<br><span class="small ${marginAfter < 0.2 ? "up" : "dim"}">margin ${pct(marginAfter)}</span>` : "";
    const status = ro ? (upd ? (upd.status === "done" ? '<span class="pill ok">In Shopify</span>' : upd.status === "failed" ? `<span class="pill miss" title="${esc(upd.error)}">Failed</span><br><span class="small dim">${esc(upd.error).slice(0, 80)}</span>` : upd.status === "pending" ? '<span class="pill warn">Queued</span>' : `<span class="pill">${esc(upd.status)}</span>`) : '<span class="dim">—</span>')
      : `<input type="checkbox" data-chk="update_cost" data-i="${i}" ${l.update_cost ? "checked" : ""} ${v ? "" : "disabled"} title="Write this cost to Shopify">`;
    return `<td class="l w-code">${inp("item_code", l.item_code, "mono")}${l.upc || !ro ? `<div class="small dim" style="margin-top:2px">${ro ? esc(l.upc) : inp("upc", l.upc, "mono", "UPC")}</div>` : ""}</td>
      <td class="l w-desc">${inp("description", l.description)}</td>
      <td class="w-n">${ro ? (l.qty ?? "") : inp("qty", l.qty, "num")}</td>
      <td class="w-n">${ro ? m(l.unit_cost) : inp("unit_cost", l.unit_cost, "num")}</td>
      <td class="w-n">${m(l.amount != null ? l.amount : l.qty != null && l.unit_cost != null ? l.qty * l.unit_cost : null)}</td>
      <td class="l match">${match}</td>
      <td>${costCell}</td>
      <td>${priceCell}${mCell}</td>
      <td>${status}</td>
      ${ro ? "" : `<td><button class="linkbtn small" data-del="${i}" title="Remove this line">✕</button></td>`}`;
  }

  function renderEditor() {
    const box = $("inv-edit"); if (!box) return;
    if (I.busy && !I.ed) { box.hidden = false; box.innerHTML = `<div class="muted">${esc(I.busy)}</div>`; return; }
    const ed = I.ed; if (!ed) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    const ro = ed.status === "applied";
    const keep = document.activeElement && box.contains(document.activeElement) ? { id: document.activeElement.id, f: document.activeElement.dataset.f, i: document.activeElement.dataset.i, s: document.activeElement.selectionStart } : null;
    const lines = ed.lines.map((l, i) => ({ l, i }));
    const shown = lines.filter(({ l }) => ed.filter === "all" || (ed.filter === "unmatched" ? !l.variant_id : ed.filter === "check" ? l.match_how === "title" && !l._reviewed : ed.filter === "changed" ? (() => { const v = l.variant_id && I.idx.byVid.get(String(l.variant_id)); return v && l.unit_cost != null && (v.cost == null || Math.abs(v.cost - l.unit_cost) >= 0.005); })() : true));
    const nMatched = ed.lines.filter(l => l.variant_id).length, nGuess = ed.lines.filter(l => l.match_how === "title" && !l._reviewed).length;
    const nCost = ed.lines.filter(l => l.variant_id && l.update_cost && l.unit_cost != null).length, nPrice = 0;
    const sum = ed.lines.reduce((a, l) => a + (l.amount != null ? l.amount : (l.qty || 0) * (l.unit_cost || 0)), 0);
    const r = ruleFor(ed.vendor), own = I.rules.has(ed.vendor);
    const vendorOpts = I.vendors.map(v => `<option value="${esc(v)}" ${v === ed.vendor ? "selected" : ""}>${esc(v)}</option>`).join("");
    box.innerHTML = `
      <div class="panel-head"><h2>${ro ? "Invoice" : ed.id ? "Draft invoice" : "New invoice"} ${ed.invoice_no ? "· " + esc(ed.invoice_no) : ""}</h2>
        <div class="right"><button class="mini" id="inv-close">Close</button></div></div>
      ${I.busy ? `<div class="note info">${esc(I.busy)}</div>` : ""}
      <div class="invhead">
        <label>Vendor ${ro ? `<b>${esc(ed.vendor)}</b>` : `<select id="inv-vendor" class="inp"><option value="">— pick the vendor —</option>${vendorOpts}${ed.vendor && !I.vendors.includes(ed.vendor) ? `<option selected>${esc(ed.vendor)}</option>` : ""}</select>`}</label>
        <label>Invoice # ${ro ? `<b class="mono">${esc(ed.invoice_no)}</b>` : `<input id="inv-no" class="inp mono" value="${esc(ed.invoice_no)}">`}</label>
        <label>Invoice date ${ro ? `<b>${esc(ed.invoice_date)}</b>` : `<input id="inv-date" class="inp" type="date" value="${esc(ed.invoice_date)}">`}</label>
        <label>Subtotal on invoice ${ro ? `<b>${m(ed.subtotal)}</b>` : `<input id="inv-sub" class="inp num" value="${ed.subtotal != null ? ed.subtotal.toFixed(2) : ""}">`}
          <span class="small ${ed.subtotal != null && Math.abs(ed.subtotal - sum) > 0.05 ? "up" : "dim"}">Lines add up to ${m(sum)}${ed.subtotal != null && Math.abs(ed.subtotal - sum) > 0.05 ? " — some lines may be missing" : ""}</span></label>
        <label>File <span class="dim">${esc(ed.file_name || "—")}</span></label>
      </div>

      <div class="invbar">
        <div class="seg" id="inv-filter" role="group" aria-label="Show lines">
          ${[["all", `All ${ed.lines.length}`], ["unmatched", `Not matched ${ed.lines.length - nMatched}`], ["check", `Guesses to check ${nGuess}`], ["changed", "Cost changes"]].map(([k, t]) => `<button data-filter="${k}" aria-pressed="${ed.filter === k}">${t}</button>`).join("")}
        </div>
        <span class="right">
          ${ro ? "" : `<button class="btn" id="inv-add">Add line</button>`}
          ${ed.raw ? `<button class="btn" id="inv-raw">${ed.showRaw ? "Hide" : "Show"} PDF text</button>` : ""}
          ${ro ? `<button class="btn" id="inv-recheck">Refresh results</button>` : `
            ${ed.id ? `<button class="btn" id="inv-delete">Delete draft</button>` : ""}
            <button class="btn" id="inv-save">Save draft</button>
            <button class="btn primary" id="inv-apply" ${nCost + nPrice ? "" : "disabled"}>Apply to Shopify: ${nCost} cost${nCost === 1 ? "" : "s"}${nPrice ? `, ${nPrice} price${nPrice === 1 ? "" : "s"}` : ""}</button>`}
        </span>
      </div>
      ${ed.confirm ? `<div class="note warn">Write ${nCost} cost${nCost === 1 ? "" : "s"}${nPrice ? ` and ${nPrice} retail price${nPrice === 1 ? "" : "s"}` : ""} to Shopify? Matches on this invoice are remembered for ${esc(ed.vendor)}'s next invoice. An applied invoice can't be edited.
        <span class="dbtns"><button class="mini primary" id="inv-yes">Yes, apply</button><button class="mini" id="inv-no-apply">Cancel</button></span></div>` : ""}
      ${ed.showRaw && ed.raw ? `<pre class="invraw">${esc(ed.raw.map(r => r.cells.join("  |  ")).join("\n"))}</pre>` : ""}
      <div class="tbl-wrap tall"><table class="invt">
        <thead><tr><th class="l">Item code / UPC</th><th class="l">Description</th><th>Qty</th><th>Unit cost</th><th>Amount</th><th class="l">Shopify product</th><th>Cost now</th><th>Price</th><th>${ro ? "Shopify" : "Update cost"}</th>${ro ? "" : "<th></th>"}</tr></thead>
        <tbody>${shown.map(({ l, i }) => `<tr class="${!l.variant_id ? "nomatch" : l.match_how === "title" && !l._reviewed ? "guess" : ""} ${!ro && l.variant_id && !l.update_cost && !l.update_price ? "skip" : ""}">${lineCells(l, i, ro)}</tr>`).join("") || `<tr><td class="l muted" colspan="10">No lines here.</td></tr>`}</tbody>
      </table></div>`;
    if (keep) {
      const el = keep.id ? $(keep.id) : box.querySelector(`[data-f="${keep.f}"][data-i="${keep.i}"]`);
      if (el) { el.focus(); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.s); } catch (_) {} }
    }
  }

  // ---------- events ----------
  function bindOnce() {
    const drop = $("inv-drop"), file = $("inv-file");
    file.addEventListener("change", () => { onFile(file.files[0]); file.value = ""; });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); onFile(e.dataTransfer.files[0]); });
    $("inv-refresh").addEventListener("click", () => refresh(true));
    $("inv-show").addEventListener("change", (e) => { I.show = e.target.value; renderList(); });
    $("inv-q").addEventListener("input", (e) => { I.q = e.target.value; renderList(); });
    document.getElementById("tab-invoices").addEventListener("click", (e) => {
      const o = e.target.closest("[data-open]"); if (o) { openInvoice(o.dataset.open); }
    });
    $("inv-list").addEventListener("click", () => {});
    const box = $("inv-edit");
    box.addEventListener("input", (e) => {
      const t = e.target, ed = I.ed; if (!ed) return;
      if (t.id === "inv-sq") { I.searchQ = t.value; renderEditor(); return; }
      if (t.dataset.f) {
        const l = ed.lines[+t.dataset.i], f = t.dataset.f;
        if (["qty", "unit_cost", "new_price"].includes(f)) {
          const v = numOf(t.value); l[f] = v;
          if (f === "new_price") l.update_price = v > 0;
          if (f !== "new_price") l.amount = l.qty != null && l.unit_cost != null ? Math.round(l.qty * l.unit_cost * 100) / 100 : l.amount;
        } else l[f] = t.value;
        if (f === "item_code" || f === "upc") { /* re-match on blur */ }
        clearTimeout(box._t); box._t = setTimeout(renderEditor, f === "description" || f === "item_code" || f === "upc" ? 600 : 250);
        return;
      }
      if (t.id === "inv-no") ed.invoice_no = t.value;
      if (t.id === "inv-sub") { ed.subtotal = numOf(t.value); clearTimeout(box._t); box._t = setTimeout(renderEditor, 400); }
    });
    box.addEventListener("change", (e) => {
      const t = e.target, ed = I.ed; if (!ed) return;
      if (t.id === "inv-vendor") {
        ed.vendor = t.value;
        for (const l of ed.lines) { if (l.match_how !== "manual" && l.match_how !== "remembered") { l.variant_id = null; l.match_how = ""; } l.new_price = null; l.update_price = false; }
        prepareLines(ed); renderEditor(); return;
      }
      if (t.id === "inv-date") { ed.invoice_date = t.value; return; }
      if (t.dataset.chk) { const l = ed.lines[+t.dataset.i]; l[t.dataset.chk] = t.checked; if (t.dataset.chk === "update_cost" && t.checked) l._reviewed = true; if (t.dataset.chk === "update_price" && t.checked && !(l.new_price > 0)) { const v = I.idx.byVid.get(String(l.variant_id)); l.new_price = suggest(l, v, ed.vendor) ?? (v && v.price); } renderEditor(); return; }
      if (t.dataset.f === "item_code" || t.dataset.f === "upc") {
        const l = ed.lines[+t.dataset.i];
        if (l.match_how !== "manual") { l.variant_id = null; l.match_how = ""; const hit = matchLine(l, ed.vendor); if (hit) { l.variant_id = hit.v.vid; l.match_how = hit.how; } }
        renderEditor();
      }
      if (t.dataset.f === "unit_cost") renderEditor();
    });
    box.addEventListener("keydown", (e) => {
      if (e.target.id === "inv-sq" && e.key === "Escape") { I.searchLine = null; renderEditor(); }
      if (e.target.id === "inv-sq" && e.key === "Enter") { const b = box.querySelector(".mres button[data-pick]"); if (b) b.click(); }
    });
    box.addEventListener("click", async (e) => {
      const t = e.target.closest("button"); if (!t) return;
      const ed = I.ed; if (!ed) return;
      if (t.id === "inv-close") { I.ed = null; I.searchLine = null; note(null); renderEditor(); return; }
      if (t.dataset.filter) { ed.filter = t.dataset.filter; renderEditor(); return; }
      if (t.dataset.search != null) { I.searchLine = +t.dataset.search; const l = ed.lines[I.searchLine]; I.searchQ = l.item_code || l.description.split(/\s+/).slice(0, 4).join(" "); renderEditor(); const s = $("inv-sq"); if (s) { s.focus(); s.select(); } return; }
      if (t.dataset.cancel != null) { I.searchLine = null; renderEditor(); return; }
      if (t.dataset.unmatch != null) { const l = ed.lines[+t.dataset.unmatch]; l.variant_id = null; l.match_how = "manual"; l.update_price = false; l.new_price = null; I.searchLine = null; renderEditor(); return; }
      if (t.dataset.pick) {
        const l = ed.lines[+t.dataset.i], v = I.idx.byVid.get(t.dataset.pick);
        l.variant_id = v.vid; l.match_how = "manual"; l._reviewed = true; l.update_cost = true;
        I.searchLine = null; renderEditor(); return;
      }
      if (t.dataset.del != null) { ed.lines.splice(+t.dataset.del, 1); I.searchLine = null; renderEditor(); return; }
      if (t.id === "inv-add") { ed.lines.push(Object.assign(blankLine(), { _reviewed: true })); ed.filter = "all"; renderEditor(); const ins = box.querySelectorAll('[data-f="item_code"]'); if (ins.length) ins[ins.length - 1].focus(); return; }
      if (t.id === "inv-raw") { ed.showRaw = !ed.showRaw; renderEditor(); return; }
      if (t.id === "inv-save") { save(false); return; }
      if (t.id === "inv-apply") { ed.confirm = true; renderEditor(); return; }
      if (t.id === "inv-no-apply") { ed.confirm = false; renderEditor(); return; }
      if (t.id === "inv-yes") { ed.confirm = false; save(true); return; }
      if (t.id === "inv-recheck") { I.busy = "Checking…"; renderEditor(); try { await Promise.all([loadUpdates(ed.id), loadCatalog(true)]); } catch (err) { note("bad", esc(JT.message(err))); } I.busy = ""; renderEditor(); return; }
      if (t.id === "inv-delete") {
        if (!ed.confirmDel) { ed.confirmDel = true; t.textContent = "Click again to delete"; return; }
        I.busy = "Deleting…"; renderEditor();
        try { await JT.invoices.remove(ed.id); I.ed = null; note("info", "Draft deleted."); await loadList(true); } catch (err) { note("bad", esc(JT.message(err))); }
        I.busy = ""; renderEditor(); renderList(); return;
      }
      if (t.id === "inv-rule" || t.id === "inv-resuggest") {
        const mg = numOf($("inv-margin").value), rd = $("inv-round").value;
        const rule = { margin: mg == null ? null : Math.min(Math.max(mg, 0), 94) / 100, rounding: rd };
        if (t.id === "inv-rule") {
          try { await JT.invoices.saveRule({ vendor: ed.vendor, margin: rule.margin, rounding: rule.rounding }); I.rules.set(ed.vendor, rule); note("info", `Pricing rule saved for ${esc(ed.vendor)}.`); }
          catch (err) { note("bad", esc(JT.message(err))); return; }
        } else I.rules.set(ed.vendor || "*", rule);   // try it out on this invoice without saving
        for (const l of ed.lines) { const v = l.variant_id && I.idx.byVid.get(String(l.variant_id)); if (!l.update_price || l.new_price === l._suggested) { l.new_price = suggest(l, v, ed.vendor); l._suggested = l.new_price; } }
        renderEditor(); return;
      }
    });
  }

  // ---------- boot ----------
  bindOnce();
  window.invShow = () => { if (!I.shown) { I.shown = true; refresh(false); } else { renderList(); renderEditor(); } };
  window.JTInvoices = { parseInvoice, findQtyPrice, roundPrice, parseDate, pdfRows, _state: I };   // for tests
  if ((location.hash || "") === "#invoices") setTimeout(() => window.invShow(), 0);
})();
