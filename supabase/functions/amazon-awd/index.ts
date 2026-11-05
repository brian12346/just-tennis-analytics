// Amazon AWD (Amazon Warehousing and Distribution) inventory for the Just Tennis dashboard.
// POST {action: "awd_inventory"} -> every SKU's AWD quantities now (AWD API 2024-05-09 listInventory, details=SHOW,
//                                   all pages) into jt.awd_inventory and the 'awdinv' doc (jt_awd_inventory_save,
//                                   migration 205). Scheduled hourly at :15 (cron jt-amazon-awd).
//                                   Quantities are product units.
// POST {action: "report_request", type, start?, end?, options?} / {action: "report_get", id, limit?} -> troubleshooting:
//                                   ask Amazon for any report (amazon.com) and read it back.
// POST {action: "fba_ledger", force?} -> FBA Inventory Ledger by month (GET_LEDGER_SUMMARY_VIEW_DATA, country, monthly) into
//                                   jt.fba_ledger_monthly (migration 214). Hourly at :41 (cron jt-fba-ledger): reads a pending
//                                   report when Amazon has it ready, otherwise asks for a new one at most once a day —
//                                   the last 13 months the first time, then last month and this month.
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

// ---------------------------------------------------------------- FBA Inventory Ledger (monthly)
const LEDGER = "GET_LEDGER_SUMMARY_VIEW_DATA";
const firstOfMonth = (d: Date, back = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
function ledgerRows(text: string) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split("\t").map((h) => h.replace(/^"|"$/g, "").trim().toLowerCase());
  const col = (...names: string[]) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const C = { date: col("date"), sku: col("msku", "sku"), fnsku: col("fnsku"), asin: col("asin"), disp: col("disposition"),
    start: col("starting warehouse balance"), transit: col("in transit between warehouses"), receipts: col("receipts"),
    ship: col("customer shipments"), ret: col("customer returns"), vret: col("vendor returns"), xfer: col("warehouse transfer in/out"),
    found: col("found"), lost: col("lost"), dmg: col("damaged"), disposed: col("disposed"), other: col("other events"), unknown: col("unknown events"),
    end: col("ending warehouse balance") };
  if (C.date < 0 || C.sku < 0 || C.end < 0) throw new Error("unexpected ledger columns: " + head.join(", ").slice(0, 300));
  const num = (v: string[], i: number) => i < 0 ? 0 : Math.round(Number(String(v[i] ?? "").replace(/[",]/g, "")) || 0);
  const out: any[] = [];
  for (const l of lines.slice(1)) {
    const v = l.split("\t").map((x) => x.replace(/^"|"$/g, "").trim());
    const dm = (v[C.date] || "").match(/^(\d{1,2})\/(?:\d{1,2}\/)?(\d{4})$/) || (v[C.date] || "").match(/^(\d{4})-(\d{2})/);
    if (!dm) continue;
    const [y, mo] = dm[0].includes("-") ? [dm[1], dm[2]] : [dm[2], dm[1]];
    out.push({ month: `${y}-${String(mo).padStart(2, "0")}-01`, sku: v[C.sku], fnsku: C.fnsku < 0 ? "" : v[C.fnsku], asin: C.asin < 0 ? "" : v[C.asin],
      disposition: C.disp < 0 ? "" : v[C.disp], start: num(v, C.start), receipts: num(v, C.receipts), shipments: num(v, C.ship), returns: num(v, C.ret),
      transfers: num(v, C.xfer), in_transit: num(v, C.transit), end: num(v, C.end),
      adjustments: num(v, C.vret) + num(v, C.found) + num(v, C.lost) + num(v, C.dmg) + num(v, C.disposed) + num(v, C.other) + num(v, C.unknown) });
  }
  return out;
}
async function fbaLedger(c: Creds, p: any, t0: number) {
  const st = (await rpc("jt_fba_ledger_report", { p: { op: "state" } })) || {};
  if (st.pending) {
    const rep = await sp(c, `/reports/2021-06-30/reports/${encodeURIComponent(st.pending)}`);
    if (rep.processingStatus === "DONE" && rep.reportDocumentId) {
      const rows = ledgerRows(await documentText(c, rep.reportDocumentId));
      const months = [...new Set(rows.map((r) => r.month))];
      let saved = 0;
      for (let i = 0; i < rows.length; i += 2000) saved += await rpc("jt_fba_ledger_save", { p: { rows: rows.slice(i, i + 2000), months, first: i === 0 } });
      await rpc("jt_fba_ledger_report", { p: { op: "done", report_id: st.pending, rows: saved, detail: months.sort().join(",") } });
      return { ok: true, report: st.pending, rows: saved, months: months.length, ms: Date.now() - t0 };
    }
    if (["CANCELLED", "FATAL"].includes(rep.processingStatus)) {
      await rpc("jt_fba_ledger_report", { p: { op: rep.processingStatus === "CANCELLED" ? "done" : "failed", report_id: st.pending, rows: 0, detail: rep.processingStatus } });
      return { ok: true, report: st.pending, status: rep.processingStatus };
    }
    return { ok: true, report: st.pending, status: rep.processingStatus, waiting: true };
  }
  if (st.fresh && !p.force) return { ok: true, idle: true };
  const now = new Date(), start = firstOfMonth(now, (st.have || 0) >= 12 ? 1 : 12);
  const end = new Date(now.getTime() - 36 * 3600 * 1000);         // the ledger runs about a day behind
  const r = await spPost(c, "/reports/2021-06-30/reports", { reportType: LEDGER, marketplaceIds: ["ATVPDKIKX0DER"], dataStartTime: start.toISOString(),
    dataEndTime: end.toISOString(), reportOptions: { aggregateByLocation: "COUNTRY", aggregatedByTimePeriod: "MONTHLY" } });
  await rpc("jt_fba_ledger_report", { p: { op: "requested", report_id: r.reportId, start: start.toISOString(), end: end.toISOString() } });
  return { ok: true, requested: r.reportId, start: start.toISOString().slice(0, 10) };
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
    if (p.action === "fba_ledger") return json(await fbaLedger(c, p, t0));
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
