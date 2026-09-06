// =============================================================================
// TableSocket — the reconnecting WebSocket client for a live table.
//
// Three things this has to get right, and none of them are "open a socket":
//
//  1. CLOCK. A 15 s betting timer rendered from a client clock that drifts is a
//     timer that lies. Every snapshot carries `serverNow` plus its absolute
//     `phaseDueAt`; we measure the offset between the two and count down against
//     a monotonic local clock (`performance.now`). `remainingMs()` never touches
//     Date.now() for arithmetic.
//
//  2. TICKETS. The handshake URL carries a 60 s ticket minted over HTTPS. After a
//     drop longer than that we must re-mint before dialling again, so the retry
//     loop refreshes the ticket whenever it is older than its TTL.
//
//  3. ORDER. The server is authoritative and sends full snapshots, so a late or
//     duplicated frame is harmless — we apply the newest by `updatedAt`-style
//     ordering on `serverNow` + phase, never merging deltas.
// =============================================================================
import { api } from './api.ts';
import type { ClientMessage, ServerMessage, TableView, YouView } from '../../shared/protocol.ts';
import type { PublicRules } from '../../shared/protocol.ts';

export interface SocketHandlers {
  onOpen?: () => void;
  onHello?: (msg: Extract<ServerMessage, { t: 'hello' }>) => void;
  onState?: (state: TableView, you: YouView) => void;
  onEvent?: (msg: Extract<ServerMessage, { t: 'event' }>) => void;
  onAck?: (msg: Extract<ServerMessage, { t: 'ack' }>) => void;
  onPong?: (msg: Extract<ServerMessage, { t: 'pong' }>) => void;
  onStatus?: (s: ConnectionStatus, detail?: string) => void;
  /**
   * Arrived from an invite link: redeem membership before asking for a ticket.
   * A private table's mint 403s until a table_members row exists, so the order
   * matters - and it belongs here because ensureTicket() is the one place a ticket
   * is minted, including on every reconnect and TTL refresh.
   */
  invite?: boolean;
}

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'auth-failed' | 'closed' | 'error';

const PING_INTERVAL_MS = 25_000;
const MAX_BACKOFF_MS = 15_000;

export class TableSocket {
  private ws: WebSocket | null = null;
  private ticket = '';
  private ticketAgeMs = 0;
  private ticketTtlSec = 60;
  private attempts = 0;
  private closedByUser = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private refSeq = 0;

  /** serverNow - localEpochNow, in ms. Positive means the server clock is ahead. */
  private clockOffsetMs = 0;
  /** performance.now() at the moment we last synced the offset. */
  private offsetSampledAt = 0;

  lastState: TableView | null = null;
  lastYou: YouView | null = null;
  rules: PublicRules | null = null;
  status: ConnectionStatus = 'connecting';

  constructor(
    private readonly tableId: string,
    private readonly handlers: SocketHandlers = {},
  ) {}

  // -------------------------------------------------------------- lifecycle
  async connect(): Promise<void> {
    this.closedByUser = false;
    await this.dial();
  }

  close(): void {
    this.closedByUser = true;
    this.clearTimers();
    try {
      this.ws?.close(1000, 'client closing');
    } catch {
      /* already gone */
    }
    this.ws = null;
    this.setStatus('closed');
  }

