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
  const poLabel = (po) => /^po(\b|\d)/i.test(po) ? po : "PO " + po;
  const SURE = new Set(["remembered", "sku", "upc", "manual", "confirmed", "po", "shopify"]);
  const HOW = { remembered: "Remembered", sku: "SKU match", upc: "UPC match", manual: "Picked", confirmed: "Confirmed", skupart: "Part of SKU", guess: "Guess", po: "From the PO", shopify: "From Shopify" };
  const CONF = { high: "Likely", medium: "Maybe", low: "Unsure" };
  const ACCOUNTS = [["inventory", "Inventory"], ["inbound_shipping", "Inbound Shipping"]];   // QuickBooks accounts (bill lines)
  const ACCT = new Map(ACCOUNTS);
  const FREIGHT = /\b(freight|shipping|handling|delivery|postage)\b/i;
  const PART = 66000;          // PDF bytes per stored part (base64 ~88k characters: one small database reply)

  const S = {
    shown: false, loading: false, orders: null, stage: "open", vendor: "all", q: "",
    cat: null, catP: null, ix: null, byVid: null, bySku: null, byBar: null, remembered: new Map(), vendors: [], listings: new Map(), byAmz: new Map(),
    ed: null, busy: "", files: new Map(),   // invoice id -> Uint8Array (PDFs already downloaded)
    // The editor lives on two tabs: mode "po" is the purchase order (Purchase orders tab); mode "inv" is one of its invoices
    // (Invoices tab: lines, PDF, payment, QuickBooks). invOpen: an invoice page is showing (else the invoice list).
    mode: "po", invOpen: false, pend: null, invs: null, invQ: "", invF: "all", invLoading: false,
  };
  // the tab the editor is on, and moving the editor (and its notes) there
  const hostTab = () => S.mode === "inv" ? $("tab-invoices") : $("tab-po");
  const shown = () => !!hostTab() && !hostTab().hidden;
  function place() {
    const inv = S.mode === "inv", notes = $(inv ? "inv-notes-host" : "po-notes-host"), edit = $(inv ? "inv-edit-host" : "po-edit-host");
    if (!notes || !edit) return;
    for (const id of ["po-busy", "po-note"]) if ($(id).parentNode !== notes) notes.appendChild($(id));
    if ($("po-edit-view").parentNode !== edit) edit.appendChild($("po-edit-view"));
  }
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
      "(select count(distinct l.variant_id) from jt.prep_order_lines l where l.order_id = o.id and l.update_cost and l.qty_received > 0)", "o.no_shopify_po"],
      "from jt.prep_orders o", "o.id", 2, refresh);
    S.orders = r.map(x => ({ id: x[0], vendor: x[1] || "", po: x[2] || "", status: x[3], kind: x[4] || "order", placeBy: x[5] || "", expected: x[6] || "", note: x[7] || "",
      stageAt: x[8] || {}, created: x[9], updated: x[10], nInv: +x[11], invNos: x[12] || "", invTotal: x[13] == null ? null : +x[13], due: x[14] || "", nFiles: +x[15],
      nLines: +x[16], units: +x[17], received: +x[18], cost: x[19] == null ? 0 : +x[19], unmatched: +x[20], guesses: +x[21], text: (x[22] || "").toLowerCase(), prepLines: +x[23],
      invoiced: +x[24], nBack: +x[25], backEta: x[26] || "", nUnpaid: +x[27] || 0, unpaidDue: x[28] || "", unpaidAmt: x[29] == null ? 0 : +x[29], shopifyUrl: x[30] || "", prepUnits: +x[31] || 0, into: x[32] || "", shopDiffs: x[34] ? +x[33] || 0 : null, shopStatus: x[35] || "", costsReady: +x[36] || 0, noShop: !!x[37] }))
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
  // Invoiced products are received on their invoice (the invoice area); the PO table keeps what isn't invoiced yet.
  const billed = (iv) => { const b = new Map(); for (const r of iv.rows) if (r.vid && !r.skip && isSure(r)) b.set(r.vid, (b.get(r.vid) || 0) + (Number(r.qty) || 0)); return b; };
  const invTot = (iv) => { let b = 0, g = 0; for (const [vid, q] of billed(iv)) { b += q; g += Math.min(q, (iv.got && iv.got.get(vid)) || 0); } return { b, g }; };
  // One invoice's products spread over the PO's lines for each product (a product split between the Shopify store and the
  // prep center has two lines): {billed, got, left} per line id. Lines fill in order, up to what each ordered; the last takes the rest.
  function invShares(ed, iv) {
    const b = billed(iv), out = new Map(), lastOf = new Map(), bl = new Map(b), gl = new Map();
    for (const [vid] of b) gl.set(vid, Math.min(b.get(vid), (iv.got && iv.got.get(vid)) || 0));
    ed.lines.forEach(l => lastOf.set(l.vid, l.id));
    for (const l of ed.lines) {
      if (!b.has(l.vid)) continue;
      const last = lastOf.get(l.vid) === l.id, ord = Number(l.qty) || 0;
      const bb = last ? bl.get(l.vid) : Math.min(bl.get(l.vid), ord); bl.set(l.vid, bl.get(l.vid) - bb);
      const gg = last ? gl.get(l.vid) : Math.min(gl.get(l.vid), bb); gl.set(l.vid, gl.get(l.vid) - gg);
      out.set(l.id, { billed: bb, got: gg, left: Math.max(0, bb - gg) });
    }
    return out;
  }
  const rqKey = (iv, l) => iv.id + "#" + keyOf(l);
  const rqVal = (ed, iv, l, sh) => { const k = rqKey(iv, l); return ed.rq && k in ed.rq ? ed.rq[k] : String(sh ? sh.left : 0); };
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
  // Saved POs: the details as a line of chips under the title; click one to edit (opens the details form at that field)
  function headStrip(ed, ro, both) {
    if (!ed.id || ed.editHead) return "";
    const f = (id, label, val, empty) => `<button class="hfield" data-hedit="${id}" title="Edit ${label.toLowerCase()}"><span>${label}</span><b class="${val ? "" : "dim"}">${val ? esc(val) : empty}</b></button>`;
    const su = shopUrl(ed.shopifyUrl);
    return `<div class="po-meta">${[
      f("pe-kind", "Type", ed.kind === "booking" ? "Booking" : "Order", ""),
      ed.kind === "booking" ? f("pe-placeby", "Place by", ed.placeBy ? shortDate(ed.placeBy) : "", "not set") : "",
      f("pe-exp", "Expected", ed.expected ? shortDate(ed.expected) : "", "not set"),
      shopOff(ed) ? "" : f("pe-shopify", "Shopify PO", su ? (/purchase_orders\/(\d+)/.exec(su) || [])[1] ? "#" + /purchase_orders\/(\d+)/.exec(su)[1] : "linked" : "", "add link") + (su && /^https:/.test(su) ? `<a class="small hopen" href="${esc(su)}" target="_blank" rel="noopener" title="Open in Shopify">↗</a>` : ""),
      f("pe-dest", "Receive into", both ? "Both" : ed.dest === "prep" ? "Prep center" : "Shopify store", ""),
      f("pe-note", "Note", ed.note, "add a note"),
    ].join("")}</div>`;
  }
  // Seller Sage only: no Shopify PO for this order (marked by hand, or nothing on it goes to the Shopify store)
  const prepOnly = (ed) => ed.lines.length > 0 && !ed.lines.some(l => l.dest === "shopify");
  const shopOff = (ed) => ed.noShop || prepOnly(ed);
  const shopOffO = (o) => o.noShop || (o.units > 0 && o.prepUnits >= o.units) || o.into === "prep";
  function blankEd() {
    return { id: null, status: "draft", vendor: "", po: "", kind: "order", placeBy: "", expected: "", note: "", shortOk: false, noShop: false, shopifyUrl: "", shopCheck: null, shopAll: false, stageAt: {}, created: null, shipments: [],
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
          "(select value::text from jt.settings where key = 'shopify_po_api')", "o.no_shopify_po"],
          `from jt.prep_orders o where o.id = ${JT.int(id)}`, true),
        JT.rows(["variant_id::text", "amazon_sku", "dest", "qty_ordered", "qty_received", "unit_cost", "backorder", "eta::text", "update_cost", "cost_applied", "cost_applied_at::text"], `from jt.prep_order_lines where order_id = ${JT.int(id)} order by variant_id`, true),
        JT.rows(["id::text", "name", "status"], `from jt.prep_shipments where order_id = ${JT.int(id)}`, true),
        JT.rows(["i.id::text", "i.invoice_no", "i.invoice_date::text", "i.subtotal", "i.file_name", "i.file_parts", "i.status", "i.notes", "i.due_date::text", "i.total", "i.terms",
          "i.paid_on::text", "i.pay_method", "i.pay_ref", "i.paid_from", "i.paid_amount", "i.received_at::text", "i.received_manual", "i.qbo_bill_id", "i.qbo_doc", "i.qbo_sent_at::text", "i.qbo_how", "i.qbo_sent_by", "i.qbo_attach_id"],
          `from jt.invoices i where i.order_id = ${JT.int(id)} or i.id = (select invoice_id from jt.prep_orders where id = ${JT.int(id)}) order by i.id`, true),
        // how this vendor was paid last time (for Mark paid)
        JT.rows(["i.pay_method", "i.paid_from"], `from jt.invoices i where i.vendor = (select vendor from jt.prep_orders where id = ${JT.int(id)}) and i.pay_method <> '' order by i.paid_on desc nulls last, i.id desc limit 1`, true),
      ]);
      if (!h[0]) throw { code: "tool_error", message: "That purchase order no longer exists." };
      const x = h[0], ed = blankEd();
      ed.noShop = !!x[x.length - 1];
      Object.assign(ed, { id: x[0], vendor: x[1] || "", po: x[2] || "", status: x[3], kind: x[4] || "order", placeBy: x[5] || "", expected: x[6] || "", note: x[7] || "", shortOk: !!x[8],
        stageAt: x[9] || {}, created: x[10], createdBy: x[11] || "", shopifyUrl: x[12] || "", into: x[13] || "", shopCheck: x[14] || null, shopRecvAt: x[15] || "", shopRecvBy: x[16] || "", stockSyncedAt: x[17] || "", shopStatus: x[18] || "", shopStatusAt: x[19] || "", poApi: (() => { try { return x[20] ? JSON.parse(x[20]) : null; } catch (_) { return null; } })(), shipments: sh.map(s => ({ id: s[0], name: s[1], status: s[2] })) });
      ed.lines = ol.map(([vid, asku, dest, qo, qr, uc, bo, eta, upd, ca, cat]) => ({ id: newId(), vid, asku: asku || "", dest: dest || "prep", qty: String(+qo), cost: fmtCost(uc), received: +qr || 0, backorder: !!bo, eta: eta || "", auto: false,
        upd: !!upd, costApplied: ca == null ? null : +ca, costAppliedAt: cat || "" }));
      ed.invoices = ivs.map(v => ({ ...blankInv(), id: v[0], no: v[1] || "", date: v[2] || "", subtotal: v[3] == null ? null : +v[3], fileName: v[4] || "", parts: +v[5] || 0, status: v[6] || "draft",
        notes: v[7] || "", due: v[8] || "", total: v[9] == null ? null : +v[9], terms: v[10] || "", isNew: false,
        paidOn: v[11] || "", payMethod: v[12] || "", payRef: v[13] || "", paidFrom: v[14] || "", paidAmount: v[15] == null ? null : +v[15], recvAt: v[16] || "", recvManual: !!v[17], qbo: v[18] ? { id: v[18], doc: v[19] || "", at: v[20] || "", how: v[21] || "", by: v[22] || "", att: v[23] || "" } : null }));
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
  // follow the invoice and go away with it; a PO line's cost is the invoice's (the average when several invoices have it)
  function syncLines(ed) {
    const inv = invoicedBy(ed);
    const firstRow = (vid) => { for (const iv of ed.invoices) for (const r of iv.rows) if (r.vid === vid && !r.skip && isSure(r)) return r; return null; };
    for (const [vid, q] of inv) if (!ed.lines.some(l => l.vid === vid)) {
      const r = firstRow(vid);
      ed.lines.push({ id: newId(), vid, asku: "", dest: newDest(ed), qty: String(q), cost: r ? r.cost : "", received: 0, backorder: false, eta: "", auto: true });
    }
    ed.lines = ed.lines.filter(l => !l.auto || inv.has(l.vid) || l.received);
    const invCost = new Map();
    for (const iv of ed.invoices) for (const r of iv.rows) if (r.vid && !r.skip && isSure(r) && r.cost !== "" && Number(r.cost) >= 0) {
      const a = invCost.get(r.vid) || { q: 0, amt: 0, last: null }, q = Math.max(0, Number(r.qty) || 0);
      a.q += q; a.amt += q * Number(r.cost); a.last = Number(r.cost); invCost.set(r.vid, a); }
    for (const l of ed.lines) {
      if (l.auto && inv.has(l.vid)) l.qty = String(inv.get(l.vid));
      const c = invCost.get(l.vid);
      if (c) { const v = c.q > 0 ? c.amt / c.q : c.last; const f = fmtCost(Math.round(v * 10000) / 10000); if (f !== l.cost) l.cost = f; }
      else if (l.cost === "") { const r = firstRow(l.vid); if (r && r.cost !== "") l.cost = r.cost; }
    }
  }

  // ---------- reading an invoice PDF ----------
  // Reading an invoice PDF. From the Invoices tab it finds its PO (same vendor + the PO # on the invoice), or asks
  // which PO it belongs to; from a PO's "Upload invoice PDF" it goes on that PO. Either way it then opens on the Invoices tab.
  async function readPdf(file, orderId) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { note("warn", "That isn't a PDF. Choose the invoice's PDF file."); return; }
    const fromPO = S.mode === "po" && S.ed && S.ed.id ? S.ed : null;
    if (S.ed && S.ed.dirty && !fromPO) { note("warn", `Save or discard the open ${S.ed.id ? "purchase order" : "invoice"} first. <span class="dbtns"><button class="mini primary" data-pact="save">Save</button><button class="mini" data-pact="discard">Discard changes</button></span>`); return; }
    S.busy = "Reading " + file.name + "…"; render();
    let pend;
    try {
      await catalog();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const rows = await IP.pdfRows(bytes.slice());
      const inv = IP.parseInvoice(rows, { vendors: S.vendors, known: (t, vendor) => S.bySku.has(norm(t)) || (!!vendor && S.remembered.has(vendor.toLowerCase() + "|" + norm(t))) });
      pend = { inv, rows, f: { bytes, name: file.name, type: file.type || "application/pdf" } };
    } catch (e) {
      console.error("[JT] invoice read failed", e); S.busy = ""; render();
      note("bad", "Couldn't read that PDF" + (e && e.message ? ": " + esc(e.message) : "") + "."); return;
    }
    S.busy = "";
    if (fromPO) { S.pend = null; return attach(pend, fromPO, ""); }
    S.pend = pend;
    if (!S.orders) await loadOrders(false);
    if (orderId) { await openPO(orderId); return attach(pend, S.ed, ""); }
    const inv = pend.inv;
    const same = inv.po_no && S.orders.find(o => o.status !== "complete" && norm(o.po) === norm(inv.po_no) && (!inv.vendor || !o.vendor || o.vendor.toLowerCase() === inv.vendor.toLowerCase()));
    if (same) { await openPO(same.id); return attach(pend, S.ed, `Added to <b>${esc(same.vendor)} ${esc(poLabel(same.po))}</b> (the PO # on the invoice). `); }
    choosePO(pend);
  }
  // no PO matched: pick one of the vendor's open POs, or start a new PO
  function choosePO(pend) {
    S.mode = "inv"; S.invOpen = false; S.pend = pend; goInvTab();
    const inv = pend.inv, vend = (inv.vendor || "").toLowerCase();
    const open = (S.orders || []).filter(o => o.status !== "complete");
    const same = open.filter(o => vend && o.vendor.toLowerCase() === vend), rest = open.filter(o => !same.includes(o));
    const opt = (o) => `<option value="${esc(o.id)}">${esc(o.vendor)} · ${esc(o.po ? poLabel(o.po) : "#" + o.id)} (${esc(STAGE.get(o.status))})</option>`;
    note("warn", `<b>Which purchase order is invoice ${esc(inv.invoice_no || file0(pend))} from ${esc(inv.vendor || "this vendor")} for?</b>${inv.po_no ? ` It says PO # <span class="mono">${esc(inv.po_no)}</span>, which doesn't match an open PO.` : " No PO # was found on it."}
      <div class="row">${open.length ? `<select id="pe-pendpo" class="inp sm" style="width:auto;max-width:340px">${same.length ? `<optgroup label="${esc(inv.vendor)}">${same.map(opt).join("")}</optgroup>` : ""}${rest.length ? `<optgroup label="${same.length ? "Other vendors" : "Open purchase orders"}">${rest.map(opt).join("")}</optgroup>` : ""}</select><button class="mini primary" data-pend="pick">Add it to this PO</button>` : ""}
      <button class="mini ${open.length ? "" : "primary"}" data-pend="new">Start a new PO from it</button><button class="mini" data-pend="cancel">Cancel</button></div>`);
  }
  const file0 = (pend) => pend.f.name;
  async function pendGo(how) {
    const pend = S.pend; if (!pend) return;
    if (how === "cancel") { S.pend = null; note("", ""); render(); return; }
    note("", "");
    if (how === "pick") { const id = ($("pe-pendpo") || {}).value; if (!id) return; await openPO(id); return attach(pend, S.ed, ""); }
    S.ed = blankEd(); return attach(pend, S.ed, "A new purchase order starts from this invoice. ");
  }
  // the parsed invoice goes onto ed (a PO), and opens on the Invoices tab
  async function attach(pend, ed, msg) {
    const { inv, f, rows } = pend;
    S.mode = "inv";
    const dupHere = inv.invoice_no ? ed.invoices.findIndex(v => v.no && v.no.toLowerCase() === inv.invoice_no.toLowerCase()) : -1;
    if (dupHere >= 0) { ed.cur = dupHere; S.pend = null; showInvoicePage(); note("warn", `Invoice <b>${esc(inv.invoice_no)}</b> is already on this purchase order — here it is.`); return; }
    // an invoice with this number that was already saved: use it (its lines are replaced), unless another order has it
    let reuse = null;
    try {
      if (inv.invoice_no && (inv.vendor || ed.vendor)) {
        const d = await JT.rows(["i.id::text", "i.status", "coalesce(i.order_id, (select o.id from jt.prep_orders o where o.invoice_id = i.id limit 1))::text"],
          `from jt.invoices i where lower(i.vendor) = lower(${JT.q(inv.vendor || ed.vendor)}) and lower(i.invoice_no) = lower(${JT.q(inv.invoice_no)})`, true);
        if (d[0] && d[0][2] && d[0][2] !== ed.id) {
          S.pend = null; if (!ed.id) S.ed = null; S.invOpen = false; render();
          note("warn", `Invoice <b>${esc(inv.invoice_no)}</b> from ${esc(inv.vendor || ed.vendor)} is already saved on another purchase order. <button class="mini" data-inv-open="${esc(d[0][0])}">Open it</button>`);
          return;
        }
        if (d[0]) reuse = d[0][0];
      }
    } catch (e) { note("bad", esc(JT.message(e))); return; }
    const iv = merge(ed, inv, f, rows, reuse);
    const c = count(iv), open = [...progress(ed).values()].filter((p, i) => p.open > 0 && !ed.lines[i].backorder).length;
    msg += iv.fromPo ? `${!rows.length ? "This PDF has no text in it (probably a scan or photo)" : inv.lines.length ? "None of the lines read from this PDF matched a product" : "No item lines could be read from this PDF"}, so <b>the invoice was filled in from the PO</b>: ${iv.rows.filter(r => r.fromPo).length} product${iv.rows.filter(r => r.fromPo).length === 1 ? "" : "s"} still open on it, at the PO's quantities and costs. Check them against the PDF and change anything the vendor shipped short or billed differently.`
      : !rows.length ? "This PDF has no text in it (it's probably a scan or photo), so no lines could be read. Add them with <b>Add line</b>."
      : !inv.lines.length ? "No item lines were recognised in this PDF. The PDF is shown alongside; add what's missing by hand."
      : `Read ${inv.lines.length} line${inv.lines.length === 1 ? "" : "s"}: ${c.sure} matched${c.check ? `, <b>${c.check} guess${c.check === 1 ? "" : "es"} to check</b>` : ""}${c.none ? `, <b>${c.none} not matched</b>` : ""}.`
        + (open && ed.lines.length && ed.id ? ` ${open} product${open === 1 ? " on the PO isn't" : "s on the PO aren't"} on this invoice — mark them backordered on the PO, or leave them on order.` : "")
        + " Nothing is saved until you press Save.";
    showInvoicePage();
    note(c.none || c.check || !inv.lines.length ? "warn" : "info", msg);
  }
  // switch to the Invoices tab (it renders), or just render when it's already showing
  function goInvTab() {
    const tab = $("tab-invoices");
    if (tab && tab.hidden) { const b = document.querySelector('.tabs button[data-tab="invoices"]'); if (b) b.click(); } else render();
  }
  // the invoice page on the Invoices tab, for the current invoice of the open PO
  function showInvoicePage() {
    const ed = S.ed; if (!ed || !cur(ed)) return;
    S.mode = "inv"; S.invOpen = true; ed.confirm = false;
    const v = cur(ed);
    if (window.innerWidth >= 1100 && (v.file || v.parts)) ed.showPdf = true;
    if (v.parts && !v.file && !S.files.has(v.id)) loadFile(v).then(() => { if (S.ed === ed && cur(ed) === v) { const h2 = $("pe-pdf"); if (h2) h2.innerHTML = ""; renderPdf(); } }).catch(() => {});
    goInvTab();
  }
  // opening an invoice from the list (or another tab)
  async function openInvoice(id) {
    S.mode = "inv";
    if (S.ed && S.ed.dirty && !S.ed.invoices.some(v => v.id === String(id))) {
      S.invOpen = true; render();
      note("warn", `The open ${S.ed.id ? "purchase order" : "invoice"} has unsaved changes. <span class="dbtns"><button class="mini primary" data-pact="save">Save</button><button class="mini" data-pact="discard">Discard changes</button></span>`); return;
    }
    note("", "");
    try {
      const r = await JT.rows(["coalesce(i.order_id, (select o.id from jt.prep_orders o where o.invoice_id = i.id limit 1))::text", "i.invoice_no", "i.vendor"], `from jt.invoices i where i.id = ${JT.int(id)}`, true);
      if (!r[0]) { note("bad", "That invoice no longer exists."); return; }
      const oid = r[0][0];
      if (!oid) return linkChooser(String(id), r[0][1], r[0][2]);
      if (!S.ed || S.ed.id !== oid) await openPO(oid);
      if (!S.ed) return;
      const i = S.ed.invoices.findIndex(v => v.id === String(id)); if (i >= 0) S.ed.cur = i;
      S.pend = null; pdfToken++; showInvoicePage();
    } catch (e) { note("bad", esc(JT.message(e))); }
  }
  // an older invoice saved without a PO: link it to one
  function linkChooser(id, no, vendor) {
    S.invOpen = false; render();
    const open = (S.orders || []).filter(o => o.status !== "complete"), v = (vendor || "").toLowerCase();
    const same = open.filter(o => o.vendor.toLowerCase() === v), rest = open.filter(o => !same.includes(o));
    const opt = (o) => `<option value="${esc(o.id)}">${esc(o.vendor)} · ${esc(o.po ? poLabel(o.po) : "#" + o.id)} (${esc(STAGE.get(o.status))})</option>`;
    note("warn", `<b>Invoice ${esc(no || id)} from ${esc(vendor || "?")} isn't on a purchase order yet.</b> Link it to one:
      <div class="row"><select id="pe-linkpo" class="inp sm" style="width:auto;max-width:340px">${same.length ? `<optgroup label="${esc(vendor)}">${same.map(opt).join("")}</optgroup>` : ""}${rest.length ? `<optgroup label="Other">${rest.map(opt).join("")}</optgroup>` : ""}</select>
      <button class="mini primary" data-link="${esc(id)}" ${open.length ? "" : "disabled"}>Link it</button></div>`);
  }
  async function moveInvoice(iv, toOrder) {
    const ed = S.ed; S.busy = "Moving the invoice…"; render();
    try {
      await JT.po.moveInvoice(Number(iv.id), Number(toOrder));
      S.busy = ""; ed.confirm = false; S.ed = null; await loadOrders(true); await loadInvList(true);
      await openInvoice(iv.id);
      note("info", `Invoice ${esc(iv.no || "")} moved to ${esc((S.ed && S.ed.vendor) || "")} ${esc(S.ed && S.ed.po ? poLabel(S.ed.po) : "")}.`);
    } catch (e) { S.busy = ""; render(); note("bad", "Couldn't move it: " + esc(JT.message(e))); }
  }

  // ---------- the Invoices tab: the list ----------
  async function loadInvList(refresh) {
    if (S.invLoading && !refresh) return;
    S.invLoading = true;
    try {
      const r = await JT.rows(["i.id::text", "i.vendor", "i.invoice_no", "i.invoice_date::text", "i.due_date::text", "coalesce(i.total, i.subtotal)", "o.id::text", "o.po_no", "o.status", "o.vendor",
        "i.paid_on::text", "i.received_at::text", "i.qbo_bill_id", "i.file_parts",
        "(select coalesce(sum(qty), 0) from jt.invoice_receipts x where x.invoice_id = i.id)",
        "(select coalesce(sum(qty), 0) from jt.invoice_lines l where l.invoice_id = i.id and l.variant_id is not null and l.match_how <> 'skip')",
        "(select count(*) from jt.invoice_lines l where l.invoice_id = i.id and ((l.variant_id is null and l.match_how <> 'skip') or l.match_how like 'guess%'))",
        "i.created_at::text", "i.terms"],
        "from jt.invoices i left join jt.prep_orders o on o.id = coalesce(i.order_id, (select p.id from jt.prep_orders p where p.invoice_id = i.id limit 1)) order by coalesce(i.invoice_date, i.created_at::date) desc, i.id desc", refresh);
      S.invs = r.map(x => ({ id: x[0], vendor: x[9] || x[1] || "", no: x[2] || "", date: x[3] || "", due: x[4] || "", total: x[5] == null ? null : +x[5], oid: x[6] || "", po: x[7] || "", ostatus: x[8] || "",
        paidOn: x[10] || "", recvAt: x[11] || "", qbo: x[12] || "", parts: +x[13] || 0, got: +x[14] || 0, billed: +x[15] || 0, check: +x[16] || 0, created: x[17] || "", terms: x[18] || "" }));
    } finally { S.invLoading = false; }
  }
  const INVF = [["all", "All"], ["unpaid", "To pay"], ["noqb", "Not in QuickBooks"], ["notrecv", "Not received"], ["check", "Lines to check"], ["nopo", "No PO"]];
  const invMatch = (v, f) => f === "all" ? true : f === "unpaid" ? !v.paidOn : f === "noqb" ? !v.qbo : f === "notrecv" ? !v.recvAt : f === "check" ? v.check > 0 : f === "nopo" ? !v.oid : true;
  function renderInvList() {
    if (S.mode !== "inv" || $("tab-invoices").hidden) return;
    $("inv-list-view").hidden = false; $("po-edit-view").hidden = true;
    const all = S.invs || [];
    $("inv-status").textContent = S.invs ? `${all.length.toLocaleString()} invoice${all.length === 1 ? "" : "s"}` : "Loading invoices…";
    $("inv-seg").innerHTML = INVF.map(([k, n]) => `<button data-invf="${k}" aria-pressed="${S.invF === k}">${n} <span class="cnt">${all.filter(v => invMatch(v, k)).length}</span></button>`).join("");
    const unpaid = all.filter(v => !v.paidOn), late = unpaid.filter(v => v.due && v.due < today());
    $("inv-kpis").innerHTML = [
      { l: "To pay", v: m0(unpaid.reduce((a, v) => a + (v.total || 0), 0)), s: `${n0(unpaid.length)} unpaid invoice${unpaid.length === 1 ? "" : "s"}` },
      { l: "Overdue", v: m0(late.reduce((a, v) => a + (v.total || 0), 0)), s: late.length ? `<b class="neg">${n0(late.length)} past due</b>` : "nothing past due" },
      { l: "Not in QuickBooks", v: n0(all.filter(v => !v.qbo).length), s: "invoices still to send as bills" },
      { l: "Not received", v: n0(all.filter(v => !v.recvAt && v.billed > 0).length), s: "invoices with products still to come in" },
    ].map(k => `<div class="kpi"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
    const q = S.invQ.trim().toLowerCase().replace(/^#/, "");
    const list = all.filter(v => invMatch(v, S.invF) && (!q || [v.vendor, v.no, v.po, v.terms].join(" ").toLowerCase().includes(q)));
    const t = $("inv-table");
    if (!S.invs) { t.innerHTML = '<tbody><tr><td class="l muted">Loading…</td></tr></tbody>'; return; }
    t.innerHTML = `<thead><tr><th class="l">Invoice</th><th class="l">Vendor</th><th class="l">Date</th><th class="l">Purchase order</th><th>Total</th><th class="l">Received</th><th class="l">Payment</th><th class="l">QuickBooks</th></tr></thead><tbody>${
      list.map(v => `<tr class="po-row" data-inv-open="${v.id}" tabindex="0">
        <td class="l"><b class="mono">${esc(v.no || "(no number)")}</b>${v.parts ? ' <span class="pill pos" title="PDF stored">PDF</span>' : ""}${v.check ? ` <span class="pill miss">${v.check} to check</span>` : ""}</td>
        <td class="l">${esc(v.vendor || "—")}</td>
        <td class="l small">${v.date ? esc(shortDate(v.date)) : '<span class="dim">—</span>'}</td>
        <td class="l small">${v.oid ? `<button class="linkbtn small" data-po-go="${esc(v.oid)}">${esc(v.po ? poLabel(v.po) : "#" + v.oid)}</button> <span class="pill ${PILL[v.ostatus] || "pos"}">${esc(STAGE.get(v.ostatus) || "")}</span>` : '<span class="pill miss">No PO</span>'}</td>
        <td>${m(v.total)}</td>
        <td class="l small">${v.recvAt ? '<span class="pill ok">Received</span>' : v.got > 0 ? `<span class="pill manual">${n0(v.got)} of ${n0(v.billed)} in</span>` : v.billed ? '<span class="dim">not yet</span>' : '<span class="dim">—</span>'}</td>
        <td class="l small">${v.paidOn ? `<span class="pill ok">Paid</span> <span class="meta">${esc(shortDate(v.paidOn))}</span>` : v.due && v.due < today() ? `<span class="pill miss">Overdue</span> <span class="meta">due ${esc(shortDate(v.due))}</span>` : `<span class="pill warn">Unpaid</span>${v.due ? ` <span class="meta">due ${esc(shortDate(v.due))}</span>` : ""}`}</td>
        <td class="l small">${v.qbo ? '<span class="pill ok">In QuickBooks</span>' : '<span class="pill pos">Not yet</span>'}</td></tr>`).join("")
      || `<tr><td class="l muted" colspan="8">${all.length ? "No invoices match." : "No invoices yet. Upload a vendor invoice PDF — it's matched to its purchase order by the PO # on it."}</td></tr>`}</tbody>`;
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
    // no product lines could be read: start from what's still open on the PO (checked against the PDF by hand)
    const matched = iv.rows.some(r => r.vid && !r.skip);
    if (!p.lines.length || !matched) { const pr = poRows(ed); if (pr.length) { iv.unread = iv.rows.filter(r => !r.vid && !r.skip).length; iv.rows.unshift(...pr); iv.fromPo = true; } }
    ed.invoices.push(iv); ed.cur = ed.invoices.length - 1;
    syncLines(ed);
    ed.dirty = true; ed.showPdf = window.innerWidth >= 1100; ed.boPrompt = true;
    const h = $("pe-pdf"); if (h) h.innerHTML = "";
    return iv;
  }
  // Invoice lines from the PO: every product's quantity not yet on another invoice (and not received without one),
  // at the PO's cost. Used when an invoice's lines can't be read, and by "Fill from the PO".
  function poRows(ed, skipIv) {
    const inv = new Map();
    for (const iv of ed.invoices) if (iv !== skipIv) for (const r of iv.rows) if (r.vid && !r.skip && isSure(r)) inv.set(r.vid, (inv.get(r.vid) || 0) + (Number(r.qty) || 0));
    const by = new Map();
    for (const l of ed.lines) { if (l.backorder) continue; const a = by.get(l.vid) || { q: 0, cost: "" }; a.q += Number(l.qty) || 0; if (a.cost === "" && l.cost !== "") a.cost = l.cost; by.set(l.vid, a); }
    const out = [], here = new Set(skipIv ? skipIv.rows.filter(r => r.vid && !r.skip).map(r => r.vid) : []);
    for (const [vid, a] of by) {
      const q = a.q - (inv.get(vid) || 0); if (q <= 0 || here.has(vid)) continue;
      const v = variant(vid) || {}, cost = a.cost !== "" ? a.cost : fmtCost(v.cost);
      out.push({ id: newId(), src: { item_code: v.sku || "", upc: "", description: v.title || "", qty: q, unit_cost: cost === "" ? null : Number(cost), amount: cost === "" ? null : q * Number(cost) },
        vid, how: "po", conf: "sure", alts: [], confirmed: true, skip: false, account: "inventory", qty: String(q), cost, fromPo: true });
    }
    return out;
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
    if (!shopOff(ed)) {
    if (ed.id && ed.status !== "draft" && !ed.shopifyUrl.trim()) out.push({ lvl: "info", kind: "noshopify", title: "Not linked to a Shopify PO",
      text: "Create the same PO in Shopify (Products → Purchase orders) and paste its link here, so the two stay in step.",
      fixes: [{ label: "Paste the link", fix: "focus", arg: "pe-shopify" }, { label: "Shopify purchase orders", href: `${ADMIN}/purchase_orders/new` }] });
    if (ed.shopCheck) { const sd = shopDiffs(ed); if (sd.n) out.push({ lvl: "warn", kind: "shopdiff", title: `Doesn't match the Shopify PO · ${sd.n} difference${sd.n === 1 ? "" : "s"}`,
      text: sd.rows.filter(r => r.kinds.length).slice(0, 3).map(r => esc(r.title) + ": " + r.kinds.map(k => SDIFF[k]).join(", ")).join(" · ") + (sd.n > 3 ? " · …" : ""),
      fixes: [{ label: "Show the differences", fix: "focus", arg: "pe-shopcheck" }] }); }
    else if (ed.id && ed.shopifyUrl.trim() && ed.lines.length) out.push({ lvl: "info", kind: "shopnocheck", title: "Linked to a Shopify PO — check that it matches",
      text: "Download the PO as a PDF in Shopify and upload it here; every product, quantity and cost is compared with this PO.", fixes: [{ label: "Upload the Shopify PO PDF", fix: "focus", arg: "pe-shopfile" }] });
    }
    if (ed.status === "received") out.push({ lvl: "info", kind: "toqb", title: "Received — enter the bills in QuickBooks",
      text: "Send each invoice to QuickBooks (on the Invoices tab), then mark this PO QB ready.", fixes: [{ label: "Mark QB ready", fix: "onext" }] });
    if (ed.status === "qb_ready") out.push({ lvl: "info", kind: "tocomplete", title: "In QuickBooks — mark the PO complete",
      text: "Payments are tracked on each invoice (Invoices tab), so the PO can be completed now.", fixes: [{ label: "Mark complete", fix: "onext" }] });
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
    if (o.status !== "draft" && !o.shopifyUrl && !shopOffO(o)) f.push(["info", "not in Shopify"]);
    if (o.shopDiffs) f.push(["warn", `Shopify PO differs · ${o.shopDiffs}`]);
    else if (o.shopifyUrl && o.shopDiffs == null && o.status !== "draft" && !shopOffO(o)) f.push(["info", "Shopify PO not checked"]);
    if (o.nBack) f.push([o.backEta && o.backEta < today() ? "warn" : "info", `${o.nBack} backordered${o.backEta ? " · ETA " + shortDate(o.backEta) : ""}`]);
    if (o.status === "partial" && !o.nBack) f.push(["info", "rest not backordered"]);
    if (o.status === "received") f.push(["info", "enter in QuickBooks"]);
    if (o.status === "qb_ready") f.push(["info", "complete it"]);
    return f;
  }

  // ---------- rendering: list ----------
  function render() {
    if (!shown()) return; place(); renderBusy();
    if (S.mode === "inv") { if (S.ed && S.invOpen) renderEditor(); else renderInvList(); return; }
    if (S.ed) renderEditor(); else renderList();
  }
  function renderBusy() { const b = $("po-busy"); if (!b) return; b.hidden = !S.busy; b.textContent = S.busy || ""; }
  function renderList() {
    if (S.mode !== "po" || $("tab-po").hidden) return;
    $("po-list-view").hidden = !!S.ed; $("po-edit-view").hidden = !S.ed;
    if (S.ed) return;
    if (!S.spos && !S.sposLoading) { S.sposLoading = true; loadShopPos(false).then(() => render(), () => {}).finally(() => { S.sposLoading = false; }); }
    const shopView = S.listView === "shop";
    document.querySelectorAll("#po-listview button").forEach(b => b.setAttribute("aria-pressed", String((b.dataset.lv === "shop") === shopView)));
    $("po-kpis").style.display = shopView ? "none" : ""; $("po-sslist").style.display = shopView ? "none" : "";
    const ph = $("po-pickshop-host"), hadFocus = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.ps === "q";
    ph.innerHTML = pickShopHtml();
    if (hadFocus) { const i = ph.querySelector('[data-ps="q"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
    const all = S.orders || [];
    const isOpen = (o) => o.status !== "complete";
    const cnt = (st) => all.filter(o => st === "open" ? isOpen(o) : st === "all" ? true : o.status === st).length;
    $("po-stage").innerHTML = [["open", "Open"], ...STAGES, ["all", "All"]].map(([k, n]) => `<button data-st="${k}" aria-pressed="${S.stage === k}">${n} <span class="cnt">${cnt(k)}</span></button>`).join("");
    const vs = [...new Set(all.map(o => o.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const vsel = $("po-vendor"); const want = ["all", ...vs].join("|");
    if (vsel.dataset.opts !== want) { vsel.innerHTML = `<option value="all">All vendors</option>` + vs.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(""); vsel.dataset.opts = want; vsel.value = vs.includes(S.vendor) ? S.vendor : "all"; }
    const open = all.filter(isOpen), out = all.filter(o => ["ordered", "invoiced", "partial"].includes(o.status));
    const flagged = open.filter(o => listFlags(o).some(f => f[0] !== "info"));
    $("po-kpis").innerHTML = [
      { l: "Open POs", v: n0(open.length), s: `${all.filter(o => o.status === "draft").length} draft · ${out.length} placed, not all received` },
      { c: "cost", l: "On order", v: m0(out.reduce((a, o) => a + o.cost * (o.units ? Math.max(0, o.units - o.received) / o.units : 1), 0)), s: `${n0(out.reduce((a, o) => a + Math.max(0, o.units - o.received), 0))} units to come, at cost` },
      { l: "Backordered", v: n0(all.reduce((a, o) => a + o.nBack, 0)), s: "products still to come on open POs" },
      { l: "Needs attention", v: n0(flagged.length), s: flagged.length ? "late, unmatched lines, guesses, no invoice" : "nothing flagged" },
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
        return `<tr class="po-row" data-po-open="${o.id}" tabindex="0"><td class="l"><b class="mono">${esc(o.po ? poLabel(o.po) : "#" + o.id)}</b>${o.kind === "booking" ? ' <span class="pill warn">Booking</span>' : ""}${shopOffO(o) && !o.shopifyUrl ? '<div><span class="small muted">Seller Sage only</span></div>' : o.shopifyUrl || o.shopDiffs != null ? `<div>${o.shopifyUrl ? `<a class="small" href="${esc(shopUrl(o.shopifyUrl))}" target="_blank" rel="noopener">Shopify PO ↗</a>` : '<span class="small muted">Shopify PO</span>'}${o.shopDiffs === 0 ? ' <span class="pill ok" title="Checked against the Shopify PO">matches</span>' : o.shopDiffs ? ` <span class="pill miss" title="Checked against the Shopify PO">${o.shopDiffs} difference${o.shopDiffs === 1 ? "" : "s"}</span>` : ""}${o.shopStatus ? " " + shopStatusPill(o.shopStatus) : ""}</div>` : ""}</td>
          <td class="l">${esc(o.vendor || "—")}</td>
          <td class="l"><span class="pill ${PILL[o.status]}">${STAGE.get(o.status)}</span></td>
          <td>${n0(o.nLines)}<div class="meta">${!o.units ? esc({ shopify: "→ Shopify", prep: "→ Prep", both: "→ Both" }[o.into] || "") : o.prepUnits === 0 ? "→ Shopify" : o.prepUnits >= o.units ? "→ Prep" : `→ Both`}</div></td><td>${n0(o.units)}${o.units && o.prepUnits > 0 && o.prepUnits < o.units ? `<div class="meta">${n0(o.units - o.prepUnits)} Shopify · ${n0(o.prepUnits)} prep</div>` : ""}</td><td>${o.nInv ? n0(o.invoiced) : '<span class="dim">—</span>'}</td><td>${o.received ? n0(o.received) : '<span class="dim">—</span>'}</td><td>${m0(o.cost)}</td>
          <td class="l small">${o.nInv ? `<span class="mono">${esc(o.invNos || "invoice")}</span>${o.nInv > 1 ? ` <span class="pill manual">${o.nInv} invoices</span>` : ""}${o.nFiles ? ' <span class="pill pos" title="PDF attached">PDF</span>' : ""}${o.invTotal != null ? `<div class="meta">${m(o.invTotal)}</div>` : ""}` : '<span class="dim">—</span>'}</td>
          <td class="l small">${dates}</td>
          <td class="l">${fl.map(f => `<span class="pill ${f[0] === "info" ? "pos" : "miss"}">${esc(f[1])}</span>`).join("")}</td></tr>`;
      }).join("") || `<tr><td class="l muted" colspan="11">${S.stage === "open" && !q ? "No open purchase orders. Start one with New PO, then add the vendor's invoices to it." : "No purchase orders match."}</td></tr>`}</tbody>`;
  }

  // ---------- rendering: editor ----------
  function renderEditor() {
    const ed = S.ed; if (!ed) return;
    if (S.mode === "inv") return renderInvoicePage();
    $("po-list-view").hidden = true; $("po-edit-view").hidden = false;
    const box = $("po-edit-view");
    const keep = document.activeElement && box.contains(document.activeElement) ? { id: document.activeElement.id, k: document.activeElement.dataset.k, f: document.activeElement.dataset.f, s: document.activeElement.selectionStart } : null;
    const ro = ed.status === "complete", got = GOT.includes(ed.status);
    const at = ORDER.indexOf(ed.status);
    // the stage pills: before anything is received you can jump between draft / ordered / invoiced; after that, the
    // next stage (received → QB ready → complete) is a click too
    const steps = STAGES.map(([k, n], i) => { const click = ed.id && k !== ed.status && ((!got && PRE.includes(k) && !ed.lines.some(l => l.received > 0)) || (NEXT[ed.status] && NEXT[ed.status][0] === k && GOT.includes(k)));
      return `<${click ? "button" : "span"} class="step ${k === ed.status ? "on" : i < at ? "done" : ""}" ${click ? `data-pgo="${k}" title="Move to ${n}"` : ""}>${n}</${click ? "button" : "span"}>`; }).join('<span class="step-sep">→</span>');
    const pr = progress(ed), iss = S.cat ? poIssues(ed) : [];
    let tot = { ordered: 0, invoiced: 0, received: 0, open: 0, back: 0, cost: 0 };
    for (const l of ed.lines) { const p = pr.get(l.id); tot.ordered += p.ordered; tot.invoiced += p.invoiced; tot.received += p.received; tot.open += p.open; if (l.backorder) tot.back += p.open; tot.cost += lineAmt(l); }
    const openLines = ed.lines.filter(l => pr.get(l.id).open > 0 && !l.backorder);
    const vendorOpts = S.vendors.map(v => `<option value="${esc(v)}">`).join("");
    const found = !ro && !ed.recv && ed.add.trim() ? findProducts(ed.add) : [];
    const lbl = (l) => window.JTListingLabel ? window.JTListingLabel(l) : l.sku;
    const both = ed.dest === "both" || new Set(ed.lines.map(l => l.dest)).size > 1;
    const anyInv = ed.invoices.length > 0;
    // the PO table keeps what isn't on an invoice yet; invoiced products are received on their invoice
    const onTop = (l) => { const p = pr.get(l.id); return !anyInv || p.open > 0 || (p.invoiced === 0 && p.received === 0); };
    const topLines = ed.lines.filter(onTop);
    const NC = 9 + (anyInv ? 0 : 1) + (ed.recv ? 1 : 0), NCI = 8;
    const ivNow = cur(ed), ivSh = ivNow && ivNow.id && !ivNow.isNew ? invShares(ed, ivNow) : new Map();
    const canRecv = !!ed.id && !ro && !["qb_ready", "complete"].includes(ed.status);
    // a product split across the Shopify store and the prep center: its total on every part
    const splitTot = (l) => { const parts = ed.lines.filter(x => x.vid === l.vid); if (parts.length < 2) return "";
      const q = (x) => Number(x.qty) || 0, sum = parts.reduce((a, x) => a + q(x), 0), tot = ed.splitTot && ed.splitTot[l.vid] != null ? ed.splitTot[l.vid] : sum;
      const rec = parts.reduce((a, x) => a + (x.received || 0), 0), sh = parts.filter(x => x.dest === "shopify").reduce((a, x) => a + q(x), 0), pp = sum - sh;
      return `<div class="splittot"><span class="pill manual">Split</span> <b class="num">${n0(tot)}</b> total · ${n0(sh)} Shopify + ${n0(pp)} prep${rec ? ` · ${n0(rec)} received` : ""}${sum !== tot ? ` <span class="neg">· parts add to ${n0(sum)}</span>` : ""}</div>`; };
    const canSplit = (l) => !ro && !ed.recv && ed.lines.filter(x => x.vid === l.vid).reduce((a, x) => a + (Number(x.qty) || 0), 0) > 1;
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
    const costInp = (l, v, chg, mode) => `${!ro && !ed.recv ? `<input class="inp num sm ${l.cost !== "" && !(Number(l.cost) >= 0) ? "bad" : ""}" data-f="cost" data-k="${l.id}" value="${esc(l.cost)}" inputmode="decimal" placeholder="${v && v.cost != null ? v.cost.toFixed(2) : "cost"}" style="width:76px">` : m(l.cost === "" ? v && v.cost : Number(l.cost))}`;
    const prodCell = (l, v) => `<td class="l">${v ? `<a class="olink" href="${ADMIN}/products/${esc(v.pid)}/variants/${esc(v.vid)}" target="_blank" rel="noopener">${esc(v.title)}</a><div class="meta"><span class="mono">${esc(v.sku) || "no SKU"}</span>${v.vendor ? " · " + esc(v.vendor) : ""}${l.auto ? ' <span class="pill manual" title="On an invoice but not on the PO when it was placed">added from invoice</span>' : ""}</div>${splitTot(l)}` : `<span class="dim">variant ${esc(l.vid)} (not in the catalog)</span>`}</td>`;
    const forCell = (l) => `<td class="l small"><div class="forcell">${destSel(l)}${canSplit(l) ? `<button class="linkbtn small" data-pact="split" data-k="${l.id}" title="Split between the Shopify store and one or more prep-center ASINs">Split</button>` : ""}</div></td>`;
    const unitOf = (l, v) => l.cost === "" ? (v && v.cost) || 0 : Number(l.cost) || 0;
    // the purchase order: what hasn't been invoiced yet
    const lineRow = (l) => {
      const v = variant(l.vid), p = pr.get(l.id), badQ = l.qty !== "" && !(Number.isInteger(Number(l.qty)) && Number(l.qty) >= 0);
      const chg = v && v.cost > 0 && l.cost !== "" && !isNaN(Number(l.cost)) ? (Number(l.cost) - v.cost) / v.cost : null;
      const extra = ivSh.has(l.id) ? "" : (ed.split && ed.split.id === l.id ? splitRow(l, NC) : "") + (ed.unrecv && ed.unrecv.id === l.id ? unrecvRow(l, NC) : "");
      return `<tr data-line="${l.id}">${prodCell(l, v)}${forCell(l)}
        <td>${!ro && !ed.recv ? `<input class="inp num sm ${badQ || p.ordered < p.received ? "bad" : ""}" data-f="qty" data-k="${l.id}" value="${esc(l.qty)}" inputmode="numeric" placeholder="0" style="width:64px">` : n0(p.ordered)}</td>
        ${anyInv ? `<td>${p.invoiced ? n0(p.invoiced) : '<span class="dim">—</span>'}</td><td><b class="num">${n0(p.open)}</b></td>`
          : `<td>${p.received ? n0(p.received) : '<span class="dim">—</span>'}${canUnrecv(l) ? `<div><button class="linkbtn small" data-pact="unrecv1" data-k="${l.id}" title="Take some or all of these back off the received count">un-receive</button></div>` : ""}</td>`}
        ${ed.recv ? `<td><input class="inp num sm" data-f="recv" data-k="${l.id}" value="${esc(ed.recv[keyOf(l)] ?? "")}" inputmode="numeric" placeholder="0" style="width:64px"></td>` : ""}
        <td class="l small">${p.open > 0 && !ro ? `<label class="inline bo"><input type="checkbox" data-f="bo" data-k="${l.id}" ${l.backorder ? "checked" : ""}> backordered</label>${l.backorder ? `<input class="inp sm" type="date" data-f="eta" data-k="${l.id}" value="${esc(l.eta)}" aria-label="Expected arrival" style="width:auto">` : ""}` : l.eta && p.open > 0 ? shortDate(l.eta) : !anyInv ? `<span class="pill ${p.st[1]}">${esc(p.st[0])}</span>` : '<span class="dim">—</span>'}</td>
        <td>${costInp(l, v, chg, "po")}</td>
        <td>${m(anyInv ? p.open * unitOf(l, v) : lineAmt(l))}</td>
        <td class="nowrap">${!ro && !ed.recv && !(l.received > 0) && !p.invoiced ? `<button class="linkbtn small" data-pact="rmline" data-k="${l.id}" title="Take off the PO" aria-label="Remove line">✕</button>` : ""}</td></tr>${extra}`;
    };
    // one invoice's products: receive them here, once Receive is pressed for this invoice
    const recvOn = !!(ivNow && ivNow.id && ed.recvInv === ivNow.id);
    const invRow = (l) => {
      const v = variant(l.vid), sh = ivSh.get(l.id);
      const chg = v && v.cost > 0 && l.cost !== "" && !isNaN(Number(l.cost)) ? (Number(l.cost) - v.cost) / v.cost : null;
      let rq = sh.left > 0 ? '' : '<span class="pill ok">All in</span>';
      if (sh.left > 0 && canRecv && recvOn) { const val = rqVal(ed, ivNow, l, sh), bad = val !== "" && !(Number.isInteger(Number(val)) && Number(val) >= 0);
        rq = `<div class="rq"><input class="inp num sm ${bad ? "bad" : ""}" data-f="rq" data-k="${l.id}" value="${esc(val)}" inputmode="numeric" placeholder="0" style="width:60px" aria-label="Quantity arrived"><button class="mini primary" data-pact="rq-go" data-k="${l.id}">Receive</button></div>${val !== String(sh.left) ? `<div class="meta warnt">invoice: ${n0(sh.left)}</div>` : ""}`; }
      else if (sh.left > 0) rq = `<span class="dim">${n0(sh.left)} to come</span>`;
      return `<tr data-line="${l.id}">${prodCell(l, v)}${forCell(l)}
        <td>${n0(sh.billed)}</td>
        <td>${sh.got ? n0(sh.got) : '<span class="dim">—</span>'}${canUnrecv(l) ? `<div><button class="linkbtn small" data-pact="unrecv1" data-k="${l.id}" title="Take some or all of these back off the received count">un-receive</button></div>` : ""}</td>
        <td class="rcv">${rq}</td>
        <td>${costInp(l, v, chg, "inv")}</td>
        <td>${m(sh.billed * unitOf(l, v))}</td><td></td></tr>${ed.split && ed.split.id === l.id ? splitRow(l, NCI) : ""}${ed.unrecv && ed.unrecv.id === l.id ? unrecvRow(l, NCI) : ""}`;
    };
    const unrecvRow = (l, NC) => {
      const v = variant(l.vid) || {}, n = ed.unrecv.n, bad = n !== "" && !(Number.isInteger(Number(n)) && Number(n) > 0 && Number(n) <= l.received);
      return `<tr class="splitrow"><td colspan="${NC}" class="l"><div class="splitbox"><b>Un-receive ${esc(v.title || "this product")}</b>
        <label class="inline"><input id="pe-unrq" class="inp num sm ${bad ? "bad" : ""}" data-f="unrq" value="${esc(n)}" inputmode="numeric" style="width:64px"> of ${n0(l.received)} received</label>
        <span class="small muted">${l.dest === "prep" ? "They come back out of the prep center (refused if they already shipped out)." : "They come off this PO's received count (Shopify's own stock isn't changed)."}</span>
        <span class="dbtns"><button class="mini primary" data-pact="unrecv1-go" ${bad || S.busy ? "disabled" : ""}>Un-receive</button><button class="mini" data-pact="unrecv1-no">Cancel</button></span></div></td></tr>`;
    };
    const splitRow = (l, NC) => {
      const sp = ed.split, v = variant(l.vid) || {}, ls = (S.listings.get(l.vid) || []).slice().sort((a, b) => a.units - b.units || String(a.asin).localeCompare(String(b.asin)));
      const sum = sp.parts.reduce((a, x) => a + (Number(x.q) || 0), 0);
      const opt = (x, cur) => `<option value="${esc(x.sku)}" ${cur === x.sku ? "selected" : ""} title="${esc(x.title || "")}">${esc(lbl(x))}</option>`;
      const part = (x, i) => {
        const locked = x.received > 0 ? ` <span class="meta" title="Already received here — it can't go below that">${n0(x.received)} received</span>` : "";
        const where = x.dest === "shopify" ? '<span class="sp-where">Shopify store</span>'
          : `<span class="sp-where">Prep center</span><select class="inp sm" data-f="spa" data-k="${i}" style="width:auto;max-width:240px" aria-label="ASIN" ${x.received > 0 ? "disabled" : ""}><option value="" ${!x.asku ? "selected" : ""}>any ASIN (assign later)</option>${ls.map(y => opt(y, x.asku)).join("")}${x.asku && !ls.some(y => y.sku === x.asku) ? `<option selected value="${esc(x.asku)}">${esc(x.asku)}</option>` : ""}</select>`;
        return `<div class="sp-part"><input class="inp num sm" data-f="spq" data-k="${i}" value="${esc(x.q)}" inputmode="numeric" placeholder="0" style="width:64px" aria-label="Quantity"> ${where}${locked}
          ${x.dest === "prep" && !(x.received > 0) && sp.parts.filter(y => y.dest === "prep").length > 1 ? `<button class="linkbtn small" data-pact="sp-rm" data-k="${i}" aria-label="Remove this part">✕</button>` : ""}</div>`;
      };
      return `<tr class="splitrow"><td colspan="${NC}" class="l"><div class="splitbox sp-multi"><b>Split ${esc(v.title || "this product")}</b>
        <div class="sp-parts">${sp.parts.map(part).join("")}</div>
        <div class="sp-foot"><button class="mini" data-pact="sp-add">+ Another ASIN</button>
          <span class="small ${sum !== sp.total ? "warnt" : "muted"}">${n0(sum)} of ${n0(sp.total)}${sum !== sp.total ? ` — the PO quantity becomes ${n0(sum)}` : ""}</span>
          <span class="dbtns"><button class="mini primary" data-pact="split-go">Split</button><button class="mini" data-pact="split-no">Cancel</button></span></div></div></td></tr>`;
    };
    const bucket = (d) => {
      const ls = topLines.filter(l => l.dest === d), u = ls.reduce((a, l) => a + (anyInv ? pr.get(l.id).open : Number(l.qty) || 0), 0), c = ls.reduce((a, l) => a + (anyInv ? pr.get(l.id).open * unitOf(l, variant(l.vid)) : lineAmt(l)), 0);
      return `<tr class="bucket ${d}"><td colspan="${NC}" class="l"><b>→ ${DESTN[d]}</b><span class="muted small"> · ${ls.length} product${ls.length === 1 ? "" : "s"} · ${n0(u)} units${anyInv ? " not invoiced" : ""} · ${m(c)}</span></td></tr>`
        + (ls.map(lineRow).join("") || `<tr><td colspan="${NC}" class="l muted small">${anyInv ? "Nothing here left to invoice." : "Nothing going here yet — switch products here in the first column, or Split one."}</td></tr>`);
    };
    const lineRows = both ? bucket("shopify") + bucket("prep") : topLines.map(lineRow).join("");
    // the current invoice's receiving table, shown in the invoice area
    const recvHtml = (() => {
      if (!ivNow) return "";
      if (!ivNow.id || ivNow.isNew) return '<div class="note info">Save to start receiving against this invoice.</div>';
      const ls = ed.lines.filter(l => ivSh.has(l.id)), c = count(ivNow), t = invTot(ivNow);
      const anyLeft = ls.some(l => ivSh.get(l.id).left > 0);
      const back = ed.lines.filter(l => l.backorder && pr.get(l.id).open > 0).length;
      const left = ls.reduce((a, l) => { const x = Number(rqVal(ed, ivNow, l, ivSh.get(l.id))); return a + (ivSh.get(l.id).left > 0 && Number.isInteger(x) && x > 0 ? x : 0); }, 0);
      const btn = ivNow.recvAt ? (ivNow.recvManual && !ro ? '<button class="mini" data-pact="inv-reopen" title="Take the received mark off this invoice">Reopen</button>' : "")
        : !ro && t.g > 0 ? '<button class="mini" data-pact="inv-recvd" title="Count this invoice as received in full, e.g. the vendor shipped less than they billed">Mark received</button>' : "";
      return `<div class="po-recv"><div class="panel-head"><h3 class="h3">Receive this invoice ${recvPill(ivNow)}</h3>
          <span class="muted small">${ivNow.recvAt ? "Received in full." : `${n0(t.g)} of ${n0(t.b)} units in.`}${back ? ` The PO stays open for ${back} backordered product${back === 1 ? "" : "s"}.` : ""}</span>
          <span class="dbtns right">${btn}${canRecv && !ivNow.recvAt && ls.length && anyLeft ? (recvOn
            ? `<button class="btn" data-pact="rq-stop">Done receiving</button><button class="btn primary" data-pact="rq-all" ${S.busy || !left ? "disabled" : ""}>Receive all${left ? ` (${n0(left)} units)` : ""}</button>`
            : `<button class="btn primary" data-pact="rq-start" title="Open receiving for this invoice">Receive</button>`) : ""}</span></div>
        ${recvOn && canRecv && anyLeft ? `<div class="note info small">Receiving invoice <b>${esc(ivNow.no || "")}</b>: enter what arrived for each product and press its Receive button, or Receive all. You stay on this invoice until you press Done receiving.</div>` : ""}
        ${c.check ? `<div class="note warn">${c.check} guessed product${c.check === 1 ? "" : "s"} on this invoice ${c.check === 1 ? "needs" : "need"} confirming on the invoice before ${c.check === 1 ? "it" : "they"} can be received. <button class="mini" data-pact="open-inv">Open the invoice</button></div>` : ""}
        ${ls.length ? `<div class="tbl-wrap xl"><table class="prept po-t"><thead><tr><th class="l">Product</th><th class="l">For</th><th>On invoice</th><th>Received</th><th>Receive</th><th>Unit cost</th><th>Ext.</th><th></th></tr></thead><tbody>${ls.map(invRow).join("")}</tbody></table></div>` : '<div class="muted small">No matched products on this invoice yet.</div>'}
      </div>`;
    })();
    const destTot = (d) => { const ls = ed.lines.filter(l => l.dest === d); return [ls.reduce((a, l) => a + (Number(l.qty) || 0), 0), ls.reduce((a, l) => a + lineAmt(l), 0)]; };
    const iv = cur(ed);
    const pdfOn = !!(iv && ed.showPdf && (iv.file || iv.parts));
    box.innerHTML = `
      <div class="po-top">
        <div class="po-crumb"><button class="linkbtn" data-pact="back-list">← All purchase orders</button>${ed.dirty ? '<span class="pill warn">Unsaved changes</span>' : ed.id ? '<span class="muted small">All changes saved</span>' : ""}
          <span class="dbtns right">${ed.id && ["received", "qb_ready"].includes(ed.status) && !ed.recv ? `<button class="btn primary" data-pact="next-stage" ${S.busy ? "disabled" : ""}>${NEXT[ed.status][1]}</button>` : ""}<button class="btn ${ed.dirty || !ed.id ? "primary" : ""}" data-pact="save" ${S.busy || (!ed.dirty && ed.id) || ed.recv ? "disabled" : ""} title="Save this purchase order (⌘S / Ctrl+S)">${S.busy === "Saving…" ? "Saving…" : ed.dirty || !ed.id ? "Save" : "Saved"}</button></span></div>
        <div class="po-head"><h2>${ed.id ? `<button class="hlink" data-hedit="pe-vendor" title="Edit the vendor">${esc(ed.vendor || "Vendor order")}</button> · <button class="hlink" data-hedit="pe-po" title="Edit the PO number">${esc(ed.po ? poLabel(ed.po) : "#" + ed.id)}</button>` : "New purchase order"}${ed.kind === "booking" ? ' <span class="pill warn">Booking</span>' : ""}${shopOff(ed) ? ' <span class="pill pos" title="No Shopify PO for this order">Seller Sage only</span>' : shopBadge(ed, ro)}</h2><span class="steps six seven">${steps}</span></div>
        ${headStrip(ed, ro, both)}
        ${ed.lines.length ? `<div class="po-sum">${[["Ordered", tot.ordered], ["Invoiced", tot.invoiced], ["Received", tot.received], ["On order", tot.open - tot.back], ["Backordered", tot.back]].map(([k, v]) => `<span><b class="num">${n0(v)}</b> ${k.toLowerCase()}</span>`).join("")}<span><b class="num">${m(tot.cost)}</b> at cost</span>${both ? ["shopify", "prep"].map(d => { const [u, c] = destTot(d); return `<span class="dchip ${d}">→ ${DESTN[d]} <b class="num">${n0(u)}</b> · ${m(c)}</span>`; }).join("") : ""}</div>` : ""}
      </div>
      ${!ed.id || ed.editHead ? `<section class="panel po-headedit">${ed.id ? `<div class="panel-head"><h2>PO details</h2><span class="dbtns right"><button class="btn" data-pact="head-done">Done</button></span></div>` : ""}
        <div class="pmgrid">
          <label class="stack" for="pe-vendor">Vendor<input id="pe-vendor" class="inp" list="pe-vendors" value="${esc(ed.vendor)}" ${got ? "disabled" : ""} autocomplete="off" placeholder="Shopify vendor"><datalist id="pe-vendors">${vendorOpts}</datalist></label>
          <label class="stack" for="pe-po">PO #<input id="pe-po" class="inp mono" value="${esc(ed.po)}" ${ro ? "disabled" : ""}></label>
          <label class="stack">Type<span class="seg"><button data-pkind="order" aria-pressed="${ed.kind !== "booking"}" ${ed.status !== "draft" ? "disabled" : ""}>Order</button><button data-pkind="booking" aria-pressed="${ed.kind === "booking"}" ${ed.status !== "draft" ? "disabled" : ""}>Booking</button></span></label>
          ${ed.kind === "booking" ? `<label class="stack" for="pe-placeby">Place by<input id="pe-placeby" class="inp" type="date" value="${esc(ed.placeBy)}" ${ed.status !== "draft" ? "disabled" : ""}></label>` : ""}
          <label class="stack" for="pe-exp">Expected<input id="pe-exp" class="inp" type="date" value="${esc(ed.expected)}" ${ro ? "disabled" : ""}></label>
          ${shopOff(ed) ? `<div class="stack"><span>Shopify PO</span><div class="small muted noshop">${prepOnly(ed) && !ed.noShop ? "None needed — everything on this PO goes to the prep center" : "None — Seller Sage only"}${ed.noShop && !ro ? ' <button class="linkbtn small" data-pact="yesshop">Link a Shopify PO</button>' : ""}</div></div>` : `<label class="stack" for="pe-shopify"><span>Shopify PO${ed.shopStatus ? " " + shopStatusPill(ed.shopStatus) : ""}${shopUrl(ed.shopifyUrl) && /^https:/.test(shopUrl(ed.shopifyUrl)) ? ` <a class="small" href="${esc(shopUrl(ed.shopifyUrl))}" target="_blank" rel="noopener">open ↗</a>` : ` <a class="small dim" href="${ADMIN}/purchase_orders" target="_blank" rel="noopener">Shopify POs ↗</a>`}${!ro && ed.lines.length ? ' <button class="linkbtn small" data-pact="noshop" title="This order has no Shopify PO: stop asking for one">No Shopify PO</button>' : ""}</span><input id="pe-shopify" class="inp" value="${esc(ed.shopifyUrl)}" placeholder="optional · paste the link from Shopify" autocomplete="off"></label>`}
          <label class="stack" for="pe-dest">Receive into<select id="pe-dest" class="inp" ${ro ? "disabled" : ""}><option value="shopify" ${ed.dest === "shopify" ? "selected" : ""}>Shopify store</option><option value="prep" ${ed.dest === "prep" ? "selected" : ""}>Prep center (Amazon)</option><option value="both" ${both ? "selected" : ""}>Both — choose per product</option></select></label>
          <label class="stack" for="pe-note" style="grid-column:1 / -1">Note<input id="pe-note" class="inp" value="${esc(ed.note)}" ${ro ? "disabled" : ""} placeholder="e.g. ships in two drops"></label>
        </div>
      </section>` : ""}
      ${shopCheckHtml(ed, ro)}
      ${iss.length ? `<section class="po-issues">${window.JTIssues.issuesHtml(iss)}</section>` : ""}
      <section class="panel po-lines">
        <div class="panel-head"><h2>${anyInv ? "Purchase order · not invoiced yet" : "Products on this PO"}</h2><span class="muted small">${anyInv ? "as the vendor invoices products they move to that invoice below, where they're received" : "what was ordered · receiving is against these"}</span></div>
        ${openLines.length && !ro && !ed.recv && ed.invoices.length ? `<div class="bobar ${ed.boPrompt ? "hot" : ""}"><span><b>${openLines.length} product${openLines.length === 1 ? "" : "s"}</b> ${openLines.length === 1 ? "isn't" : "aren't"} on an invoice yet (${n0(openLines.reduce((a, l) => a + pr.get(l.id).open, 0))} units).</span>
            <span class="dbtns"><label class="small" for="pe-boeta">Expected</label><input id="pe-boeta" class="inp sm" type="date" style="width:auto" aria-label="Expected arrival for the backorders (blank if unknown)">
            <button class="btn primary" data-pact="bo-all">Mark ${openLines.length === 1 ? "it" : "all " + openLines.length} backordered</button>${ed.boPrompt ? '<button class="btn" data-pact="bo-no">Keep on order</button>' : ""}</span></div>` : ""}
        ${anyInv && ed.lines.length && !topLines.length ? `<div class="note ok">Everything on this PO is on an invoice — receive it in the invoice below.</div>`
          : ed.lines.length ? `<div class="tbl-wrap xl"><table class="prept po-t"><thead><tr><th class="l">Product</th><th class="l">For</th><th>Ordered</th>${anyInv ? "<th>Invoiced</th><th>Not invoiced</th>" : "<th>Received</th>"}${ed.recv ? "<th>Arrived now</th>" : ""}<th class="l">${anyInv ? "Backorder · ETA" : "Status · backorder"}</th><th>Unit cost</th><th>Ext.</th><th></th></tr></thead><tbody>${lineRows}</tbody></table></div>`
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
      ${poInvoicesHtml(ed, ro, recvHtml)}
      <input type="file" id="pe-file" accept=".pdf,application/pdf" hidden>`;
    if (keep) {
      const el = keep.id ? $(keep.id) : keep.k && keep.f ? box.querySelector(`[data-f="${keep.f}"][data-k="${keep.k}"]`) : null;
      if (el) { el.focus(); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.s); } catch (_) {} }
    }
    if (pdfOn && $("pe-pdf") && !$("pe-pdf").childElementCount) renderPdf();
    { const bar = document.querySelector(".appbar"), top = box.querySelector(".po-top"), st = document.documentElement.style;
      if (bar) st.setProperty("--appbar-h", bar.offsetHeight + "px"); if (top) st.setProperty("--potop-h", top.offsetHeight + "px"); }
  }
  const recvPill = (v) => { if (v.isNew || !v.id) return ""; const t = invTot(v);
    return v.recvAt ? `<span class="pill ok" title="${v.recvManual ? "Marked received" : "Everything on it came in"}">Received</span>` : t.g > 0 ? `<span class="pill manual">${n0(t.g)} of ${n0(t.b)} in</span>` : ""; };
  const payPill = (v) => v.isNew ? '<span class="pill warn">new</span>' : v.paidOn ? '<span class="pill ok">Paid</span>' : overdue(v) ? '<span class="pill miss">Overdue</span>' : '<span class="pill warn">Unpaid</span>';
  const qbPill = (v) => v.qbo ? '<span class="pill ok" title="Entered in QuickBooks">In QuickBooks</span>' : v.id && !v.isNew ? '<span class="pill pos">Not in QuickBooks</span>' : "";
  // On the purchase order: its invoices as chips, the chosen one's summary (the rest is on the Invoices tab) and receiving
  function poInvoicesHtml(ed, ro, recvHtml) {
    const iv = cur(ed);
    const chips = ed.invoices.map((v, i) => { const c = count(v), bad = c.check + c.none;
      return `<button class="ivchip" data-inv="${i}" aria-pressed="${i === ed.cur}"><b>${esc(v.no || "Invoice " + (i + 1))}</b><span>${v.total != null ? m(v.total) : v.subtotal != null ? m(v.subtotal) : ""}</span>${bad ? `<span class="pill miss">${bad} to check</span>` : ""}${recvPill(v)}${v.isNew ? '<span class="pill warn">new</span>' : ""}</button>`; }).join("");
    const head = `<div class="panel-head"><h2>Invoices</h2><span class="muted small">${ed.invoices.length ? `${ed.invoices.length} on this PO` : "none yet"} · a vendor can bill in parts · invoices are uploaded and kept on the Invoices tab</span>${!ro && ed.id ? `<label class="btn ${ed.invoices.length ? "" : "primary"} right" for="pe-file" title="Read the PDF and open it on the Invoices tab, attached to this PO">Upload invoice PDF</label>` : ""}</div>
      <div class="ivchips">${chips}${!ro && ed.id ? `<label class="ivchip add" for="pe-file"><b>+ Add invoice</b><span>it opens on the Invoices tab</span></label>` : ""}</div>`;
    if (!iv) return `<section class="panel po-inv" id="pe-drop">${head}${!ed.id ? '<div class="muted small">Save the PO first, then upload its invoices (or upload an invoice on the Invoices tab — it finds this PO by its PO #).</div>' : ""}</section>`;
    const c = count(iv);
    return `<section class="panel po-inv" id="pe-drop">${head}
      <div class="po-invbar"><span><b>Invoice ${esc(iv.no || "(no number)")}</b>${iv.date ? " · " + esc(shortDate(iv.date)) : ""}${iv.total != null ? " · " + m(iv.total) : ""}${iv.due ? " · due " + esc(shortDate(iv.due)) : ""} ${payPill(iv)} ${qbPill(iv)}${c.check + c.none ? ` <span class="pill miss">${c.check + c.none} line${c.check + c.none === 1 ? "" : "s"} to check</span>` : ""}</span>
        <span class="dbtns"><button class="btn" data-pact="open-inv" title="Lines, PDF, payment and QuickBooks">Open invoice →</button></span></div>
      ${recvHtml || ""}
    </section>`;
  }
  // The Invoices tab: one invoice in full — its PO, details, payment, QuickBooks, lines and PDF
  function renderInvoicePage() {
    const ed = S.ed, iv = cur(ed), box = $("po-edit-view");
    $("inv-list-view").hidden = true; box.hidden = false;
    if (!iv) { S.invOpen = false; render(); return; }
    const keep = document.activeElement && box.contains(document.activeElement) ? { id: document.activeElement.id, k: document.activeElement.dataset.k, f: document.activeElement.dataset.f, s: document.activeElement.selectionStart } : null;
    const ro = ed.status === "complete", pdfOn = !!(ed.showPdf && (iv.file || iv.parts));
    const t = invTot(iv), others = ed.invoices.length - 1;
    const poName = ed.id ? `${esc(ed.vendor || "Vendor")} · ${esc(ed.po ? poLabel(ed.po) : "#" + ed.id)}` : `New PO · ${esc(ed.vendor || "vendor")}${ed.po ? " " + esc(poLabel(ed.po)) : ""}`;
    const canMove = ed.id && iv.id && !iv.isNew && !ro && !(t.g > 0);
    box.innerHTML = `
      <div class="po-top">
        <div class="po-crumb"><button class="linkbtn" data-pact="inv-list">← All invoices</button>${ed.dirty ? '<span class="pill warn">Unsaved changes</span>' : ed.id ? '<span class="muted small">All changes saved</span>' : ""}
          <span class="dbtns right"><button class="btn ${ed.dirty || !ed.id ? "primary" : ""}" data-pact="save" ${S.busy || (!ed.dirty && ed.id) ? "disabled" : ""} title="Save (⌘S / Ctrl+S)">${S.busy === "Saving…" ? "Saving…" : ed.dirty || !ed.id ? "Save" : "Saved"}</button></span></div>
        <div class="po-head"><h2>Invoice ${esc(iv.no || "(no number)")} · ${esc(ed.vendor || "vendor")} ${payPill(iv)} ${qbPill(iv)} ${recvPill(iv)}</h2></div>
        <div class="po-sum"><span>Purchase order <b>${poName}</b>${ed.id ? ` <span class="pill ${PILL[ed.status]}">${STAGE.get(ed.status)}</span>` : ""}</span>${others > 0 ? `<span class="muted small">${others} other invoice${others === 1 ? "" : "s"} on this PO</span>` : ""}
          <span class="dbtns">${ed.id ? `<button class="mini" data-pact="open-po">Open the PO →</button>` : ""}${canMove ? `<button class="mini" data-pact="inv-move">Change PO</button>` : iv.isNew && S.pend ? `<button class="mini" data-pact="inv-repick">Wrong PO?</button>` : ""}</span></div>
      </div>
      ${ed.confirm === "inv-move" ? moveHtml(ed) : ""}
      <section class="panel po-inv" id="pe-drop">${invDetailHtml(ed, ro, pdfOn)}</section>
      ${!ed.id ? '<div class="note info">Saving creates the purchase order with this invoice on it. You can add or change products on the PO afterwards.</div>' : ""}`;
    if (keep) {
      const el = keep.id ? $(keep.id) : keep.k && keep.f ? box.querySelector(`[data-f="${keep.f}"][data-k="${keep.k}"]`) : null;
      if (el) { el.focus(); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.s); } catch (_) {} }
    }
    if (pdfOn && $("pe-pdf") && !$("pe-pdf").childElementCount) renderPdf();
    { const bar = document.querySelector(".appbar"), top = box.querySelector(".po-top"), st = document.documentElement.style;
      if (bar) st.setProperty("--appbar-h", bar.offsetHeight + "px"); if (top) st.setProperty("--potop-h", top.offsetHeight + "px"); }
  }
  // picking another PO for a saved invoice (open POs, same vendor first)
  function moveHtml(ed) {
    const all = (S.orders || []).filter(o => o.id !== ed.id && o.status !== "complete");
    const same = all.filter(o => o.vendor.toLowerCase() === (ed.vendor || "").toLowerCase()), rest = all.filter(o => !same.includes(o));
    const opt = (o) => `<option value="${esc(o.id)}">${esc(o.vendor)} · ${esc(o.po ? poLabel(o.po) : "#" + o.id)} (${esc(STAGE.get(o.status))})</option>`;
    return `<div class="note warn">Move this invoice to another purchase order. Products the PO got from this invoice stay on this PO.
      <select id="pe-movepo" class="inp sm" style="width:auto;max-width:320px">${same.length ? `<optgroup label="${esc(ed.vendor)}">${same.map(opt).join("")}</optgroup>` : ""}${rest.length ? `<optgroup label="Other vendors">${rest.map(opt).join("")}</optgroup>` : ""}</select>
      <span class="dbtns"><button class="mini primary" data-pact="inv-move-go" ${all.length ? "" : "disabled"}>Move it</button><button class="mini" data-pact="no">Cancel</button></span></div>`;
  }
  function invDetailHtml(ed, ro, pdfOn) {
    const iv = cur(ed);
    const lock = ro || iv.status === "applied", c = count(iv);
    const rows = iv.rows.filter(r => iv.filter === "all" || (iv.filter === "none" ? !r.vid && !r.skip : iv.filter === "check" ? needsCheck(r) : true));
    const FILT = [["all", `All ${iv.rows.length}`], ["check", `Guesses to check ${c.check}`], ["none", `Not matched ${c.none}`]];
    const iss = invIssues(ed, iv);
    const rowsH = rows.map(r => {
      const badQ = r.qty !== "" && isNaN(Number(r.qty)), badC = r.cost !== "" && !(Number(r.cost) >= 0);
      const cls = r.skip ? "skipped" : !r.vid ? "nomatch" : needsCheck(r) ? "guess" : "";
      return `<tr class="${cls}">
        <td class="l inv">${r.src.item_code ? `<span class="mono">${esc(r.src.item_code)}</span>` : ""}${r.src.upc ? ` <span class="mono dim small">${esc(r.src.upc)}</span>` : ""}<div class="small">${esc(r.src.description) || '<span class="dim">no description</span>'}</div><div class="meta">${r.charge ? "charge on the invoice" : r.fromPo ? '<span class="pill pos" title="Filled in from the PO — check it against the invoice">from the PO</span>' : `${r.src.qty ?? "?"} × ${m(r.src.unit_cost)} = ${m(r.src.amount)}`}</div></td>
        <td class="l match">${matchCell(ed, r, lock)}</td>
        <td>${!lock ? `<input class="inp num sm ${badQ ? "bad" : ""}" data-f="iqty" data-k="${r.id}" value="${esc(r.qty)}" inputmode="decimal" style="width:64px">` : esc(r.qty)}</td>
        <td>${!lock ? `<input class="inp num sm ${badC ? "bad" : ""}" data-f="icost" data-k="${r.id}" value="${esc(r.cost)}" inputmode="decimal" style="width:76px">` : m(Number(r.cost))}</td>
        <td>${m(rowAmt(r))}</td>
        <td class="l small">${!lock ? `<select class="inp sm" data-f="acct" data-k="${r.id}" style="width:auto;max-width:130px">${ACCOUNTS.map(([k, n]) => `<option value="${k}" ${(r.account || "inventory") === k ? "selected" : ""}>${n}</option>`).join("")}</select>` : esc(ACCT.get(r.account || "inventory"))}</td>
        <td>${!lock ? `<button class="linkbtn small" data-pact="rmrow" data-k="${r.id}" title="Remove this invoice line" aria-label="Remove line">✕</button>` : ""}</td></tr>`;
    }).join("");
    return `
      <div class="po-invbar"><span><b>Invoice ${esc(iv.no || "(no number)")}</b>${iv.date ? " · " + esc(shortDate(iv.date)) : ""}${iv.total != null ? " · " + m(iv.total) : ""}${iv.due ? " · due " + esc(shortDate(iv.due)) : ""}${iv.fileName ? ` · <span class="dim">${esc(iv.fileName)}</span>` : ""}${iv.status === "applied" ? ' <span class="pill ok" title="Applied on the Invoices tab: its lines are locked">Costs in Shopify</span>' : ""} ${iv.paidOn ? '<span class="pill ok">Paid</span>' : overdue(iv) ? '<span class="pill miss">Overdue</span>' : '<span class="pill warn">Unpaid</span>'}</span>
        <span class="dbtns">${iv.file || iv.parts ? `<button class="mini" data-pact="pdf">${ed.showPdf ? "Hide PDF" : "Show PDF"}</button>` : ""}${!ro && !(invTot(iv).g > 0) ? `<button class="mini" data-pact="rminv">${iv.isNew ? "Discard" : "Delete invoice"}</button>` : ""}</span></div>
      ${ed.confirm === "rminv" ? `<div class="note warn">${iv.isNew ? `Discard invoice ${esc(iv.no || "")}?` : `Delete invoice ${esc(iv.no || "")}? ${iv.status === "applied" ? "It was applied earlier, so it's only detached from the PO." : "It's deleted when you save."}`} Products added to the PO from it go too. <span class="dbtns"><button class="mini primary" data-pact="do-rminv">Yes, remove it</button><button class="mini" data-pact="no">Cancel</button></span></div>` : ""}
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
      ${iv.fromPo && !lock && iv.rows.some(r => r.fromPo) ? `<div class="note info frompo">Lines filled in from the PO (the invoice's own lines couldn't be read). Compare them with the PDF${pdfOn ? " alongside" : ""}: fix any quantity or cost that's different, and remove products that aren't on this invoice. <span class="dbtns">${iv.rows.some(r => !r.vid && !r.skip) ? `<button class="mini" data-pact="dropunread">Remove the ${iv.rows.filter(r => !r.vid && !r.skip).length} unmatched line${iv.rows.filter(r => !r.vid && !r.skip).length === 1 ? "" : "s"}</button>` : ""}<button class="mini" data-pact="clearpo">Clear the PO lines</button></span></div>` : ""}
      <div class="po-body ${pdfOn ? "with-pdf" : ""}">
        <div class="po-ivlines">
          <div class="panel-head"><h3 class="h3">Invoice lines</h3><div class="seg" role="group" aria-label="Show lines">${FILT.map(([k, t]) => `<button data-ifilter="${k}" aria-pressed="${iv.filter === k}">${t}</button>`).join("")}</div></div>
          ${iv.rows.length ? `<div class="tbl-wrap xl"><table class="prept po-t"><thead><tr><th class="l">On the invoice</th><th class="l">Shopify product</th><th>Qty</th><th>Unit cost</th><th>Ext.</th><th class="l">Account</th><th></th></tr></thead><tbody>${rowsH || '<tr><td class="l muted" colspan="7">No lines here.</td></tr>'}</tbody></table></div>` : '<div class="muted small">No lines on this invoice.</div>'}
          ${!lock ? `<div class="row">${poRows(ed, iv).length ? `<button class="btn ${iv.rows.some(r => r.vid && !r.skip) ? "" : "primary"}" data-pact="fillpo" title="Add every product still open on the PO that isn't on this invoice, at the PO's quantity and cost">Fill from the PO</button>` : ""}<button class="btn" data-pact="addrow">Add line</button><button class="btn" data-pact="addcharge">Add charge (freight in)</button><span class="muted small">Freight or shipping on the invoice goes to Inbound Shipping.</span></div>` : ""}
        </div>
        ${pdfOn ? `<aside class="po-pdf"><div class="panel-head"><h3 class="h3">Invoice PDF</h3><button class="mini" data-pact="pdf">Hide</button></div><div id="pe-pdf" class="pdfpages"></div></aside>` : ""}
      </div>
    `;
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
    return `<div class="qb"><div class="qb-head"><b>QuickBooks</b><span class="qb-state">${qbState(ed, iv, ba, diff)}</span><button class="mini" data-pact="qbcopy" title="Copy the bill details">Copy</button></div>${qbPick(ed, iv)}
      <dl class="qb-meta"><div><dt>Vendor</dt><dd>${esc(ed.vendor || "—")}</dd></div><div><dt>Bill no.</dt><dd class="mono">${esc(iv.no || "—")}</dd></div><div><dt>Bill date</dt><dd>${esc(iv.date || "—")}</dd></div>
        <div><dt>Due date</dt><dd>${esc(iv.due || "—")}</dd></div><div><dt>Terms</dt><dd>${esc(iv.terms || "—")}</dd></div>${ed.po ? `<div><dt>PO / memo</dt><dd class="mono">${esc(ed.po)}</dd></div>` : ""}<div><dt>Payment</dt><dd>${iv.paidOn ? esc(payTxt(iv)) : "Unpaid"}</dd></div></dl>
      <table class="qb-t"><thead><tr><th class="l">Account</th><th>Amount</th></tr></thead><tbody>${ACCOUNTS.map(([k, n]) => `<tr><td class="l">${n}</td><td>${m(ba.out.get(k) || 0)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td class="l">Total</td><td>${m(ba.all)}</td></tr>${diff != null ? `<tr class="${Math.abs(diff) >= 0.01 ? "off" : "ok"}"><td class="l">Invoice total</td><td>${m(iv.total)}${Math.abs(diff) >= 0.01 ? ` <span class="small">(${diff > 0 ? "+" : ""}${m(diff)} not assigned)</span>` : ' <span class="small">✓ matches</span>'}</td></tr>` : ""}</tfoot></table></div>`;
  }
  // sent to QuickBooks as a bill, or the button to send it (once: QuickBooks is checked for the same bill number first)
  const QBO_BILL = "https://app.qbo.intuit.com/app/bill?txnId=";
  function qbState(ed, iv, ba, diff) {
    if (iv.qbo) return `<span class="pill ok" title="${esc(iv.qbo.how === "linked" ? "Was already in QuickBooks — linked" : "Entered from here")} ${esc(when(iv.qbo.at))}${iv.qbo.by ? " · " + esc(iv.qbo.by) : ""}">In QuickBooks · bill ${esc(iv.qbo.doc || iv.no)}</span>
      ${iv.qbo.att ? '<span class="small muted" title="The invoice PDF is attached to the bill">📎 PDF attached</span>' : iv.parts ? `<button class="mini" data-pact="qbo-attach" ${S.busy ? "disabled" : ""} title="Attach the invoice PDF to the bill in QuickBooks">Attach PDF</button>` : ""}
      <a class="small" href="${QBO_BILL}${encodeURIComponent(iv.qbo.id)}" target="_blank" rel="noopener">open ↗</a>${ed.confirm === "qbo-unlink" ? ` <span class="small">Unlink it? (deletes nothing in QuickBooks) <button class="mini" data-pact="qbo-unlink-go">Unlink</button><button class="mini" data-pact="no">Cancel</button></span>` : ` <button class="linkbtn small" data-pact="qbo-unlink" title="If the bill was deleted in QuickBooks">unlink</button>`}`;
    const why = !iv.id || iv.isNew ? "Save the invoice first" : !iv.no ? "The invoice needs a number" : !iv.date ? "The invoice needs a date" : !(ba.all > 0) ? "Nothing to bill" : "";
    const busy = S.busy === "Sending to QuickBooks…";
    return `<span class="muted small">${why ? esc(why) : "not entered yet"}</span><button class="mini primary" data-pact="qbo-send" ${why || S.busy ? "disabled" : ""}>${busy ? "Sending…" : "Send to QuickBooks"}</button>`;
  }
  // picking the QuickBooks vendor the first time, or confirming a total that doesn't match
  function qbPick(ed, iv) {
    const x = ed.qbo && ed.qbo.inv === iv.id ? ed.qbo : null; if (!x || iv.qbo) return "";
    if (x.mismatch) return `<div class="note warn small">${esc(x.error)} <span class="dbtns"><button class="mini primary" data-pact="qbo-force">Send it anyway</button><button class="mini" data-pact="qbo-cancel">Cancel</button></span></div>`;
    if (!x.need_vendor) return "";
    const sug = new Set((x.suggestions || []).map(v => v.id));
    return `<div class="note info small"><b>Which QuickBooks vendor is ${esc(x.vendor || ed.vendor)}?</b> It's remembered for next time.
      <select id="pe-qbovend" class="inp sm" style="width:auto;max-width:260px">${(x.suggestions || []).map(v => `<option value="${esc(v.id)}" ${v.id === x.pick ? "selected" : ""}>${esc(v.name)}</option>`).join("")}${x.suggestions && x.suggestions.length ? '<option disabled>──────────</option>' : '<option value="">Pick the vendor…</option>'}${(x.vendors || []).filter(v => !sug.has(v.id)).map(v => `<option value="${esc(v.id)}" ${v.id === x.pick ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select>
      <span class="dbtns"><button class="mini primary" data-pact="qbo-vend">Send</button><button class="mini" data-pact="qbo-cancel">Cancel</button></span></div>`;
  }
  async function qboSend(extra) {
    const ed = S.ed, iv = cur(ed); if (!ed || !iv) return;
    if (ed.dirty || !iv.id) { const id = await save(null, true); if (!id) return; }
    const ed2 = S.ed, iv2 = ed2.invoices.find(v => v.no === iv.no && v.id) || cur(ed2); if (!iv2 || !iv2.id) return;
    S.busy = "Sending to QuickBooks…"; render();
    try {
      const r = await JT.qbo({ action: "create_bill", invoice_id: Number(iv2.id), ...(extra || {}) });
      S.busy = "";
      if (r && r.ok) {
        ed2.qbo = null; await openPO(ed2.id); if (S.ed) { const i = S.ed.invoices.findIndex(v => v.id === iv2.id); if (i >= 0) S.ed.cur = i; render(); }
        note(r.duplicate || r.already ? "warn" : "info", esc(r.message || "Sent to QuickBooks."));
        return;
      }
      if (r && (r.need_vendor || r.mismatch)) { ed2.qbo = { inv: iv2.id, ...r, pick: r.need_vendor ? ((r.suggestions || [])[0] || {}).id || "" : "", vendor_id: extra && extra.vendor_id }; render(); return; }
      render(); note("bad", "QuickBooks: " + esc((r && r.error) || "no answer"));
    } catch (e) { S.busy = ""; render(); note("bad", "Couldn't send to QuickBooks: " + esc(JT.message(e))); }
  }
  async function qboAttach(iv) {
    const ed = S.ed; S.busy = "Attaching the PDF…"; render();
    try {
      const r = await JT.qbo({ action: "attach", invoice_id: Number(iv.id) });
      S.busy = ""; await openPO(ed.id); if (S.ed) { const i = S.ed.invoices.findIndex(v => v.id === iv.id); if (i >= 0) S.ed.cur = i; render(); }
      note(r && r.ok ? "info" : "bad", esc((r && (r.message || r.error)) || "No answer from QuickBooks."));
    } catch (e) { S.busy = ""; render(); note("bad", "Couldn't attach the PDF: " + esc(JT.message(e))); }
  }
  async function qboUnlink(iv) {
    const ed = S.ed; S.busy = "Saving…"; render();
    try { await JT.prep.qboUnlink(iv.id); S.busy = ""; await openPO(ed.id); if (S.ed) { const i = S.ed.invoices.findIndex(v => v.id === iv.id); if (i >= 0) S.ed.cur = i; render(); } note("info", "Unlinked from QuickBooks. Send it again if the bill should be there."); }
    catch (e) { S.busy = ""; render(); note("bad", "Couldn't unlink: " + esc(JT.message(e))); }
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
    // invoiced products are received on their invoice; this receives what isn't on one
    const anyInv = ed.invoices.length > 0, pr = progress(ed), notInv = ed.lines.some(l => pr.get(l.id).open > 0);
    if (ed.lines.length && !["qb_ready", "complete"].includes(ed.status) && (!anyInv || notInv)) out.push(`<button class="btn" data-pact="recv" ${busy}>${anyInv ? "Receive without an invoice…" : got ? "Receive more…" : "Receive…"}</button>`);
    if (ed.status === "partial") out.push(`<button class="btn" data-pact="short" ${busy}>Close short</button>`);
    if (got && ed.lines.some(l => l.dest === "prep" && l.received > 0)) out.push(`<button class="btn" data-pact="amzship">Create Amazon shipment</button>`);
    return out.join("");
  }

  // ---------- saving ----------
  function bodyOf(ed) {
    const lineOf = (vid) => ed.lines.find(l => l.vid === vid);
    const lines = ed.lines.map(l => ({ variant_id: Number(l.vid), amazon_sku: l.dest === "prep" ? l.asku || "" : "", dest: l.dest || "prep", qty: Number(l.qty) || 0,
      unit_cost: l.cost === "" ? null : Number(l.cost), backorder: !!l.backorder, eta: l.backorder ? l.eta || "" : "", update_cost: false }));
    const invoices = ed.invoices.map(iv => ({ id: iv.id ? Number(iv.id) : null, vendor: ed.vendor.trim(), invoice_no: iv.no || "", invoice_date: iv.date || "", file_name: iv.fileName || "",
      subtotal: iv.subtotal, total: iv.total, due_date: iv.due || "", terms: iv.terms || "", notes: iv.notes || "", ...(iv.id ? {} : { stage: "new" }),
      paid_on: iv.paidOn || "", pay_method: iv.payMethod || "", pay_ref: iv.payRef || "", paid_from: iv.paidFrom || "", paid_amount: iv.paidAmount,
      lines: iv.rows.map(r => { const l = r.vid && lineOf(r.vid);
        return { item_code: r.src.item_code, upc: r.src.upc, description: r.src.description, qty: r.qty === "" ? null : Number(r.qty), unit_cost: r.cost === "" ? null : Number(r.cost),
          amount: rowAmt(r), variant_id: r.vid ? Number(r.vid) : null, match_how: howSaved(r), update_cost: false,
          dest: l ? l.dest : "prep", amazon_sku: l && l.dest === "prep" ? l.asku || "" : "", account: r.account || "inventory" }; }) }));
    const remember = [];
    for (const iv of ed.invoices) for (const r of iv.rows) if (r.src.item_code && r.vid && isSure(r) && r.how !== "sku" && r.how !== "po") remember.push({ item_code: r.src.item_code, variant_id: Number(r.vid) });
    return { order: { id: ed.id ? Number(ed.id) : null, vendor: ed.vendor.trim(), po_no: ed.po.trim(), kind: ed.kind, place_by: ed.placeBy || "", expected_on: ed.expected || "", note: ed.note, short_ok: !!ed.shortOk, shopify_po_url: shopUrl(ed.shopifyUrl), no_shopify_po: !!ed.noShop, receive_into: ed.dest === "both" ? "both" : ed.dest,
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
      if (S.mode === "inv") loadInvList(true).then(() => { if (!S.invOpen) render(); }).catch(() => {});
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
  // moving to a stage (payments are tracked on the invoices, so completing a PO doesn't check them)
  function goStage(to) {
    const ed = S.ed; if (!ed) return;
    return save(to);
  }
  async function setStatus2(status, msg) {
    const ed = S.ed; S.busy = "Saving…"; render();
    try { await JT.prep.setOrderStatus(Number(ed.id), status); S.busy = ""; await loadOrders(true); await openPO(ed.id); note("info", msg || `Moved to ${STAGE.get(status).toLowerCase()}.`); }
    catch (e) { S.busy = ""; if (S.ed) S.ed.confirm = false; render(); note("bad", "Couldn't change the stage: " + esc(JT.message(e))); }
  }
  async function invReceived(iv, on) {
    const ed = S.ed; S.busy = "Saving…"; render();
    try { await JT.prep.invoiceReceived(iv.id, on); S.busy = ""; await openPO(ed.id); if (S.ed) { const i = S.ed.invoices.findIndex(v => v.id === iv.id); if (i >= 0) S.ed.cur = i; render(); } note("info", on ? `Invoice ${esc(iv.no || iv.id)} marked received.` : `Invoice ${esc(iv.no || iv.id)} reopened.`); }
    catch (e) { S.busy = ""; render(); note("bad", "Couldn't change the invoice: " + esc(JT.message(e))); }
  }
  async function receiveNow(obj, invId) {
    const ed = S.ed; obj = obj || (ed && ed.recv); if (!ed || !obj) return;
    const lines = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v == null || v === "") continue;
      const q = Number(v); if (!Number.isInteger(q) || q < 0) { note("bad", "Received quantities must be whole numbers."); return; }
      const [vid, asku, dest] = k.split("|");
      if (q > 0) lines.push({ variant_id: Number(vid), amazon_sku: dest === "prep" ? asku || "" : "", dest: dest || "prep", qty: q });
    }
    if (!lines.length) { note("warn", "Enter how many arrived."); return; }
    const recv = ed.recv, recvInv = ed.recvInv, mode = S.mode;
    if (ed.dirty || !ed.id) { const id = await save(null, true); if (!id) return; S.ed.recv = recv; S.ed.recvInv = recvInv; }
    S.busy = "Receiving…"; render();
    try {
      const inv = invId ? S.ed.invoices.find(v => String(v.id) === String(invId)) || { id: invId } : null;
      const n = await JT.prep.receiveOrder(Number(S.ed.id), lines, "", inv && inv.id);
      const id = S.ed.id; S.busy = ""; await loadOrders(true); await openPO(id);
      const iv2 = inv && S.ed && S.ed.invoices.find(v => String(v.id) === String(inv.id));
      if (iv2) {
        const was = S.ed.cur; S.ed.cur = S.ed.invoices.indexOf(iv2); if (!iv2.recvAt) S.ed.recvInv = iv2.id;
        if (was !== S.ed.cur) {   // openPO showed the last invoice's PDF: switch to this one's
          pdfToken++; const h = $("pe-pdf"); if (h) h.innerHTML = "";
          if (iv2.parts && !iv2.file && !S.files.has(iv2.id)) loadFile(iv2).then(() => { if (S.ed && cur(S.ed) === iv2) { const h2 = $("pe-pdf"); if (h2) h2.innerHTML = ""; renderPdf(); } }).catch(() => {});
        }
      }
      S.mode = mode; render();
      const left = S.ed ? [...progress(S.ed).values()].reduce((a, p) => a + Math.max(0, p.ordered - p.received), 0) : 0;
      note("info", `Received ${n0(n)} units${inv ? ` against invoice ${esc(inv.no || inv.id)}` : ""}.${iv2 && iv2.recvAt ? " That invoice is now received in full." : ""}${lines.some(l => l.dest === "prep") ? " Prep-center lines are in the prep center." : ""}${lines.some(l => l.dest === "shopify") ? " Shopify-store lines are recorded on the PO (Shopify's own stock isn't changed)." : ""}${left ? ` ${n0(left)} still to come on this PO.` : ""}`);
    } catch (e) { S.busy = ""; render(); note("bad", "Couldn't receive: " + esc(JT.message(e))); }
  }
  function leave() {
    const ed = S.ed;
    if (ed && ed.dirty && !ed.leaveOk) { note("warn", `This purchase order has unsaved changes. <span class="dbtns"><button class="mini primary" data-pact="save">Save</button><button class="mini" data-pact="discard">Discard changes</button></span>`); return; }
    if (S.mode === "inv") { S.invOpen = false; if (ed && ed.dirty) S.ed = null; S.pend = null; note("", ""); pdfToken++; render(); loadInvList(false).then(render).catch(() => {}); return; }
    S.ed = null; note("", ""); pdfToken++; render(); renderList();
  }

  // ---------- events ----------
  // open the PO details form (saved POs keep it folded into the header) and put the cursor in one field
  const HEAD_IDS = new Set(["pe-vendor", "pe-po", "pe-kind", "pe-placeby", "pe-exp", "pe-shopify", "pe-dest", "pe-note"]);
  function openHead(id) {
    const ed = S.ed; if (!ed) return;
    ed.editHead = true; render();
    setTimeout(() => { const el = id === "pe-kind" ? document.querySelector('[data-pkind][aria-pressed="true"]') : $(id); if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); if (!el.disabled) { el.focus(); if (el.select && el.type !== "date") el.select(); } } }, 0);
  }
  function focusArg(a) {
    { const id0 = { "po-exp": "pe-exp", "po-placeby": "pe-placeby", "po-po": "pe-po" }[a] || a; if (HEAD_IDS.has(id0) && S.ed && S.ed.id && !S.ed.editHead) { openHead(id0); return; } } if (a === "pe-shopcheck" && S.ed && !S.ed.shopOpen) { S.ed.shopOpen = true; render(); } const id = { "po-add": "po-add", "po-exp": "pe-exp", "po-inv": "pe-file", "po-placeby": "pe-placeby", "po-po": "pe-po" }[a] || a;
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
    if (f === "ppdf" || f === "oinv") { ed.showPdf = true; if (S.mode !== "inv") return showInvoicePage(); render(); return; }
    if (f === "paddcharge") return act("addcharge");
    if (f === "pbo") { const n = markBackordered(ed, ""); note("info", `${n} product${n === 1 ? "" : "s"} marked backordered. Add an ETA on each if you have one, then Save.`); render(); return; }
    if (f === "orecv") return act("recv");
    if (f === "oshort") return act("short");
    if (f === "ppaid") { const i = +d.arg; if (ed.invoices[i]) { ed.cur = i; markPaid(ed, ed.invoices[i]); if (S.mode !== "inv") showInvoicePage(); else render(); focusArg("pe-paymethod"); } return; }
    if (f === "onext") { if (NEXT[ed.status]) goStage(NEXT[ed.status][0]); return; }
    if (f === "oship") return act("amzship");
    if (f === "tab") { const b = document.querySelector(`.tabs button[data-tab="${d.arg}"]`); if (b) b.click(); return; }
    if (f === "ofill") { focusArg("po-inv"); return; }
  }
  function act(a, k) {
    const ed = S.ed; if (!ed) return;
    const iv = cur(ed), r = k && iv && iv.rows.find(x => x.id === k), l = k && ed.lines.find(x => x.id === k);
    if (a === "back-list") return leave();
    if (a === "inv-list") return leave();
    if (a === "open-inv") return showInvoicePage();
    if (a === "open-unpaid") { const i = ed.invoices.findIndex(v => !v.paidOn); ed.confirm = false; note("", ""); if (i >= 0) ed.cur = i; return showInvoicePage(); }
    if (a === "open-po") { S.invOpen = false; const b = document.querySelector('.tabs button[data-tab="po"]'); if (b) b.click(); return; }
    if (a === "inv-move") { if (ed.dirty) { note("warn", "Save or discard your changes first."); return; } ed.confirm = "inv-move"; render(); return; }
    if (a === "inv-move-go" && iv) { const to = ($("pe-movepo") || {}).value; if (to) moveInvoice(iv, to); return; }
    if (a === "inv-repick" && S.pend) { const pend = S.pend; ed.leaveOk = true; S.ed = null; S.invOpen = false; render(); return choosePO(pend); }
    if (a === "discard") { ed.leaveOk = true; return leave(); }
    if (a === "save") return save(null);
    if (a === "save-next" || a === "next-stage") return goStage(NEXT[ed.status][0]);
    if (a === "do-complete") { ed.confirm = false; return save("complete"); }
    if (a === "confirm" && r) { r.confirmed = true; syncLines(ed); ed.dirty = true; render(); return; }
    if (a === "search" && r) { ed.search = { id: r.id, q: r.src.item_code || (r.src.description || "").split(/\s+/).slice(0, 4).join(" ") }; render(); setTimeout(() => { const i = $("pe-sq"); if (i) { i.focus(); i.select(); } }, 0); return; }
    if (a === "search-cancel") { ed.search = null; render(); return; }
    if (a === "skip" && r) { r.vid = null; r.how = ""; r.conf = ""; r.confirmed = false; r.skip = true; if (FREIGHT.test(r.src.description)) r.account = "inbound_shipping"; ed.search = null; syncLines(ed); ed.dirty = true; render(); return; }
    if (a === "unskip" && r) { r.skip = false; r.account = "inventory"; ed.dirty = true; render(); return; }
    if (a === "rmrow" && r) { iv.rows = iv.rows.filter(x => x !== r); syncLines(ed); ed.dirty = true; render(); return; }
    if (a === "split" && l) {
      const mine = ed.lines.filter(x => x.vid === l.vid), total = mine.reduce((s2, x) => s2 + (Number(x.qty) || 0), 0);
      const parts = mine.map(x => ({ dest: x.dest, asku: x.dest === "prep" ? x.asku || "" : "", q: String(Number(x.qty) || 0), received: x.received || 0 }));
      parts.sort((x, y) => (x.dest === "shopify" ? 0 : 1) - (y.dest === "shopify" ? 0 : 1));
      if (!parts.some(x => x.dest === "shopify")) parts.unshift({ dest: "shopify", asku: "", q: "0", received: 0 });
      if (parts.filter(x => x.dest === "prep").length < (mine.length > 1 ? 1 : 2)) parts.push({ dest: "prep", asku: "", q: "0", received: 0 });
      ed.split = { id: l.id, vid: l.vid, total, parts };
      render(); setTimeout(() => { const i = box().querySelector('[data-f="spq"][data-k="' + (parts.length - 1) + '"]'); if (i) { i.focus(); i.select(); } }, 0); return; }
    if (a === "sp-add" && ed.split) { ed.split.parts.push({ dest: "prep", asku: "", q: "0", received: 0 }); render();
      setTimeout(() => { const i = box().querySelector('[data-f="spq"][data-k="' + (ed.split.parts.length - 1) + '"]'); if (i) { i.focus(); i.select(); } }, 0); return; }
    if (a === "sp-rm" && ed.split) { const i = Number(k); if (ed.split.parts[i] && !(ed.split.parts[i].received > 0)) ed.split.parts.splice(i, 1); render(); return; }
    if (a === "shop-api") { checkFromApi(); return; }
    if (a === "head-done") { ed.editHead = false; render(); return; }
    if (a === "noshop" || a === "yesshop") { ed.noShop = a === "noshop"; ed.dirty = true; render(); note("info", ed.noShop ? "Marked Seller Sage only: no Shopify PO. Save to keep it." : "This PO can be linked to a Shopify PO again. Save to keep it."); return; }
    if (a === "shop-open") { ed.shopOpen = !ed.shopOpen; render(); if (ed.shopOpen) setTimeout(() => { const el = $("pe-shopcheck"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 0); return; }
    if (a === "shop-all") { ed.shopAll = !ed.shopAll; render(); return; }
    if (a === "shop-rm") { ed.shopCheck = null; ed.dirty = true; render(); note("info", "Shopify PO check removed. Save to keep that."); return; }
    if (a === "unrecv1" && l) { ed.unrecv = { id: l.id, n: String(l.received) }; render(); setTimeout(() => { const i = box().querySelector('[data-f="unrq"]'); if (i) { i.focus(); i.select(); } }, 0); return; }
    if (a === "unrecv1-no") { ed.unrecv = null; render(); return; }
    if (a === "unrecv1-go") return unreceiveLine(ed);
    if (a === "split-no") { ed.split = null; render(); return; }
    if (a === "split-go") return doSplit(ed);
    if (a === "rmline" && l) { ed.lines = ed.lines.filter(x => x !== l); ed.dirty = true; render(); return; }
    if (a === "fillpo" && iv) { const pr = poRows(ed, iv); if (!pr.length) { note("info", "Everything on the PO is already on an invoice."); return; }
      iv.rows.unshift(...pr); iv.fromPo = true; iv.filter = "all"; syncLines(ed); ed.dirty = true; render(); note("info", `Added ${pr.length} product${pr.length === 1 ? "" : "s"} from the PO.${iv.rows.some(r => !r.vid && !r.skip) ? " Lines that didn't match a product are still here — remove them if the PO lines cover them." : ""} Check them against the invoice, then Save.`); return; }
    if (a === "dropunread" && iv) { iv.rows = iv.rows.filter(r => r.vid || r.skip); ed.dirty = true; render(); return; }
    if (a === "clearpo" && iv) { iv.rows = iv.rows.filter(r => !r.fromPo); iv.fromPo = false; syncLines(ed); ed.dirty = true; render(); return; }
    if (a === "addrow" && iv) { const nr = { id: newId(), src: { item_code: "", upc: "", description: "", qty: null, unit_cost: null, amount: null }, vid: null, how: "", conf: "", alts: [], confirmed: false, skip: false, account: "inventory", qty: "", cost: "" };
      iv.rows.push(nr); iv.filter = "all"; ed.search = { id: nr.id, q: "" }; ed.dirty = true; render(); setTimeout(() => { const i = $("pe-sq"); if (i) i.focus(); }, 0); return; }
    if (a === "addcharge" && iv) { const r2 = chargeRow("Freight", 0, "inbound_shipping"); r2.cost = ""; iv.rows.push(r2); iv.filter = "all"; ed.dirty = true; render();
      setTimeout(() => { const i = document.querySelector(`#po-edit-view [data-f="icost"][data-k="${r2.id}"]`); if (i) i.focus(); }, 0); return; }
    if (a === "qbcopy" && iv) { const t = qbText(ed, iv); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => note("info", "Copied the bill for QuickBooks."), () => note("info", `<pre class="qbpre">${esc(t)}</pre>`)); return; }
    if (a === "pdf") { ed.showPdf = !ed.showPdf; render(); return; }
    if (a === "rminv") { ed.confirm = "rminv"; render(); return; }
    if (a === "do-rminv" && iv) { if (iv.id) ed.removed.push(iv.id); ed.invoices.splice(ed.cur, 1); ed.cur = ed.invoices.length - 1; ed.confirm = false; syncLines(ed); ed.dirty = true; pdfToken++;
      if (S.mode === "inv") { if (!ed.id && !ed.invoices.length) { ed.leaveOk = true; S.ed = null; S.invOpen = false; S.pend = null; note("info", "Invoice discarded."); render(); return; }
        S.invOpen = false; if (ed.id) { save(null, true).then(id => { if (id) { note("info", "Invoice deleted."); loadInvList(true).then(render); } }); return; } }
      render(); return; }
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
      if (n && !ed.invoices.length) { note("warn", `Confirm or change the ${n} guessed product${n === 1 ? "" : "s"} on the invoices before receiving, so the right stock comes in.`); const i = ed.invoices.findIndex(v => count(v).check); if (i >= 0) { ed.cur = i; ed.invoices[i].filter = "check"; } render(); return; }
      const pr = progress(ed), anyInv = ed.invoices.length > 0; ed.recv = {};
      for (const x of ed.lines) { const p = pr.get(x.id); ed.recv[keyOf(x)] = String(anyInv ? 0 : Math.max(0, p.ordered - p.received)); }
      render(); return;
    }
    if (a === "recv-cancel") { ed.recv = null; render(); return; }
    if (a === "rq-start" && iv && iv.id) { ed.recvInv = iv.id; render(); return; }
    if (a === "rq-stop") { ed.recvInv = null; render(); return; }
    if (a === "rq-go" && l && iv && iv.id) { const sh = invShares(ed, iv).get(l.id); return receiveNow({ [keyOf(l)]: rqVal(ed, iv, l, sh) }, iv.id); }
    if (a === "rq-all" && iv && iv.id) {
      const sh = invShares(ed, iv), o = {};
      for (const x of ed.lines) { const y = sh.get(x.id); if (y && y.left > 0) o[keyOf(x)] = rqVal(ed, iv, x, y); }
      return receiveNow(o, iv.id);
    }
    if (a === "recv-go") return receiveNow();
    if (a === "qbo-send") return qboSend();
    if (a === "qbo-vend") { const v = ($("pe-qbovend") || {}).value; if (!v) { note("warn", "Pick the QuickBooks vendor."); return; } return qboSend({ vendor_id: v }); }
    if (a === "qbo-force") return qboSend({ force: true, ...(ed.qbo && ed.qbo.vendor_id ? { vendor_id: ed.qbo.vendor_id } : {}) });
    if (a === "qbo-cancel") { ed.qbo = null; render(); return; }
    if (a === "qbo-attach" && iv && iv.qbo) return qboAttach(iv);
    if (a === "qbo-unlink") { ed.confirm = "qbo-unlink"; render(); return; }
    if (a === "qbo-unlink-go" && iv && iv.qbo) { ed.confirm = false; return qboUnlink(iv); }
    if ((a === "inv-recvd" || a === "inv-reopen") && cur(ed) && cur(ed).id) return invReceived(cur(ed), a === "inv-recvd");
    if (a === "amzship") { if (window.JTPrepTab && window.JTPrepTab.shipFromOrder) window.JTPrepTab.shipFromOrder(ed.id); return; }
  }
  const box = () => $("po-edit-view");
  // the Save button and saved/unsaved note in the sticky header, without redrawing the page
  function syncTop() {
    const ed = S.ed, c = document.querySelector("#po-edit-view .po-crumb"); if (!ed || !c) return;
    const b = c.querySelector('button[data-pact="save"]'), st = c.querySelector(".pill.warn, .muted.small");
    const want = ed.dirty || !ed.id;
    if (b) { b.disabled = !!S.busy || !want || !!ed.recv; b.classList.toggle("primary", want); b.textContent = S.busy === "Saving…" ? "Saving…" : want ? "Save" : "Saved"; }
    if (st && ed.dirty && !st.classList.contains("warn")) st.outerHTML = '<span class="pill warn">Unsaved changes</span>';
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
    // "Estimated arrival: Oct 15, 2026" (or 2026-10-15 / 10/15/2026) and "Payment terms: Net 30"
    let arrival = "", terms = "";
    const am = /estimated\s+arrival\s*:?\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(all);
    if (am) { const d = new Date(/^\d{4}-/.test(am[1]) ? am[1] + "T12:00:00Z" : am[1].replace(/\./, "") + " 12:00 UTC"); if (!isNaN(d)) arrival = d.toISOString().slice(0, 10); }
    const tm = /payment\s+terms\s*:?\s*([^\n]+?)(?=\s{2,}|\s+estimated\b|\s+ship\s+to\b|\n|$)/i.exec(all); if (tm) terms = tm[1].trim();
    return { name, supplier: supplier.trim(), total, subtotal, shipping, arrival, terms, lines: items };
  }
  const poKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^po/, "");
  // match each Shopify PO line to a Shopify variant (its SKU first, then the supplier SKU, then the name)
  function matchShopLines(sp, vendor) {
    for (const l of sp.lines) { if (l.how === "shopify" && l.variant_id) continue;   // Shopify said which variant
      let g = guessLine({ item_code: l.sku, upc: "", description: l.title }, vendor);
      if (!l.sku && l.supplier_sku) { const g2 = guessLine({ item_code: l.supplier_sku, upc: "", description: l.title }, vendor); if (g2.how === "remembered" || g2.how === "sku") g = g2; } l.variant_id = g.vid; l.how = g.how; l.alts = g.alts; }
  }
  // New PO from the Shopify PO's PDF: vendor, PO number, expected date and every product, quantity and cost come from
  // Shopify, and the Shopify check is filled in from the same file (so it matches). A PO with that number already here
  // is opened and checked instead.
  async function newFromShopPdf(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { note("warn", "That isn't a PDF. In Shopify, open the purchase order and download (or print to) a PDF."); return; }
    S.busy = "Reading the Shopify PO…"; render();
    try {
      await catalog(); if (!S.orders) await loadOrders(false);
      const rows = await IP.pdfRows(new Uint8Array(await file.arrayBuffer()));
      const sp = parseShopPo(rows);
      S.busy = "";
      if (!sp.lines.length) { render(); note("bad", "Couldn't find any product lines in that PDF. Is it the purchase order PDF from Shopify?"); return; }
      await newFromShop(sp, { source: "pdf", file_name: file.name });
    } catch (e) { S.busy = ""; render(); note("bad", "Couldn't read that PDF: " + esc(JT.message(e))); }
  }
  // New PO from a Shopify PO (its PDF, or the PO itself from Shopify's API): vendor, PO number, expected date and every
  // product, quantity and cost come from Shopify, and the Shopify check is filled in from the same data (so it matches).
  // A PO with that number already here is opened and checked instead.
  async function newFromShop(sp, meta) {
    const from = meta.source === "pdf" ? "this PDF" : "Shopify";
    const have = sp.name && (S.orders || []).find(o => poKey(o.po) && poKey(o.po) === poKey(sp.name));
    if (have) {
      await openPO(have.id);
      if (S.ed && S.ed.id === have.id) { checkShop(sp, meta); note("info", `${esc(poLabel(have.po))} is already here, so it was checked against ${from} instead of making a second one. Save to keep the check.`); }
      return;
    }
    const nv = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const sup = sp.supplier || "", vendor = S.vendors.find(v => nv(v) === nv(sup)) || S.vendors.find(v => nv(v) && nv(sup) && (nv(sup).includes(nv(v)) || nv(v).includes(nv(sup)))) || sup;
    matchShopLines(sp, vendor);
    const ed = blankEd();
    Object.assign(ed, { vendor, po: (sp.name || "").replace(/^#\s*/, ""), expected: sp.arrival || "", note: sp.terms ? "Payment terms: " + sp.terms : "", dest: "shopify", addTo: "shopify", fromShop: true, dirty: true });
    if (meta.shopId) ed.shopifyUrl = shopUrl(meta.shopId);
    ed.shopCheck = { checked_at: new Date().toISOString(), source: meta.source, file_name: meta.file_name || sp.name, name: sp.name, supplier: sp.supplier, total: sp.total, subtotal: sp.subtotal, shipping: sp.shipping, scope: "all", lines: sp.lines, created_from: true };
    const byVid = new Map();
    for (const l of sp.lines) { if (!l.variant_id) continue; const x = byVid.get(l.variant_id); if (x) x.qty += l.qty || 0; else byVid.set(l.variant_id, { qty: l.qty || 0, cost: l.cost }); }
    for (const [vid, x] of byVid) ed.lines.push({ id: newId(), vid, asku: "", dest: "shopify", qty: String(x.qty), cost: fmtCost(x.cost), received: 0, backorder: false, eta: "", auto: false, fromShop: true });
    const unmatched = sp.lines.filter(l => !l.variant_id).length, guessed = sp.lines.filter(l => l.variant_id && l.how === "guess").length;
    ed.shopOpen = unmatched > 0 || guessed > 0;
    S.ed = ed; render();
    const units = sp.lines.reduce((a, l) => a + (l.qty || 0), 0), cost = sp.lines.reduce((a, l) => a + (l.qty || 0) * (l.cost || 0), 0);
    note(unmatched || guessed ? "warn" : "info", `Made from Shopify PO <b>${esc(sp.name || meta.file_name || "")}</b>: ${sp.lines.length} line${sp.lines.length === 1 ? "" : "s"}, ${n0(units)} units, ${m(cost)}${sp.shipping ? ` + ${m(sp.shipping)} shipping` : ""}.` +
      (unmatched ? ` <b>${unmatched} product${unmatched === 1 ? "" : "s"} couldn't be found in Shopify's catalog</b> — pick ${unmatched === 1 ? "it" : "them"} in the Shopify PO check below.` : "") +
      (guessed ? ` ${guessed} matched by name — check ${guessed === 1 ? "it" : "them"} below.` : "") +
      (sup && !S.vendors.includes(vendor) ? ` The supplier "${esc(sup)}" isn't a vendor in Shopify's catalog — check the vendor name.` : "") + " Check it over and Save.");
    if (ed.shopOpen) focusArg("pe-shopcheck");
  }
  // this PO checked against a Shopify PO (from its PDF or from Shopify)
  function checkShop(sp, meta) {
    const ed = S.ed; if (!ed) return;
    matchShopLines(sp, ed.vendor);
    ed.shopCheck = { checked_at: new Date().toISOString(), source: meta.source, file_name: meta.file_name || sp.name, name: sp.name, supplier: sp.supplier, total: sp.total, subtotal: sp.subtotal, shipping: sp.shipping,
      scope: (ed.shopCheck && ed.shopCheck.scope) || "all", lines: sp.lines };
    if (meta.shopId && !ed.shopifyUrl) ed.shopifyUrl = shopUrl(meta.shopId);
    ed.dirty = true; ed.shopAll = false;
    const d = shopDiffs(ed); ed.shopOpen = d.n > 0; render();
    note(d.n ? "warn" : "info", `${meta.source === "pdf" ? "Read" : "Checked against"} Shopify PO ${esc(sp.name || meta.file_name || "")}: ${sp.lines.length} product line${sp.lines.length === 1 ? "" : "s"}. ${d.n ? `<b>${d.n} difference${d.n === 1 ? "" : "s"}</b> from this PO — see below.` : "It matches this PO ✓."} Save to keep the check.`);
    if (d.n) focusArg("pe-shopcheck");
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
      checkShop(sp, { source: "pdf", file_name: file.name });
    } catch (e) { S.busy = ""; render(); note("bad", "Couldn't read that PDF: " + esc(JT.message(e))); }
  }

  // ---------- Shopify POs straight from Shopify (jt.shopify_pos, synced hourly by the sync's shopify-pos job; migration 070) ----------
  async function loadShopPos(refresh) {
    const r = await JT.rowsSplit(["id::text", "name", "status", "supplier", "destination", "total", "lines", "units", "created_at::text", "expected_at::text", "lines_synced is not null", "synced_at::text",
      "recv_status", "recv_units"], "from jt.shopify_pos", "id", 2, refresh);
    S.spos = r.map(x => ({ id: x[0], name: x[1] || "", status: x[2] || "", supplier: x[3] || "", dest: x[4] || "", total: x[5] == null ? null : +x[5], lines: +x[6] || 0, units: +x[7] || 0,
      created: x[8] || "", expected: x[9] || "", ready: !!x[10], synced: x[11] || "", recv: x[12] || "", recvUnits: +x[13] || 0 }))
      .sort((a, b) => (b.created || "").localeCompare(a.created || "") || Number(b.id) - Number(a.id));
    return S.spos;
  }
  // the Shopify PO by its number or link (for a PO here)
  const shopPoFor = (ed) => {
    if (!S.spos) return null;
    const m1 = /purchase_orders\/(\d+)/.exec(shopUrl(ed.shopifyUrl) || "");
    return (m1 && S.spos.find(p => p.id === m1[1])) || (ed.po && S.spos.find(p => poKey(p.name) && poKey(p.name) === poKey(ed.po))) || null;
  };
  async function spFromApi(po) {
    const r = await JT.rows(["variant_id::text", "sku", "title", "qty", "cost"], `from jt.shopify_po_lines where po_id = ${JT.int(po.id)} order by line_id`, true);
    const lines = r.map(x => { const vid = x[0] && S.byVid.has(x[0]) ? x[0] : null;
      return { variant_id: vid, sku: x[1] || "", title: x[2] || "", qty: +x[3] || 0, cost: x[4] == null ? null : +x[4], how: vid ? "shopify" : "", alts: [] }; });
    return { name: po.name, supplier: po.supplier, total: po.total, subtotal: po.total, shipping: null, arrival: (po.expected || "").slice(0, 10), terms: "", lines };
  }
  async function newFromApi(id) {
    const po = (S.spos || []).find(p => p.id === String(id)); if (!po) return;
    S.busy = `Bringing in Shopify PO ${po.name}…`; render();
    try {
      await catalog(); if (!S.orders) await loadOrders(false);
      const sp = await spFromApi(po); S.busy = "";
      if (!sp.lines.length) { render(); note("bad", `Shopify PO ${esc(po.name)} has no product lines yet${po.ready ? "" : " (its lines haven't been read yet — the hourly sync reads them)"}.`); return; }
      await newFromShop(sp, { source: "shopify", shopId: po.id, file_name: po.name });
    } catch (e) { S.busy = ""; render(); note("bad", "Couldn't bring in that PO: " + esc(JT.message(e))); }
  }
  async function checkFromApi() {
    const ed = S.ed; if (!ed) return;
    S.busy = "Checking against Shopify…"; render();
    try {
      await catalog(); await loadShopPos(true);
      const po = shopPoFor(ed); S.busy = "";
      if (!po) { render(); note("warn", `Couldn't find ${ed.po ? esc(poLabel(ed.po)) : "this PO"} among the Shopify POs read from Shopify. Check the PO number or the Shopify link, or upload the PDF instead.`); return; }
      checkShop(await spFromApi(po), { source: "shopify", shopId: po.id, file_name: po.name });
    } catch (e) { S.busy = ""; render(); note("bad", "Couldn't check against Shopify: " + esc(JT.message(e))); }
  }
  // ---------- the Shopify POs view (Purchase orders → Shopify POs) ----------
  // Seller Sage PO for a Shopify PO: linked by the Shopify link, else the same PO number
  function ssIndex() {
    const byShop = new Map(), byKey = new Map();
    for (const o of S.orders || []) {
      const m1 = /purchase_orders\/(\d+)/.exec(shopUrl(o.shopifyUrl) || ""); if (m1) byShop.set(m1[1], o);
      if (poKey(o.po)) byKey.set(poKey(o.po), o);
    }
    return (p) => byShop.get(p.id) || byKey.get(poKey(p.name)) || null;
  }
  const NEW_DAYS = 45;
  const spNew = (p, ssOf) => !ssOf(p) && p.recv !== "received" && (p.created || "") >= addDaysISO(today(), -NEW_DAYS);
  function addDaysISO(d, n) { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
  const recvPillSp = (p) => !p.recv ? '<span class="dim small" title="Not read from Shopify yet (the hourly sync reads it)">…</span>'
    : p.recv === "received" ? `<span class="pill ok">Received</span>` : p.recv === "partial" ? `<span class="pill manual">${n0(p.recvUnits)} of ${n0(p.units)} in</span>` : '<span class="pill pos">Not received</span>';
  // banner on the Seller Sage list: new Shopify POs not brought in yet
  function shopNewBanner() {
    if (!S.spos || S.listView === "shop") return "";
    const ssOf = ssIndex(), n = S.spos.filter(p => spNew(p, ssOf)).length;
    return n ? `<div class="note info">${n} Shopify PO${n === 1 ? " isn't" : "s aren't"} in Seller Sage yet. <span class="dbtns"><button class="mini primary" data-ps="show">Show ${n === 1 ? "it" : "them"}</button></span></div>` : "";
  }
  function pickShopHtml() {
    if (S.listView !== "shop") return shopNewBanner();
    const P = S.pickShop || (S.pickShop = { q: "", f: "new", shown: 100 });
    if (!S.spos) return `<section class="panel" id="po-pickshop"><div class="panel-head"><h2>Shopify POs</h2><span class="muted small">Loading Shopify POs…</span></div></section>`;
    const ssOf = ssIndex(), q = (P.q || "").toLowerCase().trim();
    const FILT = [["new", "To bring in", (p) => !ssOf(p) && p.recv !== "received"], ["here", "In Seller Sage", (p) => !!ssOf(p)], ["recv", "Received in Shopify", (p) => p.recv === "received"], ["all", "All", () => true]];
    const fx = (FILT.find(x => x[0] === P.f) || FILT[0])[2];
    const list = S.spos.filter(p => fx(p) && (!q || `${p.name} ${p.supplier}`.toLowerCase().includes(q)));
    const last = S.spos.reduce((a, p) => p.synced > a ? p.synced : a, "");
    const cnt = (f) => S.spos.filter(f).length;
    return `<section class="panel" id="po-pickshop"><div class="panel-head"><h2>Shopify POs</h2>
      <div class="seg" role="group" aria-label="Which Shopify POs">${FILT.map(([k, l, f]) => `<button data-psf="${k}" aria-pressed="${P.f === k}">${l} <span class="cnt">${cnt(f)}</span></button>`).join("")}</div>
      <div class="filters"><label>Search <input class="inp" type="search" data-ps="q" value="${esc(P.q || "")}" placeholder="PO number or supplier"></label></div></div>
      <p class="muted small">Shopify POs created since Oct 5, 2026 (and older ones a Seller Sage PO links to), read from Shopify every hour${last ? ` (last change ${esc(when(last))})` : ""}. <b>Create Seller Sage PO</b> brings one in with its vendor, PO number, products, quantities and costs — already checked against Shopify. Received comes from the PO's transfers in Shopify.</p>
      <div class="tbl-wrap tall"><table class="po-t"><thead><tr><th class="l">Shopify PO</th><th class="l">Supplier</th><th class="l">Created</th><th>Lines</th><th>Units</th><th>Total</th><th class="l">Received in Shopify</th><th class="l">Seller Sage</th></tr></thead><tbody>${
      list.slice(0, P.shown).map(p => { const o = ssOf(p);
        return `<tr><td class="l"><b class="mono">${esc(p.name || "#" + p.id)}</b> <a class="small" href="${esc(shopUrl(p.id))}" target="_blank" rel="noopener" title="Open in Shopify">↗</a>${p.status === "DRAFT" ? ' <span class="pill warn">Draft</span>' : ""}</td><td class="l">${esc(p.supplier || "—")}</td>
        <td class="l">${esc(shortDate((p.created || "").slice(0, 10)))}</td>
        <td>${p.ready ? n0(p.lines) : '<span class="dim" title="The hourly sync hasn\'t read its lines yet">…</span>'}</td><td>${p.ready ? n0(p.units) : ""}</td><td>${p.total == null ? "—" : m(p.total)}</td>
        <td class="l">${recvPillSp(p)}</td>
        <td class="l">${o ? `<button class="linkbtn" data-ps-open="${esc(o.id)}">${esc(o.po ? poLabel(o.po) : "#" + o.id)} →</button>` : `<button class="btn primary sm" data-ps-take="${esc(p.id)}" ${p.ready ? "" : "disabled"}>Create Seller Sage PO</button>`}</td></tr>`; }).join("")
      || `<tr><td class="l dim" colspan="8">${S.spos.length ? "Nothing here." : "No Shopify POs yet — the sync reads them from Shopify hourly."}</td></tr>`}</tbody></table></div>
      ${list.length > P.shown ? `<div class="row"><button class="btn" data-ps="more">Show more</button><span class="muted small">${n0(P.shown)} of ${n0(list.length)}</span></div>` : ""}</section>`;
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
  // next to the PO name: ✓ when the Shopify PO was checked and matches, the number of differences when it doesn't
  // (click to see them), and a button to check again from a new PDF
  function shopBadge(ed, ro) {
    if (!(ed.id || ed.shopCheck) || !(ed.shopifyUrl.trim() || ed.shopCheck)) return "";
    const sc = ed.shopCheck, inp = '<input type="file" id="pe-shopfile" accept=".pdf,application/pdf" hidden>';
    const btn = ro ? "" : `<button class="mini shopbtn" data-pact="shop-api" title="Compare every product, quantity and cost with the Shopify PO, read from Shopify (matched by PO number or the Shopify link)">${sc ? "Re-check Shopify" : "Check vs Shopify PO"}</button><label class="mini shopbtn" for="pe-shopfile" title="Or download the PO from Shopify as a PDF and upload it">PDF</label>`;
    if (!sc) return ` <span class="shopbadge">${btn}${inp}</span>`;
    const d = shopDiffs(ed), tip = `Checked against ${sc.name || "the Shopify PO"} ${when(sc.checked_at)}`;
    const mark = d.n ? `<button class="pill miss shopdif" data-pact="shop-open" title="${esc(tip)} — click to see">${d.n} Shopify difference${d.n === 1 ? "" : "s"}</button>`
      : `<button class="shopok" data-pact="shop-open" title="${esc(tip)} — matches" aria-label="Matches the Shopify PO">✓</button>`;
    return ` <span class="shopbadge">${mark}${btn}${inp}</span>`;
  }
  function shopCheckHtml(ed, ro) {
    if (shopOff(ed)) return "";
    if (!ed.shopCheck || !ed.shopOpen) return "";
    const up = "";
    const link = shopUrl(ed.shopifyUrl) && /^https:/.test(shopUrl(ed.shopifyUrl)) ? `<a class="small" href="${esc(shopUrl(ed.shopifyUrl))}" target="_blank" rel="noopener">open it in Shopify ↗</a>` : "";
    const api = ed.shopStatus ? `${shopStatusPill(ed.shopStatus)} <span class="muted small">as of ${esc(when(ed.shopStatusAt))}</span>`
      : ed.poApi && !ed.poApi.ok ? `<span class="muted small" title="${esc(ed.poApi.why || "")}">Shopify status: not available yet — Shopify hasn't opened its PO API to live stores; checked nightly</span>` : "";
    if (!ed.shopCheck) return `<section class="panel shopchk" id="pe-shopcheck"><div class="panel-head"><h2>Shopify PO check</h2>${api}<span class="muted small">not checked yet</span><span class="dbtns right">${up}</span></div>
      <div class="small muted">Open the PO in Shopify ${link ? `(${link})` : ""}, download it as a PDF (or print it and save as PDF), and upload it here. Every product, quantity and cost is compared with this PO.</div></section>`;
    const sc = ed.shopCheck, d = shopDiffs(ed), hasPrep = ed.lines.some(l => l.dest === "prep");
    const shown = ed.shopAll ? d.rows : d.rows.filter(r => r.kinds.length || r.guess);   // matched by name: worth a look
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
        <span class="dbtns right"><button class="mini" data-pact="shop-rm">Remove check</button><button class="mini" data-pact="shop-open">Close</button></span></div>
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
    if (kind === "unmatch") { for (const l of ed.shopCheck.lines) if (l.variant_id === vid && l.how === "guess") { l.alts = [vid, ...(l.alts || []).filter(x => x !== vid)]; l.variant_id = null; l.how = ""; }
      if (ed.fromShop) ed.lines = ed.lines.filter(l => !(l.vid === vid && l.fromShop && !l.received));   // it came from the wrong match
      ed.dirty = true; render(); return; }
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
  // one product split any way: the Shopify store and/or any number of prep-center ASINs. The product's lines become
  // exactly the parts (same place + ASIN parts are added together); a part can't go below what it already received.
  function doSplit(ed) {
    const sp = ed.split, src = sp && ed.lines.find(x => x.id === sp.id); if (!src) { ed.split = null; render(); return; }
    const want = new Map();
    for (const x of sp.parts) {
      const q = x.q === "" ? 0 : Number(x.q);
      if (!Number.isInteger(q) || q < 0) { note("bad", "Enter whole numbers for each part."); return; }
      const key = x.dest === "shopify" ? "shopify|" : "prep|" + (x.asku || "");
      want.set(key, (want.get(key) || 0) + q);
    }
    const total = [...want.values()].reduce((a, q) => a + q, 0);
    if (!total) { note("bad", "Enter how many go to each place."); return; }
    const mine = ed.lines.filter(x => x.vid === src.vid), lk = (x) => x.dest === "shopify" ? "shopify|" : "prep|" + (x.asku || "");
    for (const x of mine) { const q = want.get(lk(x)) || 0;
      if ((x.received || 0) > q) { note("warn", `${n0(x.received)} were already received into ${x.dest === "shopify" ? "the Shopify store" : "the prep center" + (x.asku ? " for " + esc(x.asku) : "")}. Un-receive ${n0(x.received - q)} first (the un-receive link under Received), then split.`); return; } }
    const tmpl = mine[0];
    const next = [];
    for (const [key, q] of want) {
      const [dest, asku] = key.split("|");
      const have = mine.find(x => lk(x) === key);
      if (have) { have.qty = String(q); if (q > 0 || have.received > 0) next.push(have); }
      else if (q > 0) next.push({ id: newId(), vid: src.vid, asku: asku || "", dest, qty: String(q), cost: tmpl.cost, received: 0, backorder: tmpl.backorder, eta: tmpl.eta, auto: false });
    }
    const at = ed.lines.indexOf(mine[0]);
    ed.lines = ed.lines.filter(x => x.vid !== src.vid); ed.lines.splice(Math.max(0, at), 0, ...next);
    ed.splitTot = ed.splitTot || {}; ed.splitTot[src.vid] = total;
    if (next.length < 2) delete ed.splitTot[src.vid];
    const ds = new Set(ed.lines.map(x => x.dest)); ed.dest = ds.size > 1 ? "both" : [...ds][0] || ed.dest;
    ed.split = null; ed.dirty = true; render();
    const sh = want.get("shopify|") || 0, prepParts = [...want].filter(([k2, q]) => k2.startsWith("prep|") && q > 0);
    note("info", `Split ${n0(total)}: ${[sh ? `${n0(sh)} to the Shopify store` : "", ...prepParts.map(([k2, q]) => `${n0(q)} to the prep center${k2.slice(5) ? " for " + esc(k2.slice(5)) : " (any ASIN)"}`)].filter(Boolean).join(", ")}. Save to keep it.`);
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
    const showShop = (on) => {
      if (S.ed && S.ed.dirty) return leave();
      if (S.ed) S.ed = null;
      S.listView = on ? "shop" : "ss"; render();
      if (on) { loadShopPos(true).then(render, (e) => note("bad", "Couldn't load the Shopify POs: " + esc(JT.message(e)))); if (!S.orders) loadOrders(false).then(render).catch(() => {}); }
    };
    $("po-shopapi").addEventListener("click", () => showShop(true));
    $("po-listview").addEventListener("click", (e) => { const b = e.target.closest("button[data-lv]"); if (b) showShop(b.dataset.lv === "shop"); });
    $("po-pickshop-host").addEventListener("click", (e) => {
      const t = e.target.closest("[data-ps-take]"); if (t) { newFromApi(t.dataset.psTake); return; }
      const o = e.target.closest("[data-ps-open]"); if (o) { openPO(o.dataset.psOpen); return; }
      const f = e.target.closest("[data-psf]"); if (f && S.pickShop) { S.pickShop.f = f.dataset.psf; S.pickShop.shown = 100; render(); return; }
      const c = e.target.closest("[data-ps]");
      if (c && c.dataset.ps === "show") { showShop(true); return; }
      if (c && c.dataset.ps === "more" && S.pickShop) { S.pickShop.shown += 200; render(); }
    });
    $("po-pickshop-host").addEventListener("input", (e) => { if (e.target.dataset.ps === "q" && S.pickShop) { S.pickShop.q = e.target.value; S.pickShop.shown = 100; render(); } });
    $("po-new").addEventListener("click", () => { if (S.ed && S.ed.dirty) return leave(); note("", ""); openPO(null); });
    $("po-shopnew").addEventListener("change", (ev) => { const f = ev.target.files[0]; ev.target.value = "";
      if (S.ed && S.ed.dirty) { note("warn", "Save or leave the PO you're working on first, then upload the Shopify PO."); return; }
      S.ed = null; note("", ""); newFromShopPdf(f); });
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
    tab.addEventListener("drop", (e) => { if (!isFile(e)) return; e.preventDefault(); tab.classList.remove("filedrop"); readPdf(e.dataTransfer.files[0]); });
    // ---- the Invoices tab ----
    const itab = $("tab-invoices");
    $("inv-file").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; S.mode = "inv"; readPdf(f); });
    $("inv-refresh").addEventListener("click", async () => { await Promise.all([loadInvList(true), loadOrders(true)]); if (S.ed && S.ed.id && !S.ed.dirty && S.invOpen) await openInvoice(cur(S.ed).id); render(); });
    $("inv-q").addEventListener("input", (e) => { S.invQ = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(renderInvList, 150); });
    $("inv-seg").addEventListener("click", (e) => { const b = e.target.closest("button[data-invf]"); if (b) { S.invF = b.dataset.invf; renderInvList(); } });
    itab.addEventListener("click", (e) => {
      const g = e.target.closest("[data-po-go]"); if (g) { e.stopPropagation(); S.invOpen = false; S.mode = "po"; const b = document.querySelector('.tabs button[data-tab="po"]'); if (b) b.click(); openPO(g.dataset.poGo); return; }
      const o = e.target.closest("[data-inv-open]"); if (o && !e.target.closest("a")) { openInvoice(o.dataset.invOpen); return; }
      const pb = e.target.closest("[data-pend]"); if (pb) { pendGo(pb.dataset.pend); return; }
      const lk = e.target.closest("[data-link]"); if (lk) { const to = ($("pe-linkpo") || {}).value; if (!to) return; S.busy = "Linking…"; render();
        JT.po.moveInvoice(Number(lk.dataset.link), Number(to)).then(async () => { S.busy = ""; note("", ""); await loadOrders(true); await loadInvList(true); openInvoice(lk.dataset.link); })
          .catch(err => { S.busy = ""; render(); note("bad", "Couldn't link it: " + esc(JT.message(err))); }); return; }
    });
    $("inv-table").addEventListener("keydown", (e) => { const o = e.target.closest("[data-inv-open]"); if (o && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openInvoice(o.dataset.invOpen); } });
    itab.addEventListener("dragover", (e) => { if (isFile(e)) { e.preventDefault(); itab.classList.add("filedrop"); } });
    itab.addEventListener("dragleave", (e) => { if (!itab.contains(e.relatedTarget)) itab.classList.remove("filedrop"); });
    itab.addEventListener("drop", (e) => { if (!isFile(e)) return; e.preventDefault(); itab.classList.remove("filedrop"); S.mode = "inv"; readPdf(e.dataTransfer.files[0]); });
    $("po-note").addEventListener("click", (e) => { const b = e.target.closest("[data-pact]"); if (b) act(b.dataset.pact); });
    box.addEventListener("change", (e) => {
      const ed = S.ed, t = e.target; if (!ed) return;
      const iv = cur(ed);
      if (t.id === "pe-file") { const f = t.files[0]; t.value = ""; readPdf(f); return; }
      if (t.id === "pe-shopfile") { const f = t.files[0]; t.value = ""; readShopPdf(f); return; }
      if (t.dataset.f === "spick" && ed.shopCheck) { const sl = ed.shopCheck.lines[+t.dataset.i]; if (sl && t.value) { sl.variant_id = t.value; sl.how = "picked";
        if (ed.fromShop) { const have = ed.lines.find(l => l.vid === t.value); if (have) have.qty = String((Number(have.qty) || 0) + (sl.qty || 0));
          else ed.lines.push({ id: newId(), vid: t.value, asku: "", dest: "shopify", qty: String(sl.qty || 0), cost: fmtCost(sl.cost), received: 0, backorder: false, eta: "", auto: false, fromShop: true }); }
        ed.dirty = true; render(); } return; }
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
      if (t.dataset.f === "spa" && ed.split) { const x = ed.split.parts[Number(t.dataset.k)]; if (x) x.asku = t.value; return; }
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
      if (t.dataset.f === "rq" && l && cur(ed)) { ed.rq = ed.rq || {}; ed.rq[rqKey(cur(ed), l)] = t.value.trim(); clearTimeout(box._t); box._t = setTimeout(render, 500); }
      if (t.dataset.f === "unrq" && ed.unrecv) { ed.unrecv.n = t.value.trim(); clearTimeout(box._t); box._t = setTimeout(render, 400); }
      if (t.dataset.f === "spq" && ed.split) { const x = ed.split.parts[Number(t.dataset.k)]; if (x) x.q = t.value.trim();
        clearTimeout(box._t); box._t = setTimeout(() => { const f = document.activeElement, fk = f && f.dataset && f.dataset.f === "spq" ? f.dataset.k : null, pos = f && f.selectionStart;
          render(); if (fk != null) { const n = box.querySelector('[data-f="spq"][data-k="' + fk + '"]'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (_) {} } } }, 500); }
      if (t.dataset.f === "iqty" && r) { r.qty = t.value.trim(); syncLines(ed); ed.dirty = true; clearTimeout(box._t); box._t = setTimeout(render, 400); }
      if (t.dataset.f === "icost" && r) { r.cost = t.value.trim().replace(/^\$/, ""); syncLines(ed); ed.dirty = true; clearTimeout(box._t); box._t = setTimeout(render, 400); }
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
      if (b.dataset.hedit) { openHead(b.dataset.hedit); return; }
      if (b.dataset.pact) { act(b.dataset.pact, b.dataset.k); return; }
      if (b.dataset.pgo) { return goStage(b.dataset.pgo); }
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
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s" && S.ed && shown() && (S.mode === "po" || S.invOpen)) {
        e.preventDefault(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        setTimeout(() => { if (S.ed && (S.ed.dirty || !S.ed.id) && !S.busy && !S.ed.recv) save(null); }, 0);
      }
    });
    let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (S.ed && S.ed.showPdf && shown()) { const h = $("pe-pdf"); if (h) h.innerHTML = ""; renderPdf(); } }, 250); });
  }

  bind();
  // new or changed Shopify products: reload the catalog; an open PO's unmatched invoice lines get another try
  window.addEventListener("jt:catalog", () => {
    S.cat = null; S.catP = null;
    if (!shown()) return;
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
  window.poShow = () => { S.mode = "po"; S.invOpen = false; if (!S.shown) { S.shown = true; refresh(false); catalog().catch(() => {}); } render(); };
  window.invShow = () => {
    S.mode = "inv";
    if (!S.invShown) { S.invShown = true; catalog().catch(() => {}); if (!S.orders) loadOrders(false).catch(() => {}); }
    render(); loadInvList(false).then(render).catch(e => note("bad", esc(JT.message(e))));
  };
  window.JTPO = { _state: S, render: () => render(), open: (id) => { const b = document.querySelector('.tabs button[data-tab="po"]'); if (b) b.click(); openPO(id); }, openInvoice, guessLine, merge, progress };
  // the Prep center (and tests) open invoices this way
  window.JTInvoices = { open: (id) => { const b = document.querySelector('.tabs button[data-tab="invoices"]'); if (b && $("tab-invoices").hidden) b.click(); openInvoice(id); } };
  if ((location.hash || "") === "#invoices") setTimeout(() => window.invShow(), 0);
  if ((location.hash || "") === "#po") setTimeout(() => window.poShow(), 0);
})();
