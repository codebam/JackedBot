// =============================================================================
// Welcome grant — the one-time free play-money stack.
//
// Why it exists
//   `users.bankroll_cents` starts at 0 and a seat costs chips, so without a
//   grant the very first thing every new player meets is a paywall. A small
//   free stack converts "opened the bot" into "sat at a table" in one tap.
//
// Why $20.00 (2000 cents)
//   1 Star buys $10.00 of chips, so the grant is exactly **two Stars' worth**:
//   the free stack teaches the exchange rate instead of hiding it. At the $1
//   minimum bet that is ~20 wagers, which is long enough to hit a blackjack,
//   double once and understand the table — and small enough that it does not
//   substitute for the first purchase.
//
// Once-only, three ways
//   1. `users.welcome_granted_at` short-circuits repeat calls in one cheap read.
//   2. The ledger key `welcome:<user_id>` is UNIQUE, so two racing bootstraps
//      (e.g. /start and a mini-app launch at the same instant) cannot both mint
//      chips — the loser is an INSERT OR IGNORE no-op.
//   3. Refused for accounts that already hold chips, so an admin top-up or an
//      earlier grant is never doubled.
//
// Farmability, honestly: a free stack is redeemable by registering another
// Telegram account, exactly like every other free-chips game. The levers that
// matter are that the grant is small, capped per identity, and that tables
// declare `min_bankroll_cents` so a free stack cannot buy into high-roller felt.
// =============================================================================
import { applyLedgerOp, LedgerKeys } from './ledger.ts';
import { getUser } from './users.ts';

export const DEFAULT_WELCOME_GRANT_CENTS = 2_000;

export interface WelcomeGrantResult {
  /** True only when this call minted the chips. */
  granted: boolean;
  bankrollCents: number;
  reason?: 'already_granted' | 'not_seeded' | 'has_balance' | 'zero_amount' | 'failed';
  detail?: string;
}

/**
 * Idempotent. Safe to call from the bot's `/start` handler *and* the mini-app
 * session bootstrap on every launch.
 */
export async function ensureWelcomeGrant(db: D1Database, userId: number, cents: number = DEFAULT_WELCOME_GRANT_CENTS): Promise<WelcomeGrantResult> {
  const user = await getUser(db, userId);
  if (!user) return { granted: false, bankrollCents: 0, reason: 'not_seeded', detail: `no users row for ${userId}` };
  if (user.welcome_granted_at) return { granted: false, bankrollCents: user.bankroll_cents, reason: 'already_granted' };

  // Nothing to grant: still stamp the column so we stop re-evaluating per launch.
  if (cents <= 0) {
    await stamp(db, userId, 0);
    return { granted: false, bankrollCents: user.bankroll_cents, reason: 'zero_amount' };
  }

  // Do not hand a second free stack to someone who already has chips — that path
  // is an admin adjust, not a welcome grant.
  if (user.bankroll_cents > 0) {
    await stamp(db, userId, 0);
    return { granted: false, bankrollCents: user.bankroll_cents, reason: 'has_balance' };
  }

  const result = await applyLedgerOp(db, {
    userId,
    centsDelta: cents,
    reason: 'welcome_grant',
    idempotencyKey: LedgerKeys.welcome(userId),
    refType: 'admin_action',
    refId: 'welcome_grant',
    note: `One-time welcome stack worth ${(cents / 100).toFixed(2)} (play money, not redeemable)`,
  });

  if (!result.ok) {
    // A positive credit cannot fail on funds; anything here is a real problem.
    console.error('welcome grant failed', userId, result.code, result.message);
    return { granted: false, bankrollCents: user.bankroll_cents, reason: 'failed', detail: result.message };
  }

  await stamp(db, userId, result.applied ? cents : 0);
  return { granted: result.applied, bankrollCents: result.bankrollCents, reason: result.applied ? undefined : 'already_granted' };
}

/**
 * `grantCents` is persisted alongside the timestamp because refund accounting
 * needs the *historical* size of the free stack, not today's config value —
 * otherwise raising the welcome offer would silently inflate the clawback floor
 * for accounts created under the old one.
 */
async function stamp(db: D1Database, userId: number, grantCents: number): Promise<void> {
  await db
    .prepare(
      `UPDATE users
          SET welcome_granted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              welcome_grant_cents = MAX(welcome_grant_cents, ?2)
        WHERE telegram_user_id = ?1`,
    )
    .bind(userId, grantCents)
    .run();
}
