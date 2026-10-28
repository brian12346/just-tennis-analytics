// Card and bank transactions for the finance dashboard (Finance › Transactions): Plaid in, QuickBooks out.
// POST {action: "status"}                     -> is Plaid set up (keys in Vault), the linked banks
// POST {action: "link_token", item_id?}       -> a Plaid Link token (item_id: re-link a bank that needs signing in again)
// POST {action: "exchange", public_token, institution?} -> Link's result: keeps the access token in Vault, saves the
//                                               bank's accounts and pulls its transactions
// POST {action: "sync", item_id?, match?}     -> new / changed / removed transactions from every linked bank
//                                               (/transactions/sync, from the saved cursor); with match, then looks for
//                                               the new ones in QuickBooks. Hourly by pg_cron (fin-bank-sync).
// POST {action: "match", days?}               -> finds unclassified transactions QuickBooks already has (same bank/card
//                                               account, amount, within 4 days: expenses, deposits, transfers, bill
//                                               payments, journal entries, sales receipts …) and links them: they're
//                                               done, nothing to post. Read-only on QuickBooks.
// POST {action: "learn", days?}               -> how QuickBooks categorized each payee (Purchases and Deposits, last 365
//                                               days) -> fin.qbo_payee_hist, for suggestions. Read-only on QuickBooks.
// POST {action: "post", tx_ids, force?}       -> posts classified transactions to QuickBooks, once each: an expense (Purchase),
//                                               money in (Deposit, or a card credit), a transfer (Transfer — both sides
//                                               linked). Looks for it in QuickBooks first and links it instead if it's
//                                               there (force skips the look).
// Callers: accounts on the finance list (Authorization: Bearer <user JWT>), or SQL via jt.bank_call (x-jt-key: sync,
// match and learn only — nothing is ever posted on a schedule).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-jt-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
async function rpc(fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}
// reads go through fin_bank_data (the fin schema isn't exposed to the API): what = items | open | ids | used | accounts
async function data(what: string, extra: Record<string, unknown> = {}): Promise<any[]> {
  return ((await rpc("fin_bank_data", { p: { what, ...extra } })) || []) as any[];
}
type Creds = Record<string, string>;
const r2 = (n: number) => Math.round(Number(n) * 100) / 100;
const dayAdd = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dayDiff = (a: string, b: string) => Math.round((new Date(a + "T12:00:00Z").getTime() - new Date(b + "T12:00:00Z").getTime()) / 864e5);

