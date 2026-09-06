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
import { TelegramBot, type Update } from '../../../lib/telegram/api.ts';
import { alreadySeen, configFor, routeUpdate } from '../../../lib/telegram/webhook.ts';
import { rateLimitOr429, SlidingWindowRateLimiter } from '../../../lib/ratelimit.ts';
import { clientIp } from '../../../lib/auth.ts';

export const prerender = false;

// Generous: a busy table generates bursts of pre-checkout + payment + command
// updates, and dropping a payment update is far worse than allowing a spike.
const perIp = new SlidingWindowRateLimiter(200, 10_000, 20_000);

export async function POST(request: Request, context: { locals: { cfContext: ExecutionContext } }): Promise<Response> {
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
    const result = await routeUpdate(update, { env, cfg, bot, ctx });
    return Response.json({ ok: true, handled: result.handled });
  } catch (e) {
    // 5xx makes Telegram retry the update, which is what we want for a transient
    // D1 hiccup. Every handler is idempotent, so a retry is safe.
    console.error('webhook handler failed', update.update_id, e);
    return new Response('error', { status: 500 });
  }
}

export async function GET(): Promise<Response> {
  return Response.json({
    ok: true,
    hint: 'Webhook receiver. Register it with: npm run telegram:webhook',
  });
}
