(() => {
  // ===================== Shipments =====================
  // Amazon inbound shipments from the SP-API (jt.inbound_shipments + jt.inbound_shipment_items, synced hourly by the
  // amazon function's inbound_shipments action; migrations 068 and 069): FBA shipments to fulfillment centers and AWD
  // shipments to Amazon's warehousing. One row per shipment with its SKUs, or one row per SKU across open shipments.
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const n0 = (x) => Math.round(x || 0).toLocaleString();
  const JT = window.JT;
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const PER = 100;
  const DAY = 86400000;
  const LATE_ARRIVED = 7, LATE_RECEIVING = 14, LATE_OLD = 21;   // days before a shipment needs attention

  // Amazon's statuses -> where the shipment is
  const STAGES = {
    prep: { l: "Preparing", cls: "pos" }, transit: { l: "In transit", cls: "web" }, arrived: { l: "Delivered", cls: "other" },
    receiving: { l: "Receiving", cls: "other" }, done: { l: "Received", cls: "ok" }, cancelled: { l: "Cancelled", cls: "cx" },
  };
  const OPEN = new Set(["prep", "transit", "arrived", "receiving"]);
  function stageOf(s) {
    const st = s.status;
    if (st === "CANCELLED" || st === "DELETED") return "cancelled";
    if (st === "CLOSED") return "done";
    if (st === "RECEIVING") return s.ue > 0 && s.ur >= s.ue ? "done" : "receiving";
    if (st === "DELIVERED" || st === "CHECKED_IN") return "arrived";
    if (st === "SHIPPED" || st === "IN_TRANSIT") return "transit";
    return "prep";
  }
  const nice = (st) => st ? st.charAt(0) + st.slice(1).toLowerCase().replace(/_/g, " ") : "";
  const fmtDay = (d) => d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }) : "—";
  const ago = (days) => days < 1 ? "today" : days < 2 ? "1 day" : `${Math.floor(days)} days`;

  // ---------- loading ----------
  let cache = null, loading = null;
  async function load(refresh) {
    if (loading) return loading;
    if (cache && !refresh) return cache;
    loading = (async () => {
      const [ships, items] = await Promise.all([
        JT.rowsSplit(["id", "kind", "name", "status", "destination", "carrier", "tracking", "created_at::text", "status_since::text", "units_expected", "units_received",
          "skus", "coalesce(raw->>'orderId', '')", "first_seen::text", "synced_at::text"], "from jt.inbound_shipments", "id", 2, refresh),
        JT.rowsSplit(["i.shipment_id", "i.sku", "i.fnsku", "i.qty_expected", "i.qty_received", "i.qty_in_case", "coalesce(f.asin, m.asin, '')", "coalesce(f.name, m.title, '')",
          "coalesce(nullif(v.display_name, ''), v.product_title, '')", "coalesce(v.sku, '')", "coalesce(v.vendor, '')", "coalesce(v.product_id::text, '')", "coalesce(v.variant_id::text, '')", "coalesce(m.units, '1')"],
          `from jt.inbound_shipment_items i
           left join lateral (select nullif(x.asin, '') as asin, nullif(x.name, '') as name from jt.fba_inventory x where x.sku = i.sku order by (x.name <> '') desc limit 1) f on true
           left join (select distinct on (data->>'sku') data->>'sku' as sku, nullif(data->>'asin', '') as asin, nullif(data->>'title', '') as title,
                             (regexp_match(data->>'variantId', '(\\d+)$'))[1]::bigint as vid, nullif(data->>'units', '') as units
                      from jt.docs where collection = 'amzmap' order by data->>'sku', data->>'updatedAt' desc nulls last) m on m.sku = i.sku
           left join jt.variants v on v.variant_id = m.vid
           where i.qty_expected + i.qty_received > 0`, "i.shipment_id", 2, refresh),
      ]);
      const now = Date.now(), by = new Map();
      let synced = null;
      const list = ships.map(r => {
        const s = { id: r[0], kind: r[1], name: r[2] || "", status: r[3] || "", dest: r[4] || "", carrier: r[5] || "", tracking: r[6] || "",
          ue: +r[9] || 0, ur: +r[10] || 0, skus: +r[11] || 0, order: r[12] || "", items: [] };
        // FBA's v0 API gives no dates; Send to Amazon names carry the plan's date: "FBA STA (10/02/2026 21:42)-MCC1"
        const mt = /\((\d\d)\/(\d\d)\/(\d{4})/.exec(s.name);
        s.created = r[7] ? new Date(r[7]) : mt ? new Date(+mt[3], +mt[1] - 1, +mt[2]) : r[13] ? new Date(r[13]) : null;
        s.since = r[8] ? new Date(r[8]) : null;
        s.days = s.since ? (now - s.since) / DAY : 0;
        s.stage = stageOf(s);
        s.open = OPEN.has(s.stage);
        s.short = s.stage === "done" && s.ue > s.ur ? s.ue - s.ur : 0;
        s.age = s.created ? (now - s.created) / DAY : 0;
        // FBA status dates only start with the first sync (Oct 2026), so an old plan that's still "delivered" counts too
        s.flag = s.stage === "arrived" && s.days >= LATE_ARRIVED ? `Delivered ${ago(s.days)} ago, nothing checked in`
          : s.stage === "arrived" && s.age >= LATE_OLD ? `Created ${ago(s.age)} ago, nothing checked in`
          : s.stage === "receiving" && s.days >= LATE_RECEIVING ? `Receiving for ${ago(s.days)}, ${n0(s.ue - s.ur)} units not checked in`
          : s.short && s.status === "CLOSED" && s.ur > 0 ? `Closed ${n0(s.short)} short` : "";
        const t = r[14] ? new Date(r[14]) : null; if (t && (!synced || t > synced)) synced = t;
        by.set(s.id, s);
        return s;
      });
      for (const r of items) {
        const s = by.get(r[0]); if (!s) continue;
        s.items.push({ sku: r[1], fnsku: r[2] || "", exp: +r[3] || 0, rec: +r[4] || 0, perCase: +r[5] || 0, asin: r[6] || "", title: r[7] || "",
          shop: r[8] || "", vsku: r[9] || "", vendor: r[10] || "", pid: r[11] || "", vid: r[12] || "", units: +r[13] || 1 });
      }
      for (const s of list) {
        s.items.sort((a, b) => b.exp - a.exp || a.sku.localeCompare(b.sku));
        s.hay = [s.id, s.name, s.order, s.dest, s.carrier, s.tracking, ...s.items.flatMap(i => [i.sku, i.fnsku, i.asin, i.title, i.shop, i.vsku, i.vendor])].join(" ").toLowerCase();
      }
      list.sort((a, b) => (b.created || 0) - (a.created || 0) || b.id.localeCompare(a.id));
      cache = { list, groups: groupAll(list), synced };
      return cache;
    })();
    try { return await loading; } finally { loading = null; }
  }

  // ---------- shipments grouped by workflow ----------
  // One Send to Amazon workflow is split by Amazon into several shipment IDs, one per fulfillment center (the "boxes"):
  // "FBA STA (10/02/2026 21:42)-MCC1", "…-MCI4", … share the name before the center code. AWD: one workflow (wf…) per shipment.
  const ORDER = ["prep", "transit", "arrived", "receiving", "done", "cancelled"];
  const wfKey = (s) => { const base = s.kind === "FBA" ? s.name.replace(/-[A-Z0-9]{3,5}$/, "") : s.name; return s.kind + "|" + (base || s.id); };
  function groupAll(list) {
    const m = new Map();
    for (const s of list) {
      const k = wfKey(s); s.gkey = k;
      const g = m.get(k) || { key: k, kind: s.kind, name: s.kind === "FBA" ? k.slice(4) : s.name, order: s.order, boxes: [] };
      g.boxes.push(s); m.set(k, g);
    }
    const out = [...m.values()];
    for (const g of out) {
      const B = g.boxes.sort((a, b) => a.dest.localeCompare(b.dest) || a.id.localeCompare(b.id));
      g.created = B.reduce((a, b) => !a || (b.created && b.created < a) ? b.created : a, null);
      g.ue = B.reduce((a, b) => a + b.ue, 0); g.ur = B.reduce((a, b) => a + b.ur, 0);
      g.open = B.some(b => b.open);
      g.dests = [...new Set(B.map(b => b.dest).filter(Boolean))];
      const live = B.filter(b => b.stage !== "cancelled");
      const pool = (live.length ? live : B).filter(b => !g.open || b.open);
      g.stage = pool.map(b => b.stage).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0];
      g.counts = ORDER.map(st => [st, B.filter(b => b.stage === st).length]).filter(x => x[1]);
      g.days = Math.min(...pool.filter(b => b.stage === g.stage && b.since).map(b => b.days), Infinity);
      const fl = B.filter(b => b.flag); g.flags = fl;
      g.flag = fl.length === 1 ? (B.length > 1 ? `${fl[0].dest || fl[0].id}: ` : "") + fl[0].flag : fl.length ? `${fl.length} boxes need attention` : "";
      const it = new Map();
      for (const b of B) for (const i of b.items) { const x = it.get(i.sku) || { ...i, exp: 0, rec: 0, boxes: 0 }; x.exp += i.exp; x.rec += i.rec; x.boxes++; it.set(i.sku, x); }
      g.items = [...it.values()].sort((a, b) => b.exp - a.exp || a.sku.localeCompare(b.sku));
      g.skus = g.items.length;
      g.hay = B.map(b => b.hay).join(" ");
    }
    return out.sort((a, b) => (b.created || 0) - (a.created || 0) || b.key.localeCompare(a.key));
  }

  // ---------- the tab ----------
  const F = { shown: false, loading: false, view: "ship", kind: "all", show: "open", q: "", page: 0, openId: null, syncing: false };
  const note = (kind, html) => { const n = $("sh-note"); if (!html) { n.hidden = true; n.innerHTML = ""; return; } n.hidden = false; n.innerHTML = `<div class="note ${kind}">${html}</div>`; };

  async function refresh(force) {
    F.loading = true; render();
    try { await load(force); } catch (e) { note("bad", esc(JT.message(e))); }
    finally { F.loading = false; render(); }
  }

  const SHOWS = {
    open: (s) => s.open, attention: (s) => !!s.flag, transit: (s) => s.stage === "prep" || s.stage === "transit",
    arrived: (s) => s.stage === "arrived" || s.stage === "receiving", done: (s) => s.stage === "done", cancelled: (s) => s.stage === "cancelled", all: () => true,
  };
  function filtered() {
    if (!cache) return [];
    const q = F.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return cache.groups.filter(g => (F.kind === "all" || g.kind === F.kind) && (F.show === "attention" ? !!g.flag : g.boxes.some(SHOWS[F.show])) && q.every(w => g.hay.includes(w)));
  }

  function kpis() {
    const L = cache.list.filter(s => F.kind === "all" || s.kind === F.kind);
    const sum = (a, f) => a.reduce((t, s) => t + f(s), 0);
    const open = L.filter(s => s.open), moving = L.filter(s => s.stage === "prep" || s.stage === "transit");
    const arr = L.filter(s => s.stage === "arrived"), rcv = L.filter(s => s.stage === "receiving"), att = L.filter(s => s.flag);
    const by = (a, k) => a.filter(s => s.kind === k).length;
    const G = cache.groups.filter(g => F.kind === "all" || g.kind === F.kind), gOpen = G.filter(g => g.open), gAtt = G.filter(g => g.flag);
    const bx = (n) => `${n0(n)} box${n === 1 ? "" : "es"}`;
    $("sh-kpis").innerHTML = [
      { l: "Open shipments", v: n0(gOpen.length), s: `${bx(open.length)} · ${n0(sum(open, s => s.ue - s.ur))} units not checked in yet${F.kind === "all" ? ` · ${by(gOpen, "FBA")} FBA · ${by(gOpen, "AWD")} AWD` : ""}` },
      { c: "sales", l: "On the way", v: n0(sum(moving, s => s.ue)), s: `units in ${bx(moving.length)} preparing or in transit` },
      { l: "Delivered, not checked in", v: n0(sum(arr, s => s.ue)), s: `units in ${bx(arr.length)}` },
      { l: "Being received", v: n0(sum(rcv, s => s.ue - s.ur)), s: `units still to check in · ${bx(rcv.length)}` },
      { c: gAtt.length ? "warnk" : "", l: "Needs attention", v: n0(gAtt.length), s: att.length ? `${bx(att.length)}: ` +  `delivered ${LATE_ARRIVED}+ days (or created ${LATE_OLD}+ days ago) with nothing checked in, receiving ${LATE_RECEIVING}+ days, or closed short` : "nothing stuck" },
    ].map(k => `<div class="kpi ${k.c || ""}"><span class="eyebrow">${k.l}</span><span class="v">${k.v}</span><span class="s">${k.s}</span></div>`).join("");
  }

  // Amazon listing (title, ASIN) and the Shopify product it's mapped to, for every row
  const amzCell = (i) => `<td class="l sh-prod">${i.asin ? `<a href="https://www.amazon.com/dp/${encodeURIComponent(i.asin)}" target="_blank" rel="noopener">${esc(i.title || i.asin)}</a>` : esc(i.title || "—")}<div class="meta mono">${esc(i.asin || "no ASIN")}</div></td>`;
  const shopCell = (i) => `<td class="l sh-prod">${i.shop ? (i.pid ? `<a href="${ADMIN}/products/${encodeURIComponent(i.pid)}${i.vid ? "/variants/" + encodeURIComponent(i.vid) : ""}" target="_blank" rel="noopener">${esc(i.shop)}</a>` : esc(i.shop)) : '<span class="dim">Not mapped</span>'}${
    i.shop ? `<div class="meta">${[i.vsku && `<span class="mono">${esc(i.vsku)}</span>`, esc(i.vendor), i.units > 1 ? `${n0(i.units)} per Amazon unit` : ""].filter(Boolean).join(" · ")}</div>` : ""}</td>`;
  // the shipment's products in its row: the biggest two, then a count of the rest
  function prodSummary(s) {
    if (!s.items.length) return `<td class="l sh-prod dim">${s.stage === "cancelled" ? "—" : "SKUs not loaded yet"}</td>`;
    const top = s.items.slice(0, 2).map(i => `<div class="sh-p1"><span class="sh-t">${esc(i.title || i.sku)}</span><div class="meta"><span class="mono">${esc(i.asin || i.sku)}</span>${i.shop ? " · " + esc(i.shop) : ""}${s.items.length > 1 ? ` · ${n0(i.exp)}` : ""}</div></div>`).join("");
    return `<td class="l sh-prod">${top}${s.items.length > 2 ? `<div class="meta">+ ${s.items.length - 2} more SKU${s.items.length > 3 ? "s" : ""}</div>` : ""}</td>`;
  }

  // SKUs of a whole shipment (all its boxes added up) — or of one box
  function itemsTable(s) {
    if (!s.items.length) return `<div class="muted small">${s.stage === "cancelled" ? "Cancelled before anything shipped." : "Amazon hasn't sent this shipment's SKUs yet. The hourly sync fetches them on its next runs."}</div>`;
    const multi = s.boxes && s.boxes.length > 1, awd = s.kind === "AWD";
    return `<table class="sh-items"><thead><tr><th class="l w-sku">SKU</th><th class="l">Amazon listing</th><th class="l">Shopify product</th>${multi ? '<th class="w-n">Boxes</th>' : ""}<th class="w-n">${awd ? "Expected" : "Shipped"}</th><th class="w-n">Received</th><th class="w-n">${s.stage === "done" ? "Short / over" : "To check in"}</th>${awd ? '<th class="w-n">Cases</th>' : ""}</tr></thead><tbody>${
      s.items.map(i => {
        const d = i.rec - i.exp;
        return `<tr><td class="l mono">${esc(i.sku)}${i.fnsku ? `<div class="meta">${esc(i.fnsku)}</div>` : ""}</td>
          ${amzCell(i)}${shopCell(i)}${multi ? `<td>${n0(i.boxes)}</td>` : ""}
          <td>${n0(i.exp)}</td><td>${n0(i.rec)}</td>${s.stage === "done" ? `<td class="${d < 0 ? "neg" : d > 0 ? "pos" : "dim"}">${d === 0 ? "—" : (d > 0 ? "+" : "") + n0(d)}</td>` : `<td>${d < 0 ? n0(-d) : "—"}</td>`}
          ${awd ? `<td>${i.perCase ? `${n0(Math.round(i.exp / i.perCase))}<div class="meta">${n0(i.perCase)} per case</div>` : "—"}</td>` : ""}</tr>`;
      }).join("")}</tbody></table>`;
  }
  const stageCell = (s, extra) => { const st = STAGES[s.stage]; return `<span class="pill ${st.cls}">${st.l}</span>${extra ? `<div class="meta">${extra}</div>` : ""}`; };
  const recvCell = (s) => { const p = s.ue ? Math.min(100, Math.round(s.ur / s.ue * 100)) : 0; return s.ue ? `${n0(s.ur)}<div class="sh-bar" aria-hidden="true"><span style="width:${p}%"></span></div>` : "—"; };
  const boxMeta = (s) => { const st = STAGES[s.stage], sm = s.stage === "done" && s.status === "RECEIVING" ? "all units checked in" : s.status && nice(s.status) !== st.l ? nice(s.status) : "";
    return s.open && s.since ? `${ago(s.days)}${sm ? " · " + esc(sm) : ""}` : esc(sm); };
  // the boxes (Amazon shipment IDs) of one shipment, each with its SKUs
  function boxesTable(g) {
    return `<table class="sh-items sh-boxes"><thead><tr><th class="l w-box">Box (shipment ID)</th><th class="l w-to">To</th><th class="l w-st">Status</th><th class="l">Contents</th><th class="w-n">Units</th><th class="w-n">Received</th><th class="l w-fl"></th></tr></thead><tbody>${
      g.boxes.map(b => `<tr><td class="l mono">${esc(b.id)}${b.carrier ? `<div class="meta">${esc(b.carrier)}${b.tracking ? " " + esc(b.tracking) : ""}</div>` : ""}</td>
        <td class="l">${esc(b.dest || "—")}</td><td class="l">${stageCell(b, boxMeta(b))}</td>
        <td class="l sh-prod">${b.items.length ? b.items.map(i => `<div><span class="mono">${esc(i.sku)}</span> × ${n0(i.exp)}${i.rec ? ` <span class="dim">(${n0(i.rec)} in)</span>` : ""}${i.title ? `<div class="meta sh-t">${esc(i.title)}</div>` : ""}</div>`).join("") : '<span class="dim">SKUs not loaded yet</span>'}</td>
        <td><b>${b.ue ? n0(b.ue) : "—"}</b></td><td>${recvCell(b)}</td>
        <td class="l sh-flag">${b.flag ? `<span class="pill miss">${esc(b.flag)}</span>` : ""}</td></tr>`).join("")}</tbody></table>`;
  }

  function shipTable(rows) {
    const pages = Math.max(1, Math.ceil(rows.length / PER)); F.page = Math.min(F.page, pages - 1);
    const page = rows.slice(F.page * PER, F.page * PER + PER);
    $("sh-table").innerHTML = `<thead><tr><th class="l">Shipment</th><th class="l">Products</th><th class="l">Type</th><th class="l">Status</th><th class="l">To</th><th class="l">Created</th><th>Boxes</th><th>SKUs</th><th>Units</th><th>Received</th><th class="l"></th></tr></thead><tbody>${
      page.map(g => {
        const open = F.openId === g.key, n = g.boxes.length, one = n === 1 ? g.boxes[0] : null;
        const id = g.kind === "AWD" ? (one ? one.id : g.order) : g.name;
        const sub = g.kind === "AWD" ? [g.order && one && g.order !== one.id ? g.order : "", g.name].filter(Boolean).join(" · ") : one ? one.id : "";
        const meta = one ? boxMeta(one) : g.counts.length > 1 ? g.counts.map(([st, c]) => `${c} ${STAGES[st].l.toLowerCase()}`).join(" · ") : (isFinite(g.days) && g.open ? ago(g.days) : "");
        const to = g.dests.length ? (g.dests.length > 3 ? `${g.dests.slice(0, 3).map(esc).join(", ")} +${g.dests.length - 3}` : g.dests.map(esc).join(", ")) : "—";
        return `<tr class="sh-row ${open ? "openrow" : ""}" data-id="${esc(g.key)}" tabindex="0" aria-expanded="${open}">
          <td class="l"><span class="${g.kind === "AWD" ? "mono" : ""}">${esc(id || g.key.slice(4))}</span>${sub ? `<div class="meta mono">${esc(sub)}</div>` : ""}</td>
          ${prodSummary(g)}
          <td class="l"><span class="pill ${g.kind === "FBA" ? "web" : "pos"}">${g.kind}</span></td>
          <td class="l">${stageCell(g, meta)}</td>
          <td class="l">${to}${one && one.carrier ? `<div class="meta">${esc(one.carrier)}${one.tracking ? " " + esc(one.tracking) : ""}</div>` : ""}</td>
          <td class="l">${fmtDay(g.created)}</td>
          <td>${n0(n)}</td>
          <td>${g.skus ? n0(g.skus) : "—"}</td>
          <td><b>${g.ue ? n0(g.ue) : "—"}</b></td>
          <td>${recvCell(g)}</td>
          <td class="l sh-flag">${g.flag ? `<span class="pill miss">${esc(g.flag)}</span>` : ""}</td></tr>${
          open ? `<tr class="sh-det"><td colspan="11">${n > 1 ? `<h3 class="sh-h">Total for the shipment · ${n0(n)} boxes</h3>` : ""}${itemsTable(g)}${n > 1 ? `<h3 class="sh-h">By box</h3>${boxesTable(g)}` : ""}</td></tr>` : ""}`;
      }).join("") || `<tr><td class="l dim" colspan="11">${cache.list.length ? "No shipments match." : "No shipments yet. The hourly Amazon sync loads them."}</td></tr>`}</tbody>`;
    $("sh-prev").hidden = F.page === 0; $("sh-next").hidden = F.page >= pages - 1;
    $("sh-count").textContent = rows.length ? `${F.page * PER + 1}–${F.page * PER + page.length} of ${rows.length.toLocaleString()} shipments` : "";
  }

  // one row per SKU across the matching open shipments: what's coming in
  function skuTable(rows) {
    const m = new Map();
    for (const s of rows) if (s.open) for (const i of s.items) {
      const left = Math.max(0, i.exp - i.rec); if (!left) continue;
      const k = m.get(i.sku) || { ...i, moving: 0, arrived: 0, fba: 0, awd: 0, ships: new Set() };
      if (s.stage === "prep" || s.stage === "transit") k.moving += left; else k.arrived += left;
      k[s.kind === "FBA" ? "fba" : "awd"] += left; k.ships.add(s.gkey); m.set(i.sku, k);
    }
    const q = F.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = [...m.values()].filter(k => q.every(w => `${k.sku} ${k.title} ${k.asin} ${k.shop} ${k.vsku} ${k.vendor}`.toLowerCase().includes(w)))
      .sort((a, b) => (b.moving + b.arrived) - (a.moving + a.arrived) || a.sku.localeCompare(b.sku));
    const pages = Math.max(1, Math.ceil(list.length / PER)); F.page = Math.min(F.page, pages - 1);
    const page = list.slice(F.page * PER, F.page * PER + PER);
    $("sh-table").innerHTML = `<thead><tr><th class="l">SKU</th><th class="l">Amazon listing</th><th class="l">Shopify product</th><th>On the way</th><th>Delivered / receiving</th><th>Total inbound</th><th>To FBA</th><th>To AWD</th><th>Shipments</th></tr></thead><tbody>${
      page.map(k => `<tr class="sh-sku" data-sku="${esc(k.sku)}" tabindex="0" title="Show this SKU's shipments">
        <td class="l mono">${esc(k.sku)}</td>${amzCell(k)}${shopCell(k)}
        <td>${k.moving ? n0(k.moving) : "—"}</td><td>${k.arrived ? n0(k.arrived) : "—"}</td><td><b>${n0(k.moving + k.arrived)}</b></td>
        <td>${k.fba ? n0(k.fba) : "—"}</td><td>${k.awd ? n0(k.awd) : "—"}</td><td>${n0(k.ships.size)}</td></tr>`).join("")
      || `<tr><td class="l dim" colspan="9">No units on the way${F.q ? " for that search" : ""}.</td></tr>`}</tbody>`;
    $("sh-prev").hidden = F.page === 0; $("sh-next").hidden = F.page >= pages - 1;
    $("sh-count").textContent = list.length ? `${F.page * PER + 1}–${F.page * PER + page.length} of ${list.length.toLocaleString()} SKUs` : "";
  }

  // phone card view: label each cell with its own table's header
  function label(t) {
    if (!t) return;
    const hs = [...t.querySelectorAll(":scope > thead > tr > th")].map(th => th.textContent.trim());
    t.querySelectorAll(":scope > tbody > tr").forEach(tr => [...tr.children].forEach((td, i) => { if (!td.hasAttribute("colspan") && hs[i]) td.setAttribute("data-label", hs[i]); }));
    t.querySelectorAll("table.sh-items").forEach(label);
  }

  function render() {
    if ($("tab-shipments").hidden) return;
    document.querySelectorAll("#sh-view button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === F.view)));
    document.querySelectorAll("#sh-kind button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.k === F.kind)));
    $("sh-show-wrap").hidden = F.view !== "ship";
    $("sh-sync").disabled = F.syncing;
    const st = $("sh-status");
    if (!cache) { st.textContent = F.loading ? "Loading shipments…" : ""; $("sh-table").innerHTML = ""; $("sh-kpis").innerHTML = ""; return; }
    st.textContent = `${cache.groups.length.toLocaleString()} shipments (${cache.list.length.toLocaleString()} boxes) from Amazon (FBA and AWD) · synced hourly${cache.synced ? `, last ${cache.synced.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}${F.loading ? " · refreshing…" : ""}${F.syncing ? " · syncing from Amazon…" : ""}`;
    kpis();
    $("sh-head").textContent = F.view === "ship" ? "Shipments" : "Inbound by SKU";
    $("sh-hint").textContent = F.view === "ship" ? "Boxes from the same Send to Amazon workflow are one shipment. Click a shipment for its total by SKU and each box's contents." : "Units not yet checked in on open shipments. Click a SKU to see its shipments.";
    if (F.view === "ship") shipTable(filtered());
    else skuTable(cache.list.filter(s => F.kind === "all" || s.kind === F.kind));
    label($("sh-table"));
  }

  async function sync() {
    F.syncing = true; note("info", "Asking Amazon for new and changed shipments. This can take a minute or two…"); render();
    try {
      const r = await JT.amazon({ action: "inbound_shipments" });
      if (r && r.ok === false) throw new Error(r.error || "Amazon sync failed");
      note("info", r && r.done === false ? "Synced part of the shipments; the hourly sync picks up the rest." : "Synced from Amazon.");
      await refresh(true);
    } catch (e) { note("bad", "Couldn't sync: " + esc(e && e.message ? e.message : JT.message(e))); }
    finally { F.syncing = false; render(); }
  }

  function bind() {
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on("sh-view", "click", (e) => { const b = e.target.closest("button[data-v]"); if (!b) return; F.view = b.dataset.v; F.page = 0; render(); });
    on("sh-kind", "click", (e) => { const b = e.target.closest("button[data-k]"); if (!b) return; F.kind = b.dataset.k; F.page = 0; render(); });
    on("sh-show", "change", (e) => { F.show = e.target.value; F.page = 0; render(); });
    on("sh-q", "input", (e) => { F.q = e.target.value; F.page = 0; clearTimeout(e.target._t); e.target._t = setTimeout(render, 200); });
    on("sh-refresh", "click", () => refresh(true));
    on("sh-sync", "click", sync);
    on("sh-prev", "click", () => { F.page--; render(); $("sh-table").scrollIntoView({ block: "start" }); });
    on("sh-next", "click", () => { F.page++; render(); $("sh-table").scrollIntoView({ block: "start" }); });
    const pick = (e) => {
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      if (e.target.closest("a")) return;   // product links open Amazon / Shopify
      const r = e.target.closest("tr.sh-row"), k = e.target.closest("tr.sh-sku");
      if (r) { e.preventDefault(); F.openId = F.openId === r.dataset.id ? null : r.dataset.id; render(); }
      else if (k) { e.preventDefault(); F.view = "ship"; F.show = "open"; $("sh-show").value = "open"; F.q = k.dataset.sku; $("sh-q").value = F.q; F.page = 0; render(); }
    };
    on("sh-table", "click", pick);
    on("sh-table", "keydown", pick);
  }

  bind();
  window.shipShow = () => { if (!F.shown) { F.shown = true; refresh(false); } else render(); };
  window.JTShip = { load, get data() { return cache; }, _state: F };
  if ((location.hash || "") === "#shipments") setTimeout(() => window.shipShow(), 0);
})();
