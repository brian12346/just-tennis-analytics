// Storefront page views (migration 166; Brian, Oct 23: "learn the URLs / who it is that scrapes our website").
// A Shopify custom pixel (Settings › Customer events) posts {store, path, referrer, ua} on every page_viewed; this logs
// it in jt.site_visits with the caller's IP and the IP's reverse DNS name (the network: a cloud host, a monitoring
// firm, a home ISP). Public (no sign-in) — it only writes, at most 120 rows a minute per IP (jt_site_visit_save).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BOT = /bot|crawl|spider|slurp|headless|python|curl|wget|scrapy|httpclient|java\/|go-http|phantom|selenium|puppeteer|playwright|monitor|pricespider|prisync|trackstreet|wiser|feedvisor/i;

const names = new Map<string, string>();      // IP -> reverse DNS, kept while this instance lives
async function reverse(ip: string): Promise<string> {
  if (!ip) return "";
  if (names.has(ip)) return names.get(ip)!;
  let host = "";
  try {
    let q = "";
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) q = ip.split(".").reverse().join(".") + ".in-addr.arpa";
    if (q) {
      const r = await Promise.race([Deno.resolveDns(q, "PTR"), new Promise<string[]>((f) => setTimeout(() => f([]), 1500))]);
      host = (r[0] || "").replace(/\.$/, "");
    }
  } catch (_) { host = ""; }
  if (names.size > 5000) names.clear();
  names.set(ip, host);
  return host;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("", { status: 405, headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const ip = (req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0] || "").trim();
    const ua = String(b.ua || req.headers.get("user-agent") || "").slice(0, 400);
    let path = String(b.path || "");
    try { if (/^https?:\/\//.test(path)) { const u = new URL(path); path = u.pathname + u.search; } } catch (_) { /* keep it */ }
    const host = await reverse(ip);
    await admin.rpc("jt_site_visit_save", { p: { store: String(b.store || "justtennis").slice(0, 30), ip, host, ua, bot: BOT.test(ua) || !!b.webdriver,
      path: path.slice(0, 500), referrer: String(b.referrer || "").slice(0, 500) } });
  } catch (_) { /* never fail the shopper's page */ }
  return new Response(null, { status: 204, headers: CORS });
});
