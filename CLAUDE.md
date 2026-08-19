# 1099-INT Check

A one-page site for extension filers checking their 1099-INT interest forms
against the IRS Wage & Income Transcript before October 15. See README.md for
what the page claims and, more importantly, what it refuses to claim.

## Deploy Configuration
- Platform: Cloudflare **Pages**, advanced mode (`wrangler.jsonc`)
- Production URL: https://1099-int-check.pages.dev
- Deploy workflow: `.github/workflows/deploy.yml` (auto-deploy on push to main)
- Deploy status command: `npx wrangler pages deployment list --project-name 1099-int-check`
- Logs: `npm run tail` (`wrangler pages deployment tail`)
- Merge method: merge commit
- Project type: web app (static page + signup API)
- Post-deploy health check: `GET /api/status` must return `{"ok":true,"configured":true}`

### Build
`dist/` is generated and gitignored. `npm run build` composes it:
`public/*` (static) plus `src/index.js` copied to `dist/_worker.js`. That
filename is what puts Pages in advanced mode. Never edit `dist/`, and never
commit it — CI builds it fresh.

### Tests
`npm test` — Node's built-in runner, no framework, no extra dependencies.
Runs in CI **before** the deploy, because the post-deploy curl checks only run
against production and can only report that a bad deploy already happened.

The suite covers the properties whose failure would be silent: the duplicate
signup response staying byte-identical to a new one (a difference leaks list
membership), the honeypot writing no row, the origin check, provider dispatch
and payload shapes, the IP salt actually reaching the digest, and `/api/status`
never echoing a secret. Add to it when you touch `handleSignup`.

### Custom deploy hooks
- Pre-merge: `npm test` and `npm run build` must succeed
- Deploy trigger: automatic on push to main, via GitHub Actions
- Health check: `GET /healthz` (200), `GET /api/status` (`configured:true`),
  `GET /` (200 + CSP header present), `GET /nonexistent` (404)

### Required repository secret
- `CLOUDFLARE_API_TOKEN` — needs **"Cloudflare Pages: Edit"**. The existing
  token, created from the "Edit Cloudflare Workers" template, already carries
  it: the first post-migration deploy authenticated and published fine
  (run 32280595780). No token change was needed. If you ever recreate it,
  Pages: Edit is the permission to check for.

### Pages secrets (set per environment, not in git)
Both `production` and `preview` need their own copies — a secret set on one is
not visible to the other, and a preview deploy with a missing key reports
`configured:false`:
```bash
npx wrangler pages secret put SUPABASE_PUBLISHABLE_KEY --project-name 1099-int-check --env production
npx wrangler pages secret put RESEND_API_KEY           --project-name 1099-int-check --env production
# then repeat each with --env preview
```

## Delivery is LIVE (Brevo, since 2026-08-19)
Confirmed by Brevo's own event log: `delivered` to an Outlook address that is
not the Brevo account address, plus the founder BCC. 0 bounces, 0 spam reports.

Two traps cost an hour and are not obvious from any status code:

- **Brevo blocks unknown IPs by default, and that is fatal for a Worker.**
  The API returns a plain `401`, indistinguishable from a bad key — the reason
  appears only in the *response body*: "unrecognised IP address". Cloudflare
  sends from hundreds of rotating edge IPs, so allowlisting cannot work.
  **Blocking must be deactivated** at
  <https://app.brevo.com/security/authorised_ips>. Brevo turns this on by
  itself after a 30-day quiet period, so it can break a working deployment
  later with no change on our side. If delivery starts 401ing, check this
  before suspecting the key.
- **Brevo shows an API key exactly once, at generation.** Afterwards the
  dashboard displays it masked (`**********zkDFyG`). Copying what is on screen
  yields the mask, not the key, and produces the same `401`. Lost keys cannot
  be recovered — generate a new one.

Because of the first trap, always read the response body when diagnosing a
delivery `401`. `delivery_status` in the signup response gives the code; the
Worker logs (`npm run tail`) carry the provider's own words.

## Provider setup — see GOING-LIVE.md
Two providers are supported, chosen by whichever key is set (or pinned with
`WALKTHROUGH_PROVIDER`):
- **Brevo** verifies a single sender ADDRESS by emailing it a link. No domain,
  so it works on `pages.dev` and reaches real visitors. ~300/day free. Mail
  sent as a personal mailbox address cannot be DKIM-aligned, so much of it is
  filtered to spam — reported as `unaligned_sender:true`. This trade was
  accepted deliberately.
- **Resend** verifies a DOMAIN via SPF/DKIM/MX records in that domain's DNS
  zone. `pages.dev` is a zone Cloudflare owns, so this is impossible until a
  domain is registered; until then Resend reaches only the account owner,
  reported as `sandbox:true`.

`GET /api/status` deliberately reports `delivery`, `sandbox` and
`unaligned_sender` as **separate** fields. `delivery:true` only means a key and
a sender exist — it has never meant a visitor receives anything. Collapsing
them is how this project previously shipped a walkthrough that was reported
sent and never arrived.

`WALKTHROUGH_FROM` is intentionally empty in `wrangler.jsonc`. A wrong value
means every send is rejected while `delivery` still reads true.

## Backend
- Supabase project `dorpekyszdlhvcozuocj` (ap-south-1), table `public.signups`
- `SUPABASE_URL` is a Pages var; `SUPABASE_PUBLISHABLE_KEY` is a Pages secret
- **Signups go through `public.signup(...)`, not a direct table insert.** It is
  `SECURITY DEFINER`; `anon` has *no* privileges on `public.signups` at all —
  no policy, no grant, no direct write. The publishable key can call that one
  function and nothing else.
