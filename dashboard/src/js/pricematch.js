// Sales › Price match (Brian, Oct 17; migration 152, sync/price_match.py). Each morning the brand sites and the Amazon
// Buy Box are checked against Just Tennis's Shopify prices. Proposed changes are approved here (Approve & apply starts
// the sync job "price-match-apply"); applied ones can be rolled back one by one or a whole run at a time. Settings:
// review/auto mode, floors (MAP, cost + margin), max drop, exclusions, brands on/off, the MAP list (CSV import).
(() => {
  const $ = (id) => document.getElementById(id);
  if (!$("tab-pricematch")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const m2 = (n) => n == null || n === "" ? "—" : usd2.format(+n);
  const n0 = (x) => Math.round(x || 0).toLocaleString();
  const when = (t) => t ? new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const ADMIN = "https://admin.shopify.com/store/justtennis-822";
  const P = { view: "proposed", src: "all", q: "", sel: new Set(), data: null, err: null, busy: "", note: null, mapBrand: "all", csv: "", loaded: false, req: 0 };

  const JT = () => window.JT, WEB = () => window.JTWeb || null;
  async function call(fn, sqlFn, p) {
    if (WEB()) { const r = await WEB().write(fn, p === undefined ? {} : { p }); return typeof r === "string" ? JSON.parse(r) : r; }
    const out = await JT().run(`select ${sqlFn}(${p === undefined ? "" : JT().q(JSON.stringify({ ...p, by: "Claude dashboard" })) + "::jsonb"})::text as r`, true);
    return out[0] && out[0].r ? JSON.parse(out[0].r) : null;
  }
  const decide = (p) => call("jt_pm_decide", "jt.pm_decide", p);
  const saveSettings = (p) => call("jt_pm_settings_save", "jt.pm_settings_save", p);
  const saveMap = (p) => call("jt_pm_map_save", "jt.pm_map_save", p);
  const runNow = () => call("jt_pm_run_now", "jt.pm_run_now");

  const CH = ["id", "run_id", "product_id", "variant_id", "product_title", "variant_title", "sku", "vendor", "source", "competitor_price", "competitor_list",
    "competitor_ref", "competitor_url", "old_price", "old_compare_at", "new_price", "new_compare_at", "cost", "map_price", "reason", "floor_applied", "big_drop",
    "status", "error", "decided_by", "decided_at", "applied_at", "rolled_back_at", "created_at"];
  async function load(refresh) {
    const id = ++P.req; P.err = null; render();
    try {
      const [ch, runs, src, set, maps, st] = await Promise.all([
        JT().rows(CH.map(c => c + "::text"), "from jt.pm_changes where status in ('proposed', 'approved', 'failed', 'rollback') or (status in ('applied', 'rolled_back', 'rejected') and created_at > now() - interval '45 days') order by id desc limit 3000", refresh),
        JT().rows(["id::text", "started_at::text", "finished_at::text", "mode", "status", "summary::text", "error", "started_by"], "from jt.pm_runs order by id desc limit 60", refresh),
        JT().rows(["name", "kind", "base_url", "array_to_string(vendors, ', ')", "sku_prefix::text", "enabled::text", "status", "last_error", "last_count::text", "checked_at::text"], "from jt.pm_sources order by sort, name", refresh),
        JT().rows(["value::text"], "from jt.settings where key = 'price_match'", refresh),
        JT().rows(["id::text", "brand", "sku_prefix", "map_price::text", "effective_from::text", "source"], "from jt.pm_map_floors where active order by brand, sku_prefix, effective_from desc", refresh),
        JT().rows(["count(*)::text"], "from jt.pm_state where active", refresh),
      ]);
      if (id !== P.req) return;
      P.data = {
        changes: ch.map(r => { const o = Object.fromEntries(CH.map((c, i) => [c, r[i]])); for (const k of ["competitor_price", "competitor_list", "old_price", "old_compare_at", "new_price", "new_compare_at", "cost", "map_price"]) o[k] = o[k] == null ? null : +o[k]; o.big_drop = o.big_drop === "true"; return o; }),
        runs: runs.map(r => { let s = {}; try { s = JSON.parse(r[5] || "{}"); } catch (_) {} return { id: r[0], started: r[1], finished: r[2], mode: r[3], status: r[4], summary: s, error: r[6], by: r[7] }; }),
        sources: src.map(r => ({ name: r[0], kind: r[1], url: r[2], vendors: r[3], prefix: +r[4], enabled: r[5] === "true", status: r[6], error: r[7], count: r[8] == null ? null : +r[8], checked: r[9] })),
        settings: (() => { try { return JSON.parse((set[0] || [])[0] || "{}"); } catch (_) { return {}; } })(),
        maps: maps.map(r => ({ id: r[0], brand: r[1], prefix: r[2], price: +r[3], from: r[4], source: r[5] })),
        lowered: +((st[0] || [])[0] || 0),
      };
      P.loaded = true;
      for (const k of [...P.sel]) if (!P.data.changes.some(c => c.id === k && ["proposed", "failed"].includes(c.status))) P.sel.delete(k);
    } catch (e) { if (id === P.req) P.err = e; }
    if (id === P.req) render();
  }

  const msg = (e) => (JT().message ? JT().message(e) : (e && e.message) || String(e));
  function note(kind, html) { P.note = { kind, html }; render(); }

  // ---------------------------------------------------------------- render
  function render() {
    const st = $("pm-status");
    if (P.err) { st.textContent = "Couldn't load price match: " + msg(P.err); return; }
    if (!P.data) { st.textContent = "Loading price match…"; return; }
    const D = P.data, last = D.runs[0], s = D.settings;
    st.innerHTML = last ? `Last run ${esc(when(last.started))} (${esc(last.status === "running" ? "running now" : last.mode === "auto" ? "auto" : "review")}${last.by === "Run now" ? ", Run now" : ""})` + ` · mode <b>${s.mode === "auto" ? "Auto" : "Review"}</b> · runs daily 5:30 am` : `No runs yet · mode <b>${s.mode === "auto" ? "Auto" : "Review"}</b> · runs daily 5:30 am — or Run now`;
    $("pm-note").innerHTML = P.note ? `<div class="note ${P.note.kind}">${P.note.html} <button class="linkbtn small" data-pm="note-x">Dismiss</button></div>` : "";
    const prop = D.changes.filter(c => ["proposed", "failed", "approved"].includes(c.status));
    const applied = D.changes.filter(c => ["applied", "rollback"].includes(c.status));
    const tot = (last && last.summary && last.summary.totals) || {};
    $("pm-kpis").innerHTML = [
      { l: "Waiting for review", v: n0(prop.filter(c => c.status !== "approved").length), s: prop.some(c => c.status === "approved") ? `${n0(prop.filter(c => c.status === "approved").length)} being applied` : "proposed changes" },
      { l: "Lowered now", v: n0(D.lowered), s: "prices this feature lowered" },
      { l: "Last run", v: last ? `${n0(tot.lowered)} ↓ · ${n0(tot.restored)} ↑` : "—", s: last ? `${n0(tot.variants)} products checked${tot.big ? ` · ${n0(tot.big)} big drops` : ""}` : "" },
      { l: "Not covered", v: n0((tot.not_covered || []).length), s: (tot.not_covered || []).join(", ") || "every source read", c: (tot.not_covered || []).length ? "warn" : "" },
    ].map(x => `<div class="kpi ${x.c || ""}"><span class="eyebrow">${x.l}</span><span class="v">${x.v}</span><span class="s">${esc(x.s)}</span></div>`).join("");
    const cnt = { proposed: prop.length, applied: applied.length, history: D.runs.length };
    $("pm-views").innerHTML = [["proposed", "Proposed"], ["applied", "Applied"], ["history", "History"], ["settings", "Settings"]]
      .map(([k, n]) => `<button type="button" data-pmv="${k}" aria-pressed="${P.view === k}">${n}${cnt[k] != null ? ` <span class="cnt">${n0(cnt[k])}</span>` : ""}</button>`).join("");
    $("pm-run").disabled = !!P.busy || (last && last.status === "running");
    $("pm-run").textContent = last && last.status === "running" ? "Running…" : "Run now";
    const body = $("pm-body");
    if (P.view === "proposed") body.innerHTML = proposedHtml(prop);
    else if (P.view === "applied") body.innerHTML = appliedHtml(applied);
    else if (P.view === "history") body.innerHTML = historyHtml();
    else body.innerHTML = settingsHtml();
  }

  const srcCell = (c) => {
    const comp = c.competitor_price != null ? `<b>${m2(c.competitor_price)}</b>${c.competitor_list && c.competitor_list > c.competitor_price + 0.005 ? ` <span class="dim">list ${m2(c.competitor_list)}</span>` : ""}` : '<span class="dim">no price today</span>';
    const nm = c.source === "Amazon" ? `Amazon${c.competitor_ref ? ` <span class="mono dim">${esc(c.competitor_ref)}</span>` : ""}` : esc(c.source);
    return `${c.competitor_url ? `<a class="olink" href="${esc(c.competitor_url)}" target="_blank" rel="noopener">${nm}</a>` : nm}<div class="meta">${comp}</div>`;
  };
  const prodCell = (c) => `<a class="olink" href="${ADMIN}/products/${esc(c.product_id)}/variants/${esc(c.variant_id)}" target="_blank" rel="noopener">${esc(c.product_title)}</a>${c.variant_title ? ` <span class="dim">· ${esc(c.variant_title)}</span>` : ""}<div class="meta"><span class="mono">${esc(c.sku) || "no SKU"}</span> · ${esc(c.vendor)}</div>`;
  const priceCell = (c) => {
    const d = c.old_price ? (c.new_price - c.old_price) / c.old_price : 0;
    return `<span class="dim strike">${m2(c.old_price)}</span> → <b>${m2(c.new_price)}</b><div class="meta ${d < 0 ? "neg" : "pos"}">${d < 0 ? "" : "+"}${(d * 100).toFixed(1)}%${c.cost ? ` · cost ${m2(c.cost)}` : ""}</div>`;
  };
  const cmpCell = (c) => c.old_compare_at === c.new_compare_at ? `<span class="dim">${c.new_compare_at == null ? "—" : m2(c.new_compare_at)}</span>` : `<span class="dim">${c.old_compare_at == null ? "none" : m2(c.old_compare_at)}</span> → ${c.new_compare_at == null ? "none" : m2(c.new_compare_at)}`;
  const flags = (c) => [
    c.reason === "restore" ? '<span class="pill ok" title="The competitor\'s price went back up: back to the price before this feature lowered it">Restore</span>' : '<span class="pill web">Lower</span>',
    c.floor_applied === "map" ? `<span class="pill other" title="Held at the brand's MAP">MAP ${m2(c.map_price)}</span>` : c.floor_applied === "cost" ? '<span class="pill other" title="Held at cost + the minimum margin">Cost floor</span>' : "",
    c.big_drop ? '<span class="pill warn" title="A bigger drop than the max-drop setting: always waits for review">Big drop</span>' : "",
    c.status === "approved" ? '<span class="pill manual">Applying…</span>' : c.status === "failed" ? `<span class="pill cx" title="${esc(c.error)}">Failed</span>` : c.status === "rollback" ? '<span class="pill manual">Rolling back…</span>' : "",
  ].filter(Boolean).join(" ");

  function proposedHtml(all) {
    const srcs = [...new Set(all.map(c => c.source))].sort();
    const q = P.q.trim().toLowerCase();
    const rows = all.filter(c => (P.src === "all" || c.source === P.src) && (!q || (c.product_title + " " + c.sku + " " + c.vendor + " " + c.variant_title).toLowerCase().includes(q)));
    const pick = rows.filter(c => c.status !== "approved");
    const nSel = pick.filter(c => P.sel.has(c.id)).length, allOn = pick.length && nSel === pick.length;
    const head = `<div class="pm-bar">
      <label class="small">Source <select class="inp sm" data-pmf="src" style="width:auto"><option value="all">All</option>${srcs.map(x => `<option ${P.src === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
      <input class="inp" type="search" data-pmf="q" value="${esc(P.q)}" placeholder="Product, SKU or vendor" style="max-width:240px">
      <span class="right dbtns"><span class="small muted">${n0(nSel)} selected</span>
        <button class="btn primary" data-pm="approve" ${nSel && !P.busy ? "" : "disabled"}>${P.busy === "approve" ? "Applying…" : "Approve &amp; apply"}</button>
        <button class="btn" data-pm="reject" ${nSel && !P.busy ? "" : "disabled"}>Reject</button></span></div>`;
    if (!all.length) return head + `<div class="muted small" style="padding:10px 2px">Nothing waiting. ${P.data.runs.length ? "The last run found no prices to change." : "Press Run now for a first look — it only proposes changes."}</div>`;
    return head + `<div class="tbl-wrap tall"><table class="prept pm-t"><thead><tr><th><input type="checkbox" data-pm="all" ${allOn ? "checked" : ""} aria-label="Select all"></th><th class="l">Product</th><th class="l">Matched to</th><th class="l">Price</th><th class="l">Compare-at</th><th class="l"></th></tr></thead><tbody>${
      rows.map(c => `<tr class="${P.sel.has(c.id) ? "sel" : ""}"><td>${c.status === "approved" ? "" : `<input type="checkbox" data-pmsel="${c.id}" ${P.sel.has(c.id) ? "checked" : ""} aria-label="Select ${esc(c.product_title)}">`}</td>
        <td class="l">${prodCell(c)}</td><td class="l small">${srcCell(c)}</td><td class="l">${priceCell(c)}</td><td class="l small">${cmpCell(c)}</td>
        <td class="l">${flags(c)}${c.status === "failed" && c.error ? `<div class="meta neg">${esc(c.error)}</div>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function appliedHtml(all) {
    const D = P.data;
    const recent = D.changes.filter(c => ["rolled_back", "rejected"].includes(c.status)).slice(0, 40);
    if (!all.length && !recent.length) return '<div class="muted small" style="padding:10px 2px">Nothing applied yet.</div>';
    const byRun = new Map();
    for (const c of all) { if (!byRun.has(c.run_id)) byRun.set(c.run_id, []); byRun.get(c.run_id).push(c); }
    let html = [...byRun.entries()].sort((a, b) => +b[0] - +a[0]).map(([rid, cs]) => {
      const r = D.runs.find(x => x.id === rid), live = cs.filter(c => c.status === "applied").length;
      return `<div class="pm-run"><div class="pm-runh"><b>Run ${esc(rid)}</b> <span class="small muted">${esc(when(r && r.started))} · ${n0(cs.length)} change${cs.length === 1 ? "" : "s"}</span>
        ${live ? `<button class="mini right" data-pm="rb-run" data-run="${esc(rid)}" ${P.busy ? "disabled" : ""}>Roll back run</button>` : ""}</div>
        <div class="tbl-wrap"><table class="prept pm-t"><thead><tr><th class="l">Product</th><th class="l">Matched to</th><th class="l">Price</th><th class="l">Applied</th><th></th></tr></thead><tbody>${
        cs.map(c => `<tr><td class="l">${prodCell(c)}</td><td class="l small">${srcCell(c)}</td><td class="l">${priceCell(c)}</td>
          <td class="l small">${esc(when(c.applied_at))}${c.decided_by ? `<div class="meta">${esc(c.decided_by === "auto" ? "auto mode" : c.decided_by.split("@")[0])}</div>` : ""}${c.error ? `<div class="meta neg">${esc(c.error)}</div>` : ""}</td>
          <td>${c.status === "applied" ? `<button class="mini" data-pm="rb" data-id="${c.id}" ${P.busy ? "disabled" : ""}>Roll back</button>` : flags(c)}</td></tr>`).join("")}</tbody></table></div></div>`;
    }).join("");
    if (recent.length) html += `<details class="pm-run"><summary class="small muted">Rolled back and rejected lately (${n0(recent.length)})</summary><div class="tbl-wrap"><table class="prept pm-t"><tbody>${
      recent.map(c => `<tr><td class="l">${prodCell(c)}</td><td class="l small">${esc(c.source)}</td><td class="l">${priceCell(c)}</td><td class="l small">${c.status === "rejected" ? `Rejected${c.decided_by ? " by " + esc(c.decided_by.split("@")[0]) : ""} <button class="linkbtn small" data-pm="reopen" data-id="${c.id}">undo</button>` : "Rolled back " + esc(when(c.rolled_back_at))}</td></tr>`).join("")}</tbody></table></div></details>`;
    return html;
  }

  function historyHtml() {
    const D = P.data;
    if (!D.runs.length) return '<div class="muted small" style="padding:10px 2px">No runs yet.</div>';
    return `<div class="tbl-wrap"><table class="prept pm-t"><thead><tr><th class="l">Run</th><th class="l">Started</th><th class="l">Mode</th><th>Checked</th><th>Lower</th><th>Restore</th><th class="l">Sources</th></tr></thead><tbody>${
      D.runs.map(r => { const t = r.summary.totals || {}, src = Object.entries(r.summary.sources || {}), amz = r.summary.amazon || {};
        const chips = src.map(([n, s]) => `<span class="pm-chip ${s.status === "ok" ? "" : "off"}" title="${esc(s.status === "ok" ? `${n0(s.skus)} SKUs on the site · ${n0(s.matched)} matched · ${n0(s.lowered)} lower · ${n0(s.restored)} restore${s.floored ? ` · ${n0(s.floored)} held at a floor` : ""}` : s.error || s.status)}">${esc(n)}${s.status === "ok" ? ` ${n0(s.matched)}` : " ✕"}</span>`).join("")
          + (amz.status ? `<span class="pm-chip ${amz.status === "ok" ? "" : "off"}" title="${esc(amz.status === "ok" ? `${n0(amz.prices)} Amazon prices · ${n0(amz.matched)} matched · ${n0(amz.lowered)} lower · ${n0(amz.restored)} restore · ${n0(amz.no_upc)} without a UPC` : amz.error || amz.status)}">Amazon${amz.status === "ok" ? ` ${n0(amz.matched)}` : amz.status === "off" ? " off" : " ✕"}</span>` : "");
        return `<tr><td class="l mono">${esc(r.id)}</td><td class="l small">${esc(when(r.started))}${r.by ? `<div class="meta">${esc(r.by)}</div>` : ""}</td>
          <td class="l small">${r.status === "failed" ? `<span class="pill cx" title="${esc(r.error)}">Failed</span>` : r.status === "running" ? '<span class="pill manual">Running</span>' : esc(r.mode === "auto" ? "Auto" : "Review")}</td>
          <td>${t.variants != null ? n0(t.variants) : ""}</td><td>${t.lowered != null ? n0(t.lowered) : ""}${t.big ? `<div class="meta">${n0(t.big)} big</div>` : ""}</td><td>${t.restored != null ? n0(t.restored) : ""}</td>
          <td class="l"><div class="pm-chips">${chips}</div>${r.error ? `<div class="meta neg">${esc(r.error)}</div>` : ""}</td></tr>`; }).join("")}</tbody></table></div>
      <p class="muted small">Hover a source for what was read and matched. ✕ = not covered that day (the site isn't a Shopify store, or it refused) — nothing is lowered or restored for it.</p>`;
  }

  function settingsHtml() {
    const D = P.data, s = D.settings;
    const tog = (k, label, sub) => `<label class="pm-tog"><input type="checkbox" data-pms="${k}" ${s[k] !== false ? "checked" : ""}> <b>${label}</b><span class="small muted">${sub}</span></label>`;
    const brands = [...new Set(D.maps.map(x => x.brand))].sort();
    const maps = D.maps.filter(x => P.mapBrand === "all" || x.brand === P.mapBrand);
    return `<div class="pm-set">
      <section><h3 class="psec">How it runs</h3>
        <div class="row"><span class="seg" role="group" aria-label="Mode"><button type="button" data-pmmode="review" aria-pressed="${s.mode !== "auto"}">Review</button><button type="button" data-pmmode="auto" aria-pressed="${s.mode === "auto"}">Auto</button></span>
          <span class="small muted">${s.mode === "auto" ? "Changes are applied each morning; big drops still wait for review." : "Changes wait here for Approve &amp; apply. Switch to Auto after a couple of weeks of clean runs."}</span></div>
        ${tog("amazon", "Match Amazon", "the Buy Box price (New) by UPC; your own listing is skipped")}
        ${tog("map_floor", "Never below MAP", "the MAP list below")}
        ${tog("cost_floor", "Never below cost + margin", "Shopify unit cost × (1 + min margin)")}
        <div class="pmgrid">
          <label class="stack" for="pm-mm">Min margin over cost (%)<input id="pm-mm" class="inp num" value="${esc(s.min_margin ?? 5)}" inputmode="decimal"></label>
          <label class="stack" for="pm-md">Max drop per run (%)<input id="pm-md" class="inp num" value="${esc(s.max_drop ?? 40)}" inputmode="decimal"></label>
          <label class="stack" for="pm-xt" style="grid-column:span 2">Skip products tagged<input id="pm-xt" class="inp" value="${esc((s.exclude_tags || []).join(", "))}"></label>
          <label class="stack" for="pm-xp" style="grid-column:span 2">Skip product types containing<input id="pm-xp" class="inp" value="${esc((s.exclude_types || []).join(", "))}"></label>
        </div>
        <div class="row"><button class="btn primary" data-pm="save-set" ${P.busy ? "disabled" : ""}>Save settings</button><span class="small muted">Used products (title starting “Used”) are always skipped.</span></div>
      </section>
      <section><h3 class="psec">Brands</h3>
        <div class="tbl-wrap"><table class="prept pm-t"><thead><tr><th class="l">On</th><th class="l">Brand</th><th class="l">Website</th><th class="l">Last run</th></tr></thead><tbody>${
          D.sources.map(x => `<tr><td class="l"><input type="checkbox" data-pmsrc="${esc(x.name)}" ${x.enabled ? "checked" : ""} aria-label="Match ${esc(x.name)}"></td>
            <td class="l"><b>${esc(x.name)}</b><div class="meta">vendors ${esc(x.vendors)}${x.prefix ? ` · SKU first ${x.prefix} characters` : ""}</div></td>
            <td class="l small"><a class="olink" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url.replace(/^https?:\/\/(www\.)?/, ""))}</a></td>
            <td class="l small">${!x.checked ? '<span class="dim">not run yet</span>' : x.status === "ok" ? `<span class="pill ok">Covered</span> <span class="dim">${n0(x.count)} SKUs</span>` : `<span class="pill warn">Not covered</span><div class="meta">${esc(x.error)}</div>`}</td></tr>`).join("")}</tbody></table></div>
        <p class="muted small">Brand sites built on Shopify work as they are. “Not covered” brands need their own reader — ask Claude to add one.</p>
      </section>
      <section><h3 class="psec">MAP list <span class="small muted">(${n0(D.maps.length)} prices)</span></h3>
        <div class="row"><label class="small">Brand <select class="inp sm" data-pmf="mapBrand" style="width:auto"><option value="all">All</option>${brands.map(b => `<option ${P.mapBrand === b ? "selected" : ""}>${esc(b)}</option>`).join("")}</select></label></div>
        <div class="tbl-wrap" style="max-height:320px"><table class="prept pm-t"><thead><tr><th class="l">Brand</th><th class="l">SKU starts with</th><th>MAP</th><th class="l">From</th><th class="l">Source</th><th></th></tr></thead><tbody>${
          maps.slice(0, 500).map(x => `<tr><td class="l">${esc(x.brand)}</td><td class="l mono">${esc(x.prefix)}</td><td>${m2(x.price)}</td><td class="l small">${esc(x.from)}</td><td class="l small dim">${esc(x.source)}</td>
            <td><button class="linkbtn small" data-pm="map-off" data-id="${x.id}" aria-label="Take ${esc(x.prefix)} off the list">✕</button></td></tr>`).join("") || '<tr><td class="l muted" colspan="6">No MAP prices.</td></tr>'}</tbody></table></div>
        <label class="stack" for="pm-csv">Add or import (CSV: brand, sku_prefix, map_price, effective_from — one per line; a header row is fine)
          <textarea id="pm-csv" class="inp mono" rows="4" placeholder="Babolat, 101511, 199.00, 2026-11-01">${esc(P.csv)}</textarea></label>
        <div class="row"><input type="file" id="pm-csvfile" accept=".csv,text/csv" class="small"><button class="btn" data-pm="map-import" ${P.busy ? "disabled" : ""}>Import</button>
          <span class="small muted">The longest matching SKU prefix wins; a later “from” date replaces an earlier one.</span></div>
      </section></div>`;
  }

  // ---------------------------------------------------------------- actions
  async function act(label, fn, okText) {
    P.busy = label; render();
    try { const r = await fn(); P.busy = ""; P.note = { kind: "info", html: okText(r) }; await load(true); }
    catch (e) { P.busy = ""; note("bad", "Couldn't save: " + esc(msg(e))); }
  }
  function parseCsv(text) {
    const rows = [];
    for (const line of String(text || "").split(/\r?\n/)) {
      const f = line.split(/,|\t/).map(x => x.trim().replace(/^"|"$/g, ""));
      if (f.length < 3 || !f[0] || /^brand$/i.test(f[0])) continue;
      rows.push({ brand: f[0], sku_prefix: f[1], map_price: f[2].replace(/[$,]/g, ""), effective_from: /^\d{4}-\d{2}-\d{2}$/.test(f[3] || "") ? f[3] : "" });
    }
    return rows;
  }
  const box = $("tab-pricematch");
  box.addEventListener("click", (e) => {
    const v = e.target.closest("[data-pmv]"); if (v) { P.view = v.dataset.pmv; render(); return; }
    const md = e.target.closest("[data-pmmode]");
    if (md) { const mode = md.dataset.pmmode; act("set", () => saveSettings({ mode }), () => mode === "auto" ? "Auto mode on: tomorrow's run applies changes (big drops still wait for review)." : "Review mode: changes wait here for approval."); return; }
    const b = e.target.closest("[data-pm]"); if (!b) return;
    const a = b.dataset.pm, D = P.data;
    if (a === "note-x") { P.note = null; render(); }
    else if (a === "all") {
      const q = P.q.trim().toLowerCase();
      const ids = D.changes.filter(c => ["proposed", "failed"].includes(c.status) && (P.src === "all" || c.source === P.src) && (!q || (c.product_title + " " + c.sku + " " + c.vendor).toLowerCase().includes(q))).map(c => c.id);
      if (b.checked) ids.forEach(i => P.sel.add(i)); else ids.forEach(i => P.sel.delete(i));
      render();
    } else if (a === "approve" || a === "reject") {
      const ids = [...P.sel].map(Number);
      act(a, () => decide({ ids, action: a }), (r) => { P.sel.clear(); return a === "approve" ? `${n0(r && r.changed)} change${r && r.changed === 1 ? "" : "s"} approved — writing to Shopify now (a minute or two). Refresh to see them under Applied.` : `${n0(r && r.changed)} rejected.`; });
    } else if (a === "rb") act("rb", () => decide({ ids: [Number(b.dataset.id)], action: "rollback" }), () => "Rolling back — the old price goes back in Shopify in a minute or two.");
    else if (a === "rb-run") { if (!confirm(`Put back the old prices for everything run ${b.dataset.run} changed?`)) return; act("rb", () => decide({ run_id: Number(b.dataset.run), action: "rollback_run" }), (r) => `Rolling back ${n0(r && r.changed)} change${r && r.changed === 1 ? "" : "s"} — old prices go back in Shopify in a minute or two.`); }
    else if (a === "reopen") act("reopen", () => decide({ ids: [Number(b.dataset.id)], action: "reopen" }), () => "Back in Proposed.");
    else if (a === "save-set") {
      const num = (id) => Number(String($(id).value).replace(/[%\s]/g, ""));
      const list = (id) => $(id).value.split(",").map(x => x.trim()).filter(Boolean);
      const p = { min_margin: num("pm-mm"), max_drop: num("pm-md"), exclude_tags: list("pm-xt"), exclude_types: list("pm-xp") };
      for (const k of ["amazon", "map_floor", "cost_floor"]) { const i = box.querySelector(`[data-pms="${k}"]`); if (i) p[k] = i.checked; }
      if (!isFinite(p.min_margin) || !isFinite(p.max_drop)) { note("bad", "Min margin and max drop must be numbers."); return; }
      act("set", () => saveSettings(p), () => "Settings saved.");
    } else if (a === "map-off") { const x = D.maps.find(m => m.id === b.dataset.id); act("map", () => saveMap({ off: [Number(b.dataset.id)] }), () => `${esc(x ? x.brand + " " + x.prefix : "MAP price")} taken off the list.`); }
    else if (a === "map-import") {
      P.csv = $("pm-csv").value; const rows = parseCsv(P.csv);
      if (!rows.length) { note("bad", "Nothing to import — one line per price: brand, SKU prefix, MAP, optional date (YYYY-MM-DD)."); return; }
      act("map", () => saveMap({ rows, source: "Seller Sage import" }), (r) => { P.csv = ""; return `${n0(r && r.saved)} MAP price${r && r.saved === 1 ? "" : "s"} saved${r && r.skipped ? `, ${n0(r.skipped)} line${r.skipped === 1 ? "" : "s"} skipped (missing brand, prefix or price)` : ""}.`; });
    }
  });
  box.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.pmsel) { const id = t.dataset.pmsel; if (t.checked) P.sel.add(id); else P.sel.delete(id); render(); }
    else if (t.dataset.pmf === "src") { P.src = t.value; render(); }
    else if (t.dataset.pmf === "mapBrand") { P.mapBrand = t.value; render(); }
    else if (t.dataset.pmsrc) { const name = t.dataset.pmsrc, on = t.checked; act("src", () => saveSettings({ source: name, enabled: on }), () => `${esc(name)} ${on ? "on" : "off"}.`); }
    else if (t.id === "pm-csvfile" && t.files && t.files[0]) { t.files[0].text().then(txt => { P.csv = txt; render(); }); }
  });
  box.addEventListener("input", (e) => {
    if (e.target.dataset.pmf === "q") { P.q = e.target.value; const pos = e.target.selectionStart; render(); const i = box.querySelector('[data-pmf="q"]'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }
    else if (e.target.id === "pm-csv") P.csv = e.target.value;
  });
  $("pm-refresh").addEventListener("click", () => load(true));
  $("pm-run").addEventListener("click", () => act("run", runNow, (r) => r && r.already ? "A run is already going — refresh in a few minutes." : "Run started (review only: it proposes, changes nothing). Takes about 5 minutes — then Refresh."));

  window.pmShow = () => { if (!P.loaded) load(false); else render(); };
  if ((location.hash || "") === "#pricematch") setTimeout(() => window.pmShow(), 0);   // opened straight on this page
})();
