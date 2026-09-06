// POST /api/telegram/webhook
// Telegram Bot API webhook receiver.
//
// Defence layers, in order:
//   1. shared-secret header (`X-Telegram-Bot-Api-Secret-Token`) — proves the call
//      came from our configured webhook, cheaply and before any parsing.
//   2. shape check on `update_id`.
//   3. `seen_updates` de-duplication (Telegram redelivers on any slow ACK).
//   4. per-charge ledger idempotency inside `creditBuyIn()` — the real guarantee
//      for money, because layers 1-3 are best-effort across isolates.
import { env } from 'cloudflare:workers';
import { TelegramApiError, TelegramBot, type Update } from '../../../lib/telegram/api.ts';
import { alreadySeen, configFor, routeUpdate } from '../../../lib/telegram/webhook.ts';
import { rateLimitOr429, SlidingWindowRateLimiter } from '../../../lib/ratelimit.ts';
import { clientIp } from '../../../lib/auth.ts';
import type { APIContext } from 'astro';

export const prerender = false;

// Generous: a busy table generates bursts of pre-checkout + payment + command
// updates, and dropping a payment update is far worse than allowing a spike.
const perIp = new SlidingWindowRateLimiter(200, 10_000, 20_000);

export async function POST(context: APIContext): Promise<Response> {
  const { request } = context;
  const cfg = configFor(env, request.url);

  const secret = request.headers.get('x-telegram-bot-api-secret-token');
  if (!secret || secret !== cfg.webhookSecret) {
    // Byte-identical response for "missing" and "wrong": no oracle on the secret.
    return new Response('forbidden', { status: 403 });
  }

  const limited = rateLimitOr429(perIp.check(clientIp(request)));
  if (limited) return limited;

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return new Response('bad json', { status: 400 });
  }
  if (!Number.isSafeInteger(update?.update_id)) return new Response('bad update', { status: 400 });

  if (await alreadySeen(env.DB as unknown as D1Database, update.update_id)) {
    // Telegram is retrying something we already handled. Answer 200 so it stops,
    // and rely on ledger idempotency for the money path.
    return Response.json({ ok: true, duplicate: true });
  }

  const ctx = context.locals.cfContext;
  const bot = new TelegramBot(cfg.botToken);

  try {
    const result = await routeUpdate(update, { env: env as unknown as Env, cfg, bot, ctx });
    return Response.json({ ok: true, handled: result.handled });
  } catch (e) {
    // A Telegram API rejection means the *delivery* failed, not our processing.
    // Retrying cannot fix "user blocked the bot" or "chat not found", and a 5xx
    // would make Telegram redeliver this update forever, so ACK those and move on.
    if (e instanceof TelegramApiError && DEAD_CHAT.test(e.description)) {
      console.warn(`dropped update ${update.update_id}: ${e.code} ${e.description}`);
      return Response.json({ ok: true, handled: 'dropped_undeliverable' });
    }
    // Everything else (D1 blip, unexpected throw) is worth retrying, and every
    // handler is idempotent, so a redelivery is safe.
    console.error('webhook handler failed', update.update_id, e);
    return new Response('error', { status: 500 });
  }
}

/** Bot API failures that will never succeed on retry. */
const DEAD_CHAT = /chat not found|user was blocked|bot was kicked|USER_DEACTIVATED|BOT_BLOCKED|PEER_ID_INVALID|chat_id is empty|not enough rights/i;

export async function GET(): Promise<Response> {
  return Response.json({
    ok: true,
    hint: 'Webhook receiver. Register it with: npm run telegram:webhook',
  });
}
