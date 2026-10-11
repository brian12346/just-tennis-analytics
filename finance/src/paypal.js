// Shopify payouts page, part 3 — PayPal. Upload PayPal's activity download (CSV); Seller Sage books PayPal's fees a week at
// a time (fin.paypal_fee_entry) and checks the Paypal Clearing Account in QuickBooks against PayPal's own balance, split by
// kind (sales, refunds, fees, transfers to the bank, other) with what to do about each gap (fin.v_paypal_check).
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (v) => { const n = Number(v) || 0; return (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const day = (s, y) => s ? new Date(String(s).slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", ...(y ? { year: "numeric" } : {}), timeZone: "UTC" }) : "—";
  const QBO_JE = (id) => `https://qbo.intuit.com/app/journal?txnId=${encodeURIComponent(id)}`;
  const near0 = (v) => Math.abs(v) < 0.005;

  const S = { loaded: false, loading: false, err: null, chk: null, weeks: [], miss: [], open: null, entry: null, entryErr: null, confirm: null, busy: "" };

  async function load(refresh) {
    S.loading = true;
    try {
      const [chk, weeks, miss] = await Promise.all([
        FIN.sql("select * from fin.v_paypal_check", refresh),
        FIN.sql("select week_end, week_start, posted, complete, tx, fees, disputes, sales, refunds, to_bank, other from fin.v_paypal_weeks order by week_end desc", refresh),
        FIN.sql("select amount, txn_id, paypal_day, name, invoice, shopify_day, order_name, status from fin.v_paypal_match where status <> 'matched' order by coalesce(paypal_day, shopify_day) desc limit 200", refresh),
      ]);
      const c = chk[0] || null;
      if (c) for (const k of Object.keys(c)) if (!["account", "paypal_balance_day", "first_day", "last_day", "qbo_synced_at", "since"].includes(k) && c[k] != null) c[k] = +c[k];
      S.chk = c;
      S.weeks = weeks.map(w => { const o = { ...w, posted: w.posted || {} }; for (const k of ["tx", "fees", "disputes", "sales", "refunds", "to_bank", "other"]) o[k] = +w[k] || 0; return o; });
      S.miss = miss.map(m => ({ ...m, amount: +m.amount }));
      S.err = null; S.loaded = true;
    } catch (e) { S.err = e; }
    S.loading = false; render();
    if (S.open) openWeek(S.open, true);
  }
  function render() { check(); weeks(); }
  function note(cls, html) { const n = $("sp-note"); n.className = "note " + (cls || ""); n.innerHTML = html; n.hidden = !html; }

  // ---------- the check
  function check() {
    const box = $("pp-check"); if (!box) return;
    if (S.err) { box.innerHTML = `<div class="note bad">Couldn't load: ${esc(S.err.message || S.err)}</div>`; return; }
    const c = S.chk; if (!c) { box.innerHTML = `<div class="m">${S.loading ? "Loading…" : ""}</div>`; return; }
    const card = (cls, k, v, s2) => `<div class="card ${cls}"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s2}</span></div>`;
    let h = `<section class="cards">${[
      card("", "PayPal balance", c.paypal_balance == null ? "—" : fmt(c.paypal_balance), c.paypal_balance_day ? `as of ${day(c.paypal_balance_day, true)} (last upload)` : "upload PayPal's activity"),
      card("", "Paypal Clearing in QuickBooks", c.qbo_balance == null ? "—" : fmt(c.qbo_balance), c.qbo_synced_at ? `as of ${new Date(c.qbo_synced_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "use Check QuickBooks"),
      card(c.paypal_balance == null ? "" : near0(c.difference) ? "green" : "amber", "Difference", c.paypal_balance == null ? "—" : near0(c.difference) ? "None" : fmt(c.difference),
        c.paypal_balance == null ? "" : near0(c.difference) ? "QuickBooks matches PayPal" : c.difference > 0 ? "QuickBooks is higher than PayPal" : "QuickBooks is lower than PayPal"),
    ].join("")}</section>`;
    if (c.paypal_balance == null) {
      box.innerHTML = h + `<div class="empty">No PayPal activity uploaded yet. In PayPal: Activity → Statements → <b>Activity download</b> · Transaction type <b>Balance affecting</b> · Format <b>CSV</b> · from ${day(addDays(c.since, 1), true)} to today. Then use “Upload PayPal activity”.</div>`;
      return;
    }
    const rows = [
      { k: "Sales", qb: c.qb_sales, pp: c.pp_sales, todo: [
        c.sales_unposted >= 0.005 && `${fmt(c.sales_unposted)} of PayPal payments marked in Shopify are in weeks not posted yet — post them in Other payments.`,
        c.paypal_only && `${c.paypal_only} PayPal sale${c.paypal_only > 1 ? "s" : ""} (${fmt(c.paypal_only_amt)}) aren't marked in Shopify — see the list below.`,
        c.shopify_only && `${c.shopify_only} Shopify PayPal payment${c.shopify_only > 1 ? "s" : ""} (${fmt(c.shopify_only_amt)}) aren't in the PayPal download — upload a later download, or check them.`] },
      { k: "Refunds", qb: c.qb_refunds, pp: c.pp_refunds, todo: [`Refunds come from the Other payments weeks; post those.`] },
      { k: "PayPal fees and chargebacks", qb: c.qb_fees, pp: c.pp_fees, todo: [`Post the PayPal fees weeks below.`] },
      { k: "Transfers to the bank", qb: c.qb_to_bank, pp: c.pp_to_bank, todo: [`In the bank feed, categorize each PayPal transfer to ${esc(c.account)}, then Check QuickBooks.`] },
      { k: "Other (holds, purchases, money in)", qb: c.qb_other, pp: c.pp_other, todo: [c.pp_other_n ? `${c.pp_other_n} PayPal transaction${c.pp_other_n > 1 ? "s aren't" : " isn't"} a Shopify sale — record ${c.pp_other_n > 1 ? "them" : "it"} in QuickBooks paid from ${esc(c.account)}.` : `Holds and money moved in from the bank.`] },
    ];
    const gaps = rows.reduce((a, r) => a + (r.qb - r.pp), 0), opening = c.difference - gaps;
    h += `<table class="az-pay"><thead><tr><th>Since ${day(c.since)}</th><th class="n">QuickBooks</th><th class="n">PayPal</th><th class="n">Gap</th><th>What to do</th></tr></thead><tbody>`;
    for (const r of rows) {
      const g = r.qb - r.pp;
      h += `<tr><td><b>${r.k}</b></td><td class="n">${fmt(r.qb)}</td><td class="n">${fmt(r.pp)}</td><td class="n ${near0(g) ? "" : "negt"}"><b>${near0(g) ? "—" : fmt(g)}</b></td>
        <td class="m">${near0(g) ? "matches" : r.todo.filter(Boolean).join("<br>")}</td></tr>`;
    }
    h += `<tr><td><b>Before the switch</b><div class="m">left from the A2X days</div></td><td></td><td></td><td class="n ${near0(opening) ? "" : "negt"}"><b>${near0(opening) ? "—" : fmt(opening)}</b></td>
      <td class="m">${near0(opening) ? "matches" : `QuickBooks and PayPal were already ${fmt(Math.abs(opening))} apart on ${day(c.since)}. Once the rows above are clear, one adjusting entry (your bookkeeper's call) fixes it.`}</td></tr>`;
    h += `</tbody><tfoot><tr><td><b>Difference</b></td><td></td><td></td><td class="n"><b>${fmt(c.difference)}</b></td><td class="m">QuickBooks minus PayPal</td></tr></tfoot></table>`;
    h += `<div class="m">Uploaded: ${c.uploaded.toLocaleString()} PayPal transactions, ${day(c.first_day)} – ${day(c.last_day, true)}. Upload through today for the check to line up with QuickBooks' current balance.</div>`;
    if (S.miss.length) {
      const lbl = { paypal_only: "In PayPal, not marked in Shopify", shopify_only: "Marked in Shopify, not in PayPal", dates_apart: "Same amount, dates far apart" };
      h += `<details class="pp-miss"><summary>${S.miss.length} sale${S.miss.length > 1 ? "s" : ""} not matched between PayPal and Shopify</summary><table class="az-lines"><thead><tr><th>Amount</th><th>PayPal</th><th>Shopify</th><th></th></tr></thead><tbody>
        ${S.miss.map(m => `<tr><td class="n">${fmt(m.amount)}</td><td>${m.txn_id ? `${day(m.paypal_day)} · ${esc(m.name || "")}<div class="m">${esc(m.txn_id)}${m.invoice ? " · " + esc(m.invoice) : ""}</div>` : "—"}</td>
          <td>${m.order_name ? `${day(m.shopify_day)} · <b>${esc(m.order_name)}</b>` : "—"}</td><td class="m">${lbl[m.status] || m.status}</td></tr>`).join("")}</tbody></table></details>`;
    }
    box.innerHTML = h;
  }
  const addDays = (d, n) => d ? new Date(new Date(String(d).slice(0, 10) + "T00:00:00Z").getTime() + n * 86400e3).toISOString().slice(0, 10) : d;

  // ---------- fees, a week at a time
  function weeks() {
    const box = $("pp-weeks"); if (!box || !S.loaded) return;
    if (!S.weeks.length) { box.innerHTML = `<div class="empty">No PayPal activity since the switch uploaded yet.</div>`; return; }
    let h = `<table class="az-pay"><thead><tr><th>Week</th><th class="n">Sales</th><th class="n">Refunds</th><th class="n">PayPal fees</th><th class="n">Chargebacks</th><th class="n">To the bank</th><th class="n">Other</th><th>Status</th></tr></thead><tbody>`;
    for (const w of S.weeks) {
      const posted = Object.keys(w.posted).length, nothing = near0(w.fees) && near0(w.disputes);
      const st = posted ? '<span class="pill paid">In QuickBooks</span>' : nothing ? '<span class="pill est">No fees</span>' : !w.complete ? '<span class="pill est">Week not over</span>' : '<span class="pill soon">Ready to post</span>';
      const cell = (v) => `<td class="n">${near0(v) ? "—" : fmt(v)}</td>`;
      h += `<tr class="row${S.open === w.week_end ? " sel" : ""}" data-ppweek="${esc(w.week_end)}"><td><b>${day(w.week_start)} – ${day(w.week_end, true)}</b><div class="m">${w.tx} transaction${w.tx === 1 ? "" : "s"}</div></td>
        ${cell(w.sales)}${cell(w.refunds)}${cell(-w.fees)}${cell(w.disputes)}${cell(w.to_bank)}${cell(w.other)}<td>${st}</td></tr>`;
      if (S.open === w.week_end) h += `<tr class="detail"><td colspan="8">${weekDetail(w)}</td></tr>`;
    }
    box.innerHTML = h + `</tbody></table>`;
  }
  async function openWeek(we, keep) {
    if (!keep && S.open === we) { S.open = null; S.entry = null; weeks(); return; }
    S.open = we; S.entry = null; S.entryErr = null; S.confirm = null; weeks();
    try { S.entry = await FIN.rpc("fin_paypal_fee_entry", { we }); } catch (e) { S.entryErr = e; }
    if (S.open === we) weeks();
  }
  function weekDetail(w) {
    if (S.entryErr) return `<div class="note bad">Couldn't build the entry: ${esc(S.entryErr.message || S.entryErr)}</div>`;
    const e = S.entry;
    if (!e || String(e.week?.week_end) !== String(w.week_end)) return `<div class="m">Building the entry…</div>`;
    const probs = e.problems || [], blocking = probs.filter(p => p.kind === "total");
    let h = probs.map(p => `<div class="note ${p.kind === "total" ? "bad" : ""}">${esc(p.message)}</div>`).join("");
    if (!e.parts.length) return h + `<div class="m">No PayPal fees that week — nothing to post.</div>`;
    const p = e.parts[0];
    h += `<div class="az-part"><div class="az-ph"><div><b>${esc(p.doc)}</b> <span class="m">PayPal fees · dated ${day(p.date, true)}</span></div>
      ${p.posted?.id ? `<a class="pill paid" href="${QBO_JE(p.posted.id)}" target="_blank" rel="noopener">In QuickBooks ↗</a>` : ""}</div>
      <table class="az-lines"><thead><tr><th>Account</th><th>Description</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>
      ${p.lines.map(l => `<tr><td>${esc(l.account)}</td><td class="m">${esc(l.description)}</td><td class="n">${l.amount > 0 ? fmt(l.amount) : ""}</td><td class="n">${l.amount < 0 ? fmt(-l.amount) : ""}</td></tr>`).join("")}
      </tbody></table></div><div class="az-actions">`;
    if (p.posted?.id) h += `<span class="m">This week's fees are in QuickBooks.</span>`;
    else if (!blocking.length) h += S.confirm === w.week_end
      ? `<span>Post this entry to QuickBooks?</span><button class="btn primary" type="button" data-pppost="${esc(w.week_end)}" ${S.busy ? "disabled" : ""}>${S.busy === "post" ? "Posting…" : "Yes, post"}</button><button class="btn" type="button" data-ppcancel>Cancel</button>`
      : `<button class="btn primary" type="button" data-ppask="${esc(w.week_end)}">Send to QuickBooks</button>`;
    return h + `</div>`;
  }
  async function postWeek(we) {
    S.busy = "post"; weeks();
    try {
      const r = await FIN.fn("amzpay", { action: "paypal_post", week_end: we });
      if (!r || r.ok === false) throw new Error((r && r.error) || "QuickBooks didn't answer");
      note("", r.results.some(x => x.linked) ? "That entry was already in QuickBooks — linked." : "Posted the PayPal fees to QuickBooks.");
    } catch (e) { note("bad", "Couldn't post: " + esc(e.message || e)); }
    S.busy = ""; S.confirm = null; FIN.clear(); await load(true);
  }

  // ---------- the upload: PayPal's activity download (CSV)
  function csvRows(text) {
    const out = []; let row = [], f = "", q = false;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
      else if (ch === '"') q = true;
      else if (ch === ",") { row.push(f); f = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.some(x => x.trim() !== "")) out.push(row); row = []; }
      else f += ch;
    }
    row.push(f); if (row.some(x => x.trim() !== "")) out.push(row);
    return out;
  }
  const money = (s) => { let t = String(s ?? "").trim(); if (!t) return null; const neg = /^\(.*\)$/.test(t) || t.startsWith("-"); t = t.replace(/[()$,\s-]/g, ""); const v = parseFloat(t); return isNaN(v) ? null : (neg ? -v : v); };
  const TZ = { PDT: "-07:00", PST: "-08:00", MDT: "-06:00", MST: "-07:00", CDT: "-05:00", CST: "-06:00", EDT: "-04:00", EST: "-05:00", UTC: "+00:00", GMT: "+00:00" };
  function isoDay(s) {
    s = String(s || "").trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/);
    if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; let mo = +m[1], d = +m[2]; if (mo > 12) [mo, d] = [d, mo]; return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
    const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  function parsePaypal(text) {
    const rows = csvRows(text); if (rows.length < 2) throw new Error("The file has no rows.");
    const hi = rows.findIndex(r => r.some(c => /^\s*transaction id\s*$/i.test(c)));
    if (hi < 0) throw new Error("This doesn't look like PayPal's activity download — there's no Transaction ID column.");
    const H = rows[hi].map(h => h.trim().toLowerCase());
    const col = (...names) => { for (const n of names) { const i = H.indexOf(n); if (i >= 0) return i; } return -1; };
    const c = { date: col("date"), time: col("time"), tz: col("timezone", "time zone"), name: col("name"), type: col("type", "description"), status: col("status"),
      cur: col("currency"), gross: col("gross"), fee: col("fee"), net: col("net"), id: col("transaction id"), inv: col("invoice number"), ref: col("reference txn id"),
      bal: col("balance"), impact: col("balance impact"), item: col("item title", "subject") };
    const miss = ["date", "type", "gross", "id"].filter(k => c[k] < 0);
    if (miss.length) throw new Error("The download is missing these columns: " + miss.join(", "));
    const out = []; let other = 0;
    for (const r of rows.slice(hi + 1)) {
      const g = (k) => c[k] >= 0 ? (r[c[k]] || "").trim() : "";
      const id = g("id"); if (!id) continue;
      if (g("cur") && g("cur").toUpperCase() !== "USD") { other++; continue; }
      const d = isoDay(g("date")); if (!d) continue;
      const gross = money(g("gross")) ?? 0, fee = money(g("fee")) ?? 0, net = money(g("net")) ?? Math.round((gross + fee) * 100) / 100;
      const t = (g("time").match(/^\d{1,2}:\d{2}(:\d{2})?$/) ? g("time") : "12:00:00").padStart(8, "0");
      out.push({ txn_id: id, at: `${d}T${t.length === 5 ? t + ":00" : t}${TZ[g("tz").toUpperCase()] || "-07:00"}`, day: d, name: g("name"), type: g("type"), status: g("status"),
        currency: "USD", gross, fee, net, balance: money(g("bal")), impact: g("impact"), invoice: g("inv"), ref: g("ref"), item: g("item") });
    }
    return { rows: out, skipped: other };
  }
  async function upload(file) {
    const b = $("pp-upload-btn"); b.disabled = true; b.textContent = "Reading…";
    try {
      const { rows, skipped } = parsePaypal(await file.text());
      if (!rows.length) throw new Error("No PayPal transactions in that file.");
      let n = 0;
      for (let i = 0; i < rows.length; i += 400) { b.textContent = `Saving ${Math.min(i + 400, rows.length)} of ${rows.length}…`; n += +(await FIN.write("fin_paypal_save", { p: { file: file.name, rows: rows.slice(i, i + 400) } })) || 0; }
      const days = rows.map(r => r.day).sort();
      note("", `Read ${n.toLocaleString()} PayPal transactions, ${day(days[0])} – ${day(days.at(-1), true)}${skipped ? ` (${skipped} in other currencies left out)` : ""}.`);
    } catch (e) { note("bad", "Couldn't read the PayPal file: " + esc(e.message || e)); }
    b.disabled = false; b.textContent = "Upload PayPal activity";
    FIN.clear(); load(true); window.dispatchEvent(new CustomEvent("fin:shopother"));
  }

  document.addEventListener("DOMContentLoaded", () => {
    const main = $("shop");
    main.addEventListener("click", (ev) => {
      if (!ev.target.closest("#pp-panel")) return;
      if (ev.target.closest("#pp-upload-btn")) { $("pp-file").click(); return; }
      const a = ev.target.closest("[data-ppask]"); if (a) { S.confirm = a.dataset.ppask; weeks(); return; }
      if (ev.target.closest("[data-ppcancel]")) { S.confirm = null; weeks(); return; }
      const p = ev.target.closest("[data-pppost]"); if (p) { postWeek(p.dataset.pppost); return; }
      if (ev.target.closest("a, button, tr.detail, details")) return;
      const w = ev.target.closest("tr[data-ppweek]"); if (w) openWeek(w.dataset.ppweek);
    });
    $("pp-file").addEventListener("change", (ev) => { const f = ev.target.files[0]; ev.target.value = ""; if (f) upload(f); });
    window.addEventListener("fin:shopother", () => { if (S.loaded) load(true); });
    if (!main.hidden) FIN.ready.then(() => load(false));
    window.addEventListener("fin:page", (e) => { if (e.detail === "shop") { if (!S.loaded && !S.loading) FIN.ready.then(() => load(false)); else render(); } });
  });
  window.__paypalParse = parsePaypal;   // for tests
})();
