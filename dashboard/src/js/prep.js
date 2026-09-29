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
      const SHIPWHERE = "where s.status <> 'shipped' or s.shipped_at > now() - interval '60 days'";
      const [items, moves, maps, lst, seed, ships, slines] = await Promise.all([
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
        // starting-inventory file(s): [seller SKU(s), ASIN, units] — ASINs for listings missing elsewhere, and lines that couldn't be loaded
        JT.rows(["d.id", "d.data->>'file'", "r->>0", "r->>1", "(r->>2)::int"], "from jt.docs d, jsonb_array_elements(d.data->'rows') r where d.collection = 'prepseed'", refresh),
        // shipments: in progress, and shipped in the last 60 days
        JT.rows(["s.id::text", "s.name", "s.dest", "s.status", "s.note", "s.created_at", "s.created_by", "s.started_at", "s.shipped_at", "s.shipped_by", "s.updated_at"],
          `from jt.prep_shipments s ${SHIPWHERE} order by s.updated_at desc`, refresh),
        JT.rows(["l.shipment_id::text", "l.variant_id::text", "l.amazon_sku", "l.qty", "coalesce(nullif(v.display_name, ''), v.product_title)", "v.sku", "v.unit_cost", "v.vendor"],
          `from jt.prep_shipment_lines l join jt.prep_shipments s on s.id = l.shipment_id left join jt.variants v on v.variant_id = l.variant_id ${SHIPWHERE}`, refresh),
      ]);
      const listing = new Map(lst.map(([sku, asin, title, price]) => [sku, { sku, asin: asin || "", title: title || "", price: price == null ? null : +price }]));
      for (const [, , skus, asin] of seed) for (const k of String(skus || "").split(",").map(s => s.trim()).filter(Boolean)) {
        const l = listing.get(k); if (!l) listing.set(k, { sku: k, asin: asin || "", title: "", price: null }); else if (!l.asin) l.asin = asin || "";
      }
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
      // seed lines whose seller SKU(s) have no Shopify mapping: not in the prep center until mapped and counted in
      const mapped = new Set(maps.filter(x => x[3] === "shopify" && x[1]).map(x => x[0]));
      const unloaded = seed.filter(([, , skus]) => !String(skus || "").split(",").some(k => mapped.has(k.trim())))
        .map(([id, file, skus, asin, qty]) => ({ id, file, skus, asin, qty: +qty || 0 }));
      const shipments = ships.map(x => ({ id: x[0], name: x[1] || "", dest: x[2], status: x[3], note: x[4] || "", created: x[5], createdBy: x[6] || "", started: x[7], shipped: x[8], shippedBy: x[9] || "", updated: x[10], lines: [] }));
      const byId = new Map(shipments.map(sh => [sh.id, sh]));
      for (const [sid, vid, asku, qty, title, sku, cost, vendor] of slines) {
        const sh = byId.get(sid); if (sh) sh.lines.push({ key: vid + "|" + (asku || ""), vid, asku: asku || "", qty: +qty, title: title || `variant ${vid}`, sku: sku || "", cost: cost == null ? null : +cost, vendor: vendor || "" });
      }
      const alloc = new Map();          // prep row -> units in open / started shipments
      for (const sh of shipments) if (sh.status !== "shipped") for (const l of sh.lines) alloc.set(l.key, (alloc.get(l.key) || 0) + l.qty);
      cache = { rows, moves, byVariant, unloaded, shipments, alloc, loadedAt: Date.now() };
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
  const P = { shown: false, loading: false, err: null, vendor: "all", q: "", modal: null, busy: false, moveKind: "all", shipView: "open" };
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
      (() => { const op = d.shipments.filter(x => x.status !== "shipped"); const u = op.reduce((a, x) => a + x.lines.reduce((b, l) => b + l.qty, 0), 0);
        return { l: "In open shipments", v: n0(u), s: op.length ? `units · ${op.filter(x => x.status === "open").length} open, ${op.filter(x => x.status === "started").length} started` : "no shipments in progress" }; })(),
    ].map(k => `<div class="kpi ${k.c || ""}"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
    renderShipments();
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
          const lst = tg ? `${tg.asin ? `<a class="olink" href="https://www.amazon.com/dp/${encodeURIComponent(tg.asin)}" target="_blank" rel="noopener">${esc(tg.title || tg.asin)}</a>` : esc(tg.title || "")}<div class="meta"><span class="mono">${esc(r.asku)}</span>${tg.asin ? ` · <span class="mono">${esc(tg.asin)}</span>` : ""}${tg.units > 1 ? ` · ${tg.units} per Amazon unit` : ""}</div>`
            : `<span class="dim">Any listing</span><div class="meta">${r.listings.length ? `${r.listings.length} mapped listing${r.listings.length === 1 ? "" : "s"}` : "no Amazon listing mapped"}</div>`;
          return `<tr><td class="l">${r.pid ? `<a class="olink" href="${ADMIN}/products/${esc(r.pid)}/variants/${esc(r.vid)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}<div class="meta"><span class="mono">${esc(r.sku) || "no SKU"}</span> · ${esc(r.vendor)}${r.type ? " · " + esc(r.type) : ""}</div></td>
            <td class="l">${lst}</td>
            <td><b>${n0(r.qty)}</b>${d.alloc.get(r.vid + "|" + r.asku) ? `<div class="meta ${d.alloc.get(r.vid + "|" + r.asku) > r.qty ? "neg" : ""}">${n0(d.alloc.get(r.vid + "|" + r.asku))} in shipments</div>` : ""}${r.amzUnits != null && r.val && r.val.units !== 1 ? `<div class="meta">≈ ${n0(r.amzUnits)} Amazon units</div>` : ""}</td>
            <td>${r.cost == null ? '<span class="pill miss">No cost</span>' : m(r.cost)}</td><td>${r.cost == null ? dash : m0(r.qty * r.cost)}</td>
            <td>${r.amzPrice == null ? dash : m(r.amzPrice)}</td><td>${r.amzValue == null ? dash : m0(r.amzValue)}</td>
            <td class="l small">${when(r.upd)}${r.note ? `<div class="meta">${esc(r.note)}</div>` : ""}</td>
            <td class="l"><span class="rbtns"><button class="mini" data-act="count" data-vid="${esc(r.vid)}" data-sku="${esc(r.asku)}">Count</button><button class="mini" data-act="ship" data-vid="${esc(r.vid)}" data-sku="${esc(r.asku)}">Ship</button></span></td></tr>`;
        }).join("") || `<tr><td class="l muted" colspan="9">No products match.</td></tr>`}</tbody>
        <tfoot><tr><td class="l">Total · ${rows.length.toLocaleString()} products</td><td></td><td>${n0(t.units)}</td><td></td><td>${m0(t.cost)}</td><td></td><td>${m0(t.amz)}</td><td></td><td></td></tr></tfoot></table></div>`;
    }
    const un = d.unloaded || [];
    $("prep-unloaded").hidden = !un.length;
    if (un.length) $("prep-unloaded").innerHTML = `<details class="note warn"><summary><b>${un.length} line${un.length === 1 ? "" : "s"} from the starting file weren't loaded (${n0(un.reduce((a, x) => a + x.qty, 0))} Amazon units)</b> — their Amazon SKU isn't mapped to a Shopify product yet. Map them on the Amazon matching tab, then add them here with Count stock.</summary>
      <table class="prepm" style="margin-top:8px"><thead><tr><th class="l">Amazon SKU</th><th class="l">ASIN</th><th>Units</th></tr></thead><tbody>${un.map(x => `<tr><td class="l mono">${esc(x.skus)}</td><td class="l">${x.asin ? `<a class="olink" href="https://www.amazon.com/dp/${encodeURIComponent(x.asin)}" target="_blank" rel="noopener">${esc(x.asin)}</a>` : ""}</td><td>${n0(x.qty)}</td></tr>`).join("")}</tbody></table></details>`;
    renderMoves();
    renderModal();
  }
  const STATUS = { open: ["Open", "pos"], started: ["Started", "web"], shipped: ["Shipped", "ok"] };
  const statusPill = (st) => `<span class="pill ${STATUS[st][1]}">${STATUS[st][0]}</span>`;
  const shipTitle = (sh) => sh.name || `Shipment #${sh.id}`;
  function renderShipments() {
    const d = cache, el = $("prep-ships");
    const prog = d.shipments.filter(x => x.status !== "shipped"), done = d.shipments.filter(x => x.status === "shipped");
    document.querySelectorAll("#prep-shview button").forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.v === P.shipView)); b.querySelector("span").textContent = b.dataset.v === "open" ? prog.length : done.length; });
    const list = P.shipView === "open" ? prog.sort((a, b) => (a.status === "started" ? 0 : 1) - (b.status === "started" ? 0 : 1) || String(b.updated).localeCompare(String(a.updated)))
      : done.sort((a, b) => String(b.shipped).localeCompare(String(a.shipped)));
    const card = (sh) => {
      const units = sh.lines.reduce((a, l) => a + l.qty, 0), cost = sh.lines.reduce((a, l) => a + l.qty * (l.cost || 0), 0);
      const short = sh.status !== "shipped" && sh.lines.some(l => l.qty > onHand(l.vid, l.asku));
      const next = sh.status === "open" ? `<button class="mini" data-sact="started" data-sid="${sh.id}">Start</button>`
        : sh.status === "started" ? `<button class="mini primary" data-sact="ship" data-sid="${sh.id}">Mark shipped</button>` : "";
      const when2 = sh.status === "shipped" ? `Shipped ${when(sh.shipped)}${sh.shippedBy ? " · " + esc(sh.shippedBy) : ""}` : sh.status === "started" ? `Started ${when(sh.started)}` : `Created ${when(sh.created)}${sh.createdBy ? " · " + esc(sh.createdBy) : ""}`;
      return `<div class="shipcard ${sh.status}" data-sid="${sh.id}" tabindex="0" role="button" aria-label="Open ${esc(shipTitle(sh))}">
        <div class="sc-top"><b class="mono">${esc(shipTitle(sh))}</b><span>${statusPill(sh.status)} <span class="pill ${sh.dest === "AWD" ? "manual" : "web"}">${esc(sh.dest)}</span></span></div>
        <div class="sc-mid"><span class="num"><b>${n0(units)}</b> units</span><span class="dim">${sh.lines.length} product${sh.lines.length === 1 ? "" : "s"} · ${m0(cost)}</span></div>
        <div class="sc-lines">${sh.lines.slice(0, 3).map(l => `<div>${n0(l.qty)} × ${esc(l.title)}</div>`).join("")}${sh.lines.length > 3 ? `<div class="dim">+${sh.lines.length - 3} more</div>` : ""}${!sh.lines.length ? '<div class="dim">No products yet</div>' : ""}</div>
        ${short ? '<div class="small neg">Some lines are more than on hand</div>' : ""}
        <div class="sc-foot"><span class="dim small">${when2}</span><span class="dbtns">${next}</span></div>
      </div>`;
    };
    el.innerHTML = (P.shipView === "open" ? `<button class="shipcard newcard" data-sact="new"><span class="plus">+</span><b>New shipment</b><span class="dim small">Add products by ASIN or SKU</span></button>` : "")
      + (list.map(card).join("") || (P.shipView === "open" ? "" : '<div class="muted small">No shipments shipped in the last 60 days.</div>'));
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
  // Shipment editor. From a stock row: a new shipment holding that row (or add it to one in progress).
  // From a card: that shipment. More products are added by ASIN, Amazon SKU or Shopify SKU.
  function openShip(vid, sku) {
    const key = vid ? vid + "|" + (sku || "") : null;
    P.modal = { kind: "ship", id: null, status: "open", shipment: "", dest: "FBA", note: "", lines: key ? [key] : [], qty: key ? { [key]: "" } : {}, info: {}, add: "", confirm: false, fromRow: key };
    renderModal(); setTimeout(() => { const i = key ? document.querySelector(`#prep-modal input[data-k="${CSS.escape(key)}"]`) : $("pm-ship"); if (i) i.focus(); }, 0);
  }
  function openShipment(id, extraKey) {
    const sh = cache && cache.shipments.find(x => x.id === String(id)); if (!sh) return;
    const qty = {}, info = {};
    for (const l of sh.lines) { qty[l.key] = String(l.qty); info[l.key] = l; }
    const lines = sh.lines.map(l => l.key);
    if (extraKey && !lines.includes(extraKey)) { lines.push(extraKey); qty[extraKey] = ""; }
    P.modal = { kind: "ship", id: sh.id, status: sh.status, shipment: sh.name, dest: sh.dest, note: sh.note, lines, qty, info, add: "", confirm: false, fromRow: extraKey || null, sh };
    renderModal(); setTimeout(() => { const i = extraKey ? document.querySelector(`#prep-modal input[data-k="${CSS.escape(extraKey)}"]`) : null; if (i) i.focus(); }, 0);
  }
  const keyOf = (r) => r.vid + "|" + r.asku;
  const rowOf = (k) => cache && cache.rows.find(r => keyOf(r) === k);
  // a shipment line: the prep row when it still has stock, else what the shipment saved
  const lineOf = (k) => { const r = rowOf(k); if (r) return r; const i = P.modal && P.modal.info[k]; if (!i) return null; return { vid: i.vid, asku: i.asku, qty: 0, title: i.title, sku: i.sku, vendor: i.vendor, cost: i.cost, listings: [], target: null }; };
  const asinsOf = (r) => [...new Set([r.target && r.target.asin, ...(r.asku ? [] : r.listings.map(l => l.asin))].filter(Boolean))];
  // Prep center rows matching what was typed: exact ASIN / Amazon SKU / Shopify SKU first, then partial matches.
  function findRows(text, exclude) {
    const t = String(text || "").trim().toLowerCase(); if (!t || !cache) return [];
    const rows = cache.rows.filter(r => r.qty > 0 && !exclude.includes(keyOf(r)));
    const keys = (r) => [...asinsOf(r), r.asku, r.sku].filter(Boolean).map(x => x.toLowerCase());
    const exact = rows.filter(r => keys(r).includes(t));
    if (exact.length) return exact;
    return rows.filter(r => keys(r).some(k => k.includes(t)) || r.title.toLowerCase().includes(t)).slice(0, 8);
  }
  function addLine(k) {
    const M = P.modal; if (!M || M.lines.includes(k)) return;
    M.lines.push(k); M.qty[k] = ""; M.add = ""; M.confirm = false; renderModal();
    setTimeout(() => { const i = document.querySelector(`#prep-modal input[data-k="${CSS.escape(k)}"]`); if (i) i.focus(); }, 0);
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
      const ro = M.status === "shipped";
      const rows = M.lines.map(lineOf).filter(Boolean);
      const saved = (k) => M.sh && M.sh.status !== "shipped" ? ((M.sh.lines.find(l => l.key === k) || {}).qty || 0) : 0;
      const avail = (r) => r.qty - ((cache.alloc.get(keyOf(r)) || 0) - saved(keyOf(r)));   // on hand less other shipments in progress
      let units = 0, cost = 0, lines = 0, bad = 0, over = 0, tight = 0;
      for (const r of rows) {
        const v = M.qty[keyOf(r)], q = v === undefined || v === "" ? 0 : Number(v);
        if (v !== "" && v !== undefined && (!Number.isInteger(q) || q < 0)) bad++;
        else if (q > 0) { lines++; units += q; cost += q * (r.cost || 0); if (q > r.qty) over++; else if (q > avail(r)) tight++; }
      }
      const found = ro ? [] : findRows(M.add, M.lines);
      const open = (cache.shipments || []).filter(x => x.status !== "shipped" && x.id !== M.id);
      const steps = ["open", "started", "shipped"].map(st2 => `<span class="step ${st2 === M.status ? "on" : ["open", "started", "shipped"].indexOf(st2) < ["open", "started", "shipped"].indexOf(M.status) ? "done" : ""}">${STATUS[st2][0]}</span>`).join('<span class="step-sep">→</span>');
      html = `<div class="panel-head"><h2>${M.id ? esc(M.shipment || "Shipment #" + M.id) : "New shipment"}</h2><span class="steps">${steps}</span><button class="mini" data-act="close">Close</button></div>
        ${!M.id && M.fromRow && open.length ? `<label class="small muted" for="pm-into">Add this product to <select id="pm-into" class="inp sm" style="width:auto"><option value="">a new shipment</option>${open.map(x => `<option value="${x.id}">${esc(shipTitle(x))} (${STATUS[x.status][0].toLowerCase()})</option>`).join("")}</select></label>` : ""}
        ${ro ? `<div class="note info">Shipped ${when(M.sh.shipped)}${M.sh.shippedBy ? " by " + esc(M.sh.shippedBy) : ""} to ${esc(M.dest)}. These units left the prep center.</div>` : ""}
        <div class="pmgrid">
          <label class="stack" for="pm-ship">Shipment ID or name<input id="pm-ship" class="inp mono" value="${esc(M.shipment)}" placeholder="e.g. FBA18ABC1234" ${ro ? "disabled" : ""}></label>
          <label class="stack">Going to<span class="seg" id="pm-dest"><button data-dest="FBA" aria-pressed="${M.dest === "FBA"}" ${ro ? "disabled" : ""}>FBA</button><button data-dest="AWD" aria-pressed="${M.dest === "AWD"}" ${ro ? "disabled" : ""}>AWD</button></span></label>
          <label class="stack" for="pm-snote" style="grid-column:span 2">Note (optional)<input id="pm-snote" class="inp" value="${esc(M.note)}" ${ro ? "disabled" : ""}></label>
        </div>
        ${rows.length ? `<div class="tbl-wrap"><table class="prept"><thead><tr><th class="l">Product</th><th class="l">Amazon listing</th>${ro ? "" : "<th>On hand</th>"}<th>${ro ? "Shipped" : "Ship"}</th><th></th></tr></thead><tbody>${
          rows.map(r => { const k = keyOf(r), v = M.qty[k] ?? "", q = v === "" ? 0 : Number(v), b = v !== "" && (!Number.isInteger(q) || q < 0), ov = q > r.qty, tg = !ov && q > avail(r), as = asinsOf(r);
            return `<tr><td class="l">${esc(r.title)}<div class="meta"><span class="mono">${esc(r.sku)}</span> · ${esc(r.vendor)}</div></td>
              <td class="l small">${r.asku ? `<span class="mono">${esc(r.asku)}</span>` : '<span class="dim">Any listing</span>'}${as.length ? `<div class="meta mono">${esc(as.join(", "))}</div>` : ""}</td>
              ${ro ? "" : `<td>${n0(r.qty)}${avail(r) !== r.qty ? `<div class="meta">${n0(Math.max(0, avail(r)))} not in other shipments</div>` : ""}</td>`}
              <td>${ro ? `<b>${n0(q)}</b>` : `<input class="inp num sm ${b || ov ? "bad" : tg ? "warnin" : ""}" data-k="${esc(k)}" value="${esc(v)}" inputmode="numeric" placeholder="0" style="width:80px"><div class="meta"><button class="linkbtn small" data-all="${esc(k)}">all ${n0(Math.max(0, avail(r)))}</button></div>`}</td>
              <td>${ro ? "" : `<button class="linkbtn small" data-rm="${esc(k)}" title="Remove from this shipment" aria-label="Remove ${esc(r.title)}">✕</button>`}</td></tr>`; }).join("")}</tbody></table></div>` : ""}
        ${ro ? "" : `<div class="addbox">
          <label class="stack" for="pm-add">Add product<input id="pm-add" class="inp mono" value="${esc(M.add)}" placeholder="ASIN, Amazon SKU or Shopify SKU" autocomplete="off"></label>
          ${M.add.trim() ? `<div class="mres">${found.map(r => `<button data-add="${esc(keyOf(r))}"><b>${esc(r.title)}</b><br><span class="dim">${esc(r.sku)}${r.asku ? " · " + esc(r.asku) : ""}${asinsOf(r).length ? " · " + esc(asinsOf(r).join(", ")) : ""} · ${n0(r.qty)} on hand</span></button>`).join("")
            || '<span class="muted small">Nothing in the prep center matches that ASIN or SKU.</span>'}</div>` : ""}
        </div>`}
        ${M.confirm === "ship" ? `<div class="note warn">Mark <b>${esc(M.shipment || "this shipment")}</b> shipped to ${esc(M.dest)}? ${n0(units)} units (${lines} product${lines === 1 ? "" : "s"}, ${m0(cost)} at cost) leave the prep center. This can't be undone. <span class="dbtns"><button class="mini primary" data-act="do-ship" ${P.busy ? "disabled" : ""}>${P.busy ? "Saving…" : "Yes, shipped"}</button><button class="mini" data-act="no-ship">Cancel</button></span></div>` : ""}
        ${M.confirm === "del" ? `<div class="note warn">Delete this shipment? Nothing has left the prep center, so no stock changes. <span class="dbtns"><button class="mini primary" data-act="do-del" ${P.busy ? "disabled" : ""}>Yes, delete</button><button class="mini" data-act="no-ship">Cancel</button></span></div>` : ""}
        <div class="row"><span class="muted small">${lines ? `${n0(units)} units · ${lines} product${lines === 1 ? "" : "s"} · ${m0(cost)} at cost` : ro ? "" : rows.length ? "Enter how many units of each product are going." : "Add the products in this shipment."}${over ? ' · <span class="neg">more than on hand — fix before shipping</span>' : tight ? ' · <span class="warnt">some units are also in another shipment</span>' : ""}</span>
          <span class="dbtns right">${ro ? '<button class="btn" data-act="close">Close</button>' : `
            ${M.id ? '<button class="btn" data-act="del">Delete</button>' : ""}
            <button class="btn" data-act="save" ${bad || P.busy ? "disabled" : ""}>Save</button>
            ${M.status === "open" ? `<button class="btn primary" data-act="save-start" ${!lines || bad || P.busy ? "disabled" : ""}>Save &amp; start</button>` : ""}
            ${M.status === "started" ? `<button class="btn" data-act="save-reopen" ${bad || P.busy ? "disabled" : ""}>Back to open</button><button class="btn primary" data-act="ship-go" ${!lines || bad || over || P.busy ? "disabled" : ""}>Mark shipped</button>` : ""}`}</span></div>`;
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
  // Save the editor, then optionally move the status (started / open / shipped).
  async function saveShipment(next) {
    const M = P.modal; if (!M) return;
    const lines = M.lines.map(k => { const [vid, sku] = k.split("|"); return { variant_id: Number(vid), amazon_sku: sku || "", qty: Number(M.qty[k]) || 0 }; }).filter(l => l.qty > 0);
    P.busy = true; renderModal();
    try {
      const id = await JT.prep.saveShipment({ id: M.id ? Number(M.id) : null, name: M.shipment.trim(), dest: M.dest, note: M.note || "", lines });
      if (next) await JT.prep.setShipmentStatus(id, next);
      const u = lines.reduce((a, l) => a + l.qty, 0), nm = M.shipment.trim() || "Shipment #" + id;
      closeModal();
      note("info", next === "shipped" ? `<b>${esc(nm)}</b> marked shipped to ${esc(M.dest)}: ${n0(u)} units taken out of the prep center.`
        : next === "started" ? `<b>${esc(nm)}</b> started.` : next === "open" ? `<b>${esc(nm)}</b> moved back to open.` : `<b>${esc(nm)}</b> saved.`);
      if (next === "shipped") P.shipView = "open";
      await load(true); render(); refreshTotals();
    } catch (e) { P.busy = false; M.confirm = false; renderModal(); note("bad", "Couldn't save the shipment: " + esc(JT.message(e))); }
  }
  async function quickStatus(id, next) {
    try { await JT.prep.setShipmentStatus(Number(id), next); note("info", next === "started" ? "Shipment started." : ""); await load(true); render(); }
    catch (e) { note("bad", "Couldn't update the shipment: " + esc(JT.message(e))); }
  }
  async function deleteShipment() {
    const M = P.modal; if (!M || !M.id) return;
    P.busy = true; renderModal();
    try { await JT.prep.deleteShipment(Number(M.id)); closeModal(); note("info", "Shipment deleted."); await load(true); render(); }
    catch (e) { P.busy = false; M.confirm = false; renderModal(); note("bad", "Couldn't delete: " + esc(JT.message(e))); }
  }
  function refreshTotals() { if (window.pcRender) window.pcRender(); }

  function bind() {
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on("prep-refresh", "click", () => refresh(true));
    on("prep-count", "click", () => openCount());
    on("prep-ship", "click", () => openShip());
    on("prep-vendor", "change", (e) => { P.vendor = e.target.value; render(); });
    on("prep-q", "input", (e) => { P.q = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(render, 200); });
    on("prep-shview", "click", (e) => { const b = e.target.closest("button[data-v]"); if (b) { P.shipView = b.dataset.v; renderShipments(); } });
    on("prep-ships", "click", (e) => {
      const b = e.target.closest("button[data-sact]");
      if (b) { e.stopPropagation(); if (b.dataset.sact === "new") return openShip(); if (b.dataset.sact === "started") return quickStatus(b.dataset.sid, "started");
        if (b.dataset.sact === "ship") { openShipment(b.dataset.sid); P.modal.confirm = "ship"; renderModal(); } return; }
      const c = e.target.closest(".shipcard[data-sid]"); if (c) openShipment(c.dataset.sid);
    });
    on("prep-ships", "keydown", (e) => { const c = e.target.closest(".shipcard[data-sid]"); if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openShipment(c.dataset.sid); } });
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
      if (t.id === "pm-add") { M.add = t.value; clearTimeout(box._t); box._t = setTimeout(renderModal, 150); return; }
      if (t.dataset.k) { M.qty[t.dataset.k] = t.value.trim(); M.confirm = false; clearTimeout(box._t); box._t = setTimeout(renderModal, 250); }
    });
    box.addEventListener("change", (e) => {
      const M = P.modal; if (!M) return;
      if (e.target.id === "pm-sku") { M.asku = e.target.value; renderModal(); }
      if (e.target.id === "pm-into" && e.target.value) openShipment(e.target.value, M.fromRow);
    });
    box.addEventListener("keydown", (e) => {
      const M = P.modal; if (!M || e.key !== "Enter") return;
      if (e.target.id === "pm-q") { const b = box.querySelector(".mres button[data-pick]"); if (b) b.click(); }
      else if (e.target.id === "pm-add") { e.preventDefault(); clearTimeout(box._t); const f = findRows(M.add, M.lines); if (f.length) addLine(keyOf(f[0])); else renderModal(); }
      else if (M.kind === "ship" && e.target.dataset.k) { e.preventDefault(); const a = $("pm-add"); if (a) a.focus(); }
      else if (M.kind === "count" && (e.target.id === "pm-qty" || e.target.id === "pm-note")) { const b = box.querySelector('[data-act="save-count"]'); if (b && !b.disabled) saveCount(); }
    });
    box.addEventListener("click", (e) => {
      const M = P.modal, b = e.target.closest("button"); if (!M || !b) return;
      if (b.dataset.act === "close") return closeModal();
      if (b.dataset.pick) { const v = cat.find(x => x.vid === b.dataset.pick); M.pick = { vid: v.vid, sku: v.sku, title: v.title, vendor: v.vendor, cost: v.cost }; M.asku = ""; renderModal(); setTimeout(() => { const i = $("pm-qty"); if (i) i.focus(); }, 0); return; }
      if (b.dataset.act === "repick") { M.pick = null; M.qty = ""; renderModal(); setTimeout(() => { const i = $("pm-q"); if (i) i.focus(); }, 0); return; }
      if (b.dataset.act === "save-count") return saveCount();
      if (b.dataset.dest) { M.dest = b.dataset.dest; M.confirm = false; renderModal(); return; }
      if (b.dataset.add) return addLine(b.dataset.add);
      if (b.dataset.rm) { M.lines = M.lines.filter(k => k !== b.dataset.rm); delete M.qty[b.dataset.rm]; M.confirm = false; renderModal(); return; }
      if (b.dataset.all) { const r = lineOf(b.dataset.all), sv = M.sh && M.sh.status !== "shipped" ? ((M.sh.lines.find(l => l.key === b.dataset.all) || {}).qty || 0) : 0;
        M.qty[b.dataset.all] = String(Math.max(0, r.qty - ((cache.alloc.get(b.dataset.all) || 0) - sv))); M.confirm = false; renderModal(); return; }
      if (b.dataset.act === "save") return saveShipment(null);
      if (b.dataset.act === "save-start") return saveShipment("started");
      if (b.dataset.act === "save-reopen") return saveShipment("open");
      if (b.dataset.act === "ship-go") { M.confirm = "ship"; renderModal(); return; }
      if (b.dataset.act === "del") { M.confirm = "del"; renderModal(); return; }
      if (b.dataset.act === "no-ship") { M.confirm = false; renderModal(); return; }
      if (b.dataset.act === "do-ship") return saveShipment("shipped");
      if (b.dataset.act === "do-del") return deleteShipment();
    });
  }

  bind();
  window.prepShow = () => { if (!P.shown) { P.shown = true; refresh(false); } else render(); };
  window.JTPrepTab = { _state: P };
  if ((location.hash || "") === "#prep") setTimeout(() => window.prepShow(), 0);
})();
