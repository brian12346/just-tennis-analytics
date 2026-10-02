// QuickBooks Online for the Just Tennis dashboard.
// POST {action: "status"}            -> company, accounts, vendor count (checks the connection)
// POST {action: "query", q: "select …"} -> a read-only QuickBooks query
// POST {action: "vendors"}           -> active QuickBooks vendors (for matching)
// POST {action: "create_bill", invoice_id, vendor_id?, force?} -> enters the invoice as a bill, once
//   (links an existing bill with the same number for the same vendor instead of entering it twice),
//   with the invoice PDF attached
// POST {action: "attach", invoice_id}  -> attaches the invoice PDF to its bill (bills entered earlier)
// POST {action: "payables_sync", full?} -> vendors, bills, bill payments and vendor credits -> schema fin (the finance
//   dashboard). Only what changed since the last pass, or everything with full (also once a week by itself, which
//   catches bills deleted in QuickBooks).
// Callers: a signed-in app user (Authorization: Bearer <user JWT>), or SQL via jt.qbo_call (x-jt-key). Accounts on
// the finance list only (fin.users) may run status and payables_sync, nothing else.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-jt-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BASES: Record<string, string> = { production: "https://quickbooks.api.intuit.com", sandbox: "https://sandbox-quickbooks.api.intuit.com" };
const MINOR = "75";

