(() => {
  // "What changed": the product changes each catalog sync from Shopify brought in (jt.catalog_changes), in a pop-up.
  // window.JTChanges.open({ since }) shows the changes of the latest sync at or after `since` (default: the latest).
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const KINDS = [["cost", "Cost"], ["price", "Price"], ["new", "New in Shopify"], ["removed", "Removed from Shopify"], ["restored", "Back in Shopify"],
    ["status", "Status"], ["title", "Name"], ["sku", "SKU"], ["barcode", "Barcode"], ["vendor", "Vendor"], ["type", "Category"], ["stock", "Stock on hand"]];
  const KN = new Map(KINDS), MONEY = new Set(["cost", "price"]), LIMIT = 500;
  const D = { runs: [], run: "", rows: [], kind: "all", q: "", busy: false };
  const fmtRun = (t) => { const d = new Date(t); return isNaN(d) ? t : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  const money = (v) => v == null || v === "" ? "—" : "$" + Number(v).toFixed(2);
  function dlg() {
    let d = document.getElementById("chg-dlg"); if (d) return d;
    d = document.createElement("dialog"); d.id = "chg-dlg"; d.className = "dlg"; document.body.appendChild(d);
    d.addEventListener("click", (e) => {
      if (e.target === d) return d.close();                                   // click on the backdrop
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.close != null) d.close();
      if (b.dataset.kind) { D.kind = b.dataset.kind; render(); }
    });
    d.addEventListener("change", (e) => { if (e.target.id === "chg-run") { D.run = e.target.value; D.kind = "all"; loadRun(); } });
    d.addEventListener("input", (e) => { if (e.target.id === "chg-q") { D.q = e.target.value; clearTimeout(d._t); d._t = setTimeout(() => render(true), 150); } });
    return d;
  }
  function cell(r) {
    if (r.kind === "new") return '<span class="pill ok">new product</span>';
    if (r.kind === "removed") return '<span class="pill miss">no longer in Shopify</span>';
    if (r.kind === "restored") return '<span class="pill ok">back in Shopify</span>';
    const f = MONEY.has(r.kind) ? money : (v) => v == null || v === "" ? '<span class="dim">(blank)</span>' : esc(v);
    let extra = "";
    if (MONEY.has(r.kind) || r.kind === "stock") {
      const a = Number(r.old), b = Number(r.new);
      if (r.old != null && r.new != null && !isNaN(a) && !isNaN(b)) {
        const dlt = b - a, sgn = dlt > 0 ? "+" : "";
        extra = ` <span class="${dlt > 0 ? (r.kind === "cost" ? "neg" : "pos") : (r.kind === "cost" ? "pos" : "neg")} small">${MONEY.has(r.kind) ? sgn + "$" + dlt.toFixed(2) + (a ? ` (${sgn}${(dlt / a * 100).toFixed(1)}%)` : "") : sgn + dlt}</span>`;
      }
    }
    return `${f(r.old)} <span class="dim">→</span> <b>${f(r.new)}</b>${extra}`;
  }
  function render(keepFocus) {
    const d = dlg(), counts = new Map();
    for (const r of D.rows) counts.set(r.kind, (counts.get(r.kind) || 0) + 1);
    const q = D.q.trim().toLowerCase();
    const list = D.rows.filter(r => (D.kind === "all" ? r.kind !== "stock" || !counts.has("stock") || D.rows.length <= LIMIT : r.kind === D.kind)
      && (!q || [r.title, r.sku, r.vendor, r.old, r.new].join(" ").toLowerCase().includes(q)));
    const products = new Set(D.rows.map(r => r.vid)).size;
    const seg = [["all", "All", D.rows.length], ...KINDS.filter(([k]) => counts.has(k)).map(([k, n]) => [k, n, counts.get(k)])];
    const hiddenStock = D.kind === "all" && counts.has("stock") && D.rows.length > LIMIT;
    d.innerHTML = `<div class="dlg-head"><h2>What changed in Shopify</h2>
        <label class="small muted">Sync <select id="chg-run" class="inp sm">${D.runs.map(([t, n]) => `<option value="${esc(t)}" ${t === D.run ? "selected" : ""}>${esc(fmtRun(t))} · ${n} change${n === 1 ? "" : "s"}</option>`).join("") || '<option value="">no syncs recorded yet</option>'}</select></label>
        <button class="mini" data-close aria-label="Close">Close</button></div>
      <div class="dlg-body">
        ${D.busy ? '<div class="muted">Loading…</div>' : !D.rows.length ? `<div class="muted">${D.runs.length ? "Nothing changed in this sync." : "No syncs with changes recorded yet. Changes are recorded from the next sync from Shopify on."}</div>` : `
        <div class="chg-sum">${n0(D.rows.length)} change${D.rows.length === 1 ? "" : "s"} to ${n0(products)} product${products === 1 ? "" : "s"}${counts.get("cost") ? ` · <b>${counts.get("cost")} cost</b>` : ""}${counts.get("price") ? ` · <b>${counts.get("price")} price</b>` : ""}${counts.get("new") ? ` · ${counts.get("new")} new` : ""}${counts.get("removed") ? ` · ${counts.get("removed")} removed` : ""}</div>
        <div class="row"><div class="seg sm" role="group" aria-label="Show">${seg.map(([k, n, c]) => `<button data-kind="${k}" aria-pressed="${D.kind === k}">${esc(n)} <span class="cnt">${c}</span></button>`).join("")}</div>
          <input id="chg-q" class="inp sm" type="search" placeholder="Product, SKU or vendor" value="${esc(D.q)}" style="max-width:220px"></div>
        ${hiddenStock ? `<div class="small muted">Stock-on-hand changes (${counts.get("stock")}) are left out of All; pick Stock on hand to see them.</div>` : ""}
        <div class="tbl-wrap"><table class="prept chg-t"><thead><tr><th class="l">Product</th><th class="l">SKU</th><th class="l">What</th><th class="l">Before → after</th></tr></thead><tbody>
          ${list.slice(0, LIMIT).map(r => `<tr><td class="l">${esc(r.title || "variant " + r.vid)}${r.vendor ? `<div class="meta">${esc(r.vendor)}</div>` : ""}</td><td class="l mono small">${esc(r.sku)}</td><td class="l"><span class="pill ${r.kind === "cost" || r.kind === "price" ? "manual" : "pos"}">${esc(KN.get(r.kind) || r.kind)}</span></td><td class="l">${cell(r)}</td></tr>`).join("") || '<tr><td class="l muted" colspan="4">No changes match.</td></tr>'}
        </tbody></table></div>
        ${list.length > LIMIT ? `<div class="small muted">Showing the first ${LIMIT} of ${n0(list.length)}; search or pick a kind to narrow it.</div>` : ""}`}
      </div>`;
    if (keepFocus) { const i = document.getElementById("chg-q"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  }
  const n0 = (n) => Math.round(n || 0).toLocaleString();
  async function loadRun() {
    D.busy = true; D.rows = []; render();
    try {
      const r = D.run ? await JT.rows(["c.kind", "c.variant_id::text", "c.old", "c.new", "coalesce(nullif(v.display_name, ''), v.product_title)", "v.sku", "v.vendor"],
        `from jt.catalog_changes c left join jt.variants v on v.variant_id = c.variant_id where c.synced_at = ${JT.q(D.run)}::timestamptz order by c.kind, v.product_title`, true) : [];
      const order = new Map(KINDS.map(([k], i) => [k, i]));
      D.rows = r.map(([kind, vid, old, nw, title, sku, vendor]) => ({ kind, vid, old, new: nw, title: title || "", sku: sku || "", vendor: vendor || "" }))
        .sort((a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99) || a.title.localeCompare(b.title));
    } catch (e) { D.rows = []; }
    D.busy = false; render();
  }
  async function open(opts) {
    const d = dlg(); D.kind = "all"; D.q = ""; D.busy = true; render(); if (!d.open) d.showModal();
    try {
      const r = await JT.rows(["synced_at::text", "count(*)"], "from jt.catalog_changes group by synced_at order by synced_at desc limit 60", true);
      D.runs = r.map(([t, n]) => [t, +n]);
    } catch (e) { D.runs = []; }
    const since = opts && opts.since ? new Date(opts.since).getTime() : null;
    const pick = since ? D.runs.filter(([t]) => new Date(t).getTime() >= since).pop() : null;
    D.run = pick ? pick[0] : since ? "" : (D.runs[0] || [""])[0];
    if (since && !pick) { D.busy = false; D.rows = []; render(); return 0; }
    await loadRun(); return D.rows.length;
  }
  window.JTChanges = { open };
})();
