// =============================================================================
// The single money-moving primitive.
//
// Every chip credit or debit in the product funnels through `applyLedgerOp()`.
// One statement does the claim, the audit row and the bankroll change (via the
// `ledger_after_insert` trigger), which makes it:
//
//   * ATOMIC     — there is no window where the bankroll moved but the ledger
//                  did not record it, because they are the same statement.
//   * IDEMPOTENT — `INSERT OR IGNORE` against UNIQUE(idempotency_key) turns a
//                  webhook replay into a 0-change no-op. The trigger does not
//                  fire for an ignored insert, so chips cannot double-credit.
//   * SAFE       — `ledger_require_funds` aborts the statement when a debit
//                  would overdraw the player, so a race between two tables can
//                  never produce a negative balance.
//
// `D1Database` / `D1Result` are globals from `npm run types` (wrangler-generated
// worker-configuration.d.ts), which supersedes @cloudflare/workers-types.
// =============================================================================

export const LEDGER_REASONS = [
  'buy_in',
  'welcome_grant',
  'bet',
  'payout_win',
  'payout_push',
  'refund_clawback',
  'admin_adjust',
  'reconcile_fix',
] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

export interface LedgerOp {
  userId: number;
  /** Signed cents. Positive mints chips, negative burns them. */
  centsDelta: number;
  reason: LedgerReason;
  /** Stable, caller-derived key. Reusing a key is always a no-op. */
  idempotencyKey: string;
  refType?: 'payment' | 'round' | 'admin_action' | 'table';
  refId?: string;
  tableId?: string;
  note?: string;
}

export type LedgerOutcome =
  | { ok: true; applied: true; bankrollCents: number; ledgerId: number | null }
  | { ok: true; applied: false; bankrollCents: number; ledgerId: null; duplicate: true }
  | { ok: false; code: 'INSUFFICIENT_BANKROLL' | 'UNKNOWN_USER' | 'INVALID_INPUT'; message: string };

const INSERT_SQL = `
  INSERT OR IGNORE INTO ledger_entries
    (user_id, cents_delta, reason, idempotency_key, ref_type, ref_id, table_id, note)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`;

const BALANCE_SQL = `SELECT bankroll_cents FROM users WHERE telegram_user_id = ?1`;

export async function applyLedgerOp(db: D1Database, op: LedgerOp): Promise<LedgerOutcome> {
  if (!Number.isSafeInteger(op.userId) || op.userId <= 0) return invalid('userId must be a positive safe integer');
  if (!Number.isSafeInteger(op.centsDelta) || op.centsDelta === 0) return invalid('centsDelta must be a non-zero integer');
  if (!LEDGER_REASONS.includes(op.reason)) return invalid(`unknown reason ${String(op.reason)}`);
  if (!op.idempotencyKey || op.idempotencyKey.length > 200) return invalid('idempotencyKey is required and must be <= 200 chars');

  try {
    // A batch is one D1 transaction with read-your-writes, so the SELECT below
    // reflects the trigger's UPDATE from the INSERT above it — and if the insert
    // aborts, neither statement commits.
    const [ins, bal] = await db.batch([
      db.prepare(INSERT_SQL).bind(
        op.userId,
        op.centsDelta,
        op.reason,
        op.idempotencyKey,
        op.refType ?? null,
        op.refId ?? null,
        op.tableId ?? null,
        op.note ?? null,
      ),
      db.prepare(BALANCE_SQL).bind(op.userId),
    ]);

    const bankroll = (bal as D1Result<{ bankroll_cents: number }>).results?.[0]?.bankroll_cents;
    if (bankroll === undefined) {
      return { ok: false, code: 'UNKNOWN_USER', message: `no users row for ${op.userId}` };
    }

    const meta = (ins as unknown as { meta?: { changes?: number; last_row_id?: number } }).meta ?? {};
    const applied = (meta.changes ?? 0) > 0;
    if (!applied) {
      return { ok: true, applied: false, bankrollCents: bankroll, ledgerId: null, duplicate: true };
    }
    return { ok: true, applied: true, bankrollCents: bankroll, ledgerId: meta.last_row_id ?? null };
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (msg.includes('INSUFFICIENT_BANKROLL')) return { ok: false, code: 'INSUFFICIENT_BANKROLL', message: 'bankroll is too small for this debit' };
    if (msg.includes('UNKNOWN_USER')) return { ok: false, code: 'UNKNOWN_USER', message: `no users row for ${op.userId}` };
    throw e;
  }
}

function invalid(message: string): LedgerOutcome {
  return { ok: false, code: 'INVALID_INPUT', message };
}

/**
 * Escrow & payout idempotency keys. Names are derived from round identity, never
 * from a mutable counter, so a retried settlement can only ever re-apply the
 * same key and therefore collapses to a no-op.
 */
export const LedgerKeys = {
  buyIn: (chargeId: string) => `buy_in:${chargeId}`,
  /** UNIQUE(idempotency_key) is what makes the free stack once-per-identity. */
  welcome: (userId: number) => `welcome:${userId}`,
  bet: (roundId: string, userId: number, seat: number) => `bet:${roundId}:${userId}:${seat}`,
  /** Delta top-up when a player raises their wager inside the betting window. */
  betAdjust: (roundId: string, userId: number, seat: number, from: number, to: number) =>
    `bet_adj:${roundId}:${userId}:${seat}:${from}->${to}`,
  /** Refund of an escrow that never got dealt (player cleared the bet / round void). */
  betReturn: (roundId: string, userId: number, seat: number, cents: number) =>
    `bet_ret:${roundId}:${userId}:${seat}:${cents}`,
  /** One credit per seat per round (not per hand): fewer D1 writes, identical
   *  totals, and the per-hand breakdown still lives in `round_hands`. */
  payout: (roundId: string, userId: number, seat: number) => `pay:${roundId}:${userId}:${seat}`,
  clawback: (chargeId: string) => `claw:${chargeId}`,
  admin: (actionId: string) => `admin:${actionId}`,
} as const;

/** Drift probe used by the cron janitor and `npm run db:drift:*`. Must be empty. */
export async function readLedgerDrift(db: D1Database): Promise<DriftRow[]> {
  const r = await db.prepare(`SELECT user_id, cached_cents, ledger_cents, drift_cents FROM v_ledger_drift LIMIT 500`).all<DriftRow>();
  return r.results ?? [];
}

export interface DriftRow {
  user_id: number;
  cached_cents: number;
  ledger_cents: number;
  drift_cents: number;
}

/** Read-only balance lookup (no ledger write). */
export async function readBankroll(db: D1Database, userId: number): Promise<number | null> {
  const r = await db.prepare(BALANCE_SQL).bind(userId).first<{ bankroll_cents: number }>();
  return r?.bankroll_cents ?? null;
}
