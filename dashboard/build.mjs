// Build the single-file dashboard page from dashboard/src.
//
//   node dashboard/build.mjs
//     -> dashboard/dist/just-tennis-sales.html   (Claude artifact)
//     -> dashboard/dist/web/index.html           (dashboard.andersenlifestyle.com, served by Vercel)
//
// index.html holds the page shell; each <!-- @inline path --> marker is replaced with that file's contents.
// The two outputs are the same page: it detects where it runs (inside Claude or on the web) at load time.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "src"), DIST = join(here, "dist");
const MARK = /<!-- @inline ([\w./-]+) -->/g;

let html = readFileSync(join(SRC, "index.html"), "utf8").replace(MARK, (_, rel) => {
  const p = join(SRC, rel);
  if (!existsSync(p)) { console.error(`missing ${p}`); process.exit(1); }
  return readFileSync(p, "utf8").replace(/\n+$/, "");
});
if (MARK.test(html)) { console.error("nested @inline markers are not supported"); process.exit(1); }

// Version shown next to the account chip, so it's easy to tell which deploy the browser has.
let sha = process.env.VERCEL_GIT_COMMIT_SHA || "";
if (!sha) { try { sha = execSync("git rev-parse HEAD", { cwd: here, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch (_) {} }
html = html.replace(/__BUILD__/g, (sha || "local").slice(0, 7));

mkdirSync(join(DIST, "web"), { recursive: true });
writeFileSync(join(DIST, "just-tennis-sales.html"), html);
// The Claude host wraps the page in its own document; the web copy needs a full one.
const web = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/icon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#F3F5F2">
${html}`.replace(/<\/style>\n/, "</style>\n</head>\n<body>\n") + "\n</body>\n</html>\n";
writeFileSync(join(DIST, "web", "index.html"), web);
// Tab icon (a tennis ball) served next to the page.
for (const [from, to] of [["favicon.svg", "favicon.svg"], ["icon-32.png", "icon-32.png"], ["icon-32.png", "favicon.ico"], ["icon-180.png", "apple-touch-icon.png"]])
  copyFileSync(join(SRC, "icon", from), join(DIST, "web", to));
console.log(`built dashboard/dist/just-tennis-sales.html and dashboard/dist/web/index.html (${Math.round(html.length / 1024)} KB)`);
