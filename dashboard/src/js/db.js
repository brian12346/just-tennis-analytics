(() => {
  // Shared Supabase access for every tab: runs SQL through the viewer's Supabase connector (execute_sql).
  // Reads come back as JSON; large reads are split into parts so each response stays small.
  // On the web version (js/web.js) the same queries go to Supabase's jt_sql function instead.
  const PROJECT = "ppmzrlqvrhzfxobvnlon";
  const WEB = window.JTWeb || null;
  let mcpP = null;
  const getMcp = () => mcpP || (mcpP = (window.claude && window.claude.use ? window.claude.use("mcp") : Promise.resolve(null)).catch(() => null));

  const q = (v) => v == null ? "null" : "'" + String(v).replace(/'/g, "''") + "'";      // SQL string literal
  const day = (d) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) throw new Error("bad date " + d); return "'" + d + "'::date"; };
  const int = (n) => { const s = String(n); if (!/^-?\d+$/.test(s)) throw new Error("bad id " + n); return s; };

  // The connector's reply can arrive as an object, as JSON text, or as JSON text inside a string, depending on
  // the viewer. Peel those layers off until the rows between the <untrusted-data-…> markers parse.
  function texts(res) {
    const out = [], seen = new Set();
    const add = (v, depth) => {
      if (v == null || depth > 3) return;
      if (typeof v === "object") {
        if (v.error) out.push({ error: v.error.message || String(v.error) });
        if (typeof v.result === "string") add(v.result, depth + 1);
        if (Array.isArray(v.content)) v.content.forEach(b => b && b.type === "text" && add(b.text, depth + 1));
        return;
      }
      const t = String(v); if (seen.has(t)) return; seen.add(t); out.push(t);
      const trimmed = t.trim();
      if (trimmed[0] === "{" || trimmed[0] === "\"") { try { add(JSON.parse(trimmed), depth + 1); } catch (_) {} }
    };
    add(res && res.payload, 0); add(res && { content: res.content }, 0);
    return out;
  }
  function unwrap(res) {
    const all = texts(res);
    let sawBlock = false, longest = 0;
    for (const t of all) {
      if (typeof t !== "string") continue;
      // the reply's intro sentence also names the marker, so take the block that closes with a matching tag
      // and contains no other opening marker
      const m = /<untrusted-data-([\w-]+)>((?:(?!<untrusted-data-)[\s\S])*?)<\/untrusted-data-\1>/.exec(t);
      if (!m) continue;
      sawBlock = true; longest = Math.max(longest, m[2].length);
      const body = m[2].trim();
      try { return JSON.parse(body); } catch (_) {}
      try { return JSON.parse(JSON.parse('"' + body + '"')); } catch (_) {}   // still escaped one level
    }
    const err = all.find(t => t && t.error);
    if (err) throw { code: "tool_error", message: err.error };
    const txt = all.filter(t => typeof t === "string").join(" ");
    if (!sawBlock && /error/i.test(txt)) throw { code: "tool_error", message: (txt.match(/ERROR:[^"\\]*/) || [txt])[0].slice(0, 300) };
    // Only a long reply can have been cut off; anything else is a format we didn't expect.
    if (sawBlock && longest > 100000) throw { code: "too_big", message: "The reply was cut off." };
    console.warn("[JT] unexpected database reply", JSON.stringify(res && (res.payload ?? res.content)).slice(0, 500));
    throw { code: "tool_error", message: "Couldn't read the database's reply." };
  }


  // At most 2 calls in flight. The very first call runs alone, so the "allow Supabase" prompt
  // is answered before anything else is sent (calls made while it is open get refused).
  let active = 0, gate = null; const waiting = [];
  let freshUntil = 0;      // right after a catalog change every read skips the caches (see catalogChanged)
  const LIMIT = WEB ? 4 : 2;                     // the Claude connector throttles bursts; direct web calls don't
  // Saves go to the front of the line: in Claude, page loads queue many reads, and a save shouldn't wait behind them.
  const acquire = (first) => new Promise(r => { if (active < LIMIT) { active++; r(); } else if (first) waiting.unshift(r); else waiting.push(r); });
  const isWrite = (sql) => /^\s*(insert|update|delete)\b/i.test(sql) || /^\s*select\s+(public\.)?jt[._]\w+\(/i.test(sql);
  const release = () => { const n = waiting.shift(); if (n) n(); else active--; };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function once(mcp, sql, refresh) {
    // Data syncs hourly, so a result stays good for 30 minutes (Refresh bypasses this).
    const opts = { cache: { staleTime: 1800000, gcTime: 21600000, refresh: !!refresh } };
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await mcp.callTool("Supabase", "execute_sql", { project_id: PROJECT, query: sql }, opts); }
      catch (e) {
        last = e;
        if (!(e && e.retryable)) throw e;
        await sleep(Math.min(Math.max(e.retryAfterMs || 0, attempt ? 12000 : 4000), 30000) + Math.random() * 1000);   // Supabase throttles bursts
      }
    }
    throw last;
  }

  // QuickBooks (the qbo edge function). On the web it's called directly; in Claude it goes through SQL (pg_net is
  // asynchronous: jt.qbo_call starts the request, jt.qbo_result has the answer once it's in).
  async function qboCall(body) {
    if (WEB) return WEB.fn("qbo", body);
    const st = await run(`select jt.qbo_call(${q(JSON.stringify(body))}::jsonb)::text as id`, true);
    const id = st[0] && st[0].id; if (!id) throw { code: "tool_error", message: "Couldn't reach QuickBooks." };
    for (let i = 0; i < 30; i++) {
      await sleep(i ? 1500 : 2500);
      const r = await run(`select jt.qbo_result(${int(id)})::text as r`, true);
      const x = r[0] && r[0].r ? JSON.parse(r[0].r) : null;
      if (!x) continue;
      if (x.error && !x.body) throw { code: "tool_error", message: "QuickBooks call failed: " + x.error };
      return typeof x.body === "string" ? { ok: false, error: x.body } : x.body;
    }
    throw { code: "server_unavailable", message: "QuickBooks took too long to answer — check the bill in QuickBooks before trying again.", retryable: true };
  }
  // The Amazon SP-API edge function (orders): {action: "sync", force?} etc.
  async function amazonCall(body) {
    if (WEB) return WEB.fn("amazon", body);
    const st = await run(`select jt.amazon_call(${q(JSON.stringify(body))}::jsonb)::text as id`, true);
    const id = st[0] && st[0].id; if (!id) throw { code: "tool_error", message: "Couldn't reach Amazon." };
    for (let i = 0; i < 80; i++) {
      await sleep(i ? 2000 : 3000);
      const r = await run(`select jt.qbo_result(${int(id)})::text as r`, true);
      const x = r[0] && r[0].r ? JSON.parse(r[0].r) : null;
      if (!x) continue;
      if (x.error && !x.body) throw { code: "tool_error", message: "Amazon call failed: " + x.error };
      return typeof x.body === "string" ? { ok: false, error: x.body } : x.body;
    }
    throw { code: "server_unavailable", message: "Amazon took too long to answer.", retryable: true };
  }
  async function run(sql, refresh) {
    refresh = refresh || Date.now() < freshUntil;
    if (WEB) {
      await acquire(isWrite(sql));
      try { return await WEB.sql(sql, refresh); }
      catch (e) { console.warn("[JT] database call failed", e && e.code, e && e.message); throw e; }
      finally { release(); }
    }
    const mcp = await getMcp();
    if (!mcp) throw { code: "not_granted", message: "Database access isn't available in this view." };
    let first = false;
    if (!gate) { first = true; let done; gate = new Promise(r => { done = r; }); gate.done = done; }
    else await gate.catch(() => {});
    await acquire(isWrite(sql));
    try {
      const res = await once(mcp, sql, refresh);
      if (first) gate.done();
      return unwrap(res);
    } catch (e) {
      if (first) { gate.done(); gate = null; }   // let the next call try the prompt again
      console.warn("[JT] database call failed", e && e.code, e && e.message);
      throw e;
    } finally { release(); }
  }

  // Rows as arrays: `select` is a list of SQL expressions, `from` the rest of the query (from/where/group by).
  async function rows(select, from, refresh) {
    const cols = select.map((e, i) => `${e} as c${i}`).join(", "), refs = select.map((_, i) => `t.c${i}`).join(", ");
    const sql = `select coalesce(json_agg(json_build_array(${refs})), '[]'::json) as j from (select ${cols} ${from}) t`;
    const out = await run(sql, refresh);
    return (out[0] && out[0].j) || [];
  }
  // Same, split into `parts` by a hash of `key` to keep each reply small; a part whose reply comes back
  // cut off is split again (up to 64 parts).
  async function rowsSplit(select, from, key, parts, refresh) {
    const [head, ...rest] = from.split(/(?=\bgroup by\b)/i);
    const hasWhere = /\bwhere\b/i.test(head);
    const part = async (n, i) => {
      const f = n <= 1 ? from : `${head} ${hasWhere ? "and" : "where"} abs(hashtext((${key})::text)) % ${n} = ${i} ${rest.join("")}`;
      try { return await rows(select, f, refresh); }
      catch (e) {
        if (!(e && e.code === "too_big") || n >= 16) throw e;
        const [a, b] = await Promise.all([part(n * 2, i), part(n * 2, i + n)]);
        return a.concat(b);
      }
    };
    const res = await Promise.all(Array.from({ length: Math.max(1, parts) }, (_, i) => part(Math.max(1, parts), i)));
    return [].concat(...res);
  }
  const call = (fn, argSql) => run(`select jt.${fn}(${argSql}) as ok`);

  // ---------- Shopify catalog changes reach every tab ----------
  // After a sync from Shopify brings in new or changed products, every tab drops its copy of the catalog: each
  // listens for "jt:catalog" and reloads (reads skip the caches for two minutes). checkCatalog() notices a sync
  // made elsewhere (the nightly one, another browser) by the catalog's last sync time; the tabs call it on show.
  const catState = { stamp: null, at: 0 };
  function catalogChanged(why) {
    freshUntil = Date.now() + 120000;
    if (WEB && window.JTWeb && window.JTWeb.clearCache) window.JTWeb.clearCache();
    window.dispatchEvent(new CustomEvent("jt:catalog", { detail: { why: why || "" } }));
  }
  async function checkCatalog(force) {
    if (!force && Date.now() - catState.at < 60000) return false;
    catState.at = Date.now();
    const r = await rows(["max(seen_at)::text"], "from jt.variants", true);
    const s = r[0] && r[0][0], was = catState.stamp; catState.stamp = s || was;
    if (was && s && s !== was) { catalogChanged("sync"); return true; }
    return false;
  }

  // ---------- dates, the same in every browser ----------
  // Pacific-time calendar day as YYYY-MM-DD, built from its parts (a locale's own date format varies by browser).
  const dayParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
  function parseTime(v) {                      // Date from a Date, a number, or a database timestamp string
    if (v instanceof Date) return v;
    if (typeof v === "number") return new Date(v);
    let s = String(v || "").trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1").replace(/([+-]\d\d)$/, "$1:00");
    return new Date(s);
  }
  function laDay(v) {
    const d = parseTime(v == null ? Date.now() : v);
    if (isNaN(d)) return null;
    const p = {}; for (const x of dayParts.formatToParts(d)) p[x.type] = x.value;
    return `${p.year}-${p.month}-${p.day}`;
  }
  function addDays(ds, n) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ds || ""));
    const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n, 12)) : new Date(NaN);
    return isNaN(d) ? ds : d.toISOString().slice(0, 10);
  }
  window.JTDate = { parseTime, laDay, addDays, today: () => laDay(Date.now()) };

  // One set of date presets for everything that reports on the past (the Shopify tab's style): buttons + a custom
  // start–end. JTRange.of(preset, anchor) -> [start, end]; `anchor` is "today" (Amazon uses its last day of data).
  const RANGE_PRESETS = [["today", "Today"], ["yesterday", "Yesterday"], ["7", "7d"], ["14", "14d"], ["30", "30d"], ["90", "90d"],
    ["mtd", "MTD"], ["ytd", "YTD"], ["12m", "12m"], ["ly", "Last year"]];
  function rangeOf(p, anchor) {
    const t = anchor || laDay(Date.now()), y = +t.slice(0, 4);
    if (p === "today") return [t, t];
    if (p === "yesterday") { const d = addDays(t, -1); return [d, d]; }
    if (p === "mtd") return [t.slice(0, 8) + "01", t];
    if (p === "ytd") return [y + "-01-01", t];
    if (p === "ly") return [(y - 1) + "-01-01", (y - 1) + "-12-31"];
    if (p === "12m") { const d = new Date(Date.UTC(y, +t.slice(5, 7) - 1 - 11, 1)); return [d.toISOString().slice(0, 10), t]; }   // this month + the 11 before
    return [addDays(t, -(Number(p) - 1)), t];
  }
  // Fill a .seg with the preset buttons (data-<attr>="<preset>").
  function rangeSeg(id, attr) {
    const el = document.getElementById(id); if (!el) return;
    el.innerHTML = RANGE_PRESETS.map(([k, l]) => `<button type="button" data-${attr}="${k}" aria-pressed="false">${l}</button>`).join("");
  }
  const rangeLabel = (s, e) => { const f = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); return s === e ? f(s) : f(s) + " – " + f(e); };
  window.JTRange = { PRESETS: RANGE_PRESETS, of: rangeOf, seg: rangeSeg, label: rangeLabel };

  // Anything that breaks on the page shows as a banner at the top instead of failing silently.
  function showError(e) {
    let msg = (e && (e.message || e.reason && e.reason.message)) || String(e || "unknown error");
    const where = e && e.stack ? (String(e.stack).split("\n").find(l => /at /.test(l)) || "").trim().replace(/\(?(https?|file):[^)]*\)?/, "").trim() : "";
    if (where) msg += " [" + where.slice(0, 60) + "]";
    console.error("[JT]", e);
    let el = document.getElementById("jt-err");
    if (!el) {
      el = document.createElement("div"); el.id = "jt-err"; el.setAttribute("role", "alert");
      el.style.cssText = "position:sticky;top:0;z-index:60;margin:0 0 8px;padding:8px 12px;border-radius:8px;background:var(--bad-bg);color:var(--bad);font-size:13px;display:flex;gap:10px;align-items:center";
      (document.querySelector(".wrap") || document.body).prepend(el);
    }
    el.innerHTML = "";
    const t = document.createElement("span"); t.textContent = "Something went wrong: " + String(msg).slice(0, 240) + ". Reload the page; if it keeps happening, tell Claude this message.";
    const x = document.createElement("button"); x.className = "mini"; x.textContent = "Dismiss"; x.onclick = () => el.remove();
    el.append(t, x);
  }
  window.addEventListener("error", (ev) => { if (ev && ev.error) showError(ev.error); });
  window.addEventListener("unhandledrejection", (ev) => { const r = ev && ev.reason; if (r && r.code && /^(not_granted|capability_disabled|cancelled)$/.test(r.code)) return; showError(r && r.message ? r : { message: (r && (r.code || r.message)) || "request failed" }); });

  // Which cost to put on past Shopify sales: "current" = today's Shopify cost on every sale (views *_costed, default),
  // "recorded" = the cost Shopify stored on each order when it was placed. Per viewer; changing it reloads the page.
  let costBasis = "current";
  try { costBasis = localStorage.getItem("jt-cost-basis") === "recorded" ? "recorded" : "current"; } catch (_) {}
  const SRC = costBasis === "current"
    ? { sales: "jt.v_shopify_sales_costed", daily: "jt.v_shopify_daily_costed", psales: "jt.v_product_sales_daily_costed" }
    : { sales: "jt.shopify_sales", daily: "jt.shopify_daily", psales: "jt.v_product_sales_daily" };
  function setCostBasis(b) { try { localStorage.setItem("jt-cost-basis", b); } catch (_) {} location.reload(); }
  document.addEventListener("DOMContentLoaded", () => document.querySelectorAll("select.basis-sel").forEach(el => {
    el.value = costBasis; el.addEventListener("change", () => setCostBasis(el.value));
  }));

  window.JT = {
    costBasis, src: SRC, setCostBasis,
    showError,
    PROJECT, q, day, int, run, rows, rowsSplit, getMcp, standalone: !!WEB, catalogChanged, checkCatalog,
    qbo: qboCall,
    amazon: amazonCall,
    // Operational alerts (Alerts tab; migration 060)
    alerts: {
      list: (refresh) => rowsSplit(["id", "rule", "key", "title", "detail", "severity", "link", "data", "status", "owner",
        "to_char(first_seen at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI')", "to_char(last_seen at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI')",
        "extract(epoch from now() - first_seen)::int", "acked_by", "to_char(snoozed_until at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI')",
        "to_char(resolved_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI')", "resolved_by", "resolution", "cause",
        "extract(epoch from coalesce(resolved_at, now()) - first_seen)::int"],
        "from jt.alerts where (status in ('open', 'acked', 'snoozed') or resolved_at > now() - interval '30 days')", "id", 2, refresh),
      rules: (refresh) => rows(["code", "category", "title", "description", "action", "owner", "enabled", "params", "sort"], "from jt.alert_rules order by sort, code", refresh),
      // per rule, last 90 days: how often, how fast it gets fixed, why, and what keeps coming back
      patterns: (refresh) => rows(["r.code", "r.title", "r.category",
        "(select count(*) from jt.alerts a where a.rule = r.code and a.first_seen > now() - interval '30 days')",
        "(select count(*) from jt.alerts a where a.rule = r.code and a.first_seen > now() - interval '90 days')",
        "(select count(*) from jt.alerts a where a.rule = r.code and a.status in ('open', 'acked', 'snoozed'))",
        "(select count(*) from jt.alerts a where a.rule = r.code and a.status = 'resolved' and a.resolved_at > now() - interval '90 days')",
        "(select count(*) from jt.alerts a where a.rule = r.code and a.status = 'cleared' and a.resolved_at > now() - interval '90 days')",
        "(select round((percentile_cont(0.5) within group (order by extract(epoch from a.resolved_at - a.first_seen)) / 3600)::numeric, 1) from jt.alerts a where a.rule = r.code and a.status = 'resolved' and a.resolved_at > now() - interval '90 days')",
        "(select coalesce(json_agg(json_build_array(c.cause, c.n) order by c.n desc), '[]') from (select a.cause, count(*) n from jt.alerts a where a.rule = r.code and a.status = 'resolved' and a.cause <> '' and a.resolved_at > now() - interval '90 days' group by 1 order by 2 desc limit 4) c)",
        "(select coalesce(json_agg(json_build_array(k.key, k.n, k.title) order by k.n desc), '[]') from (select a.key, count(*) n, max(a.title) title from jt.alerts a where a.rule = r.code and a.key <> 'all' and a.first_seen > now() - interval '90 days' group by 1 having count(*) > 1 order by 2 desc limit 5) k)",
        "(select coalesce(json_agg(json_build_array(d.d, d.n) order by d.d), '[]') from (select (a.first_seen at time zone 'America/Los_Angeles')::date d, count(*) n from jt.alerts a where a.rule = r.code and a.first_seen > now() - interval '30 days' group by 1) d)"],
        "from jt.alert_rules r order by r.sort", refresh),
      people: async (refresh) => { try { return (await rows(["email"], "from jt.app_users order by email", refresh)).map(r => r[0]); } catch (_) { return []; } },
      act: async (p) => {
        if (WEB) return WEB.write("jt_alert_act", { p });
        const out = await run(`select jt.alert_act(${q(JSON.stringify({ ...p, by: p.by || "dashboard" }))}::jsonb)::text as r`, true);
        return out[0] && Number(out[0].r);
      },
      ruleSet: async (p) => {
        if (WEB) return WEB.write("jt_alert_rule_set", { p });
        return run(`select jt.alert_rule_set(${q(JSON.stringify(p))}::jsonb)::text as r`, true);
      },
      check: async () => {
        if (WEB) return WEB.write("jt_alerts_refresh", {});
        const out = await run("select jt.refresh_alerts()::text as r", true);
        return out[0] && JSON.parse(out[0].r);
      },
      counts: async (refresh) => {
        const r = await rows(["severity", "count(*)"], "from jt.alerts where status = 'open' group by 1", refresh);
        return Object.fromEntries(r.map(x => [x[0], Number(x[1])]));
      },
    },
    // Amazon FBM orders -> Shopify stock (FBM tab)
    fbm: {
      lines: (refresh) => rows(["order_id", "sku", "coalesce(asin, '')", "coalesce(product_name, '')", "quantity", "order_status",
        "to_char(purchase_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI')", "shipped", "cancelled", "map_kind",
        "variant_id::text", "map_units", "units", "shopify_title", "shopify_sku", "shopify_qty", "product_id::text", "tracked",
        "decision", "status", "error", "decided_by", "to_char(decided_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI')",
        "to_char(applied_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI')", "shopify_before", "decided_units", "location_id"],
        "from jt.v_fbm_lines order by purchase_at desc, order_id, sku", refresh),
      // FBM listings (All Listings report) mapped to a Shopify variant that has stock
      listings: (refresh) => rows(["sku", "asin", "title", "amazon_status", "amazon_qty", "amazon_price", "report_file",
        "to_char(report_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI')", "variant_id::text", "map_units", "product_id::text",
        "shopify_title", "shopify_sku", "shopify_qty", "packs", "shopify_total", "stock_source", "amazon_qty_now", "pushed_qty", "pushed_status",
        "to_char(pushed_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI')", "pushed_by", "pushed_error",
        "(select to_char(max(updated_at) at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') from jt.location_stock)"],
        "from jt.v_fbm_listings order by shopify_qty desc, sku", refresh),
      // FBM location stock: ask the sync job for fresh numbers (about a minute)
      refreshStock: async () => {
        if (WEB) return WEB.write("jt_request_location_stock", {});
        return run("select jt.dispatch_sync('location-stock')::text as r", true);
      },
      settings: async (refresh) => { const r = await rows(["value"], "from jt.settings where key = 'fbm_sync'", refresh); return (r[0] && r[0][0]) || {}; },
      // decisions: [{order_id, sku, decision: 'decrement' | 'skip' | 'undo'}] -> {queued, skipped, undone, refused}
      async decide(decisions) {
        if (WEB) return WEB.write("jt_fbm_decide", { p: { decisions } });
        const out = await run(`select jt.fbm_decide(${q(JSON.stringify({ decisions, by: "Claude dashboard" }))}::jsonb)::text as r`, true);
        return JSON.parse(out[0].r);
      },
      async setStart(start) {
        if (WEB) return WEB.write("jt_fbm_settings", { p: { start } });
        return run(`select jt.fbm_settings(${q(JSON.stringify({ start }))}::jsonb)::text as r`, true);
      },
      async setLocation(location_id) {
        if (WEB) return WEB.write("jt_fbm_settings", { p: { location_id } });
        return run(`select jt.fbm_settings(${q(JSON.stringify({ location_id }))}::jsonb)::text as r`, true);
      },
      async setLocationName(location_name) {
        if (WEB) return WEB.write("jt_fbm_settings", { p: { location_name } });
        return run(`select jt.fbm_settings(${q(JSON.stringify({ location_name }))}::jsonb)::text as r`, true);
      },
    },
    saveCostOverride: (body) => WEB ? WEB.write("jt_save_cost_overrides", { p: [body] }) : call("save_cost_override", q(JSON.stringify(body)) + "::jsonb"),
    // shipping cost entered by hand for an order with no ShipStation label
    saveShipCost: (body) => WEB ? WEB.write("jt_save_ship_cost", { p: body }) : call("save_ship_cost", q(JSON.stringify({ ...body, by: "Claude dashboard" })) + "::jsonb"),
    deleteShipCost: (orderId) => WEB ? WEB.write("jt_delete_ship_cost", { p: { order_id: Number(int(orderId)) } }) : call("delete_ship_cost", q(JSON.stringify({ order_id: Number(int(orderId)) })) + "::jsonb"),
    deleteCostOverride: (orderId) => WEB ? WEB.write("jt_delete_cost_override", { p_order_id: Number(int(orderId)) }) : call("delete_cost_override", int(orderId)),
    // many at once (one database call); returns how many were saved
    async saveCostOverrides(bodies) {
      if (WEB) return WEB.write("jt_save_cost_overrides", { p: bodies });
      const out = await run(`with s as (select jt.save_cost_override(x) from jsonb_array_elements(${q(JSON.stringify(bodies))}::jsonb) x) select count(*)::int as n from s`);
      return (out[0] && out[0].n) || 0;
    },
    // New unit costs for Shopify variants: [{variant_id, cost}] -> queued, then written to Shopify by the sync
    async queueCostUpdates(list) {
      if (WEB) return WEB.write("jt_queue_cost_updates", { p: list });
      const out = await run(`select jt.queue_cost_updates(${q(JSON.stringify(list))}::jsonb) as n`, true);
      return (out[0] && out[0].n) || 0;
    },
    // Vendor invoices (Invoices tab): save a draft (returns its id), apply it (queues Shopify cost/price updates), delete a draft
    invoices: {
      async save(body) {
        if (WEB) return Number(await WEB.write("jt_save_invoice", { p: body }));
        const out = await run(`select jt.save_invoice(${q(JSON.stringify(body))}::jsonb) as id`, true);
        return Number(out[0] && out[0].id);
      },
      async apply(id) {
        if (WEB) return Number(await WEB.write("jt_apply_invoice", { p_id: Number(int(id)) }));
        const out = await run(`select jt.apply_invoice(${int(id)}) as n`, true);
        return Number(out[0] && out[0].n) || 0;
      },
      async remove(id) {
        if (WEB) return !!(await WEB.write("jt_delete_invoice", { p_id: Number(int(id)) }));
        const out = await run(`select jt.delete_invoice(${int(id)}) as ok`, true);
        return !!(out[0] && out[0].ok);
      },
      async updateCard(body) {
        if (WEB) return WEB.write("jt_update_invoice_card", { p: body });
        return run(`select jt.update_invoice_card(${q(JSON.stringify(body))}::jsonb) as ok`, true);
      },
      async saveRule(body) {
        if (WEB) return WEB.write("jt_save_price_rule", { p: body });
        return run(`select jt.save_price_rule(${q(JSON.stringify(body))}::jsonb) as ok`, true);
      },
    },
    // Amazon listing vendors (Amazon matching tab): [{sku, vendor}], vendor "" clears
    async setAmazonVendors(list) {
      if (WEB) return WEB.write("jt_set_amazon_vendors", { p: list });
      const out = await run(`select jt.set_amazon_vendors(${q(JSON.stringify(list))}::jsonb) as n`, true);
      return (out[0] && out[0].n) || 0;
    },
    // Prep center (Prep center tab): set counts, or ship units to Amazon. Returns the number of lines changed.
    prep: {
      // take a product off (hide: true) or put it back on (false) the prep center's Incoming products list
      async incomingHide(body) {
        if (WEB) return await WEB.write("jt_prep_incoming_hide", { p: body });
        const out = await run(`select jt.prep_incoming_hide(${q(JSON.stringify(body))}::jsonb) as ok`, true);
        return out[0] && out[0].ok;
      },
      async adjust(body) {
        if (WEB) return Number(await WEB.write("jt_prep_adjust", { p: body }));
        const out = await run(`select jt.prep_adjust(${q(JSON.stringify({ ...body, by: "Claude dashboard" }))}::jsonb) as n`, true);
        return Number(out[0] && out[0].n) || 0;
      },
      async ship(body) {
        if (WEB) return Number(await WEB.write("jt_prep_ship", { p: body }));
        const out = await run(`select jt.prep_ship(${q(JSON.stringify({ ...body, by: "Claude dashboard" }))}::jsonb) as n`, true);
        return Number(out[0] && out[0].n) || 0;
      },
      // earmark prep-center units for Amazon listings: {variant_id, from_sku, moves: [{to_sku, qty}], note}
      async assign(body) {
        if (WEB) return Number(await WEB.write("jt_prep_assign", { p: body }));
        const out = await run(`select jt.prep_assign(${q(JSON.stringify({ ...body, by: "Claude dashboard" }))}::jsonb) as n`, true);
        return Number(out[0] && out[0].n) || 0;
      },
      // shipments: open -> started -> shipped (stock leaves the prep center when shipped)
      async saveShipment(body) {
        if (WEB) return Number(await WEB.write("jt_prep_shipment_save", { p: body }));
        const out = await run(`select jt.prep_shipment_save(${q(JSON.stringify({ ...body, by: "Claude dashboard" }))}::jsonb) as id`, true);
        return Number(out[0] && out[0].id);
      },
      async setShipmentStatus(id, status) {
        if (WEB) return WEB.write("jt_prep_shipment_status", { p: { id, status } });
        const out = await run(`select jt.prep_shipment_status(${q(JSON.stringify({ id, status, by: "Claude dashboard" }))}::jsonb) as s`, true);
        return out[0] && out[0].s;
      },
      async deleteShipment(id) {
        if (WEB) return WEB.write("jt_prep_shipment_delete", { p: { id } });
        return run(`select jt.prep_shipment_delete(${q(JSON.stringify({ id }))}::jsonb) as ok`, true);
      },
      // Incoming Inventory: vendor orders coming in (draft -> ordered -> invoice -> packing_slip -> received -> shipped)
      async saveOrder(body) {
        if (WEB) return Number(await WEB.write("jt_prep_order_save", { p: body }));
        const out = await run(`select jt.prep_order_save(${q(JSON.stringify({ ...body, by: "Claude dashboard" }))}::jsonb) as id`, true);
        return Number(out[0] && out[0].id);
      },
      // unlink an invoice from its QuickBooks bill
      async qboUnlink(invoiceId) {
        const body = { invoice_id: Number(invoiceId) };
        if (WEB) return WEB.write("jt_invoice_qbo_unlink", { p: body });
        return run(`select jt.invoice_qbo_unlink(${q(JSON.stringify(body))}::jsonb)`, true);
      },
      // mark an invoice received by hand, or reopen it — jt.invoice_set_received
      async invoiceReceived(invoiceId, received) {
        const body = { invoice_id: Number(invoiceId), received: !!received };
        if (WEB) return WEB.write("jt_invoice_set_received", { p: body });
        const out = await run(`select jt.invoice_set_received(${q(JSON.stringify(body))}::jsonb) as r`, true);
        return out[0] && out[0].r;
      },
      // un-receive part of one product on a PO — jt.prep_order_unreceive_line
      async unreceiveLine(body) {
        if (WEB) return Number(await WEB.write("jt_prep_order_unreceive_line", { p: body }));
        const out = await run(`select jt.prep_order_unreceive_line(${q(JSON.stringify({ ...body, by: "Claude dashboard" }))}::jsonb) as n`, true);
        return Number(out[0] && out[0].n) || 0;
      },
      async setOrderStatus(id, status) {
        if (WEB) return WEB.write("jt_prep_order_status", { p: { id, status } });
        const out = await run(`select jt.prep_order_status(${q(JSON.stringify({ id, status, by: "Claude dashboard" }))}::jsonb) as s`, true);
        return out[0] && out[0].s;
      },
      // with invoiceId the units are also counted on that invoice (jt.po_receive_invoice)
      async receiveOrder(id, lines, note, invoiceId) {
        if (invoiceId) {
          const body = { id, invoice_id: Number(invoiceId), lines, note: note || "" };
          if (WEB) return Number(await WEB.write("jt_po_receive_invoice", { p: body }));
          const o2 = await run(`select jt.po_receive_invoice(${q(JSON.stringify({ ...body, by: "Claude dashboard" }))}::jsonb) as n`, true);
          return Number(o2[0] && o2[0].n) || 0;
        }
        if (WEB) return Number(await WEB.write("jt_prep_order_receive", { p: { id, lines, note: note || "" } }));
        const out = await run(`select jt.prep_order_receive(${q(JSON.stringify({ id, lines, note: note || "", by: "Claude dashboard" }))}::jsonb) as n`, true);
        return Number(out[0] && out[0].n) || 0;
      },
      // On The List: mark a product for re-order, put items on a draft / booking order, take one off
      async listAdd(body) {
        if (WEB) return Number(await WEB.write("jt_prep_list_add", { p: body }));
        const out = await run(`select jt.prep_list_add(${q(JSON.stringify({ ...body, by: "Claude dashboard" }))}::jsonb) as id`, true);
        return Number(out[0] && out[0].id);
      },
      async listAssign(body) {
        if (WEB) return Number(await WEB.write("jt_prep_list_assign", { p: body }));
        const out = await run(`select jt.prep_list_assign(${q(JSON.stringify({ ...body, by: "Claude dashboard" }))}::jsonb) as id`, true);
        return Number(out[0] && out[0].id);
      },
      async listRemove(id) {
        if (WEB) return WEB.write("jt_prep_list_remove", { p: { id } });
        return run(`select jt.prep_list_remove(${q(JSON.stringify({ id }))}::jsonb) as ok`, true);
      },
      async deleteOrder(id) {
        if (WEB) return WEB.write("jt_prep_order_delete", { p: { id } });
        return run(`select jt.prep_order_delete(${q(JSON.stringify({ id }))}::jsonb) as ok`, true);
      },
    },
    // Purchase orders tab: an order + its invoice (parsed from the PDF) in one save; the PDF in parts; delete a draft
    po: {
      // the PO was received in Shopify (on) or not (off); marking it starts a catalog sync — jt.po_shopify_received
      async shopifyReceived(id, on) {
        const body = { id: Number(id), on: !!on };
        if (WEB) return await WEB.write("jt_po_shopify_received", { p: body });
        const out = await run(`select jt.po_shopify_received(${q(JSON.stringify({ ...body, by: "Claude dashboard" }))}::jsonb) as t`, true);
        return out[0] && out[0].t;
      },
      // new costs from a PO to Shopify (weighted average), starting FIFO cost layers — jt.po_apply_costs
      async applyCosts(body) {
        if (WEB) return await WEB.write("jt_po_apply_costs", { p: body });
        const out = await run(`select jt.po_apply_costs(${q(JSON.stringify({ ...body, by: "Claude dashboard" }))}::jsonb) as n`, true);
        return out[0] && out[0].n;
      },
      async save(body) {
        if (WEB) return await WEB.write("jt_po_save", { p: body });
        const out = await run(`select jt.po_save(${q(JSON.stringify({ ...body, by: "Claude dashboard" }))}::jsonb) as r`, true);
        return out[0] && out[0].r;
      },
      // put a saved invoice on another purchase order (or link one that has none) — jt.invoice_move
      async moveInvoice(invoiceId, orderId) {
        const body = { invoice_id: invoiceId, order_id: orderId };
        if (WEB) return WEB.write("jt_invoice_move", { p: body });
        return run(`select jt.invoice_move(${q(JSON.stringify(body))}::jsonb) as ok`, true);
      },
      async putFilePart(body) {
        if (WEB) return WEB.write("jt_invoice_file_put", { p: body });
        return run(`select jt.invoice_file_put(${q(JSON.stringify(body))}::jsonb) as k`, true);
      },
      async remove(id) {
        if (WEB) return WEB.write("jt_po_delete", { p: { id } });
        return run(`select jt.po_delete(${q(JSON.stringify({ id }))}::jsonb) as ok`, true);
      },
    },
    // Ask for a catalog sync from Shopify now (the sync job runs in about 30 seconds). false = one was just started.
    async requestCatalogSync() {
      if (WEB) return WEB.write("jt_request_catalog_sync", {});
      const out = await run(`select jt.request_catalog_sync() as ok`, true);
      return !!(out[0] && out[0].ok);
    },
    message(e) {
      const c = e && e.code, tag = c ? ` (${c})` : "";
      if (WEB && c === "not_allowed") return "This account doesn't have access to the dashboard. Sign out and use the right account.";
      if (WEB && c === "needs_reauth") return "Your sign-in expired. Reload the page and sign in again.";
      if (WEB && c === "not_in_manifest") return "This needs live Shopify access, which only the Claude version of the dashboard has.";
      if (c === "server_not_connected") return "Supabase isn't connected for your account. Add it in claude.ai Settings → Connectors, then reload.";
      if (c === "needs_reauth") return "Your Supabase connection expired. Reconnect it in claude.ai Settings → Connectors, then press Refresh.";
      if (c === "selection_required") return "You have more than one Supabase connection. Pick one in the prompt, then press Refresh.";
      if (c === "not_in_manifest" || c === "consent_required") return "Supabase is turned off for this page. Allow it in the page's connector settings (or the prompt), then reload.";
      if (c === "approval_required" || c === "blocked_by_policy") return "Your account's settings block Supabase queries from this page" + tag + ".";
      if (c === "not_granted" || c === "capability_disabled" || c === "capability_removed") return "The database isn't available in this view. Open the dashboard in claude.ai.";
      if (c === "tool_error") return "Database error: " + (e.message || "unknown");
      if (c === "too_big") return "A result was too large to load. Try a shorter date range.";
      if (/\b429\b|rate.?limit|too many/i.test((e && e.message) || "") || c === "rate_limited") return "Supabase is limiting requests right now (too many in a short time). Wait a minute, then press Refresh.";
      if (c === "server_unavailable") return "Supabase didn't respond (busy or timed out). Wait a minute, then press Refresh.";
      return "The database didn't respond" + tag + (e && e.message && c !== "upstream_error" ? ": " + e.message : "") + ". Press Refresh in a moment.";
    },
  };

  // ---------- document storage (Amazon data, mappings, cost check), shared by both versions ----------
  // Supabase table jt.docs, one row per document. Offers the calls the tabs were written against
  // (collection/doc, where/orderBy/limit, get/set/update/delete, onSnapshot).
  const listeners = new Map(), timers = new Map();
  const changed = (c) => {        // after writes, refresh open views of that collection once things settle
    clearTimeout(timers.get(c));
    timers.set(c, setTimeout(() => (listeners.get(c) || new Set()).forEach(f => f()), 600));
  };
  const listen = (c, f) => { const set = listeners.get(c) || new Set(); set.add(f); listeners.set(c, set); return () => set.delete(f); };
  async function docSet(c, id, body) {
    if (WEB) await WEB.write("jt_doc_set", { p_collection: c, p_id: String(id), p_data: body });
    else await run(`insert into jt.docs (collection, id, data) values (${q(c)}, ${q(id)}, ${q(JSON.stringify(body))}::jsonb)
      on conflict (collection, id) do update set data = excluded.data, updated_at = now() returning 1 as ok`, true);
    changed(c);
  }
  async function docDelete(c, id) {
    if (WEB) await WEB.write("jt_doc_delete", { p_collection: c, p_id: String(id) });
    else await run(`delete from jt.docs where collection = ${q(c)} and id = ${q(id)} returning 1 as ok`, true);
    changed(c);
  }
  const OPS = { "==": "=", "<": "<", "<=": "<=", ">": ">", ">=": ">=", "!=": "<>" };
  const snapOf = (rs) => {
    const docs = (rs || []).map(r => ({ id: r.id, exists: true, data: () => r.data }));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [] };
  };
  function docRef(c, id) {
    return {
      id,
      async get() {
        const r = await run(`select id, data from jt.docs where collection = ${q(c)} and id = ${q(id)}`, true);
        return r[0] ? { exists: true, id, data: () => r[0].data } : { exists: false, id, data: () => undefined };
      },
      set: (body) => docSet(c, id, body),
      async update(body) { const cur = await this.get(); await docSet(c, id, Object.assign({}, cur.exists ? cur.data() : {}, body)); },
      delete: () => docDelete(c, id),
      onSnapshot(cb, err) { const f = () => this.get().then(cb, e => err && err(e)); f(); return listen(c, f); },
    };
  }
  function query(c, wh, ord, lim) {
    const api = {
      where: (f, op, v) => query(c, wh.concat([[f, op, v]]), ord, lim),
      orderBy: (f, dir) => query(c, wh, [f, dir === "desc" ? "desc" : "asc"], lim),
      limit: (n) => query(c, wh, ord, n),
      async get() {
        let s = `select id, data from jt.docs where collection = ${q(c)}`;
        for (const [f, op, v] of wh) {
          if (!OPS[op]) throw { code: "bad_request", message: "unsupported filter " + op };
          s += ` and (data ->> ${q(f)}) ${OPS[op]} ${q(String(v))}`;
        }
        s += ord ? ` order by data ->> ${q(ord[0])} ${ord[1]}` : " order by id";
        if (lim) s += ` limit ${int(lim)}`;
        return snapOf(await run(s, true));
      },
      onSnapshot(cb, err) { const f = () => api.get().then(cb, e => err && err(e)); f(); return listen(c, f); },
      doc: (id) => docRef(c, id),
    };
    return api;
  }
  const store = {
    collection: (c) => query(c, [], null, null),
    doc: (path) => { const i = String(path).lastIndexOf("/"); return docRef(path.slice(0, i), path.slice(i + 1)); },
  };
  // Resolves once the database is reachable (after sign-in on the web; once the connector answers inside Claude).
  window.JT.docStore = () => WEB ? WEB.ready.then(() => store) : getMcp().then(m => m ? store : null);

  // ---------- saved order costs, shared by the Shopify and cost-mapping tabs ----------
  const subs = new Set();
  let cur = new Map(), loading = null;
  async function loadOverrides(refresh) {
    const r = await rowsSplit(["order_id::text", "cost", "shopify_cogs", "lines", "src"], "from jt.cost_overrides", "order_id", 1, refresh);
    const mm = new Map();
    for (const [id, cost, sc, lines, src] of r) mm.set(id, { cost: Number(cost), lines: lines || null, src: src || "", shopifyCogs: sc == null ? null : Number(sc) });
    cur = mm; subs.forEach(f => { try { f(cur, true); } catch (_) {} });
    return cur;
  }
  window.JT.overrides = {
    subscribe(fn) { subs.add(fn); if (!loading) loading = loadOverrides(false).catch(() => {}); else fn(cur, true); return () => subs.delete(fn); },
    reload() { loading = loadOverrides(true).catch(() => {}); return loading; },
    get: () => cur,
    // after a save or delete, update everyone right away (the next reload confirms it)
    set(id, v) { const mm = new Map(cur); if (v) mm.set(String(id), v); else mm.delete(String(id)); cur = mm; subs.forEach(f => { try { f(cur, true); } catch (_) {} }); },
  };
})();
