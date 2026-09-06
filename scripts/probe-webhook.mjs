#!/usr/bin/env node
// =============================================================================
// Send a synthetic Telegram update to the deployed webhook, signed with the real
// webhook secret, so a handler can be reproduced without a phone.
//
//   node scripts/probe-webhook.mjs /balance
//   node scripts/probe-webhook.mjs /start --user 69148517
//   node scripts/probe-webhook.mjs callback:age:accept --user 69148517
//   node scripts/probe-webhook.mjs /balance --local http://localhost:8788
//
// WHY THIS EXISTS
//   Production bugs in the update router were invisible to every test: the Node
//   suite never touches the webhook, and the workerd suite calls the Durable
//   Object directly. This drives the real HTTP surface. Pair it with
//   `npx wrangler tail jackedbot --format json` to see the thrown exception
//   rather than inferring it from a 500.
//
// SAFETY
//   `--user` defaults to a synthetic id so a probe cannot accidentally message a
//   real person. Pass your own id explicitly when you want to see the reply.
//   Nothing here can move money: payments require a real charge id from Telegram.
// =============================================================================
import { flag, getVar, normalizeOrigin } from './_env.mjs';

const ORIGIN = normalizeOrigin(flag('local') ?? flag('origin') ?? getVar('PUBLIC_ORIGIN') ?? '') ?? null;
if (!ORIGIN) {
  console.error('Pass --origin https://… or --local http://localhost:8788');
  process.exit(2);
}

const SECRET = getVar('TELEGRAM_WEBHOOK_SECRET');
if (!SECRET) {
  console.error('TELEGRAM_WEBHOOK_SECRET missing — the route will answer 403.');
  process.exit(2);
}

const WHAT = process.argv[2] ?? '/start';
const USER_ID = Number(flag('user') ?? 999_002);
const USERNAME = flag('username') ?? (USER_ID === 999_002 ? 'synthetic_probe' : null);
const NOW = Math.floor(Date.now() / 1000);

const from = { id: USER_ID, is_bot: false, first_name: 'Probe', ...(USERNAME ? { username: USERNAME } : {}) };
const chat = { id: USER_ID, type: 'private', ...(USERNAME ? { username: USERNAME } : {}), first_name: 'Probe' };

let update;
if (WHAT.startsWith('callback:')) {
  update = {
    callback_query: {
      // A real callback id is required for Telegram to accept the answer; the
      // synthetic one yields QUERY_ID_INVALID, which is itself informative.
      id: `${USER_ID}:${NOW}`,
      from,
      chat_instance: '1',
      data: WHAT.slice('callback:'.length),
      message: { message_id: 1, date: NOW, chat, from, text: 'x' },
    },
  };
} else if (WHAT.startsWith('inline:')) {
  update = {
    inline_query: {
      id: `probe-${NOW}`,
      from: USER_ID ? { ...from, id: USER_ID } : from,
      query: WHAT.slice('inline:'.length),
      offset: '',
      chat_type: 'group',
    },
  };
} else if (WHAT === 'precheckout') {
  update = {
    pre_checkout_query: { id: 'pq-synthetic', from, currency: 'XTR', total_amount: 1, invoice_payload: `buyin:${USER_ID}:probe` },
  };
} else {
  update = { message: { message_id: 1, date: NOW, chat, from, text: WHAT } };
}
update.update_id = Number(`${NOW}`.slice(-9)) * 1000 + Math.floor(Math.random() * 999);

const res = await fetch(`${ORIGIN}/api/telegram/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
  body: JSON.stringify(update),
  signal: AbortSignal.timeout(45_000),
});

const text = await res.text();
console.log(`POST ${ORIGIN}/api/telegram/webhook  update_id=${update.update_id}`);
console.log(`  payload : ${JSON.stringify(update).slice(0, 150)}`);
console.log(`  response: HTTP ${res.status} ${text.slice(0, 300)}`);
if (res.status === 500) {
  console.log('\n  → handler threw. Read the real exception with:');
  console.log('      npx wrangler tail jackedbot --format json');
}
process.exit(res.ok || res.status === 403 ? 0 : 1);
