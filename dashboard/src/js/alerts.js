// Alerts tab: operational alerts from jt.alerts (rules in jt.alert_rules, checked every 15 minutes by jt.refresh_alerts).
// Open alerts are grouped by rule, each with its owner and what to do; resolving asks what was done and why it
// happened, and the Patterns view turns that into what keeps going wrong and how fast it gets fixed.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const COLS = ["id", "rule", "key", "title", "detail", "severity", "link", "data", "status", "owner", "first_seen", "last_seen", "age",
    "acked_by", "snoozed_until", "resolved_at", "resolved_by", "resolution", "cause", "took"];
  const RCOLS = ["code", "category", "title", "description", "action", "owner", "enabled", "params", "sort"];
  const CAUSES = ["Stock count was wrong", "Sold faster than expected", "Vendor was late", "Carrier delay", "Listing or mapping setup",
    "A step in our process was missed", "Expected — not a problem", "Other"];
  const SEV = { critical: 0, warning: 1, info: 2 };
  const PARAM_LABELS = { warn_hours: "Warn after (hours)", crit_hours: "Critical after (hours)", warn_days: "Warn after (days)", crit_days: "Critical after (days)",
    grace_days: "Days of grace", hours: "After (hours)", min_units_30d: "Min. sold in 30 days", crit_units_30d: "Critical at sold in 30 days", days: "Fewer days of stock than", "low_cover.crit_days": "Warning below (days)" };
  const S = { shown: false, loading: false, err: null, rows: null, rules: [], pats: null, people: [], view: "open", cat: "all", q: "", sel: new Set(),
    open: new Set(), resolving: null, msg: null, busy: false, checkedAt: null, me: "" };

  const ago = (sec) => { sec = Number(sec) || 0; if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + "m"; if (sec < 86400 * 2) return Math.round(sec / 3600) + "h"; return Math.round(sec / 86400) + "d"; };
  const fmt = (s) => { if (!s) return ""; const [d, t] = s.split(" "); return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) + (t ? " " + t : ""); };
  const who = (e) => String(e || "").replace(/@.*/, "");
  const shopUrl = (pid, vid) => `https://admin.shopify.com/store/justtennis-822/products/${encodeURIComponent(pid)}${vid ? "/variants/" + encodeURIComponent(vid) : ""}`;
  const rule = (code) => S.rules.find(r => r.code === code) || { code, title: code, category: "", action: "", owner: "" };
  const live = (a) => a.status === "open" || a.status === "acked" || a.status === "snoozed";

  async function load(refresh) {
    if (!window.JT || !window.JT.alerts) return;
    S.loading = true; render();
    try {
      const [rows, rules] = await Promise.all([window.JT.alerts.list(refresh), window.JT.alerts.rules(refresh)]);
      S.rows = rows.map(r => Object.fromEntries(COLS.map((c, i) => [c, r[i]])));
      S.rules = rules.map(r => Object.fromEntries(RCOLS.map((c, i) => [c, r[i]])));
      S.err = null;
      if (!S.people.length) S.people = await window.JT.alerts.people(refresh);
      if (S.view === "patterns") await loadPatterns(refresh);
    } catch (e) { S.err = e; }
    S.loading = false;
    render(); badge();
  }
  async function loadPatterns(refresh) {
    const r = await window.JT.alerts.patterns(refresh);
    S.pats = r.map(x => ({ code: x[0], title: x[1], category: x[2], n30: +x[3], n90: +x[4], open: +x[5], resolved: +x[6], cleared: +x[7], median: x[8], causes: x[9] || [], repeats: x[10] || [], days: x[11] || [] }));
  }
  // the count on the nav button: open critical + warning
  async function badge(refresh) {
    const b = document.querySelector('.tabs button[data-tab="alerts"]'); if (!b) return;
    let n = null;
    if (S.rows) n = S.rows.filter(a => a.status === "open" && a.severity !== "info").length;
    else { try { const c = await window.JT.alerts.counts(refresh); n = (c.critical || 0) + (c.warning || 0); } catch (_) { return; } }
    let s = b.querySelector(".nbadge");
    if (!n) { if (s) s.remove(); return; }
    if (!s) { s = document.createElement("span"); s.className = "nbadge"; b.appendChild(s); }
    s.textContent = n > 99 ? "99+" : String(n);
    const crit = S.rows ? S.rows.some(a => a.status === "open" && a.severity === "critical") : true;
    s.classList.toggle("crit", crit);
  }

  function visible() {
    const q = S.q;
    return (S.rows || []).filter(a => {
      const r = rule(a.rule);
      if (S.cat !== "all" && r.category !== S.cat) return false;
      if (q && ![a.title, a.detail, a.key, a.owner, r.title, a.resolution].some(x => String(x || "").toLowerCase().includes(q))) return false;
      if (S.view === "open") return a.status === "open" || a.status === "acked";
      if (S.view === "mine") return live(a) && S.me && a.owner === S.me;
      if (S.view === "snoozed") return a.status === "snoozed";
      if (S.view === "resolved") return a.status === "resolved" || a.status === "cleared";
      return false;
    });
  }

  function linkBtn(a) {
    const l = a.link || {};
    if (l.url) return `<a class="mini btnlink" href="${esc(l.url)}" target="_blank" rel="noopener">Open</a>`;
    if (l.shopify) return `<a class="mini btnlink" href="${esc(shopUrl(l.shopify.product_id, l.shopify.variant_id))}" target="_blank" rel="noopener">Shopify</a>`;
    if (l.tab) return `<button class="mini" type="button" data-go="${a.id}">Go to it</button>`;
    return "";
  }
  function go(a) {
    const l = a.link || {};
    if (l.tab === "po" && window.JTPO) { window.JTPO.open(l.id); return; }
    if (l.tab === "amzmap" && l.skus && window.amzMapOnly) { window.amzMapOnly({ skus: l.skus, titles: {}, asins: {}, label: a.title, back: "alerts", backLabel: "Alerts" }); return; }
    const b = document.querySelector(`.tabs button[data-tab="${l.tab}"]`); if (b) b.click();
    if (l.tab === "fbm" && window.fbmFocus) window.fbmFocus({ filter: l.filter, q: l.q });
  }

  function render() {
    if ($("tab-alerts").hidden) return;
    const st = $("al-status");
    if (S.err && !S.rows) { st.textContent = "Couldn't load alerts: " + (window.JT.message ? window.JT.message(S.err) : (S.err.message || S.err)); return; }
    if (!S.rows) { st.textContent = "Loading alerts…"; return; }
    const openA = S.rows.filter(a => a.status === "open" || a.status === "acked");
    const by = (sev) => openA.filter(a => a.severity === sev).length;
    const res7 = S.rows.filter(a => a.status === "resolved" && a.resolved_at && (Date.now() - new Date(a.resolved_at.replace(" ", "T")).getTime()) < 7 * 86400000);
    const med = (() => { const t = res7.map(a => +a.took).sort((x, y) => x - y); return t.length ? t[Math.floor(t.length / 2)] : null; })();
    st.innerHTML = `${openA.length.toLocaleString()} open · checked every 15 minutes${S.checkedAt ? " · last check " + esc(S.checkedAt) : ""}${S.loading ? " · refreshing…" : ""}`;
    $("al-kpis").innerHTML = [
      { c: by("critical") ? "badk" : "", l: "Critical", v: by("critical"), s: "Fix today" },
      { c: by("warning") ? "warnk" : "", l: "Warnings", v: by("warning"), s: "This week" },
      { l: "Info", v: by("info"), s: "Worth a look" },
      { l: "Resolved, last 7 days", v: res7.length, s: med == null ? "—" : `half fixed within ${ago(med)}` },
    ].map(x => `<div class="kpi ${x.c || ""}"><span class="eyebrow">${x.l}</span><span class="v">${Number(x.v).toLocaleString()}</span><span class="s">${x.s}</span></div>`).join("");
    const nn = $("al-note"); nn.hidden = !S.msg; nn.innerHTML = S.msg ? `<div class="note ${S.msg[0]}">${S.msg[1]}</div>` : "";
    const body = $("al-body");
    if (S.view === "rules") { body.innerHTML = renderRules(); return; }
    if (S.view === "patterns") { body.innerHTML = S.pats ? renderPatterns() : '<p class="muted">Loading patterns…</p>'; return; }
    const list = visible();
    if (S.view === "resolved") { body.innerHTML = renderResolved(list); return; }
    // grouped by rule, worst first
    const groups = new Map();
    for (const a of list) { if (!groups.has(a.rule)) groups.set(a.rule, []); groups.get(a.rule).push(a); }
    const gs = [...groups.entries()].map(([code, items]) => ({ r: rule(code), items: items.sort((x, y) => (SEV[x.severity] - SEV[y.severity]) || (+y.age - +x.age)) }))
      .sort((x, y) => (SEV[x.items[0].severity] - SEV[y.items[0].severity]) || (x.r.sort - y.r.sort));
    for (const k of [...S.sel]) if (!list.some(a => String(a.id) === k)) S.sel.delete(k);
    const sel = list.filter(a => S.sel.has(String(a.id)));
    const bulk = sel.length ? `<div class="fbm-bulk al-bulk"><span><b>${sel.length}</b> selected</span><span class="dbtns">
        <button class="mini" type="button" data-bulk="ack">Got it</button>
        <button class="mini" type="button" data-bulk="snooze" data-days="1">Snooze 1 day</button><button class="mini" type="button" data-bulk="snooze" data-days="7">Snooze 1 week</button>
        <button class="mini primary" type="button" data-bulk="resolve">Resolve…</button>
        <input class="inp" list="al-people" placeholder="Assign to…" data-bulkassign aria-label="Assign selected to">
        <button class="mini" type="button" data-bulk="clear">Clear</button></span></div>` : "";
    body.innerHTML = bulk + (S.resolving && S.resolving.bulk ? resolveForm() : "") + (gs.length ? gs.map(g => group(g)).join("") :
      `<div class="panel"><p class="muted">${S.view === "open" ? "Nothing open." : S.view === "mine" ? (S.me ? "Nothing assigned to you." : "Sign in on the web version to see your own alerts.") : "Nothing snoozed."}</p></div>`)
      + `<datalist id="al-people">${[...new Set([...S.people, ...S.rules.map(r => r.owner), ...(S.rows || []).map(a => a.owner)].filter(Boolean))].map(p => `<option value="${esc(p)}">`).join("")}</datalist>`;
  }
  function group(g) {
    const { r, items } = g;
    const crit = items.filter(a => a.severity === "critical").length, isOpen = S.open.has(r.code) || items.length <= 6;
    const owners = [...new Set(items.map(a => a.owner).filter(Boolean))];
    const shown = isOpen ? items : items.slice(0, 6);
    const allSel = items.every(a => S.sel.has(String(a.id)));
    return `<section class="panel al-group">
      <div class="al-ghead"><label class="al-gsel"><input type="checkbox" data-gsel="${esc(r.code)}" ${allSel ? "checked" : ""} aria-label="Select all ${esc(r.title)}"></label>
        <div><h2>${esc(r.title)} <span class="al-count">${items.length}</span>${crit ? ` <span class="pill cx">${crit} critical</span>` : ""}</h2>
        <div class="muted small">${esc(r.action)}${owners.length ? ` · Owner: <b>${owners.map(o => esc(who(o))).join(", ")}</b>` : ` · <span class="warnt">No owner</span> — set one under Rules`}</div></div></div>
      <div class="al-list">${shown.map(row).join("")}</div>
      ${items.length > shown.length ? `<button class="mini" type="button" data-more="${esc(r.code)}">Show all ${items.length}</button>` : ""}
    </section>`;
  }
  function row(a) {
    const resolving = S.resolving && !S.resolving.bulk && S.resolving.ids[0] === a.id;
    const sev = `<span class="sev ${esc(a.severity)}" title="${esc(a.severity)}"></span>`;
    const state = a.status === "acked" ? `<span class="pill pos" title="${esc(a.acked_by ? "by " + a.acked_by : "")}">Seen</span>` : a.status === "snoozed" ? `<span class="pill pos">Snoozed to ${esc(fmt(a.snoozed_until))}</span>` : "";
    return `<div class="al-row ${S.sel.has(String(a.id)) ? "sel" : ""}">
      <input type="checkbox" data-sel="${a.id}" ${S.sel.has(String(a.id)) ? "checked" : ""} aria-label="Select">
      ${sev}
      <div class="al-main"><div class="al-title">${esc(a.title)} ${state}</div><div class="meta">${esc(a.detail)}</div>
        <div class="meta">for ${ago(a.age)} · since ${esc(fmt(a.first_seen))}${a.owner ? ` · ${esc(who(a.owner))}` : ""}</div></div>
      <div class="dbtns">${linkBtn(a)}${a.status === "open" ? `<button class="mini" type="button" data-act="ack" data-id="${a.id}">Got it</button>` : ""}
        <button class="mini" type="button" data-act="snooze" data-id="${a.id}" data-days="1">Snooze</button>
        <button class="mini primary" type="button" data-act="resolve" data-id="${a.id}">Resolve</button></div>
      ${resolving ? `<div class="al-resolve">${resolveForm()}</div>` : ""}
    </div>`;
  }
  function resolveForm() {
    const n = S.resolving.ids.length;
    return `<div class="al-form"><label>What was done${n > 1 ? ` (all ${n})` : ""}<textarea class="inp" id="al-res" rows="2" placeholder="e.g. Counted 4 on the shelf, fixed in Shopify">${esc(S.resolving.text || "")}</textarea></label>
      <label>Why did it happen?<select class="inp" id="al-cause"><option value="">Choose…</option>${CAUSES.map(c => `<option ${S.resolving.cause === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
      <div class="dbtns"><button class="mini primary" type="button" data-res="save" ${S.busy ? "disabled" : ""}>Resolve</button><button class="mini" type="button" data-res="cancel">Cancel</button></div></div>`;
  }
  function renderResolved(list) {
    const rows = list.sort((x, y) => String(y.resolved_at).localeCompare(String(x.resolved_at))).slice(0, 300);
    return `<section class="panel"><div class="panel-head"><h2>Resolved in the last 30 days</h2><span class="muted small">"Cleared" means the problem went away without anyone closing it.</span></div>
      <div class="tbl-wrap tall"><table class="al-t"><thead><tr><th class="l">Alert</th><th class="l">Closed</th><th class="l">What was done</th><th class="l">Why</th><th>Took</th><th></th></tr></thead><tbody>
      ${rows.map(a => `<tr><td class="l"><span class="sev ${esc(a.severity)}"></span> <b>${esc(rule(a.rule).title)}</b><div class="meta">${esc(a.title)}</div></td>
        <td class="l">${esc(fmt(a.resolved_at))}<div class="meta">${a.status === "cleared" ? "cleared on its own" : esc(who(a.resolved_by))}</div></td>
        <td class="l wrap">${esc(a.status === "cleared" ? "" : a.resolution)}</td><td class="l">${esc(a.cause)}</td><td>${ago(a.took)}</td>
        <td>${a.status !== "cleared" ? `<button class="mini" type="button" data-act="reopen" data-id="${a.id}">Reopen</button>` : ""}</td></tr>`).join("") || '<tr><td class="l dim" colspan="6">Nothing resolved yet.</td></tr>'}
      </tbody></table></div></section>`;
  }
  function spark(days) {
    const m = new Map(days.map(([d, n]) => [d, +n])), out = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); out.push(m.get(d) || 0); }
    const max = Math.max(1, ...out);
    return `<span class="al-spark" title="New alerts per day, last 30 days">${out.map(n => `<i style="height:${Math.round(2 + 18 * n / max)}px" class="${n ? "" : "z"}"></i>`).join("")}</span>`;
  }
  function renderPatterns() {
    const ps = S.pats.filter(p => S.cat === "all" || p.category === S.cat).sort((a, b) => b.n30 - a.n30 || b.open - a.open);
    return `<section class="panel"><div class="panel-head"><h2>What keeps going wrong</h2><span class="muted small">Last 90 days. Causes come from "Why did it happen?" when people resolve alerts — the more that's filled in, the more this shows.</span></div>
      <div class="tbl-wrap"><table class="al-t"><thead><tr><th class="l">Rule</th><th>New, 30 days</th><th class="l">Trend</th><th>Open now</th><th>Fixed by us</th><th>Cleared itself</th><th>Typical fix time</th><th class="l">Main causes</th><th class="l">Keeps coming back</th></tr></thead><tbody>
      ${ps.map(p => `<tr><td class="l"><b>${esc(p.title)}</b><div class="meta">${esc(p.category)}</div></td><td>${p.n30}</td><td class="l">${spark(p.days)}</td><td>${p.open}</td><td>${p.resolved}</td><td>${p.cleared}</td>
        <td>${p.median == null ? "—" : ago(p.median * 3600)}</td>
        <td class="l wrap">${p.causes.map(([c, n]) => `${esc(c)} <span class="dim">(${n})</span>`).join("<br>") || '<span class="dim">—</span>'}</td>
        <td class="l wrap">${p.repeats.map(([k, n, t]) => `${esc(t)} <span class="dim">×${n}</span>`).join("<br>") || '<span class="dim">—</span>'}</td></tr>`).join("")}
      </tbody></table></div></section>`;
  }
  function renderRules() {
    const rs = S.rules.filter(r => S.cat === "all" || r.category === S.cat);
    const people = [...new Set([...S.people, ...S.rules.map(r => r.owner)].filter(Boolean))];
    return `<section class="panel"><div class="panel-head"><h2>Rules</h2><span class="muted small">Who owns each kind of alert, and when it fires. New alerts go to the owner; changing the owner also moves open alerts that have no owner. Thresholds apply from the next check.</span></div>
      <div class="al-rules">${rs.map(r => `<div class="al-rule ${r.enabled ? "" : "off"}">
        <label class="al-on"><input type="checkbox" data-ron="${esc(r.code)}" ${r.enabled ? "checked" : ""}> On</label>
        <div class="al-rinfo"><div><b>${esc(r.title)}</b> <span class="al-cat">${esc(r.category)}</span></div><div class="meta">${esc(r.description)}</div><div class="meta"><b>To do:</b> ${esc(r.action)}</div></div>
        <label class="al-owner">Owner<input class="inp" list="al-people" data-rowner="${esc(r.code)}" value="${esc(r.owner)}" placeholder="Nobody yet"></label>
        <div class="al-params">${Object.entries(r.params || {}).map(([k, v]) => `<label class="al-param">${esc(PARAM_LABELS[r.code + "." + k] || PARAM_LABELS[k] || k)}<input class="inp" type="number" min="0" data-rparam="${esc(r.code)}" data-k="${esc(k)}" value="${esc(v)}"></label>`).join("")}</div>
      </div>`).join("")}</div>
      <datalist id="al-people">${people.map(p => `<option value="${esc(p)}">`).join("")}</datalist></section>`;
  }
  async function act(ids, action, extra) {
    if (S.busy || !ids.length) return;
    S.busy = true;
    try {
      await window.JT.alerts.act({ ids: ids.map(Number), action, ...(extra || {}) });
      // apply locally so the page answers at once; the reload brings the server's view
      for (const a of S.rows || []) if (ids.map(String).includes(String(a.id))) {
        if (action === "ack") a.status = "acked";
        if (action === "snooze") { a.status = "snoozed"; a.snoozed_until = new Date(extra.until).toISOString().slice(0, 16).replace("T", " "); }
        if (action === "resolve") { a.status = "resolved"; a.resolution = extra.resolution; a.cause = extra.cause; a.resolved_at = new Date().toISOString().slice(0, 16).replace("T", " "); a.took = a.age; }
        if (action === "reopen") a.status = "open";
        if (action === "assign") a.owner = extra.owner;
      }
      for (const k of ids) S.sel.delete(String(k));
      S.msg = null;
    } catch (e) {
      S.msg = ["bad", "Couldn't save: " + esc(window.JT.message ? window.JT.message(e) : (e.message || e))];
    }
    S.busy = false; render(); badge();
    if (window.JTWeb) window.JTWeb.clearCache();
    load(true);
  }
  const until = (days) => new Date(Date.now() + days * 86400000).toISOString();

  async function checkNow() {
    const b = $("al-check"); b.disabled = true; b.textContent = "Checking…";
    try {
      const r = await window.JT.alerts.check();
      S.msg = ["info", r ? `Checked: ${r.new} new, ${r.cleared} cleared on their own.` : "Checked."];
      S.checkedAt = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    } catch (e) { S.msg = ["bad", "Couldn't check: " + esc(window.JT.message ? window.JT.message(e) : (e.message || e))]; }
    b.disabled = false; b.textContent = "Check now";
    if (window.JTWeb) window.JTWeb.clearCache();
    load(true);
  }

  const tab = $("tab-alerts");
  tab.addEventListener("click", (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.go) { const x = (S.rows || []).find(r => String(r.id) === b.dataset.go); if (x) go(x); }
    else if (b.dataset.act === "resolve") { S.resolving = { ids: [+b.dataset.id] }; render(); const t = $("al-res"); if (t) t.focus(); }
    else if (b.dataset.act === "snooze") act([b.dataset.id], "snooze", { until: until(+b.dataset.days || 1) });
    else if (b.dataset.act) act([b.dataset.id], b.dataset.act);
    else if (b.dataset.bulk === "clear") { S.sel.clear(); render(); }
    else if (b.dataset.bulk === "snooze") act([...S.sel], "snooze", { until: until(+b.dataset.days || 1) });
    else if (b.dataset.bulk === "resolve") { S.resolving = { ids: [...S.sel].map(Number), bulk: true }; render(); const t = $("al-res"); if (t) t.focus(); }
    else if (b.dataset.bulk) act([...S.sel], b.dataset.bulk);
    else if (b.dataset.res === "cancel") { S.resolving = null; render(); }
    else if (b.dataset.res === "save") {
      const text = ($("al-res").value || "").trim(), cause = $("al-cause").value;
      if (!text) { S.resolving.text = ""; S.msg = ["warn", "Say what was done — that's what the team learns from."]; render(); return; }
      const ids = S.resolving.ids; S.resolving = null;
      act(ids, "resolve", { resolution: text, cause });
    }
    else if (b.dataset.more) { S.open.add(b.dataset.more); render(); }
    else if (b.id === "al-check") checkNow();
  });
  tab.addEventListener("change", async (ev) => {
    const t = ev.target;
    if (t.dataset.sel) { t.checked ? S.sel.add(t.dataset.sel) : S.sel.delete(t.dataset.sel); render(); }
    else if (t.dataset.gsel) { visible().filter(a => a.rule === t.dataset.gsel).forEach(a => t.checked ? S.sel.add(String(a.id)) : S.sel.delete(String(a.id))); render(); }
    else if (t.hasAttribute("data-bulkassign")) { const o = t.value.trim(); if (o) act([...S.sel], "assign", { owner: o }); }
    else if (t.id === "al-cause" && S.resolving) S.resolving.cause = t.value;
    else if (t.dataset.ron || t.dataset.rowner != null || t.dataset.rparam) {
      const code = t.dataset.ron || t.dataset.rowner || t.dataset.rparam;
      const p = { code };
      if (t.dataset.ron) p.enabled = t.checked;
      else if (t.dataset.rowner != null) p.owner = t.value.trim();
      else p.params = { [t.dataset.k]: Number(t.value) };
      try { await window.JT.alerts.ruleSet(p); S.msg = ["info", "Saved. Thresholds apply from the next check."]; }
      catch (e) { S.msg = ["bad", "Couldn't save the rule: " + esc(window.JT.message ? window.JT.message(e) : (e.message || e))]; }
      if (window.JTWeb) window.JTWeb.clearCache();
      load(true);
    }
  });
  tab.addEventListener("input", (ev) => { if (ev.target.id === "al-res" && S.resolving) S.resolving.text = ev.target.value; });
  $("al-seg").addEventListener("click", async (ev) => {
    const b = ev.target.closest("button[data-v]"); if (!b) return;
    S.view = b.dataset.v; S.sel.clear(); S.resolving = null; S.msg = null;
    $("al-seg").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    render();
    if (S.view === "patterns") { try { await loadPatterns(false); } catch (e) { S.msg = ["bad", "Couldn't load patterns."]; } render(); }
  });
  $("al-cat").addEventListener("change", (ev) => { S.cat = ev.target.value; render(); });
  $("al-q").addEventListener("input", (ev) => { S.q = ev.target.value.trim().toLowerCase(); render(); });

  window.alertsShow = () => {
    S.me = (($("whoami") || {}).textContent || "").trim();
    if (!S.shown) { S.shown = true; load(false); } else { render(); load(true); }
  };
  // nav badge on load, and every 5 minutes
  setTimeout(() => badge(false), 4000);
  setInterval(() => { if ($("tab-alerts").hidden) badge(true); }, 5 * 60000);
  if (!$("tab-alerts").hidden) window.alertsShow();
})();