// ---- Plaid
const PLAID: Record<string, string> = { production: "https://production.plaid.com", sandbox: "https://sandbox.plaid.com" };
async function plaid(c: Creds, path: string, body: Record<string, unknown>): Promise<any> {
  const base = PLAID[c.plaid_env || "production"];
  if (!base) throw new Error(`plaid_env must be production or sandbox`);
  const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: c.plaid_client_id, secret: c.plaid_secret, ...body }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) { const e: any = new Error(`Plaid ${path}: ${b.error_message || b.error_code || r.status}`); e.code = b.error_code || ""; throw e; }
  return b;
}
async function syncItem(c: Creds, item: { item_id: string; cursor: string | null }, token: string) {
  let cursor = item.cursor || null, added = 0, modified = 0, removed = 0, accounts: any[] = [];
  for (let page = 0; page < 60; page++) {
    let r: any;
    try { r = await plaid(c, "/transactions/sync", { access_token: token, cursor: cursor || undefined, count: 500, options: { include_personal_finance_category: true } }); }
    catch (e) {
      const code = (e as any).code || "";
      if (code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") { cursor = item.cursor || null; continue; }
      await rpc("fin_bank_save", { p: { item: { item_id: item.item_id }, error: (e as Error).message } });
      throw e;
    }
    if (r.accounts?.length) accounts = r.accounts;
    const add = r.added || [], mod = r.modified || [], rem = (r.removed || []).map((x: any) => x.transaction_id);
    // saved in parts (the database call has a size limit); the cursor goes with the last part
    const parts = Math.max(1, Math.ceil((add.length + mod.length) / 300));
    for (let i = 0; i < parts; i++) {
      const last = i === parts - 1;
      await rpc("fin_bank_save", { p: { item: { item_id: item.item_id }, accounts: i === 0 ? accounts : [],
        added: add.slice(i * 300, (i + 1) * 300), modified: i === 0 ? mod.slice(0, 300) : mod.slice(i * 300, (i + 1) * 300),
        removed: last ? rem : [], ...(last && !r.has_more ? { cursor: r.next_cursor, error: "" } : {}) } });
    }
    added += add.length; modified += mod.length; removed += rem.length;
    cursor = r.next_cursor;
    if (!r.has_more) break;
  }
  if (!accounts.length) {   // first pull before Plaid has the history ready: at least save the accounts
    try { const a = await plaid(c, "/accounts/get", { access_token: token }); await rpc("fin_bank_save", { p: { item: { item_id: item.item_id }, accounts: a.accounts || [] } }); } catch (_) { /* next pass */ }
  }
  return { item_id: item.item_id, added, modified, removed };
}

// ---- QuickBooks (same connection as the qbo / amzpay functions)
const QB: Record<string, string> = { production: "https://quickbooks.api.intuit.com", sandbox: "https://sandbox-quickbooks.api.intuit.com" };
async function qbToken(c: Creds, force = false): Promise<string> {
  if (!force && c.qbo_access_token && c.qbo_access_expires && new Date(c.qbo_access_expires).getTime() - Date.now() > 5 * 60 * 1000) return c.qbo_access_token;
  const r = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", { method: "POST",
    headers: { Authorization: "Basic " + btoa(c.qbo_client_id + ":" + c.qbo_client_secret), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.qbo_refresh_token }) });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error(`QuickBooks sign-in failed (${r.status}): ${t.error_description || t.error || "no access token"}`);
  const exp = new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString();
  await rpc("jt_qbo_save_tokens", { p: { access_token: t.access_token, access_expires: exp, refresh_token: t.refresh_token || "" } });
  c.qbo_access_token = t.access_token; c.qbo_access_expires = exp; if (t.refresh_token) c.qbo_refresh_token = t.refresh_token;
  return t.access_token;
}
async function qb(c: Creds, method: string, path: string, body?: unknown, tries = 0): Promise<any> {
  const at = await qbToken(c, tries > 0);
  const r = await fetch(`${QB[c.qbo_env || "production"]}/v3/company/${c.qbo_realm_id}/${path}${path.includes("?") ? "&" : "?"}minorversion=75`, { method,
    headers: { Authorization: "Bearer " + at, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const b = await r.json().catch(() => ({}));
  if (r.status === 401 && tries === 0) return qb(c, method, path, body, 1);
  if (!r.ok) { const f = b?.Fault?.Error?.[0]; throw new Error(`QuickBooks ${r.status}: ${f ? `${f.Message} — ${f.Detail || ""}` : JSON.stringify(b).slice(0, 300)}`); }
  return b;
}
const query = (c: Creds, q: string) => qb(c, "GET", "query?query=" + encodeURIComponent(q)).then((r) => r.QueryResponse || {});
async function queryAll(c: Creds, entity: string, where: string): Promise<any[]> {
  const out: any[] = [];
  for (let s = 1; s < 50000; s += 1000) {
    const rows = (await query(c, `select * from ${entity} where ${where} startposition ${s} maxresults 1000`))[entity] || [];
    out.push(...rows); if (rows.length < 1000) break;
  }
  return out;
}

// every QuickBooks transaction touching a bank / card account between two days, as postings: money out of the account
// is positive (like Plaid's amounts), money in negative
type Posting = { acct: string; amt: number; date: string; type: string; id: string };
async function postings(c: Creds, from: string, to: string): Promise<Posting[]> {
  const w = `TxnDate >= '${from}' and TxnDate <= '${to}'`, out: Posting[] = [];
  const add = (acct: any, amt: any, date: string, type: string, id: string) => { if (acct?.value && Number(amt)) out.push({ acct: String(acct.value), amt: r2(Number(amt)), date, type, id: String(id) }); };
  const get = async (e: string) => { try { return await queryAll(c, e, w); } catch (_) { return []; } };
  for (const x of await get("Purchase")) add(x.AccountRef, (x.Credit ? -1 : 1) * x.TotalAmt, x.TxnDate, "Purchase", x.Id);
  for (const x of await get("Deposit")) add(x.DepositToAccountRef, -x.TotalAmt, x.TxnDate, "Deposit", x.Id);
  for (const x of await get("Transfer")) { add(x.FromAccountRef, x.Amount, x.TxnDate, "Transfer", x.Id); add(x.ToAccountRef, -x.Amount, x.TxnDate, "Transfer", x.Id); }
  for (const x of await get("BillPayment")) add(x.CheckPayment?.BankAccountRef || x.CreditCardPayment?.CCAccountRef, x.TotalAmt, x.TxnDate, "BillPayment", x.Id);
  for (const x of await get("JournalEntry")) for (const l of x.Line || []) {
    const d = l.JournalEntryLineDetail; if (!d) continue;
    add(d.AccountRef, (d.PostingType === "Credit" ? 1 : -1) * l.Amount, x.TxnDate, "JournalEntry", x.Id);
  }
  for (const x of await get("SalesReceipt")) add(x.DepositToAccountRef, -x.TotalAmt, x.TxnDate, "SalesReceipt", x.Id);
  for (const x of await get("Payment")) add(x.DepositToAccountRef, -x.TotalAmt, x.TxnDate, "Payment", x.Id);
  for (const x of await get("RefundReceipt")) add(x.DepositToAccountRef, x.TotalAmt, x.TxnDate, "RefundReceipt", x.Id);
  for (const x of await get("CreditCardPayment")) { add(x.BankAccountRef, x.Amount, x.TxnDate, "CreditCardPayment", x.Id); add(x.CreditCardAccountRef, -x.Amount, x.TxnDate, "CreditCardPayment", x.Id); }
  return out;
}
// the open transactions (classify-able, on a mapped account) QuickBooks already has → linked
async function match(c: Creds, by: string, days: number, only?: string[]) {
  const st = (await data("open", { days })).filter((t: any) => !only || only.includes(t.tx_id));
  if (!st.length) return { checked: 0, linked: 0 };
  const dates = st.map((t: any) => String(t.date)).sort();
  const ps = await postings(c, dayAdd(dates[0], -5), dayAdd(dates[dates.length - 1], 5));
  // what's already tied to a transaction here isn't used twice
  const used = new Set((await data("used")).map((x: any) => `${x.qbo_type}:${x.qbo_id}`));
  const taken = new Set<string>();
  let linked = 0;
  for (const t of st.sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)))) {
    const amt = r2(t.amount);
    const cand = ps.filter(p => p.acct === t.qbo_account_id && p.amt === amt && Math.abs(dayDiff(p.date, t.date)) <= 4
      && !taken.has(`${p.type}:${p.id}:${p.acct}`) && !(used.has(`${p.type}:${p.id}`) && p.type !== "Transfer" && p.type !== "JournalEntry" && p.type !== "CreditCardPayment"))
      .sort((a, b) => Math.abs(dayDiff(a.date, t.date)) - Math.abs(dayDiff(b.date, t.date)))[0];
    if (!cand) continue;
    taken.add(`${cand.type}:${cand.id}:${cand.acct}`);
    await rpc("fin_bank_posted", { p: { tx_ids: [t.tx_id], status: "linked", qbo_type: cand.type, qbo_id: cand.id, by } });
    linked++;
  }
  return { checked: st.length, linked };
}

