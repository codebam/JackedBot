// POST /api/age-gate — record the 18+ / play-money attestation.
//
// Stored in D1 (not localStorage) so the attestation follows the player across
// devices and is auditable: `users.age_accepted_at` plus the exact statement text
// they agreed to.
import { env } from 'cloudflare:workers';
import { requireUser, AuthError } from '../../lib/auth.ts';
import { authResponse, err, ok } from '../../lib/http.ts';
import { acceptAgeGate, hasAcceptedAge } from '../../lib/db/users.ts';
import { AGE_GATE_STATEMENT } from '../../lib/telegram/session.ts';
import type { APIContext } from 'astro';

export const prerender = false;

export async function POST(context: APIContext): Promise<Response> {
  const { request } = context;
  let auth;
  try {
    // Tight freshness: this is a legal attestation, not a page view.
    auth = await requireUser(request, env as unknown as Env, { maxAgeSeconds: 3600 });
  } catch (e) {
    if (e instanceof AuthError) return e.toResponse();
    return authResponse(e);
  }

  const body = (await request.json().catch(() => null)) as { accept?: unknown; statement?: unknown } | null;
  if (body?.accept !== true) return err('ACCEPTANCE_REQUIRED', 'You must explicitly accept the 18+ attestation.', 400);

  // The client echoes back the statement it displayed. If the wording changed
  // since the page rendered, we refuse rather than record agreement to text the
  // user never saw.
  const statement = typeof body.statement === 'string' && body.statement.trim() ? body.statement.trim() : AGE_GATE_STATEMENT;
  if (statement !== AGE_GATE_STATEMENT) {
    return err('STALE_STATEMENT', 'The terms shown have changed. Reload and confirm again.', 409);
  }

  const user = await acceptAgeGate(env.DB, auth.user.telegram_user_id, statement);
  if (!user) return err('NO_ACCOUNT', 'Account not found.', 404);

  return ok({ ageAccepted: hasAcceptedAge(user), bankrollCents: user.bankroll_cents });
}
