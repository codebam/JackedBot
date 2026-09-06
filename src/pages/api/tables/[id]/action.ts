// POST /api/tables/[id]/action — HTTP fallback for game commands.
//
// The live path is the WebSocket. This route exists for (a) a client whose socket
// is still reconnecting, and (b) tests and operator tooling. It performs no game
// logic: it forwards the command to the Table DO, which is the only writer.
import { env } from 'cloudflare:workers';
import { AuthError, requireUser } from '../../../../lib/auth.ts';
import { authResponse, err, ok, parseTableId, readJson } from '../../../../lib/http.ts';
import { tableCommand } from '../../../../lib/table-client.ts';
import { resolveTableAccess } from '../../../../lib/table-access.ts';
import { rateLimitOr429, SlidingWindowRateLimiter } from '../../../../lib/ratelimit.ts';
import type { ClientMessage } from '../../../../shared/protocol.ts';
import type { APIContext } from 'astro';

export const prerender = false;

// Slightly tighter than the socket path, because a caller stuck on HTTP polling is
// almost always a bug or a script.
const limiter = new SlidingWindowRateLimiter(20, 5_000, 4_000);

const ALLOWED: ReadonlySet<ClientMessage['t']> = new Set(['sit', 'leave', 'wager', 'clear_wager', 'action', 'resume']);

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

  const gate = rateLimitOr429(limiter.check(`${auth.user.telegram_user_id}:${tableId}`));
  if (gate) return gate;

  const cmd = await readJson<ClientMessage>(request);
  if (!cmd || !ALLOWED.has(cmd.t)) return err('BAD_COMMAND', 'Unsupported command.', 400);

  // This route used to forward straight to the DO with no visibility check at all,
  // so `sit` at a private table was reachable over plain HTTP by anyone who knew the
  // slug. The DO also enforces membership on `sit` - it is the only writer of seats -
  // but a 403 with an explanation beats a table that silently refuses to start.
  const access = await resolveTableAccess(env.DB, tableId, auth.user.telegram_user_id);
  if (!access.ok) return err(access.code, access.message, access.status);

  const r = await tableCommand(env as unknown as Env, tableId, auth.user.telegram_user_id, cmd);
  const payload = r.payload as { ok?: boolean; data?: unknown; error?: string; code?: string };
  if (r.status >= 400 || payload?.ok === false) {
    return err(payload?.code ?? 'TABLE_ERROR', payload?.error ?? 'Table rejected the request.', r.status || 502);
  }

  // `data` is the Table DO's ServerMessage (state snapshot or ack), passed through.
  return ok(payload?.data ?? null);
}