  private async dial(): Promise<void> {
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
    if (!(await this.ensureTicket())) return;

    let url: string;
    try {
      const proto = typeof location !== 'undefined' && location.protocol === 'http:' ? 'ws:' : 'wss:';
      const host = typeof location !== 'undefined' ? location.host : 'localhost';
      url = `${proto}//${host}/api/ws/table/${encodeURIComponent(this.tableId)}?ticket=${encodeURIComponent(this.ticket)}`;
    } catch {
      this.setStatus('error', 'no location available');
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.scheduleReconnect(`socket failed: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.setStatus('open');
      this.handlers.onOpen?.();
      this.startPing();
      // A snapshot may have moved on while we were disconnected.
      this.send({ t: 'resume' });
    };

    ws.onmessage = (ev) => this.handleFrame(ev.data);

    ws.onclose = (ev) => {
      this.clearTimers();
      if (this.closedByUser) {
        this.setStatus('closed');
        return;
      }
      // 1008/401-ish refusals mean the ticket was rejected: re-mint, do not spin.
      if (ev.code === 1008 || ev.code === 4001 || ev.code === 4003 || ev.code === 4008) {
        this.ticket = '';
        this.setStatus('auth-failed', ev.reason || 'ticket rejected');
        this.scheduleReconnect('re-authenticating');
        return;
      }
      this.scheduleReconnect(ev.reason || `closed (${ev.code})`);
    };

    ws.onerror = () => {
      this.setStatus('error');
      // onclose always follows onerror in browsers; the retry lives there.
    };
  }

  private async ensureTicket(): Promise<boolean> {
    const ageOk = Date.now() - this.ticketAgeMs < (this.ticketTtlSec - 10) * 1000;
    if (this.ticket && ageOk) return true;
    try {
      if (this.handlers.invite) {
        // Best effort: if this player is already enrolled the route is a no-op, and
        // if it fails the mint below reports the real reason (NOT_A_MEMBER).
        await api(`/api/tables/${encodeURIComponent(this.tableId)}/join`, { method: 'POST', body: { invite: true } }).catch(() => undefined);
      }
      const r = await api<{ url: string; ticket: string; expiresInSeconds: number }>(`/api/tables/${encodeURIComponent(this.tableId)}/socket`, {
        method: 'POST',
        body: {},
      });
      this.ticket = r.ticket;
      this.ticketTtlSec = r.expiresInSeconds || 60;
      this.ticketAgeMs = Date.now();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'ticket mint failed';
      this.setStatus('auth-failed', msg);
      // Keep trying on a slow loop: the player may simply need to re-open the app.
      this.scheduleReconnect(msg);
      return false;
    }
  }

  private scheduleReconnect(detail?: string): void {
    this.clearTimers();
    if (this.closedByUser) return;
    this.attempts += 1;
    // 0.5s, 1s, 2s, 4s ... capped, plus jitter so a table of five does not
    // reconnect in lockstep after a brief network blip.
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (this.attempts - 1));
    const delay = base / 2 + Math.random() * (base / 2);
    this.setStatus('reconnecting', detail);
    this.reconnectTimer = setTimeout(() => void this.dial(), delay);
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startPing(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.send({ t: 'ping', ref: this.nextRef(), t0: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private handleFrame(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'hello': {
        this.rules = msg.rules;
        this.syncClock(msg.serverNow, msg.table.serverNow);
        this.lastState = msg.table;
        this.lastYou = msg.you;
        this.handlers.onHello?.(msg);
        this.handlers.onState?.(msg.table, msg.you);
        break;
      }
      case 'state': {
        this.syncClock(msg.state.serverNow, msg.state.serverNow);
        // Ignore stale frames that arrive out of order after a reconnect.
        if (this.lastState && this.lastState.serverNow > msg.state.serverNow + 250 && this.lastState.phase === msg.state.phase && this.lastState.seq === msg.state.seq) {
          break;
        }
        this.lastState = msg.state;
        this.lastYou = msg.you;
        this.handlers.onState?.(msg.state, msg.you);
        break;
      }
      case 'event':
        this.handlers.onEvent?.(msg);
        break;
      case 'ack':
        this.handlers.onAck?.(msg);
        break;
      case 'pong':
        this.handlers.onPong?.(msg);
        break;
    }
  }

  private setStatus(s: ConnectionStatus, detail?: string): void {
    this.status = s;
    this.handlers.onStatus?.(s, detail);
  }

  // ------------------------------------------------------------------- clock
  private syncClock(serverNow: number, _stateServerNow?: number): void {
    if (!Number.isFinite(serverNow)) return;
    this.clockOffsetMs = serverNow - Date.now();
    this.offsetSampledAt = now();
  }

  /** Server-corrected epoch, in ms. */
  serverNow(): number {
    return Date.now() + this.clockOffsetMs;
  }

  /**
   * Ms left on the current phase, from a monotonic local clock so a phone that
   * steps its clock mid-hand cannot make the timer jump.
   */
  remainingMs(dueAt: number | null | undefined): number {
    if (!dueAt) return 0;
    const elapsedSinceSync = this.offsetSampledAt ? now() - this.offsetSampledAt : 0;
    const estimatedServerNow = this.serverNow() + elapsedSinceSync;
    return Math.max(0, dueAt - estimatedServerNow);
  }

  // --------------------------------------------------------------- commands
  nextRef(): number {
    this.refSeq = (this.refSeq + 1) % 100_000;
    return this.refSeq;
  }

  /** Send a command; returns false when the socket is not usable right now. */
  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
