// Shipping (Nov 2, Brian: "a smoother shipping option where we buy shopify shipping but have a cleaner ui on top of it").
// Buys Shopify Shipping labels with the Admin API's shippingLabelPurchase mutation (2026-07+) for Just Tennis and
// Ace n Rally orders, one at a time from the pack screen (Orders › Shipping). Shopify's API can't quote rates first or
// void a label: a label is bought for the carrier + service picked on the screen (no FedEx), and voids are done in Shopify.
//
// POST {action, store: "jt" | "anr", ...}
//   queue                                   -> {orders: [...]}   open orders that need shipping
//   buy  {fulfillment_order_id, order_id, order_name, carrier, service, service_name, box: {name, l, w, h, weight_oz},
//         weight_oz, notify}                -> {ok, status, labels: [{tracking, company, url, docs: [{type, format, url}]}], log_id}
//   result {log_id}                         -> the same, for a purchase that was still processing
//   printq {days?}                          -> {labels: [...]}  Shopify Shipping labels bought in Shopify (or here) in the
//                                              last few days, with their PDF links — "buy in Shopify, print from Seller Sage"
//   pdf {url}                               -> {b64}  a label PDF (Shopify's S3 links can't be read from the page itself)
// Callers: signed-in app users (Supabase JWT). Credentials come from
// Vault through public.jt_ship_creds() (service role only): shopify_<store>_shop, _client_id, _client_secret.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const VERSION = "2026-07";
const STORES: Record<string, string> = { jt: "Just Tennis", anr: "Ace n Rally" };

async function user(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await admin.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: ok } = await admin.rpc("jt_qbo_allowed", { uid: data.user.id });
  return ok ? (data.user.email || "app user") : null;
}

const tokens: Record<string, { t: string; exp: number; shop: string }> = {};
async function shopToken(store: string): Promise<{ t: string; shop: string }> {
  const c = tokens[store]; if (c && Date.now() < c.exp - 300000) return c;
  const { data, error } = await admin.rpc("jt_ship_creds");
  if (error) throw new Error("credentials: " + error.message);
  const shop = String(data?.[`shopify_${store}_shop`] || "").replace(/^https?:\/\//, "").replace(/\.myshopify\.com.*$/, "").replace(/\/$/, "");
  const id = data?.[`shopify_${store}_client_id`], secret = data?.[`shopify_${store}_client_secret`];
  if (!shop || !id || !secret) throw new Error(`${STORES[store]} isn't connected for shipping yet — add shopify_${store}_shop, shopify_${store}_client_id and shopify_${store}_client_secret in Supabase Vault.`);
  const r = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }) });
  if (!r.ok) throw new Error(`Shopify sign-in failed for ${STORES[store]} (${r.status})`);
  const b = await r.json();
  tokens[store] = { t: b.access_token, exp: Date.now() + Number(b.expires_in || 86399) * 1000, shop };
  return tokens[store];
}
async function gql(store: string, query: string, variables: Record<string, unknown> = {}) {
  const { t, shop } = await shopToken(store);
  const r = await fetch(`https://${shop}.myshopify.com/admin/api/${VERSION}/graphql.json`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t }, body: JSON.stringify({ query, variables }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.errors) throw new Error((b.errors && (b.errors[0]?.message || JSON.stringify(b.errors))) || `Shopify error (${r.status})`);
  return b.data;
}

const QUEUE_Q = `query Q($q: String!, $after: String) { orders(first: 50, after: $after, sortKey: CREATED_AT, query: $q) {
  pageInfo { hasNextPage endCursor }
  nodes { id name createdAt note tags totalWeight customer { displayName } displayFinancialStatus
    shippingAddress { name company address1 address2 city provinceCode zip countryCodeV2 phone }
    shippingLines(first: 2) { nodes { title } }
    fulfillmentOrders(first: 5) { nodes { id status requestStatus assignedLocation { name } deliveryMethod { methodType presentedName }
      lineItems(first: 50) { nodes { id remainingQuantity sku productTitle variantTitle weight { value unit } image { url(transform: {maxWidth: 160}) } } } } } } } }`;

