// An invoice's PDF from a link → stored on the invoice (jt.invoice_files), so Seller Sage shows it beside the lines like an
// uploaded one (Brian, Oct 28: "pull in the .pdf to the invoice … i like to be able to see the invoice to compare from the
// screen"). The Dropbox task makes a temporary Dropbox download link and calls this through SQL (jt.invoice_file_fetch).
// POST {invoice_id, url, name?} -> {ok, parts, bytes}. Only Dropbox download hosts are fetched.
// Callers: SQL via jt.invoice_file_fetch (x-jt-key), or a signed-in app user. Deployed with verify_jwt off (checks itself).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-jt-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const PART = 66000;   // bytes per stored part — the page reads parts of this size (po.js PART)
const MAX = 15 * 1024 * 1024;

function b64(u8: Uint8Array): string { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return btoa(s); }
const okHost = (h: string) => /(^|\.)dropboxusercontent\.com$/i.test(h) || /(^|\.)dropbox\.com$/i.test(h);

async function allowed(req: Request): Promise<boolean> {
  const k = req.headers.get("x-jt-key");
  if (k) { const { data } = await admin.rpc("jt_qbo_creds"); return !!data?.jt_fn_key && k === data.jt_fn_key; }
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data } = await admin.auth.getUser(jwt);
  if (!data?.user) return false;
  const { data: ok } = await admin.rpc("jt_qbo_allowed", { uid: data.user.id });
  return !!ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!(await allowed(req))) return json({ ok: false, error: "not allowed" }, 403);
    const p = await req.json().catch(() => ({}));
    const inv = Number(p.invoice_id);
    if (!inv) return json({ ok: false, error: "invoice_id is required" }, 400);
    let u: URL;
    try { u = new URL(String(p.url || "")); } catch { return json({ ok: false, error: "url is required" }, 400); }
    if (u.protocol !== "https:" || !okHost(u.hostname)) return json({ ok: false, error: "only Dropbox links" }, 400);
    if (/(^|\.)dropbox\.com$/i.test(u.hostname)) u.searchParams.set("dl", "1");   // a shared link → the file itself
    const r = await fetch(u.toString(), { redirect: "follow" });
    if (!r.ok) return json({ ok: false, error: `download failed (${r.status})` }, 502);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (!bytes.length || bytes.length > MAX) return json({ ok: false, error: `bad size (${bytes.length} bytes)` }, 400);
    const type = /^%PDF/.test(new TextDecoder().decode(bytes.subarray(0, 5))) ? "application/pdf" : (r.headers.get("content-type") || "application/octet-stream").split(";")[0];
    const name = String(p.name || decodeURIComponent(u.pathname.split("/").pop() || "") || `invoice-${inv}.pdf`).slice(0, 200);
    const n = Math.ceil(bytes.length / PART);
    for (let k = 0; k < n; k++) {
      const { error } = await admin.rpc("jt_invoice_file_put_svc", { p: { invoice_id: inv, part: k, parts: n, data: b64(bytes.subarray(k * PART, (k + 1) * PART)), name, type, size: bytes.length } });
      if (error) return json({ ok: false, error: error.message }, 500);
    }
    return json({ ok: true, invoice_id: inv, parts: n, bytes: bytes.length, type });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
