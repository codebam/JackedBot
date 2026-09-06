// Private tables: stakes validation and the inline-mode picker.
//
// Both are pure, so the money-relevant rules (what blinds are allowed, who can see
// what) are pinned here without workerd, and the two failure modes that bit this
// project in production get explicit assertions: a Telegram 4xx caused by a bad
// button URL, and an update type silently never arriving.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateStakes, safeTableName, STAKE_LIMITS } from '../../src/lib/stakes.ts';
import { buildInlineResults } from '../../src/lib/telegram/inline.ts';
import { startParamForPath, pathForStartParam } from '../../src/shared/deeplink.ts';
import type { PrivateTableSummary } from '../../src/lib/db/privateTables.ts';

const good = { name: 'Friday night', minBetCents: 500, maxBetCents: 20_000, buyInCents: 10_000, minBankrollCents: 2_500, seatCount: 5 };

describe('validateStakes', () => {
  it('accepts a sane full-control table and echoes the value back', () => {
    const r = validateStakes(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(good);
  });

  it('treats a missing seat minimum as zero rather than undefined', () => {
    const r = validateStakes({ ...good, minBankrollCents: undefined });
    expect(r.ok && r.value.minBankrollCents).toBe(0);
  });
  it('rejects non-integer cents instead of rounding it away', () => {
    // 12.5 would otherwise become a fractional-chips table, and the ledger is INTEGER.
    for (const bad of [12.5, '500', NaN, Infinity, 2 ** 53]) {
      expect(validateStakes({ ...good, minBetCents: bad }).ok, `minBetCents=${String(bad)}`).toBe(false);
    }
  });

  it('enforces the bands', () => {
    // Narrowed via a helper rather than `?.`: the union is the point of the API, and
    // reading .code without checking ok is exactly what this type exists to prevent.
    const rejected = (r: ReturnType<typeof validateStakes>, code: string) => {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(code);
    };
    rejected(validateStakes({ ...good, minBetCents: 10 }), 'STAKE_OUT_OF_BAND');
    rejected(validateStakes({ ...good, maxBetCents: STAKE_LIMITS.maxBetCents.hi + 100 }), 'STAKE_OUT_OF_BAND');
    rejected(validateStakes({ ...good, seatCount: 9 }), 'SEAT_COUNT_INVALID');
    rejected(validateStakes({ ...good, name: '' }), 'NAME_REQUIRED');
  });

  it('rejects a max bet below the min bet', () => {
    const r = validateStakes({ ...good, minBetCents: 5_000, maxBetCents: 1_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('MAX_BELOW_MIN');
  });

  it('rejects a buy-in that cannot cover one minimum bet', () => {
    expect(validateStakes({ ...good, minBetCents: 5_000, buyInCents: 1_000 }).ok).toBe(false);
  });

  it('warns when a seat minimum is above the buy-in, because that is unjoinable', () => {
    const r = validateStakes({ ...good, buyInCents: 5_000, minBankrollCents: 100_000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join(' ')).toMatch(/cannot take a seat/);
  });

  it('strips markup characters from a table name', () => {
    const out = safeTableName('<b>x</b>');
    expect(out).not.toMatch(/[<>&]/);
    expect(out).toContain('x');
  });
});

const table = (over: Partial<PrivateTableSummary>): PrivateTableSummary => ({
  id: 'a'.repeat(32),
  name: 'Friday night',
  minBetCents: 500,
  maxBetCents: 20_000,
  buyInCents: 10_000,
  seatCount: 5,
  activeSeats: 1,
  status: 'open',
  role: 'owner',
  ...over,
});

describe('buildInlineResults', () => {
  const appUrl = (path: string) => `https://jackedbot.example.workers.dev${path}`;

  it('uses a url button on inline results, never web_app', () => {
    // This is the BUTTON_URL_INVALID class of bug. In inline mode the symptom is an
    // empty picker with no error at all, so assert the shape rather than the code path.
    const r = buildInlineResults({ query: '', tables: [table({})], appUrl })[0]!;
    const btn = r.reply_markup?.inline_keyboard[0]?.[0] as { text: string; url?: string; web_app?: { url: string } };
    expect(btn.text).toBe('Join table');
    // web_app is not a legal button type on an inline result: Telegram answers
    // BUTTON_TYPE_INVALID and drops the whole batch, which the client shows as
    // "No results". The deep link has to ride in a plain url button.
    expect(btn.web_app).toBeUndefined();
    // Without a deepLink the helper falls back to the bare https app URL, which is
    // still a legal `url` button. handleInlineQuery always supplies deepLink, so the
    // shipped form is t.me/<bot>?startapp=t_<id>; asserted in config.ts below.
    expect(btn.url).toBe(`https://jackedbot.example.workers.dev/table/${'a'.repeat(32)}?invite=1`);
  });

  it('keeps result ids within Telegram limits and unique', () => {
    const rs = buildInlineResults({ query: '', tables: [table({}), table({ id: 'b'.repeat(32), name: 'Other' })], appUrl });
    expect(new Set(rs.map((r) => r.id)).size).toBe(2);
    for (const r of rs) expect(r.id.length).toBeLessThanOrEqual(64);
  });

  it('filters by typed text on the name, not on the slug', () => {
    const tables = [table({ id: 'c'.repeat(32), name: 'Beach' }), table({ id: 'd'.repeat(32), name: 'Mountain' })];
    expect(buildInlineResults({ query: 'bea', tables, appUrl }).map((r) => r.title)).toEqual(['Beach · yours']);
    // Typing half a slug must not resolve to a table.
    expect(buildInlineResults({ query: 'dddd', tables, appUrl })[0]?.id).toBe('help-none');
  });

  it('degrades to a help row instead of an empty picker', () => {
    const rs = buildInlineResults({ query: 'nothing matches', tables: [], appUrl, createUrl: appUrl('/new-table') });
    expect(rs).toHaveLength(1);
    expect(rs[0]!.id).toBe('help-none');
    // The create row can no longer point at /new-table as a web_app button; it links
    // to the lobby, where the create button lives and where initData exists.
    const btn = rs[0]!.reply_markup?.inline_keyboard[0]?.[0] as { text: string; url?: string; web_app?: unknown };
    expect(btn.web_app).toBeUndefined();
    expect(btn.text).toMatch(/create/i);
    expect(btn.url).toBe('https://jackedbot.example.workers.dev/');
  });

  it('labels a full table honestly rather than offering a Join that will fail', () => {
    const rs = buildInlineResults({ query: '', tables: [table({ activeSeats: 5 })], appUrl });
    const btn = rs[0]!.reply_markup?.inline_keyboard[0]?.[0] as { text: string };
    expect(btn.text).toBe('View table');
    expect(rs[0]!.description).toMatch(/0 seats open/);
  });

  it('escapes markup characters in the posted message', () => {
    const hostile = table({ name: 'a<b>&c' });
    const rs = buildInlineResults({ query: '', tables: [hostile], appUrl });
    expect(rs[0]!.input_message_content.message_text).not.toMatch(/a<b>/);
    expect(rs[0]!.input_message_content.message_text).toContain('a&lt;b&gt;&amp;c');
  });
});

describe('inline mode wiring', () => {
  // The single most likely way this feature "does nothing": allowed_updates is set in
  // two places, and Telegram drops any update type not listed there without an error
  // on either side. Assert both copies, and that they agree.
  const lists = [
    ['scripts/set-webhook.mjs', readFileSync('scripts/set-webhook.mjs', 'utf8')],
    ['src/lib/telegram/api.ts', readFileSync('src/lib/telegram/api.ts', 'utf8')],
  ] as const;

  for (const [file, src] of lists) {
    it(`${file} subscribes to inline_query`, () => {
      const m = /allowed_updates: \[([^\]]*)\]/.exec(src);
      expect(m, 'no allowed_updates literal found').not.toBeNull();
      const list = (m?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
      expect(list).toContain('inline_query');
      expect(list).toContain('callback_query');
    });
  }

  it('both allowed_updates lists are identical', () => {
    const grab = (src: string) => (/allowed_updates: \[([^\]]*)\]/.exec(src)?.[1] ?? '').split(',').map((s) => s.trim()).sort().join('|');
    expect(grab(lists[0][1])).toBe(grab(lists[1][1]));
  });

  it('registers /newtable with BotFather commands', () => {
    const src = readFileSync('src/lib/telegram/commands.ts', 'utf8');
    expect(src).toMatch(/command: 'newtable'/);
  });
});

describe('seatCount is a count of people, not money', () => {
  // Regression: the create form once ran the seats <select> through its dollars->cents
  // helper, so "5" reached validateStakes as 500 and every private table failed with
  // "A table seats between 1 and 5 players."
  const stakes = (over: Record<string, unknown>) =>
    validateStakes({ name: 'Duror Fans Table', minBetCents: 100, maxBetCents: 1000, buyInCents: 500, minBankrollCents: 100, ...over });

  it('accepts an integer seat count', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const r = stakes({ seatCount: n });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.seatCount).toBe(n);
    }
  });

  it('rejects a seat count that was multiplied by 100 on the way out', () => {
    const r = stakes({ seatCount: 500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SEAT_COUNT_INVALID');
  });

  it('keeps money in integer cents and counts as counts', () => {
    const r = stakes({ seatCount: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.minBetCents).toBe(100); // $1.00
      expect(r.value.seatCount).toBe(5); // five chairs
    }
    expect(stakes({ seatCount: 2.5 }).ok).toBe(false);
    expect(stakes({ seatCount: '5' }).ok).toBe(false);
  });
});

describe('Telegram wire-format rules the API enforces and TypeScript does not', () => {
  const ID_CHARSET = /^[A-Za-z0-9_-]{1,64}$/;

  // answerInlineQuery rejects the entire batch if any result id falls outside this
  // charset, and the client renders that as a plain "No results". The pre-existing
  // id test checked length and uniqueness, which let `t:<hex>` through to production.
  it('uses only [A-Za-z0-9_-] in every inline result id, including the help row', () => {
    const appUrl = (p: string) => `https://app.example${p}`;
    const rows = buildInlineResults({ query: '', tables: [table({})], appUrl });
    for (const r of rows) expect(r.id).toMatch(ID_CHARSET);
    const help = buildInlineResults({ query: '', tables: [], appUrl });
    expect(help.length).toBeGreaterThan(0);
    for (const r of help) expect(r.id).toMatch(ID_CHARSET);
  });

});

describe('Mini App deep links use the only form Telegram implements', () => {
  // t.me/<bot>?app=<url> was never a Telegram parameter; the client ignored it and
  // opened the bot's chat, so every invite link we generated was inert.
  it('encodes a table invite as a start param and back again', () => {
    const id = 'a3b4ca98dc4b4aae815c51b87ba72e71';
    expect(startParamForPath(`/table/${id}?invite=1`)).toBe(`t_${id}`);
    expect(pathForStartParam(`t_${id}`)).toBe(`/table/${id}?invite=1`);
    // Telegram's 64-char base64url budget applies to the start PARAM, not the link.
    expect(`t_${id}`).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(`t_${id}`.length).toBeLessThanOrEqual(64);
  });

  it('refuses to turn a start param into an arbitrary path', () => {
    for (const bad of ['t_zzz', 't_' + 'a'.repeat(31), 't_' + 'a'.repeat(32) + 'x', 'https://evil.example/', '', 'x_' + 'a'.repeat(32)]) {
      expect(pathForStartParam(bad)).toBe(null);
    }
    expect(pathForStartParam('h')).toBe('/');
    expect(startParamForPath('/new-table')).toBe(null);
  });

  it('builds share links as startapp, never as the invented ?app= form', () => {
    const src = readFileSync('src/lib/config.ts', 'utf8');
    expect(src).toMatch(/\?startapp=\$\{param\}/);
    expect(src).not.toMatch(/`https:\/\/t\.me\/\$\{cfg\.botUsername\}\?app=/);
  });
});

describe('the private-table list is a client concern, not an SSR one', () => {
  // Telegram hands initData to the WebApp client object, not to the URL. Any lobby
  // section rendered from SSR identity is therefore absent for a real Mini App launch
  // - the bug behind the inert Join button (ded99de) and the table-page nag
  // (25fa085), and it would have hidden the owner's only Close button too.
  it('renders the section from an island, never from SSR membership', () => {
    const src = readFileSync('src/pages/index.astro', 'utf8');
    expect(src).not.toMatch(/listShareableTables/);
    expect(src).toMatch(/<PrivateTables client:load/);
  });

  it('loads and closes through the session-authenticated API, owner-gated in the UI', () => {
    const src = readFileSync('src/components/PrivateTables.tsx', 'utf8');
    expect(src).toMatch(/api<\{ privateTables/);
    expect(src).toMatch(/\/close/);
    expect(src).toMatch(/role === 'owner'/);
    // The server is still the authority; hiding the button is a hint, not a control.
    const route = readFileSync('src/pages/api/tables/[id]/close.ts', 'utf8');
    expect(route).toMatch(/NOT_OWNER/);
    expect(route).toMatch(/getMembership/);
  });
});
