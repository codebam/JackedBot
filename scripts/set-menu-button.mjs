#!/usr/bin/env node
// Point the bot's in-chat MENU BUTTON at the Mini App — this is what makes
// "▶ Play" open your workers.dev URL inside Telegram.
//
//   node scripts/set-menu-button.mjs --origin https://jackedbot.<sub>.workers.dev
//   node scripts/set-menu-button.mjs --origin ... --path /lobby --text "🃏 Play"
//   node scripts/set-menu-button.mjs --check
//   node scripts/set-menu-button.mjs --reset     # back to the default button
//
// Two places a Mini App URL can live, and this script covers both:
//   1. the bot menu button (setChatMenuButton)          <- here
//   2. BotFather -> /newapp or /menu_text               <- manual, one time
// A Mini App must be served over HTTPS on a real host; workers.dev qualifies,
// but Telegram requires the domain to be *verified* in BotFather if you want the
// https://<sub>.workers.dev host rather than a t.me/<bot>/<app> short link.
import { flag, getVar, hasFlag, normalizeOrigin, requireVar, resolveOrigin, tgCall } from './_env.mjs';

const token = requireVar('TELEGRAM_BOT_TOKEN', 'From @BotFather.');

if (hasFlag('check')) {
  const r = await tgCall(token, 'getChatMenuButton', {});
  console.log('default menu button:', JSON.stringify(r, null, 2));
  process.exit(0);
}

if (hasFlag('reset')) {
  await tgCall(token, 'setChatMenuButton', { menu_button: { type: 'default' } });
  console.log('Menu button reset to default.');
  process.exit(0);
}

const origin = normalizeOrigin(resolveOrigin() ?? '');
if (!origin) {
  console.error(
    [
      `I need the deployment origin, e.g.`,
      ``,
      `  node scripts/set-menu-button.mjs --origin https://jackedbot.<your-subdomain>.workers.dev`,
      ``,
      `Or set PUBLIC_ORIGIN in wrangler.toml / .dev.vars and re-run.`,
    ].join('\n'),
  );
  process.exit(2);
}

const path = getVar('MINI_APP_PATH') || flag('path') || '/';
const url = `${origin}${path.startsWith('/') ? path : `/${path}`}`;
const text = (flag('text') || getVar('MENU_BUTTON_TEXT') || '🃏 Play Blackjack').slice(0, 38);
const chatId = flag('chat');

const me = await tgCall(token, 'getMe');
console.log(`bot   : @${me.username}`);
console.log(`button: "${text}" -> ${url}${chatId ? ` (chat ${chatId})` : ' (default, all chats)'}`);

await tgCall(token, 'setChatMenuButton', {
  ...(chatId ? { chat_id: Number(chatId) } : {}),
  menu_button: { type: 'web_app', text, web_app: { url } },
});

// The command menu is a separate thing from the button; set both so /start,
// /balance etc. show up as tap-to-run entries.
await tgCall(token, 'setMyCommands', {
  commands: [
    { command: 'start', description: 'Open the table lobby' },
    { command: 'balance', description: 'Show your play-money bankroll' },
    { command: 'help', description: 'Rules, payouts and how chips work' },
    { command: 'buy', description: 'Buy chips with Telegram Stars' },
    { command: 'history', description: 'Your last hands' },
    { command: 'tables', description: 'List open tables' },
  ],
  scope: { type: 'default' },
});

console.log(
  [
    `\n✅ Menu button and command list registered.`,
    ``,
    `If the button opens a browser instead of the in-app webview:`,
    `  • the URL must be https (workers.dev is),`,
    `  • and Telegram must know the host as a Mini App: BotFather -> /mybots ->`,
    `    Bot Settings -> Menu Button -> Configure menu button (or /newapp), pointing`,
    `    at this same URL. BotFather writes the entry that the client trusts.`,
  ].join('\n'),
);
