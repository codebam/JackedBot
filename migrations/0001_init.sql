-- JackedBot initial schema.
-- GENERATED FROM schema.sql BY scripts/sync-migration.mjs — DO NOT EDIT.
-- Edit the canonical copy at the repository root and run: npm run db:migrate:local

-- =============================================================================
-- JackedBot — D1 schema (Telegram Multiplayer Blackjack)
-- =============================================================================
-- Money model
--   * All monetary values are INTEGER CENTS (US$). $10.00 buy-in = 1000.
--   * `users.bankroll_cents` is a *cache*. The ledger is the source of truth.
--   * Bankroll is PLAY MONEY. It is never convertible to Stars, TON or fiat.
--     There is deliberately NO withdrawal / cashout table, column or code path.
--
-- Write path (single-statement, atomic, idempotent):
--   INSERT OR IGNORE INTO ledger_entries (..., idempotency_key) VALUES (...);
--   `ledger_after_insert` moves the bankroll; `ledger_require_funds` aborts the
--   whole statement if a debit would overdraw the player. Because idempotency_key
--   is UNIQUE and we use INSERT OR IGNORE, a replayed webhook or a retried bet
--   is a guaranteed no-op — the trigger never fires for an ignored insert.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  telegram_user_id  INTEGER PRIMARY KEY,                 -- Telegram user id (snowflake-safe < 2^53)
  username          TEXT,
  first_name        TEXT,
  last_name         TEXT,
  language_code     TEXT,
  is_premium        INTEGER NOT NULL DEFAULT 0 CHECK (is_premium IN (0, 1)),

  -- Cached projection of SUM(ledger_entries.cents_delta). Maintained only by
  -- triggers, so it can never drift from the ledger.
  bankroll_cents    INTEGER NOT NULL DEFAULT 0 CHECK (bankroll_cents >= 0),

  -- Once-only free stack so a brand-new player can sit down without paying.
  -- Fast guard only: the real once-only guarantee is the UNIQUE ledger key
  -- `welcome:<user_id>`. NULL = never granted.
  welcome_granted_at TEXT,
  -- Exactly how many cents the welcome stack was, frozen at grant time. Used as
  -- the non-clawbackable floor in refund accounting so a refund can never eat the
  -- free stack when the purchased chips are already gone.
  welcome_grant_cents INTEGER NOT NULL DEFAULT 0 CHECK (welcome_grant_cents >= 0),

  -- Age gate. NULL until the user clicks the 18+ attestation. D1-backed so the
  -- attestation follows the user across devices instead of living in localStorage.
  age_accepted_at   TEXT,
  age_accepted_ip   TEXT,
  age_accept_text   TEXT,

  banned_at         TEXT,
  roles             TEXT NOT NULL DEFAULT 'player',      -- csv: 'player','admin'
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at DESC);

-- Never let the cached bankroll go negative, with an actionable error message.
CREATE TRIGGER IF NOT EXISTS users_bankroll_non_negative
BEFORE UPDATE OF bankroll_cents ON users
WHEN NEW.bankroll_cents < 0
BEGIN
  SELECT RAISE(ABORT, 'INSUFFICIENT_BANKROLL');
END;

CREATE TRIGGER IF NOT EXISTS users_touch_updated_at
AFTER UPDATE ON users
BEGIN
  UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE telegram_user_id = NEW.telegram_user_id;
END;