// how payees were categorized in QuickBooks
async function learn(c: Creds, days: number) {
  const to = new Date().toISOString().slice(0, 10), from = dayAdd(to, -days), rows: any[] = [];
  for (const x of await queryAll(c, "Purchase", `TxnDate >= '${from}'`)) {
    const lines = (x.Line || []).filter((l: any) => l.AccountBasedExpenseLineDetail?.AccountRef?.value);
    if (!lines.length) continue;
    const big = lines.sort((a: any, b: any) => Number(b.Amount) - Number(a.Amount))[0];
    const acct = big.AccountBasedExpenseLineDetail.AccountRef.value, dir = x.Credit ? "in" : "out";
    const v = x.EntityRef?.type === "Vendor" ? { vendor_id: x.EntityRef.value, vendor_name: x.EntityRef.name || "" } : {};
    for (const payee of new Set([x.EntityRef?.name, big.Description, x.PrivateNote].filter(Boolean).map(String)))
      rows.push({ payee, direction: dir, account_id: acct, date: x.TxnDate, ...v });
  }
  for (const x of await queryAll(c, "Deposit", `TxnDate >= '${from}'`)) for (const l of x.Line || []) {
    const acct = l.DepositLineDetail?.AccountRef?.value; if (!acct) continue;
    const e = l.DepositLineDetail?.Entity;
    for (const payee of new Set([e?.name, l.Description].filter(Boolean).map(String)))
      rows.push({ payee, direction: "in", account_id: acct, date: x.TxnDate, ...(e?.type === "Vendor" ? { vendor_id: e.value, vendor_name: e.name || "" } : {}) });
  }
  let saved = 0;
  for (let i = 0; i < Math.max(1, rows.length); i += 1000) saved += Number(await rpc("fin_qbo_payee_save", { p: { rows: rows.slice(i, i + 1000), clear: i === 0 } })) || 0;
  return { rows: rows.length, saved, from };
}

