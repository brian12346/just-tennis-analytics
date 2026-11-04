// Nightly reorder export for Brit's FBA Reorder Planner (Excel for Mac, Power Query reads these CSVs).
// POST {action: "export", force?} -> writes to Dropbox, Just Tennis Inc / Operations / Amazon Operations / FBA Ordering /
//   Seller Sage Data:
//     FBA Inventory Report.csv      Amazon GET_FBA_INVENTORY_PLANNING_DATA as Amazon sends it (tab -> comma)
//     Business Report 365-Day.csv   jt_reorder_export_data().business (from Amazon orders; traffic columns blank)
//     Inventory AWD.csv             jt_reorder_export_data().awd (live AWD + FBA)
//     Last updated.txt              when and from what
//   Once a day: does nothing when today's (Pacific) export is already written, unless force. If Amazon hasn't
//   finished the report within ~90 s, the report id is kept (jt_reorder_export_state) and the next run picks it up.
//   Scheduled every 15 min 12:00-13:45 UTC (cron jt-reorder-export, migration 207).
// POST {action: "status"} -> the saved state.
// Callers: a signed-in app user, or SQL via jt.reorder_export_call (x-jt-key).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-jt-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const HOST = "https://sellingpartnerapi-na.amazon.com";
// files go in a subfolder of FBA Ordering (the "Just Tennis Inc" team folder)
const FOLDER = "/Just Tennis Inc/Operations/Amazon Operations/FBA Ordering/Seller Sage Data";
// team space root (Just Tennis), so team folders resolve by their display path
const PATH_ROOT = JSON.stringify({ ".tag": "root", root: "14924316323" });
const PLANNING = "GET_FBA_INVENTORY_PLANNING_DATA";

const BUSINESS_HEADERS = ["(Parent) ASIN", "(Child) ASIN", "Title", "Sessions - Total", "Sessions - Total - B2B", "Session Percentage - Total",
  "Session Percentage - Total - B2B", "Page Views - Total", "Page Views - Total - B2B", "Page Views Percentage - Total",
  "Page Views Percentage - Total - B2B", "Featured Offer (Buy Box) Percentage", "Featured Offer (Buy Box) Percentage - B2B",
  "Units Ordered", "Units Ordered - B2B", "Unit Session Percentage", "Unit Session Percentage - B2B", "Ordered Product Sales",
  "Ordered Product Sales - B2B", "Total Order Items", "Total Order Items - B2B"];
const AWD_HEADERS = ["Product Name", "SKU", "FNSKU", "ASIN", "Inbound to AWD (units)", "Inbound to AWD (cases)", "Available in AWD (units)",
  "Available in AWD (cases)", "Available Units in AWD (US)", "Available Cartons in AWD (US)", "Reserved in AWD (units)", "Reserved in AWD (cases)",
  "Outbound Order (units)", "Outbound Order (cases)", "Researching (units)", "Researching (cases)", "Outbound to FBA (units)",
  "Available in FBA (units)", "Available in FBA (days)", "Reserved in FBA (units)", "Customer Order (units)", "FC Processing (units)",
  "FC Transfer (units)", "Days of Supply (days)", "Auto Replenishment Ratio (percent)"];

type Creds = Record<string, string>;
async function rpc(fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}
const wait = (ms: number) => new Promise((f) => setTimeout(f, ms));

