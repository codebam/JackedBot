// POST /api/tables/[id]/join — redeem an invite link into membership.
//
// The table page calls this once per load with the `?invite=` flag the share link
// carries. That flag is not a credential (the URL path is the capability, and this
// route still requires fresh initData), it is a statement of intent: "this player
// arrived from an invite, not from a guessed slug". Public tables ignore it.
//
// Enrollment is deliberately per-table and idempotent, so a reload cannot create a
// second row or move `joined_at`.
import { env } from 'cloudflare:workers';
import { AuthError, requireUser } from '../../../../lib/auth.ts';
import { authResponse, err, ok, parseTableId } from '../../../../lib/http.ts';
import { resolveTableAccess } from '../../../../lib/table-access.ts';
import { redeemInvite } from '../../../../lib/db/privateTables.ts';
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

  // skipMembership: joining is how you become a member, so it cannot require one.
  // Existence and closure are still enforced, and `invite` must appear in the URL —
  // a bare POST must not be able to enrol a stranger into somebody's private game
  // just by guessing a slug, which is the only thing keeping these tables private.
  const access = await resolveTableAccess(env.DB, tableId, auth.user.telegram_user_id, { skipMembership: true });
  if (!access.ok) return err(access.code, access.message, access.status);

  let viaInvite = false;
  try {
    const body = (await request.json()) as { invite?: unknown };
    viaInvite = body?.invite === true || body?.invite === tableId;
  } catch {
    viaInvite = false;
  }
  if (!viaInvite) return err('INVITE_REQUIRED', 'Open the table from its invite link to join.', 403);

  if (!auth.user.age_accepted_at && !access.cfg.isPublic) {
    return err('AGE_GATE_REQUIRED', 'Confirm you are 18 or over to play.', 428);
  }

  const role = await redeemInvite(env.DB, tableId, auth.user.telegram_user_id);
  return ok({ tableId, role, isPublic: access.cfg.isPublic });
}
