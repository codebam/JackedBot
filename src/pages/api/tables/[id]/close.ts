// POST /api/tables/[id]/close — the owner closes their own private table.
//
// "Delete" is deliberately not on offer. Every chip movement in this app is
// journalled against the table, so removing the row would orphan the ledger and
// break the one guarantee the game has: that any balance can be reconstructed.
// Closing sets status='closed', which is the reversible-by-design end state:
//
//   * resolveTableAccess refuses it, so no new socket tickets and no new actions;
//   * listShareableTables filters on status='open', so it leaves the inline picker;
//   * the lobby's private list filters status <> 'closed', so it leaves the lobby;
//   * a hand already in progress is untouched and settles normally, because the
//     bets were escrowed at the ledger when they were placed.
//
// Owner-only, enforced twice and for different reasons: getMembership answers
// "may this user close it", and closePrivateTable's UPDATE carries
// `created_by = ?` so a logic error above it still cannot close a stranger's table.
import { env } from 'cloudflare:workers';
import { AuthError, requireUser } from '../../../../lib/auth.ts';
import { authResponse, err, ok, parseTableId } from '../../../../lib/http.ts';
import { closePrivateTable, getMembership } from '../../../../lib/db/privateTables.ts';
import type { APIContext } from 'astro';

export const prerender = false;

export async function POST(context: APIContext<{ id: string }>): Promise<Response> {
  const { request, params } = context;
  const tableId = parseTableId(params.id);
  if (!tableId) return err('BAD_TABLE_ID', 'Unknown table.', 400);

  let auth;
  try {
    auth = await requireUser(request, env as unknown as Env);
  } catch (e) {
    if (e instanceof AuthError) return e.toResponse();
    return authResponse(e);
  }

  const role = await getMembership(env.DB, tableId, auth.user.telegram_user_id);
  if (role === null) return err('NOT_A_MEMBER', 'You are not a member of this table.', 403);
  if (role !== 'owner') {
    return err('NOT_OWNER', 'Only the player who created a private table can close it.', 403);
  }

  // false means the guarded UPDATE matched nothing: not private, already closed, or
  // not created by this user. Report it as closed rather than leaking which.
  const changed = await closePrivateTable(env.DB, tableId, auth.user.telegram_user_id);
  return ok({ tableId, closed: true, changed, note: 'The table no longer appears in the lobby or inline picker.' });
}
