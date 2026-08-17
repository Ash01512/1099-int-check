# 1099-INT Check

A one-page site for people who filed a tax extension and want to check their
1099-INT interest forms against the IRS record before they file.

Deployed as a Cloudflare Worker serving a single static page.

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
| `SUPABASE_PUBLISHABLE_KEY` | Worker secret | Kept out of a public repo so strangers cannot POST straight into the table. |

```bash
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY
```

If either binding is missing the Worker answers `503 not_configured` and the page
disables the input and shows a visible warning. That is deliberate: a form that
accepts an address and drops it is worse than one that admits it is not wired up,
because the silence reads as "nobody was interested" when nobody was recorded.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then paste your publishable key
npm run dev                      # http://localhost:8787
```

`.dev.vars` is gitignored.

## Deploy

```bash
npx wrangler login                            # one-time browser OAuth
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY
npm run deploy
```

Deploys to `1099-int-check.<your-subdomain>.workers.dev`. Change `name` in
`wrangler.jsonc` to deploy elsewhere.

## Traffic sources

Append `?src=` to the link you post and the value rides along with each
submission, so you can tell communities apart:

```
https://your-worker.workers.dev/?src=churning
https://your-worker.workers.dev/?src=doc
```

Anything without a `src` parameter is recorded as `direct`.

## Layout

```
├── public/
│   └── index.html      the entire page: markup, styles, and script inline
├── src/
│   └── index.js        Worker: security headers + POST /api/signup
├── wrangler.jsonc      Worker + static assets config
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
| anything else | 404. |

### Abuse controls on `/api/signup`

| Control | Behaviour |
|---|---|
| Rate limit | 5 per minute per IP via the `SIGNUP_LIMITER` binding → `429`. If the binding is missing the Worker logs a warning rather than pretending to be protected. |
| Origin check | A cross-site `Origin` is rejected `403`. A missing `Origin` (curl, server-to-server) is allowed, since blocking it buys nothing and breaks scripted testing. |
| Honeypot | A filled hidden field is answered `201` and discarded, so bots get no signal. |
| Enumeration | A duplicate address returns exactly the same `201 {"ok":true}` as a new one. A distinct "already subscribed" would let anyone test whether a given person is on the list. |
| Normalisation | Addresses are lowercased before storage, matching the `lower(email)` unique index. |

### The Worker

An assets-only Worker cannot set response headers or run server-side logic,
which is why `src/index.js` exists. It adds a strict CSP (`default-src 'none'`,
`connect-src 'self'`), `nosniff`, `frame-ancestors 'none'`, HSTS, and a
restrictive `Permissions-Policy`.

**`run_worker_first` is required and not optional.** Without it, matching assets
are served straight from the asset store and the Worker never runs, so the page
silently returns with no security headers at all while the API route keeps
them — an easy thing to ship without noticing. Verified by inspecting response
headers on `GET /` both ways.

`not_found_handling` is `none`, not `single-page-application`. This is a one-page
site; with the SPA setting every unknown path returned the landing page with a
200, so crawlers would see unlimited duplicate URLs.

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
