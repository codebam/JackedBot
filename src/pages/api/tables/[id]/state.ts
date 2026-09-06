// POST /api/tables/[id]/state — authoritative snapshot for SSR + reconnect.
//
// The table page renders the server-side snapshot into the island's initial props,
// so the first paint already shows real cards and a real countdown instead of a
// spinner while the socket opens.
import { env } from 'cloudflare:workers';
import { AuthError, requireUser } from '../../../../lib/auth.ts';
import { authResponse, err, ok, parseTableId } from '../../../../lib/http.ts';
import { tableState } from '../../../../lib/table-client.ts';

export const prerender = false;

export async function GET(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  return state(request, params.id);
}

export async function POST(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  return state(request, params.id);
}

async function state(request: Request, rawId: string): Promise<Response> {
  let auth;
  try {
    auth = await requireUser(request, env as unknown as Env);
  } catch (e) {
    if (e instanceof AuthError) return e.toResponse();
    return authResponse(e);
  }

  const tableId = parseTableId(rawId);
  if (!tableId) return err('BAD_TABLE_ID', 'Unknown table.', 400);

  const r = await tableState(env as unknown as Env, tableId, auth.user.telegram_user_id);
  const payload = r.payload as { ok?: boolean; data?: unknown; error?: string; code?: string };
  if (!payload?.ok) return err(payload?.code ?? 'TABLE_ERROR', payload?.error ?? 'Table unavailable.', r.status || 502);

  return ok(payload.data);
}
