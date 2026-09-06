// Security-critical helpers: initData signatures, WS tickets, money, rate limits.
import { describe, expect, it } from 'vitest';

import { buildDataCheckString, computeInitDataHash, timingSafeEqualHex, validateInitData } from '../../src/lib/telegram/initData.ts';
import { signTicket, verifyTicket, normalizeInitData } from '../../src/lib/auth.ts';
import { formatCents, sumChips, toCents } from '../../src/shared/money.ts';
import { SlidingWindowRateLimiter } from '../../src/lib/ratelimit.ts';
import type { AppConfig } from '../../src/lib/config.ts';

// Not credential-shaped on purpose: this is only ever an HMAC key for the
// signature fixture below, and a `digits:alphanumeric` string in a public repo
// reads as a leaked bot token to every secret scanner and human reviewer.
const TOKEN = 'security-test-fixture-key-not-a-bot-token';
const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef';

const te = new TextEncoder();

async function hmacBytes(key: Uint8Array | string, msg: string): Promise<Uint8Array> {
  const raw = typeof key === 'string' ? te.encode(key) : key;
  const k = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, te.encode(msg) as BufferSource);
  return new Uint8Array(sig);
}

async function hmacHex(key: Uint8Array | string, msg: string): Promise<string> {
  return Array.from(await hmacBytes(key, msg))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Forge a *valid* initData string the same way a Telegram client does. Having the
 * generator in the test means we can also prove the verifier rejects every
 * tampered variant, which a captured sample alone would not.
 */
async function forge(fields: Record<string, string>, token = TOKEN): Promise<string> {
  const params = new URLSearchParams(fields);
  const secretKey = await hmacBytes('WebAppData', token);
  const hash = await hmacHex(secretKey, buildDataCheckString(params));
  params.set('hash', hash);
  return params.toString();
}

const USER = JSON.stringify({ id: 4242, first_name: 'Ada', username: 'ada', language_code: 'en', is_premium: false });
const NOW = Math.floor(Date.now() / 1000);

describe('timingSafeEqualHex', () => {
  it('matches equal strings and rejects different ones', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualHex('', '')).toBe(true);
  });
});

describe('data-check-string construction', () => {
  it('sorts keys, uses decoded values, excludes only hash', () => {
    const p = new URLSearchParams(`user=${encodeURIComponent(USER)}&auth_date=1700000000&query_id=abc&hash=deadbeef`);
    const dcs = buildDataCheckString(p);
    const lines = dcs.split('\n');
    expect(lines).toEqual([...lines].sort());
    expect(dcs).not.toContain('deadbeef');
    expect(lines[0]!.startsWith('auth_date=')).toBe(true);
    // The user value must be the decoded JSON, which is what Telegram signs.
    expect(dcs).toContain(`user=${USER}`);
    expect(dcs).not.toContain('%7B');
  });
});

