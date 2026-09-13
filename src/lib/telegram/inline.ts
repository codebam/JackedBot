// =============================================================================
// Inline mode: turn `@JackedBot` in a group chat into a picker of the private
// tables that specific player may share.
//
// Two rules the whole module is built around:
//
//  1. The results are computed from the *querying user's* memberships. Telegram
//     hands us `inline_query.from.id`, and nothing else, so a table can only ever
//     appear for someone already enrolled in it. Combined with `is_personal` in
//     api.ts, a stranger's picker cannot surface someone's game night.
//  2. The posted message carries a `url` button holding a t.me/<bot>?startapp= deep
//    link. NOT a web_app button: Telegram rejects that type on inline results.
//     `t.me/<bot>?app=` share form is rejected there with BUTTON_URL_INVALID, which
//     is the bug that took out /start and /balance in production - and in inline
//     mode the rejection would be invisible, showing as an empty picker.
// =============================================================================
import { formatCents } from '../../shared/money.ts';
import { clipText, esc } from './api.ts';
import type { InlineKeyboardMarkup, InlineQuery, InlineQueryResult, TelegramBot } from './api.ts';
import type { PrivateTableSummary } from '../db/privateTables.ts';
import { listShareableTables } from '../db/privateTables.ts';
import { miniAppLink, webAppUrl } from '../config.ts';
import type { AppConfig } from '../config.ts';
import type { WebhookOutcome } from './webhook.ts';

/**
 * Telegram caps a result title at 64 and a description at 512. `clipText` counts
 * bytes and cuts on a code-point boundary, where the old `String.slice` counted
 * UTF-16 units: clipping an emoji table name at the cap left a lone surrogate
 * behind, which JSON-encodes to an unpaired `\udXXX` — and one malformed field makes
 * answerInlineQuery reject the whole batch, which the client shows as "No results".
 */
const TITLE_MAX = 64;
const DESC_MAX = 512;

export interface InlineArgs {
  /** Raw `query` from the inline query: whatever was typed after the @mention. */
  query: string;
  tables: PrivateTableSummary[];
  /** Absolute https Mini App URL for a path. Injected so tests need no config. */
  appUrl: (path: string) => string;
  /**
   * t.me/<bot>?startapp=<param> form. REQUIRED on inline results: Telegram rejects
   * `web_app` buttons in an inline result's reply_markup with BUTTON_TYPE_INVALID,
   * and one bad button discards the whole batch, which the client shows as a bare
   * "No results". web_app is only legal in messages the bot itself sends.
   */
  deepLink?: (path: string) => string;
  /** Link to offer when the player has nothing to share. Optional. */
  createUrl?: string;
}

function stakes(t: PrivateTableSummary): string {
  const seatFloor = t.minBetCents === t.buyInCents ? '' : ` · buy-in ${formatCents(t.buyInCents)}`;
  return `${formatCents(t.minBetCents)}–${formatCents(t.maxBetCents)} blinds${seatFloor} · ${t.activeSeats}/${t.seatCount} seated`;
}

/**
 * Answer one inline query.
 *
 * No `ensureUser` here on purpose. An inline ping is not consent to be onboarded:
 * it does not pass the age gate and carries no bankroll, so creating rows from it
 * would let a group mention manufacture accounts. Someone who has never opened the
 * app simply has no memberships, and sees the "create a table first" row.
 *
 * Every path must answer. An unanswered inline query shows the player a permanent
 * "bot returned no results" spinner, which is indistinguishable from inline mode
 * being off - so the catch block degrades to the help row rather than throwing.
 */
export async function handleInlineQuery(
  query: InlineQuery,
  deps: { env: Env; cfg: AppConfig; bot: TelegramBot },
): Promise<WebhookOutcome> {
  const { env, cfg, bot } = deps;
  const userId = query.from?.id;

  let results: InlineQueryResult[];
  try {
    const tables = userId ? await listShareableTables(env.DB, userId) : [];
    results = buildInlineResults({
      query: query.query ?? '',
      tables,
      appUrl: (path) => webAppUrl(cfg, path),
      deepLink: (path) => miniAppLink(cfg, path),
      createUrl: cfg.botUsername ? webAppUrl(cfg, '/new-table') : undefined,
    });
  } catch (e) {
    console.error('inline query failed', (e as Error).message);
    results = buildInlineResults({ query: '', tables: [], appUrl: (path) => webAppUrl(cfg, path), deepLink: (path) => miniAppLink(cfg, path) });
  }

  try {
    await bot.answerInlineQuery(query.id, results);
  } catch (e) {
    // A rejected answer cannot be retried inside this update's window, and must not
    // make the webhook 500 - that would redeliver the same dead query forever.
    console.error('answerInlineQuery rejected', (e as Error).message);
    return { handled: 'inline_query_failed', detail: (e as Error).message.slice(0, 120) };
  }
  return { handled: 'inline_query', detail: `${results.length} result(s) for ${query.chat_type ?? 'sender'}` };
}

