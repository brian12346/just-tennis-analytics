(() => {
  // Shared Supabase access for every tab: runs SQL through the viewer's Supabase connector (execute_sql).
  // Reads come back as JSON; large reads are split into parts so each response stays small.
  const PROJECT = "ppmzrlqvrhzfxobvnlon";
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
        if (!(e && e.code === "too_big") || n >= 16) throw e;
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
