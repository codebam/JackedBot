#!/usr/bin/env node
// Register the Telegram webhook against this deployment.
//
//   node scripts/set-webhook.mjs --origin https://jackedbot.<sub>.workers.dev
//   node scripts/set-webhook.mjs --tunnel   # show the tunnel command instead
//   node scripts/set-webhook.mjs --delete   # tear it down
//   node scripts/set-webhook.mjs --check    # getWebhookInfo only
//
// This is the step that ties TELEGRAM_WEBHOOK_SECRET to reality: we generate-or-
// read the same secret the Worker has, send it as setWebhook's `secret_token`, and
// Telegram then includes it in the X-Telegram-Bot-Api-Secret-Token header of every
// delivery. The Worker compares that header before parsing a byte of the update.
//
// Local development note: Telegram cannot reach localhost. Either deploy and point
// at the workers.dev URL, or expose the dev server with `cloudflared tunnel`.
import { flag, getVar, hasFlag, normalizeOrigin, requireVar, resolveOrigin, tgCall } from './_env.mjs';

const token = requireVar('TELEGRAM_BOT_TOKEN', 'Get it from @BotFather (/token).');
const path = getVar('WEBHOOK_PATH') || '/api/telegram/webhook';

async function info() {
  const i = await tgCall(token, 'getWebhookInfo');
  console.log('webhook url      :', i.url || '(not set)');
  console.log('pending updates  :', i.pending_update_count);
  console.log('last error       :', i.last_error_message || '(none)', i.last_error_date ? new Date(i.last_error_date * 1000).toISOString() : '');
  console.log('max_connections  :', i.max_connections ?? '(default 40)');
  console.log('ip_address       :', i.ip_address || '(unset)');
  return i;
}

if (hasFlag('check')) {
  await info();
  process.exit(0);
}

if (hasFlag('delete')) {
  await tgCall(token, 'deleteWebhook', { drop_pending_updates: hasFlag('drop-pending') });
  console.log('Webhook removed. Telegram will no longer deliver updates to this Worker.');
  process.exit(0);
}

if (hasFlag('tunnel')) {
  const port = flag('port') || '8787';
  console.log(
    [
      `Telegram cannot reach localhost, so expose the dev server with a named tunnel:`,
      ``,
      `  cloudflared tunnel --url http://localhost:${port}`,
      ``,
      `Copy the printed https://<random>.trycloudflare.com origin, then:`,
      ``,
      `  node scripts/set-webhook.mjs --origin https://<random>.trycloudflare.com`,
      ``,
      `Also set the same TELEGRAM_WEBHOOK_SECRET in .dev.vars as you used here.`,
    ].join('\n'),
  );
  process.exit(0);
}

const secret = requireVar(
  'TELEGRAM_WEBHOOK_SECRET',
  'You invent this one — it is not issued by Telegram.\n' +
    '  Generate:  openssl rand -hex 32\n' +
    '  Store it:  npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   (and in .dev.vars locally)\n' +
    '  This script then gives the SAME string to Telegram, which echoes it back in the\n' +
    '  X-Telegram-Bot-Api-Secret-Token header on every delivery.',
);
if (secret.length < 16) {
  console.error('TELEGRAM_WEBHOOK_SECRET is too short to be worth anything. Use `openssl rand -hex 32`.');
  process.exit(2);
}

let origin = resolveOrigin();
if (!origin) {
  const me = await tgCall(token, 'getMe');
  console.error(
    [
      `I do not know where your Worker lives.`,
      ``,
      `  node scripts/set-webhook.mjs --origin https://jackedbot.<your-subdomain>.workers.dev`,
      ``,
      `The URL must be the workers.dev root of this Worker: ${path} gets appended.`,
      `Find the exact URL in Cloudflare dashboard -> Workers & Pages -> jackedbot -> URL.`,
      `(Bot @${me.username} is reachable and authorised, so only the origin is missing.)`,
    ].join('\n'),
  );
  process.exit(2);
}
origin = normalizeOrigin(origin);
const url = `${origin}${path}`;

console.log(`bot            : @${(await tgCall(token, 'getMe')).username}`);
console.log(`registering    : ${url}`);
console.log(`secret token   : ${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`);

await tgCall(token, 'setWebhook', {
  url,
  secret_token: secret,
  // Only the update types the router actually reads. Leaving this unset makes
  // Telegram send everything, including reactions and chat-member churn.
  allowed_updates: ['message', 'edited_message', 'callback_query', 'pre_checkout_query'],
  drop_pending_updates: hasFlag('flush'),
  max_connections: 40,
});

const i = await info();
if (normalizeOrigin(i.url || '') !== origin) {
  console.error(`setWebhook reported ${i.url}, expected ${origin} — check for a typo.`);
  process.exit(1);
}
console.log(`\n✅ Telegram will now POST to ${url} and sign every request with your secret header.`);
