/**
 * Retired hostname: 1099-int-check.ashabbas-2023.workers.dev
 *
 * This Worker used to BE the site. After the move to Cloudflare Pages it
 * serves one purpose: sending everything that still points at the old address
 * to the real one, permanently.
 *
 * Deleting the Worker instead would have been tidier and wrong. That hostname
 * was the published production URL, so it may sit in a browser history, a
 * saved note, or a post somewhere. A dead hostname turns each of those into a
 * connection error; a redirect turns them into a visit.
 *
 * It also consolidates search ranking. Both hostnames served identical HTML,
 * and the canonical tag added to the page cannot help here, because this
 * Worker no longer serves that page at all.
 *
 * There are no bindings and no secrets in use. The Supabase and Resend
 * secrets previously set on this Worker are now unreachable from this code —
 * signups belong to the Pages deployment, and letting two deployments write
 * to the same table would quietly split the list in two.
 */

const TARGET = "https://1099-int-check.pages.dev";

export default {
  fetch(request) {
    const url = new URL(request.url);

    // Preserve path and query so a shared deep link, and the ?src= parameter
    // that tells r/churning apart from DoC, both survive the hop.
    const destination = TARGET + url.pathname + url.search;

    // 301 for the cases search engines care about: it is the clearest
    // "this moved for good" signal and every crawler understands it.
    // 308 for anything else, because it is the only permanent redirect that
    // preserves the method — a 301 would silently turn an old POST into a GET
    // and the request body would be dropped without an error.
    const status = request.method === "GET" || request.method === "HEAD" ? 301 : 308;

    return new Response(null, {
      status,
      headers: {
        Location: destination,
        // A year. Short enough to correct a mistake, long enough that
        // intermediaries stop asking.
        "Cache-Control": "max-age=31536000",
        // The redirect itself is not the site, but it is still a response
        // from a hostname that used to be, and it costs nothing to keep the
        // framing and sniffing protections on it.
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      },
    });
  },
};
