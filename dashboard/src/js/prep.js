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
      // History: finished shipments, orders and list items from the last HIST_DAYS days; Activity shows the latest moves
      const la = (c) => `${c} > now() - interval '${HIST_DAYS} days'`;
      // the checklist columns (migration 090); until it's applied the page works without them
      if (FLOW == null) FLOW = await JT.rows(["count(*)"], "from information_schema.columns where table_schema = 'jt' and table_name = 'prep_shipments' and column_name = 'closed_at'", true)
        .then(r => +(r[0] && r[0][0]) > 0).catch(() => false);
      const SHIPWHERE = FLOW ? `where s.status <> 'shipped' or s.closed_at is null or ${la("s.closed_at")}` : `where s.status <> 'shipped' or ${la("s.shipped_at")}`;
      const ORDWHERE = `where o.status <> 'complete' or ${la("o.updated_at")}`;
      const AMZQ = (linked) => JT.rows(["i.id", "i.kind", "i.name", "i.status", "i.destination", "coalesce(i.created_at, i.first_seen)::text", "i.units_expected", "i.units_received",
          linked ? "l.shipment_id::text" : "null::text", linked ? "l.how" : "''",
          "(select json_agg(json_build_array(x.sku, x.qty_expected, x.qty_received)) from jt.inbound_shipment_items x where x.shipment_id = i.id and x.qty_expected + x.qty_received > 0)"],
        `from jt.inbound_shipments i ${linked ? "left join jt.prep_shipment_amazon l on l.amazon_id = i.id" : ""}
          where ${linked ? "l.amazon_id is not null or" : ""} (coalesce(i.created_at, i.first_seen) > now() - interval '45 days' and i.status not in ('CANCELLED', 'DELETED'))`, refresh);
      const [items, moves, maps, lst, seed, ships, slines, ords, olines, list, ordship, amz, invl] = await Promise.all([
        JT.rows(["i.variant_id::text", "i.amazon_sku", "i.qty", "i.note", "i.updated_at", "v.product_id::text", "v.sku", "coalesce(nullif(v.display_name, ''), v.product_title)",
          "v.vendor", "v.product_type", "v.unit_cost", "v.price", "v.inventory_qty"],
          "from jt.prep_items i left join jt.variants v on v.variant_id = i.variant_id order by i.updated_at desc", refresh),
        JT.rows(["m.at", "m.kind", "m.variant_id::text", "m.amazon_sku", "m.qty_change", "m.qty_after", "m.shipment", "m.dest", "m.note", "m.by_user",
          "coalesce(nullif(v.display_name, ''), v.product_title)", "v.sku"],
          "from jt.prep_moves m left join jt.variants v on v.variant_id = m.variant_id order by m.at desc, m.id desc limit 1000", refresh),
        JT.rowsSplit(["data->>'sku'", "(regexp_match(data->>'variantId', '(\\d+)$'))[1]", "coalesce(data->>'units', '1')", "data->>'kind'"],
          "from jt.docs where collection = 'amzmap'", "id", 4, refresh),
        // Amazon listing titles, ASINs and prices (All Listings report; FBA report price wins when there is one)
        JT.rowsSplit(["r->>0", "r->>1", "r->>2", "r->>3"], "from jt.docs d, jsonb_array_elements(d.data->'rows') r where d.collection = 'amzlistings'", "d.id", 2, refresh),
        // starting-inventory file(s): [seller SKU(s), ASIN, units] — ASINs for listings missing elsewhere, and lines that couldn't be loaded
        JT.rows(["d.id", "d.data->>'file'", "r->>0", "r->>1", "(r->>2)::int"], "from jt.docs d, jsonb_array_elements(d.data->'rows') r where d.collection = 'prepseed'", refresh),
        // shipments: in progress, and shipped in the last 60 days
        JT.rows(["s.id::text", "s.name", "s.dest", "s.status", "s.note", "s.created_at", "s.created_by", "s.started_at", "s.shipped_at", "s.shipped_by", "s.updated_at", "s.order_id::text",
          ...(FLOW ? ["s.placement", "s.checks", "s.closed_at", "s.closed_by", "s.exception", "s.exception_at", "s.exception_by"] : [])],
          `from jt.prep_shipments s ${SHIPWHERE} order by s.updated_at desc`, refresh),
        JT.rows(["l.shipment_id::text", "l.variant_id::text", "l.amazon_sku", "l.qty", "coalesce(nullif(v.display_name, ''), v.product_title)", "v.sku", "v.unit_cost", "v.vendor", "v.product_id::text"],
          `from jt.prep_shipment_lines l join jt.prep_shipments s on s.id = l.shipment_id left join jt.variants v on v.variant_id = l.variant_id ${SHIPWHERE}`, refresh),
        // Incoming Inventory: vendor orders in progress, and ones shipped out in the last 60 days, with their linked invoice
        JT.rows(["o.id::text", "o.vendor", "o.po_no", "o.status", "o.invoice_id::text", "o.expected_on::text", "o.note", "o.short_ok", "o.stage_at", "o.created_at", "o.created_by", "o.updated_at",
          "i.invoice_no", "i.invoice_date::text", "(select sum(coalesce(il.amount, il.qty * il.unit_cost)) from jt.invoice_lines il where il.invoice_id = i.id and il.match_how <> 'skip')", "o.kind", "o.place_by::text", "o.receive_into"],
          `from jt.prep_orders o left join jt.invoices i on i.id = o.invoice_id ${ORDWHERE} order by o.updated_at desc`, refresh),
        JT.rows(["l.order_id::text", "l.variant_id::text", "l.amazon_sku", "l.qty_ordered", "l.qty_received", "l.unit_cost", "coalesce(nullif(v.display_name, ''), v.product_title)", "v.sku", "v.unit_cost", "v.vendor", "v.product_id::text", "l.dest", "l.eta::text", "l.incoming_hidden_qty"],
          `from jt.prep_order_lines l join jt.prep_orders o on o.id = l.order_id left join jt.variants v on v.variant_id = l.variant_id ${ORDWHERE}`, refresh),
        // On The List: products marked for re-order (open ones, and ones received in the last 60 days)
        JT.rows(["i.id::text", "i.variant_id::text", "i.amazon_sku", "i.dest", "i.qty", "i.note", "i.source", "i.order_id::text", "i.added_at", "i.added_by", "i.closed_at",
          "coalesce(nullif(v.display_name, ''), v.product_title)", "v.sku", "v.vendor", "v.unit_cost", "v.inventory_qty", "v.product_id::text"],
          `from jt.prep_list i left join jt.variants v on v.variant_id = i.variant_id where i.closed_at is null or ${la("i.closed_at")} order by i.added_at desc`, refresh),
        // Amazon shipments made from open vendor orders (any date), so Incoming products can count down
        JT.rows(["s.order_id::text", "s.status", "l.variant_id::text", "l.amazon_sku", "l.qty"],
          `from jt.prep_shipment_lines l join jt.prep_shipments s on s.id = l.shipment_id join jt.prep_orders o on o.id = s.order_id where o.status in ('ordered', 'invoiced', 'partial', 'received', 'qb_ready')`, refresh),
        // Seller Central shipments (last 45 days, and any linked to a prep shipment) to match with prep shipments
        AMZQ(true).catch(() => AMZQ(false)).catch(() => []),
        // invoices not received yet, prep center lines: what's coming and when (arrival_on, migration 090)
        JT.rows(["i.id::text", "i.vendor", "i.invoice_no", "i.invoice_date::text", "coalesce(i.order_id, (select p.id from jt.prep_orders p where p.invoice_id = i.id limit 1))::text",
          FLOW ? "i.arrival_on::text" : "null::text", "l.variant_id::text", "l.amazon_sku", "sum(l.qty)", "(select r.qty from jt.invoice_receipts r where r.invoice_id = i.id and r.variant_id = l.variant_id)",
          "coalesce(nullif(v.display_name, ''), v.product_title)", "v.sku", "v.vendor", "v.product_id::text", "max(l.unit_cost)"],
          `from jt.invoices i join jt.invoice_lines l on l.invoice_id = i.id left join jt.variants v on v.variant_id = l.variant_id
            where i.received_at is null and l.dest = 'prep' and l.variant_id is not null and l.match_how <> 'skip' and coalesce(i.invoice_date, i.created_at::date) > current_date - 180
            group by i.id, l.variant_id, l.amazon_sku, v.variant_id order by i.id`, refresh).catch(() => []),
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
      const shipments = ships.map(x => ({ id: x[0], name: x[1] || "", dest: x[2], status: x[3], note: x[4] || "", created: x[5], createdBy: x[6] || "", started: x[7], shipped: x[8], shippedBy: x[9] || "", updated: x[10], orderId: x[11] || null, lines: [],
        placement: x[12] || "", checks: x[13] || {}, closed: x[14] || null, closedBy: x[15] || "", exception: x[16] || "", exceptionAt: x[17] || null, exceptionBy: x[18] || "" }));
      const byId = new Map(shipments.map(sh => [sh.id, sh]));
      for (const [sid, vid, asku, qty, title, sku, cost, vendor, pid] of slines) {
        const sh = byId.get(sid); if (sh) sh.lines.push({ key: vid + "|" + (asku || ""), vid, asku: asku || "", qty: +qty, title: title || `variant ${vid}`, sku: sku || "", cost: cost == null ? null : +cost, vendor: vendor || "", pid: pid || "" });
      }
      const alloc = new Map();          // prep row -> units in open / started shipments
      for (const sh of shipments) if (sh.status !== "shipped") for (const l of sh.lines) alloc.set(l.key, (alloc.get(l.key) || 0) + l.qty);
      const orders = ords.map(x => ({ id: x[0], vendor: x[1] || "", po: x[2] || "", status: x[3], invoiceId: x[4] || null, expected: x[5] || "", note: x[6] || "", shortOk: !!x[7],
        stageAt: x[8] || {}, created: x[9], createdBy: x[10] || "", updated: x[11], inv: x[4] ? { no: x[12] || "", date: x[13] || "", total: x[14] == null ? null : +x[14] } : null, kind: x[15] || "order", placeBy: x[16] || "", into: x[17] || "", lines: [] }));
      const oById = new Map(orders.map(o => [o.id, o]));
      for (const [oid, vid, asku, qo, qr, uc, title, sku, sc, vendor, pid, dest, eta, hid] of olines) {
        const o = oById.get(oid); if (o) o.lines.push({ key: okey(vid, asku, dest), vid, asku: asku || "", dest: dest || "prep", ordered: +qo, received: +qr, unitCost: uc == null ? null : +uc,
          title: title || `variant ${vid}`, sku: sku || "", shopCost: sc == null ? null : +sc, vendor: vendor || "", pid: pid || "", eta: eta || "", hiddenAt: hid == null ? null : +hid });
      }
      for (const o of orders) { o.shipments = shipments.filter(sh => sh.orderId === o.id); o.lines.sort((a, b) => a.title.localeCompare(b.title)); }
      // Amazon seller SKU / ASIN -> Shopify variant, for adding products to an order by Amazon code
      const byAmz = new Map();
      for (const [vid, ls] of byVariant) for (const l of ls) { byAmz.set(l.sku.toLowerCase(), { vid, asku: l.sku }); if (l.asin) byAmz.set(l.asin.toLowerCase(), { vid, asku: "" }); }
      const listItems = list.map(x => ({ id: x[0], vid: x[1], asku: x[2] || "", dest: x[3], qty: x[4] == null ? null : +x[4], note: x[5] || "", source: x[6] || "", orderId: x[7] || null,
        added: x[8], addedBy: x[9] || "", closed: x[10] || null, title: x[11] || `variant ${x[1]}`, sku: x[12] || "", vendor: x[13] || "", cost: x[14] == null ? null : +x[14], shopQty: x[15] == null ? null : +x[15], pid: x[16] || "" }));
      for (const it of listItems) it.order = it.orderId ? oById.get(it.orderId) || null : null;
      // Units still to come on placed vendor orders, by prep row (product + listing): the shipment editor counts these
      // as available when planning, and flags lines that are waiting on them.
      const incoming = new Map();
      // Incoming products: every prep-center product on an open vendor order (placed, not complete), received or
      // still coming, until it's all in Amazon shipments made from that order.
      const OPEN = ["ordered", "invoiced", "partial", "received", "qb_ready"], poRows = [];
      for (const o of orders) if (OPEN.includes(o.status)) for (const l of o.lines) {
        if (l.dest !== "prep") continue;
        const k = l.vid + "|" + l.asku, left = Math.max(0, l.ordered - l.received);
        const listings = byVariant.get(l.vid) || [];
        const target = l.asku ? (listings.find(x => x.sku === l.asku) || { ...(listing.get(l.asku) || {}), sku: l.asku, units: 1 }) : null;
        const name = (o.vendor ? o.vendor + " " : "") + (o.po ? poLabel(o.po) : "order #" + o.id), when = l.eta || o.expected || "";
        const hidden = l.hiddenAt != null && l.received <= l.hiddenAt;       // taken off the list (it shows again if more arrive)
        poRows.push({ key: k, oid: o.id, name, when, status: o.status, hidden, vid: l.vid, asku: l.asku, title: l.title, sku: l.sku, vendor: l.vendor, pid: l.pid, cost: lineCost(l),
          listings, target, ordered: l.ordered, received: l.received, coming: left, backorder: !!l.backorder, used: 0, shipped: 0 });
        if (left && !hidden && ["ordered", "invoiced", "partial"].includes(o.status)) {
          let r = incoming.get(k);
          if (!r) { r = { vid: l.vid, asku: l.asku, qty: 0, coming: 0, title: l.title, sku: l.sku, vendor: l.vendor, type: "", pid: l.pid, cost: lineCost(l), listings, target, from: [] }; incoming.set(k, r); }
          r.coming += left; r.from.push({ oid: o.id, name, qty: left, when });
        }
      }
      // shipments from those orders count down their products (a product the shipment's own order doesn't have
      // counts against the oldest open order that does)
      for (const [oid, st, vid, asku, qty] of ordship) {
        const k = vid + "|" + (asku || "");
        const r = poRows.find(x => x.oid === oid && x.key === k) || poRows.filter(x => x.key === k).sort((a, b) => Number(a.oid) - Number(b.oid))[0];
        if (!r) continue;
        r.used += +qty || 0; if (st === "shipped") r.shipped += +qty || 0;
      }
      // what's here now can't be more than the prep center's free stock of that product (not in any shipment in
      // progress); older orders' units went out first, so the free stock is given to the newest orders first
      const stockOf = (k) => { const r = rows.find(x => x.vid + "|" + x.asku === k); return r ? r.qty : 0; };
      const cap = new Map();
      for (const r of [...poRows].sort((a, b) => Number(b.oid) - Number(a.oid))) {
        if (!cap.has(r.key)) cap.set(r.key, Math.max(0, stockOf(r.key) - (alloc.get(r.key) || 0)));
        const c = cap.get(r.key), here = Math.min(Math.max(0, r.received - r.used), c);
        cap.set(r.key, c - here);
        r.ready = here; r.comingLeft = Math.max(0, r.coming - Math.max(0, r.used - r.received)); r.left = r.ready + r.comingLeft;
      }
      const skuUnits = new Map();     // Amazon seller SKU -> {vid, units} (Shopify product and units per Amazon unit)
      for (const [sku, vid, units, kind] of maps) if (kind === "shopify" && vid) skuUnits.set(sku, { vid, units: +units || 1 });
      const amzShips = amz.map(x => ({ id: x[0], kind: x[1], name: x[2] || "", status: x[3] || "", fc: x[4] || "", created: x[5] || "", ue: +x[6] || 0, ur: +x[7] || 0, linkedTo: x[8] || null, how: x[9] || "",
        items: (x[10] || []).map(([sku, qe, qr]) => ({ sku, qty: +qe || 0, got: +qr || 0 })) }));
      for (const sh of shipments) sh.amz = amzShips.filter(a => a.linkedTo === sh.id);
      // open invoices: one per invoice, with its prep center lines and what's still to come (received per product is
      // given to the invoice's lines in order)
      const invMap = new Map();
      for (const [iid, ven, no, idate, oid, arr, vid, asku, qty, got, title, sku, vvendor, pid, uc] of invl) {
        let iv = invMap.get(iid);
        if (!iv) { iv = { id: iid, vendor: ven || "", no: no || "", date: idate || "", oid: oid || null, arrival: arr || "", lines: [], gotLeft: new Map() }; invMap.set(iid, iv); }
        if (!iv.gotLeft.has(vid)) iv.gotLeft.set(vid, +got || 0);
        const g = Math.min(iv.gotLeft.get(vid), +qty || 0); iv.gotLeft.set(vid, iv.gotLeft.get(vid) - g);
        const listings = byVariant.get(vid) || [];
        iv.lines.push({ key: vid + "|" + (asku || ""), vid, asku: asku || "", qty: +qty || 0, got: g, left: Math.max(0, (+qty || 0) - g), title: title || `variant ${vid}`, sku: sku || "", vendor: vvendor || ven || "",
          pid: pid || "", cost: uc == null ? null : +uc, listings, target: asku ? (listings.find(x => x.sku === asku) || { ...(listing.get(asku) || {}), sku: asku, units: 1 }) : null });
      }
      const invoicesOpen = [...invMap.values()].filter(iv => iv.lines.some(l => l.left > 0));
      for (const iv of invoicesOpen) { const o = iv.oid ? oById.get(iv.oid) : null; iv.order = o || null; iv.when = iv.arrival || (o && o.expected) || ""; }
      cache = { rows, moves, byVariant, byAmz, unloaded, shipments, alloc, orders, incoming, poRows, list: listItems, amzShips, skuUnits, invoicesOpen, loadedAt: Date.now() };
      cache.amzSuggest = amzSuggest(cache);
      return cache;
    })();
    try { return await loading; } finally { loading = null; }
  }
  function totals(rows) {
    const t = { units: 0, cost: 0, retail: 0, amz: 0, skus: 0, earmarked: 0, noCost: 0, noCostUnits: 0 };
    for (const r of rows) {
      if (r.qty <= 0) continue;
      t.skus++; t.units += r.qty; if (r.asku) t.earmarked++;
      const c = window.JTCost && window.JTCost.has(r.vid) ? window.JTCost.unit(r.vid, r.cost) : r.cost;     // FIFO cost layers where a PO set them
      if (c == null) { t.noCost++; t.noCostUnits += r.qty; } else t.cost += r.qty * c;
      t.amz += r.amzValue || 0;
      t.retail += r.amzValue != null ? r.amzValue : r.qty * (r.price || 0);   // Amazon price where known, else Shopify price
    }
    return t;
  }
  // how a mapped Amazon listing reads in pickers: ASIN, pack size, seller SKU
  const listingLabel = (l) => [l.asin || "no ASIN", (l.units || 1) !== 1 ? (l.units + "-pack") : "", l.sku].filter(Boolean).join(" · ");
  window.JTListingLabel = listingLabel;
  const okey = (vid, asku, dest) => vid + "|" + (asku || "") + "|" + (dest || "prep");
  // On The List, shared with the Inventory value and Amazon inventory tabs ("+ List" buttons)
  const listed = (vid, asku, dest) => cache && cache.list ? cache.list.find(i => !i.closed && i.vid === String(vid) && i.asku === (asku || "") && i.dest === (dest || "prep")) || null : null;
  // Adds to On The List, which puts it on the vendor's draft PO (migration 089). Returns {item, where}: where is
  // e.g. "the Wilson draft PO (Order #61)" for messages.
  async function addToList(body) {
    await JT.prep.listAdd(body);
    await load(true);
    if (!$("tab-prep").hidden) render();
    const item = listed(body.variant_id, body.amazon_sku, body.dest), o = item && item.order;
    return { item, where: o ? `the ${o.vendor ? esc(o.vendor) + " " : ""}draft PO (${esc(orderTitle(o))})` : "On The List" };
  }
  window.JTPrep = { load, totals, listed, addToList, get data() { return cache; } };

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
  const P = { shown: false, loading: false, err: null, vendor: "all", q: "", modal: null, busy: false, moveKind: "all", shipView: "open", oView: "open", oStage: "all", lView: "todo", lAdd: "", lSel: new Set() };
  const HIST_DAYS = 90;
  let FLOW = null;     // migration 090 applied (checklist columns, invoice arrival dates)

  const note = (kind, html) => { const n = $("prep-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; };
  async function refresh(force) {
    P.loading = true; P.err = null; render();
    try { if (JT.fba) await JT.fba.load(false).catch(() => {}); await load(force); } catch (e) { P.err = e; note("bad", esc(JT.message(e))); }
    finally { P.loading = false; render(); }
  }
  // Sync from Seller Central now (same as the hourly sync: FBA + AWD shipments changed in the last 3 days), so new
  // shipments can be linked without waiting for the hour
  async function syncAmz() {
    if (P.amzSyncing) return;
    P.amzSyncing = true; syncBtns(); note("info", "Getting new and changed shipments from Seller Central. This can take a minute…");
    try {
      const r = await JT.amazon({ action: "inbound_shipments" });
      if (r && r.ok === false) throw new Error(r.error || "Amazon sync failed");
      const n = ((r && r.fba && r.fba.found) || 0) + ((r && r.awd && r.awd.found) || 0);
      await load(true); render();
      if (P.modal && P.modal.kind === "ship" && P.modal.id) { P.modal.sh = cache.shipments.find(x => x.id === P.modal.id) || P.modal.sh; renderModal(); }
      note("info", `Synced from Seller Central: ${n} shipment${n === 1 ? "" : "s"} changed in the last 3 days${r && r.done === false ? " (the rest come with the hourly sync)" : ""}.`);
    } catch (e) { note("bad", "Couldn't sync from Seller Central: " + esc(e && e.message ? e.message : JT.message(e))); }
    finally { P.amzSyncing = false; syncBtns(); }
  }
  function syncBtns() {
    const b = $("prep-amzsync"); if (b) { b.disabled = !!P.amzSyncing; b.textContent = P.amzSyncing ? "Syncing…" : "Sync Amazon shipments"; }
    document.querySelectorAll('[data-act="amz-sync"]').forEach(x => { x.disabled = !!P.amzSyncing; x.textContent = P.amzSyncing ? "Syncing from Seller Central…" : "Sync from Seller Central"; });
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
      (() => { const iv = d.invoicesOpen || []; const u = iv.reduce((a, x) => a + x.lines.reduce((b, l) => b + l.left, 0), 0);
        const c = iv.reduce((a, x) => a + x.lines.reduce((b, l) => b + l.left * (l.cost || 0), 0), 0);
        return { l: "Incoming on invoices", v: n0(u), s: iv.length ? `units · ${m0(c)} at cost · ${iv.length} invoice${iv.length === 1 ? "" : "s"} not received yet` : "no invoices waiting to arrive" }; })(),
    ].map(k => `<div class="kpi ${k.c || ""}"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
    renderShipments();
    renderList();
    renderIncoming();
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
          <div><b>3 · See it in the totals</b><span>Inventory › Value shows Shopify, prep center and Amazon separately.</span></div>
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
          return `<tr class="prodrow" data-prod="${esc(r.vid)}" data-psku="${esc(r.asku)}" title="Click for everything about this product"><td class="l">${r.pid ? `<a class="olink" href="${ADMIN}/products/${esc(r.pid)}/variants/${esc(r.vid)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}<div class="meta"><span class="mono">${esc(r.sku) || "no SKU"}</span> · ${esc(r.vendor)}${r.type ? " · " + esc(r.type) : ""}</div></td>
            <td class="l">${lst}</td>
            <td><b>${n0(r.qty)}</b>${d.alloc.get(r.vid + "|" + r.asku) ? `<div class="meta ${d.alloc.get(r.vid + "|" + r.asku) > r.qty + comingOf(r.vid + "|" + r.asku) ? "neg" : ""}">${n0(d.alloc.get(r.vid + "|" + r.asku))} in shipments${d.alloc.get(r.vid + "|" + r.asku) > r.qty && d.alloc.get(r.vid + "|" + r.asku) <= r.qty + comingOf(r.vid + "|" + r.asku) ? " (some incoming)" : ""}</div>` : ""}${comingOf(r.vid + "|" + r.asku) ? `<div class="meta">+ ${n0(comingOf(r.vid + "|" + r.asku))} incoming</div>` : ""}${r.amzUnits != null && r.val && r.val.units !== 1 ? `<div class="meta">≈ ${n0(r.amzUnits)} Amazon units</div>` : ""}</td>
            <td>${r.cost == null ? '<span class="pill miss">No cost</span>' : m(r.cost)}</td><td>${r.cost == null ? dash : m0(r.qty * r.cost)}</td>
            <td>${r.amzPrice == null ? dash : m(r.amzPrice)}</td><td>${r.amzValue == null ? dash : m0(r.amzValue)}</td>
            <td class="l small">${when(r.upd)}${r.note ? `<div class="meta">${esc(r.note)}</div>` : ""}</td>
            <td class="l"><span class="rbtns"><button class="mini" data-act="count" data-vid="${esc(r.vid)}" data-sku="${esc(r.asku)}">Count</button><button class="mini" data-act="ship" data-vid="${esc(r.vid)}" data-sku="${esc(r.asku)}">Ship</button>${r.asku || r.listings.length ? `<button class="mini" data-act="assign" data-vid="${esc(r.vid)}" data-sku="${esc(r.asku)}" title="${r.asku ? "Move these units to another listing, or back to any listing" : "Earmark these units for an Amazon listing (ASIN)"}">Assign</button>` : ""}${listed(r.vid, r.asku, "prep") ? (listed(r.vid, r.asku, "prep").order ? `<span class="pill ok" title="On ${esc(orderTitle(listed(r.vid, r.asku, "prep").order))}">On PO</span>` : '<span class="pill ok" title="On The List">On list</span>') : `<button class="mini" data-act="list" data-vid="${esc(r.vid)}" data-sku="${esc(r.asku)}" title="Put on On The List to re-order">+ List</button>`}</span></td></tr>`;
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
  const SPREV = { started: "open", shipped: "started" };
  const statusPill = (st) => `<span class="pill ${STATUS[st][1]}">${STATUS[st][0]}</span>`;
  const shipTitle = (sh) => sh.name || (sh.amz && sh.amz.length ? planKey(sh.amz[0]) : `Shipment #${sh.id}`);

  // ---------- exceptions ----------
  // Everything about a shipment that needs someone to look at it. The card turns amber (warn) or red (bad), and the
  // shipment's popup lists each one with what it means and buttons to fix it. Blocking problems ("bad") stop
  // "Mark shipped"; warnings don't. New checks slot in here: each is {lvl, kind, title, text, fixes}.
  // A fix is {label, fix, k?, n?, arg?} (handled in the popup), {label, act} (a popup button) or {label, href}.
  const LATE_DAYS = 7, STALE_DAYS = 14;
  const KIND_LABEL = { short: "short on stock", shared: "also in another shipment", nocost: "missing cost", nolisting: "no Amazon listing",
    empty: "no products", noid: "no shipment ID", amzshipped: "shipped in Seller Central", incoming: "waiting on incoming", late: "late", stale: "sitting open", bad: "quantity isn't a whole number" };
  const daysSince = (t) => { const d = window.JTDate.parseTime(t); return t && !isNaN(d) ? Math.floor((Date.now() - d) / 864e5) : null; };
  // s: {id, status, name, created, started, lines: [{key, vid, asku, qty, title, sku, cost, pid}]} (a saved shipment or the popup's draft)
  function issuesOf(s) {
    const out = [];
    if (!cache || s.status === "shipped") return out;
    const mine = s.id ? cache.shipments.find(x => x.id === String(s.id)) : null;
    const savedQty = (k) => mine && mine.status !== "shipped" ? ((mine.lines.find(l => l.key === k) || {}).qty || 0) : 0;
    const othersWith = (k) => cache.shipments.filter(x => x.status !== "shipped" && x.id !== String(s.id || "") && x.lines.some(l => l.key === k));
    const lines = s.lines.filter(l => l.qty > 0);
    if (s.id && !lines.length && !s.lines.some(l => l.invalid)) out.push({ lvl: "warn", kind: "empty", title: "No products in this shipment", text: "Add what's going in the box by ASIN, Amazon SKU or Shopify SKU.", fixes: [{ label: "Add a product", fix: "focus", arg: "pm-add" }] });
    for (const l of s.lines) if (l.invalid) out.push({ lvl: "bad", kind: "bad", title: `${esc(l.title)}: "${esc(l.raw)}" isn't a quantity`, text: "Enter a whole number of units.", fixes: [{ label: "Fix the quantity", fix: "focusk", k: l.key }] });
    for (const l of lines) {
      const have = onHand(l.vid, l.asku), others = Math.max(0, (cache.alloc.get(l.key) || 0) - savedQty(l.key)), free = Math.max(0, have - others);
      const who = othersWith(l.key), whoTxt = who.map(x => `${shipTitle(x)} (${STATUS[x.status][0].toLowerCase()})`).join(", ");
      const name = esc(l.title) + (l.asku ? ` <span class="mono">${esc(l.asku)}</span>` : "");
      const inc = cache.incoming && cache.incoming.get(l.key), coming = inc ? inc.coming : 0;
      if (l.qty > have && l.qty <= have + coming - others) {
        const need = l.qty - Math.max(0, have - others);
        out.push({ lvl: "bad", kind: "incoming", title: `${name}: ${n0(need)} still incoming`,
          text: `${n0(Math.max(0, have - others))} ${have - others === 1 ? "is" : "are"} in the prep center for this shipment; the rest ${need === 1 ? "is" : "are"} on ${inc.from.map(f => esc(f.name) + (f.when ? " (expected " + shortDate(f.when) + ")" : "")).join(", ")}. Plan it now; mark it shipped once they've been received into the prep center.`,
          fixes: inc.from.slice(0, 3).map(f => ({ label: `Open ${f.name}`, fix: "gotoorder", arg: f.oid })) });
      } else if (l.qty > have) {
        const fixes = [];
        if (free > 0) fixes.push({ label: `Ship ${n0(free)} instead`, fix: "setqty", k: l.key, n: free });
        fixes.push({ label: "Recount this product", fix: "recount", k: l.key });
        fixes.push({ label: "Remove from shipment", fix: "remove", k: l.key });
        for (const x of who) fixes.push({ label: `Open ${shipTitle(x)}`, fix: "goto", arg: x.id });
        out.push({ lvl: "bad", kind: "short", title: `Short on ${name}`,
          text: `This shipment has ${n0(l.qty)}, but ${have ? "only " + n0(have) + (have === 1 ? " is" : " are") : "none are"} in the prep center${others ? ` and ${n0(others)} of those ${others === 1 ? "is" : "are"} already in ${esc(whoTxt)}` : ""}. `
            + `If the rest is on the shelf, recount it into the prep center; if it's on the Shopify side, move it over and recount; otherwise ship what's here${free ? ` (${n0(free)})` : ""} or take it off this shipment.`, fixes });
      } else if (l.qty > free) {
        const fixes = [];
        if (free > 0) fixes.push({ label: `Ship ${n0(free)} instead`, fix: "setqty", k: l.key, n: free });
        for (const x of who) fixes.push({ label: `Open ${shipTitle(x)}`, fix: "goto", arg: x.id });
        fixes.push({ label: "Recount this product", fix: "recount", k: l.key });
        out.push({ lvl: "warn", kind: "shared", title: `${name} is also in ${esc(whoTxt)}`,
          text: `${n0(have)} in the prep center, ${n0(others)} already set aside for ${who.length === 1 ? "that shipment" : "those shipments"}, and this one wants ${n0(l.qty)}. Whichever ships second will come up short.`, fixes });
      }
      if (l.cost == null) out.push({ lvl: "warn", kind: "nocost", title: `No Shopify cost on ${name}`, text: "The shipment's value, the prep center total and Amazon profit leave this product out until it has a cost.",
        fixes: [...(l.pid ? [{ label: "Open in Shopify", href: `${ADMIN}/products/${l.pid}/variants/${l.vid}` }] : []), { label: "Find it in Inventory value", fix: "costs", arg: l.sku || l.title }] });
      const r = rowOf(l.key);
      if (!l.asku && r && !r.listings.length) out.push({ lvl: "warn", kind: "nolisting", title: `${name} isn't mapped to an Amazon listing`, text: "Amazon won't know which listing these units are for, and they won't be valued at an Amazon price. Map one of its listings, or earmark the stock for a seller SKU with Count stock.",
        fixes: [{ label: "Open Amazon mapping", fix: "tab", arg: "amzmap" }] });
    }
    const amzL = mine ? mine.amz || [] : [];
    if (amzL.length && amzL.some(a => AMZ_GONE.has(a.status))) out.push({ lvl: "warn", kind: "amzshipped", title: "Seller Central shows this shipment on its way",
      text: `${amzL.filter(a => AMZ_GONE.has(a.status)).map(a => esc(a.id) + " is " + esc(AMZ_STAGE(a.status).toLowerCase())).join(", ")}. Mark it shipped so the prep center count is right.`, fixes: [{ label: "Mark shipped", act: "ship-go" }] });
    if (s.status === "started" && !amzL.length && !String(s.name || "").trim()) out.push({ lvl: "warn", kind: "noid", title: "No Amazon shipment ID", text: "Add the shipment ID from Seller Central (FBA…) so this can be matched to what Amazon receives.", fixes: [{ label: "Add the ID", fix: "focus", arg: "pm-ship" }] });
    const ds = daysSince(s.started), dc = daysSince(s.created);
    if (s.status === "started" && ds != null && ds >= LATE_DAYS) out.push({ lvl: "warn", kind: "late", title: `Started ${ds} days ago and not shipped`, text: "If it went out, mark it shipped so the prep center count is right. If it's on hold, move it back to open.",
      fixes: [{ label: "Mark shipped", act: "ship-go" }, { label: "Back to open", act: "save-reopen" }] });
    if (s.status === "open" && s.id && dc != null && dc >= STALE_DAYS) out.push({ lvl: "info", kind: "stale", title: `Open for ${dc} days`, text: "Its units are held back from other shipments while it's open. Start it, or delete it if it isn't going.",
      fixes: [{ label: "Start", act: "save-start" }, { label: "Delete", act: "del" }] });
    const rank = { bad: 0, warn: 1, info: 2 };
    return out.sort((a, b) => rank[a.lvl] - rank[b.lvl]);
  }
  const worst = (list) => list.some(x => x.lvl === "bad") ? "bad" : list.some(x => x.lvl === "warn") ? "warn" : list.length ? "info" : "";
  function issueSummary(list) {
    const by = new Map(); for (const x of list) if (x.lvl !== "info") by.set(x.kind, (by.get(x.kind) || 0) + 1);
    return [...by].map(([k, n]) => (n > 1 && ["short", "shared", "nocost", "nolisting"].includes(k) ? n + " products " : "") + KIND_LABEL[k]).join(" · ");
  }
  function issuesHtml(list) {
    if (!list.length) return "";
    const btn = (f) => f.href ? `<a class="mini" href="${esc(f.href)}" target="_blank" rel="noopener">${esc(f.label)} ↗</a>`
      : f.act ? `<button class="mini" data-act="${f.act}">${esc(f.label)}</button>`
      : `<button class="mini" data-fix="${f.fix}" data-k="${esc(f.k || "")}" data-n="${f.n ?? ""}" data-arg="${esc(f.arg || "")}">${esc(f.label)}</button>`;
    const n = list.filter(x => x.lvl !== "info").length;
    return `<div class="issues"><span class="ih">${n ? `Needs attention · ${n}` : "Heads up"}</span>${list.map(x => `<div class="issue ${x.lvl}"><div class="it"><b>${x.title}</b><span>${x.text}</span></div>${x.fixes.length ? `<div class="fixes">${x.fixes.map(btn).join("")}</div>` : ""}</div>`).join("")}</div>`;
  }
  window.JTIssues = { issuesOf, issuesHtml, worst };
  const contentsOf = (sh) => {
    const t = sh.lines.map(l => l.title);
    return !t.length ? "Empty shipment" : t.length === 1 ? t[0] : t.length === 2 ? t[0] + " + " + t[1] : `${t[0]} + ${t.length - 1} more`;
  };
  // ---------- Seller Central matching ----------
  // Send to Amazon splits one plan into several FBA shipments named "<plan name>-<fulfillment center>" (e.g. "FBA STA
  // (10/06/2026 02:24)-GYR2"), so shipments are grouped by plan; an AWD shipment is its own group. A prep shipment
  // matches a plan when they hold the same products in the same quantities (Shopify units: Amazon units × pack size).
  const msOf = (t) => { const d = t ? window.JTDate.parseTime(t) : null, v = d ? +d : NaN; return isNaN(v) ? null : v; };
  const planKey = (a) => a.kind === "FBA" ? a.name.replace(/-[A-Z]{3}\d{1,2}$/, "") || a.id : a.name || a.id;
  function amzGroups(list) {
    const g = new Map();
    for (const a of list) { const k = a.kind + "|" + planKey(a); let x = g.get(k); if (!x) { x = { key: k, label: planKey(a), kind: a.kind, ships: [] }; g.set(k, x); } x.ships.push(a); }
    return [...g.values()];
  }
  // products in Shopify units: Map vid -> units, plus seller SKUs that aren't mapped to a Shopify product
  function amzContents(ships, c) {
    const byVid = new Map(), unmapped = [];
    for (const a of ships) for (const it of a.items) {
      const m = c.skuUnits.get(it.sku);
      if (!m) { unmapped.push(it.sku); continue; }
      byVid.set(m.vid, (byVid.get(m.vid) || 0) + it.qty * m.units);
    }
    return { byVid, unmapped };
  }
  function prepContents(sh) { const byVid = new Map(); for (const l of sh.lines) if (l.qty > 0) byVid.set(l.vid, (byVid.get(l.vid) || 0) + l.qty); return byVid; }
  // how well a prep shipment and a group of Amazon shipments match: null (different products) or {exact, diff, units}
  function compare(prep, amzC) {
    if (!prep.size || amzC.unmapped.length || prep.size !== amzC.byVid.size) return null;
    let diff = 0, units = 0;
    for (const [vid, q] of prep) { if (!amzC.byVid.has(vid)) return null; diff += Math.abs(q - amzC.byVid.get(vid)); units += q; }
    if (diff > Math.max(6, units * 0.05)) return null;      // same products, quantities within 5% (Amazon can trim a plan)
    const amzUnits = [...amzC.byVid.values()].reduce((a, b) => a + b, 0);
    return { exact: diff === 0, diff, units, amzUnits };
  }
  const amzIdIn = (name) => (String(name || "").match(/\b(FBA[0-9A-Z]{8,}|STAR-[0-9A-Z]{8,}|wf[0-9a-f-]{20,})\b/g) || []);
  // suggestions: prep shipment id -> {group, how: "id" | "exact" | "close", diff}; each Amazon group goes to one prep shipment
  function amzSuggest(c) {
    const free = c.amzShips.filter(a => !a.linkedTo), groups = amzGroups(free), out = new Map(), used = new Set();
    const prepList = c.shipments.filter(sh => !sh.amz.length && (sh.status !== "shipped" || (daysSince(sh.shipped) ?? 99) <= 30));
    const cands = [];
    for (const sh of prepList) {
      const ids = amzIdIn(sh.name), pc = prepContents(sh), t0 = msOf(sh.created);
      for (const g of groups) {
        if (ids.length && g.ships.some(a => ids.includes(a.id) || ids.includes(a.name))) { cands.push({ sh, g, how: "id", diff: 0, rank: 0 }); continue; }
        if (g.kind !== sh.dest) continue;
        const gt = Math.min(...g.ships.map(a => msOf(a.created) ?? Infinity));
        if (t0 != null && isFinite(gt) && gt < t0 - 3 * 864e5) continue;                 // made in Seller Central before the prep shipment
        const r = compare(pc, amzContents(g.ships, c));
        if (r) cands.push({ sh, g, how: r.exact ? "exact" : "close", diff: r.amzUnits - r.units, rank: r.exact ? 1 : 2 + Math.abs(r.diff) / Math.max(1, r.units) });
      }
    }
    const gap = (x) => Math.abs((msOf(x.g.ships[0].created) || 0) - (msOf(x.sh.created) || 0));
    cands.sort((a, b) => a.rank - b.rank || gap(a) - gap(b));
    for (const x of cands) { if (out.has(x.sh.id) || used.has(x.g.key)) continue; out.set(x.sh.id, x); used.add(x.g.key); }
    return out;
  }
  const AMZ_STAGE = (st) => ({ WORKING: "Working", READY_TO_SHIP: "Ready to ship", SHIPPED: "Shipped", IN_TRANSIT: "In transit", DELIVERED: "Delivered", CHECKED_IN: "Checked in", RECEIVING: "Receiving", CLOSED: "Closed", CREATED: "Created", CANCELLED: "Cancelled", DELETED: "Deleted" }[st] || st);
  const AMZ_GONE = new Set(["SHIPPED", "IN_TRANSIT", "DELIVERED", "CHECKED_IN", "RECEIVING", "CLOSED"]);
  // one line about a prep shipment's Seller Central side, for its card
  // the card's Seller Central line: Linked (with Amazon's status), Match / Likely (a suggestion to link inside the
  // shipment), or No shipment. Linking and every other change happen inside the shipment, not on the card.
  function amzLine(sh) {
    if (sh.amz.length) {
      const sts = [...new Set(sh.amz.map(a => AMZ_STAGE(a.status)))], ue = sh.amz.reduce((t, a) => t + a.ue, 0), ur = sh.amz.reduce((t, a) => t + a.ur, 0);
      const gone = sh.status !== "shipped" && sh.amz.some(a => AMZ_GONE.has(a.status));
      return `<div class="sc-amz" title="${esc(sh.amz.map(a => `${a.id} · ${a.fc} · ${AMZ_STAGE(a.status)} · ${a.ur}/${a.ue}`).join("\n"))}"><span class="pill ok">Linked</span><span>${sh.amz.length} shipment${sh.amz.length === 1 ? "" : "s"} · ${esc(sts.join(", "))}${ur ? ` · ${n0(ur)} of ${n0(ue)} received` : ""}</span>${gone ? '<span class="warnt">· on its way — mark shipped</span>' : ""}</div>`;
    }
    const sg = cache.amzSuggest && cache.amzSuggest.get(sh.id);
    if (!sg) return `<div class="sc-amz"><span class="pill miss">No shipment</span><span class="dim">not in Seller Central yet</span></div>`;
    const u = sg.g.ships.reduce((t, a) => t + a.ue, 0);
    return `<div class="sc-amz" title="${esc(sg.g.ships.map(a => a.id).join(", "))}"><span class="pill ${sg.how === "close" ? "warn" : "pos"}">${sg.how === "close" ? "Likely" : "Match"}</span><span>${esc(sg.g.label)} · ${sg.g.ships.length > 1 ? sg.g.ships.length + " shipments · " : ""}${n0(u)} units${sg.how === "close" ? ` (${sg.diff > 0 ? "+" : ""}${n0(sg.diff)})` : ""}</span></div>`;
  }
  // the popup's Seller Central part: linked Amazon shipments (with how their contents compare), the suggested match,
  // and a list to link any other recent Seller Central shipment by hand
  function amzSection(M) {
    const sh = cache.shipments.find(x => x.id === String(M.id)) || M.sh, linked = sh.amz || [], sg = cache.amzSuggest && cache.amzSuggest.get(sh.id);
    const row = (a, btn) => `<tr><td class="l mono">${esc(a.id)}<div class="meta">${esc(a.name)}</div></td><td class="l">${esc(a.fc)}</td><td class="l small">${esc(AMZ_STAGE(a.status))}</td><td>${n0(a.ue)}</td><td>${a.ur ? n0(a.ur) : '<span class="dim">—</span>'}</td><td class="l small mono">${esc(a.items.map(i => i.sku + " × " + i.qty).join(", "))}</td><td>${btn}</td></tr>`;
    const head = '<thead><tr><th class="l">Amazon shipment</th><th class="l">To</th><th class="l">Status</th><th>Units</th><th>Received</th><th class="l">Contents</th><th></th></tr></thead>';
    let html = "";
    if (linked.length) {
      const r = compare(prepContents(sh), amzContents(linked, cache)), ac = amzContents(linked, cache), pc = prepContents(sh);
      const diffs = [...new Set([...pc.keys(), ...ac.byVid.keys()])].filter(v => (pc.get(v) || 0) !== (ac.byVid.get(v) || 0)).map(v => {
        const l = sh.lines.find(x => x.vid === v), t = l ? l.title : (cache.rows.find(x => x.vid === v) || {}).title || "variant " + v;
        return `${esc(t)}: ${n0(pc.get(v) || 0)} here, ${n0(ac.byVid.get(v) || 0)} in Seller Central`; });
      html += `<table class="prept">${head}<tbody>${linked.map(a => row(a, `<button class="linkbtn small" data-act="amz-unlink" data-aid="${esc(a.id)}" title="Unlink this Amazon shipment">Unlink</button>`)).join("")}</tbody></table>
        ${M.recon ? "" : r && r.exact ? '<div class="small pos">Contents match.</div>' : diffs.length || ac.unmapped.length ? `<div class="row small"><span class="warnt">Contents differ (Shopify units): ${diffs.join(" · ")}${ac.unmapped.length ? `${diffs.length ? " · " : ""}not mapped to a Shopify product: ${esc(ac.unmapped.join(", "))}` : ""}</span>${ac.unmapped.length ? "" : '<button class="mini primary" data-act="recon-open">Make it match Seller Central</button>'}</div>` : ""}`;
    } else if (sg) {
      const u = sg.g.ships.reduce((t, a) => t + a.ue, 0);
      html += `<div class="note ${sg.how === "close" ? "warn" : "info"}"><b>${sg.how === "id" ? "Matches the shipment ID" : sg.how === "exact" ? "Same contents" : `Close match (${sg.diff > 0 ? "+" : ""}${n0(sg.diff)} units in Seller Central)`}:</b> ${esc(sg.g.label)} · ${sg.g.ships.length} shipment${sg.g.ships.length === 1 ? "" : "s"} · ${n0(u)} units
        ${M.recon ? "" : '<button class="mini primary" data-act="amz-link-sugg">Link</button>'}</div>
        <table class="prept">${head}<tbody>${sg.g.ships.map(a => row(a, "")).join("")}</tbody></table>`;
    }
    const free = amzGroups(cache.amzShips.filter(a => !a.linkedTo)).sort((a, b) => String(b.ships[0].created).localeCompare(String(a.ships[0].created)));
    const opt = (v, t) => `<option value="${esc(v)}" ${M.amzPick === v ? "selected" : ""}>${esc(t)}</option>`;
    const picker = free.length && !M.recon ? `<div class="row small"><label for="pm-amz" class="muted">${linked.length ? "Link another" : sg ? "Or link a different one" : "Link a Seller Central shipment"}</label>
      <select id="pm-amz" class="inp sm" style="width:auto;max-width:560px"><option value="">Choose…</option>${free.map(g => {
        const u = g.ships.reduce((t, a) => t + a.ue, 0), sk = [...new Set(g.ships.flatMap(a => a.items.map(i => i.sku)))];
        return opt(g.ships.map(a => a.id).join(","), `${g.label} · ${g.ships.length > 1 ? g.ships.length + " shipments · " : ""}${g.ships[0].status.toLowerCase().replace(/_/g, " ")} · ${n0(u)} units · ${sk.slice(0, 3).join(", ")}${sk.length > 3 ? " +" + (sk.length - 3) : ""}`)
          + (g.ships.length > 1 ? g.ships.map(a => opt(a.id, `    just ${a.id} (${a.fc}) · ${n0(a.ue)} units`)).join("") : "");
      }).join("")}</select><button class="mini" data-act="amz-link-pick" ${M.amzPick ? "" : "disabled"}>Link</button></div>` : "";
    if (M.recon) html = reconHtml(M) + html;
    const syncL = M.recon ? "" : `<button class="linkbtn small" data-act="amz-sync" ${P.amzSyncing ? "disabled" : ""} title="Get shipments made in Seller Central since the hourly sync">${P.amzSyncing ? "Syncing from Seller Central…" : "Sync from Seller Central"}</button>`;
    return `<div class="amzbox"><div class="lanehead"><h3 class="psec" style="margin:0">Seller Central</h3>${linked.length ? "" : '<span class="muted small">not linked yet</span>'}<span class="right">${syncL}</span></div>${html}${picker}${!html && !picker ? '<div class="muted small">No Seller Central shipments to link yet. Made one just now? Sync from Seller Central.</div>' : ""}</div>`;
  }
  // Seller Central is the source of truth for a linked shipment: its contents in Shopify units by seller SKU, and per
  // product how far the prep shipment is off. unmapped: seller SKUs with no Shopify product (can't be reconciled).
  function reconPlan(sh, ships) {
    const bySku = new Map(), unmapped = [];
    for (const a of ships) for (const it of a.items) {
      const m = cache.skuUnits.get(it.sku); if (!m) { unmapped.push(it.sku); continue; }
      const x = bySku.get(it.sku) || { variant_id: m.vid, amazon_sku: it.sku, qty: 0 }; x.qty += it.qty * m.units; bySku.set(it.sku, x);
    }
    const lines = [...bySku.values()], pc = prepContents(sh), rows = [];
    for (const vid of new Set([...pc.keys(), ...lines.map(l => l.variant_id)])) {
      const o = pc.get(vid) || 0, n = lines.filter(l => l.variant_id === vid).reduce((t, l) => t + l.qty, 0);
      if (o === n) continue;
      const l = sh.lines.find(x => x.vid === vid), r = cache.rows.find(x => x.vid === vid);
      const best = lines.filter(x => x.variant_id === vid).sort((a2, b2) => b2.qty - a2.qty)[0];
      rows.push({ vid, title: (l && l.title) || (r && r.title) || "variant " + vid, sku: (l && l.sku) || (r && r.sku) || "", prep: o, amz: n,
        to: "prep", tsku: (best && best.amazon_sku) || (l && l.asku) || ((cache.byVariant.get(vid) || [])[0] || {}).sku || "" });
    }
    return { lines, rows, unmapped: [...new Set(unmapped)] };
  }
  // link (ids) and/or make the shipment match Seller Central. Differences in quantity are asked about first.
  function amzLinkAsk(sid, ids, how) {
    const sh = cache.shipments.find(x => x.id === String(sid)); if (!sh) return;
    const ships = [...(sh.amz || []), ...cache.amzShips.filter(a => ids.includes(a.id) && !(sh.amz || []).some(x => x.id === a.id))];
    const plan = reconPlan(sh, ships);
    if (plan.unmapped.length) {    // can't work out Shopify units: link only, and say why the quantities weren't matched
      if (ids.length) amzLink(sid, ids, how, false, null, `Seller Central has ${plan.unmapped.join(", ")}, which ${plan.unmapped.length === 1 ? "isn't" : "aren't"} mapped to a Shopify product, so the shipment's quantities weren't changed. Map ${plan.unmapped.length === 1 ? "it" : "them"} on the Amazon mapping tab, then use “Make it match Seller Central”.`);
      else note("bad", `Map ${esc(plan.unmapped.join(", "))} to a Shopify product first (Amazon mapping tab).`);
      return;
    }
    if (!plan.rows.length) return amzLink(sid, ids, how, false, { lines: plan.lines, dispose: [] });   // same quantities: just take Seller Central's listings
    if (!P.modal || P.modal.kind !== "ship" || P.modal.id !== String(sid)) openShipment(sid);
    P.modal.recon = { ids, how, rows: plan.rows, lines: plan.lines };
    renderModal();
    setTimeout(() => { const el = document.querySelector("#prep-mcard .recon"); if (el) el.scrollIntoView({ block: "nearest" }); }, 0);
  }
  function reconHtml(M) {
    const R = M.recon, shipped = M.status === "shipped";
    const opts = (r) => { const ls = cache.byVariant.get(r.vid) || [], list = ls.some(l => l.sku === r.tsku) || !r.tsku ? ls : [{ sku: r.tsku, asin: "" }, ...ls];
      return list.map(l => `<option value="${esc(l.sku)}" ${l.sku === r.tsku ? "selected" : ""}>${esc(l.sku)}${l.asin ? " · " + esc(l.asin) : ""}${(l.units || 1) !== 1 ? ` (${l.units}-pack)` : ""}</option>`).join("") + `<option value="" ${!r.tsku ? "selected" : ""}>Any listing (not earmarked)</option>`; };
    return `<div class="recon note warn"><b>Seller Central is the source of truth.</b> ${R.ids.length ? "Linking" : "Updating"} changes this shipment to Seller Central's quantities. What should happen to the difference?
      <div class="tbl-wrap"><table class="prept"><thead><tr><th class="l">Product</th><th>This shipment</th><th>Seller Central</th><th>Difference</th><th class="l">The difference</th></tr></thead><tbody>${R.rows.map(r => {
        const d = r.amz - r.prep, extra = -d;
        return `<tr><td class="l">${esc(r.title)}<div class="meta mono">${esc(r.sku)}</div></td><td>${n0(r.prep)}</td><td>${n0(r.amz)}</td><td class="${d < 0 ? "neg" : "pos"}">${d > 0 ? "+" : ""}${n0(d)}</td>
          <td class="l small">${extra > 0 ? `<label class="rradio"><input type="radio" name="rto-${esc(r.vid)}" data-rto="${esc(r.vid)}" value="prep" ${r.to === "prep" ? "checked" : ""}> ${shipped ? "Back into" : "Stays in"} the prep center for <select class="inp sm" data-rsku="${esc(r.vid)}" style="width:auto;max-width:260px">${opts(r)}</select></label>
              <label class="rradio"><input type="radio" name="rto-${esc(r.vid)}" data-rto="${esc(r.vid)}" value="shopify" ${r.to === "shopify" ? "checked" : ""}> Into Shopify inventory <span class="dim">(${n0(extra)} added to Shopify's available stock${shipped ? "" : ", taken out of the prep center"})</span></label>`
            : `${n0(d)} more ${shipped ? "come out of the prep center now" : "will come out of the prep center when it ships"}${!shipped && (prepHere(r.vid, r.tsku).qty + prepHere(r.vid, "").qty) < r.amz ? ' <span class="warnt">— the prep center doesn\'t have that many</span>' : ""}`}</td></tr>`; }).join("")}</tbody></table></div>
      <div class="row"><span class="dbtns right"><button class="btn" data-act="recon-cancel">Cancel</button><button class="btn primary" data-act="recon-go" ${P.busy ? "disabled" : ""}>${P.busy ? "Saving…" : R.ids.length ? "Link and update shipment" : "Update shipment"}</button></span></div></div>`;
  }
  async function amzLink(sid, ids, how, unlink, reconcile, warnText) {
    P.busy = true; if (P.modal) renderModal();
    try {
      const r = await JT.prep.shipLink({ shipment_id: Number(sid), amazon_ids: ids, how, unlink: !!unlink, ...(reconcile ? { reconcile } : {}) });
      P.busy = false;
      await load(true); render();
      if (P.modal && P.modal.kind === "ship" && P.modal.id === String(sid)) { if (reconcile) openShipment(sid); else { P.modal.sh = cache.shipments.find(x => x.id === String(sid)) || P.modal.sh; P.modal.amzPick = ""; P.modal.recon = null; renderModal(); } }
      const rc = r && r.reconcile;
      const parts = [unlink ? "Unlinked from Seller Central." : ids.length ? `Linked ${ids.length} Seller Central shipment${ids.length === 1 ? "" : "s"}.` : "Shipment updated to Seller Central's quantities."];
      if (rc && rc.to_prep) parts.push(`${n0(rc.to_prep)} unit${rc.to_prep === 1 ? "" : "s"} kept in the prep center.`);
      if (rc && rc.to_shopify) parts.push(`${n0(rc.to_shopify)} unit${rc.to_shopify === 1 ? "" : "s"} going back into Shopify inventory (the sync applies it in a minute or two).`);
      if (rc && rc.taken) parts.push(`${n0(rc.taken)} more taken out of the prep center.`);
      if (rc && rc.short) parts.push(`<span class="warnt">The prep center was ${n0(rc.short)} short — recount that product.</span>`);
      note(warnText ? "warn" : "info", parts.join(" ") + (warnText ? " " + esc(warnText) : ""));
    } catch (e) { P.busy = false; if (P.modal) renderModal(); note("bad", "Couldn't link: " + esc(JT.message(e))); }
  }
  // ===================== Amazon shipment checklist =====================
  // A prep shipment goes: placeholder tied to ASINs -> stock counted -> how it ships (FBA splits / fees OK / AWD) ->
  // incoming invoice received and combined with prep center stock -> created in Seller Central -> linked here ->
  // shipped -> Amazon receives it -> closed. Any time it can be put in an exception state with a note, to triage.
  const PLACEMENTS = [["optimized", "FBA · Amazon-optimized splits"], ["fees_ok", "FBA · fewer shipments, placement fees OK"], ["awd", "AWD"], ["other", "Other (see note)"]];
  const FLOW_STEPS = ["asin", "count", "method", "combine", "sc", "link", "ship", "close"];
  function flowOf(sh) {
    const lines = sh.lines.filter(l => l.qty > 0), ck = sh.checks || {}, amz = sh.amz || [], shipped = sh.status === "shipped";
    const t0 = (msOf(sh.created) || 0) - 3 * 864e5;
    const countedAt = (vid) => cache.moves.some(m => m[2] === vid && m[1] === "adjust" && (msOf(m[0]) || 0) >= t0);
    const counted = !!ck.counted || (lines.length > 0 && lines.every(l => countedAt(l.vid)));
    const noAsin = lines.filter(l => !l.asku).length;
    const short = shipped ? 0 : lines.reduce((t, l) => t + Math.max(0, l.qty - prepHere(l.vid, l.asku).qty), 0);
    const ue = amz.reduce((t, a) => t + a.ue, 0), ur = amz.reduce((t, a) => t + a.ur, 0), amzDone = amz.length > 0 && amz.every(a => a.status === "CLOSED" || (a.ue > 0 && a.ur >= a.ue));
    const S = {
      asin: { label: "Placeholder tied to ASINs", done: lines.length > 0 && !noAsin, past: shipped,
        text: !lines.length ? "Add the products going to Amazon." : noAsin ? `${noAsin} product${noAsin === 1 ? " isn't" : "s aren't"} tied to an Amazon listing yet — pick the listing (ASIN) for each.` : "Every product is tied to a listing." },
      count: { label: "Prep center stock counted", done: counted, past: shipped, check: "counted",
        text: counted ? (ck.counted ? `Marked counted ${when(ck.counted.at)}${ck.counted.by ? " · " + esc(ck.counted.by) : ""}.` : "Every product was counted since this shipment was set up.") : "Count each product on the shelf (Count) so the numbers are right." },
      method: { label: "How it ships", done: !!sh.placement || sh.dest === "AWD", past: shipped,
        text: sh.placement ? (PLACEMENTS.find(p => p[0] === sh.placement) || ["", sh.placement])[1] : sh.dest === "AWD" ? "AWD" : "FBA with Amazon's splits, fewer shipments with placement fees, or AWD." },
      combine: { label: "Incoming received & combined", done: !!ck.combined, past: shipped, check: "combined",
        text: ck.combined ? `Combined ${when(ck.combined.at)}${ck.combined.by ? " · " + esc(ck.combined.by) : ""}.` : short ? `${n0(short)} unit${short === 1 ? " is" : "s are"} still to arrive. Receive the invoice, then put it together with the prep center stock.` : "Everything is here — put it together in one place." },
      sc: { label: "Created in Seller Central", done: !!ck.sc_created || amz.length > 0, past: shipped, check: "sc_created",
        text: amz.length ? "Seller Central has it." : ck.sc_created ? `Marked created ${when(ck.sc_created.at)}.` : "Create the shipment in Send to Amazon." },
      link: { label: "Linked to Seller Central", done: amz.length > 0,
        text: amz.length ? `${amz.length} Amazon shipment${amz.length === 1 ? "" : "s"}: ${esc(amz.map(a => a.id).join(", "))}` : "Link it once Seller Central has made the shipment (suggestions show up on the card)." },
      ship: { label: "Shipped", done: shipped, text: shipped ? `Shipped ${when(sh.shipped)}${sh.shippedBy ? " · " + esc(sh.shippedBy) : ""}.` : "Mark it shipped when the boxes leave — that takes the units out of the prep center." },
      close: { label: "Received by Amazon & closed", done: !!sh.closed, ready: shipped && amzDone,
        text: sh.closed ? `Closed ${when(sh.closed)}${sh.closedBy ? " · " + esc(sh.closedBy) : ""}.` : amz.length ? `Amazon has received ${n0(ur)} of ${n0(ue)}${amzDone ? " — ready to close." : "."}` : shipped ? "Link the Seller Central shipments to follow receiving, or close it when Amazon has it all." : "After it ships." },
    };
    const steps = FLOW_STEPS.map(k => ({ k, ...S[k], ok: S[k].done || S[k].past }));
    const next = steps.find(s => !s.ok) || null;
    return { steps, next, doneN: steps.filter(s => s.ok).length };
  }
  const flowBar = (f) => `<div class="flowbar" title="${f.doneN} of ${f.steps.length} steps">${f.steps.map(s => `<span class="${s.ok ? "on" : ""}"></span>`).join("")}</div>`;
  function flowHtml(M) {
    const sh = cache.shipments.find(x => x.id === String(M.id)); if (!sh) return "";
    const f = flowOf(sh), ro = !FLOW;
    const act = (s) => {
      if (ro) return "";
      if (s.k === "method") return `<select id="pm-place" class="inp sm" style="width:auto"><option value="">Choose…</option>${PLACEMENTS.map(([v, l]) => `<option value="${v}" ${sh.placement === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
      if (s.k === "count" && !s.done) return `<button class="mini" data-flow="check:counted">Mark counted</button>`;
      if (s.check && !s.done && s.k !== "count") return `<button class="mini" data-flow="check:${s.check}">Mark done</button>`;
      if (s.check && (sh.checks || {})[s.check]) return `<button class="linkbtn small" data-flow="uncheck:${s.check}">Undo</button>`;
      if (s.k === "ship" && !s.done && sh.status === "started") return '<button class="mini primary" data-act="ship-go">Mark shipped</button>';
      if (s.k === "close") return s.done ? '<button class="linkbtn small" data-flow="reopen">Reopen</button>' : sh.status === "shipped" ? `<button class="mini ${s.ready ? "primary" : ""}" data-flow="close">Close shipment</button>` : "";
      return "";
    };
    const exc = sh.exception
      ? `<div class="note bad"><b>Exception</b> · ${esc(sh.exception)}<div class="meta">${sh.exceptionAt ? "since " + when(sh.exceptionAt) : ""}${sh.exceptionBy ? " · " + esc(sh.exceptionBy) : ""}</div>${ro ? "" : '<span class="dbtns"><button class="mini" data-flow="exc-edit">Edit</button><button class="mini primary" data-flow="exc-clear">Resolved</button></span>'}</div>` : "";
    const excEdit = M.excEdit != null ? `<div class="row"><input id="pm-exc" class="inp" style="flex:1" value="${esc(M.excEdit)}" placeholder="What's wrong — e.g. Amazon received 12 short, box damaged, wrong FNSKU"><button class="mini" data-flow="exc-cancel">Cancel</button><button class="mini primary" data-flow="exc-save">Save exception</button></div>` : "";
    return `<div class="flowbox"><div class="lanehead"><h3 class="psec" style="margin:0">Checklist</h3>${flowBar(f)}<span class="muted small">${f.next ? "Next: " + esc(f.next.label) : "All done"}</span>
        ${ro || sh.exception || M.excEdit != null ? "" : '<button class="linkbtn small right" data-flow="exc-edit">Flag a problem</button>'}</div>
      ${exc}${excEdit}${ro ? '<div class="small muted">The checklist starts working after the next database update.</div>' : ""}
      <ol class="flow">${f.steps.map((s, i) => `<li class="${s.ok ? "ok" : f.next === s ? "next" : ""}"><span class="fn">${s.ok ? "✓" : i + 1}</span><div class="ft"><b>${esc(s.label)}</b><span>${s.text}</span></div><div class="fa">${act(s)}</div></li>`).join("")}</ol></div>`;
  }
  async function flowDo(sid, body, msg) {
    try {
      await JT.prep.shipFlow({ id: Number(sid), ...body });
      await load(true); render();
      if (P.modal && P.modal.kind === "ship" && P.modal.id === String(sid)) { P.modal.sh = cache.shipments.find(x => x.id === String(sid)) || P.modal.sh; P.modal.dest = P.modal.sh.dest; P.modal.excEdit = null; renderModal(); }   // how it ships sets FBA / AWD (migration 104)
      if (msg) note("info", msg);
    } catch (e) { note("bad", "Couldn't update the shipment: " + esc(JT.message(e))); }
  }
  function flowClick(M, b) {
    const f = b.dataset.flow, [a, k] = f.split(":");
    if (a === "check") return flowDo(M.id, { check: { [k]: true } });
    if (a === "uncheck") return flowDo(M.id, { check: { [k]: false } });
    if (a === "close") return flowDo(M.id, { close: true }, "Shipment closed.");
    if (a === "reopen") return flowDo(M.id, { close: false });
    if (a === "exc-edit") { const sh = cache.shipments.find(x => x.id === String(M.id)); M.excEdit = (sh && sh.exception) || ""; renderModal(); setTimeout(() => { const i = $("pm-exc"); if (i) i.focus(); }, 0); return; }
    if (a === "exc-cancel") { M.excEdit = null; renderModal(); return; }
    if (a === "exc-save") { const t = (M.excEdit || "").trim(); if (!t) { note("bad", "Say what's wrong first."); return; } return flowDo(M.id, { exception: t }, "Shipment flagged as an exception."); }
    if (a === "exc-clear") return flowDo(M.id, { exception: "" }, "Exception resolved.");
  }
  const SHVIEWS = { open: (x) => x.status !== "shipped" && !x.closed, amazon: (x) => x.status === "shipped" && !x.closed, exc: (x) => !!x.exception && !x.closed, closed: (x) => !!x.closed };
  function renderShipments() {
    const d = cache, el = $("prep-ships");
    if (!SHVIEWS[P.shipView]) P.shipView = "open";
    document.querySelectorAll("#prep-shview button").forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.v === P.shipView)); const c = b.querySelector("span"); if (c && SHVIEWS[b.dataset.v]) c.textContent = d.shipments.filter(SHVIEWS[b.dataset.v]).length; });
    const list = d.shipments.filter(SHVIEWS[P.shipView]).sort(P.shipView === "closed" ? (a, b) => String(b.closed).localeCompare(String(a.closed))
      : P.shipView === "amazon" ? (a, b) => String(b.shipped).localeCompare(String(a.shipped))
      : (a, b) => (b.exception ? 1 : 0) - (a.exception ? 1 : 0) || (a.status === "started" ? 0 : 1) - (b.status === "started" ? 0 : 1) || String(b.updated).localeCompare(String(a.updated)));
    const skuLink = (sku) => `<a class="olink mono" href="https://sellercentral.amazon.com/skucentral?mSku=${encodeURIComponent(sku)}&condition=New&ref_=myp_skuc" target="_blank" rel="noopener" title="Open in Seller Central">${esc(sku)}</a>`;
    const asinOf = (vid, asku) => ((cache.byVariant.get(vid) || []).find(l => l.sku === asku) || {}).asin || "";
    const card = (sh) => {
      const units = sh.lines.reduce((a, l) => a + l.qty, 0), cost = sh.lines.reduce((a, l) => a + l.qty * (l.cost || 0), 0);
      const iss = issuesOf(sh).filter(x => !["noid", "amzshipped", "nolisting"].includes(x.kind)), lvl = sh.exception ? "bad" : worst(issuesOf(sh)), sum = issueSummary(iss), f = flowOf(sh);
      const when2 = sh.closed ? `Closed ${when(sh.closed)}` : sh.status === "shipped" ? `Shipped ${when(sh.shipped)}${sh.shippedBy ? " · " + esc(sh.shippedBy) : ""}` : sh.status === "started" ? `Started ${when(sh.started)}` : `Created ${when(sh.created)}${sh.createdBy ? " · " + esc(sh.createdBy) : ""}`;
      const contents = contentsOf(sh), ls = sh.lines.filter(l => l.qty > 0);
      const prod = (l) => `<div class="sc-prod"><span class="mono">${esc(l.sku || "no SKU")}</span>${l.vendor ? ` · ${esc(l.vendor)}` : ""}${ls.length > 1 ? ` · ${n0(l.qty)}` : ""}<br>${l.asku ? `<span class="mono">${esc(asinOf(l.vid, l.asku) || "no ASIN")}</span> · ${skuLink(l.asku)}` : '<span class="warnt">no Amazon listing picked</span>'}</div>`;
      return `<div class="shipcard ${sh.status}${lvl === "bad" || lvl === "warn" ? " issue-" + lvl : ""}" data-sid="${sh.id}" tabindex="0" role="button" aria-label="Open shipment: ${esc(contents)}${sum ? " — needs attention: " + esc(sum) : ""}">
        <div class="sc-title" title="${esc(sh.lines.map(l => n0(l.qty) + " × " + l.title).join("\n"))}">${esc(contents)}</div>
        ${ls.slice(0, 2).map(prod).join("")}${ls.length > 2 ? `<div class="sc-prod dim">+ ${ls.length - 2} more product${ls.length - 2 === 1 ? "" : "s"}</div>` : ""}
        <div class="sc-qty"><b class="num">${n0(units)}</b><span>unit${units === 1 ? "" : "s"}</span><span class="dim">· ${sh.lines.length} product${sh.lines.length === 1 ? "" : "s"} · ${m0(cost)}</span></div>
        <div class="sc-meta">${sh.closed ? '<span class="pill ok">Closed</span>' : statusPill(sh.status)}<span class="pill ${sh.dest === "AWD" ? "manual" : "web"}">${esc(sh.dest)}</span><span class="mono">${esc(shipTitle(sh))}</span></div>
        ${amzLine(sh)}
        ${sh.exception ? `<div class="sc-issue"><span aria-hidden="true">●</span><span>Exception: ${esc(sh.exception)}</span></div>` : sum ? `<div class="sc-issue"><span aria-hidden="true">${lvl === "bad" ? "●" : "▲"}</span><span>${esc(sum)}</span></div>` : ""}
        ${FLOW && !sh.closed ? `<div class="sc-flow">${flowBar(f)}<span class="small">${f.next ? "Next: " + esc(f.next.label) : "Ready to close"}</span></div>` : ""}
        <div class="sc-foot"><span class="dim small">${when2}</span></div>
      </div>`;
    };
    const empty = { open: "", amazon: '<div class="muted small">Nothing at Amazon waiting to be received.</div>', exc: '<div class="muted small">No exceptions.</div>', closed: '<div class="muted small">No shipments closed in the last 90 days.</div>' }[P.shipView];
    el.innerHTML = (P.shipView === "open" ? `<button class="shipcard newcard" data-sact="new"><span class="plus">+</span><b>New shipment</b><span class="dim small">A placeholder for the ASINs you're sending</span></button>` : "")
      + (list.map(card).join("") || empty);
  }
  // ===================== Incoming Inventory: vendor orders coming in =====================
  // draft -> ordered -> invoice -> packing slip -> received -> shipped. Receiving puts the units in the prep center
  // (in parts if needed); "shipped" is when the received stock goes out again, normally on an Amazon Outgoing shipment
  // made from the order. Exceptions work like the outgoing ones: the card turns amber, the popup says how to fix it.
  const OSTAGES = [["draft", "Draft"], ["ordered", "Ordered"], ["invoiced", "Invoiced"], ["partial", "Partly received"], ["received", "Received"], ["qb_ready", "QB Ready"], ["complete", "Complete"]];
  const OSTAGE = new Map(OSTAGES), OORDER = OSTAGES.map(x => x[0]);
  const PRE = ["draft", "ordered", "invoiced"], OGOT = ["partial", "received", "qb_ready", "complete"];
  const ONEXT = { draft: ["ordered", "Mark ordered"], ordered: ["invoiced", "Mark invoiced"], received: ["qb_ready", "Mark QB ready"], qb_ready: ["complete", "Mark complete"] };
  const OPREV = { ordered: "draft", invoiced: "ordered", partial: "invoiced", received: "invoiced", qb_ready: "received", complete: "qb_ready" };
  const OPILL = { draft: "pos", ordered: "manual", invoiced: "other", partial: "warn", received: "ok", qb_ready: "web", complete: "ok" };
  const RECEIVED_IDLE_DAYS = 14;
  const lineCost = (l) => l.unitCost != null ? l.unitCost : l.shopCost;
  const poLabel = (po) => /^po\b/i.test(po) ? po : "PO " + po;
  const orderTitle = (o) => o.po ? poLabel(o.po) : `Order #${o.id}`;
  const today = () => window.JTDate.today();
  const shortDate = (ds) => ds ? new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";

  // o: {id, status, vendor, po, expected, invoiceId, inv, shortOk, stageAt, shipments, lines: [{key, vid, asku, title, sku, pid, ordered, received, unitCost, shopCost}]}
  function orderIssuesOf(o) {
    const out = [];
    if (!o || o.status === "complete") return out;
    const at = OORDER.indexOf(o.status), lines = o.lines.filter(l => l.ordered > 0 || l.received > 0);
    if (o.id && !o.lines.length) out.push({ lvl: "warn", kind: "empty", title: "No products on this order", text: "Add what was ordered so it can be received into the prep center.",
      fixes: [{ label: "Add a product", fix: "focus", arg: "po-add" }] });
    if (OGOT.includes(o.status)) {
      const short = o.status === "partial" ? lines.filter(l => l.received < l.ordered) : [], over = lines.filter(l => l.received > l.ordered);
      if (short.length && !o.shortOk) out.push({ lvl: "warn", kind: "partial", title: `Not received in full · ${short.length} product${short.length === 1 ? "" : "s"}`,
        text: short.slice(0, 4).map(l => `${esc(l.title)}: ${n0(l.received)} of ${n0(l.ordered)}`).join(" · ") + (short.length > 4 ? " · …" : "")
          + ". If the rest is coming, receive it when it lands. If the vendor won't send it, close the order short (and ask them for a credit).",
        fixes: [{ label: "Receive the rest", fix: "orecv" }, { label: "Close short", fix: "oshort" }, ...(o.invoiceId ? [{ label: "Open the invoice", fix: "oinv" }] : [])] });
      if (over.length) out.push({ lvl: "info", kind: "over", title: `More arrived than ordered · ${over.length} product${over.length === 1 ? "" : "s"}`,
        text: over.map(l => `${esc(l.title)}: ${n0(l.received)} for ${n0(l.ordered)} ordered`).join(" · ") + ". Check it against the packing slip and invoice.", fixes: [] });
      const ds = ["partial", "received"].includes(o.status) ? daysSince(o.stageAt.received || o.stageAt.partial) : null;
      const outgoing = (o.shipments || []).filter(sh => sh.status !== "shipped");
      if (ds != null && ds >= RECEIVED_IDLE_DAYS && !outgoing.length) out.push({ lvl: "info", kind: "idle", title: `Received ${ds} days ago, not on an Amazon shipment yet`,
        text: "Create the Amazon Outgoing shipment for it, or mark it shipped if it went out another way.", fixes: [{ label: "Create Amazon shipment", fix: "oship" }] });
    }
    if (["ordered", "invoiced"].includes(o.status) && o.expected && o.expected < today()) {
      const late = Math.round((new Date(today() + "T12:00:00Z") - new Date(o.expected + "T12:00:00Z")) / 864e5);
      out.push({ lvl: "warn", kind: "late", title: `Late · expected ${shortDate(o.expected)} (${late} day${late === 1 ? "" : "s"} ago)`,
        text: "Chase the vendor for a ship date and update the expected date, or receive it if it's here.",
        fixes: [{ label: "Receive it", fix: "orecv" }, { label: "Change expected date", fix: "focus", arg: "po-exp" }] });
    }
    if (at >= OORDER.indexOf("invoiced") && !o.invoiceId) out.push({ lvl: "warn", kind: "noinv", title: "No invoice linked",
      text: "Link the vendor's invoice from the Invoices tab so costs and quantities can be checked against it. Upload it there first if it isn't in yet.",
      fixes: [{ label: "Link invoice", fix: "focus", arg: "po-inv" }, { label: "Go to Invoices", fix: "tab", arg: "invoices" }] });
    if (o.inv && o.inv.total != null) {
      const tot = lines.reduce((a, l) => a + l.ordered * (lineCost(l) || 0), 0);
      if (tot > 0 && Math.abs(o.inv.total - tot) > Math.max(1, tot * 0.01)) out.push({ lvl: "warn", kind: "invdiff",
        title: `Invoice total ${m(o.inv.total)} vs. order ${m(tot)}`, text: `A difference of ${m(o.inv.total - tot)}: a price change, a product missing on one side, a short shipment, or invoice lines that aren't products (freight, fees). If it's only freight or fees, this can be ignored.`,
        fixes: [{ label: "Fill lines from the invoice", fix: "ofill" }, { label: "Open the invoice", fix: "oinv" }] });
    }
    if (o.status === "draft" && o.kind === "booking") {
      if (!o.placeBy) out.push({ lvl: "info", kind: "noplace", title: "No place-by date", text: "Set when this booking order has to be placed with the vendor.", fixes: [{ label: "Set the date", fix: "focus", arg: "po-placeby" }] });
      else if (o.placeBy < today()) out.push({ lvl: "warn", kind: "placeby", title: `Booking order was due to be placed ${shortDate(o.placeBy)}`, text: "Place it with the vendor and mark it ordered, or push the date out.",
        fixes: [{ label: "Mark ordered", fix: "onext" }, { label: "Change the date", fix: "focus", arg: "po-placeby" }] });
    }
    const zero = o.lines.filter(l => !(l.ordered > 0) && !(l.received > 0));
    if (zero.length && at < OORDER.indexOf("partial")) out.push({ lvl: at >= 1 ? "warn" : "info", kind: "noqty", title: `No quantity for ${zero.length} product${zero.length === 1 ? "" : "s"}`,
      text: zero.slice(0, 4).map(l => esc(l.title)).join(" · ") + (zero.length > 4 ? " · …" : "") + " — added from On The List without a quantity.", fixes: [{ label: "Enter quantities", fix: "focuskq", k: zero[0].key }] });
    if (at >= 1 && !o.po) out.push({ lvl: "info", kind: "nopo", title: "No PO number", text: "Add the PO # so the invoice and packing slip can be matched to this order.", fixes: [{ label: "Add PO #", fix: "focus", arg: "po-po" }] });
    for (const l of lines) if (lineCost(l) == null) out.push({ lvl: "warn", kind: "nocost", title: `No cost for ${esc(l.title)}`,
      text: "Enter the unit cost from the invoice on this order, or set a cost in Shopify.", fixes: [...(l.pid ? [{ label: "Open in Shopify", href: `${ADMIN}/products/${l.pid}/variants/${l.vid}` }] : []), { label: "Enter the cost", fix: "focuskc", k: l.key }] });
    const rank = { bad: 0, warn: 1, info: 2 };
    return out.sort((a, b) => rank[a.lvl] - rank[b.lvl]);
  }
  const OKIND = { placeby: "past place-by date", noqty: "no quantity", noplace: "no place-by date", partial: "not received in full", late: "late", noinv: "no invoice", invdiff: "invoice doesn't match", nocost: "missing cost", empty: "no products", idle: "waiting to ship", nopo: "no PO #", over: "extra received" };
  // shared with the Purchase orders tab
  window.JTOrderIssues = { orderIssuesOf, OSTAGES, ONEXT, OPREV, OPILL, poLabel, get orderSummary() { return orderSummary; } };
  const orderSummary = (list) => { const by = new Map(); for (const x of list) if (x.lvl !== "info") by.set(x.kind, (by.get(x.kind) || 0) + 1); return [...by].map(([k, n]) => (n > 1 && k === "nocost" ? n + " products " : "") + OKIND[k]).join(" · "); };


  // Incoming shipments: what's coming to the prep center and when, so Amazon shipments can be lined up ahead of it.
  // Groups, in date order: stock from open POs that's here and not on an Amazon shipment yet; each invoice not
  // received yet, by its expected arrival (set here; falls back to the PO's expected date). Orders that aren't
  // invoiced yet aren't shown: the invoice is what's actually coming (Brian, Oct 7). Ship plans a placeholder Amazon shipment for a product; "Plan shipment" does a whole invoice.
  function renderIncoming() {
    const el = $("prep-inc"), panel = $("prep-inc-panel"); if (!el || !cache) return;
    const q = P.q.trim().toLowerCase();
    const match = (r) => (P.vendor === "all" || r.vendor === P.vendor) && (!q || [r.title, r.sku, r.vendor, r.asku, r.target && r.target.title, r.target && r.target.asin].join(" ").toLowerCase().includes(q));
    const po = (cache.poRows || []).filter(r => r.left > 0), hid = po.filter(r => r.hidden), usePo = P.incHidden ? po : po.filter(r => !r.hidden);
    const invs = cache.invoicesOpen || [], td = today();
    const groups = [];
    const here = usePo.filter(r => r.ready > 0 && match(r)).map(r => ({ ...r, n: r.ready, kind: "po" }));
    if (here.length) groups.push({ key: "here", sort: "0", head: `<b>In the prep center now</b> <span class="muted small">received from open POs, not on an Amazon shipment yet</span>`, rows: here });
    for (const iv of invs) {
      const rows = iv.lines.filter(l => l.left > 0 && match(l)).map(l => ({ ...l, n: l.left, oid: iv.oid, kind: "inv" }));
      if (!rows.length) continue;
      const late = iv.when && iv.when < td, units = rows.reduce((t, r) => t + r.n, 0), o = iv.order;
      groups.push({ key: "inv" + iv.id, sort: "1" + (iv.when || "9999"), iv, rows,
        head: `<span class="arr"><label class="small muted" for="arr-${esc(iv.id)}">Arriving</label> <input type="date" class="inp sm" id="arr-${esc(iv.id)}" data-arrival="${esc(iv.id)}" value="${esc(iv.arrival)}" ${FLOW ? "" : "disabled title=\"After the next database update\""}>${!iv.arrival && iv.when ? ` <span class="small muted">PO says ${shortDate(iv.when)}</span>` : !iv.when ? ' <span class="pill warn">set a date</span>' : ""}${late ? ' <span class="pill miss">late</span>' : ""}</span>
          <b>${esc(iv.vendor)}</b> invoice <span class="mono">${esc(iv.no || "#" + iv.id)}</span>${iv.date ? ` <span class="small muted">· ${shortDate(iv.date)}</span>` : ""}
          ${o ? ` · <button class="linkbtn small" data-act="gotoorder" data-oid="${esc(o.id)}">${esc(o.po ? poLabel(o.po) : "order #" + o.id)}</button>` : ""} <span class="small muted">· ${n0(units)} units</span>
          <button class="mini right" data-act="plan-inv" data-iid="${esc(iv.id)}" title="Set up a placeholder Amazon shipment with everything on this invoice">Plan shipment</button>` });
    }
    groups.sort((a, b) => a.sort.localeCompare(b.sort));
    panel.hidden = !groups.length && !hid.length && !invs.length;
    $("prep-inc-hid").innerHTML = hid.length ? `<button class="linkbtn small" data-act="inc-hidden">${P.incHidden ? "Hide removed" : `Show removed (${hid.length})`}</button>` : "";
    const tot = (pred) => groups.filter(pred).reduce((t, g) => t + g.rows.reduce((u, r) => u + r.n, 0), 0);
    const nInv = groups.filter(g => g.iv).length;
    $("prep-inc-sum").textContent = `${n0(tot(g => g.key === "here"))} here now · ${n0(tot(g => !!g.iv))} arriving on ${nInv} invoice${nInv === 1 ? "" : "s"}`;
    if (!groups.length) { el.innerHTML = `<div class="muted small">Nothing coming in${hid.length ? ` (${hid.length} removed from the list)` : ""}.</div>`; return; }
    const row = (r) => {
      const tg = r.target, ph = prepHere(r.vid, r.asku), sh = cache.alloc.get(r.vid + "|" + r.asku) || 0;
      const lst = tg ? `${esc(tg.title || tg.asin || "")}<div class="meta"><span class="mono">${esc(r.asku)}</span>${tg.asin ? ` · <span class="mono">${esc(tg.asin)}</span>` : ""}</div>` : `<span class="dim">Any listing</span><div class="meta">${r.listings.length ? `${r.listings.length} mapped listing${r.listings.length === 1 ? "" : "s"}` : "no Amazon listing mapped"}</div>`;
      return `<tr class="prodrow" data-prod="${esc(r.vid)}" data-psku="${esc(r.asku)}" title="Click for everything about this product"><td class="l">${r.pid ? `<a class="olink" href="${ADMIN}/products/${esc(r.pid)}/variants/${esc(r.vid)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}<div class="meta"><span class="mono">${esc(r.sku) || "no SKU"}</span> · ${esc(r.vendor)}</div></td>
        <td class="l small">${lst}</td>
        <td><b>${n0(r.n)}</b>${r.kind === "inv" && r.got ? `<div class="meta">${n0(r.got)} already in</div>` : ""}${r.backorder ? '<div class="meta"><span class="pill warn">backordered</span></div>' : ""}</td>
        <td>${ph.qty ? n0(ph.qty) : '<span class="dim">0</span>'}${ph.other ? `<div class="meta">+ ${n0(ph.other)} ${r.asku ? "not earmarked" : "earmarked"}</div>` : ""}</td>
        <td>${sh ? n0(sh) : '<span class="dim">—</span>'}</td>
        <td>${r.cost == null ? '<span class="pill miss">No cost</span>' : m(r.cost)}</td>
        <td class="l"><span class="rbtns">${r.hidden ? `<span class="pill pos">removed</span><button class="mini" data-act="inc-show" data-vid="${esc(r.vid)}" data-sku="${esc(r.asku)}" data-oid="${esc(r.oid)}">Put back</button>`
          : `<button class="mini ${r.kind === "po" && r.ready ? "primary" : ""}" data-act="ship" data-vid="${esc(r.vid)}" data-sku="${esc(r.asku)}" data-oid="${esc(r.oid || "")}" data-n="${r.n}" title="Put these units on an Amazon shipment (a placeholder until they're here)">Ship</button>${r.kind === "po" ? `<button class="mini" data-act="inc-hide" data-vid="${esc(r.vid)}" data-sku="${esc(r.asku)}" data-oid="${esc(r.oid)}" title="Take this off the list (e.g. backordered for a long time). The PO keeps it; it comes back if more arrive.">Remove</button>` : ""}`}</span></td></tr>`;
    };
    el.innerHTML = `<div class="tbl-wrap"><table class="prept inct"><thead><tr><th class="l">Shopify product</th><th class="l">For Amazon listing</th><th>Coming</th><th title="Units of this product in the prep center now, for this listing">At prep center</th><th>In shipments</th><th>Unit cost</th><th class="l"></th></tr></thead><tbody>${
      groups.map(g => `<tr class="grp"><td class="l" colspan="7"><div class="grph">${g.head}</div></td></tr>${g.rows.map(row).join("")}`).join("")}</tbody></table></div>`;
  }
  // a placeholder Amazon shipment with everything still to come on an invoice
  function planInvoice(iid) {
    const iv = (cache.invoicesOpen || []).find(x => x.id === String(iid)); if (!iv) return;
    const ls = iv.lines.filter(l => l.left > 0), lines = [], qty = {};
    for (const l of ls) { const k = l.vid + "|" + l.asku; if (!lines.includes(k)) lines.push(k); qty[k] = String((Number(qty[k]) || 0) + l.left); }
    P.modal = { kind: "ship", id: null, status: "open", shipment: "", dest: "FBA", note: `${iv.vendor} invoice ${iv.no || "#" + iv.id}`, lines, qty, info: Object.fromEntries(ls.map(l => [l.vid + "|" + l.asku, l])),
      add: "", confirm: false, fromRow: null, ...(iv.oid ? { orderId: iv.oid } : {}) };
    renderModal();
  }
  // prep-center stock of a product for one listing (asku "" = not earmarked), the rest of that product's stock, and
  // how much of this listing's stock is in shipments in progress
  function prepHere(vid, asku) {
    let qty = 0, other = 0;
    for (const x of cache.rows) if (x.vid === vid) { if (x.asku === (asku || "")) qty += x.qty; else if (!asku || !x.asku) other += x.qty; }   // other: earmarked stock for "any listing", unearmarked stock for a listing
    return { qty, other, inShip: cache.alloc.get(vid + "|" + (asku || "")) || 0 };
  }
  // Incoming Inventory is what's coming to the prep center: POs with prep-center lines (a PO split with the
  // Shopify store shows only its prep-center part), and empty POs not set to go to the Shopify store.
  function incoming(orders) {
    return orders.filter(o => o.lines.some(l => l.dest === "prep") || (!o.lines.length && o.into !== "shopify"))
      .map(o => o.lines.some(l => l.dest !== "prep") ? { ...o, lines: o.lines.filter(l => l.dest === "prep"), split: true } : o);
  }
  // ---------- order popup ----------
  let invList = null;
  async function invoices() {
    if (invList) return invList;
    const r = await JT.rows(["i.id::text", "i.vendor", "i.invoice_no", "i.invoice_date::text", "(select sum(coalesce(l.amount, l.qty * l.unit_cost)) from jt.invoice_lines l where l.invoice_id = i.id)"],
      "from jt.invoices i order by i.invoice_date desc nulls last, i.id desc limit 500", true);
    invList = r.map(x => ({ id: x[0], vendor: x[1] || "", no: x[2] || "", date: x[3] || "", total: x[4] == null ? null : +x[4] }));
    return invList;
  }
  function openOrder(id) {
    if (window.JTPO) { P.modal = null; renderModal(); window.JTPO.open(id || null); return; }    // orders are edited on the Purchase orders tab
    const o = id ? cache.orders.find(x => x.id === String(id)) : null;
    P.modal = { kind: "order", id: o ? o.id : null, status: o ? o.status : "draft", vendor: o ? o.vendor : "", po: o ? o.po : "", expected: o ? o.expected : "", invoiceId: o ? o.invoiceId : "",
      okind: o ? o.kind : "order", placeBy: o ? o.placeBy : "",
      note: o ? o.note : "", shortOk: o ? o.shortOk : false, o, add: "", recv: null, confirm: false,
      lines: o ? o.lines.map(l => ({ ...l, ordered: String(l.ordered), cost: l.unitCost == null ? "" : String(+l.unitCost) })) : [] };
    catalog().then(() => { if (P.modal && P.modal.kind === "order") renderModal(); }).catch(() => {});
    invoices().then(() => { if (P.modal && P.modal.kind === "order") renderModal(); }).catch(() => {});
    renderModal(); if (!o) setTimeout(() => { const i = $("po-vendor"); if (i) i.focus(); }, 0);
  }
  // the popup's order as orderIssuesOf reads it
  function draftOrder(M) {
    const inv = M.invoiceId && invList ? invList.find(x => x.id === String(M.invoiceId)) : M.o && M.o.inv;
    return { id: M.id, status: M.status, vendor: M.vendor, po: M.po.trim(), expected: M.expected, kind: M.okind, placeBy: M.placeBy, invoiceId: M.invoiceId || null, inv: M.invoiceId ? inv || null : null,
      shortOk: M.shortOk, stageAt: M.o ? M.o.stageAt : {}, shipments: M.o ? M.o.shipments : [],
      lines: M.lines.map(l => ({ ...l, ordered: Number(l.ordered) || 0, unitCost: l.cost === "" ? null : Number(l.cost) })) };
  }
  // products to add: Amazon seller SKU / ASIN (through the mappings), else the Shopify catalog
  function findProducts(text) {
    const t = String(text || "").trim(); if (!t || !cat) return [];
    const a = cache.byAmz.get(t.toLowerCase());
    if (a) { const v = cat.find(x => x.vid === a.vid); if (v) return [{ ...v, asku: a.asku }]; }
    const exact = cat.filter(v => v.sku.toLowerCase() === t.toLowerCase() || v.barcode === t);
    return (exact.length ? exact : searchCat(t)).map(v => ({ ...v, asku: "" }));
  }
  function addOrderLine(v, asku) {
    const M = P.modal, key = okey(v.vid, asku, "prep");
    if (!M.lines.some(l => l.key === key)) M.lines.push({ key, vid: v.vid, asku: asku || "", dest: "prep", title: v.title, sku: v.sku, vendor: v.vendor, pid: "", shopCost: v.cost, ordered: "", cost: "", received: 0, unitCost: null });
    if (!M.vendor && v.vendor) M.vendor = v.vendor;
    M.add = ""; renderModal();
    setTimeout(() => { const i = document.querySelector(`#prep-modal input[data-ok="${CSS.escape(key)}"]`); if (i) i.focus(); }, 0);
  }
  function orderModalHtml(M) {
    const got = M.status === "received" || M.status === "shipped", ro = M.status === "shipped", editLines = !got && !M.recv;
    const iss = orderIssuesOf(draftOrder(M));
    const at = OORDER.indexOf(M.status);
    const steps = OSTAGES.map(([k, n], i) => {
      const click = M.id && !got && PRE.includes(k) && k !== M.status;
      return `<${click ? "button" : "span"} class="step ${k === M.status ? "on" : i < at ? "done" : ""}" ${click ? `data-ogo="${k}" title="Move to ${n}"` : ""}>${n}</${click ? "button" : "span"}>`;
    }).join('<span class="step-sep">→</span>');
    const vendors = cat ? [...new Set(cat.map(v => v.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b)) : [];
    const invs = (invList || []).filter(x => !M.vendor || x.vendor.toLowerCase() === M.vendor.toLowerCase() || x.id === String(M.invoiceId));
    const found = editLines && M.add.trim() ? findProducts(M.add) : [];
    let units = 0, cost = 0, rec = 0;
    for (const l of M.lines) { const q = Number(l.ordered) || 0; units += q; rec += l.received || 0; cost += q * ((l.cost !== "" ? Number(l.cost) : l.shopCost) || 0); }
    const listingSel = (l) => { const ls = cache.byVariant.get(l.vid) || [];
      if (l.dest === "shopify") return editLines ? `<select class="inp sm" data-odest="${esc(l.key)}" style="width:auto"><option value="prep">Prep center</option><option value="shopify" selected>Shopify store</option></select>` : '<span class="pill pos">Shopify store</span>';
      if (!editLines) return l.asku ? `<span class="mono">${esc(l.asku)}</span>` : '<span class="dim">Any listing</span>';
      return `<select class="inp sm" data-osku="${esc(l.key)}" style="width:auto;max-width:190px"><option value="">Any listing (assign later)</option>${ls.map(x => `<option value="${esc(x.sku)}" ${x.sku === l.asku ? "selected" : ""} title="${esc(x.title || "")}">${esc(listingLabel(x))}</option>`).join("")}${l.asku && !ls.some(x => x.sku === l.asku) ? `<option selected>${esc(l.asku)}</option>` : ""}<option value="@shopify">→ Shopify store instead</option></select>`; };
    let recvUnits = 0; if (M.recv) for (const k in M.recv) recvUnits += Number(M.recv[k]) || 0;
    const head = `<tr><th class="l">Product</th><th class="l">For</th><th>Ordered</th>${got || M.recv ? "<th>Received</th>" : ""}${M.recv ? "<th>Arrived now</th>" : ""}<th>Unit cost</th><th>Ext.</th>${editLines ? "<th></th>" : ""}</tr>`;
    const rowsH = M.lines.map(l => { const q = Number(l.ordered) || 0, c = l.cost !== "" ? Number(l.cost) : l.shopCost;
      return `<tr><td class="l">${esc(l.title)}<div class="meta"><span class="mono">${esc(l.sku)}</span>${l.vendor ? " · " + esc(l.vendor) : ""}</div></td>
        <td class="l small">${listingSel(l)}</td>
        <td>${editLines ? `<input class="inp num sm" data-ok="${esc(l.key)}" value="${esc(l.ordered)}" inputmode="numeric" placeholder="0" style="width:72px">` : n0(q)}</td>
        ${got || M.recv ? `<td class="${l.received < q ? "warnt" : ""}">${n0(l.received)}</td>` : ""}
        ${M.recv ? `<td><input class="inp num sm" data-rk="${esc(l.key)}" value="${esc(M.recv[l.key] ?? "")}" inputmode="numeric" placeholder="0" style="width:72px"></td>` : ""}
        <td>${editLines || (got && !ro) ? `<input class="inp num sm" data-oc="${esc(l.key)}" value="${esc(l.cost)}" inputmode="decimal" placeholder="${l.shopCost != null ? (+l.shopCost).toFixed(2) : "cost"}" style="width:80px" ${got ? "disabled" : ""}>` : m(c)}</td>
        <td>${c == null || isNaN(c) ? '<span class="dim">—</span>' : m0(q * c)}</td>
        ${editLines ? `<td><button class="linkbtn small" data-orm="${esc(l.key)}" aria-label="Remove ${esc(l.title)}">✕</button></td>` : ""}</tr>`; }).join("");
    const inv = M.invoiceId && invList ? invList.find(x => x.id === String(M.invoiceId)) : null;
    const out = M.o ? (M.o.shipments || []) : [];
    return `<div class="panel-head"><h2>${M.id ? esc(M.vendor || "Vendor order") + " · " + esc(M.po ? poLabel(M.po) : "#" + M.id) : "New vendor order"}</h2><span class="steps six">${steps}</span>${M.id && window.JTPO ? `<button class="mini" data-fix="pofull">Open in Purchase orders</button>` : ""}<button class="mini" data-act="close">Close</button></div>
      ${issuesHtml(iss)}
      <div class="pmgrid">
        <label class="stack" for="po-vendor">Vendor<input id="po-vendor" class="inp" list="po-vendors" value="${esc(M.vendor)}" ${got ? "disabled" : ""} autocomplete="off"><datalist id="po-vendors">${vendors.map(v => `<option value="${esc(v)}">`).join("")}</datalist></label>
        <label class="stack" for="po-po">PO #<input id="po-po" class="inp mono" value="${esc(M.po)}" ${ro ? "disabled" : ""}></label>
        <label class="stack">Type<span class="seg" id="po-kind"><button data-okind="order" aria-pressed="${M.okind !== "booking"}" ${M.status !== "draft" ? "disabled" : ""}>Order</button><button data-okind="booking" aria-pressed="${M.okind === "booking"}" ${M.status !== "draft" ? "disabled" : ""}>Booking</button></span></label>
        ${M.okind === "booking" ? `<label class="stack" for="po-placeby">Place by<input id="po-placeby" class="inp" type="date" value="${esc(M.placeBy)}" ${M.status !== "draft" ? "disabled" : ""}></label>` : ""}
        <label class="stack" for="po-exp">Expected<input id="po-exp" class="inp" type="date" value="${esc(M.expected)}" ${ro ? "disabled" : ""}></label>
        <label class="stack" for="po-inv">Invoice<select id="po-inv" class="inp" ${ro ? "disabled" : ""}><option value="">${invList ? (invs.length ? "— not linked —" : M.vendor ? "No invoices from " + esc(M.vendor) + " yet" : "— not linked —") : "Loading invoices…"}</option>${invs.map(x => `<option value="${x.id}" ${x.id === String(M.invoiceId) ? "selected" : ""}>${esc(x.no || "#" + x.id)} · ${esc(x.date || "no date")}${x.total != null ? " · " + m0(x.total) : ""}${M.vendor ? "" : " · " + esc(x.vendor)}</option>`).join("")}</select></label>
        <label class="stack" for="po-note" style="grid-column:1 / -1">Note<input id="po-note" class="inp" value="${esc(M.note)}" ${ro ? "disabled" : ""} placeholder="e.g. booking order, ships in two drops"></label>
      </div>
      ${M.invoiceId ? `<div class="row small"><span class="muted">Linked invoice ${esc(inv ? inv.no || "#" + inv.id : "")}${inv && inv.total != null ? " · " + m(inv.total) : ""}</span><button class="linkbtn small" data-fix="oinv">Open it</button>${editLines ? '<button class="linkbtn small" data-fix="ofill">Fill products from it</button>' : ""}</div>` : ""}
      ${M.lines.length ? `<div class="tbl-wrap"><table class="prept recvgrid"><thead>${head}</thead><tbody>${rowsH}</tbody></table></div>` : ""}
      ${editLines ? `<div class="addbox"><label class="stack" for="po-add">Add product<input id="po-add" class="inp mono" value="${esc(M.add)}" placeholder="Shopify SKU, UPC, product name, ASIN or Amazon SKU" autocomplete="off"></label>
        ${M.add.trim() ? `<div class="mres">${!cat ? '<span class="muted small">Loading the Shopify catalog…</span>' : found.map((v, i) => `<button data-oadd="${i}"><b>${esc(v.title)}</b><br><span class="dim">${esc(v.sku)} · ${esc(v.vendor)}${v.asku ? " · for " + esc(v.asku) : ""} · ${m(v.cost)}</span></button>`).join("") || '<span class="muted small">No products match.</span>'}</div>` : ""}</div>` : ""}
      ${out.length ? `<div class="row small muted">Amazon Outgoing: ${out.map(sh => `<button class="linkbtn small" data-fix="goto" data-arg="${sh.id}">${esc(shipTitle(sh))} (${STATUS[sh.status][0].toLowerCase()})</button>`).join(" · ")}</div>` : ""}
      ${M.confirm === "unrecv" ? (() => { const u = M.lines.reduce((a, l) => a + (l.received || 0), 0);
        return `<div class="note warn">Move this order back to packing slip? The ${n0(u)} received unit${u === 1 ? "" : "s"} come back out of the prep center (it's refused if some have already shipped out). <span class="dbtns"><button class="mini primary" data-oact="do-back" ${P.busy ? "disabled" : ""}>${P.busy ? "Saving…" : "Yes, move it back"}</button><button class="mini" data-oact="no">Cancel</button></span></div>`; })() : ""}
      ${M.confirm === "del" ? `<div class="note warn">Delete this order? Nothing has been received, so no stock changes. <span class="dbtns"><button class="mini primary" data-oact="do-del" ${P.busy ? "disabled" : ""}>Yes, delete</button><button class="mini" data-oact="no">Cancel</button></span></div>` : ""}
      ${M.confirm === "shipped" ? `<div class="note warn">Mark this order shipped without an Amazon Outgoing shipment? Prep center stock doesn't change — use this when it went out some other way, and fix the counts with Count stock. <span class="dbtns"><button class="mini primary" data-oact="do-shipped" ${P.busy ? "disabled" : ""}>Yes, mark shipped</button><button class="mini" data-oact="no">Cancel</button></span></div>` : ""}
      <div class="row"><span class="muted small">${M.recv ? `Receiving ${n0(recvUnits)} unit${recvUnits === 1 ? "" : "s"} into the prep center` : `${n0(units)} units ordered${got ? ` · ${n0(rec)} received` : ""} · ${m0(cost)} at cost`}</span>
        <span class="dbtns right">${OPREV[M.status] && M.id && !M.recv ? `<button class="btn" data-oact="back">← Back to ${OSTAGE.get(OPREV[M.status]).toLowerCase()}</button>` : ""}${ro ? '<button class="btn" data-act="close">Close</button>' : M.recv ? `
          <button class="btn" data-oact="recv-cancel">Cancel</button><button class="btn primary" data-oact="recv-go" ${!recvUnits || P.busy ? "disabled" : ""}>${P.busy ? "Saving…" : `Receive ${n0(recvUnits)} units`}</button>` : `
          ${M.id && !got ? '<button class="btn" data-oact="del">Delete</button>' : ""}
          <button class="btn" data-oact="save" ${P.busy ? "disabled" : ""}>Save</button>
          ${ONEXT[M.status] ? `<button class="btn" data-oact="save-next">Save &amp; ${ONEXT[M.status][1].replace(/^M/, "m")}</button>` : ""}
          ${!got && M.lines.length ? `<button class="btn ${M.status === "packing_slip" ? "primary" : ""}" data-oact="recv-start">Receive…</button>` : ""}
          ${M.status === "received" ? `<button class="btn" data-oact="recv-start">Receive more…</button><button class="btn" data-oact="shipped">Mark shipped</button><button class="btn primary" data-oact="ship">Create Amazon shipment</button>` : ""}`}</span></div>`;
  }
  function orderBody(M) {
    return { id: M.id ? Number(M.id) : null, vendor: M.vendor.trim(), po_no: M.po.trim(), expected_on: M.expected || "", invoice_id: M.invoiceId ? Number(M.invoiceId) : "", note: M.note, short_ok: !!M.shortOk,
      kind: M.okind || "order", place_by: M.placeBy || "",
      lines: M.lines.map(l => ({ variant_id: Number(l.vid), amazon_sku: l.asku, dest: l.dest || "prep", qty: Number(l.ordered) || 0, unit_cost: l.cost === "" ? null : Number(l.cost) })) };
  }
  async function saveOrder(next, quiet) {
    const M = P.modal; if (!M) return null;
    const bad = M.lines.find(l => l.ordered !== "" && !(Number.isInteger(Number(l.ordered)) && Number(l.ordered) >= 0) || l.cost !== "" && !(Number(l.cost) >= 0));
    if (bad) { note("bad", `Check the quantity and cost for ${esc(bad.title)}.`); return null; }
    P.busy = true; renderModal();
    try {
      const id = await JT.prep.saveOrder(orderBody(M)); M.id = String(id);
      if (next) await JT.prep.setOrderStatus(id, next);
      if (!quiet) { const nm = (M.vendor || "Order") + (M.po ? " " + poLabel(M.po) : ""); P.modal = null; note("info", `<b>${esc(nm)}</b> ${next ? (OORDER.indexOf(next) < OORDER.indexOf(M.status) ? "moved back to " : "moved to ") + OSTAGE.get(next).toLowerCase() : "saved"}.`); }
      await load(true); P.busy = false; render(); refreshTotals(); return id;
    } catch (e) { P.busy = false; renderModal(); note("bad", "Couldn't save the order: " + esc(JT.message(e))); return null; }
  }
  async function receiveNow() {
    const M = P.modal; if (!M || !M.recv) return;
    const lines = M.lines.map(l => ({ variant_id: Number(l.vid), amazon_sku: l.asku, dest: l.dest || "prep", qty: Number(M.recv[l.key]) || 0 })).filter(l => l.qty > 0);
    if (lines.some(l => !Number.isInteger(l.qty) || l.qty < 0)) { note("bad", "Received quantities must be whole numbers."); return; }
    if (M.status !== "received") { const id = await saveOrder(null, true); if (!id) return; }
    P.busy = true; renderModal();
    try {
      const n = await JT.prep.receiveOrder(Number(M.id), lines);
      P.busy = false; const id = M.id; P.modal = null;
      await load(true); render(); refreshTotals();
      note("info", `Received ${n0(n)} units into the prep center.`);
      openOrder(id);
    } catch (e) { P.busy = false; renderModal(); note("bad", "Couldn't receive: " + esc(JT.message(e))); }
  }
  // An Amazon Outgoing shipment with the order's received products (as many as the prep center has free).
  function shipFromOrder(o) {
    const lines = [], qty = {}, info = {};
    for (const l of o.lines) {
      if (l.dest === "shopify") continue;                     // went to the Shopify store, not the prep center
      const k = l.vid + "|" + l.asku, r = rowOf(k); if (!r || !l.received) continue;
      const free = r.qty - (cache.alloc.get(k) || 0);
      lines.push(k); qty[k] = String(Math.max(0, Math.min(l.received, free))); info[k] = { ...l, key: k, qty: 0 };
    }
    P.modal = { kind: "ship", id: null, status: "open", shipment: "", dest: "FBA", note: (o.vendor ? o.vendor + " " : "") + (o.po ? poLabel(o.po) : "order #" + o.id), lines, qty, info, add: "", confirm: false, fromRow: null, orderId: o.id };
    renderModal(); setTimeout(() => { const i = $("pm-ship"); if (i) i.focus(); }, 0);
  }
  async function fillFromInvoice() {
    const M = P.modal; if (!M || !M.invoiceId) return;
    try {
      const r = await JT.rows(["l.variant_id::text", "sum(l.qty)", "max(l.unit_cost)", "coalesce(nullif(v.display_name, ''), v.product_title)", "v.sku", "v.vendor", "v.unit_cost"],
        `from jt.invoice_lines l left join jt.variants v on v.variant_id = l.variant_id where l.invoice_id = ${JT.int(M.invoiceId)} and l.variant_id is not null group by 1, 4, 5, 6, 7`, true);
      const nm = await JT.rows(["count(*)"], `from jt.invoice_lines where invoice_id = ${JT.int(M.invoiceId)} and variant_id is null`, true);
      let added = 0, updated = 0;
      for (const [vid, q, uc, title, sku, vendor, sc] of r) {
        const l = M.lines.find(x => x.vid === vid);
        const qty = String(Math.round(+q || 0)), cost = uc == null ? "" : String(Math.round(+uc * 100) / 100);
        if (l) { l.ordered = qty; l.cost = cost; updated++; }
        else { M.lines.push({ key: okey(vid, "", "prep"), vid, asku: "", dest: "prep", title: title || "variant " + vid, sku: sku || "", vendor: vendor || "", pid: "", shopCost: sc == null ? null : +sc, ordered: qty, cost, received: 0, unitCost: null }); added++; }
      }
      const miss = +((nm[0] || [])[0] || 0);
      note(miss ? "warn" : "info", `From the invoice: ${added} product${added === 1 ? "" : "s"} added, ${updated} updated.${miss ? ` ${miss} invoice line${miss === 1 ? " isn't" : "s aren't"} matched to a Shopify product yet — match ${miss === 1 ? "it" : "them"} on the Invoices tab.` : ""}`);
      renderModal();
    } catch (e) { note("bad", "Couldn't read the invoice: " + esc(JT.message(e))); }
  }
  function orderFix(d) {
    const M = P.modal;
    if (d.fix === "pofull") { const id = M.id; P.modal = null; renderModal(); window.JTPO.open(id); return true; }
    if (d.fix === "orecv") { M.recv = {}; for (const l of M.lines) M.recv[l.key] = String(Math.max(0, (Number(l.ordered) || 0) - (l.received || 0))); renderModal(); return true; }
    if (d.fix === "oshort") { M.shortOk = true; saveOrder(null); return true; }
    if (d.fix === "oinv") { const id = M.invoiceId; P.modal = null; renderModal(); const t = document.querySelector('.tabs button[data-tab="invoices"]'); if (t) t.click(); setTimeout(() => window.JTInvoices && window.JTInvoices.open(id), 50); return true; }
    if (d.fix === "ofill") { fillFromInvoice(); return true; }
    if (d.fix === "oship") { const o = cache.orders.find(x => x.id === M.id); if (o) shipFromOrder(o); return true; }
    if (d.fix === "onext") { saveOrder(ONEXT[M.status][0]); return true; }
    if (d.fix === "focuskq") { setTimeout(() => { const i = document.querySelector(`#prep-modal input[data-ok="${CSS.escape(d.k)}"]`); if (i) { i.focus(); i.select(); } }, 0); return true; }
    if (d.fix === "focuskc") { setTimeout(() => { const i = document.querySelector(`#prep-modal input[data-oc="${CSS.escape(d.k)}"]`); if (i) { i.focus(); i.select(); } }, 0); return true; }
    return false;
  }

  // ===================== On The List: products to re-order =====================
  // Marked from the prep center, Amazon inventory, Inventory value or the search box here; each item is for the prep
  // center (Amazon) or the Shopify store. Tick items and put them on the vendor's in-flight draft order or a booking
  // order (Incoming Inventory). Its status follows that order.
  const listStage = (i) => i.closed ? "done" : !i.order ? "need" : i.order.status === "draft" ? "draft" : OGOT.includes(i.order.status) ? "done" : "onorder";
  function listStatus(i) {
    const st = listStage(i), o = i.order;
    if (st === "need") return '<span class="pill miss">Needs an order</span>';
    const lbl = `${o.kind === "booking" ? "Booking" : "Draft"} · ${esc(orderTitle(o))}`;
    if (st === "draft") return `<button class="linkbtn small" data-lord="${o.id}">${lbl}</button>${o.kind === "booking" && o.placeBy ? `<div class="meta">place by ${shortDate(o.placeBy)}</div>` : ""}`;
    if (st === "onorder") return `<span class="pill manual">${OSTAGE.get(o.status)}</span> <button class="linkbtn small" data-lord="${o.id}">${esc(orderTitle(o))}</button>${o.expected ? `<div class="meta">expected ${shortDate(o.expected)}</div>` : ""}`;
    return `<span class="pill ok">Received</span>${o ? ` <button class="linkbtn small" data-lord="${o.id}">${esc(orderTitle(o))}</button>` : ""}`;
  }
  // on an order, the order line's quantity is the one that counts
  const listQty = (i) => { const l = i.order && i.order.lines.find(x => x.vid === i.vid && x.asku === i.asku && x.dest === i.dest); return l ? l.ordered : i.qty; };
  function stockOf(i) {
    const parts = [];
    if (i.dest === "prep") {
      const pr = cache.rows.filter(r => r.vid === i.vid && (!i.asku || r.asku === i.asku || !r.asku)).reduce((a, r) => a + r.qty, 0);
      parts.push(`prep ${n0(pr)}`);
      const fd = JT.fba && JT.fba.data;
      if (fd) {
        const skus = i.asku ? [i.asku] : (cache.byVariant.get(i.vid) || []).map(l => l.sku);
        const its = fd.items.filter(x => skus.includes(x.sku));
        if (its.length) parts.push(`Amazon ${n0(its.reduce((a, x) => a + JT.fba.unitsOf(x, true), 0))}`);
        const sold = its.reduce((a, x) => a + (x.t30 || 0), 0); if (sold) parts.push(`${n0(sold)} sold/30d`);
      }
    }
    parts.push(`Shopify ${i.shopQty == null ? "—" : n0(i.shopQty)}`);
    return parts.join(" · ");
  }
  // On The List: products to re-order. "To order" is what isn't on a PO yet; "Add to PO" puts a row on its
  // vendor's draft PO (no quantity needed — whoever places the order sets it) and it moves to "On a PO".
  function renderList() {
    const d = cache, el = $("prep-list");
    const by = { todo: [], onorder: [], done: [] };
    for (const i of d.list) { const st = listStage(i); (st === "need" ? by.todo : st === "draft" || st === "onorder" ? by.onorder : by.done).push(i); }
    document.querySelectorAll("#prep-lview button").forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.v === P.lView)); b.querySelector("span").textContent = by[b.dataset.v].length; });
    const items = by[P.lView];
    const found = P.lAdd.trim() && cat ? findProducts(P.lAdd).slice(0, 8) : [];
    $("prep-lres").innerHTML = P.lAdd.trim() ? (!cat ? '<span class="muted small">Loading the Shopify catalog…</span>' : found.map((v, k) => `<button data-ladd="${k}"><b>${esc(v.title)}</b><br><span class="dim">${esc(v.sku)} · ${esc(v.vendor)}${v.asku ? " · for " + esc(v.asku) : ""}</span></button>`).join("") || '<span class="muted small">No products match.</span>') : "";
    if (!items.length) { el.innerHTML = `<div class="muted small" style="padding:6px 2px">${P.lView === "todo" ? "Nothing to order. Add products with the box above, or with “+ List” on Prep center stock, Amazon inventory and Inventory value." : P.lView === "onorder" ? "Nothing from the list is on a PO." : "Nothing received from the list in the last 90 days."}</div>`; return; }
    const groups = new Map();
    for (const i of items) { const k = i.vendor || "(no vendor)"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
    const todo = P.lView === "todo";
    el.innerHTML = [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([v, list]) => {
      const dr = todo ? d.orders.find(o => o.status === "draft" && o.kind === "order" && (o.vendor || "").toLowerCase() === (v === "(no vendor)" ? "" : v.toLowerCase())) : null;
      return `<div class="lgroup"><div class="lghead"><b>${esc(v)}</b><span class="muted small">${list.length} product${list.length === 1 ? "" : "s"}${todo && dr ? ` · draft PO <button class="linkbtn small" data-lord="${dr.id}">${esc(orderTitle(dr))}</button>` : ""}</span></div>
        <div class="tbl-wrap"><table class="prept"><thead><tr><th class="l">Product</th><th class="l">For</th>${todo ? "" : "<th>Qty</th>"}<th class="l">Stock now</th><th class="l">${todo ? "" : "PO"}</th><th></th></tr></thead><tbody>${
        list.map(i => `<tr>
          <td class="l">${i.pid ? `<a class="olink" href="${ADMIN}/products/${esc(i.pid)}/variants/${esc(i.vid)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : esc(i.title)}<div class="meta"><span class="mono">${esc(i.sku)}</span>${i.source ? " · from " + esc({ prep: "prep center", amazon: "Amazon inventory", inventory: "inventory value", search: "search" }[i.source] || i.source) : ""}${i.addedBy ? " · " + esc(i.addedBy) : ""}${i.added ? " · " + shortDate(String(i.added).slice(0, 10)) : ""}</div></td>
          <td class="l small">${i.dest === "shopify" ? '<span class="pill pos">Shopify store</span>' : `<span class="pill web">Prep / Amazon</span>${i.asku ? `<div class="meta mono">${esc(i.asku)}</div>` : ""}`}</td>
          ${todo ? "" : `<td>${(() => { const q = listQty(i); return q ? n0(q) : '<span class="dim">not set</span>'; })()}</td>`}
          <td class="l small">${stockOf(i)}</td>
          <td class="l small">${todo ? `<button class="mini primary" data-lpo="${i.id}" title="Put it on a draft PO">Add to PO</button>` : listStatus(i)}</td>
          <td>${listStage(i) === "done" ? "" : `<button class="linkbtn small" data-lrm="${i.id}" title="Take off the list${listStage(i) === "draft" ? " (and off its draft PO)" : ""}" aria-label="Remove ${esc(i.title)}">✕</button>`}</td></tr>`).join("")}</tbody></table></div></div>`;
    }).join("");
  }
  async function listAssign(vendor) {
    const sel = document.querySelector(`#prep-list select[data-lput="${CSS.escape(vendor)}"]`), val = sel ? sel.value : "new";
    const ids = cache.list.filter(i => (i.vendor || "(no vendor)") === vendor && P.lSel.has(i.id)).map(i => Number(i.id));
    if (!ids.length) return;
    try {
      const body = { ids, ...(val === "new" || val === "booking" ? { new: { vendor: vendor === "(no vendor)" ? "" : vendor, kind: val === "booking" ? "booking" : "order" } } : { order_id: Number(val) }) };
      const oid = await JT.prep.listAssign(body);
      ids.forEach(i => P.lSel.delete(String(i)));
      await load(true); render();
      const o = cache.orders.find(x => x.id === String(oid));
      note("info", `Put ${ids.length} product${ids.length === 1 ? "" : "s"} on ${o && o.kind === "booking" ? "booking order" : "draft order"} <button class="linkbtn" data-lord="${oid}">${esc(o ? (o.vendor + " " + orderTitle(o)) : "#" + oid)}</button>.${val === "booking" ? " Set its place-by date in the order." : ""}`);
    } catch (e) { note("bad", "Couldn't put them on the order: " + esc(JT.message(e))); }
  }
  function bindList() {
    $("prep-lview").addEventListener("click", (e) => { const b = e.target.closest("button[data-v]"); if (b) { P.lView = b.dataset.v; renderList(); } });
    const add = $("pl-add");
    add.addEventListener("focus", () => { catalog().then(() => renderList()).catch(() => {}); });
    add.addEventListener("input", () => { P.lAdd = add.value; clearTimeout(add._t); add._t = setTimeout(renderList, 150); });
    const doAdd = async (v) => {
      if (!v) return;
      const dest = $("pl-dest").value;
      try {
        const r = await addToList({ variant_id: Number(v.vid), amazon_sku: dest === "prep" ? v.asku || "" : "", dest, source: "search" });
        add.value = ""; P.lAdd = ""; P.lView = "todo"; render(); note("info", `Added ${esc(v.title)} to ${r.where}.`); add.focus();
      } catch (e) { note("bad", "Couldn't add it: " + esc(JT.message(e))); }
    };
    add.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doAdd(findProducts(P.lAdd)[0]); } });
    $("prep-lres").addEventListener("click", (e) => { const b = e.target.closest("button[data-ladd]"); if (b) doAdd(findProducts(P.lAdd)[+b.dataset.ladd]); });
    const el = $("prep-list");
    el.addEventListener("change", async (e) => {
      const t = e.target;
      if (t.dataset.lsel) { if (t.checked) P.lSel.add(t.dataset.lsel); else P.lSel.delete(t.dataset.lsel); renderList(); }
      else if (t.dataset.lall != null) { for (const i of cache.list) if ((i.vendor || "(no vendor)") === t.dataset.lall && listStage(i) !== "done" && listStage(i) !== "onorder") { if (t.checked) P.lSel.add(i.id); else P.lSel.delete(i.id); } renderList(); }
      else if (t.dataset.lqty) {
        const i = cache.list.find(x => x.id === t.dataset.lqty), v = t.value.trim();
        if (v && !(Number.isInteger(Number(v)) && Number(v) >= 0)) { t.classList.add("bad"); return; }
        try { await JT.prep.listAdd({ variant_id: Number(i.vid), amazon_sku: i.asku, dest: i.dest, qty: v === "" ? null : Number(v) }); await load(true); render(); }
        catch (err) { note("bad", "Couldn't save the quantity: " + esc(JT.message(err))); }
      }
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset.lqty) e.target.blur(); });
    el.addEventListener("click", async (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.lgo) return listAssign(b.dataset.lgo);
      if (b.dataset.lpo) { openToPo(b.dataset.lpo); return; }
      if (b.dataset.lrm) { try { await JT.prep.listRemove(Number(b.dataset.lrm)); P.lSel.delete(b.dataset.lrm); await load(true); render(); } catch (err) { note("bad", "Couldn't remove it: " + esc(JT.message(err))); } return; }
    });
    // order links anywhere on the tab (list rows, notes)
    $("tab-prep").addEventListener("click", (e) => { const b = e.target.closest("[data-lord]"); if (b && !b.closest("#prep-modal")) openOrder(b.dataset.lord); });
  }

  function renderMoves() {
    const d = cache; const el = $("prep-moves");
    const list = d.moves.filter(x => P.moveKind === "all" || x[1] === P.moveKind || x[1] === "un" + P.moveKind);
    document.querySelectorAll("#prep-mkind button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.k === P.moveKind)));
    if (!d.moves.length) { el.innerHTML = `<div class="muted small" style="padding:8px 2px">No activity yet. Counts, shipments to Amazon and the starting inventory will be listed here.</div>`; return; }
    const KIND = { adjust: '<span class="pill pos">Count</span>', ship: '<span class="pill web">Shipped</span>', seed: '<span class="pill ok">Starting stock</span>', receive: '<span class="pill other">Received</span>', unship: '<span class="pill warn">Un-shipped</span>', unreceive: '<span class="pill warn">Un-received</span>', assign: '<span class="pill manual">Assigned</span>' };
    el.innerHTML = `<div class="tbl-wrap tall"><table class="prepm"><thead><tr><th class="l">When</th><th class="l">What</th><th class="l">Product</th><th>Change</th><th>After</th><th class="l">Shipment</th><th class="l">By</th><th class="l">Note</th></tr></thead><tbody>${
      list.map(x => { const [at, kind, vid, asku, chg, after, shipment, dest, nt, by, title, sku] = x;
        return `<tr><td class="l small">${when(at)}</td><td class="l">${KIND[kind] || esc(kind)}</td>
          <td class="l">${esc(title || "variant " + vid)}<div class="meta"><span class="mono">${esc(sku || "")}</span>${asku ? ` · for <span class="mono">${esc(asku)}</span>` : ""}</div></td>
          <td class="${chg < 0 ? "neg" : "pos"}">${chg > 0 ? "+" : ""}${n0(chg)}</td><td>${n0(after)}</td>
          <td class="l">${shipment ? `<span class="mono">${esc(shipment)}</span>` : ""}${dest ? ` <span class="pill ${dest === "AWD" ? "manual" : "web"}">${esc(dest)}</span>` : ""}</td>
          <td class="l small">${esc(by)}</td><td class="l small">${esc(nt)}</td></tr>`; }).join("") || `<tr><td class="l muted" colspan="8">Nothing of this kind yet.</td></tr>`}</tbody></table></div>`;
  }

  // ---------- modals: count stock / ship to Amazon ----------
  // Earmark prep-center units for Amazon listings (or move them between listings / back to "any listing").
  function openAssign(vid, sku) {
    const r = cache && cache.rows.find(x => x.vid === vid && x.asku === (sku || "")); if (!r) return;
    P.modal = { kind: "assign", vid, from: r.asku, qty: {}, note: "" };
    renderModal(); setTimeout(() => { const i = document.querySelector("#prep-modal input[data-aq]"); if (i) i.focus(); }, 0);
  }
  function assignHtml(M) {
    const r = cache.rows.find(x => x.vid === M.vid && x.asku === M.from); if (!r) return "";
    const ls = r.listings.slice(), have = r.qty;
    if (M.from && !ls.some(l => l.sku === M.from) && r.target) ls.push({ ...r.target, sku: M.from });
    const targets = [...(M.from ? [{ sku: "", any: true }] : []), ...ls.filter(l => l.sku !== M.from).sort((a, b) => (a.units || 1) - (b.units || 1) || String(a.asin).localeCompare(String(b.asin)))];
    const onHandFor = (sku) => { const x = cache.rows.find(y => y.vid === M.vid && y.asku === sku); return x ? x.qty : 0; };
    let total = 0, bad = 0, odd = 0;
    for (const t of targets) { const v = M.qty[t.sku] ?? ""; if (v === "") continue; const q = Number(v); if (!Number.isInteger(q) || q < 0) { bad++; continue; } total += q; if (q % (t.units || 1)) odd++; }
    const over = total > have;
    const fromTxt = M.from ? `<span class="mono">${esc(M.from)}</span>` : "any listing";
    return `<div class="panel-head"><h2>Assign to Amazon listings</h2><button class="mini" data-act="close">Close</button></div>
      <div class="pickbox"><b>${esc(r.title)}</b> <span class="mono dim">${esc(r.sku)}</span> · ${esc(r.vendor)} · <b>${n0(have)}</b> in the prep center for ${fromTxt}</div>
      <p class="muted small" style="margin:0">Quantities are Shopify units (single items). A 2-pack listing takes 2 per Amazon unit. Whatever you don't assign stays where it is${M.from ? "" : " — for any listing, to assign later"}.</p>
      ${targets.length ? `<div class="tbl-wrap"><table class="prept"><thead><tr><th class="l">Amazon listing</th><th>In prep now</th><th>Assign</th><th>Amazon units</th></tr></thead><tbody>${targets.map(t => {
        const v = M.qty[t.sku] ?? "", q = Number(v), u = t.units || 1, b2 = v !== "" && (!Number.isInteger(q) || q < 0);
        return `<tr><td class="l">${t.any ? "<b>Any listing</b><div class=\"meta\">not earmarked — assign later</div>" : `${t.asin ? `<a class="olink" href="https://www.amazon.com/dp/${encodeURIComponent(t.asin)}" target="_blank" rel="noopener">${esc(t.asin)}</a>` : '<span class="dim">no ASIN</span>'}${u !== 1 ? ` <span class="pill warn">${u}-pack</span>` : ""}<div class="meta">${esc((t.title || "").slice(0, 80))}</div><div class="meta mono">${esc(t.sku)}</div>`}</td>
          <td>${n0(onHandFor(t.sku))}</td>
          <td><input class="inp num sm ${b2 ? "bad" : v !== "" && q % u ? "warnin" : ""}" data-aq="${esc(t.sku)}" value="${esc(v)}" inputmode="numeric" placeholder="0" style="width:80px"><div class="meta"><button class="linkbtn small" data-aall="${esc(t.sku)}">all ${n0(Math.floor(Math.max(0, have - total + (Number(v) || 0)) / u) * u)}</button></div></td>
          <td>${v !== "" && !b2 && q ? (q % u ? `<span class="warnt">${(q / u).toFixed(1)}</span>` : n0(q / u)) : '<span class="dim">—</span>'}</td></tr>`; }).join("")}</tbody></table></div>`
        : `<div class="note warn">No Amazon listing is mapped to this product. Map one on the Amazon mapping tab first.</div>`}
      <label class="stack" for="pm-anote">Note (optional)<input id="pm-anote" class="inp" value="${esc(M.note)}" placeholder="e.g. building 2-packs for FBA"></label>
      <div class="row"><span class="small ${over ? "neg" : "muted"}">${over ? `That's ${n0(total)} — only ${n0(have)} are there.` : `${n0(total)} of ${n0(have)} assigned${odd ? ` · <span class="warnt">a pack listing isn't a whole number of packs</span>` : ""}`}</span>
        <span class="dbtns right"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="save-assign" ${!total || over || bad || P.busy ? "disabled" : ""}>${P.busy ? "Saving…" : "Assign"}</button></span></div>`;
  }
  async function saveAssign() {
    const M = P.modal; if (!M || M.kind !== "assign") return;
    const moves = Object.entries(M.qty).map(([to_sku, v]) => ({ to_sku, qty: Number(v) || 0 })).filter(x => x.qty > 0);
    P.busy = true; renderModal();
    try {
      const n = await JT.prep.assign({ variant_id: Number(M.vid), from_sku: M.from, moves, note: M.note || "" });
      P.busy = false; P.modal = null; note("info", `Assigned ${n0(n)} unit${n === 1 ? "" : "s"}.`); await load(true); render();
    } catch (e) { P.busy = false; renderModal(); note("bad", "Couldn't assign: " + esc(JT.message(e))); }
  }
  function openCount(vid, sku, back, fallback) {
    const r = vid && cache ? cache.rows.find(x => x.vid === vid && x.asku === (sku || "")) : null;
    const pick = r ? { vid: r.vid, sku: r.sku, title: r.title, vendor: r.vendor, cost: r.cost } : fallback || null;
    P.modal = { kind: "count", q: "", pick, asku: r ? r.asku : sku || "", qty: "", note: "", back: back || null };
    catalog().then(() => renderModal()).catch(e => note("bad", esc(JT.message(e))));
    renderModal(); setTimeout(() => { const i = $(P.modal.pick ? "pm-qty" : "pm-q"); if (i) i.focus(); }, 0);
  }
  // Shipment editor. From a stock row: a new shipment holding that row (or add it to one in progress).
  // From a card: that shipment. More products are added by ASIN, Amazon SKU or Shopify SKU.
  // New shipment, step 1: find the one seller SKU being sent (search by ASIN, seller SKU, Shopify SKU, UPC or name).
  // Picking it opens the shipment with that SKU. One SKU per new shipment for now.
  function openNewShip() {
    P.modal = { kind: "newship", q: "" };
    renderModal(); setTimeout(() => { const i = $("pm-nq"); if (i) i.focus(); }, 0);
    catalog().then(() => { if (P.modal && P.modal.kind === "newship") renderModal(); }).catch(() => {});
  }
  function skuCandidates(q) {
    const w = q.trim().toLowerCase().split(/\s+/).filter(Boolean); if (!w.length) return { list: [], unmapped: [] };
    const byVid = new Map((cat || []).map(v => [v.vid, v])), seen = new Set(), out = [];
    const add = (vid, l) => {
      const k = vid + "|" + l.sku; if (seen.has(k)) return; seen.add(k);
      const v = byVid.get(vid) || cache.rows.find(r => r.vid === vid) || {};
      const text = [l.sku, l.asin, l.title, v.sku, v.title, v.vendor, v.barcode].join(" ").toLowerCase();
      if (!w.every(t => text.includes(t))) return;
      const ph = prepHere(vid, l.sku), any = prepHere(vid, "").qty;
      out.push({ vid, sku: l.sku, asin: l.asin || "", ltitle: l.title || "", units: l.units || 1, title: v.title || `variant ${vid}`, vsku: v.sku || "", vendor: v.vendor || "",
        here: ph.qty, any, coming: comingOf(vid + "|" + l.sku) + comingOf(vid + "|"), inShip: ph.inShip, status: v.status || "" });
    };
    for (const [vid, ls] of cache.byVariant) for (const l of ls) add(vid, l);
    for (const r of cache.rows) if (r.asku) add(r.vid, { sku: r.asku, asin: (r.target && r.target.asin) || "", title: (r.target && r.target.title) || "", units: (r.target && r.target.units) || 1 });
    out.sort((a, b) => (b.here > 0) - (a.here > 0) || (b.here + b.any > 0) - (a.here + a.any > 0) || (b.coming > 0) - (a.coming > 0) || a.title.localeCompare(b.title) || a.sku.localeCompare(b.sku));
    const mappedVids = new Set(out.map(x => x.vid));
    const unmapped = cat ? searchCat(q).filter(v => !mappedVids.has(v.vid) && !cache.byVariant.has(v.vid)).slice(0, 5) : [];
    return { list: out.slice(0, 25), unmapped };
  }
  function newShipHtml(M) {
    const { list, unmapped } = skuCandidates(M.q);
    return `<div class="panel-head"><h2>New shipment</h2><button class="mini" data-act="close">Close</button></div>
      <label class="stack" for="pm-nq">Which SKU are you sending?<input id="pm-nq" class="inp mono" value="${esc(M.q)}" placeholder="ASIN, seller SKU, Shopify SKU, UPC or product name" autocomplete="off"></label>
      ${!M.q.trim() ? '<p class="muted small" style="margin:0">One seller SKU per shipment. Pick it, then enter how many units are going.</p>'
        : `<div class="skures">${list.map((c, i) => `<button class="skuopt" data-pickship="${i}">
            <span class="so-main"><b>${esc(c.title)}</b><span class="dim small"> · ${esc(c.vsku || "no SKU")}${c.vendor ? " · " + esc(c.vendor) : ""}</span></span>
            <span class="so-amz"><span class="mono">${esc(c.asin || "no ASIN")}</span> · <span class="mono">${esc(c.sku)}</span>${c.units !== 1 ? ` <span class="pill warn">${c.units}-pack</span>` : ""}${c.ltitle ? `<span class="dim small"> · ${esc(c.ltitle.slice(0, 70))}</span>` : ""}</span>
            <span class="so-stock small">${c.here ? `<b>${n0(c.here)}</b> in the prep center for this SKU` : '<span class="dim">none earmarked for this SKU</span>'}${c.any ? ` · ${n0(c.any)} not earmarked` : ""}${c.coming ? ` · ${n0(c.coming)} incoming` : ""}${c.inShip ? ` · ${n0(c.inShip)} in other shipments` : ""}</span>
          </button>`).join("") || '<span class="muted small">No Amazon listing matches that.</span>'}
          ${unmapped.length ? `<div class="small muted">Found in Shopify but not mapped to an Amazon listing: ${unmapped.map(v => `${esc(v.title)} <span class="mono">${esc(v.sku)}</span>`).join(" · ")} — map it on the Amazon mapping tab first.</div>` : ""}
          ${!cat ? '<span class="muted small">Loading the Shopify catalog…</span>' : ""}</div>`}`;
  }
  function pickNewShip(c) {
    openShip(c.vid, c.sku);
    if (P.modal && P.modal.kind === "ship") {
      P.modal.info[c.vid + "|" + c.sku] = { vid: c.vid, asku: c.sku, title: c.title, sku: c.vsku, vendor: c.vendor, cost: null };
      P.modal.single = true; renderModal();
    }
  }
  function openShip(vid, sku, oid, n) {
    const key = vid ? vid + "|" + (sku || "") : null, o = oid && cache.orders.find(x => x.id === String(oid));
    P.modal = { kind: "ship", id: null, status: "open", shipment: "", dest: "FBA", note: o ? (o.vendor ? o.vendor + " " : "") + (o.po ? poLabel(o.po) : "order #" + o.id) : "",
      lines: key ? [key] : [], qty: key ? { [key]: n ? String(n) : "" } : {}, info: {}, add: "", confirm: false, fromRow: key, ...(o ? { orderId: o.id } : {}) };
    renderModal(); setTimeout(() => { const i = key ? document.querySelector(`#prep-modal input[data-k="${CSS.escape(key)}"]`) : $("pm-ship"); if (i) i.focus(); }, 0);
  }
  function openShipment(id, extraKey) {
    const sh = cache && cache.shipments.find(x => x.id === String(id)); if (!sh) return;
    const qty = {}, info = {};
    for (const l of sh.lines) { qty[l.key] = String(l.qty); info[l.key] = l; }
    const lines = sh.lines.map(l => l.key);
    if (extraKey && !lines.includes(extraKey)) { lines.push(extraKey); qty[extraKey] = ""; }
    P.modal = { kind: "ship", id: sh.id, status: sh.status, shipment: sh.name, dest: sh.dest, note: sh.note, lines, qty, info, add: "", confirm: false, fromRow: extraKey || null, sh, orderId: sh.orderId };
    renderModal(); setTimeout(() => { const i = extraKey ? document.querySelector(`#prep-modal input[data-k="${CSS.escape(extraKey)}"]`) : null; if (i) i.focus(); }, 0);
  }
  const keyOf = (r) => r.vid + "|" + r.asku;
  const rowOf = (k) => cache && (cache.rows.find(r => keyOf(r) === k) || (cache.incoming && cache.incoming.get(k)) || null);
  const comingOf = (k) => (cache && cache.incoming && cache.incoming.get(k) || {}).coming || 0;
  // a shipment line: the prep row when it still has stock, else what the shipment saved
  const lineOf = (k) => { const r = rowOf(k); if (r) return r; const i = P.modal && P.modal.info[k]; if (!i) return null; return { vid: i.vid, asku: i.asku, qty: 0, title: i.title, sku: i.sku, vendor: i.vendor, cost: i.cost, listings: [], target: null }; };
  const asinsOf = (r) => [...new Set([r.target && r.target.asin, ...(r.asku ? [] : r.listings.map(l => l.asin))].filter(Boolean))];
  // Prep center rows matching what was typed: exact ASIN / Amazon SKU / Shopify SKU first, then partial matches.
  function findRows(text, exclude) {
    const t = String(text || "").trim().toLowerCase(); if (!t || !cache) return [];
    const rows = cache.rows.filter(r => r.qty > 0 && !exclude.includes(keyOf(r)))
      .concat([...(cache.incoming || new Map()).values()].filter(r => !exclude.includes(keyOf(r)) && !cache.rows.some(x => keyOf(x) === keyOf(r) && x.qty > 0)));
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
  // Closing a popup opened from a shipment (e.g. a recount) goes back to that shipment, with its edits kept.
  function closeModal() { const b = P.modal && P.modal.back; P.modal = b || null; P.busy = false; renderModal(); }
  function onHand(vid, sku) { const r = cache && cache.rows.find(x => x.vid === vid && x.asku === (sku || "")); return r ? r.qty : 0; }

  // ---------- product detail (click a row on Incoming products) ----------
  // Everything about one product: its Amazon listings (prep center stock, FBA stock, units sold 7/30/90 days per
  // ASIN), vendor orders, invoices not received yet, and Amazon shipments in progress.
  function openProduct(vid, asku) {
    P.modal = { kind: "prod", vid, asku: asku || "", info: null, err: "" };
    renderModal();
    loadProduct(vid).then(info => { if (P.modal && P.modal.kind === "prod" && P.modal.vid === vid) { P.modal.info = info; renderModal(); } })
      .catch(e => { if (P.modal && P.modal.kind === "prod") { P.modal.err = JT.message(e); renderModal(); } });
  }
  async function loadProduct(vid) {
    const v = JT.int(vid), ls = cache.byVariant.get(vid) || [];
    const skus = [...new Set([...ls.map(l => l.sku), ...cache.rows.filter(r => r.vid === vid && r.asku).map(r => r.asku)])];
    const asins = [...new Set(ls.map(l => l.asin).filter(Boolean))];
    const inList = (a) => a.length ? a.map(JT.q).join(",") : "''";
    const T = "(now() at time zone 'America/Los_Angeles')::date";
    const [vr, sales, fba, invs, pos, lastShip, hist] = await Promise.all([
      JT.rows(["coalesce(nullif(v.display_name, ''), v.product_title)", "v.sku", "v.vendor", "v.unit_cost", "v.price", "v.inventory_qty", "v.product_id::text", "v.barcode"],
        `from jt.variants v where v.variant_id = ${v}`, true),
      asins.length ? JT.rows(["a.asin", `coalesce(sum(a.units) filter (where a.day > ${T} - 7), 0)`, `coalesce(sum(a.units) filter (where a.day > ${T} - 30), 0)`, "coalesce(sum(a.units), 0)",
        `coalesce(sum(a.fba_units) filter (where a.day > ${T} - 30), 0)`], `from jt.asin_daily a where a.asin in (${inList(asins)}) and a.day > ${T} - 90 group by a.asin`, true) : [],
      JT.rows(["f.sku", "f.asin", "f.fulfillable", "f.inbound_working + f.inbound_shipped + f.inbound_receiving", "f.reserved_total", "f.unfulfillable", "f.active"],
        `from jt.fba_inventory f where f.sku in (${inList(skus)})${asins.length ? ` or (f.asin in (${inList(asins)}) and f.active)` : ""}`, true),
      JT.rows(["i.id::text", "i.invoice_no", "i.vendor", "i.invoice_date::text", "coalesce(i.order_id, (select p.id from jt.prep_orders p where p.invoice_id = i.id limit 1))::text",
        "sum(l.qty)", "max(l.unit_cost)", `(select r.qty from jt.invoice_receipts r where r.invoice_id = i.id and r.variant_id = ${v})`, "i.received_at is not null", "i.paid_on::text"],
        `from jt.invoice_lines l join jt.invoices i on i.id = l.invoice_id where l.variant_id = ${v} and l.match_how <> 'skip'
          and (i.received_at is null or coalesce(i.invoice_date, i.created_at::date) > current_date - 120) group by i.id order by (i.received_at is null) desc, i.invoice_date desc nulls last, i.id desc limit 20`, true),
      JT.rows(["o.id::text", "o.vendor", "o.po_no", "o.status", "sum(l.qty_ordered)", "sum(l.qty_received)", "max(coalesce(l.eta, o.expected_on))::text", "o.created_at::date::text",
        "string_agg(distinct l.dest, ',')", "string_agg(distinct nullif(l.amazon_sku, ''), ', ')"],
        `from jt.prep_order_lines l join jt.prep_orders o on o.id = l.order_id where l.variant_id = ${v} group by o.id order by (o.status in ('draft', 'ordered', 'invoiced', 'partial')) desc, o.id desc limit 15`, true),
      // last time each seller SKU went to Amazon (Seller Central shipments, and shipped prep center shipments)
      skus.length ? JT.rows(["k", "max(d)::text"], `from (select x.sku k, coalesce(s.created_at, s.first_seen)::date d from jt.inbound_shipment_items x join jt.inbound_shipments s on s.id = x.shipment_id
          where x.sku in (${inList(skus)}) and x.qty_expected > 0 and s.status not in ('CANCELLED', 'DELETED')
          union all select l.amazon_sku, s.shipped_at::date from jt.prep_shipment_lines l join jt.prep_shipments s on s.id = l.shipment_id
          where l.variant_id = ${v} and s.status = 'shipped' and l.amazon_sku <> '') t group by k`, true).catch(() => []) : [],
      // last ordered (a PO placed with it), last backordered (migration 090)
      JT.rows(["max(coalesce((o.stage_at->>'ordered')::timestamptz, o.created_at))::date::text", FLOW ? "max(l.backorder_at)::date::text" : "null::text",
          "bool_or(l.backorder and l.qty_received < l.qty_ordered and o.status in ('ordered', 'invoiced', 'partial'))"],
        `from jt.prep_order_lines l join jt.prep_orders o on o.id = l.order_id where l.variant_id = ${v} and o.status <> 'draft'`, true).catch(() => []),
    ]);
    const x = vr[0] || [];
    return {
      title: x[0] || "", sku: x[1] || "", vendor: x[2] || "", cost: x[3] == null ? null : +x[3], price: x[4] == null ? null : +x[4], shopQty: x[5] == null ? null : +x[5], pid: x[6] || "", upc: x[7] || "",
      sales: new Map(sales.map(r => [r[0], { d7: +r[1], d30: +r[2], d90: +r[3], fba30: +r[4] }])),
      fba: fba.map(r => ({ sku: r[0], asin: r[1], avail: +r[2], inbound: +r[3], reserved: +r[4], unf: +r[5], active: !!r[6] })),
      invs: invs.map(r => ({ id: r[0], no: r[1] || "", vendor: r[2] || "", date: r[3] || "", oid: r[4] || null, billed: +r[5] || 0, cost: r[6] == null ? null : +r[6], got: r[7] == null ? 0 : +r[7], recv: !!r[8], paid: r[9] || "" })),
      lastShip: new Map(lastShip.map(r => [r[0], r[1]])), lastOrdered: (hist[0] || [])[0] || "", lastBackorder: (hist[0] || [])[1] || "", backorderNow: !!(hist[0] || [])[2],
      pos: pos.map(r => ({ id: r[0], vendor: r[1] || "", po: r[2] || "", status: r[3], ordered: +r[4] || 0, received: +r[5] || 0, eta: r[6] || "", created: r[7] || "", dest: r[8] || "", askus: r[9] || "" })),
    };
  }
  function prodHtml(M) {
    const base = cache.rows.find(r => r.vid === M.vid) || (cache.poRows || []).find(r => r.vid === M.vid) || {};
    const I = M.info;
    const title = (I && I.title) || base.title || "Product", sku = (I && I.sku) || base.sku || "", vendor = (I && I.vendor) || base.vendor || "";
    const head = `<div class="panel-head"><h2>${esc(title)}</h2><button class="mini" data-act="close">Close</button></div>
      <div class="pickbox"><span class="mono">${esc(sku) || "no SKU"}</span> · ${esc(vendor)}${I && I.upc ? ` · UPC <span class="mono">${esc(I.upc)}</span>` : ""}${I ? ` · cost ${m(I.cost)} · Shopify price ${m(I.price)}` : ""}${(I && I.pid) || base.pid ? ` · <a class="olink" href="${ADMIN}/products/${esc((I && I.pid) || base.pid)}/variants/${esc(M.vid)}" target="_blank" rel="noopener">Open in Shopify</a>` : ""}</div>`;
    if (M.err) return head + `<div class="note bad">Couldn't load this product: ${esc(M.err)}</div>`;
    if (!I) return head + '<div class="muted small">Loading…</div>';
    // listings: every mapped listing, plus earmarked stock for a listing that isn't mapped, plus stock for any listing
    const ls = (cache.byVariant.get(M.vid) || []).slice();
    for (const r of cache.rows) if (r.vid === M.vid && r.asku && !ls.some(l => l.sku === r.asku)) ls.push({ ...(r.target || {}), sku: r.asku, units: (r.target && r.target.units) || 1 });
    const prepOf = (a) => { const r = cache.rows.find(x => x.vid === M.vid && x.asku === a); return r ? r.qty : 0; };
    const shipOf = (a) => cache.alloc.get(M.vid + "|" + a) || 0;
    const comingOf2 = (a) => (cache.poRows || []).filter(r => r.vid === M.vid && r.asku === a && !r.hidden).reduce((t, r) => t + r.comingLeft, 0);
    const fbaOf = (l) => I.fba.find(f => f.sku === l.sku) || null;
    // aging: a seller SKU with no shipment in AGE_DAYS while another SKU for the same ASIN has one is an old SKU
    const AGE_DAYS = 180, ago = (d) => d ? Math.floor((Date.now() - new Date(d + "T12:00:00Z")) / 864e5) : null;
    const lastTxt = (l) => {
      const d = I.lastShip.get(l.sku), a = ago(d);
      const newer = l.asin && ls.some(x => x.sku !== l.sku && x.asin === l.asin && I.lastShip.get(x.sku) && (!d || I.lastShip.get(x.sku) > d) && ago(I.lastShip.get(x.sku)) <= AGE_DAYS);
      return `${d ? shortDate(d) + (a > 330 ? " " + d.slice(0, 4) : "") : '<span class="dim">never</span>'}${(a == null || a > AGE_DAYS) && newer ? '<div><span class="pill warn" title="Another SKU for this ASIN has been shipping instead">old SKU</span></div>' : a > AGE_DAYS ? `<div class="meta">${Math.round(a / 30)} months ago</div>` : ""}`;
    };
    const seenAsin = new Set();
    let tot = { prep: 0, ship: 0, coming: 0, avail: 0, inbound: 0, reserved: 0, s7: 0, s30: 0, s90: 0 };
    const nm = (x) => x ? n0(x) : '<span class="dim">—</span>';
    const rowsHtml = ls.sort((a, b) => (a.units || 1) - (b.units || 1) || String(a.asin || "").localeCompare(String(b.asin || ""))).map(l => {
      const u = l.units || 1, f = fbaOf(l), s = l.asin ? I.sales.get(l.asin) : null, first = l.asin && !seenAsin.has(l.asin);
      if (l.asin) seenAsin.add(l.asin);
      const p = prepOf(l.sku), sh = shipOf(l.sku), cm = comingOf2(l.sku);
      tot.prep += p; tot.ship += sh; tot.coming += cm;
      if (f) { tot.avail += f.avail * u; tot.inbound += f.inbound * u; tot.reserved += f.reserved * u; }
      if (s && first) { tot.s7 += s.d7 * u; tot.s30 += s.d30 * u; tot.s90 += s.d90 * u; }
      const daily = s ? s.d30 / 30 : 0, cover = f && daily > 0 ? Math.round((f.avail + f.inbound) / daily) : null;
      return `<tr class="${l.sku === M.asku ? "hl" : ""}"><td class="l">${l.asin ? `<a class="olink" href="https://www.amazon.com/dp/${encodeURIComponent(l.asin)}" target="_blank" rel="noopener">${esc(l.asin)}</a>` : '<span class="dim">no ASIN</span>'}${u !== 1 ? ` <span class="pill warn">${u}-pack</span>` : ""}
          <div class="meta">${esc((l.title || "").slice(0, 70))}</div><div class="meta mono">${esc(l.sku)}</div></td>
        <td>${l.price != null ? m(l.price) : '<span class="dim">—</span>'}</td>
        <td>${p ? `<b>${n0(p)}</b>` : '<span class="dim">0</span>'}${cm ? `<div class="meta">+ ${n0(cm)} incoming</div>` : ""}</td><td>${nm(sh)}</td>
        <td>${f ? n0(f.avail) : '<span class="dim">—</span>'}${f && f.unf ? `<div class="meta">${n0(f.unf)} unsellable</div>` : ""}</td><td>${f ? nm(f.inbound) : '<span class="dim">—</span>'}</td><td>${f ? nm(f.reserved) : '<span class="dim">—</span>'}</td>
        ${l.asin && !first ? '<td colspan="3" class="dim small">same ASIN as above</td>' : `<td>${s ? n0(s.d7) : '<span class="dim">0</span>'}</td><td>${s ? n0(s.d30) : '<span class="dim">0</span>'}</td><td>${s ? n0(s.d90) : '<span class="dim">0</span>'}</td>`}
        <td>${cover == null ? '<span class="dim">—</span>' : cover > 365 ? "1 yr+" : cover + " days"}</td>
        <td class="small">${lastTxt(l)}</td></tr>`;
    }).join("");
    const anyP = prepOf(""), anyS = shipOf(""), anyC = comingOf2("");
    tot.prep += anyP; tot.ship += anyS; tot.coming += anyC;
    const anyRow = anyP || anyS || anyC ? `<tr class="${!M.asku ? "hl" : ""}"><td class="l"><b>Any listing</b><div class="meta">prep center stock not earmarked</div></td><td></td>
        <td>${anyP ? `<b>${n0(anyP)}</b>` : '<span class="dim">0</span>'}${anyC ? `<div class="meta">+ ${n0(anyC)} incoming</div>` : ""}</td><td>${nm(anyS)}</td><td colspan="8"></td></tr>` : "";
    const multi = ls.some(l => (l.units || 1) !== 1);
    const listTbl = `<h3 class="psec">Amazon listings</h3>
      ${ls.length || anyRow ? `<div class="tbl-wrap"><table class="prept"><thead><tr><th class="l">Listing</th><th>Price</th><th>At prep center</th><th>In shipments</th><th>FBA available</th><th>FBA inbound</th><th>FBA reserved</th><th>Sold 7d</th><th>Sold 30d</th><th>Sold 90d</th><th title="FBA available + inbound, at the last 30 days' rate">FBA cover</th><th title="Last time this seller SKU went to Amazon">Last shipment</th></tr></thead>
        <tbody>${rowsHtml}${anyRow}</tbody>
        <tfoot><tr><td class="l">Total${multi ? " · single units" : ""}</td><td></td><td>${n0(tot.prep)}${tot.coming ? `<div class="meta">+ ${n0(tot.coming)} incoming</div>` : ""}</td><td>${n0(tot.ship)}</td><td>${n0(tot.avail)}</td><td>${n0(tot.inbound)}</td><td>${n0(tot.reserved)}</td><td>${n0(tot.s7)}</td><td>${n0(tot.s30)}</td><td>${n0(tot.s90)}</td><td></td><td></td></tr></tfoot></table></div>
        <p class="muted small" style="margin:4px 0 0">Prep center and shipment counts are Shopify units (single items); FBA stock and sales are Amazon units (packs) per listing. Sales are all Amazon orders for the ASIN (FBA and FBM).</p>`
        : `<div class="note warn">No Amazon listing is mapped to this product.</div>`}`;
    const kpis = `<div class="pkpis">${[["Shopify on hand", I.shopQty == null ? "—" : n0(I.shopQty)], ["At prep center", n0(tot.prep)], ["Incoming", n0(tot.coming)], ["FBA available", n0(tot.avail)], ["Sold 30d", n0(tot.s30)],
      ["Last ordered", I.lastOrdered ? shortDate(I.lastOrdered) + (ago(I.lastOrdered) > 330 ? " " + I.lastOrdered.slice(0, 4) : "") : "never"],
      ["Last backordered", I.backorderNow ? "now" : I.lastBackorder ? shortDate(I.lastBackorder) + (ago(I.lastBackorder) > 330 ? " " + I.lastBackorder.slice(0, 4) : "") : "—"]]
      .map(([l, v]) => `<div><span class="dim small">${l}</span><b>${v}</b></div>`).join("")}</div>`;
    const OPENST = ["draft", "ordered", "invoiced", "partial"];
    const poTbl = `<h3 class="psec">Purchase orders</h3>${I.pos.length ? `<div class="tbl-wrap"><table class="prept"><thead><tr><th class="l">PO</th><th class="l">Status</th><th>Ordered</th><th>Received</th><th>Still coming</th><th class="l">Expected</th></tr></thead><tbody>${I.pos.map(o => {
        const left = Math.max(0, o.ordered - o.received);
        return `<tr class="${OPENST.includes(o.status) ? "" : "dimrow"}"><td class="l"><button class="linkbtn small" data-act="gotoorder" data-oid="${esc(o.id)}">${esc((o.vendor ? o.vendor + " " : "") + (o.po ? poLabel(o.po) : "order #" + o.id))}</button><div class="meta">${shortDate(o.created)}${o.dest.includes("shopify") ? (o.dest.includes("prep") ? " · prep + Shopify" : " · to Shopify") : ""}${o.askus ? ` · for <span class="mono">${esc(o.askus)}</span>` : ""}</div></td>
          <td class="l small">${esc(OSTAGE.get(o.status) || o.status)}</td><td>${n0(o.ordered)}</td><td>${nm(o.received)}</td><td>${left && OPENST.includes(o.status) ? `<b>${n0(left)}</b>` : '<span class="dim">—</span>'}</td><td class="l small">${o.eta && left ? shortDate(o.eta) : ""}</td></tr>`; }).join("")}</tbody></table></div>`
      : '<div class="muted small">Not on any purchase order.</div>'}`;
    const openInv = I.invs.filter(i => !i.recv), recent = I.invs.filter(i => i.recv).slice(0, 3);
    const invRow = (i) => `<tr class="${i.recv ? "dimrow" : ""}"><td class="l">${esc(i.vendor)} <span class="mono">${esc(i.no || "#" + i.id)}</span><div class="meta">${shortDate(i.date)}${i.paid ? " · paid" : ""}</div></td>
        <td class="l small">${i.oid ? (() => { const o = I.pos.find(p => p.id === i.oid); return `<button class="linkbtn small" data-act="gotoorder" data-oid="${esc(i.oid)}">${esc(o ? (o.po ? poLabel(o.po) : "order #" + o.id) : "PO")}</button>`; })() : '<span class="dim">no PO</span>'}</td>
        <td>${n0(i.billed)}</td><td>${i.recv ? n0(i.got || i.billed) : nm(i.got)}</td><td>${i.recv ? '<span class="pill ok">Received</span>' : `<b>${n0(Math.max(0, i.billed - i.got))}</b>`}</td><td>${m(i.cost)}</td></tr>`;
    const invTbl = `<h3 class="psec">Invoices${openInv.length ? ` · ${openInv.length} open` : ""}</h3>${openInv.length || recent.length ? `<div class="tbl-wrap"><table class="prept"><thead><tr><th class="l">Invoice</th><th class="l">PO</th><th>Billed</th><th>Received</th><th>Still to receive</th><th>Unit cost</th></tr></thead><tbody>${openInv.map(invRow).join("")}${recent.map(invRow).join("")}</tbody></table></div>${!openInv.length ? '<div class="muted small">No open invoices — the latest received ones are shown.</div>' : ""}`
      : '<div class="muted small">No invoices for this product in the last 120 days.</div>'}`;
    const ships = cache.shipments.filter(s => s.status !== "shipped" && s.lines.some(l => l.vid === M.vid));
    const shipTbl = ships.length ? `<h3 class="psec">Amazon shipments in progress</h3><div class="tbl-wrap"><table class="prept"><thead><tr><th class="l">Shipment</th><th class="l">Status</th><th class="l">Listing</th><th>Units</th></tr></thead><tbody>${ships.map(s => s.lines.filter(l => l.vid === M.vid).map(l =>
        `<tr><td class="l">${esc(s.name || "(no shipment ID)")} <span class="pill ${s.dest === "AWD" ? "manual" : "web"}">${esc(s.dest)}</span></td><td class="l small">${esc(s.status)}</td><td class="l mono small">${esc(l.asku || "any")}</td><td>${n0(l.qty)}</td></tr>`).join("")).join("")}</tbody></table></div>` : "";
    return head + kpis + listTbl + poTbl + invTbl + shipTbl;
  }
  // the Amazon listing (ASIN / seller SKU) a shipment line is for; changing it re-keys the line, and Save earmarks
  // not-earmarked prep center stock for the new listing
  function listingPick(r, k) {
    const ls = cache.byVariant.get(r.vid) || [], opts = ls.slice();
    if (r.asku && !opts.some(l => l.sku === r.asku)) opts.unshift({ sku: r.asku, asin: (r.target && r.target.asin) || "", units: 1 });
    if (!opts.length) return '<span class="dim">Any listing</span><div class="meta warnt">no Amazon listing mapped</div>';
    return `<select class="inp sm ${r.asku ? "" : "warnin"}" data-lsku="${esc(k)}" style="width:auto;max-width:300px"><option value="" ${r.asku ? "" : "selected"}>Pick a listing…</option>${opts.map(l => `<option value="${esc(l.sku)}" ${l.sku === r.asku ? "selected" : ""}>${esc(l.asin || "no ASIN")} · ${esc(l.sku)}${(l.units || 1) !== 1 ? ` (${l.units}-pack)` : ""}</option>`).join("")}</select>`;
  }
  function rekeyLine(M, k, sku) {
    const [vid, oldSku] = k.split("|"), nk = vid + "|" + (sku || ""); if (nk === k) return;
    const q = (Number(M.qty[k]) || 0) + (Number(M.qty[nk]) || 0);
    const r = lineOf(k), info = M.info[k] || (r ? { vid, asku: oldSku, title: r.title, sku: r.sku, vendor: r.vendor, cost: r.cost } : {});
    M.lines = M.lines.includes(nk) ? M.lines.filter(x => x !== k) : M.lines.map(x => x === k ? nk : x);
    delete M.qty[k]; M.qty[nk] = q ? String(q) : "";
    M.info[nk] = { ...info, asku: sku || "" };
    M.rekey = M.rekey || {}; const from = M.rekey[k] != null ? M.rekey[k] : oldSku; delete M.rekey[k]; if (from !== (sku || "")) M.rekey[nk] = from;
    M.confirm = false;
  }
  // On The List -> Add to PO: pick any draft PO (this vendor's first) or start a new draft PO for the vendor
  function openToPo(id) {
    const i = cache.list.find(x => x.id === String(id)); if (!i) return;
    P.modal = { kind: "topo", id: i.id, pick: "" };
    const ven = (i.vendor || "").toLowerCase(), ds = cache.orders.filter(o => o.status === "draft");
    const mine = ds.find(o => (o.vendor || "").toLowerCase() === ven && o.kind === "order");
    P.modal.pick = mine ? mine.id : "new";
    renderModal();
  }
  function toPoHtml(M) {
    const i = cache.list.find(x => x.id === M.id); if (!i) return "";
    const ven = (i.vendor || "").toLowerCase();
    const ds = cache.orders.filter(o => o.status === "draft").sort((a, b) => ((b.vendor || "").toLowerCase() === ven) - ((a.vendor || "").toLowerCase() === ven) || String(b.updated).localeCompare(String(a.updated)));
    const opt = (v, main, sub) => `<label class="poopt ${M.pick === v ? "on" : ""}"><input type="radio" name="topo" data-topo="${esc(v)}" ${M.pick === v ? "checked" : ""}><span><b>${main}</b>${sub ? `<span class="dim small"> · ${sub}</span>` : ""}</span></label>`;
    return `<div class="panel-head"><h2>Add to PO</h2><button class="mini" data-act="close">Close</button></div>
      <div class="pickbox"><b>${esc(i.title)}</b> <span class="mono dim">${esc(i.sku)}</span> · ${esc(i.vendor || "no vendor")}${i.asku ? ` · for <span class="mono">${esc(i.asku)}</span>` : ""}</div>
      <div class="poopts">${ds.map(o => opt(o.id, `${esc(o.vendor || "(no vendor)")} ${esc(orderTitle(o))}`, `${o.kind === "booking" ? "booking order" + (o.placeBy ? ", place by " + shortDate(o.placeBy) : "") : "draft"} · ${o.lines.length} product${o.lines.length === 1 ? "" : "s"}${(o.vendor || "").toLowerCase() !== ven ? ' · <span class="warnt">different vendor</span>' : ""}`)).join("")}
        ${opt("new", "Create new draft PO", esc(i.vendor || "no vendor"))}</div>
      <p class="muted small" style="margin:0">No quantity needed — whoever places the order sets it. The product leaves the To order list.</p>
      <div class="row"><span class="dbtns right"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="topo-go" ${M.pick && !P.busy ? "" : "disabled"}>${P.busy ? "Adding…" : "Add to PO"}</button></span></div>`;
  }
  async function toPoGo() {
    const M = P.modal; if (!M || M.kind !== "topo" || !M.pick) return;
    const i = cache.list.find(x => x.id === M.id); if (!i) return;
    P.busy = true; renderModal();
    try {
      const oid = await JT.prep.listAssign({ ids: [Number(i.id)], ...(M.pick === "new" ? { new: { vendor: i.vendor || "", kind: "order" } } : { order_id: Number(M.pick) }) });
      P.busy = false; P.modal = null; renderModal(); await load(true); render();
      const o = cache.orders.find(x => x.id === String(oid));
      note("info", `${esc(i.title)} is on <button class="linkbtn" data-lord="${oid}">${esc(o ? (o.vendor ? o.vendor + " " : "") + orderTitle(o) : "order #" + oid)}</button> (draft) — it's off the To order list.`);
    } catch (err) { P.busy = false; renderModal(); note("bad", "Couldn't add it to a PO: " + esc(JT.message(err))); }
  }
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
          <span class="dbtns right"><button class="btn" data-act="close">${M.back ? "Back to shipment" : "Cancel"}</button><button class="btn primary" data-act="save-count" ${want == null || bad || want === cur || P.busy ? "disabled" : ""}>${P.busy ? "Saving…" : "Save count"}</button></span></div>` : ""}`;
    } else if (M.kind === "assign") {
      html = assignHtml(M);
    } else if (M.kind === "topo") {
      html = toPoHtml(M);
    } else if (M.kind === "newship") {
      html = newShipHtml(M);
    } else if (M.kind === "prod") {
      html = prodHtml(M);
    } else if (M.kind === "order") {
      html = orderModalHtml(M);
    } else {
      const ro = M.status === "shipped";
      const rows = M.lines.map(lineOf).filter(Boolean);
      const saved = (k) => M.sh && M.sh.status !== "shipped" ? ((M.sh.lines.find(l => l.key === k) || {}).qty || 0) : 0;
      const avail = (r) => r.qty + comingOf(keyOf(r)) - ((cache.alloc.get(keyOf(r)) || 0) - saved(keyOf(r)));   // on hand + incoming, less other shipments in progress
      let units = 0, cost = 0, lines = 0, bad = 0;
      for (const r of rows) {
        const v = M.qty[keyOf(r)], q = v === undefined || v === "" ? 0 : Number(v);
        if (v !== "" && v !== undefined && (!Number.isInteger(q) || q < 0)) bad++;
        else if (q > 0) { lines++; units += q; cost += q * (r.cost || 0); }
      }
      const found = ro ? [] : findRows(M.add, M.lines);
      const draft = { id: M.id, status: M.status, name: M.shipment, created: M.sh && M.sh.created, started: M.sh && M.sh.started,
        lines: rows.map(r => { const k = keyOf(r), v = M.qty[k] ?? "", q = v === "" ? 0 : Number(v), inf = M.info[k] || {};
          return { key: k, vid: r.vid, asku: r.asku, qty: Number.isInteger(q) && q > 0 ? q : 0, invalid: v !== "" && !(Number.isInteger(q) && q >= 0), raw: v,
            title: r.title, sku: r.sku, cost: r.cost, pid: r.pid || inf.pid || "" }; }) };
      const iss = ro ? [] : issuesOf(draft), blocked = iss.some(x => x.lvl === "bad");
      if (blocked) for (const x of iss) x.fixes = x.fixes.filter(f => f.act !== "ship-go");
      const open = (cache.shipments || []).filter(x => x.status !== "shipped" && x.id !== M.id);
      const steps = ["open", "started", "shipped"].map(st2 => `<span class="step ${st2 === M.status ? "on" : ["open", "started", "shipped"].indexOf(st2) < ["open", "started", "shipped"].indexOf(M.status) ? "done" : ""}">${STATUS[st2][0]}</span>`).join('<span class="step-sep">→</span>');
      html = `<div class="panel-head"><h2>${M.id ? esc(M.shipment || "Shipment #" + M.id) : "New shipment"}</h2><span class="steps">${steps}</span><button class="mini" data-act="close">Close</button></div>
        ${!M.id && M.fromRow && open.length && !M.single ? `<label class="small muted" for="pm-into">Add this product to <select id="pm-into" class="inp sm" style="width:auto"><option value="">a new shipment</option>${open.map(x => `<option value="${x.id}">${esc(shipTitle(x))} (${STATUS[x.status][0].toLowerCase()})</option>`).join("")}</select></label>` : ""}
        <div class="contents"><h3 class="psec" style="margin:0">What's going · pick the ASIN / seller SKU for each product</h3>
        ${rows.length ? `<div class="tbl-wrap"><table class="prept"><thead><tr><th class="l">Product</th><th class="l">Amazon listing</th>${ro ? "" : "<th>On hand</th>"}<th>${ro ? "Shipped" : "Ship"}</th><th></th></tr></thead><tbody>${
          rows.map(r => { const k = keyOf(r), v = M.qty[k] ?? "", q = v === "" ? 0 : Number(v), b = v !== "" && (!Number.isInteger(q) || q < 0), ov = q > r.qty + comingOf(k), tg = !ov && q > avail(r), as = asinsOf(r);
            return `<tr><td class="l">${esc(r.title)}<div class="meta"><span class="mono">${esc(r.sku)}</span> · ${esc(r.vendor)}</div></td>
              <td class="l small">${ro ? `${r.asku ? `<span class="mono">${esc(r.asku)}</span>` : '<span class="dim">Any listing</span>'}${as.length ? `<div class="meta mono">${esc(as.join(", "))}</div>` : ""}` : listingPick(r, k)}</td>
              ${ro ? "" : `<td>${n0(r.qty)}${comingOf(k) ? `<div class="meta">+ ${n0(comingOf(k))} incoming</div>` : ""}${avail(r) !== r.qty + comingOf(k) ? `<div class="meta">${n0(Math.max(0, avail(r)))} not in other shipments</div>` : ""}</td>`}
              <td>${ro ? `<b>${n0(q)}</b>` : `<input class="inp num sm ${b || ov ? "bad" : tg ? "warnin" : ""}" data-k="${esc(k)}" value="${esc(v)}" inputmode="numeric" placeholder="0" style="width:80px"><div class="meta"><button class="linkbtn small" data-all="${esc(k)}">all ${n0(Math.max(0, avail(r)))}</button></div>`}</td>
              <td>${ro ? "" : `<button class="linkbtn small" data-rm="${esc(k)}" title="Remove from this shipment" aria-label="Remove ${esc(r.title)}">✕</button>`}</td></tr>`; }).join("")}</tbody></table></div>` : ""}
        ${ro || (M.single && !M.id) ? "" : `<div class="addbox">
          <label class="stack" for="pm-add">Add product<input id="pm-add" class="inp mono" value="${esc(M.add)}" placeholder="ASIN, Amazon SKU or Shopify SKU" autocomplete="off"></label>
          ${M.add.trim() ? `<div class="mres">${found.map(r => `<button data-add="${esc(keyOf(r))}"><b>${esc(r.title)}</b><br><span class="dim">${esc(r.sku)}${r.asku ? " · " + esc(r.asku) : ""}${asinsOf(r).length ? " · " + esc(asinsOf(r).join(", ")) : ""} · ${n0(r.qty)} on hand${comingOf(keyOf(r)) ? ` · ${n0(comingOf(keyOf(r)))} incoming` : ""}</span></button>`).join("")
            || '<span class="muted small">Nothing in the prep center matches that ASIN or SKU.</span>'}</div>` : ""}
        </div>`}
        </div>
        <div class="pmgrid">
          <label class="stack" for="pm-ship">Shipment ID or name<input id="pm-ship" class="inp mono" value="${esc(M.shipment)}" placeholder="e.g. FBA18ABC1234" ${ro ? "disabled" : ""}></label>
          <label class="stack">Going to<span class="seg" id="pm-dest"><button data-dest="FBA" aria-pressed="${M.dest === "FBA"}" ${ro ? "disabled" : ""}>FBA</button><button data-dest="AWD" aria-pressed="${M.dest === "AWD"}" ${ro ? "disabled" : ""}>AWD</button></span></label>
          <label class="stack" for="pm-snote" style="grid-column:span 2">Note (optional)<input id="pm-snote" class="inp" value="${esc(M.note)}" ${ro ? "disabled" : ""}></label>
        </div>
        ${ro ? `<div class="note info">Shipped ${when(M.sh.shipped)}${M.sh.shippedBy ? " by " + esc(M.sh.shippedBy) : ""} to ${esc(M.dest)}. These units left the prep center.</div>` : ""}
        ${M.id ? flowHtml(M) : ""}
        ${issuesHtml(iss)}
        ${M.orderId || (M.sh && M.sh.orderId) ? (() => { const o = cache.orders.find(x => x.id === String(M.orderId || M.sh.orderId)); return o ? `<div class="row small muted">From Incoming Inventory: <button class="linkbtn small" data-fix="gotoorder" data-arg="${o.id}">${esc(o.vendor)} ${esc(orderTitle(o))}</button></div>` : ""; })() : ""}
        ${M.id && M.sh ? amzSection(M) : ""}
        ${M.confirm === "ship" ? `<div class="note warn">Mark <b>${esc(M.shipment || "this shipment")}</b> shipped to ${esc(M.dest)}? ${n0(units)} units (${lines} product${lines === 1 ? "" : "s"}, ${m0(cost)} at cost) leave the prep center. This can't be undone. <span class="dbtns"><button class="mini primary" data-act="do-ship" ${P.busy ? "disabled" : ""}>${P.busy ? "Saving…" : "Yes, shipped"}</button><button class="mini" data-act="no-ship">Cancel</button></span></div>` : ""}
        ${M.confirm === "unship" ? (() => { const u = M.lines.reduce((a, k) => a + (Number(M.qty[k]) || 0), 0), o = M.sh && M.sh.orderId && cache.orders.find(x => x.id === String(M.sh.orderId));
          return `<div class="note warn">Move <b>${esc(M.shipment || "this shipment")}</b> back to started? ${n0(u)} units go back into the prep center${o && o.status === "shipped" ? `, and ${esc(o.vendor)} ${esc(orderTitle(o))} goes back to received` : ""}. <span class="dbtns"><button class="mini primary" data-act="do-unship" ${P.busy ? "disabled" : ""}>${P.busy ? "Saving…" : "Yes, move it back"}</button><button class="mini" data-act="no-ship">Cancel</button></span></div>`; })() : ""}
        ${M.confirm === "del" ? `<div class="note warn">Delete this shipment? Nothing has left the prep center, so no stock changes. <span class="dbtns"><button class="mini primary" data-act="do-del" ${P.busy ? "disabled" : ""}>Yes, delete</button><button class="mini" data-act="no-ship">Cancel</button></span></div>` : ""}
        <div class="row"><span class="muted small">${lines ? `${n0(units)} units · ${lines} product${lines === 1 ? "" : "s"} · ${m0(cost)} at cost` : ro ? "" : rows.length ? "Enter how many units of each product are going." : "Add the products in this shipment."}${blocked && M.status === "started" ? ' · <span class="neg">fix the red items above to mark it shipped</span>' : ""}</span>
          <span class="dbtns right">${ro ? '<button class="btn" data-act="unship-ask">← Back to started</button><button class="btn" data-act="close">Close</button>' : `
            ${M.id ? '<button class="btn" data-act="del">Delete</button>' : ""}
            <button class="btn" data-act="save" ${bad || P.busy ? "disabled" : ""}>Save</button>
            ${M.status === "open" ? `<button class="btn primary" data-act="save-start" ${!lines || bad || P.busy ? "disabled" : ""}>Save &amp; start</button>` : ""}
            ${M.status === "started" ? `<button class="btn" data-act="save-reopen" ${bad || P.busy ? "disabled" : ""}>Back to open</button><button class="btn primary" data-act="ship-go" ${!lines || bad || blocked || P.busy ? "disabled" : ""}>Mark shipped</button>` : ""}`}</span></div>`;
    }
    $("prep-mcard").innerHTML = html; $("prep-mcard").classList.toggle("prod-card", M.kind === "prod");
    if (keep) { const el = keep.id ? $(keep.id) : keep.k ? box.querySelector(`input[data-k="${CSS.escape(keep.k)}"]`) : null; if (el) { el.focus(); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.s); } catch (_) {} } }
  }

  function applyFix(d) {
    const M = P.modal; if (!M) return;
    const k = d.k, focusSoon = (sel) => setTimeout(() => { const i = typeof sel === "string" ? $(sel) : sel(); if (i) { i.focus(); if (i.select) i.select(); } }, 0);
    if (d.fix === "setqty") { M.qty[k] = String(d.n); M.confirm = false; renderModal(); }
    else if (d.fix === "remove") { M.lines = M.lines.filter(x => x !== k); delete M.qty[k]; M.confirm = false; renderModal(); }
    else if (d.fix === "recount") { const [vid, asku] = k.split("|"), i = M.info[k] || {}; openCount(vid, asku, M, { vid, sku: i.sku || "", title: i.title || "", vendor: i.vendor || "", cost: i.cost ?? null });
      catalog().catch(() => {}); focusSoon("pm-qty"); }
    else if (d.fix === "focus") focusSoon(d.arg);
    else if (d.fix === "focusk") focusSoon(() => document.querySelector(`#prep-modal input[data-k="${CSS.escape(k)}"]`));
    else if (d.fix === "goto") openShipment(d.arg);
    else if (d.fix === "gotoorder") openOrder(d.arg);
    else if (d.fix === "tab" || d.fix === "costs") {
      P.modal = null; renderModal();
      const t = document.querySelector(`.tabs button[data-tab="${d.fix === "costs" ? "costs" : d.arg}"]`); if (t) t.click();
      if (d.fix === "costs") setTimeout(() => { const q = $("pc-q"), st = $("pc-stat"); if (st) { st.value = "all"; st.dispatchEvent(new Event("change")); } if (q) { q.value = d.arg; q.dispatchEvent(new Event("input")); } }, 50);
    }
  }
  async function saveCount() {
    const M = P.modal; if (!M || !M.pick) return;
    P.busy = true; renderModal();
    try {
      await JT.prep.adjust({ lines: [{ variant_id: Number(M.pick.vid), amazon_sku: M.asku || "", qty: Number(M.qty), note: M.note || "" }] });
      note("info", `Saved the count for ${esc(M.pick.title)}.`); await load(true); closeModal(); render(); refreshTotals();
    } catch (e) { P.busy = false; renderModal(); note("bad", "Couldn't save: " + esc(JT.message(e))); }
  }
  // Save the editor, then optionally move the status (started / open / shipped).
  async function saveShipment(next) {
    const M = P.modal; if (!M) return;
    const lines = M.lines.map(k => { const [vid, sku] = k.split("|"); return { variant_id: Number(vid), amazon_sku: sku || "", qty: Number(M.qty[k]) || 0 }; }).filter(l => l.qty > 0);
    P.busy = true; renderModal();
    try {
      // lines moved from "any listing" to a listing: earmark the not-earmarked stock they'll ship from
      if (M.status !== "shipped") for (const [nk, from] of Object.entries(M.rekey || {})) {
        const [vid, sku] = nk.split("|"), q = Number(M.qty[nk]) || 0; if (from !== "" || !sku || !q || !M.lines.includes(nk)) continue;
        const have = prepHere(vid, sku).qty, take = Math.min(Math.max(0, q - have), prepHere(vid, "").qty);
        if (take > 0) await JT.prep.assign({ variant_id: Number(vid), from_sku: "", moves: [{ to_sku: sku, qty: take }], note: "for shipment " + (M.shipment.trim() || "#" + (M.id || "new")) });
      }
      const id = await JT.prep.saveShipment({ id: M.id ? Number(M.id) : null, name: M.shipment.trim(), dest: M.dest, note: M.note || "", lines, ...(M.orderId ? { order_id: Number(M.orderId) } : {}) });
      if (next) await JT.prep.setShipmentStatus(id, next);
      const u = lines.reduce((a, l) => a + l.qty, 0), nm = M.shipment.trim() || "Shipment #" + id;
      closeModal();
      note("info", next === "shipped" ? `<b>${esc(nm)}</b> marked shipped to ${esc(M.dest)}: ${n0(u)} units taken out of the prep center.`
        : next === "started" ? `<b>${esc(nm)}</b> started.` : next === "open" ? `<b>${esc(nm)}</b> moved back to open.` : `<b>${esc(nm)}</b> saved.`);
      if (next === "shipped") P.shipView = "open";
      await load(true); render(); refreshTotals();
    } catch (e) { P.busy = false; M.confirm = false; renderModal(); note("bad", "Couldn't save the shipment: " + esc(JT.message(e))); }
  }
  async function unship() {
    const M = P.modal; if (!M || !M.id) return;
    P.busy = true; renderModal();
    try {
      await JT.prep.setShipmentStatus(Number(M.id), "started");
      const nm = M.shipment || "Shipment #" + M.id; P.busy = false; P.modal = null;
      note("info", `<b>${esc(nm)}</b> moved back to started; its units are back in the prep center.`);
      P.shipView = "open"; await load(true); render(); refreshTotals();
    } catch (e) { P.busy = false; M.confirm = false; renderModal(); note("bad", "Couldn't move it back: " + esc(JT.message(e))); }
  }
  async function quickStatus(id, next) {
    try { await JT.prep.setShipmentStatus(Number(id), next); note("info", next === "started" ? "Shipment started." : next === "open" ? "Shipment moved back to open." : ""); await load(true); render(); }
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
    on("prep-amzsync", "click", () => syncAmz());
    on("prep-count", "click", () => openCount());
    on("prep-ship", "click", () => openNewShip());
    on("prep-vendor", "change", (e) => { P.vendor = e.target.value; render(); });
    on("prep-q", "input", (e) => { P.q = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(render, 200); });
    on("prep-shview", "click", (e) => { const b = e.target.closest("button[data-v]"); if (b) { P.shipView = b.dataset.v; renderShipments(); } });
    on("prep-ships", "click", (e) => {
      const b = e.target.closest("button[data-sact]");
      if (b) { e.stopPropagation(); if (b.dataset.sact === "new") return openNewShip(); if (b.dataset.sact === "started") return quickStatus(b.dataset.sid, "started");
        if (b.dataset.sact === "fix") return openShipment(b.dataset.sid);
        if (b.dataset.sact === "close") { b.disabled = true; return flowDo(b.dataset.sid, { close: true }, "Shipment closed."); }
        if (b.dataset.sact === "amzlink") { const sg = cache.amzSuggest.get(b.dataset.sid); if (sg) amzLinkAsk(b.dataset.sid, sg.g.ships.map(a => a.id), sg.how === "id" ? "id" : "match"); return; }
        if (b.dataset.sact === "back") { const sh = cache.shipments.find(x => x.id === b.dataset.sid);
          if (sh.status === "shipped") { openShipment(sh.id); P.modal.confirm = "unship"; renderModal(); } else quickStatus(sh.id, SPREV[sh.status]); return; }
        if (b.dataset.sact === "ship") { openShipment(b.dataset.sid); P.modal.confirm = "ship"; renderModal(); } return; }
      if (e.target.closest("a")) return;   // links on the card (Seller Central SKU) open on their own
      const c = e.target.closest(".shipcard[data-sid]"); if (c) openShipment(c.dataset.sid);
    });
    on("prep-ships", "keydown", (e) => { if (e.target.closest("a")) return; const c = e.target.closest(".shipcard[data-sid]"); if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openShipment(c.dataset.sid); } });
    on("prep-mkind", "click", (e) => { const b = e.target.closest("button[data-k]"); if (b) { P.moveKind = b.dataset.k; renderMoves(); } });
    $("tab-prep").addEventListener("change", async (e) => {
      const t = e.target; if (!t.dataset || t.dataset.arrival == null || t.closest("#prep-modal")) return;
      t.disabled = true;
      try { await JT.prep.setArrival({ id: Number(t.dataset.arrival), arrival_on: t.value || null }); await load(true); render(); note("info", t.value ? `Arrival set to ${shortDate(t.value)}.` : "Arrival date cleared."); }
      catch (err) { t.disabled = false; note("bad", "Couldn't save the date: " + esc(JT.message(err))); }
    });
    $("tab-prep").addEventListener("click", (e) => {
      const pr = e.target.closest("tr[data-prod]");
      if (pr && !e.target.closest("button, a, input, select") && !String(window.getSelection() || "")) { openProduct(pr.dataset.prod, pr.dataset.psku); return; }
      const b = e.target.closest("[data-act]"); if (!b || b.closest("#prep-modal")) return;
      if (b.dataset.act === "count") openCount(b.dataset.vid, b.dataset.sku);
      if (b.dataset.act === "ship") openShip(b.dataset.vid, b.dataset.sku, b.dataset.oid, b.dataset.n ? Number(b.dataset.n) : 0);
      if (b.dataset.act === "gotoorder") openOrder(b.dataset.oid);
      if (b.dataset.act === "plan-inv") planInvoice(b.dataset.iid);
      if (b.dataset.act === "inc-hidden") { P.incHidden = !P.incHidden; renderIncoming(); }
      if (b.dataset.act === "inc-hide" || b.dataset.act === "inc-show") {
        const hide = b.dataset.act === "inc-hide", r = (cache.poRows || []).find(x => x.oid === b.dataset.oid && x.vid === b.dataset.vid && x.asku === (b.dataset.sku || ""));
        b.disabled = true;
        JT.prep.incomingHide({ order_id: Number(b.dataset.oid), variant_id: Number(b.dataset.vid), amazon_sku: b.dataset.sku || "", dest: "prep", hide })
          .then(async () => { await load(true); render(); note("info", hide ? `<b>${esc(r ? r.title : "Product")}</b> removed from Incoming products. It's still on ${esc(r ? r.name : "the PO")}; <button class="linkbtn" data-act="inc-hidden">show removed</button> to put it back.` : `<b>${esc(r ? r.title : "Product")}</b> is back on Incoming products.`); })
          .catch(err => { b.disabled = false; note("bad", "Couldn't update the list: " + esc(JT.message(err))); });
      }
      if (b.dataset.act === "assign") openAssign(b.dataset.vid, b.dataset.sku);
      if (b.dataset.act === "list") { b.disabled = true; addToList({ variant_id: Number(b.dataset.vid), amazon_sku: b.dataset.sku || "", dest: "prep", source: "prep" })
        .then((r) => note("info", `Added to ${r.where}.`), (err) => { b.disabled = false; note("bad", "Couldn't add it: " + esc(JT.message(err))); }); }
    });
    const box = $("prep-modal");
    box.addEventListener("mousedown", (e) => { if (e.target === box && !P.busy) closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && P.modal && !P.busy) closeModal(); });
    box.addEventListener("input", (e) => {
      const M = P.modal, t = e.target; if (!M) return;
      if (M.kind === "assign") { if (t.dataset.aq != null) { M.qty[t.dataset.aq] = t.value.trim(); clearTimeout(box._t); box._t = setTimeout(renderModal, 250); } else if (t.id === "pm-anote") M.note = t.value; return; }
      if (t.id === "pm-nq") { M.q = t.value; clearTimeout(box._t); box._t = setTimeout(renderModal, 150); return; }
      if (t.id === "pm-exc") { M.excEdit = t.value; return; }
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
      if (e.target.dataset && e.target.dataset.topo != null && M.kind === "topo") { M.pick = e.target.dataset.topo; renderModal(); }
      if (e.target.id === "pm-amz") { M.amzPick = e.target.value; renderModal(); }
      if (e.target.dataset && e.target.dataset.lsku != null && M.kind === "ship") { rekeyLine(M, e.target.dataset.lsku, e.target.value); renderModal(); }
      if (e.target.id === "pm-place" && M.id) flowDo(M.id, { placement: e.target.value });
      if (M.recon && e.target.dataset.rto) { const r = M.recon.rows.find(x => String(x.vid) === e.target.dataset.rto); if (r) { r.to = e.target.value; renderModal(); } }
      if (M.recon && e.target.dataset.rsku) { const r = M.recon.rows.find(x => String(x.vid) === e.target.dataset.rsku); if (r) { r.tsku = e.target.value; r.to = "prep"; renderModal(); } }
      if (e.target.id === "pm-into" && e.target.value) {
        const oid = M.orderId, k = M.fromRow, qv = M.qty[k];
        openShipment(e.target.value, k);
        if (P.modal && !P.modal.orderId && oid) P.modal.orderId = oid;          // made from a vendor order: count it against that order
        if (P.modal && k && qv && !P.modal.qty[k]) { P.modal.qty[k] = qv; renderModal(); }
      }
    });
    box.addEventListener("keydown", (e) => {
      const M = P.modal; if (!M || e.key !== "Enter") return;
      if (e.target.id === "pm-nq") { e.preventDefault(); clearTimeout(box._t); M.q = e.target.value; const c = skuCandidates(M.q).list; if (c.length === 1) pickNewShip(c[0]); else renderModal(); return; }
      if (e.target.id === "pm-q") { const b = box.querySelector(".mres button[data-pick]"); if (b) b.click(); }
      else if (e.target.id === "pm-add") { e.preventDefault(); clearTimeout(box._t); const f = findRows(M.add, M.lines); if (f.length) addLine(keyOf(f[0])); else renderModal(); }
      else if (M.kind === "ship" && e.target.dataset.k) { e.preventDefault(); const a = $("pm-add"); if (a) a.focus(); }
      else if (M.kind === "count" && (e.target.id === "pm-qty" || e.target.id === "pm-note")) { const b = box.querySelector('[data-act="save-count"]'); if (b && !b.disabled) saveCount(); }
    });
    box.addEventListener("click", (e) => {
      const M = P.modal, b = e.target.closest("button"); if (!M || !b) return;
      if (b.dataset.act === "close") return closeModal();
      if (M.kind === "topo") { if (b.dataset.act === "topo-go") toPoGo(); return; }
      if (M.kind === "newship") { if (b.dataset.pickship != null) { const c = skuCandidates(M.q).list[+b.dataset.pickship]; if (c) pickNewShip(c); } return; }
      if (M.kind === "prod") { if (b.dataset.act === "gotoorder") { P.modal = null; renderModal(); openOrder(b.dataset.oid); } return; }
      if (b.dataset.pick) { const v = cat.find(x => x.vid === b.dataset.pick); M.pick = { vid: v.vid, sku: v.sku, title: v.title, vendor: v.vendor, cost: v.cost }; M.asku = ""; renderModal(); setTimeout(() => { const i = $("pm-qty"); if (i) i.focus(); }, 0); return; }
      if (b.dataset.act === "repick") { M.pick = null; M.qty = ""; renderModal(); setTimeout(() => { const i = $("pm-q"); if (i) i.focus(); }, 0); return; }
      if (b.dataset.act === "save-count") return saveCount();
      if (M.kind === "assign") {
        if (b.dataset.act === "save-assign") return saveAssign();
        if (b.dataset.aall != null) { const r = cache.rows.find(x => x.vid === M.vid && x.asku === M.from), t = (r.listings.find(l => l.sku === b.dataset.aall) || {}), u = t.units || 1;
          let other = 0; for (const [k, v] of Object.entries(M.qty)) if (k !== b.dataset.aall) other += Number(v) || 0;
          M.qty[b.dataset.aall] = String(Math.floor(Math.max(0, r.qty - other) / u) * u); renderModal(); return; }
        return;
      }
      if (b.dataset.fix) return applyFix(b.dataset);
      if (b.dataset.dest) { M.dest = b.dataset.dest; M.confirm = false; renderModal(); return; }
      if (b.dataset.add) return addLine(b.dataset.add);
      if (b.dataset.rm) { M.lines = M.lines.filter(k => k !== b.dataset.rm); delete M.qty[b.dataset.rm]; M.confirm = false; renderModal(); return; }
      if (b.dataset.all) { const r = lineOf(b.dataset.all), sv = M.sh && M.sh.status !== "shipped" ? ((M.sh.lines.find(l => l.key === b.dataset.all) || {}).qty || 0) : 0;
        M.qty[b.dataset.all] = String(Math.max(0, r.qty + comingOf(b.dataset.all) - ((cache.alloc.get(b.dataset.all) || 0) - sv))); M.confirm = false; renderModal(); return; }
      if (b.dataset.flow) return flowClick(M, b);
      if (b.dataset.act === "amz-link-sugg") { const sg = cache.amzSuggest.get(String(M.id)); if (sg) amzLinkAsk(M.id, sg.g.ships.map(a => a.id), sg.how === "id" ? "id" : "match"); return; }
      if (b.dataset.act === "amz-sync") { syncAmz(); return; }
      if (b.dataset.act === "amz-link-pick") { if (M.amzPick) amzLinkAsk(M.id, M.amzPick.split(","), "manual"); return; }
      if (b.dataset.act === "recon-open") return amzLinkAsk(M.id, [], "");
      if (b.dataset.act === "recon-cancel") { M.recon = null; renderModal(); return; }
      if (b.dataset.act === "recon-go") { const R = M.recon; if (R) amzLink(M.id, R.ids, R.how, false, { lines: R.lines, dispose: R.rows.filter(x => x.prep > x.amz).map(x => ({ variant_id: Number(x.vid), to: x.to, ...(x.to === "prep" ? { amazon_sku: x.tsku } : {}) })) }); return; }
      if (b.dataset.act === "amz-unlink") return amzLink(M.id, [b.dataset.aid], "", true);
      if (b.dataset.act === "save") return saveShipment(null);
      if (b.dataset.act === "save-start") return saveShipment("started");
      if (b.dataset.act === "save-reopen") return saveShipment("open");
      if (b.dataset.act === "ship-go") { M.confirm = "ship"; renderModal(); return; }
      if (b.dataset.act === "del") { M.confirm = "del"; renderModal(); return; }
      if (b.dataset.act === "no-ship") { M.confirm = false; renderModal(); return; }
      if (b.dataset.act === "do-ship") return saveShipment("shipped");
      if (b.dataset.act === "do-del") return deleteShipment();
      if (b.dataset.act === "unship-ask") { M.confirm = "unship"; renderModal(); return; }
      if (b.dataset.act === "do-unship") return unship();
    });
  }

  bind();
  bindList();
  window.addEventListener("jt:catalog", () => { cat = null; if (!$("tab-prep").hidden) refresh(true); else P.shown = false; });
  window.prepShow = () => { if (!P.shown) { P.shown = true; refresh(false); } else render(); };
  window.JTPrepTab = { _state: P,
    // from the Purchase orders tab: an Amazon Outgoing shipment made from a received order
    async shipFromOrder(id) { const b = document.querySelector('.tabs button[data-tab="prep"]'); if (b) b.click(); await load(true); P.shown = true; render();
      const o = cache.orders.find(x => x.id === String(id)); if (o) shipFromOrder(o); } };
  if ((location.hash || "") === "#prep") setTimeout(() => window.prepShow(), 0);
})();