async function queue(store: string) {
  const out: unknown[] = []; let after: string | null = null;
  for (let i = 0; i < 6; i++) {
    const d = await gql(store, QUEUE_Q, { q: "fulfillment_status:unshipped status:open delivery_method:shipping", after });
    for (const o of d.orders.nodes) {
      const fos = o.fulfillmentOrders.nodes.filter((f: any) => ["OPEN", "IN_PROGRESS"].includes(f.status) && f.deliveryMethod?.methodType === "SHIPPING"
        && f.lineItems.nodes.some((l: any) => l.remainingQuantity > 0));
      if (!fos.length || !o.shippingAddress) continue;
      out.push({ id: o.id, name: o.name, created: o.createdAt, note: o.note || "", tags: o.tags, paid: o.displayFinancialStatus, customer: o.customer?.displayName || o.shippingAddress?.name || "",
        address: o.shippingAddress, method: o.shippingLines.nodes[0]?.title || fos[0].deliveryMethod?.presentedName || "",
        weight_g: Number(o.totalWeight || 0),
        fos: fos.map((f: any) => ({ id: f.id, status: f.status, location: f.assignedLocation?.name || "",
          lines: f.lineItems.nodes.filter((l: any) => l.remainingQuantity > 0).map((l: any) => ({ id: l.id, qty: l.remainingQuantity, sku: l.sku || "", title: l.productTitle, variant: l.variantTitle || "",
            img: l.image?.url || "", weight: l.weight })) })) });
    }
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  return out;
}

// labels bought in the last few days: fulfillments with a Shopify Shipping label
const PRINTQ_Q = `query P($q: String!, $after: String) { orders(first: 50, after: $after, sortKey: UPDATED_AT, reverse: true, query: $q) {
  pageInfo { hasNextPage endCursor }
  nodes { id name customer { displayName } shippingAddress { name city provinceCode countryCodeV2 }
    fulfillments(first: 10) { id createdAt trackingInfo { company number }
      fulfillmentLineItems(first: 30) { nodes { quantity lineItem { sku name image { url(transform: {maxWidth: 120}) } } } }
      shippingLabel { id printed shippingDocuments { documentType format url } } } } } }`;
async function printq(store: string, days: number) {
  const since = new Date(Date.now() - days * 864e5), out: unknown[] = []; let after: string | null = null;
  for (let i = 0; i < 6; i++) {
    const d = await gql(store, PRINTQ_Q, { q: `updated_at:>'${since.toISOString().slice(0, 19)}Z' fulfillment_status:shipped`, after });
    for (const o of d.orders.nodes) for (const f of o.fulfillments || []) {
      const l = f.shippingLabel; if (!l || Date.parse(f.createdAt) < since.getTime()) continue;
      const doc = (l.shippingDocuments || []).find((x: any) => x.url && /LABEL/i.test(x.documentType || "")) || (l.shippingDocuments || []).find((x: any) => x.url);
      out.push({ label_id: l.id, order_id: o.id, order: o.name, customer: o.customer?.displayName || o.shippingAddress?.name || "",
        to: [o.shippingAddress?.city, o.shippingAddress?.provinceCode, o.shippingAddress?.countryCodeV2 !== "US" ? o.shippingAddress?.countryCodeV2 : ""].filter(Boolean).join(", "),
        at: f.createdAt, company: f.trackingInfo?.[0]?.company || "", tracking: f.trackingInfo?.[0]?.number || "", shopify_printed: !!l.printed,
        url: doc?.url || "", format: doc?.format || "",
        items: (f.fulfillmentLineItems?.nodes || []).map((x: any) => ({ qty: x.quantity, sku: x.lineItem?.sku || "", title: x.lineItem?.name || "", img: x.lineItem?.image?.url || "" })) });
    }
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  return out.sort((a: any, b: any) => String(b.at).localeCompare(String(a.at)));
}
const okPdfHost = (h: string) => /^shopify-shipify\.s3[.-][a-z0-9-]*\.?amazonaws\.com$/i.test(h) || /(^|\.)amazonaws\.com$/i.test(h) && /shopify/i.test(h) || /(^|\.)shopify\.com$/i.test(h) || /(^|\.)shopifycdn\.com$/i.test(h);
async function pdf(url: string) {
  let u: URL; try { u = new URL(url); } catch { throw new Error("bad label link"); }
  if (u.protocol !== "https:" || !okPdfHost(u.hostname)) throw new Error("only Shopify label links");
  const r = await fetch(u.toString()); if (!r.ok) throw new Error(r.status === 403 ? "That label link has expired (Shopify keeps them 7 days) — reprint it from Shopify." : `label download failed (${r.status})`);
  const b = new Uint8Array(await r.arrayBuffer()); if (b.length > 8 * 1024 * 1024) throw new Error("label too big");
  let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
}

const BUY_M = `mutation B($i: ShippingLabelPurchaseInput!) { shippingLabelPurchase(shippingLabelPurchase: $i) { shippingLabelPurchaseResult { id status } userErrors { field code message } } }`;
const RESULT_Q = `query R($id: ID!) { node(id: $id) { ... on ShippingLabelPurchaseResult { id status done errors { code message }
  shippingLabels { id trackingInfo { number company url } shippingDocuments { documentType format url } } } } }`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const labelsOf = (n: any) => (n?.shippingLabels || []).map((l: any) => ({ id: l.id, tracking: l.trackingInfo?.number || "", company: l.trackingInfo?.company || "",
  track_url: l.trackingInfo?.url || "", docs: (l.shippingDocuments || []).map((d: any) => ({ type: d.documentType, format: d.format, url: d.url })) }));

async function poll(store: string, resultId: string, logId: number, seconds = 40) {
  const t0 = Date.now(); let n: any = null;
  while (Date.now() - t0 < seconds * 1000) {
    const d = await gql(store, RESULT_Q, { id: resultId }); n = d.node;
    if (n && n.status !== "PENDING_PURCHASE") break;
    await sleep(2000);
  }
  const status = n?.status || "PENDING_PURCHASE", labels = labelsOf(n), errs = (n?.errors || []).map((e: any) => e.message).join("; ");
  const l0 = labels[0] || {};
  await admin.rpc("jt_ship_log_save", { p: { id: logId, status, tracking: l0.tracking || "", company: l0.company || "", label_url: (l0.docs || []).find((x: any) => x.url)?.url || "",
    labels, error: errs } });
  return { ok: status === "PURCHASED", status, labels, error: errs, log_id: logId };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const by = await user(req); if (!by) return json({ ok: false, error: "not allowed" }, 403);
    const p = await req.json().catch(() => ({}));
    const store = String(p.store || "jt"); if (!STORES[store]) return json({ ok: false, error: "unknown store" }, 400);
    if (p.action === "queue") return json({ ok: true, store, orders: await queue(store) });
    if (p.action === "printq") return json({ ok: true, store, labels: await printq(store, Math.min(7, Math.max(1, Number(p.days) || 3))) });
    if (p.action === "pdf") return json({ ok: true, b64: await pdf(String(p.url || "")) });
    if (p.action === "result") {
      const { data: row } = await admin.rpc("jt_ship_log_get", { p: { id: Number(p.log_id) } });
      if (!row?.result_id) return json({ ok: false, error: "not found" }, 404);
      return json(await poll(row.store, row.result_id, Number(p.log_id), 20));
    }
    if (p.action === "buy") {
      const box = p.box || {}, w = Number(p.weight_oz);
      if (!p.fulfillment_order_id || !(w > 0)) return json({ ok: false, error: "Weigh the package first." }, 400);
      if (!(Number(box.l) > 0 && Number(box.w) > 0 && Number(box.h) > 0)) return json({ ok: false, error: "Pick a box (length, width and height)." }, 400);
      const input: Record<string, unknown> = {
        fulfillmentOrderId: p.fulfillment_order_id,
        shippingDatetime: new Date(Date.now() + 10 * 60000).toISOString(),
        totalWeight: { value: w, unit: "OUNCES" },
        packageInfo: { customPackage: { type: "BOX", weight: { value: Math.max(0, Number(box.weight_oz) || 0), unit: "OUNCES" },
          dimensions: { length: Number(box.l), width: Number(box.w), height: Number(box.h), unit: "INCHES" } } },
        notifyCustomer: p.notify !== false,
      };
      if (!p.again) {          // never two labels for one order by accident (a double click, a retry)
        const { data: last } = await admin.rpc("jt_ship_last", { p: { fulfillment_order_id: p.fulfillment_order_id } });
        if (last && (last.status === "PURCHASED" || Date.now() - Date.parse(last.created_at) < 10 * 60000))
          return json({ ok: false, status: "ALREADY", error: last.status === "PURCHASED" ? `This order already has a label (${last.company || last.service_name} ${last.tracking}).` : "A label for this order is still being bought.", last });
      }
      if (p.carrier && p.service) input.preferredRateSelection = { carrierCode: String(p.carrier), serviceCode: String(p.service) };
      const { data: logId, error: le } = await admin.rpc("jt_ship_log_save", { p: { store, order_id: p.order_id || "", order_name: p.order_name || "", fulfillment_order_id: p.fulfillment_order_id,
        carrier: p.carrier || "", service: p.service || "", service_name: p.service_name || "", box: box.name || "", box_dims: `${box.l}x${box.w}x${box.h}`, weight_oz: w, status: "STARTING", by } });
      if (le) throw new Error("log: " + le.message);
      const d = await gql(store, BUY_M, { i: input });
      const r = d.shippingLabelPurchase, ue = (r.userErrors || []).map((e: any) => e.message + (e.code ? ` (${e.code})` : "")).join("; ");
      if (ue || !r.shippingLabelPurchaseResult) {
        await admin.rpc("jt_ship_log_save", { p: { id: logId, status: "REJECTED", error: ue || "no result" } });
        return json({ ok: false, status: "REJECTED", error: ue || "Shopify didn't start the purchase.", log_id: logId });
      }
      await admin.rpc("jt_ship_log_save", { p: { id: logId, status: "PENDING_PURCHASE", result_id: r.shippingLabelPurchaseResult.id } });
      return json(await poll(store, r.shippingLabelPurchaseResult.id, logId));
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
