// Price match, Amazon side (migration 152; Brian, Oct 17). POST {action: "buybox"} -> UPC -> ASIN for Just Tennis
// products of the enabled brands (Catalog Items 2022-04-01, cached a month, jt.pm_upc_asin) and the Buy Box price per
// ASIN (Product Pricing getItemOffersBatch, daily, jt.pm_amazon_prices). Works through what's due until its time limit;
// scheduled every 3 minutes early in the morning (jt.pm_amazon_call), before the 05:30 PT "price-match" sync job.
// Price = the Buy Box landed price (New); when Just Tennis holds the Buy Box, or there is none, the lowest other new offer.
// Same credentials and callers as the "amazon" function: SQL with x-jt-key, or a signed-in app user.
// Our in-stock ASINs (FBA and FBM, jt.v_pm_amazon_stock) are priced first; our own offer and the lowest other seller's
// are saved too, for Sales › Price match › Amazon prices (migration 155), and whether Amazon.com itself has an offer (156).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-jt-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const HOST = "https://sellingpartnerapi-na.amazon.com";

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

const SELLER_ID = "AJPAM6HXYXK3Y";   // Just Tennis's seller (merchant) id; not a secret
const wait = (ms: number) => new Promise((f) => setTimeout(f, ms));

const US_MKT = "ATVPDKIKX0DER";
const AMAZON_RETAIL = "ATVPDKIKX0DER";   // Amazon.com's own seller id on amazon.com (same as the marketplace id)
async function buybox(c: Creds, deadline: number) {
  const seller = c.spapi_seller_id || SELLER_ID;
  const todo = await rpc("jt_pm_amazon_todo", { p: { upcs: 400, asins: 300 } });
  const res: any = { upcs: 0, found: 0, asins: 0, priced: 0, errors: 0, left_upcs: todo.left_upcs, left_asins: todo.left_asins, error: "" };
  const strip = (x: string) => String(x || "").replace(/^0+/, "");
  // UPC -> ASIN, 20 identifiers a call (by length: 12 UPC, 13 EAN, 14 GTIN), about 2 calls a second
  const groups: Record<string, string[]> = { UPC: [], EAN: [], GTIN: [] };
  for (const u of todo.upcs || []) (u.length === 12 ? groups.UPC : u.length === 13 ? groups.EAN : groups.GTIN).push(u);
  try {
    for (const [type, list] of Object.entries(groups)) {
      for (let i = 0; i < list.length && Date.now() < deadline - 30_000; i += 20) {
        const chunk = list.slice(i, i + 20);
        const q = new URLSearchParams({ identifiersType: type, identifiers: chunk.join(","), marketplaceIds: US_MKT, includedData: "identifiers,summaries", pageSize: "20" });
        const r = await sp(c, "GET", "/catalog/2022-04-01/items?" + q.toString());
        const hit: Record<string, { asin: string; title: string }> = {};
        for (const it of r.items || []) {
          const title = ((it.summaries || [])[0] || {}).itemName || "";
          for (const set of it.identifiers || []) for (const id of set.identifiers || []) {
            const u = chunk.find((x) => strip(x) === strip(id.identifier));
            if (u && !hit[u]) hit[u] = { asin: it.asin, title };
          }
        }
        await rpc("jt_pm_amazon_save", { p: { upcs: chunk.map((u) => ({ upc: u, asin: hit[u]?.asin || "", title: hit[u]?.title || "" })) } });
        res.upcs += chunk.length; res.found += Object.keys(hit).length;
        await wait(600);
      }
    }
    // ASIN -> Buy Box (New), 20 a batch; Amazon allows about one batch every 10 seconds
    const asins: string[] = todo.asins || [];
    for (let i = 0; i < asins.length && Date.now() < deadline - 12_000; i += 20) {
      const chunk = asins.slice(i, i + 20);
      const body = { requests: chunk.map((a) => ({ uri: `/products/pricing/v0/items/${a}/offers`, method: "GET", MarketplaceId: US_MKT, ItemCondition: "New", CustomerType: "Consumer" })) };
      const r = await sp(c, "POST", "/batches/products/pricing/v0/itemOffers", body);
      const rows: any[] = [];
      (r.responses || []).forEach((resp: any, k: number) => {
        const pl = resp.body?.payload, asin = pl?.ASIN || chunk[k];
        if (!pl || (resp.status?.statusCode && resp.status.statusCode >= 400)) {
          rows.push({ asin, price: null, error: (resp.body?.errors || [])[0]?.message || `status ${resp.status?.statusCode || "?"}` }); res.errors++; return;
        }
        let bb: number | null = null;
        for (const b of pl.Summary?.BuyBoxPrices || []) if (String(b.condition || "").toLowerCase() === "new") bb = Number(b.LandedPrice?.Amount);
        const offers: any[] = pl.Offers || [];
        const own = offers.some((o) => o.SellerId === seller && o.IsBuyBoxWinner);
        let price = bb;
        if (own || price == null) {
          const others = offers.filter((o) => o.SellerId !== seller && String(o.SubCondition || "").toLowerCase() === "new")
            .map((o) => Number(o.ListingPrice?.Amount || 0) + Number(o.Shipping?.Amount || 0)).filter((x) => x > 0);
          price = others.length ? Math.min(...others) : null;
        }
        const fba = offers.some((o) => o.IsBuyBoxWinner && o.IsFulfilledByAmazon && o.SellerId !== seller);
        const landed = (o: any) => Number(o.ListingPrice?.Amount || 0) + Number(o.Shipping?.Amount || 0);
        const mine = offers.find((o) => o.SellerId === seller);
        const amz = offers.find((o) => o.SellerId === AMAZON_RETAIL);   // Amazon.com itself selling on the listing
        const others = offers.filter((o) => o.SellerId !== seller && String(o.SubCondition || "").toLowerCase() === "new").map(landed).filter((x) => x > 0);
        const r2 = (x: number | null) => x == null ? null : Math.round(x * 100) / 100;
        rows.push({ asin, price: r2(price), buybox_price: bb, own_buybox: own, amazon_fulfilled: fba,
                    offers: pl.Summary?.TotalOfferCount ?? offers.length, error: "",
                    own_price: mine ? r2(landed(mine)) : null, lowest_other: others.length ? r2(Math.min(...others)) : null,
                    amazon_retail: !!amz, amazon_retail_price: amz ? r2(landed(amz)) : null, amazon_retail_buybox: !!(amz && amz.IsBuyBoxWinner) });
        if (price != null) res.priced++;
      });
      await rpc("jt_pm_amazon_save", { p: { prices: rows } });
      res.asins += chunk.length;
      if (i + 20 < asins.length) await wait(10_500);
    }
  } catch (e) { res.error = (e as Error).message; }
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
    if (p.action === "buybox") return json({ ok: true, ...(await buybox(c, t0 + 110_000)) });
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message });
  }
});
