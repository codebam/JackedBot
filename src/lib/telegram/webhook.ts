// =============================================================================
// Telegram update router — the webhook entry point.
//
// Ordering rules that matter:
//   * `pre_checkout_query` is answered FIRST and awaited, because Telegram
//     retransmits it if the bot is silent for 10 s. Everything else in the same
//     update is done after the answer is on the wire.
//   * `successful_payment` credits chips through `creditBuyIn()`, whose ledger
//     claim is keyed on `telegram_payment_charge_id`. Telegram *will* redeliver
//     this update; the credit must not run twice.
//   * Non-critical work (messages, stats) goes through `ctx.waitUntil` so the
//     webhook ACK stays fast and Telegram does not back off.
// =============================================================================
import { formatCents } from '../../shared/money.ts';
import { getConfig, type AppConfig } from '../config.ts';
import { creditBuyIn } from '../db/payments.ts';
import { getUser } from '../db/users.ts';
import { TelegramApiError, type PreCheckoutQuery, type TelegramBot, type Update } from './api.ts';
import { BOT_COMMANDS, cmdBalance, cmdBuy, cmdHelp, cmdHistory, cmdNewTable, cmdRefund, cmdStart, cmdTables, handleCallback } from './commands.ts';
import { handleInlineQuery } from './inline.ts';
import type { TelegramWebAppUser } from './initData.ts';

export interface WebhookDeps {
  env: Env;
  cfg: AppConfig;
  bot: TelegramBot;
  ctx: ExecutionContext;
}

export type WebhookOutcome = { handled: string; detail?: string };

/** Invoice payload: `buyin:<user_id>:<nonce>`. */
interface ParsedPayload {
  kind: 'buyin';
  userId: number;
  nonce: string;
}

export function parsePayload(payload: string): ParsedPayload | null {
  const parts = payload.split(':');
  if (parts.length !== 3 || parts[0] !== 'buyin') return null;
  const userId = Number(parts[1]);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  if (!parts[2] || parts[2].length > 40) return null;
  return { kind: 'buyin', userId, nonce: parts[2] };
}

export async function routeUpdate(update: Update, deps: WebhookDeps): Promise<WebhookOutcome> {
  const { bot, cfg, ctx } = deps;

  // ------------------------------------------------------------------ payment
  if (update.pre_checkout_query) {
    return handlePreCheckout(update.pre_checkout_query, deps);
  }

  const message = update.message ?? update.edited_message;

  if (message?.successful_payment) {
    const payment = message.successful_payment;
    const from = message.from;
    if (!from) return { handled: 'successful_payment', detail: 'no sender' };

    const parsed = parsePayload(payment.invoice_payload);
    const stars = payment.currency === 'XTR' ? payment.total_amount : 0;

    if (!parsed || parsed.userId !== from.id) {
      // Payload does not match the payer: never credit on a mismatch.
      console.error(`payload mismatch charge=${payment.telegram_payment_charge_id} from=${from.id} payload=${payment.invoice_payload}`);
      ctx.waitUntil(
        bot.sendMessage(from.id, `We could not attach that payment to your account. Contact support and quote <code>${payment.telegram_payment_charge_id}</code>.`).catch(() => undefined),
      );
      return { handled: 'successful_payment', detail: 'payload_mismatch' };
    }
    if (payment.currency !== 'XTR') {
      console.error(`unexpected currency ${payment.currency} on charge ${payment.telegram_payment_charge_id}`);
      return { handled: 'successful_payment', detail: 'bad_currency' };
    }
    if (stars <= 0) return { handled: 'successful_payment', detail: 'zero_amount' };

    const cents = stars * cfg.centsPerStar;
    const result = await creditBuyIn(deps.env.DB, {
      chargeId: payment.telegram_payment_charge_id,
      userId: parsed.userId,
      stars,
      cents,
      payload: payment.invoice_payload,
      chatId: message.chat.id,
      messageId: message.message_id,
      isTest: Boolean((message as { is_test?: boolean }).is_test),
      allowTest: cfg.allowTestPayments,
    });

    if (!result.ok) {
      console.error('creditBuyIn failed', payment.telegram_payment_charge_id, result.error);
      return { handled: 'successful_payment', detail: `error:${result.error}` };
    }
    if (!('credited' in result) || !result.credited) {
      return { handled: 'successful_payment', detail: 'test_payment_blocked' };
    }

    ctx.waitUntil(
      bot
        .sendMessage(
          from.id,
          result.alreadyCredited
            ? `✅ That purchase was already credited — no double credit. Balance <b>${formatCents(result.bankrollCents)}</b>.`
            : `✅ <b>${formatCents(cents)}</b> in play money added (${stars} ⭐). Balance <b>${formatCents(result.bankrollCents)}</b>.\n\n${cfg.houseWarning}`,
        )
        .catch((e) => console.warn('post-credit message failed', (e as Error).message)),
    );
    return { handled: 'successful_payment', detail: result.alreadyCredited ? 'duplicate' : 'credited' };
  }

  if (message?.refunded_payment) {
    // Telegram also tells us when the *provider* refunded (chargeback / support).
    // We cannot claw back from here without the charge id being ours, so log it
    // loudly and let the operator run /refund — never silently keep chips minted
    // by money that has left the account.
    const chargeId = (message.refunded_payment as { telegram_payment_charge_id?: string }).telegram_payment_charge_id ?? '';
    console.warn(`EXTERNAL refund detected for charge ${chargeId} — run /refund ${chargeId} to claw back chips`);
    return { handled: 'refunded_payment', detail: chargeId };
  }

  // ------------------------------------------------------------------ commands
  if (message?.text && message.from && message.chat?.type === 'private') {
    const user = toTgUser(message.from);
    const [rawCmd, ...rest] = message.text.trim().split(/\s+/);
    const cmd = ((rawCmd ?? '').toLowerCase()).split('@')[0] ?? '';
    const arg = rest.join(' ');

    const common = { env: deps.env, cfg, bot, message, user };
    switch (cmd) {
      case '/start':
        await cmdStart(common);
        return { handled: '/start' };
      case '/help':
        await cmdHelp(common);
        return { handled: '/help' };
      case '/balance':
        await cmdBalance(common);
        return { handled: '/balance' };
      case '/buy':
      case '/topup':
      case '/rebuy':
        await cmdBuy(common);
        return { handled: '/buy' };
      case '/history':
        await cmdHistory(common);
        return { handled: '/history' };
      case '/tables':
        await cmdTables(common);
        return { handled: '/tables' };
      case '/refund':
        await cmdRefund(common, arg);
        return { handled: '/refund' };
      case '/newtable':
        await cmdNewTable(common);
        return { handled: '/newtable' };
      case '/commands':
        await bot.setMyCommands([...BOT_COMMANDS]);
        await bot.sendMessage(message.chat.id, 'Command list re-registered with Telegram.');
        return { handled: '/commands' };
      default:
        if (cmd.startsWith('/')) {
          await bot.sendMessage(message.chat.id, `Unknown command. Try /start, /balance or /help.`);
          return { handled: 'unknown_command', detail: cmd };
        }
        // Free text: nudge toward the app instead of ignoring the player.
        await cmdStart(common);
        return { handled: 'free_text' };
    }
  }

  // ------------------------------------------------------------------- inline
  // `@JackedBot` typed in any chat. Must be answered or the player stares at a
  // spinner, and requires `inline_query` in allowed_updates to arrive at all.
  if (update.inline_query) {
    return handleInlineQuery(update.inline_query, { env: deps.env, cfg, bot });
  }

  // ------------------------------------------------------------------ callback
  if (update.callback_query) {
    await handleCallback({ env: deps.env, cfg, bot, query: update.callback_query });
    return { handled: 'callback_query', detail: update.callback_query.data ?? '' };
  }

  return { handled: 'ignored' };
}

