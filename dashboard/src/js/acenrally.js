(() => {
  // ===================== Ace n Rally =====================
  // Brian's second Shopify store (acenrally.com), sales only. Its sales come from Shopify Analytics into jt.anr_daily /
  // jt.anr_sales (sync jobs "acenrally" hourly and nightly; migration 071) and are costed with the matching Just Tennis
  // product (same SKU, else barcode, else a match set by hand) at today's Just Tennis cost — receiving and costs are
  // all done in Just Tennis.
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m = (n) => usd.format(n || 0), m0 = (n) => usd0.format(n || 0);
  const n0 = (x) => Math.round(x || 0).toLocaleString();
  const pct = (x) => x == null || !isFinite(x) ? "—" : (x * 100).toFixed(1) + "%";
  const num = (x) => Number(x) || 0;
  const JT = window.JT;
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const shortDay = (ds) => new Date(ds + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

  const A = { shown: false, loading: false, preset: "30", start: null, end: null, days: null, prods: null, unmatched: null, status: null, sort: "net", reqId: 0 };

  window.JTRange.seg("anr-rangeseg", "r");
  function setRange(r) {
    A.preset = r; [A.start, A.end] = window.JTRange.of(r);
    $("anr-start").value = A.start; $("anr-end").value = A.end;
    document.querySelectorAll("#anr-rangeseg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.r === r)));
  }
  const note = (kind, html) => { const n = $("anr-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; };

  async function load(refresh) {
    const id = ++A.reqId; A.loading = true; render();
    const s = JT.day(A.start), e = JT.day(A.end);
    try {
      const [days, prods, un, st, ship] = await Promise.all([
        JT.rows(["day::text", "orders", "gross", "discounts", "returns", "net", "shipping", "taxes", "total", "cogs", "gross_profit", "net_no_cost"],
          `from jt.v_anr_daily_costed where day between ${s} and ${e} order by day desc`, refresh),
        JT.rows(["s.product_title", "max(s.vendor)", "max(s.product_type)", "sum(s.units)", "sum(s.gross)", "sum(s.discounts)", "sum(s.net)", "sum(s.cogs)", "sum(s.net_no_cost)",
          "count(distinct s.order_id)", "bool_and(s.jt_variant_id is not null)", "bool_or(s.jt_variant_id is not null)", "max(v.product_id)::text",
          "max(coalesce(nullif(v.display_name, ''), v.product_title))"],
          `from jt.v_anr_sales_costed s left join jt.variants v on v.variant_id = s.jt_variant_id where s.day between ${s} and ${e} group by s.product_title`, refresh),
        JT.rows(["anr_variant_id::text", "sku", "barcode", "title"], "from jt.v_anr_variant_map where jt_variant_id is null and anr_variant_id in (select variant_id from jt.anr_sales) order by title", refresh),
        JT.rows(["job", "finished_at", "ok"], "from jt.v_sync_status where job like 'acenrally%'", refresh).catch(() => []),
        // ShipStation labels (shared account) on Ace n Rally orders, by order day (migration 074)
        JT.rows(["order_day::text", "sum(label_cost)", "count(*) filter (where labels > 0)", "count(*) filter (where labels = 0 and net > 0)"],
          `from jt.v_anr_order_shipping where order_day between ${s} and ${e} group by 1`, refresh).catch(() => []),
      ]);
      if (id !== A.reqId) return;
      const sh = new Map(ship.map(x => [x[0], { labels: num(x[1]), withLabel: num(x[2]), noLabel: num(x[3]) }]));
      A.days = days.map(x => ({ day: x[0], orders: num(x[1]), gross: num(x[2]), disc: num(x[3]), ret: num(x[4]), net: num(x[5]), ship: num(x[6]), tax: num(x[7]), total: num(x[8]),
        cogs: num(x[9]), gp: num(x[10]), nocost: num(x[11]), ...(sh.get(x[0]) || { labels: 0, withLabel: 0, noLabel: 0 }) }));
      A.prods = prods.map(x => ({ title: x[0] || "(Custom items)", vendor: x[1] || "", type: x[2] || "", units: num(x[3]), gross: num(x[4]), disc: num(x[5]), net: num(x[6]),
        cogs: num(x[7]), nocost: num(x[8]), orders: num(x[9]), all: !!x[10], any: !!x[11], pid: x[12] || "", jt: x[13] || "" }));
      A.unmatched = un.map(x => ({ vid: x[0], sku: x[1] || "", barcode: x[2] || "", title: x[3] || "" }));
      A.status = st;
      note("", "");
    } catch (err) { if (id === A.reqId) note("bad", esc(JT.message(err))); }
    finally { if (id === A.reqId) { A.loading = false; render(); } }
  }

  function render() {
    if ($("tab-anr").hidden) return;
    const st = $("anr-status");
    if (!A.days) { st.textContent = A.loading ? "Loading Ace n Rally sales…" : ""; return; }
    const last = (A.status || []).filter(r => r[2]).map(r => r[1]).sort().pop();
    if (!last && !A.days.length) {
      st.textContent = "";
      $("anr-kpis").innerHTML = ""; $("anr-days").innerHTML = ""; $("anr-prods").innerHTML = ""; $("anr-unm").hidden = true;
      note("info", "Ace n Rally isn't connected yet. Once its Shopify app is set up (secrets ACENRALLY_SHOP, ACENRALLY_CLIENT_ID and ACENRALLY_CLIENT_SECRET in GitHub), the hourly sync brings in its sales.");
      return;
    }
    st.textContent = `${window.JTRange.label(A.start, A.end)} · Shopify Analytics for acenrally.com · costed at Just Tennis cost (matched by SKU or barcode) · labels from ShipStation${last ? ` · synced ${new Date(last).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}${A.loading ? " · refreshing…" : ""}`;
    const D = A.days, sum = (f) => D.reduce((a, d) => a + f(d), 0);
    const net = sum(d => d.net), cogs = sum(d => d.cogs), gp = sum(d => d.gp), nc = sum(d => d.nocost), orders = sum(d => d.orders);
    const units = A.prods.reduce((a, p) => a + p.units, 0), costed = net - nc;
    const lab = sum(d => d.labels), chg = sum(d => d.ship), noLab = sum(d => d.noLabel), after = gp + chg - lab;
    $("anr-kpis").innerHTML = [
      { c: "sales", l: "Net sales", v: m0(net), s: `gross ${m0(sum(d => d.gross))} · discounts ${m0(-sum(d => d.disc))} · returns ${m0(-sum(d => d.ret))}` },
      { l: "Orders", v: n0(orders), s: `${n0(units)} units · ${orders ? m(net / orders) : "—"} per order` },
      { c: "cost", l: "Product cost", v: m0(cogs), s: "at Just Tennis cost" },
      { c: "sales", l: "Gross profit", v: `<span class="${gp < 0 ? "neg" : ""}">${m0(gp)}</span>`, s: `${costed > 0 ? pct(gp / costed) : "—"} margin on sales with a cost` },
      { c: "cost", l: "Shipping labels", v: m0(lab), s: `ShipStation · ${orders ? m(lab / orders) : "—"} per order · customers paid ${m0(chg)}${noLab ? ` · ${n0(noLab)} order${noLab === 1 ? "" : "s"} with no label` : ""}` },
      { c: "sales", l: "Profit after shipping", v: `<span class="${after < 0 ? "neg" : ""}">${m0(after)}</span>`, s: `gross profit + shipping charged − labels${costed > 0 ? ` · ${pct(after / costed)} of costed sales` : ""}` },
      { c: nc > 0.5 ? "warnk" : "", l: "Not costed", v: m0(nc), s: nc > 0.5 ? `net sales with no Just Tennis match · ${A.unmatched.length} product${A.unmatched.length === 1 ? "" : "s"} to match` : "every product matched" },
    ].map(k => `<div class="kpi ${k.c || ""}"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");

    $("anr-days").innerHTML = `<thead><tr><th class="l">Day</th><th>Orders</th><th>Gross</th><th>Discounts</th><th>Returns</th><th>Net sales</th><th>Shipping</th><th>Product cost</th><th>Gross profit</th><th>Margin</th><th>Labels</th><th>After shipping</th></tr></thead><tbody>${
      D.map(d => { const c = d.net - d.nocost, af = d.gp + d.ship - d.labels;
        return `<tr><td class="l">${shortDay(d.day)}</td><td>${n0(d.orders)}</td><td>${m(d.gross)}</td><td>${m(-d.disc)}</td><td>${m(-d.ret)}</td><td><b>${m(d.net)}</b></td><td>${m(d.ship)}</td>
          <td>${m(d.cogs)}${d.nocost > 0.5 ? `<div class="meta">${m(d.nocost)} not costed</div>` : ""}</td><td class="${d.gp < 0 ? "neg" : ""}">${m(d.gp)}</td><td>${c > 0 ? pct(d.gp / c) : "—"}</td>
          <td>${m(d.labels)}${d.noLabel ? `<div class="meta">${n0(d.noLabel)} without a label</div>` : ""}</td><td class="${af < 0 ? "neg" : ""}">${m(af)}</td></tr>`; }).join("")
      || '<tr><td class="l dim" colspan="12">No sales in this range.</td></tr>'}</tbody>${D.length ? `<tfoot><tr><td class="l">Total</td><td>${n0(orders)}</td><td>${m(sum(d => d.gross))}</td><td>${m(-sum(d => d.disc))}</td><td>${m(-sum(d => d.ret))}</td><td><b>${m(net)}</b></td><td>${m(sum(d => d.ship))}</td><td>${m(cogs)}</td><td>${m(gp)}</td><td>${costed > 0 ? pct(gp / costed) : "—"}</td><td>${m(lab)}</td><td>${m(after)}</td></tr></tfoot>` : ""}`;

    const key = { net: (p) => p.net, units: (p) => p.units, profit: (p) => p.net - p.nocost - p.cogs, margin: (p) => (p.net - p.nocost) > 0 ? (p.net - p.nocost - p.cogs) / (p.net - p.nocost) : -9 }[A.sort];
    const P = [...A.prods].sort((a, b) => key(b) - key(a));
    $("anr-prods").innerHTML = `<thead><tr><th class="l">Product (Ace n Rally)</th><th class="l">Just Tennis product</th><th>Units</th><th>Orders</th><th>Net sales</th><th>Cost</th><th>Gross profit</th><th>Margin</th></tr></thead><tbody>${
      P.slice(0, 200).map(p => { const c = p.net - p.nocost, g = c - p.cogs;
        return `<tr><td class="l">${esc(p.title)}<div class="meta">${esc([p.vendor, p.type].filter(Boolean).join(" · "))}</div></td>
          <td class="l">${p.any ? `${p.pid ? `<a href="${ADMIN}/products/${encodeURIComponent(p.pid)}" target="_blank" rel="noopener">${esc(p.jt)}</a>` : esc(p.jt)}${p.all ? "" : '<div class="meta">some variants not matched</div>'}` : '<span class="pill miss">Not matched</span>'}</td>
          <td>${n0(p.units)}</td><td>${n0(p.orders)}</td><td><b>${m(p.net)}</b></td><td>${c > 0.005 ? m(p.cogs) : "—"}</td><td class="${g < 0 ? "neg" : ""}">${c > 0.005 ? m(g) : "—"}</td><td>${c > 0.005 ? pct(g / c) : "—"}</td></tr>`; }).join("")
      || '<tr><td class="l dim" colspan="8">No product sales in this range.</td></tr>'}</tbody>`;

    $("anr-unm").hidden = !A.unmatched.length;
    $("anr-unm-list").innerHTML = A.unmatched.map(u => `<li><b>${esc(u.title)}</b> <span class="mono small">${esc(u.sku || "no SKU")}${u.barcode ? " · " + esc(u.barcode) : ""}</span></li>`).join("");
  }

  function bind() {
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on("anr-rangeseg", "click", (e) => { const b = e.target.closest("button[data-r]"); if (!b) return; setRange(b.dataset.r); load(false); });
    const custom = () => { const s = $("anr-start").value, e = $("anr-end").value; if (!s || !e || s > e) return; A.preset = ""; A.start = s; A.end = e;
      document.querySelectorAll("#anr-rangeseg button").forEach(b => b.setAttribute("aria-pressed", "false")); load(false); };
    on("anr-start", "change", custom); on("anr-end", "change", custom);
    on("anr-refresh", "click", () => load(true));
    on("anr-sort", "change", (e) => { A.sort = e.target.value; render(); });
  }

  setRange(A.preset);
  bind();
  window.anrShow = () => { if (!A.shown) { A.shown = true; load(false); } else render(); };
  window.JTAnr = { load, _state: A };
  if ((location.hash || "") === "#anr") setTimeout(() => window.anrShow(), 0);
})();
