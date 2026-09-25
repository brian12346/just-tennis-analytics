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
    return JSON.parse(m[1]);
  }

  async function run(sql, refresh) {
    const mcp = await getMcp();
    if (!mcp) throw { code: "not_granted", message: "Database access isn't available in this view." };
    const opts = { cache: { staleTime: 120000, gcTime: 1800000, refresh: !!refresh } };
    let res;
    try { res = await mcp.callTool("Supabase", "execute_sql", { project_id: PROJECT, query: sql }, opts); }
    catch (e) {
      if (e && e.retryable) { await new Promise(r => setTimeout(r, 800 + Math.random() * 800)); res = await mcp.callTool("Supabase", "execute_sql", { project_id: PROJECT, query: sql }, opts); }
      else throw e;
    }
    return unwrap(res);
  }

  // Rows as arrays: `select` is a list of SQL expressions, `from` the rest of the query (from/where/group by).
  async function rows(select, from, refresh) {
    const cols = select.map((e, i) => `${e} as c${i}`).join(", "), refs = select.map((_, i) => `t.c${i}`).join(", ");
    const sql = `select coalesce(json_agg(json_build_array(${refs})), '[]'::json) as j from (select ${cols} ${from}) t`;
    const out = await run(sql, refresh);
    return (out[0] && out[0].j) || [];
  }
  // Same, split into `parts` by a hash of `key` (run in parallel) to keep each reply small.
  async function rowsSplit(select, from, key, parts, refresh) {
    if (parts <= 1) return rows(select, from, refresh);
    const hasWhere = /\bwhere\b/i.test(from.split(/\bgroup by\b/i)[0]);
    const [head, ...rest] = from.split(/(?=\bgroup by\b)/i);
    const res = await Promise.all(Array.from({ length: parts }, (_, i) =>
      rows(select, `${head} ${hasWhere ? "and" : "where"} abs(hashtext((${key})::text)) % ${parts} = ${i} ${rest.join("")}`, refresh)));
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
      const c = e && e.code;
      if (c === "server_not_connected") return "Supabase isn't connected for your account. Add it in claude.ai Settings → Connectors, then reload.";
      if (c === "needs_reauth") return "Your Supabase connection expired. Reconnect it in claude.ai Settings → Connectors.";
      if (c === "not_in_manifest") return "Database access is turned off for this page. Allow Supabase in the page's connector settings, then reload.";
      if (c === "not_granted" || c === "capability_disabled") return "The database isn't available in this view. Open the dashboard in claude.ai.";
      if (c === "tool_error") return "Database error: " + (e.message || "unknown");
      return "The database didn't respond. Press Refresh in a moment.";
    },
  };

  // ---------- saved order costs, shared by the Shopify and cost-mapping tabs ----------
  const subs = new Set();
  let cur = new Map(), loading = null;
  async function loadOverrides(refresh) {
    const r = await rowsSplit(["order_id::text", "cost", "shopify_cogs", "lines", "src"], "from jt.cost_overrides", "order_id", 2, refresh);
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
