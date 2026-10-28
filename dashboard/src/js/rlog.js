(() => {
  // Orders › Receive log (Brian, Oct 29: "a receive log under orders ... grouped by each time a receive button was pressed
  // and then able to be expanded to see what was written where and we also need to handle roll backs. please also include
  // system generated updates when you fix things"). One row per press (jt.stock_events, migration 178), newest first;
  // open a row for what was written where: the Shopify store (with Shopify's answer), the prep center (count after),
  // Not for resale. Receiving can be rolled back from here.
  const JT = window.JT, $ = (id) => document.getElementById(id);
  if (!JT || !$("tab-rlog")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n0 = (x) => Math.round(Number(x) || 0).toLocaleString("en-US");
  const sgn = (x) => { const n = Math.round(Number(x) || 0); return n > 0 ? "+" + n0(n) : n < 0 ? "−" + n0(-n) : "0"; };
  const TZ = "America/Los_Angeles";
  const when = (t) => { const d = new Date(t); return isNaN(d) ? "" : d.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  const who = (s) => { s = String(s || ""); return !s ? "system" : s.includes("@") ? s.split("@")[0] : s; };
  const KIND = { receive: "Received", unreceive: "Un-received", rollback: "Rolled back", adjust: "Count", count: "Count", ship: "Shipped to Amazon", unship: "Unshipped",
    to_shopify: "Moved to Shopify", from_shopify: "Moved to prep center", seed: "Starting inventory", assign: "Earmarked", reconcile: "Seller Central", double_fix: "Fix", fix: "Fix" };
  const S = { f: "po", q: "", rows: null, open: new Set(), det: new Map(), busy: false, limit: 150, focus: null };
  const isFix = (r) => /^claude/i.test(r.by) || r.kind === "fix" || r.kind === "double_fix";

  async function load() {
    const where = S.f === "po" ? "where e.order_id is not null" : S.f === "fix" ? "where (e.by_user ilike 'claude%' or e.kind in ('fix', 'double_fix'))" : "";
    const r = await JT.rows(["e.id::text", "e.at::text", "e.by_user", "e.order_id::text", "o.vendor", "o.po_no", "e.invoice_id::text", "i.invoice_no", "e.kind", "e.note",
      "e.rollback_of::text", "e.rolled_back_by::text", "e.backfilled::text",
      "(select coalesce(sum(m.delta), 0) from jt.shopify_stock_moves m where m.event_id = e.id)",
      "(select coalesce(sum(m.qty_change), 0) from jt.prep_moves m where m.event_id = e.id)",
      "(select coalesce(sum(l.qty_change), 0) from jt.stock_event_lines l where l.event_id = e.id and l.dest = 'demo')",
      "(select count(*) from jt.stock_event_lines l where l.event_id = e.id)",
      "(select count(*) from jt.shopify_stock_moves m where m.event_id = e.id and m.status = 'pending')",
      "(select count(*) from jt.shopify_stock_moves m where m.event_id = e.id and m.status not in ('done', 'pending'))",
      "(select count(distinct x.v) from (select variant_id v from jt.shopify_stock_moves where event_id = e.id union select variant_id from jt.prep_moves where event_id = e.id union select variant_id from jt.stock_event_lines where event_id = e.id) x)"],
      `from jt.stock_events e left join jt.prep_orders o on o.id = e.order_id left join jt.invoices i on i.id = e.invoice_id ${where} order by e.at desc, e.id desc limit ${JT.int(S.limit)}`, true);
    S.rows = r.map(x => ({ id: x[0], at: x[1], by: x[2] || "", oid: x[3] || "", vendor: x[4] || "", po: x[5] || "", iid: x[6] || "", ino: x[7] || "", kind: x[8] || "", note: x[9] || "",
      of: x[10] || "", rb: x[11] || "", old: x[12] === "true", shop: +x[13] || 0, prep: +x[14] || 0, demo: +x[15] || 0, nl: +x[16] || 0, pend: +x[17] || 0, err: +x[18] || 0, np: +x[19] || 0 }));
  }
  async function loadDetail(id) {
    const e = JT.int(id);
    const r = await JT.rows(["src", "vid", "title", "sku", "asku", "chg", "after", "st", "err"],
      `from (select 'shopify' src, m.variant_id::text vid, coalesce(nullif(v.display_name, ''), v.product_title, 'variant ' || m.variant_id) title, v.sku, m.amazon_sku asku, m.delta chg,
               case when m.status = 'done' and m.shopify_before is not null then m.shopify_before + m.delta end after, m.status st, coalesce(m.error, '') err, m.id k
             from jt.shopify_stock_moves m left join jt.variants v on v.variant_id = m.variant_id where m.event_id = ${e}
           union all
           select 'prep', m.variant_id::text, coalesce(nullif(v.display_name, ''), v.product_title, 'variant ' || m.variant_id), v.sku, m.amazon_sku, m.qty_change, m.qty_after, '', '', m.id
             from jt.prep_moves m left join jt.variants v on v.variant_id = m.variant_id where m.event_id = ${e}
           union all
           select 'po:' || l.dest, l.variant_id::text, coalesce(nullif(v.display_name, ''), v.product_title, 'variant ' || l.variant_id), v.sku, l.amazon_sku, l.qty_change, null, '', '', l.id
             from jt.stock_event_lines l left join jt.variants v on v.variant_id = l.variant_id where l.event_id = ${e}
               and (l.dest = 'demo'
                 or (l.dest = 'shopify' and not exists (select 1 from jt.shopify_stock_moves m where m.event_id = l.event_id and m.variant_id = l.variant_id))
                 or (l.dest = 'prep' and not exists (select 1 from jt.prep_moves m where m.event_id = l.event_id and m.variant_id = l.variant_id)))
          ) t order by title, src`, true);
    return r.map(x => ({ src: x[0], vid: x[1], title: x[2] || "", sku: x[3] || "", asku: x[4] || "", chg: +x[5] || 0, after: x[6] == null ? null : +x[6], st: x[7] || "", err: x[8] || "" }));
  }

  const label = (r) => r.kind === "rollback" ? `Rolled back <button class="linkbtn small" data-rl-go="${esc(r.of)}">#${esc(r.of)}</button>` : esc(KIND[r.kind] || r.kind || "Change");
  const where = (d) => d.src === "shopify" ? "Shopify store" : d.src === "prep" ? `Prep center${d.asku ? ` · <span class="mono">${esc(d.asku)}</span>` : ""}`
    : d.src === "po:demo" ? "Not for resale <span class=\"dim\">(no stock)</span>" : d.src === "po:shopify" ? "Shopify store <span class=\"dim\">(PO only, received in Shopify)</span>" : `Prep center <span class="dim">(PO only)</span>`;
  const shopSt = (d) => d.src !== "shopify" ? "" : d.st === "done" ? '<span class="pill ok">written to Shopify</span>' : d.st === "pending" ? '<span class="pill warn" title="The Shopify sync applies it within minutes">waiting for Shopify</span>'
    : `<span class="pill miss" title="${esc(d.err)}">Shopify: ${esc(d.st || "failed")}</span>`;
  function detailHtml(r) {
    const d = S.det.get(r.id);
    if (!d) return '<div class="muted small rl-det">Loading…</div>';
    if (d.err) return `<div class="neg small rl-det">${esc(d.err)}</div>`;
    if (!d.rows.length) return '<div class="muted small rl-det">Nothing was written for this entry.</div>';
    return `<div class="rl-det"><table class="prept rl-dt"><thead><tr><th class="l">Product</th><th class="l">Where</th><th>Change</th><th>After</th><th class="l">Shopify</th></tr></thead><tbody>${d.rows.map(x =>
      `<tr><td class="l"><button class="linkbtn" data-rl-prod="${esc(x.vid)}" title="Open the product (inventory log)">${esc(x.title)}</button> <span class="mono dim small">${esc(x.sku)}</span></td>
        <td class="l small">${where(x)}</td><td class="${x.chg < 0 ? "neg" : "pos"} num">${sgn(x.chg)}</td><td class="num">${x.after == null ? '<span class="dim">—</span>' : n0(x.after)}</td>
        <td class="l small">${shopSt(x)}${x.err && x.st !== "done" ? `<div class="meta neg">${esc(x.err.slice(0, 160))}</div>` : ""}</td></tr>`).join("")}</tbody></table>
      ${r.old ? '<div class="meta">From before the log (grouped by PO, person and minute); lines with no stock change weren\'t kept then.</div>' : ""}</div>`;
  }
  function render() {
    if ($("tab-rlog").hidden) return;
    $("rl-seg").innerHTML = [["po", "PO receiving"], ["all", "All inventory changes"], ["fix", "System fixes"]]
      .map(([k, n]) => `<button data-rl-f="${k}" aria-pressed="${S.f === k}">${n}</button>`).join("");
    const t = $("rl-table");
    if (!S.rows) { t.innerHTML = '<tbody><tr><td class="l muted">Loading…</td></tr></tbody>'; return; }
    const q = S.q.trim().toLowerCase();
    const rows = S.rows.filter(r => !q || [r.vendor, r.po, r.ino, r.by, KIND[r.kind] || r.kind, r.note, "#" + r.id].join(" ").toLowerCase().includes(q));
    $("rl-status").textContent = `${n0(rows.length)} entr${rows.length === 1 ? "y" : "ies"}${S.rows.length >= S.limit ? ` (latest ${n0(S.limit)})` : ""}`;
    t.innerHTML = `<thead><tr><th></th><th class="l">When</th><th class="l">What</th><th class="l">Purchase order</th><th class="l">Invoice</th><th>→ Shopify</th><th>→ Prep center</th><th>Not for resale</th><th class="l">Shopify</th><th class="l">By</th><th></th></tr></thead><tbody>${
      rows.map(r => {
        const o = S.open.has(r.id), canRb = r.nl > 0 && !r.rb && r.kind !== "rollback";
        const st = r.err ? `<span class="pill miss">${r.err} failed</span>` : r.pend ? `<span class="pill warn">${r.pend} waiting</span>` : r.shop ? '<span class="pill ok">written</span>' : '<span class="dim">—</span>';
        return `<tr class="po-row rl-row ${o ? "on" : ""} ${r.rb ? "dimrow" : ""} ${S.focus === r.id ? "rl-focus" : ""}" data-rl-open="${esc(r.id)}" tabindex="0">
          <td class="rl-car" aria-hidden="true">${o ? "▾" : "▸"}</td>
          <td class="l small"><span class="nowrap">${esc(when(r.at))}</span><div class="meta">#${esc(r.id)}</div></td>
          <td class="l">${label(r)}${isFix(r) ? ' <span class="pill other">fix</span>' : ""}${r.rb ? ` <span class="pill pos" title="Undone by #${esc(r.rb)}">rolled back · <button class="linkbtn small" data-rl-go="${esc(r.rb)}">#${esc(r.rb)}</button></span>` : ""}${r.note ? `<div class="meta">${esc(r.note)}</div>` : ""}<div class="meta">${n0(r.np)} product${r.np === 1 ? "" : "s"}</div></td>
          <td class="l">${r.oid ? `<button class="linkbtn" data-rl-po="${esc(r.oid)}">${esc(r.vendor)} ${esc(r.po || "#" + r.oid)}</button>` : '<span class="dim">—</span>'}</td>
          <td class="l small">${r.iid ? `<button class="linkbtn small" data-rl-inv="${esc(r.iid)}">${esc(r.ino || "#" + r.iid)}</button>` : r.oid && r.kind === "receive" ? '<span class="dim">no invoice</span>' : '<span class="dim">—</span>'}</td>
          <td class="num ${r.shop < 0 ? "neg" : ""}">${r.shop ? sgn(r.shop) : '<span class="dim">—</span>'}</td>
          <td class="num ${r.prep < 0 ? "neg" : ""}">${r.prep ? sgn(r.prep) : '<span class="dim">—</span>'}</td>
          <td class="num">${r.demo ? sgn(r.demo) : '<span class="dim">—</span>'}</td>
          <td class="l small">${st}</td>
          <td class="l small">${esc(who(r.by))}</td>
          <td>${canRb ? `<button class="mini" data-rl-rb="${esc(r.id)}" title="Undo this: what it received comes back off the PO, Shopify and the prep center">Roll back</button>` : ""}</td></tr>
          ${o ? `<tr class="rl-detrow"><td></td><td colspan="10">${detailHtml(r)}</td></tr>` : ""}`;
      }).join("") || `<tr><td class="l muted" colspan="11">${S.q ? "Nothing matches." : "Nothing logged yet."}</td></tr>`}</tbody>`;
    const n = $("rl-more"); if (n) n.hidden = S.rows.length < S.limit;
  }
  async function refresh() {
    S.busy = true; render();
    try { await load(); } catch (e) { $("rl-status").textContent = "Couldn't load the log: " + JT.message(e); }
    S.busy = false; render();
  }
  async function toggle(id) {
    if (S.open.has(id)) { S.open.delete(id); render(); return; }
    S.open.add(id); render();
    if (!S.det.has(id)) { try { S.det.set(id, { rows: await loadDetail(id) }); } catch (e) { S.det.set(id, { rows: [], err: JT.message(e) }); } render(); }
  }
  async function rollback(id) {
    const r = (S.rows || []).find(x => x.id === id); if (!r) return;
    const box = $("rl-note");
    if (box.dataset.ask !== id) {
      box.dataset.ask = id; box.hidden = false; box.className = "note warn";
      box.innerHTML = `Roll back <b>#${esc(id)}</b> (${esc(KIND[r.kind] || r.kind)}${r.oid ? ` on ${esc(r.vendor)} ${esc(r.po)}` : ""})? ${r.kind === "unreceive" ? "What it un-received is received again" : "What it received comes back off the PO"}: Shopify stock, the prep center and the invoice's received count. It's refused if the units already left the prep center. <span class="dbtns"><button class="mini primary" data-rl-rbgo="${esc(id)}">Roll back</button><button class="mini" data-rl-cancel>Cancel</button></span>`;
      return;
    }
  }
  async function rollbackGo(id) {
    const box = $("rl-note"); box.dataset.ask = ""; box.className = "note info"; box.textContent = "Rolling back…";
    try {
      const W = window.JTWeb || null;
      if (W) await W.write("jt_stock_event_rollback", { p: { id: Number(id) } });
      else await JT.run(`select jt.stock_event_rollback(${JT.q(JSON.stringify({ id: Number(id), by: "Claude dashboard" }))}::jsonb)::text as r`, true);
      box.className = "note info"; box.innerHTML = `Rolled back <b>#${esc(id)}</b>.`;
      S.det.clear(); await refresh();
      window.dispatchEvent(new CustomEvent("jt:changed"));
    } catch (e) { box.className = "note bad"; box.innerHTML = "Couldn't roll it back: " + esc(JT.message(e)); }
  }
  function go(id) {   // jump to an entry (from a rolled-back link or the product's log)
    S.focus = String(id);
    const have = (S.rows || []).some(r => r.id === S.focus);
    const after = () => { S.open.add(S.focus); if (!S.det.has(S.focus)) loadDetail(S.focus).then(rows => { S.det.set(S.focus, { rows }); render(); }).catch(() => {}); render();
      const el = document.querySelector(`[data-rl-open="${CSS.escape(S.focus)}"]`); if (el) el.scrollIntoView({ block: "center" }); };
    if (have) after(); else { S.f = "all"; S.limit = 2000; refresh().then(after); }
  }

  $("tab-rlog").addEventListener("click", (e) => {
    const f = e.target.closest("[data-rl-f]"); if (f) { S.f = f.dataset.rlF; S.open.clear(); refresh(); return; }
    const rb = e.target.closest("[data-rl-rb]"); if (rb) { e.stopPropagation(); rollback(rb.dataset.rlRb); return; }
    const rg = e.target.closest("[data-rl-rbgo]"); if (rg) { rollbackGo(rg.dataset.rlRbgo); return; }
    if (e.target.closest("[data-rl-cancel]")) { const b = $("rl-note"); b.hidden = true; b.dataset.ask = ""; return; }
    const g = e.target.closest("[data-rl-go]"); if (g) { e.stopPropagation(); go(g.dataset.rlGo); return; }
    const po = e.target.closest("[data-rl-po]"); if (po) { e.stopPropagation(); if (window.JTPO) window.JTPO.open(po.dataset.rlPo); return; }
    const iv = e.target.closest("[data-rl-inv]"); if (iv) { e.stopPropagation(); if (window.JTInvoices) window.JTInvoices.open(iv.dataset.rlInv); return; }
    const pr = e.target.closest("[data-rl-prod]"); if (pr) { e.stopPropagation(); if (window.JTPrepTab && window.JTPrepTab.openProduct) window.JTPrepTab.openProduct(pr.dataset.rlProd); return; }
    if (e.target.closest("#rl-more")) { S.limit += 300; refresh(); return; }
    if (e.target.closest("#rl-refresh")) { S.det.clear(); refresh(); return; }
    const row = e.target.closest("[data-rl-open]"); if (row && !e.target.closest("button, a")) toggle(row.dataset.rlOpen);
  });
  $("tab-rlog").addEventListener("keydown", (e) => { const row = e.target.closest("[data-rl-open]"); if (row && e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(row.dataset.rlOpen); } });
  $("rl-q").addEventListener("input", (e) => { S.q = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(render, 150); });
  window.rlShow = () => { if (!S.rows) refresh(); else render(); };
  window.JTStockLog = { go: (id) => { const b = document.querySelector('.tabs button[data-tab="rlog"]'); if (b && $("tab-rlog").hidden) b.click(); go(id); } };
  if ((location.hash || "") === "#rlog") setTimeout(() => window.rlShow(), 0);
})();
