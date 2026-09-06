-- Private (unlisted, invite-only) tables.
--
-- Intentionally additive and idempotent: `CREATE TABLE IF NOT EXISTS` only, never
-- `ALTER TABLE`. migrations/0001_init.sql is regenerated from schema.sql and so
-- already contains this table for a fresh database; this file exists to bring an
-- ALREADY-MIGRATED database up to the same shape. `wrangler d1 migrations apply`
-- records 0001 as done and will not re-run it, so the delta has to ship as 0002 —
-- and it must be safe to run on a database that got the table from 0001 as well.
--
-- There is no separate invite code column. A private table's slug is generated
-- from 128 bits of entropy and is never listed, so the URL itself is the
-- capability; holding it is what the membership rule is for. See
-- src/lib/db/privateTables.ts.

CREATE TABLE IF NOT EXISTS table_members (
  table_id   TEXT    NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
  role       TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (table_id, user_id)
);

-- "Which tables can this player see / share?" is answered from inline mode and the
-- lobby on every request, so it needs an index on the user side of the join.
CREATE INDEX IF NOT EXISTS idx_table_members_user ON table_members(user_id, table_id, role);
