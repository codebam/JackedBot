// =============================================================================
// Bot commands and inline-keyboard callbacks: /start /help /balance /buy
// /history, plus the operator commands /refund and /tables.
//
// Every reply states that chips are play money. The free stack is announced
// explicitly so nobody mistakes it for a purchase they made.
// =============================================================================
import { formatCents } from '../../shared/money.ts';
import { miniAppLink, type AppConfig } from '../config.ts';
import { getPlayerSummary, listLobbyTables, recentHands } from '../db/tablesRepo.ts';
import { ledgerTail, paymentsForUser, refundAndClawback, recentPayments } from '../db/payments.ts';
import { acceptAgeGate, getUser, hasAcceptedAge, isAdmin } from '../db/users.ts';
import type { TelegramBot, CallbackQuery, InlineKeyboardMarkup, Message } from './api.ts';
import { esc } from './api.ts';
import { AGE_GATE_STATEMENT, bootstrapUser } from './session.ts';
import type { TelegramWebAppUser } from './initData.ts';

export const BOT_COMMANDS = [
  { command: 'start', description: 'Open the table lobby' },
  { command: 'balance', description: 'Show your play-money bankroll' },
  { command: 'help', description: 'Rules, payouts and how chips work' },
  { command: 'buy', description: 'Buy $10 of play money with 1 Star' },
  { command: 'history', description: 'Your last hands' },
  { command: 'tables', description: 'List open tables' },
] as const;

export const ADMIN_COMMANDS = [
  { command: 'refund', description: 'Refund a Star charge and claw back its chips' },
  { command: 'grant', description: 'Admin adjust a bankroll' },
] as const;

export interface CommandContext {
  env: Env;
  cfg: AppConfig;
  bot: TelegramBot;
  message: Message;
  user: TelegramWebAppUser;
}

/** Reply with the Mini App attached, plus an age gate when it is still open. */
export async function cmdStart(c: CommandContext): Promise<void> {
  const boot = await bootstrapUser(c.env, c.cfg, c.user);
  const { user } = boot;

  if (!hasAcceptedAge(user)) {
    await c.bot.sendMessage(
      c.message.chat.id,
      `<b>JackedBot</b> — multiplayer blackjack with <b>play money only</b>.
${esc(c.cfg.houseWarning)}

Before the tables, I need one confirmation.`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: '✔ I am 18+ and this is play money', callback_data: 'age:accept' }]],
        } satisfies InlineKeyboardMarkup,
      },
    );
    return;
  }

  const lines = [
    `<b>Welcome to JackedBot</b> 🃏`,
    ``,
    boot.welcomeGranted
      ? `🎁 Free starter stack: <b>${esc(formatCents(boot.welcomeCents))}</b> in play money — no purchase made.`
      : `💰 Bankroll: <b>${esc(formatCents(boot.bankrollCents))}</b> in play money.`,
    ``,
    `• 1 ⭐ Star = ${esc(formatCents(c.cfg.centsPerStar))} of chips`,
    `• Chips are <b>play money only</b> — never redeemable for Stars, TON or cash`,
    ``,
    `Grab a seat below. Good luck.`,
  ];

  await c.bot.sendMessage(c.message.chat.id, lines.join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🃏 Open the lobby', web_app: { url: miniAppLink(c.cfg, '/lobby') } }],
        [
          { text: '💵 Buy chips', callback_data: 'buyin' },
          { text: 'ℹ️ Rules', callback_data: 'help' },
        ],
      ],
    } satisfies InlineKeyboardMarkup,
  });
}

