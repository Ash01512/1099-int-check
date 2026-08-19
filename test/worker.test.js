/**
 * Tests for the signup handler.
 *
 * Node's built-in runner, no dependencies, no framework. This project has one
 * devDependency and that is worth keeping.
 *
 * These exist because the review found two defects that source review could
 * not see and CI's post-deploy curl checks could not catch: they only run
 * against production, and only after a bad deploy has already happened. The
 * properties asserted here are the ones whose failure would be silent —
 * a signup that leaks list membership, a honeypot that writes a row, an origin
 * check that stops checking. None of those change a status code you would
 * notice.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const SUPABASE = {
  SUPABASE_URL: "https://db.example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};

/** Requests captured by the fetch stub, so we can assert what was sent. */
let sent;

/**
 * Stub global fetch. `supabaseStatus` decides how the insert answers, which is
 * how duplicate handling gets exercised without a database.
 */
function stubFetch({ supabaseStatus = 201, providerStatus = 201 } = {}) {
  sent = { supabase: [], provider: [] };
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const record = {
      url: href,
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null,
    };
    if (href.includes("supabase")) {
      sent.supabase.push(record);
      return new Response("", { status: supabaseStatus });
    }
    sent.provider.push(record);
    return new Response(JSON.stringify({ id: "stub" }), { status: providerStatus });
  };
}

function signup(fields, { env = {}, headers = {} } = {}) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return worker.fetch(
    new Request("https://site.test/api/signup", { method: "POST", body, headers }),
    { ...SUPABASE, ...env }
  );
}

const json = (res) => res.json();

beforeEach(() => stubFetch());

describe("email validation", () => {
  for (const bad of ["", "   ", "nope", "a@b", "a@b.c", "no-at-sign.com", "two@@at.com"]) {
    test(`rejects ${JSON.stringify(bad)}`, async () => {
      const res = await signup({ email: bad });
      assert.equal(res.status, 400);
      assert.equal((await json(res)).error, "invalid_email");
      assert.equal(sent.supabase.length, 0, "must not write on invalid input");
    });
  }

  test("accepts a normal address", async () => {
    const res = await signup({ email: "reader@example.com" });
    assert.equal(res.status, 201);
    assert.equal(sent.supabase.length, 1);
  });

  test("lowercases before storing, matching the lower(email) unique index", async () => {
    await signup({ email: "Reader@Example.COM" });
    assert.equal(sent.supabase[0].body.email, "reader@example.com");
  });

  test("clamps overlong fields rather than forwarding them", async () => {
    await signup({ email: "reader@example.com", source: "x".repeat(500) });
    assert.equal(sent.supabase[0].body.source.length, 64);
  });
});

describe("honeypot", () => {
  test("a filled honeypot writes nothing", async () => {
    const res = await signup({ email: "bot@example.com", company: "Acme Bot" });
    assert.equal(res.status, 201);
    assert.equal(sent.supabase.length, 0, "honeypot must not reach the database");
  });

  test("its response is indistinguishable from a real signup", async () => {
    // If a bot could tell it was caught, it would simply stop filling the field.
    const trap = await signup({ email: "bot@example.com", company: "Acme Bot" });
    const real = await signup({ email: "human@example.com" }, { env: {} });
    assert.equal(trap.status, real.status);
    assert.deepEqual(await json(trap), { ok: true });
  });
});

describe("origin check", () => {
  test("rejects a cross-site Origin", async () => {
    const res = await signup(
      { email: "reader@example.com" },
      { headers: { Origin: "https://evil.example" } }
    );
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error, "forbidden_origin");
    assert.equal(sent.supabase.length, 0);
  });

  test("allows a same-site Origin", async () => {
    const res = await signup(
      { email: "reader@example.com" },
      { headers: { Origin: "https://site.test" } }
    );
    assert.equal(res.status, 201);
  });

  test("allows a missing Origin, so scripted testing still works", async () => {
    const res = await signup({ email: "reader@example.com" });
    assert.equal(res.status, 201);
  });
});

