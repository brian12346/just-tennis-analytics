// To do list — the home screen (Brian, Oct 14: "rather than metrics, it's a to do screen. people can put things on
// there so you know what is important today / schedule work"). To-dos live in jt.todos (migration 143): a title, an
// owner, a day (none = later), important or not, notes, and what it opens. Seller Sage suggests to-dos from what's
// waiting (jt.todo_suggestions: orders to approve, invoices with import issues, invoices to receive …); "+ To do" turns
// one into a to-do, and it ticks itself off once that's done (jt.todo_autoclose, run when the page opens).
// Each person's own list, semi-private (migration 144): you see your to-dos and the ones you gave someone else, and
// nobody browses another person's list (jt.todo_visible works out who's asking from the sign-in). Owners are Seller
// Sage users (email). In the Claude version there's no sign-in, so "Viewing as" picks whose list to show.
// The layout is a starting point: Brian changes it by asking Claude.
(() => {
  const $ = (id) => document.getElementById(id);
  if (!$("tab-todo")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const COLS = ["id::text", "title", "notes", "owner", "due_on::text", "important", "link", "source", "done_at::text", "done_by", "created_at::text", "created_by"];
  const S = { shown: false, loading: false, err: null, items: null, sugg: null, people: [], me: "", web: false, who: "mine", form: null, showDone: false, suggAll: false, closed: 0 };

  // ---------- dates (the browser's own day: the team is in San Diego) ----------
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
  const today = () => ymd(new Date());
  const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return ymd(d); };
  const dayName = (s) => new Date(s + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const daysLate = (s) => Math.round((new Date(today() + "T12:00:00") - new Date(s + "T12:00:00")) / 864e5);
  const nameOf = (email) => { const n = String(email || "").replace(/@.*/, ""); return n ? n.charAt(0).toUpperCase() + n.slice(1) : ""; };
  const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

  async function load(refresh) {
    if (!window.JT || !window.JT.todo) return;
    S.loading = true; render();
    try {
      // first: to-dos whose Seller Sage item got done are ticked off
      try { S.closed = await window.JT.todo.autoclose(); } catch (_) { S.closed = 0; }
      const [items, sugg] = await Promise.all([
        window.JT.rows(COLS, "from jt.todo_visible() where done_at is null or done_at > now() - interval '7 days' order by id", true),
        window.JT.rows(["key", "kind", "title", "link", "detail", "since::text", "taken_by"], "from jt.todo_suggest() order by since nulls last", true).catch(() => []),
      ]);
      S.items = items.map(r => ({ id: r[0], title: r[1] || "", notes: r[2] || "", owner: r[3] || "", due: r[4] || "", important: !!r[5], link: r[6] || "", source: r[7] || "",
        doneAt: r[8] || "", doneBy: r[9] || "", created: r[10] || "", createdBy: r[11] || "" }));
      S.sugg = sugg.map(r => ({ key: r[0], kind: r[1], title: r[2] || "", link: r[3] || "", detail: r[4] || "", since: r[5] || "", takenBy: r[6] || "" }));
      if (!S.people.length && window.JT.alerts && window.JT.alerts.people) S.people = (await window.JT.alerts.people(refresh)).map(e => String(e || "").toLowerCase()).filter(Boolean);
      if (!S.web && !S.me) { S.me = pickedMe() || S.people[0] || ""; }
      S.err = null;
    } catch (e) { S.err = e; }
    S.loading = false; render(); badge();
  }

  // ---------- which to-dos ----------
  const open = () => (S.items || []).filter(t => !t.doneAt);
  const mine = (t) => !!S.me && same(t.owner, S.me);
  const gave = (t) => !!S.me && same(t.createdBy, S.me) && !same(t.owner, S.me);
  const shown = (t) => S.who === "gave" ? gave(t) : mine(t);
  const who = (email) => same(email, S.me) ? "Me" : nameOf(email) || "—";
  // the Claude version: whose list to show (remembered on this device)
  const pickedMe = () => { try { return localStorage.getItem("jt-todo-me") || ""; } catch (_) { return ""; } };
  const bucket = (t) => t.due && t.due <= today() ? "today" : t.due && t.due <= plus(7) ? "week" : "later";
  const order = (a, b) => (b.important - a.important) || String(a.due || "9999").localeCompare(String(b.due || "9999")) || Number(a.id) - Number(b.id);
  const LINK = (l) => { const [k, id] = String(l || "").split(":"); return k === "po" ? "Order" : k === "invoice" ? "Invoice" : l ? l : ""; };
  const KIND = { approve: ["Approve", "warn"], submit: ["Submit", "pos"], invfix: ["Invoice issue", "miss"], invpo: ["Build PO", "pos"], receive: ["Receive", "manual"], qbo: ["QuickBooks", "ok"] };

  function itemHtml(t) {
    if (S.form && S.form.id === t.id) return formHtml();
    const late = t.due && t.due < today() ? daysLate(t.due) : 0;
    const when = !t.due ? "" : t.due === today() ? "today" : late ? `${late} day${late === 1 ? "" : "s"} late` : t.due === plus(1) ? "tomorrow" : dayName(t.due);
    return `<div class="td-item ${t.important ? "imp" : ""} ${late ? "late" : ""}">
      <button class="td-check" type="button" data-td-done="${esc(t.id)}" title="Mark done" aria-label="Mark ${esc(t.title)} done"></button>
      <div class="td-body"><button class="td-title" type="button" data-td-edit="${esc(t.id)}" title="Edit">${t.important ? '<span class="td-star" aria-label="Important">★</span> ' : ""}${esc(t.title)}</button>
        <div class="td-meta">${[gave(t) ? `<span class="td-who">for ${esc(who(t.owner))}</span>` : t.createdBy.includes("@") && !same(t.createdBy, t.owner) ? `<span class="td-from">from ${esc(nameOf(t.createdBy))}</span>` : "",
          when ? `<span class="${late ? "td-late" : ""}">${esc(when)}</span>` : "", t.link ? `<button class="linkbtn small" type="button" data-td-go="${esc(t.link)}">${esc(LINK(t.link))} →</button>` : ""].filter(Boolean).join(" · ")}${t.source ? ' <span class="pill pos" title="From Seller Sage — ticks itself off when done">auto</span>' : ""}</div>
        ${t.notes ? `<div class="td-notes">${esc(t.notes)}</div>` : ""}</div></div>`;
  }
  function formHtml() {
    const f = S.form, ppl = [...new Set([S.me, ...S.people, f.owner].filter(Boolean).map(e => e.toLowerCase()))];
    const quick = [["today", "Today", today()], ["tomorrow", "Tomorrow", plus(1)], ["monday", "Next Monday", nextMonday()], ["none", "No date", ""]];
    return `<form class="td-form" id="td-form" autocomplete="off">
      <input class="inp td-ftitle" id="td-ftitle" value="${esc(f.title)}" placeholder="What needs doing?" aria-label="To-do" required>
      <div class="td-frow">
        <label class="stack small">For<select class="inp" id="td-fowner" style="width:auto;min-width:130px">${ppl.map(p => `<option value="${esc(p)}" ${same(p, f.owner || S.me) ? "selected" : ""}>${esc(who(p))}</option>`).join("")}</select></label>
        <div class="stack small"><span>When</span><span class="seg sm" role="group" aria-label="When">${quick.map(([k, n, d]) => `<button type="button" data-td-when="${esc(d)}" aria-pressed="${f.due === d}">${n}</button>`).join("")}</span></div>
        <label class="stack small">Day<input class="inp" type="date" id="td-fdue" value="${esc(f.due)}"></label>
        <label class="td-imp small"><input type="checkbox" id="td-fimp" ${f.important ? "checked" : ""}> ★ Important</label>
      </div>
      <textarea class="inp" id="td-fnotes" rows="2" placeholder="Notes (optional)">${esc(f.notes)}</textarea>
      <div class="row"><button class="btn primary" type="submit">${f.id ? "Save" : "Add to-do"}</button><button class="btn" type="button" data-td-cancel>Cancel</button>${f.id ? `<button class="btn right" type="button" data-td-del="${esc(f.id)}">Delete</button>` : ""}</div>
    </form>`;
  }

  function render() {
    if ($("tab-todo").hidden) return;
    const all = open(), vis = all.filter(shown).sort(order);
    const st = $("td-status");
    st.textContent = S.err ? "Couldn't load the to do list: " + (window.JT.message ? window.JT.message(S.err) : String(S.err)) : !S.items ? "Loading…"
      : `${dayName(today())} · ${vis.filter(t => bucket(t) === "today").length} for today${S.closed ? ` · Seller Sage ticked off ${S.closed} that ${S.closed === 1 ? "was" : "were"} done` : ""}`;
    // my list, or what I gave others (to follow up); the Claude version also picks whose list
    const nGave = all.filter(gave).length;
    $("td-who").innerHTML = `<button type="button" data-td-who="mine" aria-pressed="${S.who === "mine"}">My list <span class="cnt">${all.filter(mine).length}</span></button><button type="button" data-td-who="gave" aria-pressed="${S.who === "gave"}" title="To-dos you gave someone else">I assigned <span class="cnt">${nGave}</span></button>`;
    const va = $("td-as"); if (va) { va.hidden = S.web || S.people.length < 2; va.innerHTML = `Viewing as <select class="inp" id="td-asme" style="width:auto">${S.people.map(p => `<option value="${esc(p)}" ${same(p, S.me) ? "selected" : ""}>${esc(nameOf(p))}</option>`).join("")}</select>`; }
    // the add form (new) sits above the columns
    $("td-new").innerHTML = S.form && !S.form.id ? formHtml() : "";
    // suggestions
    // one person has each suggestion: hidden once it's on my list, "Brittany has it" when it's on someone else's
    const sg = (S.sugg || []).filter(s => !same(s.takenBy, S.me)).sort((a, b) => !!a.takenBy - !!b.takenBy);
    const sgShow = S.suggAll ? sg : sg.slice(0, 6);
    $("td-sugg").innerHTML = !sg.length ? "" : `<div class="td-sugg-h"><b>From Seller Sage</b> <span class="muted small">${sg.filter(s => !s.takenBy).length} waiting — add the ones you'll do to your list</span></div>
      <div class="td-sugg-list">${sgShow.map(s => { const k = KIND[s.kind] || [s.kind, "pos"];
        return `<div class="td-sg"><span class="pill ${k[1]}">${esc(k[0])}</span><button class="linkbtn td-sgt" type="button" data-td-go="${esc(s.link)}">${esc(s.title)}</button><span class="muted small">${esc(s.detail)}</span>${s.takenBy ? `<span class="pill pos" title="On ${esc(nameOf(s.takenBy))}'s to do list">${esc(nameOf(s.takenBy))} has it</span>` : `<button class="mini" type="button" data-td-take="${esc(s.key)}" title="Add to my list, for today">+ My list</button>`}</div>`; }).join("")}</div>
      ${sg.length > 6 ? `<button class="linkbtn small" type="button" data-td-sall>${S.suggAll ? "Show fewer" : `Show all ${sg.length}`}</button>` : ""}`;
    // columns
    const cols = [["today", "Today", "and anything late"], ["week", "Next 7 days", ""], ["later", "Later", "or no date"]];
    $("td-cols").innerHTML = cols.map(([k, n, sub]) => { const ts = vis.filter(t => bucket(t) === k);
      return `<section class="td-col td-${k}"><div class="td-col-h"><b>${n}</b><span class="il-cnt">${ts.length}</span>${sub ? `<span class="muted small">${sub}</span>` : ""}</div>
        <div class="td-list">${ts.map(itemHtml).join("") || `<div class="il-empty">${!S.items ? "Loading…" : k === "today" ? "Nothing for today" : "Nothing here"}</div>`}</div></section>`; }).join("");
    // done (last 7 days)
    const done = (S.items || []).filter(t => t.doneAt && shown(t)).sort((a, b) => b.doneAt.localeCompare(a.doneAt));
    $("td-done").innerHTML = !done.length ? "" : `<button class="linkbtn small" type="button" data-td-showdone>${S.showDone ? "Hide" : "Show"} done in the last 7 days (${done.length})</button>
      ${S.showDone ? `<div class="td-donelist">${done.map(t => `<div class="td-item done"><button class="td-check on" type="button" data-td-undo="${esc(t.id)}" title="Not done" aria-label="Mark ${esc(t.title)} not done">✓</button><div class="td-body"><span class="td-title">${esc(t.title)}</span><div class="td-meta">${esc(who(t.owner))} · done ${esc(dayName(t.doneAt.slice(0, 10)))}${t.doneBy ? " by " + esc(t.doneBy.includes("@") ? who(t.doneBy) : t.doneBy) : ""}</div></div></div>`).join("")}</div>` : ""}`;
    if (S.form && S.form.focus) { S.form.focus = false; const i = $("td-ftitle"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  }
  // the To do button in the top bar shows how many of mine are for today (or late)
  function badge() {
    const b = document.querySelector('.appbar .ws.home'); if (!b) return;
    let el = b.querySelector(".td-badge"); const n = open().filter(t => mine(t) && bucket(t) === "today").length;
    if (!el) { el = document.createElement("span"); el.className = "td-badge"; b.appendChild(el); }
    el.textContent = n ? String(n) : ""; el.hidden = !n;
  }

  // ---------- actions ----------
  const note = (kind, html) => { const n = $("td-note"); n.className = "note " + (kind || ""); n.innerHTML = html; n.hidden = !html; };
  function readForm() {
    const f = S.form; if (!f) return null;
    f.title = ($("td-ftitle") || {}).value || ""; f.owner = ($("td-fowner") || {}).value || S.me; f.due = ($("td-fdue") || {}).value || "";
    f.important = !!($("td-fimp") || {}).checked; f.notes = ($("td-fnotes") || {}).value || "";
    return f;
  }
  async function saveForm() {
    const f = readForm(); if (!f || !f.title.trim()) { note("warn", "Give the to-do a title."); return; }
    try {
      await window.JT.todo.save({ id: f.id || null, by: S.me, title: f.title.trim(), owner: f.owner.trim(), due_on: f.due, important: f.important, notes: f.notes.trim(), link: f.link || "", source: f.source || "" });
      S.form = null; note("", ""); await load(true);
    } catch (e) { note("bad", "Couldn't save: " + esc(window.JT.message(e))); }
  }
  async function act(fn, msg) { try { await fn(); await load(true); if (msg) note("info", msg); } catch (e) { note("bad", esc(window.JT.message(e))); } }
  function go(link) {
    const [k, id] = String(link || "").split(":");
    if (k === "po" && window.JTPO) return window.JTPO.open(id);
    if (k === "invoice" && window.JTInvoices) return window.JTInvoices.open(id);
    const b = document.querySelector(`.tabs button[data-tab="${CSS.escape(k)}"]`); if (b) b.click();
  }

  $("td-add").addEventListener("click", () => { S.form = { id: null, title: "", owner: S.me, due: today(), important: false, notes: "", link: "", source: "", focus: true }; render(); });
  $("tab-todo").addEventListener("submit", (e) => { if (e.target.id === "td-form") { e.preventDefault(); saveForm(); } });
  $("tab-todo").addEventListener("click", (e) => {
    const t = e.target, q = (sel) => t.closest(sel);
    let b;
    if ((b = q("[data-td-who]"))) { S.who = b.dataset.tdWho; render(); badge(); return; }
    if ((b = q("[data-td-when]"))) { readForm(); S.form.due = b.dataset.tdWhen; render(); return; }
    if (q("[data-td-cancel]")) { S.form = null; render(); return; }
    if ((b = q("[data-td-del]"))) { const id = b.dataset.tdDel; S.form = null; return act(() => window.JT.todo.remove(id), "To-do deleted."); }
    if ((b = q("[data-td-edit]"))) { const it = (S.items || []).find(x => x.id === b.dataset.tdEdit); if (it) { S.form = { ...it, due: it.due, focus: true }; render(); } return; }
    if ((b = q("[data-td-done]"))) { const it = (S.items || []).find(x => x.id === b.dataset.tdDone); b.classList.add("on"); return act(() => window.JT.todo.done(b.dataset.tdDone, true, S.me), it ? `Done: ${esc(it.title)}. <button class="linkbtn" type="button" data-td-undo="${esc(it.id)}">Undo</button>` : ""); }
    if ((b = q("[data-td-undo]"))) { note("", ""); return act(() => window.JT.todo.done(b.dataset.tdUndo, false, S.me)); }
    if ((b = q("[data-td-take]"))) { const s = (S.sugg || []).find(x => x.key === b.dataset.tdTake); if (!s) return;
      return act(() => window.JT.todo.save({ by: S.me, title: s.title, owner: S.me, due_on: today(), link: s.link, source: s.key, notes: s.detail }), `On your list for today: ${esc(s.title)}. Click it to change the day or give it to someone.`); }
    if ((b = q("[data-td-go]"))) { go(b.dataset.tdGo); return; }
    if (q("[data-td-sall]")) { S.suggAll = !S.suggAll; render(); return; }
    if (q("[data-td-showdone]")) { S.showDone = !S.showDone; render(); return; }
  });
  $("td-refresh").addEventListener("click", () => load(true));
  $("tab-todo").addEventListener("change", (e) => { if (e.target.id === "td-asme") { S.me = e.target.value; try { localStorage.setItem("jt-todo-me", S.me); } catch (_) {} S.form = null; render(); badge(); } });

  // who's signed in (the web app fills #whoami once sign-in finishes)
  const signedIn = () => (window.JTWeb && window.JTWeb.ready ? window.JTWeb.ready : Promise.resolve()).then(() => { const em = (($("whoami") || {}).textContent || "").trim().toLowerCase(); if (em) { S.me = em; S.web = true; } });
  window.todoShow = async () => {
    await signedIn();
    if (!S.shown) { S.shown = true; if (!S.items && !S.loading) load(false); else render(); } else { render(); load(true); }
  };
  // the badge once signed in, then every 5 minutes while another page is open
  signedIn().then(() => { if (!S.items && !S.loading) load(false); });
  setInterval(() => { if ($("tab-todo").hidden) load(true); }, 5 * 60000);
  if (!$("tab-todo").hidden) setTimeout(() => window.todoShow(), 0);
})();