export async function cmdHelp(c: CommandContext): Promise<void> {
  const r = c.cfg.rules;
  await c.bot.sendMessage(
    c.message.chat.id,
    `<b>How JackedBot works</b>

<b>Table rules</b>
• ${r.decks} decks in the shoe, reshuffled at ~${Math.round(r.penetration * 100)}% penetration
• Blackjack pays <b>3:2</b>, pushes return your wager
• Double on any first two cards, and after a split
• Split once per hand (two independent hands)
• Dealer draws to 16 and stands on all 17s
• No insurance, no surrender

<b>Money</b>
• 1 ⭐ Star = ${esc(formatCents(c.cfg.centsPerStar))} of chips${c.cfg.welcomeGrantCents > 0 ? `
• New accounts get a one-time free ${esc(formatCents(c.cfg.welcomeGrantCents))} stack` : ''}
• <b>Chips are play money.</b> There is no cashout: chips cannot be turned into Stars, TON or currency
• Out of chips? Rebuy — stacks add up across purchases

<b>Commands</b>
/start — open the lobby
/balance — your bankroll
/buy — buy chips with Stars
/history — your recent hands
/tables — list open tables

<b>Age policy</b>
18+ only. ${esc(c.cfg.houseWarning)}`,
    { reply_markup: { inline_keyboard: [[{ text: '🃏 Open the lobby', web_app: { url: miniAppLink(c.cfg, '/lobby') } }]] } },
  );
}

export async function cmdBalance(c: CommandContext): Promise<void> {
  const summary = await getPlayerSummary(c.env.DB, c.user.id);
  const payments = await paymentsForUser(c.env.DB, c.user.id, 3);
  const entries = await ledgerTail(c.env.DB, c.user.id, 6);

  const body = [
    `<b>Bankroll</b>: ${esc(formatCents(summary?.bankroll_cents ?? 0))} <i>(play money)</i>`,
    ``,
    summary
      ? `Hands ${summary.hands_played} · won ${summary.hands_won} · blackjacks ${summary.blackjacks}
Wagered ${esc(formatCents(summary.wagered_cents))} · net ${esc(formatCents(summary.net_cents))}`
      : `No hands played yet.`,
    ``,
    payments.length ? `<b>Stars purchases</b>\n${payments.map((p) => `• ${p.stars_amount}⭐ → ${esc(formatCents(p.cents_credited))} <i>${esc(p.status)}</i>`).join('\n')}` : `<b>Stars purchases</b>: none`,
    entries.length ? `\n<b>Recent chip movement</b>\n${entries.map((e) => `• ${esc(e.reason)} ${e.cents_delta >= 0 ? '+' : ''}${esc(formatCents(e.cents_delta))}`).join('\n')}` : '',
    ``,
    esc(c.cfg.houseWarning),
  ];

  await c.bot.sendMessage(c.message.chat.id, body.join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [{ text: '💵 Buy chips', callback_data: 'buyin' }],
        [{ text: '🃏 Lobby', web_app: { url: miniAppLink(c.cfg, '/lobby') } }],
      ],
    },
  });
}

/** In-chat Stars purchase. The mini app uses /api/buyin + openInvoice instead. */
export async function cmdBuy(c: CommandContext): Promise<void> {
  const { user } = await bootstrapUser(c.env, c.cfg, c.user);
  const nonce = Math.random().toString(36).slice(2, 10);
  const payload = `buyin:${user.telegram_user_id}:${nonce}`;

  await c.bot.sendInvoiceStars(c.message.chat.id, {
    title: c.cfg.buyIn.label,
    description: c.cfg.buyIn.description,
    payload,
    stars: c.cfg.buyIn.stars,
    startParameter: `buy${nonce}`,
  });
}

export async function cmdHistory(c: CommandContext): Promise<void> {
  const hands = await recentHands(c.env.DB, c.user.id, 10);
  if (!hands.length) {
    await c.bot.sendMessage(c.message.chat.id, `No hands recorded yet. /start to take a seat.`);
    return;
  }
  const lines = hands.map((h) => {
    const net = h.payout_cents - h.bet_cents;
    return `• <b>${esc(h.outcome)}</b> ${net >= 0 ? '+' : ''}${esc(formatCents(net))} — ${esc(h.cards.join(' '))} bet ${esc(formatCents(h.bet_cents))}`;
  });
  await c.bot.sendMessage(c.message.chat.id, `<b>Last ${hands.length} hands</b>\n${lines.join('\n')}\n\n<i>${esc(c.cfg.houseWarning)}</i>`);
}