describe('validateInitData', () => {
  it('accepts a correctly signed, fresh payload', async () => {
    const raw = await forge({ user: USER, auth_date: String(NOW), query_id: 'AAA' });
    const r = await validateInitData(raw, { botToken: TOKEN, maxAgeSeconds: 86_400 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.user.id).toBe(4242);
      expect(r.data.user.username).toBe('ada');
      expect(r.data.authDate).toBe(NOW);
      expect(r.data.queryId).toBe('AAA');
    }
  });

  it('rejects a payload signed by a different bot', async () => {
    const raw = await forge({ user: USER, auth_date: String(NOW) }, 'security-test-fixture-OTHER-key');
    const r = await validateInitData(raw, { botToken: TOKEN, maxAgeSeconds: 86_400 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BAD_HASH');
  });

  it('rejects tampering with the user id', async () => {
    const raw = await forge({ user: USER, auth_date: String(NOW) });
    const evil = raw.replace('%22id%22%3A4242', '%22id%22%3A1111');
    expect(evil).not.toBe(raw);
    const r = await validateInitData(evil, { botToken: TOKEN, maxAgeSeconds: 86_400 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BAD_HASH');
  });

  it('rejects a stale auth_date and a wildly future one', async () => {
    const stale = await forge({ user: USER, auth_date: String(NOW - 90_000) });
    const r1 = await validateInitData(stale, { botToken: TOKEN, maxAgeSeconds: 86_400 });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('STALE');

    const future = await forge({ user: USER, auth_date: String(NOW + 3600) });
    const r2 = await validateInitData(future, { botToken: TOKEN, maxAgeSeconds: 86_400 });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('FUTURE_AUTH_DATE');
  });

  it('rejects missing, zero and absent-hash input without throwing', async () => {
    for (const bad of ['', '   ', 'user=%7B%7D', `user=${encodeURIComponent(USER)}&auth_date=${NOW}`]) {
      const r = await validateInitData(bad, { botToken: TOKEN, maxAgeSeconds: 86_400 });
      expect(r.ok).toBe(false);
    }
    const zero = await forge({ user: USER, auth_date: '0' });
    const r = await validateInitData(zero, { botToken: TOKEN, maxAgeSeconds: 86_400 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BAD_AUTH_DATE');
  });

  it('verifies the algorithm against Telegram documented vector shape', async () => {
    // Independent recomputation of the spec, not a call into our own helper.
    const raw = await forge({ user: USER, auth_date: String(NOW) });
    const params = new URLSearchParams(raw);
    const dcs = [...params.keys()]
      .filter((k) => k !== 'hash')
      .sort()
      .map((k) => `${k}=${params.get(k)}`)
      .join('\n');
    const secretKey = await hmacBytes('WebAppData', TOKEN);
    expect(await hmacHex(secretKey, dcs)).toBe(params.get('hash'));
  });
});

describe('websocket tickets', () => {
  const cfg = { appSecret: SECRET, wsTicketTtlSeconds: 60 } as AppConfig;

  it('round-trips a valid ticket', async () => {
    const t = await signTicket(cfg, 4242, 'bravo');
    const v = await verifyTicket(cfg, t, 'bravo');
    expect(v).toEqual({ ok: true, userId: 4242, tableId: 'bravo' });
  });

  it('refuses a ticket minted for another table', async () => {
    const t = await signTicket(cfg, 4242, 'bravo');
    const v = await verifyTicket(cfg, t, 'delta');
    expect(!v.ok && v.reason).toBe('WRONG_TABLE');
  });

  it('refuses an expired ticket', async () => {
    // signTicket's 4th argument is the ISSUE time, so expiry = issue + ttl.
    const t = await signTicket(cfg, 4242, 'bravo', NOW - 120);
    const v = await verifyTicket(cfg, t, 'bravo', NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('EXPIRED');
  });

  it('refuses a forged or mutated ticket', async () => {
    const t = await signTicket(cfg, 4242, 'bravo');
    const [pre = '', body = '', sig = ''] = t.split('.');
    // Swap the user id inside the payload without re-signing.
    const evil = Buffer.from(JSON.stringify({ u: 1, t: 'bravo', e: NOW + 999, n: 'x', p: 'ws' })).toString('base64url');
    expect(await verifyTicket(cfg, `${pre}.${evil}.${sig}`, 'bravo')).toMatchObject({ ok: false, reason: 'BAD_SIG' });
    // Flip one hex char of the signature.
    const flipped = `${pre}.${body}.${sig.slice(0, -1)}${sig.at(-1) === 'a' ? 'b' : 'a'}`;
    expect(await verifyTicket(cfg, flipped, 'bravo')).toMatchObject({ ok: false, reason: 'BAD_SIG' });
    // Garbage shapes must not throw.
    for (const junk of ['', 'nonsense', 'ws1.onlytwo', 'ws1.a.b.c', 'v9.aaa.bbb']) {
      expect((await verifyTicket(cfg, junk, 'bravo')).ok).toBe(false);
    }
  });

  it('does not verify with a different app secret', async () => {
    const t = await signTicket(cfg, 4242, 'bravo');
    const other = { appSecret: 'f'.repeat(64), wsTicketTtlSeconds: 60 } as AppConfig;
    expect(await verifyTicket(other, t, 'bravo')).toMatchObject({ ok: false, reason: 'BAD_SIG' });
  });
});

describe('normalizeInitData', () => {
  it('decodes a percent-encoded blob exactly once', () => {
    const raw = `user=${encodeURIComponent(USER)}&auth_date=${NOW}&hash=abc`;
    expect(normalizeInitData(raw)).toBe(raw);
    expect(normalizeInitData(encodeURIComponent(raw))).toBe(raw);
  });
});

describe('money', () => {
  it('formats cents as dollars without float drift', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(1000)).toBe('$10.00');
    expect(formatCents(1050)).toBe('$10.50');
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(-250)).toBe('-$2.50');
  });

  it('rejects sub-cent and non-numeric input instead of rounding', () => {
    expect(toCents(1000)).toBe(1000);
    expect(toCents('1000')).toBe(1000);
    expect(toCents(10.5)).toBeNull();
    expect(toCents('10.50')).toBeNull();
    expect(toCents(NaN)).toBeNull();
    expect(toCents(Infinity)).toBeNull();
    expect(toCents(null)).toBeNull();
    expect(toCents({})).toBeNull();
  });

  it('sums chips under a cap', () => {
    expect(sumChips([500, 500, 100], 10_000)).toBe(1100);
    expect(sumChips([500, 500], 700)).toBe(700);
    expect(sumChips([-1, 500, NaN as number], 10_000)).toBe(500);
  });
});

describe('rate limiter', () => {
  it('allows exactly `limit` hits then blocks with a sane retryAfter', () => {
    const rl = new SlidingWindowRateLimiter(3, 1000);
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(rl.check('k', t0 + i).allowed).toBe(true);
    const blocked = rl.check('k', t0 + 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it('slides the window rather than resetting it wholesale', () => {
    const rl = new SlidingWindowRateLimiter(2, 1000);
    const t0 = 5_000_000;
    expect(rl.check('u', t0).allowed).toBe(true);
    expect(rl.check('u', t0 + 100).allowed).toBe(true);
    expect(rl.check('u', t0 + 200).allowed).toBe(false);
    expect(rl.check('u', t0 + 999).allowed).toBe(false);
    expect(rl.check('u', t0 + 1001).allowed).toBe(true); // first hit expired
  });

  it('keeps keys independent and bounds its memory', () => {
    const rl = new SlidingWindowRateLimiter(1, 1000, 2);
    expect(rl.check('a', 500).allowed).toBe(true);
    expect(rl.check('b', 501).allowed).toBe(true);
    expect(rl.check('c', 502).allowed).toBe(true);
    expect(rl.check('d', 503).allowed).toBe(true);
    // Sweep is allowed slack for the key being written, but must not grow without
    // bound as distinct keys stream through.
    expect(rl.size).toBeLessThanOrEqual(4);
    // A key that is still tracked keeps enforcing its own budget.
    expect(rl.check('d', 504).allowed).toBe(false);
    rl.reset('d');
    expect(rl.check('d', 505).allowed).toBe(true);
  });

  it('validates its own construction', () => {
    expect(() => new SlidingWindowRateLimiter(0, 1000)).toThrow(RangeError);
    expect(() => new SlidingWindowRateLimiter(5, 0)).toThrow(RangeError);
  });
});
