// =============================================================================
// Private tables: creation, membership, and the "can this player see it" reads.
//
// Model (decided with the owner of this project, so it is written down here):
//   * `is_public = 0` means unlisted AND invite-only. The lobby never lists it,
//     inline mode never offers it to a stranger, and the Table DO will not seat a
//     non-member.
//   * The invite is the URL. A private slug is 32 hex chars (128 bits) and is only
//     ever handed to the creator, so "holds the link" and "may join" are the same
//     fact — no separate code to rotate, and no ALTER TABLE to get onto a live DB.
//   * Opening that link while authenticated enrolls you (see redeemInvite). That is
//     the moment the link stops being a secret to you and becomes a seat.
// =============================================================================
import type { Stakes } from '../stakes.ts';
import { safeTableName } from '../stakes.ts';
import type { TableConfig } from './tablesRepo.ts';

/** Same CHECK the schema enforces, kept here so a UI can render the cap. */
export const MAX_OPEN_PRIVATE_TABLES_PER_USER = 5;

/** 32 lowercase hex chars = 128 bits, and legal under shared/routes.ts TABLE_ID_RE. */
export function newTableId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PrivateTableSummary {
  id: string;
  name: string;
  minBetCents: number;
  maxBetCents: number;
  buyInCents: number;
  seatCount: number;
  activeSeats: number;
  status: string;
  role: 'owner' | 'member';
}

/**
 * Create an unlisted table and enroll its creator as owner.
 *
 * Both statements go in one `batch()`, which D1 runs as a single transaction: a
 * table nobody owns would be permanently joinable by nobody, and an owner row
 * pointing at a table that failed to insert would be a phantom in their inline
 * results. Either half failing means neither half happens.
 */
export async function createPrivateTable(db: D1Database, ownerUserId: number, stakes: Stakes): Promise<{ tableId: string }> {
  const name = safeTableName(stakes.name) || 'Private table';

  const count = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM tables
        WHERE created_by = ?1 AND is_public = 0 AND status <> 'closed'`,
    )
    .bind(ownerUserId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_OPEN_PRIVATE_TABLES_PER_USER) {
    throw new Error(`RATE_LIMITED: you already have ${MAX_OPEN_PRIVATE_TABLES_PER_USER} open private tables. Close one first.`);
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const tableId = newTableId();
    try {
      await db.batch([
        db.prepare(
          `INSERT INTO tables (id, name, status, buy_in_cents, min_bet_cents, max_bet_cents, min_bankroll_cents,
                               seat_count, is_public, created_by, phase, active_seats)
           VALUES (?1, ?2, 'open', ?3, ?4, ?5, ?6, ?7, 0, ?8, 'BETTING', 0)`,
        ).bind(tableId, name, stakes.buyInCents, stakes.minBetCents, stakes.maxBetCents, stakes.minBankrollCents, stakes.seatCount, ownerUserId),
        db.prepare(`INSERT INTO table_members (table_id, user_id, role) VALUES (?1, ?2, 'owner')`).bind(tableId, ownerUserId),
      ]);
      return { tableId };
    } catch (e) {
      // Only a slug collision may be retried; anything else (including the
      // rate-limit throw above) must reach the caller unchanged.
      if (!/UNIQUE constraint failed: tables\.id/.test((e as Error).message)) throw e;
    }
  }
  throw new Error('ID_COLLISION: could not allocate a table id');
}

/** Current role of `userId` at `tableId`, or null when they are not a member. */
export async function getMembership(db: D1Database, tableId: string, userId: number): Promise<'owner' | 'member' | null> {
  const row = await db
    .prepare(`SELECT role FROM table_members WHERE table_id = ?1 AND user_id = ?2`)
    .bind(tableId, userId)
    .first<{ role: 'owner' | 'member' }>();
  return row?.role ?? null;
}

/**
 * Redeem the invite: enroll an authenticated player who arrived through the link.
 *
 * Idempotent by design — the island calls this on every table-page load, and
 * INSERT OR IGNORE means a reload cannot duplicate a row or bump `joined_at`.
 */
export async function redeemInvite(db: D1Database, tableId: string, userId: number): Promise<'owner' | 'member'> {
  await db.prepare(`INSERT OR IGNORE INTO table_members (table_id, user_id, role) VALUES (?1, ?2, 'member')`).bind(tableId, userId).run();
  return (await getMembership(db, tableId, userId)) ?? 'member';
}

/** Tables this player may share through inline mode: private, theirs or joined. */
export async function listShareableTables(db: D1Database, userId: number): Promise<PrivateTableSummary[]> {
  const res = await db
    .prepare(
      `SELECT t.id, t.name, t.status, t.min_bet_cents, t.max_bet_cents, t.buy_in_cents, t.seat_count, t.active_seats, m.role
         FROM table_members m
         JOIN tables t ON t.id = m.table_id
        WHERE m.user_id = ?1 AND t.is_public = 0 AND t.status = 'open'
        ORDER BY (m.role = 'owner') DESC, t.last_activity_at DESC NULLS LAST, t.id ASC
        LIMIT 20`,
    )
    .bind(userId)
    // snake_case, because this is the row shape - the mapping below produces the
    // camelCase PrivateTableSummary the callers actually use.
    .all<{
      id: string;
      name: string;
      status: string;
      min_bet_cents: number;
      max_bet_cents: number;
      buy_in_cents: number;
      seat_count: number;
      active_seats: number | null;
      role: 'owner' | 'member';
    }>();

  return (res.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    minBetCents: r.min_bet_cents,
    maxBetCents: r.max_bet_cents,
    buyInCents: r.buy_in_cents,
    seatCount: r.seat_count,
    activeSeats: r.active_seats ?? 0,
    status: r.status,
    role: r.role,
  }));
}

/** Ids the player is enrolled in, for annotating the lobby with "private · yours". */
export async function listMemberTableIds(db: D1Database, userId: number): Promise<string[]> {
  const res = await db.prepare(`SELECT table_id FROM table_members WHERE user_id = ?1`).bind(userId).all<{ table_id: string }>();
  return (res.results ?? []).map((r) => r.table_id);
}

/** Close a table. Owner-only; the caller must have checked the role. */
export async function closePrivateTable(db: D1Database, tableId: string, userId: number): Promise<boolean> {
  const meta = await db
    .prepare(`UPDATE tables SET status = 'closed' WHERE id = ?1 AND is_public = 0 AND created_by = ?2 AND status <> 'closed'`)
    .bind(tableId, userId)
    .run();
  return (meta.meta?.changes ?? 0) > 0;
}

/** Does this config need a membership check at all? Public tables never do. */
export function needsMembership(cfg: TableConfig): boolean {
  return !cfg.isPublic;
}
