(() => {
  // Web version (dashboard.andersenlifestyle.com). Inside Claude this file does nothing.
  // On the web it signs in with Supabase Auth and stands in for what the Claude host provides:
  //   window.claude.use("mcp")       -> only lets the page know the database is ready (Shopify is not called from the web)
  //   window.claude.use("db")        -> the page's document storage, kept in Supabase table jt.docs
  //   window.claude.use("downloads") -> saves files through the browser
  // Every database call goes through public.jt_* functions, which only answer the accounts in jt.app_users.
  if (window.claude && window.claude.use) return;

  const SB_URL = "https://ppmzrlqvrhzfxobvnlon.supabase.co";
  const SB_KEY = "sb_publishable_nPVLpNx1vs2qfpEK7nFmag_5Z3NqDYb";   // publishable key: safe in the page, grants nothing by itself
  const LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
  const $ = (id) => document.getElementById(id);

  let sb = null, readyResolve;
  const ready = new Promise(r => { readyResolve = r; });

  // ---------- sign-in ----------
  function showLogin(msg) {
    document.body.classList.add("signed-out");
    $("login").hidden = false;
    $("login-msg").textContent = msg || "";
    setTimeout(() => $("login-email").focus(), 0);
  }
  function signedIn(session) {
    document.body.classList.remove("signed-out");
    $("login").hidden = true;
    $("acct").hidden = false;
    $("whoami").textContent = session.user.email || "";
    readyResolve();
  }
  async function boot() {
    try {
      const mod = await import(LIB);
      sb = mod.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    } catch (e) { showLogin("Couldn't load the sign-in library. Check your connection and reload."); return; }
    const { data } = await sb.auth.getSession();
    if (data && data.session) signedIn(data.session); else showLogin();
    sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") location.reload(); });
  }
  document.addEventListener("DOMContentLoaded", () => {
    $("login-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!sb) return;
      const btn = $("login-go"); btn.disabled = true; $("login-msg").textContent = "Signing in…";
      const { data, error } = await sb.auth.signInWithPassword({ email: $("login-email").value.trim(), password: $("login-pass").value });
      btn.disabled = false;
      if (error) { $("login-msg").textContent = /invalid/i.test(error.message) ? "Email or password is wrong." : error.message; return; }
      $("login-pass").value = "";
      signedIn(data.session);
    });
    $("signout").addEventListener("click", async () => { cache.clear(); if (sb) await sb.auth.signOut(); location.reload(); });
    boot();
  });

  // ---------- database ----------
  const toErr = (e) => {
    const m = (e && e.message) || String(e);
    if ((e && e.code === "42501") || /not allowed/i.test(m)) return { code: "not_allowed", message: "This account doesn't have access to the dashboard." };
    if (/jwt|token|session/i.test(m)) return { code: "needs_reauth", message: m };
    if (/fetch|network/i.test(m)) return { code: "server_unavailable", message: m, retryable: true };
    return { code: "tool_error", message: m };
  };
  async function rpc(fn, args) {
    await ready;
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw toErr(error);
    return data;
  }
  // Reads are kept for 30 minutes (data syncs hourly); Refresh or any save clears them.
  const cache = new Map();
  async function sql(q, refresh) {
    const hit = cache.get(q);
    if (!refresh && hit && Date.now() - hit.t < 1800000) return hit.v;
    const v = await rpc("jt_sql", { q });
    cache.set(q, { t: Date.now(), v });
    return v;
  }
  async function write(fn, args) { const v = await rpc(fn, args); cache.clear(); return v; }

  // ---------- document storage (same calls the Claude page's storage offers) ----------
  const listeners = new Map();   // collection -> Set of refresh functions
  const timers = new Map();
  const changed = (c) => {        // after writes, refresh open views of that collection once things settle
    clearTimeout(timers.get(c));
    timers.set(c, setTimeout(() => (listeners.get(c) || new Set()).forEach(f => f()), 600));
  };
  const OPS = { "==": "=", "<": "<", "<=": "<=", ">": ">", ">=": ">=", "!=": "<>" };
  const snapOf = (rows) => {
    const docs = (rows || []).map(r => ({ id: r.id, exists: true, data: () => r.data }));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [] };
  };
  function query(c, wh, ord, lim) {
    const api = {
      where: (f, op, v) => query(c, wh.concat([[f, op, v]]), ord, lim),
      orderBy: (f, dir) => query(c, wh, [f, dir === "desc" ? "desc" : "asc"], lim),
      limit: (n) => query(c, wh, ord, n),
      async get() {
        const J = window.JT;
        let s = `select id, data from jt.docs where collection = ${J.q(c)}`;
        for (const [f, op, v] of wh) {
          if (!OPS[op]) throw { code: "bad_request", message: "unsupported filter " + op };
          s += ` and (data ->> ${J.q(f)}) ${OPS[op]} ${J.q(String(v))}`;
        }
        s += ord ? ` order by data ->> ${J.q(ord[0])} ${ord[1]}` : " order by id";
        if (lim) s += ` limit ${J.int(lim)}`;
        return snapOf(await J.run(s, true));
      },
      onSnapshot(cb, err) {
        const f = () => api.get().then(cb, e => err && err(e));
        f();
        const set = listeners.get(c) || new Set(); set.add(f); listeners.set(c, set);
        return () => set.delete(f);
      },
      doc(id) {
        return {
          id,
          async get() {
            const J = window.JT;
            const r = await J.run(`select id, data from jt.docs where collection = ${J.q(c)} and id = ${J.q(id)}`, true);
            return r[0] ? { exists: true, id, data: () => r[0].data } : { exists: false, id, data: () => undefined };
          },
          async set(body) { await write("jt_doc_set", { p_collection: c, p_id: String(id), p_data: body }); changed(c); },
          async update(body) { const cur = await this.get(); await this.set(Object.assign({}, cur.exists ? cur.data() : {}, body)); },
          async delete() { await write("jt_doc_delete", { p_collection: c, p_id: String(id) }); changed(c); },
        };
      },
    };
    return api;
  }
  const docs = { collection: (c) => query(c, [], null, null) };

  // ---------- downloads ----------
  const downloads = {
    async save({ filename, data, mimeType }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType || (/\.csv$/i.test(filename) ? "text/csv" : "application/octet-stream") });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename || "download";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    },
  };

  const noShopify = { async callTool() { throw { code: "not_in_manifest", message: "Live Shopify calls aren't available on the web version." }; } };
  window.claude = {
    use(name) {
      if (name === "mcp") return ready.then(() => noShopify);
      if (name === "db") return ready.then(() => docs);
      if (name === "downloads") return Promise.resolve(downloads);
      return Promise.resolve(null);
    },
  };
  window.JTWeb = { ready, rpc, sql, write, clearCache: () => cache.clear() };
})();
