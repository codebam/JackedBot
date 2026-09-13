// =============================================================================
// Browser -> our API. Every call carries initData; the server verifies the
// signature on all of them, so this is transport sugar, not a trust mechanism.
// =============================================================================
import { getInitData } from './telegram.ts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: string; code: string };

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Skip the initData header (public endpoints only). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (!opts.anonymous) {
    const initData = getInitData();
    if (initData) headers['x-telegram-init-data'] = initData;
  }
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(path, { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers, body, signal: opts.signal });
  } catch (e) {
    throw new ApiError(
      (e as Error).name === 'AbortError' ? 'That took too long and was cancelled. Try again.' : NETWORK_COPY,
      'NETWORK',
      0,
    );
  }

  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!json) throw new ApiError(`JackedBot sent back something unexpected (HTTP ${res.status}). Pull to refresh and try again.`, 'BAD_RESPONSE', res.status);
  if (!json.ok) throw new ApiError(json.error, json.code, res.status);
  return json.data;
}

/** One copy of the offline message: it is thrown, mapped and rendered. */
const NETWORK_COPY = 'No connection to JackedBot right now. Check your network and try again.';

/** Codes the UI knows how to react to, with the reaction it should have. */
export const RECOVERABLE: Record<string, string> = {
  INIT_DATA_REQUIRED: 'Re-open the mini app from Telegram.',
  INIT_DATA_BAD_HASH: 'Session rejected. Re-open the mini app.',
  INIT_DATA_STALE: 'Session expired. Re-open the mini app.',
  AGE_GATE_REQUIRED: 'Confirm you are 18 or over to continue.',
  NEED_REBUY: 'You are out of chips — buy more to keep playing.',
  NEED_SEAT_MINIMUM: 'This table needs a bigger bankroll.',
  INSUFFICIENT_BANKROLL: 'Not enough chips for that.',
  RATE_LIMITED: 'Slow down a moment.',
  TABLE_FULL: 'Every seat is taken.',
  NOT_BETTING: 'Betting is closed for this round.',
  NOT_YOUR_TURN: 'Wait for your turn.',
  // Transport and plumbing codes: these arrive with either no copy at all or with
  // whatever raw text the other end happened to emit, so the map is the copy.
  NETWORK: NETWORK_COPY,
  BAD_RESPONSE: 'JackedBot sent back something unexpected. Pull to refresh and try again.',
  NON_JSON_RESPONSE: 'The table is not responding. Pull to refresh and try again.',
  TABLE_ERROR: 'The table is not responding. Pull to refresh and try again.',
  SOCKET_REFUSED: 'Could not reach the table. Pull to refresh and try again.',
  BOOT_FAILED: 'The table did not start. Pull to refresh and try again.',
  INVOICE_FAILED: 'The payment sheet would not open. Nothing was charged — try again shortly.',
  TABLE_NOT_FOUND: 'That table is gone. Head back to the lobby.',
};

/** Last resort. Never a stack trace, a machine code, `undefined` or `[object Object]`. */
const UNKNOWN = 'Something went wrong on our side. Pull to refresh, then try again.';

/**
 * Is this string a sentence a player can act on?
 *
 * The server writes good copy for its own rejections and that copy wins, but a
 * message can also reach here as a bare code, an empty string, a dumped HTML error
 * page or a stack frame — all of which used to be shown verbatim in a toast.
 */
function isSentence(message: string): boolean {
  const t = message.trim();
  if (!t || t.length > 200) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(t)) return false; // STAKE_OUT_OF_BAND
  if (/^(at\s|\w*Error:|[<[{]|https?:)/.test(t)) return false; // stack frame, JSON, HTML, URL
  return true;
}

/**
 * The only error string the UI is allowed to render.
 *
 * Order of preference: what the server said, then what our code map says about that
 * failure, then a plain "try again". Anything we cannot phrase for a human is
 * replaced rather than passed through — an unrecognisable message costs the player
 * the one thing they needed, which is what to do next.
 */
export function humanError(e: unknown): string {
  if (e instanceof ApiError) {
    if (isSentence(e.message)) return e.message.trim();
    return RECOVERABLE[e.code] ?? UNKNOWN;
  }
  if (e instanceof Error) {
    if (e.name === 'AbortError') return 'That took too long and was cancelled. Try again.';
    // A fetch failure surfaces as "Failed to fetch" / "Load failed" / "NetworkError
    // when attempting to fetch resource" depending on the client: name the symptom,
    // not the engine's wording.
    if (/fetch|network|offline|load failed/i.test(e.message)) return NETWORK_COPY;
    return UNKNOWN;
  }
  return UNKNOWN;
}
