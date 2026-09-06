// =============================================================================
// Telegram Stars -> play money, and the only reverse path that exists: an
// operator-initiated refund that claws the chips back.
//
//   1 Star  ==  $10.00 ==  1000 cents of play money
//
// IMPORTANT: there is deliberately no "cash out" function in this file. Players
// can convert Stars into chips, never chips into Stars, TON or fiat. The clawback
// below is a *refund correction*, not a withdrawal: it removes chips that were
// minted by a charge that no longer stands.
// =============================================================================
import type { TelegramBot } from '../telegram/api.ts';
import { applyLedgerOp, LedgerKeys } from './ledger.ts';

export interface PaymentRow {
  telegram_payment_charge_id: string;
  user_id: number;
  stars_amount: number;
  cents_credited: number;
  status: 'pending' | 'credited' | 'refunded' | 'refund_failed';
  payload: string | null;
  is_test: number;
  created_at: string;
  credited_at: string | null;
  refunded_at: string | null;
  refund_charge_id: string | null;
}

export interface CreditInput {
  chargeId: string;
  userId: number;
  stars: number;
  cents: number;
  payload?: string | null;
  chatId?: number | null;
  messageId?: number | null;
  isTest?: boolean;
  /** When false, a test-mode charge is recorded but mints no chips. */
  allowTest?: boolean;
}

export type CreditResult =
  | { ok: true; credited: true; alreadyCredited: false; bankrollCents: number; cents: number }
  | { ok: true; credited: true; alreadyCredited: true; bankrollCents: number; cents: number }
  | { ok: true; credited: false; reason: 'TEST_PAYMENT_BLOCKED'; bankrollCents: number | null; cents: 0 }
  | { ok: false; error: string };

/**
 * Idempotent by `telegram_payment_charge_id`. Safe to call from a webhook handler
 * that Telegram is retrying: the ledger claim and the payment row are both
 * upserts, and the second pass reports `alreadyCredited: true`.
 */
export async function creditBuyIn(db: D1Database, input: CreditInput): Promise<CreditResult> {
  if (!input.chargeId) return { ok: false, error: 'missing telegram_payment_charge_id' };
  if (!Number.isSafeInteger(input.stars) || input.stars <= 0) return { ok: false, error: `invalid star count ${input.stars}` };
  if (!Number.isSafeInteger(input.cents) || input.cents <= 0) return { ok: false, error: `invalid cent amount ${input.cents}` };

  if (input.isTest && !input.allowTest) {
    // The charge happened in Telegram's test environment. Record it for the audit
    // trail, mint nothing.
    await db
      .prepare(
        `INSERT OR IGNORE INTO payments (telegram_payment_charge_id, user_id, stars_amount, cents_credited, payload, tg_chat_id, tg_message_id, is_test, status)
         VALUES (?1,?2,?3,0,?4,?5,?6,1,'pending')`,
      )
      .bind(input.chargeId, input.userId, input.stars, input.payload ?? null, input.chatId ?? null, input.messageId ?? null)
      .run();
    return { ok: true, credited: false, reason: 'TEST_PAYMENT_BLOCKED', bankrollCents: null, cents: 0 };
  }

  // 1. Claim the chips in the ledger. If this key already exists the trigger did
  //    not fire again and we fall through to heal the payments row.
  const ledger = await applyLedgerOp(db, {
    userId: input.userId,
    centsDelta: input.cents,
    reason: 'buy_in',
    idempotencyKey: LedgerKeys.buyIn(input.chargeId),
    refType: 'payment',
    refId: input.chargeId,
    note: `${input.stars} Star(s) = $${(input.cents / 100).toFixed(2)} play money`,
  });
  if (!ledger.ok) return { ok: false, error: ledger.message };

  // 2. Record the charge itself.
  await db
    .prepare(
      `INSERT INTO payments (telegram_payment_charge_id, user_id, stars_amount, cents_credited, payload, tg_chat_id, tg_message_id, is_test, status, credited_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'credited',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(telegram_payment_charge_id) DO UPDATE SET
         status          = 'credited',
         cents_credited  = excluded.cents_credited,
         credited_at     = COALESCE(payments.credited_at, excluded.credited_at)`,
    )
    .bind(
      input.chargeId,
      input.userId,
      input.stars,
      input.cents,
      input.payload ?? null,
      input.chatId ?? null,
      input.messageId ?? null,
      input.isTest ? 1 : 0,
    )
    .run();

  return {
    ok: true,
    credited: true,
    alreadyCredited: !ledger.applied,
    bankrollCents: ledger.bankrollCents,
    cents: input.cents,
  };
}

