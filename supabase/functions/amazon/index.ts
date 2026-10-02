// Amazon Selling Partner API for the Just Tennis dashboard (North America: US, Canada, Mexico).
// POST {action: "status"}               -> the marketplaces this seller account takes part in (checks the connection)
// POST {action: "sync", force?}         -> picks up order reports Amazon has finished, and (at most hourly, or when
//                                          forced) asks for a new report of orders changed in the last 3 days
// POST {action: "backfill", since, until?} -> asks for order reports by purchase date from `since` to `until` (or now),
//                                          30 days each. Amazon allows about 15 report requests at once, then 1 a minute:
//                                          chunks it turns away are queued and asked for by later syncs.
// POST {action: "fin_days", first, last, check?} -> money from the Finances API (2024-06-19 transactions) for whole Pacific days
//                                          first..last: every transaction item is saved to jt.amazon_fin_lines, then
//                                          jt_amazon_fin_build turns the days into the Amazon tab's days (amzdays, or
//                                          amzdays_api with check). Stops before the time limit and says which day is
//                                          next ({ok, done: [days], next}). This replaces uploading the Transaction report
//                                          (Amazon doesn't let this account request that report through the API).
// POST {action: "fin_nightly"}          -> fin_days for the last 7 full days (scheduled nightly)
// POST {action: "fin_recent"}           -> fin_days for yesterday and today so far (scheduled hourly, and Refresh)
// POST {action: "listings"}            -> asks now for the All Listings report (US); the next sync saves it
// POST {action: "fbm_qty", items: [{sku, quantity}], preview?} -> sets FBM listings' available quantity on amazon.com
//                                          (Listings Items API patch of fulfillment_availability, channel DEFAULT; other
//                                          fields of it such as handling time are kept). preview = Amazon's
//                                          VALIDATION_PREVIEW: checked, nothing changed. Each one is logged in jt.fbm_pushes.
//                                          Stops before the time limit: {ok, results, next: [items not done]}.
// POST {action: "probe", path}          -> read-only GET of a /finances/, /reports/, /listings/ or /fba/ endpoint, for troubleshooting
// POST {action: "inbound_shipments", since?, until?, kinds?, backfill_items?} -> FBA shipments (Fulfillment Inbound v0) and
//                                          AWD shipments (AWD 2024-05-09) updated since `since` (default: the last 3 days) into
//                                          jt.inbound_shipments, with SKU quantities (jt.inbound_shipment_items) for open
//                                          and changed ones (backfill_items: also closed ones saved without them) as time
//                                          allows; rerun until {done: true}. kinds: ["fba"], ["awd"] or both. Hourly.
//                                          AWD quantities are in units (Amazon reports cases; cases × units per case).
// POST {action: "fba_inventory"}        -> FBA inventory now (FBA Inventory API getInventorySummaries, amazon.com pool, all
//                                          pages, with details) into jt.fba_inventory (jt_fba_inventory_save). Scheduled hourly.
// Listings: GET_MERCHANT_LISTINGS_ALL_DATA (the All Listings report), asked for once a day by sync and saved to jt.docs
// 'amzlistings' (jt_amazon_listings_save) in the shape the dashboard's upload used.
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
const LISTINGS = "GET_MERCHANT_LISTINGS_ALL_DATA";
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

// the All Listings report for amazon.com (the FBM tab and the mapping tab work from the US listings)
async function requestListings(c: Creds, by: string) {
  const r = await sp(c, "POST", "/reports/2021-06-30/reports", { reportType: LISTINGS, marketplaceIds: ["ATVPDKIKX0DER"] });
  await rpc("jt_amazon_save", { p: { op: "request", report_id: r.reportId, report_type: LISTINGS, kind: "listings", marketplaces: ["us"], data_start: null, data_end: null, by } });
  return r.reportId as string;
}
// rows as the dashboard's upload saves them: [sku, asin, title, price, qty, channel, status, open date]
function parseListings(text: string) {
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (rows.length < 2) return [];
  const H = rows[0].split("\t").map((h) => h.trim().toLowerCase());
  const ix = (n: string) => H.indexOf(n);
  if (ix("seller-sku") < 0) throw new Error("the listings report has no seller-sku column");
  const col: Record<string, number> = { sku: ix("seller-sku"), asin: ix("asin1") >= 0 ? ix("asin1") : ix("product-id"), title: ix("item-name"), price: ix("price"),
    qty: ix("quantity"), channel: ix("fulfillment-channel"), status: ix("status"), opened: ix("open-date") };
  const out: unknown[] = [];
  for (const l of rows.slice(1)) {
    const f = l.split("\t"); const g = (k: string) => col[k] >= 0 ? (f[col[k]] || "").trim() : "";
    if (!g("sku")) continue;
    const pr = parseFloat(g("price").replace(/[^0-9.\-]/g, ""));
    out.push([g("sku"), g("asin"), g("title").slice(0, 160), isNaN(pr) ? null : pr, g("qty") === "" ? null : Number(g("qty")), g("channel"), g("status") || "Active", g("opened").slice(0, 10)]);
  }
  return out;
}

