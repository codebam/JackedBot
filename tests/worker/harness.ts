// Shared harness for the workerd project: applies the real schema to a real local
// D1 and mints the same tickets the production code mints.
import { env } from 'cloudflare:test';
// Embedded from the real schema.sql (see scripts/gen-test-schema.mjs, asserted
// fresh by tests/unit/schema.test.ts) so this runs the exact triggers production
// gets — not a hand-copied subset of them.
import { SCHEMA_SQL as schemaSql } from './schema.generated.ts';
import { splitSqlStatements } from './sql-split.ts';
import type { ServerMessage, TableView, YouView } from '../../src/shared/protocol.ts';

/**
 * Injected by vitest.workers.config.ts from `.dev.vars`, because that is the value
 * the runtime actually holds — `.dev.vars` overrides `[vars]` in wrangler.test.toml.
 * Declared rather than hard-coded so the signature always matches the verifier.
 */
declare const __TEST_APP_SECRET__: string;
export const TEST_APP_SECRET: string = __TEST_APP_SECRET__;
export const TABLE_ID = 'bravo';

function TABLE_NS(): DurableObjectNamespace {
  return (env as unknown as { TABLE: DurableObjectNamespace }).TABLE;
}

/** The D1 handle from the test Worker's bindings. */
const db = (): D1Database => (env as unknown as { DB: D1Database }).DB;

let ready: Promise<void> | null = null;

/** One-time schema bootstrap. `exec` runs the whole file, triggers included. */
export function dbReady(): Promise<void> {
  ready ??= (async () => {
    // D1's own exec() splitter cannot handle this file, so statements are carved
    // here — trigger bodies included — and applied as one transaction.
    const statements = splitSqlStatements(schemaSql);
    if (statements.length < 30) throw new Error(`schema split produced only ${statements.length} statements`);
    await db().batch(statements.map((sql) => db().prepare(sql)));
    await db()
      .prepare(
        `INSERT OR IGNORE INTO tables (id, name, status, buy_in_cents, min_bet_cents, max_bet_cents, min_bankroll_cents, seat_count, is_public, phase)
         VALUES (?1, 'Test Bravo', 'open', 1000, 100, 50000, 0, 5, 1, 'BETTING')`,
      )
      .bind(TABLE_ID)
      .run();
  })();
  return ready;
}

export async function seedUser(userId: number, bankrollCents: number, opts: { ageAccepted?: boolean; username?: string } = {}): Promise<void> {
  await dbReady();
  await db()
    .prepare(`INSERT OR IGNORE INTO users (telegram_user_id, username, first_name, age_accepted_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(userId, opts.username ?? `u${userId}`, `User ${userId}`, opts.ageAccepted === false ? null : '2026-01-01T00:00:00.000Z')
    .run();
  if (bankrollCents > 0) {
    await db()
      .prepare(`INSERT OR IGNORE INTO ledger_entries (user_id, cents_delta, reason, idempotency_key) VALUES (?1, ?2, 'admin_adjust', ?3)`)
      .bind(userId, bankrollCents, `seed:${userId}:${bankrollCents}`)
      .run();
  }
}

export async function bankrollOf(userId: number): Promise<number> {
  const row = await db()
    .prepare(`SELECT bankroll_cents FROM users WHERE telegram_user_id = ?1`)
    .bind(userId)
    .first<{ bankroll_cents: number }>();
  return row?.bankroll_cents ?? -1;
}

/**
 * Ticket compatible with signTicket() in src/lib/auth.ts, produced with the same
 * WebCrypto HMAC the production code uses (workerd has no synchronous HMAC).
 */
export async function mintTicket(userId: number, tableId = TABLE_ID, ttlSeconds = 120): Promise<string> {
  const payload = { u: userId, t: tableId, e: Math.floor(Date.now() / 1000) + ttlSeconds, n: 'deadbeefcafebabe', p: 'ws' };
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(TEST_APP_SECRET) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`ws1|${body}`) as BufferSource);
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `ws1.${body}.${hex}`;
}

/** An expired ticket, to prove the DO rejects stale credentials. */
export async function mintExpiredTicket(userId: number, tableId = TABLE_ID): Promise<string> {
  return mintTicket(userId, tableId, -10);
}

/** GET /state on the DO, as an authenticated viewer. */
export async function doState<T = unknown>(userId: number, tableId = TABLE_ID): Promise<{ status: number; body: T }> {
  await dbReady();
  const ticket = await mintTicket(userId, tableId);
  const ns = TABLE_NS();
  const stub = ns.get(ns.idFromName(tableId));
  const res = await stub.fetch(new Request(`https://table.internal/state?table=${tableId}&ticket=${encodeURIComponent(ticket)}`));
  return { status: res.status, body: (await res.json()) as T };
}

/** Direct stub fetch with an arbitrary ticket — for the rejection tests. */
export async function doFetchWithTicket<T = unknown>(ticket: string, path = '/state', tableId = TABLE_ID): Promise<{ status: number; body: T }> {
  await dbReady();
  const ns = TABLE_NS();
  const stub = ns.get(ns.idFromName(tableId));
  const res = await stub.fetch(new Request(`https://table.internal${path}?table=${tableId}&ticket=${encodeURIComponent(ticket)}`));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

/** POST /cmd on the DO through the same ticket-authenticated path the UI falls back to. */
export async function doCmdRaw<T = unknown>(userId: number, cmd: unknown, tableId = TABLE_ID): Promise<{ status: number; body: T }> {
  await dbReady();
  const ticket = await mintTicket(userId, tableId);
  const ns = TABLE_NS();
  const stub = ns.get(ns.idFromName(tableId));
  const res = await stub.fetch(
    new Request(`https://table.internal/cmd?table=${tableId}&ticket=${encodeURIComponent(ticket)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cmd),
    }),
  );
  return { status: res.status, body: (await res.json()) as T };
}

/** A rejected command, normalised. */
export interface Ack {
  ok: boolean;
  code?: string;
  error?: string;
}

/** A state-carrying reply, unwrapped from the `{ok,data}` envelope. */
export interface Viewed {
  table: TableView;
  you: YouView;
}

/**
 * Send a command and return BOTH shapes: the DO answers `wager`/`sit`/`resume`
 * with a `state` frame and refusals with an `ack`, so tests should not have to
 * know which one they are about to get.
 */
export async function send(userId: number, cmd: unknown, tableId = TABLE_ID): Promise<{ status: number; ack: Ack | null; view: Viewed | null; raw: unknown }> {
  const { status, body } = await doCmdRaw<{ ok?: boolean; code?: string; error?: string; data?: ServerMessage }>(userId, cmd, tableId);
  if (typeof body !== 'object' || body === null) return { status, ack: null, view: null, raw: body };

  const msg = body.data;
  if (msg && msg.t === 'ack') {
    return { status, ack: { ok: msg.ok, code: msg.code, error: msg.error }, view: null, raw: msg };
  }
  if (msg && msg.t === 'state') {
    return { status, ack: { ok: true }, view: { table: msg.state, you: msg.you }, raw: msg };
  }
  if (msg && msg.t === 'hello') {
    return { status, ack: { ok: true }, view: { table: msg.table, you: msg.you }, raw: msg };
  }
  if (msg && msg.t === 'pong') return { status, ack: { ok: true }, view: null, raw: msg };

  // Transport-level failure (ticket rejected, boot error).
  return {
    status,
    ack: { ok: Boolean(body.ok), code: body.code, error: body.error },
    view: null,
    raw: body,
  };
}

const _unused = [doState, bankrollOf];
void _unused;
