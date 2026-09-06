// =============================================================================
// Tiny HTTP helpers so every API route answers with the same envelope and the
// same no-store discipline (game state and balances must never be cached).
// =============================================================================
import type { ApiEnvelope } from '../shared/protocol.ts';

export const NO_STORE = { 'cache-control': 'no-store, max-age=0' } as const;

export function ok<T>(data: T, init?: ResponseInit): Response {
  const body: ApiEnvelope<T> = { ok: true, data };
  return Response.json(body, { ...init, headers: { ...NO_STORE, ...(init?.headers ?? {}) } });
}

export function err(code: string, message: string, status = 400, init?: ResponseInit): Response {
  const body: ApiEnvelope<never> = { ok: false, error: message, code };
  return Response.json(body, { status, ...init, headers: { ...NO_STORE, ...(init?.headers ?? {}) } });
}

/** Map the typed AuthError into a response without leaking internals. */
export function authResponse(e: unknown): Response {
  const anyErr = e as { status?: number; code?: string; message?: string };
  if (typeof anyErr?.status === 'number' && anyErr.status >= 400 && anyErr.status < 600) {
    return err(anyErr.code ?? 'UNAUTHORIZED', anyErr.message ?? 'unauthorized', anyErr.status);
  }
  console.error('unexpected auth failure', e);
  return err('INTERNAL', 'Internal error', 500);
}

/**
 * A table id is a slug, not a uuid. Keep it boring and validated: it becomes a
 * Durable Object name, an SQL parameter and a DOM id.
 */
const TABLE_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export function parseTableId(raw: string | undefined): string | null {
  if (!raw) return null;
  const id = decodeURIComponent(raw).trim().toLowerCase();
  return TABLE_ID_RE.test(id) ? id : null;
}

/** Best-effort JSON body with a size ceiling, so a fat POST cannot cost us memory. */
export async function readJson<T>(request: Request, maxBytes = 8_192): Promise<T | null> {
  const len = Number(request.headers.get('content-length') ?? '0');
  if (len > maxBytes) return null;
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}
