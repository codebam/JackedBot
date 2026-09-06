/// <reference types="astro/client" />
//
// `npx wrangler types` (wired to `npm run types` and `postinstall`) writes
// ./worker-configuration.d.ts with every Cloudflare runtime global plus an `Env`
// interface built from wrangler.toml bindings + [vars]. That file is gitignored.
//
// This module is the permanent, hand-maintained half of `Env`: **secrets**, which
// deliberately never appear in wrangler.toml. `import { env } from
// 'cloudflare:workers'` is typed against `Cloudflare.Env`, so the augmentation has
// to target that namespace — declaring a bare global `interface Env` here would
// silently miss it.

declare namespace Cloudflare {
  interface Env {
    /** Bot token from @BotFather. Signs initData and calls the Bot API. */
    TELEGRAM_BOT_TOKEN: string;
    /** 32+ random bytes. Derives WebSocket tickets. YOU generate this. */
    APP_SECRET: string;
    /**
     * Compared against the X-Telegram-Bot-Api-Secret-Token header Telegram adds to
     * every webhook delivery. Also yours to invent — scripts/set-webhook.mjs hands
     * the same string to Telegram via setWebhook's `secret_token`.
     */
    TELEGRAM_WEBHOOK_SECRET: string;
    /** Comma-separated Telegram user ids allowed to run admin commands. */
    ADMIN_USER_IDS?: string;
    /** "1" accepts Telegram test-environment charges as real chip credits. */
    ALLOW_TEST_PAYMENTS?: string;
  }
}

interface Env extends Cloudflare.Env {}

// `@astrojs/cloudflare` injects an `App.Locals` augmentation exposing the Cloudflare
// ExecutionContext as `locals.cfContext`, but that file is only emitted during a
// build (`.astro/cloudflare.d.ts`), so `tsc --noEmit` on a fresh checkout could not
// see it. Declaring it here matches the adapter's own shape exactly — interface
// merging makes the two declarations identical rather than conflicting.
declare namespace App {
  interface Locals {
    /** Cloudflare ExecutionContext: use for waitUntil() and DO `exports`. */
    cfContext: ExecutionContext;
  }
}
