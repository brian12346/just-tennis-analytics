// Cash flow page: 17 weeks (about 4 months) from this week. Money in = Amazon payouts (each payout stream estimated
// from its own history: same weekday, usual gap, average of its last payouts) + Shopify payouts (weekly; average of
// recent real payouts, or a share of recent sales until payouts sync) + other receipts typed in. Money out = open
// QuickBooks bills by due date (overdue ones in this week) + other payments typed in. A typed amount for a payout
// replaces its estimate (fin.forecast); real payouts replace both once they arrive.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const money = (v) => (v < 0 ? "−" : "") + "$" + Math.abs(Math.round(Number(v) || 0)).toLocaleString("en-US");
  const short = (v) => { const a = Math.abs(v), s = v < 0 ? "−" : ""; return a >= 1e6 ? s + "$" + (a / 1e6).toFixed(2) + "M" : a >= 1e4 ? s + "$" + Math.round(a / 1e3) + "K" : a >= 1e3 ? s + "$" + (a / 1e3).toFixed(1) + "K" : money(v); };
  const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dnum = (s) => Math.round(new Date(s + "T12:00:00Z").getTime() / 86400000);
  const wday = (s) => new Date(s + "T12:00:00Z").getUTCDay();
  const monday = (s) => addDays(s, -((wday(s) + 6) % 7));
  const fmtD = (s) => new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MK = { ATVPDKIKX0DER: "US", A1AM78C64UM0Y8: "Mexico", A2EUQ1WTGCTBG2: "Canada" };
  const WEEKS = 17;
  const parseAmt = (s) => { const v = parseFloat(String(s ?? "").replace(/[$,\s]/g, "")); return isNaN(v) ? null : v; };

  const S = { loaded: false, loading: false, err: null, amz: [], shopPay: [], shopDays: [], bills: [], fc: [], cash: {}, shopCfg: { weekday: 1, pct_of_sales: 97 }, open: new Set(), busy: false };

  async function load(refresh) {
    S.loading = true; render();
    try {
      const [amz, sp, sd, bills, fc, st] = await Promise.all([
        FIN.sql("select id, day, marketplace, currency, amount_local, amount from fin.v_amazon_payouts order by day", refresh),
        FIN.sql("select id, (issued_at at time zone 'America/Los_Angeles')::date as day, status, amount from fin.shopify_payouts where issued_at > now() - interval '200 days' order by issued_at", refresh),
        FIN.sql("select day, total from jt.shopify_daily where day >= current_date - 42 order by day", refresh),
        FIN.sql("select id, vendor_name, doc_number, due_date, balance from fin.qbo_bills where balance <> 0", refresh),
        FIN.sql("select id, kind, stream, expected_on, amount, note, updated_by from fin.forecast where active", refresh),
        FIN.sql("select key, value from fin.settings", refresh),
      ]);
      S.amz = amz.map(x => ({ ...x, amount: +x.amount })); S.shopPay = sp.map(x => ({ ...x, amount: +x.amount }));
      S.shopDays = sd.map(x => ({ day: x.day, total: +x.total })); S.bills = bills.map(b => ({ ...b, balance: +b.balance }));
      S.fc = fc.map(x => ({ ...x, amount: +x.amount }));
      const set = Object.fromEntries(st.map(r => [r.key, r.value || {}]));
      S.cash = set.cash || {}; S.shopCfg = { weekday: 1, pct_of_sales: 97, ...(set.shopify || {}) };
      S.err = null; S.loaded = true;
    } catch (e) { S.err = e; }
    S.loading = false; render();
  }

  // ---------- payout streams ----------
  // Amazon: one stream per marketplace + weekday it lands on (e.g. US Thursdays every 14 days, a small US one on Sundays)
  function amazonStreams() {
    const g = new Map();
    for (const p of S.amz) { const k = `amazon:${p.marketplace}:${wday(p.day)}`; if (!g.has(k)) g.set(k, []); g.get(k).push(p); }
    const out = [];
    for (const [id, ps] of g) {
      ps.sort((a, b) => a.day.localeCompare(b.day));
      const gaps = ps.slice(1).map((p, i) => dnum(p.day) - dnum(ps[i].day)).filter(x => x > 0);
      let gap = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 14;
      gap = Math.max(7, Math.round(gap / 7) * 7);
      const recent = ps.slice(-3), avg = recent.reduce((a, p) => a + p.amount, 0) / recent.length;
      out.push({ id, kind: "amazon", mk: ps[0].marketplace, label: `Amazon ${MK[ps[0].marketplace] || ps[0].marketplace}`, weekday: wday(ps[0].day), gap, last: ps[ps.length - 1].day, avg, n: ps.length, actuals: ps,
        basis: `average of the last ${recent.length} payout${recent.length > 1 ? "s" : ""}` });
    }
    // name the second stream of a marketplace
    const byMk = {};
    out.sort((a, b) => b.avg - a.avg).forEach(s => { byMk[s.mk] = (byMk[s.mk] || 0) + 1; if (byMk[s.mk] > 1) s.label += ` · ${DAYS[s.weekday]} payout`; });
    return out;
  }
  function shopifyStream() {
    const wd = Number(S.shopCfg.weekday ?? 1), pct = Number(S.shopCfg.pct_of_sales ?? 97) / 100;
    const paid = S.shopPay.filter(p => /paid|in_transit|scheduled/i.test(p.status) || !p.status);
    let avg, basis;
    if (paid.length >= 2) { const r = paid.slice(-4); avg = r.reduce((a, p) => a + p.amount, 0) / r.length; basis = `average of the last ${r.length} Shopify payouts`; }
    else {
      // last 4 complete weeks of Shopify sales (Mon–Sun) × the payout share
      const end = monday(today()), start = addDays(end, -28);
      const tot = S.shopDays.filter(d => d.day >= start && d.day < end).reduce((a, d) => a + d.total, 0);
      avg = tot / 4 * pct; basis = `${Math.round(pct * 100)}% of the last 4 weeks' Shopify sales (until real payouts sync)`;
    }
    return { id: "shopify", kind: "shopify", label: "Shopify", weekday: wd, gap: 7, avg, basis, actuals: paid.map(p => ({ day: p.day, amount: p.amount, id: p.id })), last: paid.length ? paid[paid.length - 1].day : null, n: paid.length };
  }

  // every event in the window: payouts (actual / typed / estimate), other lines, bills
  function events() {
    const t = today(), w0 = monday(t), end = addDays(w0, 7 * WEEKS);
    const asOf = S.cash.as_of || t;
    const typed = new Map(S.fc.filter(f => f.kind === "payout").map(f => [`${f.stream}|${f.expected_on}`, f]));
    const ev = [];
    const streams = [...amazonStreams(), shopifyStream()];
    for (const s of streams) {
      // real payouts after the balance date
      for (const a of s.actuals) if (a.day > asOf && a.day >= w0 && a.day < end) ev.push({ type: "in", src: s.kind, stream: s.id, label: s.label, day: a.day, amount: a.amount, state: "actual" });
      // expected ones from today on: the stream's next date after its last payout (or the next matching weekday)
      let d;
      if (s.last) { d = addDays(s.last, s.gap); while (d < t) d = addDays(d, s.gap); }
      else { d = t; while (wday(d) !== s.weekday) d = addDays(d, 1); }
      for (; d < end; d = addDays(d, s.gap)) {
        if (s.actuals.some(a => Math.abs(dnum(a.day) - dnum(d)) <= 2)) continue;   // already paid around then
        const f = typed.get(`${s.id}|${d}`);
        ev.push({ type: "in", src: s.kind, stream: s.id, label: s.label, day: d, amount: f ? f.amount : s.avg, est: s.avg, state: f ? "typed" : "estimate", note: f ? f.note : "" });
      }
    }
    for (const f of S.fc.filter(f => f.kind !== "payout")) {
      if (f.expected_on < w0 || f.expected_on >= end) continue;
      ev.push({ type: f.kind === "other_in" ? "in" : "out", src: "other", id: f.id, label: f.note || (f.kind === "other_in" ? "Other money in" : "Other payment"), day: f.expected_on, amount: f.amount, state: "typed" });
    }
    for (const b of S.bills) {
      const due = b.due_date || t, d = due < t ? t : due;
      if (d >= end) continue;
      ev.push({ type: "out", src: "bill", label: b.vendor_name, doc: b.doc_number, day: d, due, amount: b.balance, state: due < t ? "overdue" : "due" });
    }
    return { ev, streams, w0, end };
  }
  function weeksOf(ev, w0) {
    const ws = [];
    for (let i = 0; i < WEEKS; i++) { const k = addDays(w0, 7 * i); ws.push({ k, amazon: 0, shopify: 0, other_in: 0, bills: 0, other_out: 0, items: [] }); }
    for (const e of ev) {
      const w = ws[Math.floor((dnum(e.day) - dnum(w0)) / 7)]; if (!w) continue;
      w.items.push(e);
      if (e.type === "in") w[e.src === "other" ? "other_in" : e.src] += e.amount; else w[e.src === "bill" ? "bills" : "other_out"] += e.amount;
    }
    let bal = S.cash.balance == null ? null : Number(S.cash.balance);
    for (const w of ws) { w.in = w.amazon + w.shopify + w.other_in; w.out = w.bills + w.other_out; w.net = w.in - w.out; if (bal != null) { bal += w.net; w.bal = bal; } }
    return ws;
  }

  // ---------- render ----------
  function render() {
    if ($("cash").hidden) return;
    if (S.err && !S.loaded) { $("cf-sub").textContent = "Couldn't load: " + (S.err.message || S.err); return; }
    if (!S.loaded) { $("cf-sub").textContent = "Loading…"; return; }
    const { ev, streams, w0 } = events(), ws = weeksOf(ev, w0);
    $("cf-sub").textContent = `${fmtD(w0)} – ${fmtD(addDays(w0, 7 * WEEKS - 1))} · bills from QuickBooks, payouts from Amazon and Shopify history${S.loading ? " · loading…" : ""}`;
    if (document.activeElement !== $("cf-bal")) $("cf-bal").value = S.cash.balance == null ? "" : money(S.cash.balance);
    if (document.activeElement !== $("cf-asof")) $("cf-asof").value = S.cash.as_of || "";
    const tin = ws.reduce((a, w) => a + w.in, 0), tout = ws.reduce((a, w) => a + w.out, 0);
    const hasBal = S.cash.balance != null, low = hasBal ? ws.reduce((m, w) => w.bal < m.bal ? w : m, ws[0]) : null;
    const amzIn = ws.reduce((a, w) => a + w.amazon, 0), shIn = ws.reduce((a, w) => a + w.shopify, 0);
    const card = (cls, k, v, s) => `<div class="card ${cls}"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s}</span></div>`;
    $("cf-cards").innerHTML = [
      card("", "Cash now", hasBal ? short(S.cash.balance) : "—", hasBal ? `as of ${fmtD(S.cash.as_of || today())}` : "Type it in at the top right"),
      card("green", "Coming in, 4 months", short(tin), `Amazon ${short(amzIn)} · Shopify ${short(shIn)}${tin - amzIn - shIn ? ` · other ${short(tin - amzIn - shIn)}` : ""}`),
      card("red", "Going out, 4 months", short(tout), `${short(ws.reduce((a, w) => a + w.bills, 0))} in bills${ws.reduce((a, w) => a + w.other_out, 0) ? ` · ${short(ws.reduce((a, w) => a + w.other_out, 0))} other` : ""}`),
      card(hasBal && ws[ws.length - 1].bal < 0 ? "red" : "", "Cash in 4 months", hasBal ? short(ws[ws.length - 1].bal) : short(tin - tout), hasBal ? `net ${short(tin - tout)}` : "net change (no starting balance yet)"),
      card(low && low.bal < 0 ? "red" : low ? "amber" : "", "Lowest point", low ? short(low.bal) : "—", low ? `week of ${fmtD(low.k)}` : "Needs a starting balance"),
    ].join("");
    chart(ws); table(ws); assumptions(streams);
  }

  function chart(ws) {
    const W = 1000, H = 260, pad = { l: 56, r: 12, t: 12, b: 26 }, bw = (W - pad.l - pad.r) / ws.length;
    const hasBal = S.cash.balance != null;
    const hi = Math.max(1, ...ws.map(w => w.in), ...(hasBal ? ws.map(w => w.bal) : [])), lo = Math.min(0, ...ws.map(w => -w.out), ...(hasBal ? ws.map(w => w.bal) : []));
    const y = (v) => pad.t + (hi - v) / (hi - lo) * (H - pad.t - pad.b);
    let s = `<svg viewBox="0 0 ${W} ${H}" class="cf-svg" role="img" aria-label="Weekly money in and out">`;
    for (const v of [hi, (hi + lo) / 2, lo, 0]) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? "zero" : "grid"}"/><text x="${pad.l - 6}" y="${y(v) + 4}" class="ax" text-anchor="end">${short(v)}</text>`;
    ws.forEach((w, i) => {
      const x = pad.l + i * bw + bw * 0.18, bwi = bw * 0.64;
      let top = 0;
      for (const [k, c] of [["amazon", "var(--green2)"], ["shopify", "var(--blue)"], ["other_in", "#7FA89A"]]) { if (!w[k]) continue; s += `<rect x="${x}" y="${y(top + w[k])}" width="${bwi}" height="${y(top) - y(top + w[k])}" fill="${c}"><title>${esc(fmtD(w.k))}: ${k.replace("_", " ")} ${money(w[k])}</title></rect>`; top += w[k]; }
      let bot = 0;
      for (const [k, c] of [["bills", "var(--red)"], ["other_out", "#D49A86"]]) { if (!w[k]) continue; s += `<rect x="${x}" y="${y(bot)}" width="${bwi}" height="${y(bot - w[k]) - y(bot)}" fill="${c}"><title>${esc(fmtD(w.k))}: ${k === "bills" ? "bills" : "other out"} ${money(w[k])}</title></rect>`; bot -= w[k]; }
      if (i % 2 === 0) s += `<text x="${pad.l + i * bw + bw / 2}" y="${H - 8}" class="ax" text-anchor="middle">${esc(fmtD(w.k))}</text>`;
    });
    if (hasBal) s += `<polyline points="${ws.map((w, i) => `${pad.l + i * bw + bw / 2},${y(w.bal)}`).join(" ")}" class="balline"/>` + ws.map((w, i) => `<circle cx="${pad.l + i * bw + bw / 2}" cy="${y(w.bal)}" r="3" class="baldot ${w.bal < 0 ? "neg" : ""}"><title>Cash after week of ${esc(fmtD(w.k))}: ${money(w.bal)}</title></circle>`).join("");
    s += "</svg>";
    $("cf-chart").innerHTML = s + `<div class="cf-legend"><span><i style="background:var(--green2)"></i>Amazon</span><span><i style="background:var(--blue)"></i>Shopify</span><span><i style="background:#7FA89A"></i>Other in</span><span><i style="background:var(--red)"></i>Bills</span><span><i style="background:#D49A86"></i>Other out</span>${hasBal ? '<span><i class="ln"></i>Cash balance</span>' : ""}</div>`;
  }

  function table(ws) {
    const hasBal = S.cash.balance != null;
    const cell = (v, cls) => `<td class="n ${cls || ""}">${v ? money(v) : '<span class="m">—</span>'}</td>`;
    const rows = ws.map(w => {
      const estAny = w.items.some(e => e.state === "estimate");
      const head = `<tr class="row" data-week="${w.k}"><td><b>${fmtD(w.k)}</b>${w.k === monday(today()) ? ' <span class="pill soon">this week</span>' : ""}</td>${cell(w.amazon)}${cell(w.shopify)}${cell(w.other_in)}${cell(w.bills, "out")}${cell(w.other_out, "out")}<td class="n"><b class="${w.net < 0 ? "negt" : ""}">${money(w.net)}</b>${estAny ? '<div class="m">incl. estimates</div>' : ""}</td>${hasBal ? `<td class="n"><b class="${w.bal < 0 ? "negt" : ""}">${money(w.bal)}</b></td>` : ""}</tr>`;
      if (!S.open.has(w.k)) return head;
      const ins = w.items.filter(e => e.type === "in").sort((a, b) => a.day.localeCompare(b.day));
      const outs = w.items.filter(e => e.type === "out").sort((a, b) => a.day.localeCompare(b.day) || b.amount - a.amount);
      const inRow = (e) => {
        if (e.src === "other") return `<tr><td>${fmtD(e.day)}</td><td>${esc(e.label)} <span class="pill open">typed</span></td><td class="n">${money(e.amount)}</td><td><button class="link" data-rm="${e.id}">Remove</button></td></tr>`;
        if (e.state === "actual") return `<tr><td>${fmtD(e.day)}</td><td>${esc(e.label)} <span class="pill paid">paid</span></td><td class="n">${money(e.amount)}</td><td></td></tr>`;
        return `<tr><td>${fmtD(e.day)}</td><td>${esc(e.label)} <span class="pill ${e.state === "typed" ? "open" : "est"}">${e.state === "typed" ? "your number" : "estimate"}</span></td>
          <td class="n"><input class="amt ${e.state === "estimate" ? "estv" : ""}" data-stream="${esc(e.stream)}" data-day="${e.day}" value="${money(e.amount)}" aria-label="${esc(e.label)} payout ${esc(fmtD(e.day))}"></td>
          <td>${e.state === "typed" ? `<button class="link" data-reset="${esc(e.stream)}|${e.day}" title="Back to the estimate (${money(e.est)})">Use estimate</button>` : ""}</td></tr>`;
      };
      const outRow = (e) => e.src === "bill"
        ? `<tr><td>${fmtD(e.due)}</td><td>${esc(e.label)}${e.doc ? ` <span class="m">#${esc(e.doc)}</span>` : ""}${e.state === "overdue" ? ' <span class="pill over">overdue</span>' : ""}</td><td class="n">${money(e.amount)}</td><td></td></tr>`
        : `<tr><td>${fmtD(e.day)}</td><td>${esc(e.label)} <span class="pill open">typed</span></td><td class="n">${money(e.amount)}</td><td><button class="link" data-rm="${e.id}">Remove</button></td></tr>`;
      const add = (kind) => `<form class="cf-add" data-kind="${kind}" data-week="${w.k}"><input name="note" placeholder="${kind === "other_in" ? "e.g. Wholesale invoice #123" : "e.g. Payroll, rent, tax"}" aria-label="What"><input name="day" type="date" value="${w.k}" min="${w.k}" max="${addDays(w.k, 6)}" aria-label="Date"><input name="amount" class="amt" placeholder="$0" aria-label="Amount"><button class="btn small" type="submit">Add</button></form>`;
      return head + `<tr class="detail"><td colspan="${hasBal ? 8 : 7}"><div class="det">
        <div><h3>Coming in · ${money(w.in)}</h3><table>${ins.map(inRow).join("") || '<tr><td class="m">Nothing expected</td></tr>'}</table>${add("other_in")}</div>
        <div><h3>Going out · ${money(w.out)}</h3><table>${outs.map(outRow).join("") || '<tr><td class="m">Nothing due</td></tr>'}</table>${add("other_out")}</div></div></td></tr>`;
    }).join("");
    const tot = (k) => ws.reduce((a, w) => a + w[k], 0);
    $("cf-table").innerHTML = `<table><thead><tr><th>Week of</th><th class="n">Amazon</th><th class="n">Shopify</th><th class="n">Other in</th><th class="n">Bills due</th><th class="n">Other out</th><th class="n">Net</th>${hasBal ? '<th class="n">Cash after</th>' : ""}</tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><td><b>4 months</b></td>${cell(tot("amazon"))}${cell(tot("shopify"))}${cell(tot("other_in"))}${cell(tot("bills"), "out")}${cell(tot("other_out"), "out")}<td class="n"><b>${money(tot("net"))}</b></td>${hasBal ? `<td class="n"><b>${money(ws[ws.length - 1].bal)}</b></td>` : ""}</tr></tfoot></table>`;
  }

  function assumptions(streams) {
    const shop = streams.find(s => s.kind === "shopify");
    $("cf-assume").innerHTML = `<table><thead><tr><th>Payout</th><th>Lands</th><th>Last one</th><th class="n">Typical</th><th>Based on</th></tr></thead><tbody>
      ${streams.map(s => `<tr><td><b>${esc(s.label)}</b></td><td>${s.kind === "shopify" ? `<select id="cf-shopday" aria-label="Shopify payout day">${DAYS.map((d, i) => `<option value="${i}" ${i === s.weekday ? "selected" : ""}>Every ${d}</option>`).join("")}</select>` : `Every ${s.gap === 7 ? "" : s.gap / 7 + " weeks on "}${DAYS[s.weekday]}`}</td>
        <td>${s.last ? fmtD(s.last) + (s.n ? "" : "") : '<span class="m">none yet</span>'}</td><td class="n">${money(s.avg)}</td>
        <td class="m">${esc(s.basis)}${s.kind === "shopify" && !shop.n ? ` · <label>share <input id="cf-shoppct" class="pct" value="${esc(S.shopCfg.pct_of_sales)}" inputmode="decimal">%</label>` : ""}</td></tr>`).join("")}
      </tbody></table>
      <p class="m">Amazon history starts Sep 1, 2026 (when Amazon's payments data was connected), so early estimates rest on a few payouts. Shopify switches to real payouts once the Shopify app has the <code>read_shopify_payments_payouts</code> permission.</p>`;
  }

  // ---------- saving ----------
  async function save(fn, p, okMsg) {
    try { await FIN.write(fn, { p }); if (okMsg) note("", okMsg); } catch (e) { note("bad", "Couldn't save: " + esc(e.message || e)); }
    await load(true);
  }
  function note(kind, html) { const n = $("cf-note"); n.hidden = !html; n.className = "note " + (kind || ""); n.innerHTML = html || ""; }

  document.addEventListener("DOMContentLoaded", () => {
    const main = $("cash");
    main.addEventListener("click", (ev) => {
      const r = ev.target.closest("tr[data-week]");
      if (r && !ev.target.closest("input,button,select,a")) { const k = r.dataset.week; S.open.has(k) ? S.open.delete(k) : S.open.add(k); render(); return; }
      const rm = ev.target.closest("[data-rm]"); if (rm) { save("fin_forecast_set", { op: "remove", id: Number(rm.dataset.rm) }); return; }
      const rs = ev.target.closest("[data-reset]"); if (rs) { const [stream, day] = rs.dataset.reset.split("|"); save("fin_forecast_set", { op: "set", stream, expected_on: day, amount: null }); }
    });
    main.addEventListener("change", (ev) => {
      const t = ev.target;
      if (t.matches("input.amt[data-stream]")) { const v = parseAmt(t.value); if (v == null) { render(); return; } save("fin_forecast_set", { op: "set", stream: t.dataset.stream, expected_on: t.dataset.day, amount: v }); }
      else if (t.id === "cf-bal") { const v = parseAmt(t.value); save("fin_settings_set", { key: "cash", value: { balance: v, as_of: $("cf-asof").value || today() } }); }
      else if (t.id === "cf-asof") save("fin_settings_set", { key: "cash", value: { as_of: t.value || null } });
      else if (t.id === "cf-shopday") save("fin_settings_set", { key: "shopify", value: { weekday: Number(t.value) } });
      else if (t.id === "cf-shoppct") { const v = parseAmt(t.value); if (v != null && v > 0 && v <= 100) save("fin_settings_set", { key: "shopify", value: { pct_of_sales: v } }); }
    });
    main.addEventListener("submit", (ev) => {
      const f = ev.target.closest("form.cf-add"); if (!f) return;
      ev.preventDefault();
      const v = parseAmt(f.amount.value);
      if (!v) { f.amount.focus(); return; }
      save("fin_forecast_set", { op: "add", kind: f.dataset.kind, expected_on: f.day.value || f.dataset.week, amount: v, note: f.note.value.trim() });
    });
    if (!$("cash").hidden) FIN.ready.then(() => load(false));   // opened straight on #cash
    window.addEventListener("fin:page", (e) => { if (e.detail === "cash") { if (!S.loaded && !S.loading) FIN.ready.then(() => load(false)); else render(); } });
  });
})();
