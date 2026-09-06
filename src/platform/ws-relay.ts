// =============================================================================
// The Worker-side half of the browser -> Durable Object WebSocket relay.
//
// Extracted from src/worker.ts so the integration tests run the SAME relay code
// that ships to production, rather than a paraphrase of it. A Worker entry module
// may only export its handler and Durable Object classes, so this logic cannot
// live inline and still be testable.
// =============================================================================
import { WS_PREFIX, isTableId } from '../shared/routes.ts';
import type { Table } from './table.do.ts';

export interface RelayResult {
  /** Set only when the request was not a table socket at all. */
  passthrough?: true;
  response?: Response;
}

/**
 * A Durable Object's own address is not reachable from a browser, so the island
 * dials this Worker path and we hand the upgrade to the DO that owns the table.
 *
 * The request is forwarded verbatim: `Sec-WebSocket-Key`/`-Version`/`-Extensions`
 * must survive byte-identically, and the DO parses the table slug out of the same
 * path and validates the `ticket` itself. Being an internal hop confers no
 * authority — the ticket does.
 */
export async function relayTableSocket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const tableId = decodeURIComponent(url.pathname.slice(WS_PREFIX.length)).toLowerCase();

  if (!isTableId(tableId)) {
    return new Response('bad table id', { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  const stub: DurableObjectStub = env.TABLE.get(env.TABLE.idFromName(tableId));
  try {
    return await stub.fetch(request);
  } catch (e) {
    console.error('ws relay failed', tableId, e);
    return new Response('table unavailable', { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}

/** True when this request should be handled by the relay instead of Astro. */
export function isTableSocketRequest(request: Request): boolean {
  try {
    return new URL(request.url).pathname.startsWith(WS_PREFIX);
  } catch {
    return false;
  }
}

export type TableStub = DurableObjectStub<Table>;
