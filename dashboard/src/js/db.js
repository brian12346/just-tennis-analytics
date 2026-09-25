(() => {
  // Shared Supabase access for every tab: runs SQL through the viewer's Supabase connector (execute_sql).
  // Reads come back as JSON; large reads are split into parts so each response stays small.
  const PROJECT = "ppmzrlqvrhzfxobvnlon";
  let mcpP = null;
  const getMcp = () => mcpP || (mcpP = (window.claude && window.claude.use ? window.claude.use("mcp") : Promise.resolve(null)).catch(() => null));

  const q = (v) => v == null ? "null" : "'" + String(v).replace(/'/g, "''") + "'";      // SQL string literal
  const day = (d) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) throw new Error("bad date " + d); return "'" + d + "'::date"; };
  const int = (n) => { const s = String(n); if (!/^-?\d+$/.test(s)) throw new Error("bad id " + n); return s; };

  function unwrap(res) {
    let p = res && res.payload;
    if (p && typeof p === "object" && typeof p.result === "string") p = p.result;
    if (typeof p !== "string") {
      const t = res && res.content && res.content.find(b => b.type === "text");
      p = t ? t.text : "";
      try { const j = JSON.parse(p); if (j && typeof j.result === "string") p = j.result; else if (j && j.error) throw { code: "tool_error", message: j.error.message || String(j.error) }; } catch (e) { if (e && e.code) throw e; }
    }
    const m = /<untrusted-data-[^>]*>\s*([\s\S]*?)\s*<\/untrusted-data-/.exec(p);
    if (!m) {
      if (/error/i.test(p)) throw { code: "tool_error", message: p.replace(/^.*?(ERROR:)/s, "$1").slice(0, 300) };
      throw { code: "tool_error", message: "Unexpected reply from the database." };
    }
    try { return JSON.parse(m[1]); }
    catch (_) { throw { code: "too_big", message: "The reply was cut off." }; }
  }

  // At most 2 calls in flight. The very first call runs alone, so the "allow Supabase" prompt
  // is answered before anything else is sent (calls made while it is open get refused).
  let active = 0, gate = null; const waiting = [];
  const acquire = () => new Promise(r => { if (active < 2) { active++; r(); } else waiting.push(r); });
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

  async function run(sql, refresh) {
    const mcp = await getMcp();
    if (!mcp) throw { code: "not_granted", message: "Database access isn't available in this view." };
    let first = false;
    if (!gate) { first = true; let done; gate = new Promise(r => { done = r; }); gate.done = done; }
    else await gate.catch(() => {});
    await acquire();
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
        if (!(e && e.code === "too_big") || n >= 64) throw e;
        const [a, b] = await Promise.all([part(n * 2, i), part(n * 2, i + n)]);
        return a.concat(b);
      }
    };
    const res = await Promise.all(Array.from({ length: Math.max(1, parts) }, (_, i) => part(Math.max(1, parts), i)));
    return [].concat(...res);
  }
  const call = (fn, argSql) => run(`select jt.${fn}(${argSql}) as ok`);

  window.JT = {
    PROJECT, q, day, int, run, rows, rowsSplit, getMcp,
    saveCostOverride: (body) => call("save_cost_override", q(JSON.stringify(body)) + "::jsonb"),
    deleteCostOverride: (orderId) => call("delete_cost_override", int(orderId)),
    // many at once (one database call); returns how many were saved
    async saveCostOverrides(bodies) {
      const out = await run(`with s as (select jt.save_cost_override(x) from jsonb_array_elements(${q(JSON.stringify(bodies))}::jsonb) x) select count(*)::int as n from s`);
      return (out[0] && out[0].n) || 0;
    },
    message(e) {
      const c = e && e.code, tag = c ? ` (${c})` : "";
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
