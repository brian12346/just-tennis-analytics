// Amazon Selling Partner API for the Just Tennis dashboard (North America: US, Canada, Mexico).
// POST {action: "status"}               -> the marketplaces this seller account takes part in (checks the connection)
// POST {action: "sync", force?}         -> picks up order reports Amazon has finished, and (at most hourly, or when
//                                          forced) asks for a new report of orders changed in the last 3 days
// POST {action: "backfill", since, until?} -> asks for order reports by purchase date from `since` to `until` (or now),
//                                          30 days each. Amazon allows about 15 report requests at once, then 1 a minute:
//                                          chunks it turns away are queued and asked for by later syncs.
// Orders come from Amazon's flat-file order reports (one row per order item), saved to jt.amazon_order_lines.
// Callers: a signed-in app user (Authorization: Bearer <user JWT>), or SQL via jt.amazon_call (x-jt-key).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-jt-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const HOST = "https://sellingpartnerapi-na.amazon.com";
const MARKETS: Record<string, string> = { ATVPDKIKX0DER: "us", A2EUQ1WTGCTBG2: "ca", A1AM78C64UM0Y8: "mx" };
const BY_UPDATE = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL";
const BY_ORDER = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL";
const CHANNEL: Record<string, string> = { "amazon.com": "us", "amazon.ca": "ca", "amazon.com.mx": "mx" };

type Creds = Record<string, string>;
async function creds(): Promise<Creds> {
  const { data, error } = await admin.rpc("jt_spapi_creds");
  if (error) throw new Error("reading credentials: " + error.message);
  return data || {};
}
async function rpc(fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

let access = "";
async function token(c: Creds): Promise<string> {
  if (access) return access;
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.spapi_refresh_token, client_id: c.spapi_client_id, client_secret: c.spapi_client_secret }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error(`Amazon sign-in failed (${r.status}): ${t.error_description || t.error || "no access token"} — check the three spapi_ secrets in Vault, or authorize the app again for a new refresh token`);
  access = t.access_token;
  return access;
}
async function sp(c: Creds, method: string, path: string, body?: unknown, tries = 0): Promise<any> {
  const r = await fetch(HOST + path, {
    method, headers: { "x-amz-access-token": await token(c), "Content-Type": "application/json", Accept: "application/json", "User-Agent": "JustTennisDashboard/1.0 (Language=TypeScript)" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 429 && tries < 3) { await new Promise((f) => setTimeout(f, 2000 * (tries + 1))); return sp(c, method, path, body, tries + 1); }
  const b = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = (b.errors || [])[0] || {};
    const err = new Error(`Amazon API ${r.status} on ${path.split("?")[0]}: ${e.message || JSON.stringify(b).slice(0, 300)}${e.details ? " — " + e.details : ""}`);
    (err as any).status = r.status;
    throw err;
  }
  return b;
}

// ---- reports
async function requestReport(c: Creds, type: string, start: Date, end: Date | null, kind: string, by: string, queuedId?: string) {
  const ids = Object.keys(MARKETS);
  const ask = async (mk: string[]) => {
    const body: any = { reportType: type, marketplaceIds: mk, dataStartTime: start.toISOString() };
    if (end) body.dataEndTime = end.toISOString();
    const r = await sp(c, "POST", "/reports/2021-06-30/reports", body);
    await rpc("jt_amazon_save", { p: { op: "request", report_id: r.reportId, report_type: type, kind, marketplaces: mk.map((m) => MARKETS[m]), data_start: start.toISOString(), data_end: end ? end.toISOString() : null, by, queued_id: queuedId } });
    return r.reportId as string;
  };
  try { return [await ask(ids)]; }
  catch (e) {
    // some accounts can't ask for several marketplaces in one report: one report per marketplace instead
    if ((e as any).status !== 400) throw e;
    const out: string[] = [];
    for (const m of ids) { try { out.push(await ask([m])); } catch (e2) { if ((e2 as any).status !== 400) throw e2; } }
    if (!out.length) throw e;
    return out;
  }
}

const num = (s: string | undefined) => { const v = parseFloat(String(s ?? "").replace(/,/g, "")); return isNaN(v) ? 0 : v; };
const r2 = (x: number) => Math.round(x * 100) / 100;
function parseOrders(text: string) {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!rows.length) return [];
  const H = rows[0].split("\t").map((h) => h.trim().toLowerCase());
  const at = (r: string[], n: string) => { const i = H.indexOf(n); return i < 0 ? "" : (r[i] ?? "").trim(); };
  const lines = new Map<string, any>();
  for (const l of rows.slice(1)) {
    const r = l.split("\t");
    const order_id = at(r, "amazon-order-id"), sku = at(r, "sku");
    if (!order_id || !sku) continue;
    const ch = at(r, "sales-channel");
    const k = order_id + "\u0001" + sku;
    const x = lines.get(k);
    const money = { quantity: Math.round(num(at(r, "quantity"))), item_price: num(at(r, "item-price")), item_tax: num(at(r, "item-tax")), shipping_price: num(at(r, "shipping-price")), shipping_tax: num(at(r, "shipping-tax")), gift_wrap_price: num(at(r, "gift-wrap-price")), item_promo: num(at(r, "item-promotion-discount")), ship_promo: num(at(r, "ship-promotion-discount")) };
    if (x) { for (const [f, v] of Object.entries(money)) x[f] = r2(x[f] + v); continue; }
    // Amazon lists discounts as positive or negative depending on the report; keep them negative
    lines.set(k, {
      order_id, sku, asin: at(r, "asin"), merchant_order_id: at(r, "merchant-order-id"),
      purchase_at: at(r, "purchase-date") || null, last_updated_at: at(r, "last-updated-date") || null,
      order_status: at(r, "order-status"), item_status: at(r, "item-status"), fulfillment: at(r, "fulfillment-channel"),
      sales_channel: ch, marketplace: CHANNEL[ch.toLowerCase()] || "other", product_name: at(r, "product-name"),
      currency: at(r, "currency"), ...money, is_business: /^true$/i.test(at(r, "is-business-order")),
      ship_state: at(r, "ship-state"), ship_country: at(r, "ship-country"),
    });
  }
  const out = [...lines.values()];
  for (const x of out) { x.item_promo = -Math.abs(x.item_promo); x.ship_promo = -Math.abs(x.ship_promo); }
  return out;
}