// post classified transactions
async function post(c: Creds, ids: string[], by: string, force: boolean) {
  const all = await data("ids", { ids }), byId = new Map(all.map((t: any) => [t.tx_id, t]));
  const qa = new Map((await data("accounts")).map((a: any) => [a.id, a]));
  const out: any[] = [];
  const done = new Set<string>();
  // what QuickBooks already has around these days (read once for the whole batch)
  const ds = all.map((t: any) => String(t.date)).sort();
  let ps: Posting[] = [];
  if (!force && ds.length) ps = await postings(c, dayAdd(ds[0], -4), dayAdd(ds[ds.length - 1], 4));
  const usedQ = new Set((await data("used")).map((x: any) => `${x.qbo_type}:${x.qbo_id}`));
  for (const id of ids) {
    if (done.has(id)) continue;
    const t: any = byId.get(id);
    const res = (r: Record<string, unknown>) => { out.push({ tx_id: id, ...r }); };
    if (!t) { res({ ok: false, error: "not found" }); continue; }
    if (t.status === "posted" || t.status === "linked") { res({ ok: true, already: true, qbo_type: t.qbo_type, qbo_id: t.qbo_id }); continue; }
    if (t.status !== "ready") { res({ ok: false, error: "mark it Ready first" }); continue; }
    if (t.kind === "skip") { res({ ok: false, error: "it's marked skip" }); continue; }
    if (t.pending) { res({ ok: false, error: "still pending at the bank — post it once it clears" }); continue; }
    const A: any = qa.get(t.qbo_account_id);
    if (!A) { res({ ok: false, error: `${t.institution} ${t.acct_name} isn't matched to a QuickBooks account yet` }); continue; }
    if (!t.class_account) { res({ ok: false, error: "no category picked" }); continue; }
    const amt = r2(t.amount), abs = Math.abs(amt), card = A.type === "Credit Card";
    // already in QuickBooks? (someone categorized it there, or it was posted another way)
    if (!force) {
      const hit = ps.find(p => p.acct === t.qbo_account_id && p.amt === amt && Math.abs(dayDiff(p.date, t.date)) <= 4 && !usedQ.has(`${p.type}:${p.id}`));
      if (hit) { usedQ.add(`${hit.type}:${hit.id}`); await rpc("fin_bank_posted", { p: { tx_ids: [id], status: "linked", qbo_type: hit.type, qbo_id: hit.id, by } }); res({ ok: true, linked: true, qbo_type: hit.type, qbo_id: hit.id }); continue; }
    }
    const desc = [t.merchant, t.name].filter(Boolean).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).join(" · ").slice(0, 3900);
    const note = [t.memo, desc, "posted from Seller Sage Finance"].filter(Boolean).join(" · ").slice(0, 3900);
    const vend = t.vendor_id ? { value: String(t.vendor_id), type: "Vendor" } : undefined;
    let type = "", body: any;
    try {
      if (t.kind === "transfer") {
        const B: any = qa.get(t.class_account);
        if (!B) { res({ ok: false, error: "a transfer needs the other bank account or card" }); continue; }
        type = "Transfer";
        body = { FromAccountRef: { value: amt > 0 ? A.id : B.id }, ToAccountRef: { value: amt > 0 ? B.id : A.id }, Amount: abs, TxnDate: t.date, PrivateNote: note };
      } else if (amt > 0 || card) {
        type = "Purchase";
        body = { PaymentType: card ? "CreditCard" : t.check_number ? "Check" : "Cash", AccountRef: { value: A.id }, TxnDate: t.date, PrivateNote: note,
          ...(card && amt < 0 ? { Credit: true } : {}), ...(vend ? { EntityRef: vend } : {}), ...(t.check_number && !card ? { DocNumber: String(t.check_number).slice(0, 21) } : {}),
          Line: [{ DetailType: "AccountBasedExpenseLineDetail", Amount: abs, Description: desc, AccountBasedExpenseLineDetail: { AccountRef: { value: t.class_account } } }] };
      } else {
        type = "Deposit";
        body = { DepositToAccountRef: { value: A.id }, TxnDate: t.date, PrivateNote: note,
          Line: [{ DetailType: "DepositLineDetail", Amount: abs, Description: desc, DepositLineDetail: { AccountRef: { value: t.class_account }, ...(vend ? { Entity: vend } : {}) } }] };
      }
      const made = (await qb(c, "POST", type.toLowerCase(), body))[type];
      const tie = [id];
      // a transfer between two linked accounts: the other side is the same QuickBooks transfer
      if (type === "Transfer" && t.other_tx) {
        const o: any = byId.get(t.other_tx);
        if (o && !(o.status === "posted" || o.status === "linked")) { tie.push(t.other_tx); done.add(t.other_tx); }
      }
      await rpc("fin_bank_posted", { p: { tx_ids: tie, status: "posted", qbo_type: type, qbo_id: made.Id, by } });
      res({ ok: true, posted: true, qbo_type: type, qbo_id: made.Id, also: tie.slice(1) });
    } catch (e) { res({ ok: false, error: (e as Error).message }); }
  }
  return { ok: out.every(r => r.ok), results: out, posted: out.filter(r => r.posted).length, linked: out.filter(r => r.linked).length, failed: out.filter(r => !r.ok).length };
}

