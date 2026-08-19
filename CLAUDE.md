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

### Custom deploy hooks
- Pre-merge: `npm run build` must succeed (it fails loudly on a missing input)
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

## Delivery — see GOING-LIVE.md
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
- The signup rate limit is enforced by a Postgres trigger. On Pages this is now
  the **only** limit: Pages Functions cannot bind the Cloudflare rate limiter at
  all. That is a smaller loss than it sounds — Cloudflare documents the edge
  binding as permissive and eventually consistent, and it let 14 of 14 rapid
  writes through a 5/60 limit in production. Do not try to reintroduce it here.

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
- Secrets do not carry over between the `production` and `preview` Pages
  environments. Setting one and testing the other is a confusing way to see
  `configured:false`.
- `wrangler pages dev` does not watch `src/`. It serves `dist/`, so rerun
  `npm run build` (or `npm run dev`) after editing the worker.
- **A fresh deployment does not reach every edge node at once.** The deploy
  workflow retries its whole verification block up to 6 times rather than
  sleeping once. Run 32280595780 failed the canonical check against an edge
  still serving the previous deployment while every other check passed, which
  reads as a content bug rather than a race. Do not "fix" a one-off red run by
  weakening an assertion.

## Local development
```bash
npm install
cp .dev.vars.example .dev.vars   # then paste the publishable key
npm run dev                      # builds dist/, then wrangler pages dev
```

## The retired hostname
`1099-int-check.ashabbas-2023.workers.dev` was the production URL until
2026-08-19. It is still live, and it is now a **redirect only** — see
`redirect/`, a separate Worker deployed with `cd redirect && npx wrangler
deploy`. It is not part of the Pages build and CI does not touch it.

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
