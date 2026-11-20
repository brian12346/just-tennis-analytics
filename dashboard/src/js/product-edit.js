(() => {
  // ===================== Products › edit (Nov 19) =====================
  // Brian: "on the Products page if you click on a Product it'll pop up a screen with all the things needed to be edited —
  // name, inventory, cost, etc. Before saving ask if it should be saved to Shopify and/or Amazon depending on where the
  // change will be made." window.JTProductEdit.open(productId, variantId?).
  //   Shopify: name, vendor, category (product type), status; per size/color SKU, barcode, price, cost and a store count
  //     (jt.product_edit, migration 221: queued and written by the sync within a minute or two).
  //   Amazon: each mapped listing's price (pm-amazon set_price, straight away; the MAP floor rules still apply).
  // Prep center, FBA and AWD stock are shown, not edited here (the prep center and Amazon own those counts).
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const m2 = (x) => x == null || x === "" || isNaN(x) ? "—" : usd.format(Number(x));
  const n0 = (x) => Math.round(Number(x) || 0).toLocaleString("en-US");
  const JT = () => window.JT, WEB = () => window.JTWeb || null;
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const STATUSES = [["ACTIVE", "Active"], ["DRAFT", "Draft"], ["ARCHIVED", "Archived"]];
  const PF = [["title", "Name"], ["vendor", "Vendor"], ["product_type", "Category"], ["status", "Status"]];
  const VF = [["sku", "SKU"], ["barcode", "Barcode / UPC"], ["price", "Price"], ["cost", "Cost"], ["count", "Store count"]];
  const M = { pid: null, focus: null, data: null, err: null, ed: { p: {}, v: {}, a: {} }, confirm: null, busy: false, msg: null };

  function host() {
    let d = $("jt-pedit"); if (d) return d;
    d = document.createElement("div"); d.className = "modal"; d.id = "jt-pedit"; d.hidden = true;
    d.innerHTML = '<div class="modal-card it-card pe-card" id="jt-pedit-card" role="dialog" aria-modal="true" aria-label="Edit product"></div>';
    document.body.appendChild(d);
    d.addEventListener("mousedown", (e) => { if (e.target === d && !M.busy) close(); });
    d.addEventListener("click", onClick);
    d.addEventListener("input", onInput);
    d.addEventListener("change", onInput);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !d.hidden && !M.busy) { e.preventDefault(); if (M.confirm) { M.confirm = null; render(); } else close(); } });
    return d;
  }
  function close() {
    if (dirty() && !window.confirm("Close without saving your changes?")) return;
    const d = $("jt-pedit"); if (d) d.hidden = true; document.body.classList.remove("modal-open"); M.pid = null;
  }

  async function open(pid, focusVid) {
    M.pid = String(pid); M.focus = focusVid ? String(focusVid) : null; M.data = null; M.err = null; M.ed = { p: {}, v: {}, a: {} }; M.confirm = null; M.msg = null;
    const d = host(); d.hidden = false; document.body.classList.add("modal-open"); render();
    await load();
  }
  async function load() {
    const p = JT().int(M.pid), mine = M.pid;
    try {
      const vids = `(select variant_id from jt.variants where product_id = ${p} and removed_at is null)`;
      const [vs, stock, amz, pend] = await Promise.all([
        JT().rows(["variant_id::text", "coalesce(variant_title, '')", "coalesce(product_title, '')", "coalesce(sku, '')", "coalesce(barcode, '')", "coalesce(vendor, '')", "coalesce(product_type, '')",
          "coalesce(status, '')", "price", "unit_cost", "inventory_qty", "coalesce(tracked, true)"], `from jt.variants where product_id = ${p} and removed_at is null order by variant_id`, true),
        JT().rows(["x.variant_id::text", "coalesce((select sum(i.qty) from jt.prep_items i where i.variant_id = x.variant_id and i.qty > 0), 0)",
          "coalesce((select sum((s.fba_available + s.fba_transfer + s.fba_inbound) * coalesce(s.map_units, 1)) from jt.v_asin_stock s where s.variant_id = x.variant_id), 0)",
          "coalesce((select sum(s.awd * coalesce(s.map_units, 1)) from jt.v_asin_stock s where s.variant_id = x.variant_id), 0)"], `from ${vids} x(variant_id)`, true).catch(() => []),
        JT().rows(["m.variant_id::text", "m.sku", "coalesce(m.map_units, 1)", "coalesce(s.asin, '')", "coalesce(s.title, '')", "s.price", "coalesce(s.ch, '')", "coalesce(s.amz_status, '')"],
          `from jt.mv_amz_sku_cost m left join jt.amazon_skus() s on s.sku = m.sku where m.variant_id in ${vids} order by m.sku`, true).catch(() => []),
        // changes still on their way to Shopify, or refused by it (last 2 days)
        JT().rows(["'p'", "coalesce(variant_id::text, '')", "fields::text", "status", "error", "created_at::text"],
          `from jt.shopify_product_updates where product_id = ${p} and (status = 'pending' or (status = 'failed' and created_at > now() - interval '2 days')) order by id`, true).catch(() => []),
      ]);
      if (mine !== M.pid) return;
      if (!vs.length) throw { message: "This product isn't in the Shopify catalog copy (it may have been deleted)." };
      const st = new Map(stock.map(x => [x[0], { prep: +x[1] || 0, fba: +x[2] || 0, awd: +x[3] || 0 }]));
      const [costPend, movePend] = await Promise.all([
        JT().rows(["variant_id::text", "new_cost", "new_price", "status", "error"], `from jt.cost_updates where variant_id in ${vids} and (status = 'pending' or (status = 'failed' and requested_at > now() - interval '2 days')) order by id`, true).catch(() => []),
        JT().rows(["variant_id::text", "set_to", "delta", "status", "error"], `from jt.shopify_stock_moves where variant_id in ${vids} and (status = 'pending' or (status = 'failed' and created_at > now() - interval '2 days')) order by id`, true).catch(() => []),
      ]);
      if (mine !== M.pid) return;
      const v0 = vs[0];
      M.data = {
        title: v0[2], vendor: v0[5], type: v0[6], status: v0[7],
        vars: vs.map(x => ({ vid: x[0], vt: x[1] === "Default Title" ? "" : x[1], sku: x[3], barcode: x[4], price: x[8] == null ? null : +x[8], cost: x[9] == null ? null : +x[9],
          store: x[10] == null ? null : +x[10], tracked: !(x[11] === false || x[11] === "false"), ...(st.get(x[0]) || { prep: 0, fba: 0, awd: 0 }) })),
        amz: amz.map(x => ({ vid: x[0], sku: x[1], units: +x[2] || 1, asin: x[3], title: x[4], price: x[5] == null ? null : +x[5], ch: x[6], st: x[7] })),
        pend: [...pend.map(x => ({ kind: "fields", vid: x[1], fields: JSON.parse(x[2] || "{}"), status: x[3], error: x[4] })),
          ...costPend.map(x => ({ kind: "cost", vid: x[0], cost: x[1], price: x[2], status: x[3], error: x[4] })),
          ...movePend.map(x => ({ kind: "count", vid: x[0], set_to: x[1], delta: x[2], status: x[3], error: x[4] }))],
      };
    } catch (e) { if (mine === M.pid) M.err = e; }
    if (mine === M.pid) render();
    if (M.focus) setTimeout(() => { const r = document.querySelector(`#jt-pedit tr[data-pe-v="${CSS.escape(M.focus)}"]`); if (r) { r.classList.add("pe-focus"); r.scrollIntoView({ block: "center" }); } }, 0);
  }

  // ---- edits: kept as typed text; a field equal to its current value isn't a change ----
  const money = (s) => { const t = String(s ?? "").trim().replace(/[$,\s]/g, ""); if (t === "") return null; return /^\d*\.?\d+$/.test(t) ? Math.round(Number(t) * 100) / 100 : NaN; };
  const intv = (s) => { const t = String(s ?? "").trim(); if (t === "") return null; return /^\d+$/.test(t) ? Number(t) : NaN; };
  function changes() {
    const D = M.data; if (!D) return { shop: [], amz: [], bad: [] };
    const shop = [], amz = [], bad = [];
    for (const [k, l] of PF) {
      if (!(k in M.ed.p)) continue;
      const cur = k === "title" ? D.title : k === "vendor" ? D.vendor : k === "product_type" ? D.type : D.status, nv = String(M.ed.p[k]).trim();
      if (nv === cur) continue;
      if (k === "title" && !nv) { bad.push("The product needs a name."); continue; }
      shop.push({ lvl: "p", k, label: l, from: cur, to: nv });
    }
    for (const v of D.vars) {
      const e = M.ed.v[v.vid] || {}, name = v.vt || "Default";
      for (const [k, l] of VF) {
        if (!(k in e)) continue;
        const raw = e[k];
        if (k === "sku" || k === "barcode") { const nv = String(raw).trim(); if (nv !== v[k]) shop.push({ lvl: "v", vid: v.vid, name, k, label: l, from: v[k], to: nv }); continue; }
        if (k === "count") { if (String(raw).trim() === "") continue; const n = intv(raw); if (isNaN(n)) { bad.push(`${name}: the store count must be a whole number.`); continue; }
          if (n !== v.store) shop.push({ lvl: "v", vid: v.vid, name, k, label: l, from: v.store, to: n }); continue; }
        const n = money(raw);
        if (n == null) continue;
        if (isNaN(n)) { bad.push(`${name}: the ${l.toLowerCase()} must be a number, like 129.99.`); continue; }
        if (n !== v[k]) shop.push({ lvl: "v", vid: v.vid, name, k, label: l, from: v[k], to: n });
      }
    }
    for (const a of D.amz) {
      const raw = M.ed.a[a.sku]; if (raw == null) continue;
      const n = money(raw); if (n == null) continue;
      if (isNaN(n) || n <= 0) { bad.push(`${a.sku}: the Amazon price must be a number, like 129.99.`); continue; }
      if (n !== a.price) amz.push({ sku: a.sku, asin: a.asin, label: "Amazon price", from: a.price, to: n });
    }
    return { shop, amz, bad };
  }
  const dirty = () => { const c = changes(); return c.shop.length + c.amz.length > 0; };
  const fmt = (c) => c.k === "price" || c.k === "cost" || c.label === "Amazon price" ? m2(c.to) : c.k === "status" ? (STATUSES.find(s => s[0] === c.to) || [, c.to])[1] : c.k === "count" ? n0(c.to) : (c.to === "" ? "(blank)" : c.to);
  const fmtFrom = (c) => c.from == null || c.from === "" ? "(blank)" : c.k === "price" || c.k === "cost" || c.label === "Amazon price" ? m2(c.from) : c.k === "status" ? (STATUSES.find(s => s[0] === c.from) || [, c.from])[1] : c.k === "count" ? n0(c.from) : c.from;

  function render() {
    const card = $("jt-pedit-card"); if (!card) return;
    const D = M.data;
    const head = (t, sub) => `<div class="it-head"><div><span class="eyebrow">${sub}</span><h2>${t}</h2></div><button class="btn" type="button" data-pe="close" title="Close (Esc)" ${M.busy ? "disabled" : ""}>Close</button></div>`;
    if (M.err) { card.innerHTML = head("Product", "Edit product") + `<div class="note bad">Couldn't load it: ${esc((JT().message && JT().message(M.err)) || M.err.message || M.err)}</div>`; return; }
    if (!D) { card.innerHTML = head("Loading…", "Edit product") + '<div class="muted small" style="padding:12px">Loading the product, its stock and its Amazon listings…</div>'; return; }
    const val = (obj, k, cur) => k in obj ? obj[k] : cur == null ? "" : cur;
    const p = M.ed.p, ch = changes();
    const pendFor = (vid) => D.pend.filter(x => x.vid === vid || (!vid && x.kind === "fields" && !x.vid));
    const pendNote = (list) => list.length ? `<div class="pe-pend">${list.map(x => {
      const what = x.kind === "fields" ? Object.entries(x.fields).map(([k, v]) => `${k.replace("_", " ")} → ${v === "" ? "(blank)" : v}`).join(", ") : x.kind === "cost" ? [x.cost != null ? `cost → ${m2(x.cost)}` : "", x.price != null ? `price → ${m2(x.price)}` : ""].filter(Boolean).join(", ") : `store count → ${n0(x.set_to)}`;
      return x.status === "failed" ? `<span class="neg" title="${esc(x.error)}">Shopify refused: ${esc(what)} — ${esc(x.error.slice(0, 120))}</span>` : `<span class="muted">On its way to Shopify: ${esc(what)}</span>`; }).join("<br>")}</div>` : "";
    const inp = (attrs, v, cls, ph) => `<input class="inp ${cls || ""}" ${attrs} value="${esc(v)}" ${ph ? `placeholder="${esc(ph)}"` : ""} autocomplete="off" data-lpignore="true" data-jtnofill="1">`;
    const ed = (vid, k) => (M.ed.v[vid] || {})[k];
    const isCh = (vid, k) => ch.shop.some(c => c.vid === vid && c.k === k);
    const pCh = (k) => ch.shop.some(c => c.lvl === "p" && c.k === k);
    const varRows = D.vars.map(v => `<tr data-pe-v="${esc(v.vid)}">
        <td class="l"><b>${esc(v.vt || "Default")}</b><div class="meta"><a class="olink" href="${ADMIN}/products/${esc(M.pid)}/variants/${esc(v.vid)}" target="_blank" rel="noopener">Shopify</a> · <button class="linkbtn small" data-pe="item" data-vid="${esc(v.vid)}">history</button></div>${pendNote(pendFor(v.vid))}</td>
        <td class="${isCh(v.vid, "sku") ? "pe-ch" : ""}">${inp(`data-pv="${esc(v.vid)}" data-k="sku" aria-label="SKU"`, val(M.ed.v[v.vid] || {}, "sku", v.sku), "pe-w8")}</td>
        <td class="${isCh(v.vid, "barcode") ? "pe-ch" : ""}">${inp(`data-pv="${esc(v.vid)}" data-k="barcode" aria-label="Barcode"`, val(M.ed.v[v.vid] || {}, "barcode", v.barcode), "pe-w8")}</td>
        <td class="${isCh(v.vid, "price") ? "pe-ch" : ""}">${inp(`data-pv="${esc(v.vid)}" data-k="price" inputmode="decimal" aria-label="Price"`, ed(v.vid, "price") ?? (v.price == null ? "" : v.price.toFixed(2)), "pe-w5")}</td>
        <td class="${isCh(v.vid, "cost") ? "pe-ch" : ""}">${inp(`data-pv="${esc(v.vid)}" data-k="cost" inputmode="decimal" aria-label="Cost"`, ed(v.vid, "cost") ?? (v.cost == null ? "" : v.cost.toFixed(2)), "pe-w5")}
          ${v.price > 0 && v.cost != null ? `<div class="meta">${Math.round((1 - (money(ed(v.vid, "cost") ?? v.cost) || 0) / (money(ed(v.vid, "price") ?? v.price) || v.price)) * 100)}% margin</div>` : ""}</td>
        <td class="${isCh(v.vid, "count") ? "pe-ch" : ""}">${v.tracked ? inp(`data-pv="${esc(v.vid)}" data-k="count" inputmode="numeric" aria-label="Store count"`, ed(v.vid, "count") ?? "", "pe-w4", v.store == null ? "" : String(Math.max(0, v.store))) + `<div class="meta">now ${n0(v.store)}</div>` : '<span class="dim small">not tracked</span>'}</td>
        <td class="num small">${n0(v.prep)}</td><td class="num small">${n0(v.fba)}</td><td class="num small">${n0(v.awd)}</td></tr>`).join("");
    const amzRows = D.amz.map(a => { const v = D.vars.find(x => x.vid === a.vid);
      return `<tr><td class="l"><span class="mono">${esc(a.sku)}</span>${a.units > 1 ? ` <span class="pill pos">${a.units}-pack</span>` : ""}<div class="meta">${a.asin ? `<a class="olink" href="https://www.amazon.com/dp/${encodeURIComponent(a.asin)}" target="_blank" rel="noopener">${esc(a.asin)}</a> · ` : ""}${esc(v ? v.vt || "Default" : "")}${a.ch ? " · " + esc(a.ch.toUpperCase()) : ""}${a.st ? " · " + esc(a.st) : ""}</div></td>
        <td class="l small">${esc(a.title || "")}</td>
        <td class="${ch.amz.some(c => c.sku === a.sku) ? "pe-ch" : ""}">${inp(`data-pa="${esc(a.sku)}" inputmode="decimal" aria-label="Amazon price for ${esc(a.sku)}"`, M.ed.a[a.sku] ?? (a.price == null ? "" : a.price.toFixed(2)), "pe-w5")}</td></tr>`; }).join("");
    const n = ch.shop.length + ch.amz.length;
    card.innerHTML = head(`<a class="olink" href="${ADMIN}/products/${esc(M.pid)}" target="_blank" rel="noopener">${esc(D.title)}</a>`, "Edit product")
      + (M.msg ? `<div class="note ${M.msg[0]}">${M.msg[1]}</div>` : "")
      + `<div class="pe-grid">
          <label class="${pCh("title") ? "pe-ch" : ""}"><span class="eyebrow">Name</span>${inp('data-pp="title" aria-label="Product name"', val(p, "title", D.title), "pe-wide")}</label>
          <label class="${pCh("vendor") ? "pe-ch" : ""}"><span class="eyebrow">Vendor</span>${inp('data-pp="vendor" aria-label="Vendor" list="pe-vendors"', val(p, "vendor", D.vendor))}</label>
          <label class="${pCh("product_type") ? "pe-ch" : ""}"><span class="eyebrow">Category</span>${inp('data-pp="product_type" aria-label="Category" list="pe-types"', val(p, "product_type", D.type))}</label>
          <label class="${pCh("status") ? "pe-ch" : ""}"><span class="eyebrow">Shopify status</span><select class="inp" data-pp="status" aria-label="Status">${STATUSES.map(([k, l]) => `<option value="${k}" ${val(p, "status", D.status) === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        </div>${pendNote(pendFor(""))}
        <h3 class="eyebrow pe-h">Sizes / colors <span class="muted" style="text-transform:none;letter-spacing:0">· a store count sets Shopify's available units to the number counted; prep center, FBA and AWD are shown for reference</span></h3>
        <div class="tbl-wrap"><table class="pe-t"><thead><tr><th class="l">Size / color</th><th>SKU</th><th>Barcode / UPC</th><th>Price</th><th>Cost</th><th>Store count</th><th>Prep</th><th>FBA</th><th>AWD</th></tr></thead><tbody>${varRows}</tbody></table></div>
        <h3 class="eyebrow pe-h">Amazon listings</h3>
        ${D.amz.length ? `<div class="tbl-wrap"><table class="pe-t"><thead><tr><th class="l">Seller SKU</th><th class="l">Amazon title</th><th>Our price</th></tr></thead><tbody>${amzRows}</tbody></table></div>`
          : '<p class="muted small">No Amazon listing is mapped to this product (Amazon › Mapping).</p>'}
        ${ch.bad.length ? `<div class="note warn">${ch.bad.map(esc).join("<br>")}</div>` : ""}
        <div class="pe-foot">${M.confirm ? confirmBox(ch) : `<span class="muted small">${n ? `${n} change${n === 1 ? "" : "s"}` : "No changes yet"}</span>
          <span class="row"><button class="btn" type="button" data-pe="reset" ${n ? "" : "disabled"}>Undo changes</button><button class="btn primary" type="button" data-pe="save" ${n && !ch.bad.length ? "" : "disabled"}>Save…</button></span>`}</div>
        <datalist id="pe-vendors">${(window.JTProductEdit._vendors || []).map(x => `<option value="${esc(x)}">`).join("")}</datalist><datalist id="pe-types">${(window.JTProductEdit._types || []).map(x => `<option value="${esc(x)}">`).join("")}</datalist>`;
  }
  // the save question: where each change goes, with a box per destination
  function confirmBox(ch) {
    const C = M.confirm, list = (xs) => `<ul class="pe-list">${xs.map(c => `<li>${c.lvl === "v" ? `<b>${esc(c.name)}</b> · ` : c.sku ? `<span class="mono">${esc(c.sku)}</span> · ` : ""}${esc(c.label)}: ${esc(String(fmtFrom(c)))} → <b>${esc(String(fmt(c)))}</b></li>`).join("")}</ul>`;
    return `<div class="pe-confirm"><b>Save these changes?</b>
      ${ch.shop.length ? `<label class="pe-dest"><input type="checkbox" data-pe-dest="shop" ${C.shop ? "checked" : ""} ${M.busy ? "disabled" : ""}> <b>Save to Shopify</b> <span class="muted small">(${ch.shop.length} change${ch.shop.length === 1 ? "" : "s"} · written within a minute or two)</span></label>${list(ch.shop)}` : ""}
      ${ch.amz.length ? `<label class="pe-dest"><input type="checkbox" data-pe-dest="amz" ${C.amz ? "checked" : ""} ${M.busy ? "disabled" : ""}> <b>Save to Amazon</b> <span class="muted small">(${ch.amz.length} price${ch.amz.length === 1 ? "" : "s"} · live on amazon.com in about 15 minutes; MAP floors still apply)</span></label>${list(ch.amz)}` : ""}
      ${ch.shop.length && ch.amz.length ? "" : `<div class="muted small">${ch.shop.length ? "Nothing here changes on Amazon." : "Nothing here changes in Shopify."}</div>`}
      <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn" type="button" data-pe="back" ${M.busy ? "disabled" : ""}>Back</button><button class="btn primary" type="button" data-pe="go" ${(C.shop && ch.shop.length) || (C.amz && ch.amz.length) ? "" : "disabled"} ${M.busy ? "disabled" : ""}>${M.busy ? "Saving…" : "Save"}</button></div></div>`;
  }

  function onInput(e) {
    const t = e.target, D = M.data; if (!D) return;
    if (t.dataset.pp) M.ed.p[t.dataset.pp] = t.value;
    else if (t.dataset.pv) { (M.ed.v[t.dataset.pv] = M.ed.v[t.dataset.pv] || {})[t.dataset.k] = t.value; }
    else if (t.dataset.pa) M.ed.a[t.dataset.pa] = t.value;
    else if (t.dataset.peDest) { M.confirm[t.dataset.peDest] = t.checked; render(); return; }
    else return;
    if (e.type === "change" || t.tagName === "SELECT") rerenderKeep(t);
  }
  // re-render without losing the caret (on blur/change only, so typing stays smooth)
  function rerenderKeep(t) {
    const sel = t.dataset.pp ? `[data-pp="${t.dataset.pp}"]` : t.dataset.pv ? `[data-pv="${CSS.escape(t.dataset.pv)}"][data-k="${t.dataset.k}"]` : t.dataset.pa ? `[data-pa="${CSS.escape(t.dataset.pa)}"]` : null;
    const had = document.activeElement === t;
    render();
    if (had && sel) { const n = document.querySelector("#jt-pedit " + sel); if (n) n.focus(); }
  }
  function onClick(e) {
    const b = e.target.closest("[data-pe]"); if (!b) return;
    const a = b.dataset.pe;
    if (a === "close") return close();
    if (a === "item") { if (window.JTItem) window.JTItem.open(b.dataset.vid); return; }
    if (a === "reset") { M.ed = { p: {}, v: {}, a: {} }; M.msg = null; render(); return; }
    if (a === "save") { const c = changes(); M.confirm = { shop: c.shop.length > 0, amz: c.amz.length > 0 }; render(); return; }
    if (a === "back") { M.confirm = null; render(); return; }
    if (a === "go") return save();
  }

  async function pmAmazon(body) {
    if (WEB()) return WEB().fn("pm-amazon", body);
    const st = await JT().run(`select jt.pm_amazon_call(${JT().q(JSON.stringify({ ...body, by: "Claude dashboard" }))}::jsonb)::text as id`, true);
    const id = st[0] && Number(st[0].id); if (!id) throw { message: "Couldn't reach Amazon." };
    for (let i = 0; i < 70; i++) {
      await new Promise(res => setTimeout(res, i ? 2000 : 3000));
      const r = await JT().run(`select jt.qbo_result(${id})::text as r`, true);
      const x = r[0] && r[0].r ? JSON.parse(r[0].r) : null;
      if (!x) continue;
      if (x.error && !x.body) throw { message: "Amazon call failed: " + x.error };
      return typeof x.body === "string" ? JSON.parse(x.body) : x.body;
    }
    throw { message: "Amazon took too long to answer — check the Price match page in a few minutes." };
  }
  async function shopifySave(list) {
    const body = { product_id: Number(M.pid), product: {}, variants: [] }, vv = new Map();
    for (const c of list) {
      if (c.lvl === "p") { body.product[c.k] = c.to; continue; }
      const v = vv.get(c.vid) || { variant_id: Number(c.vid) }; v[c.k] = c.to; vv.set(c.vid, v);
    }
    body.variants = [...vv.values()];
    if (!Object.keys(body.product).length) delete body.product;
    if (WEB()) { const r = await WEB().write("jt_product_edit", { p: body }); if (WEB().clearCache) WEB().clearCache(); return r; }
    const out = await JT().run(`select jt.product_edit(${JT().q(JSON.stringify({ ...body, by: "Claude dashboard" }))}::jsonb)::text as r`, true);
    return out[0] && out[0].r;
  }
  async function save() {
    const ch = changes(), C = M.confirm; if (!C || M.busy) return;
    M.busy = true; render();
    const done = [], fail = [];
    if (C.shop && ch.shop.length) {
      try { await shopifySave(ch.shop); done.push(`${ch.shop.length} Shopify change${ch.shop.length === 1 ? "" : "s"} queued (Shopify updates in a minute or two)`); }
      catch (e) { fail.push("Shopify: " + esc((JT().message && JT().message(e)) || e.message || e)); }
    }
    if (C.amz && ch.amz.length) {
      try {
        const out = await pmAmazon({ action: "set_price", items: ch.amz.map(c => ({ sku: c.sku, asin: c.asin, price: c.to })) });
        const res = (out && out.results) || [];
        const ok = res.filter(r => r.status === "ACCEPTED" || r.status === "UNCHANGED");
        for (const r of res) if (!ok.includes(r)) fail.push(`Amazon ${esc(r.sku)}: ${esc(r.error || (r.issues || []).map(i => i.message || i).join("; ") || r.status)}`);
        if (ok.length) done.push(`${ok.length} Amazon price${ok.length === 1 ? "" : "s"} sent (live in about 15 minutes)`);
        if (!res.length && out && out.ok === false) fail.push("Amazon: " + esc(out.error || "didn't take the change"));
      } catch (e) { fail.push("Amazon: " + esc((JT().message && JT().message(e)) || e.message || e)); }
    }
    M.busy = false; M.confirm = null;
    if (!fail.length) M.ed = { p: {}, v: {}, a: {} };
    M.msg = fail.length ? ["bad", (done.length ? done.join(" · ") + "<br>" : "") + "Not saved — " + fail.join("<br>")] : ["info", done.join(" · ") || "Nothing was saved."];
    M.data = null; render();
    await load();
    window.dispatchEvent(new CustomEvent("jt:productedited", { detail: { pid: M.pid } }));
  }

  window.JTProductEdit = { open, close, _vendors: [], _types: [] };
})();
