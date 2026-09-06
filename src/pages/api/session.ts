// POST /api/session — mini-app bootstrap.
//
// Called once when the lobby or a table mounts. It is the account-creation point
// for players who arrive straight from a t.me link without ever messaging the bot,
// so it runs the same bootstrap as /start: verify initData, upsert the user, mint
// the one-time welcome stack.
import { env } from 'cloudflare:workers';
import { requireUser, AuthError } from '../../lib/auth.ts';
import { authResponse, err, ok } from '../../lib/http.ts';
import { hasAcceptedAge, isAdmin } from '../../lib/db/users.ts';
import { bootstrapUser, AGE_GATE_STATEMENT } from '../../lib/telegram/session.ts';
import { formatCents } from '../../shared/money.ts';

export const prerender = false;

export async function POST(request: Request): Promise<Response> {
  let auth;
  try {
    auth = await requireUser(request, env as unknown as Env);
  } catch (e) {
    if (e instanceof AuthError) return e.toResponse();
    return authResponse(e);
  }

  const boot = await bootstrapUser(env as unknown as Env, auth.cfg, auth.initData.user);

  // A returning player may still have an open age gate (for example an account
  // created before the gate shipped). Report it instead of letting the seat
  // request fail confusingly later.
  const ageAccepted = hasAcceptedAge(boot.user);

  return ok({
    userId: auth.user.telegram_user_id,
    displayName: auth.user.username ? `@${auth.user.username}` : auth.user.first_name,
    bankrollCents: boot.bankrollCents,
    welcomeGranted: boot.welcomeGranted,
    welcomeCents: boot.welcomeCents,
    welcomeLabel: formatCents(boot.welcomeCents),
    ageAccepted,
    ageStatement: AGE_GATE_STATEMENT,
    admin: isAdmin(auth.user, auth.cfg.adminIds, auth.user.telegram_user_id),
    needsRebuy: boot.bankrollCents <= 0,
    houseWarning: auth.cfg.houseWarning,
    buyIn: {
      stars: auth.cfg.buyIn.stars,
      label: auth.cfg.buyIn.label,
      cents: auth.cfg.centsPerStar * auth.cfg.buyIn.stars,
      centsLabel: formatCents(auth.cfg.centsPerStar * auth.cfg.buyIn.stars),
    },
    money: {
      centsPerStar: auth.cfg.centsPerStar,
      oneStarLabel: formatCents(auth.cfg.centsPerStar),
      playMoneyOnly: true,
      cashoutAvailable: false,
    },
  });
}

/** GET /api/session — cheap who-am-I, no bootstrap writes. */
export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await requireUser(request, env as unknown as Env, { maxAgeSeconds: 3600 });
    if (!hasAcceptedAge(auth.user)) {
      return err('AGE_GATE_REQUIRED', 'Confirm you are 18 or over to continue.', 428);
    }
    return ok({ userId: auth.user.telegram_user_id, bankrollCents: auth.user.bankroll_cents });
  } catch (e) {
    if (e instanceof AuthError) return e.toResponse();
    return authResponse(e);
  }
}
