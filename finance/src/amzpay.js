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

  const S = { loaded: false, loading: false, err: null, rows: [], groups: [], map: [], seen: [], coa: [], cfg: {}, open: null, entry: null, entryErr: null, busy: "", confirm: null, filter: "todo", mapQ: "" };

  async function load(refresh) {
    S.loading = true; render();
    try {
      const [rows, groups, map, seen, coa, cfg] = await Promise.all([
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
      ]);
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
    cards(); table(); mapping();
  }
  function cards() {
    const card = (cls, k, v, s, f) => `<button type="button" class="card ${cls}${S.filter === f ? " on" : ""}" data-filter="${f}"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s}</span></button>`;
    const by = (k) => S.rows.filter(r => status(r)[0] === k);
    const sumUsd = (rs) => rs.reduce((a, r) => a + (usd(r) || 0), 0);
    const todo = [...by("ready"), ...by("new")];
    const open = S.groups[0];
    $("az-cards").innerHTML = [
      card(todo.length ? "amber" : "green", "To post", String(todo.length), todo.length ? `${short(sumUsd(todo))} in payouts` : "All caught up", "todo"),
      card("green", "In QuickBooks", String(by("posted").length), `posted from here · ${short(sumUsd(by("posted")))}`, "posted"),
      card("", "Posted by A2X", String(by("a2x").length), "before the switch", "a2x"),
      card("", "All settlements", String(S.rows.length), "the last 90 days", "all"),
      `<div class="card"><span class="k">Next payout</span><span class="v">${open ? fmt(open.original, open.currency).replace(/\.\d\d/, "") : "—"}</span><span class="s">${open ? `${FLAG[{ USD: "US", CAD: "CA", MXN: "MX" }[open.currency]] || open.currency} · building since ${day(open.start_at)}` : "none open"}</span></div>`,
    ].join("");
  }
  function table() {
    const f = S.filter;
    const rows = S.rows.filter(r => { const s = status(r)[0]; return f === "all" ? true : f === "todo" ? s === "ready" || s === "new" : s === f; });
    if (!rows.length) { $("az-table").innerHTML = `<div class="empty">${f === "todo" ? "Nothing waiting to be posted." : "No settlements here."}</div>`; return; }
    let h = `<table><thead><tr><th>Marketplace</th><th>Settlement period</th><th>Paid</th><th class="n">Payout</th><th class="n">In USD</th><th class="n">Units</th><th>Status</th></tr></thead><tbody>`;
    for (const r of rows) {
      const [k, label] = status(r);
      const u = usd(r);
      h += `<tr class="row${S.open === r.settlement_id ? " sel" : ""}" data-sid="${esc(r.settlement_id)}"><td><b>${esc(FLAG[r.market] || r.market)}</b><div class="m">#${esc(r.settlement_id)}</div></td>
        <td>${day(r.start_at)} – ${day(r.end_at, true)}</td><td>${day(r.deposit_date)}</td>
        <td class="n">${fmt(r.total, r.currency)}</td><td class="n">${u == null ? "—" : fmt(u)}</td><td class="n">${Number(r.units || 0).toLocaleString()}</td>
        <td><span class="pill ${k === "posted" ? "paid" : k === "ready" ? "soon" : k === "a2x" ? "open" : "est"}">${esc(label)}</span>${k === "a2x" ? `<div class="m">${esc(r.a2x_docs[0])}${r.a2x_docs.length > 1 ? " +" + (r.a2x_docs.length - 1) : ""}</div>` : ""}</td></tr>`;
      if (S.open === r.settlement_id) h += `<tr class="detail"><td colspan="7">${detail(r)}</td></tr>`;
    }
    $("az-table").innerHTML = h + "</tbody></table>";
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
      const f = ev.target.closest("[data-filter]"); if (f) { S.filter = f.dataset.filter; render(); return; }
      const a = ev.target.closest("[data-ask]"); if (a) { S.confirm = a.dataset.ask; table(); return; }
      if (ev.target.closest("[data-cancel]")) { S.confirm = null; table(); return; }
      const p = ev.target.closest("[data-post]"); if (p) { postIt(p.dataset.post); return; }
      const c = ev.target.closest("[data-csv]"); if (c) { exportCsv(c.dataset.csv); return; }
      if (ev.target.closest("a, select, button, tr.detail")) return;
      const r = ev.target.closest("tr[data-sid]"); if (r) openEntry(r.dataset.sid);
    });
    main.addEventListener("change", (ev) => { const s = ev.target.closest("select[data-map]"); if (s) setMap(JSON.parse(s.dataset.map), s.value); });
    $("az-q").addEventListener("input", (ev) => { S.mapQ = ev.target.value.trim().toLowerCase(); mapping(); });
    $("az-refresh").addEventListener("click", refresh);
    $("az-check").addEventListener("click", check);
    if (!$("amz").hidden) FIN.ready.then(() => load(false));
    window.addEventListener("fin:page", (e) => { if (e.detail === "amz") { if (!S.loaded && !S.loading) FIN.ready.then(() => load(false)); else render(); } });
  });
})();