export interface RefundResult {
  ok: boolean;
  status: 'refunded' | 'refund_failed' | 'not_found' | 'already_refunded' | 'not_credited';
  starsRefunded: number;
  centsRemoved: number;
  /** cents_credited - centsRemoved: chips already gambled away or welcome-protected. */
  shortfallCents: number;
  /** Free-stack cents the clawback deliberately left alone. */
  protectedCents?: number;
  bankrollCents: number | null;
  message?: string;
}

/**
 * Admin flow, in the only safe order:
 *   1. ask Telegram for the Stars refund (the player's entitlement is immediate),
 *   2. remove the chips that charge minted, capped at what is still in the
 *      bankroll — chips spent at a table cannot be un-spent, so the remainder is
 *      recorded as an operator-visible shortfall instead of pushing the balance
 *      negative or silently skipping the clawback.
 * Both the refund outcome and the clawback are journalled in `admin_actions`.
 */
export async function refundAndClawback(db: D1Database, bot: TelegramBot, chargeId: string, actorId: number): Promise<RefundResult> {
  const row = await db
    .prepare(
      `SELECT telegram_payment_charge_id, user_id, stars_amount, cents_credited, status, is_test
        FROM payments WHERE telegram_payment_charge_id = ?1`,
    )
    .bind(chargeId)
    .first<Pick<PaymentRow, 'telegram_payment_charge_id' | 'user_id' | 'stars_amount' | 'cents_credited' | 'status' | 'is_test'>>();

  if (!row) return { ok: false, status: 'not_found', starsRefunded: 0, centsRemoved: 0, shortfallCents: 0, bankrollCents: null, message: `no payment ${chargeId}` };
  if (row.status === 'refunded')
    return { ok: true, status: 'already_refunded', starsRefunded: 0, centsRemoved: 0, shortfallCents: 0, bankrollCents: null };
  if (row.status !== 'credited')
    return { ok: false, status: 'not_credited', starsRefunded: 0, centsRemoved: 0, shortfallCents: 0, bankrollCents: null, message: `payment status is ${row.status}` };

  let refundError: string | undefined;
  try {
    await bot.refundStarPayment(row.user_id, chargeId);
  } catch (e) {
    refundError = (e as Error).message;
    await db
      .prepare(`UPDATE payments SET status = 'refund_failed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE telegram_payment_charge_id = ?1`)
      .bind(chargeId)
      .run();
    await logAdminAction(db, actorId, 'refund_payment_failed', chargeId, { error: refundError }, 'failed');
    return { ok: false, status: 'refund_failed', starsRefunded: 0, centsRemoved: 0, shortfallCents: 0, bankrollCents: null, message: refundError };
  }

  // Claw back at most what the player still holds — and never the free stack.
  //
  // The welcome grant is not proceeds of this charge, so taking it to "undo" a
  // purchase whose chips are already gone would confiscate value the player never
  // received from that Star. `welcome_grant_cents` is therefore a floor under the
  // clawback, and any amount we could not reach is journalled for the operator.
  const balanceRow = await db
    .prepare(`SELECT bankroll_cents, welcome_grant_cents FROM users WHERE telegram_user_id = ?1`)
    .bind(row.user_id)
    .first<{ bankroll_cents: number; welcome_grant_cents: number }>();
  const balance = balanceRow?.bankroll_cents ?? 0;
  const protectedCents = balanceRow?.welcome_grant_cents ?? 0;
  const removableCents = Math.max(0, balance - protectedCents);
  const centsRemoved = Math.min(removableCents, row.cents_credited);
  const shortfallCents = row.cents_credited - centsRemoved;

  if (centsRemoved > 0) {
    const led = await applyLedgerOp(db, {
      userId: row.user_id,
      centsDelta: -centsRemoved,
      reason: 'refund_clawback',
      idempotencyKey: LedgerKeys.clawback(chargeId),
      refType: 'payment',
      refId: chargeId,
      note: `clawback after refundStarPayment; ${shortfallCents}c untraceable (played away or protected welcome stack)`,
    });
    if (!led.ok) {
      await logAdminAction(db, actorId, 'refund_clawback_failed', chargeId, { error: led.message, centsRemoved }, 'partial');
      return {
        ok: false,
        status: 'refunded',
        starsRefunded: row.stars_amount,
        centsRemoved: 0,
        shortfallCents: row.cents_credited,
        bankrollCents: null,
        message: `Stars refunded but chips could not be removed: ${led.message}`,
      };
    }
  }

  await db
    .prepare(
      `UPDATE payments SET status='refunded', refunded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              refund_charge_id=?2, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE telegram_payment_charge_id = ?1`,
    )
    .bind(chargeId, `admin:${actorId}`)
    .run();

  await logAdminAction(
    db,
    actorId,
    'refund_payment',
    chargeId,
    { userId: row.user_id, stars: row.stars_amount, cents_credited: row.cents_credited, cents_removed: centsRemoved, shortfall_cents: shortfallCents, welcome_floor_cents: protectedCents },
    'ok',
  );

  const after = await db.prepare(`SELECT bankroll_cents FROM users WHERE telegram_user_id = ?1`).bind(row.user_id).first<{ bankroll_cents: number }>();

  return {
    ok: true,
    status: 'refunded',
    starsRefunded: row.stars_amount,
    centsRemoved,
    shortfallCents,
    protectedCents,
    bankrollCents: after?.bankroll_cents ?? null,
  };
}

