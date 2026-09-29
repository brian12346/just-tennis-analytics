(() => {
  // ===================== Prep center =====================
  // The part of the physical warehouse set aside to send to Amazon (the rest is Shopify inventory). Stock is held
  // per Shopify variant, optionally earmarked for one Amazon listing. Counts are set with "Count stock"; "Ship to
  // Amazon" takes units out (FBA or AWD). Every change is logged in jt.prep_moves. window.JTPrep is shared with the
  // Inventory value tab, which adds the prep center to the totals.
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m = (n) => n == null || isNaN(n) ? "—" : usd.format(n), m0 = (n) => n == null || isNaN(n) ? "—" : usd0.format(n);
  const n0 = (x) => Math.round(x || 0).toLocaleString();
  const JT = window.JT;
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const TZ = "America/Los_Angeles";
  const when = (t) => { const d = window.JTDate.parseTime(t); return isNaN(d) ? "" : d.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };

  // ---------- data ----------
  let cache = null, loading = null;
  async function load(refresh) {
    if (loading) return loading;
    if (cache && !refresh) return cache;
    loading = (async () => {
      const [items, moves, maps, lst] = await Promise.all([
        JT.rows(["i.variant_id::text", "i.amazon_sku", "i.qty", "i.note", "i.updated_at", "v.product_id::text", "v.sku", "coalesce(nullif(v.display_name, ''), v.product_title)",
          "v.vendor", "v.product_type", "v.unit_cost", "v.price", "v.inventory_qty"],
          "from jt.prep_items i left join jt.variants v on v.variant_id = i.variant_id order by i.updated_at desc", refresh),
        JT.rows(["m.at", "m.kind", "m.variant_id::text", "m.amazon_sku", "m.qty_change", "m.qty_after", "m.shipment", "m.dest", "m.note", "m.by_user",
          "coalesce(nullif(v.display_name, ''), v.product_title)", "v.sku"],
          "from jt.prep_moves m left join jt.variants v on v.variant_id = m.variant_id order by m.at desc, m.id desc limit 200", refresh),
        JT.rowsSplit(["data->>'sku'", "(regexp_match(data->>'variantId', '(\\d+)$'))[1]", "coalesce(data->>'units', '1')", "data->>'kind'"],
          "from jt.docs where collection = 'amzmap'", "id", 4, refresh),
        // Amazon listing titles, ASINs and prices (All Listings report; FBA report price wins when there is one)
        JT.rowsSplit(["r->>0", "r->>1", "r->>2", "r->>3"], "from jt.docs d, jsonb_array_elements(d.data->'rows') r where d.collection = 'amzlistings'", "d.id", 2, refresh),
      ]);
      const listing = new Map(lst.map(([sku, asin, title, price]) => [sku, { sku, asin: asin || "", title: title || "", price: price == null ? null : +price }]));
      const fd = JT.fba && JT.fba.data;
      if (fd) for (const it of fd.items) { const l = listing.get(it.sku) || { sku: it.sku, asin: it.asin, title: it.name }; if (it.price) l.price = it.price; listing.set(it.sku, l); }
      const byVariant = new Map();    // variant id -> Amazon listings mapped to it
      for (const [sku, vid, units, kind] of maps) {
        if (kind !== "shopify" || !vid) continue;
        const l = listing.get(sku) || { sku, asin: "", title: "", price: null };
        const a = byVariant.get(vid) || []; a.push({ ...l, sku, units: +units || 1 }); byVariant.set(vid, a);
      }
      const rows = items.map(x => {
        const [vid, asku, qty, note, upd, pid, sku, title, vendor, type, cost, price, shopQty] = x;
        const listings = byVariant.get(vid) || [];
        const target = asku ? (listings.find(l => l.sku === asku) || { ...(listing.get(asku) || {}), sku: asku, units: 1 }) : null;
        // Amazon value: the earmarked listing, else the only listing mapped to this product
        const val = target || (listings.length === 1 ? listings[0] : null);
        const amzUnits = val ? qty / (val.units || 1) : null;
        return { vid, asku, qty: +qty, note: note || "", upd, pid, sku: sku || "", title: title || `(variant ${vid} not in Shopify)`, vendor: vendor || "", type: type || "",
          cost: cost == null ? null : +cost, price: price == null ? null : +price, shopQty, listings, target, val,
          amzUnits, amzPrice: val && val.price != null ? val.price : null, amzValue: val && val.price != null ? amzUnits * val.price : null };
      });
      cache = { rows, moves, byVariant, loadedAt: Date.now() };
      return cache;
    })();
    try { return await loading; } finally { loading = null; }
  }
  function totals(rows) {
    const t = { units: 0, cost: 0, retail: 0, amz: 0, skus: 0, earmarked: 0, noCost: 0, noCostUnits: 0 };
    for (const r of rows) {
      if (r.qty <= 0) continue;
      t.skus++; t.units += r.qty; if (r.asku) t.earmarked++;
      if (r.cost == null) { t.noCost++; t.noCostUnits += r.qty; } else t.cost += r.qty * r.cost;
      t.amz += r.amzValue || 0;
      t.retail += r.amzValue != null ? r.amzValue : r.qty * (r.price || 0);   // Amazon price where known, else Shopify price
    }
    return t;
  }
  window.JTPrep = { load, totals, get data() { return cache; } };

  // ---------- catalog for the product picker ----------
  let cat = null;
  async function catalog() {
    if (cat) return cat;
    const r = await JT.rowsSplit(["variant_id::text", "sku", "coalesce(nullif(display_name, ''), product_title)", "vendor", "unit_cost", "coalesce(barcode, '')", "status"],
      "from jt.variants where removed_at is null", "variant_id", 4, false);
    cat = r.map(x => ({ vid: x[0], sku: x[1] || "", title: x[2] || "", vendor: x[3] || "", cost: x[4] == null ? null : +x[4], barcode: x[5], status: x[6] || "",
      text: [x[1], x[2], x[3], x[5]].join(" ").toLowerCase() }));
    return cat;
  }
  function searchCat(q) {
    const w = q.trim().toLowerCase().split(/\s+/).filter(Boolean); if (!w.length || !cat) return [];
    return cat.filter(v => w.every(t => v.text.includes(t))).sort((a, b) => (a.status === "ACTIVE" ? 0 : 1) - (b.status === "ACTIVE" ? 0 : 1) || a.title.localeCompare(b.title)).slice(0, 12);
  }

  // ---------- tab state ----------
  const P = { shown: false, loading: false, err: null, vendor: "all", q: "", modal: null, busy: false, moveKind: "all" };
  const note = (kind, html) => { const n = $("prep-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; };
  async function refresh(force) {
    P.loading = true; P.err = null; render();
    try { if (JT.fba) await JT.fba.load(false).catch(() => {}); await load(force); } catch (e) { P.err = e; note("bad", esc(JT.message(e))); }
    finally { P.loading = false; render(); }
  }
  function visible() {
    const d = cache; if (!d) return [];
    const q = P.q.trim().toLowerCase();
    return d.rows.filter(r => r.qty > 0 && (P.vendor === "all" || r.vendor === P.vendor)
      && (!q || [r.title, r.sku, r.vendor, r.asku, r.target && r.target.title].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => b.qty * (b.cost || 0) - a.qty * (a.cost || 0) || a.title.localeCompare(b.title));
  }

  // ---------- render ----------
  const EMPTY_ICON = `<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true"><path d="M8 22 32 10l24 12v22L32 56 8 44z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><path d="M8 22l24 12 24-12M32 34v22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><path d="M20 16l24 12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="3 4"/></svg>`;
  function render() {
    if ($("tab-prep").hidden) return;
    const d = cache, st = $("prep-status");
    if (!d) { st.textContent = P.loading ? "Loading the prep center…" : ""; $("prep-kpis").innerHTML = ""; $("prep-body").innerHTML = ""; $("prep-moves").innerHTML = ""; return; }
    const all = d.rows.filter(r => r.qty > 0), rows = visible(), t = totals(rows), ta = totals(all);
    const last = d.moves[0];
    st.textContent = `${all.length.toLocaleString()} product${all.length === 1 ? "" : "s"} in the prep center${last ? " · last change " + when(last[0]) : ""}${P.loading ? " · refreshing…" : ""}`;
    $("prep-kpis").innerHTML = [
      { l: "Units in prep center", v: n0(t.units), s: `${t.skus.toLocaleString()} product${t.skus === 1 ? "" : "s"}` },
      { c: "cost", l: "Prep center at cost", v: m0(t.cost), s: t.noCost ? `${t.noCost} without a Shopify cost` : "units × Shopify cost" },
      { c: "sales", l: "Value at Amazon price", v: m0(t.amz), s: "earmarked listing, or the only listing mapped to the product" },
      { l: "Earmarked for a listing", v: `${t.earmarked} of ${t.skus}`, s: "the rest can go to any listing of the product" },
    ].map(k => `<div class="kpi ${k.c || ""}"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
    // vendor filter
    const vs = [...new Set(all.map(r => r.vendor))].sort((a, b) => a.localeCompare(b));
    $("prep-vendor").innerHTML = `<option value="all">All vendors</option>` + vs.map(v => `<option value="${esc(v)}" ${v === P.vendor ? "selected" : ""}>${esc(v || "(none)")}</option>`).join("");
    $("prep-filters").hidden = !all.length;
    $("prep-ship").disabled = !all.length;

    if (!all.length) {
      $("prep-body").innerHTML = `<div class="empty-state">
        <div class="es-icon">${EMPTY_ICON}</div>
        <h3>Nothing in the prep center yet</h3>
        <p>This is the stock in the warehouse set aside to send to Amazon — kept apart from Shopify inventory. Your starting counts will be loaded from a seed file; after that, count stock in here and record each shipment to FBA or AWD.</p>
        <div class="es-steps">
          <div><b>1 · Count stock</b><span>Pick a Shopify product, optionally the Amazon listing it's for, and enter the units on the shelf.</span></div>
          <div><b>2 · Ship to Amazon</b><span>Enter the shipment ID, FBA or AWD, and how many units of each product went out.</span></div>
          <div><b>3 · See it in the totals</b><span>The Inventory value tab shows Shopify, prep center and Amazon separately.</span></div>
        </div>
        <div class="row" style="justify-content:center"><button class="btn primary" data-act="count">Count stock</button></div>
      </div>`;
    } else {
      const dash = '<span class="dim">—</span>';
      $("prep-body").innerHTML = `<div class="tbl-wrap tall"><table class="prept"><thead><tr><th class="l">Shopify product</th><th class="l">For Amazon listing</th><th>On hand</th><th>Unit cost</th><th>Ext. cost</th><th>Amazon price</th><th>Ext. at Amazon</th><th class="l">Updated</th><th class="l"></th></tr></thead><tbody>${
        rows.map(r => {
          const tg = r.target;
          const lst = tg ? `<a class="olink" href="https://www.amazon.com/dp/${encodeURIComponent(tg.asin || "")}" target="_blank" rel="noopener">${esc(tg.title || tg.sku)}</a><div class="meta"><span class="mono">${esc(r.asku)}</span>${tg.units > 1 ? ` · ${tg.units} per Amazon unit` : ""}</div>`
            : `<span class="dim">Any listing</span><div class="meta">${r.listings.length ? `${r.listings.length} mapped listing${r.listings.length === 1 ? "" : "s"}` : "no Amazon listing mapped"}</div>`;
          return `<tr><td class="l">${r.pid ? `<a class="olink" href="${ADMIN}/products/${esc(r.pid)}/variants/${esc(r.vid)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}<div class="meta"><span class="mono">${esc(r.sku) || "no SKU"}</span> · ${esc(r.vendor)}${r.type ? " · " + esc(r.type) : ""}</div></td>
            <td class="l">${lst}</td>
            <td><b>${n0(r.qty)}</b>${r.amzUnits != null && r.val && r.val.units !== 1 ? `<div class="meta">≈ ${n0(r.amzUnits)} Amazon units</div>` : ""}</td>
            <td>${r.cost == null ? '<span class="pill miss">No cost</span>' : m(r.cost)}</td><td>${r.cost == null ? dash : m0(r.qty * r.cost)}</td>
            <td>${r.amzPrice == null ? dash : m(r.amzPrice)}</td><td>${r.amzValue == null ? dash : m0(r.amzValue)}</td>
            <td class="l small">${when(r.upd)}${r.note ? `<div class="meta">${esc(r.note)}</div>` : ""}</td>
            <td class="l"><span class="rbtns"><button class="mini" data-act="count" data-vid="${esc(r.vid)}" data-sku="${esc(r.asku)}">Count</button><button class="mini" data-act="ship" data-vid="${esc(r.vid)}" data-sku="${esc(r.asku)}">Ship</button></span></td></tr>`;
        }).join("") || `<tr><td class="l muted" colspan="9">No products match.</td></tr>`}</tbody>
        <tfoot><tr><td class="l">Total · ${rows.length.toLocaleString()} products</td><td></td><td>${n0(t.units)}</td><td></td><td>${m0(t.cost)}</td><td></td><td>${m0(t.amz)}</td><td></td><td></td></tr></tfoot></table></div>`;
    }
    renderMoves();
    renderModal();
  }
  function renderMoves() {
    const d = cache; const el = $("prep-moves");
    const list = d.moves.filter(x => P.moveKind === "all" || x[1] === P.moveKind);
    document.querySelectorAll("#prep-mkind button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.k === P.moveKind)));
    if (!d.moves.length) { el.innerHTML = `<div class="muted small" style="padding:8px 2px">No activity yet. Counts, shipments to Amazon and the starting inventory will be listed here.</div>`; return; }
    const KIND = { adjust: '<span class="pill pos">Count</span>', ship: '<span class="pill web">Shipped</span>', seed: '<span class="pill ok">Starting stock</span>' };
    el.innerHTML = `<div class="tbl-wrap tall"><table class="prepm"><thead><tr><th class="l">When</th><th class="l">What</th><th class="l">Product</th><th>Change</th><th>After</th><th class="l">Shipment</th><th class="l">By</th><th class="l">Note</th></tr></thead><tbody>${
      list.map(x => { const [at, kind, vid, asku, chg, after, shipment, dest, nt, by, title, sku] = x;
        return `<tr><td class="l small">${when(at)}</td><td class="l">${KIND[kind] || esc(kind)}</td>
          <td class="l">${esc(title || "variant " + vid)}<div class="meta"><span class="mono">${esc(sku || "")}</span>${asku ? ` · for <span class="mono">${esc(asku)}</span>` : ""}</div></td>
          <td class="${chg < 0 ? "neg" : "pos"}">${chg > 0 ? "+" : ""}${n0(chg)}</td><td>${n0(after)}</td>
          <td class="l">${shipment ? `<span class="mono">${esc(shipment)}</span>` : ""}${dest ? ` <span class="pill ${dest === "AWD" ? "manual" : "web"}">${esc(dest)}</span>` : ""}</td>
          <td class="l small">${esc(by)}</td><td class="l small">${esc(nt)}</td></tr>`; }).join("") || `<tr><td class="l muted" colspan="8">Nothing of this kind yet.</td></tr>`}</tbody></table></div>`;
  }

  // ---------- modals: count stock / ship to Amazon ----------
  function openCount(vid, sku) {
    const r = vid && cache ? cache.rows.find(x => x.vid === vid && x.asku === (sku || "")) : null;
    P.modal = { kind: "count", q: "", pick: r ? { vid: r.vid, sku: r.sku, title: r.title, vendor: r.vendor, cost: r.cost } : null, asku: r ? r.asku : "", qty: "", note: "" };
    catalog().then(() => renderModal()).catch(e => note("bad", esc(JT.message(e))));
    renderModal(); setTimeout(() => { const i = $(P.modal.pick ? "pm-qty" : "pm-q"); if (i) i.focus(); }, 0);
  }
  function openShip(vid, sku) {
    const qty = {};
    if (vid) qty[vid + "|" + (sku || "")] = "";
    P.modal = { kind: "ship", shipment: "", dest: "FBA", note: "", qty, focus: vid ? vid + "|" + (sku || "") : null, confirm: false };
    renderModal(); setTimeout(() => { const i = P.modal.focus ? document.querySelector(`#prep-modal input[data-k="${CSS.escape(P.modal.focus)}"]`) : $("pm-ship"); if (i) i.focus(); }, 0);
  }
  function closeModal() { P.modal = null; P.busy = false; renderModal(); }
  function onHand(vid, sku) { const r = cache && cache.rows.find(x => x.vid === vid && x.asku === (sku || "")); return r ? r.qty : 0; }

  function renderModal() {
    const box = $("prep-modal"), M = P.modal;
    box.hidden = !M; document.body.classList.toggle("modal-open", !!M);
    if (!M) { $("prep-mcard").innerHTML = ""; return; }
    const keep = document.activeElement && box.contains(document.activeElement) ? { id: document.activeElement.id, k: document.activeElement.dataset.k, s: document.activeElement.selectionStart } : null;
    let html = "";
    if (M.kind === "count") {
      const listings = M.pick && cache ? (cache.byVariant.get(M.pick.vid) || []) : [];
      const cur = M.pick ? onHand(M.pick.vid, M.asku) : 0;
      const want = M.qty === "" ? null : Number(M.qty);
      const bad = M.qty !== "" && (!Number.isInteger(want) || want < 0);
      const res = !M.pick ? searchCat(M.q) : [];
      html = `<div class="panel-head"><h2>Count stock</h2><button class="mini" data-act="close">Close</button></div>
        <p class="muted small" style="margin:0">Enter how many units are on the prep center shelf now. The difference from the current count is logged.</p>
        ${M.pick ? `<div class="pickbox"><b>${esc(M.pick.title)}</b> <span class="mono dim">${esc(M.pick.sku)}</span> · ${esc(M.pick.vendor)} · cost ${m(M.pick.cost)} <button class="linkbtn small" data-act="repick">change</button></div>`
          : `<label class="stack" for="pm-q">Shopify product<input id="pm-q" class="inp" value="${esc(M.q)}" placeholder="Search by product name, SKU, vendor or UPC" autocomplete="off"></label>
             <div class="mres">${!cat ? '<span class="muted small">Loading the Shopify catalog…</span>' : res.map(v => `<button data-pick="${esc(v.vid)}"><b>${esc(v.title)}</b><br><span class="dim">${esc(v.sku)} · ${esc(v.vendor)} · ${m(v.cost)}${v.status !== "ACTIVE" ? " · " + esc(v.status.toLowerCase()) : ""}</span></button>`).join("") || (M.q.trim() ? '<span class="muted small">No products match.</span>' : "")}</div>`}
        ${M.pick ? `<div class="pmgrid">
          <label class="stack" for="pm-sku">For Amazon listing<select id="pm-sku" class="inp"><option value="">Any listing (not earmarked)</option>${listings.map(l => `<option value="${esc(l.sku)}" ${l.sku === M.asku ? "selected" : ""}>${esc(l.sku)}${l.units !== 1 ? ` (×${l.units})` : ""} · ${esc((l.title || "").slice(0, 60))}</option>`).join("")}${M.asku && !listings.some(l => l.sku === M.asku) ? `<option selected>${esc(M.asku)}</option>` : ""}</select></label>
          <label class="stack">In prep center now<b class="num" style="font-size:18px;padding:6px 0">${n0(cur)}</b></label>
          <label class="stack" for="pm-qty">Counted units<input id="pm-qty" class="inp num ${bad ? "bad" : ""}" value="${esc(M.qty)}" inputmode="numeric" placeholder="0"></label>
          <label class="stack" for="pm-note" style="grid-column:1 / -1">Note (optional)<input id="pm-note" class="inp" value="${esc(M.note)}" placeholder="e.g. cycle count, received from Wilson PO 1234"></label>
        </div>
        <div class="row">${want != null && !bad ? `<span class="${want - cur < 0 ? "neg" : "pos"}">${want - cur > 0 ? "+" : ""}${n0(want - cur)} units${M.pick.cost != null ? " · " + m0((want - cur) * M.pick.cost) + " at cost" : ""}</span>` : ""}
          <span class="dbtns right"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="save-count" ${want == null || bad || want === cur || P.busy ? "disabled" : ""}>${P.busy ? "Saving…" : "Save count"}</button></span></div>` : ""}`;
    } else {
      const rows = (cache ? cache.rows : []).filter(r => r.qty > 0);
      let units = 0, cost = 0, lines = 0, over = 0;
      for (const r of rows) { const v = M.qty[r.vid + "|" + r.asku]; const q = v === undefined || v === "" ? 0 : Number(v); if (q > 0) { lines++; units += q; cost += q * (r.cost || 0); if (q > r.qty || !Number.isInteger(q)) over++; } }
      html = `<div class="panel-head"><h2>Ship to Amazon</h2><button class="mini" data-act="close">Close</button></div>
        <div class="pmgrid">
          <label class="stack" for="pm-ship">Shipment ID or name<input id="pm-ship" class="inp mono" value="${esc(M.shipment)}" placeholder="e.g. FBA18ABC1234"></label>
          <label class="stack">Destination<span class="seg" id="pm-dest"><button data-dest="FBA" aria-pressed="${M.dest === "FBA"}">FBA</button><button data-dest="AWD" aria-pressed="${M.dest === "AWD"}">AWD</button></span></label>
          <label class="stack" for="pm-snote" style="grid-column:span 2">Note (optional)<input id="pm-snote" class="inp" value="${esc(M.note)}"></label>
        </div>
        <div class="tbl-wrap tall"><table class="prept"><thead><tr><th class="l">Shopify product</th><th class="l">For listing</th><th>On hand</th><th>Ship</th><th></th></tr></thead><tbody>${
          rows.map(r => { const k = r.vid + "|" + r.asku, v = M.qty[k] ?? "", q = v === "" ? 0 : Number(v), bad = v !== "" && (!Number.isInteger(q) || q < 0 || q > r.qty);
            return `<tr class="${q > 0 ? "picked" : ""}"><td class="l">${esc(r.title)}<div class="meta"><span class="mono">${esc(r.sku)}</span> · ${esc(r.vendor)}</div></td>
              <td class="l small">${r.asku ? `<span class="mono">${esc(r.asku)}</span>` : '<span class="dim">Any</span>'}</td><td>${n0(r.qty)}</td>
              <td><input class="inp num sm ${bad ? "bad" : ""}" data-k="${esc(k)}" value="${esc(v)}" inputmode="numeric" placeholder="0" style="width:80px"></td>
              <td><button class="linkbtn small" data-all="${esc(k)}">all ${n0(r.qty)}</button></td></tr>`; }).join("")}</tbody></table></div>
        ${M.confirm ? `<div class="note warn">Take ${n0(units)} units (${lines} product${lines === 1 ? "" : "s"}, ${m0(cost)} at cost) out of the prep center as shipment <b>${esc(M.shipment || "(no ID)")}</b> to ${M.dest}? <span class="dbtns"><button class="mini primary" data-act="do-ship" ${P.busy ? "disabled" : ""}>${P.busy ? "Saving…" : "Yes, ship"}</button><button class="mini" data-act="no-ship">Cancel</button></span></div>` : ""}
        <div class="row"><span class="muted small">${lines ? `${n0(units)} units · ${lines} product${lines === 1 ? "" : "s"} · ${m0(cost)} at cost` : "Enter how many units of each product are in this shipment."}${over ? ' · <span class="neg">some lines are more than on hand</span>' : ""}</span>
          <span class="dbtns right"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="ship-go" ${!lines || over || P.busy ? "disabled" : ""}>Ship ${lines ? n0(units) + " units" : ""}</button></span></div>`;
    }
    $("prep-mcard").innerHTML = html;
    if (keep) { const el = keep.id ? $(keep.id) : keep.k ? box.querySelector(`input[data-k="${CSS.escape(keep.k)}"]`) : null; if (el) { el.focus(); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.s); } catch (_) {} } }
  }

  async function saveCount() {
    const M = P.modal; if (!M || !M.pick) return;
    P.busy = true; renderModal();
    try {
      await JT.prep.adjust({ lines: [{ variant_id: Number(M.pick.vid), amazon_sku: M.asku || "", qty: Number(M.qty), note: M.note || "" }] });
      closeModal(); note("info", `Saved the count for ${esc(M.pick.title)}.`); await load(true); render(); refreshTotals();
    } catch (e) { P.busy = false; renderModal(); note("bad", "Couldn't save: " + esc(JT.message(e))); }
  }
  async function doShip() {
    const M = P.modal; if (!M) return;
    const lines = Object.entries(M.qty).map(([k, v]) => { const [vid, sku] = k.split("|"); return { variant_id: Number(vid), amazon_sku: sku || "", qty: Number(v) || 0 }; }).filter(l => l.qty > 0);
    P.busy = true; renderModal();
    try {
      await JT.prep.ship({ shipment: M.shipment.trim(), dest: M.dest, note: M.note || "", lines });
      const u = lines.reduce((a, l) => a + l.qty, 0);
      closeModal(); note("info", `Recorded ${n0(u)} units shipped to ${M.dest}${M.shipment ? " (" + esc(M.shipment) + ")" : ""}. They'll show up in Amazon inventory as inbound once the next FBA / AWD report is uploaded.`);
      await load(true); render(); refreshTotals();
    } catch (e) { P.busy = false; M.confirm = false; renderModal(); note("bad", "Couldn't record the shipment: " + esc(JT.message(e))); }
  }
  function refreshTotals() { if (window.pcRender) window.pcRender(); }

  function bind() {
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on("prep-refresh", "click", () => refresh(true));
    on("prep-count", "click", () => openCount());
    on("prep-ship", "click", () => openShip());
    on("prep-vendor", "change", (e) => { P.vendor = e.target.value; render(); });
    on("prep-q", "input", (e) => { P.q = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(render, 200); });
    on("prep-mkind", "click", (e) => { const b = e.target.closest("button[data-k]"); if (b) { P.moveKind = b.dataset.k; renderMoves(); } });
    $("tab-prep").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]"); if (!b || b.closest("#prep-modal")) return;
      if (b.dataset.act === "count") openCount(b.dataset.vid, b.dataset.sku);
      if (b.dataset.act === "ship") openShip(b.dataset.vid, b.dataset.sku);
    });
    const box = $("prep-modal");
    box.addEventListener("mousedown", (e) => { if (e.target === box && !P.busy) closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && P.modal && !P.busy) closeModal(); });
    box.addEventListener("input", (e) => {
      const M = P.modal, t = e.target; if (!M) return;
      if (t.id === "pm-q") { M.q = t.value; clearTimeout(box._t); box._t = setTimeout(renderModal, 150); return; }
      if (t.id === "pm-qty") { M.qty = t.value.trim(); renderModal(); return; }
      if (t.id === "pm-note") { M.note = t.value; return; }
      if (t.id === "pm-ship") { M.shipment = t.value; return; }
      if (t.id === "pm-snote") { M.note = t.value; return; }
      if (t.dataset.k) { M.qty[t.dataset.k] = t.value.trim(); M.confirm = false; clearTimeout(box._t); box._t = setTimeout(renderModal, 250); }
    });
    box.addEventListener("change", (e) => { const M = P.modal; if (M && e.target.id === "pm-sku") { M.asku = e.target.value; renderModal(); } });
    box.addEventListener("keydown", (e) => {
      const M = P.modal; if (!M || e.key !== "Enter") return;
      if (e.target.id === "pm-q") { const b = box.querySelector(".mres button[data-pick]"); if (b) b.click(); }
      else if (M.kind === "count" && (e.target.id === "pm-qty" || e.target.id === "pm-note")) { const b = box.querySelector('[data-act="save-count"]'); if (b && !b.disabled) saveCount(); }
    });
    box.addEventListener("click", (e) => {
      const M = P.modal, b = e.target.closest("button"); if (!M || !b) return;
      if (b.dataset.act === "close") return closeModal();
      if (b.dataset.pick) { const v = cat.find(x => x.vid === b.dataset.pick); M.pick = { vid: v.vid, sku: v.sku, title: v.title, vendor: v.vendor, cost: v.cost }; M.asku = ""; renderModal(); setTimeout(() => { const i = $("pm-qty"); if (i) i.focus(); }, 0); return; }
      if (b.dataset.act === "repick") { M.pick = null; M.qty = ""; renderModal(); setTimeout(() => { const i = $("pm-q"); if (i) i.focus(); }, 0); return; }
      if (b.dataset.act === "save-count") return saveCount();
      if (b.dataset.dest) { M.dest = b.dataset.dest; M.confirm = false; renderModal(); return; }
      if (b.dataset.all) { M.qty[b.dataset.all] = String(onHand(...b.dataset.all.split("|"))); M.confirm = false; renderModal(); return; }
      if (b.dataset.act === "ship-go") { M.confirm = true; renderModal(); return; }
      if (b.dataset.act === "no-ship") { M.confirm = false; renderModal(); return; }
      if (b.dataset.act === "do-ship") return doShip();
    });
  }

  bind();
  window.prepShow = () => { if (!P.shown) { P.shown = true; refresh(false); } else render(); };
  window.JTPrepTab = { _state: P };
  if ((location.hash || "") === "#prep") setTimeout(() => window.prepShow(), 0);
})();
