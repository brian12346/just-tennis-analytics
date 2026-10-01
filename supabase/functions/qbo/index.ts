// QuickBooks Online for the Just Tennis dashboard.
// POST {action: "status"}            -> company, accounts, vendor count (checks the connection)
// POST {action: "query", q: "select …"} -> a read-only QuickBooks query
// Callers: a signed-in app user (Authorization: Bearer <user JWT>), or SQL via jt.qbo_call (x-jt-key).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-jt-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BASES: Record<string, string> = { production: "https://quickbooks.api.intuit.com", sandbox: "https://sandbox-quickbooks.api.intuit.com" };
const MINOR = "75";

type Creds = Record<string, string>;
async function creds(): Promise<Creds> {
  const { data, error } = await admin.rpc("jt_qbo_creds");
  if (error) throw new Error("reading credentials: " + error.message);
  return data || {};
}
async function save(p: Record<string, string>) {
  const { error } = await admin.rpc("jt_qbo_save_tokens", { p });
  if (error) throw new Error("saving tokens: " + error.message);
}
async function refresh(c: Creds): Promise<string> {
  const r = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(c.qbo_client_id + ":" + c.qbo_client_secret), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.qbo_refresh_token }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error(`QuickBooks sign-in failed (${r.status}): ${t.error_description || t.error || "no access token"} — the refresh token may need reconnecting in the OAuth Playground`);
  const exp = new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString();
  await save({ access_token: t.access_token, access_expires: exp, refresh_token: t.refresh_token || "" });
  c.qbo_access_token = t.access_token; c.qbo_access_expires = exp; if (t.refresh_token) c.qbo_refresh_token = t.refresh_token;
  return t.access_token;
}
async function token(c: Creds, force = false): Promise<string> {
  if (!force && c.qbo_access_token && c.qbo_access_expires && new Date(c.qbo_access_expires).getTime() - Date.now() > 5 * 60 * 1000) return c.qbo_access_token;
  return refresh(c);
}
// a GET against the company; works out production vs sandbox on the first call
async function api(c: Creds, path: string, tries = 0): Promise<any> {
  const at = await token(c, tries > 0);
  const envs = c.qbo_env ? [c.qbo_env] : ["production", "sandbox"];
  let last: any = null;
  for (const env of envs) {
    const r = await fetch(`${BASES[env]}/v3/company/${c.qbo_realm_id}/${path}${path.includes("?") ? "&" : "?"}minorversion=${MINOR}`, { headers: { Authorization: "Bearer " + at, Accept: "application/json" } });
    const b = await r.json().catch(() => ({}));
    if (r.ok) { if (!c.qbo_env) { await save({ env }); c.qbo_env = env; } return b; }
    last = { status: r.status, env, body: b };
    if (r.status === 401 && tries === 0 && c.qbo_env) { return api(c, path, 1); }
  }
  const f = last?.body?.Fault?.Error?.[0] || last?.body?.fault?.error?.[0];
  throw new Error(`QuickBooks API ${last?.status} (${last?.env}): ${f ? `${f.Message || f.message} — ${f.Detail || f.detail || ""}` : JSON.stringify(last?.body).slice(0, 300)}`);
}
const query = (c: Creds, q: string) => api(c, "query?query=" + encodeURIComponent(q));

async function allowed(req: Request, c: Creds): Promise<boolean> {
  const k = req.headers.get("x-jt-key");
  if (k && c.jt_fn_key && k === c.jt_fn_key) return true;
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
    const c = await creds();
    if (!(await allowed(req, c))) return json({ ok: false, error: "not allowed" }, 403);
    for (const k of ["qbo_client_id", "qbo_client_secret", "qbo_refresh_token", "qbo_realm_id"]) if (!c[k]) return json({ ok: false, error: `${k} is missing from Vault` }, 400);
    const p = await req.json().catch(() => ({}));
    if (p.action === "status") {
      const ci = (await api(c, `companyinfo/${c.qbo_realm_id}`)).CompanyInfo || {};
      const acc = ((await query(c, "select Id, Name, FullyQualifiedName, AccountType, AccountSubType, Active from Account maxresults 1000")).QueryResponse?.Account || [])
        .map((a: any) => ({ id: a.Id, name: a.FullyQualifiedName || a.Name, type: a.AccountType, sub: a.AccountSubType }));
      const vc = (await query(c, "select count(*) from Vendor")).QueryResponse?.totalCount ?? null;
      return json({ ok: true, env: c.qbo_env, company: { name: ci.CompanyName, legal: ci.LegalName, country: ci.Country, fiscal_start: ci.FiscalYearStartMonth }, vendors: vc, accounts: acc });
    }
    if (p.action === "query") {
      const q = String(p.q || "");
      if (!/^\s*select\s/i.test(q)) return json({ ok: false, error: "only select queries" }, 400);
      return json({ ok: true, env: c.qbo_env, result: (await query(c, q)).QueryResponse || {} });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