async function fetchDocument(c: Creds, docId: string): Promise<string> {
  const d = await sp(c, "GET", `/reports/2021-06-30/documents/${encodeURIComponent(docId)}`);
  const r = await fetch(d.url);
  if (!r.ok) throw new Error(`downloading the report failed (${r.status})`);
  let stream: ReadableStream<Uint8Array> = r.body!;
  if (d.compressionAlgorithm === "GZIP") stream = stream.pipeThrough(new DecompressionStream("gzip"));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { return new TextDecoder("windows-1252").decode(buf); }
}

// pick up finished reports; returns what happened to each
async function collect(c: Creds, deadline: number) {
  const st = await rpc("jt_amazon_state");
  const done: any[] = [];
  for (const p of st.pending || []) {
    if (Date.now() > deadline) break;
    const rep = await sp(c, "GET", `/reports/2021-06-30/reports/${encodeURIComponent(p.report_id)}`);
    const s = rep.processingStatus;
    if (s === "IN_QUEUE" || s === "IN_PROGRESS") {
      // Amazon gives up on some requests silently; stop waiting after a day
      if (Date.now() - new Date(p.requested_at).getTime() > 24 * 3600 * 1000) { await rpc("jt_amazon_save", { p: { op: "report", report_id: p.report_id, status: "failed", detail: "Amazon never finished the report" } }); done.push({ report_id: p.report_id, status: "failed" }); }
      else done.push({ report_id: p.report_id, status: "waiting" });
      continue;
    }
    if (s === "CANCELLED") {   // Amazon cancels a report when there is no data in its range
      await rpc("jt_amazon_save", { p: { op: "report", report_id: p.report_id, status: "done", rows: 0, detail: "no orders in this range" } });
      done.push({ report_id: p.report_id, status: "done", rows: 0 }); continue;
    }
    if (s !== "DONE") {
      await rpc("jt_amazon_save", { p: { op: "report", report_id: p.report_id, status: "failed", detail: `Amazon status ${s}` } });
      done.push({ report_id: p.report_id, status: "failed", detail: s }); continue;
    }
    try {
      const lines = parseOrders(await fetchDocument(c, rep.reportDocumentId));
      let saved = 0;
      for (let i = 0; i < lines.length; i += 1500) saved += await rpc("jt_amazon_save", { p: { op: "lines", report_id: p.report_id, lines: lines.slice(i, i + 1500) } });
      await rpc("jt_amazon_save", { p: { op: "report", report_id: p.report_id, status: "done", rows: lines.length, detail: `${saved} lines saved` } });
      done.push({ report_id: p.report_id, status: "done", rows: lines.length, saved });
    } catch (e) {
      await rpc("jt_amazon_save", { p: { op: "report", report_id: p.report_id, status: "failed", detail: String((e as Error).message).slice(0, 500) } });
      done.push({ report_id: p.report_id, status: "failed", detail: (e as Error).message });
    }
  }
  return { st, done };
}

