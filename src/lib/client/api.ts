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
    throw new ApiError((e as Error).name === 'AbortError' ? 'Request cancelled.' : 'Network unreachable.', 'NETWORK', 0);
  }

  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!json) throw new ApiError(`Unexpected response (HTTP ${res.status})`, 'BAD_RESPONSE', res.status);
  if (!json.ok) throw new ApiError(json.error, json.code, res.status);
  return json.data;
}

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
};

export function humanError(e: unknown): string {
  if (e instanceof ApiError) return e.message || RECOVERABLE[e.code] || `Error: ${e.code}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
