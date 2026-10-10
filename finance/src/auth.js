// Sign-in and database access for the finance dashboard. Same Supabase project and accounts as the sales dashboard,
// but every read goes through public.fin_sql, which only answers accounts on the finance list (fin.users).
(() => {
  const SB_URL = "https://ppmzrlqvrhzfxobvnlon.supabase.co";
  const SB_KEY = "sb_publishable_nPVLpNx1vs2qfpEK7nFmag_5Z3NqDYb";   // publishable key: safe in the page, grants nothing by itself
  const LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
  const $ = (id) => document.getElementById(id);
  let sb = null, readyResolve;
  const ready = new Promise(r => { readyResolve = r; });

  const show = (which) => { for (const id of ["login", "noaccess", "app"]) $(id).hidden = id !== which; document.body.classList.toggle("signed-out", which !== "app"); };
  function login(msg) { show("login"); $("login-msg").textContent = msg || ""; setTimeout(() => $("login-email").focus(), 0); }
  async function signedIn(session) {
    let allowed = false;
    try { const { data } = await sb.rpc("fin_whoami"); allowed = !!(data && data.allowed); } catch (_) {}
    if (!allowed) { $("noaccess-who").textContent = session.user.email || "This account"; show("noaccess"); return; }
    $("whoami").textContent = session.user.email || "";
    show("app");
    readyResolve();
  }
  async function boot() {
    try {
      const mod = await import(LIB);
      sb = mod.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "jt-finance-auth",
        lock: async (_n, _t, fn) => fn() } });
    } catch (e) { login("Couldn't load the sign-in library. Check your connection and reload."); return; }
    const { data } = await sb.auth.getSession();
    if (data && data.session) signedIn(data.session); else login();
    sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") location.reload(); });
  }
  document.addEventListener("DOMContentLoaded", () => {
    $("login-form").addEventListener("submit", async (ev) => {
      ev.preventDefault(); if (!sb) return;
      const btn = $("login-go"); btn.disabled = true; $("login-msg").textContent = "Signing in…";
      const { data, error } = await sb.auth.signInWithPassword({ email: $("login-email").value.trim(), password: $("login-pass").value });
      btn.disabled = false;
      if (error) { $("login-msg").textContent = /invalid/i.test(error.message) ? "Email or password is wrong." : error.message; return; }
      $("login-pass").value = ""; $("login-msg").textContent = "";
      signedIn(data.session);
    });
    document.querySelectorAll("[data-signout]").forEach(b => b.addEventListener("click", async () => { cache.clear(); if (sb) await sb.auth.signOut(); location.reload(); }));
    boot();
  });

  const toErr = (e) => {
    const m = (e && e.message) || String(e);
    if ((e && e.code === "42501") || /not allowed/i.test(m)) return { code: "not_allowed", message: "This account doesn't have finance access." };
    return { code: "error", message: m };
  };
  async function rpc(fn, args) {
    await ready;
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej({ message: "The database took too long to answer." }), 30000); });
    try { const { data, error } = await Promise.race([sb.rpc(fn, args), timeout]); if (error) throw toErr(error); return data; }
    finally { clearTimeout(timer); }
  }
  // reads are kept 10 minutes; Refresh clears them
  const cache = new Map();
  async function sql(q, refresh) {
    const hit = cache.get(q);
    if (!refresh && hit && Date.now() - hit.t < 600000) return hit.v;
    const v = await rpc("fin_sql", { q });
    cache.set(q, { t: Date.now(), v });
    return v;
  }
  async function fn(name, body) {
    await ready;
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      let b = null; try { b = error.context && typeof error.context.json === "function" ? await error.context.json() : null; } catch (_) {}
      if (b) return b;
      throw toErr(error);
    }
    return data;
  }
  function download(filename, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" })); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  async function write(fn, args) { const v = await rpc(fn, args); cache.clear(); return v; }
  window.FIN = { ready, sql, fn, write, download, clear: () => cache.clear() };
  // pages: #payables (default), #cash, #fba, #profit
  const PAGES = ["payables", "cash", "fba", "profit"];
  function route() {
    const h = (location.hash || "#payables").slice(1), page = PAGES.includes(h) ? h : "payables";
    for (const id of PAGES) document.getElementById(id).hidden = id !== page;
    document.querySelectorAll(".nav a[data-page]").forEach(a => { const on = a.dataset.page === page; a.classList.toggle("on", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    window.dispatchEvent(new CustomEvent("fin:page", { detail: page }));
  }
  window.addEventListener("hashchange", route);
  document.addEventListener("DOMContentLoaded", route);
})();
