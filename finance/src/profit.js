// Profit page: overall profit by month since Jan 2025 = the sales dashboard's profit (net sales − cost of goods −
// shipping labels − Amazon and payment fees, all channels; any ad spend it already took off is added back) − the costs
// Brian picks. Costs are QuickBooks accounts by month (fin.qbo_pl, refreshed daily); only payroll (the "Payroll expenses"
// accounts: wages and payroll taxes) is counted to start. Other accounts are switched on, or grouped, under "Add a cost"
// (fin.pl_rules).
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const money = (v) => (v < 0 ? "−" : "") + "$" + Math.abs(Math.round(Number(v) || 0)).toLocaleString("en-US");
  const short = (v) => { const a = Math.abs(v), s = v < 0 ? "−" : ""; return a >= 1e6 ? s + "$" + (a / 1e6).toFixed(2) + "M" : a >= 1e4 ? s + "$" + Math.round(a / 1e3) + "K" : a >= 1e3 ? s + "$" + (a / 1e3).toFixed(1) + "K" : money(v); };
  const pct = (a, b) => { if (!b) return "—"; const v = (a / b * 100).toFixed(1); return (v === "-0.0" ? "0.0" : v.replace("-", "−")) + "%"; };
  const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const mLabel = (m, long) => new Date(m + "T12:00:00Z").toLocaleDateString("en-US", { month: long ? "long" : "short", year: "numeric", timeZone: "UTC" });
  const START = "2025-01-01";
  const OUT = "— Not counted";
  const GROUP_ORDER = ["Payroll", "Staff costs", "Rent & facilities", "Advertising", "Software & subscriptions", "Meals & travel", "Insurance", "Bank fees & interest", "Professional fees", "Taxes", "Other expenses", "Other income"];
  const SEC = { Income: "Income", COGS: "Cost of goods sold", Expenses: "Expenses", OtherIncome: "Other income", OtherExpenses: "Other expenses" };

  const S = { loaded: false, loading: false, err: null, dash: [], pl: [], accts: [], sync: null, period: "all", open: new Set(), busy: false, acctQ: "", acctAll: false };

  async function load(refresh) {
    S.loading = true; render();
    try {
      const [dash, pl, ac, st] = await Promise.all([
        FIN.sql(`select to_char(date_trunc('month', day), 'YYYY-MM-DD') as month, channel, sum(net_sales) as net_sales, sum(cogs) as cogs, sum(profit) as profit, sum(ad_spend) as ad_spend
                 from jt.v_sales_channels_daily where day >= '${START}' group by 1, 2`, refresh),
        FIN.sql("select section, account_key, to_char(month, 'YYYY-MM-DD') as month, amount from fin.qbo_pl where amount <> 0", refresh),
        FIN.sql("select section, account_key, account, parent, total, months, include, grp, default_include, default_grp, rule_by from fin.pl_account_class", refresh),
        FIN.sql("select value, updated_at from fin.sync_state where key = 'qbo_pl'", refresh),
      ]);
      S.dash = dash.map(r => ({ ...r, net_sales: +r.net_sales || 0, cogs: +r.cogs || 0, profit: +r.profit || 0, ad_spend: +r.ad_spend || 0 }));
      S.pl = pl.map(r => ({ ...r, amount: +r.amount || 0 }));
      S.accts = ac.map(a => ({ ...a, total: +a.total || 0 }));
      S.sync = st[0] || null; S.err = null; S.loaded = true;
    } catch (e) { S.err = e; }
    S.loading = false; render();
  }

  // ---------- the numbers
  const key = (section, k) => section + "|" + k;
  function model() {
    const cls = new Map(S.accts.map(a => [key(a.section, a.account_key), a]));
    const months = new Map();
    const M = (m) => { if (!months.has(m)) months.set(m, { month: m, net_sales: 0, dash: 0, ad_back: 0, ch: {}, groups: {}, accts: [], exp: 0 }); return months.get(m); };
    for (const d of S.dash) {
      const r = M(d.month); r.net_sales += d.net_sales; r.dash += d.profit; r.ad_back += d.ad_spend;
      r.ch[d.channel] = (r.ch[d.channel] || 0) + d.profit + d.ad_spend;
    }
    for (const p of S.pl) {
      if (p.month < START) continue;
      const r = M(p.month), c = cls.get(key(p.section, p.account_key));
      const inc = p.section === "Income" || p.section === "OtherIncome";
      if (!c || !c.include) continue;
      const amt = inc ? -p.amount : p.amount;          // income in a group lowers expenses
      r.groups[c.grp] = (r.groups[c.grp] || 0) + amt; r.exp += amt;
      r.accts.push({ grp: c.grp, name: c.account, parent: c.parent, amount: amt });
    }
    const rows = [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
    for (const r of rows) { r.base = r.dash + r.ad_back; r.overall = r.base - r.exp; }
    const used = new Set(); for (const r of rows) for (const g in r.groups) if (Math.abs(r.groups[g]) >= 0.5) used.add(g);
    const groups = [...used].sort((a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
    return { rows, groups };
  }
  function inPeriod(m) {
    const t = today(), cur = t.slice(0, 8) + "01";
    if (S.period === "all") return true;
    if (S.period === "12") { const d = new Date(cur + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() - 12); return m > d.toISOString().slice(0, 10) && m < cur; }
    return m.slice(0, 4) === S.period;
  }
  const sumBy = (rows, f) => rows.reduce((a, r) => a + f(r), 0);

  // ---------- render
  function note(cls, html) { const n = $("pf-note"); n.className = "note " + (cls || ""); n.innerHTML = html; n.hidden = !html; }
  function render() {
    if (S.err) { note("bad", "Couldn't load: " + esc(S.err.message || S.err)); }
    const sub = $("pf-sub");
    if (S.loading && !S.loaded) { sub.textContent = "Loading… (adding up sales since January 2025 takes a few seconds)"; return; }
    if (!S.loaded) return;
    const at = S.sync?.updated_at ? new Date(S.sync.updated_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
    sub.textContent = at ? `Costs from QuickBooks as of ${at} · updates every morning` : "QuickBooks costs not loaded yet — use Refresh from QuickBooks";
    const { rows, groups } = model();
    const cur = today().slice(0, 8) + "01";
    const sel = rows.filter(r => inPeriod(r.month));
    const full = sel.filter(r => r.month < cur);
    cards(sel, full, groups); chart(rows.filter(r => inPeriod(r.month)).slice().reverse(), cur); statement(sel, groups, cur); accounts();
  }
  function cards(sel, full, groups) {
    const card = (cls, k, v, s) => `<div class="card ${cls}"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s}</span></div>`;
    const ns = sumBy(sel, r => r.net_sales), base = sumBy(sel, r => r.base), exp = sumBy(sel, r => r.exp), ov = base - exp;
    const avg = full.length ? sumBy(full, r => r.overall) / full.length : null;
    const items = groups.map(g => [g, sumBy(sel, r => r.groups[g] || 0)]);
    const costLabel = groups.length === 1 ? esc(groups[0]) : "Costs";
    $("pf-cards").innerHTML = [
      card(ov < 0 ? "red" : "green", "Overall profit", short(ov), `${pct(ov, ns)} of ${short(ns)} net sales`),
      card("", "Dashboard profit", short(base), `${pct(base, ns)} of net sales`),
      card("", costLabel, short(exp), groups.length > 1 ? items.map(([g, v]) => `${esc(g)} ${short(v)}`).join(" · ") : groups.length ? `${pct(exp, ns)} of net sales` : "No costs counted yet"),
      card("", `${costLabel} share`, pct(exp, base), "of dashboard profit"),
      card(avg != null && avg < 0 ? "red" : "", "Average month", avg == null ? "—" : short(avg), `overall profit · ${full.length} full month${full.length === 1 ? "" : "s"}`),
    ].join("");
  }
  function chart(rows, cur) {
    if (!rows.length) { $("pf-chart").innerHTML = `<div class="empty">No months in this period.</div>`; return; }
    const W = 1000, H = 260, L = 56, R = 10, T = 14, B = 34;
    const vals = rows.flatMap(r => [r.base, r.overall, -r.exp]);
    const hi = Math.max(0, ...vals), lo = Math.min(0, ...vals), span = hi - lo || 1;
    const y = (v) => T + (hi - v) / span * (H - T - B);
    const bw = (W - L - R) / rows.length, w = Math.min(34, bw * 0.36);
    const step = Math.pow(10, Math.floor(Math.log10(span / 4))), tick = [1, 2, 2.5, 5, 10].map(k => k * step).find(k => span / k <= 6) || step;
    let g = "";
    for (let v = Math.ceil(lo / tick) * tick; v <= hi; v += tick) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text>`;
    g += `<line class="zero" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
    rows.forEach((r, i) => {
      const x = L + i * bw + bw / 2;
      const bar = (v, dx, c, t, op = 1) => `<rect x="${x + dx - w / 2}" y="${Math.min(y(v), y(0))}" width="${w}" height="${Math.max(1, Math.abs(y(v) - y(0)))}" rx="2" fill="${c}" fill-opacity="${op}"><title>${esc(t)}</title></rect>`;
      g += bar(r.base, -w / 2 - 1, "var(--green2)", `${mLabel(r.month)} · dashboard profit ${money(r.base)}`, .3);
      g += bar(-r.exp, -w / 2 - 1, "var(--amber)", `${mLabel(r.month)} · costs ${money(r.exp)}`, .45);
      g += bar(r.overall, w / 2 + 1, r.overall < 0 ? "var(--red)" : "var(--green)", `${mLabel(r.month)} · overall profit ${money(r.overall)}`);
      if (rows.length <= 24 && (rows.length <= 12 || i % 2 === 0 || i === rows.length - 1)) {
        const lab = new Date(r.month + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) + (r.month.slice(5, 7) === "01" || i === 0 ? " " + r.month.slice(2, 4) : "") + (r.month === cur ? "*" : "");
        g += `<text class="ax" x="${x}" y="${H - 12}" text-anchor="middle">${lab}</text>`;
      }
    });
    $("pf-chart").innerHTML = `<svg class="cf-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Overall profit by month">${g}</svg>
      <div class="cf-legend"><span><i style="background:var(--green2);opacity:.3"></i>Dashboard profit</span><span><i style="background:var(--amber);opacity:.45"></i>Costs</span><span><i style="background:var(--green)"></i>Overall profit</span><span><i style="background:var(--red)"></i>Overall loss</span>${rows.some(r => r.month === cur) ? "<span>* month to date</span>" : ""}</div>`;
  }
  // statement layout: months across (oldest → newest, a total column per full year when the period spans years, then
  // the period's total); income on top, costs below (in parentheses), overall profit at the bottom. A cost row opens to
  // its QuickBooks accounts.
  const CH = [["amazon", "Amazon"], ["justtennis", "Just Tennis"], ["acenrally", "Ace n Rally"]];
  function columns(sel, cur) {
    const ms = sel.slice().sort((a, b) => a.month.localeCompare(b.month));
    const years = [...new Set(ms.map(r => r.month.slice(0, 4)))];
    const cols = [];
    for (const y of years) {
      const inY = ms.filter(r => r.month.slice(0, 4) === y);
      for (const r of inY) cols.push({ key: r.month, label: new Date(r.month + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }), rows: [r], partial: r.month === cur });
      if (years.length > 1) cols.push({ key: "y" + y, label: y + (y === cur.slice(0, 4) ? " YTD" : ""), rows: inY, sum: true });
    }
    cols.push({ key: "total", label: "Total", rows: ms, sum: true, total: true });
    return cols;
  }
  function statement(sel, groups, cur) {
    const cols = columns(sel, cur);
    const add = (rs, f) => rs.reduce((a, r) => a + (f(r) || 0), 0);
    const acctRows = (g) => {   // account → amount per month for one cost group
      const m = new Map();
      for (const r of sel) for (const a of r.accts) if (a.grp === g) {
        const k = a.name + "|" + a.parent; if (!m.has(k)) m.set(k, { name: a.name, parent: a.parent, by: {} });
        m.get(k).by[r.month] = (m.get(k).by[r.month] || 0) + a.amount;
      }
      return [...m.values()].sort((a, b) => add(Object.values(b.by), x => x) - add(Object.values(a.by), x => x));
    };
    const cell = (c, f, kind) => {
      const v = add(c.rows, f);
      const txt = kind === "pct" ? v : !v && kind !== "strong" ? "—" : kind === "cost" ? `(${money(Math.abs(v)).replace("−", "")})` : money(v);
      return `<td class="n${c.sum ? " sum" : ""}${c.partial ? " part" : ""}">${txt}</td>`;
    };
    const tr = (cls, label, f, kind, attrs) => `<tr class="${cls}" ${attrs || ""}><th scope="row">${label}</th>${cols.map(c => kind === "pct"
      ? `<td class="n${c.sum ? " sum" : ""}${c.partial ? " part" : ""}">${pct(add(c.rows, r => r.overall), add(c.rows, r => r.net_sales))}</td>` : cell(c, f, kind)).join("")}</tr>`;
    const band = (cls, label, note) => `<tr class="band ${cls}"><th scope="row">${label}${note ? ` <span>${note}</span>` : ""}</th><td colspan="${cols.length}"></td></tr>`;

    let b = "";
    b += band("inc", "Income", "dashboard profit by channel");
    b += tr("memo", "Net sales <span class=\"m\">for reference</span>", r => r.net_sales, "plain");
    for (const [k, l] of CH) if (sel.some(r => r.ch[k])) b += tr("line", l, r => r.ch[k], "plain");
    b += tr("subtot inc", "Total income", r => r.base, "strong");
    b += band("exp", "Costs", "taken off profit");
    for (const g of groups) {
      const open = S.open.has(g), acc = acctRows(g);
      b += tr("line cost grp", `<button type="button" class="tog" data-grp="${esc(g)}" aria-expanded="${open}">${open ? "▾" : "▸"}</button>${esc(g)} <span class="m">${acc.length} account${acc.length === 1 ? "" : "s"}</span>`, r => r.groups[g], "cost", `data-grp="${esc(g)}"`);
      if (open) for (const a of acc) b += tr("acct", `${esc(a.name)}${a.parent ? ` <span class="m">${esc(a.parent)}</span>` : ""}`, r => a.by[r.month], "cost");
    }
    if (!groups.length) b += `<tr class="line"><th scope="row" class="m">No costs counted yet</th><td colspan="${cols.length}"></td></tr>`;
    b += tr("subtot exp", "Total costs", r => r.exp, "cost");
    b += tr("net", "Overall profit", r => r.overall, "strong");
    b += tr("memo", "Margin", null, "pct");
    const head = `<tr><th scope="col"></th>${cols.map(c => `<th scope="col" class="n${c.sum ? " sum" : ""}${c.partial ? " part" : ""}"${c.partial ? ' title="Month to date"' : ""}>${esc(c.label)}${c.partial ? "*" : ""}</th>`).join("")}</tr>`;
    const box = $("pf-table");
    box.innerHTML = sel.length ? `<table class="stmt"><thead>${head}</thead><tbody>${b}</tbody></table>${cols.some(c => c.partial) ? '<div class="hint stmt-note">* month to date — its payroll may not be in QuickBooks yet</div>' : ""}` : `<div class="empty">No months in this period.</div>`;
    box.scrollLeft = box.scrollWidth;   // newest months in view
    // net row colours
    box.querySelectorAll("tr.net td").forEach(td => { if (td.textContent.trim().startsWith("−")) td.classList.add("negt"); });
  }

  function accounts() {
    const q = S.acctQ;
    const groups = [...new Set([...GROUP_ORDER, ...S.accts.map(a => a.grp)])].filter(g => g !== "In dashboard profit");
    const opts = (a) => [OUT, ...groups].map(g => `<option ${(a.include ? a.grp : OUT) === g ? "selected" : ""}>${esc(g)}</option>`).join("") + `<option value="__new">New cost item…</option>`;
    const row = (a) => {
      const changed = a.include !== a.default_include || (a.include && a.grp !== a.default_grp);
      return `<tr><td>${esc(a.account)}${a.parent ? ` <span class="m">${esc(a.parent)}</span>` : ""}</td><td class="n">${money(a.total)}</td>
        <td><select data-acct="${esc(a.section + "|" + a.account_key)}" ${S.busy ? "disabled" : ""}>${opts(a)}</select></td>
        <td>${changed ? `<span class="m">changed${a.rule_by ? " by " + esc(a.rule_by) : ""}</span> <button class="link" type="button" data-reset="${esc(a.account_key)}">undo</button>` : ""}</td></tr>`;
    };
    const head = `<thead><tr><th>QuickBooks account</th><th class="n">Since Jan 2025</th><th>Counted as</th><th></th></tr></thead>`;
    const on = S.accts.filter(a => a.include).sort((a, b) => a.grp.localeCompare(b.grp) || b.total - a.total);
    $("pf-costs").innerHTML = on.length ? `<table>${head}<tbody>${on.map(row).join("")}</tbody></table>` : `<div class="empty">${S.accts.length ? "No costs counted — add one below." : "No QuickBooks data yet — use Refresh from QuickBooks."}</div>`;
    const rest = S.accts.filter(a => !a.include && Math.abs(a.total) >= 0.5 && (!q || (a.account + " " + a.parent).toLowerCase().includes(q)))
      .sort((a, b) => Object.keys(SEC).indexOf(a.section) - Object.keys(SEC).indexOf(b.section) || b.total - a.total);
    let sec = null, body = "";
    for (const a of rest) {
      if (a.section !== sec) { sec = a.section; body += `<tr class="yr"><td colspan="4"><b>${esc(SEC[sec] || sec)}</b>${sec === "Income" || sec === "COGS" ? ' <span class="m">— most of these are already in the dashboard\'s profit (sales, cost of goods, labels, Amazon and payment fees)</span>' : ""}</td></tr>`; }
      body += row(a);
    }
    $("pf-accts").innerHTML = rest.length ? `<table>${head}<tbody>${body}</tbody></table>` : `<div class="empty">${q ? "No accounts match." : "Every account is counted."}</div>`;
  }

  // ---------- actions
  async function setRule(acctKey, include, grp) {
    S.busy = true; accounts();
    try { await FIN.write("fin_pl_rule_set", { p: { account_key: acctKey, include, grp } }); await load(true); }
    catch (e) { note("bad", "Couldn't save: " + esc(e.message || e)); }
    S.busy = false; render();
  }
  async function refresh() {
    const b = $("pf-refresh"); b.disabled = true; b.textContent = "Refreshing…";
    try {
      const r = await FIN.fn("qbo", { action: "pl_sync" });
      if (!r || r.ok === false) throw new Error((r && r.error) || "QuickBooks didn't answer");
      note("", `Updated from QuickBooks: ${r.months} months.`);
    } catch (e) { note("bad", "Couldn't refresh from QuickBooks: " + esc(e.message || e)); }
    b.disabled = false; b.textContent = "Refresh from QuickBooks";
    FIN.clear(); load(true);
  }
  function exportCsv() {
    const { rows, groups } = model();
    const sel = rows.filter(r => inPeriod(r.month));
    const cols = columns(sel, today().slice(0, 8) + "01");
    const q = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
    const sum = (c, f) => c.rows.reduce((a, r) => a + (f(r) || 0), 0).toFixed(2);
    const line = (label, f) => [label, ...cols.map(c => sum(c, f))];
    const lines = [["", ...cols.map(c => c.key.startsWith("y") ? c.label : c.key === "total" ? "Total" : c.key.slice(0, 7))],
      line("Net sales", r => r.net_sales),
      ...CH.filter(([k]) => sel.some(r => r.ch[k])).map(([k, l]) => line(`Income: ${l}`, r => r.ch[k])),
      line("Total income (dashboard profit)", r => r.base),
      ...groups.map(g => line(`Cost: ${g}`, r => r.groups[g])),
      line("Total costs", r => r.exp),
      line("Overall profit", r => r.overall)];
    FIN.download(`overall-profit-${today()}.csv`, lines.map(r => r.map(q).join(",")).join("\n"));
  }

  document.addEventListener("DOMContentLoaded", () => {
    const main = $("profit");
    main.addEventListener("click", (ev) => {
      const rs = ev.target.closest("[data-reset]");
      if (rs) { setRule(rs.dataset.reset, null, null); return; }
      const t = ev.target.closest("tr[data-grp]");
      if (t) { const g = t.dataset.grp; S.open.has(g) ? S.open.delete(g) : S.open.add(g); const { rows, groups } = model(); statement(rows.filter(r => inPeriod(r.month)), groups, today().slice(0, 8) + "01"); }
    });
    main.addEventListener("change", (ev) => {
      const s = ev.target.closest("select[data-acct]");
      if (!s) return;
      const [section, k] = s.dataset.acct.split(/\|(.*)/s);
      const a = S.accts.find(x => x.section === section && x.account_key === k);
      let v = s.value;
      if (v === "__new") { v = (prompt("Name of the new cost item (e.g. Rent)") || "").trim(); if (!v) { accounts(); return; } }
      // store only what differs from the default (null = default)
      if (v === OUT) setRule(k, a && !a.default_include ? null : false, null);
      else setRule(k, a && a.default_include ? null : true, a && v === a.default_grp ? null : v);
    });
    $("pf-period").addEventListener("change", (ev) => { S.period = ev.target.value; render(); });
    $("pf-q").addEventListener("input", (ev) => { S.acctQ = ev.target.value.trim().toLowerCase(); accounts(); });
    $("pf-refresh").addEventListener("click", refresh);
    $("pf-csv").addEventListener("click", exportCsv);
    if (!$("profit").hidden) FIN.ready.then(() => load(false));   // opened straight on #profit
    window.addEventListener("fin:page", (e) => { if (e.detail === "profit") { if (!S.loaded && !S.loading) FIN.ready.then(() => load(false)); else render(); } });
  });
})();