-- -----------------------------------------------------------------------------
-- ledger_entries — append-only double-less journal of every chip movement
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_entries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,

  -- Signed delta in cents. Positive = house gave chips, negative = chips taken.
  cents_delta      INTEGER NOT NULL CHECK (cents_delta <> 0),

  reason           TEXT NOT NULL CHECK (reason IN (
                     'buy_in',          -- Stars payment captured -> +1000/Star
                     'welcome_grant',   -- one-time free play-money stack
                     'bet',             -- stake escrowed at the table (round start)
                     'payout_win',      -- winning hand returned
                     'payout_push',     -- push stake refunded
                     'refund_clawback', -- Stars refunded via refundStarPayment -> chips removed
                     'admin_adjust',    -- manual correction by an admin
                     'reconcile_fix'    -- automated drift repair
                   )),

  -- Machine-stable key. UNIQUE + INSERT OR IGNORE == exactly-once semantics.
  idempotency_key  TEXT NOT NULL,

  ref_type         TEXT,                                -- 'payment' | 'round' | 'admin_action'
  ref_id           TEXT,
  table_id         TEXT,
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON ledger_entries(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_reason    ON ledger_entries(reason, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_ref       ON ledger_entries(ref_type, ref_id);

-- Ledger rows are a financial audit trail: forbid mutation and deletion.
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'LEDGER_IS_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'LEDGER_IS_APPEND_ONLY'); END;

-- Move the bankroll as a side effect of the ledger insert. One statement is
-- therefore the whole transaction: claim + settle, or nothing at all.
CREATE TRIGGER IF NOT EXISTS ledger_after_insert
AFTER INSERT ON ledger_entries
BEGIN
  UPDATE users
     SET bankroll_cents = bankroll_cents + NEW.cents_delta
   WHERE telegram_user_id = NEW.user_id;
END;

-- Refuse a ledger row for a player we have never seen. D1 does not guarantee
-- that `PRAGMA foreign_keys` is effective for every connection, so the invariant
-- that `users.bankroll_cents` mirrors the ledger is enforced explicitly here
-- instead of relying on the FK declaration alone.
CREATE TRIGGER IF NOT EXISTS ledger_requires_user
BEFORE INSERT ON ledger_entries
WHEN (SELECT COUNT(*) FROM users WHERE telegram_user_id = NEW.user_id) = 0
BEGIN
  SELECT RAISE(ABORT, 'UNKNOWN_USER');
END;

-- A debit is only legal if the post-credit projection still clears the bill.
-- Computed from the ledger (not the cache) so a drifted cache cannot launder an
-- overdraft. SUM(...) is NULL for a user with no history, hence COALESCE.
CREATE TRIGGER IF NOT EXISTS ledger_require_funds
BEFORE INSERT ON ledger_entries
WHEN NEW.cents_delta < 0
 AND (
        COALESCE((SELECT SUM(cents_delta) FROM ledger_entries WHERE user_id = NEW.user_id), 0)
        + NEW.cents_delta
      ) < 0
BEGIN
  SELECT RAISE(ABORT, 'INSUFFICIENT_BANKROLL');
END;

-- -----------------------------------------------------------------------------
-- payments — Telegram Stars charges (XTR). Idempotency anchor for buy-ins.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  telegram_payment_charge_id TEXT PRIMARY KEY,           -- supplied by Telegram; stable across retries
  user_id                    INTEGER NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
  stars_amount               INTEGER NOT NULL CHECK (stars_amount > 0),
  currency                   TEXT NOT NULL DEFAULT 'XTR' CHECK (currency = 'XTR'),
  cents_credited             INTEGER NOT NULL DEFAULT 0,  -- 0 until captured
  payload                    TEXT,                        -- our opaque invoice payload
  tg_chat_id                 INTEGER,
  tg_message_id              INTEGER,
  is_test                    INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),

  status                     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                               'pending',   -- invoice sent, unpaid
                               'credited',  -- successful_payment handled, chips issued
                               'refunded',  -- refundStarPayment ok + chips clawed back
                               'refund_failed'
                             )),

  -- Test-mode payments must never mint real playable chips.
  credited_at                TEXT,
  refunded_at                TEXT,
  refund_charge_id           TEXT,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_payments_user_time ON payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status    ON payments(status, created_at DESC);

-- -----------------------------------------------------------------------------
-- tables — the lobby registry. Live game state lives in the Table Durable
-- Object; this row is the durable directory + config + last-known snapshot.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tables (
  id              TEXT PRIMARY KEY,                      -- short base32 slug, also the DO name
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closing', 'closed')),

  -- Economics, in cents
  buy_in_cents    INTEGER NOT NULL DEFAULT 1000 CHECK (buy_in_cents > 0),   -- what a seat buys
  min_bet_cents   INTEGER NOT NULL DEFAULT 10   CHECK (min_bet_cents > 0),
  max_bet_cents   INTEGER NOT NULL DEFAULT 50000 CHECK (max_bet_cents >= min_bet_cents),
  -- Seat price of admission. A high-roller table can require more chips than the
  -- one-time welcome grant, which is what stops a free stack from buying access
  -- to the $100 felt. Enforced by the Table DO when a player sits.
  min_bankroll_cents INTEGER NOT NULL DEFAULT 0 CHECK (min_bankroll_cents >= 0),
  seat_count      INTEGER NOT NULL DEFAULT 5 CHECK (seat_count BETWEEN 1 AND 5),

  is_public       INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)),
  created_by      INTEGER REFERENCES users(telegram_user_id) ON DELETE SET NULL,

  -- Denormalised heartbeat so the lobby can sort/filter without waking every DO.
  active_seats    INTEGER NOT NULL DEFAULT 0,
  phase           TEXT NOT NULL DEFAULT 'BETTING',
  last_activity_at TEXT,
  snapshot        TEXT,                                  -- compact JSON: lobby cards, safe subset only
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CHECK (max_bet_cents >= buy_in_cents OR buy_in_cents >= min_bet_cents)
);

CREATE INDEX IF NOT EXISTS idx_tables_list ON tables(status, is_public, last_activity_at DESC);

