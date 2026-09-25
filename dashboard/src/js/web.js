(() => {
  // Web version (dashboard.andersenlifestyle.com). Inside Claude this file does nothing.
  // On the web it signs in with Supabase Auth and stands in for what the Claude host provides:
  //   window.claude.use("mcp")       -> only lets the page know the database is ready (Shopify is not called from the web)
  //   window.claude.use("db")        -> the page's document storage (JT.docStore in db.js: Supabase table jt.docs)
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
      // lock: run auth steps directly. The default browser lock can leave requests waiting forever after the tab
      // sleeps or refreshes its session, which froze the page ("nothing happens" on clicks).
      sb = mod.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
        lock: async (_name, _timeout, fn) => fn() } });
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
  // Every request gives up after 30 seconds, so nothing can hang the page.
  async function rpc(fn, args) {
    await ready;
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej({ code: "server_unavailable", message: "The database took too long to answer.", retryable: true }), 30000); });
    try {
      const { data, error } = await Promise.race([sb.rpc(fn, args), timeout]);
      if (error) throw toErr(error);
      return data;
    } finally { clearTimeout(timer); }
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
      if (name === "db") return ready.then(() => window.JT.docStore());
      if (name === "downloads") return Promise.resolve(downloads);
      return Promise.resolve(null);
    },
  };
  window.JTWeb = { ready, rpc, sql, write, clearCache: () => cache.clear() };
})();
