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
  // ---------- printing labels so they're easy to read (Nov 3, Brian: "make it so that the printer sizing makes it easy to
  // read the printed labels"). Each label PDF is drawn at print resolution, trimmed to the label itself (no white margins
  // or letter-page blank space), turned upright, and fitted edge to edge on the paper: a 4×6 label (thermal printer), or a
  // 4×6 area on letter paper. The print page has no browser margins or scaling. ----------
  const PAPER = { "4x6": { w: 4, h: 6, page: "4in 6in" }, letter: { w: 4, h: 6, page: "letter", letter: true } };
  let paper = "4x6"; try { paper = localStorage.getItem("jt.lb.paper") || "4x6"; } catch (_) {}
  const DPI = 300;
  async function pdfBytes(url) { const r = await call({ action: "pdf", store: S.store, url }); const bin = atob(r.b64 || ""), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  // content box of a page, in PDF points: where the non-white pixels are
  async function contentBox(page) {
    const vp = page.getViewport({ scale: 1 }), c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const x = c.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: x, viewport: vp }).promise;
    const d = x.getImageData(0, 0, c.width, c.height).data; let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let i = y * c.width * 4, xx = 0; xx < c.width; xx++, i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return { x0: 0, y0: 0, w: vp.width, h: vp.height };
    const pad = 4; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(c.width, x1 + pad); y1 = Math.min(c.height, y1 + pad);
    return { x0, y0, w: x1 - x0, h: y1 - y0 };
  }
  // one page → a PNG exactly the label size (4×6 at 300 dpi), upright, filling it
  async function pageToLabel(page) {
    const bx = await contentBox(page), land = bx.w > bx.h, Wt = 4 * DPI, Ht = 6 * DPI;
    const fw = land ? Ht : Wt, fh = land ? Wt : Ht, sc = Math.min(fw / bx.w, fh / bx.h);
    const c = document.createElement("canvas"); c.width = Math.round(bx.w * sc); c.height = Math.round(bx.h * sc);
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: x, viewport: page.getViewport({ scale: sc }), transform: [1, 0, 0, 1, -bx.x0 * sc, -bx.y0 * sc] }).promise;
    const out = document.createElement("canvas"); out.width = Wt; out.height = Ht;
    const o = out.getContext("2d"); o.fillStyle = "#fff"; o.fillRect(0, 0, Wt, Ht); o.imageSmoothingEnabled = false;
    if (land) { o.translate(Wt / 2, Ht / 2); o.rotate(Math.PI / 2); o.drawImage(c, -c.width / 2, -c.height / 2); }
    else o.drawImage(c, (Wt - c.width) / 2, (Ht - c.height) / 2);
    return out.toDataURL("image/png");
  }
  async function printLabels(urls) {
    const lib = await window.JTInvParse.pdfLib(), imgs = [];
    for (const u of urls) { const doc = await lib.getDocument({ data: await pdfBytes(u), isEvalSupported: false }).promise;
      for (let i = 1; i <= Math.min(doc.numPages, 4); i++) imgs.push(await pageToLabel(await doc.getPage(i))); }
    if (!imgs.length) throw { message: "No label pages to print." };
    const pp = PAPER[paper] || PAPER["4x6"], f = document.createElement("iframe");
    f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden"; document.body.appendChild(f);
    const css = `@page{size:${pp.page};margin:0}html,body{margin:0;padding:0;background:#fff}
      .pg{width:${pp.letter ? "8.5in" : "4in"};height:${pp.letter ? "11in" : "6in"};display:flex;align-items:${pp.letter ? "flex-start" : "center"};justify-content:center;${pp.letter ? "padding-top:.5in;box-sizing:border-box;" : ""}page-break-after:always;break-after:page;overflow:hidden}
      .pg:last-child{page-break-after:auto;break-after:auto}img{width:4in;height:6in;display:block;image-rendering:pixelated}`;
    f.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>${css}</style></head><body>${imgs.map(s2 => `<div class="pg"><img src="${s2}"></div>`).join("")}</body></html>`;
    await new Promise(r => { f.onload = r; });
    await Promise.all([...f.contentDocument.images].map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; })));
    f.contentWindow.focus(); f.contentWindow.print();
    setTimeout(() => f.remove(), 60000);
    return imgs.length;
  }

  const S = { mode: "print", pq: null, pqErr: "", printed: new Set(), pf: "todo", psel: new Set(), store: "jt", orders: null, err: "", sel: null, q: "", boxes: null, recent: [], busy: "", res: null, picks: {} };
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

  // ---------- To print: labels bought in Shopify, printed from here (Nov 3, Brian: "buy the shipping from within shopify
  // but then print the labels from seller sage") ----------
  async function loadPrintQ() {
    S.pq = null; S.pqErr = ""; render();
    try { const [r, pr] = await Promise.all([call({ action: "printq", store: S.store, days: 3 }), JT.rows(["label_id"], "from jt.ship_printed where printed_at > now() - interval '10 days'", true)]);
      S.pq = r.labels || []; S.printed = new Set(pr.map(x => x[0])); }
    catch (e) { S.pq = []; S.pqErr = JT.message ? JT.message(e) : String(e.message || e); }
    S.psel = new Set([...S.psel].filter(id => (S.pq || []).some(l => l.label_id === id))); render();
  }
  async function doPrint(ls) {
    const go = ls.filter(l => l.url); if (!go.length) { alertNote("No label file to print."); return; }
    S.busy = "print"; render();
    try { const n = await printLabels(go.map(l => l.url));
      await W().write("jt_ship_printed", { p: { store: S.store, labels: go.map(l => ({ label_id: l.label_id, order: l.order })) } });
      go.forEach(l => S.printed.add(l.label_id)); S.psel.clear(); alertNote(`Sent ${n} label${n === 1 ? "" : "s"} to the printer.`, true); }
    catch (e) { alertNote("Couldn't print: " + (JT.message ? JT.message(e) : e.message)); }
    S.busy = ""; render();
  }
  function printView() {
    const all = S.pq || [], todo = all.filter(l => !S.printed.has(l.label_id)), list = S.pf === "todo" ? todo : all;
    const q = S.q.trim().toLowerCase().replace(/^#/, ""), shown = list.filter(l => !q || [l.order, l.customer, l.tracking, ...l.items.map(i => i.sku + " " + i.title)].join(" ").toLowerCase().replace(/#/g, "").includes(q));
    const nSel = S.psel.size;
    return `<div class="panel-head"><h2>To print <span class="muted small">${S.pq ? `${n0(todo.length)} not printed · ${n0(all.length)} bought in the last 3 days` : ""}</span></h2>
        <span class="seg sm"><button type="button" data-lb-pf="todo" aria-pressed="${S.pf === "todo"}">Not printed</button><button type="button" data-lb-pf="all" aria-pressed="${S.pf === "all"}">All</button></span>
        <label class="small">Paper <select id="lb-paper" class="inp sm">${[["4x6", "4×6 label (thermal)"], ["letter", "Letter (4×6 label on the page)"]].map(([k, n]) => `<option value="${k}" ${paper === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <span class="dbtns right">${nSel ? `<button class="btn" data-lb-act="print-sel" ${S.busy ? "disabled" : ""}>Print ${n0(nSel)} selected</button>` : ""}<button class="btn primary" data-lb-act="print-todo" ${S.busy || !todo.length ? "disabled" : ""}>${S.busy === "print" ? "Preparing…" : `Print all not printed (${n0(todo.length)})`}</button></span></div>
      <p class="small muted">Buy the labels in Shopify (you see the prices there), then print them here: each label is trimmed and fitted to fill the label, upright, at full resolution. In the print window pick your label printer, paper ${paper === "4x6" ? "4×6 in" : "Letter"}, margins none, scale 100%.</p>
      ${S.pqErr ? `<div class="note warn small">${esc(S.pqErr)}</div>` : !S.pq ? '<div class="muted small">Loading labels from Shopify…</div>' : shown.length ? `<div class="tbl-wrap"><table class="prept lb-pt"><thead><tr><th><input type="checkbox" data-lb-pall ${shown.length && shown.every(l => S.psel.has(l.label_id)) ? "checked" : ""} aria-label="Select all"></th><th class="l">Order</th><th class="l">What's in it</th><th class="l">Label</th><th class="l">Bought</th><th></th></tr></thead><tbody>${
        shown.map(l => `<tr class="${S.printed.has(l.label_id) ? "dim" : ""}"><td><input type="checkbox" data-lb-psel="${esc(l.label_id)}" ${S.psel.has(l.label_id) ? "checked" : ""}></td>
          <td class="l"><b>${esc(l.order)}</b><div class="small">${esc(l.customer)}${l.to ? " · " + esc(l.to) : ""}</div></td>
          <td class="l small lb-pitems">${l.items.map(i => `<span class="lb-pi">${i.img ? `<img src="${esc(i.img)}" alt="">` : ""}<span>${i.qty > 1 ? `<b class="warnt">${i.qty}×</b> ` : ""}${esc(i.title)}<span class="muted mono"> ${esc(i.sku)}</span></span></span>`).join("")}</td>
          <td class="l small">${esc(l.company)}<div class="mono">${esc(l.tracking)}</div></td>
          <td class="l small">${esc(when(l.at))}${S.printed.has(l.label_id) ? '<div><span class="pill ok">printed</span></div>' : ""}</td>
          <td class="l nowrap">${l.url ? `<button class="btn sm ${S.printed.has(l.label_id) ? "" : "primary"}" data-lb-print="${esc(l.label_id)}" ${S.busy ? "disabled" : ""}>${S.printed.has(l.label_id) ? "Reprint" : "Print"}</button>` : '<span class="small muted">no file</span>'}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="muted small">${all.length ? "Everything's printed. 🎾" : "No Shopify Shipping labels bought in the last 3 days."}</div>`}`;
  }

  function render() {
    if ($("tab-labels").hidden) return;
    for (const b of document.querySelectorAll("#lb-mode [data-lb-mode]")) b.setAttribute("aria-pressed", String(b.dataset.lbMode === S.mode));
    const grid = host.querySelector(".lb-grid"), pv = $("lb-printv"), rec = $("lb-recent-panel");
    if (grid) grid.hidden = S.mode === "print"; if (rec) rec.hidden = S.mode === "print"; if (pv) { pv.hidden = S.mode !== "print"; if (S.mode === "print") { pv.innerHTML = printView(); for (const b of document.querySelectorAll("#lb-store [data-lb-store]")) b.setAttribute("aria-pressed", String(b.dataset.lbStore === S.store)); $("lb-sum").textContent = ""; return; } }
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
      if (r.ok) { p.done = true; if (url) printLabels([url]).catch(e2 => alertNote("Couldn't print it here: " + (JT.message ? JT.message(e2) : e2.message) + " — use the Print label link.")); }
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
    const md = e.target.closest("[data-lb-mode]"); if (md) { S.mode = md.dataset.lbMode; if (S.mode === "print" && !S.pq) loadPrintQ(); else if (S.mode === "buy" && !S.orders) loadQueue(); else render(); return; }
    const st = e.target.closest("[data-lb-store]"); if (st) { S.store = st.dataset.lbStore; S.sel = null; S.res = null; S.pq = null; S.orders = null; S.mode === "print" ? loadPrintQ() : loadQueue(); return; }
    const pf = e.target.closest("[data-lb-pf]"); if (pf) { S.pf = pf.dataset.lbPf; render(); return; }
    if (e.target.matches("[data-lb-psel]")) { e.target.checked ? S.psel.add(e.target.dataset.lbPsel) : S.psel.delete(e.target.dataset.lbPsel); render(); return; }
    if (e.target.matches("[data-lb-pall]")) { const vis = [...host.querySelectorAll("[data-lb-psel]")].map(x => x.dataset.lbPsel); vis.forEach(id => e.target.checked ? S.psel.add(id) : S.psel.delete(id)); render(); return; }
    const pr = e.target.closest("[data-lb-print]"); if (pr) { const l = (S.pq || []).find(x => x.label_id === pr.dataset.lbPrint); if (l) doPrint([l]); return; }
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
    if (k === "refresh") { if (S.mode === "print") { loadPrintQ(); return; } loadQueue(); loadRecent().then(render).catch(() => {}); return; }
    if (k === "print-todo") { doPrint((S.pq || []).filter(l => !S.printed.has(l.label_id))); return; }
    if (k === "print-sel") { doPrint((S.pq || []).filter(l => S.psel.has(l.label_id))); return; }
    if (k === "boxes") { S.boxEdit = !S.boxEdit; render(); return; }
    if (k === "buy" && o) return buy(o, false);
    if (k === "again" && o) return buy(o, true);
    if (k === "next") { const list = (S.orders || []).filter(x => !(S.picks[x.id] && S.picks[x.id].done)); S.sel = list.length ? list[0].id : null; S.res = null; render(); const s = $("lb-scan"); if (s) s.focus(); return; }
  });
  const alertNote = (t, ok) => { const n = $("lb-note"); if (n) { n.hidden = false; n.className = "note " + (ok ? "info" : "warn"); n.textContent = t; clearTimeout(n._t); n._t = setTimeout(() => { n.hidden = true; }, 6000); } };
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
    if (e.target.id === "lb-paper") { paper = e.target.value; try { localStorage.setItem("jt.lb.paper", paper); } catch (_) {} render(); return; }
    const o = (S.orders || []).find(x => x.id === S.sel), t = e.target; if (!o) return; const p = pick(o);
    if (t.id === "lb-svc") { p.svc = t.value; render(); }
    if (t.id === "lb-notify") p.notify = t.checked;
  });
  host.addEventListener("keydown", (e) => {
    if (e.target.id === "lb-scan" && e.key === "Enter" && S.mode === "print") { e.preventDefault(); const v = e.target.value.trim().replace(/^#/, "").toLowerCase(); e.target.value = ""; S.q = "";
      const l = (S.pq || []).find(x => x.order.replace(/^#/, "").toLowerCase() === v || x.tracking.toLowerCase() === v); if (l) doPrint([l]); else { S.q = v; render(); } return; }
    if (e.target.id === "lb-scan" && e.key === "Enter") { e.preventDefault(); const v = e.target.value; e.target.value = ""; scan(v); setTimeout(() => { const s = $("lb-scan"); if (s) s.focus(); }, 0); return; }
    if ((e.target.id === "lb-lb" || e.target.id === "lb-oz") && e.key === "Enter") { e.preventDefault(); const b = host.querySelector(".lb-go"); if (b && !b.disabled) b.click(); }
  });
  window.labShow = () => {
    if (!W()) { $("lb-pack").innerHTML = '<div class="note info">Buying labels works on the web version — open <b>dashboard.andersenlifestyle.com</b> › Shipping › Ship orders.</div>'; return; }
    if (!S.boxes) loadBoxes().then(render).catch(() => {});
    loadRecent().then(render).catch(() => {});
    if (S.mode === "print") { if (!S.pq) loadPrintQ(); else render(); } else if (!S.orders) loadQueue(); else render();
    setTimeout(() => { const s = $("lb-scan"); if (s) s.focus(); }, 50);
  };
  window.JTLabels = { _state: S };
  if ((location.hash || "") === "#labels") setTimeout(() => window.labShow(), 0);
})();
