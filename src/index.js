/**
 * 1099-INT Check — static landing page plus a signup endpoint,
 * served from a Cloudflare Pages Function.
 *
 * The page lives in public/. `npm run build` copies this file to
 * dist/_worker.js, which puts Pages in "advanced mode": every request enters
 * here first, and static files are fetched deliberately via env.ASSETS. That
 * ordering is what lets the security headers below reach the page at all.
 *
 * This file attaches those headers and handles POST /api/signup, writing to
 * Supabase.
 *
 * The Supabase key never reaches the browser. The page posts same-origin
 * to /api/signup and this Worker forwards the insert, so validation, the
 * honeypot, and rate limiting cannot be bypassed by posting directly.
 */

// Inline <style> and <script> in the page require 'unsafe-inline' on those
// two directives. Everything else is shut: no external scripts, no framing,
// and connect-src is 'self' only, since the browser talks to this Worker
// rather than to a third-party form provider.
const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self'",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
};

// The walkthrough itself. Plain text on purpose: this audience reads mail in
// terminals and clients that distrust HTML, and the content is instructions,
// not marketing. It never claims the reader is finished, matching the page.
const WALKTHROUGH_TEXT = `Short version: pull one IRS transcript, compare it against
your own list of accounts, and find the interest you forgot to report.
Twenty minutes if you already have an IRS login. Closer to an hour if not.

You filed an extension, so your return isn't in yet and the IRS has had
since April to post what payers reported under your SSN. That window closes
Thursday, October 15, 2026. There is no second extension.

The transcript is not a complete record of your 2025 interest and never will
be. It shows most of what was filed, not all of it. It is still the fastest
way to find the account you forgot.

Here is the whole method.

1. Pull your Wage & Income Transcript
   Go to https://www.irs.gov/individuals/get-transcript and sign in.
   Then: tax year 2025, Wage and Income Transcript, download the PDF.

   Sign-in runs through ID.me, and this is the step people quit on. First
   time through, budget thirty minutes, not five. Have on hand:
   - a government photo ID you can photograph front and back
   - your SSN
   - a mobile number billed in your own name

   That last one is the usual failure. Google Voice, prepaid, and lines on a
   family plan in someone else's name often fail the phone match. When
   self-service fails, ID.me routes you to a live video call and the queue
   can run hours. Start on a weekday morning.

   If ID.me will not pass you at all, the paper route is Form 4506-T with
   box 8 ticked. Note that "Get Transcript by Mail" and the automated phone
   line do not offer Wage and Income at all. Allow several weeks. If the ID
   check fails you in September, send the 4506-T the same day.

2. Find the interest entries
   Search the PDF for "1099-INT". For each entry note the payer name and
   Box 1, interest income.

   Then note these, because they are easy to skip and they move money:
   - Box 3, US Treasury interest. Taxable federally, exempt from state and
     local tax. T-bills and Treasury money market funds land here.
   - Box 8, tax-exempt interest. Not taxable, still has to be reported.
   - Box 4, federal tax withheld. Backup withholding is your money back.
   - Box 2, early withdrawal penalty. Deductible if you broke a CD.

   Now search the same PDF for "1099-MISC", "1099-NEC" and "1099-OID".
   Account opening bonuses usually arrive as interest on a 1099-INT, but
   referral bonuses are typically reported on a 1099-MISC or 1099-NEC
   instead. Brokered CDs and zeros report as 1099-OID. Searching the extra
   form types costs you nothing and catches the ones that went the other way.

3. Build your own list
   From your records, list every account that paid you interest in 2025 with
   the amount. Bank statements, year-end summaries, whatever you have.

4. Compare the two lists, both directions
   Transcript has a payer you don't: that is the one you would have filed
   without. Add it.
   Amounts disagree by more than rounding: the IRS matches against the
   transcript figure, so work out why before you file. Usually a bonus
   posted as interest, or a joint account reported in full under one SSN.
   You have a payer the transcript doesn't: report it anyway. Accounts
   paying under ten dollars generate no 1099 at all and the interest is
   still taxable. This is the case no transcript can catch for you.

   Where it goes: total taxable interest on Form 1040 line 2b, tax-exempt on
   line 2a. Over 1,500 dollars of taxable interest and you also file
   Schedule B, which with ten-plus accounts you almost certainly will.

What this does not tell you
   That you are finished. The IRS does not treat the current processing year
   as final, and a payer who never filed will never appear. A clean
   comparison is not a guarantee. The only claim here is the narrow one:
   these are the payers the transcript shows that your figures do not.

   Corrected 1099s take another four to six weeks to reach the transcript
   after the payer issues them, so a pull today can miss a correction made
   in July. If you are filing in October, pull once now and once in the
   first week of October and compare. The second pull takes five minutes,
   because you are already verified.

If you get stuck at the identity check, or the transcript is missing a payer
you know about, reply to this email and tell me what happened. I read every
one.

Not a tax preparer. Not tax advice.
`

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

