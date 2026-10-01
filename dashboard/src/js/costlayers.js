(() => {
  // Cost layers (FIFO) for inventory value — see db/migrations/028_cost_layers.sql. A product whose cost was applied
  // from a purchase order has an opening layer (what it had on hand before, at its old cost) and one layer per PO
  // receipt since, at the PO cost. Stock on hand is valued newest layer first. Products without layers use the
  // Shopify cost as before. window.JTCost.
  const C = { layers: new Map(), shop: new Map(), prep: new Map(), loaded: false, loading: null };
  const tOf = (s) => { const d = new Date(s); return isNaN(d) ? 0 : d.getTime(); };
  async function load(refresh, vids) {
    if (C.loading && !refresh) return C.loading;
    C.loading = (async () => {
      const rows = await JT.rows(["variant_id::text", "kind", "order_id::text", "po_no", "qty", "unit_cost", "at::text"], "from jt.v_cost_layers", true);
      const layers = new Map();
      for (const [vid, kind, oid, po, qty, cost, at] of rows) { const a = layers.get(vid) || []; a.push({ kind, orderId: oid, po: po || "", qty: +qty || 0, cost: +cost, at, t: tOf(at) }); layers.set(vid, a); }
      for (const a of layers.values()) a.sort((x, y) => (x.kind === "opening" ? -1 : y.kind === "opening" ? 1 : x.t - y.t));
      const want = [...new Set([...layers.keys(), ...(vids || []).map(String)])].filter(v => /^\d+$/.test(v));
      const [sh, pr] = want.length ? await Promise.all([
        JT.rows(["variant_id::text", "inventory_qty"], `from jt.variants where variant_id in (${want.join(",")})`, true),
        JT.rows(["variant_id::text", "sum(qty)"], `from jt.prep_items where variant_id in (${want.join(",")}) group by 1`, true),
      ]) : [[], []];
      C.layers = layers; C.shop = new Map(sh.map(([v, q]) => [v, Math.max(0, +q || 0)])); C.prep = new Map(pr.map(([v, q]) => [v, +q || 0])); C.loaded = true;
      return C;
    })();
    try { return await C.loading; } finally { C.loading = null; }
  }
  // Amazon units of a product (FBA + AWD incl. inbound), through the listings mapped to it
  function amzUnits(vid) {
    const fd = JT.fba && JT.fba.data; if (!fd) return 0;
    // units only (JT.fba.unitsOf): JT.fba.totals values items through unit() below, which would loop back here
    let u = 0; for (const it of fd.items) if (it.map && it.map.vid === String(vid) && it.map.kind !== "manual") u += Math.max(0, JT.fba.unitsOf(it, true)) * (it.map.units || 1);
    return u;
  }
  const onHand = (vid) => (C.shop.get(String(vid)) || 0) + (C.prep.get(String(vid)) || 0) + amzUnits(vid);
  // value of n units on hand: newest layers first; anything beyond the layers at the opening (oldest) cost
  function fifo(layers, n) {
    let left = Math.max(0, n), v = 0;
    const newest = layers.slice().sort((a, b) => (a.kind === "opening") - (b.kind === "opening") || b.t - a.t);
    for (const l of newest) { if (left <= 0) break; const q = l.kind === "opening" ? left : Math.min(left, l.qty); v += q * l.cost; left -= q; }
    if (left > 0 && newest.length) v += left * newest[newest.length - 1].cost;
    return v;
  }
  const has = (vid) => C.layers.has(String(vid));
  function unit(vid, fallback) {
    const L = C.layers.get(String(vid)); if (!L) return fallback;
    const n = onHand(vid);
    if (n <= 0) { const po = L.filter(l => l.kind === "po"); return po.length ? po[po.length - 1].cost : L[0].cost; }
    return fifo(L, n) / n;
  }
  // "12 @ $6.00 (PO …) · 4 @ $5.00 (before)": what the units on hand are valued at
  function describe(vid) {
    const L = C.layers.get(String(vid)); if (!L) return "";
    let left = onHand(vid); const parts = [];
    const newest = L.slice().sort((a, b) => (a.kind === "opening") - (b.kind === "opening") || b.t - a.t);
    for (const l of newest) { if (left <= 0) break; const q = l.kind === "opening" ? left : Math.min(left, l.qty); if (q > 0) parts.push(`${Math.round(q)} @ $${l.cost.toFixed(2)} ${l.kind === "opening" ? "(older stock)" : "(PO " + (l.po || l.orderId) + ")"}`); left -= q; }
    return parts.join(" · ");
  }
  window.JTCost = { load, has, unit, onHand, fifo, describe, layers: (vid) => C.layers.get(String(vid)) || null, get loaded() { return C.loaded; } };
})();
