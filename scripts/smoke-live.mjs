#!/usr/bin/env node
// =============================================================================
// Live smoke test against a deployed Worker.
//
// This exists because unit + workerd tests passed while every Astro API route was
// broken in production: they were written as `POST(request, context)`, but Astro
// hands an endpoint a *single* APIContext argument, so `context.locals` threw 500
// before any auth check. The DO tests called the object directly and never touched
// the HTTP surface, so nothing caught it. This does.
//
//   node scripts/smoke-live.mjs                       # uses PUBLIC_ORIGIN/.dev.vars
//   node scripts/smoke-live.mjs --origin https://…    # explicit
//
// Exit code is non-zero if any expectation fails. Safe to run in CI after deploy.
// It never sends a real payment and never mutates a player's balance.
// =============================================================================
import { flag, getVar, normalizeOrigin } from './_env.mjs';

const ORIGIN = normalizeOrigin(flag('origin') ?? getVar('PUBLIC_ORIGIN') ?? '') ?? null;
if (!ORIGIN) {
  console.error('No origin. Pass --origin https://<name>.<sub>.workers.dev or set PUBLIC_ORIGIN.');
  process.exit(2);
}

const WEBHOOK_SECRET = getVar('TELEGRAM_WEBHOOK_SECRET');
let failures = 0;
const results = [];

async function check(name, expectStatus, fn) {
  let got = null;
  let body = '';
  try {
    const r = await fn();
    got = r.status;
    body = (await r.text()).slice(0, 160);
  } catch (e) {
    got = `ERR ${e.message}`;
  }
  const ok = got === expectStatus;
  if (!ok) failures++;
  results.push({ ok, name, want: expectStatus, got, body });
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(46)} ${ok ? `${got}` : `want ${expectStatus}, got ${got}`}${ok ? '' : `\n     ${body}`}`);
}

const post = (path, { secret, body = '{}', headers = {} } = {}) =>
  fetch(ORIGIN + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}), ...headers },
    body,
  });

console.log(`smoke-testing ${ORIGIN}\n`);

// --- public surface ---------------------------------------------------------
await check('GET /api/health returns 200', 200, () => fetch(ORIGIN + '/api/health'));
await check('GET / renders the lobby', 200, () => fetch(ORIGIN + '/'));
await check('GET /table/bravo renders (no session)', 200, () => fetch(ORIGIN + '/table/bravo'));
await check('GET /favicon.png served from Assets', 200, () => fetch(ORIGIN + '/favicon.png'));
await check('GET /site.webmanifest served', 200, () => fetch(ORIGIN + '/site.webmanifest'));

// --- auth is actually enforced (these MUST reject) --------------------------
await check('GET /api/tables without initData -> 401', 401, () => fetch(ORIGIN + '/api/tables'));
await check('POST /api/session with junk initData -> 401', 401, () => post('/api/session', { body: '{"initData":"garbage=1"}' }));
await check('POST /api/buyin with no initData -> 401', 401, () => post('/api/buyin', { body: '{}' }));
await check('POST /api/age-gate with no initData -> 401', 401, () => post('/api/age-gate', { body: '{"accept":true}' }));
await check('GET /api/history without initData -> 401', 401, () => fetch(ORIGIN + '/api/history'));
await check('POST /api/tables/bravo/socket -> 401', 401, () => post('/api/tables/bravo/socket', { body: '{}' }));

// --- the webhook's shared-secret gate --------------------------------------
await check('webhook with no secret header -> 403', 403, () => post('/api/telegram/webhook', { body: '{"update_id":1}' }));
await check('webhook with wrong secret -> 403', 403, () => post('/api/telegram/webhook', { secret: 'definitely-not-the-secret', body: '{"update_id":2}' }));

if (!WEBHOOK_SECRET) {
  console.log('\n⚠ TELEGRAM_WEBHOOK_SECRET not available locally; skipped the positive webhook case.');
} else {
  // An update with no recognisable field: proves the route parses, authorises and
  // answers 200 through the real Astro endpoint signature.
  const id = Date.now() * 1000 + Math.floor(Math.random() * 999);
  await check('webhook with valid secret -> 200', 200, () => post('/api/telegram/webhook', { secret: WEBHOOK_SECRET, body: JSON.stringify({ update_id: id }) }));
}

// --- content assertions on the lobby ---------------------------------------
{
  const html = await fetch(ORIGIN + '/').then((r) => r.text()).catch(() => '');
  const must = ['telegram-web-app.js', 'play money', 'Open tables', 'no cashout'];
  for (const needle of must) {
    const ok = html.includes(needle);
    if (!ok) failures++;
    console.log(`${ok ? '✓' : '✗'} lobby HTML contains "${needle}"`);
  }
  // Guardrail: the public page must never promise a withdrawal path.
  for (const bad of ['withdraw', 'cash out', 'redeem for']) {
    const ok = !html.toLowerCase().includes(bad);
    if (!ok) failures++;
    console.log(`${ok ? '✓' : '✗'} lobby HTML does not offer "${bad}"`);
  }
}

console.log(`\n${failures === 0 ? '✔ smoke passed' : `✖ ${failures} smoke failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
