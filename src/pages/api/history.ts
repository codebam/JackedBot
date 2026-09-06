// GET /api/history — the player's own ledger tail, hand history and rollups.
//
// Read-only and strictly self-scoped: the user id always comes from verified
// initData, never from the query string.
import { env } from 'cloudflare:workers';
import { AuthError, requireUser } from '../../lib/auth.ts';
import { authResponse, ok } from '../../lib/http.ts';
import { ledgerTail, paymentsForUser } from '../../lib/db/payments.ts';
import { getPlayerSummary, recentHands } from '../../lib/db/tablesRepo.ts';
import { formatCents } from '../../shared/money.ts';
import type { APIContext } from 'astro';

export const prerender = false;

export async function GET(context: APIContext): Promise<Response> {
  const { request } = context;
  let auth;
  try {
    auth = await requireUser(request, env as unknown as Env);
  } catch (e) {
    if (e instanceof AuthError) return e.toResponse();
    return authResponse(e);
  }

  const userId = auth.user.telegram_user_id;
  const [summary, ledger, hands, payments] = await Promise.all([
    getPlayerSummary(env.DB, userId),
    ledgerTail(env.DB, userId, 30),
    recentHands(env.DB, userId, 15),
    paymentsForUser(env.DB, userId, 10),
  ]);

  return ok({
    bankrollCents: auth.user.bankroll_cents,
    welcome: {
      granted: Boolean(auth.user.welcome_granted_at),
      grantedAt: auth.user.welcome_granted_at,
      cents: auth.user.welcome_grant_cents,
    },
    summary,
    ledger: ledger.map((e) => ({
      id: e.id,
      reason: e.reason,
      // The raw enum is not an explanation: `admin_adjust` covers both a human
      // top-up and the automatic bust relief, and `note` says which happened.
      refId: e.ref_id,
      note: e.note,
      centsDelta: e.cents_delta,
      label: e.cents_delta >= 0 ? formatCents(e.cents_delta) : formatCents(e.cents_delta),
      tableId: e.table_id,
      createdAt: e.created_at,
    })),
    hands: hands.map((h) => ({
      roundId: h.round_id,
      tableId: h.table_id,
      seat: h.seat,
      handIndex: h.hand_index,
      cards: h.cards,
      betCents: h.bet_cents,
      payoutCents: h.payout_cents,
      netCents: h.payout_cents - h.bet_cents,
      outcome: h.outcome,
      createdAt: h.created_at,
    })),
    payments: payments.map((p) => ({
      chargeId: p.telegram_payment_charge_id,
      stars: p.stars_amount,
      cents: p.cents_credited,
      status: p.status,
      createdAt: p.created_at,
    })),
    playMoneyOnly: true,
    cashoutAvailable: false,
  });
}
