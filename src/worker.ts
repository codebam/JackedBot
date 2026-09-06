// =============================================================================
// Worker entrypoint.
//
// This file is the reason wrangler.toml sets `main = "./src/worker.ts"` instead
// of Astro's default entrypoint: a Durable Object class must be a *top-level
// export of the Worker module*, and Astro's generated entry only exports
// `fetch`. So we export `Table` here and delegate everything else to the
// Cloudflare adapter's Astro handler.
//
// HARD CONSTRAINT (learned the hard way, from workerd itself):
//   every named export of a Worker entry module is treated as a candidate
//   entrypoint. Exporting a plain value fails the runtime with
//     "Incorrect type for map entry 'X': the provided value is not of type
//      'function or ExportedHandler'"
//   — so ONLY `Table` and the default handler are exported. Anything else lives
//   in src/shared/* and is imported normally.
// =============================================================================
import { handle } from '@astrojs/cloudflare/handler';

import { Table } from './platform/table.do.ts';
import { isTableSocketRequest, relayTableSocket } from './platform/ws-relay.ts';

export { Table };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Browser WebSocket handshakes for a table never enter the Astro pipeline:
    // a 101 response with an attached socket should not depend on a page router.
    if (isTableSocketRequest(request)) return relayTableSocket(request, env);

    // Everything else is Astro: SSR pages, /api/* routes, static assets via ASSETS.
    return handle(request, env, ctx);
  },

  /**
   * Hourly janitor (`[triggers] crons` in wrangler.toml): prune webhook de-dupe
   * rows, unstick tables caught mid-transition, and shout if the ledger and the
   * cached bankroll ever disagree.
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await env.DB.prepare(`DELETE FROM seen_updates WHERE received_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 day')`).run();
      await env.DB
        .prepare(
          `UPDATE tables SET status = 'open'
            WHERE status = 'closing'
              AND (last_activity_at IS NULL OR last_activity_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes'))`,
        )
        .run();
    } catch (e) {
      console.error('cron prune failed', e);
    }

    try {
      const drift = await env.DB.prepare(`SELECT user_id, drift_cents FROM v_ledger_drift LIMIT 20`).all<{ user_id: number; drift_cents: number }>();
      if ((drift.results ?? []).length > 0) {
        // Never auto-"fix" money: a human reads this.
        console.error(`LEDGER DRIFT DETECTED (${drift.results?.length} users)`, JSON.stringify(drift.results?.slice(0, 5)));
      }
    } catch (e) {
      console.error('drift probe failed', e);
    }
  },
} satisfies ExportedHandler<Env>;
