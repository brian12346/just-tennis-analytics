(() => {
  // Inventory › Active products (Brian, Oct 28: "let's add an Active Products page. Let's start that list with anything we
  // have in stock in Shopify or Amazon and also include anything that we've sold in the last 12 months. We can cull the
  // list from there"). One row per product (its sizes/colors fold out); stock in the store, prep center and Amazon,
  // units sold in the last 12 months by channel. Remove takes a product (or one size) off the list — Shopify isn't
  // touched — and Removed shows them with Put back. Data: jt.active_products() (migration 184).
  // Statuses (Oct 28: "Active, OOS, EOL, ??" … "we should touch every product and make an assessment so there should be a
  // not-mapped filter so we can work through the list"): each product gets an assessed status by hand — Active, EOL,
  // Seasonal or Hold (don't reorder) — saved per size/color (jt.active_status, migration 187); "Not assessed" lists what's
  // left, with a suggestion. Separately, a stock state worked out from stock and sales: New, In stock, Low stock (under 4
  // weeks at the 90-day pace), Out of stock, On order, Slow (nothing sold in 90 days), Dead stock (nothing in 12 months).
  // Amazon ASINs (Nov 4, migrations 210-211): a third view — each ASIN and each of its seller SKUs gets a status (Active /
  // Inactive – out of stock / Inactive – other / Closed) and FBA / FBM, kept in Seller Sage; see the block above refresh().
  const JT = window.JT, $ = (id) => document.getElementById(id);
  if (!JT || !$("tab-active")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n0 = (x) => Math.round(Number(x) || 0).toLocaleString("en-US");
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const TZ = "America/Los_Angeles";
  const sd = (d) => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: "UTC" }) : "";
  // new products are added by themselves (migration 185: new in Shopify, or put on a PO); "New" = added in the last 30 days
  const NEW_DAYS = 30, isNew = (o) => !!o.added && Date.now() - Date.parse(o.added) < NEW_DAYS * 864e5;
  const STATUS = { active: ["Active", "ok"], eol: ["EOL", "miss"], seasonal: ["Seasonal", "other"], hold: ["Hold", "pos"] };
  const FILTERS = [["all", "All"], ["new", "New"], ["todo", "Not assessed"], ["active", "Active"], ["eol", "EOL"], ["seasonal", "Seasonal"], ["hold", "Hold"], ["mixed", "Mixed"], ["removed", "Removed"]];
  const STOCKS = { new: ["New", "ok", "Added in the last 30 days, nothing sold yet"], instock: ["In stock", "", "Stock on hand and selling"],
    low: ["Low stock", "warn", "Under 4 weeks of stock at the 90-day pace"], oos: ["Out of stock", "miss", "Sold in the last 12 months, none on hand anywhere, nothing on order"],
    onorder: ["On order", "other", "None on hand; more is on an open PO"], slow: ["Slow", "warn", "Stock on hand, nothing sold in 90 days"],
    dead: ["Dead stock", "miss", "Stock on hand, nothing sold in 12 months"], none: ["No stock", "pos", "No stock and no sales"] };
  const SFILT = [["", "Any stock"], ["onhand", "On hand"], ["sold", "Sold in 12 months"], ...Object.entries(STOCKS).map(([k, v]) => [k, v[0]]), ["shopoff", "Not active in Shopify"], ["disc", "Discontinued"]];
  // the stock state of a size or a whole product
  const stockOf = (o, nw) => { const pace = o.s90 / 90;
    if (o.stock <= 0) return o.onOrder > 0 ? "onorder" : nw && !o.sold ? "new" : o.sold > 0 ? "oos" : "none";
    if (nw && !o.sold) return "new";
    if (!o.sold) return "dead"; if (!o.s90) return "slow";
    return pace > 0 && o.stock / (pace * 7) < 4 ? "low" : "instock"; };
  // what to set it to, when it isn't assessed yet
  const suggest = (o, isP) => o.disc ? "eol" : o.stk === "new" || o.stk === "onorder" ? "active" : o.stk === "dead" ? "eol" : (isP ? o.draft : o.status !== "ACTIVE") && o.stock <= 0 ? "eol" : "active";
  const SORTK = { added: (p) => -(p.added ? Date.parse(p.added) : 0), sold: (p) => -p.sold, stock: (p) => -p.stock, last: (p) => -(p.last ? Date.parse(p.last) : 0), name: (p) => p.title.toLowerCase(), vendor: (p) => (p.vendor + " " + p.title).toLowerCase() };
  const GROUPS = [["", "No grouping"], ["vendor", "Vendor"], ["type", "Category"]];
  // missing product info (Oct 29, Brian: "a filter for missing product attributes so we can fill them in" — products with
  // no SKU / UPC don't match on vendor invoices). Checked per size / color; a product shows when any of its sizes is missing it.
  const MISS = { sku: ["No SKU", v => !v.sku.trim()], upc: ["No UPC / barcode", v => !v.barcode.trim()], cost: ["No cost", v => !(v.cost > 0)],
    price: ["No price", v => !(v.price > 0)], type: ["No category", v => !v.type.trim()], vendor: ["No vendor", v => !v.vendor.trim()],
    dup: ["Duplicate SKU", v => !!v.sku.trim() && S.dups.has(v.sku.trim().toLowerCase())] };
  const SHORT = { sku: "SKU", upc: "UPC", cost: "cost", price: "price", type: "category", vendor: "vendor", dup: "duplicate SKU" };
  const missOf = (v) => Object.keys(MISS).filter(k => MISS[k][1](v));
  const MFILT = [["", "Any info"], ["any", "Missing anything"], ...Object.entries(MISS).map(([k, v]) => [k, v[0]])];
  // Used gear (Nov 2, Brian: "let's handle used products differently than new. we aren't going to have UPC/SKU info on
  // the used products. let's have an entirely different screen for used products"): Shopify product type or title
  // starting "Used" (Used Tennis Rackets, Used Pickleball Paddles, "Used - …"). Kept out of the new-product list, its
  // counts and its missing-info checks; the Used screen lists each piece on its own.
  const isUsed = (v) => /^\s*used\b/i.test(v.type || "") || /^\s*used\b/i.test(v.title || "");
  const S = { view: "new", used: [], uf: "stock", usort: "added", rows: null, prods: null, f: "all", sf: "", mf: "", dups: new Set(), q: "", vendor: "", type: "", sort: "sold", by: "", shut: new Set(), open: new Set(), sel: new Set(), limit: 150, busy: false, err: null, ask: null };

  async function load() {
    S.err = null;
    const r = await JT.rows(["a.variant_id::text", "a.product_id::text", "a.title", "a.sku", "a.vendor", "a.product_type", "a.status", "a.price", "a.unit_cost",
      "a.store", "a.prep", "a.fba", "a.awd", "a.shop365", "a.anr365", "a.amz365", "a.sold90", "a.last_sold::text", "a.discontinued", "a.culled", "a.culled_at::text", "a.culled_by", "a.cull_note", "a.added_at::text", "a.added_how", "a.on_order", "a.set_status", "a.status_note", "a.status_by", "a.status_at::text", "coalesce(v.barcode, '')"],
      "from jt.active_products() a left join jt.variants v on v.variant_id = a.variant_id", true);
    S.rows = r.map(x => ({ vid: x[0], pid: x[1], title: x[2] || "", sku: x[3] || "", vendor: x[4] || "", type: x[5] || "", status: x[6] || "", price: x[7] == null ? null : +x[7], cost: x[8] == null ? null : +x[8],
      store: +x[9] || 0, prep: +x[10] || 0, fba: +x[11] || 0, awd: +x[12] || 0, shop: +x[13] || 0, anr: +x[14] || 0, amz: +x[15] || 0, s90: +x[16] || 0, last: x[17] || "",
      disc: x[18] === true || x[18] === "true", culled: x[19] === true || x[19] === "true", cAt: x[20] || "", cBy: x[21] || "", cNote: x[22] || "", added: x[23] || "", how: x[24] || "", onOrder: +x[25] || 0, st: x[26] || "", stNote: x[27] || "", stBy: x[28] || "", stAt: x[29] || "", barcode: x[30] || "" }));
    group();
  }
  // a product's name without its size/color part ("Pure Aero 2026 - 4 1/8" (#1)" → "Pure Aero 2026")
  const base = (t) => String(t || "").split(" - ")[0].trim() || t;
  function group() {
    const by = new Map(), seen = new Map();
    for (const v of S.rows) { const k = v.sku.trim().toLowerCase(); if (k && !v.culled && !isUsed(v)) seen.set(k, (seen.get(k) || 0) + 1); }
    S.dups = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
    S.used = [];
    for (const v of S.rows) {
      v.stock = v.store + v.prep + v.fba + v.awd; v.sold = v.shop + v.anr + v.amz;
      if (isUsed(v)) { if (!v.culled) S.used.push(v); continue; }
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
      p.added = src.map(v => v.added).filter(Boolean).sort().pop() || ""; p.isNew = src.some(isNew);
      p.how = (src.find(v => isNew(v)) || {}).how || "";
      p.value = src.reduce((a, v) => a + v.stock * (v.cost || 0), 0);
      p.onOrder = sum("onOrder", src);
      for (const v of p.vs) { v.stk = stockOf(v, isNew(v)); v.sug = suggest(v, false); }
      p.stk = stockOf(p, p.isNew); p.sug = suggest(p, true);
      // the product's assessment: every live size the same → that; some set, some not or different → mixed; none → not assessed
      const sts = new Set(src.map(v => v.st || ""));
      p.st = sts.size === 1 ? [...sts][0] : "mixed"; p.todo = src.some(v => !v.st);
      p.stNote = (src.find(v => v.stNote) || {}).stNote || "";
    }
    S.prods = [...by.values()];
  }
  const fOk = (p, f) => f === "removed" ? p.vs.some(v => v.culled) : p.allCulled ? false
    : f === "all" ? true : f === "new" ? p.isNew : f === "todo" ? p.todo : f === "mixed" ? p.st === "mixed" : p.st === f;
  const mVs = (p, f) => p.vs.filter(v => !v.culled && (f === "any" ? missOf(v).length > 0 : MISS[f][1](v)));
  const mOk = (p, f) => !f || mVs(p, f).length > 0;
  const sOk = (p, f) => !f ? true : f === "onhand" ? p.stock > 0 : f === "sold" ? p.sold > 0 : f === "shopoff" ? p.draft : f === "disc" ? p.anyDisc : p.stk === f;
  function shown() {
    const q = S.q.trim().toLowerCase();
    const list = (S.prods || []).filter(p => fOk(p, S.f) && sOk(p, S.sf) && mOk(p, S.mf) && (!S.vendor || p.vendor === S.vendor) && (!S.type || p.type === S.type)
      && (!q || (p.title + " " + p.vendor + " " + p.type + " " + p.vs.map(v => v.sku + " " + v.title).join(" ")).toLowerCase().includes(q)));
    const k = SORTK[S.sort] || SORTK.sold;
    return list.sort((a, b) => { const x = k(a), y = k(b); return x < y ? -1 : x > y ? 1 : a.title.localeCompare(b.title); });
  }
  const stockCell = (o) => o.stock ? `<span title="Store ${n0(o.store)} · prep ${n0(o.prep)} · Amazon FBA ${n0(o.fba)} · AWD ${n0(o.awd)}">${n0(o.stock)}</span>` : '<span class="dim">0</span>';
  const where = (o) => [["Store", o.store], ["Prep", o.prep], ["FBA", o.fba], ["AWD", o.awd]].filter(x => x[1]).map(x => `${x[0]} ${n0(x[1])}`).join(" · ");
  const soldCell = (o) => o.sold ? `<span title="Just Tennis ${n0(o.shop)} · Ace n Rally ${n0(o.anr)} · Amazon ${n0(o.amz)} · last 90 days ${n0(o.s90)}">${n0(o.sold)}</span>` : '<span class="dim">0</span>';
  const chans = (o) => [["JT", o.shop], ["AnR", o.anr], ["Amz", o.amz]].filter(x => x[1]).map(x => `${x[0]} ${n0(x[1])}`).join(" · ");
  const tags = (o, isP) => [
    (isP ? o.isNew : isNew(o)) && o.stk !== "new" ? `<span class="pill ok" title="Added ${esc((o.added || "").slice(0, 10))}${o.how ? " · " + esc(o.how) : ""}">new</span>` : "",
    (isP ? o.anyDisc : o.disc) ? '<span class="pill miss" title="Marked discontinued (Inventory › Discontinued)">discontinued</span>' : "",
    (isP ? o.draft : o.status !== "ACTIVE") ? `<span class="pill pos" title="Shopify status">${esc(isP ? "not active in Shopify" : (o.status || "").toLowerCase())}</span>` : ""].join(" ");
  const missPill = (v) => { const m = missOf(v); return m.length ? `<span class="pill miss" title="Missing in Shopify — open it to fill in">no ${m.filter(k => k !== "dup").map(k => SHORT[k]).join(" · ")}${m.includes("dup") ? (m.length > 1 ? " · " : "") + "duplicate SKU" : ""}</span>`.replace("no duplicate", "duplicate") : ""; };
  const codes = (v) => `<span class="mono">${esc(v.sku) || "no SKU"}</span>${v.barcode ? ` · <span class="mono">${esc(v.barcode)}</span>` : ""}`;
  const stockPill = (o) => { const x = STOCKS[o.stk]; return x ? `<span class="pill ${x[1]}" title="${esc(x[2])}${o.onOrder ? ` · ${n0(o.onOrder)} on order` : ""}">${x[0]}</span>` : ""; };
  // the assessment cell: the status, or (not assessed) the suggestion with one-click buttons
  const stCell = (o, key, isP) => {
    const st = o.st;
    if (st && st !== "mixed") return `<span class="pill ${STATUS[st][1]} ap-st" title="${esc(o.stNote || "")}">${STATUS[st][0]}</span> <button class="linkbtn small" data-ap-quick="${key}:" title="Back to not assessed">×</button>`;
    return `${st === "mixed" ? '<span class="pill pos" title="Its sizes / colors have different statuses (or some aren\'t set)">Mixed</span> ' : '<span class="ap-todo">Not assessed</span> '}<span class="ap-quick">${["active", "eol", "seasonal", "hold"].map(k => `<button class="mini ${k === o.sug ? "sug" : ""}" data-ap-quick="${key}:${k}" title="${k === o.sug ? "Suggested · " : ""}Set ${isP ? "every size / color" : "this one"} to ${STATUS[k][0]}">${STATUS[k][0]}</button>`).join("")}</span>`;
  };

  function render() {
    if ($("tab-active").hidden) return;
    if (S.view === "asins") {
      for (const b of document.querySelectorAll("#ap-view [data-ap-view]")) b.setAttribute("aria-pressed", String(b.dataset.apView === "asins"));
      for (const id of ["ap-seg", "ap-stock", "ap-miss", "ap-by", "ap-dl"]) { const el = $(id); if (el) el.hidden = true; }
      $("ap-bulk").hidden = false;
      return renderAsins();
    }
    const st = $("ap-status");
    if (S.err) { st.innerHTML = `<span class="neg">Couldn't load the list: ${esc(JT.message(S.err))}</span>`; return; }
    if (!S.prods) { st.textContent = "Loading products, stock and 12 months of sales… (a few seconds)"; $("ap-table").innerHTML = ""; return; }
    for (const b of document.querySelectorAll("#ap-view [data-ap-view]")) { b.setAttribute("aria-pressed", String(b.dataset.apView === S.view)); if (b.dataset.apView === "used") b.innerHTML = `Used <span class="cnt">${n0(S.used.filter(v => v.stock > 0).length)}</span>`; }
    for (const id of ["ap-seg", "ap-stock", "ap-miss", "ap-by", "ap-bulk", "ap-dl"]) { const el = $(id); if (el) el.hidden = S.view === "used"; }
    if (S.view === "used") return renderUsed();
    const live = S.prods.filter(p => !p.allCulled), lv = S.rows.filter(v => !v.culled && !isUsed(v));
    // every card shows its products below (Nov 2, Brian: "let's make all of the items in the screenshot clickable");
    // the picked one is outlined, clicking it again shows all
    const KGO = [["todo", ""], ["active", ""], ["all", "onhand"], ["all", "sold"], ["all", "oos"], ["all", "dead"], ["removed", ""]];
    $("ap-kpis").innerHTML = [
      ["Assessed", `${n0(live.filter(p => !p.todo).length)} <small>of ${n0(live.length)}</small>`, `${n0(live.filter(p => p.todo).length)} product${live.filter(p => p.todo).length === 1 ? "" : "s"} still to assess`],
      ["Active", n0(live.filter(p => p.st === "active").length), `EOL ${n0(live.filter(p => p.st === "eol").length)} · seasonal ${n0(live.filter(p => p.st === "seasonal").length)} · hold ${n0(live.filter(p => p.st === "hold").length)}`],
      ["In stock", n0(live.filter(p => p.stock > 0).length), `${n0(lv.reduce((a, v) => a + v.stock, 0))} units · store, prep, Amazon`],
      ["Sold in 12 months", n0(live.filter(p => p.sold > 0).length), `${n0(lv.reduce((a, v) => a + v.sold, 0))} units, all channels`],
      ["Out of stock", n0(live.filter(p => p.stk === "oos").length), `${n0(live.filter(p => p.stk === "low").length)} low · ${n0(live.filter(p => p.stk === "onorder").length)} on order`],
      ["Dead stock", n0(live.filter(p => p.stk === "dead").length), "on hand, nothing sold in 12 months"],
      ["Removed", n0(S.prods.filter(p => p.vs.some(v => v.culled)).length), "taken off the list"],
    ].map(([l, v, s], i) => { const [f, sf] = KGO[i], on = S.f === f && S.sf === sf;
      return `<div class="kpi ${on ? "on" : ""}"><button class="kpi-go" type="button" data-ap-kpi="${i}" aria-pressed="${on}" title="${on ? "Show all products" : "Show these below"}"><span class="eyebrow">${l}</span><span class="v">${v}</span><span class="s">${s}</span></button></div>`; }).join("");
    $("ap-kpis").dataset.go = JSON.stringify(KGO);
    $("ap-miss").innerHTML = MFILT.map(([k, n]) => `<option value="${k}" ${S.mf === k ? "selected" : ""}>${n}${k ? ` (${n0(S.prods.filter(p => !p.allCulled && fOk(p, S.f) && mOk(p, k)).length)})` : ""}</option>`).join("");
    $("ap-dl").hidden = !S.mf;
    $("ap-stock").innerHTML = SFILT.map(([k, n]) => `<option value="${k}" ${S.sf === k ? "selected" : ""}>${n}${k ? ` (${n0(S.prods.filter(p => !p.allCulled && fOk(p, S.f) && sOk(p, k)).length)})` : ""}</option>`).join("");
    $("ap-seg").innerHTML = FILTERS.map(([k, n]) => `<button data-ap-f="${k}" aria-pressed="${S.f === k}">${n} <span class="cnt">${n0(S.prods.filter(p => fOk(p, k)).length)}</span></button>`).join("");
    const opts = (k, cur, all) => `<option value="">${all}</option>` + [...new Set(S.prods.map(p => p[k]).filter(Boolean))].sort().map(v => `<option ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
    $("ap-vendor").innerHTML = opts("vendor", S.vendor, "All vendors"); $("ap-type").innerHTML = opts("type", S.type, "All categories");
    $("ap-by").innerHTML = GROUPS.map(([k, n]) => `<option value="${k}" ${S.by === k ? "selected" : ""}>${k ? "Group by " + n.toLowerCase() : n}</option>`).join("");
    let list = shown();
    const gk = (p) => (S.by ? p[S.by] : "") || (S.by === "type" ? "(no category)" : "(no vendor)");
    const gstat = new Map();
    if (S.by) {
      for (const p of list) { const k = gk(p); let g = gstat.get(k); if (!g) gstat.set(k, g = { n: 0, stock: 0, sold: 0, value: 0 }); g.n++; g.stock += p.stock; g.sold += p.sold; g.value += p.value; }
      const ord = [...gstat.keys()].sort((a, b) => gstat.get(b).sold - gstat.get(a).sold || a.localeCompare(b));
      const rank = new Map(ord.map((k, i) => [k, i]));
      list = list.map((p, i) => [p, i]).sort((a, b) => rank.get(gk(a[0])) - rank.get(gk(b[0])) || a[1] - b[1]).map(x => x[0]);

    }
    const openList = S.by ? list.filter(p => !S.shut.has(gk(p))) : list, page = openList.slice(0, S.limit), rem = S.f === "removed";
    const pageSet = new Set(page);
    // with grouping: every group's header in order (a closed group shows just its header), products up to the page limit
    const items = S.by ? (() => { const out = [], seen = new Set(); for (const p of list) { const k = gk(p); if (!seen.has(k)) { seen.add(k); out.push({ k }); } if (pageSet.has(p)) out.push(p); } return out; })() : page;

    const ghead = (k) => { const g = gstat.get(k), shut = S.shut.has(k);
      return `<tr class="ap-g ${shut ? "shut" : ""}" data-ap-g="${esc(k)}"><td colspan="11" class="l"><span class="rl-car" aria-hidden="true">${shut ? "▸" : "▾"}</span> <b>${esc(k)}</b> <span class="muted small">· ${n0(g.n)} product${g.n === 1 ? "" : "s"} · ${n0(g.stock)} on hand · ${n0(g.sold)} sold in 12 mo</span></td></tr>`; };

    const nAll = S.by ? [...gstat.values()].reduce((a, g) => a + g.n, 0) : list.length;
    st.textContent = `${n0(nAll)} product${nAll === 1 ? "" : "s"}${S.by ? ` in ${n0(gstat.size)} ${S.by === "type" ? "categories" : "vendors"}` : ""}${openList.length > page.length ? ` · showing ${n0(page.length)}` : ""}`;
    const nSel = S.sel.size;
    $("ap-bulk").innerHTML = nSel ? `<b>${n0(nSel)}</b> selected · ${rem ? `<button class="btn sm primary" data-ap-act="restore">Put back on the list</button>` : `Set status: ${["active", "eol", "seasonal", "hold"].map(k => `<button class="btn sm" data-ap-set="${k}" ${S.busy ? "disabled" : ""}>${STATUS[k][0]}</button>`).join("")} <button class="btn sm" data-ap-set="@sug" ${S.busy ? "disabled" : ""} title="Each one gets its own suggestion">Use suggestions</button> <button class="linkbtn small" data-ap-set="" title="Back to not assessed">clear</button> <span class="ap-sep">·</span> <input id="ap-note" class="inp sm" placeholder="Note / why (optional)" style="width:180px"> <button class="btn sm" data-ap-act="cull" ${S.busy ? "disabled" : ""}>Remove from the list</button>`} <button class="linkbtn small" data-ap-act="clear">Clear</button>` : `<span class="muted small">${rem ? "Tick products to put them back." : "Set a status with the buttons on each row, or tick several to set them together (or take them off the list). Shopify isn't changed."}</span>`;
    const th = (k, l, left) => `<th class="${left ? "l" : ""} sortable" data-ap-sort="${k}" aria-sort="${S.sort === k ? "descending" : "none"}">${l}${S.sort === k ? " ↓" : ""}</th>`;
    const allOn = page.length && page.every(p => p.vs.filter(v => rem ? v.culled : !v.culled).every(v => S.sel.has(v.vid)));
    $("ap-table").innerHTML = `<thead><tr><th><input type="checkbox" data-ap-all ${allOn ? "checked" : ""} aria-label="Select all shown"></th><th></th>${th("name", "Product", 1)}<th class="l">Status</th>${th("vendor", "Vendor · category", 1)}${th("stock", "On hand")}<th class="l">Where</th>${th("sold", "Sold 12 mo")}<th class="l">Channels</th>${th("last", "Last sold", 1)}<th class="l"></th></tr></thead><tbody>${
      items.map(p => {
        if (p.k !== undefined && !p.pid) return ghead(p.k);

        const vs = p.vs.filter(v => rem ? v.culled : !v.culled), o = S.open.has(p.pid), on = vs.length && vs.every(v => S.sel.has(v.vid)), some = !on && vs.some(v => S.sel.has(v.vid));
        const one = p.vs.length === 1 ? p.vs[0] : null;
        return `<tr class="po-row ap-p ${o ? "on" : ""}" data-ap-open="${esc(p.pid)}">
          <td><input type="checkbox" data-ap-selp="${esc(p.pid)}" ${on ? "checked" : ""} ${some ? 'data-some="1"' : ""} aria-label="Select ${esc(p.title)}"></td>
          <td class="rl-car" aria-hidden="true">${p.vs.length > 1 ? (o ? "▾" : "▸") : ""}</td>
          <td class="l"><a class="olink" href="${ADMIN}/products/${esc(p.pid)}" target="_blank" rel="noopener">${esc(one ? one.title : p.title)}</a>
            <div class="meta">${one ? `${codes(one)} ${missPill(one)}${S.f === "new" && one.added ? ` <span class="pill ok" title="${esc(one.how || "")}">added ${esc(sd(one.added.slice(0, 10)))}</span>` : ""}` : `${n0(vs.length)} size${vs.length === 1 ? "" : "s"} / color${vs.length === 1 ? "" : "s"}${p.someCulled && !rem ? ` · ${n0(p.vs.length - vs.length)} removed` : ""}${S.f === "new" && p.added ? ` · <span class="pill ok" title="${esc(p.how || "")}">added ${esc(sd(p.added.slice(0, 10)))}</span>` : ""}${(() => { const n = mVs(p, S.mf || "any").length; return n ? ` <span class="pill miss" title="Sizes / colors missing ${S.mf && S.mf !== "any" ? esc(MISS[S.mf][0].toLowerCase()) : "info"} in Shopify">${n0(n)} missing ${S.mf && S.mf !== "any" ? esc(SHORT[S.mf]) : "info"}</span>` : ""; })()}`} ${stockPill(p)} ${tags(p, true)}</div></td>
          <td class="l ap-stc">${rem ? "" : stCell(p, "p" + p.pid, true)}</td>
          <td class="l small">${esc(p.vendor || "—")}<div class="meta">${esc(p.type || "")}</div></td>
          <td class="num">${stockCell(p)}</td><td class="l small muted">${where(p)}</td>
          <td class="num">${soldCell(p)}</td><td class="l small muted">${chans(p)}</td>
          <td class="l small">${p.last ? esc(sd(p.last)) : '<span class="dim">—</span>'}</td>
          <td class="l small">${rem ? vs.map(v => v.cNote).filter(Boolean).slice(0, 1).map(esc).join("") || '<span class="dim">removed</span>' : ""}</td></tr>
          ${(o || S.mf) && p.vs.length > 1 ? (S.mf && !o ? vs.filter(v => S.mf === "any" ? missOf(v).length : MISS[S.mf][1](v)) : vs).map(v => `<tr class="ap-v"><td><input type="checkbox" data-ap-selv="${esc(v.vid)}" ${S.sel.has(v.vid) ? "checked" : ""} aria-label="Select ${esc(v.title)}"></td><td></td>
            <td class="l"><a class="olink" href="${ADMIN}/products/${esc(v.pid)}/variants/${esc(v.vid)}" target="_blank" rel="noopener">${esc(v.title)}</a><div class="meta">${codes(v)} ${missPill(v)} ${stockPill(v)} ${tags(v, false)}</div></td>
            <td class="l ap-stc">${v.culled ? "" : stCell(v, "v" + v.vid, false)}</td><td></td><td class="num">${stockCell(v)}</td><td class="l small muted">${where(v)}</td><td class="num">${soldCell(v)}</td><td class="l small muted">${chans(v)}</td>
            <td class="l small">${v.last ? esc(sd(v.last)) : '<span class="dim">—</span>'}</td><td class="l small">${v.culled ? `<span class="dim" title="${esc(v.cBy)} · ${esc(v.cAt.slice(0, 10))}">${esc(v.cNote || "removed")}</span>` : ""}</td></tr>`).join("") : ""}`;
      }).join("") || `<tr><td colspan="11" class="l muted">${S.prods.length ? "Nothing matches." : "No products."}</td></tr>`}</tbody>`;
    for (const c of $("ap-table").querySelectorAll('input[data-some="1"]')) c.indeterminate = true;
    $("ap-more").hidden = openList.length <= page.length;
  }

  // the Used screen: one row per piece — price, cost, where it is, when it came in, whether it sold
  const UFILT = [["stock", "In stock"], ["sold", "Sold"], ["all", "All"]];
  const USORT = { added: (v) => -(v.added ? Date.parse(v.added) : 0), name: (v) => v.title.toLowerCase(), price: (v) => -(v.price || 0), cost: (v) => -(v.cost || 0),
    stock: (v) => -v.stock, sold: (v) => -v.sold, last: (v) => -(v.last ? Date.parse(v.last) : 0), vendor: (v) => (v.vendor + " " + v.title).toLowerCase() };
  const daysIn = (v) => v.added ? Math.floor((Date.now() - Date.parse(v.added)) / 864e5) : null;
  function renderUsed() {
    const q = S.q.trim().toLowerCase(), all = S.used;
    const inStock = all.filter(v => v.stock > 0), soldOut = all.filter(v => v.stock <= 0 && v.sold > 0);
    const val = (vs, k) => vs.reduce((a, v) => a + v.stock * (v[k] || 0), 0), m0 = (x) => "$" + n0(x);
    const aged = inStock.filter(v => (daysIn(v) ?? 0) > 90), new30 = all.filter(isNew);
    $("ap-kpis").innerHTML = [
      ["In stock", n0(inStock.length), `${m0(val(inStock, "price"))} at price · ${m0(val(inStock, "cost"))} cost`, "stock"],
      ["Sold in 12 months", n0(all.reduce((a, v) => a + v.sold, 0)), `${n0(soldOut.length)} piece${soldOut.length === 1 ? "" : "s"} sold out`, "sold"],
      ["Added in 30 days", n0(new30.length), "new used pieces", "new"],
      ["Over 90 days", n0(aged.length), aged.length ? `${m0(val(aged, "price"))} at price — think about a markdown` : "nothing sitting long", "aged"],
    ].map(([l, v, sub, k]) => `<div class="kpi ${S.uf === k ? "on" : ""}"><button class="kpi-go" type="button" data-ap-uf="${k}" aria-pressed="${S.uf === k}"><span class="eyebrow">${l}</span><span class="v">${v}</span><span class="s">${sub}</span></button></div>`).join("");
    const opts = (k, cur, lab) => `<option value="">${lab}</option>` + [...new Set(all.map(v => v[k]).filter(Boolean))].sort().map(x => `<option ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("");
    $("ap-vendor").innerHTML = opts("vendor", S.vendor, "All brands"); $("ap-type").innerHTML = opts("type", S.type, "All used types");
    const fOkU = (v) => S.uf === "stock" ? v.stock > 0 : S.uf === "sold" ? v.sold > 0 : S.uf === "new" ? isNew(v) : S.uf === "aged" ? v.stock > 0 && (daysIn(v) ?? 0) > 90 : true;
    const k = USORT[S.usort] || USORT.added;
    const list = all.filter(v => fOkU(v) && (!S.vendor || v.vendor === S.vendor) && (!S.type || v.type === S.type) && (!q || (v.title + " " + v.vendor + " " + v.type + " " + v.sku).toLowerCase().includes(q)))
      .sort((a, b) => { const x = k(a), y = k(b); return x < y ? -1 : x > y ? 1 : a.title.localeCompare(b.title); });
    $("ap-status").textContent = `${n0(list.length)} used piece${list.length === 1 ? "" : "s"}`;
    const th = (key, l, left) => `<th class="${left ? "l" : ""} sortable" data-ap-usort="${key}" aria-sort="${S.usort === key ? "descending" : "none"}">${l}${S.usort === key ? " ↓" : ""}</th>`;
    const seg = `<tr class="ap-useg"><td colspan="9" class="l"><span class="seg sm">${UFILT.map(([k2, n]) => `<button type="button" data-ap-uf="${k2}" aria-pressed="${S.uf === k2}">${n}</button>`).join("")}</span></td></tr>`;
    $("ap-table").innerHTML = `<thead>${seg}<tr>${th("name", "Used piece", 1)}${th("vendor", "Brand · type", 1)}${th("price", "Price")}${th("cost", "Cost")}${th("stock", "On hand")}<th class="l">Where</th>${th("added", "Came in", 1)}${th("sold", "Sold 12 mo")}${th("last", "Last sold", 1)}</tr></thead><tbody>${
      list.slice(0, S.limit).map(v => { const d = daysIn(v);
        return `<tr><td class="l"><a class="olink" href="${ADMIN}/products/${esc(v.pid)}/variants/${esc(v.vid)}" target="_blank" rel="noopener">${esc(v.title)}</a>${v.status !== "ACTIVE" ? ` <span class="pill pos">${esc((v.status || "").toLowerCase())}</span>` : ""}</td>
          <td class="l small">${esc(v.vendor || "—")}<div class="meta">${esc(v.type || "")}</div></td>
          <td class="num">${v.price ? "$" + v.price.toFixed(2) : '<span class="dim">—</span>'}</td><td class="num">${v.cost ? "$" + v.cost.toFixed(2) : '<span class="pill miss">no cost</span>'}</td>
          <td class="num">${stockCell(v)}</td><td class="l small muted">${where(v)}</td>
          <td class="l small">${v.added ? esc(sd(v.added.slice(0, 10))) + (d != null ? `<div class="meta ${v.stock > 0 && d > 90 ? "neg" : ""}">${d} day${d === 1 ? "" : "s"}${v.stock > 0 ? " on hand" : ""}</div>` : "") : '<span class="dim">—</span>'}</td>
          <td class="num">${soldCell(v)}</td><td class="l small">${v.last ? esc(sd(v.last)) : '<span class="dim">—</span>'}</td></tr>`; }).join("") || `<tr><td colspan="9" class="l muted">${all.length ? "Nothing matches." : "No used products (Shopify product type or title starting “Used”)."}</td></tr>`}</tbody>`;
    $("ap-more").hidden = list.length <= S.limit;
  }

  // ---------- Amazon ASINs (Nov 4, Brian: "we need a good way to curate our master data on amazon … the following states
  // for the asins - active, inactive - out of stock, inactive - other reasons, closed/deleted. and we also want to have a
  // clear toggle for FBA and FBM" … "we really need to show the SKU info within the ASIN info as we will want to control
  // things at the SKU level in our cleanup. i originally said asin, but we need SKU as well"). One block per ASIN with its
  // seller SKUs under it. The ASIN gets a status and FBA / FBM switches (jt.asin_master, migration 210); each SKU its own
  // status and fulfillment, FBA or FBM (jt.amazon_sku_master, migration 211). Seller Sage only — nothing is sent to Amazon.
  // Until set, Amazon's data suggests each one; a set status Amazon's data disagrees with is flagged.
  // Data: jt.amazon_asins(), jt.amazon_skus(); writes: public.jt_asin_master(p), public.jt_amazon_sku_master(p).
  const AZ = { active: ["Active", "ok", "Selling on Amazon"], inactive_oos: ["Inactive – out of stock", "warn", "Listing inactive because there's no stock"],
    inactive_other: ["Inactive – other", "miss", "Listing inactive for another reason (suppressed, missing info, pricing…) — needs a look"],
    closed: ["Closed / deleted", "pos", "Listing closed or deleted on Amazon"] };
  const AZK = Object.keys(AZ);
  const AZF = [["all", "All"], ["todo", "Not set"], ...AZK.map(k => [k, AZ[k][0]]), ["differs", "Amazon differs"], ["both", "ASIN on FBA + FBM"]];
  const AZCH = [["", "Any fulfillment"], ["FBA", "FBA SKUs"], ["FBM", "FBM SKUs"]];
  const AZSORT = { sold: (g) => -g.s365, stock: (g) => -g.stock, name: (g) => g.title.toLowerCase(), vendor: (g) => (g.vendor + " " + g.title).toLowerCase() };
  Object.assign(S, { az: null, azErr: null, azf: "all", azch: "", azsort: "sold", azsel: new Set(), azsku: new Set() });
  const b01 = (x) => x === true || x === "true" || x === "t";
  const nul = (x) => x == null || x === "" ? null : x;
  const azSt = (o) => o.status || o.sug;                                    // what it is: set, else suggested
  const azDiff = (o) => !!o.status && o.status !== o.sug;
  const azFba = (a) => a.fba != null ? a.fba : a.sfba, azFbm = (a) => a.fbm != null ? a.fbm : a.sfbm;
  const skuFul = (s) => s.ful || s.sful;
  async function loadAsins() {
    S.azErr = null;
    const [ra, rs] = await Promise.all([
      JT.rows(["asin", "title", "in_listings", "fba_available", "fba_inbound", "awd", "prep", "sold90", "sold365", "last_sold::text", "variant_id::text", "product_id::text",
        "vendor", "shopify_title", "suggest", "suggest_fba", "suggest_fbm", "status", "fba", "fbm", "note", "set_by", "set_at::text", "listings_file"], "from jt.amazon_asins()", true),
      JT.rows(["sku", "asin", "title", "ch", "amz_status", "price", "qty", "opened", "in_listings", "fba_available", "fba_inbound", "awd", "prep", "sold30", "sold90", "sold365", "last_sold::text",
        "suggest", "suggest_ful", "status", "ful", "note", "set_by", "set_at::text"], "from jt.amazon_skus()", true)]);
    const by = new Map();
    for (const x of ra) {
      const a = { asin: x[0], title: x[1] || "", listed: b01(x[2]), avail: +x[3] || 0, inbound: +x[4] || 0, awd: +x[5] || 0, prep: +x[6] || 0, s90: +x[7] || 0, s365: +x[8] || 0, last: x[9] || "",
        vid: x[10] || "", pid: x[11] || "", vendor: x[12] || "", stitle: x[13] || "", sug: x[14] || "", sfba: b01(x[15]), sfbm: b01(x[16]), status: x[17] || "",
        fba: nul(x[18]) == null ? null : b01(x[18]), fbm: nul(x[19]) == null ? null : b01(x[19]), note: x[20] || "", by: x[21] || "", at: x[22] || "", file: x[23] || "", skus: [], real: true };
      a.stock = a.avail + a.inbound + a.awd + a.prep; by.set(a.asin, a);
    }
    for (const x of rs) {
      const s = { sku: x[0], asin: x[1] || "", title: x[2] || "", ch: x[3] || "", amz: x[4] || "", price: nul(x[5]) == null ? null : +x[5], qty: nul(x[6]) == null ? null : +x[6], opened: x[7] || "",
        listed: b01(x[8]), avail: +x[9] || 0, inbound: +x[10] || 0, awd: +x[11] || 0, prep: +x[12] || 0, s30: +x[13] || 0, s90: +x[14] || 0, s365: +x[15] || 0, last: x[16] || "",
        sug: x[17] || "", sful: x[18] || "", status: x[19] || "", ful: x[20] || "", note: x[21] || "", by: x[22] || "", at: x[23] || "" };
      s.stock = s.avail + s.inbound + s.awd + s.prep;
      let a = by.get(s.asin);
      if (!a) by.set(s.asin, a = { asin: s.asin, title: s.asin ? s.title : "SKUs with no ASIN", listed: false, avail: 0, inbound: 0, awd: 0, prep: 0, stock: 0, s90: 0, s365: 0, last: "",
        vendor: "", stitle: "", sug: "closed", status: "", skus: [], real: !!s.asin });
      a.skus.push(s);
      if (!a.real) { a.stock += s.stock; a.s365 += s.s365; a.s90 += s.s90; }
    }
    for (const a of by.values()) a.skus.sort((p, q) => (q.amz === "Active") - (p.amz === "Active") || p.ch.localeCompare(q.ch) || q.s365 - p.s365 || p.sku.localeCompare(q.sku));
    S.az = [...by.values()];
  }
  const allSkus = () => (S.az || []).flatMap(a => a.skus);
  const skuChOk = (s) => !S.azch || skuFul(s) === S.azch;
  // a status filter picks SKUs; an ASIN shows when it (or one of its SKUs) matches, with its matching SKUs
  const skuFOk = (s, f) => f === "all" || f === "both" ? true : f === "todo" ? !s.status : f === "differs" ? azDiff(s) : azSt(s) === f;
  const asinFOk = (a, f) => f === "both" ? a.real && azFba(a) && azFbm(a) : f === "all" ? true : !a.real ? false : f === "todo" ? !a.status : f === "differs" ? azDiff(a) : azSt(a) === f;
  function azShown() {
    const q = S.q.trim().toLowerCase(), k = AZSORT[S.azsort] || AZSORT.sold, out = [];
    for (const a of S.az || []) {
      if (S.vendor && a.vendor !== S.vendor) continue;
      const hit = !q || (a.asin + " " + a.title + " " + a.vendor + " " + a.stitle).toLowerCase().includes(q);
      const skus = a.skus.filter(s => skuChOk(s) && (S.azf === "both" || skuFOk(s, S.azf)) && (hit || s.sku.toLowerCase().includes(q)));
      const self = asinFOk(a, S.azf) && hit && !S.azch;
      if (S.azf === "both" ? self : (skus.length || self)) out.push({ a, skus: S.azf === "both" ? a.skus.filter(skuChOk) : skus });
    }
    return out.sort((x, y) => { const p = k(x.a), r = k(y.a); return p < r ? -1 : p > r ? 1 : x.a.title.localeCompare(y.a.title); });
  }
  const shortSt = (k) => AZ[k] ? AZ[k][0].replace("Inactive – out of stock", "Inactive – OOS").replace("Closed / deleted", "Closed") : k;
  // the status: a select — "Suggested: X" until set (dashed), the status once set (colored); "Amazon: X" when they differ
  const stSel = (o, key) => `<select class="az-sel ${o.status ? "s-" + AZ[o.status][1] : "auto"}" data-az-ss="${key}" title="${o.status ? esc([AZ[o.status][2], o.note, o.by && "set by " + o.by, o.at && o.at.slice(0, 10)].filter(Boolean).join(" · ")) : "Not set — Amazon's data suggests " + esc(AZ[o.sug] ? AZ[o.sug][0] : o.sug)}">
      <option value="" ${o.status ? "" : "selected"}>${o.status ? "↺ Suggested: " : "Suggested: "}${esc(shortSt(o.sug))}</option>${AZK.map(k => `<option value="${k}" ${o.status === k ? "selected" : ""}>${esc(AZ[k][0])}</option>`).join("")}</select>${azDiff(o) ? `<div class="az-diff" title="Worked out from Amazon's listings and stock today">Amazon: ${esc(shortSt(o.sug))}</div>` : ""}`;
  // ASIN: FBA / FBM switches (dashed = suggested, not set); SKU: one FBA | FBM switch
  const asinTogs = (a) => ["fba", "fbm"].map(ch => { const set = a[ch] != null, on = ch === "fba" ? azFba(a) : azFbm(a);
    return `<button type="button" class="az-tog ${on ? "on" : ""} ${set ? "" : "auto"}" data-az-ch="${esc(a.asin)}:${ch}" aria-pressed="${on}" title="Sell this ASIN ${ch.toUpperCase()}: ${on ? "yes" : "no"}${set ? "" : " (suggested — click to set)"}">${ch.toUpperCase()}</button>`; }).join("")
    + (a.fba != null || a.fbm != null ? `<button class="linkbtn small" data-az-chclr="${esc(a.asin)}" title="Back to the suggestion">↺</button>` : "");
  const skuSwitch = (s) => { const f = skuFul(s);
    return `<span class="az-sw ${s.ful ? "" : "auto"}" role="group" aria-label="Fulfillment">${["FBA", "FBM"].map(ch => `<button type="button" data-az-ful="${esc(s.sku)}:${ch}" aria-pressed="${f === ch}" title="${ch}${s.ful ? "" : f === ch ? " (lists this way on Amazon now — click to set)" : ""}">${ch}</button>`).join("")}</span>${s.ful && s.ful !== s.sful ? `<div class="az-diff">Amazon: ${esc(s.sful)}</div>` : ""}`; };
  const azStockOf = (o) => o.stock ? `<span title="FBA ${n0(o.avail)} · inbound ${n0(o.inbound)} · AWD ${n0(o.awd)} · prep center ${n0(o.prep)}">${n0(o.stock)}</span>` : '<span class="dim">0</span>';
  const azSoldOf = (o) => `${o.s365 ? n0(o.s365) : '<span class="dim">0</span>'}${o.s90 ? `<div class="meta">${n0(o.s90)} in 90 d</div>` : ""}`;
  const amzSku = (s) => !s.listed ? '<span class="pill pos" title="Not in Amazon\'s listings report">not listed</span>'
    : `<span class="pill ${s.amz === "Active" ? "ok" : "pos"}">${esc(s.amz || "—")}</span> <span class="small muted">${s.price != null ? "$" + s.price.toFixed(2) : ""}${s.ch === "FBM" && s.qty != null ? ` · qty ${n0(s.qty)}` : ""}</span>`;
  function renderAsins() {
    const st = $("ap-status");
    if (!S.az && !S.azErr && !S.azLoading) { S.azLoading = true; loadAsins().catch(e => { S.azErr = e; }).finally(() => { S.azLoading = false; render(); }); }
    if (S.azErr) { st.innerHTML = `<span class="neg">Couldn't load the ASINs: ${esc(JT.message(S.azErr))}</span>`; $("ap-table").innerHTML = ""; return; }
    if (!S.az) { st.textContent = "Loading Amazon listings, stock and sales…"; $("ap-table").innerHTML = ""; $("ap-kpis").innerHTML = ""; $("ap-bulk").innerHTML = ""; return; }
    const skus = allSkus(), asins = S.az.filter(a => a.real);
    const nS = (f) => skus.filter(s => skuFOk(s, f)).length, setS = skus.filter(s => s.status).length;
    const bothN = asins.filter(a => azFba(a) && azFbm(a)).length;
    const K = [["todo", "SKUs set", `${n0(setS)} <small>of ${n0(skus.length)}</small>`, `${n0(asins.filter(a => a.status).length)} of ${n0(asins.length)} ASINs set`],
      ...AZK.map(k => [k, AZ[k][0], n0(nS(k)), `SKUs · ${n0(skus.filter(s => s.status === k).length)} set`]),
      ["differs", "Amazon differs", n0(nS("differs") + asins.filter(azDiff).length), "set here, Amazon's data says otherwise"],
      ["both", "ASIN on FBA + FBM", n0(bothN), `${n0(asins.filter(a => azFba(a) && azFbm(a) && a.avail + a.inbound + a.awd > 0).length)} with FBA stock`]];
    $("ap-kpis").innerHTML = K.map(([f, l, v, s]) => `<div class="kpi ${S.azf === f ? "on" : ""}"><button class="kpi-go" type="button" data-az-f="${f}" aria-pressed="${S.azf === f}" title="${S.azf === f ? "Show all" : "Show these below"}"><span class="eyebrow">${l}</span><span class="v">${v}</span><span class="s">${s}</span></button></div>`).join("");
    const vs = [...new Set(asins.map(a => a.vendor).filter(Boolean))].sort();
    $("ap-vendor").innerHTML = `<option value="">All vendors</option>` + vs.map(v => `<option ${v === S.vendor ? "selected" : ""}>${esc(v)}</option>`).join("");
    $("ap-type").innerHTML = AZCH.map(([k, n]) => `<option value="${k}" ${S.azch === k ? "selected" : ""}>${n}${k ? ` (${n0(skus.filter(s => skuFul(s) === k).length)})` : ""}</option>`).join("");
    const list = azShown(), page = list.slice(0, S.limit), nSk = list.reduce((x, g) => x + g.skus.length, 0);
    const file = (asins.find(a => a.file) || {}).file || "";
    st.textContent = `${n0(list.length)} ASIN${list.length === 1 ? "" : "s"} · ${n0(nSk)} SKU${nSk === 1 ? "" : "s"}${list.length > page.length ? ` · showing ${n0(page.length)} ASINs` : ""}${file ? ` · from ${file}` : ""}`;
    const nA = S.azsel.size, nK = S.azsku.size, busy = S.busy ? "disabled" : "";
    const what = [nA && `${n0(nA)} ASIN${nA === 1 ? "" : "s"}`, nK && `${n0(nK)} SKU${nK === 1 ? "" : "s"}`].filter(Boolean).join(" + ");
    $("ap-bulk").innerHTML = nA || nK ? `<div class="az-bulk"><b>${what}</b> selected
      <select class="inp sm" id="az-bst" ${busy}><option value="">Set status…</option>${AZK.map(k => `<option value="${k}">${esc(AZ[k][0])}</option>`).join("")}<option value="@clear">↺ Back to the suggestion</option></select>
      ${nK ? `<span class="ap-sep">·</span> SKUs to <button class="btn sm" data-az-bulk="ful:FBA" ${busy}>FBA</button><button class="btn sm" data-az-bulk="ful:FBM" ${busy}>FBM</button>` : ""}
      ${nA ? `<span class="ap-sep">·</span> ASINs: FBA <button class="btn sm" data-az-bulk="fba:true" ${busy}>on</button><button class="btn sm" data-az-bulk="fba:false" ${busy}>off</button> FBM <button class="btn sm" data-az-bulk="fbm:true" ${busy}>on</button><button class="btn sm" data-az-bulk="fbm:false" ${busy}>off</button>` : ""}
      <span class="ap-sep">·</span> <button class="btn sm primary" data-az-bulk="sug" ${busy} title="Each one gets Amazon's suggestion (status, and FBA / FBM)">Use suggestions</button>
      <input id="az-note" class="inp sm" placeholder="Note (optional)" style="width:150px"> <button class="linkbtn small" data-az-bulk="none">Clear</button></div>`
      : `<span class="muted small">Each ASIN and each of its SKUs gets a status and fulfillment. Dashed = Amazon's suggestion, not set yet. Tick rows to set several at once. Seller Sage only — nothing is changed on Amazon.</span>`;
    const th = (k, l, cls) => k ? `<th class="${cls || ""} sortable" data-az-sort="${k}" aria-sort="${S.azsort === k ? "descending" : "none"}">${l}${S.azsort === k ? " ↓" : ""}</th>` : `<th class="${cls || ""}">${l}</th>`;
    const allOn = page.length && page.every(g => (!g.a.real || S.azsel.has(g.a.asin)) && g.skus.every(s => S.azsku.has(s.sku)));
    const seg = `<tr class="ap-useg"><td colspan="7" class="l"><span class="seg sm">${AZF.map(([k, n]) => `<button type="button" data-az-f="${k}" aria-pressed="${S.azf === k}">${n}</button>`).join("")}</span></td></tr>`;
    $("ap-table").innerHTML = `<thead>${seg}<tr><th class="az-ck"><input type="checkbox" data-az-all ${allOn ? "checked" : ""} aria-label="Select all shown"></th>${th("name", "ASIN / seller SKU", "l")}${th("", "Fulfillment", "l")}${th("", "Status", "l")}${th("", "On Amazon now", "l")}${th("stock", "Stock")}${th("sold", "Sold 12 mo")}</tr></thead>${
      page.map(({ a, skus: ss }) => {
        const nAct = a.skus.filter(s => s.amz === "Active").length, gOn = (!a.real || S.azsel.has(a.asin)) && ss.every(s => S.azsku.has(s.sku));
        const head = `<tr class="az-a">
          <td class="az-ck"><input type="checkbox" data-az-g="${esc(a.asin)}" ${gOn ? "checked" : ""} aria-label="Select ${esc(a.asin || "these SKUs")} and its SKUs"></td>
          <td class="l">${a.real ? `<a class="olink az-t" href="https://www.amazon.com/dp/${esc(a.asin)}" target="_blank" rel="noopener">${esc(a.title || a.asin)}</a>` : `<span class="az-t">${esc(a.title)}</span>`}
            <div class="meta">${a.real ? `<span class="mono">${esc(a.asin)}</span>` : ""}${a.vendor ? ` · ${esc(a.vendor)}` : ""}${a.pid ? ` · <a class="olink" href="${ADMIN}/products/${esc(a.pid)}${a.vid ? "/variants/" + esc(a.vid) : ""}" target="_blank" rel="noopener">Shopify</a>` : a.real ? ' · <span class="dim">no Shopify product</span>' : ""}${a.real ? ` · <a class="olink" href="https://sellercentral.amazon.com/myinventory/inventory?searchField=all&searchTerm=${esc(a.asin)}" target="_blank" rel="noopener">Seller Central</a>` : ""}${a.last ? ` · last sold ${esc(sd(a.last))}` : ""}</div></td>
          <td class="l">${a.real ? `<span class="az-togs">${asinTogs(a)}</span>${azFba(a) && azFbm(a) && a.avail + a.inbound + a.awd > 0 ? '<div class="az-diff" title="Stocked at FBA — we don\'t also sell it FBM">FBA stock + FBM</div>' : ""}` : ""}</td>
          <td class="l">${a.real ? stSel(a, "a:" + a.asin) : ""}</td>
          <td class="l small muted">${a.skus.length ? `${n0(a.skus.length)} SKU${a.skus.length === 1 ? "" : "s"} · ${nAct ? `<b class="pos-t">${n0(nAct)} active</b>` : "none active"}` : a.listed ? "" : "not listed"}</td>
          <td class="num">${azStockOf(a)}</td><td class="num">${azSoldOf(a)}</td></tr>`;
        const rows = ss.map(s => `<tr class="az-s">
          <td class="az-ck"><input type="checkbox" data-az-sku="${esc(s.sku)}" ${S.azsku.has(s.sku) ? "checked" : ""} aria-label="Select ${esc(s.sku)}"></td>
          <td class="l"><span class="mono">${esc(s.sku)}</span>${s.opened ? ` <span class="meta-i">listed ${esc(sd(String(s.opened).slice(0, 10)))}</span>` : ""}</td>
          <td class="l">${skuSwitch(s)}</td><td class="l">${stSel(s, "s:" + s.sku)}</td><td class="l">${amzSku(s)}</td>
          <td class="num">${azStockOf(s)}</td><td class="num">${azSoldOf(s)}</td></tr>`).join("");
        const hid = a.skus.length - ss.length;
        return `<tbody class="az-g">${head}${rows}${hid > 0 ? `<tr class="az-s az-more"><td></td><td class="l small muted" colspan="6">${n0(hid)} more SKU${hid === 1 ? "" : "s"} on this ASIN not matching the filter</td></tr>` : ""}</tbody>`;
      }).join("") || `<tbody><tr><td colspan="7" class="l muted">${S.az.length ? "Nothing matches." : "No ASINs yet — Amazon's listings report hasn't been read."}</td></tr></tbody>`}`;
    $("ap-more").hidden = list.length <= page.length;
  }
  // saves: [{lvl: "a" | "s", ids, ...fields}]
  async function azSave(groups) {
    S.busy = true; render();
    const b = $("ap-note2");
    try {
      const W = window.JTWeb || null, now = new Date().toISOString();
      for (const g of groups) {
        if (!g.ids.length) continue;
        const { lvl, ids, ...f } = g, p = lvl === "a" ? { asins: ids, ...f } : { skus: ids, ...f };
        const fn = lvl === "a" ? "asin_master_set" : "amazon_sku_master_set";
        if (W) await W.write(lvl === "a" ? "jt_asin_master" : "jt_amazon_sku_master", { p });
        else await JT.run(`select jt.${fn}(${JT.q(JSON.stringify({ ...p, by: "Claude dashboard" }))}::jsonb)::text as r`, true);
        const objs = lvl === "a" ? S.az.filter(a => ids.includes(a.asin)) : allSkus().filter(s => ids.includes(s.sku));
        for (const o of objs) { for (const [k, v] of Object.entries(f)) o[k] = k === "status" || k === "ful" ? v || "" : v; o.at = now; }
      }
      b.hidden = true;
    } catch (e) { b.hidden = false; b.className = "note bad"; b.textContent = "Couldn't save that: " + JT.message(e); }
    S.busy = false; render();
  }
  async function azRefresh() { if (S.azLoading) return; S.az = null; S.azLoading = true; render(); try { await loadAsins(); } catch (e) { S.azErr = e; } S.azLoading = false; render(); }
  const withNote = (g) => { const n = $("az-note") ? $("az-note").value.trim() : ""; return n ? { ...g, note: n } : g; };
  $("tab-active").addEventListener("change", (e) => {
    if (S.view !== "asins") return;
    const ss = e.target.closest("select[data-az-ss]");
    if (ss) { const i = ss.dataset.azSs.indexOf(":"), lvl = ss.dataset.azSs.slice(0, i), id = ss.dataset.azSs.slice(i + 1); azSave([{ lvl, ids: [id], status: ss.value }]); return; }
    if (e.target.id === "az-bst" && e.target.value) { const v = e.target.value === "@clear" ? "" : e.target.value;
      azSave([withNote({ lvl: "a", ids: [...S.azsel], status: v }), withNote({ lvl: "s", ids: [...S.azsku], status: v })]).then(() => { S.azsel.clear(); S.azsku.clear(); render(); }); }
  });
  $("tab-active").addEventListener("click", (e) => {
    if (S.view !== "asins") return;
    const f = e.target.closest("[data-az-f]"); if (f) { const k = f.dataset.azF; S.azf = S.azf === k && f.classList.contains("kpi-go") ? "all" : k; S.azsel.clear(); S.azsku.clear(); S.limit = 150; render(); return; }
    const so = e.target.closest("[data-az-sort]"); if (so) { S.azsort = so.dataset.azSort; render(); return; }
    const c1 = e.target.closest("[data-az-ch]"); if (c1) { const [asin, ch] = c1.dataset.azCh.split(":"), a = S.az.find(x => x.asin === asin); if (!a) return;
      azSave([{ lvl: "a", ids: [asin], [ch]: !(ch === "fba" ? azFba(a) : azFbm(a)) }]); return; }
    const cc = e.target.closest("[data-az-chclr]"); if (cc) { azSave([{ lvl: "a", ids: [cc.dataset.azChclr], fba: null, fbm: null }]); return; }
    const fu = e.target.closest("[data-az-ful]"); if (fu) { const i = fu.dataset.azFul.lastIndexOf(":"), sku = fu.dataset.azFul.slice(0, i), ch = fu.dataset.azFul.slice(i + 1);
      const s = allSkus().find(x => x.sku === sku); if (!s) return;
      azSave([{ lvl: "s", ids: [sku], ful: s.ful === ch ? "" : ch }]); return; }
    const bk = e.target.closest("[data-az-bulk]");
    if (bk) { const v = bk.dataset.azBulk, A = [...S.azsel], K = [...S.azsku], done = () => { S.azsel.clear(); S.azsku.clear(); render(); };
      if (v === "none") return done();
      if (v === "sug") {
        const gs = new Map(), add = (lvl, k, base, id) => { const key = lvl + "|" + k; if (!gs.has(key)) gs.set(key, withNote({ lvl, ids: [], ...base })); gs.get(key).ids.push(id); };
        for (const a of S.az.filter(x => S.azsel.has(x.asin))) add("a", `${a.sug}|${a.sfba}|${a.sfbm}`, { status: a.sug, fba: a.sfba, fbm: a.sfbm }, a.asin);
        for (const s of allSkus().filter(x => S.azsku.has(x.sku))) add("s", `${s.sug}|${s.sful}`, { status: s.sug, ful: s.sful }, s.sku);
        azSave([...gs.values()]).then(done); return; }
      const [key, val] = v.split(":");
      if (key === "ful") azSave([withNote({ lvl: "s", ids: K, ful: val })]).then(done);
      else azSave([withNote({ lvl: "a", ids: A, [key]: val === "true" })]).then(done);
      return; }
    if (e.target.matches("[data-az-all]")) { const on = e.target.checked;
      for (const g of azShown().slice(0, S.limit)) { if (g.a.real) on ? S.azsel.add(g.a.asin) : S.azsel.delete(g.a.asin); for (const s of g.skus) on ? S.azsku.add(s.sku) : S.azsku.delete(s.sku); }
      render(); return; }
    const gk = e.target.closest("[data-az-g]");
    if (gk) { const g = azShown().find(x => x.a.asin === gk.dataset.azG); if (!g) return; const on = gk.checked;
      if (g.a.real) on ? S.azsel.add(g.a.asin) : S.azsel.delete(g.a.asin); for (const s of g.skus) on ? S.azsku.add(s.sku) : S.azsku.delete(s.sku); render(); return; }
    const sk = e.target.closest("[data-az-sku]"); if (sk) { sk.checked ? S.azsku.add(sk.dataset.azSku) : S.azsku.delete(sk.dataset.azSku); render(); return; }
    if (e.target.closest("#ap-refresh")) { azRefresh(); e.stopImmediatePropagation(); return; }
  }, true);
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
  // set the assessment for sizes / colors: st = a status, "" (clear) or "@sug" (each one's own suggestion)
  async function setStatus(vids, st) {
    if (!vids.length) return;
    const note = $("ap-note") ? $("ap-note").value.trim() : "";
    const groups = new Map();
    for (const vid of vids) { const v = S.rows.find(x => x.vid === vid); if (!v) continue; const k = st === "@sug" ? v.sug : st; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(vid); }
    S.busy = true; render();
    try {
      const W = window.JTWeb || null;
      for (const [k, ids] of groups) {
        const p = { ids, status: k, note };
        if (W) await W.write("jt_active_status", { p });
        else await JT.run(`select jt.active_status_set(${JT.q(JSON.stringify({ ...p, by: "Claude dashboard" }))}::jsonb)::text as r`, true);
        for (const v of S.rows) if (ids.includes(v.vid)) { v.st = k; v.stNote = k ? note : ""; }
      }
      group(); S.sel.clear();
      const b = $("ap-note2"); b.hidden = true;
    } catch (e) { const b = $("ap-note2"); b.hidden = false; b.className = "note bad"; b.textContent = "Couldn't save the status: " + JT.message(e); }
    S.busy = false; render();
  }
  const pick = (vids, on) => { for (const v of vids) on ? S.sel.add(v) : S.sel.delete(v); };
  const liveVids = (p) => p.vs.filter(v => S.f === "removed" ? v.culled : !v.culled).map(v => v.vid);

  $("tab-active").addEventListener("click", (e) => {
    const vw = e.target.closest("[data-ap-view]"); if (vw) { S.view = vw.dataset.apView; S.vendor = ""; S.type = ""; S.limit = 150; render(); return; }
    const uf = e.target.closest("[data-ap-uf]"); if (uf) { S.uf = S.uf === uf.dataset.apUf && uf.classList.contains("kpi-go") ? "all" : uf.dataset.apUf; S.limit = 150; render(); return; }
    const us = e.target.closest("[data-ap-usort]"); if (us) { S.usort = us.dataset.apUsort; render(); return; }
    const kp = e.target.closest("[data-ap-kpi]");
    if (kp) { const [f2, sf2] = JSON.parse($("ap-kpis").dataset.go)[+kp.dataset.apKpi], on = S.f === f2 && S.sf === sf2;
      S.f = on ? "all" : f2; S.sf = on ? "" : sf2; if (S.sort === "added" && S.f !== "new") S.sort = "sold"; S.sel.clear(); S.limit = 150; render();
      if (!on) { const t = $("ap-table"); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); } return; }
    // New: added in the last 30 days, newest first (Nov 2)
    const f = e.target.closest("[data-ap-f]"); if (f) { const was = S.f; S.f = f.dataset.apF; if (S.f === "new") S.sort = "added"; else if (was === "new" && S.sort === "added") S.sort = "sold"; S.sel.clear(); S.limit = 150; render(); return; }
    const qk = e.target.closest("[data-ap-quick]");
    if (qk) { const [key, st] = qk.dataset.apQuick.split(":"); const vids = key[0] === "p" ? liveVids(S.prods.find(x => x.pid === key.slice(1)) || { vs: [] }) : [key.slice(1)]; setStatus(vids, st); return; }
    const ss = e.target.closest("[data-ap-set]"); if (ss) { setStatus([...S.sel], ss.dataset.apSet); return; }
    const so = e.target.closest("[data-ap-sort]"); if (so) { S.sort = so.dataset.apSort; render(); return; }
    const a = e.target.closest("[data-ap-act]");
    if (a) { const k = a.dataset.apAct; if (k === "cull") setCull(true); else if (k === "restore") setCull(false); else if (k === "clear") { S.sel.clear(); render(); } return; }
    if (e.target.matches("[data-ap-all]")) { const page = shown().slice(0, S.limit); pick(page.flatMap(liveVids), e.target.checked); render(); return; }
    const sp = e.target.closest("[data-ap-selp]"); if (sp) { const p = S.prods.find(x => x.pid === sp.dataset.apSelp); if (p) pick(liveVids(p), sp.checked); render(); return; }
    const sv = e.target.closest("[data-ap-selv]"); if (sv) { pick([sv.dataset.apSelv], sv.checked); render(); return; }
    const g = e.target.closest("[data-ap-g]"); if (g) { const k = g.dataset.apG; S.shut.has(k) ? S.shut.delete(k) : S.shut.add(k); render(); return; }
    if (e.target.closest("#ap-more")) { S.limit += 300; render(); return; }
    if (e.target.closest("#ap-refresh")) { refresh(); return; }
    const row = e.target.closest("[data-ap-open]");
    if (row && !e.target.closest("a, button, input")) { const id = row.dataset.apOpen; S.open.has(id) ? S.open.delete(id) : S.open.add(id); render(); }
  });
  $("ap-q").addEventListener("input", (e) => { S.q = e.target.value; clearTimeout(e.target._t); e.target._t = setTimeout(() => { S.limit = 150; render(); }, 150); });
  $("ap-vendor").addEventListener("change", (e) => { S.vendor = e.target.value; S.limit = 150; render(); });
  $("ap-type").addEventListener("change", (e) => { if (S.view === "asins") S.azch = e.target.value; else S.type = e.target.value; S.limit = 150; render(); });
  $("ap-stock").addEventListener("change", (e) => { S.sf = e.target.value; S.limit = 150; render(); });
  $("ap-miss").addEventListener("change", (e) => { S.mf = e.target.value; S.limit = 150; render(); });
  // the list to fill in (one row per size / color that's missing something), e.g. to work through in Shopify's bulk editor
  $("ap-dl").addEventListener("click", async () => {
    const q = (x) => /[",\n]/.test(String(x ?? "")) ? `"${String(x).replace(/"/g, '""')}"` : String(x ?? "");
    const rows = [["Product", "Size / color", "Vendor", "Category", "SKU", "UPC", "Cost", "Price", "Missing", "On hand", "Sold 12 mo", "Shopify"]];
    for (const p of shown()) for (const v of mVs(p, S.mf)) rows.push([p.title, v.title.includes(" - ") ? v.title.split(" - ").slice(1).join(" - ") : "", v.vendor, v.type, v.sku, v.barcode, v.cost ?? "", v.price ?? "",
      missOf(v).map(k => MISS[k][0]).join("; "), v.stock, v.sold, `${ADMIN}/products/${v.pid}/variants/${v.vid}`]);
    const d = window.claude && window.claude.use ? await window.claude.use("downloads").catch(() => null) : null;
    const b = $("ap-note2");
    if (!d) { b.hidden = false; b.className = "note warn"; b.textContent = "Downloads aren't available here."; return; }
    try { await d.save({ filename: `products-${S.mf === "any" ? "missing-info" : "missing-" + S.mf}.csv`, data: rows.map(r => r.map(q).join(",")).join("\n") + "\n", mimeType: "text/csv" }); }
    catch (e) { if (e && e.code !== "declined") { b.hidden = false; b.className = "note bad"; b.textContent = JT.message(e); } }
  });
  $("ap-by").addEventListener("change", (e) => { S.by = e.target.value; S.shut.clear(); S.limit = 150; render(); });
  // Refresh from Shopify (Nov 2, Brian): starts the catalog read (jt.catalog_refresh, migration 193 — at most every 5 minutes),
  // waits for it (a few minutes) and reloads the list. New products land here by themselves (migration 185).
  const ago = (iso) => { if (!iso) return "never"; const m = Math.round((Date.now() - Date.parse(iso)) / 6e4);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
  const catStatus = async () => { const r = await JT.rows(["jt.catalog_status()::text"], "", true); return r[0] ? JSON.parse(r[0][0]) : {}; };
  let shopWait = null;
  async function showShop() { const el = $("ap-shopst"); if (!el || shopWait) return;
    try { const st = await catStatus(); el.textContent = `Shopify products read ${ago(st.last_sync)}`; el.title = st.last_sync ? new Date(st.last_sync).toLocaleString() : ""; } catch (_) { el.textContent = ""; } }
  async function refreshShop() {
    const el = $("ap-shopst"), b = $("ap-shop"); if (shopWait) return;
    b.disabled = true; el.textContent = "Asking Shopify…";
    try {
      const W = window.JTWeb || null;
      const r = W ? await W.write("jt_catalog_refresh", { p: {} }) : JSON.parse(((await JT.run(`select jt.catalog_refresh('{"by":"Claude dashboard"}'::jsonb)::text as r`, true))[0] || {}).r || "{}");
      const res = typeof r === "string" ? JSON.parse(r) : r || {};
      const since = Date.parse(res.requested_at || new Date().toISOString()) - 5000, before = (S.rows || []).length, t0 = Date.now();
      el.textContent = res.started ? "Reading products from Shopify… (2–3 minutes)" : `Already reading from Shopify (started ${ago(res.requested_at)})…`;
      shopWait = setInterval(async () => {
        let st = {}; try { st = await catStatus(); } catch (_) { return; }
        if (st.last_sync && Date.parse(st.last_sync) > since) {
          clearInterval(shopWait); shopWait = null; b.disabled = false;
          await refresh();
          const added = (S.rows || []).length - before;
          el.textContent = `Up to date with Shopify${added > 0 ? ` · ${n0(added)} new size${added === 1 ? "" : "s"} / color${added === 1 ? "" : "s"}` : ""}`;
        } else if (Date.now() - t0 > 10 * 6e4) { clearInterval(shopWait); shopWait = null; b.disabled = false; el.textContent = "Shopify is taking longer than usual — check back in a few minutes."; }
      }, 15000);
    } catch (e) { b.disabled = false; el.textContent = "Couldn't start it: " + JT.message(e); }
  }
  $("ap-shop").addEventListener("click", refreshShop);
  window.apShow = () => { showShop(); if (!S.rows && !S.err) refresh(); else render(); };
  window.JTActive = { _state: S };
  if ((location.hash || "") === "#active") setTimeout(() => window.apShow(), 0);
})();
