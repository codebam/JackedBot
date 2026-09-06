// =============================================================================
// users — identity, cached bankroll, age attestation, roles.
// The upsert never writes `bankroll_cents`; only the ledger triggers do.
// =============================================================================
import type { TelegramWebAppUser } from '../telegram/initData.ts';

export interface UserRow {
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string | null;
  is_premium: number;
  bankroll_cents: number;
  welcome_granted_at: string | null;
  welcome_grant_cents: number;
  age_accepted_at: string | null;
  banned_at: string | null;
  roles: string;
  created_at: string;
  last_seen_at: string | null;
}

const UPSERT_SQL = `
INSERT INTO users (telegram_user_id, username, first_name, last_name, language_code, is_premium, last_seen_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(telegram_user_id) DO UPDATE SET
  username      = COALESCE(excluded.username, users.username),
  first_name    = excluded.first_name,
  last_name     = COALESCE(excluded.last_name, users.last_name),
  language_code = COALESCE(excluded.language_code, users.language_code),
  is_premium    = excluded.is_premium,
  last_seen_at  = excluded.last_seen_at
RETURNING telegram_user_id, username, first_name, last_name, language_code, is_premium,
          bankroll_cents, welcome_granted_at, welcome_grant_cents,
          age_accepted_at, banned_at, roles, created_at, last_seen_at`;

const SELECT_SQL = `
SELECT telegram_user_id, username, first_name, last_name, language_code, is_premium,
       bankroll_cents, welcome_granted_at, welcome_grant_cents,
       age_accepted_at, banned_at, roles, created_at, last_seen_at
  FROM users WHERE telegram_user_id = ?1`;

export function fromTgUser(u: TelegramWebAppUser): {
  id: number;
  username: string | null;
  first_name: string;
  last_name: string | null;
  language_code: string | null;
  is_premium: number;
} {
  return {
    id: u.id,
    username: u.username ?? null,
    first_name: u.first_name ?? '',
    last_name: u.last_name ?? null,
    language_code: u.language_code ?? null,
    is_premium: u.is_premium ? 1 : 0,
  };
}

export async function ensureUser(
  db: D1Database,
  u: { id: number; username?: string | null; first_name?: string; last_name?: string | null; language_code?: string | null; is_premium?: number },
): Promise<UserRow> {
  const res = await db
    .prepare(UPSERT_SQL)
    .bind(u.id, u.username ?? null, u.first_name ?? '', u.last_name ?? null, u.language_code ?? null, u.is_premium ?? 0)
    .all<UserRow>();
  const row = res.results?.[0];
  if (!row) throw new Error(`ensureUser: upsert returned no row for ${u.id}`);
  return row;
}

export async function getUser(db: D1Database, userId: number): Promise<UserRow | null> {
  return (await db.prepare(SELECT_SQL).bind(userId).first<UserRow>()) ?? null;
}

/** Idempotent by nature: re-clicking the gate just refreshes the timestamp. */
export async function acceptAgeGate(db: D1Database, userId: number, statement: string): Promise<UserRow | null> {
  await db
    .prepare(
      `UPDATE users SET age_accepted_at = COALESCE(age_accepted_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                        age_accept_text   = ?2
       WHERE telegram_user_id = ?1`,
    )
    .bind(userId, statement.slice(0, 200))
    .run();
  return getUser(db, userId);
}

export function hasAcceptedAge(row: Pick<UserRow, 'age_accepted_at'> | null): boolean {
  return Boolean(row?.age_accepted_at);
}

export function isBanned(row: Pick<UserRow, 'banned_at'> | null): boolean {
  return Boolean(row?.banned_at);
}

/** Admin = listed in the ADMIN_USER_IDS secret-driven var, or carries the role. */
export function isAdmin(row: Pick<UserRow, 'roles'> | null, adminIds: number[], userId?: number): boolean {
  if (row?.roles?.split(',').includes('admin')) return true;
  return userId !== undefined && adminIds.includes(userId);
}

export function displayName(row: Pick<UserRow, 'username' | 'first_name' | 'telegram_user_id'>): string {
  if (row.username) return `@${row.username}`;
  return (row.first_name || `player ${row.telegram_user_id}`).slice(0, 24);
}
