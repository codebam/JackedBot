// =============================================================================
// Telegram Mini App `initData` validation.
//
// Spec (https://core.telegram.org/bots/webapps#validating-data-received-via-the-
// mini-app), implemented literally:
//
//   secret_key        = HMAC_SHA256(key = "WebAppData", msg = bot_token)
//   data_check_string = all received fields except `hash`,
//                       sorted alphabetically, as `key=<value>`, joined by '\n'
//   hash              = hex( HMAC_SHA256(key = secret_key, msg = data_check_string) )
//
// Everything the game trusts — user id, seat ownership, bankroll access — is
// gated behind this function returning `ok: true`. The value used in
// `data_check_string` is the *percent-decoded* value (what URLSearchParams gives),
// which is what Telegram's own clients sign.
// =============================================================================

export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  allows_write_to_pm?: boolean;
  photo_url?: string;
  added_to_attachment_menu?: boolean;
}

export interface InitData {
  /** Raw query string exactly as the client supplied it (needed for nothing but logs). */
  raw: string;
  queryId?: string;
  user: TelegramWebAppUser;
  /** Set when the Mini App is opened in a chat other than the user's own. */
  chat?: { id: number; type: string; title?: string; username?: string; photo_url?: string };
  chatType?: string;
  chatInstance?: string;
  authDate: number;
  startParam?: string;
  canSendAfter?: number;
  hash: string;
}

export type InitDataFailure =
  | 'EMPTY'
  | 'NO_HASH'
  | 'NO_USER'
  | 'BAD_USER'
  | 'BAD_AUTH_DATE'
  | 'STALE'
  | 'FUTURE_AUTH_DATE'
  | 'BAD_HASH';

export type InitDataResult = { ok: true; data: InitData } | { ok: false; reason: InitDataFailure; message: string };

const te = new TextEncoder();

async function hmac(key: Uint8Array | string, msg: string): Promise<ArrayBuffer> {
  const keyBytes = typeof key === 'string' ? te.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return crypto.subtle.sign('HMAC', cryptoKey, te.encode(msg) as BufferSource);
}

function toHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = '';
  for (const b of view) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Length-checked, byte-by-byte comparison with no early exit.
 * `String.prototype ===` on hex digests leaks the position of the first differing
 * character through timing; irrelevant for a local hash check but this is an
 * authorisation decision on a network-reachable endpoint, so we do it properly.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The alphabetised `key=value` string Telegram signs. Exported for tests. */
export function buildDataCheckString(params: URLSearchParams, exclude: string[] = ['hash']): string {
  const keys: string[] = [];
  for (const k of params.keys()) if (!exclude.includes(k)) keys.push(k);
  keys.sort();
  return keys.map((k) => `${k}=${params.get(k) ?? ''}`).join('\n');
}

export async function computeInitDataHash(initData: string, botToken: string): Promise<string> {
  const params = new URLSearchParams(initData);
  const secretKey = new Uint8Array(await hmac('WebAppData', botToken));
  return toHex(await hmac(secretKey, buildDataCheckString(params)));
}

export interface ValidateOptions {
  botToken: string;
  /** Reject initData older than this. Telegram does not expire it; we must. */
  maxAgeSeconds: number;
  /** Injectable clock (epoch seconds) for deterministic tests. */
  nowSeconds?: number;
}

/**
 * Verifies signature + freshness and returns the parsed payload.
 * Never throws: every failure path is a typed `reason` so callers can answer with
 * the right HTTP status and the client can decide whether to re-launch the app.
 */
export async function validateInitData(initData: string | null | undefined, opts: ValidateOptions): Promise<InitDataResult> {
  const raw = (initData ?? '').trim();
  if (!raw) return fail('EMPTY', 'initData is missing');

  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) return fail('NO_HASH', 'initData contains no hash parameter');

  // 1. Signature first: an invalid signature means the payload is untrusted, and
  //    we must not parse or act on any of its fields (including auth_date).
  let expected: string;
  try {
    expected = await computeInitDataHash(raw, opts.botToken);
  } catch (e) {
    return fail('BAD_HASH', `unable to compute signature: ${(e as Error).message}`);
  }
  if (!timingSafeEqualHex(expected, hash.toLowerCase())) {
    return fail('BAD_HASH', 'initData signature does not match the bot token');
  }

  // 2. Freshness.
  const authDate = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return fail('BAD_AUTH_DATE', 'auth_date missing, zero or not an integer');
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const age = now - authDate;
  if (age > opts.maxAgeSeconds) return fail('STALE', `initData is ${age}s old (limit ${opts.maxAgeSeconds}s)`);
  // Allow 5 minutes of client clock skew, nothing more.
  if (age < -300) return fail('FUTURE_AUTH_DATE', 'auth_date is more than 5 minutes in the future');

  // 3. Actor.
  const userJson = params.get('user');
  if (!userJson) return fail('NO_USER', 'initData has no user field');
  let user: TelegramWebAppUser;
  try {
    user = JSON.parse(userJson) as TelegramWebAppUser;
  } catch {
    return fail('BAD_USER', 'user field is not valid JSON');
  }
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) return fail('BAD_USER', 'user.id is not a safe positive integer');

  const chatJson = params.get('chat');
  let chat: InitData['chat'] | undefined;
  if (chatJson) {
    try {
      chat = JSON.parse(chatJson);
    } catch {
      chat = undefined;
    }
  }

  return {
    ok: true,
    data: {
      raw,
      queryId: params.get('query_id') ?? undefined,
      user,
      chat,
      chatType: params.get('chat_type') ?? undefined,
      chatInstance: params.get('chat_instance') ?? undefined,
      authDate,
      startParam: params.get('start_param') ?? undefined,
      canSendAfter: params.get('can_send_after') ? Number(params.get('can_send_after')) : undefined,
      hash,
    },
  };
}

function fail(reason: InitDataFailure, message: string): InitDataResult {
  return { ok: false, reason, message };
}

/** Bot id is the numeric prefix of the token; used for /start deep-link validation. */
export function botIdFromToken(token: string): number {
  const n = Number(token.split(':')[0]);
  return Number.isSafeInteger(n) ? n : 0;
}
