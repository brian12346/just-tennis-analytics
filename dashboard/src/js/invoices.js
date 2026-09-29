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
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";

  // Board lanes, in workflow order. Keys are stored in jt.invoices.stage; names can change freely.
  const STAGES = [
    ["booked", "Booking Orders Placed"],
    ["new", "New Invoices"],
    ["errors", "Invoices with Errors"],
    ["needs_products", "Invoiced - Needs Shopify Products"],
    ["needs_po", "Shipped - Items Received - Needs Shopify PO"],
    ["shopify", "Shipped - Shopify"],
    ["sellerboard", "Invoiced - Seller Board"],
    ["ready_qb", "Ready for QB"],
    ["processed", "Processed"],
  ];
  const STAGE_NAME = new Map(STAGES);
  const stageOf = (k) => STAGE_NAME.has(k) ? k : "new";
  const DONE_SHOWN = 12;   // newest cards shown in Processed until "show all"

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
    busy: "", q: "", showAllDone: false, drag: null,
    updates: new Map(),         // for an applied invoice: variant id -> {status, error, new_cost, new_price}
  };

  function note(kind, html) {
    const n = $(I.ed ? "inv-mnote" : "inv-note");
    for (const id of ["inv-note", "inv-mnote"]) if ($(id) !== n || !html) { $(id).hidden = true; $(id).innerHTML = ""; }
    if (!html) return;
    n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`;
  }
  const setStatus = (t) => { $("inv-status").textContent = t; };

  // ---------- loading ----------
  async function loadList(refresh) {
    const r = await JT.rows(["i.id::text", "i.vendor", "i.invoice_no", "i.invoice_date::text", "i.file_name", "i.subtotal", "i.status",
      "i.created_at", "i.applied_at", "(select count(*) from jt.invoice_lines l where l.invoice_id = i.id)",
      "(select count(*) from jt.invoice_lines l where l.invoice_id = i.id and l.variant_id is not null)",
      "(select sum(coalesce(l.amount, l.qty * l.unit_cost)) from jt.invoice_lines l where l.invoice_id = i.id)",
      "i.stage", "i.stage_at", "i.po_no", "left(i.notes, 140)"],
      "from jt.invoices i order by i.stage_at desc, i.id desc limit 2000", refresh);
    const done = () => setStatus(`${I.list.length} invoice${I.list.length === 1 ? "" : "s"}${I.cat ? ` · ${I.cat.length.toLocaleString()} Shopify variants loaded for matching` : ""}`);
    setTimeout(done, 0);
    I.list = r.map(x => ({ id: x[0], vendor: x[1], invoice_no: x[2], date: x[3], file: x[4], subtotal: x[5], status: x[6], created: x[7], applied: x[8], lines: +x[9], matched: +x[10], total: x[11], stage: stageOf(x[12]), stage_at: x[13], po_no: x[14] || "", notes: x[15] || "" }));
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
    I.loading = true; I.err = null; setStatus("Loading invoices and the product catalog…"); renderBoard();
    try {
      await Promise.all([loadList(force), loadCatalog(force)]);
      I.ready = true;
      setStatus(`${I.list.length} invoice${I.list.length === 1 ? "" : "s"} · ${I.cat.length.toLocaleString()} Shopify variants loaded for matching`);
    } catch (e) { I.err = e; setStatus(""); note("bad", esc(JT.message(e))); }
    finally { I.loading = false; renderBoard(); renderEditor(); }
  }

  // ---------- reading the PDF (js/invparse.js) ----------
  const { pdfRows, parseDate, findQtyPrice, cellBelow } = window.JTInvParse;
  const parseInvoice = (rows) => window.JTInvParse.parseInvoice(rows, { vendors: I.vendors,
    known: (t, vendor) => !!(I.idx && (I.idx.bySku.has(norm(t)) || (vendor && I.remembered.has(vendor.toLowerCase() + "|" + norm(t))))) });

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
    note(null); I.ed = null; I.busy = "Reading " + file.name + "…"; renderEditor();
    try {
      const rows = await pdfRows(await file.arrayBuffer());
      const inv = parseInvoice(rows);
      I.ed = { id: null, status: "draft", vendor: inv.vendor, invoice_no: inv.invoice_no, invoice_date: inv.invoice_date, file_name: file.name,
               subtotal: inv.subtotal, notes: "", po_no: "", stage: "new", dirty: true, lines: inv.lines.map(l => Object.assign(blankLine(), l)), raw: rows, filter: "all" };
      prepareLines(I.ed);
      if (!rows.length) note("warn", "This PDF has no text in it (it's probably a scan or photo), so no lines could be read. Add the lines by hand with <b>Add line</b>, or ask the vendor for a digital invoice.");
      else if (!inv.lines.length) note("warn", "No item lines were recognised in this PDF. Add them with <b>Add line</b>, and use <b>Show PDF text</b> to see what was read. Send Claude a sample of this vendor's invoice to teach the reader its layout.");
      const dup = I.list && I.list.find(x => x.invoice_no && inv.invoice_no && x.invoice_no.toLowerCase() === inv.invoice_no.toLowerCase() && x.vendor.toLowerCase() === (inv.vendor || "").toLowerCase());
      if (dup) note("warn", `Invoice <b>${esc(inv.invoice_no)}</b> from ${esc(inv.vendor)} was already uploaded${dup.status === "applied" ? " and applied" : ""}. <button class="mini" data-open="${esc(dup.id)}">Open it</button>`);
    } catch (e) {
      console.error("[JT] invoice read failed", e);
      note("bad", "Couldn't read that PDF" + (e && e.message ? ": " + esc(e.message) : "") + ".");
    } finally { I.busy = ""; renderEditor(); }
  }
  async function openInvoice(id) {
    note(null); I.ed = null; I.busy = "Opening invoice…"; renderEditor();
    try {
      if (!I.cat) await loadCatalog(false);
      const [h, ls] = await Promise.all([
        JT.rows(["id::text", "vendor", "invoice_no", "invoice_date::text", "file_name", "subtotal", "status", "notes", "stage", "po_no"], `from jt.invoices where id = ${JT.int(id)}`, true),
        JT.rows(["line_no", "item_code", "upc", "description", "qty", "unit_cost", "amount", "variant_id::text", "match_how", "update_cost", "new_price"], `from jt.invoice_lines where invoice_id = ${JT.int(id)} order by line_no`, true),
      ]);
      if (!h[0]) throw { code: "tool_error", message: "That invoice no longer exists." };
      const [iid, vendor, no, date, file, sub, status, notes, stage, po] = h[0];
      I.ed = { id: iid, vendor, invoice_no: no, invoice_date: date || "", file_name: file, subtotal: sub == null ? null : +sub, status, notes, stage: stageOf(stage), po_no: po || "", raw: null, filter: "all",
               lines: ls.map(x => ({ item_code: x[1], upc: x[2], description: x[3], qty: x[4] == null ? null : +x[4], unit_cost: x[5] == null ? null : +x[5], amount: x[6] == null ? null : +x[6],
                                     variant_id: x[7], match_how: x[8], update_cost: !!x[9], new_price: x[10] == null ? null : +x[10], update_price: x[10] != null, _reviewed: true })) };
      I.updates = new Map();
      if (status === "applied") await loadUpdates(iid);
      else prepareLines(I.ed);
    } catch (e) { note("bad", esc(JT.message(e))); }
    finally { I.busy = ""; renderEditor(); }
  }
  function bodyOf(ed) {
    return { id: ed.id, vendor: ed.vendor || "", invoice_no: ed.invoice_no || "", invoice_date: ed.invoice_date || "", file_name: ed.file_name || "",
             subtotal: ed.subtotal, notes: ed.notes || "", po_no: ed.po_no || "", stage: ed.stage || "new",
             lines: ed.lines.map(l => ({ item_code: l.item_code || "", upc: l.upc || "", description: l.description || "", qty: l.qty, unit_cost: l.unit_cost, amount: l.amount,
                                         variant_id: l.variant_id || null, match_how: l.match_how || "", update_cost: !!l.update_cost,
                                         new_price: null })) };   // prices aren't changed from invoices (for now)
  }
  async function save(andApply) {
    const ed = I.ed; if (!ed || ed.status === "applied") return;
    if (!ed.vendor) { note("warn", "Pick the vendor first — matches are remembered per vendor."); return; }
    I.busy = andApply ? "Applying…" : "Saving…"; renderEditor();
    try {
      ed.id = String(await JT.invoices.save(bodyOf(ed))); ed.dirty = false;
      if (andApply) {
        const n = await JT.invoices.apply(ed.id);
        note("info", `Applied. ${n} product cost${n === 1 ? "" : "s"} queued for Shopify. The sync writes them within about a minute; this invoice shows each one's result.`);
        ed.status = "applied";
        await Promise.all([loadList(true), loadUpdates(ed.id), loadCatalog(true)]);
      } else {
        note("info", "Saved.");
        await loadList(true);
      }
    } catch (e) {
      const msg = (e && e.message) || "";
      if (/invoices_vendor_no_idx|duplicate key/i.test(msg)) note("bad", `Invoice ${esc(ed.invoice_no)} from ${esc(ed.vendor)} is already saved. Open its card on the board instead.`);
      else note("bad", esc(JT.message(e)));
    } finally { I.busy = ""; renderEditor(); renderBoard(); }
  }

  function newCard(stage) {
    note(null);
    I.ed = { id: null, status: "draft", vendor: "", invoice_no: "", invoice_date: window.JTDate.today(), file_name: "", subtotal: null, notes: "", po_no: "",
             stage: stageOf(stage), dirty: false, lines: [], raw: null, filter: "all" };
    renderEditor();
    const v = $("inv-vendor"); if (v) v.focus();
  }
  // Stage / PO / notes of an applied invoice (its lines are locked).
  async function saveCard() {
    const ed = I.ed; if (!ed || !ed.id) return;
    I.busy = "Saving…"; renderEditor();
    try { await JT.invoices.updateCard({ id: Number(ed.id), stage: ed.stage, notes: ed.notes || "", po_no: ed.po_no || "" }); ed.dirty = false; note("info", "Saved."); await loadList(true); }
    catch (e) { note("bad", esc(JT.message(e))); }
    finally { I.busy = ""; renderEditor(); renderBoard(); }
  }

  // ---------- rendering ----------
  const daysSince = (t) => { const d = window.JTDate.parseTime(t); return isNaN(d) ? null : Math.floor((Date.now() - d) / 864e5); };
  function cardHtml(x) {
    const days = daysSince(x.stage_at);
    const ref = [x.invoice_no ? "#" + x.invoice_no : "", x.po_no ? "PO " + x.po_no : ""].filter(Boolean).join(" · ") || (x.file || "no invoice # yet");
    const unmatched = x.lines - x.matched;
    return `<div class="icard" draggable="true" data-card="${esc(x.id)}" title="${esc(x.notes)}">
      <div class="ic-top"><b>${esc(x.vendor || "No vendor")}</b><span>${x.total == null ? "" : m(+x.total)}</span></div>
      <div class="mono dim">${esc(ref)}</div>
      <div class="dim">${esc(x.date || "no date")} · ${x.lines} line${x.lines === 1 ? "" : "s"}${days != null ? ` · ${days === 0 ? "today" : days + "d here"}` : ""}</div>
      <div class="pills">${x.status === "applied" ? '<span class="pill ok">Costs in Shopify</span>' : x.lines ? '<span class="pill warn">Costs not applied</span>' : ""}${unmatched > 0 ? `<span class="pill miss">${unmatched} not matched</span>` : ""}</div>
    </div>`;
  }
  function renderBoard() {
    const b = $("inv-board"); if (!b) return;
    if (I.drag) { I.renderLater = true; return; }          // don't replace the cards while one is being dragged
    if (!I.list) { b.innerHTML = `<div class="muted">${I.loading ? "Loading…" : ""}</div>`; return; }
    const qs = I.q.trim().toLowerCase();
    const hit = (x) => !qs || [x.vendor, x.invoice_no, x.po_no, x.file, x.notes].join(" ").toLowerCase().includes(qs);
    b.innerHTML = STAGES.map(([k, name]) => {
      let cards = I.list.filter(x => x.stage === k && hit(x));
      const total = cards.length;
      const cut = k === "processed" && !I.showAllDone && !qs && cards.length > DONE_SHOWN;
      if (cut) cards = cards.slice(0, DONE_SHOWN);
      return `<div class="lane" data-stage="${k}">
        <div class="lane-h"><b>${esc(name)}</b><span class="meta"><span class="cnt">${total}</span><button class="mini" data-new="${k}" title="Add a card to this stage">+ Add</button></span></div>
        <div class="lane-cards">${cards.map(cardHtml).join("") || '<span class="empty">Drop cards here</span>'}${cut ? `<button class="mini" id="inv-alldone">Show all ${total}</button>` : ""}</div>
      </div>`;
    }).join("");
  }
  async function moveCard(id, stage) {
    const x = I.list && I.list.find(c => c.id === id); if (!x || x.stage === stage) return;
    const was = [x.stage, x.stage_at];
    x.stage = stage; x.stage_at = new Date().toISOString(); renderBoard();
    try { await JT.invoices.updateCard({ id: Number(id), stage }); }
    catch (e) { [x.stage, x.stage_at] = was; renderBoard(); note("bad", "Couldn't move the card: " + esc(JT.message(e))); }
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

  function showModal(on) {
    $("inv-modal").hidden = !on; document.body.classList.toggle("modal-open", on);
  }
  function closeModal(force) {
    const ed = I.ed;
    if (ed && ed.dirty && !force) { ed.confirmClose = true; renderEditor(); return; }
    I.ed = null; I.searchLine = null; I.busy = ""; note(null); showModal(false); $("inv-edit").innerHTML = "";
  }
  function renderEditor() {
    const box = $("inv-edit"); if (!box) return;
    if (I.busy && !I.ed) { showModal(true); box.innerHTML = `<div class="panel-head"><h2>Invoice</h2><button class="mini" id="inv-close">Close</button></div><div class="muted">${esc(I.busy)}</div>`; return; }
    const ed = I.ed; if (!ed) { showModal(false); box.innerHTML = ""; return; }
    showModal(true);
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
      <div class="panel-head"><h2>${esc(ed.vendor || (ed.id ? "Invoice" : "New invoice"))} ${ed.invoice_no ? "· " + esc(ed.invoice_no) : ""} ${ro ? '<span class="pill ok">Costs in Shopify</span>' : ""}</h2>
        <div class="right" style="display:flex;gap:8px;align-items:center">
          <label class="small muted">Stage <select id="inv-stage" class="inp sm">${STAGES.map(([k, n]) => `<option value="${k}" ${k === ed.stage ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
          ${ro && ed.dirty ? '<button class="mini primary" id="inv-savecard">Save</button>' : ""}
          <button class="mini" id="inv-close" title="Close (Esc)">Close</button></div></div>
      ${ed.confirmClose ? `<div class="note warn">You have unsaved changes. <span class="dbtns"><button class="mini primary" id="inv-save-close">Save and close</button><button class="mini" id="inv-discard">Discard</button><button class="mini" id="inv-keep">Keep editing</button></span></div>` : ""}
      ${I.busy ? `<div class="note info">${esc(I.busy)}</div>` : ""}
      <div class="invhead">
        <label>Vendor ${ro ? `<b>${esc(ed.vendor)}</b>` : `<select id="inv-vendor" class="inp"><option value="">— pick the vendor —</option>${vendorOpts}${ed.vendor && !I.vendors.includes(ed.vendor) ? `<option selected>${esc(ed.vendor)}</option>` : ""}</select>`}</label>
        <label>Invoice # ${ro ? `<b class="mono">${esc(ed.invoice_no)}</b>` : `<input id="inv-no" class="inp mono" value="${esc(ed.invoice_no)}">`}</label>
        <label>Invoice date ${ro ? `<b>${esc(ed.invoice_date)}</b>` : `<input id="inv-date" class="inp" type="date" value="${esc(ed.invoice_date)}">`}</label>
        <label>Subtotal on invoice ${ro ? `<b>${m(ed.subtotal)}</b>` : `<input id="inv-sub" class="inp num" value="${ed.subtotal != null ? ed.subtotal.toFixed(2) : ""}">`}
          <span class="small ${ed.subtotal != null && Math.abs(ed.subtotal - sum) > 0.05 ? "up" : "dim"}">Lines add up to ${m(sum)}${ed.subtotal != null && Math.abs(ed.subtotal - sum) > 0.05 ? " — some lines may be missing" : ""}</span></label>
        <label>PO # <input id="inv-po" class="inp mono" value="${esc(ed.po_no || "")}"></label>
        <label style="grid-column:span 2">Notes <textarea id="inv-notes" class="inp" rows="1">${esc(ed.notes || "")}</textarea></label>
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
            <button class="btn" id="inv-save">Save</button>
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
    const file = $("inv-file"), board = $("inv-board"), tab = $("tab-invoices");
    file.addEventListener("change", () => { onFile(file.files[0]); file.value = ""; });
    $("inv-refresh").addEventListener("click", () => refresh(true));
    $("inv-q").addEventListener("input", (e) => { I.q = e.target.value; renderBoard(); });
    $("inv-new").addEventListener("click", () => newCard("new"));
    // a PDF dropped anywhere on the tab is uploaded
    const isFile = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
    tab.addEventListener("dragover", (e) => { if (isFile(e) && !I.ed) { e.preventDefault(); board.classList.add("filedrop"); } });
    tab.addEventListener("dragleave", (e) => { if (!tab.contains(e.relatedTarget)) board.classList.remove("filedrop"); });
    tab.addEventListener("drop", (e) => { if (isFile(e)) { e.preventDefault(); board.classList.remove("filedrop"); if (!I.ed) onFile(e.dataTransfer.files[0]); } });
    // cards: open on click, drag between lanes
    tab.addEventListener("click", (e) => {
      const o = e.target.closest("[data-open]"); if (o) { openInvoice(o.dataset.open); return; }
      const c = e.target.closest(".icard"); if (c) { openInvoice(c.dataset.card); return; }
      const n = e.target.closest("[data-new]"); if (n) { newCard(n.dataset.new); return; }
      if (e.target.id === "inv-alldone") { I.showAllDone = true; renderBoard(); }
    });
    board.addEventListener("dragstart", (e) => {
      const c = e.target.closest && e.target.closest(".icard"); if (!c) return;
      I.drag = c.dataset.card; c.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "jt-card:" + c.dataset.card);
    });
    board.addEventListener("dragend", () => { I.drag = null; board.querySelectorAll(".dragging,.lane.over").forEach(x => x.classList.remove("dragging", "over")); if (I.renderLater) { I.renderLater = false; renderBoard(); } });
    board.addEventListener("dragover", (e) => {
      if (!I.drag) return; const lane = e.target.closest(".lane"); if (!lane) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      board.querySelectorAll(".lane.over").forEach(x => x !== lane && x.classList.remove("over")); lane.classList.add("over");
    });
    board.addEventListener("drop", (e) => {
      if (!I.drag) return; const lane = e.target.closest(".lane"); if (!lane) return;
      e.preventDefault(); e.stopPropagation(); const id = I.drag; I.drag = null; lane.classList.remove("over");
      moveCard(id, lane.dataset.stage);
    });
    // popup: Esc or a click outside closes it
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && I.ed && !$("inv-modal").hidden && e.target.id !== "inv-sq") closeModal(false); });
    $("inv-modal").addEventListener("mousedown", (e) => { if (e.target.id === "inv-modal") closeModal(false); });
    const box = $("inv-edit");
    box.addEventListener("input", (e) => {
      const t = e.target, ed = I.ed; if (!ed) return;
      if (t.id === "inv-sq") { I.searchQ = t.value; renderEditor(); return; }
      if (!ed.dirty) { ed.dirty = true; if (ed.status === "applied") renderEditor(); }
      if (t.id === "inv-po") { ed.po_no = t.value; return; }
      if (t.id === "inv-notes") { ed.notes = t.value; return; }
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
      if (t.id !== "inv-sq") ed.dirty = true;
      if (t.id === "inv-stage") { ed.stage = t.value; renderEditor(); return; }
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
      if (t.id === "inv-close" && !I.ed) { closeModal(true); return; }
      const ed = I.ed; if (!ed) return;
      if (t.id === "inv-close") { closeModal(false); return; }
      if (t.id === "inv-discard") { closeModal(true); return; }
      if (t.id === "inv-keep") { ed.confirmClose = false; renderEditor(); return; }
      if (t.id === "inv-save-close") { ed.confirmClose = false; if (ed.status === "applied") await saveCard(); else await save(false); if (I.ed && !I.ed.dirty) closeModal(true); return; }
      if (t.id === "inv-savecard") { saveCard(); return; }
      if (t.dataset.filter) { ed.filter = t.dataset.filter; renderEditor(); return; }
      if (t.dataset.search != null) { I.searchLine = +t.dataset.search; const l = ed.lines[I.searchLine]; I.searchQ = l.item_code || l.description.split(/\s+/).slice(0, 4).join(" "); renderEditor(); const s = $("inv-sq"); if (s) { s.focus(); s.select(); } return; }
      if (t.dataset.cancel != null) { I.searchLine = null; renderEditor(); return; }
      if (t.dataset.unmatch != null) { const l = ed.lines[+t.dataset.unmatch]; l.variant_id = null; l.match_how = "manual"; l.update_price = false; l.new_price = null; I.searchLine = null; renderEditor(); return; }
      if (t.dataset.pick) {
        const l = ed.lines[+t.dataset.i], v = I.idx.byVid.get(t.dataset.pick);
        l.variant_id = v.vid; l.match_how = "manual"; l._reviewed = true; l.update_cost = true;
        I.searchLine = null; renderEditor(); return;
      }
      if (t.dataset.pick || t.dataset.unmatch != null || t.id === "inv-add") ed.dirty = true;
      if (t.dataset.del != null) { ed.dirty = true; ed.lines.splice(+t.dataset.del, 1); I.searchLine = null; renderEditor(); return; }
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
        try { await JT.invoices.remove(ed.id); closeModal(true); note("info", "Draft deleted."); await loadList(true); } catch (err) { note("bad", esc(JT.message(err))); }
        I.busy = ""; renderEditor(); renderBoard(); return;
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
  window.addEventListener("jt:catalog", () => { I.cat = null; if (!$("tab-invoices").hidden) refresh(true); else I.shown = false; });
  window.invShow = () => { if (!I.shown) { I.shown = true; refresh(false); } else { renderBoard(); renderEditor(); } };
  window.JTInvoices = { parseInvoice, findQtyPrice, roundPrice, parseDate, pdfRows, _state: I, open: (id) => { if (window.invShow) window.invShow(); openInvoice(id); } };   // for tests
  if ((location.hash || "") === "#invoices") setTimeout(() => window.invShow(), 0);
})();
