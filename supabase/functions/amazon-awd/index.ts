// Amazon AWD (Amazon Warehousing and Distribution) inventory for the Just Tennis dashboard.
// POST {action: "awd_inventory"} -> every SKU's AWD quantities now (AWD API 2024-05-09 listInventory, details=SHOW,
//                                   all pages) into jt.awd_inventory and the 'awdinv' doc (jt_awd_inventory_save,
//                                   migration 205). Scheduled hourly at :15 (cron jt-amazon-awd).
//                                   Quantities are product units.
// POST {action: "report_request", type, start?, end?, options?} / {action: "report_get", id, limit?} -> troubleshooting:
//                                   ask Amazon for any report (amazon.com) and read it back.
// Callers: a signed-in app user (Authorization: Bearer <user JWT>), or SQL via jt.amazon_awd_call (x-jt-key).
// Uses the same SP-API credentials as the `amazon` function (jt_spapi_creds).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-jt-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const HOST = "https://sellingpartnerapi-na.amazon.com";

type Creds = Record<string, string>;
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
  if (!r.ok || !t.access_token) throw new Error(`Amazon sign-in failed (${r.status}): ${t.error_description || t.error || "no access token"}`);
  access = t.access_token;
  return access;
}
async function sp(c: Creds, path: string, tries = 0): Promise<any> {
  const r = await fetch(HOST + path, { headers: { "x-amz-access-token": await token(c), Accept: "application/json", "User-Agent": "JustTennisDashboard/1.0 (Language=TypeScript)" } });
  if (r.status === 429 && tries < 4) { await new Promise((f) => setTimeout(f, 2000 * (tries + 1))); return sp(c, path, tries + 1); }
  const b = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = (b.errors || [])[0] || {};
    throw new Error(`Amazon API ${r.status} on ${path.split("?")[0]}: ${e.message || JSON.stringify(b).slice(0, 300)}${e.details ? " — " + e.details : ""}`);
  }
  return b;
}

async function spPost(c: Creds, path: string, body: unknown): Promise<any> {
  const r = await fetch(HOST + path, { method: "POST", headers: { "x-amz-access-token": await token(c), "Content-Type": "application/json", Accept: "application/json", "User-Agent": "JustTennisDashboard/1.0 (Language=TypeScript)" }, body: JSON.stringify(body) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) { const e = (b.errors || [])[0] || {}; throw new Error(`Amazon API ${r.status} on ${path}: ${e.message || JSON.stringify(b).slice(0, 300)}${e.details ? " — " + e.details : ""}`); }
  return b;
}
async function documentText(c: Creds, docId: string): Promise<string> {
  const d = await sp(c, `/reports/2021-06-30/documents/${encodeURIComponent(docId)}`);
  const r = await fetch(d.url);
  if (!r.ok) throw new Error(`downloading the report failed (${r.status})`);
  let stream: ReadableStream<Uint8Array> = r.body!;
  if (d.compressionAlgorithm === "GZIP") stream = stream.pipeThrough(new DecompressionStream("gzip"));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return new TextDecoder("windows-1252").decode(buf); }
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
    const c: Creds = (await rpc("jt_spapi_creds")) || {};
    if (!(await caller(req, c))) return json({ ok: false, error: "not allowed" }, 403);
    for (const k of ["spapi_client_id", "spapi_client_secret", "spapi_refresh_token"]) if (!c[k]) return json({ ok: false, error: `${k} is missing from Vault` }, 400);
    const p = await req.json().catch(() => ({}));
    // troubleshooting: ask for any report, or read one back (first `limit` characters of its document)
    if (p.action === "report_request") {
      const body: any = { reportType: String(p.type), marketplaceIds: ["ATVPDKIKX0DER"] };
      if (p.start) body.dataStartTime = String(p.start);
      if (p.end) body.dataEndTime = String(p.end);
      if (p.options) body.reportOptions = p.options;
      return json({ ok: true, result: await spPost(c, "/reports/2021-06-30/reports", body) });
    }
    if (p.action === "report_get") {
      const rep = await sp(c, `/reports/2021-06-30/reports/${encodeURIComponent(String(p.id))}`);
      let text = "";
      if (rep.processingStatus === "DONE" && rep.reportDocumentId) text = await documentText(c, rep.reportDocumentId);
      return json({ ok: true, report: rep, length: text.length, text: text.slice(0, Number(p.limit) || 3000) });
    }
    if (p.action !== "awd_inventory") return json({ ok: false, error: "unknown action" }, 400);

    const rows: any[] = []; let next = "", pages = 0;
    do {
      const q = new URLSearchParams({ details: "SHOW", maxResults: "200" });
      if (next) q.set("nextToken", next);
      const r = await sp(c, "/awd/2024-05-09/inventory?" + q.toString());
      for (const x of r.inventory || []) {
        const d = x.inventoryDetails || {};
        rows.push({ sku: x.sku, onhand: x.totalOnhandQuantity || 0, available: d.availableDistributableQuantity || 0,
          reserved: d.reservedDistributableQuantity || 0, inbound: x.totalInboundQuantity || 0, replenishment: d.replenishmentQuantity || 0 });
      }
      next = r.nextToken || ""; pages++;
      if (next) await new Promise((f) => setTimeout(f, 1100));   // listInventory: about 1 call a second
    } while (next && Date.now() - t0 < 100_000);

    const complete = !next;
    const saved = await rpc("jt_awd_inventory_save", { p: { rows, complete, skus: rows.map((r) => r.sku) } });
    return json({ ok: true, pages, rows: rows.length, saved, complete,
      units: rows.reduce((s, r) => s + r.onhand + r.inbound + r.replenishment, 0) });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message });
  }
});
