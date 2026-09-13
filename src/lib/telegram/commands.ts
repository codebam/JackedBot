// =============================================================================
// Bot commands and inline-keyboard callbacks: /start /help /balance /buy
// /history, plus the operator commands /refund and /tables.
//
// Every reply states that chips are play money. The free stack is announced
// explicitly so nobody mistakes it for a purchase they made.
// =============================================================================
import { formatCents, formatDelta } from '../../shared/money.ts';
import { cardLabel } from '../../game/cards.ts';
import { webAppUrl, type AppConfig } from '../config.ts';
import { getPlayerSummary, listLobbyTables, recentHands } from '../db/tablesRepo.ts';
import { ledgerTail, paymentsForUser, refundAndClawback, recentPayments } from '../db/payments.ts';
import { BUST_RELIEF_REF_ID } from '../db/relief.ts';
import { acceptAgeGate, getUser, hasAcceptedAge, isAdmin } from '../db/users.ts';
import type { TelegramBot, CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message } from './api.ts';
import { clipText, esc } from './api.ts';
import { AGE_GATE_STATEMENT, bootstrapUser, type BootstrapResult } from './session.ts';
import type { TelegramWebAppUser } from './initData.ts';

/**
 * Ledger `reason` is a machine enum. Printed raw, the automatic bust top-up reads as
 * "an admin handed out money" - which is what `admin_adjust` says, and is not what
 * happened. `ref_id` is the field that tells the two apart, which is exactly why
 * relief journals there instead of needing a new reason value (the column is a CHECK
 * constraint SQLite cannot ALTER).
 */
function ledgerLabel(e: { reason: string; ref_id: string | null }): string {
  if (e.reason === 'admin_adjust') return e.ref_id === BUST_RELIEF_REF_ID ? 'house relief' : 'admin adjust';
  if (e.reason === 'welcome_grant') return 'welcome stack';
  if (e.reason === 'buy_in') return 'Stars purchase';
  return e.reason;
}

/**
 * `round_hands.outcome` and `payments.status` are CHECK-constrained machine enums.
 * Printed raw they read as database columns ("• bust -$10.00", "1⭐ → $10.00
 * pending"), so they get the same treatment `ledgerLabel` gives the ledger's
 * `reason`. An unmapped value is echoed rather than dropped: a new enum member
 * should show up in chat, not vanish.
 */
const HAND_LABELS: Record<string, string> = {
  blackjack: 'Blackjack',
  win: 'Won',
  push: 'Push',
  lose: 'Lost',
  bust: 'Bust',
  surrendered: 'Surrendered',
};

const PAYMENT_LABELS: Record<string, string> = {
  pending: 'not paid',
  credited: 'added',
  refunded: 'refunded',
  refund_failed: 'refund failed',
};

const label = (map: Record<string, string>, value: string): string => map[value] ?? value;

/**
 * Name a free credit when one just landed on this very call.
 *
 * An unexplained balance bump is indistinguishable from a purchase the player does
 * not remember making, which is the confusion this file's header says it exists to
 * prevent. Bust relief was being minted silently: /start just showed "$10.00".
 */
function chipsLine(boot: BootstrapResult): string {
  const bankroll = `💰 Bankroll: <b>${esc(formatCents(boot.bankrollCents))}</b> in play money.`;
  if (boot.welcomeGranted) return `🎁 Free starter stack: <b>${esc(formatCents(boot.welcomeCents))}</b> in play money — no purchase made.`;
  if (boot.reliefGranted) return `🎁 You were at $0.00, so the house credited <b>${esc(formatCents(boot.reliefCents))}</b> in play money — free, not a purchase.\n${bankroll}`;
  return bankroll;
}

/** The same announcement, as a line under an already-printed balance. */
function balanceNote(boot: BootstrapResult): string {
  if (boot.welcomeGranted) return `🎁 Includes your free starter stack of <b>${esc(formatCents(boot.welcomeCents))}</b> — no purchase made.`;
  if (boot.reliefGranted) return `🎁 You were at $0.00, so the house credited <b>${esc(formatCents(boot.reliefCents))}</b>. Free, not a purchase.`;
  return '';
}

