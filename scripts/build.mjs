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
 * Plain Node, no dependencies, no shell builtins: this runs on Windows
 * locally and Ubuntu in CI, and `cp -r` is not available on both.
 */

import { cp, rm, mkdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const publicDir = join(root, "public");
const workerSrc = join(root, "src", "index.js");

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

await cp(publicDir, dist, { recursive: true });
await cp(workerSrc, join(dist, "_worker.js"));

console.log("built dist/ (public/* + src/index.js -> _worker.js)");
