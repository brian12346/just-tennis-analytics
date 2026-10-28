(() => {
  // ===================== Purchase orders =====================
  // Vendor orders (jt.prep_orders — the same orders Incoming Inventory shows on the Prep center tab), full page.
  // A PO can have several invoices (jt.invoices.order_id): the vendor ships and bills in parts. Receiving is against
  // the PO's lines; anything ordered and not yet invoiced is on order or backordered (with an expected date).
  // A PO is built by hand, or from the vendor's invoice PDF: the PDF is read in the browser
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

  // draft -> ordered -> invoiced -> partial (some received) -> complete (fully received or closed short). QuickBooks is
  // done per invoice (migration 106: the old received / QB ready steps are complete).
  const STAGES = [["draft", "Draft"], ["ordered", "Ordered"], ["invoiced", "Invoiced"], ["partial", "Partly received"], ["complete", "Complete"]];
  const STAGE = new Map([...STAGES, ["received", "Complete"], ["qb_ready", "Complete"]]), ORDER = STAGES.map(x => x[0]), PRE = ["draft", "ordered", "invoiced"], GOT = ["partial", "received", "qb_ready", "complete"];
  const NEXT = { draft: ["ordered", "Mark ordered"], ordered: ["invoiced", "Mark invoiced"] };
  const PREV = { ordered: "draft", invoiced: "ordered", partial: "invoiced", received: "invoiced", qb_ready: "invoiced", complete: "invoiced" };
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
      "(select count(distinct l.variant_id) from jt.prep_order_lines l where l.order_id = o.id and l.update_cost and l.qty_received > 0)", "o.no_shopify_po",
      "o.approved_at::text", "o.approved_by", `(select count(*) ${IV} and ii.qbo_bill_id is not null)`,
      "o.ready_at::text",
      `(select string_agg(ii.id || ':' || (ii.received_at is not null)::int || (ii.qbo_bill_id is not null)::int || ':' || coalesce(coalesce(ii.total, ii.subtotal)::text, '')
         || ':' || (select coalesce(sum(il.qty), 0) from jt.invoice_lines il where il.invoice_id = ii.id and il.variant_id is not null and il.match_how <> 'skip')
         || ':' || (select coalesce(sum(r.qty), 0) from jt.invoice_receipts r where r.invoice_id = ii.id) || ':' || coalesce(ii.invoice_date::text, '')
         || ':' || coalesce(nullif(ii.invoice_no, ''), '#' || ii.id), '|' order by ii.id) ${IV})`,
      // the part of the order no invoice covers yet, per product (units : cost) — its own card in Ordered (Oct 29)
      `(select coalesce(sum(greatest(x.ord - x.inv, 0)), 0) || ':' || coalesce(sum(greatest(x.ord - x.inv, 0) * x.cost), 0) from (select l.variant_id, sum(l.qty_ordered) as ord,
         max(coalesce(l.unit_cost, v.unit_cost, 0)) as cost, coalesce((select sum(il.qty) ${IL} and il.variant_id = l.variant_id and il.match_how <> 'skip'), 0) as inv
         from jt.prep_order_lines l left join jt.variants v on v.variant_id = l.variant_id where l.order_id = o.id group by l.variant_id) x)`, "o.ready_at::text"],
      "from jt.prep_orders o", "o.id", 2, refresh);
    S.orders = r.map(x => ({ id: x[0], vendor: x[1] || "", po: x[2] || "", status: x[3], kind: x[4] || "order", placeBy: x[5] || "", expected: x[6] || "", note: x[7] || "",
      stageAt: x[8] || {}, created: x[9], updated: x[10], nInv: +x[11], invNos: x[12] || "", invTotal: x[13] == null ? null : +x[13], due: x[14] || "", nFiles: +x[15],
      nLines: +x[16], units: +x[17], received: +x[18], cost: x[19] == null ? 0 : +x[19], unmatched: +x[20], guesses: +x[21], text: (x[22] || "").toLowerCase(), prepLines: +x[23],
      invoiced: +x[24], nBack: +x[25], backEta: x[26] || "", nUnpaid: +x[27] || 0, unpaidDue: x[28] || "", unpaidAmt: x[29] == null ? 0 : +x[29], shopifyUrl: x[30] || "", prepUnits: +x[31] || 0, into: x[32] || "", shopDiffs: x[34] ? +x[33] || 0 : null, shopStatus: x[35] || "", costsReady: +x[36] || 0, noShop: !!x[37],
      approvedAt: x[38] || "", approvedBy: x[39] || "", nQB: +x[40] || 0,
      invs: (x[41] || "").split("|").filter(Boolean).map(t => { const [id, f, tot, billed, got, date, ...no] = t.split(":");
        return { id, recv: f[0] === "1", qb: f[1] === "1", total: tot === "" ? null : +tot, billed: +billed || 0, got: +got || 0, date: date || "", no: no.join(":") }; }),
      restUnits: +String(x[42] || "0:0").split(":")[0] || 0, restCost: +String(x[42] || "0:0").split(":")[1] || 0, readyAt: x[43] || "" }))
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    // category / budget / placeholder (migration 162; empty until it's in)
    const pl = await JT.rows(["id::text", "category", "budget::text", "placeholder::text", "missing_invoice::text"], "from jt.prep_orders where category <> '' or budget is not null or placeholder or missing_invoice", refresh).catch(() => null);
    S.planOn = !!pl;
    const pm = new Map((pl || []).map(x => [x[0], x]));
    for (const o of S.orders) { const x = pm.get(o.id); o.category = x ? x[1] || "" : ""; o.budget = x && x[2] != null ? +x[2] : null; o.placeholder = !!x && x[3] === "true"; o.missingInv = !!x && x[4] === "true"; }
    await loadLanePos("po");
  }
  // what a PO is missing for its plan: shown as flags (only the vendor is required)
  const planGaps = (o) => [!o.category && "no category", o.budget == null && "no budget"].filter(Boolean);
  async function planCall(fn, sqlFn, p) {
    const W = window.JTWeb || null;
    if (W) { const r = await W.write(fn, { p }); return typeof r === "string" ? JSON.parse(r) : r; }
    const out = await JT.run(`select ${sqlFn}(${JT.q(JSON.stringify({ ...p, by: "Claude dashboard" }))}::jsonb)::text as r`, true);
    return out[0] && out[0].r != null ? JSON.parse(out[0].r) : null;
  }
  const CATS = ["Racquets", "Shoes", "Bags", "Strings", "Balls", "Grips & accessories", "Apparel", "Pickleball", "Padel", "Booking"];
  const catOptions = () => [...new Set([...CATS, ...(S.orders || []).map(o => o.category).filter(Boolean)])].sort().map(c => `<option value="${esc(c)}">`).join("");
  // Shopify catalog, remembered vendor codes and Amazon listings: for matching invoice lines and adding products.
  function catalog(refresh) {
    if (S.cat && !refresh) return Promise.resolve(S.cat);
    if (S.catP && !refresh) return S.catP;
    refresh = refresh || !S.catOnce; S.catOnce = true;   // first load of the page: fresh (at most 3 min old), not the cached copy
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
    S.loading = true; setStatus("Loading orders…"); renderList();
    try { await loadOrders(force); }
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
      out.set(l.id, { billed: bb, got: 0, left: 0 });
    }
    // what this invoice already received goes first to the lines that received it (a split product's parts are separate
    // ASINs: the units still to come must stay on the part that hasn't received them), then to the rest in order
    for (const pass of [0, 1]) for (const l of ed.lines) {
      const sh = out.get(l.id); if (!sh) continue;
      const room = sh.billed - sh.got, can = pass === 0 ? Math.min(room, Math.max(0, (l.received || 0) - sh.got)) : room;
      const g = Math.min(can, gl.get(l.vid)); sh.got += g; gl.set(l.vid, gl.get(l.vid) - g);
    }
    for (const sh of out.values()) sh.left = Math.max(0, sh.billed - sh.got);
    return out;
  }
  const rqKey = (iv, l) => iv.id + "#" + keyOf(l);
  const rqVal = (ed, iv, l, sh) => { const k = rqKey(iv, l); return ed.rq && k in ed.rq ? ed.rq[k] : String(sh ? sh.left : 0); };
  const newDest = (ed) => ed.dest === "both" ? ed.addTo || "shopify" : ed.dest === "prep" ? "prep" : "shopify";
  const DESTN = { shopify: "Shopify store", prep: "Prep center", demo: "Not for resale" };   // demo: received, never put into stock (migration 172)
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
  // line order (saved as prep_order_lines.pos, migration 170): move one line before/after another
  function moveLine(ed, fromId, toId, after) {
    const a = ed.lines.findIndex(x => x.id === fromId); if (a < 0) return false;
    const [l] = ed.lines.splice(a, 1); let b = ed.lines.findIndex(x => x.id === toId);
    if (b < 0) { ed.lines.splice(a, 0, l); return false; }
    ed.lines.splice(after ? b + 1 : b, 0, l); return true;
  }
  // invoice lines: move one before/after another; reorganize (v0.35.0). Charges and unmatched lines stay after the
  // products for the order/category/product sorts; "vendor" is the line's place on the vendor's invoice (vendor_no).
  function moveRow(iv, fromId, toId, after) {
    const a = iv.rows.findIndex(x => x.id === fromId); if (a < 0) return false;
    const [r] = iv.rows.splice(a, 1); const b = iv.rows.findIndex(x => x.id === toId);
    if (b < 0) { iv.rows.splice(a, 0, r); return false; }
    iv.rows.splice(after ? b + 1 : b, 0, r); return true;
  }
  function arrangeRows(ed, iv, how) {
    const at = new Map(iv.rows.map((r, i) => [r.id, i])), v = (r) => variant(r.vid) || {}, tail = (r) => (r.vid && !r.skip ? 0 : 1);
    const ordPos = new Map(ed.lines.map((l, i) => [String(l.vid), i]));
    const key = how === "vendor" ? (r) => [r.vno != null ? r.vno : 1e6]
      : how === "order" ? (r) => [tail(r), ordPos.has(String(r.vid)) ? ordPos.get(String(r.vid)) : 1e6]
      : how === "cat" ? (r) => [tail(r), (v(r).type || "~").toLowerCase(), (v(r).product || v(r).title || "").toLowerCase(), (v(r).variant || "").toLowerCase()]
      : how === "name" ? (r) => [tail(r), (v(r).product || v(r).title || "~").toLowerCase(), (v(r).variant || "").toLowerCase()] : null;
    if (!key) return false;
    const cmp = (x, y) => { const a = key(x), b = key(y); for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return at.get(x.id) - at.get(y.id); };
    const before = iv.rows.map(r => r.id).join(); iv.rows.sort(cmp); return iv.rows.map(r => r.id).join() !== before;
  }
  // a whole new order: like an invoice (its line order; what isn't on it stays after, as it was), grouped by product, or by SKU
  function arrange(ed, how) {
    const v = (l) => variant(l.vid) || {}, at = new Map(ed.lines.map((l, i) => [l.id, i]));
    let key;
    if (how.startsWith("inv:")) { const iv = ed.invoices[Number(how.slice(4))]; if (!iv) return false;
      const pos = new Map(); (iv.rows || []).forEach((r, i) => { if (r.vid && !pos.has(String(r.vid))) pos.set(String(r.vid), i); });
      key = (l) => [pos.has(String(l.vid)) ? pos.get(String(l.vid)) : 1e6]; }
    else if (how === "name") key = (l) => [(v(l).product || v(l).title || "").toLowerCase(), (v(l).variant || "").toLowerCase()];
    else if (how === "cat") key = (l) => [(v(l).type || "~").toLowerCase(), (v(l).product || v(l).title || "").toLowerCase(), (v(l).variant || "").toLowerCase()];
    else return false;
    const cmp = (x, y) => { const a = key(x), b = key(y); for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return at.get(x.id) - at.get(y.id); };
    const before = ed.lines.map(l => l.id).join(); ed.lines.sort(cmp);
    return ed.lines.map(l => l.id).join() !== before;
  }
  const variant = (vid) => vid && S.byVid ? S.byVid.get(String(vid)) : null;
  const cur = (ed) => ed.cur >= 0 ? ed.invoices[ed.cur] || null : null;
  // Saved POs: the details as a line of chips under the title; click one to edit (opens the details form at that field)
  // ---------- vendor view: the PO as the vendor sees it (Brian, Oct 6) ----------
  // One row per product (split parts added together): vendor SKU (the Shopify SKU), UPC, description, size, quantity,
  // and the unit cost unless it's turned off. Downloads as a PDF or CSV to send to the vendor.
  const SHIP_TO = ["Just Tennis", "9925 Businesspark Avenue, Suite C", "San Diego, CA 92131", "(858) 547-9707"];
  function vendorRows(ed) {
    const by = new Map();
    for (const l of ed.lines) {
      const q = Number(l.qty) || 0; if (q <= 0) continue;
      const v = variant(l.vid), unit = l.cost === "" ? (v && v.cost) || 0 : Number(l.cost) || 0;
      const r = by.get(l.vid) || by.set(l.vid, { sku: v ? v.sku : "", upc: v ? v.barcode : "", desc: v ? (v.product || v.title) : "variant " + l.vid, size: v ? v.variant : "", qty: 0, ext: 0 }).get(l.vid);
      r.qty += q; r.ext += q * unit;
    }
    return [...by.values()].map(r => ({ ...r, unit: r.qty ? r.ext / r.qty : 0 }))
      .sort((a, b) => a.desc.localeCompare(b.desc) || String(a.size).localeCompare(String(b.size), undefined, { numeric: true }) || a.sku.localeCompare(b.sku));
  }
  const vendorPoName = (ed) => ed.po ? poLabel(ed.po) : "PO #" + (ed.id || "new");
  const vendorDate = (ed) => { const d = ed.stageAt && ed.stageAt.ordered ? new Date(ed.stageAt.ordered) : new Date(); return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };
  function vendorBar(ed) {
    if (!ed.lines.length) return "";
    return `<div class="vbar2"><span class="seg sm" role="group" aria-label="View"><button data-pact="vview-off" aria-pressed="${!S.vview}">Working view</button><button data-pact="vview-on" aria-pressed="${!!S.vview}" title="What the vendor needs: SKU, UPC, product, size and quantity">Vendor view</button></span>
      ${S.vview ? `<span class="seg sm" role="group" aria-label="Cost"><button data-pact="vcost-on" aria-pressed="${!S.vnocost}">Show cost</button><button data-pact="vcost-off" aria-pressed="${!!S.vnocost}">Hide cost</button></span>
      <span class="dbtns right"><button class="btn" data-pact="vcsv" title="Spreadsheet for the vendor (opens in Excel)">Download CSV</button><button class="btn primary" data-pact="vpdf" title="PDF to email the vendor">Download PDF</button></span>` : ""}</div>`;
  }
  function vendorHtml(ed) {
    const rows = vendorRows(ed), cost = !S.vnocost, u = rows.reduce((a, r) => a + r.qty, 0), t = rows.reduce((a, r) => a + r.ext, 0);
    return `<div class="vsheet">
      <div class="vs-head"><div><div class="eyebrow">Purchase order</div><h3 class="h3">${esc(vendorPoName(ed))}</h3><div class="small muted">${esc(ed.vendor || "Vendor")} · ${esc(vendorDate(ed))}${ed.expected ? " · ship by " + esc(shortDate(ed.expected)) : ""}</div></div>
        <div class="small"><div class="eyebrow">Ship to</div>${SHIP_TO.map(esc).join("<br>")}</div></div>
      ${ed.note ? `<div class="small"><b>Note:</b> ${esc(ed.note)}</div>` : ""}
      <div class="tbl-wrap"><table class="po-t vs-t"><thead><tr><th>#</th><th class="l">Vendor SKU</th><th class="l">UPC</th><th class="l">Product</th><th class="l">Size / color</th><th>Qty</th>${cost ? "<th>Unit cost</th><th>Total</th>" : ""}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr><td class="dim">${i + 1}</td><td class="l mono">${esc(r.sku) || '<span class="neg">no SKU</span>'}</td><td class="l mono">${esc(r.upc)}</td><td class="l">${esc(r.desc)}</td><td class="l">${esc(r.size)}</td><td><b>${n0(r.qty)}</b></td>${cost ? `<td>${m(r.unit)}</td><td>${m(r.ext)}</td>` : ""}</tr>`).join("")}</tbody>
      <tfoot><tr><td></td><td class="l" colspan="4">${rows.length} item${rows.length === 1 ? "" : "s"}</td><td>${n0(u)}</td>${cost ? `<td></td><td>${m(t)}</td>` : ""}</tr></tfoot></table></div>
      ${rows.length < new Set(ed.lines.map(l => l.vid)).size ? '<div class="muted small">Products with no quantity are left off.</div>' : ""}
    </div>`;
  }
  const fileBase = (ed) => `${(ed.vendor || "vendor").replace(/[^A-Za-z0-9]+/g, "-")}_${vendorPoName(ed).replace(/[^A-Za-z0-9]+/g, "-")}`.replace(/-+/g, "-").replace(/^-|-$/g, "");
  async function saveFile(name, data, mimeType) {
    const d = window.claude && window.claude.use ? await window.claude.use("downloads").catch(() => null) : null;
    if (!d) { note("warn", "Downloads aren't available here."); return; }
    try { await d.save({ filename: name, data, mimeType }); } catch (e) { if (e && e.code !== "declined") note("warn", esc(JT.message(e))); }
  }
  async function vendorCsv(ed) {
    const cost = !S.vnocost, q = (x) => /[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x);
    const lines = [[vendorPoName(ed), ed.vendor, vendorDate(ed)].map(q).join(","), ["Ship to", SHIP_TO.join(", ")].map(q).join(","), ""];
    lines.push(["Vendor SKU", "UPC", "Product", "Size / color", "Qty", ...(cost ? ["Unit cost", "Total"] : [])].join(","));
    for (const r of vendorRows(ed)) lines.push([r.sku, r.upc ? `="${r.upc}"` : "", r.desc, r.size, r.qty, ...(cost ? [r.unit.toFixed(2), r.ext.toFixed(2)] : [])].map(q).join(","));
    await saveFile(fileBase(ed) + ".csv", lines.join("\n"), "text/csv");
  }
  let pdfLib = null;
  function loadScript(src) { return new Promise((ok, bad) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => bad(new Error("Couldn't load " + src)); document.head.appendChild(s); }); }
  async function vendorPdf(ed) {
    try {
      if (!pdfLib) {
        await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
        await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js");
        pdfLib = window.jspdf;
      }
      const cost = !S.vnocost, rows = vendorRows(ed), doc = new pdfLib.jsPDF({ unit: "pt", format: "letter" }), W = doc.internal.pageSize.getWidth();
      doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.text("Purchase Order", 40, 50);
      doc.setFontSize(12); doc.text(vendorPoName(ed), 40, 70);
      doc.setFont("helvetica", "normal"); doc.setFontSize(10);
      doc.text([`Vendor: ${ed.vendor || ""}`, `Date: ${vendorDate(ed)}`, ...(ed.expected ? [`Ship by: ${shortDate(ed.expected)}`] : [])], 40, 92);
      doc.setFont("helvetica", "bold"); doc.text("Ship to", W - 220, 50); doc.setFont("helvetica", "normal"); doc.text(SHIP_TO, W - 220, 64);
      let y = 140; if (ed.note) { doc.text(doc.splitTextToSize("Note: " + ed.note, W - 80), 40, y - 14); y += 10; }
      const money = (x) => "$" + x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      const units = rows.reduce((a, r) => a + r.qty, 0), total = rows.reduce((a, r) => a + r.ext, 0);
      doc.autoTable({ startY: y, head: [["#", "Vendor SKU", "UPC", "Product", "Size / color", "Qty", ...(cost ? ["Unit cost", "Total"] : [])]],
        body: rows.map((r, i) => [i + 1, r.sku, r.upc, r.desc, r.size, r.qty, ...(cost ? [money(r.unit), money(r.ext)] : [])]),
        foot: [["", `${rows.length} items`, "", "", "", units, ...(cost ? ["", money(total)] : [])]],
        styles: { fontSize: 9, cellPadding: 4 }, headStyles: { fillColor: [0, 38, 118] }, footStyles: { fillColor: [238, 241, 244], textColor: 20 },
        columnStyles: { 0: { cellWidth: 22 }, 5: { halign: "right" }, 6: { halign: "right" }, 7: { halign: "right" } } });
      const out = doc.output("blob");
      await saveFile(fileBase(ed) + ".pdf", out, "application/pdf");
    } catch (e) { note("bad", "Couldn't make the PDF: " + esc(e && e.message || String(e)) + ". Download CSV works without it."); }
  }
  function headStrip(ed, ro, both) {
    if (!ed.id || ed.editHead) return "";
    const f = (id, label, val, empty) => `<button class="hfield" data-hedit="${id}" title="Edit ${label.toLowerCase()}"><span>${label}</span><b class="${val ? "" : "dim"}">${val ? esc(val) : empty}</b></button>`;
    const su = shopUrl(ed.shopifyUrl);
    return `<div class="po-meta">${[
      f("pe-kind", "Type", ed.kind === "booking" ? "Booking" : "Order", ""),
      ed.kind === "booking" ? f("pe-placeby", "Place by", ed.placeBy ? shortDate(ed.placeBy) : "", "not set") : "",
      f("pe-exp", "Expected", ed.expected ? shortDate(ed.expected) : "", "not set"),
      "" && f("pe-shopify", "Shopify PO", su ? (/purchase_orders\/(\d+)/.exec(su) || [])[1] ? "#" + /purchase_orders\/(\d+)/.exec(su)[1] : "linked" : "", "add link") + (su && /^https:/.test(su) ? `<a class="small hopen" href="${esc(su)}" target="_blank" rel="noopener" title="Open in Shopify">↗</a>` : ""),
      f("pe-dest", "Receive into", both ? "Both" : ed.dest === "prep" ? "Prep center" : "Shopify store", ""),
      f("pe-note", "Note", ed.note, "add a note"),
    ].join("")}</div>`;
  }
  // Seller Sage only: no Shopify PO for this order (marked by hand, or nothing on it goes to the Shopify store)
  const prepOnly = (ed) => ed.lines.length > 0 && !ed.lines.some(l => l.dest === "shopify");
  // no Shopify POs any more (Brian, Oct 21): every PO is Seller Sage only
  const shopOff = () => true;
  const shopOffO = () => true;
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
          "(select value::text from jt.settings where key = 'shopify_po_api')", "o.approved_at::text", "o.approved_by", "o.no_shopify_po", "o.ready_at::text"],
          `from jt.prep_orders o where o.id = ${JT.int(id)}`, true),
        JT.rows(["variant_id::text", "amazon_sku", "dest", "qty_ordered", "qty_received", "unit_cost", "backorder", "eta::text", "update_cost", "cost_applied", "cost_applied_at::text"], `from jt.prep_order_lines where order_id = ${JT.int(id)} order by coalesce(pos, 1000000), variant_id, dest desc, amazon_sku`, true),
        JT.rows(["id::text", "name", "status"], `from jt.prep_shipments where order_id = ${JT.int(id)}`, true),
        JT.rows(INV_COLS, `from jt.invoices i where i.order_id = ${JT.int(id)} or i.id = (select invoice_id from jt.prep_orders where id = ${JT.int(id)}) order by i.id`, true),
        // how this vendor was paid last time (for Mark paid)
        JT.rows(["i.pay_method", "i.paid_from"], `from jt.invoices i where i.vendor = (select vendor from jt.prep_orders where id = ${JT.int(id)}) and i.pay_method <> '' order by i.paid_on desc nulls last, i.id desc limit 1`, true),
      ]);
      if (!h[0]) throw { code: "tool_error", message: "That purchase order no longer exists." };
      const x = h[0], ed = blankEd();
      ed.noShop = !!x[x.length - 2]; ed.approvedAt = x[x.length - 4] || ""; ed.approvedBy = x[x.length - 3] || ""; ed.readyAt = x[x.length - 1] || "";
      Object.assign(ed, { id: x[0], vendor: x[1] || "", po: x[2] || "", status: x[3], kind: x[4] || "order", placeBy: x[5] || "", expected: x[6] || "", note: x[7] || "", shortOk: !!x[8],
        stageAt: x[9] || {}, created: x[10], createdBy: x[11] || "", shopifyUrl: x[12] || "", into: x[13] || "", shopCheck: x[14] || null, shopUrl0: x[12] || "", shopCheck0: JSON.stringify(x[14] || null), shopRecvAt: x[15] || "", shopRecvBy: x[16] || "", stockSyncedAt: x[17] || "", shopStatus: x[18] || "", shopStatusAt: x[19] || "", poApi: (() => { try { return x[20] ? JSON.parse(x[20]) : null; } catch (_) { return null; } })(), shipments: sh.map(s => ({ id: s[0], name: s[1], status: s[2] })) });
      ed.lines = ol.map(([vid, asku, dest, qo, qr, uc, bo, eta, upd, ca, cat]) => ({ id: newId(), vid, asku: asku || "", dest: dest || "prep", qty: String(+qo), cost: fmtCost(uc), received: +qr || 0, backorder: !!bo, eta: eta || "", auto: false,
        upd: !!upd, costApplied: ca == null ? null : +ca, costAppliedAt: cat || "" }));
      ed.lastPay = lp[0] ? { method: lp[0][0] || "", from: lp[0][1] || "" } : null;
      await fillInvoices(ed, ivs);
      { const pl = await JT.rows(["category", "budget::text", "placeholder::text", "missing_invoice::text", "missing_invoice_at::text", "missing_invoice_by"], `from jt.prep_orders where id = ${JT.int(id)}`, true).catch(() => null);
        ed.planOn = !!pl; ed.category = pl && pl[0] ? pl[0][0] || "" : ""; ed.budget = pl && pl[0] && pl[0][1] != null ? +pl[0][1] : null; ed.placeholder = !!(pl && pl[0] && pl[0][2] === "true");
        ed.missingInv = !!(pl && pl[0] && pl[0][3] === "true"); ed.missingAt = pl && pl[0] ? pl[0][4] || "" : ""; ed.missingBy = pl && pl[0] ? pl[0][5] || "" : ""; }
      // store units received here and on the Shopify PO too (migration 161): {variant_id: units Shopify counted twice}
      ed.recvDouble = await JT.rows(["recv_double::text"], `from jt.prep_orders where id = ${JT.int(id)}`, true).then(r => { try { return JSON.parse((r[0] || [])[0] || "{}"); } catch (_) { return {}; } }).catch(() => ({}));
      const dests = new Set(ed.lines.map(l => l.dest));
      ed.dest = dests.size > 1 || ed.into === "both" ? "both" : dests.size === 1 ? [...dests][0] : ed.into || "shopify";
      ed.showPdf = window.innerWidth >= 1100 && !!(cur(ed) && cur(ed).parts);
      S.ed = ed; S.busy = "";
      if (cur(ed) && cur(ed).parts) loadFile(cur(ed)).then(() => { if (S.ed === ed) { const h2 = $("pe-pdf"); if (h2) h2.innerHTML = ""; renderPdf(); } }).catch(() => {});
    } catch (e) { S.busy = ""; S.ed = null; note("bad", esc(JT.message(e))); }
    render();
  }

  // unmatched invoice lines (and guesses) get another try against the catalog. sure: only certain matches (on open)
  function rematch(ed, sure) {
    let n = 0;
    if (ed) for (const iv of ed.invoices) for (const r of iv.rows) {
      if (!r.src || r.skip || r.how === "manual" || r.confirmed || isSure(r)) continue;       // not-matched lines and guesses
      const g = guessLine(r.src, ed.vendor);
      if (g.vid && (!sure || SURE.has(g.how)) && (g.vid !== r.vid || g.how !== r.how)) { Object.assign(r, g); n++; }
    }
    return n;
  }
  const rematchMsg = (n) => `${n} invoice line${n === 1 ? " was" : "s were"} matched to products added in Shopify since the invoice was saved. Check them and Save.`;
  // the saved invoices of a PO (or the one invoice of an invoice saved without a PO): header, lines, receipts
  const INV_COLS = ["i.id::text", "i.invoice_no", "i.invoice_date::text", "i.subtotal", "i.file_name", "i.file_parts", "i.status", "i.notes", "i.due_date::text", "i.total", "i.terms",
    "i.paid_on::text", "i.pay_method", "i.pay_ref", "i.paid_from", "i.paid_amount", "i.received_at::text", "i.received_manual", "i.qbo_bill_id", "i.qbo_doc", "i.qbo_sent_at::text", "i.qbo_how", "i.qbo_sent_by", "i.qbo_attach_id"];
  async function fillInvoices(ed, ivs) {
    ed.invoices = ivs.map(v => ({ ...blankInv(), id: v[0], no: v[1] || "", date: v[2] || "", subtotal: v[3] == null ? null : +v[3], fileName: v[4] || "", parts: +v[5] || 0, status: v[6] || "draft",
      notes: v[7] || "", due: v[8] || "", total: v[9] == null ? null : +v[9], terms: v[10] || "", isNew: false,
      paidOn: v[11] || "", payMethod: v[12] || "", payRef: v[13] || "", paidFrom: v[14] || "", paidAmount: v[15] == null ? null : +v[15], recvAt: v[16] || "", recvManual: !!v[17], qbo: v[18] ? { id: v[18], doc: v[19] || "", at: v[20] || "", how: v[21] || "", by: v[22] || "", att: v[23] || "" } : null }));
    if (!ed.invoices.length) return;
    const il = await JT.rows(["invoice_id::text", "line_no", "item_code", "upc", "description", "qty", "unit_cost", "amount", "variant_id::text", "match_how", "account", "coalesce(vendor_no, line_no)"],
      `from jt.invoice_lines where invoice_id in (${ed.invoices.map(v => JT.int(v.id)).join(",")}) order by invoice_id, line_no`, true);
    const byId = new Map(ed.invoices.map(v => [v.id, v]));
    for (const l of il) {
      const iv = byId.get(l[0]); if (!iv) continue;
      const hw = howFromSaved(l[8] ? l[9] : "");
      iv.rows.push({ id: newId(), src: { item_code: l[2] || "", upc: l[3] || "", description: l[4] || "", qty: l[5] == null ? null : +l[5], unit_cost: l[6] == null ? null : +l[6], amount: l[7] == null ? null : +l[7] },
        vid: l[8] || null, how: hw.how, conf: hw.conf, alts: [], confirmed: false, skip: l[9] === "skip", account: l[10] || "inventory", vno: l[11] == null ? null : +l[11],
        qty: l[5] == null ? "" : String(+l[5]), cost: fmtCost(l[6]) });
    }
    for (const iv of ed.invoices) for (const r of iv.rows) if (needsCheck(r)) r.alts = guessLine(r.src, ed.vendor).alts;
    // lines saved before their product existed in Shopify: match them now (SKU / barcode / remembered code), then Save
    const n = rematch(ed, true);
    if (n) { ed.dirty = true; setTimeout(() => { if (S.ed !== ed) return; syncLines(ed); render(); note("info", rematchMsg(n)); }, 60); }
    const rc = await JT.rows(["invoice_id::text", "variant_id::text", "qty"], `from jt.invoice_receipts where invoice_id in (${ed.invoices.map(v => JT.int(v.id)).join(",")})`, true).catch(() => []);
    for (const [iid, vid, q] of rc) { const iv = byId.get(iid); if (iv) iv.got.set(vid, +q || 0); }
    ed.cur = ed.invoices.length - 1;
  }

  // ---------- an invoice without a PO (Brian, Oct 14: "we often get the invoice first") ----------
  // ed.alone: an editor holding one invoice and no PO. Saved with jt.invoice_save_alone; from here it's turned into a
  // Shopify import CSV (to build the Shopify PO), starts a Seller Sage PO, or goes onto an existing PO. When a Shopify PO
  // with exactly its products syncs in, the database attaches it to that PO by itself (migration 141).
  async function openAlone(id) {
    S.ed = null; S.busy = "Opening the invoice…"; render();
    try {
      await catalog();
      if (!S.orders) await loadOrders(false);
      const ivs = await JT.rows([...INV_COLS, "i.vendor"], `from jt.invoices i where i.id = ${JT.int(id)}`, true);
      if (!ivs[0]) throw { code: "tool_error", message: "That invoice no longer exists." };
      const ed = blankEd(); ed.alone = true; ed.vendor = ivs[0][INV_COLS.length] || "";
      const lp = ed.vendor ? await JT.rows(["i.pay_method", "i.paid_from"], `from jt.invoices i where i.vendor = ${JT.q(ed.vendor)} and i.pay_method <> '' order by i.paid_on desc nulls last, i.id desc limit 1`, true) : [];
      ed.lastPay = lp[0] ? { method: lp[0][0] || "", from: lp[0][1] || "" } : null;
      await fillInvoices(ed, ivs.map(r => r.slice(0, INV_COLS.length)));
      syncLines(ed);
      S.ed = ed; S.busy = ""; S.pend = null; pdfToken++; showInvoicePage();
    } catch (e) { S.busy = ""; S.ed = null; render(); note("bad", esc(JT.message(e))); }
  }
  async function saveAlone(quiet) {
    const ed = S.ed, iv = ed && cur(ed); if (!ed || !iv || S.busy) return null;
    if (!ed.vendor.trim()) { note("bad", "Enter the vendor."); return null; }
    const b = iv.rows.find(r => r.qty !== "" && isNaN(Number(r.qty)) || r.cost !== "" && !(Number(r.cost) >= 0));
    if (b) { note("bad", `Check the quantity and cost of ${esc(b.src.description || b.src.item_code)}.`); return null; }
    const body = bodyOf(ed), first = !iv.id;
    S.busy = "Saving…"; render();
    try {
      const id = String(await JT.po.saveInvoiceAlone({ ...body.invoices[ed.cur], remember: body.remember }));
      iv.id = id;
      if (iv.file && !iv.file.saved) { await uploadFile(id, iv.file); iv.file.saved = true; }
      S.busy = "";
      loadInvList(true).catch(() => {});
      await openAlone(id);
      if (!quiet) note("info", `Invoice <b>${esc(iv.no || id)}</b> ${first ? "saved" : "saved again"} — no PO yet.${body.remember.length ? " Matches are remembered for this vendor's next invoice." : ""} Start a PO from it or add it to one.`);
      return id;
    } catch (e) {
      S.busy = ""; render();
      const msg = (e && e.message) || "";
      note("bad", /invoices_vendor_no_idx|duplicate key/i.test(msg) ? `Invoice ${esc(iv.no)} from ${esc(ed.vendor)} is already saved.` : "Couldn't save: " + esc(JT.message(e)));
      return null;
    }
  }
  function aloneLinkHtml(ed) {
    const all = (S.orders || []).filter(o => o.status !== "complete");
    const same = all.filter(o => o.vendor.toLowerCase() === (ed.vendor || "").toLowerCase()), rest = all.filter(o => !same.includes(o));
    const opt = (o) => `<option value="${esc(o.id)}">${esc(o.vendor)} · ${esc(o.po ? poLabel(o.po) : "#" + o.id)} (${esc(STAGE.get(o.status))})</option>`;
    return `<div class="note warn">Put this invoice on a purchase order:
      ${ed.moveRank ? rankHtml(ed.moveRank.rk, ed.moveRank.n, 'data-pact="alone-link-go" data-k') : ""}
      <select id="pe-alonepo" class="inp sm" style="width:auto;max-width:320px">${same.length ? `<optgroup label="${esc(ed.vendor)}">${same.map(opt).join("")}</optgroup>` : ""}${rest.length ? `<optgroup label="Other vendors">${rest.map(opt).join("")}</optgroup>` : ""}</select>
      <span class="dbtns"><button class="mini primary" data-pact="alone-link-go" ${all.length ? "" : "disabled"}>Add it</button><button class="mini" data-pact="no">Cancel</button></span></div>`;
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
  // the reader timed out or failed: "Try again" / "Use the quick reader". Resolves "retry", "quick", or the read's
  // result when it finishes on its own while the question is up (checked every 5 s).
  function askRetry(rr) {
    return new Promise((done) => {
      let over = false;
      const finish = (v) => { if (over) return; over = true; clearInterval(t); S.busyRetry = null; done(v); };
      const t = setInterval(async () => { const r = await window.JTReader.peek(rr.readId); if (r) finish(r); }, 5000);
      S.busy = (rr.outcome === "timeout" ? "The invoice reader didn't finish" + (rr.message ? " — " + rr.message + "." : ".")
        : "The invoice reader hit an error" + (rr.message ? ": " + rr.message : ".")) + " ";
      S.busyRetry = finish; renderBusy();
    });
  }
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
      // the vendor-template reader first (scans, discounts, multi-invoice PDFs); the in-browser reader if it can't
      let inv = null, readNote = "", readId = null;
      if (window.JTReader) {
        S.busySkip = true;
        const onWait = (t) => { S.busy = t; renderBusy(); };
        let rr = await window.JTReader.read(bytes, file.name, { onWait });
        // timed out or failed: ask — try the reader again (same file, no re-upload) or go on with the quick reader
        while (!rr.ok && rr.retry && rr.outcome !== "skipped" && rr.readId) {
          S.busySkip = false;
          const late = await askRetry(rr);
          if (late === "quick") break;
          if (late && late !== "retry") { rr = late; break; }   // it finished while we were asking
          S.busySkip = true; S.busy = "Trying the invoice reader again…"; renderBusy();
          rr = await window.JTReader.wait(rr.readId, { kick: true, onWait });
        }
        S.busySkip = false; S.busyRetry = null; readId = rr.readId || null;
        if (rr.ok) {
          inv = rr.inv;
          if (rr.others.length) readNote += `This PDF holds ${rr.others.length + 1} invoices (${[inv, ...rr.others].map(x => esc(x.invoice_no)).join(", ")}); this is the first. `;
          if (inv.read.status !== "auto_ok" && inv.read.issues.length) readNote += `Read with the ${esc(inv.vendor)} template; check: ${esc(inv.read.issues.slice(0, 2).join("; "))}. `;
          else readNote += `Read with the ${esc(inv.vendor)} template${inv.read.status === "auto_ok" ? " (lines and totals tie out)" : ""}. `;
        } else if (rr.outcome === "unknown_vendor") readNote = "No vendor template knows this invoice yet, so the quick reader was used (it's queued for Claude to learn). ";
        else if (rr.outcome === "unsupported") readNote = `${esc(rr.message || "This doesn't look like an invoice")}. `;
        else if (rr.outcome === "timeout" || rr.outcome === "error") readNote = "The invoice reader didn't finish, so the quick reader was used. ";
      }
      if (!inv) inv = IP.parseInvoice(rows, { vendors: S.vendors, known: (t, vendor) => S.bySku.has(norm(t)) || (!!vendor && S.remembered.has(vendor.toLowerCase() + "|" + norm(t))) });
      pend = { inv, rows, f: { bytes, name: file.name, type: file.type || "application/pdf" }, readId, readNote };
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
    // the PO # on the invoice: "1125" is PO1125 (poKey drops a leading "PO")
    const poKey = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^po/, "");
    const same = inv.po_no && S.orders.find(o => o.status !== "complete" && (norm(o.po) === norm(inv.po_no) || (poKey(o.po) && poKey(o.po) === poKey(inv.po_no)))
      && (!inv.vendor || !o.vendor || o.vendor.toLowerCase() === inv.vendor.toLowerCase()));
    if (same) { await openPO(same.id); return attach(pend, S.ed, `Added to <b>${esc(same.vendor)} ${esc(poLabel(same.po))}</b> (the PO # on the invoice). `); }
    choosePO(pend);
  }
  // no PO matched: pick one of the vendor's open POs, or start a new PO
  async function choosePO(pend) {
    S.mode = "inv"; S.invOpen = false; S.pend = pend; goInvTab();
    const inv = pend.inv, vend = (inv.vendor || "").toLowerCase();
    // the vendor's open orders that already have these products: the likely home for this invoice
    const vids = [...new Set((inv.lines || []).map(l => { const g = guessLine(l, inv.vendor); return SURE.has(g.how) ? g.vid : null; }).filter(Boolean))];
    const rk = inv.vendor ? await rankOpenPOs(inv.vendor, vids).catch(() => []) : [];
    const best = rk.find(x => x.shared > 0 && x.shared * 2 >= vids.length);
    const open = (S.orders || []).filter(o => o.status !== "complete");
    const same = open.filter(o => vend && o.vendor.toLowerCase() === vend), rest = open.filter(o => !same.includes(o));
    const opt = (o) => `<option value="${esc(o.id)}">${esc(o.vendor)} · ${esc(o.po ? poLabel(o.po) : "#" + o.id)} (${esc(STAGE.get(o.status))})</option>`;
    note("warn", `<b>Which purchase order is invoice ${esc(inv.invoice_no || file0(pend))} from ${esc(inv.vendor || "this vendor")} for?</b>${inv.po_no ? ` It says PO # <span class="mono">${esc(inv.po_no)}</span>, which doesn't match an open PO.` : " No PO # was found on it."}
      ${best ? `<div class="small"><b>There's an open order with these products</b> — add the invoice to it rather than starting another PO:</div>` : ""}${rankHtml(rk, vids.length, 'data-pend="pick" data-o')}
      <div class="row">${open.length ? `<select id="pe-pendpo" class="inp sm" style="width:auto;max-width:340px">${same.length ? `<optgroup label="${esc(inv.vendor)}">${same.map(opt).join("")}</optgroup>` : ""}${rest.length ? `<optgroup label="${same.length ? "Other vendors" : "Open purchase orders"}">${rest.map(opt).join("")}</optgroup>` : ""}</select><button class="mini primary" data-pend="pick">Add it to this PO</button>` : ""}
      <button class="mini" data-pend="new" ${best ? `title="${esc(best.o.vendor)} ${esc(best.o.po ? poLabel(best.o.po) : "#" + best.o.id)} already has ${best.shared} of these products"` : ""}>Start a new PO from it${best ? " anyway" : ""}</button><button class="mini ${open.length ? "" : "primary"}" data-pend="alone" title="Keep the invoice on its own for now: check its lines, build the Shopify PO from it (Shopify import CSV), and it goes onto that PO when it syncs in">Save the invoice only — no PO yet</button><button class="mini" data-pend="cancel">Cancel</button></div>`);
  }
  const file0 = (pend) => pend.f.name;
  async function fixDouble(ed) {
    S.busy = "Taking the extra units out of Shopify…"; render();
    try {
      const n = WEBW() ? Number(await WEBW().write("jt_po_fix_double", { p: { id: Number(ed.id) } }))
        : Number(((await JT.run(`select jt.po_fix_double(${JT.q(JSON.stringify({ id: Number(ed.id), by: "Claude dashboard" }))}::jsonb) as n`, true))[0] || {}).n || 0);
      S.busy = ""; ed.recvDouble = {}; render(); note("info", `${n0(n)} unit${n === 1 ? "" : "s"} will come out of Shopify's stock in a minute (Inventory sync).`);
    } catch (e) { S.busy = ""; render(); note("bad", "Couldn't fix it: " + esc(JT.message(e))); }
  }
  const WEBW = () => window.JTWeb || null;
  async function pendGo(how, oid) {
    const pend = S.pend; if (!pend) return;
    if (how === "cancel") { S.pend = null; note("", ""); render(); return; }
    // the PO picker is inside the note: read it before the note is cleared
    const pick = how === "pick" ? (oid || ($("pe-pendpo") || {}).value) : "";
    if (how === "pick" && !pick) return;
    note("", "");
    if (how === "pick") { await openPO(pick); if (!S.ed) return; return attach(pend, S.ed, ""); }
    if (how === "alone") { S.ed = Object.assign(blankEd(), { alone: true }); return attach(pend, S.ed, "This invoice is on its own — no PO yet. "); }
    S.ed = blankEd(); return attach(pend, S.ed, "A new purchase order starts from this invoice. ");
  }
  // the parsed invoice goes onto ed (a PO), and opens on the Invoices tab
  async function attach(pend, ed, msg) {
    const { inv, f, rows } = pend;
    msg = (pend.readNote || "") + (msg || "");
    const noText = !rows.length && !inv.lines.length;     // a scan the template reader couldn't read either
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
    msg += iv.fromPo ? `${noText ? "This PDF has no text in it (probably a scan or photo)" : inv.lines.length ? "None of the lines read from this PDF matched a product" : "No item lines could be read from this PDF"}, so <b>the invoice was filled in from the PO</b>: ${iv.rows.filter(r => r.fromPo).length} product${iv.rows.filter(r => r.fromPo).length === 1 ? "" : "s"} still open on it, at the PO's quantities and costs. Check them against the PDF and change anything the vendor shipped short or billed differently.`
      : noText ? "This PDF has no text in it (it's probably a scan or photo), so no lines could be read. Add them with <b>Add line</b>."
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
      if (!oid) return openAlone(String(id));
      if (!S.ed || S.ed.id !== oid) await openPO(oid);
      if (!S.ed) return;
      const i = S.ed.invoices.findIndex(v => v.id === String(id)); if (i >= 0) S.ed.cur = i;
      S.ed.lineEdit = false; S.pend = null; pdfToken++; showInvoicePage();
    } catch (e) { note("bad", esc(JT.message(e))); }
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


  // ---------- swimlane order and table sorting (Brian, Oct 29: "we need to be able to sort the tables at the bottom of
  // the orders and invoices page. we should also be able to reorder items in the swimlanes") ----------
  // A card's place in its lane is kept in the database (lane_pos, migration 173) so everyone sees the same order; cards
  // without one follow in the lane's usual order.
  const LANEPOS = { po: new Map(), inv: new Map() }, LANEIDS = { po: {}, inv: {} };
  // Orders lanes hold order cards ("o12") and invoice cards ("i34", their place kept in invoices.po_lane_pos, migration 174)
  async function loadLanePos(kind) {
    const r = kind === "po"
      ? await JT.rows(["k", "pos::text"], "from (select 'o' || id as k, lane_pos as pos from jt.prep_orders where lane_pos is not null union all select 'i' || id, po_lane_pos from jt.invoices where po_lane_pos is not null) x", true).catch(() => null)
      : await JT.rows(["id::text", "lane_pos::text"], "from jt.invoices where lane_pos is not null", true).catch(() => null);
    if (r) LANEPOS[kind] = new Map(r.map(x => [x[0], +x[1]]));
  }
  function laneSort(kind, k, arr) {
    const m = LANEPOS[kind], at = new Map(arr.map((x, i) => [x.id, i]));
    const out = m.size ? arr.slice().sort((a, b) => (m.has(a.id) ? m.get(a.id) : 1e9) - (m.has(b.id) ? m.get(b.id) : 1e9) || at.get(a.id) - at.get(b.id)) : arr;
    LANEIDS[kind][k] = out.map(x => x.id);
    return out;
  }
  const laneCustom = (kind, arr) => arr.some(x => LANEPOS[kind].has(x.id));
  const laneRedraw = (kind) => kind === "po" ? renderList() : renderInvList();
  async function saveLaneOrder(kind, ids, clear) {
    const before = new Map(LANEPOS[kind]);
    ids.forEach((id, i) => clear ? LANEPOS[kind].delete(id) : LANEPOS[kind].set(id, i + 1));
    laneRedraw(kind);
    try { await planCall("jt_lane_order", "jt.lane_order", { kind, ids: kind === "po" ? ids : ids.map(Number), clear: !!clear }); }
    catch (e) { LANEPOS[kind] = before; laneRedraw(kind); note("bad", "Couldn't save the order of the cards: " + esc(JT.message(e))); }
  }
  function moveCard(kind, k, id, to, above) {
    const ids = (LANEIDS[kind][k] || []).filter(x => x !== id);
    const i = ids.indexOf(to); if (i < 0 || id === to) return;
    ids.splice(above ? i : i + 1, 0, id);
    saveLaneOrder(kind, ids);
  }
  function wireLaneDrag(box, kind) {
    const sel = "[data-ck]";
    const idOf = (c) => c.dataset.ck;
    let drag = null;
    const marks = () => box.querySelectorAll(".drop-above,.drop-below");
    const clear = () => { marks().forEach(x => x.classList.remove("drop-above", "drop-below")); box.querySelectorAll(".dragging").forEach(x => x.classList.remove("dragging")); };
    box.addEventListener("dragstart", (e) => {
      const c = e.target.closest && e.target.closest(sel + "[draggable=true]"); if (!c) return;
      drag = { id: idOf(c), k: c.closest("[data-lane-k]").dataset.laneK };
      e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", drag.id); c.classList.add("dragging");
    });
    box.addEventListener("dragover", (e) => {
      if (!drag) return;
      const lane = e.target.closest("[data-lane-k]"); if (!lane || lane.dataset.laneK !== drag.k) return;   // only within its own lane
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      const c = e.target.closest(sel);
      marks().forEach(x => x.classList.remove("drop-above", "drop-below"));
      if (c && idOf(c) !== drag.id) { const r = c.getBoundingClientRect(); c.classList.add(e.clientY < r.top + r.height / 2 ? "drop-above" : "drop-below"); }
    });
    box.addEventListener("drop", (e) => {
      if (!drag) return; e.preventDefault();
      const c = box.querySelector(".drop-above,.drop-below"), above = !!c && c.classList.contains("drop-above"), d = drag;
      drag = null; clear();
      if (c) moveCard(kind, d.k, d.id, idOf(c), above);
    });
    box.addEventListener("dragend", () => { drag = null; clear(); });
    box.addEventListener("keydown", (e) => {     // Alt+Up / Alt+Down on a card moves it
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      const c = e.target.closest(sel); if (!c || e.target !== c) return;
      e.preventDefault();
      const k = c.closest("[data-lane-k]").dataset.laneK, id = idOf(c), ids = (LANEIDS[kind][k] || []).slice(), i = ids.indexOf(id), j = i + (e.key === "ArrowUp" ? -1 : 1);
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      saveLaneOrder(kind, ids);
      const f = box.querySelector(`${sel.slice(0, -1)}="${CSS.escape(id)}"]`); if (f) f.focus();
    });
    box.addEventListener("click", (e) => {
      const r = e.target.closest("[data-lane-reset]"); if (!r) return; e.stopPropagation();
      const k = r.dataset.laneReset; saveLaneOrder(kind, LANEIDS[kind][k] || [], true);
    });
  }
  // the tables: click a column heading to sort by it, again to flip it, a third time for the usual order
  const SORTS = { po: null, inv: null };
  try { Object.assign(SORTS, JSON.parse(localStorage.getItem("jt.po.sorts") || "{}")); } catch (e) { /* no storage here */ }
  function sortTh(kind, keys, k, label, left) {
    const s = SORTS[kind], on = !!s && s.k === k;
    if (!keys[k]) return `<th class="${left ? "l" : ""}">${label}</th>`;
    return `<th class="${left ? "l " : ""}th-s${on ? " on" : ""}" aria-sort="${on ? (s.dir > 0 ? "ascending" : "descending") : "none"}"><button type="button" class="th-sort" data-sort="${k}" title="Sort by ${esc(label)}">${label}<span class="sort-ic" aria-hidden="true">${on ? (s.dir > 0 ? "▲" : "▼") : "↕"}</span></button></th>`;
  }
  function applySort(kind, keys, list) {
    const s = SORTS[kind]; if (!s || !keys[s.k]) return list;
    const f = keys[s.k][0], blank = (x) => x == null || x === "" || (typeof x === "number" && isNaN(x));
    return list.map((x, i) => [f(x), x, i]).sort((a, b) => {
      if (blank(a[0]) || blank(b[0])) return blank(a[0]) - blank(b[0]) || a[2] - b[2];      // blanks last either way
      const c = typeof a[0] === "number" && typeof b[0] === "number" ? a[0] - b[0] : String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true, sensitivity: "base" });
      return c * s.dir || a[2] - b[2];
    }).map(p => p[1]);
  }
  function toggleSort(kind, keys, k) {
    const s = SORTS[kind], first = keys[k][1] || 1;
    SORTS[kind] = !s || s.k !== k ? { k, dir: first } : s.dir === first ? { k, dir: -first } : null;
    try { localStorage.setItem("jt.po.sorts", JSON.stringify(SORTS)); } catch (e) { /* no storage here */ }
  }
  // [value, first click's direction (-1: biggest / newest first)]
  const PO_KEYS = {
    po: [o => o.po ? poLabel(o.po) : "#" + o.id], vendor: [o => o.vendor], status: [o => OLANE_N_I.get(oLanes(o)[0])],
    products: [o => o.nLines, -1], ordered: [o => o.units, -1], invoiced: [o => o.nInv ? o.invoiced : null, -1], received: [o => o.received || null, -1],
    cost: [o => o.cost, -1], invoices: [o => o.invNos || null],
    dates: [o => (GOT.includes(o.status) ? o.stageAt.received : o.status === "draft" && o.kind === "booking" && o.placeBy ? o.placeBy : o.expected || o.updated) || null, -1],
    attention: [o => listFlags(o).filter(f => f[0] !== "info").length || null, -1],
  };
  const INV_KEYS = {
    no: [v => v.no || null], status: [v => LANES.findIndex(([k]) => k === laneOf(v))], vendor: [v => v.vendor], date: [v => v.date || null, -1],
    po: [v => v.oid ? v.po || "#" + v.oid : null], total: [v => v.total, -1], received: [v => v.recvAt ? 2 : v.billed ? v.got / v.billed : null, -1],
    payment: [v => v.paidOn ? "2" + v.paidOn : "1" + (v.due || "9999")], qb: [v => v.qbo ? 1 : 0],
  };
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
      await loadLanePos("inv");
    } finally { S.invLoading = false; }
  }
  // Status lanes (Brian, Oct 14): every invoice is in exactly one, in this order — lines to check or match first, then
  // no PO yet, then on a PO with products still to come in, then complete (received, or nothing on it to receive).
  // QuickBooks and payment show on the cards and in the table; they don't move an invoice between lanes.
  const LANES = [["issues", "Import issues", "lines to check or match"], ["nopo", "No PO", "waiting for their purchase order"],
    ["receive", "Ready to receive", "on a PO, products still to come in"], ["complete", "Complete", "received"]];
  const laneOf = (v) => v.check > 0 ? "issues" : !v.oid ? "nopo" : !v.recvAt && v.billed > 0 ? "receive" : "complete";
  const LANE_CARDS = 6;
  const INVF = [["all", "All"], ...LANES.map(([k, n]) => [k, n]), ["unpaid", "To pay"], ["noqb", "Not in QuickBooks"]];
  const invMatch = (v, f) => f === "all" ? true : f === "unpaid" ? !v.paidOn : f === "noqb" ? !invClosed(v) : !v.paidOn && laneOf(v) === f;
  const daysAgo = (d) => { const n = Math.floor((Date.now() - new Date(d).getTime()) / 864e5); return n <= 0 ? "today" : n === 1 ? "1 day" : n + " days"; };
  function laneCard(v, k) {
    const po = v.oid ? esc(v.po ? poLabel(v.po) : "PO #" + v.oid) : "";
    const hint = k === "issues" ? `<span class="pill miss">${v.check} line${v.check === 1 ? "" : "s"} to check</span>${po ? ` <span class="dim">${po}</span>` : ' <span class="dim">no PO</span>'}`
      : k === "nopo" ? `<span class="dim">waiting ${esc(daysAgo(v.created || v.date))} · start or pick its PO</span>`
      : k === "receive" ? `${po} · ${v.got > 0 ? `<span class="pill manual">${n0(v.got)} of ${n0(v.billed)} in</span>` : `<span class="dim">${n0(v.billed)} unit${v.billed === 1 ? "" : "s"} to come</span>`}`
      : `${po ? po + " · " : ""}${v.paidOn ? '<span class="pill ok">Paid</span>' : v.due && v.due < today() ? '<span class="pill miss">Overdue</span>' : '<span class="pill warn">Unpaid</span>'} ${v.qbo ? '<span class="pill ok">QB</span>' : ""}`;
    return `<div class="il-card" role="button" tabindex="0" draggable="true" data-ck="${esc(v.id)}" data-inv-open="${esc(v.id)}" title="Open invoice ${esc(v.no || "")} — drag to reorder (or Alt+↑ / Alt+↓)">
      <span class="il-top"><b>${esc(v.vendor || "—")}</b><span class="il-amt">${m(v.total)}</span></span>
      <span class="il-no"><span class="mono">${esc(v.no || "(no number)")}</span>${v.date ? " · " + esc(shortDate(v.date)) : ""}</span>
      <span class="il-hint">${hint}</span></div>`;
  }
  function renderLanes(all) {
    const by = new Map(LANES.map(([k]) => [k, []]));
    for (const v of all) if (!v.paidOn) by.get(laneOf(v)).push(v);   // paid invoices leave the lanes (Brian, Oct 28); the table still has them
    // oldest first where something is waiting on us; newest first once complete
    for (const k of ["issues", "nopo", "receive"]) by.get(k).sort((a, b) => String(a.date || a.created).localeCompare(String(b.date || b.created)));
    $("inv-lanes").innerHTML = LANES.map(([k, n, sub]) => {
      const vs = laneSort("inv", k, by.get(k)), tot = vs.reduce((a, v) => a + (v.total || 0), 0), more = vs.length - LANE_CARDS;
      return `<div class="il-lane il-${k} ${S.invF === k ? "on" : ""}" data-lane-k="${k}">
        <button class="il-head" type="button" data-lane="${k}" aria-pressed="${S.invF === k}" title="Show these in the table below"><b>${n}</b><span class="il-cnt">${n0(vs.length)}</span></button>
        <div class="il-sub">${vs.length ? `${m0(tot)} · ${sub}` : sub}</div>
        <div class="il-cards">${vs.slice(0, LANE_CARDS).map(v => laneCard(v, k)).join("") || '<div class="il-empty">Nothing here</div>'}</div>
        ${more > 0 ? `<button class="linkbtn small il-more" type="button" data-lane="${k}">+ ${n0(more)} more in the table</button>` : ""}
        ${laneCustom("inv", vs) ? `<button class="linkbtn small il-reset" type="button" data-lane-reset="${k}" title="Put this lane back in its usual order">Reset order</button>` : ""}</div>`;
    }).join("");
  }
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
      { l: "Open", v: n0(all.filter(v => !invClosed(v)).length), s: "not in QuickBooks yet — closes once sent" },
      { l: "Not received", v: n0(all.filter(v => !v.recvAt && v.billed > 0).length), s: "invoices with products still to come in" },
    ].map(k => `<div class="kpi"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
    if (S.invs) renderLanes(all); else $("inv-lanes").innerHTML = "";
    const q = S.invQ.trim().toLowerCase().replace(/^#/, "");
    const list = all.filter(v => invMatch(v, S.invF) && (!q || [v.vendor, v.no, v.po, v.terms].join(" ").toLowerCase().includes(q)));
    const t = $("inv-table");
    if (!S.invs) { t.innerHTML = '<tbody><tr><td class="l muted">Loading…</td></tr></tbody>'; return; }
    const LN = new Map(LANES.map(([k, n]) => [k, n])), LP = { issues: "miss", nopo: "pos", receive: "manual", complete: "ok" };
    const th = (k, l, left) => sortTh("inv", INV_KEYS, k, l, left);
    t.innerHTML = `<thead><tr>${th("no", "Invoice", 1)}${th("status", "Status", 1)}${th("vendor", "Vendor", 1)}${th("date", "Date", 1)}${th("po", "Purchase order", 1)}${th("total", "Total")}${th("received", "Received", 1)}${th("payment", "Payment", 1)}${th("qb", "QuickBooks", 1)}</tr></thead><tbody>${
      applySort("inv", INV_KEYS, list).map(v => `<tr class="po-row" data-inv-open="${v.id}" tabindex="0">
        <td class="l"><b class="mono">${esc(v.no || "(no number)")}</b>${invClosed(v) ? " " + closedPill : ""}${v.parts ? ' <span class="pill pos" title="PDF stored">PDF</span>' : ""}${v.check ? ` <span class="pill miss">${v.check} to check</span>` : ""}</td>
        <td class="l small"><span class="pill ${LP[laneOf(v)]}">${LN.get(laneOf(v))}</span></td>
        <td class="l">${esc(v.vendor || "—")}</td>
        <td class="l small">${v.date ? esc(shortDate(v.date)) : '<span class="dim">—</span>'}</td>
        <td class="l small">${v.oid ? `<button class="linkbtn small" data-po-go="${esc(v.oid)}">${esc(v.po ? poLabel(v.po) : "#" + v.oid)}</button> <span class="pill ${PILL[v.ostatus] || "pos"}">${esc(STAGE.get(v.ostatus) || "")}</span>` : '<span class="pill pos" title="Saved on its own — it goes onto its PO when that PO syncs in with the same products">No PO yet</span>'}</td>
        <td>${m(v.total)}</td>
        <td class="l small">${v.recvAt ? '<span class="pill ok">Received</span>' : v.got > 0 ? `<span class="pill manual">${n0(v.got)} of ${n0(v.billed)} in</span>` : v.billed ? '<span class="dim">not yet</span>' : '<span class="dim">—</span>'}</td>
        <td class="l small">${v.paidOn ? `<span class="pill ok">Paid</span> <span class="meta">${esc(shortDate(v.paidOn))}</span>` : v.due && v.due < today() ? `<span class="pill miss">Overdue</span> <span class="meta">due ${esc(shortDate(v.due))}</span>` : `<span class="pill warn">Unpaid</span>${v.due ? ` <span class="meta">due ${esc(shortDate(v.due))}</span>` : ""}`}</td>
        <td class="l small">${v.qbo ? '<span class="pill ok">In QuickBooks</span>' : '<span class="pill pos">Not yet</span>'}</td></tr>`).join("")
      || `<tr><td class="l muted" colspan="9">${all.length ? "No invoices match." : "No invoices yet. Upload a vendor invoice PDF — it's matched to its purchase order by the PO # on it."}</td></tr>`}</tbody>`;
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
    iv.rows.forEach((r, i) => { if (r.vno == null) r.vno = i + 1; });   // the vendor's line order, kept for "Match vendor invoice"
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
        text: "If the rest is coming, mark it backordered (with an ETA if you have one). If the vendor won't send it, close the PO short — it's complete.",
        fixes: [{ label: "Mark them backordered", fix: "pbo" }, { label: "Close short", fix: "oshort" }] });
    }
    const rank = { bad: 0, warn: 1, info: 2 };
    return out.sort((a, b) => rank[a.lvl] - rank[b.lvl]);
  }
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
    if (o.nBack) f.push([o.backEta && o.backEta < today() ? "warn" : "info", `${o.nBack} backordered${o.backEta ? " · ETA " + shortDate(o.backEta) : ""}`]);
    if (o.status === "partial" && !o.nBack) f.push(["info", "rest not backordered"]);
    return f;
  }

  // ---------- rendering: list ----------
  // the address bar follows what's open, so the link can be shared (Brian, Oct 20: "a shareable URL for POs … review
  // the order with Brittany"): #po/41, #invoices/123 (the web version asks to sign in first)
  function syncHash() {
    const iv = S.ed && S.invOpen ? cur(S.ed) : null;
    const want = S.mode === "inv" ? (iv && iv.id && !iv.isNew ? "#invoices/" + iv.id : "#invoices") : S.ed && S.ed.id ? "#po/" + S.ed.id : "#po";
    // only while this page is the one showing (the other pages redraw it in the background)
    const tabEl = $(S.mode === "inv" ? "tab-invoices" : "tab-po"); if (!tabEl || tabEl.hidden) return;
    const title = S.mode === "inv" ? (iv && iv.id && !iv.isNew ? `Invoice ${iv.no || "#" + iv.id} · ${S.ed.vendor || ""}` : "") : S.ed && S.ed.id ? `${S.ed.vendor || "PO"} · ${S.ed.po ? poLabel(S.ed.po) : "#" + S.ed.id}` : "";
    if (window.JTNav) window.JTNav.at(want, title); else if (location.hash !== want) try { history.replaceState(null, "", want); } catch (_) {}
  }
  const APP_URL = "https://dashboard.andersenlifestyle.com/";
  const shareUrl = (h) => (window.JTWeb ? location.origin + location.pathname : APP_URL) + h;
  async function copyLink(h, what) {
    const u = shareUrl(h);
    try { await navigator.clipboard.writeText(u); note("info", `Link to ${esc(what)} copied: <span class="mono">${esc(u)}</span> — anyone with a Seller Sage sign-in can open it.`); }
    catch (_) { note("info", `Link to ${esc(what)}: <input class="inp sm mono" value="${esc(u)}" readonly onclick="this.select()" style="width:360px"> — anyone with a Seller Sage sign-in can open it.`); }
  }
  function render() {
    if (!shown()) return; place(); renderBusy(); syncHash();
    if (S.mode === "inv") { if (S.ed && S.invOpen) renderEditor(); else renderInvList(); return; }
    if (S.ed) renderEditor(); else renderList();
  }
  // the tab's own header (title, PO count, New PO…) only on the list: an open PO is its own page, titled by the PO
  function pageHead(on) {
    const h = document.querySelector("#tab-po > header.top"), st = $("po-status");
    if (h) h.style.display = on ? "" : "none"; if (st) st.style.display = on ? "" : "none";
  }
  function renderBusy() {
    const b = $("po-busy"); if (!b) return; b.hidden = !S.busy; b.textContent = S.busy || "";
    if (S.busy && S.busyRetry) {                     // the reader timed out / failed: try again, or the quick reader
      const go = S.busyRetry;
      const a = document.createElement("button"); a.className = "mini primary"; a.style.marginLeft = "10px"; a.textContent = "Try again";
      a.addEventListener("click", () => go("retry")); b.appendChild(a);
      const k = document.createElement("button"); k.className = "mini"; k.style.marginLeft = "6px"; k.textContent = "Use the quick reader";
      k.addEventListener("click", () => go("quick")); b.appendChild(k);
      return;
    }
    if (S.busy && S.busySkip && window.JTReader) {   // waiting on the template reader: let them use the quick reader now
      const k = document.createElement("button"); k.className = "mini"; k.style.marginLeft = "10px"; k.textContent = "Don't wait — use the quick reader";
      k.addEventListener("click", () => window.JTReader.skip()); b.appendChild(k);
    }
  }
  // ---------- Orders lanes (Brian, Oct 14) ----------
  // (Awaiting submission dropped Oct 16 — Brian: redundant. Approve now marks the order ordered too; an older approved
  // draft shows in Ordered with its Mark ordered button.)
  // Ready to approve → Ordered → Invoiced → Received → Recorded. A draft waits for Approve, then
  // for "Mark ordered" once it's with the vendor; an invoice arriving makes it Invoiced (partly received counts there
  // when it has one); fully received is Received until every invoice is in QuickBooks, then Recorded.
  // Everything is received in Seller Sage (Brian, Oct 21: no more Shopify POs), so Invoiced is one lane again.
  const OLANES = [["approve", "Draft & approve", "drafts being put together, and drafts ready to approve"],
    ["ordered", "Ordered", "with the vendor, not invoiced yet"], ["invoiced", "Invoiced", "invoice in — receive it against the invoice"],
    ["received", "Received", "in — bill not in QuickBooks yet"], ["recorded", "Recorded", "received and in QuickBooks"]];
  const OLANE_N = new Map(OLANES.map(([k, n]) => [k, n])), OLANE_P = { approve: "warn", ordered: "manual", invoiced: "other", received: "ok", recorded: "ok" };
  const invLane = () => "invoiced";
  const laneOfO = (o) => o.status === "draft" ? (o.approvedAt ? "ordered" : "approve") : o.status === "ordered" ? "ordered"
    : o.status === "invoiced" ? invLane(o) : o.status === "partial" ? (o.nInv ? invLane(o) : "ordered")
    : o.nInv > 0 && o.nQB >= o.nInv ? "recorded" : "received";
  // a card is two short lines (vendor · cost / PO · what's next) so ten fit in a lane without scrolling (Brian, Oct 14)
  const OLANE_CARDS = 10;
  // An order can straddle lanes (Brian, Oct 29: "once an order is invoiced it shows up the invoiced lane and then the
  // state is tracked by the invoice state until the invoice is in quickbooks"). Each invoice on it is its own card:
  // Invoiced until it's received, then Received until it's in QuickBooks, then Recorded. What no invoice covers yet stays
  // as the order's card in Ordered. Drafts, and orders with no invoices, are one card as before.
  const ivLane = (iv) => !iv.recv && iv.billed > 0 ? "invoiced" : iv.qb ? "recorded" : "received";
  function oLaneCards(o) {
    if (o.status === "draft" || !o.invs || !o.invs.length) return [{ k: laneOfO(o), ck: "o" + o.id, o, amt: o.cost }];
    const cs = o.invs.map(iv => ({ k: ivLane(iv), ck: "i" + iv.id, o, iv, amt: iv.total || 0 }));
    if (["ordered", "invoiced", "partial"].includes(o.status) && o.restUnits > 0) cs.unshift({ k: "ordered", ck: "o" + o.id, o, rest: true, amt: o.restCost });
    return cs;
  }
  const oLanes = (o) => [...new Set(oLaneCards(o).map(c => c.k))].sort((a, b) => OLANE_N_I.get(a) - OLANE_N_I.get(b));
  const OLANE_N_I = new Map(OLANES.map(([k], i) => [k, i]));
  function cardOf(c) { return c.iv ? ivOCard(c) : oCard(c.o, c.k, c); }
  // one invoice of an order, in the lane its own state puts it
  function ivOCard(c) {
    const o = c.o, iv = c.iv, k = c.k, name = esc(o.po ? poLabel(o.po) : "#" + o.id), nInv = o.invs.length;
    const hint = k === "invoiced" ? (iv.got > 0 ? `<span class="pill manual">${n0(iv.got)}/${n0(iv.billed)} in</span>` : `<span class="dim">${n0(iv.billed)} to come</span>`)
      : k === "received" ? '<span class="pill warn" title="Bill to enter in QuickBooks">for QB</span>'
      : '<span class="pill ok">In QB</span>';
    const bits = [`invoice ${nInv > 1 ? `${o.invs.indexOf(iv) + 1} of ${nInv}` : ""}`.trim(), iv.billed ? `${n0(iv.billed)} units` : "charges only", iv.date ? esc(shortDate(iv.date)) : "", iv.qb && k !== "recorded" ? "in QuickBooks" : ""].filter(Boolean);
    return `<div class="il-card oc ocv" role="button" tabindex="0" draggable="true" data-ck="${esc(c.ck)}" data-po-open="${esc(o.id)}" data-po-inv="${esc(iv.id)}" title="Open ${esc(o.vendor || "")} ${name} at invoice ${esc(iv.no)} — drag to reorder (or Alt+↑ / Alt+↓)">
      <span class="il-top"><span class="oc-v"><b>${esc(o.vendor || "—")}</b><button class="oc-inv" type="button" data-inv-open="${esc(iv.id)}" title="Open invoice ${esc(iv.no)}">Inv ${esc(String(iv.no).replace(/^#/, "").slice(-6))} →</button></span><span class="il-amt">${iv.total == null ? '<span class="dim">—</span>' : m0(iv.total)}</span></span>
      <span class="oc-2"><span class="mono oc-name">${name}</span><span class="oc-h">${hint}</span></span>
      <span class="oc-3">${bits.join(" · ")}</span></div>`;
  }
  // the extra line on a bigger card (Brian, Oct 29: "make the cards a little larger so we can see more of the details")
  function ocDetail(o, k) {
    const bits = [];
    if (o.nLines) bits.push(`${n0(o.nLines)} product${o.nLines === 1 ? "" : "s"}`);
    if (o.units) bits.push(`${n0(o.units)} units`);
    if (o.received > 0 && o.received < o.units) bits.push(`${n0(o.received)} in`);
    if (o.invs && o.invs.length) bits.push(`${o.invs.length} invoice${o.invs.length === 1 ? "" : "s"}`);
    if (o.expected && k !== "ordered") bits.push("exp " + esc(shortDate(o.expected)));
    if (o.category && o.nLines) bits.push(esc(o.category));
    return bits.join(" · ");
  }
  function oCard(o, k, c) {
    const name = esc(o.po ? poLabel(o.po) : "#" + o.id), left = Math.max(0, o.units - o.received), rest = !!(c && c.rest);
    const hint = rest ? `<span class="dim">${n0(o.restUnits)} not invoiced</span>`
      : k === "approve" && !o.readyAt ? '<span class="pill pos" title="Still being put together — open it and press Ready to approve">Draft</span>'
      : k === "approve" ? `<span class="pill warn" title="Marked ready ${esc(when(o.readyAt))}">Ready</span> <button class="mini primary" type="button" data-po-approve="${esc(o.id)}" title="${n0(o.nLines)} products · ${n0(o.units)} units">Approve</button>`
      : k === "ordered" && o.status === "draft" ? `<button class="mini" type="button" data-po-mark="${esc(o.id)}" title="Approved ${esc(when(o.approvedAt))}${o.approvedBy ? " by " + esc(o.approvedBy.split("@")[0]) : ""} — mark it once it's with the vendor">Mark ordered</button>`
      : k === "ordered" && !o.nLines && !o.missingInv ? `<span class="pill other" title="Placeholder — fills out from the invoices put on it${planGaps(o).length ? "; " + planGaps(o).join(", ") : ""}">${o.category ? esc(o.category) : "placeholder"}</span>${planGaps(o).length ? ` <span class="pill warn" title="${esc(planGaps(o).join(", "))}">!</span>` : ""}`
      : k === "ordered" ? `<span class="dim">${o.expected ? "exp " + esc(shortDate(o.expected)) : n0(o.units) + " units"}</span>`
      : k === "invoiced" ? (o.received > 0 ? `<span class="pill manual">${n0(o.received)}/${n0(o.units)} in</span>` : `<span class="dim">${n0(left)} to come</span>`)
      : k === "received" ? (o.nInv ? `<span class="pill warn" title="Bills to enter in QuickBooks">${o.nInv - o.nQB} for QB</span>` : '<span class="pill pos">no invoice</span>')
      : `<span class="dim">${esc(when(o.stageAt.received || o.updated))}</span>`;
    // the invoice, one click away (Brian, Oct 14): the next one that needs something — to receive, then to enter in QuickBooks
    const iv = !rest && ["invoiced", "received", "recorded"].includes(k) && o.invs && o.invs.length
      ? (k === "invoiced" ? o.invs.find(v => !v.recv) : k === "received" ? o.invs.find(v => !v.qb) : null) || o.invs[o.invs.length - 1] : null;
    const miss = o.missingInv ? '<span class="pill warn" title="Goods came in with no invoice in the system — it clears when an invoice is put on this order">missing invoice</span> ' : "";
    const ivChip = iv ? `<button class="oc-inv" type="button" data-inv-open="${esc(iv.id)}" title="Open invoice ${esc(iv.no)}${o.invs.length > 1 ? ` (${o.invs.length} invoices on this order)` : ""}">${o.invs.length > 1 ? `${o.invs.length} inv` : "Inv"} ${esc(String(iv.no).replace(/^#/, "").slice(-6))} →</button>` : "";
    const amt = rest ? `<span class="il-amt" title="The part not on an invoice yet, at cost (whole order ${m0(o.cost)})">${m0(o.restCost)}</span>`
      : `<span class="il-amt" ${o.budget != null ? `title="Budget ${m0(o.budget)}${o.cost ? ` · ordered ${m0(o.cost)}` : ""}"` : ""}>${!o.cost && o.budget != null ? `<span class="dim">budget</span> ${m0(o.budget)}` : m0(o.cost)}</span>`;
    const detail = rest ? [`rest of the order · ${o.invs.length} invoice${o.invs.length === 1 ? "" : "s"} in`, o.nBack ? `${n0(o.nBack)} backordered` : "", o.expected ? "exp " + esc(shortDate(o.expected)) : ""].filter(Boolean).join(" · ") : ocDetail(o, k);
    return `<div class="il-card oc ${rest ? "ocr" : ""}" role="button" tabindex="0" draggable="true" data-ck="o${esc(o.id)}" data-po-open="${esc(o.id)}" ${rest ? 'data-po-view="notinv"' : ""} title="Open ${esc(o.vendor || "")} ${name}${rest ? " at what's not invoiced yet" : ""} — drag to reorder (or Alt+↑ / Alt+↓)">
      <span class="il-top"><span class="oc-v"><b>${esc(o.vendor || "—")}</b>${ivChip}</span>${amt}</span>
      <span class="oc-2"><span class="mono oc-name">${name}</span><span class="oc-h">${miss}${hint}</span></span>
      <span class="oc-3">${detail}</span></div>`;
  }
  function renderOLanes(all) {
    const by = new Map(OLANES.map(([k]) => [k, []]));
    for (const o of all) for (const c of oLaneCards(o)) by.get(c.k).push({ ...c, id: c.ck });
    const at = (c) => String(c.iv ? c.iv.date || c.o.created : c.o.created);
    for (const k of ["approve", "ordered", "invoiced"]) by.get(k).sort((a, b) => at(a).localeCompare(at(b)));   // oldest waiting first
    by.get("approve").sort((a, b) => !!b.o.readyAt - !!a.o.readyAt);   // ready to approve above drafts
    for (const k of ["received", "recorded"]) by.get(k).sort((a, b) => at(b).localeCompare(at(a)));
    $("po-lanes").innerHTML = OLANES.map(([k, n, sub]) => {
      const os = laneSort("po", k, by.get(k)), tot = os.reduce((a, c) => a + (c.amt || 0), 0), more = os.length - OLANE_CARDS;
      return `<div class="il-lane ol-${k} ${S.stage === k ? "on" : ""}" data-lane-k="${k}">
        <div class="ol-headrow"><button class="il-head" type="button" data-olane="${k}" aria-pressed="${S.stage === k}" title="${esc(sub)} — show these in the table below"><b>${n}</b><span class="il-cnt">${n0(os.length)}</span></button>${k === "approve" ? '<button class="ol-add" type="button" data-po-start title="Start a new, blank order" aria-label="Start an order">+</button>' : ""}</div>
        <div class="ol-sum" title="Total of the ${n0(os.length)} card${os.length === 1 ? "" : "s"} here (orders at cost, invoices at their total)">${m0(tot)}</div>
        ${k === "approve" && os.length ? `<div class="ol-split small">${(() => { const r = os.filter(c => c.o.readyAt).length; return `<b>${n0(r)}</b> ready to approve · ${n0(os.length - r)} draft${os.length - r === 1 ? "" : "s"}`; })()}</div>` : ""}
        <div class="il-cards">${os.slice(0, OLANE_CARDS).map(cardOf).join("") || (k === "approve" ? '<button class="il-empty ol-start" type="button" data-po-start>+ Start an order</button>' : '<div class="il-empty">Nothing here</div>')}</div>
        ${more > 0 ? `<button class="linkbtn small il-more" type="button" data-olane="${k}">+ ${n0(more)} more in the table</button>` : ""}
        ${laneCustom("po", os) ? `<button class="linkbtn small il-reset" type="button" data-lane-reset="${k}" title="Put this lane back in its usual order">Reset order</button>` : ""}</div>`;
    }).join("");
  }
  // Stats over the lanes (Brian, Oct 29: "something about orders on the way, backordered products, etc"). Each one
  // filters the table when it maps to a set of orders.
  // the tiles that filter the table to orders that aren't a lane (Oct 29: "the backordered card should be clickable")
  const kWeek = () => new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const KPI_ST = {
    back: ["Backordered", o => o.nBack > 0 && o.status !== "complete"],
    due: ["Due this week / late", o => ["ordered", "invoiced", "partial"].includes(o.status) && !!o.expected && (o.expected <= kWeek()) && (o.expected >= today() || o.status !== "partial")],
    unpaid: ["Bills to pay", o => o.nUnpaid > 0],
  };
  function poKpis(all) {
    const t = today(), wk = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const out = all.filter(o => ["ordered", "invoiced", "partial"].includes(o.status));
    const toCome = out.reduce((a, o) => a + o.cost * (o.units ? Math.max(0, o.units - o.received) / o.units : 1), 0);
    const units = out.reduce((a, o) => a + Math.max(0, o.units - o.received), 0);
    const late = out.filter(o => o.status !== "partial" && o.expected && o.expected < t), soon = out.filter(o => o.expected && o.expected >= t && o.expected <= wk);
    const notInv = out.filter(o => o.restUnits > 0), notInvAmt = notInv.reduce((a, o) => a + o.restCost, 0);
    const back = all.filter(o => o.nBack > 0 && o.status !== "complete"), nBack = back.reduce((a, o) => a + o.nBack, 0);
    const etas = back.map(o => o.backEta).filter(Boolean).sort(), pastEta = back.filter(o => o.backEta && o.backEta < t).length, nextEta = etas.find(d => d >= t);
    const unpaid = all.filter(o => o.nUnpaid > 0), owed = unpaid.reduce((a, o) => a + o.unpaidAmt, 0), overdue = unpaid.filter(o => o.unpaidDue && o.unpaidDue < t);
    const k = (l, v, sub, cls, go) => `<div class="kpi ${cls || ""}">${go ? `<button class="kpi-go" type="button" data-st-go="${go}" title="Show these in the table">` : ""}<span class="eyebrow">${l}</span><span class="v">${v}</span><span class="s">${sub}</span>${go ? "</button>" : ""}</div>`;
    return [
      k("On the way", m0(toCome), `${n0(units)} units · ${n0(out.length)} order${out.length === 1 ? "" : "s"}`, "", "open"),
      k("Due this week", n0(soon.length), `${soon.length ? m0(soon.reduce((a, o) => a + o.cost, 0)) + " expected" : "nothing expected"}${late.length ? ` · <b class="neg">${n0(late.length)} late</b>` : ""}`, late.length ? "warnk" : "", soon.length || late.length ? "due" : ""),
      k("Not invoiced yet", m0(notInvAmt), `${n0(notInv.reduce((a, o) => a + o.restUnits, 0))} units on ${n0(notInv.length)} order${notInv.length === 1 ? "" : "s"}`, "", "ordered"),
      k("Backordered", n0(nBack), nBack ? `product${nBack === 1 ? "" : "s"} on ${n0(back.length)} order${back.length === 1 ? "" : "s"}${nextEta ? " · next ETA " + esc(shortDate(nextEta)) : ""}${pastEta ? ` · <b class="neg">${n0(pastEta)} past ETA</b>` : ""}` : "nothing backordered", pastEta ? "warnk" : "", nBack ? "back" : ""),
      k("Bills to pay", m0(owed), unpaid.length ? `${n0(unpaid.length)} order${unpaid.length === 1 ? "" : "s"}${overdue.length ? ` · <b class="neg">${n0(overdue.length)} overdue</b>` : " · none overdue"}` : "all paid", "", unpaid.length ? "unpaid" : ""),
    ].join("");
  }
  // a lane card opens its PO at that invoice, or at what isn't invoiced yet
  async function openCard(el) {
    const inv = el.dataset.poInv, view = el.dataset.poView;
    await openPO(el.dataset.poOpen);
    if (!S.ed || (!inv && !view)) return;
    if (inv) { const i = S.ed.invoices.findIndex(v => v.id === String(inv)); if (i >= 0) { S.ed.cur = i; S.ed.view = "inv"; } }
    else S.ed.view = view;
    render();
  }
  async function approveOrder(id, yes) {
    S.busy = yes === false ? "Saving…" : "Approving…"; render();
    try { await JT.po.approve(id, yes); if (yes !== false) await JT.prep.setOrderStatus(Number(id), "ordered"); S.busy = ""; await loadOrders(true); if (S.ed && S.ed.id === String(id)) await openPO(id); else render();
      const o = (S.orders || []).find(x => x.id === String(id));
      note("info", yes === false ? `${esc(o ? o.vendor + " " + (o.po ? poLabel(o.po) : "#" + id) : "Order")} is back in Draft &amp; approve.` : `${esc(o ? o.vendor + " " + (o.po ? poLabel(o.po) : "#" + id) : "Order")} approved and marked ordered.`); }
    catch (e) { S.busy = ""; render(); note("bad", "Couldn't approve: " + esc(JT.message(e))); }
  }
  async function markOrdered(id) {
    S.busy = "Saving…"; render();
    try { await JT.prep.setOrderStatus(Number(id), "ordered"); S.busy = ""; await loadOrders(true); render(); const o = (S.orders || []).find(x => x.id === String(id)); note("info", `${esc(o ? o.vendor + " " + (o.po ? poLabel(o.po) : "#" + id) : "Order")} marked ordered.`); }
    catch (e) { S.busy = ""; render(); note("bad", "Couldn't mark it ordered: " + esc(JT.message(e))); }
  }
  function renderList() {
    if (S.mode !== "po" || $("tab-po").hidden) return;
    $("po-list-view").hidden = !!S.ed; $("po-edit-view").hidden = !S.ed;
    if (S.ed) return;
    pageHead(true);
    const all = S.orders || [];
    const isOpen = (o) => o.status !== "complete";
    const isLane = (st) => OLANE_N.has(st);
    const inStage = (o, st) => st === "open" ? isOpen(o) : st === "all" ? true : isLane(st) ? oLanes(o).includes(st) : KPI_ST[st] ? KPI_ST[st][1](o) : o.status === st;
    const q = S.q.trim().toLowerCase().replace(/^#/, "");
    const cnt = (st) => all.filter(o => inStage(o, st)).length;
    if (S.orders) renderOLanes(all); else $("po-lanes").innerHTML = "";
    renderStart();
    $("po-stage").innerHTML = [["open", "Open"], ...OLANES.map(([k, n]) => [k, n]), ["all", "All"], ...(KPI_ST[S.stage] ? [[S.stage, KPI_ST[S.stage][0]]] : [])].map(([k, n]) => `<button data-st="${k}" aria-pressed="${S.stage === k}">${n} <span class="cnt">${cnt(k)}</span></button>`).join("");
    const vs = [...new Set(all.map(o => o.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const vsel = $("po-vendor"); const want = ["all", ...vs].join("|");
    if (vsel.dataset.opts !== want) { vsel.innerHTML = `<option value="all">All vendors</option>` + vs.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(""); vsel.dataset.opts = want; vsel.value = vs.includes(S.vendor) ? S.vendor : "all"; }
    const open = all.filter(isOpen), out = all.filter(o => ["ordered", "invoiced", "partial"].includes(o.status));
    const flagged = open.filter(o => listFlags(o).some(f => f[0] !== "info"));
    const toCome = out.reduce((a, o) => a + o.cost * (o.units ? Math.max(0, o.units - o.received) / o.units : 1), 0), nBack = all.reduce((a, o) => a + o.nBack, 0);
    if (S.orders) $("po-status").innerHTML = `${n0(open.length)} open${flagged.length ? ` · <button class="linkbtn" type="button" data-st-go="open" title="Late, unmatched lines, guesses, no invoice">${n0(flagged.length)} need attention</button>` : ""}`;
    const list = all.filter(o => inStage(o, S.stage) && (S.vendor === "all" || o.vendor === S.vendor)
      && (!q || [o.vendor, o.po, o.invNos, o.note, o.text].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => S.stage === "open" ? ORDER.indexOf(b.status) - ORDER.indexOf(a.status) || String(b.updated).localeCompare(String(a.updated)) : String(b.updated).localeCompare(String(a.updated)));
    const sorted = applySort("po", PO_KEYS, list), th = (k, l, left) => sortTh("po", PO_KEYS, k, l, left);
    $("po-kpis").innerHTML = S.orders ? poKpis(all) : "";
    const t = $("po-table");
    if (!S.orders) { t.innerHTML = `<tbody><tr><td class="l muted">${S.loading ? "Loading…" : ""}</td></tr></tbody>`; return; }
    t.innerHTML = `<thead><tr>${th("po", "PO", 1)}${th("vendor", "Vendor", 1)}${th("status", "Status", 1)}${th("products", "Products")}${th("ordered", "Ordered")}${th("invoiced", "Invoiced")}${th("received", "Received")}${th("cost", "Cost")}${th("invoices", "Invoices", 1)}${th("dates", "Dates", 1)}${th("attention", "Needs attention", 1)}</tr></thead><tbody>${
      sorted.map(o => {
        const fl = listFlags(o), got = GOT.includes(o.status);
        const dates = o.status === "draft" && o.kind === "booking" && o.placeBy ? `place by ${shortDate(o.placeBy)}` : got ? `received ${when(o.stageAt.received)}` : o.expected ? `expected ${shortDate(o.expected)}` : `updated ${when(o.updated)}`;
        return `<tr class="po-row" data-po-open="${o.id}" tabindex="0"><td class="l"><b class="mono">${esc(o.po ? poLabel(o.po) : "#" + o.id)}</b>${o.kind === "booking" ? ' <span class="pill warn">Booking</span>' : ""}</td>
          <td class="l">${esc(o.vendor || "—")}</td>
          <td class="l">${oLanes(o).map(k => `<span class="pill ${OLANE_P[k]}" title="${esc(STAGE.get(o.status))}">${k === "approve" ? (o.readyAt ? "Ready to approve" : "Draft") : OLANE_N.get(k)}</span>`).join("")}</td>
          <td>${n0(o.nLines)}<div class="meta">${!o.units ? esc({ shopify: "→ Shopify", prep: "→ Prep", both: "→ Both" }[o.into] || "") : o.prepUnits === 0 ? "→ Shopify" : o.prepUnits >= o.units ? "→ Prep" : `→ Both`}</div></td><td>${n0(o.units)}${o.units && o.prepUnits > 0 && o.prepUnits < o.units ? `<div class="meta">${n0(o.units - o.prepUnits)} Shopify · ${n0(o.prepUnits)} prep</div>` : ""}</td><td>${o.nInv ? n0(o.invoiced) : '<span class="dim">—</span>'}</td><td>${o.received ? n0(o.received) : '<span class="dim">—</span>'}</td><td>${m0(o.cost)}</td>
          <td class="l small">${o.nInv ? `<span class="mono">${esc(o.invNos || "invoice")}</span>${o.nInv > 1 ? ` <span class="pill manual">${o.nInv} invoices</span>` : ""}${o.nFiles ? ' <span class="pill pos" title="PDF attached">PDF</span>' : ""}${o.invTotal != null ? `<div class="meta">${m(o.invTotal)}</div>` : ""}` : '<span class="dim">—</span>'}</td>
          <td class="l small">${dates}</td>
          <td class="l">${fl.map(f => `<span class="pill ${f[0] === "info" ? "pos" : "miss"}">${esc(f[1])}</span>`).join("")}</td></tr>`;
      }).join("") || `<tr><td class="l muted" colspan="11">${S.stage === "open" && !q ? "No open orders. Start one with New PO, then add the vendor's invoices to it." : "No orders match."}</td></tr>`}</tbody>`;
  }

  // ---------- rendering: editor ----------
  function renderEditor() {
    const ed = S.ed; if (!ed) return;
    if (S.mode === "inv") return renderInvoicePage();
    $("po-list-view").hidden = true; $("po-edit-view").hidden = false;
    pageHead(false);
    const box = $("po-edit-view");
    const keep = document.activeElement && box.contains(document.activeElement) ? { id: document.activeElement.id, k: document.activeElement.dataset.k, f: document.activeElement.dataset.f, s: document.activeElement.selectionStart } : null;
    const ro = false, got = GOT.includes(ed.status);      // a complete PO stays editable (receive more, un-receive, invoices)
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
    // what isn't on an invoice yet (invoiced products are received on their invoice)
    const onTop = (l) => { const p = pr.get(l.id); return !anyInv || p.open > 0 || (p.invoiced === 0 && p.received === 0); };
    const topLines = ed.lines.filter(onTop);
    // which view of the PO: the entire PO, one invoice, what isn't invoiced, or (once every invoice is received) what's
    // still to come. Receiving without an invoice works on the entire PO, or on what isn't invoiced.
    const vw = poViews(ed, pr);
    if (!ed.view || !vw.ok(ed.view)) ed.view = S.lastView && String(S.lastView.id) === String(ed.id) && vw.ok(S.lastView.view) ? S.lastView.view : vw.def;
    if (ed.recv && ed.view !== "all" && ed.view !== "notinv") ed.view = anyInv ? "notinv" : "all";
    if (ed.id) S.lastView = { id: ed.id, view: ed.view };
    const mode = ed.view === "inv" ? "inv" : ed.view;
    const NC = 9 + (mode === "all" && anyInv ? 1 : 0) + (ed.recv ? 1 : 0), NCI = 8;
    const ivNow = mode === "inv" ? cur(ed) : null, ivSh = ivNow && ivNow.id && !ivNow.isNew ? invShares(ed, ivNow) : new Map();
    const canRecv = !!ed.id && !ro && true;
    // a product split across the Shopify store and the prep center: its total on every part
    const splitTot = (l) => { const parts = ed.lines.filter(x => x.vid === l.vid); if (parts.length < 2) return "";
      const q = (x) => Number(x.qty) || 0, sum = parts.reduce((a, x) => a + q(x), 0), tot = ed.splitTot && ed.splitTot[l.vid] != null ? ed.splitTot[l.vid] : sum;
      const rec = parts.reduce((a, x) => a + (x.received || 0), 0), sh = parts.filter(x => x.dest === "shopify").reduce((a, x) => a + q(x), 0), pp = sum - sh;
      return `<div class="splittot"><span class="pill manual">Split</span> <b class="num">${n0(tot)}</b> total · ${n0(sh)} Shopify + ${n0(pp)} prep${rec ? ` · ${n0(rec)} received` : ""}${sum !== tot ? ` <span class="neg">· parts add to ${n0(sum)}</span>` : ""}</div>`; };
    const canSplit = (l) => !ro && !ed.recv && ed.lines.filter(x => x.vid === l.vid).reduce((a, x) => a + (Number(x.qty) || 0), 0) > 1;
    const canUnrecv = (l) => l.received > 0 && ed.id && !ed.recv && true;
    const destSel = (l) => {
      const canPick = !ro && !(l.received > 0) && (!ed.recv || PRE.includes(ed.status) || true);
      if (!canPick) return l.dest === "shopify" ? '<span class="pill pos">Shopify store</span>' : l.dest === "demo" ? '<span class="pill other" title="Demo units: received, not added to inventory">Not for resale</span>' : `<span class="pill web">Prep center</span>${l.asku ? `<div class="meta mono">${esc(lbl((S.listings.get(l.vid) || []).find(x => x.sku === l.asku) || { sku: l.asku }))}</div>` : '<div class="meta">any ASIN</div>'}`;
      const ls = (S.listings.get(l.vid) || []).slice().sort((a, b) => a.units - b.units || String(a.asin).localeCompare(String(b.asin)));
      const val = l.dest === "shopify" ? "@shopify" : l.dest === "demo" ? "@demo" : l.asku || "";
      if (both) return `<span class="seg sm dseg" role="group" aria-label="Where it goes"><button data-pdest="shopify" data-k="${l.id}" aria-pressed="${l.dest === "shopify"}">Shopify</button><button data-pdest="prep" data-k="${l.id}" aria-pressed="${l.dest === "prep"}">Prep</button><button data-pdest="demo" data-k="${l.id}" aria-pressed="${l.dest === "demo"}" title="Not for resale (demo units): received, never added to inventory">Demo</button></span>`
        + (l.dest === "prep" ? `<select class="inp sm" data-f="dest" data-k="${l.id}" style="width:auto;max-width:150px;margin-top:4px" aria-label="ASIN"><option value="" ${val === "" ? "selected" : ""}>any ASIN (assign later)</option>${ls.map(x => `<option value="${esc(x.sku)}" ${val === x.sku ? "selected" : ""} title="${esc(x.title || "")}">${esc(lbl(x))}</option>`).join("")}${l.asku && !ls.some(x => x.sku === l.asku) ? `<option selected value="${esc(l.asku)}">${esc(l.asku)}</option>` : ""}</select>` : "");
      return `<select class="inp sm" data-f="dest" data-k="${l.id}" style="width:auto;max-width:150px"><option value="@shopify" ${val === "@shopify" ? "selected" : ""}>Shopify store</option><option value="@demo" ${l.dest === "demo" ? "selected" : ""}>Not for resale (demo)</option><option value="" ${val === "" ? "selected" : ""}>Prep center · any ASIN (assign later)</option>${ls.map(x => `<option value="${esc(x.sku)}" ${val === x.sku ? "selected" : ""} title="${esc(x.title || "")}">Prep · ${esc(lbl(x))}</option>`).join("")}${l.asku && !ls.some(x => x.sku === l.asku) ? `<option selected value="${esc(l.asku)}">Prep · ${esc(l.asku)}</option>` : ""}</select>`;
    };
    const costInp = (l, v, chg, mode) => `${!ro && !ed.recv ? `<input class="inp num sm ${l.cost !== "" && !(Number(l.cost) >= 0) ? "bad" : ""}" data-f="cost" data-k="${l.id}" value="${esc(l.cost)}" inputmode="decimal" placeholder="${v && v.cost != null ? v.cost.toFixed(2) : "cost"}" style="width:76px">` : m(l.cost === "" ? v && v.cost : Number(l.cost))}`;
    const prodCell = (l, v) => `<td class="l">${v ? `<a class="olink" href="${ADMIN}/products/${esc(v.pid)}/variants/${esc(v.vid)}" target="_blank" rel="noopener">${esc(v.title)}</a><div class="meta"><span class="mono">${esc(v.sku) || "no SKU"}</span>${v.vendor ? " · " + esc(v.vendor) : ""}${l.auto ? ' <span class="pill manual" title="On an invoice but not on the PO when it was placed">added from invoice</span>' : ""}</div>${splitTot(l)}` : `<span class="dim">variant ${esc(l.vid)} (not in the catalog)</span>`}</td>`;
    const forCell = (l) => `<td class="l small"><div class="forcell">${destSel(l)}${canSplit(l) ? `<button class="linkbtn small" data-pact="split" data-k="${l.id}" title="Split between the Shopify store and one or more prep-center ASINs">Split</button>` : ""}</div></td>`;
    const unitOf = (l, v) => l.cost === "" ? (v && v.cost) || 0 : Number(l.cost) || 0;
    // the PO's products, in one of three views: "all" (the entire PO), "notinv" (what isn't on an invoice yet) and
    // "left" (what's still to be received, once every invoice is in)
    const leftOf = (l) => { const p = pr.get(l.id); return Math.max(0, p.ordered - p.received); };
    const fq = (ed.find || "").trim().toLowerCase();
    const findOk = (l) => { if (!fq) return true; const v = variant(l.vid) || {}; return [v.title, v.sku, v.barcode, l.asku].join(" ").toLowerCase().includes(fq); };
    const lineRow = (l, mode) => {
      const v = variant(l.vid), p = pr.get(l.id), badQ = l.qty !== "" && !(Number.isInteger(Number(l.qty)) && Number(l.qty) >= 0);
      const chg = v && v.cost > 0 && l.cost !== "" && !isNaN(Number(l.cost)) ? (Number(l.cost) - v.cost) / v.cost : null;
      const extra = (ed.split && ed.split.id === l.id ? splitRow(l, NC) : "") + (ed.unrecv && ed.unrecv.id === l.id ? unrecvRow(l, NC) : "");
      const recvCell = `<td>${p.received ? n0(p.received) : '<span class="dim">—</span>'}${canUnrecv(l) ? `<div><button class="linkbtn small" data-pact="unrecv1" data-k="${l.id}" title="Take some or all of these back off the received count">un-receive</button></div>` : ""}</td>`;
      const still = mode === "notinv" ? p.open : mode === "left" ? leftOf(l) : 0;
      const boCell = (open) => `<td class="l small">${open > 0 && !ro ? `<label class="inline bo"><input type="checkbox" data-f="bo" data-k="${l.id}" ${l.backorder ? "checked" : ""}> backordered</label>${l.backorder ? `<input class="inp sm" type="date" data-f="eta" data-k="${l.id}" value="${esc(l.eta)}" aria-label="Expected arrival" style="width:auto">` : ""}` : l.eta && open > 0 ? shortDate(l.eta) : mode === "all" ? `<span class="pill ${p.st[1]}">${esc(p.st[0])}</span>` : '<span class="dim">—</span>'}</td>`;
      const canDrag = !ro && !ed.recv && ed.lines.length > 1;
      const handle = canDrag ? `<button type="button" class="dragh" id="drag-${l.id}" draggable="true" data-drag="${l.id}" aria-label="Move ${esc(v ? v.title : "this line")}: drag it, or Alt+Up / Alt+Down" title="Drag to reorder (or Alt+↑ / Alt+↓)"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></button>` : "";
      return `<tr data-line="${l.id}" class="${canDrag ? "dragrow" : ""}">${handle ? prodCell(l, v).replace('<td class="l">', '<td class="l"><div class="dragcell">' + handle + '<div>').replace(/<\/td>$/, "</div></div></td>") : prodCell(l, v)}${forCell(l)}
        <td>${!ro && !ed.recv ? `<input class="inp num sm ${badQ || p.ordered < p.received ? "bad" : ""}" data-f="qty" data-k="${l.id}" value="${esc(l.qty)}" inputmode="numeric" placeholder="0" style="width:64px">` : n0(p.ordered)}</td>
        ${mode === "notinv" ? `<td>${p.invoiced ? n0(p.invoiced) : '<span class="dim">—</span>'}</td><td><b class="num">${n0(p.open)}</b></td>`
          : mode === "left" ? `${recvCell}<td><b class="num">${n0(still)}</b></td>`
          : `${anyInv ? `<td>${p.invoiced ? n0(p.invoiced) : '<span class="dim">—</span>'}</td>` : ""}${recvCell}`}
        ${ed.recv ? `<td><input class="inp num sm" data-f="recv" data-k="${l.id}" value="${esc(ed.recv[keyOf(l)] ?? "")}" inputmode="numeric" placeholder="0" style="width:64px"></td>` : ""}
        ${boCell(mode === "all" ? p.open : still)}
        <td>${costInp(l, v, chg, "po")}</td>
        <td>${m(mode === "all" ? lineAmt(l) : still * unitOf(l, v))}</td>
        <td class="nowrap">${!ro && !ed.recv && !(l.received > 0) && !p.invoiced ? `<button class="linkbtn small" data-pact="rmline" data-k="${l.id}" title="Take off the PO" aria-label="Remove line">✕</button>` : ""}</td></tr>${extra}`;
    };
    // one invoice's products: receive them here, once Receive is pressed for this invoice
    const recvOn = !!(ivNow && ivNow.id && ed.recvInv === ivNow.id);
    const invRow = (l) => {
      const v = variant(l.vid), sh = ivSh.get(l.id);
      const chg = v && v.cost > 0 && l.cost !== "" && !isNaN(Number(l.cost)) ? (Number(l.cost) - v.cost) / v.cost : null;
      let rq = sh.left > 0 ? '' : '<span class="pill ok">All in</span>';
      if (sh.left > 0 && canRecv && recvOn) { const val = rqVal(ed, ivNow, l, sh), bad = val !== "" && !(Number.isInteger(Number(val)) && Number(val) >= 0);
        rq = `<div class="rq"><input class="inp num sm ${bad ? "bad" : ""}" data-f="rq" data-k="${l.id}" value="${esc(val)}" inputmode="numeric" placeholder="0" style="width:60px" aria-label="Quantity arrived"><button class="mini primary" data-pact="rq-go" data-k="${l.id}" title="Receive just this product now">Receive</button></div>${val !== String(sh.left) ? `<div class="meta warnt">invoice: ${n0(sh.left)}</div>` : ""}`; }
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
    const viewLines = (mode === "notinv" ? topLines : mode === "left" ? ed.lines.filter(l => leftOf(l) > 0) : ed.lines)
      .filter(l => !ed.recv || leftOf(l) > 0)   // receiving: only what isn't received yet
      .filter(findOk);
    const unitsOf = (l) => mode === "notinv" ? pr.get(l.id).open : mode === "left" ? leftOf(l) : Number(l.qty) || 0;
    const amtOf = (l) => mode === "all" ? lineAmt(l) : unitsOf(l) * unitOf(l, variant(l.vid));
    const bucket = (d) => {
      const ls = viewLines.filter(l => l.dest === d), u = ls.reduce((a, l) => a + unitsOf(l), 0), c = ls.reduce((a, l) => a + amtOf(l), 0);
      return `<tr class="bucket ${d}"><td colspan="${NC}" class="l"><b>→ ${DESTN[d]}</b><span class="muted small"> · ${ls.length} product${ls.length === 1 ? "" : "s"} · ${n0(u)} units${mode === "notinv" ? " not invoiced" : mode === "left" ? " still to come" : ""} · ${m(c)}</span></td></tr>`
        + (ls.map(l => lineRow(l, mode)).join("") || `<tr><td colspan="${NC}" class="l muted small">${mode === "notinv" ? "Nothing here left to invoice." : mode === "left" ? "Nothing here still to come." : "Nothing going here yet — switch products here in the first column, or Split one."}</td></tr>`);
    };
    const lineRows = mode === "inv" ? "" : both ? bucket("shopify") + bucket("prep") + (ed.lines.some(l => l.dest === "demo") ? bucket("demo") : "") : viewLines.map(l => lineRow(l, mode)).join("");
    // the current invoice's receiving table, shown in the invoice area
    const recvHtml = (() => {
      if (!ivNow) return "";
      if (!ivNow.id || ivNow.isNew) return '<div class="note info">Save to start receiving against this invoice.</div>';
      // in the invoice's own line order, so the table reads like the paper invoice
      const ivPos = new Map(); ivNow.rows.forEach((r, i) => { if (r.vid && !ivPos.has(String(r.vid))) ivPos.set(String(r.vid), i); });
      const all = ed.lines.filter(l => ivSh.has(l.id)).map((l, i) => [l, i]).sort((a, b) => ((ivPos.get(String(a[0].vid)) ?? 1e6) - (ivPos.get(String(b[0].vid)) ?? 1e6)) || a[1] - b[1]).map(x => x[0]), c = count(ivNow), t = invTot(ivNow);
      const anyLeft = all.some(l => ivSh.get(l.id).left > 0);
      // while receiving, only the products still to come on this invoice
      const ls = (recvOn && canRecv && anyLeft ? all.filter(l => ivSh.get(l.id).left > 0) : all).filter(findOk);
      const back = ed.lines.filter(l => l.backorder && pr.get(l.id).open > 0).length;
      const left = ls.reduce((a, l) => { const x = Number(rqVal(ed, ivNow, l, ivSh.get(l.id))); return a + (ivSh.get(l.id).left > 0 && Number.isInteger(x) && x > 0 ? x : 0); }, 0);
      const btn = ivNow.recvAt ? (ivNow.recvManual && !ro ? '<button class="mini" data-pact="inv-reopen" title="Take the received mark off this invoice">Reopen</button>' : "")
        : !ro && t.g > 0 ? '<button class="mini" data-pact="inv-recvd" title="Count this invoice as received in full, e.g. the vendor shipped less than they billed">Mark received</button>' : "";
      return `<div class="po-recv ${ivNow.recvAt ? "done" : ""}">
        ${c.check ? `<div class="note warn">${c.check} guessed product${c.check === 1 ? "" : "s"} on this invoice ${c.check === 1 ? "needs" : "need"} confirming on the invoice before ${c.check === 1 ? "it" : "they"} can be received. <button class="mini" data-pact="open-inv">Open the invoice</button></div>` : ""}
        ${ls.length ? `<div class="tbl-wrap xl"><table class="prept po-t"><thead><tr><th class="l">Product</th><th class="l">For</th><th>On invoice</th><th>Received</th><th>To come</th><th>Unit cost</th><th>Ext.</th><th></th></tr></thead><tbody>${ls.map(invRow).join("")}</tbody></table></div>` : '<div class="muted small">No matched products on this invoice yet.</div>'}
      </div>`;
    })();
    const destTot = (d) => { const ls = ed.lines.filter(l => l.dest === d); return [ls.reduce((a, l) => a + (Number(l.qty) || 0), 0), ls.reduce((a, l) => a + lineAmt(l), 0)]; };
    const iv = cur(ed);
    const pdfOn = !!(iv && ed.showPdf && (iv.file || iv.parts));
    // ---------- page layout (v0.33.0, Brian Oct 27, option A): receiving first; invoices, details and totals on the right ----------
    const savedTxt = ed.dirty ? '<span class="pill warn">Unsaved changes</span>' : ed.id ? "All changes saved" : "";
    const appr = ed.id && ed.status === "draft" ? (ed.approvedAt ? ` <span class="pill ok" title="Approved ${esc(when(ed.approvedAt))}${ed.approvedBy ? " by " + esc(ed.approvedBy) : ""}">Approved · awaiting submission</span> <button class="linkbtn small" data-pact="unapprove">undo</button>` : ed.readyAt ? ` <span class="pill warn" title="Marked ready ${esc(when(ed.readyAt))}">Ready to approve</span>` : ' <span class="pill pos" title="Still being put together — press Ready to approve when it is">Draft</span>') : "";
    const recvBy = (d) => { let o = 0, r = 0; for (const l of ed.lines) if (l.dest === d) { const p = pr.get(l.id); o += p.ordered; r += p.received; } return [r, o]; };
    const bandDests = ["prep", "shopify", "demo"].filter(d => ed.lines.some(l => l.dest === d)); if (!bandDests.length) bandDests.push(ed.dest === "prep" ? "prep" : "shopify");
    const destBar = (d) => { const [r, o] = recvBy(d), pct = o ? Math.min(100, Math.round(r / o * 100)) : 0;
      return `<div class="po2-bar"><div class="po2-barl"><span>→ ${DESTN[d]}</span><span class="muted">${n0(r)} of ${n0(o)}</span></div><span class="po2-track"><span style="width:${pct}%"></span></span></div>`; };
    const savedInv = ed.invoices.some(v => v.id && !v.isNew);
    const band = ed.id && ed.lines.length ? `<section class="panel po2-band" aria-label="Receiving">
        <div class="po2-big"><span class="eyebrow">Received</span><span class="po2-metric num">${n0(tot.received)} <small>of ${n0(tot.ordered)} units</small></span></div>
        <div class="po2-bars">${bandDests.map(destBar).join("")}</div>
        ${savedInv ? `<span class="dbtns"><button class="btn" data-pact="print-slip" title="This invoice's products with what's been received and what's still open">Print packing slip</button></span>` : ""}</section>` : "";
    // the invoices list on the right is the filter for the table (All lines · each invoice · Not on an invoice)
    const ivCard = (v, i) => { const t = invTot(v), c = count(v), bad = c.check + c.none, pct = t.b ? Math.round(t.g / t.b * 100) : 0, on = mode === "inv" && i === ed.cur;
      const rp = v.isNew || !v.id ? '<span class="pill warn">not saved</span>' : bad ? `<span class="pill miss">${bad} to check</span>` : v.recvAt ? '<span class="pill ok">✓ Received</span>' : t.b > t.g ? `<span class="pill warn">${n0(t.b - t.g)} to come</span>` : "";
      const meta = [v.date && shortDate(v.date), v.due && "due " + shortDate(v.due), t.b ? `${n0(t.g)} of ${n0(t.b)} in` : ""].filter(Boolean).map(esc).join(" · ");
      return `<button class="po2-inv ${on ? "on" : ""}" data-inv="${i}" aria-pressed="${on}" title="Show invoice ${esc(v.no || "")}"><span class="po2-ih"><b>${esc(v.no || "(no number)")}</b><span class="num">${v.total != null ? m(v.total) : ""}</span></span>
        ${meta ? `<span class="small muted">${meta}</span>` : ""}${t.b ? `<span class="po2-track sm"><span style="width:${pct}%"></span></span>` : ""}<span class="po2-pills">${rp}${v.id && !v.isNew ? (invClosed(v) ? closedPill : qbPill(v)) : ""}</span></button>`; };
    const flat = (k, label, n, cls) => `<button class="po2-inv flat ${cls || ""} ${mode === k ? "on" : ""}" data-pview="${k}" aria-pressed="${mode === k}"><span class="po2-ih"><span>${label}</span><span class="muted num">${n0(n)}</span></span></button>`;
    // what isn't on an invoice yet: always listed once there are invoices; gold when something is waiting for one
    const niLines = ed.lines.filter(l => pr.get(l.id).open > 0), niWait = niLines.filter(l => !l.backorder).length;
    const notInvCard = `<button class="po2-inv ${vw.notInv ? "attn" : "flat dashed"} ${mode === "notinv" ? "on" : ""}" data-pview="notinv" aria-pressed="${mode === "notinv"}" title="Products, or the part of them, not on an invoice yet">
        <span class="po2-ih"><span>Not on an invoice</span><span class="muted num">${n0(vw.notInv)}</span></span>
        ${vw.notInv ? `<span class="small muted">${niLines.length} product${niLines.length === 1 ? "" : "s"}${niLines.length - niWait ? ` · ${niLines.length - niWait} backordered` : ""}</span><span class="po2-pills"><span class="pill warn">${niWait ? "Waiting for an invoice" : "Backordered"}</span></span>` : ""}</button>`;
    const selIv = mode === "inv" && ivNow && ivNow.id && !ivNow.isNew ? ivNow : null;
    const selActs = selIv ? `<div class="po2-ivact"><button class="btn sm" data-pact="print-inv">Print invoice</button>${selIv.parts || selIv.file ? '<button class="btn sm" data-pact="print-pdf">Vendor PDF</button>' : ""}${selIv.recvAt ? (selIv.recvManual && !ro ? '<button class="btn sm" data-pact="inv-reopen" title="Take the received mark off this invoice">Reopen</button>' : "") : !ro && invTot(selIv).g > 0 ? '<button class="btn sm" data-pact="inv-recvd" title="Count this invoice as received in full, e.g. the vendor shipped less than they billed">Mark received</button>' : ""}<button class="btn sm" data-pact="open-inv" title="Lines, PDF, payment and QuickBooks">Open invoice →</button></div>${invStepsHtml(ed, selIv)}` : "";
    const dd = (id, k, v, empty) => `<dt>${k}</dt><dd><button class="hfield2" data-hedit="${id}" title="Edit ${k.toLowerCase()}">${v ? esc(v) : `<span class="dim">${empty}</span>`}</button></dd>`;
    const invSum = ed.invoices.filter(v => v.id && !v.isNew).reduce((a, v) => a + (v.total != null ? v.total : v.subtotal || 0), 0);
    const trow = (k, u, c, mu) => `<span class="${mu ? "muted" : ""}">${k}</span><span class="num ${mu ? "muted" : ""}">${u}</span><span class="num ${mu ? "muted" : ""}">${c}</span>`;
    const side = ed.id ? `<aside class="po2-side" aria-label="Invoices and order details">
        <section class="panel po2-card"><div class="po2-ch"><h2>Invoices${ed.invoices.length ? " · " + ed.invoices.length : ""}</h2>${!ro ? `<label class="btn sm" for="pe-file" title="Read the vendor's invoice PDF and put it on this PO">+ Add invoice</label>` : ""}</div>
          ${flat("all", "All lines", tot.ordered)}${ed.invoices.map(ivCard).join("")}${vw.showLeft ? flat("left", "Still to receive", vw.left) : ""}${anyInv ? notInvCard : ""}
          ${selActs}</section>
        <section class="panel po2-card"><div class="po2-ch"><h2>Order details</h2></div>
          <dl class="po2-dl">${dd("pe-vendor", "Vendor", ed.vendor, "not set")}${dd("pe-po", "PO #", ed.po, "not set")}${dd("pe-kind", "Type", ed.kind === "booking" ? "Booking" : "Order", "")}${ed.kind === "booking" ? dd("pe-placeby", "Place by", ed.placeBy ? shortDate(ed.placeBy) : "", "not set") : ""}${dd("pe-exp", "Expected", ed.expected ? shortDate(ed.expected) : "", "not set")}${dd("pe-dest", "Receive into", both ? "Both" : ed.dest === "prep" ? "Prep center" : "Shopify store", "")}${dd("pe-note", "Note", ed.note, "add a note")}</dl>
          ${planHtml(ed, ro)}</section>
        ${ed.lines.length ? `<section class="panel po2-card"><div class="po2-ch"><h2>Totals</h2></div><div class="po2-tot">
          ${trow("Ordered", n0(tot.ordered), m(tot.cost))}${both ? ["prep", "shopify", "demo"].filter(d => ed.lines.some(l => l.dest === d)).map(d => { const [u, c] = destTot(d); return trow(DESTN[d], n0(u), m(c), true); }).join("") : ""}
          ${trow("Invoiced", n0(tot.invoiced), anyInv ? m(invSum) : "")}${trow("Received", n0(tot.received), "")}${trow("On order", n0(tot.open - tot.back), "")}${tot.back ? trow("Backordered", n0(tot.back), "") : ""}</div></section>` : ""}
      </aside>` : "";
    // the row over the table: what it shows (an invoice as a chip, × back to all lines), Find, and Receive for that invoice
    const chip = (label) => `<span class="po2-chip">${label}<button data-pview="all" aria-label="Show all lines" title="Show all lines"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button></span>`;
    let flLeft = "", flBtn = "";
    if (mode === "inv" && ivNow) { const t = invTot(ivNow);
      flLeft = chip("Invoice " + esc(ivNow.no || "(no number)")) + `<span class="muted small">${[ivNow.date && shortDate(ivNow.date), ivNow.total != null && m(ivNow.total), ivNow.due && "due " + shortDate(ivNow.due), t.b && `${n0(t.g)} of ${n0(t.b)} received`].filter(Boolean).join(" · ")}</span>`;
      if (canRecv && ivNow.id && !ivNow.isNew && (ivNow.recvAt || !(t.b > t.g))) flBtn = `<button class="btn po2-recv" data-pact="rq-start" ${S.busy ? "disabled" : ""} title="Receive extra units, more than the invoice shows">Receive more</button>`;
      else if (canRecv && ivNow.id && !ivNow.isNew && t.b > t.g) flBtn = `<button class="btn primary po2-recv" data-pact="rq-start" ${S.busy ? "disabled" : ""}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg> Receive · ${n0(t.b - t.g)} left</button>`;
    } else if (mode === "notinv") flLeft = chip("Not on an invoice") + `<span class="muted small">${n0(vw.notInv)} units</span>`;
    else if (mode === "left") flLeft = chip("Still to receive") + `<span class="muted small">${n0(vw.left)} units</span>`;
    else flLeft = `<b>All lines</b> <span class="muted small">${n0(tot.ordered)} units${anyInv && vw.openInv ? " · pick an invoice on the right to receive it" : ""}</span>`;
    const filterRow = `<div class="po2-filter"><span class="po2-fl">${flLeft}</span><span class="po2-fr">${!ro && !ed.recv && mode === "all" && ed.lines.length > 1 ? `<select id="po-arrange" class="inp sm" aria-label="Reorganize the lines" title="Put the lines in an order — or drag them by the handle"><option value="">Reorganize lines…</option>${ed.invoices.filter(v => v.rows && v.rows.length).map((v, i) => `<option value="inv:${ed.invoices.indexOf(v)}">Match vendor invoice ${esc(v.no || "#" + (i + 1))}</option>`).join("")}<option value="cat">Group by category</option><option value="name">Group by product</option></select>` : ""}${!ro && !ed.recv && !(S.vview && ed.lines.length) ? `<button class="btn" data-pact="add-prod" title="Add a product to this PO">+ Add product</button>` : ""}${ed.lines.length ? `<input id="po-find" class="inp sm" type="search" placeholder="Find product or SKU" value="${esc(ed.find || "")}" aria-label="Find a product on this PO">` : ""}${flBtn}</span></div>`;
    box.innerHTML = `
      <div class="po-top po2-top">
        <div class="po2-headrow">
          <div class="po2-tb">
            <span class="eyebrow">${ed.id ? `<button class="hlink" data-hedit="pe-vendor" title="Edit the vendor">${esc(ed.vendor || "Vendor")}</button>` : esc(ed.vendor || "New")} · ${ed.kind === "booking" ? "Booking" : "Purchase order"}${savedTxt ? ` · <span class="po2-saved">${savedTxt}</span>` : ""}</span>
            <div class="po2-title"><h2>${ed.id ? `<button class="hlink" data-hedit="pe-po" title="Edit the PO number">${esc(ed.po || "#" + ed.id)}</button>` : "New purchase order"}</h2>${ed.id ? `<button class="po2-link" data-pact="copy-link" aria-label="Copy a link to this PO" title="Copy a link to this PO (needs a Seller Sage sign-in)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>` : ""}${appr}</div>
          </div>
          <div class="po2-hr"><span class="steps six seven">${steps}</span>
            <span class="dbtns">${ed.id && ["received", "qb_ready"].includes(ed.status) && !ed.recv ? `<button class="btn primary" data-pact="next-stage" ${S.busy ? "disabled" : ""}>${NEXT[ed.status][1]}</button>` : ""}${ed.dirty ? `<button class="btn" data-pact="revert" ${S.busy ? "disabled" : ""} title="${ed.id ? "Throw away the changes since the last save" : "Throw away this new order"}">${ed.id ? "Discard changes" : "Discard"}</button>` : ""}<button class="btn ${ed.dirty || !ed.id ? "primary" : ""}" data-pact="save" ${S.busy || (!ed.dirty && ed.id) || ed.recv ? "disabled" : ""} title="Save this purchase order (⌘S / Ctrl+S)">${S.busy === "Saving…" ? "Saving…" : ed.dirty || !ed.id ? "Save" : "Saved"}</button></span></div>
        </div>
        ${ed.id ? "" : headStrip(ed, ro, both)}
      </div>
      ${!ed.id || ed.editHead ? `<section class="panel po-headedit">${ed.id ? `<div class="panel-head"><h2>PO details</h2><span class="dbtns right"><button class="btn" data-pact="head-done">Done</button></span></div>` : ""}
        <div class="pmgrid">
          <label class="stack" for="pe-vendor">Vendor<input id="pe-vendor" class="inp" list="pe-vendors" value="${esc(ed.vendor)}" ${got ? "disabled" : ""} autocomplete="off" placeholder="Shopify vendor"><datalist id="pe-vendors">${vendorOpts}</datalist></label>
          <label class="stack" for="pe-po">PO #<input id="pe-po" class="inp mono" value="${esc(ed.po)}" ${ro ? "disabled" : ""}></label>
          <label class="stack">Type<span class="seg"><button data-pkind="order" aria-pressed="${ed.kind !== "booking"}" ${ed.status !== "draft" ? "disabled" : ""}>Order</button><button data-pkind="booking" aria-pressed="${ed.kind === "booking"}" ${ed.status !== "draft" ? "disabled" : ""}>Booking</button></span></label>
          ${ed.kind === "booking" ? `<label class="stack" for="pe-placeby">Place by<input id="pe-placeby" class="inp" type="date" value="${esc(ed.placeBy)}" ${ed.status !== "draft" ? "disabled" : ""}></label>` : ""}
          <label class="stack" for="pe-exp">Expected<input id="pe-exp" class="inp" type="date" value="${esc(ed.expected)}" ${ro ? "disabled" : ""}></label>
          <label class="stack" for="pe-dest">Receive into<select id="pe-dest" class="inp" ${ro ? "disabled" : ""}><option value="shopify" ${ed.dest === "shopify" ? "selected" : ""}>Shopify store</option><option value="prep" ${ed.dest === "prep" ? "selected" : ""}>Prep center (Amazon)</option><option value="both" ${both ? "selected" : ""}>Both — choose per product</option></select></label>
          <label class="stack" for="pe-note" style="grid-column:1 / -1">Note<input id="pe-note" class="inp" value="${esc(ed.note)}" ${ro ? "disabled" : ""} placeholder="e.g. ships in two drops"></label>
        </div>
      </section>` : ""}
      ${band}${doubleHtml(ed)}
      ${iss.length ? `<section class="po-issues">${window.JTIssues.issuesHtml(iss)}</section>` : ""}
      <div class="po2-cols">
      <section class="panel po-lines po-inv po2-main" id="pe-drop">
        ${vendorBar(ed)}${S.vview && ed.lines.length ? vendorHtml(ed) : filterRow}
        ${S.vview && ed.lines.length ? "" : mode === "inv" ? (recvHtml || "") : `
        ${openLines.length && !ro && !ed.recv && ed.invoices.length && mode !== "all" ? `<div class="bobar ${ed.boPrompt ? "hot" : ""}"><span><b>${openLines.length} product${openLines.length === 1 ? "" : "s"}</b> ${openLines.length === 1 ? "isn't" : "aren't"} on an invoice yet (${n0(openLines.reduce((a, l) => a + pr.get(l.id).open, 0))} units).</span>
            <span class="dbtns"><label class="small" for="pe-boeta">Expected</label><input id="pe-boeta" class="inp sm" type="date" style="width:auto" aria-label="Expected arrival for the backorders (blank if unknown)">
            <button class="btn primary" data-pact="bo-all">Mark ${openLines.length === 1 ? "it" : "all " + openLines.length} backordered</button>${ed.boPrompt ? '<button class="btn" data-pact="bo-no">Keep on order</button>' : ""}</span></div>` : ""}
        ${mode === "notinv" && ed.lines.length && !topLines.length ? `<div class="note ok">Everything on this PO is on an invoice — pick the invoice above to receive it.</div>`
          : mode === "left" && !viewLines.length ? `<div class="note ok">Everything on this PO has been received.</div>`
          : ed.lines.length ? `<div class="tbl-wrap xl"><table class="prept po-t"><thead><tr><th class="l">Product</th><th class="l">For</th><th>Ordered</th>${mode === "notinv" ? "<th>Invoiced</th><th>Not invoiced</th>" : mode === "left" ? "<th>Received</th><th>Still to come</th>" : `${anyInv ? "<th>Invoiced</th>" : ""}<th>Received</th>`}${ed.recv ? "<th>Arrived now</th>" : ""}<th class="l">${mode === "all" ? "Status · backorder" : "Backorder · ETA"}</th><th>Unit cost</th><th>Ext.</th><th></th></tr></thead><tbody>${lineRows}</tbody></table></div>`
          : `<div class="muted small">No products yet. Add them below, or upload the vendor's invoice PDF.</div>`}
        ${!ro && !ed.recv && mode !== "left" ? `<div class="addbox">${both ? `<div class="row small">Add to <span class="seg sm"><button data-paddto="shopify" aria-pressed="${ed.addTo !== "prep"}">Shopify store</button><button data-paddto="prep" aria-pressed="${ed.addTo === "prep"}">Prep center</button></span></div>` : ""}<label class="stack" for="po-add">Add product<input id="po-add" class="inp mono" value="${esc(ed.add)}" placeholder="Shopify SKU, UPC, product name, ASIN or Amazon SKU" autocomplete="off"></label>
          ${ed.status === "draft" ? `<div class="row small addcsv"><span class="muted">or from a spreadsheet:</span><button class="btn sm" type="button" data-pact="csv-up" title="A CSV or Excel file of products (Shopify SKU, UPC or Amazon SKU) and quantities: added to this order">Upload CSV</button><button class="linkbtn small" type="button" data-pact="csv-tmpl" title="A blank CSV to fill in: Shopify SKU, UPC or Amazon SKU, Qty, and optionally Unit cost">Download template</button></div>` : ""}
          ${ed.add.trim() ? `<div class="mres">${!S.cat ? '<span class="muted small">Loading the Shopify catalog…</span>' : found.map((x, i) => `<button data-padd="${i}"><b>${esc(x.v.title)}</b><br><span class="dim">${esc(x.v.sku)} · ${esc(x.v.vendor)}${x.asku ? " · for " + esc(x.asku) : ""} · cost ${m(x.v.cost)}</span></button>`).join("") || '<span class="muted small">No products match.</span>'}</div>` : ""}</div>` : ""}`}
        ${ed.confirm === "del" ? `<div class="note warn">Delete this purchase order and its draft invoices? Nothing has been received, so no stock changes. <span class="dbtns"><button class="mini primary" data-pact="do-del">Yes, delete</button><button class="mini" data-pact="no">Cancel</button></span></div>` : ""}
        ${ed.confirm === "unrecv" ? `<div class="note warn">Move this order back to invoiced? What was received into the prep center comes back out (refused if some of it already shipped out). <span class="dbtns"><button class="mini primary" data-pact="do-back">Yes, move it back</button><button class="mini" data-pact="no">Cancel</button></span></div>` : ""}
        ${ed.confirm === "short" ? `<div class="note warn">Close this PO short? What wasn't received is treated as not coming (ask the vendor for a credit if it was billed), and the PO moves to Received. <span class="dbtns"><button class="mini primary" data-pact="do-short">Yes, close it short</button><button class="mini" data-pact="no">Cancel</button></span></div>` : ""}
        ${ro ? `<div class="note info">This PO is complete, so its products and invoice lines are locked. Invoice payments can still be changed. Step it back to QB ready to change anything else.</div>` : ""}
        <div class="row po-foot"><span class="muted small">${ed.recv ? "Enter what arrived. It starts from what's invoiced and not yet received; anything else can be received too. Prep-center lines go into the prep center (pick the ASIN, or leave it on any ASIN and assign it later); Shopify-store lines are recorded." : `${n0(tot.ordered)} units · ${m(tot.cost)}`}</span>
          <span class="dbtns right">${footButtons(ed, got, ro)}</span></div>
      </section>${side}</div>
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
  // an invoice is closed in Seller Sage once it's been sent to QuickBooks (v0.10.87). Payment is tracked for finance
  // and doesn't keep it open; receiving still shows on the PO.
  const invLeft = (v) => [!v.qbo && "send it to QuickBooks"].filter(Boolean);
  const invClosed = (v) => !v.isNew && !!v.id && !!v.qbo;
  const closedPill = '<span class="pill ok" title="Sent to QuickBooks — payment is up to finance">✓ Closed</span>';
  function invStepsHtml(ed, iv) {
    if (iv.isNew || !iv.id) return "";
    const step = (ok, label) => `<span class="ivstep ${ok ? "done" : ""}">${ok ? "✓" : "○"} ${label}</span>`;
    const left = invLeft(iv);
    const wait = ed.invoices.filter(x => x !== iv && x.id && !x.isNew && !x.recvAt && invTot(x).b > invTot(x).g);
    const poNote = iv.recvAt && wait.length && !["received", "qb_ready", "complete"].includes(ed.status)
      ? ` The PO stays <b>${esc(STAGE.get(ed.status))}</b> until ${wait.map(x => `invoice <b>${esc(x.no || "")}</b> (${n0(invTot(x).b - invTot(x).g)} units still to come)`).join(" and ")} ${wait.length === 1 ? "is" : "are"} received.` : "";
    return `<div class="ivsteps">${step(!!iv.recvAt, "Received")}${step(!!iv.qbo, "In QuickBooks")}
      <span class="small">${left.length ? `To close it: ${left.join(", ")}.` : `<b>This invoice is closed</b> — it's in QuickBooks; payment is up to finance.${iv.recvAt ? "" : " Products still to receive show on the PO."}`}${poNote}</span></div>`;
  }
  // Which views of a PO apply: the entire PO (default), each invoice, what isn't invoiced (once there are invoices) and,
  // once every invoice is received and something is still to come, what's still to receive (then the default).
  function poViews(ed, pr) {
    const ivs = ed.invoices, anyInv = ivs.length > 0;
    const openInv = ivs.some(v => v.id && !v.isNew && !v.recvAt);
    const notInv = ed.lines.reduce((a, l) => a + pr.get(l.id).open, 0);
    const left = ed.lines.reduce((a, l) => { const p = pr.get(l.id); return a + Math.max(0, p.ordered - p.received); }, 0);
    const showLeft = !openInv && left > 0 && ed.lines.some(l => (l.received || 0) > 0);
    const ok = (v) => v === "all" || (v === "inv" && !!cur(ed)) || v === "notinv" || (v === "left" && showLeft);
    return { anyInv, openInv, notInv, left, showLeft, ok, def: showLeft ? "left" : "all" };
  }
  // The view switch above the PO's table: All · each invoice · Still to receive · Not invoiced (last) · + Add invoice
  function viewSeg(ed, vw, ro) {
    if (!ed.id && !ed.invoices.length) return `<div class="panel-head"><h2>Products on this PO</h2><span class="muted small">what was ordered · receiving is against these</span></div>`;
    const v = ed.view, units = (n) => `<span class="cnt">${n0(n)}</span>`;
    const ivBtn = (iv, i) => { const t = invTot(iv), c = count(iv), bad = c.check + c.none;
      const st = iv.isNew ? '<span class="pill warn">new</span>' : bad ? `<span class="pill miss">${bad} to check</span>` : invClosed(iv) && (iv.recvAt || !(t.b > t.g)) ? closedPill : iv.recvAt ? `<span class="pill ok" title="Received in full; still to ${esc(invLeft(iv).join(" and "))}">✓ received</span>` : t.g > 0 ? `<span class="pill manual">${n0(t.g)} of ${n0(t.b)} in</span>` : `<span class="pill pos">${n0(t.b)} to receive</span>`;
      return `<button data-inv="${i}" aria-pressed="${v === "inv" && i === ed.cur}" title="Invoice ${esc(iv.no || "")}${iv.total != null ? " · " + m(iv.total) : ""}">Invoice ${esc(iv.no || "#" + (i + 1))} ${st}</button>`; };
    return `<div class="panel-head pviews"><div class="seg" role="group" aria-label="Show">
        <button data-pview="all" aria-pressed="${v === "all"}" title="Every product on this PO">All</button>
        ${ed.invoices.map(ivBtn).join("")}
        ${vw.showLeft ? `<button data-pview="left" aria-pressed="${v === "left"}" title="Every invoice is received: what's still to come">Still to receive ${units(vw.left)}</button>` : ""}
        <button data-pview="notinv" aria-pressed="${v === "notinv"}" title="Products, or the part of them, that aren't on an invoice yet${vw.anyInv ? ` (${n0(vw.notInv)} units)` : ""}">Not invoiced</button>
      </div>${!ro && ed.id ? `<label class="btn right" for="pe-file" title="Read the vendor's invoice PDF and open it on the Invoices tab, attached to this PO">+ Add invoice</label>` : ""}</div>`;
  }
  // the chosen invoice's summary line (the rest is on the Invoices tab)
  function invBarHtml(ed) {
    const iv = cur(ed); if (!iv) return "";
    const c = count(iv);
    return `<div class="po-invbar"><span><b>Invoice ${esc(iv.no || "(no number)")}</b>${iv.date ? " · " + esc(shortDate(iv.date)) : ""}${iv.total != null ? " · " + m(iv.total) : ""}${iv.due ? " · due " + esc(shortDate(iv.due)) : ""} ${invClosed(iv) ? closedPill : iv.isNew || !iv.id ? payPill(iv) : ""}${c.check + c.none ? ` <span class="pill miss">${c.check + c.none} line${c.check + c.none === 1 ? "" : "s"} to check</span>` : ""}</span>
        <span class="dbtns"><button class="btn" data-pact="open-inv" title="Lines, PDF, payment and QuickBooks">Open invoice →</button></span></div>${invStepsHtml(ed, iv)}`;
  }
  // The Invoices tab: one invoice in full — its PO, details, payment, QuickBooks, lines and PDF
  function renderInvoicePage() {
    const ed = S.ed, iv = cur(ed), box = $("po-edit-view");
    $("inv-list-view").hidden = true; box.hidden = false;
    if (!iv) { S.invOpen = false; render(); return; }
    const keep = document.activeElement && box.contains(document.activeElement) ? { id: document.activeElement.id, k: document.activeElement.dataset.k, f: document.activeElement.dataset.f, s: document.activeElement.selectionStart } : null;
    const ro = false, pdfOn = !!(ed.showPdf && (iv.file || iv.parts));
    const t = invTot(iv), others = ed.invoices.length - 1;
    const poName = ed.id ? `${esc(ed.vendor || "Vendor")} · ${esc(ed.po ? poLabel(ed.po) : "#" + ed.id)}` : `New PO · ${esc(ed.vendor || "vendor")}${ed.po ? " " + esc(poLabel(ed.po)) : ""}`;
    const canMove = ed.id && iv.id && !iv.isNew && !ro;
    // name the PO right here when the invoice starts a new one (or its PO has no name yet); stays a field while typing
    const nameIn = !ed.alone && (!ed.id || !ed.po || ed.nameIn); if (nameIn) ed.nameIn = true;
    const saved = ed.alone ? !!iv.id : !!ed.id;
    // no PO yet: the vendor, and what to do with the invoice — start a PO from it, or put it on one
    const aloneSum = () => `<div class="po-sum alone"><span>Purchase order <b>none yet</b> <label class="po-name">Vendor <input id="pe-vendor" class="inp sm" list="pe-vendors" value="${esc(ed.vendor)}" autocomplete="off" placeholder="Shopify vendor" style="width:160px"><datalist id="pe-vendors">${S.vendors.map(v => `<option value="${esc(v)}">`).join("")}</datalist></label></span>
          <span class="dbtns"><button class="mini primary" data-pact="alone-newpo" title="Start a Seller Sage purchase order with this invoice's products on it">Start a PO from it</button><button class="mini" data-pact="alone-link" title="Put this invoice on an existing purchase order">Add to a PO</button></span></div>`;
    // ---------- page layout (v0.35.0, Brian Oct 28): the PO page's look — header, summary band, lines, cards on the right ----------
    const c = count(iv), savedTxt = ed.dirty ? '<span class="pill warn">Unsaved changes</span>' : saved ? "All changes saved" : "";
    const matched = iv.rows.length > 0 && !c.check && !c.none;
    const steps = [["Matched", matched], ...(ed.alone ? [] : [["Received", !!iv.recvAt]]), ["In QuickBooks", !!iv.qbo], ["Paid", !!iv.paidOn]];
    const nextAt = steps.findIndex(x => !x[1]);
    const stepHtml = steps.map(([k, ok], i) => `<span class="step ${ok ? "done" : i === nextAt ? "on" : ""}">${ok ? "✓ " : ""}${k === "Paid" && !ok && iv.due ? `Unpaid · due ${esc(shortDate(iv.due))}` : k}</span>`).join('<span class="step-sep">→</span>');
    const rowSum = iv.rows.reduce((a, r) => a + rowAmt(r), 0), chg = iv.rows.filter(r => r.skip).reduce((a, r) => a + rowAmt(r), 0);
    const tieDiff = iv.total != null ? Math.round((iv.total - rowSum) * 100) / 100 : null;
    const band = iv.rows.length || iv.total != null ? `<section class="panel po2-band" aria-label="Summary">
        <div class="po2-big"><span class="eyebrow">Invoice total</span><span class="po2-metric num">${iv.total != null ? m(iv.total) : m(rowSum)}</span>
          <span class="small muted">${m(rowSum - chg)} products${chg ? ` + ${m(chg)} charges` : ""}${tieDiff == null ? "" : Math.abs(tieDiff) < 0.01 ? ' · <span class="okt">ties out ✓</span>' : ` · <span class="warnt">lines are ${m(Math.abs(tieDiff))} ${tieDiff > 0 ? "under" : "over"} the total</span>`}</span></div>
        ${ed.id && t.b ? `<div class="po2-bars"><div class="po2-bar"><div class="po2-barl"><span>Received</span><span class="muted">${n0(t.g)} of ${n0(t.b)} units</span></div><span class="po2-track"><span style="width:${Math.min(100, Math.round(t.g / t.b * 100))}%"></span></span>
          <span class="small ${iv.recvAt ? "okt" : "muted"}">${iv.recvAt ? `✓ Received in full${iv.recvAt ? " " + esc(shortDate(String(iv.recvAt).slice(0, 10))) : ""}` : t.g ? `${n0(t.b - t.g)} still to come` : "Nothing received yet"}</span></div></div>` : '<div class="po2-bars"></div>'}
        <div class="po2-big"><span class="eyebrow">Payment</span><span class="po2-pay">${iv.paidOn ? `Paid ${esc(shortDate(iv.paidOn))}` : iv.due ? `Due ${esc(shortDate(iv.due))}` : "No due date"}</span><span class="small ${!iv.paidOn && overdue(iv) ? "neg" : "muted"}">${iv.paidOn ? esc(iv.payMethod || "") : overdue(iv) ? "Overdue" : iv.terms ? esc(iv.terms) : "unpaid"}</span></div>
        <span class="dbtns">${iv.paidOn ? "" : `<button class="btn primary" data-pact="pay">Mark paid</button>`}${ed.id && iv.id && !iv.isNew ? `<button class="btn" data-pact="print-slip" title="This invoice's products with what's been received and what's still open">Print packing slip</button>` : ""}</span></section>` : "";
    const fld = (id, label, val, attrs) => `<label class="stack" for="${id}">${label}<input id="${id}" class="inp ${attrs || ""}" value="${esc(val)}"></label>`;
    const lockF = iv.status === "applied";
    const fc = (k, label, n) => `<button class="po2-inv flat ${(iv.filter || "all") === k ? "on" : ""}" data-ifilter="${k}" aria-pressed="${(iv.filter || "all") === k}"><span class="po2-ih"><span>${label}</span><span class="muted num">${n0(n)}</span></span></button>`;
    // the invoice's details across the top (Brian, Oct 28: "let's not have the right hand column of details on the invoices -
    // it's too complicated to have 3 columns. let's put the invoice metadata at the top")
    const poBlock = ed.alone
      ? `<div class="ivm-po"><span class="eyebrow">Purchase order</span><span class="small">None yet</span>
          <label class="stack small" for="pe-vendor">Vendor<input id="pe-vendor" class="inp sm" list="pe-vendors" value="${esc(ed.vendor)}" autocomplete="off" placeholder="Shopify vendor"><datalist id="pe-vendors">${S.vendors.map(v => `<option value="${esc(v)}">`).join("")}</datalist></label>
          <span class="dbtns"><button class="btn sm primary" data-pact="alone-newpo" title="Start a Seller Sage purchase order with this invoice's products on it">Start a PO from it</button><button class="btn sm" data-pact="alone-link" title="Put this invoice on an existing purchase order">Add to a PO</button></span></div>`
      : `<div class="ivm-po"><span class="eyebrow">Purchase order</span>
          ${nameIn ? `<b>${ed.id ? esc(ed.vendor || "Vendor") + " · #" + esc(ed.id) : "New PO · " + esc(ed.vendor || "vendor")}</b><label class="stack small" for="pe-po">PO name<input id="pe-po" class="inp sm mono" value="${esc(ed.po)}" placeholder="e.g. Oct Balls" autocomplete="off"></label>`
            : `<button class="linkbtn ivm-polink" data-pact="open-po" title="Open the purchase order">${esc(ed.po ? ed.po : "#" + ed.id)} →</button><span class="small muted">${ed.id ? esc(STAGE.get(ed.status) || "") : ""}${others > 0 ? ` · ${others + 1} invoices` : ""}${canMove ? ' · <button class="linkbtn small" data-pact="inv-move">Change PO</button>' : iv.isNew && S.pend ? ' · <button class="linkbtn small" data-pact="inv-repick">Wrong PO?</button>' : ""}</span>`}</div>`;
    const meta = `<section class="panel iv-meta" aria-label="Invoice details">
        <div class="ivm-row">
          ${poBlock}
          <div class="ivm-fields">
            <label class="stack" for="pe-invno">Invoice #<input id="pe-invno" class="inp sm mono" value="${esc(iv.no)}" ${lockF ? "disabled" : ""}></label>
            <label class="stack" for="pe-invdate">Date<input id="pe-invdate" class="inp sm" type="date" value="${esc(iv.date)}" ${lockF ? "disabled" : ""}></label>
            <label class="stack" for="pe-invdue">Due<input id="pe-invdue" class="inp sm" type="date" value="${esc(iv.due)}"></label>
            <label class="stack" for="pe-invterms">Terms<input id="pe-invterms" class="inp sm" value="${esc(iv.terms)}" placeholder="e.g. Net 30"></label>
            <label class="stack" for="pe-invsub">Subtotal<input id="pe-invsub" class="inp sm num" value="${iv.subtotal != null ? iv.subtotal.toFixed(2) : ""}" ${lockF ? "disabled" : ""}></label>
            <label class="stack" for="pe-invtotal">Total<input id="pe-invtotal" class="inp sm num" value="${iv.total != null ? iv.total.toFixed(2) : ""}"></label>
          </div>
          <div class="ivm-acts">${iv.status === "applied" ? '<span class="pill ok" title="Applied on the Invoices tab: its lines are locked">Costs in Shopify</span>' : ""}${iv.id && !iv.isNew ? `<button class="linkbtn small" data-pact="print-inv" title="Print this invoice as saved in Seller Sage">Print invoice</button>${iv.parts || iv.file ? `<button class="linkbtn small" data-pact="print-pdf" title="Print the vendor's PDF${iv.fileName ? " · " + esc(iv.fileName) : ""}">Print vendor PDF</button>` : ""}` : ""}${!(t.g > 0) ? `<button class="linkbtn small neg" data-pact="rminv">${iv.isNew ? "Discard invoice" : "Delete invoice"}</button>` : ""}</div>
        </div>
        ${iv.rows.length ? `<div class="ivm-pq">${qbLine(ed, iv)}</div>` : ""}
        ${iv.paidOn || iv.payMethod || iv.payRef || iv.paidFrom ? `<div class="ivm-pq">${payHtml(ed, iv)}</div>` : ""}
      </section>`;
    box.innerHTML = `
      <div class="po-top po2-top">
        <div class="po2-headrow">
          <div class="po2-tb">
            <span class="eyebrow">${esc(ed.vendor || "Vendor")} · Invoice${savedTxt ? ` · <span class="po2-saved">${savedTxt}</span>` : ""}</span>
            <div class="po2-title"><h2>${esc(iv.no || "(no number)")}</h2>${iv.id && !iv.isNew ? `<button class="po2-link" data-pact="copy-link" aria-label="Copy a link to this invoice" title="Copy a link to this invoice (needs a Seller Sage sign-in)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>` : ""}${overdue(iv) && !iv.paidOn ? payPill(iv) : ""}</div>
          </div>
          <div class="po2-hr"><span class="steps">${stepHtml}</span>
            <span class="dbtns">${ed.dirty ? `<button class="btn" data-pact="revert" ${S.busy ? "disabled" : ""} title="${saved ? "Throw away the changes since the last save" : "Throw away this new invoice"}">${saved ? "Discard changes" : "Discard"}</button>` : ""}<button class="btn ${ed.dirty || !saved ? "primary" : ""}" data-pact="save" ${S.busy || (!ed.dirty && saved) ? "disabled" : ""} title="Save (⌘S / Ctrl+S)">${S.busy === "Saving…" ? "Saving…" : ed.dirty || !saved ? "Save" : "Saved"}</button></span></div>
        </div>
      </div>
      ${ed.confirm === "inv-move" ? moveHtml(ed) : ed.confirm === "alone-link" ? aloneLinkHtml(ed) : ""}
      ${band}
      ${ed.alone ? `<div class="note info">${saved ? "This invoice isn't on a purchase order yet." : "Saving keeps this invoice on its own — no purchase order yet."} Start a PO from it, or add it to an open one.</div>`
        : !ed.id ? '<div class="note info">Saving creates the purchase order with this invoice on it. You can add or change products on the PO afterwards.</div>' : ""}
      ${meta}
      <section class="panel po-inv iv-main" id="pe-drop">${invDetailHtml(ed, ro, pdfOn)}</section>`;
    if (keep) {
      const el = keep.id ? $(keep.id) : keep.k && keep.f ? box.querySelector(`[data-f="${keep.f}"][data-k="${keep.k}"]`) : null;
      if (el) { el.focus(); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.s); } catch (_) {} }
    }
    if (pdfOn && $("pe-pdf") && !$("pe-pdf").childElementCount) renderPdf();
    { const bar = document.querySelector(".appbar"), top = box.querySelector(".po-top"), st = document.documentElement.style;
      if (bar) st.setProperty("--appbar-h", bar.offsetHeight + "px"); if (top) st.setProperty("--potop-h", top.offsetHeight + "px"); }
  }
  // ---------- packing slip (Brian, Oct 20): the invoice's products with what's been received and what's still to come,
  // printed for checking the boxes as they're opened. One row per PO line the invoice covers (a product split between the
  // store and the prep center has two), still-to-come first; lines not matched to a product listed at the end.
  function slipHtml(ed, iv) {
    const sh = invShares(ed, iv), V = (vid) => (S.byVid && S.byVid.get(vid)) || {};
    const code = (vid) => { const r = iv.rows.find(x => x.vid === vid); return r ? { item: r.src.item_code || "", upc: r.src.upc || "" } : { item: "", upc: "" }; };
    const rows = ed.lines.filter(l => sh.has(l.id) && sh.get(l.id).billed > 0).map(l => {
      const x = sh.get(l.id), v = V(l.vid), c = code(l.vid);
      return { l, v, c, billed: x.billed, got: x.got, left: x.left, st: x.left <= 0 ? "Received" : x.got > 0 ? "Partly received" : "Still to come" };
    });
    const open = rows.filter(r => r.left > 0).sort((a, b) => (a.v.title || "").localeCompare(b.v.title || "")), done = rows.filter(r => r.left <= 0).sort((a, b) => (a.v.title || "").localeCompare(b.v.title || ""));
    const other = iv.rows.filter(r => !r.vid && !r.skip && (r.src.description || r.src.item_code)).map(r => ({ item_code: r.src.item_code, description: r.src.description, qty: r.qty }));
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    const e = (x) => String(x ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const tr = (r) => `<tr class="${r.left <= 0 ? "done" : ""}"><td class="box">${r.left <= 0 ? "✓" : ""}</td>
      <td><b>${e(r.v.product || r.v.title || "variant " + r.l.vid)}</b>${r.v.variant && r.v.variant !== "Default Title" ? ` · ${e(r.v.variant)}` : ""}
        <div class="m">${[r.v.sku && "SKU " + r.v.sku, r.c.item && r.c.item !== r.v.sku && "item " + r.c.item, (r.v.barcode || r.c.upc) && "UPC " + (r.v.barcode || r.c.upc)].filter(Boolean).map(e).join(" · ")}</div></td>
      <td>${r.l.dest === "prep" ? `Prep center${r.l.asku ? `<div class="m">${e(r.l.asku)}</div>` : ""}` : r.l.dest === "demo" ? "Not for resale" : "Shopify store"}</td>
      <td class="n">${r.billed}</td><td class="n">${r.got}</td><td class="n"><b>${r.left || ""}</b></td>
      <td>${e(r.st)}${r.l.backorder && r.left > 0 ? `<div class="m">backordered${r.l.eta ? " · expected " + e(shortDate(r.l.eta)) : ""}</div>` : ""}</td>
      <td class="cnt"></td></tr>`;
    const table = (title, rs) => rs.length ? `<h2>${title} <span>(${rs.length})</span></h2><table class="t"><colgroup><col style="width:22px"><col><col style="width:110px"><col style="width:62px"><col style="width:66px"><col style="width:48px"><col style="width:120px"><col style="width:62px"></colgroup><thead><tr><th></th><th>Product</th><th>For</th><th class="n">Invoiced</th><th class="n">Received</th><th class="n">Open</th><th>Status</th><th>Count</th></tr></thead><tbody>${rs.map(tr).join("")}</tbody></table>` : "";
    const now = new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    return `<!doctype html><html><head><meta charset="utf-8"><title>Packing slip ${e(iv.no || "")}</title><style>
      @page{size:letter;margin:12mm}*{box-sizing:border-box}body{font:11px/1.35 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;margin:0}
      h1{font-size:18px;margin:0}h2{font-size:13px;margin:14px 0 4px}h2 span{color:#666;font-weight:400}
      .hd{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #111;padding-bottom:6px;margin-bottom:8px}
      .hd .r{text-align:right}.k{color:#555}.sum{display:flex;gap:18px;margin:6px 0 2px;font-size:12px}.sum b{font-size:14px}
      table{width:100%;border-collapse:collapse;page-break-inside:auto;font-size:inherit}table.t{table-layout:fixed}tr{page-break-inside:avoid}
      th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:#444;border-bottom:1px solid #111;padding:4px 5px}
      td{border-bottom:1px solid #ccc;padding:5px;vertical-align:top}.n{text-align:right;white-space:nowrap}.m{color:#555;font-size:10px}
      td.box{width:18px;font-size:13px;text-align:center}td.box::before{content:"";}tr:not(.done) td.box{border:1px solid #111;border-bottom-color:#111}
      td.cnt{width:60px;border-bottom:1px solid #111}tr.done td{color:#555}.foot{margin-top:12px;color:#666;font-size:10px}
    </style></head><body>
      <div class="hd"><div><h1>Packing slip · ${e(ed.vendor || "")}</h1><div>Invoice <b>${e(iv.no || "—")}</b>${iv.date ? ` · ${e(shortDate(iv.date))}` : ""}</div>
        <div>${ed.po ? e(poLabel(ed.po)) : "No PO"}${ed.status ? ` · ${e(STAGE.get(ed.status) || ed.status)}` : ""}</div></div>
        <div class="r"><div class="k">Printed ${e(now)}</div>${iv.recvAt ? `<div><b>Received in full</b> ${e(shortDate(String(iv.recvAt).slice(0, 10)))}</div>` : ""}</div></div>
      <div class="sum"><span>Invoiced <b>${sum("billed")}</b></span><span>Received <b>${sum("got")}</b></span><span>Still open <b>${sum("left")}</b></span><span>${rows.length} product line${rows.length === 1 ? "" : "s"}</span></div>
      ${table("Still to come", open)}${table("Received", done)}
      ${other.length ? `<h2>On the invoice, not matched to a product <span>(${other.length})</span></h2><table><tbody>${other.map(r => `<tr><td>${e(r.item_code)}</td><td>${e(r.description)}</td><td class="n">${e(r.qty ?? "")}</td></tr>`).join("")}</tbody></table>` : ""}
      <div class="foot">Count what's in the box, write it in Count, then receive it on the invoice in Seller Sage.</div>
    </body></html>`;
  }
  function printSlip(ed, iv) {
    if (!iv || !iv.id) { note("warn", "Save the invoice first."); return; }
    printHtml(slipHtml(ed, iv));
  }
  // ---------- print the invoice (Brian, Oct 20: "print the seller sage invoice or the attached vendor pdf") ----------
  // The Seller Sage invoice: header, every line as saved (with the product it's matched to), totals, paid / received /
  // QuickBooks status. The vendor PDF: its pages drawn with pdf.js and printed as images, so it prints the same in every
  // browser (a PDF in a frame doesn't print reliably, e.g. Safari).
  function invPrintHtml(ed, iv) {
    const e = (x) => String(x ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const V = (vid) => (S.byVid && S.byVid.get(vid)) || {};
    const money = (x) => x == null || x === "" || !isFinite(Number(x)) ? "" : Number(x).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
    const rows = iv.rows.filter(r => r.src.description || r.src.item_code || r.vid || r.qty !== "");
    const amt = (r) => { const q = Number(r.qty), c = Number(r.cost); return r.qty !== "" && r.cost !== "" && isFinite(q) && isFinite(c) ? q * c : r.src.amount; };
    const linesSum = rows.filter(r => !r.skip).reduce((a, r) => a + (Number(amt(r)) || 0), 0);
    const units = rows.filter(r => !r.skip && r.account === "inventory").reduce((a, r) => a + (Number(r.qty) || 0), 0);
    const recvd = iv.recvAt ? `Received in full ${e(shortDate(String(iv.recvAt).slice(0, 10)))}` : "Not received in full";
    const paid = iv.paidOn ? `Paid ${e(shortDate(iv.paidOn))}${iv.paidAmount != null ? " · " + money(iv.paidAmount) : ""}${iv.payMethod ? " · " + e(iv.payMethod) : ""}${iv.payRef ? " " + e(iv.payRef) : ""}` : "Not paid";
    const qb = iv.qbo ? `In QuickBooks${iv.qbo.doc ? " · bill " + e(iv.qbo.doc) : ""}` : "Not in QuickBooks";
    const now = new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    const tr = (r, i) => { const v = r.vid ? V(r.vid) : null;
      return `<tr class="${r.skip ? "skip" : ""}"><td class="n m">${i + 1}</td><td class="mono">${e(r.src.item_code)}${r.src.upc ? `<div class="m">UPC ${e(r.src.upc)}</div>` : ""}</td>
        <td>${e(r.src.description)}${v ? `<div class="m">→ ${e(v.title || "")}${v.sku ? " · " + e(v.sku) : ""}</div>` : r.skip ? '<div class="m">not a product (skipped)</div>' : r.account && r.account !== "inventory" ? `<div class="m">${e(r.account)}</div>` : '<div class="m">not matched</div>'}</td>
        <td class="n">${e(r.qty)}</td><td class="n">${money(r.cost === "" ? r.src.unit_cost : r.cost)}</td><td class="n">${money(amt(r))}</td></tr>`; };
    const tot = [["Lines", linesSum], ["Subtotal", iv.subtotal], ["Total", iv.total]].filter(x => x[1] != null && x[1] !== "");
    return `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${e(iv.no || "")} · ${e(ed.vendor || "")}</title><style>
      @page{size:letter;margin:12mm}*{box-sizing:border-box}body{font:11px/1.35 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;margin:0}
      h1{font-size:18px;margin:0}.hd{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #111;padding-bottom:6px;margin-bottom:8px}
      .hd .r{text-align:right}.k{color:#555}.grid{display:grid;grid-template-columns:repeat(4,auto);gap:2px 18px;justify-content:start;margin:6px 0 10px}
      .grid div span{display:block;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:.03em}
      table{width:100%;border-collapse:collapse;font-size:inherit}tr{page-break-inside:avoid}th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:#444;border-bottom:1px solid #111;padding:4px 5px}
      td{border-bottom:1px solid #ccc;padding:5px;vertical-align:top}.n{text-align:right;white-space:nowrap}.m{color:#555;font-size:10px}.mono{font-family:ui-monospace,Menlo,monospace;font-size:10px}
      tr.skip td{color:#777}.tot{margin:8px 0 0 auto;width:260px}.tot td{border:0;padding:2px 5px}.tot tr:last-child td{border-top:1px solid #111;font-weight:700;font-size:12px}
      .st{display:flex;gap:18px;flex-wrap:wrap;margin-top:10px;padding-top:6px;border-top:1px solid #ccc}.notes{margin-top:8px;white-space:pre-wrap}.foot{margin-top:12px;color:#666;font-size:10px}
    </style></head><body>
      <div class="hd"><div><h1>Invoice ${e(iv.no || "(no number)")}</h1><div><b>${e(ed.vendor || "")}</b></div></div>
        <div class="r"><div class="k">Printed ${e(now)} · Seller Sage</div>${iv.fileName ? `<div class="k">Vendor PDF: ${e(iv.fileName)}</div>` : ""}</div></div>
      <div class="grid"><div><span>Invoice date</span>${e(iv.date ? shortDate(iv.date) : "—")}</div><div><span>Due</span>${e(iv.due ? shortDate(iv.due) : "—")}</div>
        <div><span>Terms</span>${e(iv.terms || "—")}</div><div><span>Purchase order</span>${ed.id ? e((ed.po ? poLabel(ed.po) : "PO") + " · #" + ed.id) : "—"}</div></div>
      <table><thead><tr><th class="n">#</th><th>Item</th><th>Description</th><th class="n">Qty</th><th class="n">Unit cost</th><th class="n">Amount</th></tr></thead>
        <tbody>${rows.map(tr).join("") || '<tr><td colspan="6" class="m">No lines.</td></tr>'}</tbody></table>
      <table class="tot"><tbody><tr><td class="k">Units</td><td class="n">${n0(units)}</td></tr>${tot.map(([k, x]) => `<tr><td class="k">${k}</td><td class="n">${money(x)}</td></tr>`).join("")}</tbody></table>
      <div class="st"><span>${recvd}</span><span>${paid}</span><span>${qb}</span></div>
      ${iv.notes ? `<div class="notes"><span class="k">Notes:</span> ${e(iv.notes)}</div>` : ""}
    </body></html>`;
  }
  function printInvoice(ed, iv) {
    if (!iv || !iv.id) { note("warn", "Save the invoice first."); return; }
    printHtml(invPrintHtml(ed, iv));
  }
  async function printVendorPdf(ed, iv) {
    if (!iv) return;
    if (!iv.file && !iv.parts) { note("warn", "There's no vendor PDF on this invoice."); return; }
    S.busy = "Getting the PDF ready to print…"; renderBusy();
    try {
      const bytes = iv.file ? iv.file.bytes : await loadFile(iv);
      const lib = await IP.pdfLib(), doc = await lib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise, imgs = [];
      for (let p = 1; p <= doc.numPages; p++) {
        S.busy = `Getting the PDF ready to print… page ${p} of ${doc.numPages}`; renderBusy();
        const page = await doc.getPage(p), vp = page.getViewport({ scale: 2 });
        const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
        await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        imgs.push(c.toDataURL("image/png"));
      }
      S.busy = ""; renderBusy();
      const t = `Invoice ${iv.no || ""} · ${ed.vendor || ""}`.replace(/[&<>"]/g, "");
      printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>${t}</title><style>@page{margin:0}body{margin:0}img{display:block;width:100%;height:auto;page-break-after:always}img:last-child{page-break-after:auto}</style></head><body>${imgs.map(u => `<img src="${u}" alt="">`).join("")}</body></html>`, 600);
    } catch (e) { S.busy = ""; renderBusy(); note("bad", "Couldn't print the PDF: " + esc(JT.message ? JT.message(e) : (e && e.message) || "unknown error")); }
  }
  function printHtml(html, wait) {
    const f = document.createElement("iframe");
    f.setAttribute("aria-hidden", "true"); f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(f);
    const d = f.contentWindow.document; d.open(); d.write(html); d.close();
    setTimeout(() => {
      try { f.contentWindow.focus(); f.contentWindow.print(); }
      catch (_) {   // printing blocked here: open it in a window instead
        const w = window.open("", "_blank"); if (w) { w.document.write(html); w.document.close(); w.focus(); w.print(); } else note("warn", "Your browser blocked printing from this page.");
      }
      setTimeout(() => f.remove(), 60000);
    }, wait || 250);
  }
  // category and budget (migration 162): saved as soon as they're changed; what's ordered and invoiced against the budget
  function planHtml(ed, ro) {
    if (!ed.id || !ed.planOn) return "";
    const ordered = ed.lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0);
    const invoiced = ed.invoices.filter(v => v.id && !v.isNew).reduce((a, v) => a + (v.total != null ? v.total : v.subtotal || 0), 0);
    const b = ed.budget, used = Math.max(ordered, invoiced), pct = b ? Math.min(100, Math.round(used / b * 100)) : 0;
    const gaps = ed.placeholder ? [!ed.category && "No category", b == null && "No budget"].filter(Boolean) : [];   // flagged on placeholders
    return `<div class="po-plan">
      ${ed.placeholder && !ed.lines.length ? '<span class="pill other" title="Made as a placeholder: put invoices on it and their products fill it out">Placeholder</span>' : ""}
      <label class="small">Category <input class="inp sm" id="pe-cat" list="pe-cats" value="${esc(ed.category)}" placeholder="add a category" ${ro ? "disabled" : ""} style="width:150px"><datalist id="pe-cats">${catOptions()}</datalist></label>
      <label class="small">Budget $<input class="inp sm num" id="pe-budget" value="${b == null ? "" : esc(String(b))}" placeholder="add a budget" inputmode="decimal" ${ro ? "disabled" : ""} style="width:100px"></label>
      ${b != null ? `<span class="po-bud" title="Ordered ${m0(ordered)} · invoiced ${m0(invoiced)}"><span class="po-bar"><span style="width:${pct}%" class="${used > b ? "over" : ""}"></span></span>
        <span class="small">${ordered ? `${m0(ordered)} ordered · ` : ""}${m0(invoiced)} invoiced · <b class="${used > b ? "neg" : ""}">${used > b ? `${m0(used - b)} over` : `${m0(b - used)} left`}</b> of ${m0(b)}</span></span>` : ""}
      ${gaps.map(g => `<span class="pill warn">${g}</span>`).join("")}
      ${ed.missingInv ? `<span class="pill warn" title="Flagged ${esc(when(ed.missingAt))}${ed.missingBy ? " by " + esc(ed.missingBy.split("@")[0]) : ""} — clears by itself when an invoice is put on this order">Missing invoice</span>${ro ? "" : '<button class="linkbtn small" data-pact="miss-off">clear</button>'}`
        : !ro && !ed.invoices.some(v => v.id && !v.isNew) ? '<button class="linkbtn small" data-pact="miss-on" title="Goods came in and there\'s no invoice for them yet">Flag: invoice missing</button>' : ""}</div>`;
  }
  async function savePlan(ed, field, val) {
    const p = { id: Number(ed.id) };
    if (field === "category") p.category = val.trim();
    else { const b = val.replace(/[$,\s]/g, ""); if (b !== "" && !(Number(b) >= 0)) { note("warn", "The budget needs to be a number, like 10000."); return; } p.budget = b; }
    try { await planCall("jt_po_plan_set", "jt.po_plan_set", p);
      if (field === "category") ed.category = p.category; else ed.budget = p.budget === "" ? null : Number(p.budget);
      const o = (S.orders || []).find(x => x.id === ed.id); if (o) { o.category = ed.category; o.budget = ed.budget; }
      render();
    } catch (e) { note("bad", "Couldn't save it: " + esc(JT.message(e))); }
  }
  // received in Seller Sage and on the Shopify PO as well: Shopify has those units twice (migration 161)
  function doubleHtml(ed) {
    const d = Object.entries(ed.recvDouble || {}).filter(([, n]) => +n > 0); if (!d.length) return "";
    const name = (vid) => { const v = S.byVid && S.byVid.get(vid); return v ? (v.title || v.sku) : "product " + vid; };
    const units = d.reduce((a, [, n]) => a + +n, 0);
    return `<div class="note bad"><b>Received twice:</b> ${n0(units)} unit${units === 1 ? " was" : "s were"} received here and on the Shopify PO too, so Shopify counted ${units === 1 ? "it" : "them"} twice — ${d.slice(0, 4).map(([v, n]) => `${esc(name(v))} ×${n0(n)}`).join(", ")}${d.length > 4 ? "…" : ""}.
      Receive in Seller Sage only (the Shopify PO is just the record). <button class="mini primary" data-pact="fix-double" ${S.busy ? "disabled" : ""}>Take the extra out of Shopify</button></div>`;
  }
  // the vendor's open POs ranked by how many of these products they have still to come (to spot the open order
  // before starting another PO — Brian, Oct 20). vids = the invoice's matched products. -> [{o, shared, open}]
  async function rankOpenPOs(vendor, vids, skipId) {
    const want = new Set((vids || []).filter(Boolean).map(String));
    const open = (S.orders || []).filter(o => o.status !== "complete" && o.id !== skipId && (!vendor || o.vendor.toLowerCase() === vendor.toLowerCase()));
    if (!want.size || !open.length) return open.map(o => ({ o, shared: 0, open: 0 }));
    const r = await JT.rows(["order_id::text", "variant_id::text", "sum(qty_ordered)", "sum(qty_received)"],
      `from jt.prep_order_lines where order_id in (${open.map(o => JT.int(o.id)).join(",")}) group by 1, 2`, true).catch(() => []);
    const by = new Map(open.map(o => [o.id, { o, shared: 0, open: 0 }]));
    for (const [oid, vid, qo, qr] of r) { const x = by.get(oid); if (x && want.has(vid)) { x.shared++; x.open += Math.max(0, (+qo || 0) - (+qr || 0)); } }
    return [...by.values()].sort((a, b) => b.shared - a.shared || b.open - a.open);
  }
  const rankHtml = (rk, nWant, act) => { const top = rk.filter(x => x.shared > 0).slice(0, 3); if (!top.length) return "";
    return `<div class="po-rank">${top.map((x, i) => `<div class="po-rank-row ${i === 0 && x.shared * 2 >= nWant ? "best" : ""}"><b>${esc(x.o.vendor)} ${esc(x.o.po ? poLabel(x.o.po) : "#" + x.o.id)}</b>
      <span class="small muted">${esc(STAGE.get(x.o.status))} · ${n0(x.shared)} of ${n0(nWant)} products on this invoice${x.open ? ` · ${n0(x.open)} unit${x.open === 1 ? "" : "s"} still to come` : " · nothing left to come"}</span>
      <button class="mini ${i === 0 ? "primary" : ""}" ${act}="${esc(x.o.id)}">Use this PO</button></div>`).join("")}</div>`; };
  // picking another PO for a saved invoice (open POs, same vendor first)
  function moveHtml(ed) {
    const all = (S.orders || []).filter(o => o.id !== ed.id && o.status !== "complete");
    const same = all.filter(o => o.vendor.toLowerCase() === (ed.vendor || "").toLowerCase()), rest = all.filter(o => !same.includes(o));
    const opt = (o) => `<option value="${esc(o.id)}">${esc(o.vendor)} · ${esc(o.po ? poLabel(o.po) : "#" + o.id)} (${esc(STAGE.get(o.status))})</option>`;
    const iv = cur(ed), got = iv ? invTot(iv).g : 0;
    return `<div class="note warn">Move this invoice to another purchase order.${got ? ` The ${n0(got)} unit${got === 1 ? "" : "s"} received against it move with it (stock doesn't change; this PO keeps the rest).` : ""}${iv && iv.qbo ? " Its QuickBooks bill isn't changed." : ""}
      ${ed.moveRank ? rankHtml(ed.moveRank.rk, ed.moveRank.n, 'data-pact="inv-move-to" data-k') : ""}
      <select id="pe-movepo" class="inp sm" style="width:auto;max-width:320px">${same.length ? `<optgroup label="${esc(ed.vendor)}">${same.map(opt).join("")}</optgroup>` : ""}${rest.length ? `<optgroup label="Other vendors">${rest.map(opt).join("")}</optgroup>` : ""}</select>
      <span class="dbtns"><button class="mini primary" data-pact="inv-move-go" ${all.length ? "" : "disabled"}>Move it</button><button class="mini" data-pact="no">Cancel</button></span></div>`;
  }
  // ---------- the invoice page's lines (v0.35.0, Brian Oct 28: same look as the PO) ----------
  // Lines lock once the invoice is matched (every line a sure match, a charge or not a product) and saved: "Edit lines"
  // opens them (ed.lineEdit) to change matches, quantities and costs, reorder (drag / Alt+arrows / Reorganize) or add lines.
  const invMatched = (iv) => !!iv.id && !iv.isNew && iv.rows.length > 0 && (() => { const c = count(iv); return !c.check && !c.none; })();
  function invDetailHtml(ed, ro, pdfOn) {
    const iv = cur(ed);
    const lock = ro || iv.status === "applied", c = count(iv);
    const lockL = lock || (invMatched(iv) && !ed.lineEdit);
    if ((iv.filter === "check" && !c.check) || (iv.filter === "none" && !c.none) || (iv.filter === "charge" && !c.skip)) iv.filter = "all";
    const fq = (ed.find || "").trim().toLowerCase();
    const rowText = (r) => { const v = variant(r.vid) || {}; return [r.src.item_code, r.src.upc, r.src.description, v.title, v.sku].join(" ").toLowerCase(); };
    const rows = iv.rows.filter(r => iv.filter === "all" || (iv.filter === "none" ? !r.vid && !r.skip : iv.filter === "check" ? needsCheck(r) : iv.filter === "charge" ? r.skip : true)).filter(r => !fq || rowText(r).includes(fq));
    const t = invTot(iv), iss = invIssues(ed, iv);
    const gotShown = new Set();
    // not for resale (demo units): the PO line's place is 'demo' — received, never added to inventory (migration 172)
    const demoCell = (r) => { if (!r.vid || r.skip || ed.alone) return ""; const l = ed.lines.find(x => String(x.vid) === String(r.vid)); if (!l) return "";
      if (lockL || l.received > 0) return l.dest === "demo" ? '<div><span class="pill other" title="Received, not added to inventory">Not for resale</span></div>' : "";
      return `<label class="inline small ivdemo"><input type="checkbox" data-f="ivdemo" data-k="${r.id}" ${l.dest === "demo" ? "checked" : ""}> Not for resale (demo)</label>`; };
    const rowsH = rows.map(r => {
      const badQ = r.qty !== "" && isNaN(Number(r.qty)), badC = r.cost !== "" && !(Number(r.cost) >= 0);
      const cls = r.skip ? "skipped" : !r.vid ? "nomatch" : needsCheck(r) ? "guess" : "";
      const n = iv.rows.indexOf(r) + 1;
      let got = '<span class="dim">—</span>';
      if (r.vid && !r.skip && iv.got && !gotShown.has(r.vid)) { gotShown.add(r.vid); const g = iv.got.get(r.vid) || 0, q = Number(r.qty) || 0; got = `<span class="${g >= q && q > 0 ? "okt" : g > 0 ? "warnt" : "dim"}">${n0(g)}</span>`; }
      const handle = !lockL && iv.rows.length > 1 ? `<button type="button" class="dragh" id="drag-${r.id}" draggable="true" data-drag="${r.id}" data-dkind="row" aria-label="Move line ${n}: drag it, or Alt+Up / Alt+Down" title="Drag to reorder (or Alt+↑ / Alt+↓)"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></button>` : "";
      return `<tr class="${cls} ${handle ? "dragrow" : ""}" data-row="${r.id}">
        <td class="l nowrap ivn">${handle}<span class="muted">${n}</span></td>
        <td class="l inv">${r.src.item_code ? `<span class="mono">${esc(r.src.item_code)}</span>` : ""}${r.src.upc ? ` <span class="mono dim small">${esc(r.src.upc)}</span>` : ""}<div class="small">${esc(r.src.description) || '<span class="dim">no description</span>'}</div></td>
        <td class="l match">${matchCell(ed, r, lockL)}${demoCell(r)}</td>
        <td>${!lockL ? `<input class="inp num sm ${badQ ? "bad" : ""}" data-f="iqty" data-k="${r.id}" value="${esc(r.qty)}" inputmode="decimal" style="width:64px">` : esc(r.qty)}</td>
        <td>${got}</td>
        <td>${!lockL ? `<input class="inp num sm ${badC ? "bad" : ""}" data-f="icost" data-k="${r.id}" value="${esc(r.cost)}" inputmode="decimal" style="width:76px">` : m(Number(r.cost))}</td>
        <td>${m(rowAmt(r))}</td>
        <td class="l small">${!lockL ? `<select class="inp sm" data-f="acct" data-k="${r.id}" style="width:auto;max-width:130px">${ACCOUNTS.map(([k, nm]) => `<option value="${k}" ${(r.account || "inventory") === k ? "selected" : ""}>${nm}</option>`).join("")}</select>` : esc((ACCOUNTS.find(([k]) => k === (r.account || "inventory")) || [, "Inventory"])[1])}</td>
        <td>${!lockL ? `<button class="linkbtn small" data-pact="rmrow" data-k="${r.id}" title="Remove this invoice line" aria-label="Remove line">✕</button>` : ""}</td></tr>`;
    }).join("");
    const FN = { all: "All lines", check: "Guesses to check", none: "Not matched", charge: "Charges" };
    const fseg = (k, label, n) => `<button data-ifilter="${k}" aria-pressed="${(iv.filter || "all") === k}">${label} <span class="cnt">${n0(n)}</span></button>`;
    const flLeft = `<span class="seg sm" role="group" aria-label="Show lines">${fseg("all", "All", iv.rows.length)}${c.check ? fseg("check", "Guesses to check", c.check) : ""}${c.none ? fseg("none", "Not matched", c.none) : ""}${c.skip ? fseg("charge", "Charges", c.skip) : ""}</span>${fq ? `<span class="muted small">${rows.length} found</span>` : ""}`;
    const canRecvIv = ed.id && iv.id && !iv.isNew && !iv.recvAt && t.b > t.g && !c.check;
    const canMoreIv = ed.id && iv.id && !iv.isNew && !c.check && !canRecvIv && t.b > 0;
    const tools = lock ? "" : lockL
      ? `<span class="iv-lock"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg> Matched to the vendor invoice</span><button class="btn" data-pact="lines-edit" title="Change matches, quantities, costs or the order of the lines">Edit lines</button>`
      : `${iv.rows.length > 1 ? `<select id="inv-arrange" class="inp sm" aria-label="Reorganize the lines"><option value="">Reorganize lines…</option><option value="vendor">Match vendor invoice</option>${ed.lines.length ? '<option value="order">Match order</option>' : ""}<option value="cat">Group by category</option><option value="name">Group by product</option></select>` : ""}${invMatched(iv) && ed.lineEdit ? '<button class="btn" data-pact="lines-done">Done editing</button>' : ""}`;
    return `
      ${ed.confirm === "rminv" && ed.alone ? `<div class="note warn">${iv.id ? `Delete invoice ${esc(iv.no || "")}? It's removed for good.` : `Discard invoice ${esc(iv.no || "")}?`} <span class="dbtns"><button class="mini primary" data-pact="do-rminv">Yes, ${iv.id ? "delete" : "discard"} it</button><button class="mini" data-pact="no">Cancel</button></span></div>`
      : ed.confirm === "rminv" ? `<div class="note warn">${iv.isNew ? `Discard invoice ${esc(iv.no || "")}?` : `Delete invoice ${esc(iv.no || "")}? ${iv.status === "applied" ? "It was applied earlier, so it's only detached from the PO." : "It's deleted when you save."}`} Products added to the PO from it go too. <span class="dbtns"><button class="mini primary" data-pact="do-rminv">Yes, remove it</button><button class="mini" data-pact="no">Cancel</button></span></div>` : ""}
      ${iss.length ? window.JTIssues.issuesHtml(iss) : ""}
      ${iv.fromPo && !lockL && iv.rows.some(r => r.fromPo) ? `<div class="note info frompo">Lines filled in from the PO (the invoice's own lines couldn't be read). Compare them with the PDF${pdfOn ? " alongside" : ""}: fix any quantity or cost that's different, and remove products that aren't on this invoice. <span class="dbtns">${iv.rows.some(r => !r.vid && !r.skip) ? `<button class="mini" data-pact="dropunread">Remove the ${iv.rows.filter(r => !r.vid && !r.skip).length} unmatched line${iv.rows.filter(r => !r.vid && !r.skip).length === 1 ? "" : "s"}</button>` : ""}<button class="mini" data-pact="clearpo">Clear the PO lines</button></span></div>` : ""}
      <div class="po2-filter"><span class="po2-fl">${flLeft}</span><span class="po2-fr">${tools}${iv.file || iv.parts ? `<button class="btn" data-pact="pdf" aria-pressed="${!!ed.showPdf}">${ed.showPdf ? "Hide PDF" : "Show PDF beside"}</button>` : ""}${iv.rows.length ? `<input id="po-find" class="inp sm" type="search" placeholder="Find item or product" value="${esc(ed.find || "")}" aria-label="Find a line on this invoice">` : ""}${canRecvIv ? `<button class="btn primary po2-recv" data-pact="rq-start" ${S.busy ? "disabled" : ""}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg> Receive · ${n0(t.b - t.g)} left</button>` : canMoreIv ? `<button class="btn po2-recv" data-pact="rq-start" title="Receive extra units, more than the invoice shows">Receive more</button>` : ""}</span></div>
      <div class="po-body ${pdfOn ? "with-pdf" : ""}">
        <div class="po-ivlines">
          ${iv.rows.length ? `<div class="tbl-wrap"><table class="prept po-t iv-t"><thead><tr><th class="l">#</th><th class="l">On the invoice</th><th class="l">Shopify product</th><th>Qty</th><th>Received</th><th>Unit cost</th><th>Ext.</th><th class="l">Account</th><th></th></tr></thead><tbody>${rowsH || `<tr><td colspan="9" class="l muted small">No lines here.</td></tr>`}</tbody></table></div>` : '<div class="muted small">No lines yet.</div>'}
          ${!lockL ? `<div class="row">${!ed.alone && poRows(ed, iv).length ? `<button class="btn ${iv.rows.some(r => r.vid && !r.skip) ? "" : "primary"}" data-pact="fillpo" title="Add every product still open on the PO that isn't on this invoice, at the PO's quantity and cost">Fill from the PO</button>` : ""}<button class="btn" data-pact="addrow">Add line</button><button class="btn" data-pact="addcharge">Add charge (freight in)</button><span class="muted small">Freight or shipping on the invoice goes to Inbound Shipping.</span></div>` : ""}
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
    if (ed.alone) return `<div class="qb"><div class="qb-head"><b>QuickBooks</b><span class="qb-state muted small">Send the bill once the invoice is on its purchase order.</span><button class="mini" data-pact="qbcopy" title="Copy the bill details">Copy</button></div></div>`;
    const ba = byAccount(iv), diff = iv.total != null ? Math.round((iv.total - ba.all) * 100) / 100 : null;
    return `<div class="qb"><div class="qb-head"><b>QuickBooks</b><span class="qb-state">${qbState(ed, iv, ba, diff)}</span><button class="mini" data-pact="qbcopy" title="Copy the bill details">Copy</button></div>${qbPick(ed, iv)}
      <div class="qb-line small" title="Vendor, bill number, dates and terms are the invoice's own (above)">Bill to <b>${esc(ed.vendor || "—")}</b> · no. <span class="mono">${esc(iv.no || "—")}</span>${ed.po ? ` · memo <span class="mono">${esc(ed.po)}</span>` : ""} · ${iv.paidOn ? esc(payTxt(iv)) : "unpaid"}</div>
      <table class="qb-t"><thead><tr><th class="l">Account</th><th>Amount</th></tr></thead><tbody>${ACCOUNTS.filter(([k]) => Math.abs(ba.out.get(k) || 0) >= 0.005 || k === "inventory").map(([k, n]) => `<tr><td class="l">${n}</td><td>${m(ba.out.get(k) || 0)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td class="l">Total</td><td>${m(ba.all)}</td></tr>${diff != null ? `<tr class="${Math.abs(diff) >= 0.01 ? "off" : "ok"}"><td class="l">Invoice total</td><td>${m(iv.total)}${Math.abs(diff) >= 0.01 ? ` <span class="small">(${diff > 0 ? "+" : ""}${m(diff)} not assigned)</span>` : ' <span class="small">✓ matches</span>'}</td></tr>` : ""}</tfoot></table></div>`;
  }
  // one line for the invoice page (v0.36.2: "let's make this more compact"); "Show bill" opens the full breakdown
  function qbLine(ed, iv) {
    if (!iv.rows.length) return "";
    if (ed.alone || ed.qbOpen) return qbHtml(ed, iv) + (ed.alone ? "" : '<button class="linkbtn small" data-pact="qb-more">Hide bill</button>');
    const ba = byAccount(iv), diff = iv.total != null ? Math.round((iv.total - ba.all) * 100) / 100 : null;
    const parts = ACCOUNTS.filter(([k]) => Math.abs(ba.out.get(k) || 0) >= 0.005 || k === "inventory").map(([k, n]) => `${n} ${m(ba.out.get(k) || 0)}`).join(" · ");
    return `<div class="ivm-qb"><b>QuickBooks</b><span class="qb-state">${qbState(ed, iv, ba, diff)}</span><span class="small muted">${parts}${diff != null ? (Math.abs(diff) >= 0.01 ? ` · <span class="warnt">${diff > 0 ? "+" : ""}${m(diff)} not assigned</span>` : ' · <span class="okt">✓ matches the total</span>') : ""}</span>
      <span class="dbtns"><button class="mini" data-pact="qbcopy" title="Copy the bill details">Copy</button><button class="linkbtn small" data-pact="qb-more">Show bill</button></span></div>${qbPick(ed, iv)}`;
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
    if (ed.recv) return `<button class="btn" data-pact="recv-cancel">Cancel</button><button class="btn primary" data-pact="recv-go" ${busy}>Save</button>`;
    const ivR = ed.view === "inv" && cur(ed);
    if (ivR && ivR.id && ed.recvInv === ivR.id && !ivR.recvAt && true)
      return `<button class="btn" data-pact="rq-stop">Cancel</button><button class="btn primary" data-pact="rq-all" ${busy}>Save</button>`;
    const out = [];
    if (ed.id && PREV[ed.status]) out.push(`<button class="btn" data-pact="back">← Back to ${STAGE.get(PREV[ed.status]).toLowerCase()}</button>`);
    if (ed.id && PRE.includes(ed.status) && !ed.lines.some(l => l.received > 0)) out.push(`<button class="btn" data-pact="del">Delete</button>`);
    // a draft is approved (Ready to approve → Ordered: approving marks it ordered)
    // Draft → Ready to approve → approved (Oct 29): the order says when it's ready; approving still works from either
    // Brian, Oct 29: "I like 'Save', 'Ready to Order', and 'Approve'" (each one saves first when there are changes)
    if (ed.status === "draft" && !ed.approvedAt) {
      out.push(`<button class="btn" data-pact="save" ${busy || (!ed.dirty && ed.id ? "disabled" : "")} title="Save this order (⌘S / Ctrl+S)">Save</button>`);
      if (ed.readyAt) out.push(`<button class="btn" data-pact="unready" ${busy} title="Still working on it: back to Draft">Back to draft</button>`);
      else out.push(`<button class="btn primary" data-pact="ready" ${busy} title="Done putting it together: saves it and shows it as Ready to approve">Ready to Order</button>`);
      out.push(`<button class="btn ${ed.readyAt ? "primary" : ""}" data-pact="save-approve" ${busy} title="Saves it, approves it and marks it ordered: it moves to Ordered">Approve</button>`);
    }
    else if (NEXT[ed.status]) out.push(`<button class="btn primary" data-pact="save-next" ${busy}>Save &amp; ${NEXT[ed.status][1].replace(/^M/, "m")}</button>`);
    // each invoice still to receive: a button that opens it ready to receive (from any view; on its own view the
    // receive table has its own buttons)
    if (false)
      ed.invoices.forEach((iv, i) => { if (!iv.id || iv.isNew || iv.recvAt || (ed.view === "inv" && i === ed.cur)) return; const t = invTot(iv); if (!(t.b > t.g)) return;
        out.push(`<button class="btn primary" data-pact="recv-inv" data-k="${i}" ${busy}>Receive invoice ${esc(iv.no || "#" + (i + 1))}</button>`); });
    // invoiced products are received on their invoice; this receives what isn't on one
    const anyInv = ed.invoices.length > 0, pr = progress(ed), notInv = ed.lines.some(l => pr.get(l.id).open > 0);
    if (ed.lines.length && true && (!anyInv || notInv)) out.push(`<button class="btn" data-pact="recv" ${busy}>${anyInv ? "Receive without an invoice…" : got ? "Receive more…" : "Receive…"}</button>`);
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
          dest: l ? l.dest : "prep", amazon_sku: l && l.dest === "prep" ? l.asku || "" : "", account: r.account || "inventory", vendor_no: r.vno == null ? null : r.vno }; }) }));
    const remember = [];
    for (const iv of ed.invoices) for (const r of iv.rows) if (r.src.item_code && r.vid && isSure(r) && r.how !== "sku" && r.how !== "po") remember.push({ item_code: r.src.item_code, variant_id: Number(r.vid) });
    return { order: { id: ed.id ? Number(ed.id) : null, vendor: ed.vendor.trim(), po_no: ed.po.trim(), kind: ed.kind, place_by: ed.placeBy || "", expected_on: ed.expected || "", note: ed.note, short_ok: !!ed.shortOk, no_shopify_po: !!ed.noShop, receive_into: ed.dest === "both" ? "both" : ed.dest, },
      lines, invoices, remove_invoices: ed.removed.map(Number), remember };
  }
  function problems(ed) {
    const bad = ed.lines.find(l => l.qty !== "" && !(Number.isInteger(Number(l.qty)) && Number(l.qty) >= 0) || l.cost !== "" && !(Number(l.cost) >= 0));
    if (bad) return `Check the quantity and cost for ${esc((variant(bad.vid) || {}).title || "a product")} — quantities are whole numbers.`;
    const under = ed.lines.find(l => (l.received || 0) > (Number(l.qty) || 0));
    if (under) return `${esc((variant(under.vid) || {}).title || "A product")}: ${n0(under.received)} were already received, so the PO can't order fewer.`;
    for (const iv of ed.invoices) { const b = iv.rows.find(r => r.qty !== "" && isNaN(Number(r.qty)) || r.cost !== "" && !(Number(r.cost) >= 0)); if (b) return `Check the quantity and cost on invoice ${esc(iv.no || "")}: ${esc(b.src.description || b.src.item_code)}.`; }
    if (!ed.vendor.trim()) return "Enter the vendor.";
    const seen = new Set(); for (const l of ed.lines) { const k = keyOf(l); if (seen.has(k)) return `${esc((variant(l.vid) || {}).title || "A product")} is on the PO twice for the same place. Take one off.`; seen.add(k); }
    return "";
  }
  async function save(next, quiet) {
    const ed = S.ed; if (!ed || S.busy) return null;
    if (ed.alone) return saveAlone(quiet);
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
  // ---------- receiving popup (Brian, Oct 27: "move to a pop up when you go to receive ... input a number / receive
  // each row individually as well as a receive all button ... a save button that asks to save/discard then commits") ----
  // Nothing is written while the popup is open: rows are filled in (a number, the row's "All", or "Receive all"), and
  // Save receives everything entered in one go — into Shopify's stock / the prep center — then the PO reloads once.
  // S.rm = { inv: invoice id | null, rows: [{ k, lid, title, sku, dest, asku, billed, got, left, val }], ask: false }
  function rmHost() {
    let d = $("rcv-modal"); if (d) return d;
    d = document.createElement("div"); d.className = "modal"; d.id = "rcv-modal"; d.hidden = true;
    d.innerHTML = '<div class="modal-card rcv-card" id="rcv-card" role="dialog" aria-modal="true" aria-label="Receive"></div>';
    document.body.appendChild(d);
    d.addEventListener("click", (e) => {
      if (e.target === d) return rmClose();
      const b = e.target.closest("button"); if (!b || !S.rm) return;
      const a = b.dataset.rm, r = S.rm.rows[Number(b.dataset.i)];
      if (a === "close") return rmClose();
      if (a === "one" && r) { r.val = String(r.left); S.rm.ask = false; rmPaint(); rmFocus(Number(b.dataset.i) + 1); return; }
      if (a === "zero" && r) { r.val = ""; S.rm.ask = false; rmPaint(); return; }
      if (a === "all") { S.rm.rows.forEach(x => { x.val = String(x.left); }); S.rm.ask = false; rmPaint(); return; }
      if (a === "clear") { S.rm.rows.forEach(x => { x.val = ""; }); S.rm.ask = false; rmPaint(); return; }
      if (a === "save") { if (rmBad()) return rmPaint(); if (!rmUnits()) { S.rm.msg = "Enter how many arrived, or press Receive all."; return rmPaint(); } S.rm.ask = "save"; rmPaint(); return; }
      if (a === "back") { S.rm.ask = false; rmPaint(); return; }
      if (a === "discard") { S.rm = null; d.hidden = true; document.body.classList.remove("modal-open"); return; }
      if (a === "commit") return rmCommit();
    });
    d.addEventListener("change", (e) => {
      if (e.target.id !== "rcv-more" || !S.rm || !S.ed) return; const l = S.ed.lines.find(x => x.id === e.target.value); if (!l) return;
      const v = variant(l.vid) || {}, pr = progress(S.ed).get(l.id) || { ordered: 0, received: 0 };
      S.rm.rows.push({ k: keyOf(l), lid: l.id, title: v.title || "variant " + l.vid, sku: v.sku || "", dest: l.dest || "prep", asku: l.asku || "", billed: 0, got: pr.received || 0, left: 0, val: "" });
      S.rm.ask = false; rmPaint(); rmFocus(S.rm.rows.length - 1);
    });
    d.addEventListener("input", (e) => {
      const t = e.target; if (!S.rm || t.dataset.rmq == null) return;
      const r = S.rm.rows[Number(t.dataset.rmq)]; if (!r) return;
      r.val = t.value.trim(); S.rm.ask = false; S.rm.msg = "";
      rmFoot(); t.classList.toggle("bad", rmRowBad(r));
      const tr = t.closest("tr"); if (tr) tr.classList.toggle("on", Number(r.val) > 0);
    });
    d.addEventListener("keydown", (e) => {
      if (!S.rm) return;
      if (e.key === "Escape") { e.preventDefault(); return rmClose(); }
      if (e.key === "Enter" && e.target.dataset.rmq != null) { e.preventDefault(); rmFocus(Number(e.target.dataset.rmq) + 1); }
    });
    return d;
  }
  const rmRowBad = (r) => r.val !== "" && !(Number.isInteger(Number(r.val)) && Number(r.val) >= 0);
  const rmBad = () => { const b = S.rm.rows.find(rmRowBad); if (b) S.rm.msg = `Check the number for ${b.title}: whole units only.`; return !!b; };
  const rmUnits = () => S.rm.rows.reduce((a, r) => a + (rmRowBad(r) ? 0 : Number(r.val) || 0), 0);
  const rmDirty = () => S.rm && S.rm.rows.some(r => (Number(r.val) || 0) > 0);
  function rmFocus(i) { setTimeout(() => { const el = document.querySelector(`#rcv-modal [data-rmq="${i}"]`); if (el) { el.focus(); el.select(); } else { const b = document.querySelector('#rcv-modal [data-rm="save"]'); if (b) b.focus(); } }, 0); }
  function rmClose() { if (!S.rm) return; if (rmDirty()) { S.rm.ask = "close"; rmPaint(); return; } S.rm = null; $("rcv-modal").hidden = true; document.body.classList.remove("modal-open"); }
  function openRecv(invId) {
    const ed = S.ed; if (!ed) return;
    const iv = invId ? ed.invoices.find(v => String(v.id) === String(invId)) : null;
    const rows = [];
    if (iv) {
      if (count(iv).check) { note("warn", `Confirm the guessed products on invoice ${esc(iv.no || "")} before receiving it, so the right stock comes in. <button class="mini" data-pact="open-inv">Open the invoice</button>`); return; }
      const sh = invShares(ed, iv);
      for (const l of ed.lines) { const y = sh.get(l.id); if (y && y.billed > 0) rows.push({ l, billed: y.billed, got: y.got, left: y.left }); }
    } else {
      const pr = progress(ed), anyInv = ed.invoices.length > 0;
      for (const l of ed.lines) { const p = pr.get(l.id), left = anyInv ? Math.min(p.open, Math.max(0, p.ordered - p.received)) : Math.max(0, p.ordered - p.received);
        if (left > 0 || !anyInv) rows.push({ l, billed: p.ordered, got: p.received, left }); }
    }
    S.rm = { inv: iv ? iv.id : null, invNo: iv ? iv.no || "" : "", ask: false, msg: "",
      rows: rows.map(({ l, billed, got, left }) => { const v = variant(l.vid) || {};
        return { k: keyOf(l), lid: l.id, title: v.title || l.title || "variant " + l.vid, sku: v.sku || "", dest: l.dest || "prep", asku: l.asku || "", billed, got, left, val: "" }; })
        .sort((a, b) => (b.left > 0) - (a.left > 0)) };
    rmHost().hidden = false; document.body.classList.add("modal-open"); rmPaint(); rmFocus(0);
  }
  function rmFoot() {
    const f = $("rcv-foot"); if (!f || !S.rm) return;
    const u = rmUnits(), rows = S.rm.rows.filter(r => (Number(r.val) || 0) > 0 && !rmRowBad(r)).length;
    f.querySelector(".rcv-sum").textContent = u ? `${n0(u)} unit${u === 1 ? "" : "s"} on ${rows} product${rows === 1 ? "" : "s"} to receive` : "Nothing entered yet";
    const b = f.querySelector('[data-rm="save"]'); if (b) b.textContent = u ? `Save — receive ${n0(u)} unit${u === 1 ? "" : "s"}` : "Save";
  }
  function rmPaint() {
    const c = $("rcv-card"); if (!c || !S.rm) return;
    const R = S.rm, ed = S.ed, left = R.rows.reduce((a, r) => a + r.left, 0), u = rmUnits();
    const over = R.rows.filter(r => !rmRowBad(r) && Number(r.val) > r.left);
    const dests = [...new Set(R.rows.filter(r => Number(r.val) > 0 && r.dest !== "demo").map(r => r.dest))].map(d => DESTN[d] || d);
    const demoN = R.rows.filter(r => r.dest === "demo" && !rmRowBad(r)).reduce((a, r) => a + (Number(r.val) || 0), 0);
    const extra = over.reduce((a, r) => a + Number(r.val) - r.left, 0);
    const row = (r, i) => `<tr class="${Number(r.val) > 0 ? "on" : ""}"><td class="l"><b>${esc(r.title)}</b><div class="meta mono">${esc(r.sku || "no SKU")}${r.dest === "prep" && r.asku ? " · " + esc(r.asku) : ""}</div></td>
      <td class="l small">${esc(DESTN[r.dest] || r.dest)}</td><td>${n0(r.billed)}</td><td>${r.got ? n0(r.got) : '<span class="dim">—</span>'}</td><td>${r.left ? n0(r.left) : '<span class="pill ok">All in</span>'}</td>
      <td class="rcv"><input class="inp num sm ${rmRowBad(r) ? "bad" : ""}" data-rmq="${i}" value="${esc(r.val)}" inputmode="numeric" placeholder="0" style="width:68px" aria-label="Arrived now: ${esc(r.title)}">${Number(r.val) > r.left && !rmRowBad(r) ? `<div class="meta">+${n0(Number(r.val) - r.left)} extra</div>` : ""}</td>
      <td class="l nowrap">${r.left > 0 ? `<button class="mini" data-rm="one" data-i="${i}" title="Receive all ${n0(r.left)} still to come">All ${n0(r.left)}</button>` : ""}${r.val !== "" ? ` <button class="linkbtn small" data-rm="zero" data-i="${i}" title="Clear this row">clear</button>` : ""}</td></tr>`;
    const ask = R.ask ? `<div class="note ${R.ask === "close" ? "warn" : "info"} rcv-ask"><b>${R.ask === "close" ? "You've entered units that aren't received yet." : `Receive ${n0(u)} unit${u === 1 ? "" : "s"}?`}</b>
        ${R.ask === "save" ? `${dests.length ? ` They go into ${esc(dests.join(" and "))} now${dests.includes("Shopify store") ? " (Shopify updates in a minute)" : ""}.` : ""}${demoN ? ` ${n0(demoN)} not-for-resale unit${demoN === 1 ? " is" : "s are"} recorded only — not added to inventory.` : ""}${extra ? ` ${n0(extra)} unit${extra === 1 ? " is" : "s are"} more than ${R.inv ? "the invoice shows" : "ordered"} — they're received on the PO as extra.` : ""}` : " Save receives them; Discard closes without receiving."}
        <span class="dbtns"><button class="btn primary" data-rm="commit" ${S.busy ? "disabled" : ""}>${S.busy === "Receiving…" ? "Receiving…" : "Save"}</button><button class="btn" data-rm="discard">Discard</button><button class="btn" data-rm="back">Keep editing</button></span></div>` : "";
    c.innerHTML = `<div class="panel-head"><h2>${R.inv ? `Receive invoice ${esc(R.invNo)}` : "Receive"} <span class="muted small">· ${esc(ed.vendor || "")} ${esc(ed.po ? poLabel(ed.po) : "")}</span></h2><button class="mini" data-rm="close">Close</button></div>
      <div class="row small"><span class="muted">${n0(left)} unit${left === 1 ? "" : "s"} still to come${R.inv ? " on this invoice" : ""}. Enter what arrived on each row, or receive everything at once. Nothing is received until you Save.</span>
        <span class="dbtns right"><button class="btn" data-rm="all" ${left ? "" : "disabled"}>Receive all (${n0(left)})</button><button class="btn" data-rm="clear">Clear</button></span></div>
      ${R.msg ? `<div class="note warn small">${esc(R.msg)}</div>` : ""}
      ${(() => { const have = new Set(R.rows.map(r => r.lid)), more = (ed.lines || []).filter(l => !have.has(l.id));
        return more.length ? `<label class="row small rcv-add">Something else came in<select id="rcv-more" class="inp sm" aria-label="Add another product from this PO"><option value="">+ Another product on this PO…</option>${more.map(l => { const v = variant(l.vid) || {}; return `<option value="${esc(l.id)}">${esc(v.title || "variant " + l.vid)}${v.sku ? " · " + esc(v.sku) : ""} → ${esc(DESTN[l.dest] || l.dest)}</option>`; }).join("")}</select><span class="muted">Not on the PO? Add it to the PO first.</span></label>` : ""; })()}
      <div class="tbl-wrap rcv-wrap"><table class="prept po-t"><thead><tr><th class="l">Product</th><th class="l">For</th><th>${R.inv ? "On invoice" : "Ordered"}</th><th>Received</th><th>Still to come</th><th>Arrived now</th><th></th></tr></thead>
        <tbody>${R.rows.map(row).join("") || `<tr><td colspan="7" class="l muted">Nothing left to receive.</td></tr>`}</tbody></table></div>
      ${ask}
      <div class="row rcv-foot" id="rcv-foot"><span class="rcv-sum small"></span><span class="dbtns right"><button class="btn" data-rm="close">Cancel</button><button class="btn primary" data-rm="save" ${S.busy ? "disabled" : ""}>Save</button></span></div>`;
    rmFoot();
  }
  async function rmCommit() {
    const R = S.rm; if (!R || S.busy) return;
    if (rmBad()) { R.ask = false; return rmPaint(); }
    const obj = {}; for (const r of R.rows) if ((Number(r.val) || 0) > 0) obj[r.k] = String((Number(obj[r.k]) || 0) + Number(r.val));
    if (!Object.keys(obj).length) { R.ask = false; return rmPaint(); }
    S.rm = null; $("rcv-modal").hidden = true; document.body.classList.remove("modal-open");
    await receiveNow(obj, R.inv, false);
  }
  async function receiveNow(obj, invId, stay) {
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
        const was = S.ed.cur; S.ed.cur = S.ed.invoices.indexOf(iv2); S.ed.recvInv = stay && !iv2.recvAt ? iv2.id : null;
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
    S.ed = null; S.lastView = null; note("", ""); pdfToken++; render(); renderList();
  }

  // ---------- events ----------
  // open the PO details form (saved POs keep it folded into the header) and put the cursor in one field
  const HEAD_IDS = new Set(["pe-vendor", "pe-po", "pe-kind", "pe-placeby", "pe-exp", "pe-dest", "pe-note"]);
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
    if (a === "vview-on" || a === "vview-off") { S.vview = a === "vview-on"; render(); return; }
    if (a === "vcost-on" || a === "vcost-off") { S.vnocost = a === "vcost-off"; render(); return; }
    if (a === "vcsv") return vendorCsv(ed);
    if (a === "vpdf") return vendorPdf(ed);
    if (a === "back-list") return leave();
    if (a === "inv-list") return leave();
    if (a === "open-inv") return showInvoicePage();
    if (a === "open-unpaid") { const i = ed.invoices.findIndex(v => !v.paidOn); ed.confirm = false; note("", ""); if (i >= 0) ed.cur = i; return showInvoicePage(); }
    if (a === "open-po") { S.invOpen = false; const b = document.querySelector('.tabs button[data-tab="po"]'); if (b) b.click(); return; }
    if (a === "inv-move") { if (ed.dirty) { note("warn", "Save or discard your changes first."); return; }
      const ivm = cur(ed), vids = ivm ? [...new Set((ivm.rows || []).filter(r => r.vid && isSure(r)).map(r => r.vid))] : [];
      ed.moveRank = null; ed.confirm = "inv-move"; render();
      rankOpenPOs(ed.vendor, vids, ed.id).then(rk => { if (S.ed === ed && ed.confirm === "inv-move") { ed.moveRank = { rk, n: vids.length }; render(); } });
      return; }
    if (a === "fix-double") { fixDouble(ed); return; }
    if (a === "qb-more") { ed.qbOpen = !ed.qbOpen; render(); return; }
    if (a === "lines-edit") { ed.lineEdit = true; render(); return; }
    if (a === "lines-done") { ed.lineEdit = false; ed.search = null; render(); return; }
    if (a === "add-prod") { if (ed.view === "inv" || ed.view === "left") ed.view = "all"; ed.search = null; render(); focusArg("po-add");
      setTimeout(() => { const el = $("po-add"); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); }, 0); return; }
    if (a === "print-slip") { printSlip(ed, cur(ed)); return; }
    if (a === "print-inv") { printInvoice(ed, cur(ed)); return; }
    if (a === "print-pdf") { printVendorPdf(ed, cur(ed)); return; }
    if (a === "copy-link") { const iv2 = cur(ed);
      if (S.mode === "inv" && iv2 && iv2.id) copyLink("#invoices/" + iv2.id, "invoice " + (iv2.no || iv2.id));
      else if (ed.id) copyLink("#po/" + ed.id, `${ed.vendor} ${ed.po ? poLabel(ed.po) : "PO #" + ed.id}`);
      return; }
    if (a === "miss-on" || a === "miss-off") {
      planCall("jt_po_flag_missing_invoice", "jt.po_flag_missing_invoice", { id: Number(ed.id), on: a === "miss-on" })
        .then(() => { ed.missingInv = a === "miss-on"; ed.missingAt = new Date().toISOString(); const o = (S.orders || []).find(x => x.id === ed.id); if (o) o.missingInv = ed.missingInv; render(); })
        .catch(e => note("bad", "Couldn't save it: " + esc(JT.message(e)))); return; }
    if (a === "inv-move-to" && iv && k) { moveInvoice(iv, k); return; }
    if (a === "inv-move-go" && iv) { const to = ($("pe-movepo") || {}).value; if (to) moveInvoice(iv, to); return; }
    if (a === "inv-repick" && S.pend) { const pend = S.pend; ed.leaveOk = true; S.ed = null; S.invOpen = false; render(); return choosePO(pend); }
    if (a === "discard") { ed.leaveOk = true; return leave(); }
    // Discard changes (v0.34.1): reload what's saved and stay on the page
    // no "are you sure": pressing Discard is the choice (Brian, Oct 28)
    if (a === "revert" || a === "revert-yes") {
      const ivId = S.mode === "inv" && S.invOpen && cur(ed) && cur(ed).id && !cur(ed).isNew ? cur(ed).id : null, poId = ed.id, view = ed.view, curI = ed.cur;
      ed.dirty = false; ed.leaveOk = true; S.ed = null; note("", "");
      if (ivId) return openInvoice(ivId).then(() => note("info", "Changes discarded."));
      if (S.mode === "inv" && S.invOpen) return leave();     // a new invoice: back to the list
      if (poId) return openPO(poId).then(() => { if (S.ed) { if (view) S.ed.view = view; if (curI != null && S.ed.invoices[curI]) S.ed.cur = curI; render(); } note("info", "Changes discarded."); });
      return leave();
    }
    if (a === "save") return save(null);
    if (a === "csv-up") { $("po-sheet").click(); return; }
    if (a === "csv-tmpl") return orderTemplate();
    // an invoice without a PO
    if (a === "alone-newpo" && iv) { ed.alone = false; ed.confirm = false; ed.nameIn = true; syncLines(ed); ed.dirty = true; render();
      note("info", `A new purchase order starts from this invoice, with its ${n0(ed.lines.length)} matched product${ed.lines.length === 1 ? "" : "s"}. Name it, then Save.`); setTimeout(() => { const i = $("pe-po"); if (i) i.focus(); }, 0); return; }
    if (a === "alone-link" && iv) { if (ed.dirty || !iv.id) { note("warn", "Save the invoice first, then add it to a PO."); return; } ed.confirm = "alone-link"; ed.moveRank = null; render();
      { const vids = [...new Set((iv.rows || []).filter(r => r.vid && isSure(r)).map(r => r.vid))];
        rankOpenPOs(ed.vendor, vids).then(rk => { if (S.ed === ed && ed.confirm === "alone-link") { ed.moveRank = { rk, n: vids.length }; render(); } }); }
      return; }
    if (a === "alone-link-go" && iv) { const to = k || ($("pe-alonepo") || {}).value; if (!to) return; S.busy = "Adding it to the PO…"; render();
      JT.po.moveInvoice(Number(iv.id), Number(to)).then(async () => { S.busy = ""; ed.leaveOk = true; S.ed = null; note("", ""); await loadOrders(true); await loadInvList(true); await openInvoice(iv.id); note("info", `Invoice ${esc(iv.no || "")} is on ${esc((S.ed && S.ed.vendor) || "")} ${esc(S.ed && S.ed.po ? poLabel(S.ed.po) : "")} now.`); })
        .catch(err => { S.busy = ""; render(); note("bad", "Couldn't add it: " + esc(JT.message(err))); }); return; }
    if (a === "save-next" || a === "next-stage") return goStage(NEXT[ed.status][0]);
    if (a === "ready" || a === "unready") {
      const on = a === "ready";
      (on && (ed.dirty || !ed.id) ? save(null) : Promise.resolve(ed.id)).then(async id => {
        if (!id) return;
        S.busy = "Saving…"; render();
        try { await planCall("jt_po_ready", "jt.po_ready", { id: Number(id), on }); S.busy = ""; await loadOrders(true); await openPO(String(id));
          note("info", on ? "Marked <b>ready to approve</b>." : "Back to <b>draft</b>."); }
        catch (e) { S.busy = ""; render(); note("bad", "Couldn't change it: " + esc(JT.message(e))); }
      });
      return;
    }
    if (a === "save-approve") { (ed.dirty || !ed.id ? save(null, true) : Promise.resolve(ed.id)).then(id => { if (id) approveOrder(id); }); return; }
    if (a === "unapprove" && ed.id) return approveOrder(ed.id, false);
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
    if (a === "head-done") { ed.editHead = false; render(); return; }
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
    if (a === "do-rminv" && iv && ed.alone && iv.id) { S.busy = "Deleting…"; render();
      JT.invoices.remove(iv.id).then(async (ok) => { S.busy = ""; ed.leaveOk = true; S.ed = null; S.invOpen = false; await loadInvList(true); render(); note(ok ? "info" : "warn", ok ? `Invoice ${esc(iv.no || "")} deleted.` : "That invoice can't be deleted (its costs were applied)."); })
        .catch(err => { S.busy = ""; render(); note("bad", "Couldn't delete it: " + esc(JT.message(err))); }); return; }
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
    if (a === "back") { if (["partial", "received", "qb_ready", "complete"].includes(ed.status)) { ed.confirm = "unrecv"; render(); } else if (ed.dirty) note("warn", "Save or discard your changes first."); else setStatus2(PREV[ed.status], `Moved back to ${STAGE.get(PREV[ed.status]).toLowerCase()}.`); return; }
    if (a === "do-back") return setStatus2(PREV[ed.status], "Moved back to invoiced; the received units came out of the prep center.");
    if (a === "short") { ed.confirm = "short"; render(); return; }
    if (a === "do-short") { if (ed.dirty) { save("received"); return; } return setStatus2("received", "Closed short — the PO is complete."); }
    if (a === "pay" && iv) { markPaid(ed, iv); render(); focusArg("pe-paymethod"); return; }
    if (a === "unpay" && iv) { iv.paidOn = ""; iv.paidAmount = null; iv.payRef = ""; ed.dirty = true; render(); return; }
    if (a === "recv") {
      const n = allChecks(ed);
      if (n && !ed.invoices.length) { note("warn", `Confirm or change the ${n} guessed product${n === 1 ? "" : "s"} on the invoices before receiving, so the right stock comes in.`); const i = ed.invoices.findIndex(v => count(v).check); if (i >= 0) { ed.cur = i; ed.invoices[i].filter = "check"; } render(); return; }
      return openRecv(null);
    }
    if (a === "recv-cancel") { ed.recv = null; render(); return; }
    if (a === "rq-start" && iv && iv.id) return openRecv(iv.id);
    if (a === "recv-inv") { const v = ed.invoices[Number(k)]; if (!v) return; ed.cur = Number(k); ed.view = "inv"; render(); return openRecv(v.id); }
    if (a === "rq-stop") { if (ed.rq && iv) for (const kk of Object.keys(ed.rq)) if (kk.startsWith(iv.id + "#")) delete ed.rq[kk]; ed.recvInv = null; render(); return; }
    if (a === "rq-go" && l && iv && iv.id) { const sh = invShares(ed, iv).get(l.id); return receiveNow({ [keyOf(l)]: rqVal(ed, iv, l, sh) }, iv.id, true); }
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


  // ---------- Start an order (Brian, Oct 14: "a plus button on Ready to approve to start an order — a smooth way to
  // start the ordering process") ----------
  // Pick the vendor: its active products with what sold in the last 90 days (Just Tennis, Ace n Rally, Amazon), what's
  // on hand (store, prep center, Amazon) and already on open orders (jt.reorder_plan, migration 145). Below the days of
  // stock to hold (3 months by default) a product gets a quantity, rounded up to the vendor's case pack. Tick, adjust,
  // and "Create the draft" opens it as a new order, ready to save and approve. Or start empty / from a Shopify PO / PDF.
  const START_KEY = "jt-start-order";
  const startPrefs = () => { try { return JSON.parse(localStorage.getItem(START_KEY) || "{}") || {}; } catch (_) { return {}; } };
  const keepStart = (f) => { try { const p = startPrefs(); f(p); localStorage.setItem(START_KEY, JSON.stringify(p)); } catch (_) {} };
  const monthTag = () => new Date().toLocaleDateString("en-US", { month: "short", timeZone: TZ });
  // New order opens a blank PO (Brian, Oct 29: "it should just open a blank new order and not do that pre-fill
  // silliness"). The reorder planner below (openStart) is no longer on a button.
  function newOrder() {
    if (S.ed && S.ed.dirty) return leave();
    S.start = null; note("", "");
    openPO(null);
  }
  function openStart(vendor) {
    if (S.ed && S.ed.dirty) return leave();
    if (S.ed) S.ed = null;
    S.listView = "ss"; note("", "");
    const pr = startPrefs();
    S.start = { vendor: vendor || pr.vendor || "", days: pr.days || 90, pack: 1, name: "", rows: null, loading: false, err: null, all: false, qty: new Map(), sel: new Set(), focus: true };
    if (S.start.vendor) S.start.pack = (pr.packs || {})[S.start.vendor.toLowerCase()] || 1;
    render(); catalog().then(() => { if (S.start) renderStart(); }).catch(() => {});
    if (S.start.vendor) loadPlan();
  }
  async function loadPlan() {
    const st = S.start; if (!st || !st.vendor.trim()) return;
    st.loading = true; st.err = null; st.rows = null; renderStart();
    try {
      const r = await JT.rows(["r.variant_id::text", "r.product_id::text", "r.title", "r.sku", "coalesce(s.list_cost, r.unit_cost)", "r.shop90 + r.anr90 + r.amz90", "r.shop30 + r.anr30 + r.amz30", "r.shop90", "r.anr90", "r.amz90", "greatest(r.store, 0)", "r.prep", "r.amazon", "r.on_order",
        "coalesce(s.discontinued, false)", "coalesce(s.availability, '')", "s.list_cost is not null"],
        `from jt.reorder_plan(${JT.q(st.vendor.trim())}) r left join jt.product_status s on s.variant_id = r.variant_id`, true);
      if (S.start !== st) return;
      st.rows = r.map(x => ({ vid: x[0], pid: x[1], title: x[2] || "", sku: x[3] || "", cost: x[4] == null ? null : +x[4], s90: +x[5] || 0, s30: +x[6] || 0, shop: +x[7] || 0, anr: +x[8] || 0, amz: +x[9] || 0,
        store: +x[10] || 0, prep: +x[11] || 0, amazon: +x[12] || 0, onOrder: +x[13] || 0, disc: !!x[14], avail: x[15] || "", listCost: !!x[16] }));
      st.nDisc = st.rows.filter(r => r.disc).length; st.rows = st.rows.filter(r => !r.disc);   // discontinued products: Inventory › Discontinued
      planQty(st);
    } catch (e) { if (S.start === st) st.err = e; }
    if (S.start === st) { st.loading = false; renderStart(); }
  }
  // per row: pace (units a day, last 90 days), on hand, days of stock left (with what's on order), suggested quantity
  function planRow(st, r) {
    const rate = r.s90 / 90, have = r.store + r.prep + r.amazon, pack = Math.max(1, Math.round(st.pack) || 1);
    const need = rate * st.days - have - r.onOrder;
    return { rate, have, left: rate > 0 ? (have + r.onOrder) / rate : Infinity, sugg: need > 0.5 ? Math.ceil(need / pack) * pack : 0, hot: r.s30 / 30 > rate * 1.5 && r.s30 >= 3 };
  }
  function planQty(st) {
    st.qty = new Map(); st.sel = new Set();
    for (const r of st.rows || []) { const p = planRow(st, r); if (p.sugg > 0) { st.qty.set(r.vid, String(p.sugg)); st.sel.add(r.vid); } }
  }
  function renderStart() {
    const host = $("po-start-host"); if (!host) return;
    const st = S.start; if (!st) { host.innerHTML = ""; return; }
    const keep = document.activeElement && host.contains(document.activeElement) ? { id: document.activeElement.id, s: document.activeElement.selectionStart } : null;
    const rows = (st.rows || []).map(r => ({ r, p: planRow(st, r) }));
    const want = rows.filter(x => x.p.sugg > 0 || st.sel.has(x.r.vid));
    const shown = (st.all ? rows : want).sort((a, b) => a.p.left - b.p.left || b.r.s90 - a.r.s90).slice(0, st.all ? 400 : 200);
    const picked = rows.filter(x => st.sel.has(x.r.vid) && +(st.qty.get(x.r.vid) || 0) > 0);
    const units = picked.reduce((a, x) => a + +(st.qty.get(x.r.vid) || 0), 0), cost = picked.reduce((a, x) => a + (+(st.qty.get(x.r.vid) || 0)) * (x.r.cost || 0), 0);
    const dl = (x) => x.p.left === Infinity ? '<span class="dim">no sales</span>' : x.p.left < 1 ? '<span class="neg">out</span>' : `<span class="${x.p.left < 30 ? "neg" : x.p.left < st.days ? "warnt" : ""}">${n0(x.p.left)} d</span>`;
    host.innerHTML = `<section class="panel po-start">
      <div class="ps-row">
        <b class="ps-title">Start an order</b>
        <label class="ps-f">Vendor <input id="ps-vendor" class="inp" list="ps-vendors" value="${esc(st.vendor)}" placeholder="Vendor" autocomplete="off" style="width:170px"><datalist id="ps-vendors">${(S.vendors || []).map(v => `<option value="${esc(v)}">`).join("")}</datalist></label>
        <label class="ps-f" title="Days of stock to hold (90 = 3 months)">Hold <input id="ps-days" class="inp num" value="${esc(st.days)}" inputmode="numeric" style="width:56px"> days</label>
        <label class="ps-f" title="Quantities round up to this (e.g. Head racquets ship 20 to a case); remembered for this vendor">Case pack <input id="ps-pack" class="inp num" value="${esc(st.pack)}" inputmode="numeric" style="width:52px"></label>
        <button class="btn primary sm" type="button" data-ps-go ${st.loading ? "disabled" : ""}>${st.loading ? "Looking…" : st.rows ? "Recalculate" : "What to reorder"}</button>
        <button class="btn sm" type="button" data-ps-ofx ${st.ofBusy ? "disabled" : ""} title="Excel workbook for the vendor's Amazon listings: an order form filled in with suggested quantities, a vendor view by SKU, Amazon inventory (FBA and AWD) and Amazon sales by week">${st.ofBusy ? "Building…" : "Amazon order form (Excel)"}</button>
        <span class="ps-or">or <button class="linkbtn" type="button" data-ps-ph title="Just the vendor, a category and a budget — it fills out from the invoices you put on it">placeholder</button> · <button class="linkbtn" type="button" data-ps-mi title="Stuff arrived and there's nothing in the system for it: start an order to receive it, flagged until the invoice comes">missing invoice</button> · <button class="linkbtn" type="button" data-ps-empty>empty order</button> · <label class="linkbtn" for="ps-xlsx" title="An order sheet (Excel or CSV): products by Shopify SKU, UPC, Amazon seller SKU or ASIN, with quantities">from Excel</label><input type="file" id="ps-xlsx" accept=".xlsx,.xls,.csv" hidden></span>
        <button class="mini ps-x" type="button" data-ps-close title="Close" aria-label="Close">✕</button>
      </div>
      ${st.ph ? `<div class="ps-row ps-ph"><b>Placeholder order</b>
          <label class="ps-f">Category <input id="ps-cat" class="inp" list="ps-cats" value="${esc(st.phCat || "")}" placeholder="e.g. Shoes" style="width:150px"><datalist id="ps-cats">${catOptions()}</datalist></label>
          <label class="ps-f">Budget $<input id="ps-budget" class="inp num" value="${esc(st.phBudget || "")}" inputmode="decimal" placeholder="0" style="width:90px"></label>
          <label class="ps-f">Name <input id="ps-phname" class="inp" value="${esc(st.phName || "")}" placeholder="optional, e.g. Fall shoes" style="width:150px"></label>
          <button class="btn primary sm" type="button" data-ps-phgo ${S.busy ? "disabled" : ""}>Create placeholder</button>
          <span class="small muted">Only the vendor is needed; anything left blank is flagged on the order. Put invoices on it (Change PO / Add to a PO) and their products fill it out.</span></div>` : ""}
      ${st.xl ? xlHtml(st.xl) : ""}
      ${st.mi ? `<div class="ps-row ps-ph"><b>Missing invoice</b>
          <label class="ps-f">What arrived <input id="ps-minote" class="inp" value="${esc(st.miNote || "")}" placeholder="optional, e.g. 3 boxes of shoes, tracking #" style="width:260px"></label>
          <button class="btn primary sm" type="button" data-ps-migo ${S.busy ? "disabled" : ""}>Start it</button>
          <span class="small muted">Vendor is needed. Add what came in and receive it; the order stays flagged "missing invoice" until its invoice is put on it.</span></div>` : ""}
      ${st.err ? `<div class="note bad">Couldn't work out the reorder list: ${esc(JT.message(st.err))}</div>` : ""}
      ${st.rows ? `<div class="ps-row small">
          <span><b>${n0(want.length)}</b> of ${n0(rows.length)} ${esc(st.vendor)} products below ${n0(st.days)} days of stock${rows.length && !want.length ? " — nothing to reorder" : ""}</span>
          <button class="linkbtn" type="button" data-ps-all>${st.all ? "Show just those" : `Show all ${n0(rows.length)}`}</button>
          ${st.nDisc ? `<button class="linkbtn" type="button" data-ps-disc title="Discontinued products aren't reordered: see them on Inventory › Discontinued">${n0(st.nDisc)} discontinued hidden</button>` : ""}
          <span class="muted">sold = last 90 days, Just Tennis + Ace n Rally + Amazon · on hand = store + prep + Amazon</span></div>
        ${shown.length ? `<div class="tbl-wrap ps-tbl"><table class="prept po-t"><thead><tr><th><input type="checkbox" data-ps-allsel aria-label="Select all" ${picked.length && picked.length === shown.filter(x => +(st.qty.get(x.r.vid) || 0) > 0).length ? "checked" : ""}></th><th class="l">Product</th><th title="Last 90 days (last 30)">Sold 90d</th><th>On hand</th><th>On order</th><th title="On hand + on order, at the 90-day pace">Days left</th><th>Order</th><th>Cost</th><th>Total</th></tr></thead><tbody>${shown.map(x => { const r = x.r, q = st.qty.get(r.vid) || "";
          return `<tr class="${st.sel.has(r.vid) ? "picked" : ""}"><td><input type="checkbox" data-ps-sel="${esc(r.vid)}" ${st.sel.has(r.vid) ? "checked" : ""} aria-label="Order ${esc(r.title)}"></td>
            <td class="l"><a class="olink" href="${ADMIN}/products/${esc(r.pid)}/variants/${esc(r.vid)}" target="_blank" rel="noopener">${esc(r.title)}</a> <span class="mono dim small">${esc(r.sku)}</span></td>
            <td title="Just Tennis ${n0(r.shop)} · Ace n Rally ${n0(r.anr)} · Amazon ${n0(r.amz)} · last 30 days ${n0(r.s30)}">${n0(r.s90)}${x.p.hot ? ' <span class="pill warn" title="Selling faster in the last 30 days">↑</span>' : ""}</td>
            <td title="Store ${n0(r.store)} · prep ${n0(r.prep)} · Amazon ${n0(r.amazon)}">${n0(x.p.have)}</td><td>${r.onOrder ? n0(r.onOrder) : '<span class="dim">—</span>'}</td><td>${dl(x)}</td>
            <td><input class="inp num sm" data-ps-qty="${esc(r.vid)}" value="${esc(q)}" inputmode="numeric" style="width:60px"></td><td title="${r.listCost ? "From the vendor's pricelist" : "Shopify cost"}">${r.cost == null ? '<span class="dim">—</span>' : m(r.cost)}${r.avail === "backorder" || r.avail === "unavailable" ? ` <span class="pill miss" title="The vendor's pricelist says ${esc(r.avail)}">${esc(r.avail === "backorder" ? "backorder" : "unavail.")}</span>` : ""}</td><td>${q && r.cost != null ? m(+q * r.cost) : ""}</td></tr>`; }).join("")}</tbody></table></div>` : ""}
        <div class="ps-row">
          <label class="ps-f">PO name <input id="ps-name" class="inp mono" value="${esc(st.name || `${monthTag()} ${st.vendor}`)}" style="width:190px"></label>
          <button class="btn primary" type="button" data-ps-create ${picked.length ? "" : "disabled"}>Create the draft · ${n0(picked.length)} product${picked.length === 1 ? "" : "s"} · ${n0(units)} units · ${m0(cost)}</button>
          <span class="muted small">It opens as a new order to check, save and approve.</span></div>` : st.loading ? '<div class="muted small">Looking at sales, stock and open orders…</div>' : ""}
    </section>`;
    if (st.focus) { st.focus = false; const i = $(st.vendor ? "ps-days" : "ps-vendor"); if (i && !st.vendor) i.focus(); }
    else if (keep && keep.id) { const el = $(keep.id); if (el) { el.focus(); try { el.setSelectionRange(keep.s, keep.s); } catch (_) {} } }
  }
  // ---------- an order from an Excel order sheet (Brian, Oct 20: "import an excel order and turn it into a seller sage
  // order") ----------
  // Each row's products are found by Shopify SKU, UPC, Amazon seller SKU or ASIN, with the quantity in the column next to
  // it (a row can name two listings, e.g. Tecnifibre's sheet: SKU + Qty, second SKU + Qty). A "Total" column, when there
  // is one, is what's ordered (the sheet takes stock already on hand off): 0 or less = covered from stock, not ordered.
  // Amazon seller SKUs go to the prep center for that listing; Shopify SKUs / UPCs to the Shopify store. Opens as a new
  // order (unsaved) to check and Save.
  const XL_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
  async function xlLib() {
    if (window.XLSX) return window.XLSX;
    await new Promise((ok, bad) => { const sc = document.createElement("script"); sc.src = XL_URL; sc.onload = ok; sc.onerror = () => bad(new Error("Couldn't load the spreadsheet reader.")); document.head.appendChild(sc); });
    return window.XLSX;
  }
  // CSV text → rows: quoted fields (commas, quotes and line breaks inside), a BOM, and ; or tab as the separator
  function csvGrid(text) {
    text = String(text || "").replace(/^\uFEFF/, "");
    const first = text.split(/\r?\n/, 1)[0] || "", cnt = (c) => first.split(c).length - 1;
    const sep = [",", ";", "\t"].sort((a, b) => cnt(b) - cnt(a))[0];
    const rows = []; let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
      if (c === '"') q = true;
      else if (c === sep) { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
      else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows.map(r => r.map(x => x.trim().replace(/^="(.*)"$/, "$1")));   // ="0123" keeps a UPC's leading zeros in Excel
  }
  // Upload CSV / Excel on the Orders page (Brian, Oct 29: "we need to be able to upload a csv to create an order"): the
  // file goes straight into a new, unsaved order — products matched by Shopify SKU, UPC, Amazon seller SKU or ASIN, the
  // vendor taken from the products — to check and Save. Rows that match nothing are listed in the order's note.
  // the order template (Oct 29: "we need to be able to download a template for an order"): fill in one product column
  // per row (Shopify SKU, UPC or Amazon SKU — an Amazon SKU sends it to the prep center) and Qty; Unit cost is optional
  // (blank = the product's cost in Shopify); Product is just for you.
  async function orderTemplate() {
    const rows = [["Shopify SKU", "UPC", "Amazon SKU", "Product", "Qty", "Unit cost"]];
    await saveFile("order-template.csv", rows.map(r => r.join(",")).join("\n") + "\n", "text/csv");
  }
  async function sheetOrder(f) {
    if (!f) return;
    const into = S.ed && S.mode !== "inv" && S.ed.status === "draft" ? S.ed : null;   // from inside an order: add to it
    if (!into && S.ed && S.ed.dirty) return leave();
    const st = { vendor: into ? into.vendor : "", xl: null };
    S.busy = `Reading ${esc(f.name)}…`; render();
    await xlRead(st, f);
    S.busy = ""; render();
    const x = st.xl;
    if (x.err) { note("bad", `Couldn't read ${esc(f.name)}: ${esc(x.err)}`); return; }
    const sh = x.sheets[x.pick];
    if (!sh || !sh.lines.length) {
      note("warn", `Nothing in ${esc(f.name)} matched a product with a quantity.${sh && sh.unmatched.length ? ` ${n0(sh.unmatched.length)} row${sh.unmatched.length === 1 ? "" : "s"} didn't match (e.g. ${sh.unmatched.slice(0, 3).map(u => esc(u.desc)).join(", ")}).` : ""} The file needs a column of Shopify SKUs, UPCs or Amazon SKUs and a quantity column (Qty / Quantity / Units / Order).`);
      return;
    }
    if (into && S.ed === into) return xlMerge(into, st);
    xlOpen(st, true);
  }
  // a spreadsheet's products added to the open order: same product and destination adds to the quantity
  function xlMerge(ed, st) {
    const x = st.xl, sh = x.sheets[x.pick];
    let added = 0, more = 0;
    for (const l of sh.lines) {
      const have = ed.lines.find(y => y.vid === l.vid && y.dest === l.dest && (y.asku || "") === (l.asku || ""));
      if (have) { have.qty = String((Number(have.qty) || 0) + l.qty); if (l.cost != null) have.cost = fmtCost(l.cost); more++; continue; }
      ed.lines.push({ id: newId(), vid: l.vid, asku: l.asku, dest: l.dest, qty: String(l.qty), cost: fmtCost(l.cost != null ? l.cost : (variant(l.vid) || {}).cost), received: 0, backorder: false, eta: "", auto: false });
      added++;
    }
    if (!ed.vendor && st.vendor) ed.vendor = st.vendor;
    const dests = new Set(ed.lines.map(l => l.dest)); if (dests.size > 1) { ed.dest = "both"; ed.into = "both"; }
    const miss = sh.unmatched.length ? `not matched: ${sh.unmatched.map(u => u.row || u.desc).join("; ")}` : "";
    ed.note = [ed.note, `From ${x.file}${miss ? " — " + miss : ""}`].filter(Boolean).join(" · ");
    ed.dirty = true; ed.add = "";
    render();
    note(sh.unmatched.length ? "warn" : "info", `Added from <b>${esc(x.file)}</b>: ${n0(added)} new line${added === 1 ? "" : "s"}${more ? `, ${n0(more)} added to lines already here` : ""} · ${n0(sh.units)} units.${sh.unmatched.length ? ` <b>${n0(sh.unmatched.length)} row${sh.unmatched.length === 1 ? "" : "s"} didn't match a product</b> (listed in the note) — add ${sh.unmatched.length === 1 ? "it" : "them"} with Add product.` : ""}${ed.vendor ? "" : " <b>Fill in the vendor.</b>"} Check it, then <b>Save</b>.`);
  }
  function xlId(v) {
    const t = String(v ?? "").trim(); if (!t || t.length < 3 || /^\d{1,3}$/.test(t)) return null;
    const a = S.byAmz.get(t.toLowerCase()); if (a) return { vid: a.vid, asku: a.asku, dest: "prep", how: a.asku ? "Amazon SKU" : "ASIN" };
    const k = norm(t), sk = S.bySku.get(k); if (sk && sk.length === 1) return { vid: sk[0].vid, asku: "", dest: "shopify", how: "SKU" };
    const bc = S.byBar.get(k.replace(/^0+/, "")); if (/^\d{8,14}$/.test(t) && bc && bc.length === 1) return { vid: bc[0].vid, asku: "", dest: "shopify", how: "UPC" };
    return null;
  }
  const xlNum = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,\s]/g, "")); return isFinite(n) ? n : null; };
  function xlSheet(name, grid) {
    let h = 0; for (let i = 0; i < Math.min(12, grid.length); i++) if ((grid[i] || []).filter(c => /qty|quantity|sku|description|cost|total|units|order/i.test(String(c || ""))).length >= 2) { h = i; break; }
    const hd = (grid[h] || []).map(c => String(c ?? "").trim());
    const totC = hd.findIndex(x => /^total$/i.test(x)), costC = hd.findIndex(x => /cost|price/i.test(x) && !/extend|ext\.?$/i.test(x));
    const qtyHead = hd.findIndex(x => /^(qty|quantity|order qty|units|order)$/i.test(x));
    const out = { name, lines: [], covered: [], unmatched: [], units: 0 };
    // Seller Sage's own Amazon order form (orderform.js): just the Amazon SKU and Order qty columns count
    const aC = hd.findIndex(x => /^amazon sku$/i.test(x)), oC = hd.findIndex(x => /^order qty$/i.test(x)), ucC = hd.findIndex(x => /^unit cost$/i.test(x));
    if (aC >= 0 && oC >= 0) {
      for (const r of grid.slice(h + 1)) {
        const id = r && xlId(r[aC]); const q = Math.max(0, Math.round(xlNum(r && r[oC]) || 0)); if (!id || !q) continue;
        const cost = ucC >= 0 ? xlNum(r[ucC]) : null;
        out.lines.push({ ...id, code: String(r[aC]).trim(), qty: q, desc: String(r[aC + 3] ?? r[aC] ?? ""), cost: cost && cost > 0 ? cost : null }); out.units += q;
      }
      return out;
    }
    // A sheet with named product and quantity columns (our template, a PO's Download CSV, most vendor sheets): the first
    // product column that matches, the quantity from the quantity column. "Total" there is money, not a quantity.
    const idCols = hd.map((x, i) => [x, i]).filter(([x]) => /^(amazon sku|seller sku|msku|shopify sku|vendor sku|sku|item|item #|item no\.?|style|upc|barcode|ean|gtin|asin)$/i.test(x))
      .sort((a, b) => ["amazon sku", "seller sku", "msku"].includes(b[0].toLowerCase()) - ["amazon sku", "seller sku", "msku"].includes(a[0].toLowerCase())).map(x => x[1]);
    if (idCols.length && qtyHead >= 0) {
      const descC = hd.findIndex(x => /^(product|description|name|item description|title)$/i.test(x));
      for (const r of grid.slice(h + 1)) {
        if (!r || !r.some(c => c !== "" && c != null)) continue;
        const q = Math.max(0, Math.round(xlNum(r[qtyHead]) || 0));
        const c = idCols.find(i => xlId(r[i])), desc = String((descC >= 0 ? r[descC] : "") || "").trim();
        if (c == null) { if (q > 0) out.unmatched.push({ desc: desc || String(r[idCols[0]] || ""), row: r.filter(x => x !== "" && x != null).slice(0, 4).join(" · ") }); continue; }
        if (!q) continue;
        const cost = costC >= 0 ? xlNum(r[costC]) : null;
        out.lines.push({ ...xlId(r[c]), code: String(r[c]).trim(), qty: q, desc, cost: cost && cost > 0 ? cost : null }); out.units += q;
      }
      return out;
    }
    for (const r of grid.slice(h + 1)) {
      if (!r || !r.some(c => c !== "" && c != null)) continue;
      const pairs = [];
      for (let c = 0; c < r.length; c++) { const id = xlId(r[c]); if (!id) continue;
        let q = xlNum(r[c + 1]); if (q == null && qtyHead >= 0 && !pairs.length) q = xlNum(r[qtyHead]);
        pairs.push({ ...id, code: String(r[c]).trim(), qty: Math.max(0, Math.round(q || 0)) }); }
      const desc = String(r[0] ?? "").trim();
      if (!pairs.length) { const looksItem = r.slice(1).some(c => xlNum(c) > 0) && desc && !/^[A-Z\s]+$/.test(desc); if (looksItem) out.unmatched.push({ desc, row: r.filter(c => c !== "" && c != null).slice(0, 4).join(" · ") }); continue; }
      let want = pairs.reduce((a, x) => a + x.qty, 0); if (!want) continue;
      const tot = totC >= 0 ? xlNum(r[totC]) : null;
      if (tot != null && tot < want) {
        if (tot <= 0) { out.covered.push({ desc, want }); continue; }
        let cut = want - tot; for (let i = pairs.length - 1; i >= 0 && cut > 0; i--) { const d = Math.min(cut, pairs[i].qty); pairs[i].qty -= d; cut -= d; }
        want = tot;
      }
      const cost = costC >= 0 ? xlNum(r[costC]) : null;
      for (const x of pairs) if (x.qty > 0) out.lines.push({ ...x, desc, cost: cost && cost > 0 ? cost : null });
      out.units += want;
    }
    return out;
  }
  async function xlRead(st, f) {
    st.xl = { file: f.name, sheets: null, pick: 0, err: null }; renderStart();
    try {
      await catalog();
      let grids;
      if (/\.(csv|tsv|txt)$/i.test(f.name)) grids = [{ name: f.name.replace(/\.[^.]+$/, ""), grid: csvGrid(await f.text()) }];
      else { const X = await xlLib(); const wb = X.read(await f.arrayBuffer(), { type: "array" });
        grids = wb.SheetNames.map(n => ({ name: n, grid: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }) })); }
      st.xl.sheets = grids.map(g => xlSheet(g.name, g.grid));
      // the last sheet with something to order (order sheets are usually added at the end; a template is skipped)
      const ok = st.xl.sheets.map((x, i) => [x, i]).filter(([x]) => x.lines.length && !/template/i.test(x.name));
      const of = st.xl.sheets.findIndex(x => /^order form$/i.test(x.name));
      st.xl.pick = of >= 0 ? of : ok.length ? ok[ok.length - 1][1] : 0;
      if (!st.vendor) { const vs = new Map(); for (const l of (st.xl.sheets[st.xl.pick] || { lines: [] }).lines) { const v = (variant(l.vid) || {}).vendor; if (v) vs.set(v, (vs.get(v) || 0) + 1); }
        st.vendor = [...vs.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || ""; }
    } catch (e) { st.xl.err = e.message || String(e); }
    renderStart();
  }
  function xlHtml(x) {
    if (x.err) return `<div class="ps-row ps-ph"><span class="neg">Couldn't read ${esc(x.file)}: ${esc(x.err)}</span> <button class="linkbtn" data-ps-xlx>Close</button></div>`;
    if (!x.sheets) return `<div class="ps-row ps-ph small">Reading ${esc(x.file)}…</div>`;
    const sh = x.sheets[x.pick] || { lines: [], covered: [], unmatched: [], units: 0 };
    const v = (vid) => variant(vid) || {};
    const cost = sh.lines.reduce((a, l) => a + l.qty * (l.cost != null ? l.cost : v(l.vid).cost || 0), 0);
    return `<div class="ps-ph ps-xl"><div class="ps-row"><b>From Excel</b> <span class="small mono">${esc(x.file)}</span>
        ${x.sheets.length > 1 ? `<span class="seg sm" role="group" aria-label="Sheet">${x.sheets.map((s2, i) => `<button type="button" data-ps-xlsheet="${i}" aria-pressed="${i === x.pick}" title="${n0(s2.lines.length)} lines · ${n0(s2.units)} units">${esc(s2.name)}</button>`).join("")}</span>` : ""}
        <button class="linkbtn small" data-ps-xlx>Close</button></div>
      <div class="small">${n0(sh.lines.length)} line${sh.lines.length === 1 ? "" : "s"} · <b>${n0(sh.units)}</b> units · ${m0(cost)} at cost${sh.covered.length ? ` · ${n0(sh.covered.length)} covered from stock (not ordered)` : ""}${sh.unmatched.length ? ` · <span class="warnt">${n0(sh.unmatched.length)} not matched</span>` : ""}</div>
      ${sh.lines.length ? `<div class="tbl-wrap ps-xltbl"><table class="prept po-t"><thead><tr><th class="l">Product</th><th class="l">From the sheet</th><th class="l">For</th><th>Qty</th><th>Cost</th></tr></thead><tbody>${sh.lines.map(l =>
        `<tr><td class="l">${esc(v(l.vid).title || "variant " + l.vid)} <span class="mono dim small">${esc(v(l.vid).sku || "")}</span></td><td class="l small">${esc(l.desc)} <span class="mono dim">${esc(l.code)}</span></td>
         <td class="l small">${l.dest === "prep" ? `Prep center${l.asku ? ` · <span class="mono">${esc(l.asku)}</span>` : ""}` : "Shopify store"}</td><td>${n0(l.qty)}</td><td>${l.cost != null ? m(l.cost) : `<span class="dim">${m(v(l.vid).cost)}</span>`}</td></tr>`).join("")}</tbody></table></div>` : '<div class="small muted">Nothing to order on this sheet.</div>'}
      ${sh.covered.length ? `<div class="small muted">Covered from stock: ${sh.covered.map(c => `${esc(c.desc)} (${n0(c.want)})`).join(", ")}</div>` : ""}
      ${sh.unmatched.length ? `<div class="small warnt">Not matched to a product: ${sh.unmatched.slice(0, 12).map(u => esc(u.desc)).join(", ")}${sh.unmatched.length > 12 ? "…" : ""}</div>` : ""}
      <div class="ps-row"><button class="btn primary sm" data-ps-xlgo ${sh.lines.length ? "" : "disabled"}>Open as a new order</button><span class="small muted">Opens unsaved for you to check, then Save. Vendor: ${esc(S.start && S.start.vendor || "pick above")}.</span></div></div>`;
  }
  function xlOpen(st, upload) {
    const x = st.xl, sh = x.sheets[x.pick]; if (!sh || !sh.lines.length) return;
    if (!st.vendor && !upload) { note("warn", "Pick the vendor first."); return; }
    const by = new Map();
    for (const l of sh.lines) { const k = l.vid + "|" + l.asku + "|" + l.dest; const a = by.get(k) || { ...l, qty: 0 }; a.qty += l.qty; by.set(k, a); }
    const lines = [...by.values()].map(l => ({ id: newId(), vid: l.vid, asku: l.asku, dest: l.dest, qty: String(l.qty), cost: fmtCost(l.cost != null ? l.cost : (variant(l.vid) || {}).cost),
      received: 0, backorder: false, eta: "", auto: false }));
    const dests = new Set(lines.map(l => l.dest));
    const m2 = /(\d{1,2})\s*([A-Za-z]{3})[a-z]*.*?(\d{4})/.exec(sh.name), nm = m2 ? `${m2[2]} ${m2[1]} ${m2[3]}` : upload ? "" : sh.name;
    const extra = [sh.covered.length ? `covered from stock: ${sh.covered.map(c => `${c.desc} ${c.want}`).join(", ")}` : "", sh.unmatched.length ? `not matched: ${sh.unmatched.map(u => u.row || u.desc).join("; ")}` : ""].filter(Boolean).join("; ");
    S.start = null; renderStart();
    openPO(null, { vendor: st.vendor, po: nm, note: `From ${x.file}${x.sheets.length > 1 || !upload ? ` (sheet ${sh.name})` : ""}${extra ? " — " + extra : ""}`, lines, dirty: true,
      dest: dests.size > 1 ? "both" : [...dests][0], into: dests.size > 1 ? "both" : [...dests][0] });
    const miss = sh.unmatched.length ? ` <b>${n0(sh.unmatched.length)} row${sh.unmatched.length === 1 ? "" : "s"} didn't match a product</b> (listed in the note) — add ${sh.unmatched.length === 1 ? "it" : "them"} with Add product.` : "";
    note(sh.unmatched.length || !st.vendor ? "warn" : "info", `New ${esc(st.vendor || "")} order from <b>${esc(upload ? x.file : sh.name)}</b>: ${n0(lines.length)} lines, ${n0(sh.units)} units.${miss}${st.vendor ? "" : " <b>Fill in the vendor.</b>"} Check it, then <b>Save</b>.`);
  }
  async function createMissing(st) {
    if (!st.vendor) { note("warn", "Pick the vendor the goods came from."); const v = $("ps-vendor"); if (v) v.focus(); return; }
    S.busy = "Starting the order…"; render();
    try {
      const id = await planCall("jt_po_missing_invoice_create", "jt.po_missing_invoice_create", { vendor: st.vendor, note: (st.miNote || "").trim() });
      S.busy = ""; S.start = null; renderStart(); await loadOrders(true); await openPO(String(id));
      note("warn", `Order for ${esc(st.vendor)} started and flagged <b>missing invoice</b>. Add the products that came in (Add product, quantity = what arrived), Save, then Receive. Put the invoice on it when it shows up and the flag clears.`);
      setTimeout(() => { const a = document.querySelector('#po-edit-view [placeholder^="Shopify SKU"]'); if (a) a.focus(); }, 50);
    } catch (e) { S.busy = ""; render(); note("bad", "Couldn't start it: " + esc(JT.message(e))); }
  }
  async function createPlaceholder(st) {
    if (!st.vendor) { note("warn", "Pick the vendor for the placeholder."); const v = $("ps-vendor"); if (v) v.focus(); return; }
    const b = String(st.phBudget || "").replace(/[$,\s]/g, "");
    if (b !== "" && !(Number(b) >= 0)) { note("warn", "The budget needs to be a number, like 10000."); return; }
    S.busy = "Creating the placeholder…"; render();
    try {
      const id = await planCall("jt_po_placeholder_create", "jt.po_placeholder_create", { vendor: st.vendor, category: (st.phCat || "").trim(), budget: b, po_no: (st.phName || "").trim() });
      S.busy = ""; S.start = null; renderStart(); await loadOrders(true); await openPO(String(id));
      const gaps = [!(st.phCat || "").trim() && "category", b === "" && "budget"].filter(Boolean);
      note(gaps.length ? "warn" : "info", `Placeholder for ${esc(st.vendor)} created.${gaps.length ? ` Missing: ${gaps.join(" and ")} — add ${gaps.length > 1 ? "them" : "it"} on the order.` : ""} Put invoices on it and their products fill it out.`);
    } catch (e) { S.busy = ""; render(); note("bad", "Couldn't create it: " + esc(JT.message(e))); }
  }
  function readStart() {
    const st = S.start; if (!st) return;
    const v = $("ps-vendor"), d = $("ps-days"), k = $("ps-pack"), nm = $("ps-name");
    if (v) { const want = (S.vendors || []).find(x => x.toLowerCase() === v.value.trim().toLowerCase()); st.vendor = want || v.value.trim(); }
    if (d) st.days = Math.max(1, Math.round(+d.value) || 90);
    if (k) st.pack = Math.max(1, Math.round(+k.value) || 1);
    if (nm) st.name = nm.value;
    const pc = $("ps-cat"), pb = $("ps-budget"), pn = $("ps-phname");
    { const mn = $("ps-minote"); if (mn) st.miNote = mn.value; }
    if (pc) st.phCat = pc.value; if (pb) st.phBudget = pb.value; if (pn) st.phName = pn.value;
  }
  function createFromStart() {
    readStart(); const st = S.start; if (!st || !st.rows) return;
    const lines = st.rows.filter(r => st.sel.has(r.vid) && +(st.qty.get(r.vid) || 0) > 0).map(r => ({ id: newId(), vid: r.vid, asku: "", dest: "shopify", qty: String(+st.qty.get(r.vid)), cost: fmtCost(r.cost),
      received: 0, backorder: false, eta: "", auto: false, upd: false, costApplied: null, costAppliedAt: "" }));
    if (!lines.length) return;
    keepStart(p => { p.vendor = st.vendor; p.days = st.days; p.packs = p.packs || {}; p.packs[st.vendor.toLowerCase()] = st.pack; });
    const name = (st.name || `${monthTag()} ${st.vendor}`).trim();
    S.start = null;
    openPO(null, { vendor: st.vendor, po: name, lines, dirty: true, note: `Started from the reorder list: ${st.days} days of stock${st.pack > 1 ? `, case pack ${st.pack}` : ""}.` });
    note("info", `${lines.length} product${lines.length === 1 ? "" : "s"} from the reorder list. Check the quantities, then <b>Save &amp; approve</b>.`);
  }
  function bindStart() {
    const host = $("po-start-host");
    host.addEventListener("click", (e) => {
      const st = S.start; if (!st) return; const t = e.target;
      if (t.closest("[data-ps-close]")) { S.start = null; renderStart(); return; }
      if (t.closest("[data-ps-ofx]")) { readStart(); if (!window.JTOrderForm) return;
        st.ofBusy = true; renderStart();
        window.JTOrderForm.download({ vendor: st.vendor, days: st.days })
          .then(r => note("info", `Downloaded <b>${esc(r.name)}</b>: ${n0(r.listings)} Amazon listing${r.listings === 1 ? "" : "s"}, ${n0(r.skus)} SKU${r.skus === 1 ? "" : "s"}, ${n0(r.suggested)} units suggested for ${esc(st.days)} days. Edit Order qty, then bring it back with <b>from Excel</b>.`))
          .catch(e => note("bad", "Couldn't build the order form: " + esc(JT.message ? JT.message(e) : (e && e.message) || String(e))))
          .finally(() => { st.ofBusy = false; renderStart(); });
        return; }
      if (t.closest("[data-ps-go]")) { readStart(); const pr = startPrefs(); if (!st.packTouched) st.pack = (pr.packs || {})[st.vendor.toLowerCase()] || st.pack; keepStart(p => { p.vendor = st.vendor; p.days = st.days; }); loadPlan(); return; }
      if (t.closest("[data-ps-ph]")) { readStart(); st.ph = !st.ph; renderStart(); const c = $("ps-cat"); if (c) c.focus(); return; }
      if (t.closest("[data-ps-phgo]")) { readStart(); createPlaceholder(st); return; }
      const xs = t.closest("[data-ps-xlsheet]"); if (xs && st.xl) { st.xl.pick = +xs.dataset.psXlsheet; renderStart(); return; }
      if (t.closest("[data-ps-xlgo]") && st.xl) { readStart(); xlOpen(st); return; }
      if (t.closest("[data-ps-xlx]")) { st.xl = null; renderStart(); return; }
      if (t.closest("[data-ps-mi]")) { readStart(); st.mi = !st.mi; renderStart(); const c = $("ps-minote"); if (c) c.focus(); return; }
      if (t.closest("[data-ps-migo]")) { readStart(); createMissing(st); return; }
      if (t.closest("[data-ps-empty]")) { readStart(); const v = st.vendor; S.start = null; openPO(null, v ? { vendor: v } : {}); return; }
      if (t.closest("[data-ps-all]")) { readStart(); st.all = !st.all; renderStart(); return; }
      if (t.closest("[data-ps-create]")) { createFromStart(); return; }
      if (t.closest("[data-ps-disc]")) { const b = document.querySelector('.tabs button[data-tab="discontinued"]'); if (b) b.click(); return; }
      const cb = t.closest("[data-ps-sel]"); if (cb) { readStart(); const id = cb.dataset.psSel; if (cb.checked) { st.sel.add(id); if (!(+(st.qty.get(id) || 0) > 0)) { const r = st.rows.find(x => x.vid === id); st.qty.set(id, String(Math.max(st.pack, planRow(st, r).sugg || st.pack))); } } else st.sel.delete(id); renderStart(); return; }
      const all = t.closest("[data-ps-allsel]"); if (all) { readStart(); for (const r of st.rows || []) { if (all.checked && +(st.qty.get(r.vid) || 0) > 0) st.sel.add(r.vid); else if (!all.checked) st.sel.delete(r.vid); } renderStart(); }
    });
    host.addEventListener("input", (e) => {
      const st = S.start; if (!st) return; const t = e.target;
      if (t.dataset.psQty) { const id = t.dataset.psQty; st.qty.set(id, t.value.replace(/[^\d]/g, "")); if (+st.qty.get(id) > 0) st.sel.add(id); else st.sel.delete(id); clearTimeout(t._t); t._t = setTimeout(() => { readStart(); renderStart(); }, 400); return; }
      if (t.id === "ps-pack") st.packTouched = true;
    });
    host.addEventListener("keydown", (e) => { if (e.key === "Enter" && ["ps-vendor", "ps-days", "ps-pack"].includes(e.target.id)) { e.preventDefault(); host.querySelector("[data-ps-go]").click(); }
      if (e.key === "Escape") { S.start = null; renderStart(); } });
    host.addEventListener("change", (e) => { const st = S.start; if (!st) return;
      if (e.target.id === "ps-xlsx" && e.target.files && e.target.files[0]) { readStart(); const f = e.target.files[0]; e.target.value = ""; xlRead(st, f); return; }
      if (e.target.id === "ps-pack" || e.target.id === "ps-days") { readStart(); if (st.rows) { planQty(st); renderStart(); } } });
  }

  function bind() {
    const tab = $("tab-po"), box = $("po-edit-view");
    $("po-new").addEventListener("click", () => newOrder());
    $("po-sheet").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; sheetOrder(f); });
    bindStart();
    $("po-refresh").addEventListener("click", async () => { await Promise.all([refresh(true), S.cat ? catalog(true) : null]); if (S.ed && S.ed.id && !S.ed.dirty) openPO(S.ed.id); });
    $("po-q").addEventListener("input", (e) => { S.q = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(renderList, 150); });
    $("po-vendor").addEventListener("change", (e) => { S.vendor = e.target.value; renderList(); });
    $("po-stage").addEventListener("click", (e) => { const b = e.target.closest("button[data-st]"); if (b) { S.stage = b.dataset.st; renderList(); } });
    tab.addEventListener("click", (e) => {
      if (e.target.closest("[data-po-start]")) { newOrder(); return; }
      const ivo = e.target.closest("[data-inv-open]"); if (ivo) { e.stopPropagation(); if (S.ed && S.ed.dirty) return leave(); note("", ""); window.JTInvoices.open(ivo.dataset.invOpen); return; }
      const sg = e.target.closest("[data-st-go]"); if (sg) { S.stage = sg.dataset.stGo; renderList(); if (sg.classList.contains("kpi-go")) { const t2 = $("po-table"); if (t2) t2.scrollIntoView({ behavior: "smooth", block: "start" }); } return; }
      const ap = e.target.closest("[data-po-approve]"); if (ap) { e.stopPropagation(); approveOrder(ap.dataset.poApprove); return; }
      const mk = e.target.closest("[data-po-mark]"); if (mk) { e.stopPropagation(); markOrdered(mk.dataset.poMark); return; }
      const ln = e.target.closest("[data-olane]"); if (ln) { S.stage = S.stage === ln.dataset.olane && !ln.classList.contains("il-more") ? "open" : ln.dataset.olane; renderList();
        if (S.stage !== "open") { const t2 = $("po-table"); if (t2) t2.scrollIntoView({ behavior: "smooth", block: "start" }); } return; }
      const o = e.target.closest("[data-po-open]"); if (o && !e.target.closest("a")) { note("", ""); openCard(o); } });
    wireLaneDrag($("po-lanes"), "po"); wireLaneDrag($("inv-lanes"), "inv");
    $("po-table").addEventListener("click", (e) => { const b = e.target.closest("[data-sort]"); if (b) { e.stopPropagation(); toggleSort("po", PO_KEYS, b.dataset.sort); renderList(); } });
    $("inv-table").addEventListener("click", (e) => { const b = e.target.closest("[data-sort]"); if (b) { e.stopPropagation(); toggleSort("inv", INV_KEYS, b.dataset.sort); renderInvList(); } });
    $("inv-lanes").addEventListener("keydown", (e) => { const o = e.target.closest("[data-inv-open]"); if (o && e.target === o && !e.altKey && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openInvoice(o.dataset.invOpen); } });
    $("po-lanes").addEventListener("keydown", (e) => { const o = e.target.closest("[data-po-open]"); if (o && e.target === o && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openCard(o); } });
    $("po-table").addEventListener("keydown", (e) => { const o = e.target.closest("[data-po-open]"); if (o && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openPO(o.dataset.poOpen); } });
    // a PDF dropped anywhere on the tab
    const isFile = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
    tab.addEventListener("dragover", (e) => { if (isFile(e)) { e.preventDefault(); if (window.JTReader) window.JTReader.warm(); if (S.ed) tab.classList.add("filedrop"); } });
    tab.addEventListener("dragleave", (e) => { if (!tab.contains(e.relatedTarget)) tab.classList.remove("filedrop"); });
    tab.addEventListener("drop", (e) => { if (!isFile(e)) return; e.preventDefault(); tab.classList.remove("filedrop"); const f = e.dataTransfer.files[0];
      if (f && /\.(csv|tsv|xlsx|xls)$/i.test(f.name) && (!S.ed || S.ed.status === "draft")) sheetOrder(f); else readPdf(f); });
    // ---- the Invoices tab ----
    const itab = $("tab-invoices");
    $("inv-file").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; S.mode = "inv"; readPdf(f); });
    $("inv-refresh").addEventListener("click", async () => {
      await Promise.all([loadInvList(true), loadOrders(true), catalog(true)]);
      if (S.ed && S.invOpen) {
        const n = rematch(S.ed, false);    // new Shopify products: the open invoice's unmatched lines get another try
        if (n) { syncLines(S.ed); S.ed.dirty = true; render(); note("info", rematchMsg(n)); return; }
        if (S.ed.id && !S.ed.dirty) await openInvoice(cur(S.ed).id);
      }
      render();
    });
    $("inv-q").addEventListener("input", (e) => { S.invQ = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(renderInvList, 150); });
    $("inv-seg").addEventListener("click", (e) => { const b = e.target.closest("button[data-invf]"); if (b) { S.invF = b.dataset.invf; renderInvList(); } });
    $("inv-lanes").addEventListener("click", (e) => { const b = e.target.closest("[data-lane]"); if (!b) return; e.stopPropagation();
      S.invF = S.invF === b.dataset.lane && !b.classList.contains("il-more") ? "all" : b.dataset.lane; renderInvList();
      if (S.invF !== "all") { const t = $("inv-table"); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); } });
    itab.addEventListener("click", (e) => {
      const g = e.target.closest("[data-po-go]"); if (g) { e.stopPropagation(); S.invOpen = false; S.mode = "po"; const b = document.querySelector('.tabs button[data-tab="po"]'); if (b) b.click(); openPO(g.dataset.poGo); return; }
      const o = e.target.closest("[data-inv-open]"); if (o && !e.target.closest("a")) { openInvoice(o.dataset.invOpen); return; }
      const pb = e.target.closest("[data-pend]"); if (pb) { pendGo(pb.dataset.pend, pb.dataset.o); return; }
    });
    $("inv-table").addEventListener("keydown", (e) => { const o = e.target.closest("[data-inv-open]"); if (o && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openInvoice(o.dataset.invOpen); } });
    itab.addEventListener("dragover", (e) => { if (isFile(e)) { e.preventDefault(); if (window.JTReader) window.JTReader.warm(); itab.classList.add("filedrop"); } });
    itab.addEventListener("dragleave", (e) => { if (!itab.contains(e.relatedTarget)) itab.classList.remove("filedrop"); });
    itab.addEventListener("drop", (e) => { if (!isFile(e)) return; e.preventDefault(); itab.classList.remove("filedrop"); S.mode = "inv"; readPdf(e.dataTransfer.files[0]); });
    $("po-note").addEventListener("click", (e) => { const b = e.target.closest("[data-pact]"); if (b) act(b.dataset.pact); });
    box.addEventListener("change", (e) => {
      const ed = S.ed, t = e.target; if (!ed) return;
      const iv = cur(ed);
      if (t.id === "pe-cat" || t.id === "pe-budget") { savePlan(ed, t.id === "pe-cat" ? "category" : "budget", t.value); return; }
      if (t.dataset.f === "ivdemo" && iv) { const r = iv.rows.find(x => x.id === t.dataset.k), l = r && ed.lines.find(x => String(x.vid) === String(r.vid));
        if (l && !(l.received > 0)) { l.dest = t.checked ? "demo" : newDest(ed) === "demo" ? "shopify" : newDest(ed); l.asku = ""; mergeLines(ed); ed.dirty = true; render(); } return; }
      if (t.id === "inv-arrange") { const how = t.value; t.value = ""; if (how && iv && arrangeRows(ed, iv, how)) { ed.dirty = true; render(); note("info", "Lines reorganized. Save to keep the order."); } return; }
      if (t.id === "po-arrange") { const how = t.value; t.value = ""; if (how && arrange(ed, how)) { ed.dirty = true; render(); note("info", "Lines rearranged. Save to keep the order."); } return; }
      if (t.id === "pe-file") { const f = t.files[0]; t.value = ""; readPdf(f); return; }
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
      if (t.dataset.f === "dest" && l) { const oldK = keyOf(l); if (t.value === "@shopify") { l.dest = "shopify"; l.asku = ""; } else if (t.value === "@demo") { l.dest = "demo"; l.asku = ""; } else { l.dest = "prep"; l.asku = t.value; }
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
      if (t.id === "po-find") { ed.find = t.value; clearTimeout(box._ft); box._ft = setTimeout(render, 200); return; }
      if (t.dataset.f === "rq" && l && cur(ed)) { ed.rq = ed.rq || {}; ed.rq[rqKey(cur(ed), l)] = t.value.trim(); clearTimeout(box._t); box._t = setTimeout(render, 500); }
      if (t.dataset.f === "unrq" && ed.unrecv) { ed.unrecv.n = t.value.trim(); clearTimeout(box._t); box._t = setTimeout(render, 400); }
      if (t.dataset.f === "spq" && ed.split) { const x = ed.split.parts[Number(t.dataset.k)]; if (x) x.q = t.value.trim();
        clearTimeout(box._t); box._t = setTimeout(() => { const f = document.activeElement, fk = f && f.dataset && f.dataset.f === "spq" ? f.dataset.k : null, pos = f && f.selectionStart;
          render(); if (fk != null) { const n = box.querySelector('[data-f="spq"][data-k="' + fk + '"]'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (_) {} } } }, 500); }
      if (t.dataset.f === "iqty" && r) { r.qty = t.value.trim(); syncLines(ed); ed.dirty = true; clearTimeout(box._t); box._t = setTimeout(render, 400); }
      if (t.dataset.f === "icost" && r) { r.cost = t.value.trim().replace(/^\$/, ""); syncLines(ed); ed.dirty = true; clearTimeout(box._t); box._t = setTimeout(render, 400); }
    });
    // ---- reordering lines: drag a row by its handle, or Alt+Up / Alt+Down on the handle (v0.34.0) ----
    const dropClear = () => box.querySelectorAll("tr.drop-above, tr.drop-below, tr.dragging").forEach(x => x.classList.remove("drop-above", "drop-below", "dragging"));
    box.addEventListener("dragstart", (e) => {
      const h = e.target.closest && e.target.closest("[data-drag]"); if (!h || !S.ed) return;
      box._drag = h.dataset.drag; box._dkind = h.dataset.dkind || "line"; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", h.dataset.drag); } catch (_) {}
      const tr = h.closest("tr"); if (tr) { tr.classList.add("dragging"); try { e.dataTransfer.setDragImage(tr, 20, 20); } catch (_) {} }
    });
    box.addEventListener("dragover", (e) => {
      if (!box._drag) return; const tr = e.target.closest && e.target.closest(box._dkind === "row" ? "tr[data-row]" : "tr[data-line]"); if (!tr) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      const r = tr.getBoundingClientRect(), below = e.clientY > r.top + r.height / 2;
      box.querySelectorAll("tr.drop-above, tr.drop-below").forEach(x => { if (x !== tr) x.classList.remove("drop-above", "drop-below"); });
      tr.classList.toggle("drop-below", below); tr.classList.toggle("drop-above", !below);
    });
    box.addEventListener("drop", (e) => {
      if (!box._drag || !S.ed) return; const rowK = box._dkind === "row", tr = e.target.closest && e.target.closest(rowK ? "tr[data-row]" : "tr[data-line]"); e.preventDefault();
      const from = box._drag; box._drag = null; const below = tr && tr.classList.contains("drop-below"); dropClear();
      const to = tr && (rowK ? tr.dataset.row : tr.dataset.line);
      if (to && to !== from && (rowK ? moveRow(cur(S.ed), from, to, below) : moveLine(S.ed, from, to, below))) { S.ed.dirty = true; render(); }
    });
    box.addEventListener("dragend", () => { box._drag = null; dropClear(); });
    box.addEventListener("keydown", (e) => {
      const ed = S.ed; if (!ed) return;
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && e.target.dataset && e.target.dataset.drag) {
        e.preventDefault(); const id = e.target.dataset.drag, rowK = e.target.dataset.dkind === "row";
        const rows = [...box.querySelectorAll(rowK ? "tr[data-row]" : "tr[data-line]")].map(x => rowK ? x.dataset.row : x.dataset.line), i = rows.indexOf(id), j = e.key === "ArrowUp" ? i - 1 : i + 1;
        if (i >= 0 && j >= 0 && j < rows.length && (rowK ? moveRow(cur(ed), id, rows[j], e.key === "ArrowDown") : moveLine(ed, id, rows[j], e.key === "ArrowDown"))) { ed.dirty = true; render(); }
        return;
      }
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
      if (b.dataset.paddto) { ed.addTo = b.dataset.paddto; render(); return; }
      if (b.dataset.pdest) { const l = ed.lines.find(x => x.id === b.dataset.k); if (!l || l.dest === b.dataset.pdest) return;
        l.dest = b.dataset.pdest; if (l.dest !== "prep") l.asku = ""; mergeLines(ed); ed.dirty = true; render(); return; }
      if (b.dataset.pview) { ed.view = b.dataset.pview; ed.search = null; ed.confirm = false; render(); return; }
      if (b.dataset.inv != null) { ed.cur = +b.dataset.inv; ed.view = "inv"; ed.search = null; ed.confirm = false; pdfToken++; const h = $("pe-pdf"); if (h) h.innerHTML = "";
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
      const ed = S.ed, n = rematch(ed, false);
      if (n) { syncLines(ed); ed.dirty = true; note("info", rematchMsg(n)); }
      render();
    }).catch(() => {});
    refresh(true).catch(() => {});
  });
  // saved on another tab (received from the Prep center, …): reload the list when this tab is opened next
  window.addEventListener("jt:changed", () => { if ($("tab-po").hidden && $("tab-invoices").hidden) S.stale = true; });
  // ---- unsaved changes hold the page (Brian, Oct 28: "we should not be able to leave the page if there are changes on
  // the page and save/discard has not been chosen"): tabs, the Back/Forward/Recent buttons, the browser's Back, and
  // closing or reloading the window all stop until Save or Discard changes is pressed ----
  function holdForChanges() {
    const ed = S.ed;
    if (!ed || !ed.dirty || ed.leaveOk) return false;
    const onPO = !$("tab-po").hidden, onInv = !$("tab-invoices").hidden && S.invOpen;
    if (!onPO && !onInv) return false;
    note("warn", `<b>Save or discard your changes first.</b> <span class="dbtns"><button class="mini primary" data-pact="save">Save</button><button class="mini" data-pact="revert">Discard changes</button></span>`);
    const n = $("po-note"); if (n && n.scrollIntoView) n.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return true;
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".tabs button, #nav-rmenu [data-nav-go]");
    if (b && holdForChanges()) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  { const reg = () => { if (window.JTNav && window.JTNav.guard) window.JTNav.guard(holdForChanges); }; reg(); document.addEventListener("DOMContentLoaded", reg); }
  window.addEventListener("beforeunload", (e) => { if (S.ed && S.ed.dirty && !S.ed.leaveOk) { e.preventDefault(); e.returnValue = ""; } });
  // the Orders tab is the way back to the swimlanes (v0.33: no "← All orders" link on a PO). Only a person's click:
  // JTPO.open clicks the tab too, then opens a PO.
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest('.tabs button[data-tab="po"], .tabs button[data-tab="invoices"]');
    if (b && e.isTrusted) { const inv = b.dataset.tab === "invoices";
      setTimeout(() => { if (S.ed && (inv ? S.mode === "inv" && S.invOpen : S.mode === "po")) leave(); }, 0); }
  }, true);
  window.poShow = () => { S.mode = "po"; S.invOpen = false; if (!S.shown) { S.shown = true; refresh(false); catalog().catch(() => {}); } else if (S.stale && !S.ed) { S.stale = false; refresh(true); } render(); };
  window.invShow = () => {
    S.mode = "inv";
    if (!S.invShown) { S.invShown = true; catalog().catch(() => {}); if (!S.orders) loadOrders(false).catch(() => {}); }
    render(); loadInvList(false).then(render).catch(e => note("bad", esc(JT.message(e))));
    // wake the invoice reader now, so it's running by the time a PDF is dropped (it starts in ~30 s, stays up 10 min)
    if (window.JTReader) (window.JTWeb ? window.JTWeb.ready : Promise.resolve()).then(() => window.JTReader.warm());
  };
  // choosing a PDF with a file button: wake the reader while the file picker is open
  document.addEventListener("click", (e) => { const t = e.target; if (t && t.matches && t.matches('#inv-file, #pe-file, label[for="inv-file"], label[for="pe-file"]') && window.JTReader) window.JTReader.warm(); }, true);
  window.JTPO = { _state: S, render: () => render(), open: (id) => { const b = document.querySelector('.tabs button[data-tab="po"]'); if (b) b.click(); openPO(id); }, openInvoice, guessLine, merge, progress };
  // the Prep center (and tests) open invoices this way
  window.JTInvoices = { open: (id) => { const b = document.querySelector('.tabs button[data-tab="invoices"]'); if (b && $("tab-invoices").hidden) b.click(); openInvoice(id); } };
  // opened from a link: #po, #po/41, #invoices, #invoices/123
  // (waits for sign-in on the web, so a shared link opens the PO once the person has logged in)
  { const h = window.__bootHash != null ? window.__bootHash : (location.hash || ""), mp = /^#po\/(\d+)/.exec(h), mi = /^#invoices\/(\d+)/.exec(h);
    const go = (fn) => (window.JTWeb ? window.JTWeb.ready : Promise.resolve()).then(() => setTimeout(fn, 0));
    if (mi) go(() => { window.JTInvoices.open(mi[1]); });
    else if (h === "#invoices") setTimeout(() => window.invShow(), 0);   // the tab code ran before this page was loaded
    if (mp) go(() => { window.JTPO.open(mp[1]); });
    else if (h === "#po") setTimeout(() => window.poShow(), 0);
  }
  // Back / Forward / Recent / a pasted link land here (nav.js has already switched to the page)
  if (window.JTNav) {
    const stay = () => { window.JTNav.done(); syncHash(); };              // unsaved changes kept the view: keep its address
    window.JTNav.on("po", (rest) => {
      const id = (/^(\d+)/.exec(rest) || [])[1];
      if (id) { if (!(S.ed && String(S.ed.id) === id && !S.invOpen)) openPO(id); else stay(); return; }
      if (S.ed) { leave(); if (S.ed) stay(); }
    });
    window.JTNav.on("invoices", (rest) => {
      const id = (/^(\d+)/.exec(rest) || [])[1];
      if (id) { const iv = S.ed && S.invOpen && cur(S.ed); if (!(iv && String(iv.id) === id)) openInvoice(id); else stay(); return; }
      if (S.invOpen) { leave(); if (S.invOpen) stay(); }
    });
  }
})();
