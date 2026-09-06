// =============================================================================
// tables registry (lobby reads this, never wakes a DO) + hand history + stats.
//
// The Table Durable Object pushes a compact heartbeat into `tables` so the lobby
// can render "3/5 seats, betting closes in 8s" from a single D1 read.
// =============================================================================
import type { LobbyTable } from '../../shared/protocol.ts';
import type { Phase } from '../../game/rules.ts';
import { RULES } from '../../game/rules.ts';

export interface TableRow {
  id: string;
  name: string;
  status: 'open' | 'closing' | 'closed';
  buy_in_cents: number;
  min_bet_cents: number;
  max_bet_cents: number;
  min_bankroll_cents: number;
  seat_count: number;
  is_public: number;
  phase: string;
  active_seats: number;
  last_activity_at: string | null;
  snapshot: string | null;
}

const DEFAULT_TABLES = [
  // id      name                      minBet  maxBet   buyIn   seat floor
  { id: 'bravo', name: 'Bravo · $1–$500', min: 100, max: 50_000, buyIn: 1_000, seatFloor: 0 },
  { id: 'delta', name: 'Delta · $5–$500', min: 500, max: 50_000, buyIn: 5_000, seatFloor: 1_000 },
  { id: 'echo', name: 'Echo · $10 high roller', min: 1_000, max: 25_000, buyIn: 10_000, seatFloor: 10_000 },
] as const;