describe("duplicate signups", () => {
  // The whole point: a distinct answer for an already-stored address would let
  // anyone test whether a given person is on the list.
  test("answer is byte-identical to a new signup", async () => {
    const env = { BREVO_API_KEY: "k", WALKTHROUGH_FROM: "hi@example.com" };

    stubFetch({ supabaseStatus: 201 });
    const fresh = await signup({ email: "reader@example.com" }, { env });
    const freshBody = await fresh.text();

    stubFetch({ supabaseStatus: 409 });
    const dupe = await signup({ email: "reader@example.com" }, { env });
    const dupeBody = await dupe.text();

    assert.equal(dupe.status, fresh.status);
    assert.equal(dupeBody, freshBody);
  });

  test("a duplicate still triggers a send", async () => {
    stubFetch({ supabaseStatus: 409 });
    await signup(
      { email: "reader@example.com" },
      { env: { BREVO_API_KEY: "k", WALKTHROUGH_FROM: "hi@example.com" } }
    );
    assert.equal(sent.provider.length, 1);
  });
});

describe("upstream failures are reported, not swallowed", () => {
  test("database rate limit surfaces as 429", async () => {
    stubFetch({ supabaseStatus: 429 });
    const res = await signup({ email: "reader@example.com" });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "60");
  });

  test("missing Supabase config refuses loudly", async () => {
    const res = await worker.fetch(
      new Request("https://site.test/api/signup", { method: "POST", body: new FormData() }),
      {}
    );
    assert.equal(res.status, 503);
    assert.equal((await json(res)).error, "not_configured");
  });

  test("a failed send never costs the signup", async () => {
    stubFetch({ supabaseStatus: 201, providerStatus: 401 });
    const res = await signup(
      { email: "reader@example.com" },
      { env: { BREVO_API_KEY: "bad", WALKTHROUGH_FROM: "hi@example.com" } }
    );
    const body = await json(res);
    assert.equal(res.status, 201);
    assert.equal(body.ok, true, "the address is kept even when delivery fails");
    assert.equal(body.delivered, false);
    assert.equal(body.delivery_status, 401, "provider status is surfaced for diagnosis");
  });
});

describe("provider dispatch", () => {
  const from = { WALKTHROUGH_FROM: "hi@example.com" };

  test("Brevo: correct endpoint, auth header and payload shape", async () => {
    await signup({ email: "reader@example.com" }, {
      env: { ...from, BREVO_API_KEY: "brevo-key", FOUNDER_BCC: "me@example.com" },
    });
    const req = sent.provider[0];
    assert.equal(req.url, "https://api.brevo.com/v3/smtp/email");
    assert.equal(req.headers["api-key"], "brevo-key");
    assert.equal(req.body.sender.email, "hi@example.com");
    assert.deepEqual(req.body.to, [{ email: "reader@example.com" }]);
    assert.deepEqual(req.body.bcc, [{ email: "me@example.com" }]);
    assert.ok(req.body.textContent.includes("Wage & Income Transcript"));
  });

  test("Resend: correct endpoint and an idempotency key", async () => {
    await signup({ email: "reader@example.com" }, {
      env: { ...from, RESEND_API_KEY: "resend-key" },
    });
    const req = sent.provider[0];
    assert.equal(req.url, "https://api.resend.com/emails");
    assert.equal(req.headers.Authorization, "Bearer resend-key");
    assert.equal(req.headers["Idempotency-Key"], "walkthrough:reader@example.com");
  });

  test("WALKTHROUGH_PROVIDER wins when both keys exist", async () => {
    await signup({ email: "reader@example.com" }, {
      env: { ...from, BREVO_API_KEY: "b", RESEND_API_KEY: "r", WALKTHROUGH_PROVIDER: "resend" },
    });
    assert.ok(sent.provider[0].url.includes("resend.com"));
  });

  test("no key means no send, and it says so", async () => {
    const res = await signup({ email: "reader@example.com" }, { env: from });
    assert.equal(sent.provider.length, 0);
    assert.equal((await json(res)).delivery_reason, "unconfigured");
  });

  test("the email offers a way off the list", async () => {
    await signup({ email: "reader@example.com" }, { env: { ...from, BREVO_API_KEY: "k" } });
    assert.match(sent.provider[0].body.textContent, /remove/i);
  });
});

