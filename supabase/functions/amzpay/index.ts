// Amazon payouts for the finance dashboard: Amazon settlements -> QuickBooks journal entries (replaces A2X for Amazon).
// POST {action: "sync", days?, redo?} -> settlement reports Amazon made in the last `days` (default 90, Amazon keeps 90)
//                                        that aren't saved yet are read and saved (fin_amz_settlement_save, summed by
//                                        month posted / transaction / amount type and description, plus units sold by
//                                        SKU); payout groups (Finances API) for the USD a Mexico / Canada payout came to;
//                                        QuickBooks accounts (for the mapping). Daily by pg_cron and from the page.
// POST {action: "check", ids?}        -> looks in QuickBooks for each settlement's journal entries: A2X's (posted before
//                                        the switch — not posted again) and ours (linked if they're there).
// POST {action: "post", settlement_id, force?} -> posts the settlement's entries (fin.amz_entry: one per month it touches
//                                        + cost of goods) as QuickBooks journal entries, once each (an entry with the same
//                                        number already in QuickBooks is linked, not posted again). Refuses a settlement
//                                        A2X already posted.
// POST {action: "a2x_lines", ids?}   -> reads A2X's journal entries for settlements it posted (fin.amz_a2x_lines), for the
//                                        A2X vs Seller Sage comparison (check and post save them too)
// POST {action: "peek", settlement_id | report_id, lines?} -> the first lines of a settlement report (troubleshooting)
// Shopify (Just Tennis's and Ace n Rally's Shopify Payments payouts, fin.shop_entry — one simple entry per payout + cost of goods):
// POST {action: "shop_check", ids?}  -> looks in QuickBooks for each payout: A2X's entry (an A2XSH entry whose BofA (0364)
//                                        line is the payout, dated up to three weeks before it — not posted again) and ours.
// POST {action: "shop_post", payout_id, force?} -> posts the payout's entries once each; refuses one A2X posted.
// POST {action: "shop_clearing", days?} -> QuickBooks deposits, transfers, purchases and journal entries on the Shopify clearing
//                                        accounts (manual, cash, PayPal …) for the last `days` (default 60), and their
//                                        balances (fin_qbo_clearing_save). Also links weekly entries already in QuickBooks.
// POST {action: "shop_pay_post", week_end, store?} -> posts a store's week of other payments (fin.shop_pay_entry) once
//                                        (store: justtennis — the default — or acenrally).
// POST {action: "paypal_post", week_end} -> posts the week's PayPal fees entry (fin.paypal_fee_entry) once.
// Callers: accounts on the finance list (Authorization: Bearer <user JWT>), or SQL via jt.amzpay_call (x-jt-key).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-jt-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
async function rpc(fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}
type Creds = Record<string, string>;
const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));

