(() => {
  // Shipping › Ship orders (Nov 2, Brian: "a smoother shipping option where we buy shopify shipping but have a cleaner ui
  // on top of it" — Just Tennis + Ace n Rally, one order at a time, carrier/service picked per order). A pack station:
  // the open orders on the left; the picked one on the right — what's in it (scan or tick each item), the box, the
  // weight, the service — then Buy label, and the label opens to print. Labels are bought in Shopify (Shopify Shipping,
  // edge function `ship`), so tracking goes to the customer and the order is fulfilled there; the cost shows up in
  // Seller Sage's profit with the other Shopify labels. Shopify's API doesn't quote prices before buying or void labels:
  // voids are done in Shopify (the order's ⋯ menu).
  const JT = window.JT, $ = (id) => document.getElementById(id);
  if (!JT || !$("tab-labels")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n0 = (x) => Math.round(Number(x) || 0).toLocaleString("en-US");
  const W = () => window.JTWeb || null;
  // carrier + service codes for Shopify's shippingLabelPurchase (UPS codes are UPS's own; USPS ones are checked on first use)
  const SERVICES = [
    ["", "", "Let Shopify choose", "the customer's method, else your preferred carrier, else Shopify's pick"],
    ["ups_shipping", "03", "UPS Ground", ""], ["ups_shipping", "93", "UPS Ground Saver", "lighter packages"],
    ["ups_shipping", "12", "UPS 3 Day Select", ""], ["ups_shipping", "02", "UPS 2nd Day Air", ""], ["ups_shipping", "13", "UPS Next Day Air Saver", ""], ["ups_shipping", "01", "UPS Next Day Air", ""],
    ["usps", "usps_ground_advantage", "USPS Ground Advantage", ""], ["usps", "usps_priority", "USPS Priority Mail", ""], ["usps", "usps_priority_express", "USPS Priority Mail Express", ""],
  ];
  const svcKey = (s) => s[0] + "|" + s[1];
  // the service to start with, from what the customer picked at checkout
  const guessSvc = (o) => { const m = (o.method || "").toLowerCase();
    return /next|overnight|1 ?day/.test(m) ? "ups_shipping|01" : /2 ?day|two day|expedit/.test(m) ? "ups_shipping|02" : /3 ?day/.test(m) ? "ups_shipping|12" : "ups_shipping|03"; };
  const S = { store: "jt", orders: null, err: "", sel: null, q: "", boxes: null, recent: [], busy: "", res: null, picks: {} };
  // per order on screen: {box, l, w, h, boxOz, lb, oz, svc, notify, ticks: {lineId: n}}
  const pick = (o) => S.picks[o.id] || (S.picks[o.id] = { box: "", l: "", w: "", h: "", boxOz: 0, lb: "", oz: "", svc: guessSvc(o), notify: true, ticks: {} });

  async function call(body) { if (!W()) throw { message: "Buying labels works on the web version (dashboard.andersenlifestyle.com)." }; const r = await W().fn("ship", body); if (r && r.ok === false && !r.status) throw { message: r.error || "Shipping failed." }; return r; }
  async function loadBoxes() { const r = await JT.rows(["id::text", "name", "l", "w", "h", "weight_oz"], "from jt.ship_boxes where removed_at is null order by sort, name", true);
    S.boxes = r.map(x => ({ id: x[0], name: x[1], l: +x[2], w: +x[3], h: +x[4], oz: +x[5] })); }
  async function loadRecent() { const r = await JT.rows(["order_name", "store", "service_name", "tracking", "company", "label_url", "status", "error", "by", "created_at::text", "id::text"],
      "from jt.ship_labels where created_at > now() - interval '3 days' order by created_at desc limit 40", true);
    S.recent = r.map(x => ({ name: x[0], store: x[1], svc: x[2], tracking: x[3], company: x[4], url: x[5], status: x[6], error: x[7], by: x[8], at: x[9], id: x[10] })); }
  async function loadQueue() {
    S.orders = null; S.err = ""; render();
    try { const r = await call({ action: "queue", store: S.store }); S.orders = r.orders || []; }
    catch (e) { S.orders = []; S.err = JT.message ? JT.message(e) : String(e.message || e); }
    if (S.sel && !(S.orders || []).some(o => o.id === S.sel)) S.sel = null;
    if (!S.sel && S.orders && S.orders.length) S.sel = S.orders[0].id;
    render();
  }

  const age = (t) => { const h = (Date.now() - Date.parse(t)) / 36e5; return h < 1 ? "just now" : h < 24 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`; };
  const when = (t) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const lines = (o) => o.fos.flatMap(f => f.lines.map(l => ({ ...l, fo: f.id })));
  const units = (o) => lines(o).reduce((a, l) => a + l.qty, 0);
  const shopW = (o) => { let oz = 0; for (const l of lines(o)) { const w = l.weight || {}; const f = { POUNDS: 16, OUNCES: 1, KILOGRAMS: 35.274, GRAMS: 0.035274 }[w.unit] || 0; oz += (Number(w.value) || 0) * f * l.qty; } return oz; };

  function render() {
    if ($("tab-labels").hidden) return;
    for (const b of document.querySelectorAll("#lb-store [data-lb-store]")) b.setAttribute("aria-pressed", String(b.dataset.lbStore === S.store));
    const list = S.orders || [], q = S.q.trim().toLowerCase().replace(/^#/, "");
    const shown = list.filter(o => !q || [o.name, o.customer, o.address && o.address.city, ...lines(o).map(l => l.sku + " " + l.title)].join(" ").toLowerCase().replace(/#/g, "").includes(q));
    $("lb-sum").textContent = S.orders ? `${n0(list.length)} order${list.length === 1 ? "" : "s"} to ship` : "";
    $("lb-queue").innerHTML = S.err ? `<div class="note warn small">${esc(S.err)}</div>` : !S.orders ? '<div class="muted small">Loading orders from Shopify…</div>'
      : shown.map(o => { const p = S.picks[o.id], done = p && p.done;
        return `<button type="button" class="lb-card ${o.id === S.sel ? "on" : ""} ${done ? "done" : ""}" data-lb-sel="${esc(o.id)}">
          <span class="lb-top"><b>${esc(o.name)}</b><span class="small muted">${esc(age(o.created))}</span></span>
          <span class="small">${esc(o.customer)} · ${esc([o.address.city, o.address.provinceCode, o.address.countryCodeV2 !== "US" ? o.address.countryCodeV2 : ""].filter(Boolean).join(", "))}</span>
          <span class="small muted">${n0(units(o))} item${units(o) === 1 ? "" : "s"} · ${esc(o.method || "—")}${done ? ' · <span class="pill ok">label bought</span>' : ""}</span></button>`; }).join("") || `<div class="muted small">${list.length ? "Nothing matches." : "Nothing to ship. 🎾"}</div>`;
    const o = list.find(x => x.id === S.sel);
    $("lb-pack").innerHTML = o ? packHtml(o) : `<div class="muted">${S.orders ? (list.length ? "Pick an order on the left (or scan its packing slip)." : "All caught up.") : ""}</div>`;
    $("lb-recent").innerHTML = S.recent.length ? `<table class="prept"><thead><tr><th class="l">When</th><th class="l">Order</th><th class="l">Service</th><th class="l">Tracking</th><th class="l">Status</th><th class="l">By</th><th></th></tr></thead><tbody>${S.recent.map(r => `<tr>
        <td class="l small">${esc(when(r.at))}</td><td class="l">${esc(r.name)} <span class="small muted">${r.store === "anr" ? "Ace n Rally" : "Just Tennis"}</span></td><td class="l small">${esc(r.svc || "Shopify's choice")}</td>
        <td class="l mono small">${esc(r.tracking || "—")}</td><td class="l small">${r.status === "PURCHASED" ? '<span class="pill ok">bought</span>' : r.status === "PENDING_PURCHASE" || r.status === "STARTING" ? '<span class="pill warn">processing</span>' : `<span class="pill miss" title="${esc(r.error)}">${esc(r.status.toLowerCase())}</span>`}</td>
        <td class="l small muted">${esc((r.by || "").split("@")[0])}</td><td class="l">${r.url ? `<a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">Print</a>` : r.status === "PENDING_PURCHASE" ? `<button class="mini" data-lb-check="${esc(r.id)}">Check</button>` : ""}</td></tr>`).join("")}</tbody></table>` : '<div class="muted small">No labels bought here in the last 3 days.</div>';
  }

  function packHtml(o) {
    const p = pick(o), ls = lines(o), a = o.address, sw = shopW(o);
    const allTicked = ls.every(l => (p.ticks[l.id] || 0) >= l.qty);
    const boxes = (S.boxes || []).map(b => `<button type="button" class="lb-box ${p.box === b.id ? "on" : ""}" data-lb-box="${esc(b.id)}"><b>${esc(b.name)}</b><span class="small muted">${b.l}×${b.w}×${b.h}″</span></button>`).join("");
    const totOz = (Number(p.lb) || 0) * 16 + (Number(p.oz) || 0);
    const svc = SERVICES.find(s => svcKey(s) === p.svc) || SERVICES[0];
    const ready = totOz > 0 && Number(p.l) > 0 && Number(p.w) > 0 && Number(p.h) > 0 && !S.busy && !p.done;
    const res = S.res && S.res.order === o.id ? S.res : null;
    return `<div class="lb-head"><div><span class="eyebrow">${S.store === "anr" ? "Ace n Rally" : "Just Tennis"} · ${esc(age(o.created))} ago</span><h2>${esc(o.name)}</h2>
        <div class="lb-addr">${esc(a.name)}${a.company ? `<br>${esc(a.company)}` : ""}<br>${esc(a.address1)}${a.address2 ? `, ${esc(a.address2)}` : ""}<br>${esc(a.city)}, ${esc(a.provinceCode || "")} ${esc(a.zip)}${a.countryCodeV2 !== "US" ? ` · <b>${esc(a.countryCodeV2)}</b>` : ""}${a.phone ? `<br><span class="small muted">${esc(a.phone)}</span>` : ""}</div></div>
        <div class="lb-meth"><span class="small muted">Customer chose</span><b>${esc(o.method || "—")}</b>${o.paid && o.paid !== "PAID" ? `<span class="pill warn">${esc(o.paid.toLowerCase().replace(/_/g, " "))}</span>` : ""}</div></div>
      ${o.note ? `<div class="note info small"><b>Order note:</b> ${esc(o.note)}</div>` : ""}
      <h3 class="lb-h3">1 · Pack it <span class="small muted">${allTicked ? "✓ everything's in" : "scan each item, or click it"}</span></h3>
      <div class="lb-items">${ls.map(l => { const t = p.ticks[l.id] || 0, ok = t >= l.qty;
        return `<button type="button" class="lb-item ${ok ? "ok" : ""}" data-lb-tick="${esc(l.id)}">${l.img ? `<img src="${esc(l.img)}" alt="">` : '<span class="lb-noimg"></span>'}
          <span class="lb-it"><b>${esc(l.title)}</b>${l.variant && l.variant !== "Default Title" ? `<span class="small">${esc(l.variant)}</span>` : ""}<span class="small muted mono">${esc(l.sku || "no SKU")}</span></span>
          <span class="lb-q ${l.qty > 1 ? "multi" : ""}">${ok ? "✓" : ""} ${t}/${l.qty}</span></button>`; }).join("")}</div>
      <h3 class="lb-h3">2 · Box</h3>
      <div class="lb-boxes">${boxes}<button type="button" class="lb-box ${p.box === "custom" ? "on" : ""}" data-lb-box="custom"><b>Custom</b><span class="small muted">type the size</span></button></div>
      <div class="row lb-dims"><label>L <input class="inp sm num" id="lb-l" value="${esc(p.l)}" inputmode="decimal"></label><label>W <input class="inp sm num" id="lb-w" value="${esc(p.w)}" inputmode="decimal"></label><label>H <input class="inp sm num" id="lb-h" value="${esc(p.h)}" inputmode="decimal"></label><span class="small muted">inches</span>
        <button type="button" class="linkbtn small" data-lb-act="boxes">Edit boxes</button></div>
      ${S.boxEdit ? boxEditHtml() : ""}
      <h3 class="lb-h3">3 · Weigh it <span class="small muted">total on the scale, box included${sw > 0 ? ` · Shopify's product weights say ${sw >= 16 ? `${Math.floor(sw / 16)} lb ${Math.round(sw % 16)} oz` : `${Math.round(sw)} oz`}` : ""}</span></h3>
      <div class="row lb-wt"><label><input class="inp num" id="lb-lb" value="${esc(p.lb)}" inputmode="decimal" placeholder="0"> lb</label><label><input class="inp num" id="lb-oz" value="${esc(p.oz)}" inputmode="decimal" placeholder="0"> oz</label></div>
      <h3 class="lb-h3">4 · Service</h3>
      <div class="row"><select id="lb-svc" class="inp">${SERVICES.map(s => `<option value="${esc(svcKey(s))}" ${svcKey(s) === p.svc ? "selected" : ""}>${esc(s[2])}${s[3] ? " — " + esc(s[3]) : ""}</option>`).join("")}</select>
        <label class="inline small"><input type="checkbox" id="lb-notify" ${p.notify ? "checked" : ""}> email the customer their tracking</label></div>
      <div class="lb-buy">${p.done ? `<span class="pill ok">Label bought</span>` : `<button class="btn primary lb-go" data-lb-act="buy" ${ready ? "" : "disabled"} title="${ready ? "Buys the label in Shopify (Shopify Shipping) and opens it to print" : "Pick a box and enter the weight first"}">${S.busy === "buy" ? "Buying…" : `Buy label · ${esc(svc[2])}`}</button>`}
        ${!allTicked && !p.done ? '<span class="small warnt">Not every item is checked off.</span>' : ""}
        <span class="small muted">Prices aren't shown before buying (Shopify's API doesn't quote). Voids are done in Shopify.</span></div>
      ${res ? `<div class="note ${res.ok ? "ok" : res.status === "PENDING_PURCHASE" ? "warn" : "bad"}">${res.ok ? `<b>Label bought.</b> ${esc(res.company)} <span class="mono">${esc(res.tracking)}</span> ${res.url ? `<a class="btn sm primary" href="${esc(res.url)}" target="_blank" rel="noopener">Print label</a>` : ""} <button class="btn sm" data-lb-act="next">Next order →</button>`
        : res.status === "PENDING_PURCHASE" ? `Shopify is still buying it… <button class="mini" data-lb-check="${esc(res.log_id)}">Check again</button>`
        : res.status === "ALREADY" ? `${esc(res.error)} <button class="mini" data-lb-act="again" title="Buys a second label for this order">Buy another label</button>` : `<b>Couldn't buy it:</b> ${esc(res.error || res.status)}`}</div>` : ""}`;
  }
  function boxEditHtml() {
    return `<div class="lb-boxedit"><table class="prept"><thead><tr><th class="l">Box</th><th>L</th><th>W</th><th>H</th><th>Empty oz</th><th></th></tr></thead><tbody>${(S.boxes || []).map(b => `<tr data-bx="${esc(b.id)}">
      <td class="l"><input class="inp sm" data-bf="name" value="${esc(b.name)}"></td><td><input class="inp sm num" data-bf="l" value="${b.l}"></td><td><input class="inp sm num" data-bf="w" value="${b.w}"></td><td><input class="inp sm num" data-bf="h" value="${b.h}"></td><td><input class="inp sm num" data-bf="weight_oz" value="${b.oz}"></td>
      <td><button class="mini" data-lb-bsave="${esc(b.id)}">Save</button><button class="linkbtn small" data-lb-brm="${esc(b.id)}">remove</button></td></tr>`).join("")}
      <tr data-bx="new"><td class="l"><input class="inp sm" data-bf="name" placeholder="New box"></td><td><input class="inp sm num" data-bf="l"></td><td><input class="inp sm num" data-bf="w"></td><td><input class="inp sm num" data-bf="h"></td><td><input class="inp sm num" data-bf="weight_oz" placeholder="0"></td><td><button class="mini primary" data-lb-bsave="new">Add</button></td></tr></tbody></table>
      <button class="linkbtn small" data-lb-act="boxes">Done</button></div>`;
  }

  async function buy(o, again) {
    const p = pick(o), svc = SERVICES.find(s => svcKey(s) === p.svc) || SERVICES[0], fo = o.fos[0];
    const b = (S.boxes || []).find(x => x.id === p.box);
    S.busy = "buy"; S.res = null; render();
    try {
      const r = await call({ action: "buy", store: S.store, fulfillment_order_id: fo.id, order_id: o.id, order_name: o.name, carrier: svc[0], service: svc[1], service_name: svc[2],
        box: { name: b ? b.name : "Custom", l: Number(p.l), w: Number(p.w), h: Number(p.h), weight_oz: b ? b.oz : 0 }, weight_oz: (Number(p.lb) || 0) * 16 + (Number(p.oz) || 0), notify: p.notify, again: !!again });
      const l0 = (r.labels || [])[0] || {}, url = ((l0.docs || []).find(d => d.url && /LABEL/i.test(d.type || "")) || (l0.docs || []).find(d => d.url) || {}).url || "";
      S.res = { order: o.id, ok: !!r.ok, status: r.status, error: r.error, tracking: l0.tracking || "", company: l0.company || svc[2], url, log_id: r.log_id };
      if (r.ok) { p.done = true; if (url) window.open(url, "_blank", "noopener"); }
    } catch (e) { S.res = { order: o.id, ok: false, status: "ERROR", error: JT.message ? JT.message(e) : String(e.message || e) }; }
    S.busy = ""; if (W() && W().clearCache) W().clearCache(); window.dispatchEvent(new CustomEvent("jt:changed"));
    loadRecent().then(render).catch(() => {}); render();
  }
  // a scan (or typed text + Enter): an order number picks the order; a SKU ticks one of its items
  function scan(v) {
    const t = String(v || "").trim(); if (!t) return;
    const list = S.orders || [], key = t.replace(/^#/, "").toLowerCase();
    const ord = list.find(o => o.name.replace(/^#/, "").toLowerCase() === key);
    if (ord) { S.sel = ord.id; S.q = ""; render(); return; }
    const o = list.find(x => x.id === S.sel);
    if (o) { const p = pick(o), l = lines(o).find(x => x.sku && x.sku.toLowerCase() === t.toLowerCase() && (p.ticks[x.id] || 0) < x.qty);
      if (l) { p.ticks[l.id] = (p.ticks[l.id] || 0) + 1; S.q = ""; render(); return; } }
    S.q = t; render();
  }

  const host = $("tab-labels");
  host.addEventListener("click", async (e) => {
    const st = e.target.closest("[data-lb-store]"); if (st) { S.store = st.dataset.lbStore; S.sel = null; S.res = null; loadQueue(); return; }
    const sel = e.target.closest("[data-lb-sel]"); if (sel) { S.sel = sel.dataset.lbSel; S.res = null; render(); return; }
    const o = (S.orders || []).find(x => x.id === S.sel);
    const tk = e.target.closest("[data-lb-tick]"); if (tk && o) { const p = pick(o), l = lines(o).find(x => x.id === tk.dataset.lbTick); if (l) p.ticks[l.id] = (p.ticks[l.id] || 0) >= l.qty ? 0 : (p.ticks[l.id] || 0) + 1; render(); return; }
    const bx = e.target.closest("[data-lb-box]"); if (bx && o) { const p = pick(o), b = (S.boxes || []).find(x => x.id === bx.dataset.lbBox);
      p.box = bx.dataset.lbBox; if (b) { p.l = String(b.l); p.w = String(b.w); p.h = String(b.h); p.boxOz = b.oz; } render(); const f = $("lb-lb"); if (f && !p.lb) f.focus(); return; }
    const ck = e.target.closest("[data-lb-check]"); if (ck) { try { const r = await call({ action: "result", store: S.store, log_id: Number(ck.dataset.lbCheck) }); if (o && S.res) { const l0 = (r.labels || [])[0] || {};
        S.res = { ...S.res, ok: !!r.ok, status: r.status, error: r.error, tracking: l0.tracking || "", url: ((l0.docs || []).find(d => d.url) || {}).url || "" }; if (r.ok) pick(o).done = true; } } catch (_) {} await loadRecent(); render(); return; }
    const bs = e.target.closest("[data-lb-bsave]"); if (bs) { const tr = bs.closest("tr"), v = (k) => (tr.querySelector(`[data-bf="${k}"]`) || {}).value || "";
      const p = { name: v("name").trim(), l: v("l"), w: v("w"), h: v("h"), weight_oz: v("weight_oz") }; if (bs.dataset.lbBsave !== "new") p.id = Number(bs.dataset.lbBsave);
      if (!p.name || !(Number(p.l) > 0 && Number(p.w) > 0 && Number(p.h) > 0)) { alertNote("A box needs a name and its size."); return; }
      try { await W().write("jt_ship_box", { p }); await loadBoxes(); render(); } catch (err) { alertNote("Couldn't save the box: " + JT.message(err)); } return; }
    const br = e.target.closest("[data-lb-brm]"); if (br) { try { await W().write("jt_ship_box", { p: { id: Number(br.dataset.lbBrm), remove: true } }); await loadBoxes(); render(); } catch (err) { alertNote(JT.message(err)); } return; }
    const a = e.target.closest("[data-lb-act]"); if (!a) return;
    const k = a.dataset.lbAct;
    if (k === "refresh") { loadQueue(); loadRecent().then(render).catch(() => {}); return; }
    if (k === "boxes") { S.boxEdit = !S.boxEdit; render(); return; }
    if (k === "buy" && o) return buy(o, false);
    if (k === "again" && o) return buy(o, true);
    if (k === "next") { const list = (S.orders || []).filter(x => !(S.picks[x.id] && S.picks[x.id].done)); S.sel = list.length ? list[0].id : null; S.res = null; render(); const s = $("lb-scan"); if (s) s.focus(); return; }
  });
  const alertNote = (t) => { const n = $("lb-note"); if (n) { n.hidden = false; n.textContent = t; setTimeout(() => { n.hidden = true; }, 6000); } };
  host.addEventListener("input", (e) => {
    const o = (S.orders || []).find(x => x.id === S.sel), t = e.target;
    if (t.id === "lb-scan") { S.q = t.value; clearTimeout(t._t); t._t = setTimeout(render, 150); return; }
    if (!o) return; const p = pick(o);
    if (t.id === "lb-l" || t.id === "lb-w" || t.id === "lb-h") { p[t.id.slice(3)] = t.value; p.box = p.box && p.box !== "custom" ? "custom" : "custom"; syncBuy(o); return; }
    if (t.id === "lb-lb" || t.id === "lb-oz") { p[t.id.slice(3)] = t.value; syncBuy(o); return; }
  });
  // typing in a field updates the Buy button without redrawing (keeps the cursor)
  const syncBuy = (o) => { const p = pick(o), b = host.querySelector(".lb-go"); if (!b) return; const ok = ((Number(p.lb) || 0) * 16 + (Number(p.oz) || 0)) > 0 && Number(p.l) > 0 && Number(p.w) > 0 && Number(p.h) > 0 && !S.busy; b.disabled = !ok; };
  host.addEventListener("change", (e) => {
    const o = (S.orders || []).find(x => x.id === S.sel), t = e.target; if (!o) return; const p = pick(o);
    if (t.id === "lb-svc") { p.svc = t.value; render(); }
    if (t.id === "lb-notify") p.notify = t.checked;
  });
  host.addEventListener("keydown", (e) => {
    if (e.target.id === "lb-scan" && e.key === "Enter") { e.preventDefault(); const v = e.target.value; e.target.value = ""; scan(v); setTimeout(() => { const s = $("lb-scan"); if (s) s.focus(); }, 0); return; }
    if ((e.target.id === "lb-lb" || e.target.id === "lb-oz") && e.key === "Enter") { e.preventDefault(); const b = host.querySelector(".lb-go"); if (b && !b.disabled) b.click(); }
  });
  window.labShow = () => {
    if (!W()) { $("lb-pack").innerHTML = '<div class="note info">Buying labels works on the web version — open <b>dashboard.andersenlifestyle.com</b> › Shipping › Ship orders.</div>'; return; }
    if (!S.boxes) loadBoxes().then(render).catch(() => {});
    loadRecent().then(render).catch(() => {});
    if (!S.orders) loadQueue(); else render();
    setTimeout(() => { const s = $("lb-scan"); if (s) s.focus(); }, 50);
  };
  window.JTLabels = { _state: S };
  if ((location.hash || "") === "#labels") setTimeout(() => window.labShow(), 0);
})();
