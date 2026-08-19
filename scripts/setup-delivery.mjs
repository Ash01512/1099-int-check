/**
 * Walk through turning walkthrough delivery on.
 *
 * Setting these by hand is four commands in a specific order, and getting the
 * order wrong fails quietly: a Pages secret does nothing until the next
 * deployment, so skipping the deploy leaves /api/status reporting
 * delivery:false with a perfectly good key. That reads as a bad key and sends
 * you looking in the wrong place. This runs them in order and then checks the
 * result, so the feedback is immediate and accurate.
 *
 * Nothing is stored here and nothing is echoed. Each value is typed straight
 * into wrangler's own prompt and goes to Cloudflare encrypted.
 *
 *   npm run setup:delivery              (Brevo — reaches every visitor)
 *   npm run setup:delivery -- resend    (Resend — see the warning below)
 */

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const PROJECT = "1099-int-check";
const SITE = "https://1099-int-check.pages.dev";
const provider = (process.argv[2] || "brevo").toLowerCase();

if (!["brevo", "resend"].includes(provider)) {
  console.error(`Unknown provider "${provider}". Use brevo or resend.`);
  process.exit(2);
}

const KEY_NAME = provider === "brevo" ? "BREVO_API_KEY" : "RESEND_API_KEY";

const rule = "─".repeat(66);
const say = (...a) => console.log(...a);

say(`\n${rule}\n  Turn on walkthrough delivery — ${provider}\n${rule}`);

if (provider === "brevo") {
  say(`
Before starting you need two things from Brevo (https://www.brevo.com):

  1. A VERIFIED SENDER ADDRESS
     Senders, Domains & Dedicated IPs -> Senders -> Add a sender.
     Brevo emails that address a confirmation link. Click it.
     This is the step that makes delivery to strangers possible at all,
     and it needs no domain — which is why it works on pages.dev.

  2. AN API KEY
     SMTP & API -> API Keys -> Generate a new API key.
     Copy it now; Brevo shows it once.

Free plan sends roughly 300 emails/day.
`);
} else {
  say(`
WARNING: Resend refuses to send to anyone but you unless a DOMAIN is
verified in the account. Its documentation is explicit — on the shared
resend.dev domain "you can only send testing emails to your own email
address", and any other recipient "triggers a 403 error".

Check before spending time here:

  curl -s -H "Authorization: Bearer <key>" https://api.resend.com/domains

If nothing comes back with "status":"verified", this route cannot reach a
single visitor no matter what you set. Use brevo instead.
`);
}

// This script cannot run unattended, and should say so rather than appear to
// hang. wrangler reads each secret from an interactive prompt, so with stdin
// closed — CI, a pipe, a non-interactive shell — the questions below never
// resolve and Node exits on an unsettled await with no explanation.
if (!stdin.isTTY) {
  console.error(`
This needs an interactive terminal.

Each value is typed into wrangler's own prompt, so it is never passed as an
argument, written to a file, or kept in shell history. That is deliberate, and
it means the script cannot be run from a pipe or a CI job.

Open a terminal in this folder and run:

  npm run setup:delivery
`);
  process.exit(2);
}

const rl = createInterface({ input: stdin, output: stdout });
const go = await rl.question("Ready to set the secrets? [y/N] ");
rl.close();
if (!/^y(es)?$/i.test((go || "").trim())) {
  say("\nNothing changed. Re-run when you have the sender address and key.");
  process.exit(0);
}

/** Run a command with the terminal attached, so wrangler can prompt. */
function run(label, command, args) {
  say(`\n${rule}\n  ${label}\n${rule}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error(`\nFailed: ${command} ${args.join(" ")}`);
    console.error("Nothing after this point ran. Fix the above and re-run.");
    process.exit(1);
  }
}

const secret = (name) =>
  run(
    `${name} — paste the value at the prompt`,
    "npx",
    ["wrangler", "pages", "secret", "put", name, "--project-name", PROJECT, "--env", "production"]
  );

secret(KEY_NAME);

say(`
Next: WALKTHROUGH_FROM. This must be EXACTLY the address you verified with
the provider — not a similar one. An unverified address means every send is
rejected while the status endpoint still reports delivery:true, which is the
"looks configured, delivers nothing" failure this project keeps finding.
`);
secret("WALKTHROUGH_FROM");

say(`
Next: FOUNDER_BCC. Your own address. You get a blind copy of every
walkthrough, so your inbox becomes the delivery log, and replies to the
email reach you — it asks people to reply.
`);
secret("FOUNDER_BCC");

// Not optional. Cloudflare documents that on Pages, secrets "need to be done
// before a deployment that uses those secrets".
run("Deploying, so the new secrets take effect", "npm", ["run", "deploy"]);

say(`\n${rule}\n  Checking what the site now reports\n${rule}\n`);

// Give the deployment a moment to reach the edge before asking.
await new Promise((r) => setTimeout(r, 12000));

let status;
try {
  status = await (await fetch(`${SITE}/api/status`)).json();
} catch (err) {
  console.error(`Could not reach ${SITE}/api/status — ${err.message}`);
  process.exit(1);
}

say(JSON.stringify(status, null, 2));
say("");

if (!status.delivery) {
  say("delivery is still FALSE. Either a secret did not take, or the deploy");
  say("did not happen. Re-run this script.");
  process.exit(1);
}

if (status.sandbox) {
  say("delivery:true, but sandbox:true — Resend will 403 every recipient who");
  say("is not the account owner. NO VISITOR can receive the walkthrough.");
  say("Verify a domain in Resend, or switch to Brevo.");
  process.exit(1);
}

say("delivery:true and sandbox:false — the provider will accept sends to");
say("real visitors.");

if (status.unaligned_sender) {
  say("");
  say("unaligned_sender:true — you are sending as a personal mailbox through a");
  say("third party, so DKIM cannot align and a large share will be filtered to");
  say("spam. It reaches everyone; it reaches many of them in the spam folder.");
  say("Registering a domain is what fixes that.");
}

say(`
${rule}
  One test remains, and it is the only one that counts
${rule}

Sign up with an address you do not own and that is unrelated to the provider
account, and confirm the walkthrough actually arrives. Check spam.

Everything above proves the plumbing is connected. It does not prove a
stranger received anything.
`);
