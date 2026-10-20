// Inventory › Shoes (Brian, Oct 17; Just Tennis only): shoe stock as a size grid — one row per model and color (and
// width), one column per size, grouped by brand — so it's easy to see what's on the shelf for each. Shopify stock at
// all locations (jt.variants.inventory_qty, refreshed by the catalog sync) and units sold in the last 90 days per size.
// The size is the variant option that looks like a shoe size ("10", "6.5", "1"); the options before it are the color,
// anything after it (e.g. "Regular", "Wide") is the width.
// Oct 20 (Brian: "add costs and prices. And profit"): each colorway's price and cost (Shopify), margin per pair, and its
// last-90-days sales and profit (jt.shopify_sales: net − cost of goods; sales of pairs without a cost are left out).
(() => {
  const $ = (id) => document.getElementById(id);
  if (!$("tab-shoes")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const n0 = (x) => Math.round(x || 0).toLocaleString();
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m0 = (n) => usd0.format(n || 0);
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const S = { rows: null, err: null, loading: false, brand: "all", type: "all", who: "all", q: "", stock: "instock", sold: false, collapsed: new Set() };
  const msg = (e) => (window.JT.message ? window.JT.message(e) : (e && e.message) || String(e));

  const SIZE = /^(?:[A-Z]{1,2}\s?)?\d{1,2}(?:\.5)?(?:\s?[A-Z]{1,2})?$/i;     // 10, 6.5, 1, "M 10", "10 W"
  function parse(vt) {
    const t = String(vt || "").split(/\s+\/\s+/).map(x => x.trim()).filter(Boolean);
    let i = -1;
    for (let k = t.length - 1; k >= 0; k--) if (SIZE.test(t[k]) && /\d/.test(t[k])) { i = k; break; }
    if (i < 0) return { color: t.join(" / ") || "—", size: "—", width: "" };
    return { color: t.slice(0, i).join(" / ") || "—", size: t[i].replace(/\s+/g, " "), width: t.slice(i + 1).join(" / ") };
  }
  const sizeNum = (s) => { const m = String(s).match(/\d+(?:\.5)?/); return m ? +m[0] : 999; };
  const who = (title) => /\b(jr|junior|kids?|youth|boys?|girls?)\b/i.test(title) ? "Junior" : /\bwomen'?s?\b|\bladies\b|\bw\b/i.test(title) ? "Women" : /\bmen'?s?\b/i.test(title) ? "Men" : "";
  const kind = (pt) => /pickleball/i.test(pt) ? "Pickleball" : /padel/i.test(pt) ? "Padel" : "Tennis";

  async function load(refresh) {
    S.loading = true; S.err = null; render();
    try {
      const r = await window.JT.rows(["v.variant_id::text", "v.product_id::text", "v.product_title", "v.variant_title", "v.vendor", "v.product_type",
        "coalesce(v.inventory_qty, 0)::text", "v.price::text", "v.unit_cost::text", "v.sku", "coalesce(s.units, 0)::text",
        "coalesce(s.net, 0)::text", "coalesce(s.profit, 0)::text", "coalesce(s.costed_net, 0)::text"],
        `from jt.variants v left join (select variant_id, sum(units) as units, sum(net) as net, sum(net - net_no_cost - cogs) as profit, sum(net - net_no_cost) as costed_net
                                       from jt.shopify_sales where day > current_date - 90 group by variant_id) s
           on s.variant_id = v.variant_id
         where v.status = 'ACTIVE' and v.removed_at is null and v.product_type ilike '%shoe%' order by v.vendor, v.product_title`, refresh);
      S.rows = r.map(x => ({ vid: x[0], pid: x[1], title: x[2], vt: x[3], vendor: x[4], type: kind(x[5]), qty: +x[6] || 0, price: x[7] == null ? null : +x[7],
        cost: x[8] == null ? null : +x[8], sku: x[9], sold: +x[10] || 0, net: +x[11] || 0, profit: +x[12] || 0, cnet: +x[13] || 0, ...parse(x[3]), who: who(x[2]) }));
    } catch (e) { S.err = e; }
    S.loading = false; render();
  }

  // rows of the grid: product × color × width, each with qty and sold per size
  function lines(rows) {
    const by = new Map();
    for (const r of rows) {
      const k = r.pid + "|" + r.color + "|" + r.width;
      if (!by.has(k)) by.set(k, { pid: r.pid, title: r.title, color: r.color, width: r.width, vendor: r.vendor, type: r.type, who: r.who, sizes: new Map(), qty: 0, sold: 0, cost: 0, retail: 0, price: r.price, vid: r.vid,
        prices: [], costs: [], net: 0, profit: 0, cnet: 0 });
      const L = by.get(k), c = L.sizes.get(r.size) || { qty: 0, sold: 0, vid: r.vid, sku: r.sku };
      c.qty += r.qty; c.sold += r.sold; L.sizes.set(r.size, c);
      L.qty += r.qty; L.sold += r.sold; L.net += r.net; L.profit += r.profit; L.cnet += r.cnet;
      if (r.price != null) L.prices.push(r.price);
      if (r.cost != null && r.cost > 0) L.costs.push({ c: r.cost, w: Math.max(1, r.qty) });
      if (r.qty > 0) { L.cost += r.qty * (r.cost || 0); L.retail += r.qty * (r.price || 0); }
    }
    for (const L of by.values()) {
      L.pLo = L.prices.length ? Math.min(...L.prices) : null; L.pHi = L.prices.length ? Math.max(...L.prices) : null;
      const w = L.costs.reduce((a, x) => a + x.w, 0);
      L.unitCost = w ? L.costs.reduce((a, x) => a + x.c * x.w, 0) / w : null;
      L.unitPrice = L.prices.length ? L.prices.reduce((a, x) => a + x, 0) / L.prices.length : null;
      L.margin = L.unitPrice != null && L.unitCost != null ? L.unitPrice - L.unitCost : null;
    }
    return [...by.values()];
  }
  const m2 = (n) => n == null ? "—" : "$" + (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const pct = (a, b) => b ? Math.round(a / b * 100) + "%" : "";
  const priceTxt = (l) => l.pLo == null ? "—" : l.pLo === l.pHi ? m2(l.pLo) : `${m2(l.pLo)}–${m2(l.pHi)}`;

  function render() {
    const st = $("sz-status");
    if (S.err) { st.textContent = "Couldn't load shoes: " + msg(S.err); return; }
    if (!S.rows) { st.textContent = S.loading ? "Loading shoes…" : ""; return; }
    const q = S.q.trim().toLowerCase();
    const base = S.rows.filter(r => (S.type === "all" || r.type === S.type) && (S.who === "all" || r.who === S.who)
      && (!q || (r.title + " " + r.vt + " " + r.sku + " " + r.vendor).toLowerCase().includes(q)));
    const brands = [...new Set(S.rows.map(r => r.vendor))].sort();
    let L = lines(base.filter(r => S.brand === "all" || r.vendor === S.brand));
    if (S.stock === "instock") L = L.filter(l => l.qty > 0);
    else if (S.stock === "out") L = L.filter(l => l.qty <= 0 && l.sold > 0);
    st.textContent = `Shopify stock, all locations · sold = last 90 days${S.loading ? " · refreshing…" : ""}`;

    const pairs = L.reduce((a, l) => a + Math.max(0, l.qty), 0), cost = L.reduce((a, l) => a + l.cost, 0), retail = L.reduce((a, l) => a + l.retail, 0);
    const models = new Set(L.map(l => l.pid)).size;
    const brokenRuns = L.filter(l => l.qty > 0 && [...l.sizes.values()].some(c => c.qty <= 0 && c.sold > 0)).length;
    $("sz-kpis").innerHTML = [
      { l: "Pairs in stock", v: n0(pairs), s: `${n0(models)} models · ${n0(L.length)} colorways` },
      { l: "At cost", v: m0(cost), s: `${m0(retail)} at retail` },
      { l: "Sold, last 90 days", v: n0(L.reduce((a, l) => a + l.sold, 0)), s: `pairs · ${m0(L.reduce((a, l) => a + l.net, 0))} net sales` },
      (() => { const pf = L.reduce((a, l) => a + l.profit, 0), cn = L.reduce((a, l) => a + l.cnet, 0);
        return { l: "Profit, last 90 days", v: m0(pf), s: cn ? `${pct(pf, cn)} margin on sales with a cost` : "no costed sales", c: pf < 0 ? "warn" : "" }; })(),
      { l: "Profit in stock", v: m0(retail - cost), s: `at full price · ${pct(retail - cost, retail)} margin` },
      { l: "Sizes sold out", v: n0(brokenRuns), s: "colorways with a size that sold but is at 0", c: brokenRuns ? "warn" : "" },
    ].map(x => `<div class="kpi ${x.c || ""}"><span class="eyebrow">${x.l}</span><span class="v">${x.v}</span><span class="s">${esc(x.s)}</span></div>`).join("");

    const seg = (name, cur, opts) => `<span class="seg sm" role="group" aria-label="${name}">${opts.map(([k, n]) => `<button type="button" data-sh-${name}="${k}" aria-pressed="${cur === k}">${n}</button>`).join("")}</span>`;
    const brandPairs = (b) => lines(base.filter(r => r.vendor === b)).reduce((a, l) => a + Math.max(0, l.qty), 0);
    $("sz-filters").innerHTML = `
      ${seg("type", S.type, [["all", "All"], ["Tennis", "Tennis"], ["Pickleball", "Pickleball"], ["Padel", "Padel"]])}
      ${seg("who", S.who, [["all", "Everyone"], ["Men", "Men"], ["Women", "Women"], ["Junior", "Junior"]])}
      ${seg("stock", S.stock, [["instock", "In stock"], ["out", "Out, but selling"], ["all", "All"]])}
      <label class="small">Brand <select class="inp sm" id="sz-brand" style="width:auto"><option value="all">All brands</option>${brands.map(b => `<option value="${esc(b)}" ${S.brand === b ? "selected" : ""}>${esc(b)} (${n0(brandPairs(b))})</option>`).join("")}</select></label>
      <input class="inp" type="search" id="sz-q" value="${esc(S.q)}" placeholder="Model, color or SKU" style="max-width:220px">
      <label class="small sz-sold"><input type="checkbox" id="sz-sold" ${S.sold ? "checked" : ""}> Show sold (90 days)</label>`;

    const groups = new Map();
    for (const l of L) { if (!groups.has(l.vendor)) groups.set(l.vendor, []); groups.get(l.vendor).push(l); }
    const ORDER = { Men: 0, Women: 1, Junior: 2, "": 3 };
    $("sz-body").innerHTML = [...groups.entries()].map(([b, ls]) => {
      ls.sort((a, c) => (ORDER[a.who] - ORDER[c.who]) || a.title.localeCompare(c.title) || a.color.localeCompare(c.color) || a.width.localeCompare(c.width));
      const sizes = [...new Set(ls.flatMap(l => [...l.sizes.keys()]))].sort((a, c) => sizeNum(a) - sizeNum(c) || a.localeCompare(c));
      const tot = ls.reduce((a, l) => a + Math.max(0, l.qty), 0), open = !S.collapsed.has(b);
      const colTot = sizes.map(sz => ls.reduce((a, l) => a + Math.max(0, (l.sizes.get(sz) || {}).qty || 0), 0));
      let lastTitle = "";
      return `<section class="panel sz-brand">
        <button type="button" class="sz-bhead" data-sh-brandtoggle="${esc(b)}" aria-expanded="${open}"><b>${esc(b)}</b><span class="muted small">${n0(tot)} pairs · ${n0(new Set(ls.map(l => l.pid)).size)} models · ${n0(ls.length)} colorways · ${m0(ls.reduce((a, l) => a + l.cost, 0))} at cost · ${m0(ls.reduce((a, l) => a + l.profit, 0))} profit in 90 days</span><span class="right small">${open ? "▾" : "▸"}</span></button>
        ${open ? `<div class="tbl-wrap sz-wrap"><table class="sz-t"><thead><tr><th class="l sz-model">Model · color</th><th class="sz-m sz-m1">Price</th><th class="sz-m">Cost</th><th class="sz-m" title="Price − cost, per pair">Margin</th><th class="sz-m" title="Net sales − cost of goods, last 90 days">Profit 90d</th>${sizes.map(sz => `<th>${esc(sz)}</th>`).join("")}<th class="sz-tot">Total</th>${S.sold ? "" : '<th class="sz-tot">Sold 90d</th>'}</tr></thead><tbody>${
          ls.map(l => {
            const first = l.title !== lastTitle; lastTitle = l.title;
            return `<tr class="${first ? "sz-first" : ""}"><td class="l sz-model">${first ? `<a class="olink" href="${ADMIN}/products/${esc(l.pid)}" target="_blank" rel="noopener">${esc(l.title)}</a><br>` : ""}<span class="sz-color">${esc(l.color)}${l.width ? ` · <b>${esc(l.width)}</b>` : ""}</span></td>              <td class="sz-m sz-m1">${priceTxt(l)}</td>
              <td class="sz-m ${l.unitCost == null ? "neg" : ""}" ${l.unitCost == null ? 'title="No cost in Shopify for these sizes"' : ""}>${m2(l.unitCost)}</td>
              <td class="sz-m ${l.margin != null && l.margin < 0 ? "neg" : ""}">${l.margin == null ? "—" : `${m2(l.margin)}<span class="sz-s">${pct(l.margin, l.unitPrice)}</span>`}</td>
              <td class="sz-m ${l.profit < 0 ? "neg" : ""}" title="${m0(l.net)} net sales · ${n0(l.sold)} pairs">${l.sold ? m0(l.profit) : ""}</td>${
              sizes.map(sz => { const c = l.sizes.get(sz);
                if (!c) return '<td class="sz-na"></td>';
                const cls = c.qty < 0 ? "neg" : c.qty === 0 ? (c.sold > 0 ? "sz-out" : "sz-zero") : c.qty <= 1 && c.sold >= 2 ? "sz-low" : "";
                return `<td class="${cls}" title="${esc(sz)} · ${n0(c.qty)} in stock · ${n0(c.sold)} sold in 90 days · ${esc(c.sku || "")}">${c.qty === 0 ? "·" : n0(c.qty)}${S.sold && c.sold ? `<span class="sz-s">${n0(c.sold)}</span>` : ""}</td>`; }).join("")
            }<td class="sz-tot"><b>${n0(l.qty)}</b>${S.sold && l.sold ? `<span class="sz-s">${n0(l.sold)}</span>` : ""}</td>${S.sold ? "" : `<td class="sz-tot dim">${l.sold ? n0(l.sold) : ""}</td>`}</tr>`; }).join("")
          }</tbody><tfoot><tr><td class="l sz-model">All ${esc(b)}</td><td class="sz-m sz-m1"></td><td class="sz-m dim" title="Stock at cost">${m0(ls.reduce((a, l) => a + l.cost, 0))}</td><td class="sz-m dim" title="Stock at full price − cost">${m0(ls.reduce((a, l) => a + l.retail - l.cost, 0))}</td><td class="sz-m"><b>${m0(ls.reduce((a, l) => a + l.profit, 0))}</b></td>${colTot.map(n => `<td>${n ? n0(n) : ""}</td>`).join("")}<td class="sz-tot"><b>${n0(tot)}</b></td>${S.sold ? "" : `<td class="sz-tot dim">${n0(ls.reduce((a, l) => a + l.sold, 0))}</td>`}</tr></tfoot></table></div>` : ""}
      </section>`;
    }).join("") || `<div class="panel muted small" style="padding:14px">${S.stock === "instock" ? "No shoes in stock match." : "Nothing matches."}</div>`;
  }

  const tab = $("tab-shoes");
  tab.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    for (const k of ["type", "who", "stock"]) if (b.dataset["sh" + k[0].toUpperCase() + k.slice(1)] != null) { S[k] = b.dataset["sh" + k[0].toUpperCase() + k.slice(1)]; render(); return; }
    if (b.dataset.shBrandtoggle != null) { const k = b.dataset.shBrandtoggle; if (S.collapsed.has(k)) S.collapsed.delete(k); else S.collapsed.add(k); render(); }
  });
  tab.addEventListener("change", (e) => {
    if (e.target.id === "sz-brand") { S.brand = e.target.value; render(); }
    else if (e.target.id === "sz-sold") { S.sold = e.target.checked; render(); }
  });
  tab.addEventListener("input", (e) => {
    if (e.target.id !== "sz-q") return;
    S.q = e.target.value; const pos = e.target.selectionStart; render();
    const i = $("sz-q"); if (i) { i.focus(); i.setSelectionRange(pos, pos); }
  });
  $("sz-refresh").addEventListener("click", () => load(true));
  window.shoesShow = () => { if (!S.rows && !S.loading) load(false); else render(); };
  if ((location.hash || "") === "#shoes") setTimeout(() => window.shoesShow(), 0);
})();
