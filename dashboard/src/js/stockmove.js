(() => {
  // Move stock between silos in two clicks (Brian, Oct 23 — real-world request: "move inventory between silos
  // (Shop/Amazon/Prep Center) very easily … we don't have Gut on shopify but we have 100s in stock. should enable
  // selling on all channels").
  //   Prep center → Shopify store, Shopify store → Prep center: saved at once with jt.inventory_edit (the prep side is
  //   logged in jt.prep_moves, the Shopify side goes to Shopify through the fbm-inventory sync in a minute or two).
  //   Prep center → Amazon, Shopify store → Amazon: opens a new Amazon shipment with the units on it (store units are
  //   moved into the prep center first). FBA / AWD stock only comes back through a removal order in Seller Central.
  // window.JTMove.open(variantId) from any page; pages listen for "jt:stockmoved" to redraw.
  const JT = window.JT;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const n0 = (x) => Math.round(x || 0).toLocaleString();
  let M = null;   // {vid, title, sku, vendor, cost, shop, prep: [{sku, qty}], listings: [{sku, asin}], fba, awd, dir, from, to, qty, busy, err}

  const ROUTES = [
    ["prep>shop", "Prep center", "Shopify store"],
    ["shop>prep", "Shopify store", "Prep center"],
    ["prep>amz", "Prep center", "Amazon (new shipment)"],
    ["shop>amz", "Shopify store", "Amazon (new shipment)"],
  ];
  const vidOk = (v) => /^\d+$/.test(String(v));

  async function open(vid) {
    if (!vidOk(vid)) return;
    host();
    M = { vid: String(vid), loading: true, dir: null, qty: "", from: "", to: "" };
    paint();
    try {
      const [v, pi, sq] = await Promise.all([
        JT.rows(["coalesce(nullif(display_name, ''), product_title)", "sku", "vendor", "unit_cost"], `from jt.variants where variant_id = ${vid}`, true),
        JT.rows(["amazon_sku", "qty"], `from jt.prep_items where variant_id = ${vid} and qty > 0 order by qty desc`, true),
        JT.rows(["jt.shopify_qty_now(" + vid + ")"], "", true).catch(() => null),
      ]);
      const x = v[0] || [];
      const pd = window.JTPrep && window.JTPrep.data;
      const listings = pd && pd.byVariant ? (pd.byVariant.get(String(vid)) || []).map(l => ({ sku: l.sku, asin: l.asin || "", units: l.units || 1 })) : [];
      const fd = JT.fba && JT.fba.data;
      let fba = 0, awd = 0;
      if (fd && fd.items) for (const i of fd.items) if (i.map && String(i.map.vid) === String(vid)) { const u = i.map.units || 1; fba += ((i.avail || 0) + (i.inbound || 0) + (i.transfer || 0)) * u; awd += ((i.awdAvail || 0) + (i.awdIn || 0)) * u; }
      M = { ...M, loading: false, title: x[0] || "variant " + vid, sku: x[1] || "", vendor: x[2] || "", cost: x[3] == null ? null : +x[3],
        shop: sq && sq[0] && sq[0][0] != null ? +sq[0][0] : 0, prep: pi.map(r => ({ sku: r[0] || "", qty: +r[1] || 0 })), listings, fba, awd };
      const prepN = M.prep.reduce((a, r) => a + r.qty, 0);
      M.dir = M.shop <= 0 && prepN > 0 ? "prep>shop" : prepN > 0 ? "prep>shop" : M.shop > 0 ? "shop>prep" : "prep>shop";
      pickDefaults();
    } catch (e) { M.loading = false; M.err = JT.message ? JT.message(e) : String(e); }
    paint();
    setTimeout(() => { const i = $("mv-qty"); if (i) { i.focus(); i.select(); } }, 0);
  }
  const prepTotal = () => M.prep.reduce((a, r) => a + r.qty, 0);
  const fromQty = () => M.dir.startsWith("prep") ? (M.prep.find(r => r.sku === M.from) || { qty: 0 }).qty : Math.max(0, M.shop);
  function pickDefaults() {
    if (M.dir.startsWith("prep")) { if (!M.prep.some(r => r.sku === M.from)) M.from = M.prep[0] ? M.prep[0].sku : ""; }
    if (M.dir === "shop>prep" || M.dir === "shop>amz") { if (!["", ...M.listings.map(l => l.sku)].includes(M.to)) M.to = M.listings.length === 1 ? M.listings[0].sku : ""; }
    if (M.dir === "prep>amz" && !M.from && M.listings.length === 1) M.to = M.listings[0].sku;
  }
  const label = (sku) => sku ? sku : "any listing (not earmarked)";

  function host() {
    if ($("mv-modal")) return;
    const d = document.createElement("div");
    d.className = "modal"; d.id = "mv-modal"; d.hidden = true;
    d.innerHTML = '<div class="modal-card mv-card" id="mv-card" role="dialog" aria-modal="true" aria-label="Move stock"></div>';
    document.body.appendChild(d);
    d.addEventListener("click", (e) => { if (e.target === d) close(); });
    d.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); if (e.key === "Enter" && e.target.id === "mv-qty") { e.preventDefault(); go(); } });
    d.addEventListener("input", (e) => { if (e.target.id === "mv-qty") { M.qty = e.target.value; paintFoot(); } });
    d.addEventListener("change", (e) => {
      if (e.target.id === "mv-from") { M.from = e.target.value; paint(); }
      if (e.target.id === "mv-to") { M.to = e.target.value; paint(); }
    });
    d.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b || !M) return;
      if (b.dataset.mvDir) { M.dir = b.dataset.mvDir; pickDefaults(); paint(); const i = $("mv-qty"); if (i) i.focus(); return; }
      if (b.dataset.mvQ) { M.qty = b.dataset.mvQ === "all" ? String(fromQty()) : b.dataset.mvQ; paint(); return; }
      if (b.dataset.mv === "close") return close();
      if (b.dataset.mv === "go") return go();
      if (b.dataset.mv === "product" && window.JTPrepTab && window.JTPrepTab.openProduct) { const v = M.vid; close(); window.JTPrepTab.openProduct(v); }
    });
  }
  function close() { M = null; const d = $("mv-modal"); if (d) d.hidden = true; document.body.classList.remove("modal-open"); }

  function paint() {
    const d = $("mv-modal"), c = $("mv-card"); if (!d || !M) return;
    d.hidden = false; document.body.classList.add("modal-open");
    if (M.loading) { c.innerHTML = '<div class="muted small">Loading where it is…</div>'; return; }
    if (M.err) { c.innerHTML = `<div class="note bad">Couldn't load it: ${esc(M.err)}</div><div class="row"><button class="btn" data-mv="close">Close</button></div>`; return; }
    const pt = prepTotal(), max = fromQty(), toAmz = M.dir.endsWith("amz");
    const tile = (k, l, v, s) => `<div class="mv-tile ${k}"><span class="eyebrow">${l}</span><b class="num">${v}</b>${s ? `<span class="small muted">${s}</span>` : ""}</div>`;
    const prepSel = M.prep.length > 1 ? `<label class="stack">From listing<select id="mv-from" class="inp sm">${M.prep.map(r => `<option value="${esc(r.sku)}" ${r.sku === M.from ? "selected" : ""}>${esc(label(r.sku))} · ${n0(r.qty)}</option>`).join("")}</select></label>`
      : M.prep.length === 1 && M.dir.startsWith("prep") ? `<div class="small muted">From ${esc(label(M.prep[0].sku))}</div>` : "";
    const toSel = (M.dir === "shop>prep" || M.dir === "shop>amz") && M.listings.length
      ? `<label class="stack">${M.dir === "shop>amz" ? "For Amazon listing" : "Earmark for"}<select id="mv-to" class="inp sm">${M.dir === "shop>prep" ? `<option value="" ${M.to === "" ? "selected" : ""}>any listing (not earmarked)</option>` : ""}${M.listings.map(l => `<option value="${esc(l.sku)}" ${l.sku === M.to ? "selected" : ""}>${esc(l.sku)}${l.asin ? " · " + esc(l.asin) : ""}${l.units !== 1 ? ` · ${l.units}-pack` : ""}</option>`).join("")}</select></label>` : "";
    const ok = ROUTES.map(([k, f, t]) => {
      const can = k.startsWith("prep") ? pt > 0 : M.shop > 0;
      const why = !can ? (k.startsWith("prep") ? "Nothing in the prep center" : "Nothing in the Shopify store") : k.endsWith("amz") && !M.listings.length ? "No Amazon listing mapped to this product" : "";
      return `<button type="button" data-mv-dir="${k}" aria-pressed="${M.dir === k}" ${why ? `disabled title="${esc(why)}"` : ""}>${esc(f)} → ${esc(t)}</button>`;
    }).join("");
    c.innerHTML = `<div class="panel-head"><h2>Move stock</h2><button class="mini" data-mv="close">Close</button></div>
      <div><b>${esc(M.title)}</b> <span class="mono small dim">${esc(M.sku)}</span>${M.vendor ? ` <span class="small muted">· ${esc(M.vendor)}</span>` : ""}</div>
      <div class="mv-tiles">${tile(M.shop <= 0 ? "low" : "", "Shopify store", n0(M.shop), M.shop <= 0 ? "can't sell online" : "")}${tile("", "Prep center", n0(pt), M.prep.length > 1 ? `${M.prep.length} listings` : M.prep.length ? esc(label(M.prep[0].sku)) : "")}${tile("", "Amazon FBA", n0(M.fba), "")}${tile("", "Amazon AWD", n0(M.awd), "")}</div>
      <div class="seg mv-routes" role="group" aria-label="From → to">${ok}</div>
      <div class="row mv-row">${M.dir.startsWith("prep") ? prepSel : ""}${toSel}
        <label class="stack">Units<input id="mv-qty" class="inp num" inputmode="numeric" value="${esc(M.qty)}" placeholder="0" style="width:90px"></label>
        <span class="dbtns mv-quick">${[6, 12, 24, 48].filter(q => q < max).map(q => `<button class="mini" type="button" data-mv-q="${q}">${q}</button>`).join("")}${max > 0 ? `<button class="mini" type="button" data-mv-q="all">All ${n0(max)}</button>` : ""}</span></div>
      <div id="mv-foot"></div>
      <div class="small muted">${toAmz ? "Opens a new Amazon shipment in the prep center with these units on it — count, pack and send it as usual." : "Shopify updates in a minute or two (the inventory sync applies it at the store's location)."} FBA and AWD stock only comes back through a removal order in Seller Central.</div>`;
    paintFoot();
  }
  function paintFoot() {
    const f = $("mv-foot"); if (!f || !M) return;
    const q = Number(M.qty), max = fromQty(), bad = M.qty !== "" && (!Number.isInteger(q) || q <= 0), over = Number.isInteger(q) && q > max && !M.dir.startsWith("shop");
    const shopOver = M.dir.startsWith("shop") && Number.isInteger(q) && q > max;
    const route = ROUTES.find(r => r[0] === M.dir);
    const after = Number.isInteger(q) && q > 0 && !bad && !over && !shopOver
      ? M.dir === "prep>shop" ? `Store ${n0(M.shop)} → <b>${n0(M.shop + q)}</b> · prep center ${n0(prepTotal())} → ${n0(prepTotal() - q)}`
      : M.dir === "shop>prep" ? `Store ${n0(M.shop)} → <b>${n0(M.shop - q)}</b> · prep center ${n0(prepTotal())} → ${n0(prepTotal() + q)}`
      : `${n0(q)} unit${q === 1 ? "" : "s"} onto a new Amazon shipment` : "";
    f.innerHTML = `<div class="row">${bad ? '<span class="neg small">Whole units above 0.</span>' : over || shopOver ? `<span class="neg small">Only ${n0(max)} there.</span>` : `<span class="small">${after}</span>`}
      ${M.err2 ? `<span class="neg small">${esc(M.err2)}</span>` : ""}
      <span class="dbtns right"><button class="btn" data-mv="close">Cancel</button><button class="btn primary" data-mv="go" ${!after || M.busy ? "disabled" : ""}>${M.busy ? "Moving…" : route[0].endsWith("amz") ? "Start shipment" : `Move to ${route[2]}`}</button></span></div>`;
  }

  async function go() {
    if (!M || M.busy) return;
    const q = Number(M.qty), max = fromQty();
    if (!Number.isInteger(q) || q <= 0 || q > max) return;
    M.busy = true; M.err2 = ""; paintFoot();
    const title = M.title, vid = M.vid;
    try {
      if (M.dir === "prep>shop") await JT.prep.inventoryEdit({ variant_id: Number(vid), note: "quick move", moves: [{ dir: "to_shopify", amazon_sku: M.from, qty: q }] });
      else if (M.dir === "shop>prep") await JT.prep.inventoryEdit({ variant_id: Number(vid), note: "quick move", moves: [{ dir: "from_shopify", amazon_sku: M.to, qty: q }] });
      else {
        let asku = M.dir === "prep>amz" ? M.from : M.to;
        if (M.dir === "shop>amz") await JT.prep.inventoryEdit({ variant_id: Number(vid), note: "to Amazon shipment", moves: [{ dir: "from_shopify", amazon_sku: asku, qty: q }] });
        if (!asku && M.listings.length === 1) asku = M.listings[0].sku;     // not earmarked: the shipment earmarks it for the one listing
        const lines = [{ vid, asku, qty: q, title, sku: M.sku, vendor: M.vendor, cost: M.cost }], shopD = M.dir === "shop>amz" ? -q : 0;
        close();
        window.dispatchEvent(new CustomEvent("jt:stockmoved", { detail: { vid, shop: shopD } }));
        if (window.JTPrep && window.JTPrep.startShipment) await window.JTPrep.startShipment({ lines, note: "" });
        return;
      }
      const dir = M.dir; close();
      if (window.JTPrep) await window.JTPrep.load(true).catch(() => {});
      window.dispatchEvent(new CustomEvent("jt:stockmoved", { detail: { vid, shop: dir === "prep>shop" ? q : -q } }));
      toast(`${esc(title)}: moved ${n0(q)} ${dir === "prep>shop" ? "from the prep center to the Shopify store" : "from the Shopify store to the prep center"}. Shopify updates in a minute or two.`);
    } catch (e) { if (M) { M.busy = false; M.err2 = "Couldn't move it: " + (JT.message ? JT.message(e) : String(e)); paintFoot(); } }
  }
  // a short confirmation that doesn't depend on the page it was opened from
  function toast(html) {
    let t = $("mv-toast"); if (!t) { t = document.createElement("div"); t.id = "mv-toast"; t.className = "mv-toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.innerHTML = html; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => { t.hidden = true; }, 7000);
  }
  window.JTMove = { open };
})();
