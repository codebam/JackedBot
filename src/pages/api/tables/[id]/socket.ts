// POST /api/tables/[id]/socket — mint the one-use WebSocket ticket.
//
// Why this exists: a browser cannot attach an Authorization header to a WebSocket
// handshake. So the island authenticates here with initData (which we verify with
// the bot token) and receives a short-lived, table-scoped, HMAC-signed ticket that
// the Table DO validates on the other side of the relay.
//
// The ticket is deliberately NOT a session token: it grants exactly one table,
// expires in WS_TICKET_TTL_SECONDS, and says nothing about any other resource.
import { env } from 'cloudflare:workers';
import { AuthError, requireUser } from '../../../../lib/auth.ts';
import { authResponse, err, ok, parseTableId } from '../../../../lib/http.ts';
import { mintSocketTicket } from '../../../../lib/table-client.ts';
import { resolveTableAccess } from '../../../../lib/table-access.ts';
import { hasAcceptedAge } from '../../../../lib/db/users.ts';
import { WS_PREFIX } from '../../../../shared/routes.ts';
import type { APIContext } from 'astro';

export const prerender = false;

export async function POST(context: APIContext<{ id: string }>): Promise<Response> {
  const { request, params } = context;
  let auth;
  try {
    // Fresh initData only: this is the credential that opens a live game socket.
    auth = await requireUser(request, env as unknown as Env, { maxAgeSeconds: 3600 });
  } catch (e) {
    if (e instanceof AuthError) return e.toResponse();
    return authResponse(e);
  }

  const tableId = parseTableId(params.id);
  if (!tableId) return err('BAD_TABLE_ID', 'Unknown table.', 400);

  if (!hasAcceptedAge(auth.user)) return err('AGE_GATE_REQUIRED', 'Confirm you are 18 or over to play.', 428);

  // Was four hand-rolled checks, including `if (!cfg.isPublic) 403` for everyone -
  // the shape that made a private table unjoinable by its own creator. One shared
  // gate now covers existence, closure and membership identically in this route and
  // in the HTTP action fallback, which checked none of them.
  const access = await resolveTableAccess(env.DB, tableId, auth.user.telegram_user_id);
  if (!access.ok) return err(access.code, access.message, access.status);

  const { ticket, expiresInSeconds } = await mintSocketTicket(env as unknown as Env, tableId, auth.user.telegram_user_id);

  return ok({
    // The island turns this into wss://<host> + url using its own location, which
    // keeps workers.dev preview URLs working with no configuration.
    url: `${WS_PREFIX}${encodeURIComponent(tableId)}`,
    ticket,
    expiresInSeconds,
    tableId,
  });
}
