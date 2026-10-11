// Shopify payouts page, part 2 — money outside Shopify Payments (manual / wholesale, cash, PayPal, gift cards):
//  · Other payments: what was marked paid in Shopify, a week per journal entry (fin.shop_pay_entry), Send to QuickBooks
//  · Clearing accounts: those payments against the deposits categorized to the same account in QuickBooks — what's left
//    open (paid in Shopify, not deposited yet, or the other way round)
//  · Waiting for payment: orders that still owe money (Shopify's outstanding amount)
// Other payments and Waiting for payment are the store's (FIN.store); the clearing accounts are shared by both stores.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (v) => { const n = Number(v) || 0; return (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const f0 = (v) => { const n = Math.round(Number(v) || 0); return (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US"); };
  const day = (s, y) => s ? new Date(String(s).slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", ...(y ? { year: "numeric" } : {}), timeZone: "UTC" }) : "—";
  const QBO_JE = (id) => `https://qbo.intuit.com/app/journal?txnId=${encodeURIComponent(id)}`;
  const GW = { manual: "Manual", cash: "Cash", paypal: "PayPal", gift_card: "Gift card", shop_cash: "Shop Cash" };
  const gwName = (g) => GW[String(g).toLowerCase()] || g;
  const num = (r, ks) => { for (const k of ks) r[k] = +r[k] || 0; return r; };

  const S = { loaded: false, loading: false, err: null, weeks: [], clr: [], due: [], open: null, entry: null, entryErr: null, confirm: null, busy: "",
    acct: null, acctRows: null, dueShown: 25, closed: [], admin: "", st: "", closeAsk: null };
  const KEY = { justtennis: "shop_post", acenrally: "shop_post_acenrally" };
  const ST = () => KEY[FIN.store] ? FIN.store : "justtennis";

  async function load(refresh) {
    const st = ST();
    if (S.st !== st) { S.st = st; S.loaded = false; S.open = null; S.entry = null; S.confirm = null; S.closeAsk = null; S.dueShown = 25; render(); }
    S.loading = true;
    try {
      const [weeks, clr, due, closed, store] = await Promise.all([
        FIN.sql(`select week_end, week_start, posted, complete, payments, orders, amount, sales, shipping, tax, refunds, a2x_pending, cogs, orders_missing_cost, unknown_gateway, by_gateway
                 from fin.v_shop_pay_weeks where store = '${st}' order by week_end desc`, refresh),
        FIN.sql("select account, paid, payments, last_paid, deposited, deposits, last_dep, open_balance, qbo_balance, qbo_synced_at from fin.v_shop_clearing order by account", refresh),
        FIN.sql(`select order_id, name, order_day, source_name, financial_status, total, outstanding, paid, gateways, days_old from fin.v_shop_due where store = '${st}' order by created_at`, refresh),
        FIN.sql(`select order_id, name, total, outstanding, closed_by, closed_at from fin.v_shop_due_closed where store = '${st}' order by closed_at desc`, refresh),
        FIN.sql(`select value->>'admin_store' as store from fin.settings where key = '${KEY[st]}'`, refresh),
      ]);
      if (st !== ST()) return;   // switched stores meanwhile
      S.closed = closed.map(r => ({ ...r, total: r.total == null ? null : +r.total, outstanding: +r.outstanding }));
      S.admin = (store[0] && store[0].store) || "";
      S.weeks = weeks.map(r => num({ ...r, posted: r.posted || {}, by_gateway: r.by_gateway || {} }, ["payments", "orders", "amount", "sales", "shipping", "tax", "refunds", "a2x_pending", "cogs", "orders_missing_cost", "unknown_gateway"]));
      S.clr = clr.map(r => num({ ...r }, ["paid", "payments", "deposited", "deposits", "open_balance"]));
      S.due = due.map(r => num({ ...r }, ["total", "outstanding", "paid", "days_old"]));
      S.err = null; S.loaded = true;
    } catch (e) { S.err = e; }
    S.loading = false; render();
    if (S.open) openWeek(S.open, true);
    if (S.acct) openAcct(S.acct, true);
  }
  function render() { weeks(); clearing(); dueList(); }

  // ---------- other payments, a week at a time
  const weekStatus = (w) => Object.keys(w.posted).length ? ["posted", "In QuickBooks"] : !w.complete ? ["new", "Week not over"] : ["ready", "Ready to post"];
  // weeks not in QuickBooks go to "Other payments to post"; posted ones sit under Posted
  function weeks() {
    const box = $("so-weeks"), pbox = $("so-posted"); if (!box) return;
    if (S.err) { box.innerHTML = `<div class="note bad">Couldn't load: ${esc(S.err.message || S.err)}</div>`; return; }
    if (!S.loaded) { box.innerHTML = `<div class="m">${S.loading ? "Loading…" : ""}</div>`; if (pbox) pbox.innerHTML = ""; const d = $("so-due"); if (d) d.innerHTML = ""; return; }
    const todo = S.weeks.filter(w => !Object.keys(w.posted).length), done = S.weeks.filter(w => Object.keys(w.posted).length);
    box.innerHTML = todo.length ? weekTable(todo) : `<div class="empty">${S.weeks.length ? "Nothing waiting to be posted." : "No manual, cash or PayPal payments since the switch yet — they come in with the hourly Shopify sync."}</div>`;
    if (pbox) pbox.innerHTML = done.length ? weekTable(done) : `<div class="empty">No other-payment weeks posted yet.</div>`;
  }
  function weekTable(list) {
    let h = `<table class="az-pay"><thead><tr><th>Week</th><th>Paid by</th><th class="n">Sales</th><th class="n">Shipping</th><th class="n">Sales tax</th><th class="n">Refunds</th><th class="n">Total paid</th><th class="n">Cost of goods</th><th>Status</th></tr></thead><tbody>`;
    for (const w of list) {
      const [k, label] = weekStatus(w);
      const by = Object.entries(w.by_gateway).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([g, a]) => `${esc(gwName(g))} ${f0(a)}`).join(" · ");
      const cell = (v) => `<td class="n">${Math.abs(v || 0) >= 0.5 ? f0(v) : "—"}</td>`;
      h += `<tr class="row${S.open === w.week_end ? " sel" : ""}" data-week="${esc(w.week_end)}"><td><b>${day(w.week_start)} – ${day(w.week_end, true)}</b><div class="m">${w.orders} order${w.orders === 1 ? "" : "s"} · ${w.payments} payment${w.payments === 1 ? "" : "s"}</div></td>
        <td class="m">${by}${w.unknown_gateway ? ' <span class="pill soon">check</span>' : ""}</td>
        <td class="n">${Math.abs(w.sales) >= 0.5 ? f0(w.sales) : "—"}${Math.abs(w.a2x_pending) >= 0.5 ? `<div class="m" title="Payments for orders A2X already booked as sales — they clear Shopify Pending Balances">+${f0(w.a2x_pending)} A2X-booked</div>` : ""}</td>
        ${cell(w.shipping)}${cell(w.tax)}${cell(w.refunds)}<td class="n"><b>${fmt(w.amount)}</b></td>
        <td class="n">${f0(w.cogs)}${w.orders_missing_cost ? `<div class="m negt">${w.orders_missing_cost} missing cost</div>` : ""}</td>
        <td><span class="pill ${k === "posted" ? "paid" : k === "ready" ? "soon" : "est"}">${esc(k === "posted" ? "Seller Sage" : label)}</span></td></tr>`;
      if (S.open === w.week_end) h += `<tr class="detail"><td colspan="9">${weekDetail(w)}</td></tr>`;
    }
    return h + `</tbody></table>`;
  }
  async function openWeek(we, keep) {
    if (!keep && S.open === we) { S.open = null; S.entry = null; weeks(); return; }
    S.open = we; S.entry = null; S.entryErr = null; S.confirm = null; weeks();
    try { S.entry = await FIN.rpc("fin_shop_pay_entry", { we, st: S.st }); } catch (e) { S.entryErr = e; }
    if (S.open === we) weeks();
  }
  function weekDetail(w) {
    if (S.entryErr) return `<div class="note bad">Couldn't build the entry: ${esc(S.entryErr.message || S.entryErr)}</div>`;
    const e = S.entry;
    if (!e || String(e.week?.week_end) !== String(w.week_end)) return `<div class="m">Building the entry…</div>`;
    const probs = e.problems || [], blocking = probs.filter(p => p.kind === "total");
    let h = probs.map(p => `<div class="note ${p.kind === "total" ? "bad" : ""}">${esc(p.message)}</div>`).join("");
    h += `<div class="az-parts">`;
    for (const p of e.parts) {
      const dr = p.lines.reduce((a, l) => a + (l.amount > 0 ? +l.amount : 0), 0), cr = p.lines.reduce((a, l) => a + (l.amount < 0 ? -l.amount : 0), 0);
      h += `<div class="az-part"><div class="az-ph"><div><b>${esc(p.doc)}</b> <span class="m">${p.kind === "cogs" ? "cost of goods" : "payments"} · dated ${day(p.date, true)}</span></div>
        ${p.posted?.id ? `<a class="pill paid" href="${QBO_JE(p.posted.id)}" target="_blank" rel="noopener">In QuickBooks ↗</a>` : ""}</div>
        <table class="az-lines"><thead><tr><th>Account</th><th>Description</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>
        ${p.lines.map(l => `<tr class="${l.review ? "rev" : ""}"><td>${esc(l.account)}${l.review ? ' <span class="pill soon">check</span>' : ""}</td><td class="m">${esc(l.description)}</td>
          <td class="n">${l.amount > 0 ? fmt(l.amount) : ""}</td><td class="n">${l.amount < 0 ? fmt(-l.amount) : ""}</td></tr>`).join("")}
        </tbody><tfoot><tr><td colspan="2"><b>Total</b> ${Math.abs(dr - cr) < 0.005 ? '<span class="pill paid">balanced</span>' : '<span class="pill over">doesn\'t balance</span>'}</td><td class="n"><b>${fmt(dr)}</b></td><td class="n"><b>${fmt(cr)}</b></td></tr></tfoot></table></div>`;
    }
    h += `</div>`;
    const todo = e.parts.filter(p => !p.posted?.id).length;
    h += `<div class="az-actions">`;
    if (!blocking.length && todo) {
      h += S.confirm === w.week_end
        ? `<span>Post ${todo} journal entr${todo === 1 ? "y" : "ies"} to QuickBooks?</span><button class="btn primary" type="button" data-sopost="${esc(w.week_end)}" ${S.busy ? "disabled" : ""}>${S.busy === "post" ? "Posting…" : "Yes, post"}</button><button class="btn" type="button" data-socancel>Cancel</button>`
        : `<button class="btn primary" type="button" data-soask="${esc(w.week_end)}">Send to QuickBooks</button><span class="m">${todo} entr${todo === 1 ? "y" : "ies"}</span>`;
    } else if (!todo) h += `<span class="m">This week is in QuickBooks.</span>`;
    return h + `</div>`;
  }
  async function postWeek(we) {
    S.busy = "post"; weeks();
    try {
      const r = await FIN.fn("amzpay", { action: "shop_pay_post", week_end: we, store: S.st });
      if (!r || r.ok === false) throw new Error((r && r.error) || "QuickBooks didn't answer");
      const made = r.results.filter(x => x.created).length, linked = r.results.filter(x => x.linked).length;
      note("", `Posted to QuickBooks: ${made} journal entr${made === 1 ? "y" : "ies"}${linked ? `, ${linked} already there (linked)` : ""}.`);
    } catch (e) { note("bad", "Couldn't post: " + esc(e.message || e)); }
    S.busy = ""; S.confirm = null; FIN.clear(); await load(true);
  }
  function note(cls, html) { const n = $("sp-note"); n.className = "note " + (cls || ""); n.innerHTML = html; n.hidden = !html; }

  // ---------- clearing accounts
  function clearing() {
    const box = $("so-clearing"); if (!box || !S.loaded) return;
    const rows = S.clr.filter(r => r.payments || r.deposits || Math.abs(r.qbo_balance || 0) >= 0.005);
    if (!rows.length) { box.innerHTML = `<div class="empty">Nothing on the clearing accounts yet.</div>`; return; }
    let h = `<table class="az-pay"><thead><tr><th>Clearing account</th><th class="n">Paid in Shopify</th><th class="n">Deposited (QuickBooks)</th><th class="n">Open since the switch</th><th class="n">QuickBooks balance</th></tr></thead><tbody>`;
    for (const r of rows) {
      const open = Math.abs(r.open_balance) >= 0.005;
      h += `<tr class="row${S.acct === r.account ? " sel" : ""}" data-acct="${esc(r.account)}"><td><b>${esc(r.account)}</b></td>
        <td class="n">${fmt(r.paid)}<div class="m">${r.payments} payment${r.payments === 1 ? "" : "s"}${r.last_paid ? ` · last ${day(r.last_paid)}` : ""}</div></td>
        <td class="n">${fmt(-r.deposited)}<div class="m">${r.deposits} line${r.deposits === 1 ? "" : "s"}${r.last_dep ? ` · last ${day(r.last_dep)}` : ""}</div></td>
        <td class="n ${open ? (r.open_balance > 0 ? "" : "negt") : ""}"><b>${open ? fmt(r.open_balance) : "—"}</b><div class="m">${!open ? "all deposited" : r.open_balance > 0 ? "paid, not deposited yet" : "deposited, not paid in Shopify"}</div></td>
        <td class="n">${r.qbo_balance == null ? "—" : fmt(r.qbo_balance)}${r.qbo_synced_at ? `<div class="m">as of ${new Date(r.qbo_synced_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>` : ""}</td></tr>`;
      if (S.acct === r.account) h += `<tr class="detail"><td colspan="5">${acctDetail()}</td></tr>`;
    }
    box.innerHTML = h + `</tbody></table>`;
  }
  async function openAcct(a, keep) {
    if (!keep && S.acct === a) { S.acct = null; clearing(); return; }
    S.acct = a; S.acctRows = null; clearing();
    const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
    try {
      const [pays, deps] = await Promise.all([
        FIN.sql(`select day, order_name, gateway, kind, amount, a2x, store from fin.v_shop_other_tx where after_switch and account = ${q(a)} order by processed_at desc limit 300`),
        FIN.sql(`select c.txn_date, c.txn_type, c.doc, c.memo, c.amount from fin.qbo_clearing c where c.account = ${q(a)} and c.doc not like 'SSP%'
                 and c.txn_date > (select (value->>'a2x_until')::date from fin.settings where key = 'shop_post') order by c.txn_date desc limit 300`),
      ]);
      if (S.acct === a) S.acctRows = { pays, deps };
    } catch (e) { S.acctRows = { pays: [], deps: [], err: e }; }
    clearing();
  }
  function acctDetail() {
    const R = S.acctRows; if (!R) return `<div class="m">Loading…</div>`;
    if (R.err) return `<div class="note bad">${esc(R.err.message || R.err)}</div>`;
    const col = (title, rows, f) => `<div><h3>${title}</h3><table>${rows.length ? rows.map(f).join("") : '<tr><td class="m">none</td></tr>'}</table></div>`;
    return `<div class="det">${col("Paid in Shopify", R.pays, p => `<tr><td>${day(p.day)} <b>${esc(p.order_name || "")}</b><div class="m">${p.store === "acenrally" ? "Ace n Rally · " : ""}${esc(gwName(p.gateway))}${p.kind === "REFUND" ? " refund" : ""}${p.a2x ? " · A2X booked the sale" : ""}</div></td><td class="n">${fmt(p.amount)}</td></tr>`)}
      ${col("In QuickBooks (deposits and other entries)", R.deps, d => `<tr><td>${day(d.txn_date)} <span class="m">${esc(d.txn_type)}${d.doc ? " " + esc(d.doc) : ""}</span><div class="m">${esc(d.memo || "")}</div></td><td class="n">${fmt(-d.amount)}</td></tr>`)}</div>
      <div class="m">To clear a payment: mark the order paid in Shopify, and categorize the bank deposit to this account in QuickBooks. "Check QuickBooks" at the top reads the deposits.</div>`;
  }

  // ---------- orders waiting for payment
  // the store's Shopify admin handle comes from the settings (the Shopify sync fills it in)
  const ADMIN = () => S.admin || (S.st === "justtennis" ? "justtennis-822" : "");
  const ORDER_URL = (id) => `https://admin.shopify.com/store/${encodeURIComponent(ADMIN())}/orders/${encodeURIComponent(id)}`;
  const orderLink = (id, inner) => ADMIN() ? `<a href="${ORDER_URL(id)}" target="_blank" rel="noopener">${inner} ↗</a>` : inner;
  function dueList() {
    const box = $("so-due"); if (!box || !S.loaded) return;
    let h = "";
    if (!S.due.length) h += `<div class="empty">No orders waiting for payment.</div>`;
    else {
      const tot = S.due.reduce((a, r) => a + r.outstanding, 0), old = S.due.filter(r => r.days_old > 30);
      h += `<div class="m">${S.due.length} order${S.due.length === 1 ? "" : "s"} owe ${fmt(tot)}${old.length ? ` · ${old.length} over 30 days (${fmt(old.reduce((a, r) => a + r.outstanding, 0))})` : ""}</div>`;
      h += `<table class="az-pay"><thead><tr><th>Order</th><th>Placed</th><th class="n">Total</th><th class="n">Paid</th><th class="n">Still owed</th><th>Status</th><th></th></tr></thead><tbody>`;
      for (const r of S.due.slice(0, S.dueShown)) {
        const part = r.financial_status === "PARTIALLY_PAID";
        const act = S.closeAsk === String(r.order_id)
          ? `<div class="so-close"><span>Close out — ${fmt(r.outstanding)} won't be collected?</span><button class="btn small primary" type="button" data-soclose="${esc(r.order_id)}" ${S.busy ? "disabled" : ""}>${S.busy === "close" ? "Saving…" : "Yes, close out"}</button><button class="btn small" type="button" data-soclosecancel>Cancel</button></div>`
          : part ? `<button class="btn small" type="button" data-socloseask="${esc(r.order_id)}" title="Paid in full — the order amount in Shopify was wrong">Close out</button>` : "";
        h += `<tr><td>${orderLink(r.order_id, `<b>${esc(r.name)}</b>`)}<div class="m">${esc(r.source_name === "shopify_draft_order" ? "draft / manual order" : r.source_name)}${r.gateways ? " · " + esc(r.gateways) : ""}</div></td>
          <td>${day(r.order_day, true)}<div class="m ${r.days_old > 30 ? "negt" : ""}">${r.days_old} day${r.days_old === 1 ? "" : "s"} ago</div></td>
          <td class="n">${fmt(r.total)}</td><td class="n">${r.paid ? fmt(r.paid) : "—"}</td><td class="n"><b>${fmt(r.outstanding)}</b></td>
          <td><span class="pill ${part ? "soon" : "est"}">${esc(r.financial_status.replace("_", " ").toLowerCase())}</span></td><td>${act}</td></tr>`;
      }
      h += `</tbody></table>`;
      if (S.due.length > S.dueShown) h += `<div class="foot"><span>${S.due.length - S.dueShown} more</span><button class="btn small" type="button" data-somore>Show all</button></div>`;
    }
    if (S.closed.length) h += `<details class="pp-miss"><summary>${S.closed.length} closed out (paid in full; ${fmt(S.closed.reduce((a, r) => a + r.outstanding, 0))} Shopify still shows as owed)</summary><table class="az-lines"><thead><tr><th>Order</th><th class="n">Total</th><th class="n">Left in Shopify</th><th>Closed</th><th></th></tr></thead><tbody>
      ${S.closed.map(c => `<tr><td>${orderLink(c.order_id, esc(c.name || "#" + c.order_id))}</td><td class="n">${c.total == null ? "—" : fmt(c.total)}</td><td class="n">${fmt(c.outstanding)}</td>
        <td class="m">${day(String(c.closed_at).slice(0, 10), true)} · ${esc(c.closed_by)}</td><td><button class="btn small" type="button" data-soreopen="${esc(c.order_id)}">Reopen</button></td></tr>`).join("")}</tbody></table></details>`;
    box.innerHTML = h;
  }
  async function closeOut(id, reopen) {
    S.busy = "close"; dueList();
    try { await FIN.write("fin_shop_due_close", { p: reopen ? { order_id: id, store: S.st, reopen: true } : { order_id: id, store: S.st, note: "Paid in full — the order amount in Shopify was wrong" } }); }
    catch (e) { note("bad", "Couldn't save: " + esc(e.message || e)); }
    S.busy = ""; S.closeAsk = null; FIN.clear(); await load(true);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const main = $("shop");
    main.addEventListener("click", (ev) => {
      if (!ev.target.closest("#so-weeks, #so-posted, #so-clearing, #so-due")) return;
      if (ev.target.closest("[data-somore]")) { S.dueShown = 1e9; dueList(); return; }
      const ca = ev.target.closest("[data-socloseask]"); if (ca) { S.closeAsk = ca.dataset.socloseask; dueList(); return; }
      if (ev.target.closest("[data-soclosecancel]")) { S.closeAsk = null; dueList(); return; }
      const cl = ev.target.closest("[data-soclose]"); if (cl) { closeOut(cl.dataset.soclose, false); return; }
      const ro = ev.target.closest("[data-soreopen]"); if (ro) { closeOut(ro.dataset.soreopen, true); return; }
      const a = ev.target.closest("[data-soask]"); if (a) { S.confirm = a.dataset.soask; weeks(); return; }
      if (ev.target.closest("[data-socancel]")) { S.confirm = null; weeks(); return; }
      const p = ev.target.closest("[data-sopost]"); if (p) { postWeek(p.dataset.sopost); return; }
      if (ev.target.closest("a, button, tr.detail, details")) return;
      const w = ev.target.closest("tr[data-week]"); if (w) { openWeek(w.dataset.week); return; }
      const c = ev.target.closest("tr[data-acct]"); if (c) openAcct(c.dataset.acct);
    });
    window.addEventListener("fin:shopother", () => { FIN.clear(); load(true); });
    if (!main.hidden) FIN.ready.then(() => load(false));
    window.addEventListener("fin:page", (e) => { if (e.detail === "shop") { if (S.st !== ST() || (!S.loaded && !S.loading)) FIN.ready.then(() => load(false)); else render(); } });
  });
})();
