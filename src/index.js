/**
 * 1099-INT Check — static landing page served from a Cloudflare Worker.
 *
 * The page itself lives in public/. This Worker exists only to attach
 * security headers, which an assets-only Worker cannot do.
 *
 * The page collects one email address and posts it directly to Formspree
 * from the browser. Nothing is stored at the edge, and this Worker never
 * sees a submission.
 */

// The page uses inline <style> and inline <script>, so 'unsafe-inline' is
// required for those two directives. Everything else is locked shut: no
// external scripts, no framing, and outbound connections limited to the
// form endpoint.
const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src https://formspree.io https://usebasin.com https://formsubmit.co",
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

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // Cheap liveness check that does not touch the asset store.
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
