// Loads the built Claude-artifact dashboard with a fake Supabase connector that logs every query.
// Usage: node dashboard/build.mjs && node scripts/profile_dashboard_boot.mjs dashboard/dist/just-tennis-sales.html [latencyMs]
// Every connector call takes latencyMs; rows marked * are the Daily Sales tab's own queries.
const { chromium } = await import("playwright").catch(() => import("/opt/node-tools/node_modules/playwright/index.mjs"));
const [html, lat = "1000"] = process.argv.slice(2);
const browser = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
const page = await browser.newPage();
await page.addInitScript((LAT) => {
  const t0 = performance.now(); window.__log = [];
  const reply = (sql) => {
    let body = "[]";
    if (/json_agg\(json_build_array/.test(sql)) body = '[{"j":[]}]';
    else if (/^\s*select jt\./.test(sql)) body = '[{"r":null,"id":null}]';
    return { content: [{ type: "text", text: `<untrusted-data-abc>${body}</untrusted-data-abc>` }] };
  };
  const mcp = { async callTool(_s, _t, args) {
    const e = { sql: args.query, start: Math.round(performance.now() - t0) }; window.__log.push(e);
    await new Promise(r => setTimeout(r, LAT));
    e.end = Math.round(performance.now() - t0); return reply(args.query);
  } };
  window.claude = { use: (n) => n === "mcp" ? Promise.resolve(mcp) : Promise.resolve(null) };
}, Number(lat));
await page.goto("file://" + (await import("node:path")).resolve(html));
await page.waitForTimeout(Number(lat) * 40);
const log = await page.evaluate(() => window.__log);
const label = (s) => {
  const m = /from (jt\.[\w]+)/.exec(s); const c = /collection = '(\w+)'/.exec(s);
  return (c ? "docs:" + c[1] : m ? m[1] : s.slice(0, 50)) + (/hashtext/.test(s) ? " (part)" : "");
};
const dash = ["v_shopify_daily_costed","shopify_orders where","v_shopify_sales_costed","shipstation_labels","v_sync_status","ship_cost_overrides","v_combined_shipments","cost_overrides"];
console.log("#  start   end  query");
log.forEach((e, i) => console.log(String(i + 1).padStart(2), String(e.start).padStart(6), String(e.end ?? "-").padStart(6), (dash.some(d => e.sql.includes(d)) ? "* " : "  ") + label(e.sql)));
await browser.close();