// ---- FBM quantities (Listings Items API)
const SELLER_ID = "AJPAM6HXYXK3Y";   // Just Tennis's seller (merchant) id; not a secret
async function fbmQty(c: Creds, by: string, items: any[], preview: boolean, deadline: number) {
  const results: any[] = [];
  let i = 0;
  for (; i < items.length && Date.now() < deadline; i++) {
    const it = items[i] || {};
    const sku = String(it.sku || ""), qty = Math.floor(Number(it.quantity));
    const rec: any = { sku, asin: "", quantity: qty, amazon_before: null, preview, status: "failed", issues: [], error: "", by };
    try {
      if (!sku) throw new Error("no SKU");
      if (!Number.isFinite(qty) || qty < 0 || qty > 9999) throw new Error("quantity must be a whole number from 0 to 9999");
      const path = `/listings/2021-08-01/items/${encodeURIComponent(c.spapi_seller_id || SELLER_ID)}/${encodeURIComponent(sku)}?marketplaceIds=ATVPDKIKX0DER`;
      const cur = await sp(c, "GET", path + "&includedData=summaries,attributes,fulfillmentAvailability");
      const sum = (cur.summaries || [])[0] || {};
      rec.asin = sum.asin || "";
      if (!sum.productType) throw new Error("Amazon has no product type for this listing");
      const fa: any[] = cur.fulfillmentAvailability || [];
      const own = fa.find((x) => x.fulfillmentChannelCode === "DEFAULT");
      if (!own && fa.length) throw new Error("this listing is fulfilled by Amazon (FBA), not by you");
      rec.amazon_before = own && own.quantity != null ? Number(own.quantity) : null;
      const cur_fa: any[] = (cur.attributes && cur.attributes.fulfillment_availability) || [];
      const keep = cur_fa.find((x) => x.fulfillment_channel_code === "DEFAULT") || { fulfillment_channel_code: "DEFAULT" };
      const body = { productType: sum.productType, patches: [{ op: "replace", path: "/attributes/fulfillment_availability", value: [{ ...keep, quantity: qty }] }] };
      const r = await sp(c, "PATCH", path + "&includedData=issues" + (preview ? "&mode=VALIDATION_PREVIEW" : ""), body);
      rec.status = r.status || "failed";
      rec.issues = (r.issues || []).map((x: any) => ({ code: x.code, message: x.message, severity: x.severity }));
      if (rec.status !== "ACCEPTED" && rec.status !== "VALID") rec.error = rec.issues.filter((x: any) => x.severity === "ERROR").map((x: any) => x.message).join("; ") || `Amazon said ${rec.status}`;
    } catch (e) {
      rec.status = "failed"; rec.error = String((e as Error).message).slice(0, 500);
    }
    await rpc("jt_amazon_fbm_push_save", { p: rec });
    results.push({ sku, quantity: qty, status: rec.status, before: rec.amazon_before, error: rec.error, issues: rec.issues });
    await new Promise((f) => setTimeout(f, 250));   // Listings API: 5 requests a second
  }
  return { results, next: items.slice(i) };
}

