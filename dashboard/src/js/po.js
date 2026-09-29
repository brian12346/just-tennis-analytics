(() => {
  // ===================== Purchase orders =====================
  // Vendor orders (jt.prep_orders — the same orders Incoming Inventory shows on the Prep center tab), full page.
  // A PO is built by hand, from On The List, or from the vendor's invoice PDF: the PDF is read in the browser
  // (window.JTInvParse), every line gets a best guess at the Shopify product, and you confirm or change the guesses.
  // Saved through jt.po_save: the order's lines are the matched products; the invoice keeps every line as read
  // (unmatched ones too) and the PDF itself (jt.invoice_files). Confirmed matches are remembered per vendor item code.
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m = (n) => n == null || isNaN(n) ? "—" : usd.format(n), m0 = (n) => n == null || isNaN(n) ? "—" : usd0.format(n);
  const n0 = (x) => Math.round(x || 0).toLocaleString();
  const pct = (x) => x == null || !isFinite(x) ? "—" : (x > 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
  const JT = window.JT, IP = window.JTInvParse;
  const norm = IP.norm;
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const TZ = "America/Los_Angeles";
  const today = () => window.JTDate.today();
  const when = (t) => { const d = window.JTDate.parseTime(t); return !t || isNaN(d) ? "" : d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" }); };
  const shortDate = (ds) => ds ? new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
  const OI = () => window.JTOrderIssues;

  const STAGES = [["draft", "Draft"], ["ordered", "Ordered"], ["invoice", "Invoice"], ["packing_slip", "Packing slip"], ["received", "Received"], ["shipped", "Shipped"]];
  const STAGE = new Map(STAGES), ORDER = STAGES.map(x => x[0]), PRE = ["draft", "ordered", "invoice", "packing_slip"];
  const NEXT = { draft: ["ordered", "Mark ordered"], ordered: ["invoice", "Invoice in"], invoice: ["packing_slip", "Packing slip in"] };
  const PREV = { ordered: "draft", invoice: "ordered", packing_slip: "invoice", received: "packing_slip", shipped: "received" };
  const PILL = { draft: "pos", ordered: "manual", invoice: "other", packing_slip: "other", received: "ok", shipped: "web" };
  const poLabel = (po) => /^po\b/i.test(po) ? po : "PO " + po;
  const SURE = new Set(["remembered", "sku", "upc", "manual", "confirmed"]);
  const HOW = { remembered: "Remembered", sku: "SKU match", upc: "UPC match", manual: "Picked", confirmed: "Confirmed", skupart: "Part of SKU", guess: "Guess" };
  const CONF = { high: "Likely", medium: "Maybe", low: "Unsure" };
  const PART = 66000;          // PDF bytes per stored part (base64 ~88k characters: one small database reply)

  const S = {
    shown: false, loading: false, orders: null, stage: "open", vendor: "all", q: "",
    cat: null, catP: null, ix: null, byVid: null, bySku: null, byBar: null, remembered: new Map(), vendors: [], listings: new Map(), byAmz: new Map(),
    ed: null, busy: "", files: new Map(),   // invoice id -> Uint8Array (PDFs already downloaded)
  };
  let rid = 0; const newId = () => "r" + (++rid);
  const fmtCost = (v) => { if (v == null || isNaN(v)) return ""; const t = String(+Number(v).toFixed(4)); return /\.\d$/.test(t) ? t + "0" : /\./.test(t) ? t : t + ".00"; };
  const NONPRODUCT = /\b(freight|shipping|handling|fuel|surcharge|fee|discount|deposit|credit|tax)\b/i;

  const note = (kind, html) => { const n = $("po-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; };
  const setStatus = (t) => { $("po-status").textContent = t; };

  // ---------- loading ----------
  async function loadOrders(refresh) {
    const r = await JT.rowsSplit(["o.id::text", "o.vendor", "o.po_no", "o.status", "o.kind", "o.place_by::text", "o.expected_on::text", "o.note", "o.stage_at", "o.created_at", "o.updated_at",
      "o.invoice_id::text", "i.invoice_no", "i.invoice_date::text", "i.subtotal", "i.file_parts",
      "(select count(*) from jt.prep_order_lines l where l.order_id = o.id)",
      "(select coalesce(sum(l.qty_ordered), 0) from jt.prep_order_lines l where l.order_id = o.id)",
      "(select coalesce(sum(l.qty_received), 0) from jt.prep_order_lines l where l.order_id = o.id)",
      "(select sum(l.qty_ordered * coalesce(l.unit_cost, v.unit_cost)) from jt.prep_order_lines l left join jt.variants v on v.variant_id = l.variant_id where l.order_id = o.id)",
      "(select count(*) from jt.invoice_lines il where il.invoice_id = o.invoice_id and il.variant_id is null and il.match_how <> 'skip')",
      "(select count(*) from jt.invoice_lines il where il.invoice_id = o.invoice_id and il.match_how like 'guess%')",
      "(select string_agg(distinct coalesce(nullif(v.display_name, ''), v.product_title, '') || ' ' || coalesce(v.sku, ''), ' | ') from jt.prep_order_lines l join jt.variants v on v.variant_id = l.variant_id where l.order_id = o.id)",
      "(select count(*) from jt.prep_order_lines l where l.order_id = o.id and l.dest = 'prep')"],
      "from jt.prep_orders o left join jt.invoices i on i.id = o.invoice_id", "o.id", 2, refresh);
    S.orders = r.map(x => ({ id: x[0], vendor: x[1] || "", po: x[2] || "", status: x[3], kind: x[4] || "order", placeBy: x[5] || "", expected: x[6] || "", note: x[7] || "",
      stageAt: x[8] || {}, created: x[9], updated: x[10], invoiceId: x[11] || null, invNo: x[12] || "", invDate: x[13] || "", subtotal: x[14] == null ? null : +x[14], hasFile: +x[15] > 0,
      nLines: +x[16], units: +x[17], received: +x[18], cost: x[19] == null ? 0 : +x[19], unmatched: +x[20], guesses: +x[21], text: (x[22] || "").toLowerCase(), prepLines: +x[23] }))
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  }
  // Shopify catalog, remembered vendor codes and Amazon listings: for matching invoice lines and adding products.
  function catalog(refresh) {
    if (S.cat && !refresh) return Promise.resolve(S.cat);
    if (S.catP && !refresh) return S.catP;
    S.catP = (async () => {
      const [cat, rem, maps] = await Promise.all([
        JT.rowsSplit(["variant_id::text", "product_id::text", "sku", "coalesce(nullif(display_name, ''), product_title)", "vendor", "status", "product_type", "price", "unit_cost",
          "coalesce(barcode, '')", "product_title", "variant_title", "inventory_qty"], "from jt.variants where removed_at is null", "variant_id", 4, refresh),
        JT.rows(["vendor", "item_code", "variant_id::text"], "from jt.vendor_items", refresh),
        JT.rowsSplit(["data->>'sku'", "(regexp_match(data->>'variantId', '(\\d+)$'))[1]", "coalesce(data->>'units', '1')", "coalesce(data->>'asin', '')", "coalesce(data->>'title', '')"],
          "from jt.docs where collection = 'amzmap' and data->>'kind' = 'shopify'", "id", 2, refresh),
      ]);
      S.cat = cat.map(x => ({ vid: x[0], pid: x[1], sku: x[2] || "", title: x[3] || "", vendor: x[4] || "", status: x[5] || "", type: x[6] || "", price: x[7] == null ? null : +x[7],
        cost: x[8] == null ? null : +x[8], barcode: x[9] || "", product: x[10] || "", variant: x[11] || "", qty: x[12] == null ? null : +x[12] }));
      S.byVid = new Map(S.cat.map(v => [v.vid, v]));
      S.bySku = new Map(); S.byBar = new Map();
      const add = (mp, k, v) => { if (!k) return; const l = mp.get(k) || []; l.push(v); mp.set(k, l); };
      for (const v of S.cat) { add(S.bySku, norm(v.sku), v); add(S.byBar, norm(v.barcode).replace(/^0+/, ""), v); v.text = [v.sku, v.title, v.vendor, v.barcode].join(" ").toLowerCase(); }
      S.vendors = [...new Set(S.cat.map(v => v.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      S.remembered = new Map(rem.map(([v, c, id]) => [v.toLowerCase() + "|" + c, id]));
      S.listings = new Map(); S.byAmz = new Map();
      for (const [sku, vid, units, asin, title] of maps) {
        if (!vid) continue;
        const l = S.listings.get(vid) || []; l.push({ sku, units: +units || 1, asin, title }); S.listings.set(vid, l);
        S.byAmz.set(sku.toLowerCase(), { vid, asku: sku }); if (asin) S.byAmz.set(asin.toLowerCase(), { vid, asku: "" });
      }
      S.ix = window.JTMatch ? window.JTMatch.buildIndex(S.cat.map(v => ({ ...v }))) : null;
      return S.cat;
    })();
    S.catP.catch(() => { S.catP = null; });
    return S.catP;
  }
  async function refresh(force) {
    S.loading = true; setStatus("Loading purchase orders…"); renderList();
    try { await loadOrders(force); setStatus(`${S.orders.length.toLocaleString()} purchase order${S.orders.length === 1 ? "" : "s"}`); }
    catch (e) { setStatus(""); note("bad", esc(JT.message(e))); }
    finally { S.loading = false; renderList(); }
  }

  // ---------- matching one invoice line to a Shopify product ----------
  // Sure: a code remembered for this vendor, the vendor's SKU, the UPC. Otherwise the best guesses from the product
  // words (window.JTMatch, the same scorer as Amazon matching), for you to confirm or change.
  function guessLine(src, vendor) {
    const code = norm(src.item_code), upc = norm(src.upc).replace(/^0+/, "");
    const inV = (l) => l && vendor ? l.filter(v => v.vendor.toLowerCase() === vendor.toLowerCase()) : l;
    const one = (l) => l && l.length === 1 ? l[0] : null;
    const out = (v, how, conf, alts) => ({ vid: v ? v.vid : null, how: v ? how : "", conf: v ? conf : "", alts: (alts || []).filter(x => !v || x !== v.vid).slice(0, 6) });
    const fuzzy = () => {
      if (!S.ix) return { top: [], conf: "low" };
      const probe = { title: [src.description, src.item_code].filter(Boolean).join(" "), sku: src.item_code || "" };
      let g = window.JTMatch.guess(S.ix, probe, { limit: 8, vendor: vendor && S.vendors.includes(vendor) ? vendor : undefined });
      if (!g.top.some(c => c.score > 0.15) && vendor) { g = window.JTMatch.guess(S.ix, probe, { limit: 8 }); if (g.conf === "high") g.conf = "medium"; }   // not that vendor's product?
      return { top: g.top.filter(c => c.score > 0.15).map(c => c.v.vid), conf: g.conf };
    };
    const rem = code && vendor ? S.remembered.get(vendor.toLowerCase() + "|" + code) : null;
    if (rem && S.byVid.get(rem)) return out(S.byVid.get(rem), "remembered", "sure", fuzzy().top);
    if (code) { const l = S.bySku.get(code), v = one(inV(l)) || one(l); if (v) return out(v, "sku", "sure", []); }
    if (upc) { const v = one(S.byBar.get(upc)) || one(S.bySku.get(upc)); if (v) return out(v, "upc", "sure", []); }
    const f = fuzzy();
    if (code.length >= 5) {
      const hits = S.cat.filter(v => (!vendor || v.vendor.toLowerCase() === vendor.toLowerCase()) && v.sku && (norm(v.sku).includes(code) || (norm(v.sku).length >= 5 && code.includes(norm(v.sku)))));
      if (hits.length === 1) return out(hits[0], "skupart", "medium", f.top);
    }
    if (f.top.length) return out(S.byVid.get(f.top[0]), "guess", f.conf, f.top);
    return out(null);
  }
  const isSure = (r) => !!r.vid && (SURE.has(r.how) || r.confirmed);
  const needsCheck = (r) => !!r.vid && !isSure(r);
  const howSaved = (r) => r.skip ? "skip" : !r.vid ? "" : isSure(r) ? (r.confirmed && !SURE.has(r.how) ? "confirmed" : r.how) : r.how === "guess" ? "guess-" + (r.conf || "low") : r.how;
  function howFromSaved(h) {
    if (!h) return { how: "", conf: "" };
    const g = /^guess-(high|medium|low)$/.exec(h); if (g) return { how: "guess", conf: g[1] };
    if (h === "skupart") return { how: "skupart", conf: "medium" };
    if (h === "title") return { how: "guess", conf: "medium" };        // matched by title on the Invoices tab
    return { how: SURE.has(h) ? h : "manual", conf: "sure" };
  }

  // ---------- the editor's model ----------
  // row: {id, src: {item_code, upc, description, qty, unit_cost, amount} | null, vid, how, conf, alts, confirmed, dest, asku, qty, cost, received}
  const keyOf = (r) => r.vid + "|" + (r.asku || "") + "|" + (r.dest || "prep");
  const variant = (vid) => vid && S.byVid ? S.byVid.get(String(vid)) : null;
  function blankEd() {
    return { id: null, status: "draft", vendor: "", po: "", kind: "order", placeBy: "", expected: "", note: "", shortOk: false, stageAt: {}, created: null,
      inv: null, file: null, rows: [], dest: "shopify", filter: "all", dirty: false, confirm: false, recv: null, search: null, add: "", showPdf: false, shipments: [], received: new Map() };
  }
  async function openPO(id, keep) {
    if (!id) { S.ed = Object.assign(blankEd(), keep || {}); render(); catalog().then(render).catch(() => {}); return; }
    S.ed = null; S.busy = "Opening the purchase order…"; render();
    try {
      await catalog();
      const [h, ol, sh] = await Promise.all([
        JT.rows(["o.id::text", "o.vendor", "o.po_no", "o.status", "o.kind", "o.place_by::text", "o.expected_on::text", "o.note", "o.short_ok", "o.stage_at", "o.created_at", "o.created_by",
          "o.invoice_id::text", "i.invoice_no", "i.invoice_date::text", "i.subtotal", "i.file_name", "i.file_parts", "i.status", "i.notes", "i.file_type"],
          `from jt.prep_orders o left join jt.invoices i on i.id = o.invoice_id where o.id = ${JT.int(id)}`, true),
        JT.rows(["variant_id::text", "amazon_sku", "dest", "qty_ordered", "qty_received", "unit_cost"], `from jt.prep_order_lines where order_id = ${JT.int(id)}`, true),
        JT.rows(["id::text", "name", "status"], `from jt.prep_shipments where order_id = ${JT.int(id)}`, true),
      ]);
      if (!h[0]) throw { code: "tool_error", message: "That purchase order no longer exists." };
      const x = h[0], ed = blankEd();
      Object.assign(ed, { id: x[0], vendor: x[1] || "", po: x[2] || "", status: x[3], kind: x[4] || "order", placeBy: x[5] || "", expected: x[6] || "", note: x[7] || "", shortOk: !!x[8],
        stageAt: x[9] || {}, created: x[10], createdBy: x[11] || "", shipments: sh.map(s => ({ id: s[0], name: s[1], status: s[2] })) });
      if (x[12]) {
        ed.inv = { id: x[12], no: x[13] || "", date: x[14] || "", subtotal: x[15] == null ? null : +x[15], fileName: x[16] || "", parts: +x[17] || 0, status: x[18] || "draft", notes: x[19] || "", type: x[20] || "" };
        const il = await JT.rows(["line_no", "item_code", "upc", "description", "qty", "unit_cost", "amount", "variant_id::text", "match_how", "dest", "amazon_sku"],
          `from jt.invoice_lines where invoice_id = ${JT.int(x[12])} order by line_no`, true);
        for (const l of il) {
          const hw = howFromSaved(l[7] ? l[8] : "");
          ed.rows.push({ id: newId(), src: { item_code: l[1] || "", upc: l[2] || "", description: l[3] || "", qty: l[4] == null ? null : +l[4], unit_cost: l[5] == null ? null : +l[5], amount: l[6] == null ? null : +l[6] },
            vid: l[7] || null, how: hw.how, conf: hw.conf, alts: [], confirmed: false, dest: l[9] || "prep", asku: l[10] || "",
            qty: l[4] == null ? "" : String(+l[4]), cost: fmtCost(l[5]), skip: l[8] === "skip" });
        }
      }
      // order lines not on the invoice (added by hand or from On The List); the order's numbers win for the rest
      for (const [vid, asku, dest, qo, qr, uc] of ol) {
        const k = vid + "|" + (asku || "") + "|" + (dest || "prep");
        ed.received.set(k, (ed.received.get(k) || 0) + (+qr || 0));
        const onInv = ed.rows.filter(r => r.vid && keyOf(r) === k);
        if (onInv.length === 1) { onInv[0].qty = String(+qo); if (uc != null) onInv[0].cost = fmtCost(uc); continue; }
        if (onInv.length) continue;
        ed.rows.push({ id: newId(), src: null, vid, how: "manual", conf: "sure", alts: [], confirmed: true, dest: dest || "prep", asku: asku || "", qty: String(+qo), cost: fmtCost(uc) });
      }
      const dests = new Set(ed.rows.map(r => r.dest)); ed.dest = dests.size === 1 ? [...dests][0] : ed.rows.length ? "mixed" : "shopify";
      // fill in the alternatives for guesses (not saved)
      for (const r of ed.rows) if (r.src && needsCheck(r)) r.alts = guessLine(r.src, ed.vendor).alts;
      S.ed = ed; S.busy = "";
      if (ed.inv && ed.inv.parts) loadFile(ed.inv).then(() => { if (S.ed === ed && ed.showPdf) renderPdf(); }).catch(() => {});
      ed.showPdf = !!(ed.inv && ed.inv.parts) && window.innerWidth >= 1100;
    } catch (e) { S.busy = ""; S.ed = null; note("bad", esc(JT.message(e))); }
    render();
  }

  // ---------- the PDF ----------
  function toB64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); }
  function fromB64(b) { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  async function loadFile(inv) {
    if (S.files.has(inv.id)) return S.files.get(inv.id);
    const parts = [];
    for (let k = 0; k < inv.parts; k++) {
      const r = await JT.rows(["data"], `from jt.invoice_files where invoice_id = ${JT.int(inv.id)} and part = ${k}`, true);
      if (!r[0]) throw { code: "tool_error", message: "Part of the PDF is missing." };
      parts.push(fromB64(r[0][0]));
    }
    const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    S.files.set(inv.id, all);
    return all;
  }
  async function uploadFile(invId, f) {
    const n = Math.max(1, Math.ceil(f.bytes.length / PART));
    for (let k = 0; k < n; k++) {
      S.busy = n > 1 ? `Saving the PDF… ${k + 1} of ${n}` : "Saving the PDF…"; renderBusy();
      await JT.po.putFilePart({ invoice_id: Number(invId), part: k, parts: n, data: toB64(f.bytes.subarray(k * PART, (k + 1) * PART)), name: f.name, type: f.type || "application/pdf", size: f.bytes.length });
    }
    S.files.set(String(invId), f.bytes);
  }
  let pdfToken = 0;
  async function renderPdf() {
    const ed = S.ed, host = $("pe-pdf"); if (!ed || !host || !ed.showPdf) return;
    const my = ++pdfToken;
    const bytes = ed.file ? ed.file.bytes : ed.inv && ed.inv.parts ? S.files.get(ed.inv.id) : null;
    if (!bytes) { host.innerHTML = `<div class="muted small">${ed.inv && ed.inv.parts ? "Loading the PDF…" : "No PDF on this order."}</div>`; return; }
    host.innerHTML = '<div class="muted small">Showing the PDF…</div>';
    try {
      const lib = await IP.pdfLib();
      const doc = await lib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
      if (my !== pdfToken) return;
      host.innerHTML = "";
      const w = Math.max(280, host.clientWidth - 2), dpr = Math.min(2, window.devicePixelRatio || 1);
      for (let p = 1; p <= Math.min(doc.numPages, 12); p++) {
        const page = await doc.getPage(p), vp0 = page.getViewport({ scale: 1 }), sc = w / vp0.width, vp = page.getViewport({ scale: sc * dpr });
        const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height; c.style.width = w + "px"; c.setAttribute("aria-label", "Invoice page " + p);
        host.appendChild(c);
        await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        if (my !== pdfToken) return;
      }
      if (doc.numPages > 12) host.insertAdjacentHTML("beforeend", `<div class="muted small">First 12 of ${doc.numPages} pages shown.</div>`);
    } catch (e) { if (my === pdfToken) host.innerHTML = `<div class="note bad">Couldn't show the PDF: ${esc(e && e.message || "unknown error")}</div>`; }
  }

  // ---------- reading an invoice PDF ----------
  async function readPdf(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { note("warn", "That isn't a PDF. Choose the invoice's PDF file."); return; }
    const intoEd = S.ed;
    S.busy = "Reading " + file.name + "…"; render();
    try {
      await catalog();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const rows = await IP.pdfRows(bytes.slice());
      const inv = IP.parseInvoice(rows, { vendors: S.vendors, known: (t, vendor) => S.bySku.has(norm(t)) || (!!vendor && S.remembered.has(vendor.toLowerCase() + "|" + norm(t))) });
      const f = { bytes, name: file.name, type: file.type || "application/pdf" };
      let ed = intoEd, msg = "";
      if (!ed) {
        // an open order from the same vendor with this PO # takes the invoice
        if (!S.orders) await loadOrders(false);
        const same = inv.po_no && S.orders.find(o => PRE.includes(o.status) && norm(o.po) === norm(inv.po_no) && (!inv.vendor || !o.vendor || o.vendor.toLowerCase() === inv.vendor.toLowerCase()));
        if (same) { S.busy = ""; await openPO(same.id); ed = S.ed; msg = `This invoice's PO # matches <b>${esc(same.vendor)} ${esc(poLabel(same.po))}</b>, so it was added to that order. `; S.busy = "Reading " + file.name + "…"; }
        else { ed = blankEd(); S.ed = ed; }
      }
      // an invoice with this number that was already saved: use it (its lines are replaced), unless another order has it
      if (inv.invoice_no && inv.vendor && !(ed.inv && ed.inv.id)) {
        const d = await JT.rows(["i.id::text", "i.status", "(select o.id::text from jt.prep_orders o where o.invoice_id = i.id limit 1)"],
          `from jt.invoices i where lower(i.vendor) = lower(${JT.q(inv.vendor)}) and lower(i.invoice_no) = lower(${JT.q(inv.invoice_no)})`, true);
        if (d[0] && d[0][2] && d[0][2] !== ed.id) {
          S.busy = ""; if (!intoEd) S.ed = null; render();
          note("warn", `Invoice <b>${esc(inv.invoice_no)}</b> from ${esc(inv.vendor)} is already on another purchase order. <button class="mini" data-po-open="${esc(d[0][2])}">Open it</button>`);
          return;
        }
        if (d[0]) ed.invReuse = d[0][0];
      }
      merge(ed, inv, f, rows);
      S.busy = "";
      const c = count(ed);
      msg += !rows.length ? "This PDF has no text in it (it's probably a scan or photo), so no lines could be read. Add the products with <b>Add product</b>."
        : !inv.lines.length ? "No item lines were recognised in this PDF. Add the products with <b>Add product</b>; the PDF is shown alongside."
        : `Read ${inv.lines.length} line${inv.lines.length === 1 ? "" : "s"}: ${c.sure} matched${c.check ? `, <b>${c.check} guess${c.check === 1 ? "" : "es"} to check</b>` : ""}${c.none ? `, <b>${c.none} not matched</b>` : ""}. Nothing is saved until you press Save.`;
      note(c.none || c.check || !inv.lines.length ? "warn" : "info", msg);
    } catch (e) {
      console.error("[JT] invoice read failed", e); S.busy = "";
      note("bad", "Couldn't read that PDF" + (e && e.message ? ": " + esc(e.message) : "") + ".");
    }
    render();
  }
  // Put a parsed invoice on the order: a line for a product already on the order fills that row; the rest are added.
  function merge(ed, inv, f, rows) {
    if (!ed.vendor && inv.vendor) ed.vendor = inv.vendor;
    if (!ed.po && inv.po_no) ed.po = inv.po_no;
    const keepId = ed.inv ? ed.inv.id : ed.invReuse || null;
    ed.inv = { id: keepId, no: inv.invoice_no || "", date: inv.invoice_date || "", subtotal: inv.subtotal, fileName: f.name, parts: 0, status: "draft", notes: "", isNew: !ed.inv };
    ed.file = f; ed.raw = rows;
    ed.rows = ed.rows.filter(r => !r.src);                    // a replaced invoice takes its old lines with it
    const dest = ed.dest === "mixed" ? "shopify" : ed.dest;
    for (const l of inv.lines) {
      const src = { item_code: l.item_code || "", upc: l.upc || "", description: l.description || "", qty: l.qty, unit_cost: l.unit_cost, amount: l.amount };
      const g = guessLine(src, ed.vendor);
      const qty = l.qty == null ? "" : String(Math.round(l.qty * 100) / 100), cost = fmtCost(l.unit_cost);
      const onOrder = g.vid && ed.rows.find(r => !r.src && r.vid === g.vid);
      if (onOrder) { Object.assign(onOrder, { src, how: g.how, conf: g.conf, alts: g.alts, confirmed: true, qty, cost }); continue; }   // already on the PO: that settles it
      ed.rows.push({ id: newId(), src, vid: g.vid, how: g.how, conf: g.conf, alts: g.alts, confirmed: false, dest, asku: "", qty, cost, skip: !g.vid && NONPRODUCT.test(src.description + " " + src.item_code) });
    }
    ed.dirty = true; ed.showPdf = window.innerWidth >= 1100; ed.filter = "all";
  }
  function count(ed) {
    const c = { sure: 0, check: 0, none: 0, notOnInv: 0, skip: 0 };
    for (const r of ed.rows) { if (r.skip) c.skip++; else if (!r.vid) c.none++; else if (needsCheck(r)) c.check++; else c.sure++; if (ed.inv && !r.src) c.notOnInv++; }
    return c;
  }
  // re-guess every line not picked or confirmed by hand (after the vendor changes)
  function reguess(ed) {
    for (const r of ed.rows) {
      if (!r.src || r.how === "manual" || r.confirmed) continue;
      Object.assign(r, guessLine(r.src, ed.vendor));
    }
  }

  // ---------- products added by hand ----------
  function findProducts(text) {
    const t = String(text || "").trim(); if (!t || !S.cat) return [];
    const a = S.byAmz.get(t.toLowerCase());
    if (a) { const v = S.byVid.get(a.vid); if (v) return [{ v, asku: a.asku }]; }
    const exact = S.cat.filter(v => norm(v.sku) === norm(t) || (v.barcode && norm(v.barcode).replace(/^0+/, "") === norm(t).replace(/^0+/, "")));
    if (exact.length) return exact.map(v => ({ v, asku: "" }));
    const w = t.toLowerCase().split(/\s+/).filter(Boolean);
    return S.cat.filter(v => w.every(x => v.text.includes(x)))
      .sort((a, b) => (a.status === "ACTIVE" ? 0 : 1) - (b.status === "ACTIVE" ? 0 : 1) || (S.ed && S.ed.vendor ? (a.vendor === S.ed.vendor ? 0 : 1) - (b.vendor === S.ed.vendor ? 0 : 1) : 0) || a.title.localeCompare(b.title))
      .slice(0, 12).map(v => ({ v, asku: "" }));
  }

  // ---------- issues (Incoming Inventory's checks, plus the invoice's) ----------
  function issuesOf(ed) {
    const o = { id: ed.id, status: ed.status, vendor: ed.vendor, po: ed.po.trim(), expected: ed.expected, kind: ed.kind, placeBy: ed.placeBy, invoiceId: ed.inv ? ed.inv.id || "new" : null, inv: null,
      shortOk: ed.shortOk, stageAt: ed.stageAt, shipments: ed.shipments,
      lines: ed.rows.filter(r => r.vid).map((r, i, all) => { const v = variant(r.vid) || {}, k = keyOf(r), first = all.findIndex(x => keyOf(x) === k) === i;
        return { key: r.id, vid: r.vid, pid: v.pid || "", title: v.title || "variant " + r.vid, ordered: Number(r.qty) || 0, received: first ? ed.received.get(k) || 0 : 0,
          unitCost: r.cost === "" ? null : Number(r.cost), shopCost: v.cost == null ? null : v.cost, dest: r.dest }; }) };
    const out = OI() ? OI().orderIssuesOf(o) : [];
    const c = count(ed);
    if (c.none) out.unshift({ lvl: ORDER.indexOf(ed.status) >= 3 ? "bad" : "warn", kind: "unmatched", title: `${c.none} invoice line${c.none === 1 ? " isn't" : "s aren't"} matched to a Shopify product`,
      text: "They stay on the invoice but aren't on the PO (and can't be received) until you pick the product. If a line isn't a product (freight, a fee), mark it Not a product.",
      fixes: [{ label: "Show them", fix: "pfilter", arg: "none" }] });
    if (c.check) out.unshift({ lvl: ed.status === "packing_slip" ? "bad" : "warn", kind: "check", title: `${c.check} product${c.check === 1 ? " is a guess" : "s are guesses"} to check`,
      text: "Confirm each one or pick the right product. Confirmed matches are remembered for this vendor's next invoice.",
      fixes: [{ label: "Show them", fix: "pfilter", arg: "check" }, ...(ed.rows.some(r => needsCheck(r) && r.conf === "high") ? [{ label: "Confirm all Likely", fix: "pconfirmall" }] : [])] });
    if (ed.inv && ed.inv.subtotal != null && ed.rows.some(r => r.src)) {
      const sum = ed.rows.filter(r => r.src).reduce((a, r) => a + lineAmt(r), 0);
      if (Math.abs(sum - ed.inv.subtotal) > Math.max(0.05, ed.inv.subtotal * 0.001)) out.push({ lvl: "warn", kind: "subtotal", title: `Lines add up to ${m(sum)}; the invoice subtotal is ${m(ed.inv.subtotal)}`,
        text: "A line may not have been read, or a quantity or cost is off. Check against the PDF.", fixes: [{ label: "Show the PDF", fix: "ppdf" }, { label: "Add product", fix: "focus", arg: "po-add" }] });
    }
    if (ed.inv && c.notOnInv) out.push({ lvl: "info", kind: "notoninv", title: `${c.notOnInv} product${c.notOnInv === 1 ? " on the PO isn't" : "s on the PO aren't"} on the invoice`,
      text: "Back-ordered or left off by the vendor? Keep them if they're still coming, or take them off.", fixes: [{ label: "Show them", fix: "pfilter", arg: "notoninv" }] });
    const rank = { bad: 0, warn: 1, info: 2 };
    return out.filter(x => x.kind !== "invdiff").sort((a, b) => rank[a.lvl] - rank[b.lvl]);
  }
  const lineAmt = (r) => { const q = Number(r.qty) || 0, c = r.cost === "" ? (variant(r.vid) || {}).cost : Number(r.cost);
    return r.src && r.src.amount != null && String(r.src.qty) === String(Number(r.qty)) && String(r.src.unit_cost) === String(Number(r.cost)) ? r.src.amount : q * (c || 0); };
  // list-level flags (without loading every order's lines)
  function listFlags(o) {
    const f = [];
    if (o.unmatched) f.push(["warn", `${o.unmatched} not matched`]);
    if (o.guesses) f.push(["warn", `${o.guesses} to check`]);
    if (["ordered", "invoice", "packing_slip"].includes(o.status) && o.expected && o.expected < today()) f.push(["warn", "late"]);
    if (ORDER.indexOf(o.status) >= 2 && ORDER.indexOf(o.status) < 5 && !o.invoiceId) f.push(["warn", "no invoice"]);
    if (o.status === "draft" && o.kind === "booking" && o.placeBy && o.placeBy < today()) f.push(["warn", "past place-by"]);
    if (o.status === "received" && o.received < o.units) f.push(["info", "received short"]);
    return f;
  }

  // ---------- rendering: list ----------
  function render() { if ($("tab-po").hidden) return; renderBusy(); if (S.ed) renderEditor(); else renderList(); }
  function renderBusy() { const b = $("po-busy"); if (!b) return; b.hidden = !S.busy; b.textContent = S.busy || ""; }
  function renderList() {
    if ($("tab-po").hidden) return;
    $("po-list-view").hidden = !!S.ed; $("po-edit-view").hidden = !S.ed;
    if (S.ed) return;
    const all = S.orders || [];
    const cnt = (st) => all.filter(o => st === "open" ? PRE.includes(o.status) : st === "all" ? true : o.status === st).length;
    $("po-stage").innerHTML = [["open", "Open"], ...STAGES, ["all", "All"]].map(([k, n]) => `<button data-st="${k}" aria-pressed="${S.stage === k}">${n} <span class="cnt">${cnt(k)}</span></button>`).join("");
    const vs = [...new Set(all.map(o => o.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const vsel = $("po-vendor"); const want = ["all", ...vs].join("|");
    if (vsel.dataset.opts !== want) { vsel.innerHTML = `<option value="all">All vendors</option>` + vs.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(""); vsel.dataset.opts = want; vsel.value = vs.includes(S.vendor) ? S.vendor : "all"; }
    // KPIs
    const open = all.filter(o => PRE.includes(o.status)), out = all.filter(o => ["ordered", "invoice", "packing_slip"].includes(o.status));
    const flagged = open.concat(all.filter(o => o.status === "received")).filter(o => listFlags(o).some(f => f[0] !== "info"));
    $("po-kpis").innerHTML = [
      { l: "Open POs", v: n0(open.length), s: `${all.filter(o => o.status === "draft").length} draft · ${out.length} placed, not received` },
      { c: "cost", l: "On order", v: m0(out.reduce((a, o) => a + o.cost, 0)), s: `${n0(out.reduce((a, o) => a + o.units, 0))} units at cost` },
      { l: "Needs attention", v: n0(flagged.length), s: flagged.length ? "late, unmatched lines, guesses, no invoice" : "nothing flagged" },
      { l: "Received (30 days)", v: n0(all.filter(o => ["received", "shipped"].includes(o.status) && (o.stageAt.received || "") >= window.JTDate.addDays(today(), -30)).length), s: "orders" },
    ].map(k => `<div class="kpi ${k.c || ""}"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
    const q = S.q.trim().toLowerCase().replace(/^#/, "");
    const list = all.filter(o => (S.stage === "open" ? PRE.includes(o.status) : S.stage === "all" || o.status === S.stage) && (S.vendor === "all" || o.vendor === S.vendor)
      && (!q || [o.vendor, o.po, o.invNo, o.note, o.text].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => S.stage === "open" ? ORDER.indexOf(b.status) - ORDER.indexOf(a.status) || String(b.updated).localeCompare(String(a.updated)) : String(b.updated).localeCompare(String(a.updated)));
    const t = $("po-table");
    if (!S.orders) { t.innerHTML = `<tbody><tr><td class="l muted">${S.loading ? "Loading…" : ""}</td></tr></tbody>`; return; }
    t.innerHTML = `<thead><tr><th class="l">PO</th><th class="l">Vendor</th><th class="l">Stage</th><th>Products</th><th>Units</th><th>Cost</th><th class="l">Invoice</th><th class="l">Dates</th><th class="l">Needs attention</th></tr></thead><tbody>${
      list.map(o => {
        const fl = listFlags(o), got = ["received", "shipped"].includes(o.status);
        const dates = o.status === "draft" && o.kind === "booking" && o.placeBy ? `place by ${shortDate(o.placeBy)}` : got ? `received ${when(o.stageAt.received)}` : o.expected ? `expected ${shortDate(o.expected)}` : `updated ${when(o.updated)}`;
        return `<tr class="po-row" data-po-open="${o.id}" tabindex="0"><td class="l"><b class="mono">${esc(o.po ? poLabel(o.po) : "#" + o.id)}</b>${o.kind === "booking" ? ' <span class="pill warn">Booking</span>' : ""}</td>
          <td class="l">${esc(o.vendor || "—")}</td>
          <td class="l"><span class="pill ${PILL[o.status]}">${STAGE.get(o.status)}</span></td>
          <td>${n0(o.nLines)}</td><td>${got ? `${n0(o.received)} <span class="dim">of ${n0(o.units)}</span>` : n0(o.units)}</td><td>${m0(o.cost)}</td>
          <td class="l small">${o.invoiceId ? `<span class="mono">${esc(o.invNo || "invoice")}</span>${o.hasFile ? ' <span class="pill pos" title="PDF attached">PDF</span>' : ""}${o.subtotal != null ? `<div class="meta">${m(o.subtotal)}</div>` : ""}` : '<span class="dim">—</span>'}</td>
          <td class="l small">${dates}</td>
          <td class="l">${fl.map(f => `<span class="pill ${f[0] === "info" ? "pos" : "miss"}">${esc(f[1])}</span>`).join("")}</td></tr>`;
      }).join("") || `<tr><td class="l muted" colspan="9">${S.stage === "open" && !q ? "No open purchase orders. Start one with New PO, or upload a vendor invoice PDF." : "No purchase orders match."}</td></tr>`}</tbody>`;
  }

  // ---------- rendering: editor ----------
  function renderEditor() {
    const ed = S.ed; if (!ed) return;
    $("po-list-view").hidden = true; $("po-edit-view").hidden = false;
    const box = $("po-edit-view");
    const keep = document.activeElement && box.contains(document.activeElement) ? { id: document.activeElement.id, k: document.activeElement.dataset.k, f: document.activeElement.dataset.f, s: document.activeElement.selectionStart } : null;
    const got = ed.status === "received" || ed.status === "shipped", ro = ed.status === "shipped", editLines = !got && !ed.recv;
    const at = ORDER.indexOf(ed.status);
    const steps = STAGES.map(([k, n], i) => { const click = ed.id && !got && PRE.includes(k) && k !== ed.status;
      return `<${click ? "button" : "span"} class="step ${k === ed.status ? "on" : i < at ? "done" : ""}" ${click ? `data-pgo="${k}" title="Move to ${n}"` : ""}>${n}</${click ? "button" : "span"}>`; }).join('<span class="step-sep">→</span>');
    const iss = S.cat ? issuesOf(ed) : [];
    const c = count(ed);
    const rows = ed.rows.filter(r => ed.filter === "all" || (ed.filter === "none" ? !r.vid && !r.skip : ed.filter === "check" ? needsCheck(r) : ed.filter === "notoninv" ? !r.src : true));
    let units = 0, total = 0; for (const r of ed.rows) if (r.vid) { units += Number(r.qty) || 0; total += lineAmt(r); }
    const firstOfKey = new Set(); { const seen = new Set(); for (const r of ed.rows) if (r.vid) { const k = keyOf(r); if (!seen.has(k)) { seen.add(k); firstOfKey.add(r.id); } } }
    const lbl = (l) => window.JTListingLabel ? window.JTListingLabel(l) : l.sku;
    const destSel = (r) => {
      const canPick = editLines || (ed.recv && PRE.includes(ed.status) && !(ed.received.get(keyOf(r))));   // choose the listing when receiving
      if (!canPick) return r.dest === "shopify" ? '<span class="pill pos">Shopify store</span>' : `<span class="pill web">Prep center</span>${r.asku ? `<div class="meta mono">${esc(lbl((S.listings.get(r.vid) || []).find(l => l.sku === r.asku) || { sku: r.asku }))}</div>` : '<div class="meta">any ASIN</div>'}`;
      const ls = (r.vid ? S.listings.get(r.vid) || [] : []).slice().sort((a, b) => a.units - b.units || String(a.asin).localeCompare(String(b.asin)));
      const val = r.dest === "shopify" ? "@shopify" : r.asku || "";
      return `<select class="inp sm" data-f="dest" data-k="${r.id}" style="width:auto;max-width:190px"><option value="@shopify" ${val === "@shopify" ? "selected" : ""}>Shopify store</option><option value="" ${val === "" ? "selected" : ""}>Prep center · any ASIN (assign later)</option>${ls.map(l => `<option value="${esc(l.sku)}" ${val === l.sku ? "selected" : ""} title="${esc(l.title || "")}">Prep · ${esc(lbl(l))}</option>`).join("")}${r.asku && !ls.some(l => l.sku === r.asku) ? `<option selected value="${esc(r.asku)}">Prep · ${esc(r.asku)}</option>` : ""}</select>`;
    };
    const matchCell = (r) => {
      const v = variant(r.vid);
      if (ed.search && ed.search.id === r.id) {
        const res = findProducts(ed.search.q);
        return `<input class="inp" id="pe-sq" data-k="${r.id}" value="${esc(ed.search.q)}" placeholder="SKU, UPC, product words or Amazon SKU" autocomplete="off">
          <div class="mres">${ed.search.q.trim() ? res.map(x => `<button data-ppick="${esc(x.v.vid)}" data-k="${r.id}" data-asku="${esc(x.asku)}"><b>${esc(x.v.title)}</b><br><span class="dim">${esc(x.v.sku)} · ${esc(x.v.vendor)} · cost ${m(x.v.cost)}${x.v.status !== "ACTIVE" ? " · " + esc(x.v.status.toLowerCase()) : ""}</span></button>`).join("") || '<span class="muted small">No products match.</span>' : '<span class="muted small">Type to search the Shopify catalog.</span>'}</div>
          <div class="row"><button class="mini" data-pact="search-cancel">Cancel</button>${r.vid ? `<button class="mini" data-pact="unmatch" data-k="${r.id}">Not a product</button>` : ""}</div>`;
      }
      if (r.skip) return `<span class="pill pos">Not a product</span>${editLines ? ` <button class="linkbtn small" data-pact="unskip" data-k="${r.id}">it is a product</button>` : ""}<div class="meta">kept on the invoice, not on the PO</div>`;
      if (!v) return r.vid ? `<span class="dim">variant ${esc(r.vid)} (not in the catalog)</span>` : `<span class="pill miss">Not matched</span> ${editLines ? `<button class="mini" data-pact="search" data-k="${r.id}">Find product</button> <button class="linkbtn small" data-pact="skip" data-k="${r.id}">not a product</button>` : ""}`;
      const sure = isSure(r);
      const chip = sure ? `<span class="pill conf-high" title="${esc(HOW[r.how] || "Matched")}">${esc(r.confirmed && !SURE.has(r.how) ? "Confirmed" : HOW[r.how] || "Matched")}</span>`
        : `<span class="pill conf-${r.conf === "low" ? "low" : "medium"}" title="Best guess from the product words — check it">${esc(r.how === "skupart" ? "Part of SKU" : "Guess · " + (CONF[r.conf] || "Unsure"))}</span>`;
      const alts = editLines && !sure && r.alts && r.alts.length ? `<select class="inp sm alts" data-f="alt" data-k="${r.id}" aria-label="Other guesses"><option value="">Other guesses (${r.alts.length})…</option>${r.alts.map(id => { const a = variant(id); return a ? `<option value="${a.vid}">${esc(a.title)} · ${esc(a.sku)}</option>` : ""; }).join("")}</select>` : "";
      return `<a class="olink" href="${ADMIN}/products/${esc(v.pid)}/variants/${esc(v.vid)}" target="_blank" rel="noopener">${esc(v.title)}</a>
        <div class="meta"><span class="mono">${esc(v.sku) || "no SKU"}</span>${v.vendor ? " · " + esc(v.vendor) : ""}${chip}</div>
        ${editLines ? `<div class="mrow">${!sure ? `<button class="mini primary" data-pact="confirm" data-k="${r.id}">Confirm</button>` : ""}${alts}<button class="linkbtn small" data-pact="search" data-k="${r.id}">${sure ? "change" : "search"}</button></div>` : ""}`;
    };
    const rowsH = rows.map(r => {
      const v = variant(r.vid), q = Number(r.qty) || 0, cst = r.cost === "" ? (v ? v.cost : null) : Number(r.cost);
      const chg = v && v.cost > 0 && r.cost !== "" && !isNaN(Number(r.cost)) ? (Number(r.cost) - v.cost) / v.cost : null;
      const badQ = r.qty !== "" && !(Number.isInteger(Number(r.qty)) && Number(r.qty) >= 0), badC = r.cost !== "" && !(Number(r.cost) >= 0);
      const rec = got || ed.recv ? (firstOfKey.has(r.id) ? ed.received.get(keyOf(r)) || 0 : null) : null;
      const cls = r.skip ? "skipped" : !r.vid ? "nomatch" : needsCheck(r) ? "guess" : "";
      return `<tr class="${cls}" data-row="${r.id}">
        <td class="l inv">${r.src ? `${r.src.item_code ? `<span class="mono">${esc(r.src.item_code)}</span>` : ""}${r.src.upc ? ` <span class="mono dim small">${esc(r.src.upc)}</span>` : ""}<div class="small">${esc(r.src.description) || '<span class="dim">no description</span>'}</div><div class="meta">${r.src.qty ?? "?"} × ${m(r.src.unit_cost)} = ${m(r.src.amount)}</div>` : `<span class="dim small">${ed.inv ? "not on the invoice" : "added to the PO"}</span>`}</td>
        <td class="l match">${matchCell(r)}</td>
        <td class="l small">${r.vid ? destSel(r) : ""}</td>
        <td>${editLines ? `<input class="inp num sm ${badQ ? "bad" : ""}" data-f="qty" data-k="${r.id}" value="${esc(r.qty)}" inputmode="numeric" placeholder="0" style="width:70px">` : n0(q)}${rec != null ? `<div class="meta ${rec < q ? "warnt" : ""}">${n0(rec)} received</div>` : ""}</td>
        ${ed.recv ? `<td>${r.vid && firstOfKey.has(r.id) ? `<input class="inp num sm" data-f="recv" data-k="${r.id}" value="${esc(ed.recv[keyOf(r)] ?? "")}" inputmode="numeric" placeholder="0" style="width:70px">` : ""}</td>` : ""}
        <td>${editLines || (got && !ro && false) ? `<input class="inp num sm ${badC ? "bad" : ""}" data-f="cost" data-k="${r.id}" value="${esc(r.cost)}" inputmode="decimal" placeholder="${v && v.cost != null ? v.cost.toFixed(2) : "cost"}" style="width:80px">` : m(cst)}</td>
        <td>${r.vid ? m(lineAmt(r)) : r.src ? `<span class="dim">${m(r.src.amount)}</span>` : ""}</td>
        <td class="small">${v ? `${m(v.cost)}${chg != null && Math.abs(chg) >= 0.0005 ? `<div class="${chg > 0 ? "neg" : "pos"}">${pct(chg)}</div>` : ""}` : ""}</td>
        <td>${editLines ? `<button class="linkbtn small" data-pact="rm" data-k="${r.id}" title="Remove this line" aria-label="Remove line">✕</button>` : ""}</td></tr>`;
    }).join("");
    const vendorOpts = S.vendors.map(v => `<option value="${esc(v)}">`).join("");
    const inv = ed.inv;
    const found = editLines && ed.add.trim() ? findProducts(ed.add) : [];
    const FILT = [["all", `All ${ed.rows.length}`], ["check", `Guesses to check ${c.check}`], ["none", `Not matched ${c.none}`], ...(inv ? [["notoninv", `Not on invoice ${c.notOnInv}`]] : [])];
    const pdfOn = ed.showPdf && (ed.file || (inv && inv.parts));
    box.innerHTML = `
      <div class="po-crumb"><button class="linkbtn" data-pact="back-list">← All purchase orders</button>${ed.dirty ? '<span class="pill warn">Unsaved changes</span>' : ""}</div>
      <section class="panel">
        <div class="panel-head po-head"><h2>${ed.id ? esc(ed.vendor || "Vendor order") + " · " + esc(ed.po ? poLabel(ed.po) : "#" + ed.id) : "New purchase order"}${ed.kind === "booking" ? ' <span class="pill warn">Booking</span>' : ""}</h2><span class="steps six">${steps}</span></div>
        <div class="pmgrid">
          <label class="stack" for="pe-vendor">Vendor<input id="pe-vendor" class="inp" list="pe-vendors" value="${esc(ed.vendor)}" ${got ? "disabled" : ""} autocomplete="off" placeholder="Shopify vendor"><datalist id="pe-vendors">${vendorOpts}</datalist></label>
          <label class="stack" for="pe-po">PO #<input id="pe-po" class="inp mono" value="${esc(ed.po)}" ${ro ? "disabled" : ""}></label>
          <label class="stack">Type<span class="seg"><button data-pkind="order" aria-pressed="${ed.kind !== "booking"}" ${ed.status !== "draft" ? "disabled" : ""}>Order</button><button data-pkind="booking" aria-pressed="${ed.kind === "booking"}" ${ed.status !== "draft" ? "disabled" : ""}>Booking</button></span></label>
          ${ed.kind === "booking" ? `<label class="stack" for="pe-placeby">Place by<input id="pe-placeby" class="inp" type="date" value="${esc(ed.placeBy)}" ${ed.status !== "draft" ? "disabled" : ""}></label>` : ""}
          <label class="stack" for="pe-exp">Expected<input id="pe-exp" class="inp" type="date" value="${esc(ed.expected)}" ${ro ? "disabled" : ""}></label>
          <label class="stack" for="pe-dest">Receive into<select id="pe-dest" class="inp" ${editLines ? "" : "disabled"}><option value="shopify" ${ed.dest === "shopify" ? "selected" : ""}>Shopify store</option><option value="prep" ${ed.dest === "prep" ? "selected" : ""}>Prep center (Amazon)</option>${ed.dest === "mixed" ? '<option value="mixed" selected>Mixed (set per line)</option>' : ""}</select></label>
          <label class="stack" for="pe-note" style="grid-column:1 / -1">Note<input id="pe-note" class="inp" value="${esc(ed.note)}" ${ro ? "disabled" : ""} placeholder="e.g. ships in two drops"></label>
        </div>
      </section>
      <section class="panel po-inv">
        ${inv ? `<div class="po-invbar"><span><b>Invoice ${esc(inv.no || "(no number read)")}</b>${inv.date ? " · " + esc(shortDate(inv.date)) : ""}${inv.subtotal != null ? " · subtotal " + m(inv.subtotal) : ""}${inv.fileName ? ` · <span class="dim">${esc(inv.fileName)}</span>` : ""}${inv.status === "applied" ? ' <span class="pill ok" title="Applied on the Invoices tab: its lines are locked there">Costs in Shopify</span>' : ""}</span>
            <span class="dbtns">${ed.file || inv.parts ? `<button class="mini" data-pact="pdf">${ed.showPdf ? "Hide PDF" : "Show PDF"}</button>` : ""}${!ro ? `<label class="mini" for="pe-file">Replace PDF</label>` : ""}</span></div>
            <div class="pmgrid small-grid">
              <label class="stack" for="pe-invno">Invoice #<input id="pe-invno" class="inp mono" value="${esc(inv.no)}" ${ro || inv.status === "applied" ? "disabled" : ""}></label>
              <label class="stack" for="pe-invdate">Invoice date<input id="pe-invdate" class="inp" type="date" value="${esc(inv.date)}" ${ro || inv.status === "applied" ? "disabled" : ""}></label>
              <label class="stack" for="pe-invsub">Subtotal on invoice<input id="pe-invsub" class="inp num" value="${inv.subtotal != null ? inv.subtotal.toFixed(2) : ""}" ${ro || inv.status === "applied" ? "disabled" : ""}></label>
            </div>`
          : `<label class="po-drop" for="pe-file" id="pe-drop"><b>Upload the vendor's invoice PDF</b><span class="muted small">It reads the invoice's lines and matches each one to a Shopify product — or drop the PDF here.</span></label>`}
        <input type="file" id="pe-file" accept=".pdf,application/pdf" hidden>
      </section>
      ${iss.length ? `<section class="po-issues">${window.JTIssues.issuesHtml(iss)}</section>` : ""}
      <div class="po-body ${pdfOn ? "with-pdf" : ""}">
        <section class="panel po-lines">
          <div class="panel-head"><h2>Products</h2>
            <div class="seg" role="group" aria-label="Show lines">${FILT.map(([k, t]) => `<button data-pfilter="${k}" aria-pressed="${ed.filter === k}">${t}</button>`).join("")}</div></div>
          ${ed.rows.length ? `<div class="tbl-wrap xl"><table class="prept po-t"><thead><tr><th class="l">On the invoice</th><th class="l">Shopify product</th><th class="l">For</th><th>Qty</th>${ed.recv ? "<th>Arrived now</th>" : ""}<th>Unit cost</th><th>Ext.</th><th>Shopify cost</th><th></th></tr></thead>
            <tbody>${rowsH || `<tr><td class="l muted" colspan="9">No lines here.</td></tr>`}</tbody></table></div>` : `<div class="muted small">No products yet. Upload the invoice PDF above, or add products below.</div>`}
          ${editLines ? `<div class="addbox"><label class="stack" for="po-add">Add product<input id="po-add" class="inp mono" value="${esc(ed.add)}" placeholder="Shopify SKU, UPC, product name, ASIN or Amazon SKU" autocomplete="off"></label>
            ${ed.add.trim() ? `<div class="mres">${!S.cat ? '<span class="muted small">Loading the Shopify catalog…</span>' : found.map((x, i) => `<button data-padd="${i}"><b>${esc(x.v.title)}</b><br><span class="dim">${esc(x.v.sku)} · ${esc(x.v.vendor)}${x.asku ? " · for " + esc(x.asku) : ""} · cost ${m(x.v.cost)}</span></button>`).join("") || '<span class="muted small">No products match.</span>'}</div>` : ""}</div>` : ""}
          ${ed.confirm === "del" ? `<div class="note warn">Delete this purchase order${inv && inv.status !== "applied" ? " and its invoice" : ""}? Nothing has been received, so no stock changes. <span class="dbtns"><button class="mini primary" data-pact="do-del">Yes, delete</button><button class="mini" data-pact="no">Cancel</button></span></div>` : ""}
          ${ed.confirm === "unrecv" ? `<div class="note warn">Move this order back to packing slip? What was received into the prep center comes back out (refused if some of it already shipped out). <span class="dbtns"><button class="mini primary" data-pact="do-back">Yes, move it back</button><button class="mini" data-pact="no">Cancel</button></span></div>` : ""}
          ${ed.confirm === "shipped" ? `<div class="note warn">Mark this order shipped out? Stock doesn't change — for prep-center stock use Create Amazon shipment instead. <span class="dbtns"><button class="mini primary" data-pact="do-shipped">Yes, mark shipped</button><button class="mini" data-pact="no">Cancel</button></span></div>` : ""}
          <div class="row po-foot"><span class="muted small">${ed.recv ? "Enter what arrived, and pick the ASIN for prep-center lines — or leave it on any ASIN and assign it later on the Prep center tab. Shopify-store lines are recorded." : `${n0(units)} units · ${m(total)}${inv && inv.subtotal != null ? ` · invoice subtotal ${m(inv.subtotal)}` : ""}`}</span>
            <span class="dbtns right">${footButtons(ed, got, ro, c)}</span></div>
        </section>
        ${pdfOn ? `<aside class="panel po-pdf"><div class="panel-head"><h2>Invoice PDF</h2><button class="mini" data-pact="pdf">Hide</button></div><div id="pe-pdf" class="pdfpages"></div></aside>` : ""}
      </div>`;
    if (keep) {
      const el = keep.id ? $(keep.id) : keep.k && keep.f ? box.querySelector(`[data-f="${keep.f}"][data-k="${keep.k}"]`) : null;
      if (el) { el.focus(); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.s); } catch (_) {} }
    }
    if (pdfOn && !$("pe-pdf").childElementCount) renderPdf();
  }
  function footButtons(ed, got, ro, c) {
    const busy = S.busy ? "disabled" : "";
    if (ro) return `<button class="btn" data-pact="back">← Back to received</button>`;
    if (ed.recv) return `<button class="btn" data-pact="recv-cancel">Cancel</button><button class="btn primary" data-pact="recv-go" ${busy}>Receive</button>`;
    const out = [];
    if (ed.id && PREV[ed.status]) out.push(`<button class="btn" data-pact="back">← Back to ${STAGE.get(PREV[ed.status]).toLowerCase()}</button>`);
    if (ed.id && !got) out.push(`<button class="btn" data-pact="del">Delete</button>`);
    out.push(`<button class="btn ${ed.dirty && !NEXT[ed.status] ? "primary" : ""}" data-pact="save" ${busy}>Save</button>`);
    if (NEXT[ed.status]) out.push(`<button class="btn primary" data-pact="save-next" ${busy}>Save &amp; ${NEXT[ed.status][1].toLowerCase()}</button>`);
    if (!got && ed.rows.some(r => r.vid)) out.push(`<button class="btn ${ed.status === "packing_slip" ? "primary" : ""}" data-pact="recv" ${busy} ${c.check ? `title="Confirm the ${c.check} guessed product${c.check === 1 ? "" : "s"} first"` : ""}>Receive…</button>`);
    if (ed.status === "received") {
      out.push(`<button class="btn" data-pact="recv">Receive more…</button><button class="btn" data-pact="shipped">Mark shipped</button>`);
      if (ed.rows.some(r => r.vid && r.dest === "prep")) out.push(`<button class="btn primary" data-pact="amzship">Create Amazon shipment</button>`);
    }
    return out.join("");
  }

  // ---------- saving ----------
  function bodyOf(ed) {
    const lines = ed.rows.filter(r => r.vid).map(r => ({ variant_id: Number(r.vid), amazon_sku: r.dest === "prep" ? r.asku || "" : "", dest: r.dest || "prep", qty: Number(r.qty) || 0, unit_cost: r.cost === "" ? null : Number(r.cost) }));
    const order = { id: ed.id ? Number(ed.id) : null, vendor: ed.vendor.trim(), po_no: ed.po.trim(), kind: ed.kind, place_by: ed.placeBy || "", expected_on: ed.expected || "", note: ed.note, short_ok: !!ed.shortOk, lines };
    const inv = ed.inv ? { id: ed.inv.id ? Number(ed.inv.id) : null, vendor: ed.vendor.trim(), invoice_no: ed.inv.no || "", invoice_date: ed.inv.date || "", file_name: ed.inv.fileName || "",
      subtotal: ed.inv.subtotal, notes: ed.inv.notes || "", ...(ed.inv.id ? {} : { stage: "new" }),
      lines: ed.rows.filter(r => r.src).map(r => ({ item_code: r.src.item_code, upc: r.src.upc, description: r.src.description, qty: r.qty === "" ? null : Number(r.qty),
        unit_cost: r.cost === "" ? null : Number(r.cost), amount: r.vid || r.qty !== "" ? lineAmt(r) : r.src.amount, variant_id: r.vid ? Number(r.vid) : null, match_how: howSaved(r),
        update_cost: false, dest: r.dest || "prep", amazon_sku: r.dest === "prep" ? r.asku || "" : "" })) } : null;
    const remember = ed.rows.filter(r => r.src && r.src.item_code && r.vid && isSure(r) && r.how !== "sku").map(r => ({ item_code: r.src.item_code, variant_id: Number(r.vid) }));
    return { order, invoice: inv, remember };
  }
  function problems(ed) {
    const bad = ed.rows.find(r => r.qty !== "" && !(Number.isInteger(Number(r.qty)) && Number(r.qty) >= 0) || r.cost !== "" && !(Number(r.cost) >= 0));
    if (bad) { const v = variant(bad.vid); return `Check the quantity and cost for ${esc(v ? v.title : bad.src ? bad.src.description || bad.src.item_code : "a line")} — quantities are whole numbers.`; }
    if (!ed.vendor.trim()) return "Enter the vendor.";
    const k = new Map(); for (const r of ed.rows) if (r.vid) { const kk = keyOf(r); if (k.has(kk) && !(r.src && k.get(kk).src)) return `${esc((variant(r.vid) || {}).title || "A product")} is on the PO twice for the same place. Take one off or combine them.`; k.set(kk, r); }
    return "";
  }
  async function save(next, quiet) {
    const ed = S.ed; if (!ed || S.busy) return null;
    const p = problems(ed); if (p) { note("bad", p); return null; }
    const wasInvNew = !!(ed.inv && !ed.inv.id), first = !ed.id;
    S.busy = "Saving…"; render();
    try {
      const res = await JT.po.save(bodyOf(ed));
      const id = String(res.order_id), invId = res.invoice_id ? String(res.invoice_id) : null;
      ed.id = id; if (ed.inv && invId) ed.inv.id = invId;          // a retry after a later step fails updates, not duplicates
      if (invId && ed.file && !ed.file.saved) { await uploadFile(invId, ed.file); ed.file.saved = true; }
      let moved = "";
      const target = next || (wasInvNew && ["draft", "ordered"].includes(ed.status) ? "invoice" : null);
      if (target && target !== ed.status) { await JT.prep.setOrderStatus(Number(id), target); moved = target; }
      S.busy = ""; S.ed = null;
      await loadOrders(true);
      const nm = (ed.vendor || "Order") + (ed.po ? " " + poLabel(ed.po) : "");
      if (!quiet) note("info", `<b>${esc(nm)}</b> ${first ? "created" : "saved"}${moved ? ` and ${ORDER.indexOf(moved) < ORDER.indexOf(ed.status) ? "moved back to" : "moved to"} ${STAGE.get(moved).toLowerCase()}` : ""}.${bodyOf(ed).remember.length ? " Matches are remembered for this vendor's next invoice." : ""}`);
      await openPO(id);
      return id;
    } catch (e) {
      S.busy = ""; render();
      const msg = (e && e.message) || "";
      note("bad", /invoices_vendor_no_idx|duplicate key/i.test(msg) ? `Invoice ${esc(ed.inv && ed.inv.no)} from ${esc(ed.vendor)} is already saved on another order or on the Invoices tab.` : "Couldn't save: " + esc(JT.message(e)));
      return null;
    }
  }
  async function setStatus2(status, msg) {
    const ed = S.ed; S.busy = "Saving…"; render();
    try { await JT.prep.setOrderStatus(Number(ed.id), status); S.busy = ""; await loadOrders(true); await openPO(ed.id); note("info", msg || `Moved to ${STAGE.get(status).toLowerCase()}.`); }
    catch (e) { S.busy = ""; if (S.ed) S.ed.confirm = false; render(); note("bad", "Couldn't change the stage: " + esc(JT.message(e))); }
  }
  async function receiveNow() {
    const ed = S.ed; if (!ed || !ed.recv) return;
    const lines = [];
    for (const [k, v] of Object.entries(ed.recv)) {
      if (v == null || v === "") continue;
      const q = Number(v); if (!Number.isInteger(q) || q < 0) { note("bad", "Received quantities must be whole numbers."); return; }
      const [vid, asku, dest] = k.split("|");
      if (q > 0) lines.push({ variant_id: Number(vid), amazon_sku: dest === "prep" ? asku || "" : "", dest: dest || "prep", qty: q });
    }
    if (!lines.length) { note("warn", "Enter how many arrived."); return; }
    const recv = ed.recv;
    if (ed.dirty || !ed.id) { const id = await save(null, true); if (!id) return; S.ed.recv = recv; }
    S.busy = "Receiving…"; render();
    try {
      const n = await JT.prep.receiveOrder(Number(S.ed.id), lines);
      const id = S.ed.id; S.busy = ""; await loadOrders(true); await openPO(id);
      note("info", `Received ${n0(n)} units.${lines.some(l => l.dest === "prep") ? " Prep-center lines are in the prep center." : ""}${lines.some(l => l.dest === "shopify") ? " Shopify-store lines are recorded on the PO (Shopify's own stock isn't changed)." : ""}`);
    } catch (e) { S.busy = ""; render(); note("bad", "Couldn't receive: " + esc(JT.message(e))); }
  }
  function leave() {
    const ed = S.ed;
    if (ed && ed.dirty && !ed.leaveOk) { note("warn", `This purchase order has unsaved changes. <span class="dbtns"><button class="mini primary" data-pact="save">Save</button><button class="mini" data-pact="discard">Discard changes</button></span>`); return; }
    S.ed = null; note("", ""); pdfToken++; render(); renderList();
  }

  // ---------- events ----------
  function focusArg(a) { const id = { "po-add": "po-add", "po-exp": "pe-exp", "po-inv": "pe-file", "po-placeby": "pe-placeby", "po-po": "pe-po" }[a] || a;
    setTimeout(() => { const el = $(id); if (!el) return; if (id === "pe-file") el.click(); else { el.focus(); if (el.select) el.select(); } }, 0); }
  function fix(d) {
    const ed = S.ed; if (!ed) return;
    const f = d.fix, row = d.k && ed.rows.find(r => r.id === d.k);
    if (f === "focus") return focusArg(d.arg);
    if (f === "focuskq" || f === "focuskc") { setTimeout(() => { const el = document.querySelector(`#po-edit-view [data-f="${f === "focuskq" ? "qty" : "cost"}"][data-k="${CSS.escape(d.k)}"]`); if (el) { el.focus(); el.select(); } }, 0); return; }
    if (f === "pfilter") { ed.filter = d.arg; render(); return; }
    if (f === "pconfirmall") { for (const r of ed.rows) if (needsCheck(r) && r.conf === "high") r.confirmed = true; ed.dirty = true; render(); return; }
    if (f === "ppdf" || f === "oinv") { ed.showPdf = true; render(); return; }
    if (f === "orecv") return act("recv");
    if (f === "oshort") { ed.shortOk = true; save(null); return; }
    if (f === "onext") { save(NEXT[ed.status] && NEXT[ed.status][0]); return; }
    if (f === "oship") return act("amzship");
    if (f === "tab") { const b = document.querySelector(`.tabs button[data-tab="${d.arg}"]`); if (b) b.click(); return; }
    if (f === "ofill") { focusArg("po-inv"); return; }
    if (row) render();
  }
  function act(a, k) {
    const ed = S.ed; if (!ed) return;
    const r = k && ed.rows.find(x => x.id === k);
    if (a === "back-list") return leave();
    if (a === "discard") { ed.leaveOk = true; return leave(); }
    if (a === "save") return save(null);
    if (a === "save-next") return save(NEXT[ed.status][0]);
    if (a === "confirm" && r) { r.confirmed = true; ed.dirty = true; render(); return; }
    if (a === "search" && r) { ed.search = { id: r.id, q: r.src ? r.src.item_code || (r.src.description || "").split(/\s+/).slice(0, 4).join(" ") : "" }; render(); setTimeout(() => { const i = $("pe-sq"); if (i) { i.focus(); i.select(); } }, 0); return; }
    if (a === "search-cancel") { ed.search = null; render(); return; }
    if (a === "unmatch" && r) { r.vid = null; r.how = ""; r.conf = ""; r.confirmed = false; r.skip = !!r.src; ed.search = null; ed.dirty = true; render(); return; }
    if (a === "skip" && r) { r.skip = true; ed.dirty = true; render(); return; }
    if (a === "unskip" && r) { r.skip = false; ed.dirty = true; render(); return; }
    if (a === "rm" && r) { ed.rows = ed.rows.filter(x => x !== r); ed.dirty = true; render(); return; }
    if (a === "pdf") { ed.showPdf = !ed.showPdf; render(); return; }
    if (a === "del") { ed.confirm = "del"; render(); return; }
    if (a === "no") { ed.confirm = false; render(); return; }
    if (a === "do-del") { S.busy = "Deleting…"; render(); JT.po.remove(Number(ed.id)).then(async () => { S.busy = ""; S.ed = null; await loadOrders(true); render(); renderList(); note("info", "Purchase order deleted."); })
      .catch(e => { S.busy = ""; ed.confirm = false; render(); note("bad", "Couldn't delete: " + esc(JT.message(e))); }); return; }
    if (a === "back") { if (ed.status === "received") { ed.confirm = "unrecv"; render(); } else setStatus2(PREV[ed.status], `Moved back to ${STAGE.get(PREV[ed.status]).toLowerCase()}.`); return; }
    if (a === "do-back") return setStatus2(PREV[ed.status], "Moved back to packing slip; the received units came out of the prep center.");
    if (a === "shipped") { ed.confirm = "shipped"; render(); return; }
    if (a === "do-shipped") return setStatus2("shipped", "Marked shipped out.");
    if (a === "recv") {
      const c = count(ed);
      if (c.check) { note("warn", `Confirm or change the ${c.check} guessed product${c.check === 1 ? "" : "s"} before receiving, so the right stock comes in.`); ed.filter = "check"; render(); return; }
      ed.recv = {}; const seen = new Set();
      for (const x of ed.rows) if (x.vid) { const kk = keyOf(x); if (seen.has(kk)) continue; seen.add(kk);
        const ordered = ed.rows.filter(y => y.vid && keyOf(y) === kk).reduce((s, y) => s + (Number(y.qty) || 0), 0);
        ed.recv[kk] = String(Math.max(0, ordered - (ed.received.get(kk) || 0))); }
      render(); return;
    }
    if (a === "recv-cancel") { ed.recv = null; render(); return; }
    if (a === "recv-go") return receiveNow();
    if (a === "amzship") { if (window.JTPrepTab && window.JTPrepTab.shipFromOrder) window.JTPrepTab.shipFromOrder(ed.id); return; }
  }
  function addLine(x) {
    const ed = S.ed, dest = x.asku ? "prep" : ed.dest === "prep" ? "prep" : "shopify";
    const r = { id: newId(), src: null, vid: x.v.vid, how: "manual", conf: "sure", alts: [], confirmed: true, dest, asku: x.asku || "", qty: "", cost: "" };
    if (ed.rows.some(y => y.vid && keyOf(y) === keyOf(r))) { note("warn", `${esc(x.v.title)} is already on this PO.`); return; }
    ed.rows.push(r); ed.add = ""; ed.dirty = true; ed.filter = "all"; render();
    setTimeout(() => { const i = document.querySelector(`#po-edit-view [data-f="qty"][data-k="${r.id}"]`); if (i) i.focus(); }, 0);
  }

  function bind() {
    const tab = $("tab-po"), box = $("po-edit-view");
    $("po-new").addEventListener("click", () => { if (S.ed && S.ed.dirty) return leave(); note("", ""); openPO(null); });
    $("po-refresh").addEventListener("click", async () => { await Promise.all([refresh(true), S.cat ? catalog(true) : null]); if (S.ed && S.ed.id && !S.ed.dirty) openPO(S.ed.id); });
    $("po-file").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; readPdf(f); });
    $("po-q").addEventListener("input", (e) => { S.q = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(renderList, 150); });
    $("po-vendor").addEventListener("change", (e) => { S.vendor = e.target.value; renderList(); });
    $("po-stage").addEventListener("click", (e) => { const b = e.target.closest("button[data-st]"); if (b) { S.stage = b.dataset.st; renderList(); } });
    tab.addEventListener("click", (e) => {
      const o = e.target.closest("[data-po-open]"); if (o && !e.target.closest("a")) { note("", ""); openPO(o.dataset.poOpen); return; }
    });
    $("po-table").addEventListener("keydown", (e) => { const o = e.target.closest("[data-po-open]"); if (o && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openPO(o.dataset.poOpen); } });
    // a PDF dropped anywhere on the tab
    const isFile = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
    tab.addEventListener("dragover", (e) => { if (isFile(e)) { e.preventDefault(); tab.classList.add("filedrop"); } });
    tab.addEventListener("dragleave", (e) => { if (!tab.contains(e.relatedTarget)) tab.classList.remove("filedrop"); });
    tab.addEventListener("drop", (e) => { if (isFile(e)) { e.preventDefault(); tab.classList.remove("filedrop"); readPdf(e.dataTransfer.files[0]); } });
    $("po-note").addEventListener("click", (e) => { const b = e.target.closest("[data-pact]"); if (b) act(b.dataset.pact); });
    box.addEventListener("change", (e) => {
      const ed = S.ed, t = e.target; if (!ed) return;
      if (t.id === "pe-file") { const f = t.files[0]; t.value = ""; readPdf(f); return; }
      if (t.id === "pe-vendor") { ed.vendor = t.value.trim(); ed.dirty = true; reguess(ed); render(); return; }
      if (t.id === "pe-exp") { ed.expected = t.value; ed.dirty = true; render(); return; }
      if (t.id === "pe-placeby") { ed.placeBy = t.value; ed.dirty = true; render(); return; }
      if (t.id === "pe-invdate") { ed.inv.date = t.value; ed.dirty = true; return; }
      if (t.id === "pe-dest") { if (t.value !== "mixed") { ed.dest = t.value; for (const r of ed.rows) { r.dest = t.value; if (t.value === "shopify") r.asku = ""; } ed.dirty = true; render(); } return; }
      const r = t.dataset.k && ed.rows.find(x => x.id === t.dataset.k); if (!r) return;
      if (t.dataset.f === "dest") { const oldK = keyOf(r); if (t.value === "@shopify") { r.dest = "shopify"; r.asku = ""; } else { r.dest = "prep"; r.asku = t.value; }
        if (ed.recv && oldK !== keyOf(r) && oldK in ed.recv) { ed.recv[keyOf(r)] = ed.recv[oldK]; delete ed.recv[oldK]; }
        const ds = new Set(ed.rows.filter(x => x.vid).map(x => x.dest)); ed.dest = ds.size > 1 ? "mixed" : [...ds][0] || ed.dest; ed.dirty = true; render(); return; }
      if (t.dataset.f === "alt" && t.value) { r.vid = t.value; r.how = "manual"; r.conf = "sure"; r.confirmed = true; ed.dirty = true; render(); return; }
    });
    box.addEventListener("input", (e) => {
      const ed = S.ed, t = e.target; if (!ed) return;
      if (t.id === "pe-po") { ed.po = t.value; ed.dirty = true; return; }
      if (t.id === "pe-note") { ed.note = t.value; ed.dirty = true; return; }
      if (t.id === "pe-invno") { ed.inv.no = t.value; ed.dirty = true; return; }
      if (t.id === "pe-invsub") { const v = IP.numOf(t.value); ed.inv.subtotal = v; ed.dirty = true; clearTimeout(box._t); box._t = setTimeout(render, 500); return; }
      if (t.id === "po-add") { ed.add = t.value; clearTimeout(box._t); box._t = setTimeout(render, 150); if (!S.cat) catalog().then(render).catch(() => {}); return; }
      if (t.id === "pe-sq") { ed.search.q = t.value; clearTimeout(box._t); box._t = setTimeout(render, 150); return; }
      const r = t.dataset.k && ed.rows.find(x => x.id === t.dataset.k); if (!r) return;
      if (t.dataset.f === "qty") { r.qty = t.value.trim(); ed.dirty = true; clearTimeout(box._t); box._t = setTimeout(render, 400); }
      if (t.dataset.f === "cost") { r.cost = t.value.trim().replace(/^\$/, ""); ed.dirty = true; clearTimeout(box._t); box._t = setTimeout(render, 400); }
      if (t.dataset.f === "recv") { ed.recv[keyOf(r)] = t.value.trim(); }
    });
    box.addEventListener("keydown", (e) => {
      const ed = S.ed; if (!ed) return;
      if (e.target.id === "po-add" && e.key === "Enter") { e.preventDefault(); clearTimeout(box._t); const f = findProducts(ed.add); if (f.length) addLine(f[0]); else render(); }
      if (e.target.id === "pe-sq" && e.key === "Enter") { e.preventDefault(); const b = box.querySelector(".mres button[data-ppick]"); if (b) b.click(); }
      if (e.target.id === "pe-sq" && e.key === "Escape") { ed.search = null; render(); }
      if (e.key === "Enter" && e.target.dataset && (e.target.dataset.f === "qty" || e.target.dataset.f === "cost")) {
        e.preventDefault(); const ins = [...box.querySelectorAll(`input[data-f="${e.target.dataset.f}"]`)], i = ins.indexOf(e.target); clearTimeout(box._t); render();
        const nx = ins[i + 1] && box.querySelector(`input[data-f="${e.target.dataset.f}"][data-k="${ins[i + 1].dataset.k}"]`); if (nx) { nx.focus(); nx.select(); }
      }
    });
    box.addEventListener("click", (e) => {
      const ed = S.ed, b = e.target.closest("button"); if (!ed || !b) return;
      if (b.dataset.fix) { fix(b.dataset); return; }
      if (b.dataset.pact) { act(b.dataset.pact, b.dataset.k); return; }
      if (b.dataset.pgo) { save(b.dataset.pgo); return; }
      if (b.dataset.pkind) { ed.kind = b.dataset.pkind; ed.dirty = true; render(); return; }
      if (b.dataset.pfilter) { ed.filter = b.dataset.pfilter; render(); return; }
      if (b.dataset.padd != null) { const x = findProducts(ed.add)[+b.dataset.padd]; if (x) addLine(x); return; }
      if (b.dataset.ppick) { const r = ed.rows.find(x => x.id === b.dataset.k); if (r) { r.vid = b.dataset.ppick; r.skip = false; if (b.dataset.asku) { r.dest = "prep"; r.asku = b.dataset.asku; } r.how = "manual"; r.conf = "sure"; r.confirmed = true; ed.search = null; ed.dirty = true; render(); } return; }
    });
    box.addEventListener("dragover", (e) => { const d = e.target.closest("#pe-drop"); if (d) d.classList.add("over"); });
    box.addEventListener("dragleave", (e) => { const d = e.target.closest("#pe-drop"); if (d) d.classList.remove("over"); });
    window.addEventListener("beforeunload", (e) => { if (S.ed && S.ed.dirty) { e.preventDefault(); e.returnValue = ""; } });
    let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (S.ed && S.ed.showPdf && !$("tab-po").hidden) { const h = $("pe-pdf"); if (h) h.innerHTML = ""; renderPdf(); } }, 250); });
  }

  bind();
  window.poShow = () => { if (!S.shown) { S.shown = true; refresh(false); catalog().catch(() => {}); } render(); };
  window.JTPO = { _state: S, open: (id) => { const b = document.querySelector('.tabs button[data-tab="po"]'); if (b) b.click(); openPO(id); }, guessLine, merge };
  if ((location.hash || "") === "#po") setTimeout(() => window.poShow(), 0);
})();
