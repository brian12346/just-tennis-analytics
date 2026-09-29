(() => {
  // Reading a vendor invoice PDF in the browser (pdf.js): the text rows as laid out on the page, then the header
  // (vendor, invoice #, date, PO #, subtotal) and the item lines (a row whose qty x unit cost = amount).
  // Shared by the Purchase orders and Invoices tabs: window.JTInvParse.
  const norm = (t) => String(t || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const numOf = (t) => { if (t == null) return null; let s = String(t).trim(); if (!s) return null; const neg = /^\(.*\)$/.test(s) || /-$/.test(s); s = s.replace(/[()$,\s]/g, "").replace(/-$/, ""); if (!/^-?\d*\.?\d+$/.test(s)) return null; const v = Number(s); return neg ? -Math.abs(v) : v; };
  const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";

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
  function parseInvoice(rows, ctx) {
    ctx = ctx || {}; const skipV = ctx.notVendor || /\bjust tennis\b/i;   // our own name is on every invoice (bill to / ship to)
    const vendors = (ctx.vendors || []).filter(v => !skipV.test(v));
    const text = rows.map(r => r.cells.join("  ")).join("\n");
    const out = { vendor: "", invoice_no: "", invoice_date: "", po_no: "", subtotal: null, lines: [] };
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
    // PO number: "PO #", "P.O. No.", "Customer PO", "Purchase order" (same row or the cell below); not "PO Box"
    const PO_RE = /\b(?:customer\s*|cust\.?\s*)?(?:p\.?\s?o\.?|purchase\s*order)(?!\s*box)\s*(?:#|no\.?|number|num\.?)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{1,24})/i;
    for (let i = 0; i < rows.length && !out.po_no; i++) {
      const t = rows[i].cells.join("  "), mt = PO_RE.exec(t);
      if (mt && /\d/.test(mt[1]) && !/^(box|number|no)$/i.test(mt[1])) { out.po_no = mt[1]; continue; }
      const k = rows[i].cells.findIndex(c => /^(?:customer\s*)?(?:p\.?\s?o\.?|purchase\s*order)\s*(?:#|no\.?|number)?\s*:?$/i.test(c.trim()));
      if (k >= 0 && rows[i + 1]) { const b = cellBelow(rows[i], k, rows[i + 1]), tok = (b.match(/[A-Z0-9][A-Z0-9\-\/]{1,24}/i) || [])[0]; if (tok && /\d/.test(tok) && !parseDate(b)) out.po_no = tok; }
    }
    const st = /sub\s*-?\s*total[^0-9\n]*\$?\s*([\d,]+\.\d{2})/i.exec(text) || /merchandise\s*total[^0-9\n]*\$?\s*([\d,]+\.\d{2})/i.exec(text);
    if (st) out.subtotal = numOf(st[1]);
    // vendor: the Shopify vendor named most often (first page counts double)
    if (vendors.length) {
      let best = "", bestN = 0;
      const low = text.toLowerCase(), first = rows.filter(r => r.page === 1).slice(0, 25).map(r => r.cells.join(" ")).join(" ").toLowerCase();
      for (const v of vendors) {
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
      const known = (t) => !!(ctx.known && ctx.known(t, out.vendor));
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


  window.JTInvParse = { pdfLib, pdfRows, parseInvoice, parseDate, findQtyPrice, cellBelow, norm, numOf };
})();
