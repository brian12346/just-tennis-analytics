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
  const S = { rows: null, list: null, err: null, loading: false, how: "all", vendor: "all", q: "", open: null, busy: null, sort: "day", dir: -1 };
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

  async function load(refresh) {
    S.loading = true; S.err = null; render();
    try {
      const [r, l] = await Promise.all([
        window.JT.rows(["v.variant_id::text", "v.product_id::text", "v.product_title", "v.variant_title", "v.sku", "v.vendor", "v.product_type",
          "jt.shopify_qty_now(v.variant_id)::text", "so.day::text", "so.start_units::text", "so.sold::text",
          "c.at::text", "c.counted::text", "c.by", "m.status", "m.error", "(select max(seen_at) from jt.stockouts)::text",
          "(select coalesce(sum(greatest(jt.shopify_qty_now(o.variant_id), 0)), 0) from jt.variants o where o.product_id = v.product_id and o.variant_id <> v.variant_id and o.removed_at is null)::text",
          "(select count(*) from jt.variants o where o.product_id = v.product_id and o.removed_at is null)::text",
          "a.status", "a.error", "a.created_at::text"],
          `from (select distinct on (variant_id) variant_id, day, start_units, sold from jt.stockouts where day >= current_date - 7 order by variant_id, day desc) so
           join jt.variants v on v.variant_id = so.variant_id and v.removed_at is null and coalesce(v.status, '') <> 'ARCHIVED'
           left join lateral (select at, counted, by, move_id from jt.stock_counts k where k.variant_id = v.variant_id order by at desc limit 1) c on true
           left join jt.shopify_stock_moves m on m.id = c.move_id
           left join lateral (select status, error, created_at from jt.product_archives x where x.product_id = v.product_id order by created_at desc limit 1) a on true
           where (jt.shopify_qty_now(v.variant_id) <= 0 or m.status = 'pending')
             and coalesce(a.status, '') <> 'done'
             and not exists (select 1 from jt.prep_list i where i.variant_id = v.variant_id and i.dest = 'shopify' and i.closed_at is null)`, refresh),
        window.JT.rows(["i.id::text", "v.variant_id::text", "v.product_id::text", "v.product_title", "v.variant_title", "v.sku", "v.vendor",
          "i.qty::text", "i.added_at::text", "i.added_by", "i.order_id::text", "o.status", "o.po_no", "jt.shopify_qty_now(v.variant_id)::text", "v.unit_cost::text", "i.source"],
          `from jt.prep_list i join jt.variants v on v.variant_id = i.variant_id left join jt.prep_orders o on o.id = i.order_id
           where i.closed_at is null and i.dest = 'shopify' order by v.vendor, v.product_title, v.variant_title`, refresh),
      ]);
      S.rows = r.map(x => ({ vid: x[0], pid: x[1], title: x[2], vt: x[3] && x[3] !== "Default Title" ? x[3] : "", sku: x[4] || "", vendor: x[5] || "", type: x[6] || "",
        qty: +x[7] || 0, day: x[8], start: +x[9] || 0, sold: +x[10] || 0, how: howOf(+x[9] || 0, +x[10] || 0),
        countAt: x[11], counted: x[12] == null ? null : +x[12], countBy: x[13] || "", moveSt: x[14] || "", moveErr: x[15] || "",
        others: +x[17] || 0, nvar: +x[18] || 1, arSt: x[19] || "", arErr: x[20] || "", arAt: x[21] }));
      S.seen = r.length ? r[0][16] : null;
      S.list = l.map(x => ({ id: x[0], vid: x[1], pid: x[2], title: x[3], vt: x[4] && x[4] !== "Default Title" ? x[4] : "", sku: x[5] || "", vendor: x[6] || "",
        qty: x[7] == null ? null : +x[7], at: x[8], by: x[9] || "", oid: x[10], ost: x[11] || "", po: x[12] || "", now: +x[13] || 0, cost: x[14] == null ? null : +x[14], src: x[15] || "" }));
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

  const isOpen = (vid, kind) => S.open && S.open.vid === vid && S.open.kind === kind;
  function actCell(r) {
    const busy = S.busy === r.vid, dis = busy ? "disabled" : "";
    const sending = r.moveSt === "pending", archiving = r.arSt === "pending";
    if (isOpen(r.vid, "count")) return `<span class="oos-count"><input class="inp sm" id="oos-n" type="number" min="0" step="1" inputmode="numeric" placeholder="Count" aria-label="How many are on the shelf" autocomplete="off" data-lpignore="true" data-jtnofill="1" ${dis}><button class="btn sm primary" type="button" data-oos-save="${esc(r.vid)}" ${dis}>${busy ? "Saving…" : "Save"}</button><button class="btn sm" type="button" data-oos-cancel="1" ${dis}>Cancel</button></span>`;
    if (isOpen(r.vid, "reorder")) return `<span class="oos-count"><input class="inp sm" id="oos-rq" type="number" min="1" step="1" inputmode="numeric" placeholder="Qty" aria-label="How many to order (optional)" autocomplete="off" data-lpignore="true" data-jtnofill="1" ${dis}><button class="btn sm primary" type="button" data-oos-reorder-go="${esc(r.vid)}" ${dis}>${busy ? "Adding…" : "Add to To order"}</button><button class="btn sm" type="button" data-oos-cancel="1" ${dis}>Cancel</button></span>`;
    if (archiving) return `<span class="pill warn">Archiving in Shopify…</span>`;
    const canArch = r.others <= 0;
    return `<span class="oos-btns"><button class="btn sm" type="button" data-oos-count="${esc(r.vid)}" ${sending ? "disabled title='Waiting for Shopify to take the last count'" : ""}>Count</button>`
      + (discontinued(r.title) ? `<button class="btn sm" type="button" disabled title="TF-X1 racquets are discontinued — not reordered">Reorder</button>` : `<button class="btn sm" type="button" data-oos-reorder="${esc(r.vid)}" title="Put it on the To order list below">Reorder</button>`)
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
      k("Not counted yet", n0(all.filter(r => !r.countAt).length), "no physical count since", "notcounted"),
      k("To order", n0((S.list || []).length), (S.list || []).filter(i => !i.oid).length ? `${n0(S.list.filter(i => !i.oid).length)} not on a PO yet` : "below", "toorder"),
    ].join("");
    const vendors = [...new Set(all.map(r => r.vendor).filter(Boolean))].sort();
    $("oos-filters").innerHTML = `<label class="small">Vendor <select class="inp sm" id="oos-vendor" style="width:auto"><option value="all">All vendors</option>${vendors.map(v => `<option value="${esc(v)}" ${S.vendor === v ? "selected" : ""}>${esc(v)} (${all.filter(r => r.vendor === v).length})</option>`).join("")}</select></label>
      <input class="inp" type="search" id="oos-q" value="${esc(S.q)}" placeholder="Product, SKU or vendor" style="max-width:240px" autocomplete="off" data-lpignore="true" data-jtnofill="1">
      ${S.how !== "all" ? `<button class="linkbtn small" type="button" data-oos-how="all">Show all</button>` : ""}<span class="muted small right">${n0(L.length)} shown</span>`;
    const th = (k, n, cls) => `<th class="${cls || ""}"><button type="button" class="oos-sort" data-oos-sort="${k}">${n}${S.sort === k ? (S.dir > 0 ? " ▲" : " ▼") : ""}</button></th>`;
    const confirmRow = (r) => isOpen(r.vid, "archive") ? `<tr class="oos-confirm"><td colspan="6"><div class="note warn">Archive <b>${esc(r.title)}</b> in Shopify?${r.nvar > 1 ? ` That's the whole product (${n0(r.nvar)} variants), none of which has stock.` : ""} It comes off the store and out of Seller Sage's lists; you can un-archive it in Shopify later.
        <span class="dbtns"><button class="mini primary" type="button" data-oos-archive-go="${esc(r.vid)}" ${S.busy ? "disabled" : ""}>${S.busy === r.vid ? "Archiving…" : "Yes, archive it"}</button><button class="mini" type="button" data-oos-cancel="1">Cancel</button></span></div></td></tr>` : "";
    $("oos-body").innerHTML = L.length ? `<div class="tbl-wrap"><table class="oos-t"><thead><tr>${th("product", "Product", "l")}${th("vendor", "Vendor", "l")}${th("day", "Went to 0", "l")}<th class="l">How</th>${th("count", "Last count", "l")}<th></th></tr></thead><tbody>${L.map(r => {
      const sending = r.moveSt === "pending", failed = r.moveSt === "failed";
      const last = r.countAt ? `<b>${n0(r.counted)}</b> · ${esc(when(r.countAt))}${r.countBy ? ` · ${esc(who(r.countBy))}` : ""}${sending ? `<br><span class="pill warn">Sending to Shopify…</span>` : ""}${failed ? `<br><span class="neg small">Shopify didn't take it: ${esc(r.moveErr)}</span>` : ""}` : `<span class="dim">not counted</span>`;
      return `<tr>
        <td class="l"><a class="olink" href="${ADMIN}/products/${esc(r.pid)}/variants/${esc(r.vid)}" target="_blank" rel="noopener">${esc(r.title)}</a>${r.vt ? `<div class="small">${esc(r.vt)}</div>` : ""}<div class="dim small">${esc(r.sku || "no SKU")}</div>${r.arSt === "failed" ? `<div class="neg small">Couldn't archive: ${esc(r.arErr)}</div>` : ""}</td>
        <td class="l">${esc(r.vendor)}</td>
        <td class="l">${esc(day(r.day))}<div class="dim small">had ${n0(r.start)}</div></td>
        <td class="l"><span class="pill ${r.how === "adjust" ? "warn" : "other"}" title="${n0(r.sold)} of ${n0(r.start)} sold that day">${HOW[r.how]}</span></td>
        <td class="l">${last}</td>
        <td class="oos-act">${actCell(r)}</td></tr>${confirmRow(r)}`; }).join("")}</tbody></table></div>`
      : `<div class="muted small" style="padding:14px">${all.length ? "Nothing matches." : "Nothing out of stock waiting on a decision."}</div>`;
    renderList();
    if (S.open && S.open.kind === "count") { const i = $("oos-n"); if (i && !S.busy) i.focus(); }
    if (S.open && S.open.kind === "reorder") { const i = $("oos-rq"); if (i && !S.busy) i.focus(); }
  }

  function renderList() {
    const L = S.list || [], box = $("oos-list");
    $("oos-list-sum").textContent = L.length ? `${n0(L.length)} product${L.length === 1 ? "" : "s"} · ${n0(new Set(L.map(i => i.vendor)).size)} vendor${new Set(L.map(i => i.vendor)).size === 1 ? "" : "s"}` : "";
    if (!L.length) { box.innerHTML = `<div class="muted small" style="padding:14px">Nothing to order yet. <b>Reorder</b> on an out-of-stock product puts it here; from here it goes on the vendor's draft PO.</div>`; return; }
    const by = new Map(); for (const i of L) { if (!by.has(i.vendor)) by.set(i.vendor, []); by.get(i.vendor).push(i); }
    box.innerHTML = [...by.entries()].map(([ven, items]) => {
      const loose = items.filter(i => !i.oid), busyV = S.busy === "v:" + ven;
      return `<div class="oos-ven"><div class="row oos-vhead"><b>${esc(ven || "No vendor")}</b><span class="muted small">${n0(items.length)} product${items.length === 1 ? "" : "s"}</span>
        ${loose.length ? `<button class="btn sm right" type="button" data-oos-topo-v="${esc(ven)}" ${S.busy ? "disabled" : ""} title="Put the ${loose.length} not on a PO yet on ${esc(ven)}'s draft PO (one is started if there isn't one)">${busyV ? "Adding…" : `Put ${loose.length === items.length ? "all" : loose.length} on the draft PO`}</button>` : ""}</div>
        <div class="tbl-wrap"><table class="oos-t"><thead><tr><th class="l">Product</th><th>Qty</th><th>Cost</th><th class="l">Added</th><th class="l">PO</th><th></th></tr></thead><tbody>${items.map(i => {
          const po = i.oid ? `<a class="olink" href="#po/${esc(i.oid)}">${esc(i.po ? i.po : "PO #" + i.oid)}</a> <span class="pill ${i.ost === "draft" ? "pos" : "other"}">${esc(STAGE[i.ost] || i.ost)}</span>` : `<span class="dim">not on a PO</span>`;
          return `<tr><td class="l"><a class="olink" href="${ADMIN}/products/${esc(i.pid)}/variants/${esc(i.vid)}" target="_blank" rel="noopener">${esc(i.title)}</a>${i.vt ? `<div class="small">${esc(i.vt)}</div>` : ""}<div class="dim small">${esc(i.sku || "no SKU")}${i.now > 0 ? ` · ${n0(i.now)} in stock now` : ""}</div></td>
            <td><input class="inp sm oos-qty" type="number" min="0" step="1" inputmode="numeric" value="${i.qty == null ? "" : i.qty}" placeholder="—" data-oos-qty="${esc(i.id)}" aria-label="How many to order" autocomplete="off" data-lpignore="true" data-jtnofill="1" ${i.oid && i.ost !== "draft" ? "disabled title='Already ordered'" : ""}></td>
            <td>${m2(i.cost)}</td>
            <td class="l small">${esc(when(i.at))}${i.by ? ` · ${esc(who(i.by))}` : ""}</td>
            <td class="l">${po}</td>
            <td class="oos-act"><span class="oos-btns">${!i.oid ? `<button class="btn sm" type="button" data-oos-topo="${esc(i.id)}" ${S.busy ? "disabled" : ""}>${S.busy === "i:" + i.id ? "Adding…" : "Put on draft PO"}</button>` : ""}${!i.oid || i.ost === "draft" ? `<button class="btn sm" type="button" data-oos-unlist="${esc(i.id)}" ${S.busy ? "disabled" : ""} title="Take it off the To order list${i.oid ? " and the draft PO" : ""}">Remove</button>` : ""}</span></td></tr>`; }).join("")}</tbody></table></div></div>`;
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
    const i = $("oos-rq"), v = i ? i.value.trim() : "", r = S.rows.find(x => x.vid === vid);
    if (v && !/^\d+$/.test(v)) { note(`<span class="neg">The quantity is a whole number (or leave it blank to decide later).</span>`); return; }
    S.busy = vid; render();
    try {
      await call("jt_prep_list_add", "jt.prep_list_add", { variant_id: Number(vid), dest: "shopify", amazon_sku: "", source: "oos", ...(v ? { qty: Number(v) } : {}) });
      S.open = null; S.busy = null;
      note(`<b>${esc(r ? r.title : "It")}</b>${r && r.vt ? " " + esc(r.vt) : ""} is on the To order list below.`);
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
  function note(h) { const n = $("oos-note"); n.innerHTML = h; n.hidden = false; }

  const tab = $("tab-oos");
  tab.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.oosHow != null) {
      if (b.dataset.oosHow === "toorder") { $("oos-list-sec").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      S.how = b.dataset.oosHow === S.how && S.how !== "all" ? "all" : b.dataset.oosHow; render(); return;
    }
    if (b.dataset.oosSort) { const k = b.dataset.oosSort; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = k === "day" || k === "count" ? -1 : 1; } render(); return; }
    if (b.dataset.oosCount) { S.open = { vid: b.dataset.oosCount, kind: "count" }; render(); return; }
    if (b.dataset.oosReorder) { S.open = { vid: b.dataset.oosReorder, kind: "reorder" }; render(); return; }
    if (b.dataset.oosArchive) { S.open = { vid: b.dataset.oosArchive, kind: "archive" }; render(); return; }
    if (b.dataset.oosCancel) { S.open = null; render(); return; }
    if (b.dataset.oosSave) { saveCount(b.dataset.oosSave); return; }
    if (b.dataset.oosReorderGo) { reorder(b.dataset.oosReorderGo); return; }
    if (b.dataset.oosArchiveGo) { archive(b.dataset.oosArchiveGo); return; }
    if (b.dataset.oosTopo) { toPo([b.dataset.oosTopo], "i:" + b.dataset.oosTopo); return; }
    if (b.dataset.oosTopoV != null) { const ven = b.dataset.oosTopoV; toPo((S.list || []).filter(i => i.vendor === ven && !i.oid).map(i => i.id), "v:" + ven); return; }
    if (b.dataset.oosUnlist) { unlist(b.dataset.oosUnlist); return; }
  });
  tab.addEventListener("keydown", (e) => {
    if (e.target.id !== "oos-n" && e.target.id !== "oos-rq") return;
    if (e.key === "Enter") { e.preventDefault(); if (S.open && S.open.kind === "count") saveCount(S.open.vid); else if (S.open) reorder(S.open.vid); }
    else if (e.key === "Escape") { S.open = null; render(); }
  });
  tab.addEventListener("change", (e) => {
    if (e.target.id === "oos-vendor") { S.vendor = e.target.value; render(); }
    else if (e.target.dataset.oosQty) setQty(e.target.dataset.oosQty, e.target.value.trim());
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
