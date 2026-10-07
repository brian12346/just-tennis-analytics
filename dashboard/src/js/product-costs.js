(() => {
  // ===================== Inventory value (was Product costs) =====================
  // Every Shopify variant with its unit cost and its units in each place we hold stock: the Shopify store, the prep
  // center, Amazon FBA and Amazon AWD, valued at cost (Brian, Oct 7: units and cost, not price or sales).
  // Edited costs are queued in jt.cost_updates and written to Shopify by the sync.
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m = (n) => n == null || isNaN(n) ? "—" : usd.format(n), m0 = (n) => usd0.format(n || 0);
  const pct = (x) => x == null || !isFinite(x) ? "—" : (x * 100).toFixed(0) + "%";
  const JT = window.JT;
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const PER = 100;
  const money = (s) => { const t = String(s ?? "").trim().replace(/[$,\s]/g, ""); if (!t) return null; return /^\d*\.?\d+$/.test(t) ? Number(t) : NaN; };

  const P = {
    shown: false, loading: false, reqId: 0,
    rows: null,             // [{vid, pid, sku, title, vendor, type, status, price, cost, qty}]
    pending: new Map(),     // vid -> queued cost not yet in Shopify
    edits: new Map(),       // vid -> typed text
    vendor: "all", cat: "all", status: "all", issue: "all", where: "stock", q: "", sort: "cost", page: 0,
    asOf: null,             // last catalog sync (inventory quantities are as of then)
    saving: false, confirm: false,
  };
  const note = (kind, html) => { const n = $("pc-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; };

  async function load(refresh) {
    const id = ++P.reqId; P.loading = true; render();
    $("pc-status").textContent = "Loading products and stock…";
    try {
      const [cat, pend, asof] = await Promise.all([
        JT.rowsSplit(["variant_id::text", "product_id::text", "sku", "coalesce(nullif(display_name, ''), product_title)", "vendor", "product_type", "status", "price", "unit_cost", "inventory_qty"],
          "from jt.variants where removed_at is null", "variant_id", 4, refresh),
        JT.rows(["variant_id::text", "new_cost"], "from jt.cost_updates where status = 'pending' and new_cost is not null", true),
        JT.rows(["extract(epoch from max(seen_at))"], "from jt.variants", refresh),
      ]);
      if (id !== P.reqId) return;
      P.asOf = asof && asof[0] && asof[0][0] ? new Date(+asof[0][0] * 1000) : null;
      P.rows = cat.map(x => ({ vid: x[0], pid: x[1], sku: x[2] || "", title: x[3] || "", vendor: x[4] || "", type: x[5] || "", status: x[6] || "",
        price: x[7] == null ? null : +x[7], cost: x[8] == null ? null : +x[8], qty: x[9] == null ? null : +x[9] }));
      P.pending = new Map(pend.map(([v, c]) => [v, +c]));
      fillFilters();
      if (JT.fba) JT.fba.load(refresh).then(() => { if (id === P.reqId) render(); }).catch(() => {});
      if (window.JTPrep) window.JTPrep.load(refresh).then(() => { if (id === P.reqId) render(); }).catch(() => {});
      if (window.JTCost) window.JTCost.load(refresh).then(() => { if (id === P.reqId) render(); }).catch(() => {});
      const when = P.asOf ? P.asOf.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
      $("pc-status").textContent = `${P.rows.length.toLocaleString()} Shopify variants${when ? ` · Shopify stock as of ${when}` : ""}`;
    } catch (e) { note("bad", esc(JT.message(e))); $("pc-status").textContent = ""; }
    finally { if (id === P.reqId) { P.loading = false; render(); } }
  }

  function fillFilters() {
    const opt = (sel, vals, cur, all) => { $(sel).innerHTML = `<option value="all">${all}</option>` + vals.map(v => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(v || "(none)")}</option>`).join(""); };
    const vend = [...new Set(P.rows.map(r => r.vendor))].sort((a, b) => a.localeCompare(b));
    const cats = [...new Set(P.rows.filter(r => P.vendor === "all" || r.vendor === P.vendor).map(r => r.type))].sort((a, b) => a.localeCompare(b));
    if (P.cat !== "all" && !cats.includes(P.cat)) P.cat = "all";
    opt("pc-vendor", vend, P.vendor, "All vendors"); opt("pc-cat", cats, P.cat, "All categories");
  }

  const costOf = (r) => r.extra ? r.unit : P.edits.has(r.vid) ? money(P.edits.get(r.vid)) : P.pending.has(r.vid) ? P.pending.get(r.vid) : r.cost;
  const noCost = (c) => c == null || isNaN(c);
  // the cost stock is valued at: FIFO cost layers where a purchase order set the cost (JTCost), else the unit cost
  const layered = (r) => !r.extra && !P.edits.has(r.vid) && window.JTCost && window.JTCost.has(r.vid);
  const valCost = (r) => layered(r) ? window.JTCost.unit(r.vid, costOf(r)) : costOf(r);
  // the saved cost (sorting uses it, so a row doesn't jump while its cost is being typed)
  const savedCost = (r) => { if (r.extra) return r.unit; const c = P.pending.has(r.vid) ? P.pending.get(r.vid) : r.cost; return window.JTCost && window.JTCost.has(r.vid) ? window.JTCost.unit(r.vid, c) : c; };

  // ---- Units by location, in Shopify units ----
  // Shopify store: on hand in Shopify (last catalog sync; negative counts are shown but count as 0).
  // Prep center: the Prep center tab's stock. FBA / AWD: the Amazon inventory reports (FBA available + in transfer +
  // inbound; AWD available + inbound to AWD), turned into Shopify units through each listing's mapping (a 3-pack = 3).
  // Prep center and Amazon stock that isn't tied to a Shopify product is kept apart ("not tied to a product").
  const LOCS = [["shop", "Shopify store"], ["prep", "Prep center"], ["fba", "Amazon FBA"], ["awd", "Amazon AWD"]];
  let LC = { rows: null, fd: null, pd: null, by: new Map(), extra: [] };
  function locs() {
    const fd = JT.fba && JT.fba.data, pd = window.JTPrep && window.JTPrep.data;
    if (LC.rows === P.rows && LC.fd === fd && LC.pd === pd) return LC;
    const known = new Set((P.rows || []).map(r => r.vid)), by = new Map(), extra = [];
    const get = (v) => { let x = by.get(v); if (!x) by.set(v, x = { prep: 0, fba: 0, awd: 0, skus: [] }); return x; };
    // stock not tied to a Shopify product: a row of its own (no editable cost; Amazon listings use their manual cost)
    const ex = (key, o) => { const r = { extra: true, vid: key, pid: "", status: "", qty: 0, price: null, cost: o.unit, u: { shop: 0, prep: 0, fba: 0, awd: 0 }, ...o }; extra.push(r); return r; };
    if (pd) for (const r of pd.rows) {
      if (!(r.qty > 0)) continue;
      const v = String(r.vid);
      if (known.has(v)) get(v).prep += r.qty;
      else ex("p:" + v + "|" + r.asku, { src: "prep", title: r.title, sku: r.sku, vendor: r.vendor, type: r.type, unit: r.cost }).u.prep = r.qty;
    }
    if (fd) for (const it of fd.items) {
      const fu = JT.fba.unitsOf(it, true, "fba"), au = JT.fba.unitsOf(it, true, "awd");
      if (fu + au <= 0) continue;
      const v = it.map && it.map.vid ? String(it.map.vid) : null;
      if (v && known.has(v)) { const x = get(v), k = it.map.units || 1; x.fba += fu * k; x.awd += au * k; x.skus.push(it.sku); continue; }
      const r = ex("a:" + it.sku, { src: "amazon", title: it.name || it.sku, sku: it.sku, asin: it.asin, vendor: it.vendor, type: it.type, unit: it.cost, manual: !!(it.map && it.map.kind === "manual") });
      r.u.fba = fu; r.u.awd = au;
    }
    LC = { rows: P.rows, fd, pd, by, extra };
    return LC;
  }
  const NONE = { prep: 0, fba: 0, awd: 0, skus: [] };
  const unitsAt = (r) => { if (r.extra) return r.u; const x = locs().by.get(r.vid) || NONE; return { shop: r.qty > 0 ? r.qty : 0, prep: x.prep, fba: x.fba, awd: x.awd }; };
  const totalUnits = (u) => u.shop + u.prep + u.fba + u.awd;

  const matchesBase = (r, q) => (P.vendor === "all" || r.vendor === P.vendor) && (P.cat === "all" || r.type === P.cat)
    && (!q || [r.title, r.sku, r.vendor, r.asin || ""].join(" ").toLowerCase().includes(q));
  function visible() {
    if (!P.rows) return [];
    const q = P.q.trim().toLowerCase();
    const key = (r) => { const u = unitsAt(r); return P.sort === "cost" ? totalUnits(u) * (savedCost(r) || 0) : P.sort === "units" ? totalUnits(u) : u[P.sort] || 0; };
    const rows = P.rows.concat(locs().extra).filter(r => {
      if (!matchesBase(r, q) || (P.status !== "all" && r.status !== P.status)) return false;
      if (P.issue === "missing" && !noCost(costOf(r))) return false;
      if (P.issue === "edited" && !P.edits.has(r.vid)) return false;
      if (P.issue === "extra" && !r.extra) return false;
      if (P.where === "all") return true;
      const u = unitsAt(r);
      return P.where === "stock" ? totalUnits(u) > 0 || r.qty < 0 : u[P.where] > 0;
    });
    const k = new Map(rows.map(r => [r.vid, key(r)]));
    return P.sort === "name" ? rows.sort((a, b) => a.title.localeCompare(b.title))
      : rows.sort((a, b) => k.get(b.vid) - k.get(a.vid) || a.title.localeCompare(b.title));
  }

  // per-location units and cost for a set of product rows (+ optional stock not tied to a product)
  function sumUp(rows) {
    const t = { units: 0, cost: 0, noCost: 0, noCostUnits: 0, neg: 0, n: 0 };
    for (const [l] of LOCS) t[l] = { units: 0, cost: 0, noCostUnits: 0 };
    for (const r of rows) {
      if (r.qty < 0) t.neg++;
      const u = unitsAt(r), tu = totalUnits(u); if (!tu) continue;
      const c = valCost(r); t.n++;
      if (noCost(c)) { t.noCost++; t.noCostUnits += tu; }
      for (const [l] of LOCS) { t[l].units += u[l]; if (noCost(c)) t[l].noCostUnits += u[l]; else t[l].cost += u[l] * c; }
    }
    for (const [l] of LOCS) { t.units += t[l].units; t.cost += t[l].cost; }
    return t;
  }

  // Totals: every product with stock anywhere (any status), narrowed only by vendor, category and search
  function renderInv() {
    const el = $("pc-inv"); if (!P.rows) { el.innerHTML = ""; return; }
    const q = P.q.trim().toLowerCase();
    const scoped = P.vendor !== "all" || P.cat !== "all" || !!q;
    const L = locs(), every = P.rows.concat(L.extra), ex = L.extra.filter(x => matchesBase(x, q));
    const t = sumUp(every.filter(r => matchesBase(r, q)));
    const all = scoped ? sumUp(every) : t;
    const fd = L.fd, pd = L.pd;
    const scope = [P.vendor !== "all" ? esc(P.vendor || "(no vendor)") : "", P.cat !== "all" ? esc(P.cat || "(no category)") : "", q ? `“${esc(P.q.trim())}”` : ""].filter(Boolean).join(" · ");
    const day = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const when = P.asOf ? P.asOf.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    $("pc-inv-scope").innerHTML = (scoped ? `Filtered to ${scope} · all stock ${m0(all.cost)} at cost` : "All stock at cost: Shopify store, prep center, Amazon FBA and AWD")
      + (when ? ` · Shopify as of ${when}` : "") + (fd && fd.meta.snapshot ? ` · FBA report of ${day(fd.meta.snapshot)}` : "") + (fd && fd.awdMeta && fd.awdMeta.snapshot ? ` · AWD report of ${day(fd.awdMeta.snapshot)}` : "");
    const n = (x) => Math.round(x).toLocaleString();
    const loaded = { shop: true, prep: !!pd, fba: !!fd, awd: !!fd };
    const go = { prep: `<button class="linkbtn small" data-go-prep>open prep center</button>`, fba: `<button class="linkbtn small" data-go-fba>open Amazon inventory</button>`, awd: "" };
    const loc = (l, label) => {
      const x = t[l], exU = ex.reduce((a, e) => a + e.u[l], 0);
      const s = !loaded[l] ? (l === "prep" ? "loading…" : `No Amazon report loaded · ${go.fba}`)
        : [`${n(x.units)} units`, x.noCostUnits ? `${n(x.noCostUnits)} with no cost` : "", exU ? `<button class="linkbtn small" data-extra>${n(exU)} not tied to a Shopify product</button>` : "", go[l] || ""].filter(Boolean).join(" · ");
      return { l: `${label} at cost`, v: loaded[l] ? m0(x.cost) : "—", s };
    };
    const sh = (l) => t.cost ? ` (${pct(t[l].cost / t.cost)})` : "";
    el.innerHTML = [
      { c: "cost", l: "Total inventory at cost", v: m0(t.cost), s: `${n(t.units)} units · ` + LOCS.map(([l, lb]) => `${lb.replace("Amazon ", "")} ${m0(t[l].cost)}${sh(l)}`).join(" · ") },
      ...LOCS.map(([l, lb]) => loc(l, lb)),
      { l: "Not valued", v: n(t.noCostUnits), s: `units with no cost · ${t.noCost.toLocaleString()} product${t.noCost === 1 ? "" : "s"}${t.neg ? ` · ${t.neg} with negative Shopify on-hand` : ""} · <button class="linkbtn small" data-nocost>show them</button>` },
    ].map(k => `<div class="kpi ${k.c || ""}"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
  }

  let pageRows = [];
  function render() {
    if ($("tab-costs").hidden) return;
    const t = $("pc-table");
    if (!P.rows) { t.innerHTML = `<tbody><tr><td class="l muted">${P.loading ? "Loading…" : ""}</td></tr></tbody>`; $("pc-inv").innerHTML = ""; return; }
    const rows = visible();
    renderInv();
    const vt = sumUp(rows);
    const pages = Math.max(1, Math.ceil(rows.length / PER)); if (P.page >= pages) P.page = pages - 1;
    pageRows = rows.slice(P.page * PER, P.page * PER + PER);
    const ae = document.activeElement, keep = ae && ae.dataset && ae.dataset.vid, sel = keep ? [ae.selectionStart, ae.selectionEnd] : null;
    const cell = (u, c) => !u ? '<span class="dim">—</span>' : `${Math.round(u).toLocaleString()}${noCost(c) ? "" : `<div class="meta">${m0(u * c)}</div>`}`;
    t.innerHTML = `<thead><tr><th class="l">Product</th><th class="l">Vendor · category</th><th>Unit cost</th><th title="Shopify store on hand">Store</th><th title="Prep center">Prep</th><th title="Amazon FBA (incl. inbound)">FBA</th><th title="Amazon AWD (incl. inbound)">AWD</th><th>Total units</th><th>Ext. cost</th><th class="l">Status</th></tr></thead><tbody>${
      pageRows.map((r) => {
        if (r.extra) {
          const tu = totalUnits(r.u);
          return `<tr class="${r.unit == null ? "flag-bad" : "flag-warn"}">
          <td class="l">${esc(r.title)}<div class="meta"><span class="mono">${esc(r.sku) || "no SKU"}</span>${r.asin ? ` · ${esc(r.asin)}` : ""}</div></td>
          <td class="l">${esc(r.vendor)}<div class="meta">${esc(r.type || "—")}</div></td>
          <td>${r.unit == null ? '<span class="dim">no cost</span>' : m(r.unit)}${r.manual ? '<div class="meta">manual cost</div>' : ""}</td>
          <td><span class="dim">—</span></td><td>${cell(r.u.prep, r.unit)}</td><td>${cell(r.u.fba, r.unit)}</td><td>${cell(r.u.awd, r.unit)}</td>
          <td><b>${Math.round(tu).toLocaleString()}</b></td>
          <td><b>${r.unit == null ? '<span class="dim">no cost</span>' : m0(tu * r.unit)}</b></td>
          <td class="l"><span class="pill ${r.unit == null ? "miss" : "warn"}" title="${r.src === "amazon" ? "This Amazon listing isn't mapped to a Shopify product" : "This prep center product isn't in Shopify"}">Not tied to Shopify</span>${r.src === "amazon" ? ' <button class="mini" data-go="amzmap">Map it</button>' : ""}</td></tr>`;
        }
        const c = costOf(r), vc = valCost(r), edited = P.edits.has(r.vid), v = edited ? P.edits.get(r.vid) : c == null ? "" : c.toFixed(2);
        const bad = edited && (noCost(c) || c < 0);
        const u = unitsAt(r), tu = totalUnits(u), x = locs().by.get(r.vid);
        const pill = P.pending.has(r.vid) && !edited ? '<span class="pill warn">Saving to Shopify</span>' : noCost(c) ? (tu ? '<span class="pill miss">No cost</span>' : '<span class="pill">No cost</span>') : "";
        return `<tr class="${noCost(c) && tu ? "flag-bad" : ""}">
          <td class="l"><a class="olink" href="${ADMIN}/products/${esc(r.pid)}/variants/${esc(r.vid)}" target="_blank" rel="noopener">${esc(r.title)}</a><div class="meta"><span class="mono">${esc(r.sku) || "no SKU"}</span>${r.status !== "ACTIVE" ? " · " + esc(r.status.toLowerCase()) : ""}${x && x.skus.length ? ` · <span title="Amazon seller SKUs">${esc(x.skus.slice(0, 3).join(", "))}${x.skus.length > 3 ? "…" : ""}</span>` : ""}</div></td>
          <td class="l">${esc(r.vendor)}<div class="meta">${esc(r.type || "—")}</div></td>
          <td><input class="pcin ${edited ? "edited" : ""} ${bad ? "bad" : ""}" data-vid="${esc(r.vid)}" value="${esc(v)}" inputmode="decimal" aria-label="Unit cost for ${esc(r.title)}">${edited && r.cost != null ? `<div class="meta">was ${m(r.cost)}</div>` : layered(r) ? `<div class="meta" title="${esc(window.JTCost.describe(r.vid))}">FIFO ${m(vc)}</div>` : ""}</td>
          <td class="${r.qty < 0 ? "neg" : ""}">${r.qty < 0 ? r.qty.toLocaleString() : cell(u.shop, vc)}</td>
          <td>${cell(u.prep, vc)}</td><td>${cell(u.fba, vc)}</td><td>${cell(u.awd, vc)}</td>
          <td><b>${tu ? Math.round(tu).toLocaleString() : '<span class="dim">0</span>'}</b></td>
          <td><b>${!tu ? '<span class="dim">—</span>' : noCost(vc) ? '<span class="dim">no cost</span>' : m0(tu * vc)}</b></td>
          <td class="l">${pill}${!window.JTPrep ? "" : window.JTPrep.listed(r.vid, "", "shopify") ? ' <span class="pill ok" title="On The List (Prep center tab)">On list</span>'
            : ` <button class="mini" data-list="${esc(r.vid)}" title="Put on On The List (Prep center tab) to re-order for the Shopify store">+ List</button>`}</td></tr>`;
      }).join("") || `<tr><td class="l muted" colspan="10">No products match these filters.</td></tr>`}</tbody>${rows.length ? `<tfoot><tr>
          <td class="l"><b>Total · ${rows.length.toLocaleString()} in view</b></td><td></td><td></td>
          ${LOCS.map(([l]) => `<td><b>${Math.round(vt[l].units).toLocaleString()}</b><div class="meta">${m0(vt[l].cost)}</div></td>`).join("")}
          <td><b>${Math.round(vt.units).toLocaleString()}</b></td><td><b>${m0(vt.cost)}</b>${vt.noCostUnits ? `<div class="meta">${Math.round(vt.noCostUnits).toLocaleString()} units not valued</div>` : ""}</td><td></td></tr></tfoot>` : ""}`;
    if (keep) { const el = t.querySelector(`input[data-vid="${CSS.escape(keep)}"]`); if (el) { el.focus(); try { el.setSelectionRange(sel[0], sel[1]); } catch (_) {} } }
    $("pc-prev").hidden = P.page === 0; $("pc-next").hidden = P.page >= pages - 1;
    $("pc-count").textContent = rows.length ? `${P.page * PER + 1}–${P.page * PER + pageRows.length} of ${rows.length.toLocaleString()}` : "";
    const valid = [...P.edits.entries()].filter(([, v]) => { const c = money(v); return c != null && !isNaN(c) && c >= 0; });
    $("pc-save").disabled = !valid.length || P.saving; $("pc-save").textContent = valid.length ? `Save ${valid.length} cost${valid.length === 1 ? "" : "s"} to Shopify` : "Save costs to Shopify";
    $("pc-discard").disabled = !P.edits.size || P.saving;
    const cf = $("pc-confirm");
    if (P.confirm && valid.length) {
      cf.hidden = false;
      cf.innerHTML = `<div class="note warn">Write ${valid.length} unit cost${valid.length === 1 ? "" : "s"} to Shopify? This changes the cost Shopify uses for new orders and profit reports. <span class="dbtns"><button class="mini primary" id="pc-yes">Yes, save</button><button class="mini" id="pc-no">Cancel</button></span></div>`;
    } else { cf.hidden = true; cf.innerHTML = ""; }
  }

  async function save() {
    const list = [...P.edits.entries()].map(([vid, v]) => ({ variant_id: Number(vid), cost: money(v), vid })).filter(x => x.cost != null && !isNaN(x.cost) && x.cost >= 0);
    if (!list.length) return;
    P.saving = true; P.confirm = false; render();
    try {
      const n = await JT.queueCostUpdates(list.map(({ variant_id, cost }) => ({ variant_id, cost: Math.round(cost * 100) / 100 })));
      for (const x of list) { P.pending.set(x.vid, Math.round(x.cost * 100) / 100); P.edits.delete(x.vid); }
      note("info", `Saved ${n} cost${n === 1 ? "" : "s"}. The sync writes them to Shopify within about a minute; press Refresh after that to see them confirmed.`);
    } catch (e) { note("bad", "Couldn't save: " + esc(JT.message(e))); }
    finally { P.saving = false; render(); }
  }

  function bind() {
    const t = $("pc-table");
    t.addEventListener("input", (e) => {
      const el = e.target; if (!el.dataset.vid) return;
      const r = P.rows.find(x => x.vid === el.dataset.vid); const c = money(el.value);
      const orig = P.pending.has(r.vid) ? P.pending.get(r.vid) : r.cost;
      if (el.value.trim() === "" && orig == null || (c != null && !isNaN(c) && orig != null && Math.abs(c - orig) < 0.005)) P.edits.delete(r.vid); else P.edits.set(r.vid, el.value);
      clearTimeout(t._t); t._t = setTimeout(render, 500);
      el.classList.toggle("edited", P.edits.has(r.vid));
      $("pc-save").disabled = !P.edits.size;
    });
    t.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !e.target.dataset.vid) return;
      e.preventDefault(); const ins = [...t.querySelectorAll("input.pcin")]; const i = ins.indexOf(e.target);
      const next = ins[i + (e.shiftKey ? -1 : 1)]; clearTimeout(t._t); render();
      const el = next && t.querySelector(`input[data-vid="${CSS.escape(next.dataset.vid)}"]`); if (el) { el.focus(); el.select(); }
    });
    t.addEventListener("focusout", () => { clearTimeout(t._t); t._t = setTimeout(render, 150); });
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on("pc-vendor", "change", (e) => { P.vendor = e.target.value; P.page = 0; fillFilters(); render(); });
    on("pc-cat", "change", (e) => { P.cat = e.target.value; P.page = 0; render(); });
    on("pc-stat", "change", (e) => { P.status = e.target.value; P.page = 0; render(); });
    on("pc-issue", "change", (e) => { P.issue = e.target.value; P.page = 0; render(); });
    on("pc-where", "change", (e) => { P.where = e.target.value; P.page = 0; render(); });
    on("pc-sort", "change", (e) => { P.sort = e.target.value; P.page = 0; render(); });
    on("pc-q", "input", (e) => { P.q = e.target.value; P.page = 0; clearTimeout(e.target._t); e.target._t = setTimeout(render, 200); });
    on("pc-refresh", "click", () => load(true));
    on("pc-prev", "click", () => { P.page--; render(); $("pc-table").scrollIntoView({ block: "start" }); });
    on("pc-next", "click", () => { P.page++; render(); $("pc-table").scrollIntoView({ block: "start" }); });
    on("pc-discard", "click", () => { P.edits.clear(); P.confirm = false; render(); });
    on("pc-save", "click", () => { P.confirm = true; render(); });
    t.addEventListener("click", (e) => {
      const g = e.target.closest("button[data-go]"); if (g) { const b = document.querySelector(`.tabs button[data-tab="${g.dataset.go}"]`); if (b) b.click(); return; }
      const b = e.target.closest("button[data-list]"); if (!b || !window.JTPrep) return;
      const r = P.rows.find(x => x.vid === b.dataset.list); b.disabled = true;
      window.JTPrep.addToList({ variant_id: Number(r.vid), amazon_sku: "", dest: "shopify", source: "inventory" })
        .then((x) => { note("info", `Added ${esc(r.title)} (for the Shopify store) to ${x && x.where || "On The List"}.`); render(); },
              (err) => { b.disabled = false; note("bad", "Couldn't add it: " + esc(JT.message(err))); });
    });
    $("pc-inv").addEventListener("click", (e) => {
      if (e.target.closest("[data-extra]")) { P.issue = "extra"; P.where = "stock"; P.page = 0; $("pc-issue").value = "extra"; $("pc-where").value = "stock"; render(); $("pc-table").scrollIntoView({ block: "start" }); return; }
      if (e.target.closest("[data-nocost]")) { P.issue = "missing"; P.where = "stock"; P.page = 0; $("pc-issue").value = "missing"; $("pc-where").value = "stock"; render(); $("pc-table").scrollIntoView({ block: "start" }); return; }
      const go = e.target.closest("[data-go-fba]") ? "fba" : e.target.closest("[data-go-prep]") ? "prep" : null;
      if (go) { const b = document.querySelector(`.tabs button[data-tab="${go}"]`); if (b) b.click(); }
    });
    $("pc-confirm").addEventListener("click", (e) => { if (e.target.id === "pc-yes") save(); if (e.target.id === "pc-no") { P.confirm = false; render(); } });
    window.addEventListener("beforeunload", (e) => { if (P.edits.size) { e.preventDefault(); e.returnValue = ""; } });
  }

  bind();
  window.pcRender = () => render();
  window.addEventListener("jt:catalog", () => { if (!$("tab-costs").hidden) load(true); else P.shown = false; });
  window.pcShow = () => { if (!P.shown) { P.shown = true; load(false); } else render(); };
  window.JTCosts = { _state: P };
  if ((location.hash || "") === "#costs") setTimeout(() => window.pcShow(), 0);
})();
