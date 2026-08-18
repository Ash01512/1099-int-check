# 1099-INT Check

A one-page site for extension filers checking their 1099-INT interest forms
against the IRS Wage & Income Transcript before October 15. See README.md for
what the page claims and, more importantly, what it refuses to claim.

## Deploy Configuration (configured by /setup-deploy)
- Platform: Cloudflare Workers (`wrangler.jsonc`)
- Production URL: https://1099-int-check.ashabbas-2023.workers.dev
- Deploy workflow: `.github/workflows/deploy.yml` (auto-deploy on push to main)
- Deploy status command: `npx wrangler deployments list`
- Merge method: merge commit
- Project type: web app (static page + signup API)
- Post-deploy health check: `GET /api/status` must return `{"ok":true,"configured":true}`

### Custom deploy hooks
- Pre-merge: `npx wrangler deploy --dry-run` (validates config and bindings)
- Deploy trigger: automatic on push to main, via GitHub Actions
- Deploy status: `npx wrangler deployments list`
- Health check: `GET /healthz` (200), `GET /api/status` (`configured:true`), `GET /` (200 + CSP header present)

### Required repository secret
- `CLOUDFLARE_API_TOKEN` — create at Cloudflare dashboard → My Profile → API Tokens,
  using the "Edit Cloudflare Workers" template. Add under repo Settings → Secrets and
  variables → Actions. The deploy workflow cannot run without it.

## Backend
- Supabase project `dorpekyszdlhvcozuocj` (ap-south-1), table `public.signups`
- `SUPABASE_URL` is a Worker var; `SUPABASE_PUBLISHABLE_KEY` is a Worker secret
- The signup rate limit is enforced by a Postgres trigger, NOT by the Cloudflare
  rate-limit binding. Cloudflare documents that binding as permissive and
  eventually consistent; it let 14 of 14 rapid writes through a 5/60 limit in
  production. Do not move the limit back to the edge.

## Known platform traps
- `assets.run_worker_first` must stay `true`. Without it, matching assets are
  served before the Worker runs and the page returns with NO security headers,
  while the API route keeps them. This is silent. The deploy workflow checks for
  the CSP header on `/` specifically because of this.
- `not_found_handling` is `none`, not `single-page-application`. This is a
  one-page site; the SPA setting made every unknown path return the page with a 200.
- `wrangler dev` implements the rate-limit binding synchronously, so edge-behaviour
  bugs test green locally. Verify anything distributed against production.

## Local development
```bash
npm install
cp .dev.vars.example .dev.vars   # then paste the publishable key
npm run dev
```