async function caller(req: Request, c: Creds): Promise<string | null> {
  const k = req.headers.get("x-jt-key");
  if (k && c.jt_fn_key && k === c.jt_fn_key) return "scheduler";
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await admin.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: ok } = await admin.rpc("jt_qbo_allowed", { uid: data.user.id });
  return ok ? data.user.email || "app user" : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const t0 = Date.now();
  try {
    const c = await creds();
    const by = await caller(req, c);
    if (!by) return json({ ok: false, error: "not allowed" }, 403);
    for (const k of ["spapi_client_id", "spapi_client_secret", "spapi_refresh_token"]) if (!c[k]) return json({ ok: false, error: `${k} is missing from Vault` }, 400);
    const p = await req.json().catch(() => ({}));
    if (p.action === "status") {
      const r = await sp(c, "GET", "/sellers/v1/marketplaceParticipations");
      return json({ ok: true, marketplaces: (r.payload || []).map((x: any) => ({ id: x.marketplace?.id, name: x.marketplace?.name, country: x.marketplace?.countryCode, currency: x.marketplace?.defaultCurrencyCode, participating: x.participation?.isParticipating, suspended: x.participation?.hasSuspendedListings, store: x.storeName })) });
    }
    if (p.action === "sync") {
      const { st, done } = await collect(c, t0 + 90_000);
      let requested: string[] = [];
      const last = st.last_recent ? new Date(st.last_recent).getTime() : 0;
      const recentIds = new Set((st.pending || []).filter((x: any) => x.kind === "recent").map((x: any) => x.report_id));
      const waiting = done.some((d) => d.status === "waiting" && recentIds.has(d.report_id));
      let throttled = false;
      if (p.force || (Date.now() - last > 55 * 60 * 1000 && !waiting)) {
        try { requested = await requestReport(c, BY_UPDATE, new Date(Date.now() - 3 * 86400_000), null, "recent", by); }
        catch (e) { if ((e as any).status !== 429) throw e; throttled = true; }   // Amazon's report quota: the next sync asks again
      }
      // a few queued backfill chunks, as Amazon's quota allows
      let dequeued = 0;
      for (const q of throttled ? [] : (st.queued || []).slice(0, 3)) {
        try { await requestReport(c, q.report_type, new Date(q.data_start), q.data_end ? new Date(q.data_end) : null, q.kind, by, q.report_id); dequeued++; }
        catch (e) { if ((e as any).status === 429) break; throw e; }
      }
      return json({ ok: true, collected: done, requested, throttled, dequeued, queued: (st.queued || []).length - dequeued });
    }
    if (p.action === "backfill") {
      const since = new Date(String(p.since || ""));
      if (isNaN(since.getTime())) return json({ ok: false, error: "since must be a date" }, 400);
      const until = Math.min(p.until ? new Date(String(p.until)).getTime() || Date.now() : Date.now(), Date.now() - 5 * 60_000);
      const ids: string[] = [];
      let queued = 0;
      for (let s = since.getTime(); s < until; s += 30 * 86400_000) {
        const e = Math.min(s + 30 * 86400_000, until);
        if (!queued) {
          try { ids.push(...await requestReport(c, BY_ORDER, new Date(s), new Date(e), "backfill", by)); continue; }
          catch (err) { if ((err as any).status !== 429) throw err; }
        }
        await rpc("jt_amazon_save", { p: { op: "queue", report_type: BY_ORDER, kind: "backfill", data_start: new Date(s).toISOString(), data_end: new Date(e).toISOString(), by } });
        queued++;
      }
      return json({ ok: true, requested: ids, queued });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message });
  }
});