/** Idempotent: called by the lobby and by the DO's lazy hydrate. */
export async function ensureDefaultTables(db: D1Database): Promise<void> {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO tables (id, name, status, buy_in_cents, min_bet_cents, max_bet_cents, min_bankroll_cents, seat_count, is_public, phase, active_seats)
     VALUES (?1, ?2, 'open', ?3, ?4, ?5, ?6, ?7, 1, 'BETTING', 0)`,
  );
  await db.batch(DEFAULT_TABLES.map((t) => stmt.bind(t.id, t.name, t.buyIn, t.min, t.max, t.seatFloor, RULES.seatCount)));
}

export interface TableConfig {
  id: string;
  name: string;
  status: 'open' | 'closing' | 'closed';
  buyInCents: number;
  minBetCents: number;
  maxBetCents: number;
  /** Chips a player must already hold to take a seat (keeps the free stack off
   *  high-roller felt). 0 = anyone with a positive balance. */
  minBankrollCents: number;
  seatCount: number;
  isPublic: boolean;
}

export async function getTableConfig(db: D1Database, tableId: string): Promise<TableConfig | null> {
  const row = await db
    .prepare(`SELECT id, name, status, buy_in_cents, min_bet_cents, max_bet_cents, min_bankroll_cents, seat_count, is_public FROM tables WHERE id = ?1`)
    .bind(tableId)
    .first<TableRow>();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    buyInCents: row.buy_in_cents,
    minBetCents: row.min_bet_cents,
    maxBetCents: row.max_bet_cents,
    minBankrollCents: row.min_bankroll_cents,
    seatCount: row.seat_count,
    isPublic: row.is_public === 1,
  };
}

/**
 * Lobby listing. Deliberately D1-only: rendering the lobby must not pay the
 * latency (or CPU) cost of waking every Table DO.
 */
export async function listLobbyTables(db: D1Database): Promise<LobbyTable[]> {
  const res = await db
    .prepare(
      `SELECT id, name, status, buy_in_cents, min_bet_cents, max_bet_cents, min_bankroll_cents, seat_count, phase, active_seats, last_activity_at, snapshot
         FROM tables
        WHERE status <> 'closed'
        ORDER BY (active_seats > 0) DESC, last_activity_at DESC NULLS LAST, id ASC
        LIMIT 50`,
    )
    .all<TableRow>();

  return (res.results ?? []).map((r) => {
    let preview: LobbyTable['preview'] = null;
    if (r.snapshot) {
      try {
        const snap = JSON.parse(r.snapshot) as { dealer?: { upCard?: number | null }; seats?: ({ committedCents?: number } | null)[] };
        const pot = (snap.seats ?? []).reduce<number>((sum, s) => sum + (s?.committedCents ?? 0), 0);
        preview = { dealerUpCard: snap.dealer?.upCard ?? null, potCents: pot };
      } catch {
        preview = null;
      }
    }
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      phase: (r.phase as Phase) ?? 'BETTING',
      activeSeats: r.active_seats,
      seatCount: r.seat_count,
      openSeats: Math.max(0, r.seat_count - r.active_seats),
      minBetCents: r.min_bet_cents,
      maxBetCents: r.max_bet_cents,
      minBankrollCents: r.min_bankroll_cents,
      buyInCents: r.buy_in_cents,
      lastActivityAt: r.last_activity_at,
      preview,
    };
  });
}

export interface HeartbeatInput {
  tableId: string;
  phase: Phase;
  activeSeats: number;
  snapshot: unknown;
}

/** Called at most every TABLE_HEARTBEAT_MS by the DO. Fire-and-forget. */
export async function writeHeartbeat(db: D1Database, input: HeartbeatInput): Promise<void> {
  await db
    .prepare(
      `UPDATE tables
          SET phase = ?2, active_seats = ?3, snapshot = ?4, last_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?1`,
    )
    .bind(input.tableId, input.phase, input.activeSeats, JSON.stringify(input.snapshot))
    .run();
}

export async function setStatus(db: D1Database, tableId: string, status: 'open' | 'closing' | 'closed'): Promise<void> {
  await db.prepare(`UPDATE tables SET status = ?2, last_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`).bind(tableId, status).run();
}

// ---------------------------------------------------------------------------
// hand history + stats
// ---------------------------------------------------------------------------
export interface RoundHandRecord {
  userId: number;
  seat: number;
  handIndex: number;
  cards: number[];
  betCents: number;
  payoutCents: number;
  outcome: string;
  actions: string[];
}

export interface RoundRecord {
  id: string;
  tableId: string;
  seq: number;
  shoeId: string;
  dealCount: number;
  dealerCards: number[];
  wageredCents: number;
  paidCents: number;
  hands: RoundHandRecord[];
}

/**
 * Round history + stat rollups in ONE batch. Note that this batch intentionally
 * contains no bankroll math — chip movement goes through `applyLedgerOp()` so it
 * keeps its per-statement idempotency guarantee.
 */
export async function recordRound(db: D1Database, r: RoundRecord): Promise<void> {
  const stmts: D1PreparedStatement[] = [];

  stmts.push(
    db
      .prepare(
        `INSERT OR IGNORE INTO rounds (id, table_id, seq, shoe_id, deal_count, dealer_cards, wagered_cents, paid_cents, outcome_counts)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
      )
      .bind(
        r.id,
        r.tableId,
        r.seq,
        r.shoeId,
        r.dealCount,
        JSON.stringify(r.dealerCards),
        r.wageredCents,
        r.paidCents,
        JSON.stringify(countOutcomes(r.hands)),
      ),
  );

  const handStmt = db.prepare(
    `INSERT OR IGNORE INTO round_hands (round_id, user_id, table_id, seat, hand_index, cards, bet_cents, payout_cents, outcome, actions)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
  );
  const statStmt = db.prepare(
    `INSERT INTO user_stats (user_id, hands_played, hands_won, hands_lost, hands_pushed, blackjacks, busts, splits, doubles, wagered_cents, won_cents, net_cents, best_hand_cents, worst_hand_cents, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(user_id) DO UPDATE SET
       hands_played = user_stats.hands_played + excluded.hands_played,
       hands_won    = user_stats.hands_won    + excluded.hands_won,
       hands_lost   = user_stats.hands_lost   + excluded.hands_lost,
       hands_pushed = user_stats.hands_pushed + excluded.hands_pushed,
       blackjacks   = user_stats.blackjacks   + excluded.blackjacks,
       busts        = user_stats.busts        + excluded.busts,
       splits       = user_stats.splits       + excluded.splits,
       doubles      = user_stats.doubles      + excluded.doubles,
       wagered_cents= user_stats.wagered_cents+ excluded.wagered_cents,
       won_cents    = user_stats.won_cents    + excluded.won_cents,
       net_cents    = user_stats.net_cents    + excluded.net_cents,
       best_hand_cents  = MAX(user_stats.best_hand_cents,  excluded.best_hand_cents),
       worst_hand_cents = MIN(user_stats.worst_hand_cents, excluded.worst_hand_cents),
       updated_at   = excluded.updated_at`,
  );

  // Stats are aggregated per player per round so one round costs one upsert each.
  const byUser = new Map<number, StatsAccumulator>();
  for (const h of r.hands) {
    stmts.push(
      handStmt.bind(
        r.id,
        h.userId,
        r.tableId,
        h.seat,
        h.handIndex,
        JSON.stringify(h.cards),
        h.betCents,
        h.payoutCents,
        h.outcome,
        JSON.stringify(h.actions),
      ),
    );
    const acc = byUser.get(h.userId) ?? newStatsAcc();
    acc.hands += 1;
    acc.wagered += h.betCents;
    acc.won += h.payoutCents;
    acc.net += h.payoutCents - h.betCents;
    if (h.outcome === 'blackjack') acc.blackjacks += 1;
    if (h.outcome === 'win') acc.wonHands += 1;
    if (h.outcome === 'push') acc.pushed += 1;
    if (h.outcome === 'bust') acc.busts += 1;
    if (h.outcome === 'lose' || h.outcome === 'bust') acc.lost += 1;
    if (h.handIndex > 0) acc.splits += 1;
    acc.best = Math.max(acc.best, h.payoutCents - h.betCents);
    acc.worst = Math.min(acc.worst, h.payoutCents - h.betCents);
    byUser.set(h.userId, acc);
  }

  for (const [userId, a] of byUser) {
    stmts.push(
      statStmt.bind(
        userId,
        a.hands,
        a.wonHands,
        a.lost,
        a.pushed,
        a.blackjacks,
        a.busts,
        a.splits,
        a.doubles,
        a.wagered,
        a.won,
        a.net,
        a.best,
        a.worst,
      ),
    );
  }

  await db.batch(stmts);
}

interface StatsAccumulator {
  hands: number;
  wonHands: number;
  lost: number;
  pushed: number;
  blackjacks: number;
  busts: number;
  splits: number;
  doubles: number;
  wagered: number;
  won: number;
  net: number;
  best: number;
  worst: number;
}

function newStatsAcc(): StatsAccumulator {
  return {
    hands: 0,
    wonHands: 0,
    lost: 0,
    pushed: 0,
    blackjacks: 0,
    busts: 0,
    splits: 0,
    doubles: 0,
    wagered: 0,
    won: 0,
    net: 0,
    best: 0,
    worst: 0,
  };
}

function countOutcomes(hands: RoundHandRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of hands) out[h.outcome] = (out[h.outcome] ?? 0) + 1;
  return out;
}

export interface PlayerSummary {
  bankroll_cents: number;
  hands_played: number;
  hands_won: number;
  blackjacks: number;
  net_cents: number;
  wagered_cents: number;
}

export async function getPlayerSummary(db: D1Database, userId: number): Promise<PlayerSummary | null> {
  const row = await db
    .prepare(
      `SELECT u.bankroll_cents,
              COALESCE(s.hands_played,0) AS hands_played,
              COALESCE(s.hands_won,0)    AS hands_won,
              COALESCE(s.blackjacks,0)   AS blackjacks,
              COALESCE(s.net_cents,0)    AS net_cents,
              COALESCE(s.wagered_cents,0)AS wagered_cents
         FROM users u LEFT JOIN user_stats s ON s.user_id = u.telegram_user_id
        WHERE u.telegram_user_id = ?1`,
    )
    .bind(userId)
    .first<PlayerSummary>();
  return row ?? null;
}

/** Recent hands for the in-app history sheet. */
export async function recentHands(db: D1Database, userId: number, limit = 12) {
  const r = await db
    .prepare(
      `SELECT round_id, table_id, seat, hand_index, cards, bet_cents, payout_cents, outcome, created_at
         FROM round_hands WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<{
      round_id: string;
      table_id: string;
      seat: number;
      hand_index: number;
      cards: string;
      bet_cents: number;
      payout_cents: number;
      outcome: string;
      created_at: string;
    }>();
  return (r.results ?? []).map((h) => ({ ...h, cards: safeParseCards(h.cards) }));
}

function safeParseCards(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

export async function pruneStale(db: D1Database, staleMinutes = 60): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE tables SET status = 'closed'
        WHERE status <> 'closed'
          AND last_activity_at IS NOT NULL
          AND last_activity_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',?1)`,
    )
    .bind(`-${staleMinutes} minutes`)
    .run();
  return (res as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
}
