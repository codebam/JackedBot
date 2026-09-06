#!/usr/bin/env node
// =============================================================================
// End-to-end WebSocket probe: Worker relay -> Table Durable Object -> hibernated
// socket -> broadcast. Run against `wrangler dev`:
//
//   npx wrangler dev --port 8791 &
//   node scripts/e2e-ws.mjs
//
// This exists because the browser->DO hop is the one part of this architecture
// that documentation describes two different ways. We verify it on the real
// workerd runtime instead of assuming.
// =============================================================================
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:8791';
const TABLE = process.env.TABLE ?? 'bravo';

function devVar(name) {
  try {
    const line = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : '';
  } catch {
    return process.env[name] ?? '';
  }
}

const SECRET = devVar('APP_SECRET');
if (!SECRET) {
  console.error('APP_SECRET missing from .dev.vars — the ticket would not verify anyway.');
  process.exit(2);
}

/** Mirrors signTicket() in src/lib/auth.ts exactly. */
function mintTicket(userId, tableId, ttlSeconds = 60) {
  const payload = { u: userId, t: tableId, e: Math.floor(Date.now() / 1000) + ttlSeconds, n: randomBytes(8).toString('hex'), p: 'ws' };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(`ws1|${body}`).digest('hex');
  return `ws1.${body}.${sig}`;
}

const userId = Number(process.argv[2] ?? 700001);
/** ACT=stand|hit|double|split makes the probe play its first turn instead of timing out. */
const ACT = (process.env.ACT ?? '').toLowerCase();
let acted = false;
const ticket = mintTicket(userId, TABLE);

console.log(`→ health`);
const h = await fetch(`${ORIGIN}/api/health`);
const health = await h.json().catch(() => null);
console.log('  ', JSON.stringify(health?.d1), JSON.stringify(health?.durableObjects?.ok));
if (!health?.d1?.ok) {
  console.error('D1 not reachable — is the local migration applied?');
  process.exit(1);
}

const url = `${ORIGIN.replace(/^http/, 'ws')}/api/ws/table/${TABLE}?ticket=${encodeURIComponent(ticket)}`;
console.log(`→ websocket ${url.replace(/ticket=.*/, 'ticket=…')}`);

const T0 = Date.now();
const at = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;
const ws = new WebSocket(url);
const seen = [];
let hello = null;
let states = 0;
let events = 0;

const fail = (msg) => {
  console.error(`✘ ${msg}`);
  seen.slice(0, 6).forEach((s) => console.error('   frame:', s.slice(0, 200)));
  process.exitCode = 1;
  try {
    ws.close();
  } catch {
    /* noop */
  }
  setTimeout(() => process.exit(1), 200);
};

const timer = setTimeout(() => fail('no hello frame within 12s — the relay or the DO handshake is broken'), 12_000);

ws.onopen = () => console.log('  socket open (101 through the Worker relay)');
ws.onerror = (e) => console.error('  socket error', e.message ?? e);
ws.onclose = (e) => {
  clearTimeout(timer);
  console.log(`  closed code=${e.code} reason=${e.reason || '(none)'}`);
  if (!hello) fail('closed without a hello frame');
};

ws.onmessage = (m) => {
  const text = String(m.data);
  seen.push(text);
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return fail('non-JSON frame from the table');
  }

  if (msg.t === 'hello') {
    hello = msg;
    clearTimeout(timer);
    console.log(`✓ HELLO protocol=${msg.protocol} phase=${msg.table.phase} seats=${msg.table.seats.length}`);
    console.log(`  shoe: ${msg.table.shoe.cardsRemaining}/${msg.table.shoe.shoeSize} cards, commitment ${msg.table.shoe.commitment.slice(0, 12)}…`);
    console.log(`  you: bankroll=${msg.you.bankrollCents} seat=${msg.you.seatIndex}`);
    console.log(`  rules: ${msg.rules.decks} decks, BJ ${msg.rules.blackjackPays}, peek=${msg.rules.dealerPeeksForBlackjack}`);

    // Leak check: the wire payload must not contain the shoe or a hidden hole card.
    const leak = JSON.stringify(msg.table).match(/"order"\s*:/);
    console.log(leak ? '✘ LEAK: shoe order present on the wire!' : '✓ no shoe order on the wire');

    console.log('→ sit');
    ws.send(JSON.stringify({ t: 'sit', ref: 1 }));
    setTimeout(() => {
      console.log('→ wager 500');
      ws.send(JSON.stringify({ t: 'wager', chips: [500], ref: 2 }));
    }, 400);
    setTimeout(() => {
      console.log('→ waiting for the betting window to close and cards to land…');
    }, 900);
    return;
  }

  if (msg.t === 'ack' && !msg.ok) console.log(`  ✎ ack ${msg.code}: ${msg.error}`);
  if (msg.t === 'event') {
    events += 1;
    const d = msg.data ?? {};
    const label = `${msg.kind}${d.phase ? ` → ${d.phase}` : ''}${d.cards ? ` cards=[${d.cards.join(',')}]` : ''}${d.message ? ` "${d.message}"` : ''}`;
    console.log(`  ${at()} ● ${label}`);
  }
  if (msg.t === 'state') {
    states += 1;
    const s = msg.state;
    const mine = s.seats.find((x) => x?.isYou);
    const hole = !s.dealer.holeRevealed && s.dealer.cards.length < 2;
    if (states % 1 === 0) {
      console.log(
        `  ${at()} ▸ state ${s.phase} due-in=${Math.max(0, s.phaseDueAt - Date.now())}ms dealer=[${s.dealer.cards.join(',')}]${hole ? ' +1 hidden' : ''} ` +
          `mine=${mine ? `${mine.hands.map((h) => `[${h.cards.join(',')}]=${h.total}/${h.betCents}c${h.outcome ? ':' + h.outcome : ''}`).join(' ')} seat${mine.index}` : 'not seated'}` +
          `${msg.you.legal ? ` legal=${JSON.stringify(msg.you.legal)}` : ''}`,
      );

    // Drive a real player action once, to prove input -> server mutation -> broadcast.
    if (ACT && !acted && s.phase === 'PLAYER_TURNS' && mine?.hands.length && msg.you.legal?.[ACT]) {
      acted = true;
      const before = mine.hands[0].cards.length;
      console.log(`  ${at()} → sending action: ${ACT} (hand has ${before} cards)`);
      setTimeout(() => ws.send(JSON.stringify({ t: 'action', a: ACT, ref: 42 })), 250);
    }
    }
    // Round finished? report and stop.
    if (s.phase === 'SETTLEMENT' && mine && mine.hands.length && mine.hands[0].cards.length >= 2) {
      console.log('✓ round reached settlement with a dealt, funded hand');
      setTimeout(() => {
        clearTimeout(timer);
        ws.close(1000, 'e2e done');
      }, 1200);
    }
  }
  if (events > 40 || seen.length > 260) fail('too many frames — possible loop');
};
