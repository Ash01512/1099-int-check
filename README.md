# 1099-INT Check

A one-page site for people who filed a tax extension and want to check their
1099-INT interest forms against the IRS record before they file.

Deployed on Cloudflare Pages, serving a single static page.

---

## Why this exists

Provable completeness is impossible during filing season. In February the data
does not exist yet: payers file 1099-INTs with the IRS as late as March 31, and
corrected forms take another four to six weeks to appear.

There is exactly one window each year where the IRS Wage & Income Transcript is
substantially complete **and** the filer has not yet filed: roughly **August 15
to October 15**, the extension window. That is the audience for this page.

For anyone who filed on time in April, this is useless. For someone holding a
dozen savings accounts who filed an extension, it is the only stretch of the
year when the check is both possible and still cheap.

## What the page claims, and what it refuses to claim

The page never tells anyone they have every form, and neither should any product
built from it.

The IRS does not treat the current processing year as final, and a payer who
never filed will never appear on a transcript at all. A clean comparison is not
a guarantee, and presenting it as one would be a silent failure with IRS
consequences for the reader.

The only claim made anywhere on the page is the narrow one:

> These are the payers the transcript shows that your own figures do not.

The sample table in the hero is marked `EXAMPLE — NOT YOUR DATA` directly in the
table header, not in a footnote. Illustrative figures on a tax page read as a
fabricated screenshot if the disclaimer is easy to miss.

## Signups

The page posts same-origin to `/api/signup`. The Worker validates, then inserts
into Supabase. No database key is ever sent to the browser.

Routing it through the Worker rather than posting to Supabase directly means the
email check, the honeypot, and the field-length limits cannot be bypassed by
POSTing straight at the database.

### The table

`public.signups` — email, source, page, user_agent, created_at.

- `unique index on lower(email)` so a repeat signup is a no-op rather than a
  duplicate row. The Worker turns the resulting 409 into "you're already on the
  list", which is a success from the reader's point of view.
- A check constraint rejects malformed addresses at the database, not only in
  the browser.

### Write-only from the internet

RLS is on, `anon` is granted `INSERT` and nothing else, and there is no `SELECT`
policy. A leaked publishable key lets someone add a row; it does not let them
read the list. Verified:

```
INSERT as anon   201
SELECT as anon   401  permission denied for table signups
duplicate        409  unique violation
malformed email  400  check constraint violation
```

Read the collected addresses in the Supabase dashboard, or over a service-role
connection. Never from the browser.

### Configuration

| Name | Where | Why |
|---|---|---|
| `SUPABASE_URL` | `vars` in `wrangler.jsonc` | Not a secret; ships in every Supabase client. |
| `SUPABASE_PUBLISHABLE_KEY` | Pages secret | Kept out of a public repo so strangers cannot POST straight into the table. |

```bash
npx wrangler pages secret put SUPABASE_PUBLISHABLE_KEY --project-name 1099-int-check --env production
```

Pages keeps `production` and `preview` secrets separate, so run it again with
`--env preview` if you want branch deploys to work.