describe("ip_hash", () => {
  test("the salt actually changes the hash", async () => {
    // The review found IP_HASH_SALT unset in production, so ip_hash was
    // computed with a salt published in this repo and was reversible.
    await signup({ email: "a@example.com" }, {
      env: { IP_HASH_SALT: "salt-one" },
      headers: { "cf-connecting-ip": "203.0.113.7" },
    });
    const one = sent.supabase[0].body.ip_hash;

    stubFetch();
    await signup({ email: "a@example.com" }, {
      env: { IP_HASH_SALT: "salt-two" },
      headers: { "cf-connecting-ip": "203.0.113.7" },
    });
    const two = sent.supabase[0].body.ip_hash;

    assert.notEqual(one, two, "salt must be part of the digest");
    assert.match(one, /^[0-9a-f]{64}$/);
  });

  test("the raw address is never stored", async () => {
    await signup({ email: "a@example.com" }, {
      env: { IP_HASH_SALT: "s" },
      headers: { "cf-connecting-ip": "203.0.113.7" },
    });
    assert.ok(!JSON.stringify(sent.supabase[0].body).includes("203.0.113.7"));
  });
});

describe("routing and headers", () => {
  const env = { ...SUPABASE, ASSETS: { fetch: async () => new Response("<html>", { status: 200 }) } };
  const get = (path, method = "GET") =>
    worker.fetch(new Request(`https://site.test${path}`, { method }), env);

  test("GET /api/signup is 405 with an Allow header", async () => {
    const res = await get("/api/signup");
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("Allow"), "POST");
  });

  test("/healthz answers without touching the asset store", async () => {
    const res = await get("/healthz");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });

  test("security headers reach page responses, not just the API", async () => {
    // The inverse shipped once: headers on the API, none on the page.
    const res = await get("/");
    for (const h of [
      "Content-Security-Policy",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Strict-Transport-Security",
      "Referrer-Policy",
      "Permissions-Policy",
      "Cross-Origin-Opener-Policy",
    ]) {
      assert.ok(res.headers.get(h), `missing ${h} on GET /`);
    }
  });

  test("the CSP allows no external origins", async () => {
    const csp = (await get("/")).headers.get("Content-Security-Policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.ok(!/https?:\/\//.test(csp), "CSP must not permit an external host");
  });

  test("writes to other paths are refused", async () => {
    const res = await get("/", "DELETE");
    assert.equal(res.status, 405);
  });
});

describe("/api/status tells the truth", () => {
  const status = async (env) =>
    json(await worker.fetch(new Request("https://site.test/api/status"), { ...SUPABASE, ...env }));

  test("no provider: delivery false", async () => {
    const s = await status({});
    assert.equal(s.delivery, false);
    assert.equal(s.provider, null);
  });

  test("a key without a sender is not delivery", async () => {
    // A wrong or missing sender means every send is rejected; reporting
    // delivery:true here is the "looks configured, delivers nothing" failure.
    assert.equal((await status({ BREVO_API_KEY: "k" })).delivery, false);
  });

  test("Resend on its shared domain reports sandbox", async () => {
    const s = await status({ RESEND_API_KEY: "k", WALKTHROUGH_FROM: "onboarding@resend.dev" });
    assert.equal(s.sandbox, true, "sandbox reaches only the account owner");
  });

  test("a personal mailbox sender is flagged unaligned", async () => {
    assert.equal(
      (await status({ BREVO_API_KEY: "k", WALKTHROUGH_FROM: "me@gmail.com" })).unaligned_sender,
      true
    );
    assert.equal(
      (await status({ BREVO_API_KEY: "k", WALKTHROUGH_FROM: "hi@owndomain.com" })).unaligned_sender,
      false
    );
  });

  test("an unset IP salt is reported", async () => {
    assert.equal((await status({})).ip_salt_set, false);
    assert.equal((await status({ IP_HASH_SALT: "s" })).ip_salt_set, true);
  });

  test("status never leaks a secret", async () => {
    const s = await status({
      BREVO_API_KEY: "super-secret-key",
      RESEND_API_KEY: "another-secret",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      IP_HASH_SALT: "the-salt",
      WALKTHROUGH_FROM: "hi@example.com",
    });
    const body = JSON.stringify(s);
    for (const secret of ["super-secret-key", "another-secret", "sb_publishable_test", "the-salt"]) {
      assert.ok(!body.includes(secret), `status leaked ${secret}`);
    }
  });
});