// ---- Amazon (SP-API, North America)
const SP = "https://sellingpartnerapi-na.amazon.com";
const SETTLEMENT = "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2";
const MARKET: Record<string, string> = { USD: "US", CAD: "CA", MXN: "MX" };
let amzToken = "";
async function amz(c: Creds, path: string, tries = 0): Promise<any> {
  if (!amzToken) {
    const r = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.spapi_refresh_token, client_id: c.spapi_client_id, client_secret: c.spapi_client_secret }) });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) throw new Error(`Amazon sign-in failed (${r.status}): ${t.error_description || t.error || "no access token"}`);
    amzToken = t.access_token;
  }
  const r = await fetch(SP + path, { headers: { "x-amz-access-token": amzToken, Accept: "application/json", "User-Agent": "JustTennisFinance/1.0 (Language=TypeScript)" } });
  if (r.status === 429 && tries < 4) { await sleep(2500 * (tries + 1)); return amz(c, path, tries + 1); }
  const b = await r.json().catch(() => ({}));
  if (!r.ok) { const e = (b.errors || [])[0] || {}; throw new Error(`Amazon API ${r.status} on ${path.split("?")[0]}: ${e.message || JSON.stringify(b).slice(0, 200)}`); }
  return b;
}
async function amzDocument(c: Creds, docId: string): Promise<string> {
  const d = await amz(c, `/reports/2021-06-30/documents/${encodeURIComponent(docId)}`);
  const r = await fetch(d.url);
  if (!r.ok) throw new Error(`downloading the report failed (${r.status})`);
  let stream: ReadableStream<Uint8Array> = r.body!;
  if (d.compressionAlgorithm === "GZIP") stream = stream.pipeThrough(new DecompressionStream("gzip"));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return new TextDecoder("windows-1252").decode(buf); }
}
// "2026-09-23 16:54:04 UTC" | "23.09.2026 16:54:04 UTC" | "2026-09-23T16:54:04+00:00" -> ISO
function amzDate(s: string): string | null {
  s = (s || "").trim(); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2}):(\d{2}))?/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}Z`;
  const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString();
}
const num = (s: string) => { const v = parseFloat(String(s || "").replace(/,/g, "")); return isNaN(v) ? 0 : v; };
// the settlement report -> {settlement, sums, units}
function parseSettlement(text: string, reportId: string) {
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const H = rows[0].split("\t").map((h) => h.trim().toLowerCase());
  const ix = (n: string) => H.indexOf(n);
  for (const k of ["settlement-id", "transaction-type", "amount-type", "amount-description", "amount"]) if (ix(k) < 0) throw new Error(`the settlement report has no ${k} column`);
  let head: any = null;
  const sums = new Map<string, any>(), units = new Map<string, any>();
  for (const l of rows.slice(1)) {
    const f = l.split("\t"); const g = (k: string) => ix(k) >= 0 ? (f[ix(k)] || "").trim() : "";
    if (!head && g("total-amount") !== "" && g("transaction-type") === "") {
      head = { id: g("settlement-id"), report_id: reportId, start: amzDate(g("settlement-start-date")), end: amzDate(g("settlement-end-date")),
        deposit: amzDate(g("deposit-date")), total: num(g("total-amount")), currency: g("currency") || "USD" };
      continue;
    }
    if (g("transaction-type") === "" && g("amount-type") === "") continue;
    // the month by the posted date as Amazon writes it (the marketplace's own day, as A2X splits them)
    const posted = amzDate(g("posted-date") || g("posted-date-time")) || head?.start || null;
    const part = (posted || "").slice(0, 7) + "-01";
    const key = [part, g("transaction-type"), g("amount-type"), g("amount-description"), g("marketplace-name"), g("fulfillment-id")];
    const k = key.join("\u0001");
    const x = sums.get(k) || { part, tt: key[1], at: key[2], ad: key[3], mk: key[4], ful: key[5], amount: 0, n: 0 };
    x.amount += num(g("amount")); x.n++; sums.set(k, x);
    if (g("transaction-type") === "Order" && g("amount-type") === "ItemPrice" && g("amount-description") === "Principal" && g("sku")) {
      const uk = [part, g("fulfillment-id"), g("sku")].join("\u0001");
      const u = units.get(uk) || { part, ful: g("fulfillment-id"), sku: g("sku"), qty: 0 };
      u.qty += Math.round(num(g("quantity-purchased"))); units.set(uk, u);
    }
  }
  if (!head) throw new Error("the settlement report has no summary line");
  head.market = MARKET[head.currency] || head.currency;
  head.rows = rows.length - 2;
  return { settlement: head, sums: [...sums.values()].map((x) => ({ ...x, amount: Math.round(x.amount * 100) / 100 })), units: [...units.values()] };
}

async function sync(c: Creds, days: number, deadline: number, redo = false) {
  const saved: any[] = []; const skipped: string[] = []; let throttled = false;
  const since = new Date(Date.now() - Math.min(days, 90) * 86400_000).toISOString();
  let next = "", reports: any[] = [];
  do {
    const q = next ? `nextToken=${encodeURIComponent(next)}` : `reportTypes=${SETTLEMENT}&pageSize=100&createdSince=${since}`;
    const r = await amz(c, `/reports/2021-06-30/reports?${q}`);
    reports.push(...(r.reports || [])); next = r.nextToken || "";
  } while (next);
  reports = reports.filter((r) => r.processingStatus === "DONE" && r.reportDocumentId).sort((a, b) => a.createdTime.localeCompare(b.createdTime));
  const done = new Set<string>(redo ? [] : await rpc("fin_amz_report_ids") || []);
  for (const rep of reports) {
    if (done.has(rep.reportId)) { skipped.push(rep.reportId); continue; }
    if (Date.now() > deadline) break;
    let text = "";
    try { text = await amzDocument(c, rep.reportDocumentId); }
    catch (e) { if (/ 429 /.test(String((e as Error).message))) { throttled = true; break; } throw e; }   // 1 document a minute after a burst: the next pass goes on
    const parsed = parseSettlement(text, rep.reportId);
    const n = await rpc("fin_amz_settlement_save", { p: parsed });
    saved.push({ report_id: rep.reportId, settlement_id: parsed.settlement.id, market: parsed.settlement.market, total: parsed.settlement.total, rows: parsed.settlement.rows, saved: n });
    await sleep(600);
  }
  // payout groups (Finances API v0): the USD each payout came to; the settlement still open
  const groups: any[] = []; let tok = "";
  const after = new Date(Date.now() - 120 * 86400_000).toISOString();
  do {
    const r = await amz(c, `/finances/v0/financialEventGroups?MaxResultsPerPage=100&FinancialEventGroupStartedAfter=${after}${tok ? `&NextToken=${encodeURIComponent(tok)}` : ""}`);
    for (const g of r.payload?.FinancialEventGroupList || []) groups.push({ id: g.FinancialEventGroupId, status: g.ProcessingStatus || "", transfer: g.FundTransferStatus || "",
      start: g.FinancialEventGroupStart || null, end: g.FinancialEventGroupEnd || null, transfer_at: g.FundTransferDate || null,
      currency: g.OriginalTotal?.CurrencyCode || "", original: g.OriginalTotal?.CurrencyAmount ?? null, converted: g.ConvertedTotal?.CurrencyAmount ?? null, tail: g.AccountTail || "" });
    tok = r.payload?.NextToken || "";
    if (tok) await sleep(2100);
  } while (tok && Date.now() < deadline);
  const g = groups.length ? await rpc("fin_amz_groups_save", { p: { groups } }) : 0;
  return { reports: reports.length, saved, skipped: skipped.length, groups: g, throttled, more: reports.some((r) => !done.has(r.reportId) && !saved.some((s) => s.report_id === r.reportId)) };
}

// ---- QuickBooks
const QB: Record<string, string> = { production: "https://quickbooks.api.intuit.com", sandbox: "https://sandbox-quickbooks.api.intuit.com" };
async function qbToken(c: Creds, force = false): Promise<string> {
  if (!force && c.qbo_access_token && c.qbo_access_expires && new Date(c.qbo_access_expires).getTime() - Date.now() > 5 * 60 * 1000) return c.qbo_access_token;
  const r = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", { method: "POST",
    headers: { Authorization: "Basic " + btoa(c.qbo_client_id + ":" + c.qbo_client_secret), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.qbo_refresh_token }) });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error(`QuickBooks sign-in failed (${r.status}): ${t.error_description || t.error || "no access token"}`);
  const exp = new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString();
  const { error } = await admin.rpc("jt_qbo_save_tokens", { p: { access_token: t.access_token, access_expires: exp, refresh_token: t.refresh_token || "" } });
  if (error) throw new Error("saving tokens: " + error.message);
  c.qbo_access_token = t.access_token; c.qbo_access_expires = exp; if (t.refresh_token) c.qbo_refresh_token = t.refresh_token;
  return t.access_token;
}
async function qb(c: Creds, method: string, path: string, body?: unknown, tries = 0): Promise<any> {
  const at = await qbToken(c, tries > 0);
  const base = QB[c.qbo_env || "production"];
  const r = await fetch(`${base}/v3/company/${c.qbo_realm_id}/${path}${path.includes("?") ? "&" : "?"}minorversion=75`, { method,
    headers: { Authorization: "Bearer " + at, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const b = await r.json().catch(() => ({}));
  if (r.status === 401 && tries === 0) return qb(c, method, path, body, 1);
  if (!r.ok) { const f = b?.Fault?.Error?.[0]; throw new Error(`QuickBooks ${r.status}: ${f ? `${f.Message} — ${f.Detail || ""}` : JSON.stringify(b).slice(0, 300)}`); }
  return b;
}
const qq = (v: string) => "'" + String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
const query = (c: Creds, q: string) => qb(c, "GET", "query?query=" + encodeURIComponent(q)).then((r) => r.QueryResponse || {});

async function coa(c: Creds) {
  const all: any[] = [];
  for (let s = 1; s < 5000; s += 1000) {
    const r = (await query(c, `select Id, FullyQualifiedName, AccountType, Active, CurrencyRef from Account where Active in (true, false) startposition ${s} maxresults 1000`)).Account || [];
    all.push(...r); if (r.length < 1000) break;
  }
  const accounts = all.map((a: any) => ({ id: a.Id, name: a.FullyQualifiedName, type: a.AccountType, active: a.Active !== false, currency: a.CurrencyRef?.value || "USD" }));
  await rpc("fin_qbo_coa_save", { p: { accounts } });
  return accounts;
}

// the A2X entries for a settlement: A2X numbers them A2X{US|CA|MX}-{start}-{end}-nnn (and …C nnn for cost of goods),
// dated the day each month's part starts
// (their lines are saved for the A2X vs Seller Sage comparison)
async function a2xDocs(c: Creds, e: any): Promise<string[]> {
  const out: string[] = [], entries: any[] = [];
  for (const p of e.parts.filter((x: any) => x.kind === "main")) {
    const tag = "A2X" + e.settlement.market + "-" + p.doc.slice(p.doc.indexOf("-") + 1, p.doc.lastIndexOf("-"));
    const r = (await query(c, `select * from JournalEntry where TxnDate = ${qq(p.date)} maxresults 1000`)).JournalEntry || [];
    for (const j of r) if (String(j.DocNumber || "").startsWith(tag)) {
      out.push(j.DocNumber);
      entries.push({ doc: j.DocNumber, id: j.Id, date: j.TxnDate, currency: j.CurrencyRef?.value || "USD", fx: j.ExchangeRate ?? 1,
        lines: (j.Line || []).filter((l: any) => l.JournalEntryLineDetail).map((l: any) => ({
          account: l.JournalEntryLineDetail.AccountRef?.name || "", description: l.Description || "",
          amount: (l.JournalEntryLineDetail.PostingType === "Debit" ? 1 : -1) * Number(l.Amount || 0) })) });
    }
  }
  if (entries.length) await rpc("fin_amz_a2x_save", { p: { settlement_id: e.settlement.settlement_id, entries } });
  return out;
}

async function post(c: Creds, sid: string, by: string, force: boolean) {
  const e = await rpc("fin_amz_entry", { sid });
  if (!e) return { ok: false, error: "settlement not found" };
  const a2x = await a2xDocs(c, e);
  await rpc("fin_amz_posted", { p: { settlement_id: sid, a2x, checked: true } });
  if (a2x.length && !force) return { ok: false, a2x, error: `A2X already posted this settlement (${a2x.join(", ")}) — not posting it again.` };
  return postParts(c, e, by, `Amazon ${e.settlement.market} settlement ${sid}`, (doc, id, how) => rpc("fin_amz_posted", { p: { settlement_id: sid, doc, id, by, how } }));
}

// posts an entry's parts (from fin.amz_entry or fin.shop_entry) as QuickBooks journal entries, once each: a part already
// posted is skipped, one already in QuickBooks under the same number is linked
async function postParts(c: Creds, e: any, by: string, what: string, saved: (doc: string, id: string, how: string) => Promise<unknown>) {
  const totalProb = (e.problems || []).find((x: any) => x.kind === "total" || x.kind === "fx");
  if (totalProb) return { ok: false, error: totalProb.message };
  const accts = await coa(c);
  const byName = new Map(accts.filter((a) => a.active).map((a) => [a.name.toLowerCase(), a]));
  const missing = [...new Set(e.parts.flatMap((p: any) => p.lines.map((l: any) => l.account)).filter((n: string) => !byName.has(String(n).toLowerCase())))];
  if (missing.length) return { ok: false, error: `These accounts aren't in QuickBooks: ${missing.join(", ")}` };
  const results: any[] = [];
  for (const p of e.parts) {
    if (p.posted?.id) { results.push({ doc: p.doc, id: p.posted.id, already: true }); continue; }
    const dup = ((await query(c, `select Id, DocNumber from JournalEntry where DocNumber = ${qq(p.doc)}`)).JournalEntry || [])[0];
    if (dup) { await saved(p.doc, dup.Id, "linked"); results.push({ doc: p.doc, id: dup.Id, linked: true }); continue; }
    const lines = p.lines.filter((l: any) => Math.round(Number(l.amount) * 100) !== 0).map((l: any) => ({
      DetailType: "JournalEntryLineDetail", Amount: Math.abs(Math.round(Number(l.amount) * 100) / 100), Description: String(l.description || "").slice(0, 4000),
      JournalEntryLineDetail: { PostingType: Number(l.amount) > 0 ? "Debit" : "Credit", AccountRef: { value: byName.get(String(l.account).toLowerCase())!.id } } }));
    const dr = lines.filter((l: any) => l.JournalEntryLineDetail.PostingType === "Debit").reduce((a: number, l: any) => a + l.Amount, 0);
    const cr = lines.filter((l: any) => l.JournalEntryLineDetail.PostingType === "Credit").reduce((a: number, l: any) => a + l.Amount, 0);
    if (Math.abs(dr - cr) >= 0.005) return { ok: false, results, error: `${p.doc} doesn't balance (debits ${dr.toFixed(2)}, credits ${cr.toFixed(2)})` };
    const body: any = { DocNumber: p.doc, TxnDate: p.date, PrivateNote: `${what} · ${p.kind === "cogs" ? "cost of goods" : "payout"} · Seller Sage`, Line: lines };
    if (p.currency && p.currency !== "USD") { body.CurrencyRef = { value: p.currency }; body.ExchangeRate = Number(p.fx); }
    const je = (await qb(c, "POST", "journalentry", body)).JournalEntry;
    await saved(p.doc, je.Id, "created");
    results.push({ doc: p.doc, id: je.Id, created: true });
  }
  return { ok: true, results };
}