async function caller(req: Request, c: Creds): Promise<{ by: string; sched: boolean } | null> {
  const k = req.headers.get("x-jt-key");
  if (k && c.jt_fn_key && k === c.jt_fn_key) return { by: "scheduler", sched: true };
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await admin.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: fin } = await admin.rpc("fin_allowed", { uid: data.user.id });
  return fin ? { by: data.user.email || "finance user", sched: false } : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const pc = await rpc("fin_plaid_creds") as { plaid: Creds; tokens: Record<string, string> };
    const c: Creds = { ...(pc?.plaid || {}), ...(await rpc("jt_qbo_creds")) };
    const who = await caller(req, c);
    if (!who) return json({ ok: false, error: "not allowed" }, 403);
    const p = await req.json().catch(() => ({}));
    if (who.sched && !["sync", "match", "learn"].includes(p.action)) return json({ ok: false, error: "not allowed" }, 403);
    const plaidReady = !!(c.plaid_client_id && c.plaid_secret);
    const items = async () => await data("items");

    if (p.action === "status") return json({ ok: true, plaid: plaidReady, env: c.plaid_env || "production", items: (await items()).map(i => ({ item_id: i.item_id, institution: i.institution, status: i.status, error: i.error, synced_at: i.synced_at })) });
    if (["link_token", "exchange", "sync"].includes(p.action) && !plaidReady)
      return json({ ok: false, error: "Plaid isn't set up yet: add plaid_client_id, plaid_secret and plaid_env to the Supabase Vault." }, 400);
    if (p.action === "link_token") {
      const base: any = { client_name: "Just Tennis Finance", user: { client_user_id: who.by.replace(/[^a-z0-9]/gi, "_").slice(0, 60) }, country_codes: ["US"], language: "en" };
      if (p.item_id) { const tok = pc.tokens[String(p.item_id)]; if (!tok) return json({ ok: false, error: "that bank isn't linked" }, 400); base.access_token = tok; }
      else { base.products = ["transactions"]; base.transactions = { days_requested: 730 }; }
      const r = await plaid(c, "/link/token/create", base);
      return json({ ok: true, link_token: r.link_token, expiration: r.expiration });
    }
    if (p.action === "exchange") {
      if (!p.public_token) return json({ ok: false, error: "public_token is required" }, 400);
      const r = await plaid(c, "/item/public_token/exchange", { public_token: String(p.public_token) });
      await rpc("fin_plaid_token_save", { item: r.item_id, tok: r.access_token });
      await rpc("fin_bank_save", { p: { item: { item_id: r.item_id, institution: p.institution?.name || "", institution_id: p.institution?.institution_id || "", linked_by: who.by } } });
      const s = await syncItem(c, { item_id: r.item_id, cursor: null }, r.access_token);
      return json({ ok: true, item_id: r.item_id, ...s });
    }
    if (p.action === "sync") {
      const out: any[] = [];
      for (const it of await items()) {
        if (p.item_id && it.item_id !== p.item_id) continue;
        const tok = pc.tokens[it.item_id]; if (!tok) continue;
        try { out.push(await syncItem(c, it, tok)); } catch (e) { out.push({ item_id: it.item_id, error: (e as Error).message }); }
      }
      let m: any = null;
      if (p.match) { try { m = await match(c, who.by, 45); } catch (e) { m = { error: (e as Error).message }; } }
      return json({ ok: true, items: out, match: m });
    }
    if (p.action === "match") return json({ ok: true, ...(await match(c, who.by, Math.min(Number(p.days) || 120, 400), Array.isArray(p.tx_ids) ? p.tx_ids.map(String) : undefined)) });
    if (p.action === "learn") return json({ ok: true, ...(await learn(c, Math.min(Number(p.days) || 365, 730))) });
    if (p.action === "post") {
      const ids = Array.isArray(p.tx_ids) ? p.tx_ids.map(String).slice(0, 200) : [];
      if (!ids.length) return json({ ok: false, error: "tx_ids is required" }, 400);
      return json(await post(c, ids, who.by, !!p.force));
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
