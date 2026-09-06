// GET /api/health — unauthenticated liveness/readiness probe.
//
// Deliberately reveals nothing about players: counts and configuration only. It is
// the endpoint the deployment guide curls after `wrangler deploy` to confirm D1 and
// the DO both answered.
import { env } from 'cloudflare:workers';
import { tableHealth } from '../../lib/table-client.ts';

export const prerender = false;

export async function GET(): Promise<Response> {
  const out: Record<string, unknown> = {
    ok: true,
    service: 'jackedbot',
    time: new Date().toISOString(),
  };

  try {
    const tables = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tables WHERE status <> 'closed'`).first<{ n: number }>();
    out.d1 = { ok: true, openTables: tables?.n ?? 0 };
  } catch (e) {
    out.d1 = { ok: false, error: (e as Error).message };
  }

  try {
    // Waking the bravo DO also proves the class is exported from the Worker entry.
    const r = await tableHealth(env, 'bravo');
    out.durableObjects = { ok: r.status < 500, status: r.status, table: r.payload };
  } catch (e) {
    out.durableObjects = { ok: false, error: (e as Error).message };
  }

  out.config = {
    botConfigured: Boolean(env.TELEGRAM_BOT_USERNAME),
    origin: env.PUBLIC_ORIGIN || null,
    secretsPresent: { token: Boolean(env.TELEGRAM_BOT_TOKEN), appSecret: Boolean(env.APP_SECRET) },
  };
  out.playMoneyOnly = true;
  out.cashoutAvailable = false;

  const healthy = (out.d1 as { ok?: boolean })?.ok !== false;
  return Response.json(out, { status: healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
