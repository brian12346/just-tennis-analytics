// Build the finance dashboard (finance.andersenlifestyle.com) into one page: finance/dist/index.html.
//   node finance/build.mjs        (Vercel runs it with finance/ as the project's root directory)
// src/index.html holds the shell; each <!-- @inline file --> marker is replaced with that file from src/.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "src"), DIST = join(here, "dist");
let html = readFileSync(join(SRC, "index.html"), "utf8").replace(/<!-- @inline ([\w./-]+) -->/g, (_, rel) => {
  const p = join(SRC, rel);
  if (!existsSync(p)) { console.error(`missing ${p}`); process.exit(1); }
  return readFileSync(p, "utf8").replace(/\n+$/, "");
});
let sha = process.env.VERCEL_GIT_COMMIT_SHA || "";
if (!sha) { try { sha = execSync("git rev-parse HEAD", { cwd: here, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch (_) {} }
html = html.replace(/__BUILD__/g, (sha || "local").slice(0, 7)).replace(/__VERSION__/g, readFileSync(join(here, "VERSION"), "utf8").trim());
mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, "index.html"), html);
console.log(`built finance/dist/index.html (${Math.round(html.length / 1024)} KB)`);
