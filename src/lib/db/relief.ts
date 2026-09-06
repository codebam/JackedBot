// =============================================================================
// Bust relief — the automatic top-up when a player hits $0.
//
// Why it exists
//   Hitting zero mid-session and being offered only a Stars purchase is a paywall
//   in the middle of a game. A small house credit keeps the felt playable and makes
//   the first purchase a choice rather than an ultimatum.
//
// Why `admin_adjust` rather than a new ledger reason
//   `ledger_entries.reason` is a CHECK constraint, and SQLite cannot ALTER one —
//   a new value would mean rebuilding the live money journal and recreating its
//   triggers. `admin_adjust` is truthfully "the house credited chips outside a
//   purchase", which is what this is; the distinction from a human top-up lives in
//   `ref_id = 'bust_relief'`, which is just as filterable. Deliberately NOT
//   `welcome_grant`: `users.welcome_grant_cents` is the non-clawbackable floor in
//   Stars refund accounting, so stamping relief as a welcome grant would silently
//   inflate what a refund can never reclaim.
//
// Why the idempotency key is the last ledger id
//   "Once per bust, unlimited busts" needs a token that advances exactly when a new
//   chip movement happens and never otherwise. The ledger's own AUTOINCREMENT id is
//   that token:
//
//     * two racing calls read the same MAX(id) -> same key -> UNIQUE makes the
//       loser an INSERT OR IGNORE no-op, so a double grant is impossible;
//     * after a grant the balance is positive, so the guard cannot re-fire until
//       another debit happens — and that debit advances MAX(id), unlocking the next
//       bust;
//     * no clock, no cooldown column, no per-window string, nothing to drift.
//
// Farmability, same honest note as the welcome grant: a free stack is redeemable by
// registering another account. The real controls are that the credit is small, that
// tables declare `min_bankroll_cents` so free chips cannot buy into high-roller
// felt, and that every grant is journalled and therefore visible in the drift report.
// =============================================================================

import { applyLedgerOp } from './ledger.ts';
import { getUser } from './users.ts';

/** Ledger `ref_id` that separates automated relief from a human admin credit. */
export const BUST_RELIEF_REF_ID = 'bust_relief';

export interface BustReliefResult {
  /** True only when this call minted the chips. */
  granted: boolean;
  bankrollCents: number;
  reason?: 'has_balance' | 'not_seeded' | 'zero_amount' | 'duplicate' | 'failed';
  detail?: string;
}

/**
 * Resolve the configured amount without pulling AppConfig into the Durable Object.
 *
 * `BUST_RELIEF_CENTS` is a plain env var, so it arrives as a string or not at all;
 * `Number('')` is 0 and `Number('abc')` is NaN, and both would silently disable the
 * feature in production while looking configured. Only a positive safe integer wins.
 */
export function bustReliefCentsFrom(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Credit the house top-up if — and only if — this player is at exactly zero.
 *
 * Idempotent per bust event. Safe to call from the mini-app session bootstrap, the
 * bot's /balance path, and the Table DO on every seat and settlement.
 */
export async function ensureBustRelief(db: D1Database, userId: number, cents: number): Promise<BustReliefResult> {
  const user = await getUser(db, userId);
  if (!user) return { granted: false, bankrollCents: 0, reason: 'not_seeded', detail: `no users row for ${userId}` };

  // The guard is `=== 0`, not `<= 0`: the overdraft trigger makes a negative bankroll
  // impossible, and reading it as "at or below" would let a rounding bug mint chips
  // on every call for an account that should be under investigation instead.
  if (user.bankroll_cents !== 0) return { granted: false, bankrollCents: user.bankroll_cents, reason: 'has_balance' };
  if (cents <= 0) return { granted: false, bankrollCents: user.bankroll_cents, reason: 'zero_amount' };

  const last = await db
    .prepare(`SELECT COALESCE(MAX(id), 0) AS last_id FROM ledger_entries WHERE user_id = ?1`)
    .bind(userId)
    .first<{ last_id: number }>();

  const result = await applyLedgerOp(db, {
    userId,
    centsDelta: cents,
    reason: 'admin_adjust',
    idempotencyKey: `relief:${userId}:${last?.last_id ?? 0}`,
    refType: 'admin_action',
    refId: BUST_RELIEF_REF_ID,
    note: `House bust relief worth ${(cents / 100).toFixed(2)} (play money, not redeemable)`,
  });

  if (!result.ok) {
    // A positive credit cannot fail on funds; anything here is a real problem.
    console.error('bust relief failed', userId, result.code, result.message);
    return { granted: false, bankrollCents: user.bankroll_cents, reason: 'failed', detail: result.message };
  }

  return {
    granted: result.applied,
    bankrollCents: result.bankrollCents,
    reason: result.applied ? undefined : 'duplicate',
  };
}
