// Regression test for a bug that reached production and silently broke every Bot
// API call: invoking the injected fetch as `this.fetchImpl(url)` passes the
// TelegramBot instance as the receiver, and the Workers global `fetch` rejects a
// foreign `this` with
//   "Illegal invocation: function called with incorrect `this` reference"
// Node's fetch tolerates it, so the Node suite stayed green; the DO tests never
// called the Bot API, so nothing else caught it either. /start then created the
// user row and died before replying — indistinguishable from an ignored command.
//
// The assertion is on the *receiver*, which pins the bug class without a network.
import { describe, expect, it } from 'vitest';

import { TelegramBot, TelegramApiError } from '../../src/lib/telegram/api.ts';

const TOKEN = '123456789:RegressionTestTokenNotARealOne_xxxxxxxxxxx';

interface Recorded {
  receiver: unknown;
  url: string;
  method: string;
  body: Record<string, unknown>;
}

/** A fetch stand-in that records what `this` it was called with. */
function recordingFetch(reply: () => Response): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fn = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Response {
    calls.push({
      receiver: this,
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    });
    return reply();
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

const ok = (result: unknown) => Response.json({ ok: true, result });

describe('TelegramBot transport', () => {
  it('calls fetch unbound so workerd does not raise Illegal invocation', async () => {
    const { fetch: f, calls } = recordingFetch(() => ok({ id: 1, is_bot: true, username: 'probe_bot', first_name: 'Probe' }));
    const me = await new TelegramBot(TOKEN, f).getMe();

    expect(me.username).toBe('probe_bot');
    expect(calls).toHaveLength(1);
    // Strict undefined: a method-style call would put the TelegramBot here.
    expect(calls[0]!.receiver).toBeUndefined();
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it('POSTs JSON with the fields the Bot API expects', async () => {
    const { fetch: f, calls } = recordingFetch(() => ok({ message_id: 7, date: 0, chat: { id: 1, type: 'private' } }));
    const msg = await new TelegramBot(TOKEN, f).sendMessage(123, 'hello <b>world</b>');

    expect(msg.message_id).toBe(7);
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.receiver).toBeUndefined();
    expect(c.body).toMatchObject({ chat_id: 123, text: 'hello <b>world</b>', parse_mode: 'HTML' });
  });

  it('drops undefined values instead of sending the string "undefined"', async () => {
    const { fetch: f, calls } = recordingFetch(() => ok(true));
    await new TelegramBot(TOKEN, f).answerPreCheckoutQuery('pq-1', true, 'must be absent when ok');

    expect(calls[0]!.body).toEqual({ pre_checkout_query_id: 'pq-1', ok: true });
  });

  it('sends the Stars invoice parameters exactly as the docs require', async () => {
    const { fetch: f, calls } = recordingFetch(() => ok('https://t.me/pay/fake'));
    await new TelegramBot(TOKEN, f).createInvoiceLinkStars({ title: 'Buy chips', description: 'd', payload: 'buyin:1:n', stars: 3 });

    const body = calls[0]!.body;
    expect(body.currency).toBe('XTR');
    expect(body.provider_token).toBe('');
    // Stars have no minor unit: 3 Stars is amount 3, never 300.
    expect(body.prices).toEqual([{ label: 'Buy chips', amount: 3 }]);
  });

  it('rejects with a typed error on a Telegram 4xx', async () => {
    const { fetch: f } = recordingFetch(() => Response.json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, { status: 400 }));
    await expect(new TelegramBot(TOKEN, f).sendMessage(1, 'x')).rejects.toThrow(TelegramApiError);
  });

  it('refuses a malformed token at construction', () => {
    expect(() => new TelegramBot('not-a-token')).toThrow(/does not look like/);
  });
});
