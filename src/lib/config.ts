// =============================================================================
// Typed view over wrangler [vars] + secrets.
//
// Cloudflare delivers every `vars` entry as a **string**, even when it looks like
// a number (see the generated `StringifyValues<...>` in worker-configuration.d.ts).
// Reading `env.DEFAULT_MIN_BET_CENTS` directly as a number is a classic footgun,
// so nothing outside this file touches a raw var.
// =============================================================================
import { RULES } from '../game/rules.ts';

export interface AppConfig {
  isProd: boolean;
  /** Absolute origin, e.g. https://jackedbot.<sub>.workers.dev (no trailing /). */
  origin: string;
  botUsername: string;
  botToken: string;
  appSecret: string;
  webhookSecret: string;
  adminIds: number[];
  allowTestPayments: boolean;

  initDataMaxAgeSeconds: number;
  wsTicketTtlSeconds: number;
  tableHeartbeatMs: number;

  buyIn: {
    stars: number;
    label: string;
    description: string;
  };
  /** 1 Star == $10.00 == 1000 cents of play money. */
  centsPerStar: number;
  minBetCents: number;
  maxBetCents: number;
  /** One-time free play-money stack for brand-new accounts, in cents. 0 disables. */
  welcomeGrantCents: number;
  houseWarning: string;
  /** Path inside the deployment that the menu button opens, e.g. "/" or "/lobby". */
  miniAppPath: string;
  rules: typeof RULES;
}

function num(raw: string | undefined, fallback: number, opts?: { min?: number; max?: number }): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.trunc(n);
  if (opts?.min !== undefined && clamped < opts.min) return opts.min;
  if (opts?.max !== undefined && clamped > opts.max) return opts.max;
  return clamped;
}

function boolFlag(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

/**
 * `origin` resolution order:
 *  1. PUBLIC_ORIGIN var (set it after deploy for stable absolute URLs),
 *  2. the incoming request's own origin (works for any workers.dev subdomain and
 *     for preview URLs without reconfiguring anything).
 */
export function resolveOrigin(env: Env, requestUrl?: string): string {
  const configured = (env.PUBLIC_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (requestUrl) {
    try {
      const u = new URL(requestUrl);
      if (u.protocol === 'https:' || u.protocol === 'http:') return `${u.protocol}//${u.host}`;
    } catch {
      /* fall through */
    }
  }
  return '';
}

export function getConfig(env: Env, requestUrl?: string): AppConfig {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const secret = (env.APP_SECRET ?? '').trim();
  if (!token) throw new ConfigError('TELEGRAM_BOT_TOKEN secret is not set (npx wrangler secret put TELEGRAM_BOT_TOKEN)');
  if (secret.length < 32) throw new ConfigError('APP_SECRET must be at least 32 characters (npx wrangler secret put APP_SECRET)');

  return {
    isProd: (env.APP_ENV ?? 'production') === 'production',
    origin: resolveOrigin(env, requestUrl),
    botUsername: (env.TELEGRAM_BOT_USERNAME ?? '').replace(/^@/, ''),
    botToken: token,
    appSecret: secret,
    webhookSecret: (env.TELEGRAM_WEBHOOK_SECRET ?? '').trim() || secret,
    adminIds: (env.ADMIN_USER_IDS ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isSafeInteger(n) && n > 0),
    allowTestPayments: boolFlag(env.ALLOW_TEST_PAYMENTS),

    initDataMaxAgeSeconds: num(env.INITDATA_MAX_AGE_SECONDS, 86_400, { min: 60, max: 604_800 }),
    wsTicketTtlSeconds: num(env.WS_TICKET_TTL_SECONDS, 60, { min: 10, max: 600 }),
    tableHeartbeatMs: num(env.TABLE_HEARTBEAT_MS, 2_000, { min: 250, max: 60_000 }),

    buyIn: {
      stars: num(env.STARS_BUY_IN_AMOUNT, 1, { min: 1, max: 1000 }),
      label: env.BUY_IN_LABEL || 'JackedBot Play Money',
      description: env.BUY_IN_DESCRIPTION || '$10.00 of play-money chips. No cash value.',
    },
    centsPerStar: RULES.starsToCentsPerStar,
    minBetCents: num(env.DEFAULT_MIN_BET_CENTS, RULES.defaultMinBetCents, { min: 10 }),
    maxBetCents: num(env.DEFAULT_MAX_BET_CENTS, RULES.defaultMaxBetCents, { min: 100 }),
    // Two Stars' worth of chips by default: teaches the 1 Star = $10 rate instead
    // of hiding it, and is ~20 minimum bets at the low table.
    welcomeGrantCents: num(env.WELCOME_GRANT_CENTS, RULES.welcomeGrantCents, { min: 0, max: 100_000 }),
    houseWarning: env.HOUSE_WARNING || 'Play money only. No cash value. 18+.',
    miniAppPath: env.MINI_APP_PATH || '/',
    rules: RULES,
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Absolute URL for a path on this deployment. */
export function absoluteUrl(cfg: AppConfig, path: string): string {
  return `${cfg.origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Telegram deep link that opens the Mini App, used by /start and setChatMenuButton. */
export function miniAppLink(cfg: AppConfig, path: string = cfg.miniAppPath, startParam?: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  const url = absoluteUrl(cfg, startParam ? `${clean}${clean.includes('?') ? '&' : '?'}startapp=${startParam}` : clean);
  return cfg.botUsername
    // The inner URL must stay RAW. Telegram's t.me deep link takes everything after
    // ?app= as a literal URL, so percent-encoding it yields a link that opens nothing
    // (https://t.me/JackedBot?app=https%3A%2F%2F... was copied straight to chat).
    ? `https://t.me/${cfg.botUsername}?app=${url}`
    : url;
}

/**
 * The URL for an inline keyboard `web_app` button.
 *
 * This is NOT the same thing as miniAppLink(). Telegram validates web_app.button
 * URLs against the bot's registered Mini App domain and rejects the
 * `https://t.me/<bot>?app=<url>` share-link form with
 *   "Bad Request: BUTTON_URL_INVALID"
 * which took down the button on /start, /balance and /tables at once. The t.me
 * form is only for `url:` buttons and chat links; a web_app button must receive
 * the plain https origin+path.
 */
export function webAppUrl(cfg: AppConfig, path: string = cfg.miniAppPath): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return absoluteUrl(cfg, clean);
}
