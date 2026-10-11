// Shopify payouts page (Just Tennis): each Shopify Payments payout broken down into one simple QuickBooks journal entry
// (fin.shop_entry: sales, shipping, sales tax, refunds, fees, chargebacks, Shop Cash, tax adjustments and the payout to the
// bank) plus cost of goods, checked against QuickBooks (A2X's entries before the switch, ours after) and posted with
// "Send to QuickBooks". Built from Shopify Payments' transactions, each tagged with its payout by the hourly Shopify sync.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (v) => { const n = Number(v) || 0; return (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const f0 = (v) => { const n = Math.round(Number(v) || 0); return (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US"); };
  const short = (v) => { const a = Math.abs(v), s = v < 0 ? "−" : ""; return a >= 1e6 ? s + "$" + (a / 1e6).toFixed(2) + "M" : a >= 1e4 ? s + "$" + Math.round(a / 1e3) + "K" : s + "$" + Math.round(a).toLocaleString("en-US"); };
  const day = (s, y) => s ? new Date(String(s).slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", ...(y ? { year: "numeric" } : {}), timeZone: "UTC" }) : "—";
  const QBO_JE = (id) => `https://qbo.intuit.com/app/journal?txnId=${encodeURIComponent(id)}`;
  const NUM = ["amount", "tx", "orders", "sales", "shipping", "tax", "refunds", "fees", "other", "net", "cogs", "orders_missing_cost"];

  const S = { loaded: false, loading: false, err: null, rows: [], cfg: {}, open: null, entry: null, entryErr: null, busy: "", confirm: null, postedShown: 12 };

  async function load(refresh) {
    S.loading = true; render();
    try {
      const [rows, cfg] = await Promise.all([
        FIN.sql(`select id, payout_date, status, amount, posted, a2x_docs, checked_at, synced_at, tx, orders, sales, shipping, tax, refunds, fees, other, net, cogs, orders_missing_cost
                 from fin.v_shop_payouts where issued_at >= now() - interval '100 days' order by issued_at desc, id desc`, refresh),
        FIN.sql("select value from fin.settings where key = 'shop_post'", refresh),
      ]);
      S.rows = rows.map(r => { const o = { ...r, posted: r.posted || {}, a2x_docs: r.a2x_docs || [] }; for (const k of NUM) o[k] = +r[k] || 0; return o; });
      S.cfg = (cfg[0] && cfg[0].value) || {};
      S.err = null; S.loaded = true;
    } catch (e) { S.err = e; }
    S.loading = false; render();
    if (S.open) openEntry(S.open, true);
  }

  const isPosted = (r) => r.a2x_docs.length > 0 || Object.keys(r.posted).length > 0;
  function status(r) {
    if (r.a2x_docs.length) return ["a2x", "Posted by A2X"];
    if (Object.keys(r.posted).length) return ["posted", "In QuickBooks"];
    if (r.status !== "PAID") return ["new", r.status === "IN_TRANSIT" ? "On its way" : "Scheduled"];
    if (!r.tx) return ["new", "Waiting for Shopify"];
    if (Math.abs(r.net - r.amount) >= 0.005) return ["new", "Doesn't add up yet"];
    if (!r.checked_at) return ["new", "Not checked"];
    return ["ready", "Ready to post"];
  }
  // payouts from two weeks before the switch on that aren't in QuickBooks; older ones were A2X's job
  const since = () => new Date(new Date((S.cfg.start || "2026-10-01") + "T00:00:00Z").getTime() - 14 * 86400e3).toISOString().slice(0, 10);
  const todoRows = () => S.rows.filter(r => !isPosted(r) && r.status === "PAID" && String(r.payout_date) >= since());
  const doneRows = () => S.rows.filter(r => isPosted(r));

  function note(cls, html) { const n = $("sp-note"); n.className = "note " + (cls || ""); n.innerHTML = html; n.hidden = !html; }
  function render() {
    if (S.err) note("bad", "Couldn't load: " + esc(S.err.message || S.err));
    if (!S.loaded) { $("sp-sub").textContent = S.loading ? "Loading…" : ""; return; }
    const last = S.rows.reduce((a, r) => r.synced_at > a ? r.synced_at : a, "");
    $("sp-sub").textContent = last ? `Payouts from Shopify as of ${new Date(last).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · updates hourly` : "No payouts yet";
    cards(); table();
  }
  function cards() {
    const card = (cls, k, v, s2) => `<div class="card ${cls}"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s2}</span></div>`;
    const todo = todoRows(), done = doneRows();
    const sum = (rs, k) => rs.reduce((a, r) => a + r[k], 0);
    const next = S.rows.filter(r => r.status !== "PAID").sort((a, b) => String(a.payout_date).localeCompare(String(b.payout_date)))[0];
    $("sp-cards").innerHTML = [
      card(todo.length ? "amber" : "green", "To post", String(todo.length), todo.length ? `${short(sum(todo, "amount"))} in payouts` : "All caught up"),
      card("", "Cost of goods to post", short(sum(todo, "cogs")), todo.length ? "at Seller Sage's costs" : "—"),
      card("green", "Posted", String(done.length), `${short(sum(done, "amount"))} · the last 100 days`),
      card("", "Next payout", next ? f0(next.amount) : "—", next ? `${day(next.payout_date)} · ${next.status === "IN_TRANSIT" ? "on its way" : "scheduled"}` : "none scheduled"),
    ].join("");
  }
  function payoutRows(rows, posted) {
    const head = `<tr><th>Payout</th><th class="n">Sales</th><th class="n">Shipping</th><th class="n">Sales tax</th><th class="n">Refunds</th><th class="n">Shopify fees</th><th class="n">Other</th><th class="n">Payout</th><th class="n">Cost of goods</th><th class="n">After COGS</th><th>${posted ? "Posted" : "Status"}</th></tr>`;
    let h = `<table class="az-pay"><thead>${head}</thead><tbody>`;
    const tot = { amount: 0, cogs: 0 };
    for (const r of rows) {
      const [k, label] = status(r);
      tot.amount += r.amount; tot.cogs += r.cogs;
      const cell = (v) => `<td class="n">${Math.abs(v || 0) >= 0.5 ? f0(v) : "—"}</td>`;
      const st = k === "a2x" ? `<span class="pill open" title="${esc(r.a2x_docs.join(", "))}">A2X</span>`
        : k === "posted" ? `<span class="pill paid" title="${esc(Object.keys(r.posted).join(", "))}">Seller Sage</span>`
        : `<span class="pill ${k === "ready" ? "soon" : "est"}">${esc(label)}</span>`;
      h += `<tr class="row${S.open === r.id ? " sel" : ""}" data-pid="${esc(r.id)}"><td><b>${day(r.payout_date, true)}</b><div class="m">${r.orders} order${r.orders === 1 ? "" : "s"} · #${esc(r.id)}</div></td>
        ${cell(r.sales)}${cell(r.shipping)}${cell(r.tax)}${cell(r.refunds)}${cell(r.fees)}${cell(r.other)}
        <td class="n"><b>${fmt(r.amount)}</b></td>
        <td class="n">${f0(r.cogs)}${r.orders_missing_cost ? `<div class="m negt">${r.orders_missing_cost} missing cost</div>` : ""}</td>
        <td class="n ${r.amount - r.cogs < 0 ? "negt" : ""}">${f0(r.amount - r.cogs)}</td><td>${st}</td></tr>`;
      if (S.open === r.id) h += `<tr class="detail"><td colspan="11">${detail(r)}</td></tr>`;
    }
    h += `</tbody><tfoot><tr><td colspan="7"><b>${rows.length} payout${rows.length === 1 ? "" : "s"}</b></td><td class="n"><b>${fmt(tot.amount)}</b></td><td class="n"><b>${fmt(tot.cogs)}</b></td><td class="n"><b>${fmt(tot.amount - tot.cogs)}</b></td><td></td></tr></tfoot></table>`;
    return h;
  }
  function table() {
    const todo = todoRows(), done = doneRows();
    $("sp-table").innerHTML = todo.length ? payoutRows(todo, false) : `<div class="empty">Nothing waiting to be posted.</div>`;
    const shown = done.slice(0, S.postedShown);
    $("sp-posted").innerHTML = done.length ? payoutRows(shown, true) + (done.length > shown.length ? `<div class="foot"><span>${done.length - shown.length} more</span><button class="btn small" type="button" data-spmore>Show all</button></div>` : "") : `<div class="empty">Nothing posted yet.</div>`;
  }

  async function openEntry(pid, keep) {
    if (!keep && S.open === pid) { S.open = null; S.entry = null; table(); return; }
    S.open = pid; S.entry = null; S.entryErr = null; S.confirm = null; table();
    try { S.entry = await FIN.rpc("fin_shop_entry", { pid }); } catch (e) { S.entryErr = e; }
    if (S.open === pid) table();
  }
  function detail(r) {
    if (S.entryErr) return `<div class="note bad">Couldn't build the entries: ${esc(S.entryErr.message || S.entryErr)}</div>`;
    const e = S.entry;
    if (!e || e.payout?.id !== r.id) return `<div class="m">Building the entries…</div>`;
    const [k] = status(r), probs = e.problems || [], blocking = probs.filter(p => p.kind === "total");
    let h = "";
    if (k === "a2x") h += `<div class="note">A2X already posted this payout (${esc(r.a2x_docs.join(", "))}). Shown here for reference; it won't be posted again.</div>`;
    for (const p of probs) h += `<div class="note ${p.kind === "total" ? "bad" : ""}">${esc(p.message)}</div>`;
    h += `<div class="az-parts">`;
    for (const p of e.parts) {
      const dr = p.lines.reduce((a, l) => a + (l.amount > 0 ? +l.amount : 0), 0), cr = p.lines.reduce((a, l) => a + (l.amount < 0 ? -l.amount : 0), 0);
      h += `<div class="az-part"><div class="az-ph"><div><b>${esc(p.doc)}</b> <span class="m">${p.kind === "cogs" ? "cost of goods" : "payout"} · dated ${day(p.date, true)}</span></div>
        ${p.posted?.id ? `<a class="pill paid" href="${QBO_JE(p.posted.id)}" target="_blank" rel="noopener">In QuickBooks ↗</a>` : ""}</div>
        <table class="az-lines"><thead><tr><th>Account</th><th>Description</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>
        ${p.lines.map(l => `<tr class="${l.review ? "rev" : ""}"><td>${esc(l.account)}${l.review ? ' <span class="pill soon">check</span>' : ""}</td><td class="m">${esc(l.description)}</td>
          <td class="n">${l.amount > 0 ? fmt(l.amount) : ""}</td><td class="n">${l.amount < 0 ? fmt(-l.amount) : ""}</td></tr>`).join("")}
        </tbody><tfoot><tr><td colspan="2"><b>Total</b> ${Math.abs(dr - cr) < 0.005 ? '<span class="pill paid">balanced</span>' : '<span class="pill over">doesn\'t balance</span>'}</td><td class="n"><b>${fmt(dr)}</b></td><td class="n"><b>${fmt(cr)}</b></td></tr></tfoot></table></div>`;
    }
    h += `</div>`;
    const todo = e.parts.filter(p => !p.posted?.id).length;
    const can = k !== "a2x" && r.status === "PAID" && !blocking.length && todo > 0;
    h += `<div class="az-actions">`;
    if (can) {
      h += S.confirm === r.id
        ? `<span>Post ${todo} journal entr${todo === 1 ? "y" : "ies"} to QuickBooks?</span><button class="btn primary" type="button" data-sppost="${esc(r.id)}" ${S.busy ? "disabled" : ""}>${S.busy === "post" ? "Posting…" : "Yes, post"}</button><button class="btn" type="button" data-spcancel>Cancel</button>`
        : `<button class="btn primary" type="button" data-spask="${esc(r.id)}">Send to QuickBooks</button><span class="m">${todo} entr${todo === 1 ? "y" : "ies"} · checks QuickBooks for A2X's or an earlier copy first</span>`;
    } else if (k !== "a2x" && !todo) h += `<span class="m">Everything for this payout is in QuickBooks.</span>`;
    h += `<button class="btn small" type="button" data-spcsv="${esc(r.id)}">Export CSV</button></div>`;
    return h;
  }
  function exportCsv(pid) {
    const e = S.entry; if (!e) return;
    const q = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
    const lines = [["journal_no", "date", "account", "description", "debit", "credit"]];
    for (const p of e.parts) for (const l of p.lines) lines.push([p.doc, p.date, l.account, l.description, l.amount > 0 ? (+l.amount).toFixed(2) : "", l.amount < 0 ? (-l.amount).toFixed(2) : ""]);
    FIN.download(`shopify-payout-${pid}.csv`, lines.map(r => r.map(q).join(",")).join("\n"));
  }

  async function call(body, what) {
    const r = await FIN.fn("amzpay", body);
    if (!r || r.ok === false) throw new Error((r && r.error) || `${what} didn't answer`);
    return r;
  }
  async function check() {
    const b = $("sp-check"); b.disabled = true; b.textContent = "Checking…";
    try { const r = await call({ action: "shop_check" }, "QuickBooks"); note("", `Checked ${r.checked.length} payout${r.checked.length === 1 ? "" : "s"} against QuickBooks.`); }
    catch (e) { note("bad", "Couldn't check QuickBooks: " + esc(e.message || e)); }
    b.disabled = false; b.textContent = "Check QuickBooks";
    FIN.clear(); load(true);
  }
  async function postIt(pid) {
    S.busy = "post"; table();
    try {
      const r = await call({ action: "shop_post", payout_id: pid }, "QuickBooks");
      const made = r.results.filter(x => x.created).length, linked = r.results.filter(x => x.linked).length;
      note("", `Posted to QuickBooks: ${made} journal entr${made === 1 ? "y" : "ies"}${linked ? `, ${linked} already there (linked)` : ""}.`);
    } catch (e) { note("bad", "Couldn't post: " + esc(e.message || e)); }
    S.busy = ""; S.confirm = null;
    FIN.clear(); await load(true);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const main = $("shop");
    main.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-spmore]")) { S.postedShown = 1e9; table(); return; }
      const a = ev.target.closest("[data-spask]"); if (a) { S.confirm = a.dataset.spask; table(); return; }
      if (ev.target.closest("[data-spcancel]")) { S.confirm = null; table(); return; }
      const p = ev.target.closest("[data-sppost]"); if (p) { postIt(p.dataset.sppost); return; }
      const c = ev.target.closest("[data-spcsv]"); if (c) { exportCsv(c.dataset.spcsv); return; }
      if (ev.target.closest("a, select, button, tr.detail")) return;
      const r = ev.target.closest("tr[data-pid]"); if (r) openEntry(r.dataset.pid);
    });
    $("sp-check").addEventListener("click", check);
    if (!main.hidden) FIN.ready.then(() => load(false));
    window.addEventListener("fin:page", (e) => { if (e.detail === "shop") { if (!S.loaded && !S.loading) FIN.ready.then(() => load(false)); else render(); } });
  });
})();
