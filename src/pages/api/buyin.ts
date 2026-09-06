// POST /api/buyin — in-app buy-in: mint a Telegram Stars invoice link.
//
// The island feeds the returned link to `Telegram.WebApp.openInvoice(link)`, which
// raises the native Stars sheet without leaving the mini app. Telegram then drives
// the normal pre_checkout_query -> successful_payment webhook pair, and the credit
// happens there (idempotently, keyed on telegram_payment_charge_id) — never here.
//
// UNIT NOTE — the spec said `amount: 100` for 1 Star. That is wrong for XTR and
// would overcharge every player 100-fold. Telegram's digital-goods docs state the
// invoice amount is "expressed in Telegram Stars", and Stars have no minor unit:
//   amount: 1  ==  one Star
//   amount: 5  ==  five Stars
// so `total_amount` on the way back in *is* a Star count, which is exactly how
// webhook.ts converts it (stars * centsPerStar).
import { env } from 'cloudflare:workers';
import { AuthError, requireUser } from '../../lib/auth.ts';
import { authResponse, err, ok, readJson } from '../../lib/http.ts';
import { TelegramBot } from '../../lib/telegram/api.ts';
import { formatCents } from '../../shared/money.ts';
import { rateLimitOr429, SlidingWindowRateLimiter } from '../../lib/ratelimit.ts';
import { clientIp } from '../../lib/auth.ts';
import { logAdminAction } from '../../lib/db/payments.ts';
import type { APIContext } from 'astro';

export const prerender = false;

// Invoice minting is cheap but abusive in volume: 6 per minute per account.
const limiter = new SlidingWindowRateLimiter(6, 60_000, 10_000);

const MAX_STARS_PER_INVOICE = 50;

export async function POST(context: APIContext): Promise<Response> {
  const { request } = context;
  let auth;
  try {
    // Fresh credentials only: we are about to open a real-money payment sheet.
    auth = await requireUser(request, env as unknown as Env, { maxAgeSeconds: 900 });
  } catch (e) {
    if (e instanceof AuthError) return e.toResponse();
    return authResponse(e);
  }

  const userId = auth.user.telegram_user_id;
  const gate = rateLimitOr429(limiter.check(`buyin:${userId}`), 'Too many purchase attempts. Wait a minute.');
  if (gate) return gate;

  const body = await readJson<{ stars?: unknown }>(request);
  const requested = Number(body?.stars ?? auth.cfg.buyIn.stars);
  const stars = Number.isInteger(requested) ? requested : 0;
  if (stars < 1 || stars > MAX_STARS_PER_INVOICE) {
    return err('BAD_AMOUNT', `Choose between 1 and ${MAX_STARS_PER_INVOICE} Stars.`, 400);
  }

  if (!auth.user.age_accepted_at) return err('AGE_GATE_REQUIRED', 'Confirm you are 18 or over first.', 428);

  const cents = stars * auth.cfg.centsPerStar;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  // payload carries the payer id, which the webhook re-checks against `from.id`.
  const payload = `buyin:${userId}:${nonce}`;

  const bot = new TelegramBot(auth.cfg.botToken);
  let link: string;
  try {
    link = await bot.createInvoiceLinkStars({
      title: auth.cfg.buyIn.label,
      // Name the delivered value in dollars so the sheet can't mislead anyone
      // about what they are buying.
      description: `${auth.cfg.buyIn.description} — ${formatCents(cents)} of chips for ${stars} ⭐`,
      payload,
      stars,
    });
  } catch (e) {
    console.error('createInvoiceLink failed', e);
    await logAdminAction(env.DB, userId, 'buyin_link_failed', payload, { error: (e as Error).message }, 'failed');
    return err('INVOICE_FAILED', 'Could not open a payment sheet. Try again shortly.', 502);
  }

  return ok({
    link,
    stars,
    cents,
    centsLabel: formatCents(cents),
    payload,
    // Rendered verbatim by the UI: the purchase must never look like a deposit.
    disclaimer: 'Play money only. These chips cannot be converted back into Stars, TON or cash.',
  });
}
