// GET /api/tables — lobby listing, straight from D1.
//
// This never touches a Durable Object. The DO publishes a throttled heartbeat into
// `tables`, so the lobby costs one indexed read no matter how many tables exist.
import { env } from 'cloudflare:workers';
import { AuthError, requireUser } from '../../../lib/auth.ts';
import { authResponse, ok } from '../../../lib/http.ts';
import { ensureDefaultTables, listLobbyTables } from '../../../lib/db/tablesRepo.ts';
import { hasAcceptedAge } from '../../../lib/db/users.ts';

export const prerender = false;

export async function GET(request: Request): Promise<Response> {
  let auth;
  try {
    auth = await requireUser(request, env as unknown as Env);
  } catch (e) {
    if (e instanceof AuthError) return e.toResponse();
    return authResponse(e);
  }

  await ensureDefaultTables(env.DB);
  const tables = await listLobbyTables(env.DB);

  const me = {
    userId: auth.user.telegram_user_id,
    bankrollCents: auth.user.bankroll_cents,
    ageAccepted: hasAcceptedAge(auth.user),
    needsRebuy: auth.user.bankroll_cents <= 0,
  };

  return ok({
    tables,
    me,
    welcomeGrantCents: auth.cfg.welcomeGrantCents,
    houseWarning: auth.cfg.houseWarning,
    // Stated explicitly on the wire so the UI can be honest without hardcoding.
    money: { centsPerStar: auth.cfg.centsPerStar, cashoutAvailable: false, playMoneyOnly: true },
  });
}
