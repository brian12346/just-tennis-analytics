(() => {
  // ===================== Product costs =====================
  // Every Shopify variant with its current unit cost, sorted by how much it sells (Shopify + Amazon) so the costs
  // that matter most get fixed first. Edited costs are queued in jt.cost_updates and written to Shopify by the sync.
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
    rows: null,             // [{vid, pid, sku, title, vendor, type, status, price, cost, qty, sUnits, sSales, aUnits, aSales, total}]
    pending: new Map(),     // vid -> queued cost not yet in Shopify
    edits: new Map(),       // vid -> typed text
    period: "12m", vendor: "all", cat: "all", status: "ACTIVE", issue: "all", sold: "sold", q: "", page: 0,
    saving: false, confirm: false,
  };
  const note = (kind, html) => { const n = $("pc-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; };

  function range() {
    const t = window.JTDate.today(), y = +t.slice(0, 4);
    if (P.period === "ytd") return [y + "-01-01", t];
    if (P.period === "ly") return [(y - 1) + "-01-01", (y - 1) + "-12-31"];
    if (P.period === "all") return ["2025-01-01", t];
    const d = new Date(Date.UTC(y, +t.slice(5, 7) - 1 - 11, 1));   // this month and the 11 before it
    return [d.toISOString().slice(0, 10), t];
  }

  async function load(refresh) {
    const id = ++P.reqId; P.loading = true; render();
    const [from, to] = range();
    $("pc-status").textContent = "Loading products and sales…";
    try {
      const [cat, ss, maps, months, pend] = await Promise.all([
        JT.rowsSplit(["variant_id::text", "product_id::text", "sku", "coalesce(nullif(display_name, ''), product_title)", "vendor", "product_type", "status", "price", "unit_cost", "inventory_qty"],
          "from jt.variants where removed_at is null", "variant_id", 4, refresh),
        JT.rowsSplit(["variant_id::text", "sum(units)", "sum(net)"],
          `from jt.shopify_sales where day between ${JT.day(from)} and ${JT.day(to)} and variant_id <> 0 group by variant_id`, "variant_id", 2, refresh),
        JT.rowsSplit(["data->>'sku'", "data->>'variantId'", "coalesce(data->>'units', '1')"], "from jt.docs where collection = 'amzmap' and data->>'kind' = 'shopify'", "id", 2, refresh),
        JT.rowsSplit(["id", "data->'skus'"], `from jt.docs where collection = 'amzmonths' and id between ${JT.q(from.slice(0, 7))} and ${JT.q(to.slice(0, 7))}`, "id", 4, refresh),
        JT.rows(["variant_id::text", "new_cost"], "from jt.cost_updates where status = 'pending' and new_cost is not null", true),
      ]);
      if (id !== P.reqId) return;
      const shop = new Map(ss.map(([v, u, n]) => [v, [+u || 0, +n || 0]]));
      // Amazon sales per variant: listing sales from the monthly summaries, through each listing's mapping
      const amz = new Map();
      const mp = new Map(maps.map(([sku, gid, u]) => [sku, [String(gid || "").split("/").pop(), +u || 1]]));
      for (const [, skus] of months) for (const k in skus || {}) {
        const t = mp.get(k); if (!t || !t[0]) continue;
        const a = amz.get(t[0]) || [0, 0]; a[0] += (skus[k][0] || 0) * t[1]; a[1] += skus[k][1] || 0; amz.set(t[0], a);
      }
      P.rows = cat.map(x => {
        const s = shop.get(x[0]) || [0, 0], a = amz.get(x[0]) || [0, 0];
        return { vid: x[0], pid: x[1], sku: x[2] || "", title: x[3] || "", vendor: x[4] || "", type: x[5] || "", status: x[6] || "",
          price: x[7] == null ? null : +x[7], cost: x[8] == null ? null : +x[8], qty: x[9],
          sUnits: s[0], sSales: s[1], aUnits: a[0], aSales: a[1], total: s[1] + a[1] };
      });
      P.pending = new Map(pend.map(([v, c]) => [v, +c]));
      fillFilters();
      $("pc-status").textContent = `${P.rows.length.toLocaleString()} Shopify variants · sales ${from} to ${to} (Shopify net sales + Amazon product sales)`;
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

  const costOf = (r) => P.edits.has(r.vid) ? money(P.edits.get(r.vid)) : P.pending.has(r.vid) ? P.pending.get(r.vid) : r.cost;
  function issueOf(r) {
    const c = costOf(r);
    if (c == null) return "missing";
    if (r.price > 0 && c > r.price) return "above";
    if (r.price > 0 && (r.price - c) / r.price < 0.10) return "low";
    if (r.price > 0 && (r.price - c) / r.price > 0.75) return "high";
    return "";
  }
  function visible() {
    if (!P.rows) return [];
    const q = P.q.trim().toLowerCase();
    return P.rows.filter(r => (P.vendor === "all" || r.vendor === P.vendor) && (P.cat === "all" || r.type === P.cat)
      && (P.status === "all" || r.status === P.status) && (P.sold === "all" || r.sSales || r.aSales || r.sUnits || r.aUnits)
      && (!q || (r.title + " " + r.sku + " " + r.vendor).toLowerCase().includes(q))
      && (P.issue === "all" || (P.issue === "edited" ? P.edits.has(r.vid) : P.issue === "issue" ? !!issueOf(r) : issueOf(r) === P.issue)))
      .sort((a, b) => b.total - a.total || (b.sUnits + b.aUnits) - (a.sUnits + a.aUnits) || a.title.localeCompare(b.title));
  }

  function renderKpis(rows) {
    const el = $("pc-kpis");
    const tot = rows.reduce((a, r) => a + r.total, 0);
    const bad = rows.filter(r => issueOf(r) === "missing" || issueOf(r) === "above");
    const warn = rows.filter(r => issueOf(r) === "low" || issueOf(r) === "high");
    const badS = bad.reduce((a, r) => a + r.total, 0), warnS = warn.reduce((a, r) => a + r.total, 0);
    el.innerHTML = [
      { l: "Sales in view", v: m0(tot), s: `${rows.length.toLocaleString()} variants · Shopify + Amazon` },
      { l: "No cost or cost above price", v: bad.length.toLocaleString(), s: tot ? `${m0(badS)} of sales (${pct(badS / tot)})` : "" },
      { l: "Margin under 10% or over 75%", v: warn.length.toLocaleString(), s: tot ? `${m0(warnS)} of sales (${pct(warnS / tot)}) — worth a check` : "" },
      { l: "Edited, not saved", v: P.edits.size.toLocaleString(), s: P.pending.size ? `${P.pending.size} saved, waiting for Shopify` : "type a cost to edit" },
    ].map(k => `<div class="kpi"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
  }

  let pageRows = [];
  function render() {
    if ($("tab-costs").hidden) return;
    const t = $("pc-table");
    if (!P.rows) { t.innerHTML = `<tbody><tr><td class="l muted">${P.loading ? "Loading…" : ""}</td></tr></tbody>`; $("pc-kpis").innerHTML = ""; return; }
    const rows = visible();
    renderKpis(rows);
    const pages = Math.max(1, Math.ceil(rows.length / PER)); if (P.page >= pages) P.page = pages - 1;
    pageRows = rows.slice(P.page * PER, P.page * PER + PER);
    const ae = document.activeElement, keep = ae && ae.dataset && ae.dataset.vid, sel = keep ? [ae.selectionStart, ae.selectionEnd] : null;
    t.innerHTML = `<thead><tr><th class="l">Product</th><th class="l">Vendor · category</th><th>Price</th><th>Unit cost</th><th>Margin</th><th>Shopify</th><th>Amazon</th><th>Total sales</th><th class="l">Status</th></tr></thead><tbody>${
      pageRows.map((r) => {
        const iss = issueOf(r), c = costOf(r), edited = P.edits.has(r.vid), v = edited ? P.edits.get(r.vid) : c == null ? "" : c.toFixed(2);
        const bad = edited && (c == null || isNaN(c) || c < 0);
        const mg = r.price > 0 && c != null && !isNaN(c) ? (r.price - c) / r.price : null;
        const pill = P.pending.has(r.vid) && !edited ? '<span class="pill warn">Saving to Shopify</span>'
          : iss === "missing" ? '<span class="pill miss">No cost</span>' : iss === "above" ? '<span class="pill miss">Cost above price</span>'
          : iss === "low" ? '<span class="pill warn">Low margin</span>' : iss === "high" ? '<span class="pill warn">High margin</span>' : '<span class="pill ok">OK</span>';
        return `<tr class="${iss === "missing" || iss === "above" ? "flag-bad" : iss ? "flag-warn" : ""}">
          <td class="l"><a class="olink" href="${ADMIN}/products/${esc(r.pid)}/variants/${esc(r.vid)}" target="_blank" rel="noopener">${esc(r.title)}</a><div class="meta"><span class="mono">${esc(r.sku) || "no SKU"}</span>${r.status !== "ACTIVE" ? " · " + esc(r.status.toLowerCase()) : ""}${r.qty != null ? " · " + r.qty + " on hand" : ""}</div></td>
          <td class="l">${esc(r.vendor)}<div class="meta">${esc(r.type || "—")}</div></td>
          <td>${m(r.price)}</td>
          <td><input class="pcin ${edited ? "edited" : ""} ${bad ? "bad" : ""}" data-vid="${esc(r.vid)}" value="${esc(v)}" inputmode="decimal" aria-label="Unit cost for ${esc(r.title)}">${edited && r.cost != null ? `<div class="meta">was ${m(r.cost)}</div>` : ""}</td>
          <td class="${mg != null && mg < 0 ? "neg" : ""}">${pct(mg)}</td>
          <td>${r.sSales ? m0(r.sSales) : '<span class="dim">—</span>'}<div class="meta">${r.sUnits ? Math.round(r.sUnits).toLocaleString() + " sold" : ""}</div></td>
          <td>${r.aSales ? m0(r.aSales) : '<span class="dim">—</span>'}<div class="meta">${r.aUnits ? Math.round(r.aUnits).toLocaleString() + " sold" : ""}</div></td>
          <td><b>${m0(r.total)}</b></td>
          <td class="l">${pill}</td></tr>`;
      }).join("") || `<tr><td class="l muted" colspan="9">No products match these filters.</td></tr>`}</tbody>`;
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
    on("pc-status", "change", (e) => { P.status = e.target.value; P.page = 0; render(); });
    on("pc-issue", "change", (e) => { P.issue = e.target.value; P.page = 0; render(); });
    on("pc-sold", "change", (e) => { P.sold = e.target.value; P.page = 0; render(); });
    on("pc-q", "input", (e) => { P.q = e.target.value; P.page = 0; clearTimeout(e.target._t); e.target._t = setTimeout(render, 200); });
    on("pc-period", "change", (e) => { P.period = e.target.value; P.page = 0; load(false); });
    on("pc-refresh", "click", () => load(true));
    on("pc-prev", "click", () => { P.page--; render(); $("pc-table").scrollIntoView({ block: "start" }); });
    on("pc-next", "click", () => { P.page++; render(); $("pc-table").scrollIntoView({ block: "start" }); });
    on("pc-discard", "click", () => { P.edits.clear(); P.confirm = false; render(); });
    on("pc-save", "click", () => { P.confirm = true; render(); });
    $("pc-confirm").addEventListener("click", (e) => { if (e.target.id === "pc-yes") save(); if (e.target.id === "pc-no") { P.confirm = false; render(); } });
    window.addEventListener("beforeunload", (e) => { if (P.edits.size) { e.preventDefault(); e.returnValue = ""; } });
  }

  bind();
  window.pcShow = () => { if (!P.shown) { P.shown = true; load(false); } else render(); };
  window.JTCosts = { _state: P };
  if ((location.hash || "") === "#costs") setTimeout(() => window.pcShow(), 0);
})();
