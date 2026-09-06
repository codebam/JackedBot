// =============================================================================
// Worker-side client for the Table Durable Object.
//
// Every call carries a freshly minted, 60-second ticket and the DO verifies it,
// so the Worker never gets to speak for a player without proof — the internal hop
// is not a privilege boundary.
// =============================================================================
import { signTicket } from './auth.ts';
import { getConfig, type AppConfig } from './config.ts';
import type { ClientMessage, TableView, YouView } from '../shared/protocol.ts';

export function tableStub(env: Env, tableId: string): DurableObjectStub {
  return env.TABLE.get(env.TABLE.idFromName(tableId));
}

export interface TableCall {
  status: number;
  payload: unknown;
}

async function call(
  env: Env,
  tableId: string,
  path: string,
  userId: number,
  init?: { method?: string; body?: unknown },
): Promise<TableCall> {
  const cfg: AppConfig = getConfig(env);
  const ticket = await signTicket(cfg, userId, tableId);
  const url = `https://table.internal${path}?table=${encodeURIComponent(tableId)}&ticket=${encodeURIComponent(ticket)}`;

  const res = await tableStub(env, tableId).fetch(
    new Request(url, {
      method: init?.method ?? 'GET',
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    }),
  );
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = { ok: false, error: await res.text().catch(() => ''), code: 'NON_JSON_RESPONSE' };
  }
  return { status: res.status, payload };
}

export function tableState(env: Env, tableId: string, userId: number): Promise<TableCall> {
  return call(env, tableId, '/state', userId);
}

export function tableCommand(env: Env, tableId: string, userId: number, cmd: ClientMessage): Promise<TableCall> {
  return call(env, tableId, '/cmd', userId, { method: 'POST', body: cmd });
}

export function tableHealth(env: Env, tableId: string): Promise<TableCall> {
  return call(env, tableId, '/health', 0);
}

export async function tableView(env: Env, tableId: string, userId: number): Promise<{ table: TableView; you: YouView } | null> {
  const r = await tableState(env, tableId, userId);
  const p = r.payload as { ok?: boolean; data?: { table?: TableView; you?: YouView } };
  if (!p?.ok || !p.data?.table) return null;
  return { table: p.data.table, you: p.data.you ?? emptyYou(userId) };
}

function emptyYou(userId: number): YouView {
  return {
    userId,
    seatIndex: null,
    bankrollCents: 0,
    escrowCents: 0,
    availableCents: 0,
    legal: null,
    ageAccepted: true,
    needsRebuy: false,
  };
}

/**
 * Mint the WebSocket ticket for the island. Separate from `call()` because the
 * ticket must reach the *browser* — it is the only credential a WebSocket
 * handshake can carry.
 */
export async function mintSocketTicket(env: Env, tableId: string, userId: number): Promise<{ ticket: string; expiresInSeconds: number }> {
  const cfg = getConfig(env);
  const ticket = await signTicket(cfg, userId, tableId);
  return { ticket, expiresInSeconds: cfg.wsTicketTtlSeconds };
}
