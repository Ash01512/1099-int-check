/**
 * Tests for the things that ship rather than the things that are written.
 *
 * src/index.js is the source of truth, but it is not what runs. dist/_worker.js
 * is, and the difference between them is a build step that rewrites the CSP.
 * A test that only ever imports src/ would pass while the deployed policy was
 * wrong in either direction — too permissive, or so strict it blocks the page.
 *
 * The redirect Worker is covered here for the same reason: it is deployed by
 * CI and nothing else asserted its behaviour.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import builtWorker from "../dist/_worker.js";
import redirectWorker from "../redirect/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const pageResponse = () =>
  builtWorker.fetch(new Request("https://site.test/"), {
    ASSETS: { fetch: async () => new Response("<html>", { status: 200 }) },
  });

function inlineBlocks(html, tag) {
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "g");
  return [...html.matchAll(pattern)]
    .filter(([, attrs]) => !/\b(src|href)\s*=/i.test(attrs))
    .map(([, , body]) => body);
}

describe("the built worker's CSP", () => {
  test("names every inline block in the page it ships with", async () => {
    // The hash must match byte for byte. If this drifts, the browser silently
    // refuses to run the page's only script and the form stops working while
    // every status-code check still reports 200.
    const html = await readFile(join(root, "dist", "index.html"), "utf8");
    const csp = (await pageResponse()).headers.get("Content-Security-Policy");

    for (const [tag, directive] of [["script", "script-src"], ["style", "style-src"]]) {
      const blocks = inlineBlocks(html, tag);
      assert.ok(blocks.length > 0, `expected inline <${tag}> blocks in the built page`);
      for (const body of blocks) {
        const digest = createHash("sha256").update(body, "utf8").digest("base64");
        assert.ok(
          csp.includes(`'sha256-${digest}'`),
          `${directive} does not name the ${tag} block hashing to sha256-${digest}`
        );
      }
    }
  });

  test("does not fall back to 'unsafe-inline'", async () => {
    const csp = (await pageResponse()).headers.get("Content-Security-Policy");
    assert.ok(!csp.includes("unsafe-inline"), `built CSP still allows unsafe-inline: ${csp}`);
  });

  test("no build placeholder survived into the artifact", async () => {
    const csp = (await pageResponse()).headers.get("Content-Security-Policy");
    assert.ok(!csp.includes("__INLINE"), "build did not substitute the hash tokens");
  });

  test("still permits no external origin", async () => {
    const csp = (await pageResponse()).headers.get("Content-Security-Policy");
    assert.match(csp, /default-src 'none'/);
    assert.ok(!/https?:\/\//.test(csp));
  });
});

describe("the built page", () => {
  test("ships with LF line endings, matching what Pages serves", async () => {
    // Pages rewrites line endings on ingest. If dist/ kept CRLF the CSP hashes
    // would describe bytes the browser never receives.
    const html = await readFile(join(root, "dist", "index.html"), "utf8");
    assert.ok(!html.includes("\r"), "dist/index.html contains CR bytes");
  });

  test("hides the honeypot from assistive technology", async () => {
    // .hp uses position:absolute;left:-9999px, which deliberately KEEPS the
    // field in the accessibility tree. Without aria-hidden a screen reader
    // announces it as a real field, and a blind visitor who fills it has their
    // signup silently discarded behind a fake success.
    const html = await readFile(join(root, "dist", "index.html"), "utf8");
    const honeypotTags = [...html.matchAll(/<(?:label|input)[^>]*class="hp"[^>]*>/g)].map((m) => m[0]);
    assert.equal(honeypotTags.length, 2, "expected a honeypot label and input");
    for (const tag of honeypotTags) {
      assert.match(tag, /aria-hidden="true"/, `honeypot element is exposed to screen readers: ${tag}`);
    }
  });

  test("gives keyboard focus a visible state", async () => {
    const html = await readFile(join(root, "dist", "index.html"), "utf8");
    assert.match(html, /:focus-visible\s*{[^}]*outline:/);
  });
});

describe("the retired-hostname redirect", () => {
  const call = (path, method = "GET") =>
    redirectWorker.fetch(
      new Request(`https://1099-int-check.ashabbas-2023.workers.dev${path}`, { method })
    );

  test("301s a GET to the live site", async () => {
    const res = await call("/");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://1099-int-check.pages.dev/");
  });

  test("preserves path and query, so shared ?src= links keep attributing", async () => {
    const res = await call("/somewhere?src=churning&x=1");
    assert.equal(
      res.headers.get("Location"),
      "https://1099-int-check.pages.dev/somewhere?src=churning&x=1"
    );
  });

  test("308s a POST, so the method and body survive", async () => {
    // A 301 would silently rewrite an old POST into a GET and drop the body.
    const res = await call("/api/signup", "POST");
    assert.equal(res.status, 308);
  });

  test("sends no body, and keeps framing protections", async () => {
    const res = await call("/");
    assert.equal(await res.text(), "");
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  });

  test("never touches env, so it cannot write to the signups table", async () => {
    // Two deployments writing to public.signups would split the mailing list
    // with no error anywhere. The redirect takes no env argument at all.
    assert.equal(redirectWorker.fetch.length, 1, "redirect fetch must take only (request)");
  });
});