export async function logAdminAction(db: D1Database, actorId: number, action: string, targetId: string, payload: unknown, result: string): Promise<void> {
  await db
    .prepare(`INSERT INTO admin_actions (actor_id, action, target_id, payload, result) VALUES (?1,?2,?3,?4,?5)`)
    .bind(actorId, action, targetId, JSON.stringify(payload ?? null), result)
    .run();
}

/** Look up the last N charges for an admin `/refund` picker. */
export async function recentPayments(db: D1Database, limit = 10): Promise<PaymentRow[]> {
  const r = await db
    .prepare(
      `SELECT telegram_payment_charge_id, user_id, stars_amount, cents_credited, status, payload, is_test, created_at, credited_at, refunded_at, refund_charge_id
        FROM payments ORDER BY created_at DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<PaymentRow>();
  return r.results ?? [];
}

export async function paymentsForUser(db: D1Database, userId: number, limit = 20): Promise<PaymentRow[]> {
  const r = await db
    .prepare(
      `SELECT telegram_payment_charge_id, user_id, stars_amount, cents_credited, status, payload, is_test, created_at, credited_at, refunded_at, refund_charge_id
        FROM payments WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<PaymentRow>();
  return r.results ?? [];
}

/** Ledger tail for the receipt screen. */
export async function ledgerTail(db: D1Database, userId: number, limit = 25) {
  const r = await db
    .prepare(
      `SELECT id, cents_delta, reason, table_id, ref_id, note, created_at
        FROM ledger_entries WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<{ id: number; cents_delta: number; reason: string; table_id: string | null; ref_id: string | null; note: string | null; created_at: string }>();
  return r.results ?? [];
}
