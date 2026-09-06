// =============================================================================
// Route constants shared by the Worker entrypoint, the Table DO and the Astro
// routes, so the WebSocket path can never drift between the three of them.
// =============================================================================

/** Browser-facing WebSocket prefix. The Worker relays this to the Table DO. */
export const WS_PREFIX = '/api/ws/table/';

const TABLE_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export function isTableId(value: string): boolean {
  return TABLE_ID_RE.test(value);
}

/**
 * Extract the table slug from a path. Accepts both shapes so the DO can boot
 * from a relayed WebSocket request (`/api/ws/table/bravo`) or an internal
 * request (`/state`).
 */
export function tableIdFromPath(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname).toLowerCase();
  if (decoded.startsWith(WS_PREFIX)) {
    const id = decoded.slice(WS_PREFIX.length).replace(/\/+$/, '');
    return isTableId(id) ? id : null;
  }
  const m = /^\/table\/([a-z0-9_-]{2,32})(?:\/|$)/.exec(decoded);
  return m ? m[1]! : null;
}

/** Relative WebSocket URL for an island, given a table id and minted ticket. */
export function socketUrl(tableId: string, ticket: string): string {
  return `${WS_PREFIX}${encodeURIComponent(tableId)}?ticket=${encodeURIComponent(ticket)}`;
}
