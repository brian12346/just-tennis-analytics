// Inventory › Out of stock (Brian, Nov 3): every Shopify product that went to 0 in the last 7 days, by an order or by an
// inventory adjustment (jt.stockouts, from ShopifyQL's inventory dataset each hour; sold that day = start means orders,
// 0 means an adjustment), that's still at 0. Count sets Shopify's available stock to the number counted (jt_stock_count
// -> a jt.shopify_stock_moves row with set_to, applied by job fbm-inventory right away). A product counted at 0 stays on
// the list with the time of its last physical count; one counted above 0 leaves once Shopify has the count.
// Then each one is decided (Brian, Nov 3, migration 200):
//   Reorder  -> the To order list below (jt.prep_list, dest shopify: On The List), from where it goes on the vendor's
//               draft PO; receiving the PO closes it.
//   Archive  -> the Shopify product set to Archived (jt_product_archive; job fbm-inventory), when none of its variants
//               has stock left — we're not carrying it any more.
(() => {
  const $ = (id) => document.getElementById(id);
  if (!$("tab-oos")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const n0 = (x) => Math.round(x || 0).toLocaleString();
  const m2 = (x) => x == null ? "—" : "$" + Number(x).toFixed(2);
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const TZ = "America/Los_Angeles";
  const S = { rows: null, list: null, err: null, loading: false, how: "all", vendor: "all", cat: "all", q: "", open: null, busy: null, sort: "day", dir: -1 };
  const msg = (e) => (window.JT.message ? window.JT.message(e) : (e && e.message) || String(e));
  const day = (d) => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";
  const when = (t) => { const d = window.JTDate ? window.JTDate.parseTime(t) : new Date(t); return !t || isNaN(d) ? "" : d.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  const who = (e) => String(e || "").replace(/@.*/, "");
  const HOW = { order: "Sold out", adjust: "Adjustment", both: "Orders + adjustment" };
  const howOf = (start, sold) => sold <= 0 ? "adjust" : sold >= start ? "order" : "both";
  const STAGE = { draft: "Draft PO", ordered: "Ordered", invoiced: "Invoiced", partial: "Partly received", received: "Received", qb_ready: "Received", complete: "Received" };
  const discontinued = (t) => /\bTF-?X1\b/i.test(t || "");     // TF-X1 racquets are discontinued: never reorder
  const W = () => window.JTWeb || null;
  async function call(fn, sqlFn, p) {
    if (W()) { const r = await W().write(fn, { p }); if (W().clearCache) W().clearCache(); return r; }
    const out = await window.JT.run(`select ${sqlFn}(${window.JT.q(JSON.stringify({ ...p, by: "Claude dashboard" }))}::jsonb)::text as r`, true);
    return out[0] && out[0].r;
  }

  // the out-of-stock list: went to 0 in the last 7 days, plus what was put back To count (migration 204; the page works
  // without it until it's applied)
  const MAIN_COLS = ["v.variant_id::text", "v.product_id::text", "v.product_title", "v.variant_title", "v.sku", "v.vendor", "v.product_type",
          "jt.shopify_qty_now(v.variant_id)::text", "so.day::text", "so.start_units::text", "so.sold::text",
          "c.at::text", "c.counted::text", "c.by", "m.status", "m.error", "(select max(seen_at) from jt.stockouts)::text",
          "(select coalesce(sum(greatest(jt.shopify_qty_now(o.variant_id), 0)), 0) from jt.variants o where o.product_id = v.product_id and o.variant_id <> v.variant_id and o.removed_at is null)::text",
          "(select count(*) from jt.variants o where o.product_id = v.product_id and o.removed_at is null)::text",
          "a.status", "a.error", "a.created_at::text", "so.rc::text"];
  const mainRows = (refresh) => window.JT.rows(MAIN_COLS, `from (select a.variant_id, a.day, a.start_units, a.sold, false as rc
                   from (select distinct on (variant_id) variant_id, day, start_units, sold from jt.stockouts where day >= current_date - 7 order by variant_id, day desc) a
                   where not exists (select 1 from jt.oos_recount r where r.variant_id = a.variant_id)
                 union all
                 select r.variant_id, s.day, coalesce(s.start_units, 0), coalesce(s.sold, 0), true from jt.oos_recount r
                   left join lateral (select day, start_units, sold from jt.stockouts s where s.variant_id = r.variant_id order by day desc limit 1) s on true
                   where not exists (select 1 from jt.stock_counts k where k.variant_id = r.variant_id and k.at > r.at and k.counted > 0)) so
           join jt.variants v on v.variant_id = so.variant_id and v.removed_at is null and coalesce(v.status, '') <> 'ARCHIVED'
           left join lateral (select at, counted, by, move_id from jt.stock_counts k where k.variant_id = v.variant_id order by at desc limit 1) c on true
           left join jt.shopify_stock_moves m on m.id = c.move_id
           left join lateral (select status, error, created_at from jt.product_archives x where x.product_id = v.product_id order by created_at desc limit 1) a on true
           where (jt.shopify_qty_now(v.variant_id) <= 0 or m.status = 'pending' or so.rc)
             and coalesce(a.status, '') <> 'done'
             and not exists (select 1 from jt.prep_list i where i.variant_id = v.variant_id and i.dest = 'shopify' and i.closed_at is null)`, refresh)
    .then(r => { S.hasRecount = true; return r; })
    .catch(() => { S.hasRecount = false; return window.JT.rows(MAIN_COLS, `from (select distinct on (variant_id) variant_id, day, start_units, sold, false as rc from jt.stockouts where day >= current_date - 7 order by variant_id, day desc) so
           join jt.variants v on v.variant_id = so.variant_id and v.removed_at is null and coalesce(v.status, '') <> 'ARCHIVED'
           left join lateral (select at, counted, by, move_id from jt.stock_counts k where k.variant_id = v.variant_id order by at desc limit 1) c on true
           left join jt.shopify_stock_moves m on m.id = c.move_id
           left join lateral (select status, error, created_at from jt.product_archives x where x.product_id = v.product_id order by created_at desc limit 1) a on true
           where (jt.shopify_qty_now(v.variant_id) <= 0 or m.status = 'pending')
             and coalesce(a.status, '') <> 'done'
             and not exists (select 1 from jt.prep_list i where i.variant_id = v.variant_id and i.dest = 'shopify' and i.closed_at is null)`, refresh); });
  async function load(refresh) {
    S.loading = true; S.err = null; render();
    try {
      const [r, l, g, nt] = await Promise.all([
        mainRows(refresh),
        window.JT.rows(["i.id::text", "v.variant_id::text", "v.product_id::text", "v.product_title", "v.variant_title", "v.sku", "v.vendor",
          "i.qty::text", "i.added_at::text", "i.added_by", "i.order_id::text", "o.status", "o.po_no", "jt.shopify_qty_now(v.variant_id)::text", "v.unit_cost::text", "i.source",
          "pl.par::text", "pl.target_days::text",
          `(select coalesce(sum(greatest(l.qty_ordered - l.qty_received, 0)), 0) from jt.prep_order_lines l join jt.prep_orders o on o.id = l.order_id
             where l.variant_id = v.variant_id and l.dest = 'shopify' and o.status in ('ordered', 'invoiced', 'partial') and o.id is distinct from i.order_id)::text`,
          "(select coalesce(sum(s.units), 0) from jt.shopify_sales s where s.variant_id = v.variant_id and s.day > current_date - 90)::text",
          "(select c.pack from jt.case_packs c where c.variant_id = v.variant_id)::text", "(select c.pack from jt.case_packs c where lower(c.vendor) = lower(v.vendor))::text", "pl.round", "coalesce(v.product_type, '')"],
          `from jt.prep_list i join jt.variants v on v.variant_id = i.variant_id left join jt.prep_orders o on o.id = i.order_id
           left join jt.par_levels pl on pl.variant_id = v.variant_id
           where i.closed_at is null and i.dest = 'shopify' order by v.vendor, v.product_title, v.variant_title`, refresh),
        // ignored (migration 203): kept visible in their own table; a product that goes to 0 again after it was ignored comes back
        window.JT.rows(["g.variant_id::text", "v.product_id::text", "v.product_title", "v.variant_title", "v.sku", "v.vendor", "g.at::text", "g.by", "g.note",
          "jt.shopify_qty_now(v.variant_id)::text", "(select max(day) from jt.stockouts s where s.variant_id = g.variant_id)::text", "coalesce(v.status, '')"],
          `from jt.oos_ignored g join jt.variants v on v.variant_id = g.variant_id order by g.at desc`, refresh).catch(() => null),
        // notes (migration 215): one per product, on its row in every table
        window.JT.rows(["variant_id::text", "note", "by", "at::text"], "from jt.oos_notes", refresh).catch(() => null),
      ]);
      S.notes = nt ? new Map(nt.map(x => [x[0], { note: x[1] || "", by: x[2] || "", at: x[3] }])) : null;
      S.rows = r.map(x => ({ vid: x[0], pid: x[1], title: x[2], vt: x[3] && x[3] !== "Default Title" ? x[3] : "", sku: x[4] || "", vendor: x[5] || "", type: x[6] || "",
        qty: +x[7] || 0, day: x[8], start: +x[9] || 0, sold: +x[10] || 0, how: howOf(+x[9] || 0, +x[10] || 0),
        countAt: x[11], counted: x[12] == null ? null : +x[12], countBy: x[13] || "", moveSt: x[14] || "", moveErr: x[15] || "",
        others: +x[17] || 0, nvar: +x[18] || 1, arSt: x[19] || "", arErr: x[20] || "", arAt: x[21], toCount: x[22] === "true" }));
      S.seen = r.length ? r[0][16] : null;
      S.ign = g ? g.map(x => ({ vid: x[0], pid: x[1], title: x[2], vt: x[3] && x[3] !== "Default Title" ? x[3] : "", sku: x[4] || "", vendor: x[5] || "", at: x[6], by: x[7] || "", note: x[8] || "",
        now: +x[9] || 0, day: x[10] || "", status: x[11] || "" })) : null;
      { const ig = new Map((S.ign || []).map(x => [x.vid, x])); const ymd = (t) => { const d = window.JTDate ? window.JTDate.parseTime(t) : new Date(t); return isNaN(d) ? "" : d.toLocaleDateString("en-CA", { timeZone: TZ }); };
        S.rows = S.rows.filter(x => { const i = ig.get(x.vid); return !i || (x.day && x.day > ymd(i.at)); }); }
      S.list = l.map(x => ({ id: x[0], vid: x[1], pid: x[2], title: x[3], vt: x[4] && x[4] !== "Default Title" ? x[4] : "", sku: x[5] || "", vendor: x[6] || "",
        qty: x[7] == null ? null : +x[7], at: x[8], by: x[9] || "", oid: x[10], ost: x[11] || "", po: x[12] || "", now: +x[13] || 0, cost: x[14] == null ? null : +x[14], src: x[15] || "",
        par: x[16] == null ? null : +x[16], days: x[17] == null ? null : +x[17], onOrder: +x[18] || 0, sold90: +x[19] || 0,
        ownPack: x[20] == null ? null : +x[20], venPack: x[21] == null ? null : +x[21], round: x[22] || "up", type: x[23] || "" }));
    } catch (e) { S.err = e; }
    S.loading = false; render();
  }

  // category = the Shopify product type (Active products calls it category too)
  const catOf = (r) => (r.type || "").trim() || "No category";
  function filtered() {
    const q = S.q.trim().toLowerCase();
    let L = (S.rows || []).filter(r => (S.how === "all" || (S.how === "counted" ? !!r.countAt : S.how === "notcounted" ? (!r.countAt || r.toCount) : r.how === S.how || (S.how === "order" && r.how === "both")))
      && (S.vendor === "all" || r.vendor === S.vendor)
      && (S.cat === "all" || catOf(r) === S.cat)
      && (!q || (r.title + " " + r.vt + " " + r.sku + " " + r.vendor + " " + r.type).toLowerCase().includes(q)));
    const key = { day: r => r.day || "", product: r => (r.title + r.vt).toLowerCase(), vendor: r => r.vendor.toLowerCase(), cat: r => catOf(r).toLowerCase(), count: r => r.countAt || "" }[S.sort];
    L.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * S.dir || a.title.localeCompare(b.title); });
    return L;
  }

  // the note box on a row (saves when you leave it or press Enter)
  function noteCell(vid) {
    if (!S.notes) return "";
    const n = S.notes.get(String(vid)), saving = S.busy === "n:" + vid;
    return `<td class="l oos-notec"><input class="inp sm oos-note" type="text" maxlength="500" value="${esc(n ? n.note : "")}" placeholder="Add a note" data-oos-note="${esc(vid)}" aria-label="Note"
      title="${n ? esc(`${who(n.by) || "someone"} · ${when(n.at)}`) : "A note for the team: status, who's on it, what the vendor said…"}" autocomplete="off" data-lpignore="true" data-jtnofill="1" ${saving ? "disabled" : ""}>${n ? `<div class="dim small">${esc(who(n.by))}${n.by ? " · " : ""}${esc(when(n.at))}</div>` : ""}</td>`;
  }
  async function saveNote(vid, text) {
    const old = S.notes && S.notes.get(String(vid));
    if ((old ? old.note : "") === text.trim()) return;
    S.busy = "n:" + vid;
    try { await call("jt_oos_note", "jt.oos_note", { variant_id: Number(vid), note: text });
      if (text.trim()) S.notes.set(String(vid), { note: text.trim().slice(0, 500), by: ((document.getElementById("whoami") || {}).textContent || "").trim() || (old && old.by) || "", at: new Date().toISOString() });
      else S.notes.delete(String(vid));
      S.busy = null; render(); }
    catch (e) { S.busy = null; render(); note(`<span class="neg">Couldn't save the note: ${esc(msg(e))}</span>`); }
  }

  const isOpen = (vid, kind) => S.open && S.open.vid === vid && S.open.kind === kind;
  function actCell(r) {
    const busy = S.busy === r.vid, dis = busy ? "disabled" : "";
    const sending = r.moveSt === "pending", archiving = r.arSt === "pending";
    if (isOpen(r.vid, "count")) return `<span class="oos-count"><input class="inp sm" id="oos-n" type="number" min="0" step="1" inputmode="numeric" placeholder="Count" aria-label="How many are on the shelf" autocomplete="off" data-lpignore="true" data-jtnofill="1" ${dis}><button class="btn sm primary" type="button" data-oos-save="${esc(r.vid)}" ${dis}>${busy ? "Saving…" : "Save"}</button><button class="btn sm" type="button" data-oos-cancel="1" ${dis}>Cancel</button></span>`;
    if (archiving) return `<span class="pill warn">Archiving in Shopify…</span>`;
    const canArch = r.others <= 0;
    return `<span class="oos-btns"><button class="btn sm" type="button" data-oos-count="${esc(r.vid)}" ${sending ? "disabled title='Waiting for Shopify to take the last count'" : ""}>Count</button>`
      + (discontinued(r.title) ? `<button class="btn sm" type="button" disabled title="TF-X1 racquets are discontinued — not reordered">Reorder</button>` : `<button class="btn sm" type="button" data-oos-reorder="${esc(r.vid)}" ${dis} title="Put it on the To order list below — analyze it there to set how many">${busy ? "Adding…" : "Reorder"}</button>`)
      + (S.ign ? `<button class="btn sm" type="button" data-oos-ignore="${esc(r.vid)}" ${dis} title="Take it off this list and into Ignored below">Ignore</button>` : "")
      + `<button class="btn sm" type="button" data-oos-archive="${esc(r.vid)}" ${canArch ? `title="Not carrying it any more: archive the product in Shopify"` : `disabled title="${n0(r.others)} unit${r.others === 1 ? "" : "s"} of other variants still in stock — archiving takes the whole product off the store"`}>Archive</button></span>`;
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
      k("Out of stock", n0(all.length), "went to 0 in the last 7 days, not decided yet", "all"),
      k("Sold out", n0(all.filter(r => r.how !== "adjust").length), "the last units went on orders", "order"),
      k("Adjusted to 0", n0(all.filter(r => r.how === "adjust").length), "an inventory adjustment, not a sale", "adjust", all.some(r => r.how === "adjust") ? "warnk" : ""),
      k("Not counted yet", n0(all.filter(r => !r.countAt || r.toCount).length), all.some(r => r.toCount) ? `${n0(all.filter(r => r.toCount).length)} put back To count` : "no physical count since", "notcounted"),
      k("To order", n0((S.list || []).length), (S.list || []).filter(i => !i.oid).length ? `${n0(S.list.filter(i => !i.oid).length)} not on a PO yet` : "below", "toorder"),
    ].join("");
    const vendors = [...new Set(all.map(r => r.vendor).filter(Boolean))].sort();
    const cats = [...new Set([...all, ...(S.list || [])].map(catOf))].sort((a, b) => (a === "No category") - (b === "No category") || a.localeCompare(b));
    $("oos-filters").innerHTML = `<label class="small">Category <select class="inp sm" id="oos-cat" style="width:auto"><option value="all">All categories</option>${cats.map(c => `<option value="${esc(c)}" ${S.cat === c ? "selected" : ""}>${esc(c)} (${all.filter(r => catOf(r) === c).length})</option>`).join("")}</select></label>
      <label class="small">Vendor <select class="inp sm" id="oos-vendor" style="width:auto"><option value="all">All vendors</option>${vendors.map(v => `<option value="${esc(v)}" ${S.vendor === v ? "selected" : ""}>${esc(v)} (${all.filter(r => r.vendor === v).length})</option>`).join("")}</select></label>
      <input class="inp" type="search" id="oos-q" value="${esc(S.q)}" placeholder="Product, SKU, vendor or category" style="max-width:240px" autocomplete="off" data-lpignore="true" data-jtnofill="1">
      ${S.how !== "all" ? `<button class="linkbtn small" type="button" data-oos-how="all">Show all</button>` : ""}<span class="muted small right">${n0(L.length)} shown</span>`;
    const th = (k, n, cls) => `<th class="${cls || ""}"><button type="button" class="oos-sort" data-oos-sort="${k}">${n}${S.sort === k ? (S.dir > 0 ? " ▲" : " ▼") : ""}</button></th>`;
    const confirmRow = (r) => isOpen(r.vid, "archive") ? `<tr class="oos-confirm"><td colspan="${S.notes ? 8 : 7}"><div class="note warn">Archive <b>${esc(r.title)}</b> in Shopify?${r.nvar > 1 ? ` That's the whole product (${n0(r.nvar)} variants), none of which has stock.` : ""} It comes off the store and out of Seller Sage's lists; you can un-archive it in Shopify later.
        <span class="dbtns"><button class="mini primary" type="button" data-oos-archive-go="${esc(r.vid)}" ${S.busy ? "disabled" : ""}>${S.busy === r.vid ? "Archiving…" : "Yes, archive it"}</button><button class="mini" type="button" data-oos-cancel="1">Cancel</button></span></div></td></tr>` : "";
    $("oos-body").innerHTML = L.length ? `<div class="tbl-wrap"><table class="oos-t"><thead><tr>${th("product", "Product", "l")}${th("vendor", "Vendor", "l")}${th("cat", "Category", "l")}${th("day", "Went to 0", "l")}<th class="l">How</th>${th("count", "Last count", "l")}${S.notes ? '<th class="l">Notes</th>' : ""}<th></th></tr></thead><tbody>${L.map(r => {
      const sending = r.moveSt === "pending", failed = r.moveSt === "failed";
      const last = r.countAt ? `<b>${n0(r.counted)}</b> · ${esc(when(r.countAt))}${r.countBy ? ` · ${esc(who(r.countBy))}` : ""}${sending ? `<br><span class="pill warn">Sending to Shopify…</span>` : ""}${failed ? `<br><span class="neg small">Shopify didn't take it: ${esc(r.moveErr)}</span>` : ""}` : `<span class="dim">not counted</span>`;
      return `<tr data-oos-row="${esc(r.vid)}" title="Click for sales, cost and inventory history">
        <td class="l"><a class="olink" href="${ADMIN}/products/${esc(r.pid)}/variants/${esc(r.vid)}" target="_blank" rel="noopener">${esc(r.title)}</a>${r.vt ? `<div class="small">${esc(r.vt)}</div>` : ""}<div class="dim small">${esc(r.sku || "no SKU")}</div>${r.arSt === "failed" ? `<div class="neg small">Couldn't archive: ${esc(r.arErr)}</div>` : ""}</td>
        <td class="l">${esc(r.vendor)}</td>
        <td class="l small">${esc(catOf(r))}</td>
        <td class="l">${r.day ? `${esc(day(r.day))}<div class="dim small">had ${n0(r.start)}</div>` : '<span class="dim">—</span>'}</td>
        <td class="l">${r.toCount ? `<span class="pill manual" title="Put back on the list to be counted">To count</span> ` : ""}${r.day ? `<span class="pill ${r.how === "adjust" ? "warn" : "other"}" title="${n0(r.sold)} of ${n0(r.start)} sold that day">${HOW[r.how]}</span>` : ""}</td>
        <td class="l">${last}</td>
        ${noteCell(r.vid)}<td class="oos-act">${actCell(r)}</td></tr>${confirmRow(r)}`; }).join("")}</tbody></table></div>`
      : `<div class="muted small" style="padding:14px">${all.length ? "Nothing matches." : "Nothing out of stock waiting on a decision."}</div>`;
    renderList(); renderIgn();
    if (S.open && S.open.kind === "count") { const i = $("oos-n"); if (i && !S.busy) i.focus(); }
  }

  function renderIgn() {
    const sec = $("oos-ign-sec"), L = S.ign; if (!sec) return;
    sec.hidden = !L; if (!L) return;
    $("oos-ign-sum").textContent = L.length ? `${n0(L.length)} product${L.length === 1 ? "" : "s"}` : "";
    $("oos-ign").innerHTML = !L.length ? `<div class="muted small" style="padding:14px">Nothing ignored. <b>Ignore</b> takes a product off the out-of-stock list and keeps it here; <b>To count</b> puts it back on the list above.</div>`
      : `<div class="tbl-wrap"><table class="oos-t"><thead><tr><th class="l">Product</th><th class="l">Vendor</th><th class="l">Went to 0</th><th class="l">Ignored</th><th>Stock now</th>${S.notes ? '<th class="l">Notes</th>' : ""}<th></th></tr></thead><tbody>${L.map(i => `<tr data-oos-row="${esc(i.vid)}" title="Click for sales, cost and inventory history">
        <td class="l"><a class="olink" href="${ADMIN}/products/${esc(i.pid)}/variants/${esc(i.vid)}" target="_blank" rel="noopener">${esc(i.title)}</a>${i.vt ? `<div class="small">${esc(i.vt)}</div>` : ""}<div class="dim small">${esc(i.sku || "no SKU")}${i.status && i.status !== "ACTIVE" ? ` · ${esc(i.status.toLowerCase())}` : ""}</div></td>
        <td class="l">${esc(i.vendor)}</td><td class="l">${i.day ? esc(day(i.day)) : '<span class="dim">—</span>'}</td>
        <td class="l small">${esc(when(i.at))}${i.by ? ` · ${esc(who(i.by))}` : ""}</td>
        <td class="${i.now > 0 ? "okt" : "dim"}">${n0(i.now)}</td>
        ${noteCell(i.vid)}<td class="oos-act">${S.hasRecount ? `<button class="btn sm" type="button" data-oos-tocount="${esc(i.vid)}" ${S.busy ? "disabled" : ""} title="Put it back on the list above to be counted">${S.busy === "c:" + i.vid ? "…" : "To count"}</button>` : `<button class="btn sm" type="button" data-oos-unignore="${esc(i.vid)}" ${S.busy ? "disabled" : ""} title="Back on the list above while it's still within 7 days of going to 0">Un-ignore</button>`}</td></tr>`).join("")}</tbody></table></div>`;
  }
  async function toCount(vid) {
    S.busy = "c:" + vid; render();
    try { await call("jt_oos_to_count", "jt.oos_to_count", { variant_id: Number(vid) }); S.busy = null; note("Back on the list above, marked <b>To count</b>."); await load(true); }
    catch (e) { S.busy = null; render(); note(`<span class="neg">Couldn't put it back: ${esc(msg(e))}</span>`); }
  }
  async function ignore(vid, on) {
    S.busy = on ? vid : "g:" + vid; render();
    try { await call("jt_oos_ignore", "jt.oos_ignore", { variant_id: Number(vid), on }); S.busy = null; await load(true); }
    catch (e) { S.busy = null; render(); note(`<span class="neg">Couldn't ${on ? "ignore" : "un-ignore"} it: ${esc(msg(e))}</span>`); }
  }
  function renderList() {
    const L = (S.list || []).filter(i => S.cat === "all" || catOf(i) === S.cat), box = $("oos-list");
    $("oos-list-sum").textContent = L.length ? `${n0(L.length)} product${L.length === 1 ? "" : "s"} · ${n0(new Set(L.map(i => i.vendor)).size)} vendor${new Set(L.map(i => i.vendor)).size === 1 ? "" : "s"}` : "";
    if (!L.length) { box.innerHTML = `<div class="muted small" style="padding:14px">Nothing to order yet. <b>Reorder</b> on an out-of-stock product puts it here; from here it goes on the vendor's draft PO.</div>`; return; }
    const by = new Map(); for (const i of L) { if (!by.has(i.vendor)) by.set(i.vendor, []); by.get(i.vendor).push(i); }
    box.innerHTML = [...by.entries()].map(([ven, items]) => {
      const loose = items.filter(i => !i.oid), busyV = S.busy === "v:" + ven;
      return `<div class="oos-ven"><div class="row oos-vhead"><b>${esc(ven || "No vendor")}</b><span class="muted small">${n0(items.length)} product${items.length === 1 ? "" : "s"}</span>
        ${loose.length ? `<button class="btn sm right" type="button" data-oos-topo-v="${esc(ven)}" ${S.busy ? "disabled" : ""} title="Put the ${loose.length} not on a PO yet on ${esc(ven)}'s draft PO (one is started if there isn't one)">${busyV ? "Adding…" : `Put ${loose.length === items.length ? "all" : loose.length} on the draft PO`}</button>` : ""}</div>
        <div class="tbl-wrap"><table class="oos-t"><thead><tr><th class="l">Product</th><th title="Shopify available now">On hand</th><th title="On placed POs, not received yet">On order</th><th>Sold 90d</th><th>PAR</th><th>To order</th><th>Cost</th><th class="l">Added</th><th class="l">PO</th>${S.notes ? '<th class="l">Notes</th>' : ""}<th></th></tr></thead><tbody>${items.map(i => {
          const po = i.oid ? `<a class="olink" href="#po/${esc(i.oid)}">${esc(i.po ? i.po : "PO #" + i.oid)}</a> <span class="pill ${i.ost === "draft" ? "pos" : "other"}">${esc(STAGE[i.ost] || i.ost)}</span>` : `<span class="dim">not on a PO</span>`;
          return `<tr data-oos-row="${esc(i.vid)}" title="Click for sales, cost and inventory history"><td class="l"><a class="olink" href="${ADMIN}/products/${esc(i.pid)}/variants/${esc(i.vid)}" target="_blank" rel="noopener">${esc(i.title)}</a>${i.vt ? `<div class="small">${esc(i.vt)}</div>` : ""}<div class="dim small">${esc(i.sku || "no SKU")} · ${esc(catOf(i))}</div></td>
            <td class="${i.now <= 0 ? "dim" : ""}">${n0(i.now)}</td><td class="${i.onOrder ? "" : "dim"}">${i.onOrder ? n0(i.onOrder) : "—"}</td><td>${n0(i.sold90)}</td>
            <td>${i.par == null ? `<span class="dim">—</span>` : `<b>${n0(i.par)}</b>${i.days ? `<div class="dim small">${n0(i.days)} days</div>` : ""}`}${i.par != null && toPar(i) !== (i.qty || 0) && !(i.oid && i.ost !== "draft") ? `<div><button class="linkbtn small" type="button" data-oos-topar="${esc(i.id)}" title="Set To order to PAR − on hand − on order">order ${n0(toPar(i))}</button></div>` : ""}</td>
            <td><input class="inp sm oos-qty" type="number" min="0" step="1" inputmode="numeric" value="${i.qty == null ? "" : i.qty}" placeholder="—" data-oos-qty="${esc(i.id)}" aria-label="How many to order" title="${packOf(i) > 1 ? `Case of ${packOf(i)}` : ""}" autocomplete="off" data-lpignore="true" data-jtnofill="1" ${i.oid && i.ost !== "draft" ? "disabled title='Already ordered'" : ""}>${packOf(i) > 1 ? `<div class="dim small">case of ${n0(packOf(i))}${i.qty != null && i.qty % packOf(i) ? ' · <span class="warnt">not full cases</span>' : ""}</div>` : ""}</td>
            <td>${m2(i.cost)}</td>
            <td class="l small">${esc(when(i.at))}${i.by ? ` · ${esc(who(i.by))}` : ""}</td>
            <td class="l">${po}</td>
            ${noteCell(i.vid)}<td class="oos-act"><span class="oos-btns">${!i.oid && S.hasRecount ? `<button class="btn sm" type="button" data-oos-tocount="${esc(i.vid)}" ${S.busy ? "disabled" : ""} title="Take it off To order and back on the list above to be counted">${S.busy === "c:" + i.vid ? "…" : "To count"}</button>` : ""}<button class="btn sm" type="button" data-oos-an="${esc(i.id)}" title="Sales, days on hand and PAR level">Analyze</button>${!i.oid ? `<button class="btn sm" type="button" data-oos-topo="${esc(i.id)}" ${S.busy ? "disabled" : ""}>${S.busy === "i:" + i.id ? "Adding…" : "Put on draft PO"}</button>` : ""}${!i.oid || i.ost === "draft" ? `<button class="btn sm" type="button" data-oos-unlist="${esc(i.id)}" ${S.busy ? "disabled" : ""} title="Take it off the To order list${i.oid ? " and the draft PO" : ""}">Remove</button>` : ""}</span></td></tr>`; }).join("")}</tbody></table></div></div>`;
    }).join("");
  }

  async function saveCount(vid) {
    const i = $("oos-n"), v = i ? i.value.trim() : "";
    if (!/^\d+$/.test(v)) { note(`<span class="neg">Enter a whole number, 0 or more.</span>`); if (i) i.focus(); return; }
    const n = Number(v), r = S.rows.find(x => x.vid === vid);
    S.busy = vid; render();
    try {
      await call("jt_stock_count", "jt.stock_count", { variant_id: Number(vid), counted: n });
      S.open = null; S.busy = null;
      note(n > 0 ? `Counted <b>${n0(n)}</b> of ${esc(r ? r.title : "it")}: sending to Shopify. It leaves this list once Shopify has it.` : `Counted <b>0</b> of ${esc(r ? r.title : "it")}: it stays on the list with this count.`);
      await load(true);
      if (n > 0) setTimeout(() => load(true), 90000);     // the sync job usually applies it within a minute or two
    } catch (e) { S.busy = null; render(); note(`<span class="neg">Couldn't save the count: ${esc(msg(e))}</span>`); }
  }
  async function reorder(vid) {
    const r = S.rows.find(x => x.vid === vid);
    S.busy = vid; render();
    try {
      await call("jt_prep_list_add", "jt.prep_list_add", { variant_id: Number(vid), dest: "shopify", amazon_sku: "", source: "oos" });
      S.open = null; S.busy = null;
      note(`<b>${esc(r ? r.title : "It")}</b>${r && r.vt ? " " + esc(r.vt) : ""} is on the To order list below. <b>Analyze</b> it there to see its sales and set a PAR level and how many to order.`);
      await load(true);
    } catch (e) { S.busy = null; render(); note(`<span class="neg">Couldn't add it: ${esc(msg(e))}</span>`); }
  }
  async function archive(vid) {
    const r = S.rows.find(x => x.vid === vid);
    S.busy = vid; render();
    try {
      await call("jt_product_archive", "jt.product_archive", { variant_id: Number(vid) });
      S.open = null; S.busy = null;
      note(`Archiving <b>${esc(r ? r.title : "it")}</b> in Shopify. It leaves this list once Shopify has it (a minute or two).`);
      await load(true);
      setTimeout(() => load(true), 90000);
    } catch (e) { S.busy = null; S.open = null; render(); note(`<span class="neg">Couldn't archive it: ${esc(msg(e))}</span>`); }
  }
  async function toPo(ids, key) {
    S.busy = key; render();
    let ord = null;
    try {
      for (const id of ids) ord = await call("jt_prep_list_to_po", "jt.prep_list_to_po", { id: Number(id) });
      S.busy = null;
      const o = typeof ord === "string" ? ord.replace(/\D/g, "") : ord;
      note(`On the draft PO${ids.length > 1 ? ` (${ids.length} products)` : ""}. <a class="olink" href="#po/${esc(o)}">Open the PO</a> to set quantities and costs and order it.`);
      await load(true);
    } catch (e) { S.busy = null; render(); note(`<span class="neg">Couldn't put it on a PO: ${esc(msg(e))}</span>`); await load(true); }
  }
  async function unlist(id) {
    S.busy = "i:" + id; render();
    try { await call("jt_prep_list_remove", "jt.prep_list_remove", { id: Number(id) }); S.busy = null; await load(true); }
    catch (e) { S.busy = null; render(); note(`<span class="neg">Couldn't remove it: ${esc(msg(e))}</span>`); }
  }
  async function setQty(id, v) {
    const it = (S.list || []).find(x => x.id === id); if (!it) return;
    if (v !== "" && !/^\d+$/.test(v)) { note(`<span class="neg">The quantity is a whole number.</span>`); return; }
    try { await call("jt_prep_list_add", "jt.prep_list_add", { variant_id: Number(it.vid), dest: "shopify", amazon_sku: "", qty: v }); it.qty = v === "" ? null : Number(v); }
    catch (e) { note(`<span class="neg">Couldn't save the quantity: ${esc(msg(e))}</span>`); }
  }
  // ---------- Analyze: sales, days on hand, PAR (migration 201) ----------
  // case packs (migration 202): a product's own, else its vendor's; Order to PAR rounds to it, up or down
  const packOf = (i) => i.ownPack || i.venPack || 1;
  const roundTo = (q, pack, how) => pack > 1 && how !== "none" ? (how === "down" ? Math.floor(q / pack) : Math.ceil(q / pack)) * pack : q;
  const toPar = (i) => i.par == null ? null : roundTo(Math.max(0, i.par - Math.max(0, i.now) - i.onOrder), packOf(i), i.round);
  const BASIS = [["30", "Last 30 days"], ["90", "Last 90 days"], ["365", "Last 12 months"], ["ly", "Same 90 days last year"]];
  async function analyze(id) {
    const it = (S.list || []).find(x => x.id === id); if (!it) return;
    S.an = { id, it, loading: true, basis: "90", days: it.days || 90, par: it.par == null ? "" : String(it.par), parTouched: it.par != null,
      pack: String(packOf(it) > 1 ? packOf(it) : ""), round: it.round || "up" };
    openModal(); renderAn();
    try {
      const v = window.JT.int(it.vid);
      const [m, t] = await Promise.all([
        window.JT.rows(["to_char(mo, 'YYYY-MM')", "coalesce(sum(u), 0)::text", "coalesce(sum(f), 0)::text"],
          `from (select date_trunc('month', day)::date mo, units u, 0 f from jt.shopify_sales where variant_id = ${v} and day >= (date_trunc('month', current_date) - interval '12 months')::date
                 union all select date_trunc('month', decided_at)::date, 0, units from jt.fbm_decisions where variant_id = ${v} and decision = 'decrement' and status = 'done'
                   and decided_at >= date_trunc('month', current_date) - interval '12 months') x group by mo order by mo`, true),
        window.JT.rows(["coalesce(sum(units) filter (where day > current_date - 30), 0)::text", "coalesce(sum(units) filter (where day > current_date - 90), 0)::text",
          "coalesce(sum(units) filter (where day > current_date - 365), 0)::text", "coalesce(sum(units) filter (where day > current_date - 365 and day <= current_date - 275), 0)::text",
          "max(day)::text", "min(day)::text",
          `(select coalesce(sum(units) filter (where decided_at > now() - interval '30 days'), 0) || ',' || coalesce(sum(units) filter (where decided_at > now() - interval '90 days'), 0) || ',' || coalesce(sum(units) filter (where decided_at > now() - interval '365 days'), 0) || ',' || coalesce(sum(units) filter (where decided_at > now() - interval '365 days' and decided_at <= now() - interval '275 days'), 0)
             from jt.fbm_decisions where variant_id = ${v} and decision = 'decrement' and status = 'done')`],
          `from jt.shopify_sales where variant_id = ${v}`, true),
      ]);
      const f = String((t[0] || [])[6] || "0,0,0,0").split(",").map(Number), x = t[0] || [];
      S.an.months = m.map(r => ({ mo: r[0], shop: +r[1] || 0, fbm: +r[2] || 0 }));
      S.an.sold = { "30": (+x[0] || 0) + f[0], "90": (+x[1] || 0) + f[1], "365": (+x[2] || 0) + f[2], ly: (+x[3] || 0) + f[3] };
      S.an.fbm = { "30": f[0], "90": f[1], "365": f[2], ly: f[3] };
      S.an.last = x[4] || ""; S.an.first = x[5] || "";
      // a product with no sales in the last 90 days but some in the year: start from the year
      if (!S.an.sold["90"] && S.an.sold["365"]) S.an.basis = "365";
    } catch (e) { S.an.err = e; }
    S.an.loading = false; renderAn();
  }
  function anCalc(a) {
    const per = { "30": 30, "90": 90, "365": 365, ly: 90 }[a.basis], units = (a.sold || {})[a.basis] || 0, rate = units / per;
    const days = Math.max(1, Number(a.days) || 90), sug = Math.ceil(rate * days);
    const par = a.par === "" ? sug : Number(a.par), it = a.it, have = Math.max(0, it.now) + it.onOrder;   // blank PAR = the suggested one
    const raw = par == null || isNaN(par) ? null : Math.max(0, par - have), pack = Math.max(1, Math.floor(Number(a.pack) || 1));
    const up = raw == null ? null : roundTo(raw, pack, "up"), down = raw == null ? null : roundTo(raw, pack, "down");
    const order = raw == null ? null : pack > 1 && a.round !== "none" ? (a.round === "down" ? down : up) : raw;
    return { rate, units, days, sug, par, have, raw, pack, up, down, order, cover: rate > 0 ? have / rate : null };
  }
  function openModal() {
    let d = $("oos-an"); if (!d) {
      d = document.createElement("div"); d.className = "modal"; d.id = "oos-an"; d.hidden = true;
      d.innerHTML = '<div class="modal-card oos-an-card" id="oos-an-card" role="dialog" aria-modal="true" aria-label="Analyze"></div>';
      document.body.appendChild(d);
      d.addEventListener("click", (e) => { if (e.target === d) return closeModal(); const b = e.target.closest("button"); if (b) anClick(b); });
      d.addEventListener("input", (e) => anInput(e.target));
      d.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); closeModal(); } });
    }
    d.hidden = false; document.body.classList.add("modal-open");
  }
  function closeModal() { const d = $("oos-an"); if (d) d.hidden = true; document.body.classList.remove("modal-open"); S.an = null; }
  function renderAn() {
    const a = S.an, card = $("oos-an-card"); if (!a || !card) return;
    const it = a.it, c = anCalc(a);
    const head = `<div class="oos-an-head"><div><span class="eyebrow">${esc(it.vendor)} · Analyze</span><h2>${esc(it.title)}</h2>${it.vt ? `<div class="small">${esc(it.vt)}</div>` : ""}<div class="dim small mono">${esc(it.sku || "no SKU")}</div></div>
      <button class="btn" type="button" data-an="close" title="Close (Esc)">Close</button></div>`;
    if (a.loading) { card.innerHTML = head + `<div class="muted small" style="padding:16px">Loading sales…</div>`; return; }
    if (a.err) { card.innerHTML = head + `<div class="neg small" style="padding:16px">Couldn't load the sales: ${esc(msg(a.err))}</div>`; return; }
    const k = (l, v, sub) => `<div class="kpi"><span class="eyebrow">${l}</span><span class="v">${v}</span><span class="s">${esc(sub || "")}</span></div>`;
    const sd = (b) => `${n0(a.sold[b])}${a.fbm[b] ? "" : ""}`;
    const kpis = [
      k("On hand", n0(it.now), "Shopify available now"),
      k("On order", n0(it.onOrder), "placed POs, not received"),
      k("Sold 30 days", sd("30"), a.fbm["30"] ? `incl. ${n0(a.fbm["30"])} Amazon FBM` : ""),
      k("Sold 90 days", sd("90"), a.fbm["90"] ? `incl. ${n0(a.fbm["90"])} Amazon FBM` : ""),
      k("Sold 12 months", sd("365"), a.fbm["365"] ? `incl. ${n0(a.fbm["365"])} Amazon FBM` : ""),
      k("Next 90 days, last year", sd("ly"), "what sold this season a year ago"),
    ].join("");
    // the last 13 months, Shopify + FBM
    const months = []; { const d0 = new Date(); for (let i = 12; i >= 0; i--) { const d = new Date(d0.getFullYear(), d0.getMonth() - i, 1); months.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0")); } }
    const by = new Map((a.months || []).map(x => [x.mo, x])), max = Math.max(1, ...months.map(mo => { const x = by.get(mo); return x ? x.shop + x.fbm : 0; }));
    const bars = months.map(mo => { const x = by.get(mo) || { shop: 0, fbm: 0 }, tot = x.shop + x.fbm, lab = new Date(mo + "-15").toLocaleDateString("en-US", { month: "short" });
      return `<div class="oos-bar" title="${esc(lab)} ${mo.slice(0, 4)}: ${n0(tot)} sold${x.fbm ? ` (${n0(x.fbm)} Amazon FBM)` : ""}"><span class="oos-bv">${tot ? n0(tot) : ""}</span><span class="oos-bf" style="height:${Math.round(tot / max * 100)}%"><span class="oos-bfbm" style="height:${tot ? Math.round(x.fbm / tot * 100) : 0}%"></span></span><span class="oos-bl">${esc(lab)}</span></div>`; }).join("");
    const seg = BASIS.map(([b, n]) => `<button type="button" data-an-basis="${b}" aria-pressed="${a.basis === b}">${n}</button>`).join("");
    const saved = it.par != null;
    card.innerHTML = head + `
      <section class="kpis oos-an-kpis">${kpis}</section>
      <div class="oos-an-chart"><div class="row small"><b>Units sold by month</b><span class="muted">Shopify${(a.months || []).some(x => x.fbm) ? ' · <span class="oos-key"></span> Amazon FBM (from store stock)' : ""}${a.last ? ` · last sold ${esc(day(a.last))}` : " · never sold"}</span></div><div class="oos-bars">${bars}</div></div>
      <div class="oos-an-plan">
        <div class="row small"><b>Sales rate from</b><span class="seg sm" role="group" aria-label="Sales rate from">${seg}</span></div>
        <div class="oos-an-grid">
          <div><span class="eyebrow">Sales rate</span><div class="v">${c.rate >= 1 ? c.rate.toFixed(1) : c.rate.toFixed(2)}<span class="small muted"> / day</span></div><div class="small muted">${n0(c.rate * 30)} a month · ${n0(c.units)} in ${a.basis === "ly" ? "those 90 days" : BASIS.find(x => x[0] === a.basis)[1].toLowerCase()}</div></div>
          <label class="stack"><span class="eyebrow">Target days on hand</span><input class="inp" id="an-days" type="number" min="1" max="730" step="1" value="${esc(a.days)}" autocomplete="off" data-lpignore="true" data-jtnofill="1"><span class="small muted">${[30, 60, 90, 120].map(n => `<button type="button" class="linkbtn small" data-an-days="${n}">${n}</button>`).join(" · ")}</span></label>
          <div><span class="eyebrow">Suggested PAR</span><div class="v">${n0(c.sug)}</div><div class="small muted">${n0(c.days)} days × the sales rate ${c.par !== c.sug ? `<button type="button" class="linkbtn small" data-an="usesug">use it</button>` : ""}</div></div>
          <label class="stack"><span class="eyebrow">PAR level${saved ? ` <span class="pill ok">saved ${n0(it.par)}</span>` : ""}</span><input class="inp" id="an-par" type="number" min="0" step="1" value="${esc(a.par)}" placeholder="${n0(c.sug)}" autocomplete="off" data-lpignore="true" data-jtnofill="1"><span class="small muted">the stock to hold in the store</span></label>
        </div>
        <div class="row oos-an-pack small"><label class="inline">Case pack <input class="inp sm" id="an-pack" type="number" min="1" step="1" value="${esc(a.pack)}" placeholder="none" style="width:72px" autocomplete="off" data-lpignore="true" data-jtnofill="1"></label>
          <span class="muted">${it.ownPack ? `this product: ${n0(it.ownPack)}` : it.venPack ? `${esc(it.vendor)} default: ${n0(it.venPack)}` : "none set"}</span>
          ${String(a.pack) !== String(packOf(it) > 1 ? packOf(it) : "") ? `<span class="dbtns"><button class="mini" type="button" data-an="pack-v" ${S.busy ? "disabled" : ""} title="Every ${esc(it.vendor)} product without its own pack">Save for all ${esc(it.vendor || "this vendor")}</button><button class="mini" type="button" data-an="pack-p" ${S.busy ? "disabled" : ""}>Save for this product</button></span>` : ""}
          ${it.ownPack ? `<button class="linkbtn small" type="button" data-an="pack-clear" title="Use the vendor's pack${it.venPack ? ` (${n0(it.venPack)})` : ""} instead">use the vendor's</button>` : ""}
          ${c.pack > 1 && c.raw != null ? `<span class="seg sm" role="group" aria-label="Round to the case pack"><button type="button" data-an-round="down" aria-pressed="${a.round === "down"}">Round down · ${n0(c.down)}</button><button type="button" data-an-round="up" aria-pressed="${a.round === "up"}">Round up · ${n0(c.up)}</button><button type="button" data-an-round="none" aria-pressed="${a.round === "none"}">Exact · ${n0(c.raw)}</button></span>` : ""}</div>
        <div class="oos-an-order">${c.order == null ? `<span class="muted">Enter a PAR level to order to it.</span>` : `${a.par === "" ? '<span class="pill other">suggested</span> ' : ""}Order to PAR: <b>${n0(c.par)}</b> PAR − <b>${n0(Math.max(0, it.now))}</b> on hand − <b>${n0(it.onOrder)}</b> on order = ${c.order !== c.raw ? `${n0(c.raw)}, rounded ${a.round} to ${c.pack}s: ` : ""}<b class="oos-big">${n0(c.order)}</b> to order${c.pack > 1 && c.order ? ` <span class="muted small">(${n0(c.order / c.pack)} case${c.order / c.pack === 1 ? "" : "s"})</span>` : ""}${c.cover != null ? ` <span class="muted small">· on hand + on order covers ${n0(c.cover)} days now</span>` : ""}`}</div>
        <div class="row oos-an-acts"><span class="dbtns">
          <button class="btn primary" type="button" data-an="order" ${c.order == null || S.busy ? "disabled" : ""} title="Save the PAR level and set To order to ${c.order == null ? "it" : n0(c.order)}">Order to PAR${c.order != null ? ` (${n0(c.order)})` : ""}</button>
          <button class="btn" type="button" data-an="save" ${c.par == null || isNaN(c.par) || S.busy ? "disabled" : ""}>${saved ? "Update PAR" : "Save PAR"}</button>
          ${saved ? `<button class="btn" type="button" data-an="clear" ${S.busy ? "disabled" : ""} title="Take the PAR level off this product">Clear PAR</button>` : ""}</span>
          <span class="muted small right">To order now: <b>${it.qty == null ? "not set" : n0(it.qty)}</b></span></div>
        ${a.msg ? `<div class="note ${a.bad ? "bad" : "info"} small">${a.msg}</div>` : ""}
      </div>`;
  }
  function anInput(t) {
    const a = S.an; if (!a) return;
    if (t.id === "an-days") { a.days = t.value; if (!a.parTouched) a.par = ""; }
    else if (t.id === "an-par") { a.par = t.value.trim(); a.parTouched = true; }
    else if (t.id === "an-pack") { a.pack = t.value.trim(); }
    else return;
    const pos = t.selectionStart, id = t.id; renderAn(); const i = $(id); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (_) {} }
  }
  async function anSave(order) {
    const a = S.an, c = anCalc(a), it = a.it;
    if (order === "clear") { S.busy = "an"; renderAn();
      try { await call("jt_par_set", "jt.par_set", { variant_id: Number(it.vid), par: "" }); it.par = null; it.days = null; a.par = ""; a.parTouched = false; a.msg = "PAR cleared."; a.bad = false; }
      catch (e) { a.msg = "Couldn't clear it: " + esc(msg(e)); a.bad = true; }
      S.busy = null; renderAn(); renderList(); return; }
    if (c.par == null || isNaN(c.par) || c.par < 0 || !Number.isInteger(c.par)) { a.msg = "The PAR level is a whole number, 0 or more."; a.bad = true; renderAn(); return; }
    S.busy = "an"; renderAn();
    try {
      await call("jt_par_set", "jt.par_set", { variant_id: Number(it.vid), par: c.par, target_days: c.days, round: a.round });
      it.par = c.par; it.days = c.days; it.round = a.round;
      if (order) { await call("jt_prep_list_add", "jt.prep_list_add", { variant_id: Number(it.vid), dest: "shopify", amazon_sku: "", qty: c.order }); it.qty = c.order; }
      a.msg = order ? `PAR saved at <b>${n0(c.par)}</b>; To order set to <b>${n0(c.order)}</b>${it.oid && it.ost === "draft" ? " (the draft PO too)" : ""}.` : `PAR saved at <b>${n0(c.par)}</b> (${n0(c.days)} days).`; a.bad = false;
    } catch (e) { a.msg = "Couldn't save: " + esc(msg(e)); a.bad = true; }
    S.busy = null; renderAn(); renderList();
  }
  function anClick(b) {
    const a = S.an; if (!a) return;
    if (b.dataset.an === "close") return closeModal();
    if (b.dataset.anBasis) { a.basis = b.dataset.anBasis; if (!a.parTouched) a.par = ""; a.msg = ""; renderAn(); return; }
    if (b.dataset.anDays) { a.days = b.dataset.anDays; if (!a.parTouched) a.par = ""; renderAn(); return; }
    if (b.dataset.anRound) { a.round = b.dataset.anRound; renderAn(); return; }
    if (b.dataset.an === "pack-v" || b.dataset.an === "pack-p" || b.dataset.an === "pack-clear") return packSave(b.dataset.an);
    if (b.dataset.an === "usesug") { a.par = String(anCalc(a).sug); a.parTouched = true; renderAn(); return; }
    if (b.dataset.an === "save") return anSave(false);
    if (b.dataset.an === "order") return anSave(true);
    if (b.dataset.an === "clear") return anSave("clear");
  }
  async function packSave(kind) {
    const a = S.an, it = a.it, n = kind === "pack-clear" ? "" : a.pack;
    if (n !== "" && !(Number.isInteger(Number(n)) && Number(n) >= 1)) { a.msg = "A case pack is a whole number."; a.bad = true; renderAn(); return; }
    S.busy = "an"; renderAn();
    try {
      const vendor = kind === "pack-v";
      await call("jt_case_pack_set", "jt.case_pack_set", vendor ? { vendor: it.vendor, pack: n } : { variant_id: Number(it.vid), pack: n });
      const v = n === "" || Number(n) === 1 ? null : Number(n);
      if (vendor) for (const x of S.list || []) { if (x.vendor.toLowerCase() === it.vendor.toLowerCase()) x.venPack = v; }
      else it.ownPack = v;
      a.pack = String(packOf(it) > 1 ? packOf(it) : "");
      a.msg = vendor ? `Case pack for <b>${esc(it.vendor)}</b>: ${v ? n0(v) : "none"} (products with their own pack keep theirs).` : kind === "pack-clear" ? "This product uses the vendor's case pack again." : `Case pack for this product: ${v ? n0(v) : "none"}.`; a.bad = false;
    } catch (e) { a.msg = "Couldn't save the case pack: " + esc(msg(e)); a.bad = true; }
    S.busy = null; renderAn(); renderList();
  }
  async function orderToPar(id) {
    const it = (S.list || []).find(x => x.id === id); if (!it || it.par == null) return;
    const q = toPar(it); S.busy = "i:" + id; render();
    try { await call("jt_prep_list_add", "jt.prep_list_add", { variant_id: Number(it.vid), dest: "shopify", amazon_sku: "", qty: q }); it.qty = q; }
    catch (e) { note(`<span class="neg">Couldn't set it: ${esc(msg(e))}</span>`); }
    S.busy = null; render();
  }
  function note(h) { const n = $("oos-note"); n.innerHTML = h; n.hidden = false; }

  const tab = $("tab-oos");
  tab.addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-oos-row]");
    if (row && !e.target.closest("button, a, input, select, label, textarea") && !String(window.getSelection() || "") && window.JTItem) { window.JTItem.open(row.dataset.oosRow); return; }
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.oosHow != null) {
      if (b.dataset.oosHow === "toorder") { $("oos-list-sec").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      S.how = b.dataset.oosHow === S.how && S.how !== "all" ? "all" : b.dataset.oosHow; render(); return;
    }
    if (b.dataset.oosSort) { const k = b.dataset.oosSort; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = k === "day" || k === "count" ? -1 : 1; } render(); return; }
    if (b.dataset.oosCount) { S.open = { vid: b.dataset.oosCount, kind: "count" }; render(); return; }
    if (b.dataset.oosReorder) { reorder(b.dataset.oosReorder); return; }
    if (b.dataset.oosArchive) { S.open = { vid: b.dataset.oosArchive, kind: "archive" }; render(); return; }
    if (b.dataset.oosCancel) { S.open = null; render(); return; }
    if (b.dataset.oosSave) { saveCount(b.dataset.oosSave); return; }
    if (b.dataset.oosArchiveGo) { archive(b.dataset.oosArchiveGo); return; }
    if (b.dataset.oosTopo) { toPo([b.dataset.oosTopo], "i:" + b.dataset.oosTopo); return; }
    if (b.dataset.oosTopoV != null) { const ven = b.dataset.oosTopoV; toPo((S.list || []).filter(i => i.vendor === ven && !i.oid).map(i => i.id), "v:" + ven); return; }
    if (b.dataset.oosUnlist) { unlist(b.dataset.oosUnlist); return; }
    if (b.dataset.oosAn) { analyze(b.dataset.oosAn); return; }
    if (b.dataset.oosIgnore) { ignore(b.dataset.oosIgnore, true); return; }
    if (b.dataset.oosUnignore) { ignore(b.dataset.oosUnignore, false); return; }
    if (b.dataset.oosTocount) { toCount(b.dataset.oosTocount); return; }
    if (b.dataset.oosTopar) { orderToPar(b.dataset.oosTopar); return; }
  });
  tab.addEventListener("keydown", (e) => {
    if (e.target.dataset && e.target.dataset.oosNote) {
      if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
      else if (e.key === "Escape") { const n = S.notes && S.notes.get(e.target.dataset.oosNote); e.target.value = n ? n.note : ""; e.target.blur(); }
      return;
    }
    if (e.target.id !== "oos-n") return;
    if (e.key === "Enter") { e.preventDefault(); if (S.open && S.open.kind === "count") saveCount(S.open.vid); }
    else if (e.key === "Escape") { S.open = null; render(); }
  });
  tab.addEventListener("change", (e) => {
    if (e.target.id === "oos-vendor") { S.vendor = e.target.value; render(); }
    else if (e.target.id === "oos-cat") { S.cat = e.target.value; render(); }
    else if (e.target.dataset.oosQty) setQty(e.target.dataset.oosQty, e.target.value.trim());
    else if (e.target.dataset.oosNote) saveNote(e.target.dataset.oosNote, e.target.value);
  });
  tab.addEventListener("input", (e) => {
    if (e.target.id !== "oos-q") return;
    S.q = e.target.value; const pos = e.target.selectionStart; render();
    const i = $("oos-q"); if (i) { i.focus(); i.setSelectionRange(pos, pos); }
  });
  $("oos-refresh").addEventListener("click", () => load(true));
  window.oosShow = () => { if (!S.rows && !S.loading) load(false); else render(); };
  if ((location.hash || "") === "#oos") setTimeout(() => window.oosShow(), 0);
})();
