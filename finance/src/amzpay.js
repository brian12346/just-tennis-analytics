// Amazon payouts page: each Amazon settlement (from Amazon's settlement report, saved by the amzpay function) broken
// down into the QuickBooks journal entries it becomes (fin.amz_entry: one per month the settlement touches + cost of
// goods), checked against QuickBooks (A2X's entries before the switch, ours after) and posted with "Send to QuickBooks".
// The mapping (which amounts go to which account) is at the bottom; a change applies to every settlement not yet posted.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (v, cur) => { const n = Number(v) || 0; const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return (n < 0 ? "−" : "") + (cur && cur !== "USD" ? s + " " + cur : "$" + s); };
  const short = (v) => { const a = Math.abs(v), s = v < 0 ? "−" : ""; return a >= 1e6 ? s + "$" + (a / 1e6).toFixed(2) + "M" : a >= 1e4 ? s + "$" + Math.round(a / 1e3) + "K" : s + "$" + Math.round(a).toLocaleString("en-US"); };
  const day = (s, y) => s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(y ? { year: "numeric" } : {}), timeZone: "UTC" }) : "—";
  const QBO_JE = (id) => `https://qbo.intuit.com/app/journal?txnId=${encodeURIComponent(id)}`;
  const FLAG = { US: "US", CA: "Canada", MX: "Mexico" };

  const S = { loaded: false, loading: false, err: null, rows: [], groups: [], map: [], seen: [], coa: [], cfg: {}, open: null, entry: null, entryErr: null, busy: "", confirm: null, mapQ: "", sum: {}, postedShown: 12,
    cmp: null, cmpLoading: false, cmpErr: null, cmpOpen: null, cmpAcct: null, cmpLines: null,
    sku: null, skuErr: null, skuQ: "", skuF: "all", skuShown: 150 };

  async function load(refresh) {
    S.loading = true; render();
    try {
      const [rows, groups, map, seen, coa, cfg, sums] = await Promise.all([
        FIN.sql(`select settlement_id, market, currency, start_at, end_at, deposit_date, total, fx, converted_usd, units, rows, a2x_docs, checked_at, posted, transfer_status, synced_at
                 from fin.v_amz_settlements order by end_at desc`, refresh),
        FIN.sql("select group_id, status, currency, start_at, original from fin.amz_event_groups where status = 'Open' and currency in ('USD', 'CAD', 'MXN') and start_at > now() - interval '30 days' order by (currency = 'USD') desc, original desc", refresh),
        FIN.sql("select id, priority, transaction_type, amount_type, amount_description, text_match, account, review, note, updated_by, updated_at from fin.amz_map where priority < 100000 order by priority, id", refresh),
        FIN.sql(`select x.transaction_type, x.amount_type, x.amount_description, sum(x.amount) as amount, sum(x.n) as n, count(distinct x.settlement_id) as settlements,
                        a.account, a.review, a.rule_id
                 from fin.amz_settlement_sums x cross join lateral fin.amz_account(x.transaction_type, x.amount_type, x.amount_description) a
                 where x.amount <> 0 group by 1, 2, 3, 7, 8, 9 order by abs(sum(x.amount)) desc`, refresh),
        FIN.sql("select name, type from fin.qbo_coa where active order by name", refresh),
        FIN.sql("select value from fin.settings where key = 'amz_post'", refresh),
        FIN.sql("select * from fin.v_amz_settlement_summary", refresh),
      ]);
      S.sum = Object.fromEntries(sums.map(x => [x.settlement_id, Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "settlement_id" ? v : +v]))]));
      S.rows = rows.map(r => ({ ...r, total: +r.total, fx: r.fx == null ? null : +r.fx, a2x_docs: r.a2x_docs || [], posted: r.posted || {} }));
      S.groups = groups; S.map = map; S.seen = seen.map(x => ({ ...x, amount: +x.amount })); S.coa = coa; S.cfg = (cfg[0] && cfg[0].value) || {};
      S.err = null; S.loaded = true;
    } catch (e) { S.err = e; }
    S.loading = false; render();
    if (S.open) openEntry(S.open, true);
  }

  // ---------- status of a settlement
  const usd = (r) => r.currency === "USD" ? r.total : r.converted_usd != null ? +r.converted_usd : r.fx ? r.total * r.fx : null;
  function status(r) {
    if (r.a2x_docs.length) return ["a2x", "Posted by A2X"];
    const n = Object.keys(r.posted).length;
    if (n) return ["posted", "In QuickBooks"];
    if (new Date(r.start_at) < new Date((S.cfg.start || "2026-09-23") + "T00:00:00Z") && !r.checked_at) return ["old", "Before the switch"];
    if (!r.checked_at) return ["new", "Not checked"];
    return ["ready", "Ready to post"];
  }

  // ---------- render
  function note(cls, html) { const n = $("az-note"); n.className = "note " + (cls || ""); n.innerHTML = html; n.hidden = !html; }
  function render() {
    if (S.err) note("bad", "Couldn't load: " + esc(S.err.message || S.err));
    if (!S.loaded) { $("az-sub").textContent = S.loading ? "Loading…" : ""; return; }
    const last = S.rows.reduce((a, r) => r.synced_at > a ? r.synced_at : a, "");
    $("az-sub").textContent = last ? `Settlements from Amazon as of ${new Date(last).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · updates every morning` : "No settlements yet — use Refresh from Amazon";
    cards(); table(); mapping(); compare(); skuCheck();
  }
  function cards() {
    const card = (cls, k, v, s2) => `<div class="card ${cls}"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s2}</span></div>`;
    const todo = S.rows.filter(r => !isPosted(r)), done = S.rows.filter(isPosted);
    const sumUsd = (rs) => rs.reduce((a, r) => a + (usd(r) || 0), 0);
    const cogs = (rs) => rs.reduce((a, r) => a + (S.sum[r.settlement_id]?.cogs || 0), 0);
    const open = S.groups[0];
    $("az-cards").innerHTML = [
      card(todo.length ? "amber" : "green", "To post", String(todo.length), todo.length ? `${short(sumUsd(todo))} in payouts` : "All caught up"),
      card("", "Cost of goods to post", short(cogs(todo)), todo.length ? "at Seller Sage's costs" : "—"),
      card("green", "Posted", String(done.length), `${short(sumUsd(done))} · the last 90 days`),
      `<div class="card"><span class="k">Next payout</span><span class="v">${open ? fmt(open.original, open.currency).replace(/\.\d\d/, "") : "—"}</span><span class="s">${open ? `${FLAG[{ USD: "US", CAD: "CA", MXN: "MX" }[open.currency]] || open.currency} · building since ${day(open.start_at)}` : "none open"}</span></div>`,
    ].join("");
  }
  const isPosted = (r) => r.a2x_docs.length > 0 || Object.keys(r.posted).length > 0;
  // one payout: what's in it (its own currency) and its cost of goods (USD, Seller Sage's costs)
  const SYM = { USD: "$", MXN: "MX$", CAD: "CA$" };
  const f0 = (v, cur) => { const n = Math.round(Number(v) || 0); return (n < 0 ? "−" : "") + (SYM[cur] || "$") + Math.abs(n).toLocaleString("en-US"); };
  const f2 = (v, cur) => { const n = Number(v) || 0; return (n < 0 ? "−" : "") + (SYM[cur] || "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  function payoutRows(rows, posted) {
    const head = `<tr><th>Payout</th><th class="n">Sales</th><th class="n">Refunds, promos</th><th class="n">Reim&shy;bursed</th><th class="n">Amazon fees</th><th class="n">Ads, other</th><th class="n">Payout</th><th class="n">Cost of goods</th><th class="n">After COGS</th><th>${posted ? "Posted" : "Status"}</th></tr>`;
    let h = `<table class="az-pay"><thead>${head}</thead><tbody>`;
    const tot = { usd: 0, cogs: 0 };
    for (const r of rows) {
      const [k, label] = status(r), m = S.sum[r.settlement_id] || {}, cur = r.currency, u = usd(r);
      const after = u == null ? null : u - (m.cogs || 0);
      tot.usd += u || 0; tot.cogs += m.cogs || 0;
      const cell = (v) => `<td class="n">${Math.abs(v || 0) >= 0.5 ? f0(v, cur) : "—"}</td>`;
      const st = k === "a2x" ? `<span class="pill open" title="${esc(r.a2x_docs.join(", "))}">A2X</span>`
        : k === "posted" ? `<span class="pill paid" title="${esc(Object.keys(r.posted).join(", "))}">Seller Sage</span>`
        : `<span class="pill ${k === "ready" ? "soon" : "est"}">${esc(label)}</span>`;
      h += `<tr class="row${S.open === r.settlement_id ? " sel" : ""}" data-sid="${esc(r.settlement_id)}"><td><b>${esc(FLAG[r.market] || r.market)}</b> ${day(r.start_at)} – ${day(r.end_at)}<div class="m">paid ${day(r.deposit_date, true)} · #${esc(r.settlement_id)}</div></td>${cell(m.sales)}${cell(m.refunds)}${cell(m.reimbursements)}${cell(m.fees)}${cell((m.ads || 0) + (m.tax || 0) + (m.other || 0))}
        <td class="n"><b>${f2(r.total, cur)}</b>${cur !== "USD" && u != null ? `<div class="m">${f2(u)}</div>` : ""}</td>
        <td class="n">${f0(m.cogs || 0)}<div class="m">${(m.units || 0).toLocaleString()} units${m.units_no_cost ? ` · <span class="negt">${m.units_no_cost} no cost</span>` : ""}</div></td>
        <td class="n ${after != null && after < 0 ? "negt" : ""}">${after == null ? "—" : f0(after)}</td><td>${st}</td></tr>`;
      if (S.open === r.settlement_id) h += `<tr class="detail"><td colspan="10">${detail(r)}</td></tr>`;
    }
    h += `</tbody><tfoot><tr><td colspan="6"><b>${rows.length} payout${rows.length === 1 ? "" : "s"}</b> <span class="m">(USD)</span></td><td class="n"><b>${fmt(tot.usd)}</b></td><td class="n"><b>${fmt(tot.cogs)}</b></td><td class="n"><b>${fmt(tot.usd - tot.cogs)}</b></td><td></td></tr></tfoot></table>`;
    return h;
  }
  function table() {
    const todo = S.rows.filter(r => !isPosted(r)), done = S.rows.filter(isPosted);
    $("az-table").innerHTML = todo.length ? payoutRows(todo, false) : `<div class="empty">Nothing waiting to be posted.</div>`;
    const shown = done.slice(0, S.postedShown);
    $("az-posted").innerHTML = done.length ? payoutRows(shown, true) + (done.length > shown.length ? `<div class="foot"><span>${done.length - shown.length} more</span><button class="btn small" type="button" data-postedmore>Show all</button></div>` : "") : `<div class="empty">Nothing posted yet.</div>`;
  }

  // ---------- one settlement's entries
  async function openEntry(sid, keep) {
    if (!keep && S.open === sid) { S.open = null; S.entry = null; table(); return; }
    S.open = sid; S.entry = null; S.entryErr = null; S.confirm = null; table();
    try { S.entry = await FIN.rpc("fin_amz_entry", { sid }); } catch (e) { S.entryErr = e; }
    if (S.open === sid) table();
  }
  function detail(r) {
    if (S.entryErr) return `<div class="note bad">Couldn't build the entries: ${esc(S.entryErr.message || S.entryErr)}</div>`;
    const e = S.entry;
    if (!e || e.settlement?.settlement_id !== r.settlement_id) return `<div class="m">Building the entries…</div>`;
    const [k] = status(r);
    const probs = (e.problems || []);
    const blocking = probs.filter(p => p.kind === "total" || p.kind === "fx");
    const review = e.parts.flatMap(p => p.lines.filter(l => l.review));
    let h = "";
    if (k === "a2x") h += `<div class="note">A2X already posted this settlement (${esc(r.a2x_docs.join(", "))}). It's shown here for comparison and won't be posted again.</div>`;
    for (const p of probs) h += `<div class="note ${p.kind === "cost" ? "" : "bad"}">${esc(p.message)}${p.skus ? ` <span class="m">${p.skus.slice(0, 8).map(x => esc(x.sku) + " ×" + x.qty).join(", ")}${p.skus.length > 8 ? " …" : ""}</span>` : ""}</div>`;
    if (review.length) h += `<div class="note">${review.length} line${review.length > 1 ? "s" : ""} didn't match a mapping rule and went to the catch-all account (marked below). Change it in <a href="#az-map-panel">Mapping</a> if needed.</div>`;
    h += `<div class="az-parts">`;
    for (const p of e.parts) {
      const dr = p.lines.reduce((a, l) => a + (l.amount > 0 ? +l.amount : 0), 0), cr = p.lines.reduce((a, l) => a + (l.amount < 0 ? -l.amount : 0), 0);
      const cur = p.currency;
      h += `<div class="az-part"><div class="az-ph"><div><b>${esc(p.doc)}</b> <span class="m">${p.kind === "cogs" ? "cost of goods" : "payout"} · dated ${day(p.date, true)}${cur !== "USD" ? ` · in ${cur} at ${Number(p.fx || 0).toFixed(6)} USD` : ""}</span></div>
        ${p.posted?.id ? `<a class="pill paid" href="${QBO_JE(p.posted.id)}" target="_blank" rel="noopener">In QuickBooks ↗</a>` : ""}</div>
        <table class="az-lines"><thead><tr><th>Account</th><th>Description</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>
        ${p.lines.map(l => `<tr class="${l.review ? "rev" : ""}"><td>${esc(l.account)}${l.review ? ' <span class="pill soon">check</span>' : ""}</td><td class="m">${esc(l.description)}</td>
          <td class="n">${l.amount > 0 ? fmt(l.amount, cur) : ""}</td><td class="n">${l.amount < 0 ? fmt(-l.amount, cur) : ""}</td></tr>`).join("")}
        </tbody><tfoot><tr><td colspan="2"><b>Total</b> ${Math.abs(dr - cr) < 0.005 ? '<span class="pill paid">balanced</span>' : '<span class="pill over">doesn\'t balance</span>'}</td><td class="n"><b>${fmt(dr, cur)}</b></td><td class="n"><b>${fmt(cr, cur)}</b></td></tr></tfoot></table></div>`;
    }
    h += `</div>`;
    const todo = e.parts.filter(p => !p.posted?.id).length;
    const can = k !== "a2x" && !blocking.length && todo > 0;
    h += `<div class="az-actions">`;
    if (can) {
      h += S.confirm === r.settlement_id
        ? `<span>Post ${todo} journal entr${todo === 1 ? "y" : "ies"} to QuickBooks?</span><button class="btn primary" type="button" data-post="${esc(r.settlement_id)}" ${S.busy ? "disabled" : ""}>${S.busy === "post" ? "Posting…" : "Yes, post"}</button><button class="btn" type="button" data-cancel>Cancel</button>`
        : `<button class="btn primary" type="button" data-ask="${esc(r.settlement_id)}">Send to QuickBooks</button><span class="m">${todo} entr${todo === 1 ? "y" : "ies"} · checks QuickBooks for A2X's or an earlier copy first</span>`;
    } else if (k !== "a2x" && !todo) h += `<span class="m">Everything for this settlement is in QuickBooks.</span>`;
    h += `<button class="btn small" type="button" data-csv="${esc(r.settlement_id)}">Export CSV</button></div>`;
    return h;
  }
  function exportCsv(sid) {
    const e = S.entry; if (!e) return;
    const q = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
    const lines = [["journal_no", "date", "currency", "exchange_rate", "account", "description", "debit", "credit"]];
    for (const p of e.parts) for (const l of p.lines) lines.push([p.doc, p.date, p.currency, p.fx, l.account, l.description, l.amount > 0 ? (+l.amount).toFixed(2) : "", l.amount < 0 ? (-l.amount).toFixed(2) : ""]);
    FIN.download(`amazon-settlement-${sid}.csv`, lines.map(r => r.map(q).join(",")).join("\n"));
  }

  // ---------- mapping
  function mapping() {
    const q = S.mapQ;
    const opts = (sel) => S.coa.map(a => `<option ${a.name === sel ? "selected" : ""}>${esc(a.name)}</option>`).join("") + (S.coa.some(a => a.name === sel) ? "" : `<option selected>${esc(sel)}</option>`);
    const rule = (id) => S.map.find(m => String(m.id) === String(id));
    const seen = S.seen.filter(x => !q || `${x.transaction_type} ${x.amount_type} ${x.amount_description} ${x.account}`.toLowerCase().includes(q));
    let h = `<table><thead><tr><th>Amount (transaction · type · description)</th><th class="n">Last 90 days</th><th>QuickBooks account</th><th>Rule</th></tr></thead><tbody>`;
    for (const x of seen) {
      const r = rule(x.rule_id);
      h += `<tr class="${x.review ? "rev" : ""}"><td><b>${esc(x.amount_description || "—")}</b><div class="m">${esc(x.transaction_type)}${x.amount_type ? " · " + esc(x.amount_type) : ""}</div></td>
        <td class="n">${fmt(x.amount)}<div class="m">${x.settlements} settlement${x.settlements > 1 ? "s" : ""}</div></td>
        <td><select data-map='${esc(JSON.stringify({ tt: x.transaction_type, at: x.amount_type, ad: x.amount_description }))}' ${S.busy ? "disabled" : ""}>${opts(x.account)}</select>${x.review ? ' <span class="pill soon">check</span>' : ""}</td>
        <td class="m">${r ? esc(r.updated_by === "default" ? (r.note || "default") : "set by " + r.updated_by) : ""}</td></tr>`;
    }
    $("az-map").innerHTML = seen.length ? h + "</tbody></table>" : `<div class="empty">${S.seen.length ? "Nothing matches." : "No settlements yet."}</div>`;
  }
  async function setMap(key, account) {
    S.busy = "map"; mapping();
    try {
      const esc2 = (s) => "^" + String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
      await FIN.write("fin_amz_map_set", { p: { transaction_type: esc2(key.tt), amount_type: esc2(key.at), amount_description: esc2(key.ad), account, priority: 5, note: "" } });
      note("", `Saved: ${esc(key.ad)} → ${esc(account)}. Settlements not yet posted use it now.`);
      await load(true);
    } catch (e) { note("bad", "Couldn't save: " + esc(e.message || e)); }
    S.busy = ""; mapping();
  }

  // ---------- A2X vs Seller Sage: A2X's entries (read from QuickBooks into fin.amz_a2x_lines) against the entries Seller
  // Sage builds for the same settlements, by account (fin.v_amz_compare) and, for one account, line by line
  async function loadCompare(refresh) {
    S.cmpLoading = true; compare();
    try {
      const rows = await FIN.sql("select settlement_id, kind, account, a2x, ours, diff, a2x_lines, our_lines from fin.v_amz_compare", refresh);
      S.cmp = rows.filter(r => r.kind === "main").map(r => ({ ...r, a2x: +r.a2x, ours: +r.ours, diff: +r.diff })); S.cmpErr = null;   // cost of goods: Seller Sage's costs are used, not compared
    } catch (e) { S.cmpErr = e; }
    S.cmpLoading = false; compare();
  }
  const near0 = (v) => Math.abs(v) < 0.005;
  function cmpBySettlement() {
    const m = new Map();
    for (const r of S.cmp || []) {
      if (!m.has(r.settlement_id)) m.set(r.settlement_id, { sid: r.settlement_id, rows: [], off: 0, offAmt: 0 });
      const x = m.get(r.settlement_id); x.rows.push(r);
      if (!near0(r.diff)) { x.off++; x.offAmt += Math.abs(r.diff); }
    }
    const info = new Map(S.rows.map(r => [r.settlement_id, r]));
    return [...m.values()].map(x => ({ ...x, s: info.get(x.sid) || {} })).sort((a, b) => String(b.s.end_at).localeCompare(String(a.s.end_at)));
  }
  function compare() {
    const box = $("az-cmp"); if (!box) return;
    const todo = S.rows.filter(r => r.a2x_docs.length).length;
    if (S.cmpErr) { box.innerHTML = `<div class="note bad">Couldn't load the comparison: ${esc(S.cmpErr.message || S.cmpErr)}</div>`; return; }
    if (!S.cmp) { box.innerHTML = `<div class="m">${S.cmpLoading ? "Comparing…" : ""}</div>`; return; }
    const list = cmpBySettlement();
    if (!list.length) { box.innerHTML = `<div class="empty">No A2X entries read yet${todo ? ` — use “Read A2X entries” (${todo} settlement${todo > 1 ? "s" : ""} A2X posted)` : ""}.</div>`; return; }
    const matched = list.filter(x => !x.off).length;
    const worst = list.reduce((a, x) => x.offAmt > a.offAmt ? x : a, { offAmt: 0 });
    const card = (cls, k, v, s2) => `<div class="card ${cls}"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s2}</span></div>`;
    let h = `<section class="cards">${[
      card("", "Settlements compared", String(list.length), `of ${todo} A2X posted`),
      card(matched === list.length ? "green" : "amber", "Payout entries match", `${matched} / ${list.length}`, "every account to the cent"),
      card(worst.offAmt ? "amber" : "", "Biggest difference", worst.offAmt ? fmt(worst.offAmt, worst.s?.currency) : "none", worst.offAmt ? `${esc(FLAG[worst.s.market] || "")} ${day(worst.s.start_at)} – ${day(worst.s.end_at)}` : "payout lines"),
    ].join("")}</section>`;
    // by settlement
    h += `<table class="cmp"><thead><tr><th>Settlement</th><th class="n">Payout</th><th>Payout entry</th></tr></thead><tbody>`;
    for (const x of list) {
      const s = x.s;
      h += `<tr class="row${S.cmpOpen === x.sid ? " sel" : ""}" data-cmp="${esc(x.sid)}"><td><b>${esc(FLAG[s.market] || s.market || "")}</b> ${day(s.start_at)} – ${day(s.end_at, true)}<div class="m">#${esc(x.sid)}</div></td>
        <td class="n">${s.total != null ? fmt(s.total, s.currency) : ""}</td>
        <td>${x.off ? `<span class="pill soon">${x.off} account${x.off > 1 ? "s" : ""} off · ${fmt(x.offAmt, s.currency)}</span>` : '<span class="pill paid">matches</span>'}</td>
</tr>`;
      if (S.cmpOpen === x.sid) h += `<tr class="detail"><td colspan="3">${cmpDetail(x)}</td></tr>`;
    }
    h += `</tbody></table>`;
    // by account, all settlements (payout entries; amounts in each settlement's own currency are converted to USD at its rate)
    const acc = new Map(), info = new Map(S.rows.map(r => [r.settlement_id, r]));
    for (const r of S.cmp) {
      const fx = r.kind === "cogs" ? 1 : (info.get(r.settlement_id)?.fx || 1);
      const k = (r.kind === "cogs" ? "Cost of goods · " : "") + r.account;
      const a = acc.get(k) || { k, a2x: 0, ours: 0, off: 0 };
      a.a2x += r.a2x * fx; a.ours += r.ours * fx; if (!near0(r.diff)) a.off++; acc.set(k, a);
    }
    h += `<h3 class="cmp-h">All ${list.length} payouts by account <span class="m">(in USD; Mexico and Canada at each payout's rate)</span></h3><table class="cmp"><thead><tr><th>Account</th><th class="n">A2X</th><th class="n">Seller Sage</th><th class="n">Difference</th><th class="n">Settlements off</th></tr></thead><tbody>`;
    for (const a of [...acc.values()].sort((a, b) => a.k.localeCompare(b.k))) {
      const d = a.ours - a.a2x;
      h += `<tr><td>${esc(a.k)}</td><td class="n">${fmt(a.a2x)}</td><td class="n">${fmt(a.ours)}</td><td class="n ${near0(d) ? "" : "negt"}">${near0(d) ? "—" : fmt(d)}</td><td class="n">${a.off || "—"}</td></tr>`;
    }
    box.innerHTML = h + `</tbody></table>`;
  }
  function cmpDetail(x) {
    const cur = x.s.currency;
    const rows = x.rows.slice().sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "cogs" ? 1 : -1) || Math.abs(b.diff) - Math.abs(a.diff) || a.account.localeCompare(b.account));
    let h = `<table class="az-lines"><thead><tr><th>Entry</th><th>Account</th><th class="n">A2X</th><th class="n">Seller Sage</th><th class="n">Difference</th><th class="n">Lines (A2X / SS)</th></tr></thead><tbody>`;
    for (const r of rows) {
      const c = r.kind === "cogs" ? "USD" : cur, k = r.kind + "|" + r.account, open = S.cmpAcct === k;
      h += `<tr class="row${near0(r.diff) ? "" : " rev"}" data-acct="${esc(k)}"><td class="m">${r.kind === "cogs" ? "cost of goods" : "payout"}</td><td>${open ? "▾" : "▸"} ${esc(r.account)}</td>
        <td class="n">${fmt(r.a2x, c)}</td><td class="n">${fmt(r.ours, c)}</td><td class="n">${near0(r.diff) ? "—" : fmt(r.diff, c)}</td><td class="n m">${r.a2x_lines} / ${r.our_lines}</td></tr>`;
      if (open) h += `<tr class="detail"><td colspan="6">${cmpLinesHtml(c)}</td></tr>`;
    }
    return h + `</tbody></table><div class="m">Amounts are debits (+) and credits (−). Click an account to see both sets of lines.</div>`;
  }
  function cmpLinesHtml(cur) {
    const L = S.cmpLines;
    if (!L) return `<div class="m">Loading lines…</div>`;
    const col = (title, ls) => `<div><h3>${title}</h3><table>${ls.length ? ls.map(l => `<tr><td class="m">${esc(l.description || "—")}${l.doc ? `<div class="m">${esc(l.doc)}</div>` : ""}</td><td class="n">${fmt(l.amount, cur)}</td></tr>`).join("") : '<tr><td class="m">none</td></tr>'}</table></div>`;
    return `<div class="det">${col("A2X", L.a2x)}${col("Seller Sage", L.ours)}</div>`;
  }
  async function openCmpAcct(k) {
    if (S.cmpAcct === k) { S.cmpAcct = null; compare(); return; }
    S.cmpAcct = k; S.cmpLines = null; compare();
    const [kind, account] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
    try {
      const [a2x, ours] = await Promise.all([
        FIN.sql(`select doc, description, amount from fin.amz_a2x_lines where settlement_id = ${q(S.cmpOpen)} and kind = ${q(kind)} and account = ${q(account)} and amount <> 0 order by abs(amount) desc`),
        FIN.sql(`select doc, description, amount from fin.v_amz_ours_lines where settlement_id = ${q(S.cmpOpen)} and kind = ${q(kind)} and account = ${q(account)} order by abs(amount) desc`),
      ]);
      if (S.cmpAcct === k) S.cmpLines = { a2x: a2x.map(l => ({ ...l, amount: +l.amount })), ours: ours.map(l => ({ ...l, amount: +l.amount })) };
    } catch (e) { S.cmpLines = { a2x: [], ours: [] }; note("bad", "Couldn't load the lines: " + esc(e.message || e)); }
    compare();
  }
  async function readA2x() {
    const b = $("az-cmp-read"); b.disabled = true; b.textContent = "Reading from QuickBooks…";
    try {
      let more = true, n = 0;
      for (let i = 0; more && i < 6; i++) { const r = await call({ action: "a2x_lines" }, "QuickBooks"); n += r.read.length; more = r.more && r.read.length > 0; }
      note("", `Read A2X's entries for ${n} settlement${n === 1 ? "" : "s"}.`);
    } catch (e) { note("bad", "Couldn't read A2X's entries: " + esc(e.message || e)); }
    b.disabled = false; b.textContent = "Read A2X entries";
    FIN.clear(); await load(true); loadCompare(true);
  }
  function exportCmp() {
    if (!S.cmp) return;
    const info = new Map(S.rows.map(r => [r.settlement_id, r]));
    const q = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
    const lines = [["settlement_id", "market", "start", "end", "entry", "currency", "account", "a2x", "seller_sage", "difference"]];
    for (const r of S.cmp) { const s = info.get(r.settlement_id) || {}; lines.push([r.settlement_id, s.market, String(s.start_at || "").slice(0, 10), String(s.end_at || "").slice(0, 10), r.kind, r.kind === "cogs" ? "USD" : s.currency, r.account, r.a2x.toFixed(2), r.ours.toFixed(2), r.diff.toFixed(2)]); }
    FIN.download(`a2x-vs-seller-sage-${new Date().toISOString().slice(0, 10)}.csv`, lines.map(r => r.map(q).join(",")).join("\n"));
  }

  // ---------- product costs: Seller Sage's cost (the Amazon mapping) for every SKU sold in the payouts on the page — what
  // each payout's cost of goods is made of (fin.v_amz_sku_costs)
  async function loadSku(refresh) {
    try {
      const rows = await FIN.sql("select sku, units, settlements, markets, fulfillment, cost, map_units, name, shopify_unit_cost, cogs from fin.v_amz_sku_costs", refresh);
      S.sku = rows.map(r => ({ ...r, units: +r.units, cost: r.cost == null ? null : +r.cost, cogs: r.cogs == null ? null : +r.cogs })); S.skuErr = null;
    } catch (e) { S.skuErr = e; }
    skuCheck();
  }
  function skuCheck() {
    const box = $("az-sku"); if (!box) return;
    if (S.skuErr) { box.innerHTML = `<div class="note bad">Couldn't load: ${esc(S.skuErr.message || S.skuErr)}</div>`; return; }
    if (!S.sku) { box.innerHTML = `<div class="m">Loading…</div>`; return; }
    const rows = S.sku, none = rows.filter(r => r.cost == null);
    const card = (cls, k, v, s2) => `<div class="card ${cls}"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s2}</span></div>`;
    const units = rows.reduce((a, r) => a + r.units, 0), cogs = rows.reduce((a, r) => a + (r.cogs || 0), 0);
    let h = `<section class="cards">${[
      card("", "SKUs sold", rows.length.toLocaleString(), `${units.toLocaleString()} units in ${S.rows.length} payouts`),
      card("", "Cost of goods", short(cogs), `${units ? fmt(cogs / units) : "—"} a unit on average`),
      card(none.length ? "red" : "green", "SKUs with no cost", String(none.length), none.length ? `${none.reduce((a, r) => a + r.units, 0).toLocaleString()} units left out of cost of goods — set them in the Amazon mapping` : "every SKU sold has a cost"),
    ].join("")}</section>`;
    const q = S.skuQ;
    const list = rows.filter(r => (S.skuF !== "none" || r.cost == null) && (!q || `${r.sku} ${r.name || ""}`.toLowerCase().includes(q)))
      .sort((a, b) => (b.cogs || 0) - (a.cogs || 0) || b.units - a.units);
    h += `<div class="filters az-sku-f"><div class="tabs" role="tablist">${[["all", "All"], ["none", `No cost (${none.length})`]].map(([k, l]) => `<button role="tab" data-skuf="${k}" aria-selected="${S.skuF === k}">${l}</button>`).join("")}</div>
      <input id="az-sku-q" type="search" placeholder="Search SKU or product" value="${esc(S.skuQ)}"></div>`;
    h += `<table class="cmp"><thead><tr><th>SKU</th><th>Product</th><th class="n">Units sold</th><th class="n">Cost a unit</th><th class="n">Cost of goods</th></tr></thead><tbody>`;
    for (const r of list.slice(0, S.skuShown)) {
      h += `<tr><td><b>${esc(r.sku)}</b><div class="m">${esc(r.markets || "")} · ${esc(r.fulfillment || "")}${+r.map_units && +r.map_units !== 1 ? ` · ${+r.map_units} × Shopify unit` : ""}</div></td>
        <td>${esc(r.name || "")}</td><td class="n">${r.units.toLocaleString()}</td>
        <td class="n">${r.cost == null ? '<span class="pill over">no cost</span>' : fmt(r.cost)}${+r.map_units && +r.map_units !== 1 && r.shopify_unit_cost != null ? `<div class="m">${+r.map_units} × ${fmt(r.shopify_unit_cost)}</div>` : ""}</td>
        <td class="n">${r.cogs == null ? "—" : fmt(r.cogs)}</td></tr>`;
    }
    h += `</tbody></table>`;
    if (list.length > S.skuShown) h += `<div class="foot"><span>${list.length - S.skuShown} more</span><button class="btn small" type="button" data-skumore>Show more</button></div>`;
    box.innerHTML = h;
  }
  function exportSku() {
    if (!S.sku) return;
    const q = (v) => /[",\n]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : (v ?? "");
    const lines = [["sku", "product", "markets", "fulfillment", "units_sold", "cost_per_unit", "map_units", "cost_of_goods"]];
    for (const r of S.sku.slice().sort((a, b) => (b.cogs || 0) - (a.cogs || 0))) lines.push([r.sku, r.name || "", r.markets || "", r.fulfillment || "", r.units, r.cost ?? "", r.map_units ?? "", r.cogs ?? ""]);
    FIN.download(`amazon-product-costs-${new Date().toISOString().slice(0, 10)}.csv`, lines.map(r => r.map(q).join(",")).join("\n"));
  }

  // ---------- actions
  async function call(body, what) {
    const r = await FIN.fn("amzpay", body);
    if (!r || r.ok === false) throw new Error((r && r.error) || `${what} didn't answer`);
    return r;
  }
  async function refresh() {
    const b = $("az-refresh"); b.disabled = true; b.textContent = "Getting settlements…";
    try {
      const r = await call({ action: "sync" }, "Amazon");
      const n = (r.saved || []).length;
      note("", `${n ? `${n} new settlement${n > 1 ? "s" : ""} from Amazon.` : "No new settlements."}${r.more ? " Amazon hands out a few reports a minute — refresh again shortly for the rest." : ""}`);
      if (n) { b.textContent = "Checking QuickBooks…"; await call({ action: "check" }, "QuickBooks"); }
    } catch (e) { note("bad", "Couldn't refresh: " + esc(e.message || e)); }
    b.disabled = false; b.textContent = "Refresh from Amazon";
    FIN.clear(); load(true);
  }
  async function check() {
    const b = $("az-check"); b.disabled = true; b.textContent = "Checking…";
    try { const r = await call({ action: "check" }, "QuickBooks"); note("", `Checked ${r.checked.length} settlement${r.checked.length === 1 ? "" : "s"} against QuickBooks.`); }
    catch (e) { note("bad", "Couldn't check QuickBooks: " + esc(e.message || e)); }
    b.disabled = false; b.textContent = "Check QuickBooks";
    FIN.clear(); load(true);
  }
  async function postIt(sid) {
    S.busy = "post"; table();
    try {
      const r = await call({ action: "post", settlement_id: sid }, "QuickBooks");
      const made = r.results.filter(x => x.created).length, linked = r.results.filter(x => x.linked).length;
      note("", `Posted to QuickBooks: ${made} journal entr${made === 1 ? "y" : "ies"}${linked ? `, ${linked} already there (linked)` : ""}.`);
    } catch (e) { note("bad", "Couldn't post: " + esc(e.message || e)); }
    S.busy = ""; S.confirm = null;
    FIN.clear(); await load(true);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const main = $("amz");
    main.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-postedmore]")) { S.postedShown = 1e9; table(); return; }
      const a = ev.target.closest("[data-ask]"); if (a) { S.confirm = a.dataset.ask; table(); return; }
      if (ev.target.closest("[data-cancel]")) { S.confirm = null; table(); return; }
      const p = ev.target.closest("[data-post]"); if (p) { postIt(p.dataset.post); return; }
      const c = ev.target.closest("[data-csv]"); if (c) { exportCsv(c.dataset.csv); return; }
      if (ev.target.closest("a, select, button")) return;
      if (ev.target.closest("tr.detail") && !ev.target.closest("tr[data-acct]")) return;
      const sf = ev.target.closest("[data-skuf]"); if (sf) { S.skuF = sf.dataset.skuf; S.skuShown = 150; skuCheck(); return; }
      if (ev.target.closest("[data-skumore]")) { S.skuShown += 300; skuCheck(); return; }
      const ca = ev.target.closest("tr[data-acct]"); if (ca) { openCmpAcct(ca.dataset.acct); return; }
      const cr = ev.target.closest("tr[data-cmp]"); if (cr) { S.cmpOpen = S.cmpOpen === cr.dataset.cmp ? null : cr.dataset.cmp; S.cmpAcct = null; compare(); return; }
      const r = ev.target.closest("tr[data-sid]"); if (r) openEntry(r.dataset.sid);
    });
    main.addEventListener("input", (ev) => { if (ev.target.id === "az-sku-q") { S.skuQ = ev.target.value.trim().toLowerCase(); const pos = ev.target.selectionStart; skuCheck(); const el = $("az-sku-q"); el.focus(); el.setSelectionRange(pos, pos); } });
    $("az-sku-csv").addEventListener("click", exportSku);
    main.addEventListener("change", (ev) => { const s = ev.target.closest("select[data-map]"); if (s) setMap(JSON.parse(s.dataset.map), s.value); });
    $("az-q").addEventListener("input", (ev) => { S.mapQ = ev.target.value.trim().toLowerCase(); mapping(); });
    $("az-refresh").addEventListener("click", refresh);
    $("az-cmp-read").addEventListener("click", readA2x);
    $("az-cmp-csv").addEventListener("click", exportCmp);
    $("az-check").addEventListener("click", check);
    if (!$("amz").hidden) FIN.ready.then(() => { load(false); loadCompare(false); loadSku(false); });
    window.addEventListener("fin:page", (e) => { if (e.detail === "amz") { if (!S.loaded && !S.loading) FIN.ready.then(() => { load(false); loadCompare(false); loadSku(false); }); else render(); } });
  });
})();