type Creds = Record<string, string>;
async function creds(): Promise<Creds> {
  const { data, error } = await admin.rpc("jt_qbo_creds");
  if (error) throw new Error("reading credentials: " + error.message);
  return data || {};
}
async function save(p: Record<string, string>) {
  const { error } = await admin.rpc("jt_qbo_save_tokens", { p });
  if (error) throw new Error("saving tokens: " + error.message);
}
async function refresh(c: Creds): Promise<string> {
  const r = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(c.qbo_client_id + ":" + c.qbo_client_secret), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.qbo_refresh_token }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error(`QuickBooks sign-in failed (${r.status}): ${t.error_description || t.error || "no access token"} — the refresh token may need reconnecting in the OAuth Playground`);
  const exp = new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString();
  await save({ access_token: t.access_token, access_expires: exp, refresh_token: t.refresh_token || "" });
  c.qbo_access_token = t.access_token; c.qbo_access_expires = exp; if (t.refresh_token) c.qbo_refresh_token = t.refresh_token;
  return t.access_token;
}
async function token(c: Creds, force = false): Promise<string> {
  if (!force && c.qbo_access_token && c.qbo_access_expires && new Date(c.qbo_access_expires).getTime() - Date.now() > 5 * 60 * 1000) return c.qbo_access_token;
  return refresh(c);
}
// a GET against the company; works out production vs sandbox on the first call
async function api(c: Creds, path: string, tries = 0): Promise<any> {
  const at = await token(c, tries > 0);
  const envs = c.qbo_env ? [c.qbo_env] : ["production", "sandbox"];
  let last: any = null;
  for (const env of envs) {
    const r = await fetch(`${BASES[env]}/v3/company/${c.qbo_realm_id}/${path}${path.includes("?") ? "&" : "?"}minorversion=${MINOR}`, { headers: { Authorization: "Bearer " + at, Accept: "application/json" } });
    const b = await r.json().catch(() => ({}));
    if (r.ok) { if (!c.qbo_env) { await save({ env }); c.qbo_env = env; } return b; }
    last = { status: r.status, env, body: b };
    if (r.status === 401 && tries === 0 && c.qbo_env) { return api(c, path, 1); }
  }
  const f = last?.body?.Fault?.Error?.[0] || last?.body?.fault?.error?.[0];
  throw new Error(`QuickBooks API ${last?.status} (${last?.env}): ${f ? `${f.Message || f.message} — ${f.Detail || f.detail || ""}` : JSON.stringify(last?.body).slice(0, 300)}`);
}
async function post(c: Creds, path: string, body: unknown): Promise<any> {
  await api(c, `companyinfo/${c.qbo_realm_id}`);   // makes sure the token and environment are worked out
  const r = await fetch(`${BASES[c.qbo_env]}/v3/company/${c.qbo_realm_id}/${path}?minorversion=${MINOR}`, {
    method: "POST", headers: { Authorization: "Bearer " + c.qbo_access_token, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) { const f = b?.Fault?.Error?.[0]; throw new Error(`QuickBooks didn't take it (${r.status}): ${f ? `${f.Message} — ${f.Detail || ""}` : JSON.stringify(b).slice(0, 300)}`); }
  return b;
}
const qs = (v: string) => "'" + String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
const query = (c: Creds, q: string) => api(c, "query?query=" + encodeURIComponent(q));

// who is calling: an app user's email, "Claude dashboard" for the function key, or null (not allowed)
async function caller(req: Request, c: Creds): Promise<string | null> {
  const k = req.headers.get("x-jt-key");
  if (k && c.jt_fn_key && k === c.jt_fn_key) return "Claude dashboard";
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await admin.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: ok } = await admin.rpc("jt_qbo_allowed", { uid: data.user.id });
  if (ok) return data.user.email || "app user";
  const { data: fin } = await admin.rpc("fin_allowed", { uid: data.user.id });
  return fin ? "finance:" + (data.user.email || "user") : null;
}

// ---- payables for the finance dashboard
async function queryAll(c: Creds, entity: string, where: string): Promise<any[]> {
  const out: any[] = [];
  for (let start = 1; start < 100000; start += 1000) {
    const r = (await query(c, `select * from ${entity}${where ? " where " + where : ""} startposition ${start} maxresults 1000`)).QueryResponse || {};
    const rows = r[entity] || [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
const ref = (r: any) => ({ id: r?.value || "", name: r?.name || "" });
async function payablesSync(c: Creds, full: boolean) {
  const { data: last } = await admin.rpc("fin_qbo_last_sync");
  const lastFull = last?.last_full ? new Date(last.last_full).getTime() : 0;
  const doFull = full || !last?.at || Date.now() - lastFull > 7 * 86400000;
  const started = new Date().toISOString();
  // a few minutes of overlap so nothing changed during the last pass is missed
  const since = doFull ? "" : new Date(new Date(last.at).getTime() - 10 * 60000).toISOString();
  const upd = since ? `MetaData.LastUpdatedTime >= '${since}'` : "";
  const vendors = (await queryAll(c, "Vendor", upd ? `${upd} and Active in (true, false)` : "Active in (true, false)")).map((v: any) => ({
    id: v.Id, name: v.DisplayName || v.CompanyName || "", active: v.Active !== false, balance: Number(v.Balance || 0),
    terms: v.TermRef?.name || "", email: v.PrimaryEmailAddr?.Address || "", updated: v.MetaData?.LastUpdatedTime }));
  const bills = (await queryAll(c, "Bill", upd)).map((b: any) => ({
    id: b.Id, vendor_id: ref(b.VendorRef).id, vendor_name: ref(b.VendorRef).name, doc: b.DocNumber || "", date: b.TxnDate || null, due: b.DueDate || null,
    total: Number(b.TotalAmt || 0), balance: Number(b.Balance || 0), currency: b.CurrencyRef?.value || "USD", memo: b.PrivateNote || "",
    lines: (b.Line || []).filter((l: any) => l.DetailType !== "SubTotalLineDetail").map((l: any) => ({
      account: l.AccountBasedExpenseLineDetail?.AccountRef?.name || l.ItemBasedExpenseLineDetail?.ItemRef?.name || "", amount: Number(l.Amount || 0), description: l.Description || "" })),
    created: b.MetaData?.CreateTime, updated: b.MetaData?.LastUpdatedTime }));
  const payments = (await queryAll(c, "BillPayment", upd)).map((x: any) => ({
    id: x.Id, vendor_id: ref(x.VendorRef).id, vendor_name: ref(x.VendorRef).name, doc: x.DocNumber || "", date: x.TxnDate || null, total: Number(x.TotalAmt || 0),
    pay_type: x.PayType || "", account: x.CheckPayment?.BankAccountRef?.name || x.CreditCardPayment?.CCAccountRef?.name || "",
    bills: (x.Line || []).flatMap((l: any) => (l.LinkedTxn || []).filter((t: any) => t.TxnType === "Bill").map((t: any) => ({ bill_id: t.TxnId, amount: Number(l.Amount || 0) }))),
    updated: x.MetaData?.LastUpdatedTime }));
  const credits = (await queryAll(c, "VendorCredit", upd)).map((x: any) => ({
    id: x.Id, vendor_id: ref(x.VendorRef).id, vendor_name: ref(x.VendorRef).name, doc: x.DocNumber || "", date: x.TxnDate || null,
    total: Number(x.TotalAmt || 0), balance: Number(x.Balance || 0), memo: x.PrivateNote || "", updated: x.MetaData?.LastUpdatedTime }));
  let saved = 0;
  const send = async (part: Record<string, unknown>) => {
    const { data, error } = await admin.rpc("fin_qbo_payables_save", { p: part });
    if (error) throw new Error("saving payables: " + error.message);
    saved += Number(data || 0);
  };
  await send({ vendors });
  for (let i = 0; i < bills.length; i += 400) await send({ bills: bills.slice(i, i + 400) });
  for (let i = 0; i < payments.length; i += 400) await send({ payments: payments.slice(i, i + 400) });
  await send({ credits });
  await send({ finished: { at: started, started, full: doFull, last_full: doFull ? started : last?.last_full || null,
    counts: { vendors: vendors.length, bills: bills.length, payments: payments.length, credits: credits.length } } });
  return { ok: true, full: doFull, since: since || null, vendors: vendors.length, bills: bills.length, payments: payments.length, credits: credits.length, saved };
}

// the invoice PDF onto the bill (QuickBooks "upload": a JSON part describing it, then the file); its Attachable id
async function attachFile(c: Creds, invId: number, billId: string): Promise<string | null> {
  const { data: f, error } = await admin.rpc("jt_qbo_invoice_file", { inv: invId });
  if (error) throw new Error(error.message);
  if (!f || !Array.isArray(f.parts) || !f.parts.length) return null;
  const chunks = f.parts.map((b: string) => Uint8Array.from(atob(b), ch => ch.charCodeAt(0)));
  const bytes = new Uint8Array(chunks.reduce((a: number, x: Uint8Array) => a + x.length, 0)); let o = 0; for (const x of chunks) { bytes.set(x, o); o += x.length; }
  const type = f.type || "application/pdf", name = (f.name || `invoice-${invId}.pdf`).replace(/[\\/:*?"<>|]/g, "_");
  await token(c);
  if (!c.qbo_env) await api(c, `companyinfo/${c.qbo_realm_id}`);
  const fd = new FormData();
  fd.append("file_metadata_0", new Blob([JSON.stringify({ AttachableRef: [{ EntityRef: { type: "Bill", value: billId } }], FileName: name, ContentType: type })], { type: "application/json" }), "metadata.json");
  fd.append("file_content_0", new Blob([bytes], { type }), name);
  const r = await fetch(`${BASES[c.qbo_env]}/v3/company/${c.qbo_realm_id}/upload?minorversion=${MINOR}`, { method: "POST", headers: { Authorization: "Bearer " + c.qbo_access_token, Accept: "application/json" }, body: fd });
  const b = await r.json().catch(() => ({}));
  const a = b?.AttachableResponse?.[0];
  if (!r.ok || !a?.Attachable?.Id) { const f2 = a?.Fault?.Error?.[0] || b?.Fault?.Error?.[0]; throw new Error(`the PDF didn't attach (${r.status}): ${f2 ? `${f2.Message} — ${f2.Detail || ""}` : JSON.stringify(b).slice(0, 200)}`); }
  await admin.rpc("jt_qbo_attached", { inv: invId, att: a.Attachable.Id });
  return a.Attachable.Id;
}
// attach, but never fail the bill over it
async function tryAttach(c: Creds, d: any, billId: string): Promise<string> {
  if (!d.has_file) return " (no invoice PDF to attach)";
  try { return (await attachFile(c, d.id, billId)) ? " The invoice PDF is attached." : ""; }
  catch (e) { return ` The invoice PDF didn't attach: ${(e as Error).message}. Use Attach PDF to try again.`; }
}
async function billHasFiles(c: Creds, billId: string): Promise<boolean | null> {
  try { return ((await query(c, `select Id from Attachable where AttachableRef.EntityRef.Type = 'Bill' and AttachableRef.EntityRef.value = ${qs(billId)}`)).QueryResponse?.Attachable || []).length > 0; }
  catch (_) { return null; }
}

const ACCT_NAMES: Record<string, string> = { inventory: "Inventory", inbound_shipping: "Inbound Shipping" };
async function accounts(c: Creds, have: any): Promise<Record<string, { id: string; name: string }>> {
  const out: Record<string, { id: string; name: string }> = { ...(have || {}) };
  let changed = false;
  for (const [k, n] of Object.entries(ACCT_NAMES)) {
    if (out[k]?.id) continue;
    const a = (await query(c, `select Id, Name from Account where Name = ${qs(n)} and Active = true`)).QueryResponse?.Account?.[0];
    if (!a) throw new Error(`there's no "${n}" account in QuickBooks`);
    out[k] = { id: a.Id, name: a.Name }; changed = true;
  }
  if (changed) await admin.rpc("jt_qbo_setting", { k: "qbo_accounts", v: out });
  return out;
}
const words = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2 && !["inc", "llc", "the", "corp", "company", "sporting", "goods"].includes(w));

async function createBill(c: Creds, p: any, by: string) {
  const { data: d, error } = await admin.rpc("jt_qbo_bill_data", { inv: Number(p.invoice_id) });
  if (error) throw new Error(error.message);
  if (!d) return { ok: false, error: "invoice not found" };
  if (d.qbo_bill_id) return { ok: true, already: true, bill_id: d.qbo_bill_id, doc: d.qbo_doc, message: "This invoice is already in QuickBooks." };
  if (!String(d.invoice_no || "").trim()) return { ok: false, error: "The invoice needs an invoice number (it becomes the bill number)." };
  if (!d.invoice_date) return { ok: false, error: "The invoice needs an invoice date (it becomes the bill date)." };
  // vendor: picked now, remembered, or ask (with name matches first)
  const vid = String(p.vendor_id || d.qbo_vendor?.id || "");
  if (!vid) {
    const all = (await query(c, "select Id, DisplayName from Vendor where Active = true maxresults 1000")).QueryResponse?.Vendor || [];
    const w = words(d.vendor);
    const score = (n: string) => { const x = words(n); return w.filter(a => x.some(b => b.startsWith(a) || a.startsWith(b))).length; };
    const ranked = all.map((v: any) => ({ id: v.Id, name: v.DisplayName, s: score(v.DisplayName) })).sort((a: any, b: any) => b.s - a.s || a.name.localeCompare(b.name));
    return { ok: false, need_vendor: true, vendor: d.vendor, suggestions: ranked.filter((v: any) => v.s > 0).slice(0, 5), vendors: ranked.map(({ id, name }: any) => ({ id, name })) };
  }
  const vend = (await query(c, `select Id, DisplayName from Vendor where Id = ${qs(vid)}`)).QueryResponse?.Vendor?.[0];
  if (!vend) return { ok: false, error: "That QuickBooks vendor wasn't found.", need_vendor: true };
  const doc = String(d.invoice_no).trim().slice(0, 21);
  const saved = (bill: any, how: string) => admin.rpc("jt_qbo_bill_saved", { p: { invoice_id: d.id, bill_id: bill.Id, doc: bill.DocNumber || doc, how, by, vendor: d.vendor, vendor_id: vend.Id, vendor_name: vend.DisplayName } });
  // the same bill number for the same vendor is already in QuickBooks: link it, don't enter it twice
  const dup = (await query(c, `select Id, DocNumber, TotalAmt, TxnDate from Bill where DocNumber = ${qs(doc)} and VendorRef = ${qs(vend.Id)}`)).QueryResponse?.Bill?.[0];
  if (dup) {
    await saved(dup, "linked");
    // a bill entered by hand may already carry the PDF: attach only when it has no files
    const has = d.has_file ? await billHasFiles(c, dup.Id) : true;
    const att = has === false ? await tryAttach(c, d, dup.Id) : has === null ? " (couldn't check its attachments — use Attach PDF if it needs the invoice)" : "";
    return { ok: true, duplicate: true, bill_id: dup.Id, doc: dup.DocNumber, total: dup.TotalAmt, vendor: vend.DisplayName, message: `Bill ${dup.DocNumber} was already in QuickBooks for ${vend.DisplayName} — linked it instead of entering it again.${att}` };
  }
  const acc = await accounts(c, d.accounts);
  const lines = Object.entries(d.by_account || {}).map(([k, v]) => [k, Math.round(Number(v) * 100) / 100] as [string, number]).filter(([, v]) => v > 0);
  if (!lines.length) return { ok: false, error: "The invoice comes to $0 — nothing to enter." };
  const sum = Math.round(lines.reduce((a, [, v]) => a + v, 0) * 100) / 100;
  if (d.total != null && Math.abs(Number(d.total) - sum) >= 0.01 && !p.force) return { ok: false, mismatch: true, total: Number(d.total), lines_total: sum, error: `The lines add to ${sum.toFixed(2)} but the invoice total is ${Number(d.total).toFixed(2)}.` };
  const po = d.po_no ? `PO ${d.po_no}` : d.order_id ? `PO #${d.order_id}` : "";
  const body: any = {
    VendorRef: { value: vend.Id }, DocNumber: doc, TxnDate: d.invoice_date, PrivateNote: [po, "entered from Seller Sage"].filter(Boolean).join(" · "),
    Line: lines.map(([k, v]) => {
      const a = acc[k] || acc.inventory;
      return { DetailType: "AccountBasedExpenseLineDetail", Amount: v, Description: [po, ACCT_NAMES[k] || k].filter(Boolean).join(" · "), AccountBasedExpenseLineDetail: { AccountRef: { value: a.id } } };
    }),
  };
  if (d.due_date) body.DueDate = d.due_date;
  const bill = (await post(c, "bill", body)).Bill;
  await saved(bill, "created");
  const att = await tryAttach(c, d, bill.Id);
  return { ok: true, created: true, bill_id: bill.Id, doc: bill.DocNumber, total: bill.TotalAmt, vendor: vend.DisplayName, message: `Bill ${bill.DocNumber} entered in QuickBooks for ${vend.DisplayName} (${Number(bill.TotalAmt).toFixed(2)}).${att}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const c = await creds();
    const by = await caller(req, c);
    if (!by) return json({ ok: false, error: "not allowed" }, 403);
    for (const k of ["qbo_client_id", "qbo_client_secret", "qbo_refresh_token", "qbo_realm_id"]) if (!c[k]) return json({ ok: false, error: `${k} is missing from Vault` }, 400);
    const p = await req.json().catch(() => ({}));
    if (by.startsWith("finance:") && !["status", "payables_sync"].includes(p.action)) return json({ ok: false, error: "not allowed" }, 403);
    if (p.action === "payables_sync") return json(await payablesSync(c, !!p.full));
    if (p.action === "status") {
      const ci = (await api(c, `companyinfo/${c.qbo_realm_id}`)).CompanyInfo || {};
      const acc = ((await query(c, "select Id, Name, FullyQualifiedName, AccountType, AccountSubType, Active from Account maxresults 1000")).QueryResponse?.Account || [])
        .map((a: any) => ({ id: a.Id, name: a.FullyQualifiedName || a.Name, type: a.AccountType, sub: a.AccountSubType }));
      const vc = (await query(c, "select count(*) from Vendor")).QueryResponse?.totalCount ?? null;
      return json({ ok: true, env: c.qbo_env, company: { name: ci.CompanyName, legal: ci.LegalName, country: ci.Country, fiscal_start: ci.FiscalYearStartMonth }, vendors: vc, accounts: acc });
    }
    if (p.action === "query") {
      const q = String(p.q || "");
      if (!/^\s*select\s/i.test(q)) return json({ ok: false, error: "only select queries" }, 400);
      return json({ ok: true, env: c.qbo_env, result: (await query(c, q)).QueryResponse || {} });
    }
    if (p.action === "vendors") {
      const all = (await query(c, "select Id, DisplayName from Vendor where Active = true maxresults 1000")).QueryResponse?.Vendor || [];
      return json({ ok: true, vendors: all.map((v: any) => ({ id: v.Id, name: v.DisplayName })).sort((a: any, b: any) => a.name.localeCompare(b.name)) });
    }
    if (p.action === "create_bill") return json(await createBill(c, p, by));
    if (p.action === "attach") {
      const { data: d, error } = await admin.rpc("jt_qbo_bill_data", { inv: Number(p.invoice_id) });
      if (error || !d) return json({ ok: false, error: error?.message || "invoice not found" });
      if (!d.qbo_bill_id) return json({ ok: false, error: "Send the invoice to QuickBooks first." });
      if (d.qbo_attach_id) return json({ ok: true, already: true, message: "The invoice PDF is already attached to the bill." });
      if (!d.has_file) return json({ ok: false, error: "There's no PDF stored for this invoice." });
      const id = await attachFile(c, d.id, d.qbo_bill_id);
      return json({ ok: true, attach_id: id, message: "The invoice PDF is attached to the bill in QuickBooks." });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
