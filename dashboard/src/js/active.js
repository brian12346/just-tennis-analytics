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
  const FILTERS = [["all", "All"], ["todo", "Not assessed"], ["active", "Active"], ["eol", "EOL"], ["seasonal", "Seasonal"], ["hold", "Hold"], ["mixed", "Mixed"], ["removed", "Removed"]];
  const STOCKS = { new: ["New", "ok", "Added in the last 30 days, nothing sold yet"], instock: ["In stock", "", "Stock on hand and selling"],
    low: ["Low stock", "warn", "Under 4 weeks of stock at the 90-day pace"], oos: ["Out of stock", "miss", "Sold in the last 12 months, none on hand anywhere, nothing on order"],
    onorder: ["On order", "other", "None on hand; more is on an open PO"], slow: ["Slow", "warn", "Stock on hand, nothing sold in 90 days"],
    dead: ["Dead stock", "miss", "Stock on hand, nothing sold in 12 months"], none: ["No stock", "pos", "No stock and no sales"] };
  const SFILT = [["", "Any stock"], ...Object.entries(STOCKS).map(([k, v]) => [k, v[0]]), ["shopoff", "Not active in Shopify"], ["disc", "Discontinued"]];
  // the stock state of a size or a whole product
  const stockOf = (o, nw) => { const pace = o.s90 / 90;
    if (o.stock <= 0) return o.onOrder > 0 ? "onorder" : nw && !o.sold ? "new" : o.sold > 0 ? "oos" : "none";
    if (nw && !o.sold) return "new";
    if (!o.sold) return "dead"; if (!o.s90) return "slow";
    return pace > 0 && o.stock / (pace * 7) < 4 ? "low" : "instock"; };
  // what to set it to, when it isn't assessed yet
  const suggest = (o, isP) => o.disc ? "eol" : o.stk === "new" || o.stk === "onorder" ? "active" : o.stk === "dead" ? "eol" : (isP ? o.draft : o.status !== "ACTIVE") && o.stock <= 0 ? "eol" : "active";
  const SORTK = { sold: (p) => -p.sold, stock: (p) => -p.stock, last: (p) => -(p.last ? Date.parse(p.last) : 0), name: (p) => p.title.toLowerCase(), vendor: (p) => (p.vendor + " " + p.title).toLowerCase() };
  const GROUPS = [["", "No grouping"], ["vendor", "Vendor"], ["type", "Category"]];
  // missing product info (Oct 29, Brian: "a filter for missing product attributes so we can fill them in" — products with
  // no SKU / UPC don't match on vendor invoices). Checked per size / color; a product shows when any of its sizes is missing it.
  const MISS = { sku: ["No SKU", v => !v.sku.trim()], upc: ["No UPC / barcode", v => !v.barcode.trim()], cost: ["No cost", v => !(v.cost > 0)],
    price: ["No price", v => !(v.price > 0)], type: ["No category", v => !v.type.trim()], vendor: ["No vendor", v => !v.vendor.trim()],
    dup: ["Duplicate SKU", v => !!v.sku.trim() && S.dups.has(v.sku.trim().toLowerCase())] };
  const SHORT = { sku: "SKU", upc: "UPC", cost: "cost", price: "price", type: "category", vendor: "vendor", dup: "duplicate SKU" };
  const missOf = (v) => Object.keys(MISS).filter(k => MISS[k][1](v));
  const MFILT = [["", "Any info"], ["any", "Missing anything"], ...Object.entries(MISS).map(([k, v]) => [k, v[0]])];
  const S = { rows: null, prods: null, f: "all", sf: "", mf: "", dups: new Set(), q: "", vendor: "", type: "", sort: "sold", by: "", shut: new Set(), open: new Set(), sel: new Set(), limit: 150, busy: false, err: null, ask: null };

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
    for (const v of S.rows) { const k = v.sku.trim().toLowerCase(); if (k && !v.culled) seen.set(k, (seen.get(k) || 0) + 1); }
    S.dups = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
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
    : f === "all" ? true : f === "todo" ? p.todo : f === "mixed" ? p.st === "mixed" : p.st === f;
  const mVs = (p, f) => p.vs.filter(v => !v.culled && (f === "any" ? missOf(v).length > 0 : MISS[f][1](v)));
  const mOk = (p, f) => !f || mVs(p, f).length > 0;
  const sOk = (p, f) => !f ? true : f === "shopoff" ? p.draft : f === "disc" ? p.anyDisc : p.stk === f;
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
    const st = $("ap-status");
    if (S.err) { st.innerHTML = `<span class="neg">Couldn't load the list: ${esc(JT.message(S.err))}</span>`; return; }
    if (!S.prods) { st.textContent = "Loading products, stock and 12 months of sales… (a few seconds)"; $("ap-table").innerHTML = ""; return; }
    const live = S.prods.filter(p => !p.allCulled), lv = S.rows.filter(v => !v.culled);
    $("ap-kpis").innerHTML = [
      ["Assessed", `${n0(live.filter(p => !p.todo).length)} <small>of ${n0(live.length)}</small>`, `${n0(live.filter(p => p.todo).length)} product${live.filter(p => p.todo).length === 1 ? "" : "s"} still to assess`],
      ["Active", n0(live.filter(p => p.st === "active").length), `EOL ${n0(live.filter(p => p.st === "eol").length)} · seasonal ${n0(live.filter(p => p.st === "seasonal").length)} · hold ${n0(live.filter(p => p.st === "hold").length)}`],
      ["In stock", n0(live.filter(p => p.stock > 0).length), `${n0(lv.reduce((a, v) => a + v.stock, 0))} units · store, prep, Amazon`],
      ["Sold in 12 months", n0(live.filter(p => p.sold > 0).length), `${n0(lv.reduce((a, v) => a + v.sold, 0))} units, all channels`],
      ["Out of stock", n0(live.filter(p => p.stk === "oos").length), `${n0(live.filter(p => p.stk === "low").length)} low · ${n0(live.filter(p => p.stk === "onorder").length)} on order`],
      ["Dead stock", n0(live.filter(p => p.stk === "dead").length), "on hand, nothing sold in 12 months"],
      ["Removed", n0(S.prods.filter(p => p.vs.some(v => v.culled)).length), "taken off the list"],
    ].map(([l, v, s]) => `<div class="kpi"><span class="eyebrow">${l}</span><span class="v">${v}</span><span class="s">${s}</span></div>`).join("");
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
            <div class="meta">${one ? `${codes(one)} ${missPill(one)}` : `${n0(vs.length)} size${vs.length === 1 ? "" : "s"} / color${vs.length === 1 ? "" : "s"}${p.someCulled && !rem ? ` · ${n0(p.vs.length - vs.length)} removed` : ""}${(() => { const n = mVs(p, S.mf || "any").length; return n ? ` <span class="pill miss" title="Sizes / colors missing ${S.mf && S.mf !== "any" ? esc(MISS[S.mf][0].toLowerCase()) : "info"} in Shopify">${n0(n)} missing ${S.mf && S.mf !== "any" ? esc(SHORT[S.mf]) : "info"}</span>` : ""; })()}`} ${stockPill(p)} ${tags(p, true)}</div></td>
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
    const f = e.target.closest("[data-ap-f]"); if (f) { S.f = f.dataset.apF; S.sel.clear(); S.limit = 150; render(); return; }
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
  $("ap-type").addEventListener("change", (e) => { S.type = e.target.value; S.limit = 150; render(); });
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
  window.apShow = () => { if (!S.rows && !S.err) refresh(); else render(); };
  window.JTActive = { _state: S };
  if ((location.hash || "") === "#active") setTimeout(() => window.apShow(), 0);
})();
