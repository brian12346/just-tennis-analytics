(() => {
  // Inventory › Active products (Brian, Oct 28: "let's add an Active Products page. Let's start that list with anything we
  // have in stock in Shopify or Amazon and also include anything that we've sold in the last 12 months. We can cull the
  // list from there"). One row per product (its sizes/colors fold out); stock in the store, prep center and Amazon,
  // units sold in the last 12 months by channel. Remove takes a product (or one size) off the list — Shopify isn't
  // touched — and Removed shows them with Put back. Data: jt.active_products() (migration 184).
  const JT = window.JT, $ = (id) => document.getElementById(id);
  if (!JT || !$("tab-active")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n0 = (x) => Math.round(Number(x) || 0).toLocaleString("en-US");
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const TZ = "America/Los_Angeles";
  const sd = (d) => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: "UTC" }) : "";
  const FILTERS = [["all", "All"], ["both", "In stock & selling"], ["stock", "In stock, no sales 12 mo"], ["sold", "Sold, none in stock"], ["disc", "Discontinued"], ["draft", "Not active in Shopify"], ["removed", "Removed"]];
  const SORTK = { sold: (p) => -p.sold, stock: (p) => -p.stock, last: (p) => -(p.last ? Date.parse(p.last) : 0), name: (p) => p.title.toLowerCase(), vendor: (p) => (p.vendor + " " + p.title).toLowerCase() };
  const S = { rows: null, prods: null, f: "all", q: "", vendor: "", type: "", sort: "sold", open: new Set(), sel: new Set(), limit: 150, busy: false, err: null, ask: null };

  async function load() {
    S.err = null;
    const r = await JT.rows(["a.variant_id::text", "a.product_id::text", "a.title", "a.sku", "a.vendor", "a.product_type", "a.status", "a.price", "a.unit_cost",
      "a.store", "a.prep", "a.fba", "a.awd", "a.shop365", "a.anr365", "a.amz365", "a.sold90", "a.last_sold::text", "a.discontinued", "a.culled", "a.culled_at::text", "a.culled_by", "a.cull_note"],
      "from jt.active_products() a", true);
    S.rows = r.map(x => ({ vid: x[0], pid: x[1], title: x[2] || "", sku: x[3] || "", vendor: x[4] || "", type: x[5] || "", status: x[6] || "", price: x[7] == null ? null : +x[7], cost: x[8] == null ? null : +x[8],
      store: +x[9] || 0, prep: +x[10] || 0, fba: +x[11] || 0, awd: +x[12] || 0, shop: +x[13] || 0, anr: +x[14] || 0, amz: +x[15] || 0, s90: +x[16] || 0, last: x[17] || "",
      disc: x[18] === true || x[18] === "true", culled: x[19] === true || x[19] === "true", cAt: x[20] || "", cBy: x[21] || "", cNote: x[22] || "" }));
    group();
  }
  // a product's name without its size/color part ("Pure Aero 2026 - 4 1/8" (#1)" → "Pure Aero 2026")
  const base = (t) => String(t || "").split(" - ")[0].trim() || t;
  function group() {
    const by = new Map();
    for (const v of S.rows) {
      v.stock = v.store + v.prep + v.fba + v.awd; v.sold = v.shop + v.anr + v.amz;
      let p = by.get(v.pid); if (!p) by.set(v.pid, p = { pid: v.pid, title: base(v.title), vendor: v.vendor, type: v.type, vs: [] });
      p.vs.push(v);
    }
    for (const p of by.values()) {
      const sum = (k, vs) => vs.reduce((a, v) => a + v[k], 0);
      p.vs.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
      const live = p.vs.filter(v => !v.culled);
      p.allCulled = !live.length; p.someCulled = live.length < p.vs.length;
      const src = live.length ? live : p.vs;
      for (const k of ["store", "prep", "fba", "awd", "stock", "shop", "anr", "amz", "sold", "s90"]) p[k] = sum(k, src);
      p.last = src.map(v => v.last).filter(Boolean).sort().pop() || "";
      p.disc = src.every(v => v.disc); p.anyDisc = src.some(v => v.disc);
      p.draft = src.every(v => v.status !== "ACTIVE");
      p.value = src.reduce((a, v) => a + v.stock * (v.cost || 0), 0);
    }
    S.prods = [...by.values()];
  }
  const fOk = (p, f) => f === "removed" ? p.vs.some(v => v.culled) : p.allCulled ? false
    : f === "all" ? true : f === "both" ? p.stock > 0 && p.sold > 0 : f === "stock" ? p.stock > 0 && p.sold === 0 : f === "sold" ? p.sold > 0 && p.stock === 0
    : f === "disc" ? p.anyDisc : f === "draft" ? p.draft : true;
  function shown() {
    const q = S.q.trim().toLowerCase();
    const list = (S.prods || []).filter(p => fOk(p, S.f) && (!S.vendor || p.vendor === S.vendor) && (!S.type || p.type === S.type)
      && (!q || (p.title + " " + p.vendor + " " + p.type + " " + p.vs.map(v => v.sku + " " + v.title).join(" ")).toLowerCase().includes(q)));
    const k = SORTK[S.sort] || SORTK.sold;
    return list.sort((a, b) => { const x = k(a), y = k(b); return x < y ? -1 : x > y ? 1 : a.title.localeCompare(b.title); });
  }
  const stockCell = (o) => o.stock ? `<span title="Store ${n0(o.store)} · prep ${n0(o.prep)} · Amazon FBA ${n0(o.fba)} · AWD ${n0(o.awd)}">${n0(o.stock)}</span>` : '<span class="dim">0</span>';
  const where = (o) => [["Store", o.store], ["Prep", o.prep], ["FBA", o.fba], ["AWD", o.awd]].filter(x => x[1]).map(x => `${x[0]} ${n0(x[1])}`).join(" · ");
  const soldCell = (o) => o.sold ? `<span title="Just Tennis ${n0(o.shop)} · Ace n Rally ${n0(o.anr)} · Amazon ${n0(o.amz)} · last 90 days ${n0(o.s90)}">${n0(o.sold)}</span>` : '<span class="dim">0</span>';
  const chans = (o) => [["JT", o.shop], ["AnR", o.anr], ["Amz", o.amz]].filter(x => x[1]).map(x => `${x[0]} ${n0(x[1])}`).join(" · ");
  const tags = (o, isP) => [
    (isP ? o.anyDisc : o.disc) ? '<span class="pill miss">discontinued</span>' : "",
    (isP ? o.draft : o.status !== "ACTIVE") ? `<span class="pill pos" title="Shopify status">${esc(isP ? "not active" : (o.status || "").toLowerCase())}</span>` : "",
    o.stock > 0 && o.sold === 0 ? '<span class="pill warn" title="Stock on hand, nothing sold in 12 months">no sales</span>' : "",
    o.sold > 0 && o.stock === 0 ? '<span class="pill other" title="Sold in the last 12 months, none on hand anywhere">out</span>' : ""].join(" ");

  function render() {
    if ($("tab-active").hidden) return;
    const st = $("ap-status");
    if (S.err) { st.innerHTML = `<span class="neg">Couldn't load the list: ${esc(JT.message(S.err))}</span>`; return; }
    if (!S.prods) { st.textContent = "Loading products, stock and 12 months of sales… (a few seconds)"; $("ap-table").innerHTML = ""; return; }
    const live = S.prods.filter(p => !p.allCulled), lv = S.rows.filter(v => !v.culled);
    $("ap-kpis").innerHTML = [
      ["Active products", n0(live.length), `${n0(lv.length)} sizes / colors`],
      ["In stock", n0(live.filter(p => p.stock > 0).length), `${n0(lv.reduce((a, v) => a + v.stock, 0))} units · store, prep, Amazon`],
      ["Sold in 12 months", n0(live.filter(p => p.sold > 0).length), `${n0(lv.reduce((a, v) => a + v.sold, 0))} units, all channels`],
      ["In stock, no sales", n0(live.filter(p => p.stock > 0 && p.sold === 0).length), "candidates to cull or clear out"],
      ["Removed", n0(S.prods.filter(p => p.vs.some(v => v.culled)).length), "taken off the list"],
    ].map(([l, v, s]) => `<div class="kpi"><span class="eyebrow">${l}</span><span class="v">${v}</span><span class="s">${s}</span></div>`).join("");
    $("ap-seg").innerHTML = FILTERS.map(([k, n]) => `<button data-ap-f="${k}" aria-pressed="${S.f === k}">${n} <span class="cnt">${n0(S.prods.filter(p => fOk(p, k)).length)}</span></button>`).join("");
    const opts = (k, cur, all) => `<option value="">${all}</option>` + [...new Set(S.prods.map(p => p[k]).filter(Boolean))].sort().map(v => `<option ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
    $("ap-vendor").innerHTML = opts("vendor", S.vendor, "All vendors"); $("ap-type").innerHTML = opts("type", S.type, "All types");
    const list = shown(), page = list.slice(0, S.limit), rem = S.f === "removed";
    st.textContent = `${n0(list.length)} product${list.length === 1 ? "" : "s"}${list.length > page.length ? ` · showing ${n0(page.length)}` : ""}`;
    const nSel = S.sel.size;
    $("ap-bulk").innerHTML = nSel ? `<b>${n0(nSel)}</b> selected · ${rem ? `<button class="btn sm primary" data-ap-act="restore">Put back on the list</button>` : `<input id="ap-note" class="inp sm" placeholder="Why (optional)" style="width:200px"> <button class="btn sm primary" data-ap-act="cull" ${S.busy ? "disabled" : ""}>Remove from the list</button>`} <button class="linkbtn small" data-ap-act="clear">Clear</button>` : `<span class="muted small">${rem ? "Tick products to put them back." : "Tick products (or single sizes) to take them off the list. Shopify isn't changed."}</span>`;
    const th = (k, l, left) => `<th class="${left ? "l" : ""} sortable" data-ap-sort="${k}" aria-sort="${S.sort === k ? "descending" : "none"}">${l}${S.sort === k ? " ↓" : ""}</th>`;
    const allOn = page.length && page.every(p => p.vs.filter(v => rem ? v.culled : !v.culled).every(v => S.sel.has(v.vid)));
    $("ap-table").innerHTML = `<thead><tr><th><input type="checkbox" data-ap-all ${allOn ? "checked" : ""} aria-label="Select all shown"></th><th></th>${th("name", "Product", 1)}${th("vendor", "Vendor · type", 1)}${th("stock", "On hand")}<th class="l">Where</th>${th("sold", "Sold 12 mo")}<th class="l">Channels</th>${th("last", "Last sold", 1)}<th class="l"></th></tr></thead><tbody>${
      page.map(p => {
        const vs = p.vs.filter(v => rem ? v.culled : !v.culled), o = S.open.has(p.pid), on = vs.length && vs.every(v => S.sel.has(v.vid)), some = !on && vs.some(v => S.sel.has(v.vid));
        const one = p.vs.length === 1 ? p.vs[0] : null;
        return `<tr class="po-row ap-p ${o ? "on" : ""}" data-ap-open="${esc(p.pid)}">
          <td><input type="checkbox" data-ap-selp="${esc(p.pid)}" ${on ? "checked" : ""} ${some ? 'data-some="1"' : ""} aria-label="Select ${esc(p.title)}"></td>
          <td class="rl-car" aria-hidden="true">${p.vs.length > 1 ? (o ? "▾" : "▸") : ""}</td>
          <td class="l"><a class="olink" href="${ADMIN}/products/${esc(p.pid)}" target="_blank" rel="noopener">${esc(one ? one.title : p.title)}</a>
            <div class="meta">${one ? `<span class="mono">${esc(one.sku) || "no SKU"}</span>` : `${n0(vs.length)} size${vs.length === 1 ? "" : "s"} / color${vs.length === 1 ? "" : "s"}${p.someCulled && !rem ? ` · ${n0(p.vs.length - vs.length)} removed` : ""}`} ${tags(p, true)}</div></td>
          <td class="l small">${esc(p.vendor || "—")}<div class="meta">${esc(p.type || "")}</div></td>
          <td class="num">${stockCell(p)}</td><td class="l small muted">${where(p)}</td>
          <td class="num">${soldCell(p)}</td><td class="l small muted">${chans(p)}</td>
          <td class="l small">${p.last ? esc(sd(p.last)) : '<span class="dim">—</span>'}</td>
          <td class="l small">${rem ? vs.map(v => v.cNote).filter(Boolean).slice(0, 1).map(esc).join("") || '<span class="dim">removed</span>' : ""}</td></tr>
          ${o && p.vs.length > 1 ? vs.map(v => `<tr class="ap-v"><td><input type="checkbox" data-ap-selv="${esc(v.vid)}" ${S.sel.has(v.vid) ? "checked" : ""} aria-label="Select ${esc(v.title)}"></td><td></td>
            <td class="l"><a class="olink" href="${ADMIN}/products/${esc(v.pid)}/variants/${esc(v.vid)}" target="_blank" rel="noopener">${esc(v.title)}</a><div class="meta"><span class="mono">${esc(v.sku) || "no SKU"}</span> ${tags(v, false)}</div></td>
            <td></td><td class="num">${stockCell(v)}</td><td class="l small muted">${where(v)}</td><td class="num">${soldCell(v)}</td><td class="l small muted">${chans(v)}</td>
            <td class="l small">${v.last ? esc(sd(v.last)) : '<span class="dim">—</span>'}</td><td class="l small">${v.culled ? `<span class="dim" title="${esc(v.cBy)} · ${esc(v.cAt.slice(0, 10))}">${esc(v.cNote || "removed")}</span>` : ""}</td></tr>`).join("") : ""}`;
      }).join("") || `<tr><td colspan="10" class="l muted">${S.prods.length ? "Nothing matches." : "No products."}</td></tr>`}</tbody>`;
    for (const c of $("ap-table").querySelectorAll('input[data-some="1"]')) c.indeterminate = true;
    $("ap-more").hidden = list.length <= page.length;
  }

  async function refresh() {
    S.prods = S.prods || null; render();
    try { await load(); } catch (e) { S.err = e; }
    render();
  }
  async function setCull(cull) {
    const ids = [...S.sel]; if (!ids.length) return;
    const note = cull && $("ap-note") ? $("ap-note").value.trim() : "";
    S.busy = true; render();
    try {
      const p = { ids, cull, note }, W = window.JTWeb || null;
      if (W) await W.write("jt_active_cull", { p });
      else await JT.run(`select jt.active_cull_set(${JT.q(JSON.stringify({ ...p, by: "Claude dashboard" }))}::jsonb)::text as r`, true);
      const now = new Date().toISOString();
      for (const v of S.rows) if (S.sel.has(v.vid)) { v.culled = cull; v.cNote = cull ? note : ""; v.cAt = cull ? now : ""; }
      group(); S.sel.clear();
      const b = $("ap-note2"); b.hidden = false; b.className = "note info";
      b.textContent = cull ? `Took ${n0(ids.length)} item${ids.length === 1 ? "" : "s"} off the list — see Removed to put ${ids.length === 1 ? "it" : "them"} back.` : `Put ${n0(ids.length)} item${ids.length === 1 ? "" : "s"} back on the list.`;
    } catch (e) { const b = $("ap-note2"); b.hidden = false; b.className = "note bad"; b.textContent = "Couldn't save that: " + JT.message(e); }
    S.busy = false; render();
  }
  const pick = (vids, on) => { for (const v of vids) on ? S.sel.add(v) : S.sel.delete(v); };
  const liveVids = (p) => p.vs.filter(v => S.f === "removed" ? v.culled : !v.culled).map(v => v.vid);

  $("tab-active").addEventListener("click", (e) => {
    const f = e.target.closest("[data-ap-f]"); if (f) { S.f = f.dataset.apF; S.sel.clear(); S.limit = 150; render(); return; }
    const so = e.target.closest("[data-ap-sort]"); if (so) { S.sort = so.dataset.apSort; render(); return; }
    const a = e.target.closest("[data-ap-act]");
    if (a) { const k = a.dataset.apAct; if (k === "cull") setCull(true); else if (k === "restore") setCull(false); else if (k === "clear") { S.sel.clear(); render(); } return; }
    if (e.target.matches("[data-ap-all]")) { const page = shown().slice(0, S.limit); pick(page.flatMap(liveVids), e.target.checked); render(); return; }
    const sp = e.target.closest("[data-ap-selp]"); if (sp) { const p = S.prods.find(x => x.pid === sp.dataset.apSelp); if (p) pick(liveVids(p), sp.checked); render(); return; }
    const sv = e.target.closest("[data-ap-selv]"); if (sv) { pick([sv.dataset.apSelv], sv.checked); render(); return; }
    if (e.target.closest("#ap-more")) { S.limit += 300; render(); return; }
    if (e.target.closest("#ap-refresh")) { refresh(); return; }
    const row = e.target.closest("[data-ap-open]");
    if (row && !e.target.closest("a, button, input")) { const id = row.dataset.apOpen; S.open.has(id) ? S.open.delete(id) : S.open.add(id); render(); }
  });
  $("ap-q").addEventListener("input", (e) => { S.q = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(() => { S.limit = 150; render(); }, 150); });
  $("ap-vendor").addEventListener("change", (e) => { S.vendor = e.target.value; S.limit = 150; render(); });
  $("ap-type").addEventListener("change", (e) => { S.type = e.target.value; S.limit = 150; render(); });
  window.apShow = () => { if (!S.rows && !S.err) refresh(); else render(); };
  window.JTActive = { _state: S };
  if ((location.hash || "") === "#active") setTimeout(() => window.apShow(), 0);
})();