// ---- Shopify payouts: A2X posted each one as an A2XSH entry whose bank line is the payout, dated the start of the
// period it covers (up to about three weeks before the payout)
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
async function jesBetween(c: Creds, from: string, to: string) {
  const all: any[] = [];
  for (let s = 1; s < 5000; s += 1000) {
    const r = (await query(c, `select * from JournalEntry where TxnDate >= ${qq(from)} and TxnDate <= ${qq(to)} startposition ${s} maxresults 1000`)).JournalEntry || [];
    all.push(...r); if (r.length < 1000) break;
  }
  return all;
}
function shopA2x(jes: any[], e: any): string[] {
  const cfg = e.payout, bank = String(e.parts[0].lines.at(-1).account).toLowerCase(), amt = Math.round(Number(cfg.amount) * 100);
  const day = new Date(cfg.payout_date + "T00:00:00Z").getTime();
  return jes.filter((j) => String(j.DocNumber || "").startsWith("A2XSH") && !/C\d{3}$/.test(j.DocNumber)
    && Math.abs(new Date(j.TxnDate + "T00:00:00Z").getTime() - day) <= 24 * 86400e3
    && (j.Line || []).some((l: any) => l.JournalEntryLineDetail?.PostingType === "Debit" && String(l.JournalEntryLineDetail?.AccountRef?.name || "").toLowerCase() === bank
      && Math.round(Number(l.Amount) * 100) === amt)).map((j) => j.DocNumber);
}
async function shopCheck(c: Creds, ids: string[], by: string, deadline: number) {
  const entries: any[] = [];
  for (const pid of ids) { const e = await rpc("fin_shop_entry", { pid }); if (e) entries.push(e); }
  if (!entries.length) return [];
  const days = entries.map((e) => new Date(e.payout.payout_date + "T00:00:00Z").getTime());
  const jes = await jesBetween(c, isoDay(new Date(Math.min(...days) - 24 * 86400e3)), isoDay(new Date(Math.max(...days) + 3 * 86400e3)));
  const byDoc = new Map(jes.map((j) => [String(j.DocNumber || ""), j]));
  const out: any[] = [];
  for (const e of entries) {
    if (Date.now() > deadline) break;
    const pid = e.payout.id, a2x = shopA2x(jes, e);
    for (const pt of e.parts) {
      if (pt.posted?.id) continue;
      const dup = byDoc.get(pt.doc) || ((await query(c, `select Id from JournalEntry where DocNumber = ${qq(pt.doc)}`)).JournalEntry || [])[0];
      if (dup) await rpc("fin_shop_posted", { p: { payout_id: pid, doc: pt.doc, id: dup.Id, by, how: "linked" } });
    }
    await rpc("fin_shop_posted", { p: { payout_id: pid, a2x, checked: true } });
    out.push({ payout_id: pid, a2x });
  }
  return out;
}
async function shopPost(c: Creds, pid: string, by: string, force: boolean) {
  const e = await rpc("fin_shop_entry", { pid });
  if (!e) return { ok: false, error: "payout not found" };
  const day = new Date(e.payout.payout_date + "T00:00:00Z").getTime();
  const a2x = shopA2x(await jesBetween(c, isoDay(new Date(day - 24 * 86400e3)), isoDay(new Date(day + 3 * 86400e3))), e);
  await rpc("fin_shop_posted", { p: { payout_id: pid, a2x, checked: true } });
  if (a2x.length && !force) return { ok: false, a2x, error: `A2X already posted this payout (${a2x.join(", ")}) — not posting it again.` };
  return postParts(c, e, by, `Shopify payout ${pid} (${e.payout.store === "acenrally" ? "Ace n Rally" : "Just Tennis"})`, (doc, id, how) => rpc("fin_shop_posted", { p: { payout_id: pid, doc, id, by, how } }));
}

