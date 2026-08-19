# Going live: automated walkthrough delivery

The site is live and correct at https://1099-int-check.pages.dev. Signups are
captured. The one thing that does not work is **sending the walkthrough to
anyone other than the account owner**, and this file is the exact path to
fixing that.

## Why a domain is required, and not optional

Resend — like every sending provider — verifies a domain by having you publish
`SPF (TXT)`, `DKIM (TXT)`, and `MX` records in that domain's DNS zone, plus
`DMARC (TXT)` afterwards. You can only publish records in a zone you control.

`pages.dev` is a zone **Cloudflare owns**:

```
pages.dev                 NS   adi.ns.cloudflare.com, karl.ns.cloudflare.com
1099-int-check.pages.dev  NS   ray.ns.cloudflare.com, reza.ns.cloudflare.com
```

There is no mechanism — in Pages, in Wrangler, or in the dashboard — to add a
TXT or MX record under it. So `1099-int-check.pages.dev` can serve a website
but can never be an email identity. This is the cost of the free hostname, and
no amount of configuration works around it.

Until a domain is verified, Resend permits sending only from
`onboarding@resend.dev`, and only **to the address the Resend account was
registered with**. `GET /api/status` reports this as `sandbox:true`, separately
from `delivery`, precisely so a sandbox send is never mistaken for working
delivery.

## Step 1 — you: register a domain (~5 minutes, ~$10–12/yr)

Cloudflare Registrar sells at wholesale cost with no markup, and a domain
bought there lands in your Cloudflare account with DNS already active, which
skips a nameserver migration entirely.

Cloudflare dashboard → **Domain Registration** → **Register Domains**.

Prefer a `.com` for a site about taxes; trust matters more than cleverness here.

## Step 2 — you: get a Resend API key

Resend dashboard → **API Keys** → **Create API Key**, sending permission.

It cannot be created programmatically: the Resend API requires an existing API
key to create a new one, so this step needs a human with the dashboard open.

**Do not paste the key into a chat or a file.** Set it directly — Cloudflare
never reveals it again, which is the point:

```bash
npx wrangler pages secret put RESEND_API_KEY --project-name 1099-int-check --env production
npx wrangler pages secret put RESEND_API_KEY --project-name 1099-int-check --env preview
```

Both environments. A secret set on one is invisible to the other.

## Step 3 — me: DNS records

Once the domain is in your Cloudflare account, add it in Resend
(**Domains → Add Domain**), and I add the SPF/DKIM/MX records Resend generates
to the Cloudflare zone. They must be copied exactly; a single wrong character
fails verification with no useful error.

## Step 4 — you: click Verify in Resend

Propagation is usually under a minute on Cloudflare DNS. Resend re-checks on
demand.

## Step 5 — me: switch the sender and prove it

```jsonc
// wrangler.jsonc
"WALKTHROUGH_FROM": "hello@yourdomain.com",   // must be ON the verified domain
"FOUNDER_BCC": "ashabbas.2023@gmail.com"      // optional: inbox as delivery log
```

Then deploy and confirm `GET /api/status` returns:

```json
{"ok":true,"configured":true,"delivery":true,"sandbox":false}
```

`sandbox:false` is the assertion that matters. `delivery:true` alone only means
a key is present; it does not mean a stranger can receive anything.

Proof of the real thing is an end-to-end signup with an address **unrelated to
the Resend account**, confirming the walkthrough lands. Anything less tests the
sandbox and proves nothing about visitors.

## Step 6 — me: move the site onto the domain too

Worth doing in the same pass, since the site should live where the email comes
from:

- Pages → custom domain (free on the free plan, once the zone is in the account)
- `public/index.html`: update `rel="canonical"` **and** `og:url`
- `.github/workflows/deploy.yml`: update `URL`
- `redirect/index.js`: update `TARGET`, so the old workers.dev hostname points
  at the new home rather than at pages.dev
- `CLAUDE.md` and `README.md`: production URL

## Until then

Delivery stays off, and that is handled honestly rather than hidden: a visitor
is recorded in Supabase and sees *"You're on the list. I'll send the
walkthrough shortly."* No promise is made that the software does not keep. If
that interim runs for long, send manually from the captured list:

```sql
select email, source, created_at
from public.signups
order by created_at desc;
```
