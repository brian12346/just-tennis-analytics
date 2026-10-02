// Payables page: open bills, aging, what's coming due, vendors and bill payments, from the QuickBooks copy in schema
// fin (refreshed hourly by the qbo function, or with "Refresh from QuickBooks").
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const money = (v, d = 0) => (v < 0 ? "−" : "") + "$" + Math.abs(Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const m2 = (v) => money(v, 2);
  const short = (v) => { const a = Math.abs(v); return a >= 1e6 ? "$" + (v / 1e6).toFixed(1) + "M" : a >= 1e4 ? "$" + Math.round(v / 1e3) + "K" : a >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "K" : money(v); };
  const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const dnum = (s) => s ? Math.round(new Date(s + "T12:00:00Z").getTime() / 86400000) : null;
  const fmtD = (s, y) => s ? new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", ...(y ? { year: "numeric" } : {}), timeZone: "UTC" }) : "—";
  const QBO = "https://qbo.intuit.com/app";
  const AGING = [["current", "Current", "var(--green2)"], ["1-30", "1–30 days", "var(--amber)"], ["31-60", "31–60", "#C9762F"], ["61-90", "61–90", "#B9573A"], ["90+", "90+", "var(--red)"]];

  const S = { bills: [], pays: [], vendors: [], credits: [], sync: null, view: "open", q: "", vendor: "", filter: null, sort: { open: ["due_date", 1], all: ["txn_date", -1], vendors: ["open", -1], payments: ["txn_date", -1] },
    open: new Set(), loading: false, err: null, shown: 200 };

  async function load(refresh) {
    S.loading = true; render();
    try {
      const [b, p, v, c, s] = await Promise.all([
        FIN.sql("select id, vendor_id, vendor_name, doc_number, txn_date, due_date, total, balance, memo, lines, status, days_overdue, aging, invoice_id, po_no, po_id from fin.v_bills where balance <> 0 or txn_date >= current_date - 400", refresh),
        FIN.sql("select id, vendor_id, vendor_name, doc_number, txn_date, total, pay_type, account, bills from fin.qbo_bill_payments where txn_date >= current_date - 400", refresh),
        FIN.sql("select id, name, active, balance, terms from fin.qbo_vendors", refresh),
        FIN.sql("select id, vendor_id, vendor_name, doc_number, txn_date, total, balance from fin.qbo_vendor_credits where balance <> 0", refresh),
        FIN.sql("select value, updated_at from fin.sync_state where key = 'qbo_payables'", refresh),
      ]);
      for (const x of b) { x.total = +x.total; x.balance = +x.balance; }
      for (const x of p) x.total = +x.total;
      S.bills = b; S.pays = p; S.vendors = v; S.credits = c; S.sync = s[0] || null; S.err = null;
      // payments applied to each bill
      S.paidBy = new Map();
      for (const pay of p) for (const l of pay.bills || []) { if (!S.paidBy.has(l.bill_id)) S.paidBy.set(l.bill_id, []); S.paidBy.get(l.bill_id).push({ ...pay, amount: +l.amount }); }
    } catch (e) { S.err = e; }
    S.loading = false;
    vendorOptions(); render();
  }

  // ---------- derived numbers
  const open = () => S.bills.filter(b => b.balance !== 0);
  function dueClass(b) {
    if (b.balance === 0) return ["paid", "Paid"];
    const t = dnum(today()), d = dnum(b.due_date);
    if (d == null) return ["open", "No due date"];
    if (d < t) return ["over", `${t - d} day${t - d === 1 ? "" : "s"} late`];
    if (d === t) return ["soon", "Due today"];
    if (d - t <= 7) return ["soon", `Due in ${d - t} day${d - t === 1 ? "" : "s"}`];
    return ["open", "Due " + fmtD(b.due_date)];
  }
  // Monday-start weeks from this week; overdue first
  function weekOf(s) { const d = new Date(s + "T12:00:00Z"); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10); }
  function weeks() {
    const t = today(), first = weekOf(t), out = [{ key: "over", label: "Overdue", amt: 0, n: 0 }];
    for (let i = 0; i < 8; i++) { const d = new Date(first + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 7 * i); const k = d.toISOString().slice(0, 10); out.push({ key: k, label: i === 0 ? "This week" : fmtD(k), amt: 0, n: 0 }); }
    out.push({ key: "later", label: "Later", amt: 0, n: 0 });
    const lastWeek = out[out.length - 2].key;
    for (const b of open()) {
      let w;
      if (!b.due_date) w = out[out.length - 1];
      else if (b.due_date < t) w = out[0];
      else { const k = weekOf(b.due_date); w = k > lastWeek ? out[out.length - 1] : out.find(x => x.key === k) || out[out.length - 1]; }
      w.amt += b.balance; w.n++;
    }
    return out;
  }
  function inFilter(b) {
    const f = S.filter; if (!f) return true;
    const t = today();
    if (f.type === "overdue") return b.balance !== 0 && b.due_date && b.due_date < t;
    if (f.type === "due") return b.balance !== 0 && b.due_date && b.due_date >= t && dnum(b.due_date) - dnum(t) < f.days;
    if (f.type === "aging") return b.balance !== 0 && b.aging === f.key;
    if (f.type === "week") {
      if (b.balance === 0) return false;
      if (f.key === "over") return b.due_date && b.due_date < t;
      if (f.key === "later") return !b.due_date || b.due_date >= f.after;
      return b.due_date && b.due_date >= t && weekOf(b.due_date) === f.key;
    }
    return true;
  }
  const matchQ = (...xs) => !S.q || xs.some(x => String(x ?? "").toLowerCase().includes(S.q));

  function vendorStats() {
    const m = new Map(), t = today(), yr = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const get = (id, name) => { if (!m.has(id)) m.set(id, { id, name, openN: 0, open: 0, over: 0, next: null, paid12: 0, daysW: 0, daysAmt: 0, onTime: 0, timed: 0 }); return m.get(id); };
    for (const b of S.bills) {
      const v = get(b.vendor_id, b.vendor_name);
      if (b.balance !== 0) { v.openN++; v.open += b.balance; if (b.due_date && b.due_date < t) v.over += b.balance; if (b.due_date && b.due_date >= t && (!v.next || b.due_date < v.next)) v.next = b.due_date; }
    }
    const billById = new Map(S.bills.map(b => [b.id, b]));
    for (const p of S.pays) {
      const v = get(p.vendor_id, p.vendor_name);
      if (p.txn_date >= yr) v.paid12 += p.total;
      for (const l of p.bills || []) {
        const b = billById.get(l.bill_id); if (!b || !b.txn_date) continue;
        const amt = Math.abs(+l.amount) || 0;
        v.daysW += (dnum(p.txn_date) - dnum(b.txn_date)) * amt; v.daysAmt += amt;
        if (b.due_date) { v.timed += amt; if (p.txn_date <= b.due_date) v.onTime += amt; }
      }
    }
    const terms = new Map(S.vendors.map(x => [x.id, x.terms]));
    return [...m.values()].map(v => ({ ...v, terms: terms.get(v.id) || "", avgDays: v.daysAmt ? v.daysW / v.daysAmt : null, onTimePct: v.timed ? v.onTime / v.timed : null }));
  }

  function vendorOptions() {
    const sel = $("ap-vendor"), cur = sel.value;
    const names = [...new Map(S.bills.map(b => [b.vendor_id, b.vendor_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    sel.innerHTML = `<option value="">All vendors</option>` + names.map(([id, n]) => `<option value="${esc(id)}" ${id === cur ? "selected" : ""}>${esc(n)}</option>`).join("");
  }

  // ---------- render
  function render() {
    const syncEl = $("ap-sync");
    if (S.err && !S.bills.length) { syncEl.textContent = ""; note("bad", "Couldn't load payables: " + esc(S.err.message || S.err)); return; }
    if (!S.sync && S.loading) { syncEl.textContent = "Loading…"; return; }
    const at = S.sync && S.sync.updated_at ? new Date(S.sync.updated_at) : null;
    syncEl.innerHTML = at ? `Synced from QuickBooks ${esc(at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))} · updates every hour${S.loading ? " · loading…" : ""}` : "Not synced yet";
    cards(); aging(); weekBars(); table();
  }
  function note(kind, html) { const n = $("ap-note"); n.hidden = !html; n.className = "note " + (kind || ""); n.innerHTML = html || ""; }

  function cards() {
    const t = today(), o = open();
    const sum = (xs) => xs.reduce((a, b) => a + b.balance, 0);
    const over = o.filter(b => b.due_date && b.due_date < t), d7 = o.filter(b => b.due_date && b.due_date >= t && dnum(b.due_date) - dnum(t) < 7), d30 = o.filter(b => b.due_date && b.due_date >= t && dnum(b.due_date) - dnum(t) < 30);
    const credits = S.credits.reduce((a, c) => a + (+c.balance || 0), 0);
    const ago30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), paid = S.pays.filter(p => p.txn_date >= ago30);
    const oldest = over.reduce((a, b) => Math.max(a, +b.days_overdue || 0), 0);
    const card = (cls, k, v, s, f) => `<${f ? "button type=\"button\" data-f='" + esc(JSON.stringify(f)) + "'" : "div"} class="card ${cls}"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s}</span></${f ? "button" : "div"}>`;
    $("ap-cards").innerHTML = [
      card("", "Open payables", short(sum(o)), `${o.length} bills · ${new Set(o.map(b => b.vendor_id)).size} vendors${credits ? ` · ${short(credits)} in credits` : ""}`, null),
      card(over.length ? "red" : "green", "Overdue", short(sum(over)), over.length ? `${over.length} bill${over.length > 1 ? "s" : ""} · oldest ${oldest} days late` : "Nothing overdue", over.length ? { type: "overdue" } : null),
      card(d7.length ? "amber" : "", "Due in 7 days", short(sum(d7)), `${d7.length} bill${d7.length === 1 ? "" : "s"}`, d7.length ? { type: "due", days: 7 } : null),
      card("", "Due in 30 days", short(sum(d30)), `${d30.length} bill${d30.length === 1 ? "" : "s"}`, d30.length ? { type: "due", days: 30 } : null),
      card("", "Paid, last 30 days", short(paid.reduce((a, p) => a + p.total, 0)), `${paid.length} payment${paid.length === 1 ? "" : "s"}`, null),
    ].join("");
  }
  function aging() {
    const o = open(), tot = o.reduce((a, b) => a + b.balance, 0) || 1;
    const by = AGING.map(([k, l, c]) => { const xs = o.filter(b => b.aging === k); return { k, l, c, amt: xs.reduce((a, b) => a + b.balance, 0), n: xs.length }; });
    $("ap-aging").innerHTML = `<div class="aging-bar" role="img" aria-label="${esc(by.map(x => `${x.l} ${money(x.amt)}`).join(", "))}">${by.filter(x => x.amt > 0).map(x => `<span style="width:${(x.amt / tot * 100).toFixed(2)}%;background:${x.c}" title="${esc(x.l)}: ${money(x.amt)}"></span>`).join("")}</div>
      <div class="aging-legend">${by.map(x => `<button type="button" style="--c:${x.c}" data-f='${esc(JSON.stringify({ type: "aging", key: x.k, label: x.l }))}' class="${S.filter && S.filter.type === "aging" && S.filter.key === x.k ? "on" : ""}"><div class="l">${esc(x.l)}</div><div class="a">${short(x.amt)}</div><div class="c">${x.n} bill${x.n === 1 ? "" : "s"}</div></button>`).join("")}</div>`;
  }
  function weekBars() {
    const ws = weeks(), max = Math.max(1, ...ws.map(w => w.amt)), after = (() => { const d = new Date(ws[ws.length - 2].key + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); })();
    $("ap-weeks").innerHTML = `<div class="weeks">${ws.map(w => `<button type="button" class="wk ${w.key === "over" ? "over" : ""} ${S.filter && S.filter.type === "week" && S.filter.key === w.key ? "on" : ""}" data-f='${esc(JSON.stringify({ type: "week", key: w.key, after, label: w.key === "over" ? "Overdue" : w.key === "later" ? "Due later" : "Due week of " + fmtD(w.key) }))}' title="${esc(w.label)}: ${money(w.amt)} · ${w.n} bills">
      <span class="amt">${w.amt ? short(w.amt) : ""}</span><span class="bar" style="height:${Math.round(w.amt / max * 120)}px"></span><span class="lab">${esc(w.label)}</span></button>`).join("")}</div>`;
  }

  function rowsForView() {
    const v = S.view, [k, dir] = S.sort[v];
    const cmp = (a, b) => { const x = a[k], y = b[k]; const c = typeof x === "number" || typeof y === "number" ? (x ?? -Infinity) - (y ?? -Infinity) : String(x ?? "").localeCompare(String(y ?? "")); return c * dir; };
    if (v === "open" || v === "all") {
      return S.bills.filter(b => (v === "all" || b.balance !== 0) && (!S.vendor || b.vendor_id === S.vendor) && inFilter(b) && matchQ(b.vendor_name, b.doc_number, b.memo, b.po_no)).sort(cmp);
    }
    if (v === "vendors") return vendorStats().filter(x => (!S.vendor || x.id === S.vendor) && (x.openN || x.paid12) && matchQ(x.name)).sort(cmp);
    return S.pays.filter(p => (!S.vendor || p.vendor_id === S.vendor) && matchQ(p.vendor_name, p.doc_number, p.account)).sort(cmp);
  }
  function th(k, label, n) { const [sk, d] = S.sort[S.view]; return `<th data-sort="${k}" class="${n ? "n" : ""}" ${sk === k ? `aria-sort="${d > 0 ? "ascending" : "descending"}"` : ""}>${label}</th>`; }
  function table() {
    const chip = $("ap-filterchip");
    chip.innerHTML = S.filter && (S.view === "open" || S.view === "all") ? `<span class="chip">${esc(S.filter.label || (S.filter.type === "overdue" ? "Overdue" : `Due in ${S.filter.days} days`))}<button type="button" data-clear aria-label="Clear filter">×</button></span>` : "";
    const rows = rowsForView(), shown = rows.slice(0, S.shown), el = $("ap-table");
    let head, body, total = "";
    if (S.view === "open" || S.view === "all") {
      head = `<tr>${th("vendor_name", "Vendor")}${th("doc_number", "Bill #")}${th("txn_date", "Bill date")}${th("due_date", "Due")}<th>Status</th>${th("total", "Amount", 1)}${th("balance", "Open", 1)}</tr>`;
      body = shown.map(b => {
        const [cls, lab] = dueClass(b), paid = (S.paidBy.get(b.id) || []);
        const det = S.open.has(b.id) ? `<tr class="detail"><td colspan="7"><div class="det"><div><h3>Lines</h3><table>${(b.lines || []).map(l => `<tr><td>${esc(l.account)}</td><td class="m">${esc(l.description)}</td><td class="n">${m2(l.amount)}</td></tr>`).join("") || '<tr><td class="m">No lines</td></tr>'}</table>
            ${b.memo ? `<p class="m">${esc(b.memo)}</p>` : ""}</div>
            <div><h3>Payments</h3>${paid.length ? `<table>${paid.map(p => `<tr><td>${fmtD(p.txn_date, 1)}</td><td class="m">${esc(p.account || p.pay_type)}</td><td class="n">${m2(p.amount)}</td></tr>`).join("")}</table>` : '<p class="m">None yet</p>'}
            <p><a href="${QBO}/bill?txnId=${encodeURIComponent(b.id)}" target="_blank" rel="noopener">Open in QuickBooks ↗</a>${b.po_no || b.po_id ? ` · from Seller Sage PO ${esc(b.po_no || "#" + b.po_id)}` : ""}</p></div></div></td></tr>` : "";
        return `<tr class="row" data-bill="${esc(b.id)}"><td><b>${esc(b.vendor_name)}</b></td><td>${esc(b.doc_number || "—")}${b.po_no ? `<div class="m">PO ${esc(b.po_no)}</div>` : ""}</td><td>${fmtD(b.txn_date, 1)}</td><td>${fmtD(b.due_date, 1)}</td><td><span class="pill ${cls}">${esc(lab)}</span></td><td class="n">${m2(b.total)}</td><td class="n"><b>${b.balance ? m2(b.balance) : "—"}</b></td></tr>${det}`;
      }).join("");
      const sb = rows.reduce((a, b) => a + b.balance, 0);
      total = `${rows.length.toLocaleString()} bill${rows.length === 1 ? "" : "s"} · ${m2(sb)} open`;
    } else if (S.view === "vendors") {
      head = `<tr>${th("name", "Vendor")}${th("openN", "Open bills", 1)}${th("open", "Open balance", 1)}${th("over", "Overdue", 1)}${th("next", "Next due")}${th("paid12", "Paid, 12 months", 1)}${th("avgDays", "Avg days to pay", 1)}${th("onTimePct", "Paid on time", 1)}${th("terms", "Terms")}</tr>`;
      body = shown.map(v => `<tr class="row" data-vendor="${esc(v.id)}"><td><b>${esc(v.name)}</b></td><td class="n">${v.openN || "—"}</td><td class="n"><b>${v.open ? m2(v.open) : "—"}</b></td><td class="n" style="${v.over ? "color:var(--red)" : ""}">${v.over ? m2(v.over) : "—"}</td><td>${v.next ? fmtD(v.next, 1) : "—"}</td><td class="n">${v.paid12 ? money(v.paid12) : "—"}</td><td class="n">${v.avgDays == null ? "—" : Math.round(v.avgDays)}</td><td class="n">${v.onTimePct == null ? "—" : Math.round(v.onTimePct * 100) + "%"}</td><td>${esc(v.terms || "—")}</td></tr>`).join("");
      total = `${rows.length} vendors · ${m2(rows.reduce((a, v) => a + v.open, 0))} open · click a vendor to see its bills`;
    } else {
      head = `<tr>${th("txn_date", "Date")}${th("vendor_name", "Vendor")}${th("account", "Paid from")}${th("pay_type", "Method")}<th>Bills</th>${th("total", "Amount", 1)}</tr>`;
      const billNo = new Map(S.bills.map(b => [b.id, b.doc_number]));
      body = shown.map(p => `<tr><td>${fmtD(p.txn_date, 1)}</td><td><b>${esc(p.vendor_name)}</b></td><td>${esc(p.account || "—")}</td><td>${esc(p.pay_type === "CreditCard" ? "Card" : p.pay_type || "—")}</td><td class="m">${esc((p.bills || []).map(l => billNo.get(l.bill_id) || "#" + l.bill_id).slice(0, 4).join(", "))}${(p.bills || []).length > 4 ? ` +${p.bills.length - 4}` : ""}</td><td class="n"><a href="${QBO}/billpayment?txnId=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">${m2(p.total)}</a></td></tr>`).join("");
      total = `${rows.length.toLocaleString()} payments · ${m2(rows.reduce((a, p) => a + p.total, 0))} in the last 13 months`;
    }
    el.innerHTML = rows.length ? `<table><thead>${head}</thead><tbody>${body}</tbody></table>` : `<div class="empty">${S.loading ? "Loading…" : "Nothing here."}</div>`;
    $("ap-foot").innerHTML = `<span>${total}</span>${rows.length > S.shown ? `<button class="btn small" type="button" id="ap-more">Show ${Math.min(200, rows.length - S.shown)} more</button>` : ""}`;
  }

  function exportCsv() {
    const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = rowsForView();
    let lines;
    if (S.view === "vendors") lines = [["vendor", "open_bills", "open_balance", "overdue", "next_due", "paid_12_months", "avg_days_to_pay", "paid_on_time_pct", "terms"], ...rows.map(v => [v.name, v.openN, v.open.toFixed(2), v.over.toFixed(2), v.next || "", v.paid12.toFixed(2), v.avgDays == null ? "" : Math.round(v.avgDays), v.onTimePct == null ? "" : Math.round(v.onTimePct * 100), v.terms])];
    else if (S.view === "payments") lines = [["date", "vendor", "paid_from", "method", "amount", "qbo_id"], ...rows.map(p => [p.txn_date, p.vendor_name, p.account, p.pay_type, p.total.toFixed(2), p.id])];
    else lines = [["vendor", "bill_no", "bill_date", "due_date", "status", "amount", "open", "days_overdue", "po", "qbo_id"], ...rows.map(b => [b.vendor_name, b.doc_number, b.txn_date, b.due_date, dueClass(b)[1], b.total.toFixed(2), b.balance.toFixed(2), b.days_overdue || 0, b.po_no || "", b.id])];
    FIN.download(`payables-${S.view}-${today()}.csv`, lines.map(r => r.map(q).join(",")).join("\n"));
  }

  async function refresh() {
    const b = $("ap-refresh"); b.disabled = true; b.textContent = "Refreshing…";
    try {
      const r = await FIN.fn("qbo", { action: "payables_sync" });
      if (!r || r.ok === false) throw new Error((r && r.error) || "QuickBooks didn't answer");
      note("", `Updated from QuickBooks: ${r.bills} bill${r.bills === 1 ? "" : "s"} and ${r.payments} payment${r.payments === 1 ? "" : "s"} changed since the last sync.`);
    } catch (e) { note("bad", "Couldn't refresh from QuickBooks: " + esc(e.message || e)); }
    b.disabled = false; b.textContent = "Refresh from QuickBooks";
    FIN.clear(); load(true);
  }

  // ---------- events
  document.addEventListener("DOMContentLoaded", () => {
    const main = $("payables");
    main.addEventListener("click", (ev) => {
      const f = ev.target.closest("[data-f]");
      if (f) { const nf = JSON.parse(f.dataset.f); S.filter = S.filter && JSON.stringify(S.filter) === JSON.stringify(nf) ? null : nf; if (S.view !== "open" && S.view !== "all") setView("open"); S.shown = 200; render(); $("ap-table").scrollIntoView({ behavior: "smooth", block: "nearest" }); return; }
      if (ev.target.closest("[data-clear]")) { S.filter = null; render(); return; }
      const h = ev.target.closest("th[data-sort]");
      if (h) { const k = h.dataset.sort, cur = S.sort[S.view]; S.sort[S.view] = cur[0] === k ? [k, -cur[1]] : [k, /date|name|doc|terms|account|pay_type|next/.test(k) ? 1 : -1]; table(); return; }
      if (ev.target.closest("a")) return;
      const r = ev.target.closest("tr[data-bill]");
      if (r) { const id = r.dataset.bill; S.open.has(id) ? S.open.delete(id) : S.open.add(id); table(); return; }
      const v = ev.target.closest("tr[data-vendor]");
      if (v) { S.vendor = v.dataset.vendor; S.filter = null; $("ap-vendor").value = S.vendor; setView("open"); render(); return; }
      if (ev.target.id === "ap-more") { S.shown += 200; table(); }
    });
    $("ap-tabs").addEventListener("click", (ev) => { const b = ev.target.closest("button[data-v]"); if (b) { setView(b.dataset.v); render(); } });
    $("ap-vendor").addEventListener("change", (ev) => { S.vendor = ev.target.value; S.shown = 200; render(); });
    $("ap-q").addEventListener("input", (ev) => { S.q = ev.target.value.trim().toLowerCase(); S.shown = 200; table(); });
    $("ap-refresh").addEventListener("click", refresh);
    $("ap-csv").addEventListener("click", exportCsv);
    FIN.ready.then(() => load(false));
  });
  function setView(v) {
    S.view = v; S.shown = 200;
    $("ap-tabs").querySelectorAll("button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.v === v)));
  }
})();