/**
 * Filter by the typed text and build the picker.
 *
 * Matching is on the table name only, never the slug: an owner searching "bravo"
 * should find their table, but a player typing a fragment of a slug they half-
 * remember must not get a private table listed back to them that they are not in.
 * (Membership is already enforced by the caller's input, so this is about not
 * teaching anyone that slugs are a usable lookup key.)
 */
export function buildInlineResults(args: InlineArgs): InlineQueryResult[] {
  const link = args.deepLink ?? args.appUrl; // a bare https url is still a legal url button
  const needle = args.query.trim().toLowerCase();
  const matched = args.tables.filter((t) => !needle || t.name.toLowerCase().includes(needle) || stakes(t).toLowerCase().includes(needle));

  const results: InlineQueryResult[] = matched.slice(0, 20).map((t) => {
    const seatWord = t.seatCount - t.activeSeats === 1 ? 'seat' : 'seats';
    const open = Math.max(0, t.seatCount - t.activeSeats);
    return {
      type: 'article',
      // Telegram restricts result ids to [A-Za-z0-9_-], 1-64 bytes. A colon anywhere in ANY
      // result id makes answerInlineQuery reject the WHOLE batch (RESULT_ID_INVALID),
      // which the client shows as a bare "No results" with no hint of the cause.
      id: `t-${t.id}`,
      title: clipText(`${t.name}${t.role === 'owner' ? ' · yours' : ''}`, TITLE_MAX),
      // Framing first: the picker is read by people who have never opened the app,
      // and a description is truncated far earlier than a posted message.
      description: clipText(`Play money · 18+ · ${open} ${seatWord} open · ${stakes(t)}`, DESC_MAX),
      input_message_content: {
        message_text: [
          `🃏 <b>${esc(t.name)}</b>`,
          `Private blackjack table · ${esc(stakes(t))}`,
          open > 0 ? `${open} ${seatWord} open — tap Join to take one.` : 'Currently full. Tap to watch the felt.',
          // The recipient is being invited by a friend, not by us: this line is the
          // only place they are told what the chips are worth before they tap Join.
          `Chips are <b>play money</b> — no cash value, no cashout. 18+ only.`,
        ].join('\n'),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
      reply_markup: {
        inline_keyboard: [[{ text: open > 0 ? 'Join table' : 'View table', url: link(`/table/${t.id}?invite=1`) }]],
      },
    };
  });

  if (results.length) return results;

  return noMatchRow(args, link);
}

/**
 * The single row that replaces an empty picker.
 *
 * An empty result list renders as a blank picker with no explanation, which reads as
 * "inline mode is broken" - the exact misdiagnosis worth avoiding here. "Nothing
 * matched what you typed" and "you have no tables" are different facts with
 * different remedies, and telling a table owner they have no tables is worse than
 * saying nothing.
 */
function noMatchRow(args: InlineArgs, link: (path: string) => string): InlineQueryResult[] {
  const article = (title: string, description: string, messageText: string, markup?: InlineKeyboardMarkup): InlineQueryResult[] => [
    {
      type: 'article',
      id: 'help-none',
      title,
      description: clipText(description, DESC_MAX),
      input_message_content: { message_text: messageText, parse_mode: 'HTML', disable_web_page_preview: true },
      ...(markup ? { reply_markup: markup } : {}),
    },
  ];

  if (args.tables.length) {
    return article('No table matches that', `Clear the text after @JackedBot to see your ${args.tables.length} private ${args.tables.length === 1 ? 'table' : 'tables'}.`, '🃏 No private table matches that search.');
  }

  // `startapp` has no scheme for /new-table (src/shared/deeplink.ts routes only
  // `t_<table id>` and `h`), so this button opens the app home, where New table
  // lives. The label says "open", not "go to the create screen", because that is
  // what it does - and a web_app button is not legal on an inline result at all.
  return article(
    args.createUrl ? 'Create a private table first' : 'No private tables to share',
    args.createUrl
      ? 'Open JackedBot, tap New table, then come back here to post its Join button.'
      : 'Send /newtable to @JackedBot in DMs to create a private table, then mention it here.',
    '🃏 No private table to share yet — send /newtable to the bot in DMs to open one.',
    args.createUrl ? { inline_keyboard: [[{ text: 'Open JackedBot to create one', url: link('/') }]] } : undefined,
  );
}
