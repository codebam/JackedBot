// =============================================================================
// One table-visibility gate, shared by every route that lets a player touch a
// table.
//
// This module exists because there were two routes and they disagreed:
// `POST /api/tables/[id]/socket` checked `is_public` and `POST /api/tables/[id]/action`
// did not — and the action route forwards `sit` straight to the Table DO. Under
// the old "private means nobody" reading that was harmless; under invite-only
// tables it is the whole feature leaking. The DO still re-checks on `sit` (it is
// the only writer of seats), but a route-level gate is what turns a 403 with an
// explanation into a game that silently refuses to start.
// =============================================================================
import { getTableConfig, type TableConfig } from './db/tablesRepo.ts';
import { getMembership } from './db/privateTables.ts';

export type AccessOk = { ok: true; cfg: TableConfig };
export type AccessDenied = { ok: false; code: string; message: string; status: number };
export type AccessResult = AccessOk | AccessDenied;

const deny = (code: string, message: string, status: number): AccessDenied => ({ ok: false, code, message, status });

/**
 * Resolve a table for `userId`: it must exist, be open, and be either public or
 * one the player is enrolled in.
 *
 * `skipMembership` is used by the invite redemption route itself, which is the
 * only way to become a member and therefore cannot require being one already.
 */
export async function resolveTableAccess(
  db: D1Database,
  tableId: string,
  userId: number,
  opts: { skipMembership?: boolean } = {},
): Promise<AccessResult> {
  const cfg = await getTableConfig(db, tableId);
  if (!cfg) return deny('TABLE_NOT_FOUND', 'That table does not exist.', 404);
  if (cfg.status === 'closed') return deny('TABLE_CLOSED', 'That table is closed.', 410);

  if (!cfg.isPublic && !opts.skipMembership) {
    const role = await getMembership(db, tableId, userId);
    if (!role) {
      return deny('NOT_A_MEMBER', 'This table is private. Open the invite link from your group chat to join it.', 403);
    }
  }
  return { ok: true, cfg };
}

/** Same result shape as the routes' error helper, without importing http.ts here. */
export function accessDeniedResponse(d: AccessDenied): Response {
  return Response.json({ error: { code: d.code, message: d.message } }, { status: d.status });
}
