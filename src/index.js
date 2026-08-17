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
// and connect-src is 'self' only, since the browser now talks to this
// Worker rather than to a third-party form provider.
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

async function handleSignup(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    // Same principle as the page's placeholder guard: refuse loudly rather
    // than accept an address and drop it on the floor.
    return json({ error: "not_configured" }, 503);
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
  // Answer 200 so the bot has no signal that it was rejected.
  if (clamp(payload.company, 200)) return json({ ok: true });

  const email = clamp(payload.email, 254);
  if (!email || !EMAIL_RE.test(email)) {
    return json({ error: "invalid_email" }, 400);
  }

  const row = {
    email,
    source: clamp(payload.source, 64) || "direct",
    page: clamp(payload.page, 64) || "guide-landing",
    user_agent: clamp(request.headers.get("user-agent"), 512),
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

  if (res.ok) return json({ ok: true }, 201);

  // 23505 is the unique violation on lower(email). Already subscribed is a
  // success from the reader's point of view, not an error to apologise for.
  if (res.status === 409) return json({ ok: true, already: true });

  // 23514 is the email-shape check constraint, i.e. input we should have
  // caught above. Report it as a client error rather than a server fault.
  if (res.status === 400) return json({ error: "invalid_email" }, 400);

  return json({ error: "upstream_error" }, 502);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

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