If either binding is missing the server answers `503 not_configured` and the page
disables the input and shows a visible warning. That is deliberate: a form that
accepts an address and drops it is worse than one that admits it is not wired up,
because the silence reads as "nobody was interested" when nobody was recorded.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then paste your publishable key
npm run dev                      # builds dist/, then serves it
```

`.dev.vars` is gitignored. `wrangler pages dev` serves the built `dist/`
directory and does not watch `src/`, so rerun `npm run dev` after editing the
server code.

## Deploy

```bash
npx wrangler login                            # one-time browser OAuth
npx wrangler pages project create 1099-int-check --production-branch main
npx wrangler pages secret put SUPABASE_PUBLISHABLE_KEY --project-name 1099-int-check --env production
npm run deploy
```

Deploys to `1099-int-check.pages.dev`. Change `name` in `wrangler.jsonc` to
deploy elsewhere.

`npm run deploy` builds `dist/` first. Running `wrangler pages deploy` on its
own publishes whatever `dist/` already held, which on a fresh clone is nothing.

Deploying from a branch other than `main` produces a preview URL
(`<branch>.1099-int-check.pages.dev`) and leaves production alone.

## Traffic sources

Append `?src=` to the link you post and the value rides along with each
submission, so you can tell communities apart:

```
https://1099-int-check.pages.dev/?src=churning
https://1099-int-check.pages.dev/?src=doc
```

Anything without a `src` parameter is recorded as `direct`.

## Layout

```
├── public/
│   ├── index.html      the entire page: markup, styles, and script inline
│   └── 404.html        exists for its status code; see "Known traps"
├── src/
│   └── index.js        server: security headers + POST /api/signup
├── scripts/
│   └── build.mjs       composes dist/ from public/ + src/index.js
├── redirect/           retired workers.dev hostname; 301s to the real site
├── dist/               generated, gitignored, never edited by hand
├── wrangler.jsonc      Pages project config
└── package.json
```

`public/index.html` has no build step and no dependencies. It is a single file
you can open directly in a browser.

### Routes

| Route | Behaviour |
|---|---|
| `GET /` | The landing page, with security headers attached. |
| `POST /api/signup` | Validates and inserts into Supabase. JSON or form-encoded. |
| `GET /api/status` | `{ok, configured}` — lets the page detect a broken backend on load. |
| `GET /healthz` | `ok`, without touching the asset store. |
| anything else | 404, via `public/404.html`. |

### Abuse controls on `/api/signup`

| Control | Behaviour |
|---|---|
| Rate limit | 5 per minute per client, enforced by a Postgres trigger → `429`. See below. |
| Origin check | A cross-site `Origin` is rejected `403`. A missing `Origin` (curl, server-to-server) is allowed, since blocking it buys nothing and breaks scripted testing. |
| Honeypot | A filled hidden field is answered `201` and discarded, so bots get no signal. |
| Enumeration | A duplicate address returns exactly the same `201 {"ok":true}` as a new one. A distinct "already subscribed" would let anyone test whether a given person is on the list. |
| Normalisation | Addresses are lowercased before storage, matching the `lower(email)` unique index. |

#### Why the rate limit lives in Postgres

The obvious place was Cloudflare's Workers rate-limit binding. It does not work
for this, and on Pages it is not even available — Pages Functions cannot bind
the rate limiter. Losing it costs nothing, because it never held. Its own
documentation calls it
["permissive, eventually consistent, and intentionally designed to not be used
as an accurate accounting system"](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
with per-colo counters updated asynchronously, so *"rapid requests against the
same key may not be immediately reflected."*

A rapid burst from one IP is exactly the attack, and exactly the case it does
not catch. Measured on production: **14 of 14 writes succeeded** against a
configured 5/60 limit, with no error and no exception — the binding returned
`success: true` every time.

This is invisible in local development, because `wrangler dev` implements the
limiter synchronously and it appears to work perfectly.

So the limit is enforced by a `BEFORE INSERT` trigger that counts rows for the
same `ip_hash` in the last minute and raises `PT429`, which PostgREST surfaces
as a real HTTP `429`. Postgres counts synchronously, so the limit actually
holds. Measured on production after the change: **1 accepted, 14 rejected.**

The code path for the Cloudflare binding is kept in `src/index.js` so the file
still throttles at the edge if it is ever deployed as a Worker again. On Pages
the binding is absent, so that branch logs on every signup that the edge layer
is gone. The noise is deliberate: it should not be possible to forget which
layer is actually enforcing.

`ip_hash` is a salted SHA-256 of the client IP, computed server-side. The raw
address is never stored. Note that IPv4 and IPv6 clients hash to different
buckets, so a dual-stack client gets two allowances.

### The server, and two traps

A static site cannot set response headers or run server-side logic, which is why
`src/index.js` exists. It adds a strict CSP (`default-src 'none'`,
`connect-src 'self'`), `nosniff`, `frame-ancestors 'none'`, HSTS, and a
restrictive `Permissions-Policy`.

`npm run build` copies it to `dist/_worker.js`. That exact filename at the root
of the build output is what puts Pages in **advanced mode**: every request runs
the script first, and static files are fetched deliberately through
`env.ASSETS`.

**That ordering is load bearing.** It is what replaces the Workers-only
`assets.run_worker_first` flag. Adding a `_routes.json` that excludes `/` would
put the asset server back in front, and the page would silently return with no
security headers at all while the API route kept them — an easy thing to ship
without noticing. The deploy workflow greps for the CSP header on `/` for
exactly this reason.

**`public/404.html` exists only for its status code.** Pages answers an
unmatched path by serving `index.html` with a `200` unless that file is present.
This is a one-page site; without it every wrong URL becomes an indexable
duplicate of the landing page. Verified during the migration: `GET
/nope-does-not-exist` returned `200` before the file was added, `404` after.
The deploy workflow checks it.

Inline `<style>` and `<script>` require `'unsafe-inline'` on those two
directives. That is a real weakening of the CSP, accepted here because the page
is a single self-contained file with no third-party script. Moving the script to
its own file and switching to a hash or nonce would close it.

## Privacy

- No bank logins and no credentials are ever requested.
- No documents are uploaded. Readers pull their own transcript from IRS.gov and
  keep it. No transcript, and no tax figure, ever reaches this system.
- The only data collected is the email address typed into the form, plus the
  `?src=` value from the link, the page name, and the browser's user-agent
  string. It is stored in a Supabase Postgres database **you control**, not
  with a third-party form provider.
- Because that data lives in your project, you are its custodian. Storing an
  email address is a much smaller obligation than storing tax documents, but it
  is not nothing — decide your retention period and honour deletion requests.
- The collected list is not readable through the public API. See
  [Write-only from the internet](#write-only-from-the-internet).
- A hidden honeypot field catches bots; a filled honeypot is answered `200` and
  silently discarded, so the bot gets no signal that it was rejected.

## Countdown

The header count is computed from `window.DEADLINE` on every load and refreshed
each minute. It counts whole calendar days, and degrades to "Due today" and then
"Oct 15 has passed" on its own.

Hardcoding the number would be wrong the next morning, on a page whose entire
argument is a deadline. `DEADLINE` is set to the TY2025 extension deadline,
October 15 2026, and needs updating each tax year.

## Not tax advice

This is not tax advice and the author is not a tax preparer. Taking payment to
reconcile someone else's tax documents may bring you inside the IRC 7216
definition of a tax return preparer. Settle that question with an attorney before
any money changes hands.

## License

MIT
