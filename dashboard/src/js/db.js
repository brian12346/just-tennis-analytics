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
    if (WEB) {
      await acquire();
      try { return await WEB.sql(sql, refresh); }
      catch (e) { console.warn("[JT] database call failed", e && e.code, e && e.message); throw e; }
      finally { release(); }
    }
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

  window.JT = {
    showError,
    PROJECT, q, day, int, run, rows, rowsSplit, getMcp, standalone: !!WEB,
    saveCostOverride: (body) => WEB ? WEB.write("jt_save_cost_overrides", { p: [body] }) : call("save_cost_override", q(JSON.stringify(body)) + "::jsonb"),
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