// ---- Shopify payments outside Shopify Payments: QuickBooks activity on the clearing accounts, and the weekly entries
async function txBetween(c: Creds, entity: string, from: string, to: string) {
  const all: any[] = [];
  for (let s = 1; s < 5000; s += 1000) {
    const r = (await query(c, `select * from ${entity} where TxnDate >= ${qq(from)} and TxnDate <= ${qq(to)} startposition ${s} maxresults 1000`))[entity] || [];
    all.push(...r); if (r.length < 1000) break;
  }
  return all;
}
async function shopClearing(c: Creds, days: number) {
  const names: string[] = (await rpc("fin_shop_clearing_accounts")) || [];
  const accts = (await coa(c)).filter((a) => names.some((n) => n.toLowerCase() === a.name.toLowerCase()));
  const byId = new Map(accts.map((a) => [a.id, a.name]));
  const to = isoDay(new Date(Date.now() + 86400e3)), from = isoDay(new Date(Date.now() - days * 86400e3));
  const rows: any[] = [];
  for (const d of await txBetween(c, "Deposit", from, to)) {
    for (const l of d.Line || []) {
      const id = l.DepositLineDetail?.AccountRef?.value;
      if (id && byId.has(id)) rows.push({ txn_type: "Deposit", txn_id: d.Id, line_id: String(l.Id ?? l.LineNum ?? rows.length), account: byId.get(id), date: d.TxnDate,
        amount: -Number(l.Amount || 0), doc: d.DocNumber || "", memo: [l.Description, d.PrivateNote, l.DepositLineDetail?.Entity?.name].filter(Boolean).join(" · ").slice(0, 300) });
    }
    if (byId.has(d.DepositToAccountRef?.value)) rows.push({ txn_type: "Deposit", txn_id: d.Id, line_id: "to", account: byId.get(d.DepositToAccountRef.value), date: d.TxnDate,
      amount: Number(d.TotalAmt || 0), doc: d.DocNumber || "", memo: (d.PrivateNote || "").slice(0, 300) });
  }
  for (const t of await txBetween(c, "Transfer", from, to)) {
    if (byId.has(t.FromAccountRef?.value)) rows.push({ txn_type: "Transfer", txn_id: t.Id, line_id: "from", account: byId.get(t.FromAccountRef.value), date: t.TxnDate, amount: -Number(t.Amount || 0), doc: "", memo: (t.PrivateNote || "").slice(0, 300) });
    if (byId.has(t.ToAccountRef?.value)) rows.push({ txn_type: "Transfer", txn_id: t.Id, line_id: "to", account: byId.get(t.ToAccountRef.value), date: t.TxnDate, amount: Number(t.Amount || 0), doc: "", memo: (t.PrivateNote || "").slice(0, 300) });
  }
  for (const pu of await txBetween(c, "Purchase", from, to)) {   // expenses / checks paid from a clearing account (e.g. a purchase paid with PayPal)
    if (byId.has(pu.AccountRef?.value)) rows.push({ txn_type: "Purchase", txn_id: pu.Id, line_id: "pay", account: byId.get(pu.AccountRef.value), date: pu.TxnDate,
      amount: (pu.Credit ? 1 : -1) * Number(pu.TotalAmt || 0), doc: pu.DocNumber || "", memo: [pu.EntityRef?.name, pu.PrivateNote].filter(Boolean).join(" · ").slice(0, 300) });
  }
  const jes = await txBetween(c, "JournalEntry", from, to);
  for (const j of jes) for (const l of j.Line || []) {
    const id = l.JournalEntryLineDetail?.AccountRef?.value;
    if (id && byId.has(id)) rows.push({ txn_type: "JournalEntry", txn_id: j.Id, line_id: String(l.Id ?? rows.length), account: byId.get(id), date: j.TxnDate,
      amount: (l.JournalEntryLineDetail.PostingType === "Debit" ? 1 : -1) * Number(l.Amount || 0), doc: j.DocNumber || "", memo: (l.Description || "").slice(0, 300) });
  }
  const bal = (await query(c, `select FullyQualifiedName, CurrentBalance from Account where Active = true maxresults 1000`)).Account || [];
  const balances = bal.filter((a: any) => names.some((n) => n.toLowerCase() === String(a.FullyQualifiedName).toLowerCase())).map((a: any) => ({ account: a.FullyQualifiedName, balance: Number(a.CurrentBalance || 0) }));
  const n = await rpc("fin_qbo_clearing_save", { p: { from, to, rows, balances } });
  // weekly entries already in QuickBooks (posted by hand or earlier): link them
  let linked = 0;
  for (const j of jes) {
    const d = String(j.DocNumber || "");   // dated the week's last day
    const wk = d.match(/^SSP(SH|AR)-\d\d[A-Za-z]{3}(-|C)PAY$/);
    if (wk) { await rpc("fin_shop_week_posted", { p: { store: wk[1] === "AR" ? "acenrally" : "justtennis", week_end: j.TxnDate, doc: d, id: j.Id, how: "linked" } }); linked++; }
    else if (/^SSPPP-\d\d[A-Za-z]{3}-FEE$/.test(d)) { await rpc("fin_paypal_week_posted", { p: { week_end: j.TxnDate, doc: d, id: j.Id, how: "linked" } }); linked++; }
  }
  return { saved: n, accounts: accts.map((a) => a.name), balances, linked };
}
async function shopPayPost(c: Creds, we: string, by: string, st: string) {
  const e = await rpc("fin_shop_pay_entry", { we, st });
  if (!e) return { ok: false, error: "no payments that week" };
  const label = st === "acenrally" ? "Ace n Rally" : "Just Tennis";
  return postParts(c, e, by, `Shopify payments outside Shopify Payments, week ending ${we} (${label})`, (doc, id, how) => rpc("fin_shop_week_posted", { p: { store: st, week_end: we, doc, id, by, how } }));
}
async function paypalPost(c: Creds, we: string, by: string) {
  const e = await rpc("fin_paypal_fee_entry", { we });
  if (!e || !e.parts.length) return { ok: false, error: "no PayPal fees that week" };
  return postParts(c, e, by, `PayPal fees, week ending ${we} (Just Tennis)`, (doc, id, how) => rpc("fin_paypal_week_posted", { p: { week_end: we, doc, id, by, how } }));
}

