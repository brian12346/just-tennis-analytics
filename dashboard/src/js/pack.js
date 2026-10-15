// Shipping › Packing photos (Brian, Oct 15): in the warehouse, open Seller Sage on the iPhone, scan the packing slip or
// shipping label, take photos, and each photo is saved to that order (Just Tennis, Ace n Rally, Amazon FBM). Photos go
// to the private Storage bucket "order-photos"; jt.order_photos keeps one row per photo (migration 151). A code that
// doesn't match an order yet is still saved and matched once the order syncs. Each Shopify order gets a link back here
// (#pack/<store>/<order id>, set on the order by the sync job). Taking photos needs the website (Storage upload); the
// Claude version can look orders up and list photos.
(() => {
  const $ = (id) => document.getElementById(id);
  if (!$("tab-pack")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ZX_URL = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";
  const BUCKET = "order-photos";
  const STORE = { justtennis: "Just Tennis", acenrally: "Ace n Rally", amazon: "Amazon FBM", "": "No order yet" };
  const K = { view: "home", q: "", code: "", matches: null, order: null, photos: [], recent: null, err: "", finding: false, scanning: false, big: null, loaded: false };
  const web = () => window.JTWeb || null;
  const store = () => { const w = web(); return w && w.storage ? w.storage() : null; };
  const when = (t) => { const d = window.JTDate.parseTime(t); return isNaN(d) ? "" : d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  const note = (kind, html) => { const n = $("pk-note"); n.className = "note " + (kind || ""); n.innerHTML = html || ""; n.hidden = !html; };

  // ---------- data ----------
  async function loadRecent() {
    try {
      const r = await JT.rows(["store", "coalesce(order_id, '')", "max(order_name)", "max(code)", "count(*)", "max(taken_at)::text", "max(taken_by)"],
        `from jt.order_photos where hidden_at is null and taken_at > now() - interval '3 days'
           group by store, order_id, case when order_id is null then code end order by max(taken_at) desc limit 40`, true);
      K.recent = r.map(x => ({ store: x[0] || "", order_id: x[1] || "", name: x[2] || x[3] || "", code: x[3] || "", n: +x[4] || 0, at: x[5], by: x[6] || "" }));
    } catch (e) { K.recent = []; }
    if (K.view === "home") render();
  }
  async function find(q) {
    const w = web();
    if (w) { const r = await w.rpc("jt_order_find", { q }); return typeof r === "string" ? JSON.parse(r) : (r || []); }
    const out = await JT.run(`select jt.order_find(${JT.q(q)})::text as r`, true);
    return out[0] && out[0].r ? JSON.parse(out[0].r) : [];
  }
  async function loadPhotos() {
    const o = K.order; if (!o) return;
    const where = o.order_id ? `store = ${JT.q(o.store)} and order_id = ${JT.q(o.order_id)}` : `order_id is null and code = ${JT.q(o.code)}`;
    const r = await JT.rows(["id::text", "path", "taken_at::text", "taken_by"], `from jt.order_photos where hidden_at is null and ${where} order by taken_at`, true);
    const ph = r.map(x => ({ id: x[0], path: x[1], at: x[2], by: x[3] || "", url: "" }));
    const st = store();
    if (st && ph.length) {
      try {
        const { data } = await st.from(BUCKET).createSignedUrls(ph.map(p => p.path), 3600);
        for (const d of data || []) { const p = ph.find(x => x.path === d.path); if (p && d.signedUrl) p.url = d.signedUrl; }
      } catch (_) {}
    }
    // keep photos still uploading from this screen
    K.photos = ph.concat(K.photos.filter(p => p.uploading || p.failed));
    render();
  }

  // ---------- finding an order ----------
  async function lookup(code) {
    code = String(code || "").trim(); if (!code) return;
    K.code = code; K.q = code; K.finding = true; K.err = ""; K.matches = null; render();
    try {
      const m = await find(code);
      K.finding = false;
      if (m.length === 1) return openOrder(m[0]);
      K.matches = m; K.view = "pick"; render();
    } catch (e) { K.finding = false; K.err = JT.message(e); render(); }
  }
  function openOrder(m) {
    K.order = { ...m, code: K.code }; K.photos = []; K.view = "order"; K.matches = null; render();
    try { history.replaceState(null, "", m.order_id ? `#pack/${m.store}/${m.order_id}` : "#pack"); } catch (_) {}
    loadPhotos().catch(() => {});
  }
  function openUnmatched() { openOrder({ store: "", order_id: "", name: K.code, items: [], status: "", created: "" }); }

  // ---------- scanning (camera + ZXing) ----------
  let zxP = null, reader = null;
  function zx() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    if (!zxP) zxP = new Promise((ok, bad) => { const s = document.createElement("script"); s.src = ZX_URL; s.onload = () => ok(window.ZXing); s.onerror = () => { zxP = null; bad(new Error("couldn't load the barcode reader")); }; document.head.appendChild(s); });
    return zxP;
  }
  async function startScan() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { K.err = "This browser can't open the camera here. Type the order number instead."; render(); return; }
    K.view = "scan"; K.scanning = true; K.err = ""; render();
    try {
      const Z = await zx();
      const hints = new Map(); hints.set(Z.DecodeHintType.TRY_HARDER, true);
      reader = new Z.BrowserMultiFormatReader(hints, 300);
      const video = $("pk-video");
      await reader.decodeFromConstraints({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } }, video, (res) => {
        if (res && K.scanning) { const t = res.getText(); stopScan(); if (navigator.vibrate) navigator.vibrate(60); lookup(t); }
      });
    } catch (e) {
      stopScan(); K.view = "home";
      K.err = /denied|NotAllowed/i.test(String(e && (e.name || e.message))) ? "Camera access was blocked. Allow the camera for this site (Safari: aA › Website Settings › Camera), or type the order number." : "Couldn't start the camera: " + esc(e.message || e);
      render();
    }
  }
  function stopScan() { K.scanning = false; try { if (reader) reader.reset(); } catch (_) {} reader = null; }

  // ---------- photos ----------
  function shrink(file) {
    return new Promise((ok) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const MAX = 1600, s = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        c.toBlob(b => ok({ blob: b || file, w: c.width, h: c.height }), "image/jpeg", 0.82);
      };
      img.onerror = () => { URL.revokeObjectURL(url); ok({ blob: file, w: null, h: null }); };
      img.src = url;
    });
  }
  async function addPhotos(files) {
    const o = K.order, st = store(); if (!o || !files.length) return;
    if (!st) { note("warn", "Taking photos works on the website (dashboard.andersenlifestyle.com) — open it there on the phone."); return; }
    for (const f of files) {
      const tile = { id: "", path: "", at: new Date().toISOString(), by: "", url: URL.createObjectURL(f), uploading: true };
      K.photos.push(tile); render();
      try {
        const { blob, w, h } = await shrink(f);
        const key = o.order_id || ("code-" + (o.code || "x").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60));
        const path = `${o.store || "unmatched"}/${key}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        const up = await st.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false });
        if (up.error) throw up.error;
        const id = await web().write("jt_order_photo_add", { p: { store: o.store, order_id: o.order_id, order_name: o.name, code: o.code, path, bytes: blob.size, width: w, height: h } });
        tile.uploading = false; tile.id = String(id); tile.path = path;
      } catch (e) { tile.uploading = false; tile.failed = JT.message ? JT.message(e) : String(e.message || e); }
      render();
    }
    const done = K.photos.filter(p => p.id).length;
    note("info", `${esc(o.name || o.code)}: ${done} photo${done === 1 ? "" : "s"} saved.`);
  }
  async function hidePhoto(id) {
    try { await web().write("jt_order_photo_hide", { p: { id: Number(id), hide: true } }); K.photos = K.photos.filter(p => p.id !== id); K.big = null; render(); }
    catch (e) { note("bad", "Couldn't remove it: " + esc(JT.message(e))); }
  }

  // ---------- render ----------
  const itemsHtml = (o) => (o.items || []).length ? `<ul class="pk-items">${o.items.map(i => `<li><b>${esc(i.qty)}×</b> ${esc(i.title)}<span class="mono dim"> ${esc(i.sku)}</span></li>`).join("")}</ul>` : "";
  const orderHead = (o) => `<div class="pk-ohead"><span class="pill ${o.store === "amazon" ? "warn" : o.store ? "ok" : "miss"}">${esc(STORE[o.store] ?? o.store)}</span>
      <b class="pk-oname">${esc(o.name || o.code)}</b>${o.cancelled ? ' <span class="pill miss">cancelled</span>' : ""}
      <span class="muted small">${o.created ? when(o.created) : ""}${o.status ? " · " + esc(String(o.status).toLowerCase()) : ""}</span></div>`;
  function render() {
    const el = $("pk-body"); if (!el) return;
    const canShoot = !!store();
    const findBox = `<form id="pk-form" class="pk-find"><input id="pk-q" class="inp" value="${esc(K.q)}" placeholder="Order #, Amazon order ID or tracking" autocomplete="off" autocapitalize="characters" enterkeyhint="search"><button class="btn" type="submit">${K.finding ? "Finding…" : "Find"}</button></form>`;
    const err = K.err ? `<div class="note bad">${K.err}</div>` : "";
    if (K.view === "scan") {
      el.innerHTML = `<div class="pk-scan"><video id="pk-video" playsinline muted autoplay></video><div class="pk-aim"></div></div>
        <p class="muted small" style="text-align:center">Point at the barcode on the packing slip or shipping label.</p>
        <div class="pk-actions"><button class="btn" data-pk="cancel">Cancel</button></div>${findBox}`;
      return;
    }
    if (K.view === "pick") {
      el.innerHTML = `${err}<div class="pk-card"><div class="muted small">Scanned <span class="mono">${esc(K.code)}</span></div>
        ${K.matches && K.matches.length ? `<p><b>${K.matches.length} orders match — which one?</b></p>${K.matches.map((m, i) => `<button class="pk-pick" data-pkpick="${i}">${orderHead(m)}${itemsHtml(m)}</button>`).join("")}`
          : `<p><b>No order found for this code yet.</b> A brand-new order can take up to an hour to reach Seller Sage. You can still take the photos now — they're matched to the order once it syncs.</p>
             <div class="pk-actions"><button class="btn primary big" data-pk="unmatched">Take photos anyway</button></div>`}
        <div class="pk-actions"><button class="btn" data-pk="scan">Scan again</button><button class="btn" data-pk="home">Back</button></div></div>${findBox}`;
      return;
    }
    if (K.view === "order" && K.order) {
      const o = K.order, ph = K.photos, up = ph.filter(p => p.uploading).length;
      el.innerHTML = `${err}<div class="pk-card">${orderHead(o)}${o.order_id ? "" : `<div class="note warn small">Not matched to an order yet — saved under <span class="mono">${esc(o.code)}</span> and matched once the order syncs.</div>`}${itemsHtml(o)}
          <div class="pk-photos">${ph.map(p => `<button class="pk-ph ${p.uploading ? "up" : ""} ${p.failed ? "bad" : ""}" ${p.id ? `data-pkbig="${esc(p.id)}"` : ""} title="${p.failed ? esc(p.failed) : esc(when(p.at) + (p.by ? " · " + p.by : ""))}">${p.url ? `<img src="${esc(p.url)}" alt="Packing photo">` : '<span class="dim small">photo</span>'}${p.uploading ? '<span class="pk-spin">Saving…</span>' : p.failed ? '<span class="pk-spin">Failed</span>' : ""}</button>`).join("")}</div>
          <div class="muted small">${ph.filter(p => p.id).length} photo${ph.filter(p => p.id).length === 1 ? "" : "s"} saved${up ? ` · ${up} saving…` : ""}</div>
          ${canShoot ? `<label class="btn primary big pk-shoot" for="pk-file">📷 Take photo<input type="file" id="pk-file" accept="image/*" capture="environment" hidden></label>`
            : '<div class="note warn">Open Seller Sage on the website (dashboard.andersenlifestyle.com) on the phone to take photos.</div>'}
          <div class="pk-actions"><button class="btn big" data-pk="next">${up ? "Saving…" : "Done · next order"}</button><button class="btn" data-pk="home">Back</button></div></div>
        ${K.big ? (() => { const p = ph.find(x => x.id === K.big); return p ? `<div class="pk-big" data-pk="closebig"><img src="${esc(p.url)}" alt="Packing photo"><div class="pk-bigbar"><span class="small">${esc(when(p.at))}${p.by ? " · " + esc(p.by) : ""}</span>
            <a class="btn sm" href="${esc(p.url)}" target="_blank" rel="noopener">Open</a>${canShoot ? `<button class="btn sm" data-pkhide="${esc(p.id)}">Remove from order</button>` : ""}<button class="btn sm" data-pk="closebig">Close</button></div></div>` : ""; })() : ""}`;
      return;
    }
    // home
    const rec = K.recent;
    el.innerHTML = `${err}<div class="pk-card pk-home"><button class="btn primary big" data-pk="scan">▦ Scan order</button>
        <div class="muted small" style="text-align:center">Scan the packing slip or shipping label, take the photos, then Done.</div>${findBox}</div>
      <h3 class="psec">Photographed lately</h3>
      ${rec == null ? '<div class="muted small">Loading…</div>' : rec.length ? `<div class="pk-recent">${rec.map((r, i) => `<button class="pk-rrow" data-pkrec="${i}"><span class="pill ${r.store === "amazon" ? "warn" : r.store ? "ok" : "miss"}">${esc(STORE[r.store] ?? r.store)}</span>
          <b>${esc(r.name)}</b><span class="muted small">${r.n} photo${r.n === 1 ? "" : "s"} · ${esc(when(r.at))}${r.by ? " · " + esc(r.by.split("@")[0]) : ""}</span></button>`).join("")}</div>` : '<div class="muted small">No photos in the last 3 days.</div>'}`;
  }

  // ---------- events ----------
  const box = $("tab-pack");
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pk],[data-pkpick],[data-pkrec],[data-pkbig],[data-pkhide]"); if (!b) return;
    if (b.dataset.pkhide) { e.stopPropagation(); return hidePhoto(b.dataset.pkhide); }
    if (b.dataset.pkbig) { K.big = b.dataset.pkbig; render(); return; }
    if (b.dataset.pkpick != null) return openOrder(K.matches[+b.dataset.pkpick]);
    if (b.dataset.pkrec != null) { const r = K.recent[+b.dataset.pkrec]; K.code = r.code; return openOrder({ store: r.store, order_id: r.order_id, name: r.name, items: [], status: "", created: "" }); }
    const a = b.dataset.pk;
    if (a === "closebig") { if (e.target.closest(".pk-bigbar") && b.tagName !== "BUTTON") return; K.big = null; render(); return; }
    if (a === "scan") return startScan();
    if (a === "cancel") { stopScan(); K.view = "home"; render(); return; }
    if (a === "unmatched") return openUnmatched();
    if (a === "home") { stopScan(); K.view = "home"; K.order = null; K.q = ""; try { history.replaceState(null, "", "#pack"); } catch (_) {} render(); loadRecent(); return; }
    if (a === "next") { if (K.photos.some(p => p.uploading)) return; K.order = null; K.q = ""; loadRecent(); return startScan(); }
  });
  box.addEventListener("submit", (e) => { if (e.target.id === "pk-form") { e.preventDefault(); stopScan(); const v = ($("pk-q") || {}).value || ""; lookup(v); } });
  box.addEventListener("input", (e) => { if (e.target.id === "pk-q") K.q = e.target.value; });
  box.addEventListener("change", (e) => { if (e.target.id === "pk-file") { const fs = [...e.target.files]; e.target.value = ""; addPhotos(fs); } });
  $("pk-refresh").addEventListener("click", () => { if (K.view === "order") loadPhotos(); else loadRecent(); });

  window.packShow = async () => {
    const route = window.__packRoute; window.__packRoute = null;
    if (route) {     // #pack/<store>/<order id> (the link on a Shopify order)
      const [st, oid] = route.split("/");
      try {
        const r = await JT.rows(["max(order_name)", "max(code)"], `from jt.order_photos where store = ${JT.q(st)} and order_id = ${JT.q(oid)}`, true);
        const name = (r[0] && (r[0][0] || r[0][1])) || "";
        if (name) { K.code = name; const m = await find(name).catch(() => []); const hit = m.find(x => x.store === st && x.order_id === oid); return openOrder(hit || { store: st, order_id: oid, name, items: [] }); }
      } catch (_) {}
      return openOrder({ store: st, order_id: oid, name: "", items: [] });
    }
    if (!K.loaded) { K.loaded = true; loadRecent(); }
    render();
  };
  window.addEventListener("hashchange", () => { if (!/^#pack/.test(location.hash)) stopScan(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && K.scanning) { stopScan(); K.view = "home"; render(); } });
  if (/^#pack/.test(location.hash || "") || window.__packRoute) setTimeout(() => window.packShow(), 0);
  render();
})();
