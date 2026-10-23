(() => {
  // Amazon order workbook for Brittany (Brian, Oct 23: "build an exportable excel such that she has all the amazon
  // inventory data pulled in. the awd inventory too. and the sales data from amazon. and then have a order form for her
  // filled out — should be able to see the amazon sales and such and also have a vendor view which is by SKU").
  // One vendor (or every vendor) per workbook, four sheets:
  //   Vendor view    — by Shopify SKU: vendor item #, UPC, product, units to order (added up from the order form), cost.
  //   Inventory      — every Amazon listing: FBA available / transfer / inbound / reserved / unfulfillable, AWD
  //                    available / inbound / outbound to FBA, prep center, Shopify store.
  //   Sales          — Amazon units by week for the last 13 weeks, plus 7 / 30 / 90 days and the same 30 days last year.
  //   Order form     — one row per listing: Amazon SKU, then the units to order (filled in with a suggestion: enough for
  //                    the hold days at the 90-day pace, less what's at Amazon, in AWD and in the prep center), sales,
  //                    stock, days of cover, cost. Edit the quantities, then Orders › + New order › from Excel brings it
  //                    back in as an order (that reader looks for the "Order form" sheet).
  // Quantities on the order form are Shopify units (a 3-pack listing of one product counts 3 per Amazon unit).
  const JT = window.JT;
  const XL_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
  async function xlLib() {
    if (window.XLSX) return window.XLSX;
    await new Promise((ok, bad) => { const sc = document.createElement("script"); sc.src = XL_URL; sc.onload = ok; sc.onerror = () => bad(new Error("Couldn't load the spreadsheet writer.")); document.head.appendChild(sc); });
    return window.XLSX;
  }
  const r2 = (x) => Math.round((x || 0) * 100) / 100;
  const ymd = (d) => d.toISOString().slice(0, 10);

  async function build({ vendor, days }) {
    const HOLD = Math.max(7, Number(days) || 90);
    if (!JT.fba) throw new Error("The Amazon inventory page isn't loaded.");
    const fd = await JT.fba.load(false);
    const V = String(vendor || "").trim().toLowerCase();
    const items = fd.items.filter(i => !V || (i.vendor || "").toLowerCase() === V);
    if (!items.length) throw new Error(V ? `No Amazon listings for ${vendor} in the FBA / AWD reports.` : "No Amazon listings in the FBA / AWD reports.");
    const skus = items.map(i => i.sku), vids = [...new Set(items.map(i => i.map && i.map.vid).filter(Boolean))];
    const inList = (a) => a.map(x => JT.q(String(x))).join(",");
    const [sales, weeks, prep, vars, vitems] = await Promise.all([
      JT.rows(["sku", "sum(units) filter (where day >= current_date - 7)", "sum(units) filter (where day >= current_date - 30)", "sum(units) filter (where day >= current_date - 90)",
        "sum(units) filter (where day between current_date - 365 - 30 and current_date - 365)", "sum(units) filter (where day between current_date - 365 and current_date - 365 + 30)", "sum(sales) filter (where day >= current_date - 90)"],
        `from jt.amazon_sku_daily where sku in (${inList(skus)}) and day >= current_date - 400 group by sku`, true),
      JT.rows(["sku", "date_trunc('week', day)::date::text", "sum(units)"], `from jt.amazon_sku_daily where sku in (${inList(skus)}) and day >= date_trunc('week', current_date)::date - 84 group by 1, 2`, true),
      vids.length ? JT.rows(["variant_id::text", "amazon_sku", "qty"], `from jt.prep_items where qty > 0 and variant_id in (${vids.join(",")})`, true) : [],
      vids.length ? JT.rows(["variant_id::text", "sku", "barcode", "coalesce(nullif(display_name, ''), product_title)", "vendor", "unit_cost", "inventory_qty"], `from jt.variants where variant_id in (${vids.join(",")})`, true) : [],
      vids.length ? JT.rows(["variant_id::text", "string_agg(distinct item_code, ', ')"], `from jt.vendor_items where variant_id in (${vids.join(",")}) group by 1`, true) : [],
    ]);
    const S = new Map(sales.map(x => [x[0], { u7: +x[1] || 0, u30: +x[2] || 0, u90: +x[3] || 0, ly30: +x[4] || 0, lyNext30: +x[5] || 0, rev90: +x[6] || 0 }]));
    const wkStart = []; { const d = new Date(); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); for (let k = 12; k >= 0; k--) { const x = new Date(d); x.setUTCDate(x.getUTCDate() - 7 * k); wkStart.push(ymd(x)); } }
    const W = new Map(); for (const [sku, wk, u] of weeks) { const m = W.get(sku) || new Map(); m.set(wk, +u || 0); W.set(sku, m); }
    const prepBy = new Map(); for (const [vid, asku, q] of prep) prepBy.set(vid + "|" + (asku || ""), +q || 0);
    const VV = new Map(vars.map(x => [x[0], { sku: x[1] || "", upc: x[2] || "", title: x[3] || "", vendor: x[4] || "", cost: x[5] == null ? null : +x[5], store: x[6] == null ? 0 : +x[6] }]));
    const VI = new Map(vitems.map(x => [x[0], x[1] || ""]));

    const rows = items.map(i => {
      const m = i.map || {}, v = (m.vid && VV.get(String(m.vid))) || {}, pu = m.units || 1, s = S.get(i.sku) || { u7: 0, u30: 0, u90: 0, ly30: 0, lyNext30: 0, rev90: 0 };
      const atAmz = (i.avail || 0) + (i.transfer || 0) + (i.inbound || 0);
      const awd = (i.awdAvail || 0) + (i.awdIn || 0);
      const prepHere = m.vid ? (prepBy.get(m.vid + "|" + i.sku) || 0) : 0;            // earmarked for this listing (Shopify units)
      const rate = s.u90 / 90;                                                         // Amazon units a day
      const stockAmz = atAmz + awd + prepHere / pu;
      const cover = rate > 0 ? stockAmz / rate : null;
      const sugg = rate > 0 ? Math.max(0, Math.ceil((rate * HOLD - stockAmz) * pu)) : 0;   // Shopify units
      return { i, m, v, pu, s, atAmz, awd, prepHere, rate, cover, sugg, cost: v.cost != null ? v.cost : null };
    }).sort((a, b) => (b.s.u90 - a.s.u90) || String(a.i.sku).localeCompare(b.i.sku));
    return { rows, wkStart, W, HOLD, vendor: vendor || "All vendors", fd, VI, prepBy };
  }

  async function download({ vendor, days }) {
    const D = await build({ vendor, days });
    const X = await xlLib();
    const wb = X.utils.book_new();
    // formulas ({f: "B4*T4"}) go in as formula cells, so the totals follow Brittany's edits
    const sheet = (aoa, widths, opts) => { const ws = X.utils.aoa_to_sheet(aoa.map(r => r.map(v => v && typeof v === "object" && v.f ? null : v)));
      aoa.forEach((r, ri) => r.forEach((v, ci) => { if (v && typeof v === "object" && v.f) ws[X.utils.encode_cell({ r: ri, c: ci })] = { t: "n", f: v.f, v: v.v || 0 }; })); ws["!cols"] = widths.map(w => ({ wch: w })); if (opts && opts.filter) ws["!autofilter"] = { ref: X.utils.encode_range({ s: { r: opts.hr || 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[opts.hr || 0].length - 1 } }) }; return ws; };
    const asOf = [D.fd.meta && D.fd.meta.snapshot ? "FBA report " + String(D.fd.meta.snapshot).slice(0, 10) : "", D.fd.awdMeta && D.fd.awdMeta.snapshot ? "AWD report " + String(D.fd.awdMeta.snapshot).slice(0, 10) : ""].filter(Boolean).join(" · ");
    const title = `${D.vendor} · Amazon order workbook · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}${asOf ? " · " + asOf : ""}`;

    // ---- Order form (last sheet; the Excel reader on Orders looks for it by name) ----
    const OH = ["Amazon SKU", "Order qty", "Suggested", "Product", "Shopify SKU", "Vendor item #", "ASIN", "Pack", "Sold 7d", "Sold 30d", "Sold 90d", "Sold same 30d last yr", "Next 30d last yr",
      "FBA available", "FBA inbound + transfer", "AWD", "Prep center", "Shopify store", "Days of cover", "Unit cost", "Ext. cost", "Note"];
    const oAoa = [[title], [`Order qty and Suggested are Shopify units. Suggested = ${D.HOLD} days at the 90-day pace, less FBA, AWD and prep center stock. Edit Order qty, then Orders › + New order › from Excel.`], OH];
    D.rows.forEach((x, k) => {
      const r = oAoa.length + 1;   // 1-based row in Excel
      oAoa.push([x.i.sku, x.sugg || "", x.sugg || 0, x.v.title || x.m.title || x.i.name || "", x.v.sku || x.m.vsku || "", (x.m.vid && D.VI.get(String(x.m.vid))) || "", x.i.asin || "", x.pu,
        x.s.u7, x.s.u30, x.s.u90, x.s.ly30, x.s.lyNext30, x.i.avail || 0, (x.i.inbound || 0) + (x.i.transfer || 0), x.awd, x.prepHere, x.v.store || 0,
        x.cover == null ? "no sales" : Math.round(x.cover), x.cost == null ? "" : r2(x.cost), x.cost == null ? "" : { f: `B${r}*T${r}`, v: r2((x.sugg || 0) * x.cost) }, !x.m.vid ? "not mapped to a Shopify product" : ""]);
    });
    const oLast = oAoa.length;
    const tot = (k) => D.rows.reduce((t, x) => t + (k(x) || 0), 0);
    oAoa.push(["Total", { f: `SUM(B4:B${oLast})`, v: tot(x => x.sugg) }, { f: `SUM(C4:C${oLast})`, v: tot(x => x.sugg) }, "", "", "", "", "", { f: `SUM(I4:I${oLast})`, v: tot(x => x.s.u7) }, { f: `SUM(J4:J${oLast})`, v: tot(x => x.s.u30) }, { f: `SUM(K4:K${oLast})`, v: tot(x => x.s.u90) },
      "", "", "", "", "", "", "", "", "", { f: `SUM(U4:U${oLast})`, v: r2(tot(x => x.cost == null ? 0 : x.sugg * x.cost)) }, ""]);
    const wsO = sheet(oAoa, [28, 10, 10, 46, 16, 14, 12, 6, 8, 8, 9, 12, 12, 10, 12, 8, 10, 10, 10, 10, 12, 26], { filter: true, hr: 2 });

    // ---- Vendor view: by Shopify SKU, units added up from the order form ----
    const bySku = new Map();
    for (const x of D.rows) { const k = x.v.sku || x.m.vsku; if (!k) continue; const a = bySku.get(k) || { x, n: 0, u: 0 }; a.n++; a.u += x.sugg || 0; bySku.set(k, a); }
    const vAoa = [[`${D.vendor} · order by SKU · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`], ["Units are added up from the Order form (all of a product's Amazon listings)."],
      ["Shopify SKU", "Vendor item #", "UPC", "Product", "Units", "Unit cost", "Ext. cost"]];
    for (const [k, a] of [...bySku].sort((p, q) => String(p[1].x.v.title || "").localeCompare(String(q[1].x.v.title || "")))) {
      const r = vAoa.length + 1, x = a.x;
      vAoa.push([k, (x.m.vid && D.VI.get(String(x.m.vid))) || "", x.v.upc || "", x.v.title || x.m.title || "", { f: `SUMIF('Order form'!E4:E${oLast},A${r},'Order form'!B4:B${oLast})`, v: a.u }, x.cost == null ? "" : r2(x.cost), x.cost == null ? "" : { f: `E${r}*F${r}`, v: r2(a.u * x.cost) }]);
    }
    const vLast = vAoa.length;
    vAoa.push(["Total", "", "", "", { f: `SUM(E4:E${vLast})`, v: [...bySku.values()].reduce((t, a) => t + a.u, 0) }, "", { f: `SUM(G4:G${vLast})`, v: r2([...bySku.values()].reduce((t, a) => t + (a.x.cost == null ? 0 : a.u * a.x.cost), 0)) }]);
    const wsV = sheet(vAoa, [16, 14, 15, 50, 8, 10, 12], { filter: true, hr: 2 });

    // ---- Inventory ----
    const iAoa = [[`${D.vendor} · Amazon inventory${asOf ? " · " + asOf : ""}`], ["Amazon units, except Prep center and Shopify store (Shopify units). AWD outbound is already in FBA inbound."],
      ["Amazon SKU", "ASIN", "FNSKU", "Product", "Shopify SKU", "Pack", "FBA available", "FBA transfer", "FBA inbound", "FBA reserved", "FBA unfulfillable", "AWD available", "AWD inbound", "AWD outbound to FBA",
        "Prep center", "Shopify store", "Amazon price", "Health", "Days of supply (Amazon)"]];
    for (const x of D.rows) iAoa.push([x.i.sku, x.i.asin || "", x.i.fnsku || "", x.v.title || x.i.name || "", x.v.sku || x.m.vsku || "", x.pu, x.i.avail || 0, x.i.transfer || 0, x.i.inbound || 0, x.i.resv || 0, x.i.unf || 0,
      x.i.awdAvail || 0, x.i.awdIn || 0, x.i.awdOut || 0, x.prepHere, x.v.store || 0, x.i.price == null ? "" : r2(x.i.price), x.i.health || "", x.i.days == null || x.i.days === "" ? "" : +x.i.days || x.i.days]);
    const wsI = sheet(iAoa, [28, 12, 12, 46, 16, 6, 10, 10, 10, 10, 10, 10, 10, 12, 10, 10, 10, 12, 12], { filter: true, hr: 2 });

    // ---- Sales ----
    const wkLabel = (s) => "Wk " + new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" });
    const sAoa = [[`${D.vendor} · Amazon units sold (orders, by week starting Monday)`], ["Last 13 weeks; this week is partial. Same 30 days last year for comparison."],
      ["Amazon SKU", "Product", "Pack", ...D.wkStart.map(wkLabel), "7d", "30d", "90d", "Same 30d last yr", "Change vs last yr", "Sales $ 90d"]];
    for (const x of D.rows) {
      const w = D.W.get(x.i.sku) || new Map(), r = sAoa.length + 1, c = 3 + D.wkStart.length;
      const col = (n) => X.utils.encode_col(n);
      sAoa.push([x.i.sku, x.v.title || x.i.name || "", x.pu, ...D.wkStart.map(s => w.get(s) || 0), x.s.u7, x.s.u30, x.s.u90, x.s.ly30,
        x.s.ly30 ? { f: `${col(c + 1)}${r}/${col(c + 3)}${r}-1`, v: Math.round((x.s.u30 / x.s.ly30 - 1) * 1000) / 1000 } : "", r2(x.s.rev90)]);
    }
    const wsS = sheet(sAoa, [28, 46, 6, ...D.wkStart.map(() => 8), 7, 7, 7, 12, 12, 12], { filter: true, hr: 2 });

    X.utils.book_append_sheet(wb, wsV, "Vendor view");
    X.utils.book_append_sheet(wb, wsI, "Inventory");
    X.utils.book_append_sheet(wb, wsS, "Sales");
    X.utils.book_append_sheet(wb, wsO, "Order form");
    wb.Workbook = { Views: [{ activeTab: 3 }] };
    const name = `${(D.vendor || "Amazon").replace(/[^\w ]+/g, "").trim()} - Amazon order form - ${ymd(new Date())}.xlsx`;
    const out = X.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const dl = window.claude && window.claude.use ? await window.claude.use("downloads") : null;
    if (dl && dl.save) await dl.save({ filename: name, data: blob, mimeType: blob.type });
    else { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); }
    return { name, listings: D.rows.length, suggested: D.rows.reduce((t, x) => t + x.sugg, 0), skus: bySku.size };
  }
  window.JTOrderForm = { download, build };
})();