// ---- Amazon
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
async function sp(c: Creds, method: string, path: string, body?: unknown, tries = 0): Promise<any> {
  const r = await fetch(HOST + path, { method, headers: { "x-amz-access-token": await token(c), "Content-Type": "application/json", Accept: "application/json", "User-Agent": "JustTennisDashboard/1.0 (Language=TypeScript)" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 429 && tries < 4) { await wait(2000 * (tries + 1)); return sp(c, method, path, body, tries + 1); }
  const b = await r.json().catch(() => ({}));
  if (!r.ok) { const e = (b.errors || [])[0] || {}; throw new Error(`Amazon API ${r.status} on ${path.split("?")[0]}: ${e.message || JSON.stringify(b).slice(0, 300)}`); }
  return b;
}
async function documentText(c: Creds, docId: string): Promise<string> {
  const d = await sp(c, "GET", `/reports/2021-06-30/documents/${encodeURIComponent(docId)}`);
  const r = await fetch(d.url);
  if (!r.ok) throw new Error(`downloading the report failed (${r.status})`);
  let stream: ReadableStream<Uint8Array> = r.body!;
  if (d.compressionAlgorithm === "GZIP") stream = stream.pipeThrough(new DecompressionStream("gzip"));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return new TextDecoder("windows-1252").decode(buf); }
}

// ---- CSV
const cell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (headers: string[], rows: unknown[][]) => "﻿" + [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
const tsvToCsv = (text: string) => "﻿" + text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l !== "").map((l) => l.split("\t").map(cell).join(",")).join("\r\n") + "\r\n";

// ---- Dropbox (PKCE refresh token, no app secret)
async function dropboxToken(d: Creds): Promise<string> {
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: d.dropbox_refresh_token, client_id: d.dropbox_app_key }) });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error(`Dropbox sign-in failed (${r.status}): ${t.error_description || t.error || "no access token"}`);
  return t.access_token;
}
async function upload(tok: string, name: string, text: string) {
  const arg = JSON.stringify({ path: `${FOLDER}/${name}`, mode: "overwrite", autorename: false, mute: true }).replace(/[\u007f-￿]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
  const r = await fetch("https://content.dropboxapi.com/2/files/upload", { method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Dropbox-API-Arg": arg, "Dropbox-API-Path-Root": PATH_ROOT, "Content-Type": "application/octet-stream" }, body: new TextEncoder().encode(text) });
  if (!r.ok) throw new Error(`Dropbox upload of ${name} failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  const b = await r.json();
  return { name, bytes: b.size, path: b.path_display || "" };
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
    const by = await caller(req, c);
    if (!by) return json({ ok: false, error: "not allowed" }, 403);
    const p = await req.json().catch(() => ({}));
    if (p.action === "status") return json({ ok: true, state: await rpc("jt_reorder_export_state", { p: null }) });
    if (p.action !== "export") return json({ ok: false, error: "unknown action" }, 400);

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
    const st: any = (await rpc("jt_reorder_export_state", { p: null })) || {};
    if (!p.force && st.date === today && st.written_at) return json({ ok: true, skipped: "already written today", state: st });

    // the planning report: today's pending one, or a new request
    let id: string = st.pending_date === today && st.pending_report ? st.pending_report : "";
    if (!id) {
      id = (await sp(c, "POST", "/reports/2021-06-30/reports", { reportType: PLANNING, marketplaceIds: ["ATVPDKIKX0DER"] })).reportId;
      await rpc("jt_reorder_export_state", { p: { pending_report: id, pending_date: today, error: null } });
    }
    let rep: any = {};
    while (Date.now() - t0 < 95_000) {
      rep = await sp(c, "GET", `/reports/2021-06-30/reports/${encodeURIComponent(id)}`);
      if (rep.processingStatus === "DONE" || rep.processingStatus === "CANCELLED" || rep.processingStatus === "FATAL") break;
      await wait(10_000);
    }
    if (rep.processingStatus === "CANCELLED" || rep.processingStatus === "FATAL") {
      await rpc("jt_reorder_export_state", { p: { pending_report: null, error: `Amazon report ${rep.processingStatus}` } });
      return json({ ok: false, error: `Amazon report ${rep.processingStatus}; the next run asks again` });
    }
    if (rep.processingStatus !== "DONE") return json({ ok: true, waiting: id });

    const planning = tsvToCsv(await documentText(c, rep.reportDocumentId));
    const data: any = await rpc("jt_reorder_export_data");
    const dbx = await dropboxToken((await rpc("jt_dropbox_creds")) || {});
    const now = new Date();
    const stamp = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" }).format(now);
    const files = [
      await upload(dbx, "FBA Inventory Report.csv", planning),
      await upload(dbx, "Business Report 365-Day.csv", csv(BUSINESS_HEADERS, data.business || [])),
      await upload(dbx, "Inventory AWD.csv", csv(AWD_HEADERS, data.awd || [])),
    ];
    files.push(await upload(dbx, "Last updated.txt", [
      `Written by Seller Sage: ${stamp} (Pacific)`,
      `FBA Inventory Report.csv: Amazon FBA inventory planning report, created ${rep.createdTime || ""}`,
      `Business Report 365-Day.csv: Seller Sage Amazon orders (amazon.com, last 365 days, cancelled left out) through ${data.orders_through || ""}. Sessions, page views and Buy Box columns are blank.`,
      `Inventory AWD.csv: Amazon AWD inventory, pulled ${data.awd_synced_at || ""}`,
      ""].join("\r\n")));
    const saved = await rpc("jt_reorder_export_state", { p: { date: today, written_at: now.toISOString(), report_id: id, pending_report: null, error: null, by,
      files: files.map((f) => ({ name: f.name, bytes: f.bytes })), rows: { business: (data.business || []).length, awd: (data.awd || []).length } } });
    return json({ ok: true, files, state: saved });
  } catch (e) {
    try { await rpc("jt_reorder_export_state", { p: { error: String((e as Error).message).slice(0, 500), error_at: new Date().toISOString() } }); } catch { /* ignore */ }
    return json({ ok: false, error: (e as Error).message });
  }
});
