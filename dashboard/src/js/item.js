// Item detail popup (Nov 4, Brian: on Out of stock, "when you click on a item row, we should pop up the item detail
// page that has all the sales, cost, and inventory history on that item"). Any page can open it:
// window.JTItem.open(variantId). One Shopify variant:
//   Sales     — every channel (Nov 4, Brian: "include sales for all channels including fba … and for all asins"):
//               Just Tennis (jt.shopify_sales), Ace N Rally (jt.v_anr_sales_costed), and Amazon FBA and FBM from every
//               seller SKU mapped to the variant (jt.mv_amz_sku_cost → jt.amazon_sku_daily; units × the map's units per
//               listing; a SKU-day with FBA fees is FBA, else FBM). 30 / 90 / 365 days, a 13-month chart by channel, and
//               the ASINs and SKUs (jt.amazon_skus()).
//   Cost      — Shopify cost changes (jt.variant_cost_changes) and every purchase: invoice lines (vendor, invoice, qty,
//               unit cost) and PO lines.
//   Inventory — on hand, on order, and the history: went to 0 (jt.stockouts), physical counts (jt.stock_counts),
//               Shopify stock changes made in Seller Sage (receiving, counts, transfers; jt.shopify_stock_moves) and
//               prep-center moves (jt.prep_moves). Above that, Shopify on hand by month (jt.inventory_monthly, migration
//               213) as bars, and a month table with what came in and went out and the burn down / burn up rate per day.
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const n0 = (x) => Math.round(Number(x) || 0).toLocaleString();
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }), usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const m2 = (x) => x == null || x === "" || isNaN(x) ? "—" : usd.format(Number(x));
  const m0 = (x) => x == null || isNaN(x) ? "—" : usd0.format(Number(x));
  const day = (d) => d ? new Date(String(d).slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
  const when = (t) => { const d = window.JTDate ? window.JTDate.parseTime(t) : new Date(t); return !t || isNaN(d) ? "" : d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" }); };
  const who = (e) => String(e || "").replace(/@.*/, "");
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const PO_ST = { draft: "Draft", ordered: "Ordered", invoiced: "Invoiced", partial: "Partly received", received: "Received", qb_ready: "Received", complete: "Received" };
  const KIND = { receive: "Received", count: "Physical count", reconcile: "Reconciled", to_shopify: "From prep center", from_shopify: "To prep center", unreceive: "Un-received",
    adjust: "Adjusted", ship: "Shipped to Amazon", seed: "Starting count", assign: "Assigned", unship: "Un-shipped", correction: "Correction" };
  const M = { vid: null, data: null, err: null, tab: "sales" };

  function host() {
    let d = document.getElementById("jt-item"); if (d) return d;
    d = document.createElement("div"); d.className = "modal"; d.id = "jt-item"; d.hidden = true;
    d.innerHTML = '<div class="modal-card it-card" id="jt-item-card" role="dialog" aria-modal="true" aria-label="Item detail"></div>';
    document.body.appendChild(d);
    d.addEventListener("click", (e) => {
      if (e.target === d) return close();
      const b = e.target.closest("[data-it]"); if (!b) return;
      if (b.dataset.it === "close") return close();
    });
    d.addEventListener("click", (e) => { const t = e.target.closest("[data-it-tab]"); if (t) { M.tab = t.dataset.itTab; render(); } });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !d.hidden) { e.preventDefault(); close(); } });
    return d;
  }
  function close() { const d = document.getElementById("jt-item"); if (d) d.hidden = true; document.body.classList.remove("modal-open"); M.vid = null; }

  async function open(vid) {
    M.vid = String(vid); M.data = null; M.err = null; M.tab = "sales";
    const d = host(); d.hidden = false; document.body.classList.add("modal-open"); render();
    const v = window.JT.int(vid), mine = M.vid;
    try {
      const T = "(now() at time zone 'America/Los_Angeles')::date";
      const U = `(select day, 'jt' ch, units, net, net - net_no_cost - cogs profit from jt.shopify_sales where variant_id = ${v}
          union all select day, 'anr', units, net, net - net_no_cost - cogs from jt.v_anr_sales_costed where jt_variant_id = ${v}
          union all select k.day, case when k.fbafees <> 0 then 'fba' else 'fbm' end, k.units * coalesce(m.map_units, 1), k.sales,
                           case when m.cost is null then 0 else k.net - k.units * m.cost end
            from jt.mv_amz_sku_cost m join jt.amazon_sku_daily k on k.sku = m.sku where m.variant_id = ${v} and k.lines > 0) u`;
      const W = (n) => `day > ${T} - ${n}`;
      const [vr, sum, mon, skus, ksum, costs, bought, pos, inv, invm] = await Promise.all([
        window.JT.rows(["v.product_title", "v.variant_title", "v.sku", "v.barcode", "v.vendor", "v.product_type", "v.status", "v.price::text", "v.unit_cost::text", "v.product_id::text",
          "jt.shopify_qty_now(v.variant_id)::text", "v.tracked::text"], `from jt.variants v where v.variant_id = ${v}`, true),
        window.JT.rows(["ch"].concat([30, 90, 365].flatMap(n => [`coalesce(sum(units) filter (where ${W(n)}), 0)::text`, `coalesce(sum(net) filter (where ${W(n)}), 0)::text`,
          `coalesce(sum(profit) filter (where ${W(n)}), 0)::text`]), ["max(day)::text", "min(day)::text", "coalesce(sum(units), 0)::text"]),
          `from ${U} group by ch`, true),
        window.JT.rows(["to_char(date_trunc('month', day), 'YYYY-MM')", "ch", "sum(units)::text", "sum(net)::text"],
          `from ${U} where day >= (date_trunc('month', current_date) - interval '12 months')::date group by 1, 2 order by 1`, true),
        window.JT.rows(["m.sku", "coalesce(s.asin, '')", "coalesce(s.title, '')", "coalesce(s.ch, '')", "coalesce(s.amz_status, '')", "coalesce(s.status, s.suggest, '')", "coalesce(s.ful, s.suggest_ful, '')",
          "coalesce(s.fba_available, 0)::text", "coalesce(s.fba_inbound, 0)::text", "coalesce(s.awd, 0)::text", "coalesce(s.qty, 0)::text", "coalesce(s.price, 0)::text", "coalesce(m.map_units, 1)::text"],
          `from jt.mv_amz_sku_cost m left join jt.amazon_skus() s on s.sku = m.sku where m.variant_id = ${v}`, true).catch(() => []),
        window.JT.rows(["k.sku"].concat([30, 90, 365].map(n => `coalesce(sum(k.units) filter (where k.day > ${T} - ${n}), 0)::text`),
          [`coalesce(sum(k.sales) filter (where k.day > ${T} - 365), 0)::text`, "max(k.day)::text", "bool_or(k.fbafees <> 0)::text"]),
          `from jt.mv_amz_sku_cost m join jt.amazon_sku_daily k on k.sku = m.sku where m.variant_id = ${v} and k.lines > 0 group by 1`, true).catch(() => []),
        window.JT.rows(["changed_on::text", "old_cost::text", "new_cost::text", "price::text", "coalesce(flag, '')"],
          `from jt.variant_cost_changes where variant_id = ${v} order by changed_on desc, id desc limit 60`, true).catch(() => []),
        window.JT.rows(["i.id::text", "coalesce(i.invoice_date, i.created_at::date)::text", "i.vendor", "i.invoice_no", "sum(l.qty)::text", "(sum(l.amount) / nullif(sum(l.qty), 0))::text",
          "max(l.unit_cost)::text", "i.order_id::text", "(select r.qty from jt.invoice_receipts r where r.invoice_id = i.id and r.variant_id = " + v + ")::text"],
          `from jt.invoice_lines l join jt.invoices i on i.id = l.invoice_id where l.variant_id = ${v} and l.match_how <> 'skip' group by i.id order by 2 desc nulls last, i.id desc limit 40`, true).catch(() => []),
        window.JT.rows(["o.id::text", "o.vendor", "o.po_no", "o.status", "sum(l.qty_ordered)::text", "sum(l.qty_received)::text", "max(l.unit_cost)::text", "coalesce((o.stage_at->>'ordered')::date, o.created_at::date)::text",
          "max(coalesce(l.eta, o.expected_on))::text"],
          `from jt.prep_order_lines l join jt.prep_orders o on o.id = l.order_id where l.variant_id = ${v} group by o.id order by o.id desc limit 30`, true).catch(() => []),
        window.JT.rows(["at::text", "src", "kind", "chg::text", "after::text", "note", "who", "st"],
          `from (select (s.day + time '23:59')::timestamp at time zone 'America/Los_Angeles' at, 'oos' src, 'stockout' kind, -s.start_units chg, s.end_units after,
                        case when s.sold >= s.start_units then 'last units sold' when s.sold = 0 then 'adjusted to 0' else s.sold || ' sold, rest adjusted' end note, '' who, '' st
                   from jt.stockouts s where s.variant_id = ${v}
                 union all select c.at, 'count', 'count', null, c.counted, case when c.shopify_had is not null then 'Shopify had ' || c.shopify_had else '' end, c.by, ''
                   from jt.stock_counts c where c.variant_id = ${v}
                 union all select m.created_at, 'shopify', m.kind, m.delta, case when m.status = 'done' and m.shopify_before is not null then m.shopify_before + m.delta end, m.reason, m.created_by, m.status
                   from jt.shopify_stock_moves m where m.variant_id = ${v} and coalesce(m.set_to, -1) < 0
                 union all select p.at, 'prep', p.kind, p.qty_change, p.qty_after, coalesce(nullif(p.note, ''), p.shipment), p.by_user, ''
                   from jt.prep_moves p where p.variant_id = ${v}) t order by at desc limit 150`, true).catch(() => []),
        window.JT.rows(["to_char(month, 'YYYY-MM')", "start_units::text", "end_units::text", "sold::text"],
          `from jt.inventory_monthly where variant_id = ${v} and month >= (date_trunc('month', current_date) - interval '12 months')::date order by month`, true).catch(() => []),
      ]);
      if (M.vid !== mine) return;
      const x = vr[0] || [];
      const chans = new Map(sum.map(r => [r[0], { win: [0, 1, 2].map(i => ({ units: +r[1 + i * 3] || 0, net: +r[2 + i * 3] || 0, profit: +r[3 + i * 3] || 0 })), last: r[10] || "", first: r[11] || "", all: +r[12] || 0 }]));
      const ks = new Map(ksum.map(r => [r[0], { u30: +r[1] || 0, u90: +r[2] || 0, u365: +r[3] || 0, net365: +r[4] || 0, last: r[5] || "", fba: r[6] === "true" }]));
      const tot = (f) => [...chans.values()].reduce((a, c) => a + f(c), 0);
      const lastOf = [...chans.values()].map(c => c.last).filter(Boolean).sort(), firstOf = [...chans.values()].map(c => c.first).filter(Boolean).sort();
      const onOrder = pos.filter(p => ["ordered", "invoiced", "partial"].includes(p[3])).reduce((a, p) => a + Math.max(0, (+p[4] || 0) - (+p[5] || 0)), 0);
      M.data = {
        title: x[0] || "", vt: x[1] && x[1] !== "Default Title" ? x[1] : "", sku: x[2] || "", upc: x[3] || "", vendor: x[4] || "", type: x[5] || "", status: x[6] || "",
        price: x[7] == null ? null : +x[7], cost: x[8] == null ? null : +x[8], pid: x[9] || "", qty: +x[10] || 0, tracked: x[11] !== "false", onOrder,
        win: [30, 90, 365].map((n, i) => ({ n, units: tot(c => c.win[i].units), net: tot(c => c.win[i].net), profit: tot(c => c.win[i].profit) })),
        last: lastOf[lastOf.length - 1] || "", first: firstOf[0] || "", allUnits: tot(c => c.all), chans,
        months: mon.map(r => ({ mo: r[0], ch: r[1], units: +r[2] || 0, net: +r[3] || 0 })),
        skus: skus.map(r => ({ sku: r[0], asin: r[1], title: r[2], lch: r[3], amz: r[4], status: r[5], ful: r[6] || r[3] || (ks.get(r[0]) && ks.get(r[0]).fba ? "FBA" : ""), fba: (+r[7] || 0) + (+r[8] || 0), awd: +r[9] || 0,
          qty: +r[10] || 0, price: +r[11] || 0, per: +r[12] || 1, sold: ks.get(r[0]) || { u30: 0, u90: 0, u365: 0, net365: 0, last: "" } })),
        costs: costs.map(r => ({ day: r[0], old: r[1] == null ? null : +r[1], neu: r[2] == null ? null : +r[2], price: r[3] == null ? null : +r[3], flag: r[4] })),
        bought: bought.map(r => ({ id: r[0], day: r[1], vendor: r[2] || "", no: r[3] || "", qty: +r[4] || 0, unit: r[5] == null ? (r[6] == null ? null : +r[6]) : +r[5], list: r[6] == null ? null : +r[6], oid: r[7], got: r[8] == null ? null : +r[8] })),
        pos: pos.map(r => ({ id: r[0], vendor: r[1] || "", po: r[2] || "", st: r[3] || "", ordered: +r[4] || 0, got: +r[5] || 0, cost: r[6] == null ? null : +r[6], day: r[7] || "", eta: r[8] || "" })),
        invm: invm.map(r => ({ mo: r[0], start: +r[1] || 0, end: +r[2] || 0, sold: +r[3] || 0 })),
        inv: inv.map(r => ({ at: r[0], src: r[1], kind: r[2], chg: r[3] == null ? null : +r[3], after: r[4] == null ? null : +r[4], note: r[5] || "", who: r[6] || "", st: r[7] || "" })),
      };
    } catch (e) { if (M.vid === mine) M.err = e; }
    if (M.vid === mine) render();
  }

  function render() {
    const card = document.getElementById("jt-item-card"); if (!card) return;
    const D = M.data;
    const head = (t, sub) => `<div class="it-head"><div><span class="eyebrow">${sub || "Item detail"}</span><h2>${t}</h2></div><button class="btn" type="button" data-it="close" title="Close (Esc)">Close</button></div>`;
    if (M.err) { card.innerHTML = head("Item") + `<div class="note bad">Couldn't load it: ${esc((window.JT.message && window.JT.message(M.err)) || M.err.message || M.err)}</div>`; return; }
    if (!D) { card.innerHTML = head("Loading…") + '<div class="muted small" style="padding:12px">Loading sales, cost and inventory history…</div>'; return; }
    const margin = D.price > 0 && D.cost != null ? (D.price - D.cost) / D.price : null;
    const k = (l, v, s, c) => `<div class="kpi ${c || ""}"><span class="eyebrow">${l}</span><span class="v">${v}</span><span class="s">${s}</span></div>`;
    const w = D.win;
    const top = `${head(`<a class="olink" href="${ADMIN}/products/${esc(D.pid)}/variants/${esc(M.vid)}" target="_blank" rel="noopener">${esc(D.title)}</a>${D.vt ? ` <span class="it-vt">${esc(D.vt)}</span>` : ""}`,
        `${esc(D.vendor || "No vendor")} · ${esc(D.type || "No category")}${D.status && D.status !== "ACTIVE" ? ` · ${esc(D.status.toLowerCase())}` : ""}`)}
      <div class="small muted it-ids"><span class="mono">${esc(D.sku || "no SKU")}</span>${D.upc ? ` · UPC <span class="mono">${esc(D.upc)}</span>` : ""} · price <b>${m2(D.price)}</b> · cost <b>${m2(D.cost)}</b>${margin != null ? ` · margin <b>${Math.round(margin * 100)}%</b>` : ""}</div>
      <section class="kpis it-kpis">
        ${k("On hand", n0(D.qty), `${D.tracked ? "Shopify available now" : "not tracked in Shopify"}${amzStock(D) ? ` · ${n0(amzStock(D))} at Amazon` : ""}`, D.qty <= 0 ? "warnk" : "")}
        ${k("On order", n0(D.onOrder), "placed POs, not received")}
        ${k("Sold 30 days", n0(w[0].units), `${m0(w[0].net)} net`)}
        ${k("Sold 90 days", n0(w[1].units), `${m0(w[1].net)} net · ${m0(w[1].profit)} profit`)}
        ${k("Sold 12 months", n0(w[2].units), `${m0(w[2].net)} net · ${m0(w[2].profit)} profit`)}
        ${k("Last sold", D.last ? day(D.last) : "never", D.first ? `selling since ${day(D.first)}` : "")}
      </section>
      <div class="seg it-tabs" role="tablist">${[["sales", "Sales"], ["cost", "Cost"], ["inv", "Inventory"]].map(([t, n]) => `<button type="button" role="tab" data-it-tab="${t}" aria-pressed="${M.tab === t}" aria-selected="${M.tab === t}">${n}</button>`).join("")}</div>`;
    card.innerHTML = top + `<div class="it-body">${M.tab === "sales" ? sales(D) : M.tab === "cost" ? cost(D) : inventory(D)}</div>`;
  }

  const CH = [["jt", "Just Tennis"], ["anr", "Ace N Rally"], ["fba", "Amazon FBA"], ["fbm", "Amazon FBM"]];
  const amzStock = (D) => D.skus.reduce((a, k) => a + (k.fba + k.awd) * k.per, 0);
  const STAT = { active: "Active", inactive_oos: "Inactive – out of stock", inactive_other: "Inactive – other", closed: "Closed" };

  function sales(D) {
    const months = []; { const d0 = new Date(); for (let i = 12; i >= 0; i--) { const d = new Date(d0.getFullYear(), d0.getMonth() - i, 1); months.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0")); } }
    const by = new Map(); for (const x of D.months) { const o = by.get(x.mo) || { net: 0 }; o[x.ch] = (o[x.ch] || 0) + x.units; o.net += x.net; by.set(x.mo, o); }
    const used = CH.filter(([c]) => D.chans.has(c));
    const rows = months.map(mo => { const o = by.get(mo) || { net: 0 }; return { mo, o, tot: CH.reduce((a, [c]) => a + (o[c] || 0), 0) }; });
    const max = Math.max(1, ...rows.map(r => r.tot));
    const bars = rows.map(r => { const lab = new Date(r.mo + "-15").toLocaleDateString("en-US", { month: "short" });
      const segs = CH.slice().reverse().filter(([c]) => r.o[c] > 0).map(([c]) => `<span class="it-seg it-${c}" style="height:${(r.o[c] / r.tot * 100).toFixed(1)}%"></span>`).join("");
      const tip = `${lab} ${r.mo.slice(0, 4)}: ${n0(r.tot)} sold${used.length > 1 ? " (" + CH.filter(([c]) => r.o[c] > 0).map(([c, n]) => `${n} ${n0(r.o[c])}`).join(", ") + ")" : ""} · ${m0(r.o.net)} net`;
      return `<div class="oos-bar" title="${esc(tip)}"><span class="oos-bv">${r.tot ? n0(r.tot) : ""}</span><span class="oos-bf it-stack" style="height:${Math.round(r.tot / max * 100)}%">${segs}</span><span class="oos-bl">${esc(lab)}</span></div>`; }).join("");
    const avg = (wn) => wn.units > 0 ? m2(wn.net / wn.units) : "—";
    const key = used.map(([c, n]) => `<span class="it-key it-${c}"></span> ${n}`).join(" &nbsp; ");
    const chRow = ([c, n]) => { const x = D.chans.get(c);
      return `<tr><td class="l"><span class="it-key it-${c}"></span> ${n}</td>${x.win.map(wn => `<td>${n0(wn.units)}<div class="meta">${m0(wn.net)}</div></td>`).join("")}<td class="${x.win[2].profit < 0 ? "neg" : ""}">${m0(x.win[2].profit)}</td><td class="l small muted">${x.last ? day(x.last) : ""}</td></tr>`; };
    const chTbl = used.length ? `<div class="tbl-wrap"><table class="it-t"><thead><tr><th class="l">Channel</th><th>30 days</th><th>90 days</th><th>12 months</th><th>Profit 12 mo</th><th class="l">Last sold</th></tr></thead><tbody>${used.map(chRow).join("")}
        <tr class="it-tot"><td class="l"><b>All channels</b></td>${D.win.map(wn => `<td><b>${n0(wn.units)}</b><div class="meta">${m0(wn.net)}</div></td>`).join("")}<td class="${D.win[2].profit < 0 ? "neg" : ""}"><b>${m0(D.win[2].profit)}</b></td><td class="l small muted">${D.last ? day(D.last) : ""}</td></tr></tbody></table></div>`
      : '<div class="muted small">No sales recorded on any channel.</div>';
    return `<div class="row small"><b>Units sold by month</b><span class="muted">${key}</span></div>
      <div class="oos-bars">${bars}</div>
      <h3 class="h3">By channel</h3>${chTbl}
      <div class="tbl-wrap"><table class="it-t"><thead><tr><th class="l">All channels</th><th>Units</th><th>Net sales</th><th>Avg price</th><th>Profit</th></tr></thead><tbody>
        ${D.win.map(wn => `<tr><td class="l">Last ${wn.n === 365 ? "12 months" : wn.n + " days"}</td><td>${n0(wn.units)}</td><td>${m0(wn.net)}</td><td>${avg(wn)}</td><td class="${wn.profit < 0 ? "neg" : ""}">${m0(wn.profit)}</td></tr>`).join("")}
        <tr><td class="l">All time</td><td>${n0(D.allUnits)}</td><td colspan="3" class="muted small">${D.first ? `since ${day(D.first)}` : ""}</td></tr></tbody></table></div>
      ${asins(D)}
      <div class="muted small">Units are of this item (a 2-pack listing sold once counts 2). Profit = net sales − cost of goods; for Amazon it's after Amazon's selling and FBA fees. Sales recorded without a cost are left out of profit. Amazon sales count every seller SKU mapped to this item.</div>`;
  }

  function asins(D) {
    if (!D.skus.length) return `<h3 class="h3">Amazon ASINs</h3><div class="muted small">No Amazon listings are mapped to this item. Map them on Setup › Amazon mapping.</div>`;
    const g = new Map(); for (const k of D.skus) { const a = k.asin || ""; if (!g.has(a)) g.set(a, []); g.get(a).push(k); }
    const list = [...g.entries()].map(([a, L]) => ({ a, L: L.sort((x, y) => y.sold.u365 - x.sold.u365 || x.sku.localeCompare(y.sku)), u: L.reduce((s, k) => s + k.sold.u365 * k.per, 0) })).sort((x, y) => y.u - x.u);
    const rows = list.map(({ a, L }) => {
      const t = L.find(k => k.title);
      const head = `<tr class="it-asin"><td class="l" colspan="8">${a ? `<a class="olink mono" href="https://www.amazon.com/dp/${esc(a)}" target="_blank" rel="noopener">${esc(a)}</a>` : '<span class="muted">No ASIN</span>'}${t ? ` <span class="small muted">${esc(t.title.slice(0, 90))}</span>` : ""}</td></tr>`;
      return head + L.map(k => `<tr><td class="l"><span class="mono small">${esc(k.sku)}</span>${k.per !== 1 ? ` <span class="pill other" title="Units of this item per listing unit">×${+k.per.toFixed(2)}</span>` : ""}</td>
        <td class="l">${k.ful ? `<span class="pill ${k.ful === "FBA" ? "ok" : "pos"}">${esc(k.ful)}</span>` : ""}</td>
        <td class="l small">${esc(STAT[k.status] || k.status || k.amz || "")}${k.price ? ` <span class="muted">· ${m2(k.price)}</span>` : ""}</td>
        <td title="FBA available + inbound${k.awd ? ", plus AWD" : ""}">${k.fba || k.awd ? n0(k.fba + k.awd) : '<span class="dim">—</span>'}</td>
        <td>${n0(k.sold.u30)}</td><td>${n0(k.sold.u90)}</td><td>${n0(k.sold.u365)}<div class="meta">${m0(k.sold.net365)}</div></td><td class="l small muted">${k.sold.last ? day(k.sold.last) : ""}</td></tr>`).join("");
    }).join("");
    return `<h3 class="h3">Amazon ASINs · ${g.size} ASIN${g.size === 1 ? "" : "s"}, ${D.skus.length} seller SKU${D.skus.length === 1 ? "" : "s"}</h3>
      <div class="tbl-wrap"><table class="it-t"><thead><tr><th class="l">Seller SKU</th><th class="l">Ships</th><th class="l">Status</th><th>FBA stock</th><th>Sold 30d</th><th>90d</th><th>12 mo</th><th class="l">Last sold</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function cost(D) {
    const ch = D.costs.length ? `<table class="it-t"><thead><tr><th class="l">Date</th><th>From</th><th>To</th><th>Price then</th><th class="l">Note</th></tr></thead><tbody>${D.costs.map(c =>
        `<tr><td class="l">${esc(day(c.day))}</td><td>${m2(c.old)}</td><td><b>${m2(c.neu)}</b></td><td>${m2(c.price)}</td><td class="l small muted">${esc(c.flag)}</td></tr>`).join("")}</tbody></table>`
      : '<div class="muted small">No cost changes recorded.</div>';
    const bo = D.bought.length ? `<table class="it-t"><thead><tr><th class="l">Date</th><th class="l">Vendor</th><th class="l">Invoice</th><th>Qty</th><th>Unit cost</th><th>Received</th></tr></thead><tbody>${D.bought.map(b =>
        `<tr><td class="l">${esc(day(b.day))}</td><td class="l">${esc(b.vendor)}</td><td class="l"><a class="olink" href="#invoices/${esc(b.id)}" data-it="close">${esc(b.no || "#" + b.id)}</a>${b.oid ? ` · <a class="olink" href="#po/${esc(b.oid)}" data-it="close">PO</a>` : ""}</td><td>${n0(b.qty)}</td><td title="What each unit cost with any free units counted in">${m2(b.unit)}${b.list != null && b.unit != null && Math.abs(b.list - b.unit) >= 0.005 ? `<div class="small muted">list ${m2(b.list)}</div>` : ""}</td><td>${b.got == null ? '<span class="dim">—</span>' : n0(b.got)}</td></tr>`).join("")}</tbody></table>`
      : '<div class="muted small">No invoices for this product yet.</div>';
    const po = D.pos.length ? `<table class="it-t"><thead><tr><th class="l">Ordered</th><th class="l">PO</th><th class="l">Stage</th><th>Ordered</th><th>Received</th><th>Unit cost</th></tr></thead><tbody>${D.pos.map(p =>
        `<tr><td class="l">${esc(day(p.day))}</td><td class="l"><a class="olink" href="#po/${esc(p.id)}" data-it="close">${esc(p.vendor)} ${esc(p.po || "#" + p.id)}</a></td><td class="l"><span class="pill ${["ordered", "invoiced", "partial"].includes(p.st) ? "warn" : p.st === "draft" ? "pos" : "ok"}">${esc(PO_ST[p.st] || p.st)}</span>${p.eta && ["ordered", "invoiced", "partial"].includes(p.st) ? ` <span class="small muted">ETA ${esc(day(p.eta))}</span>` : ""}</td><td>${n0(p.ordered)}</td><td>${n0(p.got)}</td><td>${m2(p.cost)}</td></tr>`).join("")}</tbody></table>`
      : '<div class="muted small">No purchase orders with this product.</div>';
    return `<h3 class="h3">Bought · invoices</h3><div class="tbl-wrap">${bo}</div>
      <h3 class="h3">Purchase orders</h3><div class="tbl-wrap">${po}</div>
      <h3 class="h3">Cost in Shopify · changes</h3><div class="tbl-wrap">${ch}</div>`;
  }

  function invHistory(D) {
    const months = []; { const d0 = new Date(); for (let i = 12; i >= 0; i--) { const d = new Date(d0.getFullYear(), d0.getMonth() - i, 1); months.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0")); } }
    if (!D.invm.length) return `<h3 class="h3">On hand by month</h3><div class="muted small">Shopify's inventory history for this item isn't loaded yet. The sync fills the last 13 months on its next hourly run.</div>`;
    const by = new Map(D.invm.map(x => [x.mo, x]));
    const now = new Date(), cur = months[months.length - 1];
    const daysIn = (mo) => mo === cur ? now.getDate() : new Date(+mo.slice(0, 4), +mo.slice(5, 7), 0).getDate();
    const rows = months.map(mo => { const x = by.get(mo); if (!x) return { mo, none: true };
      const got = x.end - x.start + x.sold, d = daysIn(mo);
      return { mo, ...x, got, net: x.end - x.start, d, down: x.sold / d, up: Math.max(0, got) / d, cover: x.sold > 0 ? x.end / (x.sold / d) : null }; });
    const first = rows.findIndex(r => !r.none), shown = rows.slice(Math.max(0, first));
    const max = Math.max(1, ...shown.map(r => r.none ? 0 : Math.max(r.end, r.start)));
    const lab = (mo, y) => new Date(mo + "-15").toLocaleDateString("en-US", y ? { month: "short", year: "numeric" } : { month: "short" });
    const bars = rows.map(r => r.none ? `<div class="oos-bar"><span class="oos-bv"></span><span class="oos-bf it-inv-none" style="height:1px"></span><span class="oos-bl">${esc(lab(r.mo))}</span></div>`
      : `<div class="oos-bar" title="${esc(lab(r.mo, true))}: ${n0(r.start)} at the start, +${n0(Math.max(0, r.got))} in, −${n0(r.sold)} sold, ${n0(r.end)} at the ${r.mo === cur ? "moment" : "end"}"><span class="oos-bv">${n0(r.end)}</span><span class="oos-bf it-inv${r.mo === cur ? " it-inv-now" : ""}" style="height:${Math.max(1, Math.round(r.end / max * 100))}%"></span><span class="oos-bl">${esc(lab(r.mo))}</span></div>`).join("");
    // the last 90 days or so: the last 3 months with data, this one included
    const recent = shown.filter(r => !r.none).slice(-3), rd = recent.reduce((a, r) => a + r.d, 0);
    const down = rd ? recent.reduce((a, r) => a + r.sold, 0) / rd : 0, up = rd ? recent.reduce((a, r) => a + Math.max(0, r.got), 0) / rd : 0;
    const rate = (x) => x >= 10 ? n0(x) : x >= 0.1 ? x.toFixed(1) : x > 0 ? x.toFixed(2) : "0";
    const cover = down > 0 ? D.qty / down : null;
    const sum = `<div class="row small it-burn"><span>Burn down <b>${rate(down)}</b>/day <span class="muted">(${n0(down * 30)}/mo)</span></span><span>Burn up <b>${rate(up)}</b>/day <span class="muted">(${n0(up * 30)}/mo)</span></span>
      <span>Net <b class="${up - down < 0 ? "neg" : "okt"}">${up - down >= 0 ? "+" : "−"}${rate(Math.abs(up - down))}</b>/day</span><span>Days of cover now <b>${cover == null ? "—" : n0(cover)}</b></span><span class="muted">last ${n0(rd)} days, Shopify store</span></div>`;
    const tr = shown.slice().reverse().map(r => r.none ? `<tr><td class="l">${esc(lab(r.mo, true))}</td><td colspan="8" class="l muted small">no history</td></tr>`
      : `<tr><td class="l">${esc(lab(r.mo, true))}${r.mo === cur ? ' <span class="small muted">so far</span>' : ""}</td><td>${n0(r.start)}</td><td class="${r.got > 0 ? "okt" : r.got < 0 ? "neg" : ""}">${r.got ? (r.got > 0 ? "+" : "−") + n0(Math.abs(r.got)) : '<span class="dim">0</span>'}</td>
        <td class="${r.sold ? "neg" : ""}">${r.sold ? "−" + n0(r.sold) : '<span class="dim">0</span>'}</td><td><b>${n0(r.end)}</b></td><td class="${r.net < 0 ? "neg" : r.net > 0 ? "okt" : ""}">${r.net > 0 ? "+" : r.net < 0 ? "−" : ""}${n0(Math.abs(r.net))}</td>
        <td>${rate(r.down)}</td><td>${rate(r.up)}</td><td>${r.cover == null ? '<span class="dim">—</span>' : n0(r.cover)}</td></tr>`).join("");
    return `<div class="row small"><b>On hand by month</b><span class="muted">Shopify store · end of each month (this month: now)</span></div>
      <div class="oos-bars">${bars}</div>${sum}
      <div class="tbl-wrap"><table class="it-t"><thead><tr><th class="l">Month</th><th>Start</th><th title="Received, transferred in and adjusted (end − start + sold)">In / adjusted</th><th>Sold</th><th>End</th><th>Net change</th>
        <th title="Units sold per day">Burn down /day</th><th title="Units received or added per day">Burn up /day</th><th title="End of month ÷ that month's sales per day">Days of cover</th></tr></thead><tbody>${tr}</tbody></table></div>`;
  }

  function inventory(D) {
    const SRC = { oos: "Shopify", count: "Shopify", shopify: "Shopify", prep: "Prep center" };
    const rows = D.inv.map(r => {
      const what = r.src === "oos" ? `<span class="pill warn">Went to 0</span>` : r.src === "count" ? `<span class="pill other">Counted</span>` : esc(KIND[r.kind] || r.kind);
      const chg = r.chg == null ? "" : `<span class="${r.chg < 0 ? "neg" : "okt"}">${r.chg > 0 ? "+" : ""}${n0(r.chg)}</span>`;
      return `<tr><td class="l">${esc(when(r.at))}</td><td class="l">${what}</td><td class="l small muted">${esc(SRC[r.src])}</td><td>${chg}</td><td>${r.after == null ? '<span class="dim">—</span>' : n0(r.after)}</td><td class="l small">${esc(r.note)}${r.st && r.st !== "done" ? ` <span class="pill ${r.st === "failed" ? "miss" : "warn"}">${esc(r.st)}</span>` : ""}</td><td class="l small muted">${esc(who(r.who))}</td></tr>`;
    }).join("");
    return `${invHistory(D)}<h3 class="h3">Changes made in Seller Sage</h3><div class="tbl-wrap">${D.inv.length ? `<table class="it-t"><thead><tr><th class="l">Date</th><th class="l">What</th><th class="l">Where</th><th>Change</th><th>After</th><th class="l">Note</th><th class="l">By</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="muted small">No inventory changes recorded in Seller Sage yet.</div>'}</div>
      <div class="muted small">Shopify's own changes from orders aren't listed one by one; they show as sales. Went to 0 comes from Shopify's daily inventory history (the last 8 days are kept up to date hourly).</div>`;
  }

  window.JTItem = { open, close };
})();
