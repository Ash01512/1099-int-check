/**
 * 1099-INT Check — static landing page plus a signup endpoint,
 * served from a Cloudflare Worker.
 *
 * The page lives in public/. This Worker attaches security headers and
 * handles POST /api/signup, writing to Supabase.
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
const WALKTHROUGH_TEXT = `Checking your 1099-INTs before October 15

You filed an extension, so you have something most filers don't: the IRS
record of what was reported under your SSN is complete enough to check, and
your return isn't in yet. That overlap closes October 15.

Here is the whole method. It takes about twenty minutes.

1. Pull your Wage & Income Transcript
   Go to irs.gov/individuals/get-transcript and sign in. Choose
   "Wage & Income Transcript" for tax year 2025.
   Expect an identity check. This is the step people quit on. Budget ten
   minutes and have a photo ID and your phone to hand.

2. Find the interest section
   The transcript groups forms by type. You want the 1099-INT entries.
   For each one, note two things: the payer name, and Box 1.

3. Build your own list
   From your records, list every account that paid you interest in 2025,
   with the amount. Bank statements, year-end summaries, whatever you have.

4. Compare the two lists
   Work down the transcript. Any payer the IRS has that your list does not
   is one you would have filed without. Add it before you file.

What this does not tell you
   That you are finished. The IRS does not treat the current processing year
   as final, and a payer who never filed will never appear. A clean
   comparison is not a guarantee. The only claim here is the narrow one:
   these are the payers the transcript shows that your figures do not.

If you get stuck at the identity check, or the transcript is missing a payer
you know about, reply to this email and tell me what happened. I read every
one.

Not a tax preparer. Not tax advice.
`;

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
    subject: "Checking your 1099-INTs before October 15",
    text: WALKTHROUGH_TEXT,
  };
  // A blind copy to the founder makes the inbox the delivery log: you see
  // exactly what every reader sees, with no extra infrastructure.
  if (env.FOUNDER_BCC) body.bcc = [env.FOUNDER_BCC];

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    // Log the provider's own words. A silent send failure is the exact
    // class of bug this project keeps finding.
    const detail = await res.text().catch(() => "");
    console.error("WALKTHROUGH SEND FAILED", res.status, detail.slice(0, 300));
    return { ok: false, reason: "provider_error" };
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

  // Rate limit per client IP. Cloudflare's binding is optional so that local
  // dev and a misconfigured deploy still function; when it is absent we log
  // rather than silently pretending the endpoint is protected.
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
    return json({ ok: true, delivered: sent.ok }, 201);
  }

  // The database trigger raises PT429, which PostgREST surfaces as a real 429.
  // This is the limit that actually holds; the Cloudflare binding above is a
  // cheap first pass that its own docs describe as permissive.
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
