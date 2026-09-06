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
import { esc } from './api.ts';
import type { InlineQuery, InlineQueryResult, TelegramBot } from './api.ts';
import type { PrivateTableSummary } from '../db/privateTables.ts';
import { listShareableTables } from '../db/privateTables.ts';
import { miniAppLink, webAppUrl } from '../config.ts';
import type { AppConfig } from '../config.ts';
import type { WebhookOutcome } from './webhook.ts';

/** Telegram caps a result title at 64 chars and a description at 512. */
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

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

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
      title: clip(`${t.name}${t.role === 'owner' ? ' · yours' : ''}`, TITLE_MAX),
      description: clip(`${stakes(t)} · ${open} ${seatWord} open`, DESC_MAX),
      input_message_content: {
        message_text: [
          `🃏 <b>${esc(t.name)}</b>`,
          `Private blackjack table · ${esc(stakes(t))}`,
          open > 0 ? `${open} ${seatWord} open — tap Join to take one.` : 'Currently full. Tap to watch the felt.',
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

  // An empty result list renders as a blank picker with no explanation, which reads
  // as "inline mode is broken" - the exact misdiagnosis worth avoiding here.
  return [
    {
      type: 'article',
      id: 'help-none',
      title: args.createUrl ? 'Create a private table first' : 'No private tables to share',
      description: args.createUrl
        ? 'Open the app and create a table, then come back here to post its Join button.'
        : 'Use /newtable in DMs to create a private table, then mention @JackedBot here.',
      input_message_content: {
        message_text: '🃏 No private table to share yet — use /newtable to open one.',
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
      ...(args.createUrl
        ? { reply_markup: { inline_keyboard: [[{ text: 'Open JackedBot to create one', url: link('/') }]] } }
        : {}),
    },
  ];
}
