// Barcode images for printed paperwork (Brian, Oct 15: barcodes on the Shopify packing slips, so the warehouse can scan
// a slip on Seller Sage's Packing photos page). GET ?t=<text>[&h=<bar height px>][&label=0] -> a Code 128 (set B) SVG.
// Public (no sign-in): it only draws the text it is given, which is the order number printed beside it anyway.
// Deployed with verify_jwt off. Packing slip template: <img src=".../functions/v1/barcode?t={{ order.name | remove: '#' }}">

const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", "221312", "231212", "112232",
  "122132", "122231", "113222", "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122",
  "321221", "312212", "322112", "322211", "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311",
  "211313", "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331", "231131", "213113",
  "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224", "111422",
  "121124", "121421", "141122", "141221", "112214", "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111",
  "241112", "134111", "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141", "214121",
  "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112",
];
const START_B = 104, STOP = 106;

function code128(text: string): string {
  const vals = [START_B];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error("only printable ASCII");
    vals.push(c - 32);
  }
  let sum = START_B;
  for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103, STOP);
  return vals.map((v) => PATTERNS[v]).join("");
}

function svg(text: string, h: number, label: boolean): string {
  const widths = code128(text), q = 10, x = 2;            // quiet zone 10 modules, 2px per module
  let total = 0; for (const w of widths) total += +w;
  const W = (total + q * 2) * x, H = h + (label ? 22 : 0) + 8;
  let pos = q * x, bars = "";
  [...widths].forEach((w, i) => { const px = +w * x; if (i % 2 === 0) bars += `<rect x="${pos}" y="4" width="${px}" height="${h}"/>`; pos += px; });
  const esc = text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">` +
    `<rect width="${W}" height="${H}" fill="#fff"/><g fill="#000">${bars}</g>` +
    (label ? `<text x="${W / 2}" y="${h + 22}" font-family="Helvetica,Arial,sans-serif" font-size="16" text-anchor="middle">${esc}</text>` : "") + `</svg>`;
}

Deno.serve((req) => {
  const u = new URL(req.url);
  const t = (u.searchParams.get("t") || "").trim().slice(0, 60);
  const h = Math.min(200, Math.max(20, Number(u.searchParams.get("h")) || 60));
  const label = u.searchParams.get("label") !== "0";
  if (!t) return new Response("?t= missing", { status: 400 });
  try {
    return new Response(svg(t, h, label), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*" } });
  } catch (e) {
    return new Response(String((e as Error).message), { status: 400 });
  }
});
