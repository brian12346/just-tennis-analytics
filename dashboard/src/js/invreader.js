/* ===================== Invoice reader client (window.JTReader) =====================
   Sends a dropped invoice PDF to the reader service (vendor templates + OCR for scans) and waits for the result,
   in the same shape window.JTInvParse.parseInvoice returns, so readPdf() can use it unchanged.
   Uses JT.run / JT.q (connector) or JTWeb.write (web version). Migrations 097-100: a queued read starts the GitHub
   Actions reader (invoice-read.yml); a cold start takes about a minute, then reads take seconds while it's running.
   skip(): stop waiting for the read in progress (the page uses the quick in-browser reader instead).

   JTReader.read(bytes, name, opts) resolves to
     { ok: true,  inv, others, outcome, readId, templ }   template read: outcome auto_ok (totals tie) | needs_review
     { ok: false, outcome, message, readId }              unknown_vendor | unsupported | error | timeout | off
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
  // The reader service turns `off` here when it hasn't answered anything for a while, so drops don't wait for nothing.
  let offUntil = 0, skipNow = false;

  async function read(bytes, name, opts = {}) {
    const timeoutMs = opts.timeoutMs || 150000, onWait = opts.onWait || (() => {});
    skipNow = false;
    if (Date.now() < offUntil) return { ok: false, outcome: "off", message: "The invoice reader isn't answering right now." };
    let readId = null;
    try {
      const n = Math.max(1, Math.ceil(bytes.length / PART));
      readId = Number(await call("invoice_read_start", { name, parts: n }));
      for (let k = 0; k < n; k++) {
        onWait(n > 1 ? `Sending the PDF to the invoice reader… ${k + 1} of ${n}` : "Sending the PDF to the invoice reader…");
        await call("invoice_read_put", { read_id: readId, part: k, data: toB64(bytes.subarray(k * PART, (k + 1) * PART)) });
      }
      const t0 = Date.now(); let r = null, wait = 1200;
      while (Date.now() - t0 < timeoutMs) {
        for (let s = 0; s < wait && !skipNow; s += 250) await sleep(250);
        if (skipNow) return { ok: false, outcome: "skipped", message: "", readId };
        wait = Math.min(wait * 1.4, 3000);
        r = await call("invoice_read_get", readId, "id");
        if (typeof r === "string") r = JSON.parse(r);
        if (!r) break;
        if (r.status === "done" || r.status === "failed") break;
        const secs = Math.round((Date.now() - t0) / 1000);
        onWait(r.status === "reading" ? `Reading the invoice with the vendor template… ${secs}s (a scan takes 10–30 seconds)` : `Starting the invoice reader… ${secs}s (about a minute when it hasn't run lately)`);
      }
      if (!r || (r.status !== "done" && r.status !== "failed")) {
        if (!r || r.status === "queued") offUntil = Date.now() + 5 * 60000;      // nobody picked it up: stop waiting for a while
        return { ok: false, outcome: "timeout", message: "The invoice reader didn't answer in time.", readId };
      }
      const res = r.result || {};
      if (r.status === "failed" || r.outcome === "error") return { ok: false, outcome: "error", message: r.error || "The invoice reader failed.", readId };
      if (r.outcome === "unknown_vendor" || r.outcome === "unsupported" || !(res.invoices || []).length)
        return { ok: false, outcome: r.outcome, message: res.message || "", readId };
      const [inv, ...others] = res.invoices.map(shape);
      return { ok: true, inv, others, outcome: r.outcome, readId, templ: r.vendor };
    } catch (e) {
      console.warn("[JTReader]", e);
      return { ok: false, outcome: "error", message: (e && e.message) || String(e), readId };
    }
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

  window.JTReader = { read, link, shape, skip: () => { skipNow = true; } };
})();
