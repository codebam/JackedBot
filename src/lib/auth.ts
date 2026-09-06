// =============================================================================
// Request authentication for the Mini App + short-lived WebSocket tickets.
//
// Threat model
//   * The browser is untrusted. The ONLY proof of identity is a valid initData
//     signature produced by our bot token.
//   * A WebSocket handshake cannot carry an Authorization header in a browser,
//     so the client first hits an authenticated HTTP endpoint which mints a
//     single-purpose, 60-second, HMAC-signed ticket bound to one (user, table).
//     The Table DO verifies that ticket; it never trusts a self-reported user id.
// =============================================================================
import { getConfig, type AppConfig } from './config.ts';
import { validateInitData, type InitData, type InitDataResult } from './telegram/initData.ts';
import { ensureUser, fromTgUser, type UserRow } from './db/users.ts';

export const INIT_DATA_HEADER = 'x-telegram-init-data';

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }

  toResponse(): Response {
    return Response.json({ ok: false, error: this.message, code: this.code } as const, {
      status: this.status,
      headers: { 'cache-control': 'no-store' },
    });
  }
}

/** Pull initData out of the header (preferred) or the JSON/body form field. */
export async function extractInitData(request: Request): Promise<string | null> {
  const header = request.headers.get(INIT_DATA_HEADER);
  if (header) return normalizeInitData(header);

  const url = new URL(request.url);
  const fromQuery = url.searchParams.get('initData');
  if (fromQuery) return normalizeInitData(fromQuery);

  if (request.method === 'POST' || request.method === 'PATCH') {
    const contentType = request.headers.get('content-type') ?? '';
    try {
      if (contentType.includes('application/json')) {
        const body = (await request.json()) as { initData?: unknown };
        if (typeof body?.initData === 'string') return normalizeInitData(body.initData);
      } else if (contentType.includes('form-data')) {
        const fd = await request.formData();
        const v = fd.get('initData');
        if (typeof v === 'string') return normalizeInitData(v);
      } else if (contentType.includes('x-www-form-urlencoded')) {
        const fd = new URLSearchParams(await request.text());
        const v = fd.get('initData');
        if (v) return normalizeInitData(v);
      }
    } catch {
      /* fall through to null */
    }
  }
  return null;
}

/**
 * `Telegram.WebApp.initData` is a query string, and clients commonly percent-encode
 * the whole thing before putting it in a header or query param. Detect the encoded
 * form (no '=' before the first '%') and decode exactly once — decoding an already
 * raw string twice would corrupt the `user=` JSON and fail the signature check.
 */
export function normalizeInitData(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  if (s.includes('=')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface AuthedContext {
  cfg: AppConfig;
  env: Env;
  db: D1Database;
  initData: InitData;
  user: UserRow;
}

/**
 * Full authentication gate for every game/lobby API route:
 * signature -> freshness -> user exists in D1 (created on first sight).
 *
 * `maxAgeSeconds` is tightened for privileged calls: a stale-but-valid initData
 * string is fine for rendering a lobby, not for minting a buy-in invoice.
 */
export async function requireUser(request: Request, env: Env, opts: { maxAgeSeconds?: number } = {}): Promise<AuthedContext> {
  const cfg = getConfig(env, request.url);
  const raw = await extractInitData(request);
  if (!raw) throw new AuthError(401, 'INIT_DATA_REQUIRED', 'Telegram initData is required');

  const result: InitDataResult = await validateInitData(raw, {
    botToken: cfg.botToken,
    maxAgeSeconds: opts.maxAgeSeconds ?? cfg.initDataMaxAgeSeconds,
  });
  if (!result.ok) throw new AuthError(401, `INIT_DATA_${result.reason}`, result.message);

  const user = await ensureUser(env.DB, fromTgUser(result.data.user));
  if (user.banned_at) throw new AuthError(403, 'BANNED', 'This account is suspended.');

  return { cfg, env, db: env.DB, initData: result.data, user };
}

// ---------------------------------------------------------------------------
// WebSocket tickets
// ---------------------------------------------------------------------------
const te = new TextEncoder();

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', te.encode(key) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, te.encode(msg) as BufferSource);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

export interface TicketPayload {
  /** Telegram user id. */
  u: number;
  /** Table the ticket grants access to — a ticket for bravo must not open delta. */
  t: string;
  /** Expiry, epoch seconds. */
  e: number;
  /** Random so two tickets for the same user+table are never byte-identical. */
  n: string;
  /** Purpose separation: never let a ws ticket be replayed against an HTTP route. */
  p: 'ws';
}

const TICKET_PREFIX = 'ws1';

export async function signTicket(cfg: AppConfig, userId: number, tableId: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const payload: TicketPayload = {
    u: userId,
    t: tableId,
    e: nowSeconds + cfg.wsTicketTtlSeconds,
    n: Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
    p: 'ws',
  };
  const body = b64url(JSON.stringify(payload));
  const sig = await hmacHex(cfg.appSecret, `${TICKET_PREFIX}|${body}`);
  return `${TICKET_PREFIX}.${body}.${sig}`;
}

export type TicketResult = { ok: true; userId: number; tableId: string } | { ok: false; reason: 'MALFORMED' | 'BAD_SIG' | 'EXPIRED' | 'WRONG_TABLE' | 'BAD_PAYLOAD' };

export async function verifyTicket(cfg: AppConfig, ticket: string | null, expectedTableId: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<TicketResult> {
  if (!ticket) return { ok: false, reason: 'MALFORMED' };
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) return { ok: false, reason: 'MALFORMED' };
  const [, body, sig] = parts as [string, string, string];

  const expected = await hmacHex(cfg.appSecret, `${TICKET_PREFIX}|${body}`);
  if (expected.length !== sig.length) return { ok: false, reason: 'BAD_SIG' };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return { ok: false, reason: 'BAD_SIG' };

  let payload: TicketPayload;
  try {
    payload = JSON.parse(unb64url(body)) as TicketPayload;
  } catch {
    return { ok: false, reason: 'BAD_PAYLOAD' };
  }
  if (payload.p !== 'ws' || !Number.isSafeInteger(payload.u) || typeof payload.t !== 'string') return { ok: false, reason: 'BAD_PAYLOAD' };
  if (payload.t !== expectedTableId) return { ok: false, reason: 'WRONG_TABLE' };
  if (payload.e < nowSeconds) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, userId: payload.u, tableId: payload.t };
}

/** `X-Forwarded-For` is set by Cloudflare; the first entry is the client. */
export function clientIp(request: Request): string {
  const xff = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for');
  return xff?.split(',')[0]?.trim() ?? 'unknown';
}
