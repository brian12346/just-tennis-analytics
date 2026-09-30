(() => {
  // ===================== Purchase orders =====================
  // Vendor orders (jt.prep_orders — the same orders Incoming Inventory shows on the Prep center tab), full page.
  // A PO can have several invoices (jt.invoices.order_id): the vendor ships and bills in parts. Receiving is against
  // the PO's lines; anything ordered and not yet invoiced is on order or backordered (with an expected date).
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
  // the Shopify PO link: a pasted admin link, or just the PO's number from its admin URL
  const shopUrl = (v) => { v = String(v || "").trim(); if (!v) return ""; if (/^#?\d+$/.test(v)) return `${ADMIN}/purchase_orders/${v.replace("#", "")}`;
    if (/^(admin\.shopify\.com|[\w-]+\.myshopify\.com)\//i.test(v)) return "https://" + v; return v; };
  const TZ = "America/Los_Angeles";
  const today = () => window.JTDate.today();
  const when = (t) => { const d = window.JTDate.parseTime(t); return !t || isNaN(d) ? "" : d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" }); };
  const shortDate = (ds) => ds ? new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
  const OI = () => window.JTOrderIssues;

  // draft -> ordered -> invoiced -> partial (some received) -> received -> qb_ready (bills in QuickBooks) -> complete
  const STAGES = [["draft", "Draft"], ["ordered", "Ordered"], ["invoiced", "Invoiced"], ["partial", "Partly received"], ["received", "Received"], ["qb_ready", "QB Ready"], ["complete", "Complete"]];
  const STAGE = new Map(STAGES), ORDER = STAGES.map(x => x[0]), PRE = ["draft", "ordered", "invoiced"], GOT = ["partial", "received", "qb_ready", "complete"];
  const NEXT = { draft: ["ordered", "Mark ordered"], ordered: ["invoiced", "Mark invoiced"], received: ["qb_ready", "Mark QB ready"], qb_ready: ["complete", "Mark complete"] };
  const PREV = { ordered: "draft", invoiced: "ordered", partial: "invoiced", received: "invoiced", qb_ready: "received", complete: "qb_ready" };
  const PILL = { draft: "pos", ordered: "manual", invoiced: "other", partial: "warn", received: "ok", qb_ready: "web", complete: "ok" };
  const PAY = [["ach", "ACH"], ["check", "Check"], ["credit_card", "Credit card"], ["wire", "Wire"], ["cash", "Cash"], ["other", "Other"]], PAYN = new Map(PAY);
  const payTxt = (iv) => iv.paidOn ? [PAYN.get(iv.payMethod) || "Paid", shortDate(iv.paidOn), iv.payRef, iv.paidFrom ? "from " + iv.paidFrom : ""].filter(Boolean).join(" · ") : "";
  const overdue = (iv) => !iv.paidOn && iv.due && iv.due < today();
  const poLabel = (po) => /^po\b/i.test(po) ? po : "PO " + po;
  const SURE = new Set(["remembered", "sku", "upc", "manual", "confirmed"]);
  const HOW = { remembered: "Remembered", sku: "SKU match", upc: "UPC match", manual: "Picked", confirmed: "Confirmed", skupart: "Part of SKU", guess: "Guess" };
  const CONF = { high: "Likely", medium: "Maybe", low: "Unsure" };
  const ACCOUNTS = [["inventory", "Inventory"], ["inbound_shipping", "Inbound Shipping"]];   // QuickBooks accounts (bill lines)
  const ACCT = new Map(ACCOUNTS);
  const FREIGHT = /\b(freight|shipping|handling|delivery|postage)\b/i;
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
    const IV = "from jt.invoices ii where ii.order_id = o.id", IL = "from jt.invoice_lines il join jt.invoices ii on ii.id = il.invoice_id where ii.order_id = o.id";
    const r = await JT.rowsSplit(["o.id::text", "o.vendor", "o.po_no", "o.status", "o.kind", "o.place_by::text", "o.expected_on::text", "o.note", "o.stage_at", "o.created_at", "o.updated_at",
      `(select count(*) ${IV})`, `(select string_agg(nullif(ii.invoice_no, ''), ', ' order by ii.id) ${IV})`, `(select sum(coalesce(ii.total, ii.subtotal)) ${IV})`,
      `(select min(ii.due_date)::text ${IV})`, `(select count(*) ${IV} and ii.file_parts > 0)`,
      "(select count(*) from jt.prep_order_lines l where l.order_id = o.id)",
      "(select coalesce(sum(l.qty_ordered), 0) from jt.prep_order_lines l where l.order_id = o.id)",
      "(select coalesce(sum(l.qty_received), 0) from jt.prep_order_lines l where l.order_id = o.id)",
      "(select sum(l.qty_ordered * coalesce(l.unit_cost, v.unit_cost)) from jt.prep_order_lines l left join jt.variants v on v.variant_id = l.variant_id where l.order_id = o.id)",
      `(select count(*) ${IL} and il.variant_id is null and il.match_how <> 'skip')`,
      `(select count(*) ${IL} and il.match_how like 'guess%')`,
      "(select string_agg(distinct coalesce(nullif(v.display_name, ''), v.product_title, '') || ' ' || coalesce(v.sku, ''), ' | ') from jt.prep_order_lines l join jt.variants v on v.variant_id = l.variant_id where l.order_id = o.id)",
      "(select count(*) from jt.prep_order_lines l where l.order_id = o.id and l.dest = 'prep')",
      `(select coalesce(sum(il.qty), 0) ${IL} and il.variant_id is not null)`,
      "(select count(*) from jt.prep_order_lines l where l.order_id = o.id and l.backorder and l.qty_received < l.qty_ordered)",
      "(select min(l.eta)::text from jt.prep_order_lines l where l.order_id = o.id and l.backorder and l.qty_received < l.qty_ordered)",
      `(select count(*) ${IV} and ii.paid_on is null)`, `(select min(ii.due_date)::text ${IV} and ii.paid_on is null)`, `(select sum(coalesce(ii.total, ii.subtotal)) ${IV} and ii.paid_on is null)`, "o.shopify_po_url",
      "(select coalesce(sum(l.qty_ordered), 0) from jt.prep_order_lines l where l.order_id = o.id and l.dest = 'prep')", "o.receive_into",
      "o.shopify_check->>'diffs'", "o.shopify_check is not null", "o.shopify_po_status",
      "(select count(distinct l.variant_id) from jt.prep_order_lines l where l.order_id = o.id and l.update_cost and l.qty_received > 0)"],
      "from jt.prep_orders o", "o.id", 2, refresh);
    S.orders = r.map(x => ({ id: x[0], vendor: x[1] || "", po: x[2] || "", status: x[3], kind: x[4] || "order", placeBy: x[5] || "", expected: x[6] || "", note: x[7] || "",
      stageAt: x[8] || {}, created: x[9], updated: x[10], nInv: +x[11], invNos: x[12] || "", invTotal: x[13] == null ? null : +x[13], due: x[14] || "", nFiles: +x[15],
      nLines: +x[16], units: +x[17], received: +x[18], cost: x[19] == null ? 0 : +x[19], unmatched: +x[20], guesses: +x[21], text: (x[22] || "").toLowerCase(), prepLines: +x[23],
      invoiced: +x[24], nBack: +x[25], backEta: x[26] || "", nUnpaid: +x[27] || 0, unpaidDue: x[28] || "", unpaidAmt: x[29] == null ? 0 : +x[29], shopifyUrl: x[30] || "", prepUnits: +x[31] || 0, into: x[32] || "", shopDiffs: x[34] ? +x[33] || 0 : null, shopStatus: x[35] || "", costsReady: +x[36] || 0 }))
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
    const iv = cur(ed); if (!iv) return;
    const my = ++pdfToken;
    const bytes = iv.file ? iv.file.bytes : iv.parts ? S.files.get(iv.id) : null;
    if (!bytes) { host.innerHTML = `<div class="muted small">${iv.parts ? "Loading the PDF…" : "No PDF on this invoice."}</div>`; return; }
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

  // ---------- the editor's model ----------
  // ed.lines    what's on the PO: {id, vid, asku, dest, qty (ordered), cost, received, backorder, eta, auto}
  //             (auto: added because an invoice had a product the PO didn't; follows that invoice's quantity)
  // ed.invoices each attached invoice: {id, no, date, due, total, terms, subtotal, fileName, parts, status, notes, file, raw, rows, filter, isNew}
  //   rows      the invoice's lines: {id, src: {item_code, upc, description, qty, unit_cost, amount}, vid, how, conf, alts, confirmed, skip, account, charge, qty, cost}
  // receiving happens right on the PO once it's invoiced (or partly received)
  const receiving = (ed) => !!ed.id && !ed.recv && ["invoiced", "partial"].includes(ed.status);
  // Receiving is against one invoice at a time (ed.rcvInv): each product starts at what that invoice billed and
  // hasn't come in yet, shared over the PO's lines for it. With no invoice picked, it's what's still open.
  const billed = (iv) => { const b = new Map(); for (const r of iv.rows) if (r.vid && !r.skip && isSure(r)) b.set(r.vid, (b.get(r.vid) || 0) + (Number(r.qty) || 0)); return b; };
  const invLeft = (iv) => { const out = new Map(); for (const [vid, q] of billed(iv)) out.set(vid, Math.max(0, q - ((iv.got && iv.got.get(vid)) || 0))); return out; };
  const invTot = (iv) => { let b = 0, g = 0; for (const [vid, q] of billed(iv)) { b += q; g += Math.min(q, (iv.got && iv.got.get(vid)) || 0); } return { b, g }; };
  const rcvIv = (ed) => ed.rcvInv ? ed.invoices.find(v => v.id === ed.rcvInv) || null : null;
  function pickRcvInv(ed) { const saved = ed.invoices.filter(v => v.id && !v.isNew); ed.rcvInv = ((saved.find(v => !v.recvAt && invTot(v).b > invTot(v).g)) || {}).id || ""; }
  function invAlloc(ed) {
    const iv = rcvIv(ed), out = new Map(); if (!iv) return out;
    const left = invLeft(iv), lastOf = new Map(); ed.lines.forEach(l => lastOf.set(l.vid, l.id));
    for (const l of ed.lines) {
      const have = left.get(l.vid) || 0; let give = Math.min(have, Math.max(0, (Number(l.qty) || 0) - (l.received || 0)));
      if (lastOf.get(l.vid) === l.id) give = have;
      left.set(l.vid, have - give); out.set(l.id, give);
    }
    return out;
  }
  const rqDef = (ed, l, p) => rcvIv(ed) ? invAlloc(ed).get(l.id) || 0 : ed.invoices.length ? p.toReceive : Math.max(0, p.ordered - p.received);
  const rqVal = (ed, l, p) => { const k = keyOf(l); return ed.rq && k in ed.rq ? ed.rq[k] : String(rqDef(ed, l, p)); };
  const newDest = (ed) => ed.dest === "both" ? ed.addTo || "shopify" : ed.dest === "prep" ? "prep" : "shopify";
  const DESTN = { shopify: "Shopify store", prep: "Prep center" };
  // two lines for the same product and place become one
  function mergeLines(ed) {
    const by = new Map(), out = [];
    for (const l of ed.lines) {
      const k = keyOf(l), a = by.get(k);
      if (!a) { by.set(k, l); out.push(l); continue; }
      a.qty = String((Number(a.qty) || 0) + (Number(l.qty) || 0)); a.received = (a.received || 0) + (l.received || 0);
      if (a.cost === "") a.cost = l.cost; a.backorder = a.backorder || l.backorder; if (l.eta > a.eta) a.eta = l.eta; a.auto = a.auto && l.auto;
    }
    ed.lines = out;
    if (ed.splitTot) for (const vid of Object.keys(ed.splitTot)) if (out.filter(l => l.vid === vid).length < 2) delete ed.splitTot[vid];
  }
  const keyOf = (l) => l.vid + "|" + (l.dest === "prep" ? l.asku || "" : "") + "|" + (l.dest || "prep");
  const variant = (vid) => vid && S.byVid ? S.byVid.get(String(vid)) : null;
  const cur = (ed) => ed.cur >= 0 ? ed.invoices[ed.cur] || null : null;
  function blankEd() {
    return { id: null, status: "draft", vendor: "", po: "", kind: "order", placeBy: "", expected: "", note: "", shortOk: false, shopifyUrl: "", shopCheck: null, shopAll: false, stageAt: {}, created: null, shipments: [],
      lines: [], invoices: [], cur: -1, removed: [], dest: "shopify", addTo: "shopify", split: null, add: "", recv: null, confirm: false, dirty: false, search: null, showPdf: false, boPrompt: false };
  }
  const blankInv = () => ({ id: null, no: "", date: "", due: "", total: null, terms: "", subtotal: null, fileName: "", parts: 0, status: "draft", notes: "", file: null, raw: null, rows: [], filter: "all", isNew: true,
    paidOn: "", payMethod: "", payRef: "", paidFrom: "", paidAmount: null, recvAt: "", recvManual: false, got: new Map() });
  async function openPO(id, keep) {
    if (!id) { S.ed = Object.assign(blankEd(), keep || {}); render(); catalog().then(render).catch(() => {}); return; }
    S.ed = null; S.busy = "Opening the purchase order…"; render();
    try {
      await catalog();
      const [h, ol, sh, ivs, lp] = await Promise.all([
        JT.rows(["o.id::text", "o.vendor", "o.po_no", "o.status", "o.kind", "o.place_by::text", "o.expected_on::text", "o.note", "o.short_ok", "o.stage_at", "o.created_at", "o.created_by", "o.shopify_po_url", "o.receive_into", "o.shopify_check", "o.shopify_received_at::text", "o.shopify_received_by",
          "(select max(seen_at) from jt.variants)::text", "o.shopify_po_status", "o.shopify_po_status_at::text",
          "(select value::text from jt.settings where key = 'shopify_po_api')"],
          `from jt.prep_orders o where o.id = ${JT.int(id)}`, true),
        JT.rows(["variant_id::text", "amazon_sku", "dest", "qty_ordered", "qty_received", "unit_cost", "backorder", "eta::text", "update_cost", "cost_applied", "cost_applied_at::text"], `from jt.prep_order_lines where order_id = ${JT.int(id)} order by variant_id`, true),
        JT.rows(["id::text", "name", "status"], `from jt.prep_shipments where order_id = ${JT.int(id)}`, true),
        JT.rows(["i.id::text", "i.invoice_no", "i.invoice_date::text", "i.subtotal", "i.file_name", "i.file_parts", "i.status", "i.notes", "i.due_date::text", "i.total", "i.terms",
          "i.paid_on::text", "i.pay_method", "i.pay_ref", "i.paid_from", "i.paid_amount", "i.received_at::text", "i.received_manual"],
          `from jt.invoices i where i.order_id = ${JT.int(id)} or i.id = (select invoice_id from jt.prep_orders where id = ${JT.int(id)}) order by i.id`, true),
        // how this vendor was paid last time (for Mark paid)
        JT.rows(["i.pay_method", "i.paid_from"], `from jt.invoices i where i.vendor = (select vendor from jt.prep_orders where id = ${JT.int(id)}) and i.pay_method <> '' order by i.paid_on desc nulls last, i.id desc limit 1`, true),
      ]);
      if (!h[0]) throw { code: "tool_error", message: "That purchase order no longer exists." };
      const x = h[0], ed = blankEd();
      Object.assign(ed, { id: x[0], vendor: x[1] || "", po: x[2] || "", status: x[3], kind: x[4] || "order", placeBy: x[5] || "", expected: x[6] || "", note: x[7] || "", shortOk: !!x[8],
        stageAt: x[9] || {}, created: x[10], createdBy: x[11] || "", shopifyUrl: x[12] || "", into: x[13] || "", shopCheck: x[14] || null, shopRecvAt: x[15] || "", shopRecvBy: x[16] || "", stockSyncedAt: x[17] || "", shopStatus: x[18] || "", shopStatusAt: x[19] || "", poApi: (() => { try { return x[20] ? JSON.parse(x[20]) : null; } catch (_) { return null; } })(), shipments: sh.map(s => ({ id: s[0], name: s[1], status: s[2] })) });
      ed.lines = ol.map(([vid, asku, dest, qo, qr, uc, bo, eta, upd, ca, cat]) => ({ id: newId(), vid, asku: asku || "", dest: dest || "prep", qty: String(+qo), cost: fmtCost(uc), received: +qr || 0, backorder: !!bo, eta: eta || "", auto: false,
        upd: !!upd, costApplied: ca == null ? null : +ca, costAppliedAt: cat || "" }));
      ed.invoices = ivs.map(v => ({ ...blankInv(), id: v[0], no: v[1] || "", date: v[2] || "", subtotal: v[3] == null ? null : +v[3], fileName: v[4] || "", parts: +v[5] || 0, status: v[6] || "draft",
        notes: v[7] || "", due: v[8] || "", total: v[9] == null ? null : +v[9], terms: v[10] || "", isNew: false,
        paidOn: v[11] || "", payMethod: v[12] || "", payRef: v[13] || "", paidFrom: v[14] || "", paidAmount: v[15] == null ? null : +v[15], recvAt: v[16] || "", recvManual: !!v[17] }));
      ed.lastPay = lp[0] ? { method: lp[0][0] || "", from: lp[0][1] || "" } : null;
      if (ed.invoices.length) {
        const il = await JT.rows(["invoice_id::text", "line_no", "item_code", "upc", "description", "qty", "unit_cost", "amount", "variant_id::text", "match_how", "account"],
          `from jt.invoice_lines where invoice_id in (${ed.invoices.map(v => JT.int(v.id)).join(",")}) order by invoice_id, line_no`, true);
        const byId = new Map(ed.invoices.map(v => [v.id, v]));
        for (const l of il) {
          const iv = byId.get(l[0]); if (!iv) continue;
          const hw = howFromSaved(l[8] ? l[9] : "");
          iv.rows.push({ id: newId(), src: { item_code: l[2] || "", upc: l[3] || "", description: l[4] || "", qty: l[5] == null ? null : +l[5], unit_cost: l[6] == null ? null : +l[6], amount: l[7] == null ? null : +l[7] },
            vid: l[8] || null, how: hw.how, conf: hw.conf, alts: [], confirmed: false, skip: l[9] === "skip", account: l[10] || "inventory",
            qty: l[5] == null ? "" : String(+l[5]), cost: fmtCost(l[6]) });
        }
        for (const iv of ed.invoices) for (const r of iv.rows) if (needsCheck(r)) r.alts = guessLine(r.src, ed.vendor).alts;
        const rc = await JT.rows(["invoice_id::text", "variant_id::text", "qty"], `from jt.invoice_receipts where invoice_id in (${ed.invoices.map(v => JT.int(v.id)).join(",")})`, true).catch(() => []);
        for (const [iid, vid, q] of rc) { const iv = byId.get(iid); if (iv) iv.got.set(vid, +q || 0); }
        ed.cur = ed.invoices.length - 1;
      }
      const dests = new Set(ed.lines.map(l => l.dest));
      ed.dest = dests.size > 1 || ed.into === "both" ? "both" : dests.size === 1 ? [...dests][0] : ed.into || "shopify";
      pickRcvInv(ed);
      ed.showPdf = window.innerWidth >= 1100 && !!(cur(ed) && cur(ed).parts);
      S.ed = ed; S.busy = "";
      if (cur(ed) && cur(ed).parts) loadFile(cur(ed)).then(() => { if (S.ed === ed) { const h2 = $("pe-pdf"); if (h2) h2.innerHTML = ""; renderPdf(); } }).catch(() => {});
    } catch (e) { S.busy = ""; S.ed = null; note("bad", esc(JT.message(e))); }
    render();
  }

  // ---------- where each line stands ----------
  // invoiced: the product's quantity on the order's invoices (matched lines only), shared out over the PO's lines for
  // that product in order. open = ordered - max(invoiced, received): still to come on a later invoice.
  function invoicedBy(ed) {
    const out = new Map();
    for (const iv of ed.invoices) for (const r of iv.rows) if (r.vid && !r.skip && isSure(r)) out.set(r.vid, (out.get(r.vid) || 0) + (Number(r.qty) || 0));
    return out;
  }
  function progress(ed) {
    const inv = invoicedBy(ed), left = new Map(inv), out = new Map();
    const lastOf = new Map(); ed.lines.forEach(l => lastOf.set(l.vid, l.id));
    for (const l of ed.lines) {
      const ordered = Number(l.qty) || 0, rec = l.received || 0;
      let give = Math.min(ordered, left.get(l.vid) || 0); if (lastOf.get(l.vid) === l.id) give = left.get(l.vid) || 0;
      left.set(l.vid, (left.get(l.vid) || 0) - give);
      const open = Math.max(0, ordered - Math.max(give, rec));
      let st;
      if (ordered > 0 && rec >= ordered) st = ["Received", "ok"];
      else if (open === 0) st = rec > 0 ? ["Partly received", "manual"] : give > 0 ? ["Invoiced", "manual"] : ["—", "pos"];
      else if (l.backorder) st = [`Backordered${l.eta ? " · ETA " + shortDate(l.eta) : ""}`, "warn"];
      else st = [give > 0 || rec > 0 ? "Rest on order" : "On order", "pos"];
      out.set(l.id, { ordered, invoiced: give, received: rec, open, st, toReceive: Math.max(0, Math.min(ordered, Math.max(give, 0)) - rec) });
    }
    return out;
  }
  // keep the PO in step with its invoices: an invoiced product the PO doesn't have gets a line; lines added that way
  // follow the invoice and go away with it; a PO line without a cost takes the invoice's
  function syncLines(ed) {
    const inv = invoicedBy(ed);
    const firstRow = (vid) => { for (const iv of ed.invoices) for (const r of iv.rows) if (r.vid === vid && !r.skip && isSure(r)) return r; return null; };
    for (const [vid, q] of inv) if (!ed.lines.some(l => l.vid === vid)) {
      const r = firstRow(vid);
      ed.lines.push({ id: newId(), vid, asku: "", dest: newDest(ed), qty: String(q), cost: r ? r.cost : "", received: 0, backorder: false, eta: "", auto: true });
    }
    ed.lines = ed.lines.filter(l => !l.auto || inv.has(l.vid) || l.received);
    for (const l of ed.lines) {
      if (l.auto && inv.has(l.vid)) l.qty = String(inv.get(l.vid));
      if (l.cost === "") { const r = firstRow(l.vid); if (r && r.cost !== "") l.cost = r.cost; }
    }
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
        const same = inv.po_no && S.orders.find(o => o.status !== "complete" && norm(o.po) === norm(inv.po_no) && (!inv.vendor || !o.vendor || o.vendor.toLowerCase() === inv.vendor.toLowerCase()));
        if (same) { S.busy = ""; await openPO(same.id); ed = S.ed; msg = `This invoice's PO # matches <b>${esc(same.vendor)} ${esc(poLabel(same.po))}</b>, so it was added to that order. `; S.busy = "Reading " + file.name + "…"; }
        else { ed = blankEd(); S.ed = ed; }
      }
      const dupHere = inv.invoice_no ? ed.invoices.findIndex(v => v.no && v.no.toLowerCase() === inv.invoice_no.toLowerCase()) : -1;
      if (dupHere >= 0) { S.busy = ""; ed.cur = dupHere; render(); note("warn", `Invoice <b>${esc(inv.invoice_no)}</b> is already on this purchase order.`); return; }
      // an invoice with this number that was already saved: use it (its lines are replaced), unless another order has it
      let reuse = null;
      if (inv.invoice_no && (inv.vendor || ed.vendor)) {
        const d = await JT.rows(["i.id::text", "i.status", "coalesce(i.order_id, (select o.id from jt.prep_orders o where o.invoice_id = i.id limit 1))::text"],
          `from jt.invoices i where lower(i.vendor) = lower(${JT.q(inv.vendor || ed.vendor)}) and lower(i.invoice_no) = lower(${JT.q(inv.invoice_no)})`, true);
        if (d[0] && d[0][2] && d[0][2] !== ed.id) {
          S.busy = ""; if (!intoEd) S.ed = null; render();
          note("warn", `Invoice <b>${esc(inv.invoice_no)}</b> from ${esc(inv.vendor || ed.vendor)} is already on another purchase order. <button class="mini" data-po-open="${esc(d[0][2])}">Open it</button>`);
          return;
        }
        if (d[0]) reuse = d[0][0];
      }
      const iv = merge(ed, inv, f, rows, reuse);
      S.busy = "";
      const c = count(iv), open = [...progress(ed).values()].filter((p, i) => p.open > 0 && !ed.lines[i].backorder).length;
      msg += !rows.length ? "This PDF has no text in it (it's probably a scan or photo), so no lines could be read. Add them with <b>Add line</b>."
        : !inv.lines.length ? "No item lines were recognised in this PDF. The PDF is shown alongside; add what's missing by hand."
        : `Read ${inv.lines.length} line${inv.lines.length === 1 ? "" : "s"}: ${c.sure} matched${c.check ? `, <b>${c.check} guess${c.check === 1 ? "" : "es"} to check</b>` : ""}${c.none ? `, <b>${c.none} not matched</b>` : ""}.`
          + (open && ed.lines.length ? ` ${open} product${open === 1 ? " on the PO isn't" : "s on the PO aren't"} on this invoice — mark them backordered below, or leave them on order.` : "")
          + " Nothing is saved until you press Save.";
      note(c.none || c.check || !inv.lines.length ? "warn" : "info", msg);
    } catch (e) {
      console.error("[JT] invoice read failed", e); S.busy = "";
      note("bad", "Couldn't read that PDF" + (e && e.message ? ": " + esc(e.message) : "") + ".");
    }
    render();
  }
  // A parsed invoice becomes one of the PO's invoices; its products are matched and the PO lines follow.
  function merge(ed, p, f, rawRows, reuse) {
    if (!ed.vendor && p.vendor) ed.vendor = p.vendor;
    if (!ed.po && p.po_no) ed.po = p.po_no;
    const iv = { ...blankInv(), id: reuse || null, no: p.invoice_no || "", date: p.invoice_date || "", subtotal: p.subtotal, total: p.total, due: p.due_date || "", terms: p.terms || "",
      fileName: f.name, file: f, raw: rawRows, isNew: true };
    for (const l of p.lines) {
      const src = { item_code: l.item_code || "", upc: l.upc || "", description: l.description || "", qty: l.qty, unit_cost: l.unit_cost, amount: l.amount };
      const g = guessLine(src, ed.vendor);
      // a guess that lands on a product already on the PO settles it
      const onPO = g.vid && ed.lines.some(x => x.vid === g.vid);
      const skip = !g.vid && NONPRODUCT.test(src.description + " " + src.item_code);
      iv.rows.push({ id: newId(), src, vid: g.vid, how: g.how, conf: g.conf, alts: g.alts, confirmed: !!onPO, skip,
        account: skip && FREIGHT.test(src.description + " " + src.item_code) ? "inbound_shipping" : "inventory",
        qty: l.qty == null ? "" : String(Math.round(l.qty * 100) / 100), cost: fmtCost(l.unit_cost) });
    }
    for (const c of p.charges || []) iv.rows.push(chargeRow(c.label, c.amount, c.kind));
    ed.invoices.push(iv); ed.cur = ed.invoices.length - 1;
    syncLines(ed);
    ed.dirty = true; ed.showPdf = window.innerWidth >= 1100; ed.boPrompt = true;
    const h = $("pe-pdf"); if (h) h.innerHTML = "";
    return iv;
  }
  function chargeRow(label, amount, account) {
    return { id: newId(), src: { item_code: "", upc: "", description: label || "Freight", qty: 1, unit_cost: amount, amount }, vid: null, how: "", conf: "", alts: [], confirmed: false,
      skip: true, account: account || "inbound_shipping", charge: true, qty: "1", cost: fmtCost(amount) };
  }
  const rowAmt = (r) => { const q = Number(r.qty) || 0, c = r.cost === "" ? (variant(r.vid) || {}).cost : Number(r.cost);
    return r.src && r.src.amount != null && String(r.src.qty) === String(Number(r.qty)) && String(r.src.unit_cost) === String(Number(r.cost)) ? r.src.amount : q * (c || 0); };
  const lineAmt = (l) => (Number(l.qty) || 0) * (l.cost === "" ? (variant(l.vid) || {}).cost || 0 : Number(l.cost) || 0);
  // what a bill comes to, by QuickBooks account
  function byAccount(iv) {
    const out = new Map(ACCOUNTS.map(([k]) => [k, 0])); let all = 0;
    for (const r of iv.rows) { const a = rowAmt(r); out.set(r.account || "inventory", (out.get(r.account || "inventory") || 0) + a); all += a; }
    return { out, all: Math.round(all * 100) / 100 };
  }
  function count(iv) {
    const c = { sure: 0, check: 0, none: 0, skip: 0 };
    for (const r of iv.rows) { if (r.skip) c.skip++; else if (!r.vid) c.none++; else if (needsCheck(r)) c.check++; else c.sure++; }
    return c;
  }
  const allChecks = (ed) => ed.invoices.reduce((a, iv) => a + count(iv).check, 0);
  // re-guess every invoice line not picked or confirmed by hand (after the vendor changes)
  function reguess(ed) {
    for (const iv of ed.invoices) for (const r of iv.rows) {
      if (!r.src || r.skip || r.how === "manual" || r.confirmed) continue;
      Object.assign(r, guessLine(r.src, ed.vendor));
    }
    syncLines(ed);
  }

  // ---------- issues ----------
  const near = (a, b) => Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 0.001);
  // the PO: Incoming Inventory's checks, plus backorders
  function poIssues(ed) {
    const pr = progress(ed);
    const o = { id: ed.id, status: ed.status, vendor: ed.vendor, po: ed.po.trim(), expected: ed.expected, kind: ed.kind, placeBy: ed.placeBy, invoiceId: ed.invoices.length ? "yes" : null, inv: null,
      shortOk: ed.shortOk, stageAt: ed.stageAt, shipments: ed.shipments,
      lines: ed.lines.map(l => { const v = variant(l.vid) || {}, p = pr.get(l.id);
        return { key: l.id, vid: l.vid, pid: v.pid || "", title: v.title || "variant " + l.vid, ordered: p.ordered, received: p.received,
          unitCost: l.cost === "" ? null : Number(l.cost), shopCost: v.cost == null ? null : v.cost, dest: l.dest }; }) };
    const out = OI() ? OI().orderIssuesOf(o).filter(x => x.kind !== "invdiff" && x.kind !== "partial") : [];
    const bo = ed.lines.filter(l => l.backorder && pr.get(l.id).open > 0);
    const late = bo.filter(l => l.eta && l.eta < today());
    if (late.length) out.push({ lvl: "warn", kind: "eta", title: `${late.length} backorder${late.length === 1 ? " is" : "s are"} past the expected date`,
      text: late.slice(0, 4).map(l => `${esc((variant(l.vid) || {}).title || l.vid)} (ETA ${shortDate(l.eta)})`).join(" · ") + ". Chase the vendor and update the ETA.", fixes: [] });
    if (ed.status === "partial") {
      const short = ed.lines.filter(l => pr.get(l.id).received < pr.get(l.id).ordered && !l.backorder);
      if (short.length) out.push({ lvl: "warn", kind: "partial", title: `Partly received · ${short.length} product${short.length === 1 ? "" : "s"} still to come`,
        text: "If the rest is coming, mark it backordered (with an ETA if you have one). If the vendor won't send it, close the PO short — it moves to Received.",
        fixes: [{ label: "Mark them backordered", fix: "pbo" }, { label: "Close short", fix: "oshort" }] });
    }
    const unpaid = ed.invoices.filter(v => v.id && !v.paidOn), late2 = unpaid.filter(overdue);
    if (late2.length) out.push({ lvl: "warn", kind: "overdue", title: `${late2.length === 1 ? "Invoice " + esc(late2[0].no || "") + " is" : late2.length + " invoices are"} past due and not marked paid`,
      text: late2.map(v => `${esc(v.no || "invoice")}: due ${shortDate(v.due)}${v.total != null ? " · " + m(v.total) : ""}`).join(" · ") + ". Pay it, or mark it paid if it already was.",
      fixes: [{ label: "Mark paid", fix: "ppaid", arg: String(ed.invoices.indexOf(late2[0])) }] });
    if (ed.id && ed.status !== "draft" && !ed.shopifyUrl.trim()) out.push({ lvl: "info", kind: "noshopify", title: "Not linked to a Shopify PO",
      text: "Create the same PO in Shopify (Products → Purchase orders) and paste its link here, so the two stay in step.",
      fixes: [{ label: "Paste the link", fix: "focus", arg: "pe-shopify" }, { label: "Shopify purchase orders", href: `${ADMIN}/purchase_orders/new` }] });
    if (ed.shopCheck) { const sd = shopDiffs(ed); if (sd.n) out.push({ lvl: "warn", kind: "shopdiff", title: `Doesn't match the Shopify PO · ${sd.n} difference${sd.n === 1 ? "" : "s"}`,
      text: sd.rows.filter(r => r.kinds.length).slice(0, 3).map(r => esc(r.title) + ": " + r.kinds.map(k => SDIFF[k]).join(", ")).join(" · ") + (sd.n > 3 ? " · …" : ""),
      fixes: [{ label: "Show the differences", fix: "focus", arg: "pe-shopcheck" }] }); }
    else if (ed.id && ed.shopifyUrl.trim() && ed.lines.length) out.push({ lvl: "info", kind: "shopnocheck", title: "Linked to a Shopify PO — check that it matches",
      text: "Download the PO as a PDF in Shopify and upload it here; every product, quantity and cost is compared with this PO.", fixes: [{ label: "Upload the Shopify PO PDF", fix: "focus", arg: "pe-shopfile" }] });
    { const ready = costGroups(ed).filter(a => a.rec > 0), g = ready.length ? shopGate(ed) : null;
      if (ready.length) out.push({ lvl: "warn", kind: "costs", title: `${ready.length} new Shopify cost${ready.length === 1 ? " is" : "s are"} marked but not sent to Shopify yet`,
        text: g.block ? esc(g.text) + " — then press Apply to Shopify." : "Press Apply to Shopify to check the new costs and send them.",
        fixes: g.block ? [{ label: "Show me", fix: "focus", arg: "pe-costbar" }] : [{ label: "Apply to Shopify", fix: "papply" }] }); }
    if (ed.status === "received") out.push({ lvl: "info", kind: "toqb", title: "Received — enter the bills in QuickBooks",
      text: "Use the For QuickBooks box on each invoice, then mark this PO QB ready.", fixes: [{ label: "Mark QB ready", fix: "onext" }] });
    if (ed.status === "qb_ready") out.push(unpaid.length
      ? { lvl: "info", kind: "unpaid", title: `${unpaid.length} invoice${unpaid.length === 1 ? "" : "s"} not paid yet`, text: "Mark each invoice paid (with how it was paid) as the bills go out. Then mark the PO complete.",
          fixes: [{ label: "Mark paid", fix: "ppaid", arg: String(ed.invoices.indexOf(unpaid[0])) }] }
      : { lvl: "info", kind: "allpaid", title: "Every invoice is paid", text: "Nothing left to do on this PO.", fixes: [{ label: "Mark complete", fix: "onext" }] });
    const rank = { bad: 0, warn: 1, info: 2 };
    return out.sort((a, b) => rank[a.lvl] - rank[b.lvl]);
  }
  // one invoice: its lines and its money
  function invIssues(ed, iv) {
    const out = [], c = count(iv);
    if (c.check) out.push({ lvl: "warn", kind: "check", title: `${c.check} product${c.check === 1 ? " is a guess" : "s are guesses"} to check`,
      text: "Confirm each one or pick the right product. Until then it isn't counted as invoiced on the PO. Confirmed matches are remembered for this vendor.",
      fixes: [{ label: "Show them", fix: "pfilter", arg: "check" }, ...(iv.rows.some(r => needsCheck(r) && r.conf === "high") ? [{ label: "Confirm all Likely", fix: "pconfirmall" }] : [])] });
    if (c.none) out.push({ lvl: "warn", kind: "unmatched", title: `${c.none} line${c.none === 1 ? " isn't" : "s aren't"} matched to a Shopify product`,
      text: "Pick the product, or mark it not a product (freight, a fee).", fixes: [{ label: "Show them", fix: "pfilter", arg: "none" }] });
    if (iv.rows.length) {
      const ba = byAccount(iv), inv = ba.out.get("inventory") || 0;
      if (iv.total != null && !near(ba.all, iv.total)) out.push({ lvl: "warn", kind: "total", title: `Invoice lines add up to ${m(ba.all)}; the invoice total is ${m(iv.total)}`,
        text: `A difference of ${m(iv.total - ba.all)}. Usually a charge that wasn't read (freight, a fee, tax) or a line missed.`, fixes: [{ label: "Add charge", fix: "paddcharge" }, { label: "Show the PDF", fix: "ppdf" }] });
      else if (iv.total == null && iv.subtotal != null && !near(ba.all, iv.subtotal) && !near(inv, iv.subtotal)) out.push({ lvl: "warn", kind: "subtotal", title: `Lines add up to ${m(ba.all)}; the invoice subtotal is ${m(iv.subtotal)}`,
        text: "A line may not have been read, or a quantity or cost is off.", fixes: [{ label: "Show the PDF", fix: "ppdf" }] });
      if (iv.total == null) out.push({ lvl: "info", kind: "nototal", title: "No invoice total", text: "Enter it so the QuickBooks breakdown can be checked.", fixes: [{ label: "Enter it", fix: "focus", arg: "pe-invtotal" }] });
      if (overdue(iv)) out.push({ lvl: "warn", kind: "overdue", title: `Past due · was due ${shortDate(iv.due)}`, text: "Not marked paid yet.", fixes: [{ label: "Mark paid", fix: "ppaid", arg: String(ed.invoices.indexOf(iv)) }] });
      if (!iv.due) out.push({ lvl: "info", kind: "nodue", title: "No due date", text: "Enter the due date (or the terms) for the QuickBooks bill.", fixes: [{ label: "Enter it", fix: "focus", arg: "pe-invdue" }] });
    }
    const rank = { bad: 0, warn: 1, info: 2 };
    return out.sort((a, b) => rank[a.lvl] - rank[b.lvl]);
  }
  // list-level flags (without loading every order's lines)
  function listFlags(o) {
    const f = [];
    if (o.unmatched) f.push(["warn", `${o.unmatched} not matched`]);
    if (o.guesses) f.push(["warn", `${o.guesses} to check`]);
    if (["ordered", "invoiced"].includes(o.status) && o.expected && o.expected < today()) f.push(["warn", "late"]);
    if (ORDER.indexOf(o.status) >= 2 && !o.nInv) f.push(["warn", "no invoice"]);
    if (o.status === "draft" && o.kind === "booking" && o.placeBy && o.placeBy < today()) f.push(["warn", "past place-by"]);
    if (o.status !== "draft" && !o.shopifyUrl) f.push(["info", "not in Shopify"]);
    if (o.shopDiffs) f.push(["warn", `Shopify PO differs · ${o.shopDiffs}`]);
    else if (o.shopifyUrl && o.shopDiffs == null && o.status !== "draft") f.push(["info", "Shopify PO not checked"]);
    if (o.nBack) f.push([o.backEta && o.backEta < today() ? "warn" : "info", `${o.nBack} backordered${o.backEta ? " · ETA " + shortDate(o.backEta) : ""}`]);
    if (o.status === "partial" && !o.nBack) f.push(["info", "rest not backordered"]);
    if (o.nUnpaid && o.unpaidDue && o.unpaidDue < today()) f.push(["warn", "bill overdue"]);
    if (o.costsReady) f.push(["warn", `${o.costsReady} Shopify cost${o.costsReady === 1 ? "" : "s"} to apply`]);
    if (o.status === "received") f.push(["info", "enter in QuickBooks"]);
    if (o.status === "qb_ready" && !o.nUnpaid) f.push(["info", "all paid · complete it"]);
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
    const isOpen = (o) => o.status !== "complete";
    const cnt = (st) => all.filter(o => st === "open" ? isOpen(o) : st === "all" ? true : o.status === st).length;
    $("po-stage").innerHTML = [["open", "Open"], ...STAGES, ["all", "All"]].map(([k, n]) => `<button data-st="${k}" aria-pressed="${S.stage === k}">${n} <span class="cnt">${cnt(k)}</span></button>`).join("");
    const vs = [...new Set(all.map(o => o.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const vsel = $("po-vendor"); const want = ["all", ...vs].join("|");
    if (vsel.dataset.opts !== want) { vsel.innerHTML = `<option value="all">All vendors</option>` + vs.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(""); vsel.dataset.opts = want; vsel.value = vs.includes(S.vendor) ? S.vendor : "all"; }
    const open = all.filter(isOpen), out = all.filter(o => ["ordered", "invoiced", "partial"].includes(o.status));
    const flagged = open.filter(o => listFlags(o).some(f => f[0] !== "info"));
    const unpaid = all.filter(o => o.nUnpaid), overdueN = unpaid.filter(o => o.unpaidDue && o.unpaidDue < today()).length;
    $("po-kpis").innerHTML = [
      { l: "Open POs", v: n0(open.length), s: `${all.filter(o => o.status === "draft").length} draft · ${out.length} placed, not all received` },
      { c: "cost", l: "On order", v: m0(out.reduce((a, o) => a + o.cost * (o.units ? Math.max(0, o.units - o.received) / o.units : 1), 0)), s: `${n0(out.reduce((a, o) => a + Math.max(0, o.units - o.received), 0))} units to come, at cost` },
      { l: "Unpaid invoices", v: m0(unpaid.reduce((a, o) => a + o.unpaidAmt, 0)), s: `${n0(unpaid.reduce((a, o) => a + o.nUnpaid, 0))} invoice${unpaid.reduce((a, o) => a + o.nUnpaid, 0) === 1 ? "" : "s"}${overdueN ? ` · <b class="neg">${overdueN} PO${overdueN === 1 ? "" : "s"} overdue</b>` : ""}` },
      { l: "Backordered", v: n0(all.reduce((a, o) => a + o.nBack, 0)), s: "products still to come on open POs" },
      { l: "Needs attention", v: n0(flagged.length), s: flagged.length ? "late, unmatched lines, guesses, no invoice, overdue" : "nothing flagged" },
    ].map(k => `<div class="kpi ${k.c || ""}"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
    const q = S.q.trim().toLowerCase().replace(/^#/, "");
    const list = all.filter(o => (S.stage === "open" ? isOpen(o) : S.stage === "all" || o.status === S.stage) && (S.vendor === "all" || o.vendor === S.vendor)
      && (!q || [o.vendor, o.po, o.invNos, o.note, o.text].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => S.stage === "open" ? ORDER.indexOf(b.status) - ORDER.indexOf(a.status) || String(b.updated).localeCompare(String(a.updated)) : String(b.updated).localeCompare(String(a.updated)));
    const t = $("po-table");
    if (!S.orders) { t.innerHTML = `<tbody><tr><td class="l muted">${S.loading ? "Loading…" : ""}</td></tr></tbody>`; return; }
    t.innerHTML = `<thead><tr><th class="l">PO</th><th class="l">Vendor</th><th class="l">Stage</th><th>Products</th><th>Ordered</th><th>Invoiced</th><th>Received</th><th>Cost</th><th class="l">Invoices</th><th class="l">Dates</th><th class="l">Needs attention</th></tr></thead><tbody>${
      list.map(o => {
        const fl = listFlags(o), got = GOT.includes(o.status);
        const dates = o.status === "draft" && o.kind === "booking" && o.placeBy ? `place by ${shortDate(o.placeBy)}` : got ? `received ${when(o.stageAt.received)}` : o.expected ? `expected ${shortDate(o.expected)}` : `updated ${when(o.updated)}`;
        return `<tr class="po-row" data-po-open="${o.id}" tabindex="0"><td class="l"><b class="mono">${esc(o.po ? poLabel(o.po) : "#" + o.id)}</b>${o.kind === "booking" ? ' <span class="pill warn">Booking</span>' : ""}${o.shopifyUrl ? `<div><a class="small" href="${esc(shopUrl(o.shopifyUrl))}" target="_blank" rel="noopener">Shopify PO ↗</a>${o.shopDiffs === 0 ? ' <span class="pill ok" title="Checked against the Shopify PO">matches</span>' : ""}${o.shopStatus ? " " + shopStatusPill(o.shopStatus) : ""}</div>` : ""}</td>
          <td class="l">${esc(o.vendor || "—")}</td>
          <td class="l"><span class="pill ${PILL[o.status]}">${STAGE.get(o.status)}</span></td>
          <td>${n0(o.nLines)}<div class="meta">${!o.units ? esc({ shopify: "→ Shopify", prep: "→ Prep", both: "→ Both" }[o.into] || "") : o.prepUnits === 0 ? "→ Shopify" : o.prepUnits >= o.units ? "→ Prep" : `→ Both`}</div></td><td>${n0(o.units)}${o.units && o.prepUnits > 0 && o.prepUnits < o.units ? `<div class="meta">${n0(o.units - o.prepUnits)} Shopify · ${n0(o.prepUnits)} prep</div>` : ""}</td><td>${o.nInv ? n0(o.invoiced) : '<span class="dim">—</span>'}</td><td>${o.received ? n0(o.received) : '<span class="dim">—</span>'}</td><td>${m0(o.cost)}</td>
          <td class="l small">${o.nInv ? `<span class="mono">${esc(o.invNos || "invoice")}</span>${o.nInv > 1 ? ` <span class="pill manual">${o.nInv} invoices</span>` : ""}${o.nFiles ? ' <span class="pill pos" title="PDF attached">PDF</span>' : ""}${o.invTotal != null || o.due ? `<div class="meta">${o.invTotal != null ? m(o.invTotal) : ""}${o.nUnpaid && o.unpaidDue ? ` · due ${shortDate(o.unpaidDue)}` : ""}</div>` : ""}<div>${!o.nUnpaid ? '<span class="pill ok">Paid</span>' : o.unpaidDue && o.unpaidDue < today() ? `<span class="pill miss">${o.nUnpaid < o.nInv ? o.nUnpaid + " " : ""}Overdue</span>` : `<span class="pill warn">${o.nUnpaid < o.nInv ? o.nUnpaid + " " : ""}Unpaid</span>`}</div>` : '<span class="dim">—</span>'}</td>
          <td class="l small">${dates}</td>
          <td class="l">${fl.map(f => `<span class="pill ${f[0] === "info" ? "pos" : "miss"}">${esc(f[1])}</span>`).join("")}</td></tr>`;
      }).join("") || `<tr><td class="l muted" colspan="11">${S.stage === "open" && !q ? "No open purchase orders. Start one with New PO, then add the vendor's invoices to it." : "No purchase orders match."}</td></tr>`}</tbody>`;
  }

  // ---------- rendering: editor ----------
  function renderEditor() {
    const ed = S.ed; if (!ed) return;
    $("po-list-view").hidden = true; $("po-edit-view").hidden = false;
    const box = $("po-edit-view");
    const keep = document.activeElement && box.contains(document.activeElement) ? { id: document.activeElement.id, k: document.activeElement.dataset.k, f: document.activeElement.dataset.f, s: document.activeElement.selectionStart } : null;
    const ro = ed.status === "complete", got = GOT.includes(ed.status);
    const at = ORDER.indexOf(ed.status);
    const steps = STAGES.map(([k, n], i) => { const click = ed.id && !got && PRE.includes(k) && k !== ed.status && !ed.lines.some(l => l.received > 0);
      return `<${click ? "button" : "span"} class="step ${k === ed.status ? "on" : i < at ? "done" : ""}" ${click ? `data-pgo="${k}" title="Move to ${n}"` : ""}>${n}</${click ? "button" : "span"}>`; }).join('<span class="step-sep">→</span>');
    const pr = progress(ed), iss = S.cat ? poIssues(ed) : [];
    let tot = { ordered: 0, invoiced: 0, received: 0, open: 0, back: 0, cost: 0 };
    for (const l of ed.lines) { const p = pr.get(l.id); tot.ordered += p.ordered; tot.invoiced += p.invoiced; tot.received += p.received; tot.open += p.open; if (l.backorder) tot.back += p.open; tot.cost += lineAmt(l); }
    const openLines = ed.lines.filter(l => pr.get(l.id).open > 0 && !l.backorder);
    const vendorOpts = S.vendors.map(v => `<option value="${esc(v)}">`).join("");
    const found = !ro && !ed.recv && ed.add.trim() ? findProducts(ed.add) : [];
    const lbl = (l) => window.JTListingLabel ? window.JTListingLabel(l) : l.sku;
    const both = ed.dest === "both" || new Set(ed.lines.map(l => l.dest)).size > 1;
    const rcv = receiving(ed), anyInv = ed.invoices.length > 0;
    const NC = ed.recv || rcv ? 11 : 10;
    // a product split across the Shopify store and the prep center: its total on every part
    const splitTot = (l) => { const parts = ed.lines.filter(x => x.vid === l.vid); if (parts.length < 2) return "";
      const q = (x) => Number(x.qty) || 0, sum = parts.reduce((a, x) => a + q(x), 0), tot = ed.splitTot && ed.splitTot[l.vid] != null ? ed.splitTot[l.vid] : sum;
      const rec = parts.reduce((a, x) => a + (x.received || 0), 0), sh = parts.filter(x => x.dest === "shopify").reduce((a, x) => a + q(x), 0), pp = sum - sh;
      return `<div class="splittot"><span class="pill manual">Split</span> <b class="num">${n0(tot)}</b> total · ${n0(sh)} Shopify + ${n0(pp)} prep${rec ? ` · ${n0(rec)} received` : ""}${sum !== tot ? ` <span class="neg">· parts add to ${n0(sum)}</span>` : ""}</div>`; };
    // updating the Shopify cost from this PO: mark it here, apply in bulk (received units only)
    const costCell = (l, v, chg) => {
      const applied = l.costApplied != null ? `<div class="meta" title="Sent to Shopify ${esc(when(l.costAppliedAt))} — the average of everything on hand">Shopify set to ${m(l.costApplied)}</div>` : "";
      if (ro || ed.recv || l.cost === "" || !v) return applied;
      const differs = chg != null && Math.abs(chg) >= 0.0005 || (v.cost == null && l.cost !== "");
      if (!differs && !l.upd) return applied;
      return `<button class="mini updc ${l.upd ? "on" : ""}" data-pact="updc" data-k="${l.id}" aria-pressed="${l.upd}" title="${l.upd ? "Marked: apply it with Apply to Shopify (received units only)" : "Mark this cost to update Shopify"}">${l.upd ? "✓ Update Shopify" : "Update Shopify"}</button>${applied}`;
    };
    const canSplit = (l) => !ro && !ed.recv && (Number(l.qty) || 0) > 1;
    const canUnrecv = (l) => l.received > 0 && ed.id && !ed.recv && !["qb_ready", "complete"].includes(ed.status);
    const destSel = (l) => {
      const canPick = !ro && !(l.received > 0) && (!ed.recv || PRE.includes(ed.status) || true);
      if (!canPick) return l.dest === "shopify" ? '<span class="pill pos">Shopify store</span>' : `<span class="pill web">Prep center</span>${l.asku ? `<div class="meta mono">${esc(lbl((S.listings.get(l.vid) || []).find(x => x.sku === l.asku) || { sku: l.asku }))}</div>` : '<div class="meta">any ASIN</div>'}`;
      const ls = (S.listings.get(l.vid) || []).slice().sort((a, b) => a.units - b.units || String(a.asin).localeCompare(String(b.asin)));
      const val = l.dest === "shopify" ? "@shopify" : l.asku || "";
      if (both) return `<span class="seg sm dseg" role="group" aria-label="Where it goes"><button data-pdest="shopify" data-k="${l.id}" aria-pressed="${l.dest === "shopify"}">Shopify</button><button data-pdest="prep" data-k="${l.id}" aria-pressed="${l.dest === "prep"}">Prep</button></span>`
        + (l.dest === "prep" ? `<select class="inp sm" data-f="dest" data-k="${l.id}" style="width:auto;max-width:150px;margin-top:4px" aria-label="ASIN"><option value="" ${val === "" ? "selected" : ""}>any ASIN (assign later)</option>${ls.map(x => `<option value="${esc(x.sku)}" ${val === x.sku ? "selected" : ""} title="${esc(x.title || "")}">${esc(lbl(x))}</option>`).join("")}${l.asku && !ls.some(x => x.sku === l.asku) ? `<option selected value="${esc(l.asku)}">${esc(l.asku)}</option>` : ""}</select>` : "");
      return `<select class="inp sm" data-f="dest" data-k="${l.id}" style="width:auto;max-width:150px"><option value="@shopify" ${val === "@shopify" ? "selected" : ""}>Shopify store</option><option value="" ${val === "" ? "selected" : ""}>Prep center · any ASIN (assign later)</option>${ls.map(x => `<option value="${esc(x.sku)}" ${val === x.sku ? "selected" : ""} title="${esc(x.title || "")}">Prep · ${esc(lbl(x))}</option>`).join("")}${l.asku && !ls.some(x => x.sku === l.asku) ? `<option selected value="${esc(l.asku)}">Prep · ${esc(l.asku)}</option>` : ""}</select>`;
    };
    const lineRow = (l) => {
      const v = variant(l.vid), p = pr.get(l.id), badQ = l.qty !== "" && !(Number.isInteger(Number(l.qty)) && Number(l.qty) >= 0), badC = l.cost !== "" && !(Number(l.cost) >= 0);
      const chg = v && v.cost > 0 && l.cost !== "" && !isNaN(Number(l.cost)) ? (Number(l.cost) - v.cost) / v.cost : null;
      return `<tr data-line="${l.id}">
        <td class="l">${v ? `<a class="olink" href="${ADMIN}/products/${esc(v.pid)}/variants/${esc(v.vid)}" target="_blank" rel="noopener">${esc(v.title)}</a><div class="meta"><span class="mono">${esc(v.sku) || "no SKU"}</span>${v.vendor ? " · " + esc(v.vendor) : ""}${l.auto ? ' <span class="pill manual" title="On an invoice but not on the PO when it was placed">added from invoice</span>' : ""}</div>${splitTot(l)}` : `<span class="dim">variant ${esc(l.vid)} (not in the catalog)</span>`}</td>
        <td class="l small"><div class="forcell">${destSel(l)}${canSplit(l) ? `<button class="linkbtn small" data-pact="split" data-k="${l.id}" title="Send part to the Shopify store and part to the prep center">Split</button>` : ""}</div></td>
        <td>${!ro && !ed.recv ? `<input class="inp num sm ${badQ || p.ordered < p.received ? "bad" : ""}" data-f="qty" data-k="${l.id}" value="${esc(l.qty)}" inputmode="numeric" placeholder="0" style="width:64px">` : n0(p.ordered)}</td>
        <td>${p.invoiced ? n0(p.invoiced) : '<span class="dim">—</span>'}</td>
        <td>${p.received ? n0(p.received) : '<span class="dim">—</span>'}${canUnrecv(l) ? `<div><button class="linkbtn small" data-pact="unrecv1" data-k="${l.id}" title="Take some or all of these back off the received count">un-receive</button></div>` : ""}</td>
        ${ed.recv ? `<td><input class="inp num sm" data-f="recv" data-k="${l.id}" value="${esc(ed.recv[keyOf(l)] ?? "")}" inputmode="numeric" placeholder="0" style="width:64px"></td>` : ""}
        ${rcv ? `<td class="rcv">${p.ordered - p.received > 0 || p.toReceive > 0 ? (() => { const val = rqVal(ed, l, p), bad = val !== "" && !(Number.isInteger(Number(val)) && Number(val) >= 0);
            return `<div class="rq"><input class="inp num sm ${bad ? "bad" : ""}" data-f="rq" data-k="${l.id}" value="${esc(val)}" inputmode="numeric" placeholder="0" style="width:60px" aria-label="Quantity arrived"><button class="mini primary" data-pact="rq-go" data-k="${l.id}">Receive</button></div>`
              + (rcvIv(ed) ? (() => { const d = rqDef(ed, l, p); return d === 0 ? '<div class="meta">not on this invoice</div>' : val !== String(d) ? `<div class="meta warnt">invoice: ${n0(d)}</div>` : ""; })()
                : anyInv && !p.invoiced && !p.received ? '<div class="meta">not on an invoice yet</div>' : anyInv && val !== String(p.toReceive) ? `<div class="meta warnt">invoice: ${n0(p.toReceive)}</div>` : ""); })()
          : '<span class="pill ok">All in</span>'}</td>` : ""}
        <td class="l small"><span class="pill ${p.st[1]}">${esc(p.st[0])}</span>${p.open > 0 && (p.invoiced || p.received) ? `<div class="meta">${n0(p.open)} still to come</div>` : ""}</td>
        <td class="l small">${p.open > 0 && !ro ? `<label class="inline bo"><input type="checkbox" data-f="bo" data-k="${l.id}" ${l.backorder ? "checked" : ""}> backordered</label>${l.backorder ? `<input class="inp sm" type="date" data-f="eta" data-k="${l.id}" value="${esc(l.eta)}" aria-label="Expected arrival" style="width:auto">` : ""}` : l.eta && p.open > 0 ? shortDate(l.eta) : '<span class="dim">—</span>'}</td>
        <td>${!ro && !ed.recv ? `<input class="inp num sm ${badC ? "bad" : ""}" data-f="cost" data-k="${l.id}" value="${esc(l.cost)}" inputmode="decimal" placeholder="${v && v.cost != null ? v.cost.toFixed(2) : "cost"}" style="width:76px">${chg != null && Math.abs(chg) >= 0.0005 ? `<div class="meta ${chg > 0 ? "neg" : "pos"}">${pct(chg)} vs Shopify</div>` : ""}` : m(l.cost === "" ? v && v.cost : Number(l.cost))}${costCell(l, v, chg)}</td>
        <td>${m(lineAmt(l))}</td>
        <td class="nowrap">${!ro && !ed.recv && !(l.received > 0) ? `<button class="linkbtn small" data-pact="rmline" data-k="${l.id}" title="Take off the PO" aria-label="Remove line">✕</button>` : ""}</td></tr>${ed.split && ed.split.id === l.id ? splitRow(l) : ""}${ed.unrecv && ed.unrecv.id === l.id ? unrecvRow(l) : ""}`;
    };
    const unrecvRow = (l) => {
      const v = variant(l.vid) || {}, n = ed.unrecv.n, bad = n !== "" && !(Number.isInteger(Number(n)) && Number(n) > 0 && Number(n) <= l.received);
      return `<tr class="splitrow"><td colspan="${NC}" class="l"><div class="splitbox"><b>Un-receive ${esc(v.title || "this product")}</b>
        <label class="inline"><input id="pe-unrq" class="inp num sm ${bad ? "bad" : ""}" data-f="unrq" value="${esc(n)}" inputmode="numeric" style="width:64px"> of ${n0(l.received)} received</label>
        <span class="small muted">${l.dest === "prep" ? "They come back out of the prep center (refused if they already shipped out)." : "They come off this PO's received count (Shopify's own stock isn't changed)."}</span>
        <span class="dbtns"><button class="mini primary" data-pact="unrecv1-go" ${bad || S.busy ? "disabled" : ""}>Un-receive</button><button class="mini" data-pact="unrecv1-no">Cancel</button></span></div></td></tr>`;
    };
    const splitRow = (l) => {
      const sp = ed.split, v = variant(l.vid) || {}, ls = (S.listings.get(l.vid) || []).slice().sort((a, b) => a.units - b.units);
      return `<tr class="splitrow"><td colspan="${NC}" class="l"><div class="splitbox"><b>Split ${esc(v.title || "this product")}</b>
        <label class="inline"><input class="inp num sm" data-f="spS" value="${esc(sp.s)}" inputmode="numeric" style="width:64px"> to the Shopify store</label>
        <label class="inline"><input class="inp num sm" data-f="spP" value="${esc(sp.p)}" inputmode="numeric" style="width:64px"> to the prep center</label>
        <select class="inp sm" data-f="spA" style="width:auto;max-width:170px" aria-label="ASIN for the prep center part"><option value="">any ASIN (assign later)</option>${ls.map(x => `<option value="${esc(x.sku)}" ${sp.asku === x.sku ? "selected" : ""}>${esc(lbl(x))}</option>`).join("")}</select>
        <span class="dbtns"><button class="mini primary" data-pact="split-go">Split</button><button class="mini" data-pact="split-no">Cancel</button></span></div></td></tr>`;
    };
    const bucket = (d) => {
      const ls = ed.lines.filter(l => l.dest === d), u = ls.reduce((a, l) => a + (Number(l.qty) || 0), 0), c = ls.reduce((a, l) => a + lineAmt(l), 0);
      return `<tr class="bucket ${d}"><td colspan="${NC}" class="l"><b>→ ${DESTN[d]}</b><span class="muted small"> · ${ls.length} product${ls.length === 1 ? "" : "s"} · ${n0(u)} units · ${m(c)}</span></td></tr>`
        + (ls.map(lineRow).join("") || `<tr><td colspan="${NC}" class="l muted small">Nothing going here yet — switch products here in the first column, or Split one.</td></tr>`);
    };
    const lineRows = both ? bucket("shopify") + bucket("prep") : ed.lines.map(lineRow).join("");
    const destTot = (d) => { const ls = ed.lines.filter(l => l.dest === d); return [ls.reduce((a, l) => a + (Number(l.qty) || 0), 0), ls.reduce((a, l) => a + lineAmt(l), 0)]; };
    const iv = cur(ed);
    const pdfOn = !!(iv && ed.showPdf && (iv.file || iv.parts));
    box.innerHTML = `
      <div class="po-top">
        <div class="po-crumb"><button class="linkbtn" data-pact="back-list">← All purchase orders</button>${ed.dirty ? '<span class="pill warn">Unsaved changes</span>' : ed.id ? '<span class="muted small">All changes saved</span>' : ""}
          <span class="dbtns right"><button class="btn ${ed.dirty || !ed.id ? "primary" : ""}" data-pact="save" ${S.busy || (!ed.dirty && ed.id) || ed.recv ? "disabled" : ""} title="Save this purchase order (⌘S / Ctrl+S)">${S.busy === "Saving…" ? "Saving…" : ed.dirty || !ed.id ? "Save" : "Saved"}</button></span></div>
        <div class="po-head"><h2>${ed.id ? esc(ed.vendor || "Vendor order") + " · " + esc(ed.po ? poLabel(ed.po) : "#" + ed.id) : "New purchase order"}${ed.kind === "booking" ? ' <span class="pill warn">Booking</span>' : ""}</h2><span class="steps six seven">${steps}</span></div>
        ${ed.lines.length ? `<div class="po-sum">${[["Ordered", tot.ordered], ["Invoiced", tot.invoiced], ["Received", tot.received], ["On order", tot.open - tot.back], ["Backordered", tot.back]].map(([k, v]) => `<span><b class="num">${n0(v)}</b> ${k.toLowerCase()}</span>`).join("")}<span><b class="num">${m(tot.cost)}</b> at cost</span>${both ? ["shopify", "prep"].map(d => { const [u, c] = destTot(d); return `<span class="dchip ${d}">→ ${DESTN[d]} <b class="num">${n0(u)}</b> · ${m(c)}</span>`; }).join("") : ""}</div>` : ""}
      </div>
      <section class="panel">
        <div class="pmgrid">
          <label class="stack" for="pe-vendor">Vendor<input id="pe-vendor" class="inp" list="pe-vendors" value="${esc(ed.vendor)}" ${got ? "disabled" : ""} autocomplete="off" placeholder="Shopify vendor"><datalist id="pe-vendors">${vendorOpts}</datalist></label>
          <label class="stack" for="pe-po">PO #<input id="pe-po" class="inp mono" value="${esc(ed.po)}" ${ro ? "disabled" : ""}></label>
          <label class="stack">Type<span class="seg"><button data-pkind="order" aria-pressed="${ed.kind !== "booking"}" ${ed.status !== "draft" ? "disabled" : ""}>Order</button><button data-pkind="booking" aria-pressed="${ed.kind === "booking"}" ${ed.status !== "draft" ? "disabled" : ""}>Booking</button></span></label>
          ${ed.kind === "booking" ? `<label class="stack" for="pe-placeby">Place by<input id="pe-placeby" class="inp" type="date" value="${esc(ed.placeBy)}" ${ed.status !== "draft" ? "disabled" : ""}></label>` : ""}
          <label class="stack" for="pe-exp">Expected<input id="pe-exp" class="inp" type="date" value="${esc(ed.expected)}" ${ro ? "disabled" : ""}></label>
          <label class="stack" for="pe-shopify"><span>Shopify PO${ed.shopStatus ? " " + shopStatusPill(ed.shopStatus) : ""}${shopUrl(ed.shopifyUrl) && /^https:/.test(shopUrl(ed.shopifyUrl)) ? ` <a class="small" href="${esc(shopUrl(ed.shopifyUrl))}" target="_blank" rel="noopener">open ↗</a>` : ` <a class="small dim" href="${ADMIN}/purchase_orders" target="_blank" rel="noopener">Shopify POs ↗</a>`}</span><input id="pe-shopify" class="inp" value="${esc(ed.shopifyUrl)}" placeholder="optional · paste the link from Shopify" autocomplete="off"></label>
          <label class="stack" for="pe-dest">Receive into<select id="pe-dest" class="inp" ${ro ? "disabled" : ""}><option value="shopify" ${ed.dest === "shopify" ? "selected" : ""}>Shopify store</option><option value="prep" ${ed.dest === "prep" ? "selected" : ""}>Prep center (Amazon)</option><option value="both" ${both ? "selected" : ""}>Both — choose per product</option></select></label>
          <label class="stack" for="pe-note" style="grid-column:1 / -1">Note<input id="pe-note" class="inp" value="${esc(ed.note)}" ${ro ? "disabled" : ""} placeholder="e.g. ships in two drops"></label>
        </div>
      </section>
      ${shopCheckHtml(ed, ro)}
      ${iss.length ? `<section class="po-issues">${window.JTIssues.issuesHtml(iss)}</section>` : ""}
      <section class="panel po-lines">
        <div class="panel-head"><h2>Products on this PO</h2><span class="muted small">${receiving(ed) ? "receiving: enter what arrived for each product and press Receive — it starts from the invoice" : "what was ordered · receiving is against these"}</span></div>
        ${openLines.length && !ro && !ed.recv && ed.invoices.length ? `<div class="bobar ${ed.boPrompt ? "hot" : ""}"><span><b>${openLines.length} product${openLines.length === 1 ? "" : "s"}</b> ${openLines.length === 1 ? "isn't" : "aren't"} on an invoice yet (${n0(openLines.reduce((a, l) => a + pr.get(l.id).open, 0))} units).</span>
            <span class="dbtns"><label class="small" for="pe-boeta">Expected</label><input id="pe-boeta" class="inp sm" type="date" style="width:auto" aria-label="Expected arrival for the backorders (blank if unknown)">
            <button class="btn primary" data-pact="bo-all">Mark ${openLines.length === 1 ? "it" : "all " + openLines.length} backordered</button>${ed.boPrompt ? '<button class="btn" data-pact="bo-no">Keep on order</button>' : ""}</span></div>` : ""}
        ${rcvBar(ed)}
        ${costBar(ed, pr, ro)}
        ${ed.lines.length ? `<div class="tbl-wrap xl"><table class="prept po-t"><thead><tr><th class="l">Product</th><th class="l">For</th><th>Ordered</th><th>Invoiced</th><th>Received</th>${ed.recv ? "<th>Arrived now</th>" : rcv ? "<th>Receive</th>" : ""}<th class="l">Status</th><th class="l">Backorder · ETA</th><th>Unit cost</th><th>Ext.</th><th></th></tr></thead><tbody>${lineRows}</tbody></table></div>`
          : `<div class="muted small">No products yet. Add them below, or upload the vendor's invoice PDF.</div>`}
        ${!ro && !ed.recv ? `<div class="addbox">${both ? `<div class="row small">Add to <span class="seg sm"><button data-paddto="shopify" aria-pressed="${ed.addTo !== "prep"}">Shopify store</button><button data-paddto="prep" aria-pressed="${ed.addTo === "prep"}">Prep center</button></span></div>` : ""}<label class="stack" for="po-add">Add product<input id="po-add" class="inp mono" value="${esc(ed.add)}" placeholder="Shopify SKU, UPC, product name, ASIN or Amazon SKU" autocomplete="off"></label>
          ${ed.add.trim() ? `<div class="mres">${!S.cat ? '<span class="muted small">Loading the Shopify catalog…</span>' : found.map((x, i) => `<button data-padd="${i}"><b>${esc(x.v.title)}</b><br><span class="dim">${esc(x.v.sku)} · ${esc(x.v.vendor)}${x.asku ? " · for " + esc(x.asku) : ""} · cost ${m(x.v.cost)}</span></button>`).join("") || '<span class="muted small">No products match.</span>'}</div>` : ""}</div>` : ""}
        ${ed.confirm === "del" ? `<div class="note warn">Delete this purchase order and its draft invoices? Nothing has been received, so no stock changes. <span class="dbtns"><button class="mini primary" data-pact="do-del">Yes, delete</button><button class="mini" data-pact="no">Cancel</button></span></div>` : ""}
        ${ed.confirm === "unrecv" ? `<div class="note warn">Move this order back to invoiced? What was received into the prep center comes back out (refused if some of it already shipped out). <span class="dbtns"><button class="mini primary" data-pact="do-back">Yes, move it back</button><button class="mini" data-pact="no">Cancel</button></span></div>` : ""}
        ${ed.confirm === "short" ? `<div class="note warn">Close this PO short? What wasn't received is treated as not coming (ask the vendor for a credit if it was billed), and the PO moves to Received. <span class="dbtns"><button class="mini primary" data-pact="do-short">Yes, close it short</button><button class="mini" data-pact="no">Cancel</button></span></div>` : ""}
        ${ro ? `<div class="note info">This PO is complete, so its products and invoice lines are locked. Invoice payments can still be changed. Step it back to QB ready to change anything else.</div>` : ""}
        <div class="row po-foot"><span class="muted small">${ed.recv ? "Enter what arrived. It starts from what's invoiced and not yet received; anything else can be received too. Prep-center lines go into the prep center (pick the ASIN, or leave it on any ASIN and assign it later); Shopify-store lines are recorded." : `${n0(tot.ordered)} units · ${m(tot.cost)}`}</span>
          <span class="dbtns right">${footButtons(ed, got, ro)}</span></div>
      </section>
      ${invoicesHtml(ed, ro, pdfOn)}
      <input type="file" id="pe-file" accept=".pdf,application/pdf" hidden>`;
    if (keep) {
      const el = keep.id ? $(keep.id) : keep.k && keep.f ? box.querySelector(`[data-f="${keep.f}"][data-k="${keep.k}"]`) : null;
      if (el) { el.focus(); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.s); } catch (_) {} }
    }
    if (pdfOn && $("pe-pdf") && !$("pe-pdf").childElementCount) renderPdf();
    watchGate();
    { const bar = document.querySelector(".appbar"), top = box.querySelector(".po-top"), st = document.documentElement.style;
      if (bar) st.setProperty("--appbar-h", bar.offsetHeight + "px"); if (top) st.setProperty("--potop-h", top.offsetHeight + "px"); }
  }
  const recvPill = (v) => { if (v.isNew || !v.id) return ""; const t = invTot(v);
    return v.recvAt ? `<span class="pill ok" title="${v.recvManual ? "Marked received" : "Everything on it came in"}">Received</span>` : t.g > 0 ? `<span class="pill manual">${n0(t.g)} of ${n0(t.b)} in</span>` : ""; };
  // which invoice the Receive column is working from
  function rcvBar(ed) {
    if (!receiving(ed)) return "";
    const saved = ed.invoices.filter(v => v.id && !v.isNew); if (!saved.length) return "";
    const iv = rcvIv(ed), t = iv && invTot(iv), back = ed.lines.filter(l => l.backorder && (Number(l.qty) || 0) > (l.received || 0));
    return `<div class="bobar rcvbar"><span><label class="small" for="pe-rcvinv"><b>Receiving against</b></label>
      <select id="pe-rcvinv" class="inp sm" style="width:auto">${saved.map(v => { const x = invTot(v); return `<option value="${esc(v.id)}" ${v.id === ed.rcvInv ? "selected" : ""}>Invoice ${esc(v.no || v.id)} — ${v.recvAt ? "received" : `${n0(x.g)} of ${n0(x.b)} in`}</option>`; }).join("")}<option value="" ${!ed.rcvInv ? "selected" : ""}>No invoice (what's still open)</option></select>
      <span class="small muted">${iv ? (iv.recvAt ? "This invoice is received in full." : `${n0(t.b - t.g)} units on this invoice still to come in.`) : "Quantities start from what's still open on the PO."}${back.length ? ` The PO stays open for ${back.length} backordered product${back.length === 1 ? "" : "s"}.` : ""}</span></span></div>`;
  }
  function invoicesHtml(ed, ro, pdfOn) {
    const iv = cur(ed);
    const chips = ed.invoices.map((v, i) => { const c = count(v), bad = c.check + c.none;
      return `<button class="ivchip" data-inv="${i}" aria-pressed="${i === ed.cur}"><b>${esc(v.no || "Invoice " + (i + 1))}</b><span>${v.total != null ? m(v.total) : v.subtotal != null ? m(v.subtotal) : ""}${v.due ? " · due " + shortDate(v.due) : ""}</span>${bad ? `<span class="pill miss">${bad} to check</span>` : ""}${recvPill(v)}${v.isNew ? '<span class="pill warn">new</span>' : v.paidOn ? '<span class="pill ok">Paid</span>' : overdue(v) ? '<span class="pill miss">Overdue</span>' : '<span class="pill warn">Unpaid</span>'}</button>`; }).join("");
    const head = `<div class="panel-head"><h2>Invoices</h2><span class="muted small">${ed.invoices.length ? `${ed.invoices.length} on this PO` : "none yet"} · a vendor can bill in parts</span>${!ro ? `<label class="btn ${ed.invoices.length ? "" : "primary"} right" for="pe-file">Upload invoice PDF</label>` : ""}</div>
      <div class="ivchips">${chips}${!ro ? `<label class="ivchip add" for="pe-file"><b>+ Add invoice</b><span>upload the PDF or drop it here</span></label>` : ""}</div>`;
    if (!iv) return `<section class="panel po-inv" id="pe-drop">${head}</section>`;
    const lock = ro || iv.status === "applied", c = count(iv);
    const rows = iv.rows.filter(r => iv.filter === "all" || (iv.filter === "none" ? !r.vid && !r.skip : iv.filter === "check" ? needsCheck(r) : true));
    const FILT = [["all", `All ${iv.rows.length}`], ["check", `Guesses to check ${c.check}`], ["none", `Not matched ${c.none}`]];
    const iss = invIssues(ed, iv);
    const rowsH = rows.map(r => {
      const badQ = r.qty !== "" && isNaN(Number(r.qty)), badC = r.cost !== "" && !(Number(r.cost) >= 0);
      const cls = r.skip ? "skipped" : !r.vid ? "nomatch" : needsCheck(r) ? "guess" : "";
      return `<tr class="${cls}">
        <td class="l inv">${r.src.item_code ? `<span class="mono">${esc(r.src.item_code)}</span>` : ""}${r.src.upc ? ` <span class="mono dim small">${esc(r.src.upc)}</span>` : ""}<div class="small">${esc(r.src.description) || '<span class="dim">no description</span>'}</div><div class="meta">${r.charge ? "charge on the invoice" : `${r.src.qty ?? "?"} × ${m(r.src.unit_cost)} = ${m(r.src.amount)}`}</div></td>
        <td class="l match">${matchCell(ed, r, lock)}</td>
        <td>${!lock ? `<input class="inp num sm ${badQ ? "bad" : ""}" data-f="iqty" data-k="${r.id}" value="${esc(r.qty)}" inputmode="decimal" style="width:64px">` : esc(r.qty)}</td>
        <td>${!lock ? `<input class="inp num sm ${badC ? "bad" : ""}" data-f="icost" data-k="${r.id}" value="${esc(r.cost)}" inputmode="decimal" style="width:76px">` : m(Number(r.cost))}</td>
        <td>${m(rowAmt(r))}</td>
        <td class="l small">${!lock ? `<select class="inp sm" data-f="acct" data-k="${r.id}" style="width:auto;max-width:130px">${ACCOUNTS.map(([k, n]) => `<option value="${k}" ${(r.account || "inventory") === k ? "selected" : ""}>${n}</option>`).join("")}</select>` : esc(ACCT.get(r.account || "inventory"))}</td>
        <td>${!lock ? `<button class="linkbtn small" data-pact="rmrow" data-k="${r.id}" title="Remove this invoice line" aria-label="Remove line">✕</button>` : ""}</td></tr>`;
    }).join("");
    return `<section class="panel po-inv" id="pe-drop">${head}
      <div class="po-invbar"><span><b>Invoice ${esc(iv.no || "(no number)")}</b>${iv.date ? " · " + esc(shortDate(iv.date)) : ""}${iv.total != null ? " · " + m(iv.total) : ""}${iv.due ? " · due " + esc(shortDate(iv.due)) : ""}${iv.fileName ? ` · <span class="dim">${esc(iv.fileName)}</span>` : ""}${iv.status === "applied" ? ' <span class="pill ok" title="Applied on the Invoices tab: its lines are locked">Costs in Shopify</span>' : ""} ${iv.paidOn ? '<span class="pill ok">Paid</span>' : overdue(iv) ? '<span class="pill miss">Overdue</span>' : '<span class="pill warn">Unpaid</span>'}</span>
        <span class="dbtns">${iv.id && !iv.isNew && !ro ? (iv.recvAt ? `${recvPill(iv)}${iv.recvManual ? '<button class="mini" data-pact="inv-reopen" title="Take the received mark off this invoice">Reopen</button>' : ""}` : `${recvPill(iv)}<button class="mini" data-pact="inv-recvd" title="Count this invoice as received in full, e.g. the vendor shipped less than they billed">Mark received</button>`) : ""}${iv.file || iv.parts ? `<button class="mini" data-pact="pdf">${ed.showPdf ? "Hide PDF" : "Show PDF"}</button>` : ""}${!ro ? `<button class="mini" data-pact="rminv">Remove from PO</button>` : ""}</span></div>
      ${ed.confirm === "rminv" ? `<div class="note warn">Take invoice ${esc(iv.no || "")} off this PO? ${iv.id && iv.status === "applied" ? "It was applied on the Invoices tab, so it's only detached." : "It's deleted when you save."} Products added to the PO from it go too. <span class="dbtns"><button class="mini primary" data-pact="do-rminv">Yes, remove it</button><button class="mini" data-pact="no">Cancel</button></span></div>` : ""}
      <div class="pmgrid small-grid">
        <label class="stack" for="pe-invno">Invoice #<input id="pe-invno" class="inp mono" value="${esc(iv.no)}" ${lock ? "disabled" : ""}></label>
        <label class="stack" for="pe-invdate">Invoice date<input id="pe-invdate" class="inp" type="date" value="${esc(iv.date)}" ${lock ? "disabled" : ""}></label>
        <label class="stack" for="pe-invdue">Due date<input id="pe-invdue" class="inp" type="date" value="${esc(iv.due)}" ${ro ? "disabled" : ""}></label>
        <label class="stack" for="pe-invterms">Terms<input id="pe-invterms" class="inp" value="${esc(iv.terms)}" placeholder="e.g. Net 30" ${ro ? "disabled" : ""}></label>
        <label class="stack" for="pe-invsub">Subtotal<input id="pe-invsub" class="inp num" value="${iv.subtotal != null ? iv.subtotal.toFixed(2) : ""}" ${lock ? "disabled" : ""}></label>
        <label class="stack" for="pe-invtotal">Invoice total<input id="pe-invtotal" class="inp num" value="${iv.total != null ? iv.total.toFixed(2) : ""}" ${ro ? "disabled" : ""}></label>
      </div>
      ${payHtml(ed, iv)}
      ${qbHtml(ed, iv)}
      ${iss.length ? window.JTIssues.issuesHtml(iss) : ""}
      <div class="po-body ${pdfOn ? "with-pdf" : ""}">
        <div class="po-ivlines">
          <div class="panel-head"><h3 class="h3">Invoice lines</h3><div class="seg" role="group" aria-label="Show lines">${FILT.map(([k, t]) => `<button data-ifilter="${k}" aria-pressed="${iv.filter === k}">${t}</button>`).join("")}</div></div>
          ${iv.rows.length ? `<div class="tbl-wrap xl"><table class="prept po-t"><thead><tr><th class="l">On the invoice</th><th class="l">Shopify product</th><th>Qty</th><th>Unit cost</th><th>Ext.</th><th class="l">Account</th><th></th></tr></thead><tbody>${rowsH || '<tr><td class="l muted" colspan="7">No lines here.</td></tr>'}</tbody></table></div>` : '<div class="muted small">No lines on this invoice.</div>'}
          ${!lock ? `<div class="row"><button class="btn" data-pact="addrow">Add line</button><button class="btn" data-pact="addcharge">Add charge (freight in)</button><span class="muted small">Freight or shipping on the invoice goes to Inbound Shipping.</span></div>` : ""}
        </div>
        ${pdfOn ? `<aside class="po-pdf"><div class="panel-head"><h3 class="h3">Invoice PDF</h3><button class="mini" data-pact="pdf">Hide</button></div><div id="pe-pdf" class="pdfpages"></div></aside>` : ""}
      </div>
    </section>`;
  }
  function matchCell(ed, r, lock) {
    const v = variant(r.vid);
    if (ed.search && ed.search.id === r.id) {
      const res = findProducts(ed.search.q);
      return `<input class="inp" id="pe-sq" data-k="${r.id}" value="${esc(ed.search.q)}" placeholder="SKU, UPC, product words or Amazon SKU" autocomplete="off">
        <div class="mres">${ed.search.q.trim() ? res.map(x => `<button data-ppick="${esc(x.v.vid)}" data-k="${r.id}"><b>${esc(x.v.title)}</b><br><span class="dim">${esc(x.v.sku)} · ${esc(x.v.vendor)} · cost ${m(x.v.cost)}${x.v.status !== "ACTIVE" ? " · " + esc(x.v.status.toLowerCase()) : ""}</span></button>`).join("") || '<span class="muted small">No products match.</span>' : '<span class="muted small">Type to search the Shopify catalog.</span>'}</div>
        <div class="row"><button class="mini" data-pact="search-cancel">Cancel</button><button class="mini" data-pact="skip" data-k="${r.id}">Not a product</button></div>`;
    }
    if (r.skip) return `<span class="pill pos">${r.account === "inbound_shipping" ? "Charge · freight in" : "Not a product"}</span>${!lock ? ` <button class="linkbtn small" data-pact="unskip" data-k="${r.id}">it is a product</button>` : ""}<div class="meta">on the bill, not on the PO</div>`;
    if (!v) return r.vid ? `<span class="dim">variant ${esc(r.vid)} (not in the catalog)</span>` : `<span class="pill miss">Not matched</span> ${!lock ? `<button class="mini" data-pact="search" data-k="${r.id}">Find product</button> <button class="linkbtn small" data-pact="skip" data-k="${r.id}">not a product</button>` : ""}`;
    const sure = isSure(r);
    const chip = sure ? `<span class="pill conf-high" title="${esc(HOW[r.how] || "Matched")}">${esc(r.confirmed && !SURE.has(r.how) ? "Confirmed" : HOW[r.how] || "Matched")}</span>`
      : `<span class="pill conf-${r.conf === "low" ? "low" : "medium"}" title="Best guess from the product words — check it">${esc(r.how === "skupart" ? "Part of SKU" : "Guess · " + (CONF[r.conf] || "Unsure"))}</span>`;
    const alts = !lock && !sure && r.alts && r.alts.length ? `<select class="inp sm alts" data-f="alt" data-k="${r.id}" aria-label="Other guesses"><option value="">Other guesses (${r.alts.length})…</option>${r.alts.map(id => { const a = variant(id); return a ? `<option value="${a.vid}">${esc(a.title)} · ${esc(a.sku)}</option>` : ""; }).join("")}</select>` : "";
    return `<a class="olink" href="${ADMIN}/products/${esc(v.pid)}/variants/${esc(v.vid)}" target="_blank" rel="noopener">${esc(v.title)}</a>
      <div class="meta"><span class="mono">${esc(v.sku) || "no SKU"}</span>${v.vendor ? " · " + esc(v.vendor) : ""}${chip}</div>
      ${!lock ? `<div class="mrow">${!sure ? `<button class="mini primary" data-pact="confirm" data-k="${r.id}">Confirm</button>` : ""}${alts}<button class="linkbtn small" data-pact="search" data-k="${r.id}">${sure ? "change" : "search"}</button></div>` : ""}`;
  }
  // Paying the invoice: always editable (also on applied invoices and complete POs).
  function payHtml(ed, iv) {
    const amt = iv.total != null ? iv.total : iv.subtotal != null ? iv.subtotal : null;
    const diff = iv.paidOn && iv.paidAmount != null && amt != null && !near(iv.paidAmount, amt) ? iv.paidAmount - amt : null;
    return `<div class="pay ${iv.paidOn ? "paid" : overdue(iv) ? "late" : ""}"><div class="pay-head"><b>Payment</b>${iv.paidOn ? `<span class="pill ok">Paid ${esc(shortDate(iv.paidOn))}</span>` : overdue(iv) ? `<span class="pill miss">Overdue · due ${esc(shortDate(iv.due))}</span>` : `<span class="pill warn">Unpaid${iv.due ? " · due " + esc(shortDate(iv.due)) : ""}</span>`}
        <span class="dbtns">${iv.paidOn ? `<button class="mini" data-pact="unpay">Mark unpaid</button>` : `<button class="mini primary" data-pact="pay">Mark paid</button>`}</span></div>
      ${iv.paidOn || iv.payMethod || iv.payRef || iv.paidFrom ? `<div class="pmgrid small-grid">
        <label class="stack" for="pe-paidon">Paid on<input id="pe-paidon" class="inp" type="date" value="${esc(iv.paidOn)}"></label>
        <label class="stack" for="pe-paymethod">Paid by<select id="pe-paymethod" class="inp"><option value="" ${!iv.payMethod ? "selected" : ""}>—</option>${PAY.map(([k, n]) => `<option value="${k}" ${iv.payMethod === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="stack" for="pe-payref">Reference<input id="pe-payref" class="inp mono" value="${esc(iv.payRef)}" placeholder="${iv.payMethod === "check" ? "check no." : iv.payMethod === "credit_card" ? "last 4 / confirmation" : "confirmation no."}"></label>
        <label class="stack" for="pe-paidfrom">Paid from<input id="pe-paidfrom" class="inp" list="pe-payfroms" value="${esc(iv.paidFrom)}" placeholder="bank account or card"><datalist id="pe-payfroms">${[...new Set(ed.invoices.map(v => v.paidFrom).concat(ed.lastPay ? [ed.lastPay.from] : []).filter(Boolean))].map(v => `<option value="${esc(v)}">`).join("")}</datalist></label>
        <label class="stack" for="pe-paidamt">Amount paid<input id="pe-paidamt" class="inp num" value="${iv.paidAmount != null ? iv.paidAmount.toFixed(2) : ""}" inputmode="decimal" placeholder="${amt != null ? amt.toFixed(2) : ""}"></label>
      </div>${diff != null ? `<div class="meta ${diff < 0 ? "neg" : ""}">Paid ${m(iv.paidAmount)} against an invoice total of ${m(amt)} (${diff > 0 ? "+" : ""}${m(diff)}).</div>` : ""}` : ""}</div>`;
  }
  function markPaid(ed, iv) {
    iv.paidOn = iv.paidOn || today();
    if (iv.paidAmount == null) iv.paidAmount = iv.total != null ? iv.total : iv.subtotal != null ? iv.subtotal : iv.rows.length ? byAccount(iv).all : null;
    const prev = ed.invoices.find(v => v !== iv && v.payMethod) || null, lp = prev ? { method: prev.payMethod, from: prev.paidFrom } : ed.lastPay;
    if (!iv.payMethod && lp) { iv.payMethod = lp.method; if (!iv.paidFrom) iv.paidFrom = lp.from || ""; }
    ed.dirty = true;
  }
  // A bill as it goes into QuickBooks: header fields and one amount per account.
  function qbHtml(ed, iv) {
    if (!iv.rows.length) return "";
    const ba = byAccount(iv), diff = iv.total != null ? Math.round((iv.total - ba.all) * 100) / 100 : null;
    return `<div class="qb"><div class="qb-head"><b>For QuickBooks</b><span class="muted small">enter as a bill</span><button class="mini" data-pact="qbcopy">Copy</button></div>
      <dl class="qb-meta"><div><dt>Vendor</dt><dd>${esc(ed.vendor || "—")}</dd></div><div><dt>Bill no.</dt><dd class="mono">${esc(iv.no || "—")}</dd></div><div><dt>Bill date</dt><dd>${esc(iv.date || "—")}</dd></div>
        <div><dt>Due date</dt><dd>${esc(iv.due || "—")}</dd></div><div><dt>Terms</dt><dd>${esc(iv.terms || "—")}</dd></div>${ed.po ? `<div><dt>PO / memo</dt><dd class="mono">${esc(ed.po)}</dd></div>` : ""}<div><dt>Payment</dt><dd>${iv.paidOn ? esc(payTxt(iv)) : "Unpaid"}</dd></div></dl>
      <table class="qb-t"><thead><tr><th class="l">Account</th><th>Amount</th></tr></thead><tbody>${ACCOUNTS.map(([k, n]) => `<tr><td class="l">${n}</td><td>${m(ba.out.get(k) || 0)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td class="l">Total</td><td>${m(ba.all)}</td></tr>${diff != null ? `<tr class="${Math.abs(diff) >= 0.01 ? "off" : "ok"}"><td class="l">Invoice total</td><td>${m(iv.total)}${Math.abs(diff) >= 0.01 ? ` <span class="small">(${diff > 0 ? "+" : ""}${m(diff)} not assigned)</span>` : ' <span class="small">✓ matches</span>'}</td></tr>` : ""}</tfoot></table></div>`;
  }
  function qbText(ed, iv) {
    const ba = byAccount(iv);
    return [["Vendor", ed.vendor], ["Bill no.", iv.no], ["Bill date", iv.date], ["Due date", iv.due], ["Terms", iv.terms], ["Memo", ed.po ? poLabel(ed.po) : ""],
      ["Paid on", iv.paidOn], ["Payment method", PAYN.get(iv.payMethod) || ""], ["Payment ref.", iv.payRef], ["Paid from", iv.paidFrom], ["Amount paid", iv.paidAmount != null ? iv.paidAmount.toFixed(2) : ""]]
      .map(([k, v]) => k + "\t" + (v || "")).concat(ACCOUNTS.map(([k, n]) => n + "\t" + (ba.out.get(k) || 0).toFixed(2)), ["Total\t" + ba.all.toFixed(2)]).join("\n");
  }
  function footButtons(ed, got, ro) {
    const busy = S.busy ? "disabled" : "";
    if (ro) return `<button class="btn" data-pact="back">← Back to QB ready</button>${ed.dirty ? `<button class="btn primary" data-pact="save" ${busy}>Save</button>` : ""}`;
    if (ed.recv) return `<button class="btn" data-pact="recv-cancel">Cancel</button><button class="btn primary" data-pact="recv-go" ${busy}>Receive</button>`;
    const out = [];
    if (ed.id && PREV[ed.status]) out.push(`<button class="btn" data-pact="back">← Back to ${STAGE.get(PREV[ed.status]).toLowerCase()}</button>`);
    if (ed.id && PRE.includes(ed.status) && !ed.lines.some(l => l.received > 0)) out.push(`<button class="btn" data-pact="del">Delete</button>`);
    out.push(`<button class="btn ${ed.dirty && !NEXT[ed.status] ? "primary" : ""}" data-pact="save" ${busy}>Save</button>`);
    if (NEXT[ed.status]) out.push(`<button class="btn primary" data-pact="save-next" ${busy}>Save &amp; ${NEXT[ed.status][1].replace(/^M/, "m")}</button>`);
    if (receiving(ed) && ed.lines.length) { const pr = progress(ed), u = ed.lines.reduce((a, l) => { const v = Number(rqVal(ed, l, pr.get(l.id))); return a + (Number.isInteger(v) && v > 0 && (pr.get(l.id).ordered - pr.get(l.id).received > 0 || pr.get(l.id).toReceive > 0) ? v : 0); }, 0);
      out.push(`<button class="btn primary" data-pact="rq-all" ${busy || !u ? "disabled" : ""}>Receive all${u ? ` (${n0(u)} units)` : ""}</button>`); }
    else if (ed.lines.length && !["qb_ready", "complete"].includes(ed.status)) out.push(`<button class="btn" data-pact="recv" ${busy}>${got ? "Receive more…" : "Receive…"}</button>`);
    if (ed.status === "partial") out.push(`<button class="btn" data-pact="short" ${busy}>Close short</button>`);
    if (got && ed.lines.some(l => l.dest === "prep" && l.received > 0)) out.push(`<button class="btn" data-pact="amzship">Create Amazon shipment</button>`);
    return out.join("");
  }

  // ---------- saving ----------
  function bodyOf(ed) {
    const lineOf = (vid) => ed.lines.find(l => l.vid === vid);
    const lines = ed.lines.map(l => ({ variant_id: Number(l.vid), amazon_sku: l.dest === "prep" ? l.asku || "" : "", dest: l.dest || "prep", qty: Number(l.qty) || 0,
      unit_cost: l.cost === "" ? null : Number(l.cost), backorder: !!l.backorder, eta: l.backorder ? l.eta || "" : "", update_cost: !!l.upd }));
    const invoices = ed.invoices.map(iv => ({ id: iv.id ? Number(iv.id) : null, vendor: ed.vendor.trim(), invoice_no: iv.no || "", invoice_date: iv.date || "", file_name: iv.fileName || "",
      subtotal: iv.subtotal, total: iv.total, due_date: iv.due || "", terms: iv.terms || "", notes: iv.notes || "", ...(iv.id ? {} : { stage: "new" }),
      paid_on: iv.paidOn || "", pay_method: iv.payMethod || "", pay_ref: iv.payRef || "", paid_from: iv.paidFrom || "", paid_amount: iv.paidAmount,
      lines: iv.rows.map(r => { const l = r.vid && lineOf(r.vid);
        return { item_code: r.src.item_code, upc: r.src.upc, description: r.src.description, qty: r.qty === "" ? null : Number(r.qty), unit_cost: r.cost === "" ? null : Number(r.cost),
          amount: rowAmt(r), variant_id: r.vid ? Number(r.vid) : null, match_how: howSaved(r), update_cost: false,
          dest: l ? l.dest : "prep", amazon_sku: l && l.dest === "prep" ? l.asku || "" : "", account: r.account || "inventory" }; }) }));
    const remember = [];
    for (const iv of ed.invoices) for (const r of iv.rows) if (r.src.item_code && r.vid && isSure(r) && r.how !== "sku") remember.push({ item_code: r.src.item_code, variant_id: Number(r.vid) });
    return { order: { id: ed.id ? Number(ed.id) : null, vendor: ed.vendor.trim(), po_no: ed.po.trim(), kind: ed.kind, place_by: ed.placeBy || "", expected_on: ed.expected || "", note: ed.note, short_ok: !!ed.shortOk, shopify_po_url: shopUrl(ed.shopifyUrl), receive_into: ed.dest === "both" ? "both" : ed.dest,
      shopify_check: ed.shopCheck ? { ...ed.shopCheck, lines: ed.shopCheck.lines.map(({ alts, ...x }) => x), diffs: shopDiffs(ed).n } : null },
      lines, invoices, remove_invoices: ed.removed.map(Number), remember };
  }
  function problems(ed) {
    const bad = ed.lines.find(l => l.qty !== "" && !(Number.isInteger(Number(l.qty)) && Number(l.qty) >= 0) || l.cost !== "" && !(Number(l.cost) >= 0));
    if (bad) return `Check the quantity and cost for ${esc((variant(bad.vid) || {}).title || "a product")} — quantities are whole numbers.`;
    const under = ed.lines.find(l => (l.received || 0) > (Number(l.qty) || 0));
    if (under) return `${esc((variant(under.vid) || {}).title || "A product")}: ${n0(under.received)} were already received, so the PO can't order fewer.`;
    for (const iv of ed.invoices) { const b = iv.rows.find(r => r.qty !== "" && isNaN(Number(r.qty)) || r.cost !== "" && !(Number(r.cost) >= 0)); if (b) return `Check the quantity and cost on invoice ${esc(iv.no || "")}: ${esc(b.src.description || b.src.item_code)}.`; }
    if (!ed.vendor.trim()) return "Enter the vendor.";
    if (ed.shopifyUrl.trim() && !/^https:\/\/\S+$/i.test(shopUrl(ed.shopifyUrl))) return "The Shopify PO needs to be a link (https://admin.shopify.com/…/purchase_orders/…) or the PO's number from that link.";
    const seen = new Set(); for (const l of ed.lines) { const k = keyOf(l); if (seen.has(k)) return `${esc((variant(l.vid) || {}).title || "A product")} is on the PO twice for the same place. Take one off.`; seen.add(k); }
    return "";
  }
  async function save(next, quiet) {
    const ed = S.ed; if (!ed || S.busy) return null;
    const p = problems(ed); if (p) { note("bad", p); return null; }
    const firstInvoice = ed.invoices.some(v => v.isNew), first = !ed.id, body = bodyOf(ed);
    S.busy = "Saving…"; render();
    try {
      const res = await JT.po.save(body);
      const id = String(res.order_id), ids = (res.invoice_ids || []).map(String);
      ed.id = id; ed.invoices.forEach((v, i) => { if (ids[i]) v.id = ids[i]; }); ed.removed = [];     // a retry after a later step fails updates, not duplicates
      for (const v of ed.invoices) if (v.id && v.file && !v.file.saved) { await uploadFile(v.id, v.file); v.file.saved = true; }
      let moved = "";
      const target = next || (firstInvoice && ["draft", "ordered"].includes(ed.status) ? "invoiced" : null);
      if (target && target !== ed.status) { await JT.prep.setOrderStatus(Number(id), target); moved = target; }
      S.busy = ""; S.ed = null;
      await loadOrders(true);
      const nm = (ed.vendor || "Order") + (ed.po ? " " + poLabel(ed.po) : "");
      const nb = ed.lines.filter(l => l.backorder).length;
      if (!quiet) note("info", `<b>${esc(nm)}</b> ${first ? "created" : "saved"}${moved ? ` and ${ORDER.indexOf(moved) < ORDER.indexOf(ed.status) ? "moved back to" : "moved to"} ${STAGE.get(moved).toLowerCase()}` : ""}.${nb ? ` ${nb} product${nb === 1 ? "" : "s"} backordered.` : ""}${body.remember.length ? " Matches are remembered for this vendor's next invoice." : ""}`);
      const keepCur = ed.cur;
      await openPO(id);
      if (S.ed && keepCur >= 0 && keepCur < S.ed.invoices.length) { S.ed.cur = keepCur; render(); }
      return id;
    } catch (e) {
      S.busy = ""; render();
      const msg = (e && e.message) || "";
      note("bad", /invoices_vendor_no_idx|duplicate key/i.test(msg) ? `One of these invoice numbers from ${esc(ed.vendor)} is already saved on another order or on the Invoices tab.` : "Couldn't save: " + esc(JT.message(e)));
      return null;
    }
  }
  async function setStatus2(status, msg) {
    const ed = S.ed; S.busy = "Saving…"; render();
    try { await JT.prep.setOrderStatus(Number(ed.id), status); S.busy = ""; await loadOrders(true); await openPO(ed.id); note("info", msg || `Moved to ${STAGE.get(status).toLowerCase()}.`); }
    catch (e) { S.busy = ""; if (S.ed) S.ed.confirm = false; render(); note("bad", "Couldn't change the stage: " + esc(JT.message(e))); }
  }
  async function invReceived(iv, on) {
    const ed = S.ed; S.busy = "Saving…"; render();
    try { await JT.prep.invoiceReceived(iv.id, on); S.busy = ""; await openPO(ed.id); note("info", on ? `Invoice ${esc(iv.no || iv.id)} marked received.` : `Invoice ${esc(iv.no || iv.id)} reopened.`); }
    catch (e) { S.busy = ""; render(); note("bad", "Couldn't change the invoice: " + esc(JT.message(e))); }
  }
  async function receiveNow(obj) {
    const ed = S.ed; obj = obj || (ed && ed.recv); if (!ed || !obj) return;
    const lines = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v == null || v === "") continue;
      const q = Number(v); if (!Number.isInteger(q) || q < 0) { note("bad", "Received quantities must be whole numbers."); return; }
      const [vid, asku, dest] = k.split("|");
      if (q > 0) lines.push({ variant_id: Number(vid), amazon_sku: dest === "prep" ? asku || "" : "", dest: dest || "prep", qty: q });
    }
    if (!lines.length) { note("warn", "Enter how many arrived."); return; }
    const recv = ed.recv, ri = ed.rcvInv;
    if (ed.dirty || !ed.id) { const id = await save(null, true); if (!id) return; S.ed.recv = recv; if (S.ed.invoices.some(v => v.id === ri)) S.ed.rcvInv = ri; }
    S.busy = "Receiving…"; render();
    try {
      const inv = receiving(S.ed) ? rcvIv(S.ed) : null;
      const n = await JT.prep.receiveOrder(Number(S.ed.id), lines, "", inv && inv.id);
      const id = S.ed.id; S.busy = ""; await loadOrders(true); await openPO(id);
      const iv2 = inv && S.ed && S.ed.invoices.find(v => v.id === inv.id);
      const left = S.ed ? [...progress(S.ed).values()].reduce((a, p) => a + Math.max(0, p.ordered - p.received), 0) : 0;
      note("info", `Received ${n0(n)} units${inv ? ` against invoice ${esc(inv.no || inv.id)}` : ""}.${iv2 && iv2.recvAt ? " That invoice is now received in full." : ""}${lines.some(l => l.dest === "prep") ? " Prep-center lines are in the prep center." : ""}${lines.some(l => l.dest === "shopify") ? " Shopify-store lines are recorded on the PO (Shopify's own stock isn't changed)." : ""}${left ? ` ${n0(left)} still to come on this PO.` : ""}`);
    } catch (e) { S.busy = ""; render(); note("bad", "Couldn't receive: " + esc(JT.message(e))); }
  }
  function leave() {
    const ed = S.ed;
    if (ed && ed.dirty && !ed.leaveOk) { note("warn", `This purchase order has unsaved changes. <span class="dbtns"><button class="mini primary" data-pact="save">Save</button><button class="mini" data-pact="discard">Discard changes</button></span>`); return; }
    S.ed = null; note("", ""); pdfToken++; render(); renderList();
  }

  // ---------- events ----------
  function focusArg(a) { const id = { "po-add": "po-add", "po-exp": "pe-exp", "po-inv": "pe-file", "po-placeby": "pe-placeby", "po-po": "pe-po" }[a] || a;
    setTimeout(() => { const el = $(id); if (!el) return; if (id === "pe-file" || id === "pe-shopfile") el.click(); else if (el.tagName === "SECTION" || el.id === "pe-costbar") el.scrollIntoView({ behavior: "smooth", block: "start" }); else { el.focus(); if (el.select) el.select(); } }, 0); }
  function markBackordered(ed, eta) {
    const pr = progress(ed); let n = 0;
    for (const l of ed.lines) if (pr.get(l.id).open > 0 && !l.backorder) { l.backorder = true; l.eta = eta || ""; n++; }
    ed.boPrompt = false; ed.dirty = true; return n;
  }
  function fix(d) {
    const ed = S.ed; if (!ed) return;
    const f = d.fix, iv = cur(ed);
    if (f === "focus") return focusArg(d.arg);
    if (f === "focuskq" || f === "focuskc") { setTimeout(() => { const el = document.querySelector(`#po-edit-view [data-f="${f === "focuskq" ? "qty" : "cost"}"][data-k="${CSS.escape(d.k)}"]`); if (el) { el.focus(); el.select(); } }, 0); return; }
    if (f === "pfilter" && iv) { iv.filter = d.arg; render(); return; }
    if (f === "pconfirmall" && iv) { for (const r of iv.rows) if (needsCheck(r) && r.conf === "high") r.confirmed = true; syncLines(ed); ed.dirty = true; render(); return; }
    if (f === "ppdf" || f === "oinv") { ed.showPdf = true; render(); return; }
    if (f === "paddcharge") return act("addcharge");
    if (f === "pbo") { const n = markBackordered(ed, ""); note("info", `${n} product${n === 1 ? "" : "s"} marked backordered. Add an ETA on each if you have one, then Save.`); render(); return; }
    if (f === "orecv") return act("recv");
    if (f === "oshort") return act("short");
    if (f === "papply") { focusArg("pe-costbar"); return act("apply-costs"); }
    if (f === "ppaid") { const i = +d.arg; if (ed.invoices[i]) { ed.cur = i; markPaid(ed, ed.invoices[i]); render(); focusArg("pe-paymethod"); } return; }
    if (f === "onext") { save(NEXT[ed.status] && NEXT[ed.status][0]); return; }
    if (f === "oship") return act("amzship");
    if (f === "tab") { const b = document.querySelector(`.tabs button[data-tab="${d.arg}"]`); if (b) b.click(); return; }
    if (f === "ofill") { focusArg("po-inv"); return; }
  }
  function act(a, k) {
    const ed = S.ed; if (!ed) return;
    const iv = cur(ed), r = k && iv && iv.rows.find(x => x.id === k), l = k && ed.lines.find(x => x.id === k);
    if (a === "back-list") return leave();
    if (a === "discard") { ed.leaveOk = true; return leave(); }
    if (a === "save") return save(null);
    if (a === "save-next") return save(NEXT[ed.status][0]);
    if (a === "confirm" && r) { r.confirmed = true; syncLines(ed); ed.dirty = true; render(); return; }
    if (a === "search" && r) { ed.search = { id: r.id, q: r.src.item_code || (r.src.description || "").split(/\s+/).slice(0, 4).join(" ") }; render(); setTimeout(() => { const i = $("pe-sq"); if (i) { i.focus(); i.select(); } }, 0); return; }
    if (a === "search-cancel") { ed.search = null; render(); return; }
    if (a === "skip" && r) { r.vid = null; r.how = ""; r.conf = ""; r.confirmed = false; r.skip = true; if (FREIGHT.test(r.src.description)) r.account = "inbound_shipping"; ed.search = null; syncLines(ed); ed.dirty = true; render(); return; }
    if (a === "unskip" && r) { r.skip = false; r.account = "inventory"; ed.dirty = true; render(); return; }
    if (a === "rmrow" && r) { iv.rows = iv.rows.filter(x => x !== r); syncLines(ed); ed.dirty = true; render(); return; }
    if (a === "split" && l) { const q = Number(l.qty) || 0, half = Math.floor(q / 2);
      ed.split = { id: l.id, total: q, s: String(l.dest === "shopify" ? q - half : half), p: String(l.dest === "shopify" ? half : q - half), asku: l.dest === "prep" ? l.asku : "" };
      render(); setTimeout(() => { const i = box().querySelector('[data-f="spP"]'); if (i) { i.focus(); i.select(); } }, 0); return; }
    if (a === "updc" && l) { const on = !l.upd; for (const x of ed.lines) if (x.vid === l.vid) x.upd = on; ed.costPreview = null; ed.dirty = true; render(); return; }
    if (a === "updc-all") { for (const x of ed.lines) { const v = variant(x.vid); if (x.cost !== "" && v && (v.cost == null || Math.abs(Number(x.cost) - v.cost) >= 0.005)) for (const y of ed.lines) if (y.vid === x.vid) y.upd = true; } ed.costPreview = null; ed.dirty = true; render(); return; }
    if (a === "apply-costs") return prepareApply();
    if (a === "shoprecv") return markShopRecv(true);
    if (a === "shoprecv-off") return markShopRecv(false);
    if (a === "shoprecv-check") { const id = ed.id; openPO(id); return; }
    if (a === "apply-amz") { S.busy = "Loading the Amazon report…"; ed.costWorking = true; render();
      JT.fba.load(false).catch(() => {}).then(() => { S.busy = ""; ed.costWorking = false; prepareApply(); }); return; }
    if (a === "apply-no") { ed.costPreview = null; render(); return; }
    if (a === "apply-go") return applyCosts();
    if (a === "shop-all") { ed.shopAll = !ed.shopAll; render(); return; }
    if (a === "shop-rm") { ed.shopCheck = null; ed.dirty = true; render(); note("info", "Shopify PO check removed. Save to keep that."); return; }
    if (a === "unrecv1" && l) { ed.unrecv = { id: l.id, n: String(l.received) }; render(); setTimeout(() => { const i = box().querySelector('[data-f="unrq"]'); if (i) { i.focus(); i.select(); } }, 0); return; }
    if (a === "unrecv1-no") { ed.unrecv = null; render(); return; }
    if (a === "unrecv1-go") return unreceiveLine(ed);
    if (a === "split-no") { ed.split = null; render(); return; }
    if (a === "split-go") return doSplit(ed);
    if (a === "rmline" && l) { ed.lines = ed.lines.filter(x => x !== l); ed.dirty = true; render(); return; }
    if (a === "addrow" && iv) { const nr = { id: newId(), src: { item_code: "", upc: "", description: "", qty: null, unit_cost: null, amount: null }, vid: null, how: "", conf: "", alts: [], confirmed: false, skip: false, account: "inventory", qty: "", cost: "" };
      iv.rows.push(nr); iv.filter = "all"; ed.search = { id: nr.id, q: "" }; ed.dirty = true; render(); setTimeout(() => { const i = $("pe-sq"); if (i) i.focus(); }, 0); return; }
    if (a === "addcharge" && iv) { const r2 = chargeRow("Freight", 0, "inbound_shipping"); r2.cost = ""; iv.rows.push(r2); iv.filter = "all"; ed.dirty = true; render();
      setTimeout(() => { const i = document.querySelector(`#po-edit-view [data-f="icost"][data-k="${r2.id}"]`); if (i) i.focus(); }, 0); return; }
    if (a === "qbcopy" && iv) { const t = qbText(ed, iv); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => note("info", "Copied the bill for QuickBooks."), () => note("info", `<pre class="qbpre">${esc(t)}</pre>`)); return; }
    if (a === "pdf") { ed.showPdf = !ed.showPdf; render(); return; }
    if (a === "rminv") { ed.confirm = "rminv"; render(); return; }
    if (a === "do-rminv" && iv) { if (iv.id) ed.removed.push(iv.id); ed.invoices.splice(ed.cur, 1); ed.cur = ed.invoices.length - 1; ed.confirm = false; syncLines(ed); ed.dirty = true; pdfToken++; render(); return; }
    if (a === "bo-all") { const eta = ($("pe-boeta") || {}).value || ""; const n = markBackordered(ed, eta); note("info", `${n} product${n === 1 ? "" : "s"} marked backordered${eta ? `, expected ${shortDate(eta)}` : " (no ETA yet)"}. Change any line's ETA in the table, then Save.`); render(); return; }
    if (a === "bo-no") { ed.boPrompt = false; render(); return; }
    if (a === "del") { ed.confirm = "del"; render(); return; }
    if (a === "no") { ed.confirm = false; render(); return; }
    if (a === "do-del") { S.busy = "Deleting…"; render(); JT.po.remove(Number(ed.id)).then(async () => { S.busy = ""; S.ed = null; await loadOrders(true); render(); renderList(); note("info", "Purchase order deleted."); })
      .catch(e => { S.busy = ""; ed.confirm = false; render(); note("bad", "Couldn't delete: " + esc(JT.message(e))); }); return; }
    if (a === "back") { if (["partial", "received"].includes(ed.status)) { ed.confirm = "unrecv"; render(); } else if (ed.dirty) note("warn", "Save or discard your changes first."); else setStatus2(PREV[ed.status], `Moved back to ${STAGE.get(PREV[ed.status]).toLowerCase()}.`); return; }
    if (a === "do-back") return setStatus2(PREV[ed.status], "Moved back to invoiced; the received units came out of the prep center.");
    if (a === "short") { ed.confirm = "short"; render(); return; }
    if (a === "do-short") { if (ed.dirty) { save("received"); return; } return setStatus2("received", "Closed short and moved to received."); }
    if (a === "pay" && iv) { markPaid(ed, iv); render(); focusArg("pe-paymethod"); return; }
    if (a === "unpay" && iv) { iv.paidOn = ""; iv.paidAmount = null; iv.payRef = ""; ed.dirty = true; render(); return; }
    if (a === "recv") {
      const n = allChecks(ed);
      if (n) { note("warn", `Confirm or change the ${n} guessed product${n === 1 ? "" : "s"} on the invoices before receiving, so the right stock comes in.`); const i = ed.invoices.findIndex(v => count(v).check); if (i >= 0) { ed.cur = i; ed.invoices[i].filter = "check"; } render(); return; }
      const pr = progress(ed), anyInv = ed.invoices.length > 0; ed.recv = {};
      for (const x of ed.lines) { const p = pr.get(x.id); ed.recv[keyOf(x)] = String(anyInv ? p.toReceive : Math.max(0, p.ordered - p.received)); }
      render(); return;
    }
    if (a === "recv-cancel") { ed.recv = null; render(); return; }
    if (a === "rq-go" && l) { const p = progress(ed).get(l.id); return receiveNow({ [keyOf(l)]: rqVal(ed, l, p) }); }
    if (a === "rq-all") {
      const n = allChecks(ed);
      if (n) { note("warn", `Confirm or change the ${n} guessed product${n === 1 ? "" : "s"} on the invoices before receiving everything, so the right stock comes in. (Receive on a line works for the ones you're sure of.)`); const i = ed.invoices.findIndex(v => count(v).check); if (i >= 0) { ed.cur = i; ed.invoices[i].filter = "check"; } render(); return; }
      const pr = progress(ed), o = {};
      for (const x of ed.lines) { const p = pr.get(x.id); if (p.ordered - p.received > 0 || p.toReceive > 0) o[keyOf(x)] = rqVal(ed, x, p); }
      return receiveNow(o);
    }
    if (a === "recv-go") return receiveNow();
    if ((a === "inv-recvd" || a === "inv-reopen") && cur(ed) && cur(ed).id) return invReceived(cur(ed), a === "inv-recvd");
    if (a === "amzship") { if (window.JTPrepTab && window.JTPrepTab.shipFromOrder) window.JTPrepTab.shipFromOrder(ed.id); return; }
  }
  const box = () => $("po-edit-view");
  // ---------- new costs to Shopify ----------
  // Lines marked "Update Shopify" are applied in bulk, received products only. Shopify gets the average cost of
  // everything on hand (older units at their old cost, this PO's at the PO cost); inventory value keeps FIFO layers.
  function costGroups(ed) {
    const g = new Map();
    for (const l of ed.lines) { if (!l.upd || l.cost === "") continue; const a = g.get(l.vid) || { vid: l.vid, qty: 0, rec: 0, amt: 0 }; a.qty += Number(l.qty) || 0; a.rec += l.received || 0; a.amt += (l.received || Number(l.qty) || 0) * Number(l.cost); g.set(l.vid, a); }
    for (const a of g.values()) { const w = a.rec || a.qty; a.cost = w ? Math.round(a.amt / w * 10000) / 10000 : null; }
    return [...g.values()];
  }
  function costBar(ed, pr, ro) {
    if (ro || ed.recv) return "";
    const marked = costGroups(ed), ready = marked.filter(a => a.rec > 0), waiting = marked.filter(a => !a.rec);
    const changed = ed.lines.filter(l => !l.upd && l.cost !== "" && variant(l.vid) && (variant(l.vid).cost == null || Math.abs(Number(l.cost) - variant(l.vid).cost) >= 0.005));
    if (!marked.length && !changed.length && !ed.costPreview) return "";
    const pv = ed.costPreview, gate = shopGate(ed);
    return `<div class="costbar ${ready.length ? "hot" : ""}" id="pe-costbar" tabindex="-1"><span><b>Shopify costs</b> · ${marked.length ? `${marked.length} marked to update${ready.length ? ` · <b>${ready.length} received, ready</b>` : ""}${waiting.length ? ` · ${waiting.length} waiting to be received` : ""}` : `${changed.length} cost${changed.length === 1 ? " differs" : "s differ"} from Shopify`}</span>
      <span class="dbtns">${changed.length ? `<button class="btn" data-pact="updc-all">Mark ${changed.length === 1 ? "it" : "all " + changed.length}</button>` : ""}${ready.length ? `<button class="btn primary" data-pact="apply-costs" ${S.busy || gate.block ? "disabled" : ""} title="${esc(gate.text || "")}">${ed.costWorking ? "Working out the new costs…" : `Apply to Shopify (${ready.length})`}</button>` : ""}</span>
      ${ready.length && gate.html ? `<div class="gate small">${gate.html}</div>` : ""}
      ${pv ? `<div class="costprev">${ed.costAmzNote ? `<div class="small warnt">Amazon (FBA/AWD) stock isn't counted in "On hand" yet. <button class="linkbtn small" data-pact="apply-amz">Include Amazon stock</button> (loads the Amazon report; can take a minute)</div>` : ""}<div class="small">Shopify gets the <b>average cost of everything on hand</b>: the older units at their old cost and the units received on this PO at the PO cost. Inventory value keeps them apart (FIFO), so the older units stay at the old cost until they sell.</div>
        <table class="prept po-t"><thead><tr><th class="l">Product</th><th>On hand</th><th>Received on this PO</th><th>Shopify now</th><th>PO cost</th><th>New Shopify cost</th></tr></thead><tbody>${pv.map(x => `<tr><td class="l">${esc((variant(x.vid) || {}).title || x.vid)}<div class="meta">${esc(x.how)}</div></td><td>${n0(x.onHand)}</td><td>${n0(x.rec)}</td><td>${m(x.old)}</td><td>${m(x.poCost)}</td><td><b>${m(x.cost)}</b></td></tr>`).join("")}</tbody></table>
        <div class="dbtns"><button class="btn primary" data-pact="apply-go" ${S.busy ? "disabled" : ""}>${S.busy ? "Sending…" : `Send ${pv.length} cost${pv.length === 1 ? "" : "s"} to Shopify`}</button><button class="btn" data-pact="apply-no">Cancel</button></div></div>` : ""}
    </div>`;
  }
  // Apply to Shopify waits until the PO is received in Shopify and Shopify's stock has synced since (Shopify-store products)
  function shopGate(ed) {
    const shopRec = ed.lines.some(l => l.dest === "shopify" && l.received > 0);
    const done = ed.shopRecvAt ? `<span class="pill ok">Received in Shopify ${esc(when(ed.shopRecvAt))}</span>${ed.shopRecvBy ? ` <span class="muted">${esc(ed.shopRecvBy)}</span>` : ""} <button class="linkbtn small" data-pact="shoprecv-off">undo</button>` : "";
    if (!shopRec) return { block: false, html: ed.shopRecvAt ? done : "", text: "" };
    if (!ed.shopRecvAt) return { block: true, text: "Receive the PO in Shopify first",
      html: `<b>Receive this PO in Shopify first</b> (Shopify's stock count has to include the new units before the average cost is worked out). ${shopUrl(ed.shopifyUrl) && /^https:/.test(shopUrl(ed.shopifyUrl)) ? `<a href="${esc(shopUrl(ed.shopifyUrl))}" target="_blank" rel="noopener">Open the Shopify PO ↗</a> · ` : ""}<button class="btn" data-pact="shoprecv">It's received in Shopify</button>` };
    if (!ed.stockSyncedAt || new Date(ed.stockSyncedAt) < new Date(ed.shopRecvAt)) return { block: true, text: "Waiting for Shopify's stock to sync",
      html: `${done} · <b>waiting for Shopify's stock to sync</b> (started when you marked it; usually a few minutes). <button class="linkbtn small" data-pact="shoprecv-check">Check again</button>` };
    return { block: false, text: "", html: done };
  }
  // the Save button and saved/unsaved note in the sticky header, without redrawing the page
  function syncTop() {
    const ed = S.ed, c = document.querySelector("#po-edit-view .po-crumb"); if (!ed || !c) return;
    const b = c.querySelector('button[data-pact="save"]'), st = c.querySelector(".pill.warn, .muted.small");
    const want = ed.dirty || !ed.id;
    if (b) { b.disabled = !!S.busy || !want || !!ed.recv; b.classList.toggle("primary", want); b.textContent = S.busy === "Saving…" ? "Saving…" : want ? "Save" : "Saved"; }
    if (st && ed.dirty && !st.classList.contains("warn")) st.outerHTML = '<span class="pill warn">Unsaved changes</span>';
  }
  // while Apply waits for Shopify's stock to sync, look again every 20 seconds so it opens by itself
  let gateTimer = null;
  function watchGate() {
    clearTimeout(gateTimer);
    const ed = S.ed; if (!ed || !ed.id || !ed.shopRecvAt || $("tab-po").hidden) return;
    const g = shopGate(ed); if (!g.block || !ed.shopRecvAt || !costGroups(ed).some(a => a.rec > 0)) return;
    gateTimer = setTimeout(async () => {
      if (S.ed !== ed || ed.dirty || S.busy) return watchGate();
      try { const r = await JT.rows(["max(seen_at)::text"], "from jt.variants", true); if (r[0] && r[0][0]) ed.stockSyncedAt = r[0][0]; } catch (_) {}
      if (!shopGate(ed).block) { render(); note("info", "Shopify's stock has synced — <b>Apply to Shopify</b> is ready."); } else watchGate();
    }, 20000);
  }
  async function markShopRecv(on) {
    const ed = S.ed; if (!ed || !ed.id) return;
    if (ed.dirty) { const id = await save(null, true); if (!id) return; }
    S.busy = "Saving…"; render();
    try { await JT.po.shopifyReceived(S.ed.id, on); S.busy = ""; const keep = S.ed.cur; await openPO(S.ed.id); if (S.ed) S.ed.cur = keep;
      note("info", on ? "Marked received in Shopify. Shopify's stock is syncing now; Apply to Shopify opens when it's done." : "No longer marked received in Shopify."); render(); }
    catch (err) { S.busy = ""; render(); note("bad", "Couldn't save: " + esc(JT.message(err))); }
  }
  // work out each product's new Shopify cost (and its opening layer, the first time)
  async function prepareApply() {
    const ed = S.ed; if (!ed) return;
    if (shopGate(ed).block) { note("warn", shopGate(ed).text + "."); return; }
    if (ed.dirty) { const id = await save(null, true); if (!id) return; }
    const e2 = S.ed, groups = costGroups(e2).filter(a => a.rec > 0); if (!groups.length) return;
    S.busy = "Working out the new costs…"; e2.costWorking = true; render();
    try {
      // Amazon stock counts toward what's on hand; the Amazon report can be slow to load here, so don't wait long for it
      // Amazon stock counts toward what's on hand when the Amazon report is loaded; loading it can take a while here,
      // so it isn't waited for: the preview says so and offers to include it
      const amzNote = JT.fba && !JT.fba.data ? "amz" : "";
      await window.JTCost.load(true, groups.map(a => a.vid));
      const cutoff = e2.stageAt.partial || e2.stageAt.received || new Date().toISOString();
      const out = [];
      for (const a of groups) {
        const v = variant(a.vid) || {}, n = window.JTCost.onHand(a.vid);
        let layers = window.JTCost.layers(a.vid), opening = null, how = "";
        if (!layers) {
          // first time: this PO's receipts and any later ones are layers; the rest on hand is the opening layer at the old cost
          const r = await JT.rows(["l.order_id::text", "sum(l.qty_received)", "sum(l.qty_received * coalesce(l.unit_cost, v.unit_cost)) / sum(l.qty_received)",
            "min(coalesce((o.stage_at->>'partial')::timestamptz, (o.stage_at->>'received')::timestamptz, o.updated_at))::text"],
            `from jt.prep_order_lines l join jt.prep_orders o on o.id = l.order_id join jt.variants v on v.variant_id = l.variant_id where l.variant_id = ${JT.int(a.vid)} and l.qty_received > 0
             and coalesce((o.stage_at->>'partial')::timestamptz, (o.stage_at->>'received')::timestamptz, o.updated_at) >= ${JT.q(cutoff)}::timestamptz group by l.order_id`, true);
          const po = r.map(([oid, q, c, at]) => ({ kind: "po", orderId: oid, qty: +q || 0, cost: oid === String(e2.id) ? a.cost : +c, at, t: new Date(at).getTime() }));
          const inPo = po.reduce((s2, x) => s2 + x.qty, 0), oq = Math.max(0, Math.round(n - inPo)), oc = v.cost != null ? v.cost : a.cost;
          opening = { qty: oq, unit_cost: oc, at: cutoff };
          layers = [{ kind: "opening", qty: oq, cost: oc, at: cutoff, t: 0 }, ...po];
          how = `${n0(oq)} older units at ${m(oc)}`;
        } else how = "cost layers already started";
        const cost = n > 0 ? Math.round(window.JTCost.fifo(layers, n) / n * 100) / 100 : Math.round(a.cost * 100) / 100;
        out.push({ vid: a.vid, onHand: n, rec: a.rec, old: v.cost, poCost: a.cost, cost, opening, how });
      }
      S.busy = ""; e2.costWorking = false; e2.costPreview = out; e2.costAmzNote = amzNote; render();
      focusArg("pe-costbar");
    } catch (err) { S.busy = ""; e2.costWorking = false; render(); note("bad", "Couldn't work out the costs: " + esc(JT.message(err))); }
  }
  async function applyCosts() {
    const ed = S.ed, pv = ed && ed.costPreview; if (!pv) return;
    S.busy = "Sending costs to Shopify…"; render();
    try {
      const n = await JT.po.applyCosts({ order_id: Number(ed.id), items: pv.map(x => ({ variant_id: Number(x.vid), cost: x.cost, opening: x.opening })) });
      S.busy = ""; const id = ed.id; await openPO(id); if (window.JTCost) window.JTCost.load(true).catch(() => {});
      note("info", `${n} Shopify cost${n === 1 ? "" : "s"} queued — the sync sends ${n === 1 ? "it" : "them"} to Shopify in a minute or two. Inventory value now keeps this PO's units at the PO cost.`);
    } catch (err) { S.busy = ""; render(); note("bad", "Couldn't apply the costs: " + esc(JT.message(err))); }
  }
  // Shopify's own status for the linked PO (read by the sync once Shopify's PO API is open to the store)
  const SSTAT = { DRAFT: ["Draft", "pos"], ORDERED: ["Ordered", "manual"], PARTIALLY_RECEIVED: ["Partly received", "warn"], RECEIVED: ["Received", "ok"], CLOSED: ["Closed", "ok"], CANCELLED: ["Cancelled", "miss"], CANCELED: ["Cancelled", "miss"] };
  const shopStatusPill = (st) => { if (!st) return ""; const k = String(st).toUpperCase(), d = SSTAT[k] || [k.charAt(0) + k.slice(1).toLowerCase().replace(/_/g, " "), "pos"];
    return `<span class="pill ${d[1]}" title="Status of the PO in Shopify">Shopify: ${esc(d[0])}</span>`; };
  // ---------- checking against the Shopify PO ----------
  // Shopify's API doesn't open POs to apps on a live store yet, so Shopify's side comes from the PO's PDF.
  const SDIFF = { qty: "quantity", cost: "cost", missing: "not on the Shopify PO", extra: "only on the Shopify PO", unmatched: "not matched to a product", supplier: "supplier" };
  // A Shopify PO PDF: "Purchase order #PO1042", the supplier, then product rows (title, variant, SKU, quantity, cost, total).
  function parseShopPo(rows) {
    const txt = rows.map(r => r.cells.join(" "));
    const all = txt.join("\n");
    const name = ((all.match(/purchase\s*order\s*(#\s*[A-Z0-9-]+)/i) || all.match(/(#\s*PO[-\s]?\d+)/i) || [])[1] || "").replace(/\s+/g, "");
    const TOT = /^(sub-?total|total|taxes?|tax|shipping|freight|discount|cost summary|amount due|balance)\b/i;
    let supplier = "", total = null, subtotal = null, shipping = null;
    rows.forEach((r, i) => {
      const k = r.cells.findIndex(c => /^supplier$/i.test(c));
      if (k >= 0 && !supplier) supplier = IP.cellBelow(r, k, rows[i + 1]) || (r.cells[k + 1] || "");
      const m = /^supplier\s*:?\s+(.+)$/i.exec(r.cells[0] || ""); if (m && !supplier) supplier = m[1];
      const lead = r.cells[0] || "", last = IP.numOf(r.cells[r.cells.length - 1]);
      if (last != null && /^total\b/i.test(lead)) total = last;
      if (last != null && /^sub-?total\b/i.test(lead)) subtotal = last;
      if (last != null && /^(shipping|freight)\b/i.test(lead)) shipping = last;
    });
    const items = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]; if (TOT.test(r.cells[0] || "")) continue;
      const nums = r.cells.map((c, j) => ({ t: c, v: IP.numOf(c), i: j })).filter(x => x.v != null);
      const qp = IP.findQtyPrice(nums); if (!qp) continue;
      let before = r.cells.slice(0, qp.qi), supSku = "";
      // a Supplier SKU column: a short code in its own cell after the title
      if (before.length > 1 && /^[A-Z0-9][A-Z0-9._\/-]{2,}$/i.test(before[before.length - 1]) && /\d/.test(before[before.length - 1])) supSku = before[before.length - 1];
      let title = before.filter(c => !/^sku\b/i.test(c)).join(" ").trim(), sku = "", code = before.length > 1 ? before[before.length - 1] : "";
      // the rows under it (variant, "SKU: …") until the next product row
      for (let j = i + 1; j < Math.min(rows.length, i + 4); j++) {
        const n2 = rows[j].cells.map((c, k2) => ({ t: c, v: IP.numOf(c), i: k2 })).filter(x => x.v != null);
        if (IP.findQtyPrice(n2) || TOT.test(rows[j].cells[0] || "")) break;
        for (const c of rows[j].cells) { const m = /^sku\s*:?\s*(\S+)/i.exec(c); if (m) sku = m[1]; else if (!/^(supplier sku|barcode)\b/i.test(c) && !sku) title += " - " + c; }
      }
      const inl = before.map(c => /sku\s*:?\s*(\S+)/i.exec(c)).find(Boolean); if (inl && !sku) sku = inl[1];
      if (supSku) title = title.replace(new RegExp("\\s*" + supSku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*"), " ").trim();
      if (!sku && code && S.bySku.has(norm(code))) { sku = code; }
      if (!sku) { const hit = before.concat(rows[i + 1] ? rows[i + 1].cells : []).find(c => S.bySku.has(norm(c))); if (hit) sku = hit; }
      items.push({ sku, supplier_sku: supSku, title: title.replace(/\s+-\s*$/, ""), qty: qp.qty, cost: qp.unit, amount: qp.amount });
    }
    return { name, supplier: supplier.trim(), total, subtotal, shipping, lines: items };
  }
  async function readShopPdf(file) {
    const ed = S.ed; if (!file || !ed) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { note("warn", "That isn't a PDF. In Shopify, open the purchase order and download (or print to) a PDF."); return; }
    S.busy = "Reading the Shopify PO…"; render();
    try {
      await catalog();
      const rows = await IP.pdfRows(new Uint8Array(await file.arrayBuffer()));
      const sp = parseShopPo(rows);
      S.busy = "";
      if (!sp.lines.length) { render(); note("bad", "Couldn't find any product lines in that PDF. Is it the purchase order PDF from Shopify?"); return; }
      for (const l of sp.lines) { let g = guessLine({ item_code: l.sku, upc: "", description: l.title }, ed.vendor);
        if (!l.sku && l.supplier_sku) { const g2 = guessLine({ item_code: l.supplier_sku, upc: "", description: l.title }, ed.vendor); if (g2.how === "remembered" || g2.how === "sku") g = g2; } l.variant_id = g.vid; l.how = g.how; l.alts = g.alts; }
      ed.shopCheck = { checked_at: new Date().toISOString(), source: "pdf", file_name: file.name, name: sp.name, supplier: sp.supplier, total: sp.total, subtotal: sp.subtotal, shipping: sp.shipping,
        scope: (ed.shopCheck && ed.shopCheck.scope) || "all", lines: sp.lines };
      ed.dirty = true; ed.shopAll = false; render();
      const d = shopDiffs(ed);
      note(d.n ? "warn" : "info", `Read Shopify PO ${esc(sp.name || file.name)}: ${sp.lines.length} product line${sp.lines.length === 1 ? "" : "s"}. ${d.n ? `<b>${d.n} difference${d.n === 1 ? "" : "s"}</b> from this PO — see below.` : "It matches this PO."} Save to keep the check.`);
      focusArg("pe-shopcheck");
    } catch (e) { S.busy = ""; render(); note("bad", "Couldn't read that PDF: " + esc(JT.message(e))); }
  }
  // this PO against the Shopify PO, product by product (split products are added up)
  function shopDiffs(ed) {
    const sc = ed.shopCheck, out = { rows: [], n: 0, supplier: false, ours: { u: 0, c: 0 }, theirs: { u: 0, c: 0 } }; if (!sc) return out;
    const lines = sc.scope === "shopify" ? ed.lines.filter(l => l.dest === "shopify") : ed.lines;
    const ours = new Map(), theirs = new Map();
    for (const l of lines) { const q = Number(l.qty) || 0, c = l.cost === "" ? (variant(l.vid) || {}).cost : Number(l.cost); const a = ours.get(l.vid) || { q: 0, c: null }; a.q += q; if (a.c == null && c != null) a.c = c; ours.set(l.vid, a); out.ours.u += q; out.ours.c += q * (c || 0); }
    sc.lines.forEach((l, i) => { out.theirs.u += l.qty || 0; out.theirs.c += (l.qty || 0) * (l.cost || 0);
      if (!l.variant_id) { out.rows.push({ i, title: l.title || l.sku || "Line " + (i + 1), sku: l.sku, oq: null, sq: l.qty, oc: null, scost: l.cost, kinds: ["unmatched"], alts: l.alts || [] }); return; }
      const a = theirs.get(l.variant_id) || { q: 0, c: null, i }; a.q += l.qty || 0; if (a.c == null) a.c = l.cost; a.guess = a.guess || l.how === "guess"; theirs.set(l.variant_id, a); });
    for (const vid of new Set([...ours.keys(), ...theirs.keys()])) {
      const o = ours.get(vid), t = theirs.get(vid), v = variant(vid) || {}, kinds = [];
      if (!t) kinds.push("missing"); else if (!o) kinds.push("extra");
      else { if (o.q !== t.q) kinds.push("qty"); if (o.c != null && t.c != null && Math.abs(o.c - t.c) >= 0.005) kinds.push("cost"); }
      out.rows.push({ vid, i: t ? t.i : null, title: v.title || "variant " + vid, sku: v.sku || "", oq: o ? o.q : null, sq: t ? t.q : null, oc: o ? o.c : null, scost: t ? t.c : null, kinds, guess: t && t.guess });
    }
    const nv = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    out.supplier = !!(sc.supplier && ed.vendor && !nv(sc.supplier).includes(nv(ed.vendor)) && !nv(ed.vendor).includes(nv(sc.supplier)));
    out.rows.sort((a, b) => (b.kinds.length > 0) - (a.kinds.length > 0) || String(a.title).localeCompare(String(b.title)));
    out.n = out.rows.filter(r => r.kinds.length).length + (out.supplier ? 1 : 0);
    return out;
  }
  function shopCheckHtml(ed, ro) {
    if (!ed.id || !(ed.shopifyUrl.trim() || ed.shopCheck)) return "";
    const up = `<label class="btn ${ed.shopCheck ? "" : "primary"}" for="pe-shopfile">${ed.shopCheck ? "Re-check (new PDF)" : "Upload Shopify PO PDF"}</label><input type="file" id="pe-shopfile" accept=".pdf,application/pdf" hidden>`;
    const link = shopUrl(ed.shopifyUrl) && /^https:/.test(shopUrl(ed.shopifyUrl)) ? `<a class="small" href="${esc(shopUrl(ed.shopifyUrl))}" target="_blank" rel="noopener">open it in Shopify ↗</a>` : "";
    const api = ed.shopStatus ? `${shopStatusPill(ed.shopStatus)} <span class="muted small">as of ${esc(when(ed.shopStatusAt))}</span>`
      : ed.poApi && !ed.poApi.ok ? `<span class="muted small" title="${esc(ed.poApi.why || "")}">Shopify status: not available yet — Shopify hasn't opened its PO API to live stores; checked nightly</span>` : "";
    if (!ed.shopCheck) return `<section class="panel shopchk" id="pe-shopcheck"><div class="panel-head"><h2>Shopify PO check</h2>${api}<span class="muted small">not checked yet</span><span class="dbtns right">${up}</span></div>
      <div class="small muted">Open the PO in Shopify ${link ? `(${link})` : ""}, download it as a PDF (or print it and save as PDF), and upload it here. Every product, quantity and cost is compared with this PO.</div></section>`;
    const sc = ed.shopCheck, d = shopDiffs(ed), hasPrep = ed.lines.some(l => l.dest === "prep");
    const shown = ed.shopAll ? d.rows : d.rows.filter(r => r.kinds.length);
    const cell = (v, bad, f) => v == null ? '<span class="dim">—</span>' : `<span class="${bad ? "dif" : ""}">${f(v)}</span>`;
    const fixes = (r) => {
      if (ro) return "";
      const b = [];
      if (r.kinds.includes("qty")) b.push(`<button class="mini" data-sfix="qty" data-vid="${r.vid}">Use Shopify's qty (${n0(r.sq)})</button>`);
      if (r.kinds.includes("cost")) b.push(`<button class="mini" data-sfix="cost" data-vid="${r.vid}">Use Shopify's cost (${m(r.scost)})</button>`);
      if (r.kinds.includes("extra")) b.push(`<button class="mini" data-sfix="add" data-vid="${r.vid}">Add to this PO</button>`);
      if (r.kinds.includes("missing")) b.push(`<span class="small muted">add it to the Shopify PO</span>`);
      if (r.guess && r.i != null) b.push(`<button class="linkbtn small" data-sfix="unmatch" data-vid="${r.vid}" data-i="${r.i}">wrong product?</button>`);
      if (r.kinds.includes("unmatched")) b.push(`<select class="inp sm" data-f="spick" data-i="${r.i}" style="width:auto;max-width:200px"><option value="">Pick the product…</option>${(r.alts || []).map(id => { const a = variant(id); return a ? `<option value="${a.vid}">${esc(a.title)} · ${esc(a.sku)}</option>` : ""; }).join("")}</select>`);
      return b.join("");
    };
    const rowsH = shown.map(r => `<tr class="${r.kinds.length ? "off" : ""}"><td class="l">${esc(r.title)}<div class="meta mono">${esc(r.sku || "")}${r.guess ? ' <span class="pill conf-medium" title="Matched by the product name on the Shopify PO — check it">by name</span>' : ""}</div></td>
      <td>${cell(r.oq, r.kinds.includes("qty") || r.kinds.includes("missing"), n0)}</td><td>${cell(r.sq, r.kinds.includes("qty") || r.kinds.includes("extra"), n0)}</td>
      <td>${cell(r.oc, r.kinds.includes("cost"), m)}</td><td>${cell(r.scost, r.kinds.includes("cost"), m)}</td>
      <td class="l">${r.kinds.length ? r.kinds.map(k => `<span class="pill miss">${SDIFF[k]}${k === "qty" ? ` ${r.sq - r.oq > 0 ? "+" : ""}${n0(r.sq - r.oq)}` : k === "cost" ? ` ${r.scost - r.oc > 0 ? "+" : ""}${m(r.scost - r.oc)}` : ""}</span>`).join(" ") : '<span class="pill ok">matches</span>'}</td>
      <td class="l"><span class="dbtns">${fixes(r)}</span></td></tr>`).join("");
    return `<section class="panel shopchk ${d.n ? "bad" : "good"}" id="pe-shopcheck">
      <div class="panel-head"><h2>Shopify PO check</h2>${api}${d.n ? `<span class="pill miss">${d.n} difference${d.n === 1 ? "" : "s"}</span>` : '<span class="pill ok">Matches ✓</span>'}
        <span class="muted small">${esc(sc.name || "Shopify PO")} · checked ${when(sc.checked_at)} from ${esc(sc.file_name || "PDF")} ${link ? "· " + link : ""}</span>
        <span class="dbtns right">${up}<button class="mini" data-pact="shop-rm">Remove check</button></span></div>
      <div class="shopsum small">
        <span><b>This PO</b> ${n0(d.ours.u)} units · ${m(d.ours.c)}</span><span><b>Shopify PO</b> ${n0(d.theirs.u)} units · ${m(d.theirs.c)}${sc.shipping ? ` · shipping ${m(sc.shipping)}` : ""}${sc.total != null ? ` · total ${m(sc.total)}` : ""}</span>
        ${d.supplier ? `<span class="pill miss">supplier: Shopify says ${esc(sc.supplier)}</span>` : ""}
        ${hasPrep ? `<span class="seg sm" role="group" aria-label="What the Shopify PO covers"><button data-sscope="all" aria-pressed="${sc.scope !== "shopify"}">Whole PO</button><button data-sscope="shopify" aria-pressed="${sc.scope === "shopify"}">Shopify-store lines only</button></span>` : ""}
        <button class="linkbtn small" data-pact="shop-all">${ed.shopAll ? "Differences only" : `Show all ${d.rows.length} products`}</button></div>
      ${shown.length ? `<div class="tbl-wrap"><table class="prept po-t shop-t"><thead><tr><th class="l">Product</th><th>Our qty</th><th>Shopify qty</th><th>Our cost</th><th>Shopify cost</th><th class="l">Difference</th><th class="l"></th></tr></thead><tbody>${rowsH}</tbody></table></div>`
        : `<div class="small muted">${d.n ? "" : "Every product, quantity and cost matches."}</div>`}
    </section>`;
  }
  function shopFix(ed, kind, vid, i) {
    if (kind === "unmatch") { for (const l of ed.shopCheck.lines) if (l.variant_id === vid && l.how === "guess") { l.alts = [vid, ...(l.alts || []).filter(x => x !== vid)]; l.variant_id = null; l.how = ""; } ed.dirty = true; render(); return; }
    const d = shopDiffs(ed), r = d.rows.find(x => x.vid === vid); if (!r) return;
    const scope = ed.shopCheck.scope === "shopify" ? ed.lines.filter(l => l.dest === "shopify") : ed.lines;
    const mine = scope.filter(l => l.vid === vid);
    if (kind === "qty") { const tgt = mine.find(l => l.dest === "shopify") || mine[0]; if (!tgt) return; const nq = (Number(tgt.qty) || 0) + (r.sq - r.oq);
      if (nq < (tgt.received || 0)) { note("warn", "That would take the quantity below what's already received."); return; }
      tgt.qty = String(nq); if (ed.splitTot) delete ed.splitTot[vid]; }
    if (kind === "cost") for (const l of mine) l.cost = fmtCost(r.scost);
    if (kind === "add") { const sl = ed.shopCheck.lines.find(x => x.variant_id === vid); ed.lines.push({ id: newId(), vid, asku: "", dest: ed.shopCheck.scope === "shopify" ? "shopify" : newDest(ed), qty: String(r.sq), cost: fmtCost(sl ? sl.cost : r.scost), received: 0, backorder: false, eta: "", auto: false }); }
    ed.dirty = true; render();
  }
  // A split product keeps its total: changing one part's quantity moves the difference to the other part
  // (the other bucket first). ed.splitTot holds each split product's total.
  const qn = (x) => Number(x.qty) || 0;
  function rebalance(ed, l, val) {
    const parts = ed.lines.filter(x => x.vid === l.vid);
    if (parts.length < 2) { l.qty = val; return; }
    ed.splitTot = ed.splitTot || {};
    const tot = ed.splitTot[l.vid] ?? parts.reduce((a, x) => a + qn(x), 0); ed.splitTot[l.vid] = tot;
    l.qty = val; const v = Number(val); if (val === "" || !Number.isInteger(v) || v < 0) return;
    const others = parts.filter(x => x !== l).sort((a, b) => (b.dest !== l.dest) - (a.dest !== l.dest));
    let diff = tot - parts.reduce((a, x) => a + qn(x), 0);       // + means the others take more, - means they give some up
    for (const o of others) { if (!diff) break; const nq = Math.max(o.received || 0, qn(o) + diff); diff -= nq - qn(o); o.qty = String(nq); }
    for (const o of others) { const i = document.querySelector(`#po-edit-view [data-f="qty"][data-k="${o.id}"]`); if (i) i.value = o.qty; }
  }
  async function unreceiveLine(ed) {
    const u = ed.unrecv, l = u && ed.lines.find(x => x.id === u.id); if (!l) return;
    const q = Number(u.n); if (!(Number.isInteger(q) && q > 0 && q <= l.received)) { note("bad", `Enter a whole number from 1 to ${n0(l.received)}.`); return; }
    if (ed.dirty) { const id = await save(null, true); if (!id) return; }
    S.busy = "Un-receiving…"; render();
    try {
      const n = await JT.prep.unreceiveLine({ id: Number(S.ed.id), variant_id: Number(l.vid), amazon_sku: l.dest === "prep" ? l.asku || "" : "", dest: l.dest, qty: q });
      const id = S.ed.id; S.busy = ""; await loadOrders(true); await openPO(id);
      note("info", `Un-received ${n0(n)} of ${esc((variant(l.vid) || {}).title || "the product")}${l.dest === "prep" ? " — they came back out of the prep center" : ""}.`);
    } catch (err) { S.busy = ""; render(); note("bad", "Couldn't un-receive: " + esc(JT.message(err))); }
  }
  // one product, part to the Shopify store and part to the prep center
  function doSplit(ed) {
    const sp = ed.split, src = sp && ed.lines.find(x => x.id === sp.id); if (!src) { ed.split = null; render(); return; }
    const sQ = Number(sp.s), pQ = Number(sp.p);
    if (![sQ, pQ].every(n => Number.isInteger(n) && n >= 0) || sQ + pQ === 0) { note("bad", "Enter whole numbers for each side."); return; }
    // a received line can't be split below what it received: un-receive the units that belong on the other side first
    const keeps = src.dest === "shopify" ? sQ : src.asku === (sp.asku || "") ? pQ : 0;
    if (src.received > keeps) { note("warn", `${n0(src.received)} of these were already received into the ${src.dest === "shopify" ? "Shopify store" : "prep center"}. Un-receive ${n0(src.received - keeps)} first (the un-receive link under Received), then split, then receive them on the other side.`); return; }
    const mk = (dest, asku) => ({ id: newId(), vid: src.vid, asku, dest, qty: "0", cost: src.cost, received: 0, backorder: src.backorder, eta: src.eta, auto: false });
    const shop = src.dest === "shopify" ? src : ed.lines.find(x => x.vid === src.vid && x.dest === "shopify") || null;
    const prep = src.dest === "prep" && src.asku === sp.asku ? src : ed.lines.find(x => x.vid === src.vid && x.dest === "prep" && x.asku === sp.asku) || null;
    const S2 = shop || (sQ ? (ed.lines.push(mk("shopify", "")), ed.lines[ed.lines.length - 1]) : null);
    const P2 = prep || (pQ ? (ed.lines.push(mk("prep", sp.asku || "")), ed.lines[ed.lines.length - 1]) : null);
    // the split replaces the source line's quantity; a line it merges into keeps what it had
    const addTo = (L, q) => { if (!L) return; L.qty = String(L === src ? q : (L === shop || L === prep ? (Number(L.qty) || 0) + q : q)); };
    if (src !== S2 && src !== P2) src.qty = "0";
    addTo(S2, sQ); addTo(P2, pQ);
    ed.lines = ed.lines.filter(x => (Number(x.qty) || 0) > 0 || x.received > 0 || (x !== src && x !== S2 && x !== P2));
    ed.splitTot = ed.splitTot || {}; ed.splitTot[src.vid] = ed.lines.filter(x => x.vid === src.vid).reduce((a, x) => a + qn(x), 0);
    ed.dest = "both"; ed.split = null; ed.dirty = true; render();
    note("info", `Split: ${n0(sQ)} to the Shopify store, ${n0(pQ)} to the prep center. Save to keep it.`);
  }
  function addLine(x) {
    const ed = S.ed, dest = x.asku ? "prep" : newDest(ed);
    const l = { id: newId(), vid: x.v.vid, asku: x.asku || "", dest, qty: "", cost: "", received: 0, backorder: false, eta: "", auto: false };
    if (ed.lines.some(y => keyOf(y) === keyOf(l))) { note("warn", `${esc(x.v.title)} is already on this PO.`); return; }
    ed.lines.push(l); ed.add = ""; ed.dirty = true; render();
    setTimeout(() => { const i = document.querySelector(`#po-edit-view [data-f="qty"][data-k="${l.id}"]`); if (i) i.focus(); }, 0);
  }

  function bind() {
    const tab = $("tab-po"), box = $("po-edit-view");
    $("po-new").addEventListener("click", () => { if (S.ed && S.ed.dirty) return leave(); note("", ""); openPO(null); });
    $("po-refresh").addEventListener("click", async () => { await Promise.all([refresh(true), S.cat ? catalog(true) : null]); if (S.ed && S.ed.id && !S.ed.dirty) openPO(S.ed.id); });
    $("po-q").addEventListener("input", (e) => { S.q = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(renderList, 150); });
    $("po-vendor").addEventListener("change", (e) => { S.vendor = e.target.value; renderList(); });
    $("po-stage").addEventListener("click", (e) => { const b = e.target.closest("button[data-st]"); if (b) { S.stage = b.dataset.st; renderList(); } });
    tab.addEventListener("click", (e) => { const o = e.target.closest("[data-po-open]"); if (o && !e.target.closest("a")) { note("", ""); openPO(o.dataset.poOpen); } });
    $("po-table").addEventListener("keydown", (e) => { const o = e.target.closest("[data-po-open]"); if (o && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openPO(o.dataset.poOpen); } });
    // a PDF dropped anywhere on the tab
    const isFile = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
    tab.addEventListener("dragover", (e) => { if (isFile(e)) { e.preventDefault(); if (S.ed) tab.classList.add("filedrop"); } });
    tab.addEventListener("dragleave", (e) => { if (!tab.contains(e.relatedTarget)) tab.classList.remove("filedrop"); });
    tab.addEventListener("drop", (e) => { if (isFile(e) && !S.ed) { e.preventDefault(); note("info", "Open the purchase order (or create it with New PO), then drop the invoice PDF on it."); return; } if (isFile(e)) { e.preventDefault(); tab.classList.remove("filedrop"); readPdf(e.dataTransfer.files[0]); } });
    $("po-note").addEventListener("click", (e) => { const b = e.target.closest("[data-pact]"); if (b) act(b.dataset.pact); });
    box.addEventListener("change", (e) => {
      const ed = S.ed, t = e.target; if (!ed) return;
      const iv = cur(ed);
      if (t.id === "pe-file") { const f = t.files[0]; t.value = ""; readPdf(f); return; }
      if (t.id === "pe-shopfile") { const f = t.files[0]; t.value = ""; readShopPdf(f); return; }
      if (t.dataset.f === "spick" && ed.shopCheck) { const sl = ed.shopCheck.lines[+t.dataset.i]; if (sl && t.value) { sl.variant_id = t.value; sl.how = "picked"; ed.dirty = true; render(); } return; }
      if (t.id === "pe-vendor") { ed.vendor = t.value.trim(); ed.dirty = true; reguess(ed); render(); return; }
      if (t.id === "pe-exp") { ed.expected = t.value; ed.dirty = true; render(); return; }
      if (t.id === "pe-placeby") { ed.placeBy = t.value; ed.dirty = true; render(); return; }
      if (t.id === "pe-invdate" && iv) { iv.date = t.value; ed.dirty = true; render(); return; }
      if (t.id === "pe-invdue" && iv) { iv.due = t.value; ed.dirty = true; render(); return; }
      if (t.id === "pe-paidon" && iv) { iv.paidOn = t.value; ed.dirty = true; render(); return; }
      if (t.id === "pe-paymethod" && iv) { iv.payMethod = t.value; ed.dirty = true; render(); return; }
      if (t.id === "pe-paidamt" && iv) { iv.paidAmount = IP.numOf(t.value); ed.dirty = true; render(); return; }
      if (t.id === "pe-dest") {
        ed.dirty = true; ed.split = null;
        if (t.value === "both") { ed.dest = "both"; render(); return; }
        for (const l of ed.lines) if (!(l.received > 0)) { l.dest = t.value; if (t.value === "shopify") l.asku = ""; }
        mergeLines(ed);
        const stuck = ed.lines.filter(l => l.dest !== t.value);
        ed.dest = stuck.length ? "both" : t.value;
        if (stuck.length) note("warn", `${stuck.length} product${stuck.length === 1 ? " was" : "s were"} already received into the ${DESTN[stuck[0].dest].toLowerCase()}, so this PO stays on Both.`);
        render(); return; }
      if (t.id === "pe-boeta") return;
      if (t.id === "pe-rcvinv") { ed.rcvInv = t.value; ed.rq = {}; render(); return; }
      if (t.dataset.f === "spA" && ed.split) { ed.split.asku = t.value; return; }
      const k = t.dataset.k, l = k && ed.lines.find(x => x.id === k), r = k && iv && iv.rows.find(x => x.id === k);
      if (t.dataset.f === "dest" && l) { const oldK = keyOf(l); if (t.value === "@shopify") { l.dest = "shopify"; l.asku = ""; } else { l.dest = "prep"; l.asku = t.value; }
        if (ed.recv && oldK !== keyOf(l) && oldK in ed.recv) { ed.recv[keyOf(l)] = ed.recv[oldK]; delete ed.recv[oldK]; }
        mergeLines(ed); const ds = new Set(ed.lines.map(x => x.dest)); if (ds.size > 1) ed.dest = "both"; else if (ed.dest !== "both") ed.dest = [...ds][0] || ed.dest; ed.dirty = true; render(); return; }
      if (t.dataset.f === "bo" && l) { l.backorder = t.checked; if (!t.checked) l.eta = ""; ed.dirty = true; render(); return; }
      if (t.dataset.f === "eta" && l) { l.eta = t.value; ed.dirty = true; render(); return; }
      if (t.dataset.f === "acct" && r) { r.account = t.value; ed.dirty = true; render(); return; }
      if (t.dataset.f === "alt" && r && t.value) { r.vid = t.value; r.how = "manual"; r.conf = "sure"; r.confirmed = true; syncLines(ed); ed.dirty = true; render(); return; }
    });
    box.addEventListener("input", () => setTimeout(syncTop, 0));     // typing marks the PO unsaved: update the Save button now
    box.addEventListener("change", () => setTimeout(syncTop, 0));
    box.addEventListener("input", (e) => {
      const ed = S.ed, t = e.target; if (!ed) return;
      const iv = cur(ed);
      if (t.id === "pe-po") { ed.po = t.value; ed.dirty = true; return; }
      if (t.id === "pe-note") { ed.note = t.value; ed.dirty = true; return; }
      if (t.id === "pe-shopify") { ed.shopifyUrl = t.value; ed.dirty = true; clearTimeout(box._t); box._t = setTimeout(render, 600); return; }
      if (t.id === "pe-invno" && iv) { iv.no = t.value; ed.dirty = true; return; }
      if (t.id === "pe-invterms" && iv) { iv.terms = t.value; ed.dirty = true; return; }
      if (t.id === "pe-payref" && iv) { iv.payRef = t.value; ed.dirty = true; return; }
      if (t.id === "pe-paidfrom" && iv) { iv.paidFrom = t.value; ed.dirty = true; return; }
      if (t.id === "pe-invtotal" && iv) { iv.total = IP.numOf(t.value); ed.dirty = true; clearTimeout(box._t); box._t = setTimeout(render, 500); return; }
      if (t.id === "pe-invsub" && iv) { iv.subtotal = IP.numOf(t.value); ed.dirty = true; clearTimeout(box._t); box._t = setTimeout(render, 500); return; }
      if (t.id === "po-add") { ed.add = t.value; clearTimeout(box._t); box._t = setTimeout(render, 150); if (!S.cat) catalog().then(render).catch(() => {}); return; }
      if (t.id === "pe-sq") { ed.search.q = t.value; clearTimeout(box._t); box._t = setTimeout(render, 150); return; }
      const k = t.dataset.k, l = k && ed.lines.find(x => x.id === k), r = k && iv && iv.rows.find(x => x.id === k);
      if (t.dataset.f === "qty" && l) { rebalance(ed, l, t.value.trim()); l.auto = false; ed.dirty = true; clearTimeout(box._t); box._t = setTimeout(render, 400); }
      if (t.dataset.f === "cost" && l) { l.cost = t.value.trim().replace(/^\$/, ""); ed.dirty = true; clearTimeout(box._t); box._t = setTimeout(render, 400); }
      if (t.dataset.f === "recv" && l) { ed.recv[keyOf(l)] = t.value.trim(); }
      if (t.dataset.f === "rq" && l) { ed.rq = ed.rq || {}; ed.rq[keyOf(l)] = t.value.trim(); clearTimeout(box._t); box._t = setTimeout(render, 500); }
      if (t.dataset.f === "unrq" && ed.unrecv) { ed.unrecv.n = t.value.trim(); clearTimeout(box._t); box._t = setTimeout(render, 400); }
      if ((t.dataset.f === "spS" || t.dataset.f === "spP") && ed.split) {
        const tot = ed.split.total, v2 = t.value.trim(), n = Number(v2);
        if (t.dataset.f === "spS") { ed.split.s = v2; if (Number.isInteger(n) && n >= 0 && n <= tot) { ed.split.p = String(tot - n); const o = box.querySelector('[data-f="spP"]'); if (o) o.value = ed.split.p; } }
        else { ed.split.p = v2; if (Number.isInteger(n) && n >= 0 && n <= tot) { ed.split.s = String(tot - n); const o = box.querySelector('[data-f="spS"]'); if (o) o.value = ed.split.s; } }
      }
      if (t.dataset.f === "iqty" && r) { r.qty = t.value.trim(); syncLines(ed); ed.dirty = true; clearTimeout(box._t); box._t = setTimeout(render, 400); }
      if (t.dataset.f === "icost" && r) { r.cost = t.value.trim().replace(/^\$/, ""); ed.dirty = true; clearTimeout(box._t); box._t = setTimeout(render, 400); }
    });
    box.addEventListener("keydown", (e) => {
      const ed = S.ed; if (!ed) return;
      if (e.target.id === "po-add" && e.key === "Enter") { e.preventDefault(); clearTimeout(box._t); const f = findProducts(ed.add); if (f.length) addLine(f[0]); else render(); }
      if (e.target.id === "pe-sq" && e.key === "Enter") { e.preventDefault(); const b = box.querySelector(".mres button[data-ppick]"); if (b) b.click(); }
      if (e.target.id === "pe-sq" && e.key === "Escape") { ed.search = null; render(); }
      const f = e.target.dataset && e.target.dataset.f;
      if (f === "rq" && e.key === "Enter") { e.preventDefault(); clearTimeout(box._t); act("rq-go", e.target.dataset.k); return; }
      if (e.key === "Enter" && ["qty", "cost", "iqty", "icost", "recv"].includes(f)) {
        e.preventDefault(); const ins = [...box.querySelectorAll(`input[data-f="${f}"]`)], i = ins.indexOf(e.target); clearTimeout(box._t); render();
        const nx = ins[i + 1] && box.querySelector(`input[data-f="${f}"][data-k="${ins[i + 1].dataset.k}"]`); if (nx) { nx.focus(); nx.select(); }
      }
    });
    box.addEventListener("click", (e) => {
      const ed = S.ed, b = e.target.closest("button"); if (!ed || !b) return;
      const iv = cur(ed);
      if (b.dataset.fix) { fix(b.dataset); return; }
      if (b.dataset.pact) { act(b.dataset.pact, b.dataset.k); return; }
      if (b.dataset.pgo) { save(b.dataset.pgo); return; }
      if (b.dataset.pkind) { ed.kind = b.dataset.pkind; ed.dirty = true; render(); return; }
      if (b.dataset.sfix) { shopFix(ed, b.dataset.sfix, b.dataset.vid, b.dataset.i); return; }
      if (b.dataset.sscope && ed.shopCheck) { ed.shopCheck.scope = b.dataset.sscope; ed.dirty = true; render(); return; }
      if (b.dataset.paddto) { ed.addTo = b.dataset.paddto; render(); return; }
      if (b.dataset.pdest) { const l = ed.lines.find(x => x.id === b.dataset.k); if (!l || l.dest === b.dataset.pdest) return;
        l.dest = b.dataset.pdest; if (l.dest === "shopify") l.asku = ""; mergeLines(ed); ed.dirty = true; render(); return; }
      if (b.dataset.inv != null) { ed.cur = +b.dataset.inv; ed.search = null; ed.confirm = false; pdfToken++; const h = $("pe-pdf"); if (h) h.innerHTML = "";
        const v = cur(ed); if (v && v.parts && !v.file && !S.files.has(v.id)) loadFile(v).then(() => { if (S.ed === ed && cur(ed) === v) { const h2 = $("pe-pdf"); if (h2) h2.innerHTML = ""; renderPdf(); } }).catch(() => {});
        render(); return; }
      if (b.dataset.ifilter && iv) { iv.filter = b.dataset.ifilter; render(); return; }
      if (b.dataset.padd != null) { const x = findProducts(ed.add)[+b.dataset.padd]; if (x) addLine(x); return; }
      if (b.dataset.ppick && iv) { const r = iv.rows.find(x => x.id === b.dataset.k); if (r) { r.vid = b.dataset.ppick; r.skip = false; r.how = "manual"; r.conf = "sure"; r.confirmed = true; ed.search = null; syncLines(ed); ed.dirty = true; render(); } return; }
    });
    box.addEventListener("dragover", (e) => { const d = e.target.closest("#pe-drop"); if (d) d.classList.add("over"); });
    box.addEventListener("dragleave", (e) => { const d = e.target.closest("#pe-drop"); if (d) d.classList.remove("over"); });
    window.addEventListener("beforeunload", (e) => { if (S.ed && S.ed.dirty) { e.preventDefault(); e.returnValue = ""; } });
    // ⌘S / Ctrl+S saves the open purchase order
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s" && S.ed && !$("tab-po").hidden) {
        e.preventDefault(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        setTimeout(() => { if (S.ed && (S.ed.dirty || !S.ed.id) && !S.busy && !S.ed.recv) save(null); }, 0);
      }
    });
    let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (S.ed && S.ed.showPdf && !$("tab-po").hidden) { const h = $("pe-pdf"); if (h) h.innerHTML = ""; renderPdf(); } }, 250); });
  }

  bind();
  // new or changed Shopify products: reload the catalog; an open PO's unmatched invoice lines get another try
  window.addEventListener("jt:catalog", () => {
    S.cat = null; S.catP = null;
    if ($("tab-po").hidden) return;
    catalog(true).then(() => {
      const ed = S.ed; let n = 0;
      if (ed) for (const iv of ed.invoices) for (const r of iv.rows) {
        if (!r.src || r.skip || r.how === "manual" || r.confirmed || isSure(r)) continue;       // not-matched lines and guesses
        const g = guessLine(r.src, ed.vendor); if (g.vid && (g.vid !== r.vid || g.how !== r.how)) { Object.assign(r, g); n++; }
      }
      if (n) { syncLines(ed); ed.dirty = true; note("info", `Shopify products updated: ${n} invoice line${n === 1 ? " was" : "s were"} matched again with the new products. Check them and Save.`); }
      render();
    }).catch(() => {});
    refresh(true).catch(() => {});
  });
  window.poShow = () => { if (!S.shown) { S.shown = true; refresh(false); catalog().catch(() => {}); } render(); };
  window.JTPO = { _state: S, open: (id) => { const b = document.querySelector('.tabs button[data-tab="po"]'); if (b) b.click(); openPO(id); }, guessLine, merge, progress };
  if ((location.hash || "") === "#po") setTimeout(() => window.poShow(), 0);
})();
