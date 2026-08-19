/**
 * Prove the deployed page can actually run its own code.
 *
 * The CSP names each inline block by SHA-256 hash instead of allowing
 * 'unsafe-inline'. That is strictly better security and a strictly worse
 * failure mode: a hash that is wrong by one byte does not warn, does not log,
 * and does not change a status code. The browser simply refuses to execute the
 * page's only script, so the signup form stops doing anything and every
 * curl-based check in CI still reports a healthy 200.
 *
 * Cloudflare Pages also rewrites line endings on ingest — measured, 382 CR
 * bytes present locally and absent in the response — so "it hashed correctly on
 * my machine" is not evidence about what the browser receives.
 *
 * This fetches the real page over the network, extracts the inline blocks
 * exactly as delivered, hashes them, and asserts every one is named in the
 * CSP header that arrived with them.
 *
 *   node scripts/verify-csp.mjs https://1099-int-check.pages.dev
 */

import { createHash } from "node:crypto";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/verify-csp.mjs <url>");
  process.exit(2);
}

const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
  console.error(`FAIL ${url} returned ${res.status}`);
  process.exit(1);
}

const csp = res.headers.get("content-security-policy");
if (!csp) {
  console.error("FAIL no Content-Security-Policy header on the page");
  process.exit(1);
}
const html = await res.text();

function inlineBlocks(tag) {
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "g");
  return [...html.matchAll(pattern)]
    .filter(([, attrs]) => !/\b(src|href)\s*=/i.test(attrs))
    .map(([, , body]) => body);
}

function directive(name) {
  const found = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  return found || "";
}

let failed = 0;

for (const [tag, name] of [["script", "script-src"], ["style", "style-src"]]) {
  const blocks = inlineBlocks(tag);
  const sources = directive(name);

  if (blocks.length === 0) {
    console.log(`  ${tag}: no inline blocks served`);
    continue;
  }

  // 'unsafe-inline' is ignored by browsers whenever a hash or nonce is also
  // present, so its appearance here means the build did not substitute and the
  // policy silently reverted to the weaker one it is supposed to replace.
  if (sources.includes("'unsafe-inline'")) {
    console.error(`  FAIL ${name} still allows 'unsafe-inline' — the build did not substitute hashes`);
    failed = 1;
    continue;
  }

  for (const [i, body] of blocks.entries()) {
    const digest = createHash("sha256").update(body, "utf8").digest("base64");
    if (sources.includes(`'sha256-${digest}'`)) {
      console.log(`  ok   ${tag}[${i}] sha256-${digest.slice(0, 12)}… named in ${name}`);
    } else {
      console.error(
        `  FAIL ${tag}[${i}] hashes to sha256-${digest} but ${name} does not name it.\n` +
        `       The browser is refusing to run this block. The page looks fine and is broken.`
      );
      failed = 1;
    }
  }
}

if (failed) {
  console.error("\nCSP does not match the content actually served.");
  process.exit(1);
}
console.log("\nCSP matches every inline block as served.");