/**
 * Validate + approve the checkout. Runs *before* any chip movement: at this point
 * no money has moved, so the only job is to refuse an obviously bad charge and to
 * answer fast enough that Telegram completes the payment.
 */
async function handlePreCheckout(q: PreCheckoutQuery, deps: WebhookDeps): Promise<WebhookOutcome> {
  const { bot, cfg, env } = deps;
  const parsed = parsePayload(q.invoice_payload);
  const chargeOk = q.currency === 'XTR' && q.total_amount > 0;
  const expected = q.total_amount * cfg.centsPerStar;

  let decline: string | undefined;
  if (!parsed) decline = 'This purchase link is no longer valid. Open /buy again.';
  else if (parsed.userId !== q.from.id) decline = 'This purchase was made by a different account.';
  else if (!chargeOk) decline = 'That payment cannot be processed here.';
  else {
    const user = await getUser(env.DB, q.from.id);
    if (user?.banned_at) decline = 'This account cannot make purchases.';
  }

  // Answer first, log second: the 10 s budget is the binding constraint.
  try {
    await bot.answerPreCheckoutQuery(q.id, !decline, decline);
  } catch (e) {
    if (e instanceof TelegramApiError && /query is too old/i.test(e.description)) {
      return { handled: 'pre_checkout_query', detail: 'too_old' };
    }
    throw e;
  }

  if (decline) {
    console.warn(`pre_checkout declined user=${q.from.id} reason="${decline}"`);
    return { handled: 'pre_checkout_query', detail: 'declined' };
  }

  console.log(`pre_checkout ok user=${q.from.id} stars=${q.total_amount} -> ${formatCents(expected)} play money`);
  return { handled: 'pre_checkout_query', detail: 'ok' };
}

function toTgUser(u: { id: number; first_name: string; last_name?: string; username?: string; language_code?: string }): TelegramWebAppUser {
  return { id: u.id, first_name: u.first_name, last_name: u.last_name, username: u.username, language_code: u.language_code };
}

/** update_id de-duplication, ahead of the payment-level idempotency. */
export async function alreadySeen(db: D1Database, updateId: number): Promise<boolean> {
  const res = await db.prepare(`INSERT OR IGNORE INTO seen_updates (update_id) VALUES (?1)`).bind(updateId).run();
  const changes = (res as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  return changes === 0;
}

export function configFor(env: Env, requestUrl?: string): AppConfig {
  return getConfig(env, requestUrl);
}