-- -----------------------------------------------------------------------------
-- rounds + round_hands — server-authoritative hand history (audit & replay)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rounds (
  id            TEXT PRIMARY KEY,                        -- `${tableId}:${shoeId}:${seq}`
  table_id      TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  shoe_id       TEXT NOT NULL,
  deal_count    INTEGER NOT NULL DEFAULT 0,
  dealer_cards  TEXT NOT NULL,                           -- JSON array; written at settlement only
  wagered_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents    INTEGER NOT NULL DEFAULT 0,
  outcome_counts TEXT NOT NULL DEFAULT '{}',
  settled_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (table_id, seq)
);

CREATE TABLE IF NOT EXISTS round_hands (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id     TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
  table_id     TEXT NOT NULL,
  seat         INTEGER NOT NULL,
  hand_index   INTEGER NOT NULL DEFAULT 0,               -- 0 normal, 1+ = split offspring
  cards        TEXT NOT NULL,                            -- JSON, revealed at settlement
  bet_cents    INTEGER NOT NULL,
  payout_cents INTEGER NOT NULL,                         -- total returned incl. stake
  outcome      TEXT NOT NULL CHECK (outcome IN ('blackjack','win','push','lose','bust','surrendered')),
  actions      TEXT,                                     -- JSON action trace, for dispute resolution
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (round_id, user_id, seat, hand_index)
);

CREATE INDEX IF NOT EXISTS idx_round_hands_user ON round_hands(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_rounds_table     ON rounds(table_id, seq DESC);

-- -----------------------------------------------------------------------------
-- user_stats — rollups, updated once per settlement (never on the hot path)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_stats (
  user_id        INTEGER PRIMARY KEY REFERENCES users(telegram_user_id) ON DELETE CASCADE,
  hands_played   INTEGER NOT NULL DEFAULT 0,
  hands_won      INTEGER NOT NULL DEFAULT 0,
  hands_lost     INTEGER NOT NULL DEFAULT 0,
  hands_pushed   INTEGER NOT NULL DEFAULT 0,
  blackjacks     INTEGER NOT NULL DEFAULT 0,
  busts          INTEGER NOT NULL DEFAULT 0,
  splits         INTEGER NOT NULL DEFAULT 0,
  doubles        INTEGER NOT NULL DEFAULT 0,
  wagered_cents  INTEGER NOT NULL DEFAULT 0,
  won_cents      INTEGER NOT NULL DEFAULT 0,
  net_cents      INTEGER NOT NULL DEFAULT 0,
  best_hand_cents INTEGER NOT NULL DEFAULT 0,
  worst_hand_cents INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- -----------------------------------------------------------------------------
-- admin_actions — every privileged mutation gets a receipt
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER NOT NULL REFERENCES users(telegram_user_id),
  action      TEXT NOT NULL,                             -- 'refund_payment' | 'adjust_bankroll' | 'close_table' | ...
  target_id   TEXT,
  payload     TEXT,
  result      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- -----------------------------------------------------------------------------
-- webhooks — Telegram update dedupe (defence in depth behind payment idempotency)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seen_updates (
  update_id   INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Pruned by the hourly cron (see scheduled: true in wrangler.toml).
CREATE TRIGGER IF NOT EXISTS seen_updates_cap_ai
AFTER INSERT ON seen_updates
BEGIN
  DELETE FROM seen_updates
   WHERE update_id <= (NEW.update_id - 20000)
      OR received_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day');
END;

-- -----------------------------------------------------------------------------
-- meta
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO meta (key, value)
  VALUES ('welcome_grant_cents', '2000'); -- $20.00 = two Stars' worth of chips

-- -----------------------------------------------------------------------------
-- views — reconciliation & leaderboard
-- -----------------------------------------------------------------------------

-- Truth view: what the ledger says each player is owed.
CREATE VIEW IF NOT EXISTS v_ledger_balance AS
SELECT user_id,
       COALESCE(SUM(cents_delta), 0) AS ledger_cents
  FROM ledger_entries
 GROUP BY user_id;

-- Drift detector. Must be empty at all times. `npm run db:reconcile` reports it.
CREATE VIEW IF NOT EXISTS v_ledger_drift AS
SELECT u.telegram_user_id AS user_id,
       u.bankroll_cents   AS cached_cents,
       COALESCE(v.ledger_cents, 0) AS ledger_cents,
       u.bankroll_cents - COALESCE(v.ledger_cents, 0) AS drift_cents
  FROM users u
  LEFT JOIN v_ledger_balance v ON v.user_id = u.telegram_user_id
 WHERE u.bankroll_cents <> COALESCE(v.ledger_cents, 0);

CREATE VIEW IF NOT EXISTS v_leaderboard AS
SELECT u.telegram_user_id AS user_id,
       u.username,
       u.first_name,
       u.bankroll_cents,
       COALESCE(s.hands_played, 0) AS hands_played,
       COALESCE(s.net_cents, 0)    AS net_cents
  FROM users u
  LEFT JOIN user_stats s ON s.user_id = u.telegram_user_id
 WHERE u.banned_at IS NULL
 ORDER BY u.bankroll_cents DESC;
