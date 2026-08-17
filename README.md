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

## Status: not collecting yet

`window.FORM_ENDPOINT` in `public/index.html` is still the placeholder
`https://formspree.io/f/xxxxxxxx`.

The page detects this and **disables the email input**, showing a visible warning
instead. That is deliberate. A form that accepts addresses and drops them is
worse than one that admits it is not wired up, because you would read the silence
as "nobody was interested" when in fact nobody was recorded.

### To start collecting

1. Create a form at [formspree.io](https://formspree.io) (or Basin, or Formsubmit)
   and copy the form ID.
2. In `public/index.html`, replace the placeholder:

   ```js
   window.FORM_ENDPOINT = "https://formspree.io/f/YOUR_REAL_ID";
   ```

3. Redeploy: `npm run deploy`

The guard treats anything matching a placeholder pattern (`xxxx`, `your-form`,
`example.com`, `REPLACE_ME`) as unconfigured, so a half-finished edit fails loudly
rather than silently.

## Local development

```bash
npm install
npm run dev          # http://localhost:8787
```

## Deploy

```bash
npx wrangler login   # one-time browser OAuth
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
│   └── index.js        Worker wrapping the assets with security headers
├── wrangler.jsonc      Worker + static assets config
└── package.json
```

`public/index.html` has no build step and no dependencies. It is a single file
you can open directly in a browser.

### The Worker

An assets-only Worker cannot set response headers, which is the only reason
`src/index.js` exists. It adds a strict CSP (`default-src 'none'`, outbound
connections limited to the form providers), `nosniff`, `frame-ancestors 'none'`,
HSTS, and a restrictive `Permissions-Policy`. It also answers `/healthz`.

Inline `<style>` and `<script>` require `'unsafe-inline'` on those two
directives. That is a real weakening of the CSP, accepted here because the page
is a single self-contained file with no third-party script. Moving the script to
its own file and switching to a hash or nonce would close it.

## Privacy

- No bank logins and no credentials are ever requested.
- No documents are uploaded. Readers pull their own transcript from IRS.gov and
  keep it.
- The only data leaving the browser is the email address typed into the form,
  posted directly from the reader's browser to the form provider. The Worker
  never sees a submission and stores nothing at the edge.
- A hidden honeypot field catches bots; a filled honeypot is dropped silently.

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