- **The client IP hash is never stored beside an address.** It is passed as an
  argument, used to bucket the throttle, written to `private.rate_limit_hits`
  (which holds no email), and purged after two minutes. That table lives in a
  **`private` schema on purpose**: PostgREST only exposes the schemas it is
  configured for, so it has no HTTP surface at all. In `public` it was reachable
  and protected only by having no RLS policies — which held, but was one
  accidental policy away from letting anyone clear the throttle. It used to be a column
  on `signups`, which meant a per-visitor identifier sat next to a person's
  address indefinitely to serve a sixty-second window. Do not add it back.
- A repeat address is absorbed by `ON CONFLICT DO NOTHING` inside the function,
  so a duplicate is indistinguishable from a new signup **at the database**
  rather than flattened afterwards by the Worker.
- The rate limit is enforced in Postgres. On Pages this is the **only** limit:
  Pages Functions cannot bind the Cloudflare rate limiter at all. That is a
  smaller loss than it sounds — Cloudflare documents the edge binding as
  permissive and eventually consistent, and it let 14 of 14 rapid writes
  through a 5/60 limit in production. Do not try to reintroduce it here.

## Known platform traps
- **Pages runs `_worker.js` ahead of static assets, and that ordering is load
  bearing.** It is what replaces the Workers-only `assets.run_worker_first`.
  Adding a `_routes.json` that excludes `/` would put the asset server back in
  front and silently drop every security header from the page while leaving
  them on the API. The deploy workflow greps for the CSP header on `/`
  specifically because that bug shipped once already.
- **`public/404.html` exists only for its status code.** Pages answers an
  unmatched path by serving `index.html` with a **200** unless a `404.html` is
  present — the same duplicate-URL bug that `not_found_handling: "none"`
  prevented on Workers. Verified during the migration: without the file,
  `GET /nope-does-not-exist` returned 200. The workflow checks for 404.
- **The canonical URL in `public/index.html` is a hardcoded absolute URL.**
  `https://1099-int-check.pages.dev/`. It is what stops any other hostname
  serving this same HTML — an old deployment, a preview branch — from competing
  with production as duplicate content. It silently goes stale the moment the
  site moves to a custom domain, so update it in the same commit as the move.
  `og:url` next to it needs the same edit. The deploy workflow asserts the
  canonical matches the URL it just verified.
- **A Pages secret does nothing until the next deployment.** Cloudflare's docs:
  secrets "need to be done before a deployment that uses those secrets". Set a
  key against the live deployment and `/api/status` keeps reporting the old
  state, which reads as a bad key rather than a missing redeploy. Always
  `npm run deploy` after `wrangler pages secret put`.
- Secrets do not carry over between the `production` and `preview` Pages
  environments. Setting one and testing the other is a confusing way to see
  `configured:false`.
- `WALKTHROUGH_FROM` and `FOUNDER_BCC` are secrets, not `vars`, because this
  repo is public and both hold a personal mailbox address. Do not "tidy" them
  into `wrangler.jsonc` — that publishes an address to be harvested, and a
  value in `vars` also becomes the source of truth and outranks the secret.
- `wrangler pages dev` does not watch `src/`. It serves `dist/`, so rerun
  `npm run build` (or `npm run dev`) after editing the worker.
- **Never write `curl ... | grep -q ...` in the deploy workflow.** `grep -q`
  exits on first match, closing the pipe; `curl` takes SIGPIPE, and under
  `set -o pipefail` the pipeline reports curl's failure even though grep
  matched. It is a race — it depends on whether curl finished writing before
  grep exited — so it passes locally and on small responses, and fails on CI.
  Measured: `curl | grep -q` on the live page failed 1 in 10 locally and 6 in 6
  on CI, while the string was demonstrably present. Fetch into a variable and
  match with bash `case` instead. This bug also caused a **wrong diagnosis**:
  red run 32280595780 was blamed on edge propagation and "fixed" with a retry
  loop that was really just papering over it. The retry remains (propagation
  delay is real) but is no longer load bearing.
- Do not "fix" a red verification run by weakening an assertion.

## Local development
```bash
npm install
cp .dev.vars.example .dev.vars   # then paste the publishable key
npm run dev                      # builds dist/, then wrangler pages dev
```

## The retired hostname
`1099-int-check.ashabbas-2023.workers.dev` was the production URL until
2026-08-19. It is still live, and it is now a **redirect only** — see
`redirect/`. It is a separate Worker, not part of the Pages build, but **CI
deploys it on every push** (`npm run deploy:redirect` locally). That is
deliberate: its target is a hardcoded URL, so deploying it by hand meant a
change could be committed, reviewed and merged while the live redirect still
pointed elsewhere. The deploy workflow also asserts it still lands on
production.

It answers `301` to GET/HEAD and `308` to everything else, preserving path and
query so shared `?src=` links keep working. Redeploy it only if the production
URL changes; the target is hardcoded in `redirect/index.js`.

**It must never regain the Supabase binding.** Two deployments writing to
`public.signups` would split the mailing list across them with no error
anywhere. The old secrets are still attached to that Worker but unreachable,
since the redirect code never reads `env`.

## History
Migrated from Cloudflare Workers to Pages on 2026-08-19. Two orphaned
duplicates (`1099-int-tax`, `1099-int-checkk`, both live and both
misconfigured) were deleted in the same pass. Note that Cloudflare positions
Workers as the successor to Pages and documents only the Pages → Workers
direction; this project went the other way deliberately.