/** Telegram allows 1-64 *bytes* of inline button text and 400s the whole message past it. */
const BUTTON_TEXT_BYTES = 64;

function button(text: string, b: Omit<InlineKeyboardButton, 'text'>): InlineKeyboardButton {
  return { text: clipText(text, BUTTON_TEXT_BYTES), ...b };
}

/** The one tap that gets a reader out of the chat and onto the felt. */
const lobbyButton = (cfg: AppConfig): InlineKeyboardButton => button('🃏 Open the lobby', { web_app: { url: webAppUrl(cfg, '/') } });
const buyButton = (): InlineKeyboardButton => button('💵 Buy chips', { callback_data: 'buyin' });

export const BOT_COMMANDS = [
  { command: 'start', description: 'Open the table lobby' },
  { command: 'balance', description: 'Show your play-money bankroll' },
  { command: 'help', description: 'Rules, payouts and how chips work' },
  { command: 'buy', description: 'Buy $10 of play money with 1 Star' },
  { command: 'history', description: 'Your last hands' },
  { command: 'tables', description: 'List open tables' },
  { command: 'newtable', description: 'Create a private table and invite people to it' },
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

/**
 * The 18+ attestation card, shared by `/start` and `/buy`: buying chips with real
 * Stars is the one action in this bot that must never skip the gate, and the
 * mini-app path (`POST /api/buyin`) already refuses it with AGE_GATE_REQUIRED.
 *
 * `acceptData` is what the button reports back, so the handler can resume what the
 * player actually asked for instead of dumping them on /start after a /buy.
 */
async function sendAgeGate(c: CommandContext, lead: string, acceptData = 'age:accept'): Promise<void> {
  await c.bot.sendMessage(
    c.message.chat.id,
    `${lead}
${esc(c.cfg.houseWarning)}

Before we go any further, I need one confirmation.`,
    {
      reply_markup: {
        inline_keyboard: [[button('✔ I am 18+ and this is play money', { callback_data: acceptData })]],
      } satisfies InlineKeyboardMarkup,
    },
  );
}

/** Reply with the Mini App attached, plus an age gate when it is still open. */
export async function cmdStart(c: CommandContext): Promise<void> {
  const boot = await bootstrapUser(c.env, c.cfg, c.user);
  const { user } = boot;

  if (!hasAcceptedAge(user)) {
    await sendAgeGate(c, `<b>JackedBot</b> — multiplayer blackjack with <b>play money only</b>.`);
    return;
  }

  const lines = [
    `<b>Welcome to JackedBot</b> 🃏`,
    ``,
    chipsLine(boot),
    ``,
    `• 1 ⭐ Star = ${esc(formatCents(c.cfg.centsPerStar))} of chips`,
    `• Chips are <b>play money only</b> — never redeemable for Stars, TON or cash`,
    ``,
    `Grab a seat below. Good luck.`,
  ];

  await c.bot.sendMessage(c.message.chat.id, lines.join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [lobbyButton(c.cfg)],
        [buyButton(), button('ℹ️ Rules', { callback_data: 'help' })],
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
• Out of chips? Rebuy — stacks add up across purchases${c.cfg.bustReliefCents > 0 ? `
• Bust to $0.00 and the house credits you ${esc(formatCents(c.cfg.bustReliefCents))} automatically, free, so the felt is never a paywall` : ''}

<b>Commands</b>
/start — open the lobby
/balance — your bankroll
/buy — buy chips with Stars
/history — your recent hands
/tables — list open tables
/newtable — create a private table and invite people to it

<b>Age policy</b>
18+ only. ${esc(c.cfg.houseWarning)}`,
    { reply_markup: { inline_keyboard: [[lobbyButton(c.cfg)]] } },
  );
}

export async function cmdBalance(c: CommandContext): Promise<void> {
  // Bootstrap first, like every other command. /balance is the command a brand-new
  // player is most likely to try, and reading the row before it existed told them
  // "$0.00" while their free starter stack sat un-minted — a dead end that also
  // understated their own balance.
  const boot = await bootstrapUser(c.env, c.cfg, c.user);
  const summary = await getPlayerSummary(c.env.DB, c.user.id);
  const payments = await paymentsForUser(c.env.DB, c.user.id, 3);
  const entries = await ledgerTail(c.env.DB, c.user.id, 6);

  const note = balanceNote(boot);
  const body = [
    `<b>Bankroll</b>: ${esc(formatCents(summary?.bankroll_cents ?? boot.bankrollCents))} <i>(play money)</i>`,
    // Spread, not a placeholder: the `''` entries below are blank lines on purpose,
    // so a filter(Boolean) over the array would collapse the whole message.
    ...(note ? [note] : []),
    ``,
    summary
      ? `Hands ${summary.hands_played} · won ${summary.hands_won} · blackjacks ${summary.blackjacks}
Wagered ${esc(formatCents(summary.wagered_cents))} · net ${esc(formatCents(summary.net_cents))}`
      : `No hands played yet.`,
    ``,
    payments.length ? `<b>Stars purchases</b>\n${payments.map((p) => `• ${p.stars_amount}⭐ → ${esc(formatCents(p.cents_credited))} <i>${esc(label(PAYMENT_LABELS, p.status))}</i>`).join('\n')}` : `<b>Stars purchases</b>: none`,
    entries.length ? `\n<b>Recent chip movement</b>\n${entries.map((e) => `• ${esc(ledgerLabel(e))} ${esc(formatDelta(e.cents_delta))}`).join('\n')}` : '',
    ``,
    esc(c.cfg.houseWarning),
  ];

  await c.bot.sendMessage(c.message.chat.id, body.join('\n'), {
    reply_markup: {
      inline_keyboard: [[buyButton(), button('🃏 Take a seat', { web_app: { url: webAppUrl(c.cfg, '/') } })]],
    },
  });
}

/** In-chat Stars purchase. The mini app uses /api/buyin + openInvoice instead. */
export async function cmdBuy(c: CommandContext): Promise<void> {
  const { user } = await bootstrapUser(c.env, c.cfg, c.user);

  // Real Stars leave a real account here, so the 18+ attestation is not optional.
  if (!hasAcceptedAge(user)) {
    await sendAgeGate(c, `<b>Buying chips</b> costs Telegram Stars, so this is the one thing I gate.`, 'age:accept:buy');
    return;
  }

  const nonce = Math.random().toString(36).slice(2, 10);
  const payload = `buyin:${user.telegram_user_id}:${nonce}`;
  const { stars } = c.cfg.buyIn;

  await c.bot.sendInvoiceStars(c.message.chat.id, {
    title: c.cfg.buyIn.label,
    // The Stars sheet shows the price but never what it buys, and the description
    // used to be a fixed sentence that quietly went wrong the moment
    // STARS_BUY_IN_AMOUNT was not 1. Derive both numbers from the same config the
    // webhook credits from, so what is advertised is what lands.
    description: `${c.cfg.buyIn.description} — ${formatCents(stars * c.cfg.centsPerStar)} of chips for ${stars} ⭐`,
    payload,
    stars,
    startParameter: `buy${nonce}`,
  });
}

export async function cmdHistory(c: CommandContext): Promise<void> {
  const hands = await recentHands(c.env.DB, c.user.id, 10);
  if (!hands.length) {
    await c.bot.sendMessage(c.message.chat.id, `No hands recorded yet — your first one is one tap away.`, {
      reply_markup: { inline_keyboard: [[lobbyButton(c.cfg)]] },
    });
    return;
  }
  // `cards` are shoe positions, not faces: printed raw the line read "• win +$15.00 —
  // 0 39 bet $10.00", which tells a player nothing about the hand they remember.
  const lines = hands.map((h) => {
    const net = h.payout_cents - h.bet_cents;
    return `• <b>${esc(label(HAND_LABELS, h.outcome))}</b> ${esc(formatDelta(net))} — ${esc(h.cards.map(cardLabel).join(' '))} · bet ${esc(formatCents(h.bet_cents))}`;
  });
  await c.bot.sendMessage(c.message.chat.id, `<b>Last ${hands.length} hands</b>\n${lines.join('\n')}\n\n<i>${esc(c.cfg.houseWarning)}</i>`, {
    reply_markup: { inline_keyboard: [[lobbyButton(c.cfg)]] },
  });
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
    return { text: `${t.name} · ${t.activeSeats}/${t.seatCount} seats · ${stakes}`, web_app: { url: webAppUrl(c.cfg, `/table/${t.id}`) } };
  });
  await c.bot.sendMessage(c.message.chat.id, `<b>Open tables</b>\nPlay money only — ${esc(formatCents(c.cfg.rules.starsToCentsPerStar))} per Star.`, {
    reply_markup: { inline_keyboard: rows.map((r) => [r]) },
  });
}

// ---------------------------------------------------------------------------
// private tables
// ---------------------------------------------------------------------------
/**
 * /newtable — the entry point for an invite-only game night.
 *
 * The bot does not create the table itself. "Full control" stakes means six fields
 * with relationships between them, and a chat has no form: the Mini App does. So
 * this message is a door, not a transaction - which also keeps validation in one
 * place (`POST /api/tables`) instead of a second parser here that could drift.
 */
export async function cmdNewTable(c: CommandContext): Promise<void> {
  await bootstrapUser(c.env, c.cfg, c.user);
  await c.bot.sendMessage(
    c.message.chat.id,
    [
      '<b>Create a private table</b>',
      'Pick your own blinds, buy-in and seats. It is unlisted - nobody finds it in the lobby.',
      '',
      'After creating it:',
      '1. Go to your group chat and type <code>@JackedBot</code>',
      '2. Choose the table from the picker',
      '3. Telegram posts a Join button into the chat',
      '',
      'Whoever taps that button can sit. Chips are play money and there is no cashout.',
    ].join('\n'),
    { reply_markup: { inline_keyboard: [[{ text: 'Create private table', web_app: { url: webAppUrl(c.cfg, '/new-table') } }]] } },
  );
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

  if (data === 'age:accept' || data === 'age:accept:buy') {
    await bootstrapUser(c.env, c.cfg, user);
    await acceptAgeGate(c.env.DB, user.id, AGE_GATE_STATEMENT);
    // A callback query id is answerable only briefly and only once; a re-tapped old
// card yields QUERY_ID_INVALID (400). That used to abort the handler *after* the
// age gate was already accepted, so the webhook 500'd and Telegram redelivered a
// no-op forever. The acknowledgement is cosmetic — never let it break the flow.
await safeAnswer(c.bot, c.query.id, 'Confirmed — welcome aboard.');
    if (!c.query.message) return;
    const ctx = { env: c.env, cfg: c.cfg, bot: c.bot, message: c.query.message, user };
    // Resume the action the gate interrupted: /buy must not end at the welcome card.
    if (data === 'age:accept:buy') await cmdBuy(ctx);
    else await cmdStart(ctx);
    return;
  }

  if (data === 'buyin' || data.startsWith('buyin:')) {
    // 'buyin' (no suffix) is what cmdStart/cmdBalance actually render, so this is
    // the only branch that makes the 💵 button work.
    await safeAnswer(c.bot, c.query.id);
    if (!c.query.message) return;
    await cmdBuy({ env: c.env, cfg: c.cfg, bot: c.bot, message: c.query.message, user });
    return;
  }

  if (data === 'help') {
    await safeAnswer(c.bot, c.query.id);
    if (!c.query.message) return;
    await cmdHelp({ env: c.env, cfg: c.cfg, bot: c.bot, message: c.query.message, user });
    return;
  }

  if (data === 'buyin') {
    await safeAnswer(c.bot, c.query.id);
    await cmdBuy({ env: c.env, cfg: c.cfg, bot: c.bot, message: c.query.message!, user });
    return;
  }

  await c.bot.answerCallbackQuery(c.query.id, 'Unknown button.');
}

/** answerCallbackQuery is fire-and-forget by nature: swallow its failures. */
async function safeAnswer(bot: TelegramBot, queryId: string, text?: string): Promise<void> {
  try {
    await bot.answerCallbackQuery(queryId, text);
  } catch (e) {
    console.warn(`answerCallbackQuery failed (query ${queryId}): ${e instanceof Error ? e.message : String(e)}`);
  }
}