export async function cmdTables(c: CommandContext): Promise<void> {
  await bootstrapUser(c.env, c.cfg, c.user);
  const tables = await listLobbyTables(c.env.DB);
  if (!tables.length) {
    await c.bot.sendMessage(c.message.chat.id, `No tables are open right now. Try /start in a moment.`);
    return;
  }
  const rows = tables.map((t) => {
    const stakes = `${formatCents(t.minBetCents)}–${formatCents(t.maxBetCents)}`;
    return { text: `${t.name} · ${t.activeSeats}/${t.seatCount} seats · ${stakes}`, web_app: { url: miniAppLink(c.cfg, `/table/${t.id}`) } };
  });
  await c.bot.sendMessage(c.message.chat.id, `<b>Open tables</b>\nPlay money only — ${esc(formatCents(c.cfg.rules.starsToCentsPerStar))} per Star.`, {
    reply_markup: { inline_keyboard: rows.map((r) => [r]) },
  });
}

// ---------------------------------------------------------------------------
// operator
// ---------------------------------------------------------------------------
export async function cmdRefund(c: CommandContext, arg: string): Promise<void> {
  if (!isAdmin(await getUser(c.env.DB, c.user.id), c.cfg.adminIds, c.user.id)) {
    await c.bot.sendMessage(c.message.chat.id, 'Not authorised.');
    return;
  }
  const chargeId = arg.trim();
  if (!chargeId) {
    const recent = await recentPayments(c.env.DB, 8);
    await c.bot.sendMessage(
      c.message.chat.id,
      `Usage: /refund &lt;telegram_payment_charge_id&gt;\n\n<b>Recent charges</b>\n${recent
        .map((p) => `• <code>${esc(p.telegram_payment_charge_id)}</code> ${p.user_id} ${p.stars_amount}⭐ ${esc(p.status)}`)
        .join('\n')}`,
    );
    return;
  }
  const result = await refundAndClawback(c.env.DB, c.bot, chargeId, c.user.id);
  await c.bot.sendMessage(
    c.message.chat.id,
    [
      `<b>refundStarPayment</b> ${result.status}`,
      `charge: <code>${esc(chargeId)}</code>`,
      `stars returned: ${result.starsRefunded}`,
      `chips removed: ${esc(formatCents(result.centsRemoved))}`,
      `unreached: ${esc(formatCents(result.shortfallCents))} <i>(already played, or the protected welcome stack)</i>`,
      result.bankrollCents !== null ? `bankroll now: ${esc(formatCents(result.bankrollCents))}` : '',
      result.message ? `<code>${esc(result.message)}</code>` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

// ---------------------------------------------------------------------------
// callbacks
// ---------------------------------------------------------------------------
export async function handleCallback(c: { env: Env; cfg: AppConfig; bot: TelegramBot; query: CallbackQuery }): Promise<void> {
  const data = c.query.data ?? '';
  const chatId = c.query.message?.chat.id ?? c.query.from.id;
  const user: TelegramWebAppUser = {
    id: c.query.from.id,
    first_name: c.query.from.first_name,
    last_name: c.query.from.last_name,
    username: c.query.from.username,
    language_code: c.query.from.language_code,
  };

  if (data === 'age:accept') {
    await bootstrapUser(c.env, c.cfg, user);
    await acceptAgeGate(c.env.DB, user.id, AGE_GATE_STATEMENT);
    await c.bot.answerCallbackQuery(c.query.id, 'Confirmed — welcome aboard.');
    if (!c.query.message) return;
    await cmdStart({ env: c.env, cfg: c.cfg, bot: c.bot, message: c.query.message, user });
    return;
  }

  if (data === 'help') {
    await c.bot.answerCallbackQuery(c.query.id);
    if (!c.query.message) return;
    await cmdHelp({ env: c.env, cfg: c.cfg, bot: c.bot, message: c.query.message, user });
    return;
  }

  if (data === 'buyin') {
    await c.bot.answerCallbackQuery(c.query.id);
    await cmdBuy({ env: c.env, cfg: c.cfg, bot: c.bot, message: c.query.message!, user });
    return;
  }

  await c.bot.answerCallbackQuery(c.query.id, 'Unknown button.');
}
