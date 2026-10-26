/* ===================== Invoice reader client (window.JTReader) =====================
   Sends a dropped invoice PDF to the reader service (vendor templates + OCR for scans) and waits for the result,
   in the same shape window.JTInvParse.parseInvoice returns, so readPdf() can use it unchanged.
   Uses JT.run / JT.q (connector) or JTWeb.write (web version). Migrations 097-100: a queued read starts the GitHub
   Actions reader (invoice-read.yml); a cold start takes about a minute, then reads take seconds while it's running.
   skip(): stop waiting for the read in progress (the page uses the quick in-browser reader instead).
   wait(readId, {kick}): wait again for a read already sent: "Try again" after a time-out or a failed read (migration 167).
   warm(): start the reader before a PDF is dropped (Invoices tab opened, a file dragged in).

   JTReader.read(bytes, name, opts) resolves to
     { ok: true,  inv, others, outcome, readId, templ }   template read: outcome auto_ok (totals tie) | needs_review
     { ok: false, outcome, message, readId, retry }       unknown_vendor | unsupported | error | timeout | skipped
                                                          (retry: true when wait(readId, {kick: true}) can try again)
   It never throws; on anything but ok, fall back to the in-browser reader (IP.parseInvoice).
*/
(() => {
  const JT = window.JT, WEB = window.JTWeb || null;
  const PART = 66000;                           // same raw bytes per part as the Purchase orders script
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function toB64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); }
  async function call(fn, p, cast) {             // jt.<fn>(p) -> scalar
    if (WEB) return WEB.write("jt_" + fn, cast === "id" ? { rid: p } : { p });
    const arg = cast === "id" ? JT.int(p) : `${JT.q(JSON.stringify({ ...p, by: p.by || "Claude dashboard" }))}::jsonb`;
    const out = await JT.run(`select jt.${fn}(${arg}) as r`, true);
    return out[0] && out[0].r;
  }
  let skipNow = false, warmAt = 0;

  // wake the reader (a GitHub Actions run) before a PDF arrives: Invoices tab opened, a file dragged in. Throttled.
  function warm() {
    if (Date.now() - warmAt < 120000) return;
    warmAt = Date.now();
    (WEB ? WEB.write("jt_invoice_reader_warm", { p: {} }) : JT.run("select jt.invoice_reader_warm() as r", true)).catch(() => {});
  }

  async function read(bytes, name, opts = {}) {
    skipNow = false;
    let readId = null;
    try {
      const n = Math.max(1, Math.ceil(bytes.length / PART));
      readId = Number(await call("invoice_read_start", { name, parts: n }));
      for (let k = 0; k < n; k++) {
        (opts.onWait || (() => {}))(n > 1 ? `Sending the PDF to the invoice reader… ${k + 1} of ${n}` : "Sending the PDF to the invoice reader…");
        await call("invoice_read_put", { read_id: readId, part: k, data: toB64(bytes.subarray(k * PART, (k + 1) * PART)) });
      }
    } catch (e) {
      console.warn("[JTReader]", e);
      return { ok: false, outcome: "error", message: (e && e.message) || String(e), readId, retry: false };
    }
    return wait(readId, opts);
  }

  // wait for a read already sent (also "Try again": no re-upload). kick: re-queue a failed read / restart the reader first.
  async function wait(readId, opts = {}) {
    const timeoutMs = opts.timeoutMs || 150000, onWait = opts.onWait || (() => {});
    skipNow = false;
    try {
      let r = null, gap = 1200;
      if (opts.kick) { r = await call("invoice_read_kick", readId, "id"); if (typeof r === "string") r = JSON.parse(r); gap = 400; }
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        for (let s = 0; s < gap && !skipNow; s += 250) await sleep(250);
        if (skipNow) return { ok: false, outcome: "skipped", message: "", readId, retry: true };
        gap = Math.min(gap * 1.4, 3000);
        try { r = await call("invoice_read_get", readId, "id"); }
        catch (e) { console.warn("[JTReader] poll", e); continue; }   // one slow answer isn't the end of the read
        if (typeof r === "string") r = JSON.parse(r);
        if (!r) break;
        if (r.status === "done" || r.status === "failed") break;
        const secs = Math.round((Date.now() - t0) / 1000);
        onWait(r.status === "reading" ? `Reading the invoice with the vendor template… ${secs}s (a scan takes 10–30 seconds)` : `Starting the invoice reader… ${secs}s (usually under a minute)`);
      }
      if (!r || (r.status !== "done" && r.status !== "failed")) {
        const msg = r && r.status === "reading" ? "it's still reading the PDF" : "it hasn't started yet";
        return { ok: false, outcome: "timeout", message: msg, readId, retry: true };
      }
      return outcomeOf(r, readId);
    } catch (e) {
      console.warn("[JTReader]", e);
      return { ok: false, outcome: "error", message: (e && e.message) || String(e), readId, retry: true };
    }
  }

  // one look at a read: its result when it's finished, else null (the retry prompt checks in the background)
  async function peek(readId) {
    try {
      let r = await call("invoice_read_get", readId, "id");
      if (typeof r === "string") r = JSON.parse(r);
      return r && (r.status === "done" || r.status === "failed") ? outcomeOf(r, readId) : null;
    } catch (_) { return null; }
  }

  function outcomeOf(r, readId) {
    const res = r.result || {};
    if (r.status === "failed" || r.outcome === "error") return { ok: false, outcome: "error", message: r.error || "The invoice reader failed.", readId, retry: true };
    if (r.outcome === "unknown_vendor" || r.outcome === "unsupported" || !(res.invoices || []).length)
      return { ok: false, outcome: r.outcome, message: res.message || "", readId };
    const [inv, ...others] = res.invoices.map(shape);
    return { ok: true, inv, others, outcome: r.outcome, readId, templ: r.vendor };
  }

  // reader result -> JTInvParse.parseInvoice shape (+ extras the page may show: status, issues, early_pay, template)
  function shape(x) {
    const all = x.lines || [];
    const lines = all.filter(l => (l.kind || "item") === "item").map(l => ({
      item_code: l.item_code || "", upc: l.upc || "", description: l.description || "",
      qty: l.qty, unit_cost: l.unit_cost, amount: l.amount }));
    // charges -> merge() makes them non-product rows (chargeRow(label, amount, account)); account is the QuickBooks bucket:
    // freight -> inbound_shipping; vendor discounts and other fees (tariffs, surcharges) -> inventory (landed cost)
    const charges = [
      ...(x.charges || []).map(c => ({ label: c.label || "Freight", amount: c.amount, kind: c.kind === "inbound_shipping" ? "inbound_shipping" : "inventory" })),
      ...all.filter(l => l.kind === "discount").map(l => ({ label: l.description || "Discount", amount: l.amount, kind: "inventory" }))
    ];
    return {
      vendor: x.vendor || "", invoice_no: x.invoice_no || "", invoice_date: x.invoice_date || "", po_no: x.po_no || "",
      subtotal: x.subtotal, total: x.total, due_date: x.due_date || "", terms: x.terms || "", lines, charges,
      read: { status: x.status, issues: x.issues || [], template: x.template || "", early_pay: x.early_pay || [],
              doc_type: x.doc_type || "invoice", vendor_order_no: x.vendor_order_no || "", tax: x.tax, qbo_vendor: x.qbo_vendor || null }
    };
  }

  // after the invoice is saved: tie the read to it (keeps "invoices to learn" tidy). Fire and forget.
  function link(readId, invoiceId) {
    if (!readId || !invoiceId) return;
    if (WEB) WEB.write("jt_invoice_read_link", { p: { read_id: readId, invoice_id: Number(invoiceId) } }).catch(() => {});
    else JT.run(`select jt.invoice_read_link(${JT.q(JSON.stringify({ read_id: readId, invoice_id: Number(invoiceId) }))}::jsonb) as r`, true).catch(() => {});
  }

  window.JTReader = { read, wait, peek, warm, link, shape, skip: () => { skipNow = true; } };
})();
