(() => {
  // Back / forward / recent (Brian, Oct 20: "clean up the small nav stuff so we can easily go back and forth on what we
  // are working on ... it's silly we don't have a good back button").
  //   * Every place you work on has its own address: a page (#po, #prep), a purchase order (#po/41), an invoice
  //     (#invoices/12), a prep shipment (#prep/ship/7) or a product (#prep/product/<variant>). Going to a new place adds
  //     a history entry, so the browser's Back / Forward (and a phone's back swipe) walk through what you looked at.
  //   * The ← button in the top bar goes back and says where to ("Back to Head · Oct Ti.S6"); → goes forward.
  //   * Recent: the last places worked on (POs, invoices, shipments, products), kept per browser.
  // Pages tell this where they are with JTNav.at(hash, title); they handle coming back to a place with
  // JTNav.on(page, fn(rest)). Small view changes that aren't places keep using replaceState.
  const $ = (id) => document.getElementById(id);
  const RKEY = "jt-nav-recent", RMAX = 12;
  const handlers = new Map(), closers = [];
  let stack = [], pos = -1, seq = 0;
  // while going back/forward (or opening a link), the pages redraw on their way to the place; their in-between
  // addresses are ignored until the target is reached
  let target = null, targetT = 0, booting = true;
  const KIND = [[/^#po\/\d+/, "PO"], [/^#invoices\/\d+/, "Invoice"], [/^#prep\/ship\/\d+/, "Shipment"], [/^#prep\/product\/\d+/, "Product"]];
  const kindOf = (h) => (KIND.find(([re]) => re.test(h)) || [, ""])[1];
  const tabLabel = (t) => { const b = document.querySelector(`.tabs button[data-tab="${t}"]`); return b ? b.textContent.trim().replace(/\s+/g, " ") : t; };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function readRecent() { try { return JSON.parse(localStorage.getItem(RKEY)) || []; } catch (_) { return []; } }
  function remember(h, title) {
    if (!kindOf(h) || !title) return;
    const r = readRecent().filter(x => x.h !== h);
    r.unshift({ h, t: title, k: kindOf(h), at: Date.now() });
    try { localStorage.setItem(RKEY, JSON.stringify(r.slice(0, RMAX))); } catch (_) {}
  }
  function titleOf(h, title) { return title || tabLabel(h.replace(/^#/, "").split("/")[0] || "todo"); }

  function at(hash, title) {
    hash = hash || "#";
    const t = titleOf(hash, title);
    if (target != null) {
      if (Date.now() - targetT > 20000) target = null;
      else if (hash !== target) return;                                  // on the way to where Back is going
      else target = null;
    }
    if (booting) {                                                       // the page settling on the address it opened with
      booting = false;
      try { history.replaceState({ jt: stack[0].n }, "", hash); } catch (_) {}
      stack[0] = { ...stack[0], h: hash, t }; setTitle(); paint(); remember(hash, title); return;
    }
    { const pg = (h) => (h || "").replace(/^#/, "").split("/")[0], was = stack[pos] && pg(stack[pos].h);
      if (was && was !== pg(hash)) for (const fn of closers) try { fn(pg(hash), ""); } catch (_) {} }   // a popup doesn't follow you to another page
    if (pos >= 0 && stack[pos] && stack[pos].h === hash) { stack[pos].t = t; setTitle(); paint(); remember(hash, title); return; }
    if (location.hash === hash && pos >= 0) { stack[pos] = { h: hash, t, n: stack[pos].n }; paint(); remember(hash, title); return; }
    const n = ++seq;
    try { history.pushState({ jt: n }, "", hash); } catch (_) { return; }
    stack = stack.slice(0, pos + 1); stack.push({ h: hash, t, n }); pos = stack.length - 1;
    setTitle(); paint(); remember(hash, title);
  }
  // a view change that isn't a new place (keeps the entry, updates its address)
  function replace(hash, title) {
    target = null;
    try { history.replaceState(history.state, "", hash); } catch (_) {}
    if (pos >= 0) stack[pos] = { ...stack[pos], h: hash, t: titleOf(hash, title) }; setTitle(); paint();
  }
  function setTitle() { const c = stack[pos]; document.title = (c && c.t && c.h !== "#todo" ? c.t + " · " : "") + "Seller Sage"; }

  // go to a place: the page switches, then its handler opens the thing
  function route(h) {
    h = h || "#";
    const m = /^#([a-z]+)(?:\/(.*))?$/i.exec(h); if (!m) return;
    const page = m[1], rest = m[2] || "";
    target = h; targetT = Date.now(); booting = false;
    for (const fn of closers) try { fn(page, rest); } catch (_) {}
    const tabBtn = document.querySelector(`.tabs button[data-tab="${page}"]`), tabEl = $("tab-" + page);
    if (tabBtn && tabEl && tabEl.hidden) tabBtn.click();
    else if (h === "#" + page) at(h);                                     // the page is already showing: just record it
    const fn = handlers.get(page);
    if (fn) try { fn(rest); } catch (_) {}
    setTimeout(() => { if (target === h && location.hash === h && (!rest || !fn)) target = null; }, 1500);
  }
  // a page with unsaved changes can hold navigation (JTNav.guard(fn): fn(resume) returns true to stay put; resume() carries
  // on to where the person was going — called when they choose Discard changes, Oct 29: "the nav should go to the next page")
  let guard = null, undoing = false;
  const held = (resume) => !!(guard && guard(resume || null));
  function go(h) { if (!h) return; if (held(() => go(h))) return; if (h === location.hash) return route(h); at(h); route(h); }

  window.addEventListener("popstate", (e) => {
    const n = e.state && e.state.jt, i = n ? stack.findIndex(x => x.n === n) : -1;
    if (undoing) { undoing = false; return; }
    const to = location.hash;
    if (held(() => go(to))) { undoing = true; if (i > pos) history.back(); else history.forward(); return; }   // the browser's Back/Forward: step back to where we were
    if (i >= 0) pos = i;
    else { const ent = { h: location.hash, t: titleOf(location.hash), n: ++seq }; stack = stack.slice(0, pos + 1); stack.push(ent); pos = stack.length - 1;
      try { history.replaceState({ jt: ent.n }, "", location.hash); } catch (_) {} }
    route(location.hash); setTitle(); paint();
  });

  // ---------- the buttons ----------
  function paint() {
    const b = $("nav-back"), f = $("nav-fwd"); if (!b) return;
    const p = stack[pos - 1], nx = stack[pos + 1];
    b.disabled = !p; f.disabled = !nx;
    b.title = p ? "Back to " + p.t : "Back"; f.title = nx ? "Forward to " + nx.t : "Forward";
    const lab = $("nav-backto"); if (lab) lab.textContent = p ? p.t : "";
  }
  function recentHtml() {
    const r = readRecent(), cur = location.hash;
    if (!r.length) return '<div class="nav-rempty">Purchase orders, invoices, shipments and products you open show up here.</div>';
    const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "now" : m < 60 ? m + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d"; };
    return r.map(x => `<button type="button" class="nav-ritem${x.h === cur ? " cur" : ""}" data-nav-go="${esc(x.h)}"><span class="nav-rk">${esc(x.k)}</span><span class="nav-rt">${esc(x.t)}</span><span class="nav-ra">${ago(x.at)}</span></button>`).join("");
  }
  function closeRecent() { const m = $("nav-rmenu"); if (m) m.hidden = true; const b = $("nav-recent"); if (b) b.setAttribute("aria-expanded", "false"); }
  document.addEventListener("DOMContentLoaded", () => {
    const back = $("nav-back"), fwd = $("nav-fwd"), rec = $("nav-recent"), menu = $("nav-rmenu");
    if (back) back.addEventListener("click", () => { if (stack[pos - 1] && !held(() => history.back())) history.back(); });
    if (fwd) fwd.addEventListener("click", () => { if (stack[pos + 1] && !held(() => history.forward())) history.forward(); });
    if (rec) rec.addEventListener("click", (e) => { e.stopPropagation(); const open = menu.hidden; menu.hidden = !open; rec.setAttribute("aria-expanded", String(open)); if (open) menu.innerHTML = recentHtml(); });
    if (menu) menu.addEventListener("click", (e) => { const g = e.target.closest("[data-nav-go]"); if (!g) return; closeRecent(); go(g.dataset.navGo); });
    document.addEventListener("click", (e) => { if (menu && !menu.hidden && !e.target.closest("#nav-rmenu")) closeRecent(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menu && !menu.hidden) closeRecent(); });
    paint();
    const bar = document.querySelector(".appbar");
    const setH = () => { if (bar) document.documentElement.style.setProperty("--appbar-h", bar.getBoundingClientRect().height + "px"); };
    setH(); window.addEventListener("resize", setH); if (bar && window.ResizeObserver) new ResizeObserver(setH).observe(bar);
  });

  // the first entry: the address the page was opened with (pages reach it as they load)
  { const h = location.hash || "", n = ++seq;
    try { history.replaceState({ jt: n }, "", location.href); } catch (_) {}
    stack = [{ h, t: titleOf(h || "#todo"), n }]; pos = 0;
    if (/\//.test(h)) { target = h; targetT = Date.now(); } }

  // password managers (LastPass, 1Password) filling the app's own fields made pages look edited, so leaving them asked
  // to save (Oct 29). Every input but sign-in / password ones is marked for them to leave alone.
  const noFill = (root) => { if (!root || !root.querySelectorAll) return; for (const i of root.querySelectorAll("input:not([data-lpignore]), textarea:not([data-lpignore])")) {
    if (i.type === "password" || i.type === "email" || /^(login|pwd)-/.test(i.id || "")) continue;
    i.setAttribute("data-lpignore", "true"); i.setAttribute("data-1p-ignore", ""); i.setAttribute("data-form-type", "other");
    if (!i.getAttribute("autocomplete")) i.setAttribute("autocomplete", "off"); } };
  const startNoFill = () => { noFill(document.body); new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches && n.matches("input, textarea")) noFill(n.parentNode); else noFill(n); } }).observe(document.body, { childList: true, subtree: true }); };
  if (document.body) startNoFill(); else document.addEventListener("DOMContentLoaded", startNoFill);
  window.JTNav = { guard: (fn) => { guard = fn; }, at, replace, go, on: (page, fn) => handlers.set(page, fn), onClose: (fn) => closers.push(fn),
    get current() { return stack[pos]; }, get target() { return target; }, done() { target = null; }, _s: () => ({ stack, pos, target }) };
})();
