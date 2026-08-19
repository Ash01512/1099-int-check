/**
 * Assemble the Pages build output directory.
 *
 * Cloudflare Pages deploys a single directory. In "advanced mode" the server
 * code has to sit inside that same directory, at its root, named exactly
 * `_worker.js`. Pages recognises that name and runs it instead of serving it
 * as a static file.
 *
 * Rather than keep server code inside public/ — where a rename or a Pages
 * behaviour change would publish the Supabase call path as a downloadable
 * text file — public/ stays purely static, src/ stays purely server, and this
 * script composes dist/ from both. dist/ is generated and gitignored.
 *
 * It also computes the CSP hashes for the page's inline <script> and <style>
 * blocks and substitutes them into the worker, which is what lets the policy
 * drop 'unsafe-inline'. See computeInlineHashes below for why that has to
 * happen here rather than being written by hand.
 *
 * Plain Node, no dependencies, no shell builtins: this runs on Windows
 * locally and Ubuntu in CI, and `cp -r` is not available on both.
 */

import { readFile, writeFile, readdir, rm, mkdir, access, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const publicDir = join(root, "public");
const workerSrc = join(root, "src", "index.js");

/**
 * Files copied as text, with line endings normalised to LF.
 *
 * This is not tidiness. Cloudflare Pages normalises line endings when it
 * ingests text assets — measured: the deployed page returned 0 CR bytes where
 * the repository file, checked out on Windows with autocrlf, held 382. The CSP
 * hashes below are computed over the bytes in dist/, so if dist/ kept CRLF the
 * hash would describe a file the browser never receives, the browser would
 * refuse to run the page's only script, and the signup form would silently
 * stop working. Normalising here makes local bytes and served bytes the same.
 */
const TEXT_EXTENSIONS = new Set([".html", ".txt", ".css", ".js", ".json", ".svg", ".xml"]);

/**
 * CSP source-expression hashes for every inline block in the page.
 *
 * A hash must match the element's content byte for byte. Hand-maintaining
 * these would mean every edit to the page's script or styles silently breaks
 * the page in production and nowhere else, so they are derived from the file
 * that actually ships on every build.
 */
function computeInlineHashes(html, tag) {
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "g");
  const hashes = [];
  for (const [, attrs, body] of html.matchAll(pattern)) {
    // An element loaded from a URL is covered by 'self', not by a hash.
    if (/\bsrc\s*=/i.test(attrs) || /\bhref\s*=/i.test(attrs)) continue;
    const digest = createHash("sha256").update(body, "utf8").digest("base64");
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from)) {
    const src = join(from, entry);
    const dest = join(to, entry);
    if ((await stat(src)).isDirectory()) {
      await copyTree(src, dest);
      continue;
    }
    if (TEXT_EXTENSIONS.has(extname(entry).toLowerCase())) {
      const text = (await readFile(src, "utf8")).replace(/\r\n/g, "\n");
      await writeFile(dest, text, "utf8");
    } else {
      await writeFile(dest, await readFile(src));
    }
  }
}

// Fail loudly on a missing input. A build that quietly produces a dist/ with
// no _worker.js deploys a static page whose /api/signup 404s — the exact
// class of silent breakage this project keeps running into.
for (const required of [publicDir, workerSrc]) {
  try {
    await access(required);
  } catch {
    console.error(`build failed: missing ${required}`);
    process.exit(1);
  }
}

// Start clean so a deleted asset cannot survive in dist/ and keep shipping.
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await copyTree(publicDir, dist);

const html = await readFile(join(dist, "index.html"), "utf8");
const scriptHashes = computeInlineHashes(html, "script");
const styleHashes = computeInlineHashes(html, "style");

if (scriptHashes.length === 0 || styleHashes.length === 0) {
  console.error(
    `build failed: found ${scriptHashes.length} inline script and ${styleHashes.length} inline style blocks. ` +
    `Zero of either means the CSP would ship without the hashes the page needs, and the browser ` +
    `would block it. If the page genuinely stopped using inline blocks, update this check.`
  );
  process.exit(1);
}

let worker = await readFile(workerSrc, "utf8");
const substitutions = [
  ["__INLINE_SCRIPT_HASHES__", scriptHashes.join(" ")],
  ["__INLINE_STYLE_HASHES__", styleHashes.join(" ")],
];
for (const [token, value] of substitutions) {
  if (!worker.includes(token)) {
    console.error(
      `build failed: ${token} not found in src/index.js. The worker would ship with a CSP ` +
      `that still allows 'unsafe-inline', which is the weakness these hashes exist to remove.`
    );
    process.exit(1);
  }
  worker = worker.replaceAll(token, value);
}

await writeFile(join(dist, "_worker.js"), worker.replace(/\r\n/g, "\n"), "utf8");

console.log(
  `built dist/ — ${relative(root, publicDir)}/* + src/index.js -> _worker.js, ` +
  `CSP pinned to ${scriptHashes.length} script and ${styleHashes.length} style hash(es)`
);