function clamp(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function isConfigured(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY);
}

/**
 * Salted SHA-256 of the client IP.
 *
 * The database rate limit needs to group requests by client, but storing raw
 * addresses alongside email addresses is more personal data than this page has
 * any reason to hold. A salted hash groups correctly and cannot be reversed to
 * an address. The salt is per-deployment; rotating it resets the buckets,
 * which is harmless for a 60-second window.
 */
async function hashIp(ip, salt) {
  const data = new TextEncoder().encode(`${salt || "1099-int-check"}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Reject cross-site POSTs.
 *
 * The endpoint is only ever called by our own page via fetch, so a request
 * carrying someone else's Origin is either a misconfiguration or an attempt
 * to drive our database from another site. Requests with no Origin at all
 * (curl, server-to-server) are allowed through, because blocking them buys
 * nothing — an attacker can always omit the header — while breaking
 * legitimate scripted testing.
 */
function originAllowed(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/**
 * Send the walkthrough the page promised.
 *
 * The page says "the walkthrough is on its way." If nothing sends, that
 * sentence is a lie told to the first real users this project has. So the
 * send happens here, and the response reports what actually occurred rather
 * than what we hoped occurred.
 *
 * Ordering matters: the signup row is already committed before this runs.
 * A delivery failure must never cost you the address — losing a lead is
 * worse than a late email, and the address is the whole point of the page.
 */
async function sendWalkthrough(env, email) {
  if (!env.RESEND_API_KEY || !env.WALKTHROUGH_FROM) {
    console.error("WALKTHROUGH NOT SENT - delivery unconfigured (RESEND_API_KEY / WALKTHROUGH_FROM)");
    return { ok: false, reason: "unconfigured" };
  }

  const body = {
    from: env.WALKTHROUGH_FROM,
    to: [email],
    subject: "Find the 1099-INT you forgot, before Oct 15",
    text: WALKTHROUGH_TEXT,
  };
  // A blind copy to the founder makes the inbox the delivery log: you see
  // exactly what every reader sees, with no extra infrastructure.
  if (env.FOUNDER_BCC) body.bcc = [env.FOUNDER_BCC];
  // The email asks people to reply. Without reply_to those replies vanish,
  // killing the only support channel and the only engagement signal.
  const replyTo = env.WALKTHROUGH_REPLY_TO || env.FOUNDER_BCC;
  if (replyTo) body.reply_to = replyTo;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        // A repeat signup returns 409 and still reaches this send. Without
        // this, re-submitting an address re-sends the email every time.
        "Idempotency-Key": `walkthrough:${email}`,
      },
      body: JSON.stringify(body),
      // Workers fetch has no default timeout. A hung connection would block
      // the signup response, because the send is awaited before replying.
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return { ok: true };
    // Log the provider's own words. A silent send failure is the exact
    // class of bug this project keeps finding.
    const detail = await res.text().catch(() => "");
    console.error("WALKTHROUGH SEND FAILED", res.status, detail.slice(0, 300));
    // Surface the provider status so a failed send is diagnosable without
    // log access. 401 means a bad key; 403 means the sandbox refused a
    // recipient that is not the account owner. Different fixes entirely.
    return { ok: false, reason: "provider_error", status: res.status };
  } catch (err) {
    console.error("WALKTHROUGH SEND THREW", (err && err.message) || String(err));
    return { ok: false, reason: "unreachable" };
  }
}

async function handleSignup(request, env) {
  if (!isConfigured(env)) {
    // Same principle as the page's guard: refuse loudly rather than accept
    // an address and drop it on the floor.
    return json({ error: "not_configured" }, 503);
  }

  if (!originAllowed(request)) {
    return json({ error: "forbidden_origin" }, 403);
  }

  // Rate limit per client IP.
  //
  // On Pages this binding is ALWAYS absent: Pages Functions cannot bind the
  // Cloudflare rate limiter, so the `else` branch below is the live path in
  // production and logs on every signup. That noise is deliberate. The limit
  // that actually holds is the Postgres trigger, which returns a real 429
  // further down — Cloudflare documents the edge binding as permissive and
  // eventually consistent, and it let 14 of 14 rapid writes through a 5/60
  // limit when this ran on Workers. Losing it costs a cheap first pass, not
  // the protection.
  //
  // The branch is kept rather than deleted so this file still throttles at
  // the edge if it is ever deployed as a Worker again.
  if (env.SIGNUP_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    try {
      const result = await env.SIGNUP_LIMITER.limit({ key: ip });
      // A binding that resolves without a boolean `success` is not throttling
      // anything. Say so, loudly: an empty catch here is how an endpoint ends
      // up looking protected while being wide open.
      if (!result || typeof result.success !== "boolean") {
        console.error(
          "SIGNUP_LIMITER returned no success flag — endpoint UNTHROTTLED:",
          JSON.stringify(result)
        );
      } else if (!result.success) {
        return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
      }
    } catch (err) {
      console.error(
        "SIGNUP_LIMITER.limit() threw — endpoint UNTHROTTLED:",
        (err && err.message) || String(err)
      );
    }
  } else {
    console.error("SIGNUP_LIMITER binding absent — endpoint UNTHROTTLED");
  }

  let payload;
  const contentType = request.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      payload = await request.json();
    } else {
      payload = Object.fromEntries(await request.formData());
    }
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  // Honeypot. Bots fill every field they find; humans never see this one.
  // Answer as if it succeeded so the bot gets no signal it was rejected.
  if (clamp(payload.company, 200)) return json({ ok: true }, 201);

  const raw = clamp(payload.email, 254);
  if (!raw || !EMAIL_RE.test(raw)) {
    return json({ error: "invalid_email" }, 400);
  }
  // Store one canonical form. The unique index is on lower(email), so mixed
  // case would otherwise leave the stored value inconsistent with the key.
  const email = raw.toLowerCase();

  const row = {
    email,
    source: clamp(payload.source, 64) || "direct",
    page: clamp(payload.page, 64) || "guide-landing",
    user_agent: clamp(request.headers.get("user-agent"), 512),
    ip_hash: await hashIp(
      request.headers.get("cf-connecting-ip") || "unknown",
      env.IP_HASH_SALT
    ),
  };

  let res;
  try {
    res = await fetch(`${env.SUPABASE_URL}/rest/v1/signups`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_PUBLISHABLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
  } catch {
    return json({ error: "upstream_unreachable" }, 502);
  }

  // 23505 is the unique violation on lower(email). Answer it identically to a
  // fresh signup: telling the caller "already on the list" would let anyone
  // test whether a given address is subscribed, which is an enumeration leak
  // on what is, for this audience, a sensitive list.
  if (res.ok || res.status === 409) {
    // Row is committed. Now try to deliver, and tell the caller which of
    // those two things actually happened.
    const sent = await sendWalkthrough(env, email);
    const out = { ok: true, delivered: sent.ok };
    if (!sent.ok) {
      out.delivery_reason = sent.reason;
      if (sent.status) out.delivery_status = sent.status;
    }
    return json(out, 201);
  }

  // The database trigger raises PT429, which PostgREST surfaces as a real 429.
  // On Pages this is the ONLY rate limit in front of the table, since the edge
  // binding above cannot exist here. It was always the one that actually held.
  if (res.status === 429) {
    return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
  }

  // 23514 is the email-shape check constraint, i.e. input we should have
  // caught above. Report it as a client error rather than a server fault.
  if (res.status === 400) return json({ error: "invalid_email" }, 400);

  return json({ error: "upstream_error" }, 502);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // Lets the page discover a broken backend on load, instead of only after
    // a visitor has typed an address and pressed the button.
    if (pathname === "/api/status") {
      return json({
        ok: true,
        configured: isConfigured(env),
        delivery: Boolean(env.RESEND_API_KEY && env.WALKTHROUGH_FROM),
        // Resend's sandbox sender can only reach the account owner. Reporting
        // delivery:true from it would claim reach this cannot deliver.
        sandbox: String(env.WALKTHROUGH_FROM || "").includes("resend.dev"),
      });
    }

    if (pathname === "/api/signup") {
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
      }
      return handleSignup(request, env);
    }

    if (pathname === "/healthz") {
      return new Response("ok", {
        headers: { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS },
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD", ...SECURITY_HEADERS },
      });
    }

    const assetResponse = await env.ASSETS.fetch(request);

    // Response headers are immutable as returned; clone to add our own.
    const response = new Response(assetResponse.body, assetResponse);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      response.headers.set(key, value);
    }
    return response;
  },
};
