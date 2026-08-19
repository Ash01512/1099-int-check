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
- `CLOUDFLARE_API_TOKEN` — needs **"Cloudflare Pages: Edit"** and
  **"Account Settings: Read"**. The "Edit Cloudflare Workers" template does
  **not** grant Pages access, so the token that worked before the migration
  will fail with an authentication error. Recreate it at Cloudflare dashboard
  → My Profile → API Tokens → Custom token. Add under repo Settings → Secrets
  and variables → Actions.

### Pages secrets (set per environment, not in git)
Both `production` and `preview` need their own copies — a secret set on one is
not visible to the other, and a preview deploy with a missing key reports
`configured:false`:
```bash
npx wrangler pages secret put SUPABASE_PUBLISHABLE_KEY --project-name 1099-int-check --env production
npx wrangler pages secret put RESEND_API_KEY           --project-name 1099-int-check --env production
# then repeat each with --env preview
```

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
- Secrets do not carry over between the `production` and `preview` Pages
  environments. Setting one and testing the other is a confusing way to see
  `configured:false`.
- `wrangler pages dev` does not watch `src/`. It serves `dist/`, so rerun
  `npm run build` (or `npm run dev`) after editing the worker.

## Local development
```bash
npm install
cp .dev.vars.example .dev.vars   # then paste the publishable key
npm run dev                      # builds dist/, then wrangler pages dev
```

## History
Migrated from Cloudflare Workers to Pages on 2026-08-19. The Workers deployment
at `1099-int-check.ashabbas-2023.workers.dev` and two orphaned duplicates
(`1099-int-tax`, `1099-int-checkk`, both live and both misconfigured) were part
of that cleanup. Note that Cloudflare positions Workers as the successor to
Pages and documents only the Pages → Workers direction; this project went the
other way deliberately.
