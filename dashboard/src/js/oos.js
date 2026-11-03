// Inventory › Out of stock (Brian, Nov 3): every Shopify product that went to 0 in the last 7 days, by an order or by an
// inventory adjustment (jt.stockouts, from ShopifyQL's inventory dataset each hour; sold that day = start means orders,
// 0 means an adjustment), that's still at 0. Count sets Shopify's available stock to the number counted (jt_stock_count
// -> a jt.shopify_stock_moves row with set_to, applied by job fbm-inventory right away). A product counted at 0 stays on
// the list with the time of its last physical count; one counted above 0 leaves once Shopify has the count.
(() => {
  const $ = (id) => document.getElementById(id);
  if (!$("tab-oos")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const n0 = (x) => Math.round(x || 0).toLocaleString();
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const TZ = "America/Los_Angeles";
  const S = { rows: null, err: null, loading: false, how: "all", vendor: "all", q: "", counting: null, busy: null, sort: "day", dir: -1 };
  const msg = (e) => (window.JT.message ? window.JT.message(e) : (e && e.message) || String(e));
  const day = (d) => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";
  const when = (t) => { const d = window.JTDate ? window.JTDate.parseTime(t) : new Date(t); return !t || isNaN(d) ? "" : d.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  const who = (e) => String(e || "").replace(/@.*/, "");
  const HOW = { order: "Sold out", adjust: "Adjustment", both: "Orders + adjustment" };
  const howOf = (start, sold) => sold <= 0 ? "adjust" : sold >= start ? "order" : "both";

  async function load(refresh) {
    S.loading = true; S.err = null; render();
    try {
      const r = await window.JT.rows(["v.variant_id::text", "v.product_id::text", "v.product_title", "v.variant_title", "v.sku", "v.vendor", "v.product_type",
        "jt.shopify_qty_now(v.variant_id)::text", "so.day::text", "so.start_units::text", "so.sold::text",
        "c.at::text", "c.counted::text", "c.by", "m.status", "m.error", "(select max(seen_at) from jt.stockouts)::text"],
        `from (select distinct on (variant_id) variant_id, day, start_units, sold from jt.stockouts where day >= current_date - 7 order by variant_id, day desc) so
         join jt.variants v on v.variant_id = so.variant_id and v.removed_at is null
         left join lateral (select at, counted, by, move_id from jt.stock_counts k where k.variant_id = v.variant_id order by at desc limit 1) c on true
         left join jt.shopify_stock_moves m on m.id = c.move_id
         where jt.shopify_qty_now(v.variant_id) <= 0 or m.status = 'pending'`, refresh);
      S.rows = r.map(x => ({ vid: x[0], pid: x[1], title: x[2], vt: x[3] && x[3] !== "Default Title" ? x[3] : "", sku: x[4] || "", vendor: x[5] || "", type: x[6] || "",
        qty: +x[7] || 0, day: x[8], start: +x[9] || 0, sold: +x[10] || 0, how: howOf(+x[9] || 0, +x[10] || 0),
        countAt: x[11], counted: x[12] == null ? null : +x[12], countBy: x[13] || "", moveSt: x[14] || "", moveErr: x[15] || "" }));
      S.seen = r.length ? r[0][16] : null;
    } catch (e) { S.err = e; }
    S.loading = false; render();
  }

  function filtered() {
    const q = S.q.trim().toLowerCase();
    let L = (S.rows || []).filter(r => (S.how === "all" || (S.how === "counted" ? !!r.countAt : S.how === "notcounted" ? !r.countAt : r.how === S.how || (S.how === "order" && r.how === "both")))
      && (S.vendor === "all" || r.vendor === S.vendor)
      && (!q || (r.title + " " + r.vt + " " + r.sku + " " + r.vendor).toLowerCase().includes(q)));
    const key = { day: r => r.day || "", product: r => (r.title + r.vt).toLowerCase(), vendor: r => r.vendor.toLowerCase(), count: r => r.countAt || "" }[S.sort];
    L.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * S.dir || a.title.localeCompare(b.title); });
    return L;
  }

  function render() {
    const st = $("oos-status");
    if (S.loading && !S.rows) { st.textContent = "Loading…"; return; }
    if (S.err) { st.innerHTML = `<span class="neg">Couldn't load: ${esc(msg(S.err))}</span>`; return; }
    if (!S.rows) return;
    st.textContent = S.seen ? `From Shopify's inventory history, checked ${when(S.seen)} (every hour)` : "";
    const all = S.rows, L = filtered();
    const k = (l, v, s, go, c) => `<div class="kpi ${c || ""} ${S.how === go ? "on" : ""}"><button class="kpi-go" type="button" data-oos-how="${go}" aria-pressed="${S.how === go}"><span class="eyebrow">${l}</span><span class="v">${v}</span><span class="s">${esc(s)}</span></button></div>`;
    $("oos-kpis").innerHTML = [
      k("Out of stock", n0(all.length), "went to 0 in the last 7 days", "all"),
      k("Sold out", n0(all.filter(r => r.how !== "adjust").length), "the last units went on orders", "order"),
      k("Adjusted to 0", n0(all.filter(r => r.how === "adjust").length), "an inventory adjustment, not a sale", "adjust", all.some(r => r.how === "adjust") ? "warnk" : ""),
      k("Not counted yet", n0(all.filter(r => !r.countAt).length), "no physical count since", "notcounted"),
      k("Counted", n0(all.filter(r => r.countAt).length), "counted at 0 (or sending)", "counted"),
    ].join("");
    const vendors = [...new Set(all.map(r => r.vendor).filter(Boolean))].sort();
    $("oos-filters").innerHTML = `<label class="small">Vendor <select class="inp sm" id="oos-vendor" style="width:auto"><option value="all">All vendors</option>${vendors.map(v => `<option value="${esc(v)}" ${S.vendor === v ? "selected" : ""}>${esc(v)} (${all.filter(r => r.vendor === v).length})</option>`).join("")}</select></label>
      <input class="inp" type="search" id="oos-q" value="${esc(S.q)}" placeholder="Product, SKU or vendor" style="max-width:240px" autocomplete="off" data-lpignore="true" data-jtnofill="1">
      ${S.how !== "all" ? `<button class="linkbtn small" type="button" data-oos-how="all">Show all</button>` : ""}<span class="muted small right">${n0(L.length)} shown</span>`;
    const th = (k, n, cls) => `<th class="${cls || ""}"><button type="button" class="oos-sort" data-oos-sort="${k}">${n}${S.sort === k ? (S.dir > 0 ? " ▲" : " ▼") : ""}</button></th>`;
    $("oos-body").innerHTML = L.length ? `<div class="tbl-wrap"><table class="oos-t"><thead><tr>${th("product", "Product", "l")}${th("vendor", "Vendor", "l")}${th("day", "Went to 0", "l")}<th class="l">How</th>${th("count", "Last count", "l")}<th></th></tr></thead><tbody>${L.map(r => {
      const counting = S.counting === r.vid, busy = S.busy === r.vid;
      const sending = r.moveSt === "pending", failed = r.moveSt === "failed";
      const last = r.countAt ? `<b>${n0(r.counted)}</b> · ${esc(when(r.countAt))}${r.countBy ? ` · ${esc(who(r.countBy))}` : ""}${sending ? `<br><span class="pill warn">Sending to Shopify…</span>` : ""}${failed ? `<br><span class="neg small">Shopify didn't take it: ${esc(r.moveErr)}</span>` : ""}` : `<span class="dim">not counted</span>`;
      return `<tr>
        <td class="l"><a class="olink" href="${ADMIN}/products/${esc(r.pid)}/variants/${esc(r.vid)}" target="_blank" rel="noopener">${esc(r.title)}</a>${r.vt ? `<div class="small">${esc(r.vt)}</div>` : ""}<div class="dim small">${esc(r.sku || "no SKU")}</div></td>
        <td class="l">${esc(r.vendor)}</td>
        <td class="l">${esc(day(r.day))}<div class="dim small">had ${n0(r.start)}</div></td>
        <td class="l"><span class="pill ${r.how === "adjust" ? "warn" : "other"}" title="${n0(r.sold)} of ${n0(r.start)} sold that day">${HOW[r.how]}</span></td>
        <td class="l">${last}</td>
        <td class="oos-act">${counting ? `<span class="oos-count"><input class="inp sm" id="oos-n" type="number" min="0" step="1" inputmode="numeric" placeholder="Count" aria-label="How many are on the shelf" autocomplete="off" data-lpignore="true" data-jtnofill="1" ${busy ? "disabled" : ""}><button class="btn sm primary" type="button" data-oos-save="${esc(r.vid)}" ${busy ? "disabled" : ""}>${busy ? "Saving…" : "Save"}</button><button class="btn sm" type="button" data-oos-cancel="1" ${busy ? "disabled" : ""}>Cancel</button></span>`
          : `<button class="btn sm" type="button" data-oos-count="${esc(r.vid)}" ${sending ? "disabled title='Waiting for Shopify to take the last count'" : ""}>Count</button>`}</td></tr>`; }).join("")}</tbody></table></div>`
      : `<div class="panel muted small" style="padding:14px">${all.length ? "Nothing matches." : "Nothing went out of stock in the last 7 days."}</div>`;
    if (S.counting) { const i = $("oos-n"); if (i && !S.busy) i.focus(); }
  }

  async function saveCount(vid) {
    const i = $("oos-n"), v = i ? i.value.trim() : "";
    if (!/^\d+$/.test(v)) { note(`<span class="neg">Enter a whole number, 0 or more.</span>`); if (i) i.focus(); return; }
    const n = Number(v), r = S.rows.find(x => x.vid === vid);
    S.busy = vid; render();
    try {
      const p = { variant_id: Number(vid), counted: n }, W = window.JTWeb || null;
      if (W) await W.write("jt_stock_count", { p });
      else await window.JT.run(`select jt.stock_count(${window.JT.q(JSON.stringify({ ...p, by: "Claude dashboard" }))}::jsonb)::text as r`, true);
      if (W && W.clearCache) W.clearCache();
      S.counting = null; S.busy = null;
      note(n > 0 ? `Counted <b>${n0(n)}</b> of ${esc(r ? r.title : "it")}: sending to Shopify. It leaves this list once Shopify has it.` : `Counted <b>0</b> of ${esc(r ? r.title : "it")}: it stays on the list with this count.`);
      await load(true);
      if (n > 0) setTimeout(() => load(true), 90000);     // the sync job usually applies it within a minute or two
    } catch (e) { S.busy = null; render(); note(`<span class="neg">Couldn't save the count: ${esc(msg(e))}</span>`); }
  }
  function note(h) { const n = $("oos-note"); n.innerHTML = h; n.hidden = false; }

  const tab = $("tab-oos");
  tab.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.oosHow != null) { S.how = b.dataset.oosHow === S.how && S.how !== "all" ? "all" : b.dataset.oosHow; render(); return; }
    if (b.dataset.oosSort) { const k = b.dataset.oosSort; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = k === "day" || k === "count" ? -1 : 1; } render(); return; }
    if (b.dataset.oosCount) { S.counting = b.dataset.oosCount; render(); return; }
    if (b.dataset.oosCancel) { S.counting = null; render(); return; }
    if (b.dataset.oosSave) { saveCount(b.dataset.oosSave); return; }
  });
  tab.addEventListener("keydown", (e) => {
    if (e.target.id !== "oos-n") return;
    if (e.key === "Enter") { e.preventDefault(); if (S.counting) saveCount(S.counting); }
    else if (e.key === "Escape") { S.counting = null; render(); }
  });
  tab.addEventListener("change", (e) => { if (e.target.id === "oos-vendor") { S.vendor = e.target.value; render(); } });
  tab.addEventListener("input", (e) => {
    if (e.target.id !== "oos-q") return;
    S.q = e.target.value; const pos = e.target.selectionStart; render();
    const i = $("oos-q"); if (i) { i.focus(); i.setSelectionRange(pos, pos); }
  });
  $("oos-refresh").addEventListener("click", () => load(true));
  window.oosShow = () => { if (!S.rows && !S.loading) load(false); else render(); };
  if ((location.hash || "") === "#oos") setTimeout(() => window.oosShow(), 0);
})();