const num = (s: string | undefined) => { const v = parseFloat(String(s ?? "").replace(/,/g, "")); return isNaN(v) ? 0 : v; };
const r2 = (x: number) => Math.round(x * 100) / 100;
function parseOrders(text: string) {
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
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

// ---- Finances API: transactions -> compact lines (one per item; amounts flattened to "Path/To/Leaf": amount)
function flat(bs: any[] | null | undefined, prefix: string, out: Record<string, number>) {
  for (const b of bs || []) {
    const k = prefix ? prefix + "/" + b.breakdownType : b.breakdownType;
    if (b.breakdowns && b.breakdowns.length) flat(b.breakdowns, k, out);
    else out[k] = r2((out[k] || 0) + Number(b.breakdownAmount?.currencyAmount || 0));
  }
  return out;
}
function finLines(t: any) {
  const rel = (n: string) => (t.relatedIdentifiers || []).find((x: any) => x.relatedIdentifierName === n)?.relatedIdentifierValue || "";
  const base = {
    transaction_id: t.transactionId, posted_at: t.postedDate, type: t.transactionType || "", description: t.description || "",
    status: t.transactionStatus || "", order_id: rel("ORDER_ID"), marketplace: t.marketplaceDetails?.marketplaceId || t.sellingPartnerMetadata?.marketplaceId || "",
    currency: t.totalAmount?.currencyCode || "",
    release_of: rel("DEFERRED_TRANSACTION_ID"),   // the release of a deferred transaction already counted when it posted
  };
  const items = t.items || [];
  if (!items.length) return [{ ...base, item: 0, sku: "", qty: 0, fulfillment: "", total: Number(t.totalAmount?.currencyAmount || 0), amounts: flat(t.breakdowns, "", {}) }];
  return items.map((it: any, i: number) => {
    const ctx = (it.contexts || []).find((x: any) => x.sku || x.quantityShipped != null) || {};
    return { ...base, item: i, sku: ctx.sku || "", qty: Number(ctx.quantityShipped || 0), fulfillment: ctx.fulfillmentNetwork || "",
      total: Number(it.totalAmount?.currencyAmount || 0), amounts: flat(it.breakdowns, "", {}) };
  });
}
async function finDay(c: Creds, day: string) {
  // Pacific midnight to midnight (07:00 or 08:00 UTC)
  const midnight = (d: string) => {
    for (const h of [7, 8]) { const x = new Date(`${d}T0${h}:00:00Z`); if (Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(x)) % 24 === 0) return x; }
    return new Date(`${d}T08:00:00Z`);
  };
  const nd = new Date(day + "T12:00:00Z"); nd.setUTCDate(nd.getUTCDate() + 1);
  const start = midnight(day), end = midnight(nd.toISOString().slice(0, 10));
  let token = "", n = 0, pages = 0;
  const all: any[] = [];
  do {
    const q = `postedAfter=${start.toISOString()}&postedBefore=${(end > new Date() ? new Date(Date.now() - 3 * 60_000) : end).toISOString()}${token ? `&nextToken=${encodeURIComponent(token)}` : ""}`;
    const r = await sp(c, "GET", `/finances/2024-06-19/transactions?${q}`);
    for (const t of r.payload?.transactions || []) all.push(...finLines(t));
    token = r.payload?.nextToken || ""; pages++;
    if (token) await new Promise((f) => setTimeout(f, 1500));   // 0.5 requests a second
  } while (token && pages < 40);
  for (let i = 0; i < all.length; i += 1000) n += await rpc("jt_amazon_fin_lines_save", { p: { day, lines: all.slice(i, i + 1000) } });
  return { day, lines: all.length, saved: n, pages };
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
    if (p.report_type === LISTINGS) {
      try {
        const rows = parseListings(await fetchDocument(c, rep.reportDocumentId));
        const at = rep.createdTime || new Date().toISOString();
        const saved = await rpc("jt_amazon_listings_save", { p: { file: `Amazon API · All Listings ${String(at).slice(0, 10)}`, at, rows } });
        await rpc("jt_amazon_save", { p: { op: "report", report_id: p.report_id, status: "done", rows: rows.length, detail: `${saved} listings saved` } });
        done.push({ report_id: p.report_id, status: "done", listings: saved });
      } catch (e) {
        await rpc("jt_amazon_save", { p: { op: "report", report_id: p.report_id, status: "failed", detail: String((e as Error).message).slice(0, 500) } });
        done.push({ report_id: p.report_id, status: "failed", detail: (e as Error).message });
      }
      continue;
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

// ---- inbound shipments (FBA and AWD)
// Headers for every shipment updated in the window; SKU quantities (one call per shipment) for open shipments, ones
// whose status changed, and (backfill_items) closed ones saved without them, open ones first, as time allows.
const wait = (ms: number) => new Promise((f) => setTimeout(f, ms));
const FBA_STATUSES = "WORKING,READY_TO_SHIP,SHIPPED,IN_TRANSIT,DELIVERED,CHECKED_IN,RECEIVING,CLOSED,CANCELLED,DELETED,ERROR";
const DONE = new Set(["CLOSED", "CANCELLED", "DELETED"]);
async function inboundShipments(c: Creds, since: Date, until: Date, deadline: number, kinds: string[], backfillItems: boolean) {
  const known: Record<string, string> = (await rpc("jt_inbound_shipments_known")) || {};   // id -> "STATUS|skus"
  const res: any = {};
  const save = async (list: any[]) => { let n = 0; for (let i = 0; i < list.length; i += 100) n += await rpc("jt_inbound_shipments_save", { p: { shipments: list.slice(i, i + 100) } }); return n; };
  const wants = (id: string, st: string) => { const k = known[id]; if (!k) return true; const [ks, n] = k.split("|"); return !DONE.has(st) || ks !== st || (backfillItems && n === "0"); };
  async function run(kind: string, list: () => Promise<any[]>, head: (x: any) => any, items: (row: any) => Promise<void>) {
    const r: any = { found: 0, saved: 0, items: 0, items_left: 0, done: false, error: "" }; res[kind.toLowerCase()] = r;
    try {
      const ships = await list(); r.found = ships.length;
      // shipments without saved SKU quantities first, then open ones (so repeated runs work through the backlog)
      const has = (id: string) => !!known[id] && known[id].split("|")[1] !== "0";
      const rows = ships.map(head).sort((a: any, b: any) => (has(a.id) ? 1 : 0) - (has(b.id) ? 1 : 0) || (DONE.has(a.status) ? 1 : 0) - (DONE.has(b.status) ? 1 : 0));
      r.saved = await save(rows);                       // headers first (items: null keeps any saved items)
      let batch: any[] = [];
      for (const row of rows) {
        if (!wants(row.id, row.status)) continue;
        if (Date.now() > deadline) { r.items_left++; continue; }
        await items(row); r.items++; batch.push(row);
        if (batch.length >= 10) { await save(batch); batch = []; }
      }
      await save(batch);
      r.done = !r.items_left;
    } catch (e) { r.error = (e as Error).message; }
  }
  const US = "ATVPDKIKX0DER";
  if (kinds.includes("fba")) await run("FBA", async () => {
    const ships: any[] = []; let next = "";
    do {
      const q = new URLSearchParams(next ? { MarketplaceId: US, QueryType: "NEXT_TOKEN", NextToken: next }
        : { MarketplaceId: US, QueryType: "DATE_RANGE", ShipmentStatusList: FBA_STATUSES, LastUpdatedAfter: since.toISOString(), LastUpdatedBefore: until.toISOString() });
      const r = await sp(c, "GET", "/fba/inbound/v0/shipments?" + q.toString());
      ships.push(...(r.payload?.ShipmentData || []));
      next = r.payload?.NextToken || "";
      if (next) await wait(550);
    } while (next);
    return ships;
  }, (x) => ({ id: x.ShipmentId, kind: "FBA", name: x.ShipmentName || "", status: x.ShipmentStatus || "", destination: x.DestinationFulfillmentCenterId || "", raw: x, items: null }),
  async (row) => {
    // first page by shipment ID; more pages (if any) through getShipmentItems with the NextToken. Amazon hands back a
    // token even on the last page, so only a full page (50+ lines) goes on, at most 20 pages.
    const items: any[] = []; let nt = "", pages = 0;
    do {
      await wait(550);
      let r: any;
      if (!nt) r = await sp(c, "GET", `/fba/inbound/v0/shipments/${encodeURIComponent(row.id)}/items?MarketplaceId=${US}`);
      else { try { r = await sp(c, "GET", `/fba/inbound/v0/shipmentItems?` + new URLSearchParams({ MarketplaceId: US, QueryType: "NEXT_TOKEN", NextToken: nt }).toString()); } catch { break; } }
      const got = (r.payload?.ItemData || []).filter((it: any) => !it.ShipmentId || it.ShipmentId === row.id);
      for (const it of got) items.push({ sku: it.SellerSKU, fnsku: it.FulfillmentNetworkSKU || "", qty_expected: it.QuantityShipped || 0, qty_received: it.QuantityReceived || 0, qty_in_case: it.QuantityInCase || 0 });
      const t = r.payload?.NextToken || "";
      nt = got.length >= 50 && t && t !== nt ? t : ""; pages++;   // a short page is the last one
    } while (nt && pages < 20);
    row.items = items;
  });
  if (kinds.includes("awd")) await run("AWD", async () => {
    const ships: any[] = []; let next = "";
    do {
      const q = new URLSearchParams({ updatedAfter: since.toISOString(), updatedBefore: until.toISOString(), maxResults: "200", sortBy: "UPDATED_AT", sortOrder: "DESCENDING" });
      if (next) q.set("nextToken", next);
      const r = await sp(c, "GET", "/awd/2024-05-09/inboundShipments?" + q.toString());
      ships.push(...(r.shipments || []));
      next = r.nextToken || "";
      if (next) await wait(1100);
    } while (next);
    return ships;
  }, (x) => ({ id: x.shipmentId, kind: "AWD", name: x.externalReferenceId || x.orderId || "", status: x.shipmentStatus || "", destination: x.destinationRegion || x.warehouseReferenceId || "",
    created_at: x.createdAt || null, updated: x.updatedAt || null, raw: x, items: null }),
  async (row) => {
    await wait(600);
    const d = await sp(c, "GET", `/awd/2024-05-09/inboundShipments/${encodeURIComponent(row.id)}?skuQuantities=SHOW`);
    row.raw = { ...d, shipmentSkuQuantities: undefined };
    row.name = d.externalReferenceId || d.orderId || row.name;
    row.destination = d.destinationAddress?.name || d.destinationRegion || row.destination;
    row.carrier = d.carrierCode?.carrierCodeValue || ""; row.tracking = d.trackingId || "";
    row.created_at = d.createdAt || row.created_at; row.updated = d.updatedAt || row.updated;
    // AWD counts SKUs in cases: units come from the containers (cases × units per case)
    const units: Record<string, number> = {}, perCase: Record<string, number> = {};
    for (const ct of d.shipmentContainerQuantities || []) for (const pr of ct.distributionPackage?.contents?.products || []) {
      units[pr.sku] = (units[pr.sku] || 0) + (ct.count || 0) * (pr.quantity || 0); perCase[pr.sku] = pr.quantity || perCase[pr.sku] || 1; }
    const unitsOf = (q: any, sku: string) => !q ? 0 : q.unitOfMeasurement === "PRODUCT_UNITS" ? q.quantity || 0 : (q.quantity || 0) * (perCase[sku] || 1);
    row.items = (d.shipmentSkuQuantities || []).map((q: any) => ({ sku: q.sku, qty_expected: units[q.sku] || unitsOf(q.expectedQuantity, q.sku), qty_received: unitsOf(q.receivedQuantity, q.sku), qty_in_case: perCase[q.sku] || 0 }));
    for (const sku of Object.keys(units)) if (!row.items.some((x: any) => x.sku === sku)) row.items.push({ sku, qty_expected: units[sku], qty_received: 0, qty_in_case: perCase[sku] || 0 });
  });
  res.done = Object.values(res).every((r: any) => r.done);
  return res;
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
      // the All Listings report: once a day, or when asked (p.listings), unless one is already on its way
      let listings: string | null = null;
      const lastL = st.last_listings ? new Date(st.last_listings).getTime() : 0;
      const pendingL = (st.pending || []).some((x: any) => x.kind === "listings" && !done.some((d) => d.report_id === x.report_id && d.status !== "waiting"));
      if (!throttled && !pendingL && (p.listings || (Date.now() - lastL > 23 * 3600 * 1000 && Date.now() - (st.last_listings_any ? new Date(st.last_listings_any).getTime() : 0) > 3600 * 1000))) {
        try { listings = await requestListings(c, by); } catch (e) { if ((e as any).status !== 429) throw e; }
      }
      return json({ ok: true, collected: done, requested, throttled, dequeued, queued: (st.queued || []).length - dequeued, listings, listings_pending: pendingL });
    }
    if (p.action === "listings") {
      const st = await rpc("jt_amazon_state");
      const pend = (st.pending || []).find((x: any) => x.kind === "listings");
      if (pend) return json({ ok: true, report_id: pend.report_id, already: true });
      return json({ ok: true, report_id: await requestListings(c, by) });
    }
    if (p.action === "fbm_qty") {
      const items = Array.isArray(p.items) ? p.items.slice(0, 200) : [];
      if (!items.length) return json({ ok: false, error: "no items" }, 400);
      const out = await fbmQty(c, by, items, !!p.preview, t0 + 95_000);
      return json({ ok: true, ...out });
    }
    if (p.action === "fba_inventory") {
      const rows: any[] = []; let next = "", pages = 0;
      do {
        const q = new URLSearchParams({ details: "true", granularityType: "Marketplace", granularityId: "ATVPDKIKX0DER", marketplaceIds: "ATVPDKIKX0DER" });
        if (next) q.set("nextToken", next);
        const r = await sp(c, "GET", "/fba/inventory/v1/summaries?" + q.toString());
        for (const x of r.payload?.inventorySummaries || []) {
          const d = x.inventoryDetails || {}, rv = d.reservedQuantity || {};
          rows.push({ sku: x.sellerSku, asin: x.asin || "", fnsku: x.fnSku || "", name: x.productName || "", condition: x.condition || "",
            fulfillable: d.fulfillableQuantity || 0, inbound_working: d.inboundWorkingQuantity || 0, inbound_shipped: d.inboundShippedQuantity || 0,
            inbound_receiving: d.inboundReceivingQuantity || 0, reserved_total: rv.totalReservedQuantity || 0, reserved_customer: rv.pendingCustomerOrderQuantity || 0,
            reserved_transfer: rv.pendingTransshipmentQuantity || 0, reserved_processing: rv.fcProcessingQuantity || 0,
            researching: d.researchingQuantity?.totalResearchingQuantity || 0, unfulfillable: d.unfulfillableQuantity?.totalUnfulfillableQuantity || 0,
            total: x.totalQuantity || 0, updated: x.lastUpdatedTime || null });
        }
        next = r.pagination?.nextToken || ""; pages++;
        if (next) await new Promise((f) => setTimeout(f, 550));   // Amazon allows about 2 calls a second
      } while (next && Date.now() - t0 < 100_000);
      let saved = 0;
      for (let i = 0; i < rows.length; i += 1000) saved += await rpc("jt_fba_inventory_save", { p: { rows: rows.slice(i, i + 1000), complete: false } });
      if (!next) await rpc("jt_fba_inventory_save", { p: { rows: [], complete: true, skus: rows.map((r) => r.sku) } });
      return json({ ok: true, pages, rows: rows.length, saved, complete: !next });
    }
    if (p.action === "inbound_shipments") {
      const since = p.since ? new Date(String(p.since)) : new Date(Date.now() - 3 * 86400_000);
      if (isNaN(since.getTime())) return json({ ok: false, error: "since must be a date" }, 400);
      const until = p.until ? new Date(String(p.until)) : new Date(Date.now() - 120_000);
      if (isNaN(until.getTime())) return json({ ok: false, error: "until must be a date" }, 400);
      const kinds = Array.isArray(p.kinds) && p.kinds.length ? p.kinds.map((x: any) => String(x).toLowerCase()) : ["fba", "awd"];
      const out = await inboundShipments(c, since, until, t0 + 85_000, kinds, !!p.backfill_items);
      return json({ ok: true, since: since.toISOString(), until: until.toISOString(), ...out });
    }
    if (p.action === "probe") {   // read-only look at a Finances, Reports or Listings endpoint (troubleshooting), trimmed
      const path = String(p.path || "");
      if (!/^\/(finances|reports|listings|fba|awd|inbound)\//.test(path)) return json({ ok: false, error: "only /finances/, /reports/, /listings/, /fba/, /awd/ and /inbound/ paths" }, 400);
      const r = await sp(c, "GET", path);
      return json({ ok: true, result: JSON.stringify(r).slice(0, Number(p.limit) || 4000) });
    }
    if (p.action === "fin_days" || p.action === "fin_nightly" || p.action === "fin_recent") {
      let first = String(p.first || ""), last = String(p.last || "");
      const pt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);
      if (p.action === "fin_nightly") { last = pt(new Date(Date.now() - 86400_000)); first = pt(new Date(Date.now() - 7 * 86400_000)); }
      if (p.action === "fin_recent") { last = pt(new Date()); first = pt(new Date(Date.now() - 86400_000)); }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || !/^\d{4}-\d{2}-\d{2}$/.test(last) || first > last) return json({ ok: false, error: "first and last must be YYYY-MM-DD" }, 400);
      const done: any[] = []; let day = first;
      while (day <= last && Date.now() - t0 < 100_000) {
        done.push(await finDay(c, day));
        const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); day = d.toISOString().slice(0, 10);
      }
      const built = done.length ? await rpc("jt_amazon_fin_build", { p: { first, last: done[done.length - 1].day, target: p.check ? "amzdays_api" : "amzdays", file: "SP-API Finances" } }) : 0;
      return json({ ok: true, done, built, next: day <= last ? day : null, last });
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