async function caller(req: Request, c: Creds): Promise<string | null> {
  const k = req.headers.get("x-jt-key");
  if (k && c.jt_fn_key && k === c.jt_fn_key) return "scheduler";
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await admin.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: fin } = await admin.rpc("fin_allowed", { uid: data.user.id });
  return fin ? (data.user.email || "finance user") : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const t0 = Date.now();
  try {
    const c: Creds = { ...(await rpc("jt_spapi_creds")), ...(await rpc("jt_qbo_creds")) };
    const by = await caller(req, c);
    if (!by) return json({ ok: false, error: "not allowed" }, 403);
    const p = await req.json().catch(() => ({}));
    if (p.action === "sync") {
      const out = await sync(c, Number(p.days) || 90, t0 + 100_000, !!p.redo);
      let accounts = 0;
      if (Date.now() - t0 < 110_000) { try { accounts = (await coa(c)).length; } catch (_) { /* QuickBooks can wait for the next pass */ } }
      return json({ ok: true, ...out, accounts });
    }
    if (p.action === "check") {
      const ids: string[] = Array.isArray(p.ids) ? p.ids.map(String) : (await rpc("fin_amz_open_ids")) || [];
      const out: any[] = [];
      for (const sid of ids) {
        if (Date.now() - t0 > 100_000) break;
        const e = await rpc("fin_amz_entry", { sid });
        if (!e) continue;
        const a2x = await a2xDocs(c, e);
        for (const pt of e.parts) {
          if (pt.posted?.id) continue;
          const dup = ((await query(c, `select Id from JournalEntry where DocNumber = ${qq(pt.doc)}`)).JournalEntry || [])[0];
          if (dup) await rpc("fin_amz_posted", { p: { settlement_id: sid, doc: pt.doc, id: dup.Id, by, how: "linked" } });
        }
        await rpc("fin_amz_posted", { p: { settlement_id: sid, a2x, checked: true } });
        out.push({ settlement_id: sid, a2x });
      }
      return json({ ok: true, checked: out });
    }
    if (p.action === "a2x_lines") {   // A2X's entries for settlements it posted, for the comparison
      const ids: string[] = Array.isArray(p.ids) ? p.ids.map(String) : (await rpc("fin_amz_a2x_todo")) || [];
      const out: any[] = [];
      for (const sid of ids) {
        if (Date.now() - t0 > 100_000) break;
        const e = await rpc("fin_amz_entry", { sid });
        if (!e) continue;
        const a2x = await a2xDocs(c, e);
        await rpc("fin_amz_posted", { p: { settlement_id: sid, a2x, checked: true } });
        out.push({ settlement_id: sid, a2x });
      }
      return json({ ok: true, read: out, more: out.length < ids.length });
    }
    if (p.action === "post") {
      if (!p.settlement_id) return json({ ok: false, error: "settlement_id is required" }, 400);
      return json(await post(c, String(p.settlement_id), by, !!p.force));
    }
    if (p.action === "shop_check") {
      const ids: string[] = Array.isArray(p.ids) ? p.ids.map(String) : (await rpc("fin_shop_open_ids")) || [];
      return json({ ok: true, checked: await shopCheck(c, ids, by, t0 + 100_000) });
    }
    if (p.action === "shop_post") {
      if (!p.payout_id) return json({ ok: false, error: "payout_id is required" }, 400);
      return json(await shopPost(c, String(p.payout_id), by, !!p.force));
    }
    if (p.action === "shop_clearing") return json({ ok: true, ...(await shopClearing(c, Math.min(Number(p.days) || 60, 400))) });
    if (p.action === "shop_pay_post") {
      if (!p.week_end) return json({ ok: false, error: "week_end is required" }, 400);
      return json(await shopPayPost(c, String(p.week_end), by, p.store === "acenrally" ? "acenrally" : "justtennis"));
    }
    if (p.action === "paypal_post") {
      if (!p.week_end) return json({ ok: false, error: "week_end is required" }, 400);
      return json(await paypalPost(c, String(p.week_end), by));
    }
    if (p.action === "peek") {
      let rid = String(p.report_id || "");
      if (!rid && p.settlement_id) rid = (await rpc("fin_amz_report_of", { sid: String(p.settlement_id) })) || "";
      if (!rid) return json({ ok: false, error: "report_id or settlement_id is required" }, 400);
      const rep = await amz(c, `/reports/2021-06-30/reports/${encodeURIComponent(rid)}`);
      const text = await amzDocument(c, rep.reportDocumentId);
      return json({ ok: true, lines: text.split(/\r?\n/).slice(0, Math.min(Number(p.lines) || 40, 400)) });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
