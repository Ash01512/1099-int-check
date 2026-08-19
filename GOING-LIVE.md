# Going live: automated walkthrough delivery

The site is live at https://1099-int-check.pages.dev and signups are captured.
This file is the path to actually sending the walkthrough.

There are two routes. They differ in one thing that matters: whether the mail
lands in the inbox or the spam folder.

---

## Route A — Brevo, works today, no domain needed

**Chosen route.** Reaches every visitor, automated, free. Much of it will be
filtered to spam, and that was accepted deliberately — see "The honest caveat"
below before relying on it.

### Step 1 — you: create a Brevo account and verify one sender address

<https://www.brevo.com> → sign up → **Senders, Domains & Dedicated IPs** →
**Senders** → **Add a sender**.

Enter the address you want the walkthrough to come from. Brevo emails it a
confirmation link. Click it. That is the whole verification — no DNS, no
domain, which is exactly why this route works on `pages.dev`.

Free plan is roughly **300 emails/day**. Worth knowing before a link gets
posted somewhere busy.

### Step 2 — you: create an API key and set it

Brevo → **SMTP & API** → **API Keys** → **Generate a new API key**.

**Do not paste the key into a chat or a file.** Set it directly, so it goes
from your clipboard to Cloudflare and nowhere else:

```bash
npx wrangler pages secret put BREVO_API_KEY --project-name 1099-int-check --env production
npx wrangler pages secret put BREVO_API_KEY --project-name 1099-int-check --env preview
```

Both environments — a secret set on one is invisible to the other.

### Step 3 — set the sender address

`WALKTHROUGH_FROM` in `wrangler.jsonc` is deliberately empty. It has no safe
default: a wrong address means Brevo rejects every send with a 400 while the
status endpoint still reports `delivery:true`. Set it to **the exact address
you verified in step 1**, and set `FOUNDER_BCC` to your own address so your
inbox becomes the delivery log.

```jsonc
"WALKTHROUGH_FROM": "you@example.com",
"FOUNDER_BCC": "you@example.com"
```

Commit and push; CI deploys on merge to `main`.

### Step 4 — prove it

```bash
curl -s https://1099-int-check.pages.dev/api/status
```

Expect `"delivery":true`, `"provider":"brevo"`, `"sandbox":false`.

`"unaligned_sender":true` is expected on this route and is not an error — it
is the spam-risk flag, reported so healthy-looking delivery is never confused
with mail that actually lands.

Then the only proof that counts: sign up with an address **you do not own and
that is unrelated to the Brevo account**, and confirm the walkthrough arrives.
Check spam. Anything less tests the plumbing, not the delivery.

### The honest caveat

The mail is sent by Brevo but claims to be from your address. If that address
is a personal mailbox (`@gmail.com` and similar), Brevo cannot produce a DKIM
signature that aligns with it, so DMARC alignment fails and mailbox providers
filter a large share of it. `/api/status` reports this as
`unaligned_sender:true`.

It still reaches everyone, which is why it is a legitimate choice. It reaches
many of them in spam. The page already tells people to check their spam
folder, so the promise stays honest either way.

---

## Route B — a registered domain, mail that lands in the inbox

The only way to make the mail properly authenticated. Costs ~$10–12/yr.

Resend (or Brevo) verifies a domain by having you publish `SPF (TXT)`,
`DKIM (TXT)` and `MX` records in that domain's DNS zone, plus `DMARC` after.
You can only publish records in a zone you control, and `pages.dev` is a zone
**Cloudflare owns**:

```
pages.dev                 NS   adi.ns.cloudflare.com, karl.ns.cloudflare.com
1099-int-check.pages.dev  NS   ray.ns.cloudflare.com, reza.ns.cloudflare.com
```

No mechanism exists to add a record under it. That hostname can serve a
website; it can never be an email identity. This is the cost of the free
hostname, and no configuration works around it.

1. **You:** Cloudflare dashboard → **Domain Registration** → register a domain.
   Bought there, it lands in your account with DNS already active.
2. **You:** add the domain in Brevo or Resend.
3. **Me:** add the SPF/DKIM/MX records to the Cloudflare zone, exactly as
   generated.
4. **You:** click Verify.
5. **Me:** point `WALKTHROUGH_FROM` at an address on that domain and redeploy.
   `unaligned_sender` becomes `false` and the mail starts reaching inboxes.
6. **Me:** move the site onto the domain too — Pages custom domain, then
   update `rel="canonical"` and `og:url` in `public/index.html`, `URL` in
   `.github/workflows/deploy.yml`, `TARGET` in `redirect/index.js`, and the
   production URL in `CLAUDE.md` / `README.md`.

---

## What the status flags mean

`GET /api/status` reports four separate things, because collapsing them is how
a site ends up claiming delivery it does not have:

| Flag | Meaning |
|---|---|
| `configured` | Supabase is wired. Signups are being stored. |
| `delivery` | A provider key and a sender address exist. **Says nothing about reach.** |
| `sandbox` | Resend with no verified domain: can only reach the account owner. |
| `unaligned_sender` | Sending as a personal mailbox: reaches everyone, much of it filtered. |

`delivery:true` on its own has never meant a visitor receives anything. That
distinction is the whole reason these are four fields and not one.

## Until a provider key is set

Delivery stays off and is handled honestly: a visitor is recorded in Supabase
and sees *"You're on the list. I'll send the walkthrough shortly."* Nothing
promises what the software cannot do. To send manually from the captured list:

```sql
select email, source, created_at
from public.signups
order by created_at desc;
```
