// Credit cards page (Nov 4, Brian: "let's pull all of the credit card info in to the mix and let's start tracking
// balances and due dates" → "let's connect plaid"). Each card login is linked through Plaid (Liabilities): statement
// balance, minimum, due date, credit limit, last payment and APR, refreshed daily (fin-card-sync) or with Refresh.
// Each Plaid card is matched to its QuickBooks card (by last 4, or picked here); QuickBooks' balance shows beside it,
// and the card's close / due days go to the cash forecast. QuickBooks cards with nothing linked are listed too.
// Data: fin.v_card_status (migration 205), fin.v_cards; writes: the bank edge function, fin_bank_account_set.
(() => {
  const $ = (id) => document.getElementById(id);
  if (!$("cards")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const money = (v) => v == null || v === "" || isNaN(v) ? "—" : (v < 0 ? "−" : "") + "$" + Math.abs(Number(v)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const short = (v) => { v = Number(v) || 0; const a = Math.abs(v); return a >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : a >= 1e4 ? "$" + Math.round(v / 1e3) + "K" : a >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "K" : "$" + Math.round(v).toLocaleString("en-US"); };
  const fmtD = (s) => s ? new Date(String(s).slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
  const when = (t) => { const d = new Date(t); return !t || isNaN(d) ? "" : d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  const S = { rows: [], qbo: [], loaded: false, loading: false, err: null, status: null, busy: "", note: "", bad: false };
  const num = (x) => x == null ? null : Number(x);

  async function load(refresh) {
    S.loading = true; render();
    try {
      const [rows, qbo, st] = await Promise.all([
        FIN.sql("select * from fin.v_card_status order by institution, name", refresh).catch(() => null),
        FIN.sql("select account_id, name, owed, close_day, due_day, updated_by from fin.v_cards order by owed desc", refresh),
        FIN.fn("bank", { action: "status" }).catch(e => ({ ok: false, error: (e && e.message) || String(e) })),
      ]);
      S.rows = rows || []; S.missing = rows == null; S.qbo = qbo || []; S.status = st;
      S.loaded = true; S.err = null;
    } catch (e) { S.err = e; }
    S.loading = false; render();
  }

  // ---- Plaid Link
  let linkLib = null;
  const loadLink = () => linkLib || (linkLib = new Promise((ok, no) => {
    if (window.Plaid) return ok(window.Plaid);
    const s = document.createElement("script"); s.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    s.onload = () => ok(window.Plaid); s.onerror = () => { linkLib = null; no(new Error("Couldn't load Plaid Link")); };
    document.head.appendChild(s);
  }));
  async function link(itemId) {
    S.busy = itemId ? "relink:" + itemId : "link"; S.note = ""; render();
    try {
      const [Plaid, t] = await Promise.all([loadLink(), FIN.fn("bank", itemId ? { action: "link_token", item_id: itemId } : { action: "link_token", kind: "card" })]);
      if (!t || !t.ok) throw new Error((t && t.error) || "Plaid didn't give a link token");
      const h = Plaid.create({
        token: t.link_token,
        onSuccess: async (public_token, meta) => {
          if (itemId) { S.busy = ""; msg(`Signed in to ${esc((meta.institution || {}).name || "the bank")} again.`); await refreshCards(itemId); return; }
          S.busy = "link"; render();
          const r = await FIN.fn("bank", { action: "exchange", kind: "card", public_token, institution: meta.institution || null }).catch(e => ({ ok: false, error: e.message }));
          S.busy = "";
          if (!r || !r.ok) msg(`Linked, but couldn't read the cards: ${esc((r && r.error) || "")}`, true);
          else msg(`Linked <b>${esc((meta.institution || {}).name || "the card account")}</b>: ${r.cards} card${r.cards === 1 ? "" : "s"}.`);
          FIN.clear(); await load(true);
        },
        onExit: (err) => { S.busy = ""; if (err) msg(`Plaid: ${esc(err.display_message || err.error_message || err.error_code || "closed")}`, true); else render(); },
      });
      h.open();
    } catch (e) { S.busy = ""; msg(esc(e.message || String(e)), true); }
  }
  async function refreshCards(itemId) {
    S.busy = "refresh"; render();
    const r = await FIN.fn("bank", itemId ? { action: "liab", item_id: itemId } : { action: "liab" }).catch(e => ({ ok: false, error: e.message }));
    S.busy = "";
    if (!r || !r.ok) msg(`Couldn't refresh: ${esc((r && r.error) || "")}`, true);
    else { const bad = (r.items || []).filter(i => i.error); msg(bad.length ? `Refreshed, but ${bad.map(i => esc(i.institution || "a bank") + ": " + esc(i.error)).join("; ")}` : `Refreshed ${n((r.items || []).length)} card login${(r.items || []).length === 1 ? "" : "s"}.`, bad.length > 0); }
    FIN.clear(); await load(true);
  }
  const n = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");
  function msg(h, bad) { S.note = h; S.bad = !!bad; render(); }
  async function setQbo(accountId, qboId) {
    try { await FIN.write("fin_bank_account_set", { p: { account_id: accountId, qbo_account_id: qboId } }); FIN.clear(); await load(true); }
    catch (e) { msg(`Couldn't change it: ${esc(e.message)}`, true); }
  }

  function render() {
    const sub = $("cc-sub"), note = $("cc-note");
    note.hidden = !S.note; note.className = "note" + (S.bad ? " bad" : ""); note.innerHTML = S.note;
    $("cc-link").disabled = !!S.busy; $("cc-link").textContent = S.busy === "link" ? "Linking…" : "Link a card account";
    $("cc-refresh").disabled = !!S.busy || !S.rows.length; $("cc-refresh").textContent = S.busy === "refresh" ? "Refreshing…" : "Refresh from banks";
    if (S.loading && !S.loaded) { sub.textContent = "Loading…"; return; }
    if (S.err) { sub.innerHTML = `<span class="neg">Couldn't load: ${esc(S.err.message || S.err)}</span>`; return; }
    const st = S.status || {};
    const setup = $("cc-setup");
    setup.hidden = !(S.missing || st.plaid === false || (st.ok === false && /not set up|Vault|not allowed|404|Function not found|non-2xx/i.test(st.error || "")));
    if (!setup.hidden) setup.innerHTML = S.missing ? "The card tables aren't in the database yet (migration 205)."
      : st.plaid === false ? `<b>Plaid isn't connected yet.</b> In Supabase → Project Settings → Vault, add three secrets from your Plaid dashboard (Developers → Keys): <code>plaid_client_id</code>, <code>plaid_secret</code> (the Production secret) and <code>plaid_env</code> = <code>production</code>. Then <b>Link a card account</b> here: Amex, Chase, and Bank of America (Merrill cards are usually under the BofA login).`
      : `The bank function isn't answering: ${esc(st.error || "")}`;
    const rows = S.rows.filter(r => r.active !== false);
    const linkedQbo = new Set(rows.map(r => r.qbo_account_id).filter(Boolean));
    const unlinked = S.qbo.filter(q => Number(q.owed) > 0 && !linkedQbo.has(q.account_id));
    const owedNow = (r) => num(r.current) != null ? num(r.current) : num(r.qbo_owed) || 0;
    const tot = rows.reduce((a, r) => a + (owedNow(r) || 0), 0) + unlinked.reduce((a, q) => a + Number(q.owed || 0), 0);
    const stmt = rows.reduce((a, r) => a + (num(r.last_statement_balance) || 0), 0);
    const lim = rows.reduce((a, r) => a + (num(r.credit_limit) || 0), 0), limBal = rows.filter(r => num(r.credit_limit) > 0).reduce((a, r) => a + (owedNow(r) || 0), 0);
    const soon = rows.filter(r => r.due_in_days != null && r.due_in_days >= 0 && r.due_in_days <= 7);
    const next = rows.filter(r => r.next_payment_due_date && r.due_in_days >= 0).sort((a, b) => a.due_in_days - b.due_in_days)[0];
    const synced = rows.map(r => r.liab_synced_at).filter(Boolean).sort().pop();
    sub.textContent = rows.length ? `${n(rows.length)} card${rows.length === 1 ? "" : "s"} from Plaid${synced ? ` · updated ${when(synced)}` : ""} · daily at 6 am` : "No cards linked through Plaid yet";
    const card = (k, v, s, c) => `<div class="card ${c || ""}"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s}</span></div>`;
    $("cc-cards").innerHTML = [
      card("Owed now", short(tot), `all cards${unlinked.length ? ` (${unlinked.length} from QuickBooks only)` : ""}`),
      card("Statement balances", rows.length ? short(stmt) : "—", "what the last statements say is due"),
      card("Due in 7 days", soon.length ? short(soon.reduce((a, r) => a + (num(r.last_statement_balance) || 0), 0)) : "$0", soon.length ? soon.map(r => esc(r.institution || r.name)).join(", ") : "nothing", soon.length ? "warn" : ""),
      card("Next due", next ? fmtD(next.next_payment_due_date) : "—", next ? `${esc(next.institution)} ${esc(next.mask ? "··" + next.mask : "")} · ${money(next.last_statement_balance)}` : "link a card to see due dates"),
      card("Credit used", lim ? Math.round(limBal / lim * 100) + "%" : "—", lim ? `${short(limBal)} of ${short(lim)} limits` : "no limits from Plaid yet", lim && limBal / lim > 0.7 ? "warn" : ""),
    ].join("");
    const qOpts = (sel) => `<option value="">— not matched —</option>` + S.qbo.map(q => `<option value="${esc(q.account_id)}" ${q.account_id === sel ? "selected" : ""}>${esc(q.name)}</option>`).join("");
    const dueCell = (r) => {
      if (!r.next_payment_due_date) return '<span class="m">no due date yet</span>';
      const d = r.due_in_days, paid = r.last_payment_date && r.last_statement_issue_date && r.last_payment_date >= r.last_statement_issue_date && (num(r.last_payment_amount) || 0) >= (num(r.minimum_payment_amount) || 0);
      const pill = r.is_overdue ? '<span class="pill over">Overdue</span>' : paid ? '<span class="pill paid">Paid</span>' : d < 0 ? '<span class="pill over">Past due date</span>' : d <= 7 ? `<span class="pill soon">in ${d} day${d === 1 ? "" : "s"}</span>` : `<span class="pill open">in ${d} days</span>`;
      return `${fmtD(r.next_payment_due_date)} ${pill}`;
    };
    const apr = (r) => { const a = (r.aprs || []).find(x => x.apr_type === "purchase_apr") || (r.aprs || [])[0]; return a && a.apr_percentage != null ? `${Number(a.apr_percentage).toFixed(2)}% APR` : ""; };
    const row = (r) => {
      const util = num(r.credit_limit) > 0 ? owedNow(r) / num(r.credit_limit) : null, diff = r.qbo_account_id && num(r.current) != null ? num(r.current) - (num(r.qbo_owed) || 0) : null;
      return `<tr>
        <td><b>${esc(r.institution || "")}</b> <span class="m">${esc(r.name)}${r.mask ? " ··" + esc(r.mask) : ""}</span>${r.item_status === "error" ? `<div class="neg small">${esc(r.item_error || "needs signing in again")} <button class="btn small" type="button" data-cc-relink="${esc(r.item_id)}">Sign in again</button></div>` : ""}</td>
        <td><select data-cc-qbo="${esc(r.account_id)}" aria-label="QuickBooks card">${qOpts(r.qbo_account_id)}</select>${r.qbo_account_id ? `<div class="m">QuickBooks: ${money(r.qbo_owed)}${diff != null && Math.abs(diff) >= 1 ? ` · <span class="${Math.abs(diff) > 100 ? "neg" : ""}" title="The bank's balance now vs QuickBooks' (charges not in QuickBooks yet, or payments not recorded)">${diff > 0 ? "bank" : "QuickBooks"} ${money(Math.abs(diff))} higher</span>` : ""}</div>` : ""}</td>
        <td class="n"><b>${money(r.current)}</b>${num(r.available) != null ? `<div class="m">${money(r.available)} available</div>` : ""}</td>
        <td class="n">${money(r.credit_limit)}${util != null ? `<div class="m ${util > 0.7 ? "neg" : ""}">${Math.round(util * 100)}% used</div>` : ""}</td>
        <td class="n">${money(r.last_statement_balance)}${r.last_statement_issue_date ? `<div class="m">closed ${fmtD(r.last_statement_issue_date)}</div>` : ""}</td>
        <td class="n">${money(r.minimum_payment_amount)}</td>
        <td>${dueCell(r)}</td>
        <td>${r.last_payment_date ? `${money(r.last_payment_amount)}<div class="m">${fmtD(r.last_payment_date)}</div>` : '<span class="m">—</span>'}</td>
        <td class="m">${esc(apr(r))}</td></tr>`;
    };
    const head = `<thead><tr><th>Card</th><th>QuickBooks card</th><th class="n">Balance now</th><th class="n">Limit</th><th class="n">Statement</th><th class="n">Minimum</th><th>Due</th><th>Last payment</th><th>Rate</th></tr></thead>`;
    $("cc-table").innerHTML = rows.length || unlinked.length ? `<table>${head}<tbody>${rows.sort((a, b) => (a.due_in_days ?? 999) - (b.due_in_days ?? 999)).map(row).join("")}
      ${unlinked.map(q => `<tr class="dim"><td><b>${esc(q.name)}</b><div class="m">QuickBooks only — not linked through Plaid</div></td><td class="m">—</td><td class="n">${money(q.owed)}<div class="m">per QuickBooks</div></td><td class="n m">—</td><td class="n m">—</td><td class="n m">—</td><td class="m">${q.due_day ? `due day ${q.due_day} (typed)` : "—"}</td><td class="m">—</td><td></td></tr>`).join("")}</tbody></table>`
      : `<div class="hint" style="padding:14px">No cards yet. <b>Link a card account</b> to bring in balances, statements and due dates.</div>`;
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("cc-link").addEventListener("click", () => link(null));
    $("cc-refresh").addEventListener("click", () => refreshCards(null));
    $("cards").addEventListener("click", (e) => { const b = e.target.closest("[data-cc-relink]"); if (b) link(b.dataset.ccRelink); });
    $("cards").addEventListener("change", (e) => { const s = e.target.closest("[data-cc-qbo]"); if (s) setQbo(s.dataset.ccQbo, s.value); });
    window.addEventListener("fin:page", (e) => { if (e.detail === "cards") { if (!S.loaded && !S.loading) FIN.ready.then(() => load(false)); else render(); } });
    if ((location.hash || "") === "#cards") FIN.ready.then(() => { if (!S.loaded && !S.loading) load(false); });   // opened straight on this page
  });
})();
