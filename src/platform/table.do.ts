// =============================================================================
// Table Durable Object — one instance per physical blackjack table.
//
// RESPONSIBILITIES
//   * owns the shoe, the seats and the round state machine (single writer)
//   * terminates WebSocket connections and broadcasts redacted snapshots
//   * moves chips through D1 with idempotent ledger claims
//   * survives eviction: every transition is persisted, and every timer is
//     derived from an absolute `dueAt` instant, never from accumulated elapsed
//     time
//
// STATE-MACHINE WAKEUP (why there is both a timer and an alarm)
//   `setTimeout` gives smooth 15 s countdowns but dies with the isolate.
//   `storage.setAlarm()` survives eviction but can fire late.
//   We arm BOTH for the same instant with the alarm lagged by ALARM_LAG_MS.
//   Whichever fires first calls `onDeadline()`, which compares `Date.now()` with
//   the stored deadline and is idempotent — so a timer/alarm race, or a wake
//   after eviction, can never deal two rounds. Every transition also runs
//   through `tx()`, a serialising promise chain, because DO handlers are
//   re-entrant across `await` points.
//
// REDACTION
//   `viewFor()` is the only path from state to wire. The undealt shoe is reduced
//   to a count, and the dealer's hole card is absent from the payload until
//   `holeRevealed` flips at DEALER_TURN (or during the blackjack peek).
//
// HIBERNATION NOTE
//   `ctx.acceptWebSocket()` makes idle sockets free. But an armed alarm, an
//   incoming request or a `setTimeout` keeps the isolate awake and billable, so
//   a table with players always costs wall-time while a round is live, and an
//   empty table costs nothing after `standDown()` disarms everything.
// =============================================================================
import { DurableObject } from 'cloudflare:workers';

import { dealerMustDraw, dealerCouldHaveBlackjack, legalActions, type LegalActions } from '../game/actions.ts';
import { cardsRemaining, createShoe, drawCard, needsShuffle, rankOf, type Shoe } from '../game/cards.ts';
import { handTotal, isBlackjack, rankIndex } from '../game/hand.ts';
import { RULES, phaseDurationMs, type Phase } from '../game/rules.ts';
import { normaliseChips } from '../game/betting.ts';
import { settleHand, type Outcome, type SettledHand } from '../game/settlement.ts';
import { applyLedgerOp, LedgerKeys } from '../lib/db/ledger.ts';
import { getTableConfig, writeHeartbeat, recordRound, ensureDefaultTables, type TableConfig } from '../lib/db/tablesRepo.ts';
import { getMembership } from '../lib/db/privateTables.ts';
import { getUser, displayName as dn } from '../lib/db/users.ts';
import { getConfig, type AppConfig } from '../lib/config.ts';
import { verifyTicket } from '../lib/auth.ts';
import { SlidingWindowRateLimiter } from '../lib/ratelimit.ts';
import { formatCents } from '../shared/money.ts';
import type {
  ClientMessage,
  EventData,
  EventKind,
  HandView,
  PublicRules,
  SeatView,
  ServerMessage,
  SettlementView,
  TableView,
  YouView,
} from '../shared/protocol.ts';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import { tableIdFromPath } from '../shared/routes.ts';

const STATE_KEY = '***';
const TABLE_ID_KEY = '***';
const STATE_VERSION = 1;

/** Alarm fires this long after the in-memory timer, so the timer wins when alive. */
const ALARM_LAG_MS = 1_500;
/** Coalesce chip taps: at most one D1 escrow write per seat per window. */
const ESCROW_COALESCE_MS = 600;
/** Pause between dealer card flips — readability, not game logic. */
const DEALER_STEP_MS = 700;
/** Hard cap on a single serialised transition before we refuse to keep waiting. */
const TRANSITION_WATCHDOG_MS = 25_000;

// ---------------------------------------------------------------------------
// persisted state
// ---------------------------------------------------------------------------
export interface HandState {
  index: number;
  cards: number[];
  betCents: number;
  originalBetCents: number;
  fromSplit: boolean;
  doubled: boolean;
  status: 'pending' | 'playing' | 'stood' | 'bust' | 'complete';
  outcome?: Outcome;
  /** Action trace: H hit, S stand, D double, P split, T timed out, =BJ natural. */
  actions: string[];
  payoutCents: number;
  splitAceCapped: boolean;
}

export interface SeatState {
  userId: number;
  displayName: string;
  username: string | null;
  /** Cached D1 bankroll; the D1 overdraft trigger remains the real authority. */
  bankrollCents: number;
  pendingChips: number[];
  /** Desired wager for the upcoming round. */
  pendingWagerCents: number;
  /** Chips already debited from D1 for the upcoming round. */
  escrowCents: number;
  /** Chips the table holds for the round in play. */
  committedCents: number;
  hands: HandState[];
  seatTakenAt: number;
  lastActionAt: number;
  /** Epoch ms a disconnected player's seat stays reserved, else null. */
  graceUntil: number | null;
}

export interface TableState {
  v: number;
  tableId: string;
  name: string;
  phase: Phase;
  phaseStartedAt: number;
  /** Absolute epoch ms deadline; during PLAYER_TURNS this is the active turn's. */
  phaseDueAt: number;
  phaseTotalMs: number;
  seq: number;
  roundId: string;
  shoe: Shoe;
  /** Previously exhausted shoe, revealed so anyone can recompute the commitment. */
  retiredShoe: { id: string; seed: string; order: number[]; commitment: string } | null;
  dealer: { cards: number[]; holeRevealed: boolean };
  seats: (SeatState | null)[];
  turnSeat: number | null;
  turnHandIndex: number;
  settlement: SettlementView | null;
  dealCount: number;
  /** Set when the shoe passes the cut card; honoured at the next betting window. */
  pendingShoeSwap: boolean;
  closedAt: number | null;
  updatedAt: number;
}

interface SocketAttachment {
  userId: number;
  socketId: string;
  connectedAt: number;
}

export class Table extends DurableObject<Env> {
  private state!: TableState;
  private tableCfg!: TableConfig;
  private appCfg!: AppConfig;

  /** Lazy one-shot boot: the DO cannot know its own slug from its id. */
  private boot: Promise<void> | null = null;
  /** Serialising chain — DO handlers re-enter across awaits. */
  private chain: Promise<unknown> = Promise.resolve();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private escrowTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** userId -> last known bankroll for unseated viewers of this table. */
  private viewerBalances = new Map<number, number>();
  private lastHeartbeatAt = 0;

  private readonly betLimiter = new SlidingWindowRateLimiter(RULES.betActionsPerWindow, RULES.betWindowMs, 400);
  private readonly actionLimiter = new SlidingWindowRateLimiter(RULES.gameActionsPerWindow, RULES.gameWindowMs, 400);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Hibernation may construct this class only to deliver one WebSocket frame,
    // so the constructor does no I/O at all.
  }

  // ==========================================================================
  // boot + serialisation
  // ==========================================================================
  /**
   * @param tableIdHint supplied by the Worker on every HTTP/WS entry. Required to
   *   create a table; afterwards the persisted copy is authoritative, which is
   *   what lets hibernation event handlers (which carry no hint) boot too.
   */
  private async ready(tableIdHint?: string): Promise<void> {
    if (this.boot) return this.boot;
    this.boot = (async () => {
      this.appCfg = getConfig(this.env);
      const hint = tableIdHint?.trim();
      let tableId = hint;
      if (!tableId) tableId = (await this.ctx.storage.get<string>(TABLE_ID_KEY)) ?? undefined;
      if (!tableId) throw new Error('TABLE_ID_UNKNOWN: first contact must carry ?table=<id>');
      await this.ctx.storage.put(TABLE_ID_KEY, tableId);

      let cfg = await getTableConfig(this.env.DB, tableId);
      if (!cfg) {
        await ensureDefaultTables(this.env.DB);
        cfg = await getTableConfig(this.env.DB, tableId);
      }
      if (!cfg) throw new Error(`TABLE_NOT_CONFIGURED:${tableId}`);
      this.tableCfg = cfg;

      const stored = await this.ctx.storage.get<TableState>(STATE_KEY);
      if (isTableState(stored) && stored.tableId === tableId) {
        this.state = stored;
        this.tableCfg = { ...cfg, name: stored.name };
        // Whatever deadline elapsed while we were asleep must not be lost.
        if (stored.phase !== 'IDLE' && stored.phaseDueAt <= Date.now()) this.state.phaseDueAt = Date.now() + 400;
      } else {
        this.state = await freshState(cfg);
        await this.ctx.storage.put(STATE_KEY, this.state);
      }
    })();
    try {
      await this.boot;
    } catch (e) {
      // Never cache a failed boot: the next request may well succeed.
      this.boot = null;
      throw e;
    }
  }

  /** Run `fn` after boot, exclusively and in call order. */
  private tx<T>(fn: () => Promise<T>, tableIdHint?: string): Promise<T> {
    const step = this.chain.then(async () => {
      await this.ready(tableIdHint);
      return await fn();
    });
    // Keep the chain alive even when a link rejects.
    this.chain = step.catch(() => undefined);
    return step;
  }

  // ==========================================================================
  // HTTP + WebSocket entry
  // ==========================================================================
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The slug rides along on the path (relayed WebSocket) or ?table= (internal
    // HTTP). It is only a *hint*: the ticket below is what authenticates a caller.
    const hint = tableIdFromPath(url.pathname) ?? url.searchParams.get('table') ?? undefined;

    if ((request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') {
      try {
        return await this.tx(() => this.openSocket(url, request), hint);
      } catch (e) {
        return Response.json({ ok: false, error: (e as Error).message, code: 'SOCKET_REFUSED' } as const, { status: 400 });
      }
    }

    let ctx: { userId: number };
    try {
      await this.ready(hint);
      const verified = await verifyTicket(this.appCfg, url.searchParams.get('ticket'), this.state.tableId);
      if (!verified.ok) {
        return Response.json({ ok: false, error: `ticket ${verified.reason.toLowerCase()}`, code: `TICKET_${verified.reason}` } as const, { status: 401 });
      }
      ctx = { userId: verified.userId };
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message, code: 'BOOT_FAILED' } as const, { status: 400 });
    }

    const userId = ctx.userId;
    if (url.pathname === '/state' || url.pathname === '/') {
      // Both views, so SSR and the socket deliver the identical shape.
      return Response.json({ ok: true, data: { table: this.viewFor(userId), you: this.youFor(userId) } });
    }

    if (url.pathname === '/cmd' && request.method === 'POST') {
      const cmd = (await request.json().catch(() => null)) as ClientMessage | null;
      if (!cmd || typeof cmd.t !== 'string') {
        return Response.json({ ok: false, error: 'bad command', code: 'BAD_COMMAND' } as const, { status: 400 });
      }
      const reply = await this.tx(() => this.handleCommand(userId, cmd), hint);
      // Uniform envelope: `/state`, `/health` and `/cmd` all answer {ok,data}, so
      // the HTTP fallback route never has to guess whether it got a ServerMessage
      // or an error object.
      return Response.json({ ok: true, data: reply });
    }

    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        data: {
          tableId: this.state.tableId,
          phase: this.state.phase,
          seq: this.state.seq,
          roundId: this.state.roundId,
          seated: this.liveSeats().length,
          sockets: this.ctx.getWebSockets().length,
          cardsRemaining: cardsRemaining(this.state.shoe),
          shoeCommitment: this.state.shoe.commitment,
        },
      });
    }

    return new Response('not found', { status: 404 });
  }

  /**
   * Browser handshakes carry no Authorization header, so identity travels as the
   * one-purpose `ticket` query parameter minted by POST /api/tables/:id/socket.
   * A bad ticket returns a plain 401 *before* any socket is created.
   */
  private async openSocket(url: URL, request: Request): Promise<Response> {
    const ticket = url.searchParams.get('ticket');
    const verified = await verifyTicket(this.appCfg, ticket, this.state.tableId);
    if (!verified.ok) {
      return Response.json({ ok: false, error: 'ticket invalid', code: `TICKET_${verified.reason}` } as const, { status: 401 });
    }
    void request; // the upgrade lives on the inbound Request; we mint our own pair

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (!client || !server) return new Response('websocket pair unavailable', { status: 500 });
    const socketId = randomId();

    // Tagged by user so `socketsFor()` is O(theirs) rather than O(everyone).
    this.ctx.acceptWebSocket(server, [`u:${verified.userId}`]);
    const att: SocketAttachment = { userId: verified.userId, socketId, connectedAt: Date.now() };
    server.serializeAttachment(att);

    await this.afterSocketAttached(verified.userId);

    const hello: ServerMessage = {
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      table: this.viewFor(verified.userId),
      you: this.youFor(verified.userId),
      rules: publicRules(),
      serverNow: Date.now(),
    };
    safeSend(server, hello);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ==========================================================================
  // hibernatable WebSocket handlers
  // ==========================================================================
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = attachmentOf(ws);
    if (!att) return closeSocket(ws, 4001, 'unattached socket');
    await this.tx(async () => {
      if (typeof message !== 'string') return closeSocket(ws, 4003, 'binary frames are not part of this protocol');
      if (message.length > 2_000) return closeSocket(ws, 4008, 'frame too large');
      let cmd: ClientMessage;
      try {
        cmd = JSON.parse(message) as ClientMessage;
      } catch {
        return safeSend(ws, { t: 'ack', ok: false, error: 'malformed JSON', code: 'BAD_JSON' });
      }
      if (!cmd || typeof cmd.t !== 'string') return safeSend(ws, { t: 'ack', ok: false, error: 'missing message type', code: 'BAD_MESSAGE' });
      const reply = await this.handleCommand(att.userId, cmd);
      if (reply) safeSend(ws, reply);
    });
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const att = attachmentOf(ws);
    if (!att) return;
    await this.tx(async () => {
      await this.afterSocketDetached(att.userId);
    });
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const att = attachmentOf(ws);
    console.warn('table websocket error', this.state?.tableId ?? '(booting)', (error as Error)?.message ?? String(error));
    if (!att) return;
    await this.tx(async () => {
      await this.afterSocketDetached(att.userId);
    });
  }

  /** Clears reconnect grace and resyncs the fresh socket. */
  private async afterSocketAttached(userId: number): Promise<void> {
    await this.refreshViewerBalance(userId);
    const seat = this.seatOf(userId);
    if (seat) {
      seat.graceUntil = null;
      seat.lastActionAt = Date.now();
      await this.commit({ reason: 'seat', data: { seat: this.seatIndexOf(seat), message: 'reconnected' } });
    } else {
      await this.commit();
    }
  }

  /**
   * Last socket for that player vanished. Their cards are NOT touched: a live
   * hand keeps its stake and simply runs its turn clock out (auto-stand), and the
   * seat is held for `seatReconnectGraceMs` so a reload resumes the same hand.
   */
  private async afterSocketDetached(userId: number): Promise<void> {
    if (this.socketsFor(userId).length > 0) return;
    const seat = this.seatOf(userId);
    if (!seat) {
      await this.maybeStandDown();
      return;
    }
    const midRound = this.state.phase !== 'BETTING' && this.state.phase !== 'IDLE';
    if (midRound) {
      seat.graceUntil = Date.now() + RULES.seatReconnectGraceMs;
      await this.commit({ reason: 'seat', data: { seat: this.seatIndexOf(seat), message: 'connection lost — hand will auto-stand' } });
    } else {
      await this.vacateSeat(seat, true);
      await this.commit({ reason: 'seat', data: { seat: null, message: 'left' } });
    }
    await this.maybeStandDown();
  }

  private socketsFor(userId: number): WebSocket[] {
    return this.ctx.getWebSockets(`u:${userId}`).filter((ws) => attachmentOf(ws)?.userId === userId);
  }

  // ==========================================================================
  // commands
  // ==========================================================================
  private async handleCommand(userId: number, cmd: ClientMessage): Promise<ServerMessage | null> {
    // A hibernation wake drops the in-memory balance cache; refill it lazily so a
    // spectator's wallet never renders as $0 after the DO has been asleep.
    if (!this.seatOf(userId) && !this.viewerBalances.has(userId)) await this.refreshViewerBalance(userId);

    switch (cmd.t) {
      case 'ping':
        return { t: 'pong', ref: cmd.ref, t0: cmd.t0, serverNow: Date.now() };

      case 'resume':
        await this.commit();
        return { t: 'state', state: this.viewFor(userId), you: this.youFor(userId) };

      case 'sit':
        return this.cmdSit(userId, cmd.seat, cmd.ref);

      case 'leave':
        return this.cmdLeave(userId, cmd.ref);

      case 'wager':
      case 'clear_wager': {
        const gate = this.betLimiter.check(`w:${userId}`);
        if (!gate.allowed) return { t: 'ack', ref: cmd.ref, ok: false, error: 'Slow down.', code: 'RATE_LIMITED' };
        const chips = cmd.t === 'clear_wager' ? [] : cmd.chips;
        return this.cmdWager(userId, chips, cmd.ref);
      }

      case 'action': {
        const gate = this.actionLimiter.check(`a:${userId}`);
        if (!gate.allowed) return { t: 'ack', ref: cmd.ref, ok: false, error: 'Slow down.', code: 'RATE_LIMITED' };
        return this.cmdAction(userId, cmd.a, cmd.ref);
      }

      default:
        return {
          t: 'ack',
          ref: (cmd as { ref?: number }).ref,
          ok: false,
          error: `unknown message ${(cmd as { t: string }).t}`,
          code: 'UNKNOWN_MESSAGE',
        };
    }
  }

  private async cmdSit(userId: number, wantedSeat: number | undefined, ref?: number): Promise<ServerMessage> {
    const existing = this.seatOf(userId);
    if (existing) {
      await this.commit();
      return { t: 'state', state: this.viewFor(userId), you: this.youFor(userId) };
    }
    if (this.state.phase !== 'BETTING') {
      return { t: 'ack', ref, ok: false, error: 'A round is running — take a seat when betting opens.', code: 'NOT_BETTING' };
    }

    const row = await getUser(this.env.DB, userId);
    if (!row) return { t: 'ack', ref, ok: false, error: 'Account not found. Re-open the mini app.', code: 'NO_ACCOUNT' };
    if (!row.age_accepted_at) return { t: 'ack', ref, ok: false, error: 'Confirm you are 18 or over to play.', code: 'AGE_GATE_REQUIRED' };
    // Authoritative, not a copy of the route check: the DO is the only writer of
    // seats, and there are two ways in (socket and the HTTP action fallback) plus any
    // future one. A gate that has to be remembered per-route is a gate that leaks.
    if (!this.tableCfg.isPublic) {
      const role = await getMembership(this.env.DB, this.tableCfg.id, userId);
      if (!role) {
        return { t: 'ack', ref, ok: false, error: 'This table is private. Open it from the invite link in your group chat.', code: 'NOT_A_MEMBER' };
      }
    }
    if (row.banned_at) return { t: 'ack', ref, ok: false, error: 'This account is suspended.', code: 'BANNED' };
    if (row.bankroll_cents <= 0) return { t: 'ack', ref, ok: false, error: 'You are out of chips — buy more Stars to rebuy.', code: 'NEED_REBUY' };
    // Seat price of admission. Echo asks for $10, which a $20 welcome stack clears
    // once; a table can demand more than the grant so free chips never buy in.
    if (this.tableCfg.minBankrollCents > 0 && row.bankroll_cents < this.tableCfg.minBankrollCents) {
      return {
        t: 'ack',
        ref,
        ok: false,
        error: `This table needs ${formatCents(this.tableCfg.minBankrollCents)} on hand. You have ${formatCents(row.bankroll_cents)}.`,
        code: 'NEED_SEAT_MINIMUM',
      };
    }

    const idx = this.pickSeat(wantedSeat);
    if (idx === null) return { t: 'ack', ref, ok: false, error: 'This table is full.', code: 'TABLE_FULL' };

    const seat: SeatState = {
      userId,
      displayName: dn(row),
      username: row.username,
      bankrollCents: row.bankroll_cents,
      pendingChips: [],
      pendingWagerCents: 0,
      escrowCents: 0,
      committedCents: 0,
      hands: [],
      seatTakenAt: Date.now(),
      lastActionAt: Date.now(),
      graceUntil: null,
    };
    this.state.seats[idx] = seat;

    await this.commit({ reason: 'seat', data: { seat: idx, message: 'sat down' } });
    return { t: 'state', state: this.viewFor(userId), you: this.youFor(userId) };
  }

  private async cmdLeave(userId: number, ref?: number): Promise<ServerMessage> {
    const seat = this.seatOf(userId);
    if (!seat) return { t: 'ack', ref, ok: false, error: 'You are not seated.', code: 'NOT_SEATED' };
    if (this.state.phase !== 'BETTING') return { t: 'ack', ref, ok: false, error: 'You cannot leave mid-round.', code: 'ROUND_IN_PROGRESS' };
    await this.vacateSeat(seat, true);
    await this.commit({ reason: 'seat', data: { seat: null, message: 'stood up' } });
    await this.maybeStandDown();
    return { t: 'ack', ref, ok: true };
  }

  private async cmdWager(userId: number, chips: number[], ref?: number): Promise<ServerMessage> {
    const seat = this.seatOf(userId);
    if (!seat) return { t: 'ack', ref, ok: false, error: 'Sit down before betting.', code: 'NOT_SEATED' };
    if (this.state.phase !== 'BETTING' || Date.now() >= this.state.phaseDueAt) {
      return { t: 'ack', ref, ok: false, error: 'Betting is closed.', code: 'NOT_BETTING' };
    }

    const norm = normaliseChips(chips, this.tableCfg);
    if (norm.error) return { t: 'ack', ref, ok: false, error: norm.error, code: norm.code ?? 'BAD_WAGER' };

    seat.pendingChips = norm.chips;
    seat.pendingWagerCents = norm.total;
    seat.lastActionAt = Date.now();

    await this.commit();
    // Coalesced escrow: six rapid chip taps cost ONE D1 write, and the wire truth
    // (`escrowCents`) is guaranteed to have caught up before any card is dealt.
    this.armEscrowFlush(seat);
    return { t: 'state', state: this.viewFor(userId), you: this.youFor(userId) };
  }

  private async cmdAction(userId: number, action: 'hit' | 'stand' | 'double' | 'split', ref?: number): Promise<ServerMessage> {
    const s = this.state;
    if (s.phase !== 'PLAYER_TURNS') return { t: 'ack', ref, ok: false, error: 'No hand is in play.', code: 'NOT_YOUR_TURN' };

    const seat = this.seatOf(userId);
    if (!seat) return { t: 'ack', ref, ok: false, error: 'Sit down first.', code: 'NOT_SEATED' };
    if (s.turnSeat === null || s.seats[s.turnSeat] !== seat) return { t: 'ack', ref, ok: false, error: 'It is not your turn.', code: 'NOT_YOUR_TURN' };

    const hand = seat.hands[s.turnHandIndex];
    if (!hand || hand.status === 'stood' || hand.status === 'bust' || hand.status === 'complete') {
      return { t: 'ack', ref, ok: false, error: 'That hand is already finished.', code: 'HAND_COMPLETE' };
    }

    const legality = this.legalityFor(seat, hand);
    if (!legality[action]) {
      return { t: 'ack', ref, ok: false, error: actionDeniedMessage(action, legality), code: `ILLEGAL_${action.toUpperCase()}` };
    }

    // A double or split lays a second stake: move the chips first, mutate second.
    if (action === 'double' || action === 'split') {
      const funded = await this.debitSeat(seat, hand.betCents, `${s.roundId}:${seat.userId}:${hand.index}:${action}`);
      if (!funded) {
        seat.bankrollCents = (await this.readBankroll(seat.userId)) ?? seat.bankrollCents;
        await this.commit();
        return { t: 'ack', ref, ok: false, error: 'Not enough chips for that.', code: 'INSUFFICIENT_BANKROLL' };
      }
    }

    if (action === 'hit') {
      const card = drawCard(s.shoe);
      hand.cards.push(card);
      s.dealCount += 1;
      hand.actions.push('H');
      const t = handTotal(hand.cards);
      if (t.total > 21) {
        hand.status = 'bust';
        hand.outcome = 'bust';
      } else if (t.total === 21) {
        hand.status = 'complete';
      }
      await this.commit({ reason: 'player_action', data: { seat: s.turnSeat, handKey: handKey(seat, hand), action, card, cards: hand.cards.slice() } });
      if (hand.status === 'bust' || hand.status === 'complete') await this.advanceTurn();
    } else if (action === 'stand') {
      hand.actions.push('S');
      hand.status = 'stood';
      await this.commit({ reason: 'player_action', data: { seat: s.turnSeat, handKey: handKey(seat, hand), action } });
      await this.advanceTurn();
    } else if (action === 'double') {
      hand.betCents += hand.originalBetCents;
      hand.doubled = true;
      hand.actions.push('DD');
      const card = drawCard(s.shoe);
      hand.cards.push(card);
      s.dealCount += 1;
      const t = handTotal(hand.cards);
      hand.status = t.total > 21 ? 'bust' : 'complete';
      if (hand.status === 'bust') hand.outcome = 'bust';
      await this.commit({ reason: 'player_action', data: { seat: s.turnSeat, handKey: handKey(seat, hand), action, card } });
      await this.advanceTurn();
    } else {
      // split
      const [kept, moved] = [hand.cards[0]!, hand.cards[1]!];
      const isAcePair = rankIndex(kept) === 0;
      const second: HandState = {
        index: seat.hands.length,
        cards: [moved],
        betCents: hand.originalBetCents,
        originalBetCents: hand.originalBetCents,
        fromSplit: true,
        doubled: false,
        status: 'pending',
        actions: ['P'],
        payoutCents: 0,
        splitAceCapped: isAcePair && RULES.splitAcesOneCard,
      };
      hand.cards = [kept];
      hand.fromSplit = true;
      hand.splitAceCapped = isAcePair && RULES.splitAcesOneCard;
      hand.actions.push('P');
      seat.hands.push(second);

      // Each half draws immediately, exactly like a live table.
      for (const h of [hand, second]) {
        h.cards.push(drawCard(s.shoe));
        s.dealCount += 1;
      }
      for (const h of [hand, second]) {
        if (h.splitAceCapped || handTotal(h.cards).total === 21) {
          // 21 on a split hand is an ordinary 21, and it is stood for free.
          h.status = 'complete';
          h.actions.push('S');
        }
      }
      await this.commit({ reason: 'player_action', data: { seat: s.turnSeat, handKey: handKey(seat, hand), action, cards: [hand.cards[1]!, second.cards[1]!] } });
      await this.advanceTurn();
    }

    return { t: 'state', state: this.viewFor(userId), you: this.youFor(userId) };
  }

  // ==========================================================================
  // escrow
  // ==========================================================================
  private armEscrowFlush(seat: SeatState): void {
    const existing = this.escrowTimers.get(seat.userId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.escrowTimers.delete(seat.userId);
      this.ctx.waitUntil(this.tx(() => this.flushEscrow(seat)));
    }, ESCROW_COALESCE_MS);
    this.escrowTimers.set(seat.userId, t);
  }

  private clearEscrowTimers(): void {
    for (const t of this.escrowTimers.values()) clearTimeout(t);
    this.escrowTimers.clear();
  }

  /** Move `escrowCents` toward the player's chosen wager, in one D1 write. */
  private async flushEscrow(seat: SeatState): Promise<void> {
    const delta = seat.pendingWagerCents - seat.escrowCents;
    if (delta === 0) return;
    const from = seat.escrowCents;
    const to = seat.pendingWagerCents;

    const result = await applyLedgerOp(this.env.DB, {
      userId: seat.userId,
      centsDelta: -delta,
      reason: 'bet',
      idempotencyKey: LedgerKeys.betAdjust(this.state.roundId, seat.userId, this.seatIndexOf(seat), from, to),
      refType: 'round',
      refId: this.state.roundId,
      tableId: this.state.tableId,
      note: delta > 0 ? `wager ${from}->${to}` : `wager lowered ${from}->${to}`,
    });

    if (!result.ok) {
      if (result.code === 'INSUFFICIENT_BANKROLL') {
        // Clamp to what the bankroll really supports rather than dealing a hand
        // the player cannot cover.
        seat.pendingChips = [];
        seat.pendingWagerCents = seat.escrowCents;
        this.pushToUser(seat.userId, { t: 'ack', ok: false, error: 'Not enough chips for that wager.', code: 'INSUFFICIENT_BANKROLL' });
        await this.commit();
      } else {
        console.error('escrow flush failed', this.state.tableId, result.code, result.message);
      }
      return;
    }

    seat.escrowCents = to;
    seat.bankrollCents = result.bankrollCents;
    await this.commit();
  }

  /** Extra stake for a double/split. False means the bankroll refused it. */
  private async debitSeat(seat: SeatState, cents: number, keySuffix: string): Promise<boolean> {
    if (cents <= 0) return true;
    const result = await applyLedgerOp(this.env.DB, {
      userId: seat.userId,
      centsDelta: -cents,
      reason: 'bet',
      idempotencyKey: `bet_x:${keySuffix}`,
      refType: 'round',
      refId: this.state.roundId,
      tableId: this.state.tableId,
      note: 'double/split stake',
    });
    if (!result.ok) return false;
    seat.bankrollCents = result.bankrollCents;
    return true;
  }

  private async readBankroll(userId: number): Promise<number | null> {
    const r = await this.env.DB.prepare(`SELECT bankroll_cents FROM users WHERE telegram_user_id = ?1`).bind(userId).first<{ bankroll_cents: number }>();
    return r?.bankroll_cents ?? null;
  }

  /**
   * Balance cache for players watching a table without a seat. Seated players get
   * an exact figure maintained by the ledger writes themselves; spectators would
   * otherwise render as broke, which is both wrong and a conversion killer.
   */
  private async refreshViewerBalance(userId: number): Promise<void> {
    if (this.seatOf(userId)) return;
    const cents = await this.readBankroll(userId);
    if (cents !== null) this.viewerBalances.set(userId, cents);
  }

  // ==========================================================================
  // the state machine
  // ==========================================================================
  private async scheduleDeadline(dueAt: number | null): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (dueAt === null || dueAt <= 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const delay = Math.max(0, dueAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.ctx.waitUntil(this.tx(() => this.onDeadline()));
    }, delay);
    await this.ctx.storage.setAlarm(new Date(dueAt + ALARM_LAG_MS));
  }

  override async alarm(): Promise<void> {
    await this.tx(() => this.onDeadline());
  }

  /**
   * The single gate through which a phase may advance. Idempotent: it compares
   * the wall clock to the *stored* deadline, so duplicate wakeups (timer + alarm,
   * or a post-eviction replay) collapse to at most one transition.
   */
  private async onDeadline(): Promise<void> {
    const s = this.state;
    if (!s || s.phase === 'IDLE') return;
    const now = Date.now();
    if (now < s.phaseDueAt) {
      // Premature wakeup (alarm jitter, or a timer set before the deadline moved).
      await this.scheduleDeadline(s.phaseDueAt);
      return;
    }
    await this.step();
  }

  private async step(): Promise<void> {
    switch (this.state.phase) {
      case 'BETTING':
        return this.closeBetting();
      case 'DEALING':
        return this.beginPlayerTurns();
      case 'PLAYER_TURNS':
        return this.timeoutCurrentHand();
      case 'DEALER_TURN':
        return this.playDealer();
      case 'SETTLEMENT':
        return this.openBetting();
      default:
        return this.openBetting();
    }
  }

  private async closeBetting(): Promise<void> {
    // Final synchronous escrow pass: no unfunded wager reaches the felt.
    this.clearEscrowTimers();
    for (const seat of this.liveSeats()) {
      if (seat.escrowCents !== seat.pendingWagerCents) await this.flushEscrow(seat);
    }

    const funded: SeatState[] = [];
    for (const seat of this.liveSeats()) {
      if (seat.escrowCents > 0) {
        seat.committedCents = seat.escrowCents;
        seat.escrowCents = 0;
        seat.pendingChips = [];
        seat.pendingWagerCents = 0;
        seat.hands = [
          {
            index: 0,
            cards: [],
            betCents: seat.committedCents,
            originalBetCents: seat.committedCents,
            fromSplit: false,
            doubled: false,
            status: 'pending',
            actions: [],
            payoutCents: 0,
            splitAceCapped: false,
          },
        ];
        funded.push(seat);
      } else if (seat.escrowCents < 0) {
        seat.escrowCents = 0;
      }
    }

    if (funded.length === 0) {
      if (this.ctx.getWebSockets().length === 0 && this.liveSeats().length === 0) return this.standDown();
      // Spectators present: reopen the window without burning a shuffle.
      return this.openBetting();
    }

    await this.enterPhase('DEALING');
    await this.deal();
  }

  private async deal(): Promise<void> {
    const s = this.state;
    s.dealer = { cards: [], holeRevealed: false };
    s.dealCount = 0;

    // Two cards to each wagered hand, then the dealer's up and hole — the physical
    // order, which also fixes which card the blackjack peek reads.
    for (let pass = 0; pass < 2; pass++) {
      for (const seat of fundedSeats(s)) {
        const hand = seat.hands[0];
        if (!hand) continue;
        hand.cards.push(drawCard(s.shoe));
        s.dealCount += 1;
      }
    }
    s.dealer.cards.push(drawCard(s.shoe), drawCard(s.shoe));
    s.dealCount += 2;

    for (const seat of fundedSeats(s)) {
      const hand = seat.hands[0];
      if (hand && isBlackjack(hand.cards, false)) {
        hand.status = 'complete';
        hand.outcome = 'blackjack';
        hand.actions.push('=BJ');
      }
    }

    if (needsShuffle(s.shoe)) s.pendingShoeSwap = true;

    await this.commit({
      reason: 'deal',
      data: { seq: s.seq, cards: s.dealer.cards.slice(0, 1), message: `Upcard ${rankOf(s.dealer.cards[0] ?? 0)}` },
    });
  }

  private async beginPlayerTurns(): Promise<void> {
    const s = this.state;

    // US-style peek: a dealer natural ends the round before anyone can act into it.
    if (RULES.dealerPeeksForBlackjack && dealerCouldHaveBlackjack(s.dealer.cards[0] ?? -1) && isBlackjack(s.dealer.cards, false)) {
      s.dealer.holeRevealed = true;
      await this.commit({ reason: 'dealer_reveal', data: { cards: s.dealer.cards.slice(), message: 'Dealer has blackjack' } });
      await this.enterPhase('SETTLEMENT');
      return this.settle();
    }

    const anyToAct = fundedSeats(s).some((seat) => seat.hands.some((h) => h.status === 'pending' || h.status === 'playing'));
    if (!anyToAct) {
      await this.enterPhase('DEALER_TURN');
      return this.playDealer();
    }

    s.turnSeat = null;
    s.turnHandIndex = 0;
    await this.enterPhase('PLAYER_TURNS');
    return this.advanceTurn();
  }

  /** Advance to the next hand still owed a decision; fall through to the dealer. */
  private async advanceTurn(): Promise<void> {
    const s = this.state;
    if (s.phase !== 'PLAYER_TURNS') return;

    let next: { seat: number; hand: number } | null = null;
    search: for (let seatIdx = 0; seatIdx < s.seats.length; seatIdx++) {
      const seat = s.seats[seatIdx];
      if (!seat || seat.hands.length === 0) continue;
      // Skip hands already played in this pass: only hands strictly after the
      // current cursor (in seat-then-hand order) are eligible.
      const beforeCursor = s.turnSeat === null ? true : seatIdx > s.turnSeat;
      if (!beforeCursor && seatIdx !== s.turnSeat) continue;
      const startHand = seatIdx === s.turnSeat ? s.turnHandIndex + 1 : 0;
      for (let h = startHand; h < seat.hands.length; h++) {
        const hand = seat.hands[h]!;
        if (hand.status === 'pending' || hand.status === 'playing') {
          next = { seat: seatIdx, hand: h };
          break search;
        }
      }
    }

    if (!next) {
      await this.enterPhase('DEALER_TURN');
      return this.playDealer();
    }

    s.turnSeat = next.seat;
    s.turnHandIndex = next.hand;
    const seat = s.seats[next.seat]!;
    const hand = seat.hands[next.hand]!;
    if (hand.status === 'pending') hand.status = 'playing';
    s.phaseStartedAt = Date.now();
    s.phaseTotalMs = RULES.turnSeconds * 1000;
    s.phaseDueAt = s.phaseStartedAt + s.phaseTotalMs;
    await this.commit({ reason: 'turn', data: { seat: next.seat, handKey: handKey(seat, hand), legal: this.legalityFor(seat, hand) } });
  }

  /** Turn clock expired → stand. We never play a hand for an absent player. */
  private async timeoutCurrentHand(): Promise<void> {
    const s = this.state;
    if (s.turnSeat === null) {
      await this.enterPhase('DEALER_TURN');
      return this.playDealer();
    }
    const seat = s.seats[s.turnSeat];
    const hand = seat?.hands[s.turnHandIndex];
    if (hand && (hand.status === 'playing' || hand.status === 'pending')) {
      hand.status = 'stood';
      hand.actions.push('T');
      await this.commit({ reason: 'player_action', data: { seat: s.turnSeat, handKey: handKey(seat!, hand), action: 'stand', message: 'Time — stood automatically' } });
    }
    return this.advanceTurn();
  }

  /** Re-entrant: safe to resume after an eviction mid-draw. */
  private async playDealer(): Promise<void> {
    const s = this.state;
    s.dealer.holeRevealed = true;
    await this.commit({ reason: 'dealer_reveal', data: { cards: s.dealer.cards.slice() } });

    const anyoneLeft = fundedSeats(s).some((seat) => seat.hands.some((h) => h.status !== 'bust'));
    if (anyoneLeft && !isBlackjack(s.dealer.cards, false)) {
      while (dealerMustDraw(s.dealer.cards) && cardsRemaining(s.shoe) > 0) {
        s.dealer.cards.push(drawCard(s.shoe));
        s.dealCount += 1;
        await this.commit({ reason: 'dealer_reveal', data: { cards: s.dealer.cards.slice() } });
        await sleep(DEALER_STEP_MS);
      }
    }

    return this.settle();
  }

  private async settle(): Promise<void> {
    const s = this.state;
    const dealerCards = s.dealer.cards.slice();
    const rows: { seat: SeatState; hand: HandState; result: SettledHand }[] = [];

    for (const seat of fundedSeats(s)) {
      for (const hand of seat.hands) {
        const result = settleHand(
          { cards: hand.cards, betCents: hand.betCents, originalBetCents: hand.originalBetCents, fromSplit: hand.fromSplit, doubled: hand.doubled },
          dealerCards,
        );
        hand.payoutCents = result.payoutCents;
        hand.outcome = result.outcome;
        hand.status = hand.status === 'bust' ? 'bust' : 'complete';
        rows.push({ seat, hand, result });
      }
    }

    // One credit per seat per round instead of per hand: fewer D1 writes, the same
    // totals, and the per-hand detail still lands in `round_hands`.
    interface Bucket {
      seat: SeatState;
      payout: number;
      allPush: boolean;
      detail: string[];
      views: SettlementView['hands'];
    }
    const buckets = new Map<number, Bucket>();
    for (const { seat, hand, result } of rows) {
      const b = buckets.get(seat.userId) ?? { seat, payout: 0, allPush: true, detail: [], views: [] };
      b.payout += result.payoutCents;
      b.allPush &&= result.outcome === 'push';
      b.detail.push(`${result.outcome}:${result.payoutCents}`);
      b.views.push({
        seat: this.seatIndexOf(seat),
        userId: seat.userId,
        displayName: seat.displayName,
        handIndex: hand.index,
        cards: hand.cards.slice(),
        betCents: hand.betCents,
        payoutCents: result.payoutCents,
        netCents: result.netCents,
        outcome: result.outcome,
      });
      buckets.set(seat.userId, b);
    }

    for (const b of buckets.values()) {
      if (b.payout > 0) {
        const r = await applyLedgerOp(this.env.DB, {
          userId: b.seat.userId,
          centsDelta: b.payout,
          reason: b.allPush ? 'payout_push' : 'payout_win',
          idempotencyKey: LedgerKeys.payout(s.roundId, b.seat.userId, this.seatIndexOf(b.seat)),
          refType: 'round',
          refId: s.roundId,
          tableId: s.tableId,
          note: b.detail.join(','),
        });
        if (r.ok) b.seat.bankrollCents = r.bankrollCents;
        else console.error(`payout failed round=${s.roundId} user=${b.seat.userId} code=${r.code}`);
      }
      b.seat.committedCents = 0;
      b.seat.escrowCents = 0;
    }

    const settlement: SettlementView = {
      roundId: s.roundId,
      seq: s.seq,
      dealerCards,
      dealerTotal: handTotal(dealerCards).total,
      hands: [...buckets.values()].flatMap((b) => b.views),
    };
    s.settlement = settlement;

    // History is off the hot path: a slow D1 write must never stall the felt.
    this.ctx.waitUntil(
      recordRound(this.env.DB, {
        id: s.roundId,
        tableId: s.tableId,
        seq: s.seq,
        shoeId: s.shoe.id,
        dealCount: s.dealCount,
        dealerCards,
        wageredCents: rows.reduce((a, x) => a + x.hand.betCents, 0),
        paidCents: rows.reduce((a, x) => a + x.result.payoutCents, 0),
        hands: rows.map(({ seat, hand }) => ({
          userId: seat.userId,
          seat: this.seatIndexOf(seat),
          handIndex: hand.index,
          cards: hand.cards.slice(),
          betCents: hand.betCents,
          payoutCents: hand.payoutCents,
          outcome: hand.outcome ?? 'lose',
          actions: hand.actions.slice(),
        })),
      }).catch((e) => console.error('recordRound failed', s.roundId, e)),
    );

    await this.enterPhase('SETTLEMENT');
    await this.commit({ reason: 'settlement', data: { settlement } });
  }

  private async openBetting(): Promise<void> {
    const s = this.state;

    if (s.pendingShoeSwap || needsShuffle(s.shoe)) {
      // Reveal the exhausted shoe so anyone can recompute its commitment hash.
      const retired = { id: s.shoe.id, seed: s.shoe.seed, order: s.shoe.order.slice(), commitment: s.shoe.commitment };
      s.retiredShoe = retired;
      s.shoe = await createShoe(RULES.decks);
      s.pendingShoeSwap = false;
      await this.commit({ reason: 'shoe_retired', data: { shoe: retired } });
    }

    for (const seat of this.liveSeats()) {
      seat.hands = [];
      seat.committedCents = 0;
      seat.escrowCents = 0;
      seat.pendingWagerCents = 0;
      seat.pendingChips = [];
      const bal = await this.readBankroll(seat.userId);
      if (bal !== null) seat.bankrollCents = bal;
    }
    // Spectators can buy chips while watching; refresh them once per round rather
    // than per broadcast.
    for (const ws of this.ctx.getWebSockets()) {
      const uid = attachmentOf(ws)?.userId;
      if (uid !== undefined && !this.seatOf(uid)) await this.refreshViewerBalance(uid);
    }

    // Release seats whose grace expired and that have no socket.
    let released = false;
    for (let i = 0; i < s.seats.length; i++) {
      const seat = s.seats[i];
      if (!seat) continue;
      const attached = this.socketsFor(seat.userId).length > 0;
      if (!attached && (!seat.graceUntil || seat.graceUntil < Date.now())) {
        s.seats[i] = null;
        released = true;
      }
    }
    if (released) await this.commit({ reason: 'seat', data: { seat: null, message: 'seat released' } });

    s.seq += 1;
    s.roundId = `${s.tableId}:${s.shoe.id}:${s.seq}`;
    s.dealer = { cards: [], holeRevealed: true };
    s.settlement = null;
    s.turnSeat = null;
    s.turnHandIndex = 0;
    await this.enterPhase('BETTING');
  }

  private async enterPhase(phase: Phase): Promise<void> {
    const s = this.state;
    s.phase = phase;
    s.phaseStartedAt = Date.now();
    s.phaseTotalMs = phaseDurationMs(phase);
    s.phaseDueAt = s.phaseStartedAt + s.phaseTotalMs;
    if (phase !== 'PLAYER_TURNS') {
      s.turnSeat = null;
      s.turnHandIndex = 0;
    }
    await this.commit({ reason: 'phase', data: { phase, seq: s.seq } });
  }

  // ==========================================================================
  // idle standdown
  // ==========================================================================
  private async maybeStandDown(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) return;
    if (this.state.phase !== 'BETTING' && this.state.phase !== 'IDLE') return; // never abandon a live round
    if (this.liveSeats().length > 0) return;
    if (this.liveSeats().some((x) => x.escrowCents > 0)) return;
    await this.standDown();
  }

  /**
   * Flush the final snapshot to D1, disarm the timer and delete the alarm. With
   * no sockets and no alarm the runtime reclaims the isolate, and an empty table
   * costs exactly nothing until somebody sits down again — at which point the DO
   * wakes and `ready()` restores the shoe mid-penetration.
   */
  private async standDown(): Promise<void> {
    this.clearEscrowTimers();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.state.phase = 'IDLE';
    this.state.phaseDueAt = 0;
    this.state.phaseTotalMs = 0;
    this.state.closedAt = Date.now();
    this.state.updatedAt = Date.now();
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.ctx.storage.deleteAlarm();

    try {
      await writeHeartbeat(this.env.DB, {
        tableId: this.state.tableId,
        phase: 'IDLE',
        activeSeats: 0,
        snapshot: { dealer: { upCard: null }, seats: [] },
      });
    } catch (e) {
      console.error('standdown heartbeat failed', e);
    }
    for (const ws of this.ctx.getWebSockets()) closeSocket(ws, 1001, 'table idle');
  }

  // ==========================================================================
  // commit = persist -> reschedule -> broadcast -> lobby heartbeat
  // ==========================================================================
  private async commit(event?: { reason: EventKind; data: EventData }): Promise<void> {
    const s = this.state;
    s.updatedAt = Date.now();
    await this.ctx.storage.put(STATE_KEY, s);
    await this.scheduleDeadline(s.phase === 'IDLE' ? null : s.phaseDueAt);

    if (event) this.broadcast({ t: 'event', kind: event.reason, data: event.data, serverNow: Date.now() });
    this.broadcastState();
    this.heartbeat();
  }

  private heartbeat(): void {
    const now = Date.now();
    if (now - this.lastHeartbeatAt < this.appCfg.tableHeartbeatMs) return;
    this.lastHeartbeatAt = now;
    const snapshot = {
      dealer: { upCard: this.state.dealer.cards[0] ?? null },
      seats: this.state.seats.map((x) => (x ? { committedCents: x.committedCents + x.escrowCents + x.pendingWagerCents } : null)),
    };
    this.ctx.waitUntil(
      writeHeartbeat(this.env.DB, {
        tableId: this.state.tableId,
        phase: this.state.phase,
        activeSeats: this.liveSeats().length,
        snapshot,
      }).catch((e) => console.error('heartbeat failed', String(e))),
    );
  }

  // ==========================================================================
  // views
  // ==========================================================================
  private viewFor(userId: number): TableView {
    const s = this.state;
    const reveal = s.dealer.holeRevealed;
    const visibleCards = reveal ? s.dealer.cards.slice() : s.dealer.cards.slice(0, 1);

    const seats: (SeatView | null)[] = s.seats.map((seat, i): SeatView | null => {
      if (!seat) return null;
      const mine = seat.userId === userId;
      return {
        index: i,
        userId: seat.userId,
        displayName: seat.displayName,
        username: seat.username,
        connected: this.socketsFor(seat.userId).length > 0,
        graceUntil: seat.graceUntil,
        committedCents: seat.committedCents,
        // Other players' chip-by-chip tray is noise; show them one stack value.
        pendingChips: mine ? seat.pendingChips : seat.pendingWagerCents > 0 ? [seat.pendingWagerCents] : [],
        hands: seat.hands.map((h): HandView => {
          const t = handTotal(h.cards);
          return {
            key: handKey(seat, h),
            cards: h.cards.slice(),
            total: t.total,
            soft: t.soft,
            betCents: h.betCents,
            status: h.status === 'pending' || h.status === 'playing' ? 'open' : h.status,
            fromSplit: h.fromSplit,
            doubled: h.doubled,
            outcome: h.outcome,
          };
        }),
        isYou: mine,
      };
    });

    const active = this.activeHandOf();
    return {
      tableId: s.tableId,
      name: s.name,
      phase: s.phase,
      seq: s.seq,
      roundId: s.roundId,
      phaseDueAt: s.phaseDueAt,
      phaseDurationMs: s.phaseTotalMs,
      serverNow: Date.now(),
      dealer: {
        upCard: s.dealer.cards[0] ?? null,
        holeRevealed: reveal,
        cards: visibleCards,
        visibleTotal: visibleCards.length ? handTotal(visibleCards).total : null,
      },
      // The permutation itself is never on this object, by construction.
      shoe: {
        id: s.shoe.id,
        cardsRemaining: cardsRemaining(s.shoe),
        shoeSize: s.shoe.order.length,
        penetrationPct: Math.round((s.shoe.pos / s.shoe.order.length) * 100),
        commitment: s.shoe.commitment,
      },
      seats,
      settlement: s.settlement,
      config: {
        buyInCents: this.tableCfg.buyInCents,
        minBetCents: this.tableCfg.minBetCents,
        maxBetCents: this.tableCfg.maxBetCents,
        minBankrollCents: this.tableCfg.minBankrollCents,
        chips: [...RULES.chipDenominations].filter((c) => c <= this.tableCfg.maxBetCents),
        seatCount: this.tableCfg.seatCount,
      },
      activeSeat: s.turnSeat,
      activeHandKey: active ? handKey(active.seat, active.hand) : null,
      turnDueAt: s.phase === 'PLAYER_TURNS' ? s.phaseDueAt : null,
      playerCount: s.seats.filter((x) => x !== null).length,
      houseWarning: this.appCfg.houseWarning,
    };
  }

  private youFor(userId: number): YouView {
    const seat = this.seatOf(userId);
    const active = this.activeHandOf();
    const legal = seat && active && active.seat === seat ? this.legalityFor(seat, active.hand) : null;
    // Spectators (not seated) still have a real balance; it comes from the
    // per-viewer cache warmed at socket attach, not from a seat that isn't there.
    const bankroll = seat?.bankrollCents ?? this.viewerBalances.get(userId) ?? 0;
    return {
      userId,
      seatIndex: seat ? this.seatIndexOf(seat) : null,
      bankrollCents: bankroll,
      escrowCents: seat?.escrowCents ?? 0,
      availableCents: bankroll,
      legal,
      ageAccepted: true,
      needsRebuy: bankroll <= 0,
    };
  }

  private legalityFor(seat: SeatState, hand: HandState): LegalActions {
    return legalActions({
      cards: hand.cards,
      fromSplit: hand.fromSplit,
      splitAceCapped: hand.splitAceCapped,
      availableCents: seat.bankrollCents,
      betCents: hand.betCents,
      seatHandCount: seat.hands.length,
      cardsRemaining: cardsRemaining(this.state.shoe),
      drawCount: hand.actions.length,
    });
  }

  private activeHandOf(): { seat: SeatState; hand: HandState } | null {
    const s = this.state;
    if (s.phase !== 'PLAYER_TURNS' || s.turnSeat === null) return null;
    const seat = s.seats[s.turnSeat];
    const hand = seat?.hands[s.turnHandIndex];
    return seat && hand ? { seat, hand } : null;
  }

  // ==========================================================================
  // sockets
  // ==========================================================================
  private broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) rawSend(ws, text);
  }

  /** Snapshots are per-viewer: bankroll, tray contents and legal actions differ. */
  private broadcastState(): void {
    const byUser = new Map<number, string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachmentOf(ws);
      if (!att) continue;
      let text = byUser.get(att.userId);
      if (text === undefined) {
        text = JSON.stringify({ t: 'state', state: this.viewFor(att.userId), you: this.youFor(att.userId) } satisfies ServerMessage);
        byUser.set(att.userId, text);
      }
      rawSend(ws, text);
    }
  }

  private pushToUser(userId: number, msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const ws of this.socketsFor(userId)) rawSend(ws, text);
  }

  // ==========================================================================
  // seat helpers
  // ==========================================================================
  private liveSeats(): SeatState[] {
    return this.state.seats.filter((x): x is SeatState => x !== null);
  }

  private seatOf(userId: number): SeatState | null {
    return this.state.seats.find((x) => x?.userId === userId) ?? null;
  }

  private seatIndexOf(seat: SeatState): number {
    return this.state.seats.indexOf(seat);
  }

  private pickSeat(wanted?: number): number | null {
    if (wanted !== undefined && Number.isInteger(wanted) && wanted >= 0 && wanted < this.state.seats.length && !this.state.seats[wanted]) {
      return wanted;
    }
    for (let i = 0; i < this.state.seats.length; i++) if (!this.state.seats[i]) return i;
    return null;
  }

  private async vacateSeat(seat: SeatState, returnEscrow: boolean): Promise<void> {
    const idx = this.seatIndexOf(seat);
    if (returnEscrow && seat.escrowCents > 0 && this.state.phase === 'BETTING') {
      const back = seat.escrowCents;
      await applyLedgerOp(this.env.DB, {
        userId: seat.userId,
        centsDelta: back,
        reason: 'bet',
        idempotencyKey: LedgerKeys.betReturn(this.state.roundId, seat.userId, idx, back),
        refType: 'round',
        refId: this.state.roundId,
        tableId: this.state.tableId,
        note: 'left the table',
      });
      seat.escrowCents = 0;
    }
    const timer = this.escrowTimers.get(seat.userId);
    if (timer) {
      clearTimeout(timer);
      this.escrowTimers.delete(seat.userId);
    }
    if (idx >= 0) this.state.seats[idx] = null;
  }
}

// ---------------------------------------------------------------------------
// module helpers
// ---------------------------------------------------------------------------
function fundedSeats(s: TableState): SeatState[] {
  return s.seats.filter((x): x is SeatState => x !== null && x.hands.length > 0);
}

function isTableState(v: unknown): v is TableState {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as TableState).v === STATE_VERSION &&
    Array.isArray((v as TableState).seats) &&
    !!(v as TableState).shoe &&
    typeof (v as TableState).roundId === 'string'
  );
}

async function freshState(cfg: TableConfig): Promise<TableState> {
  const shoe = await createShoe(RULES.decks);
  const now = Date.now();
  return {
    v: STATE_VERSION,
    tableId: cfg.id,
    name: cfg.name,
    phase: 'BETTING',
    phaseStartedAt: now,
    phaseDueAt: now + RULES.bettingSeconds * 1000,
    phaseTotalMs: RULES.bettingSeconds * 1000,
    seq: 1,
    roundId: `${cfg.id}:${shoe.id}:1`,
    shoe,
    retiredShoe: null,
    dealer: { cards: [], holeRevealed: true },
    seats: Array.from({ length: cfg.seatCount }, () => null),
    turnSeat: null,
    turnHandIndex: 0,
    settlement: null,
    dealCount: 0,
    pendingShoeSwap: false,
    closedAt: null,
    updatedAt: now,
  };
}

function attachmentOf(ws: WebSocket): SocketAttachment | null {
  try {
    const att = (ws as unknown as { deserializeAttachment?: () => unknown }).deserializeAttachment?.();
    if (att && typeof att === 'object' && typeof (att as SocketAttachment).userId === 'number') return att as SocketAttachment;
  } catch {
    /* no attachment (e.g. socket accepted before this code shipped) */
  }
  return null;
}

function rawSend(ws: WebSocket, text: string): void {
  try {
    ws.send(text);
  } catch {
    /* hibernated/closing socket — the close handler does the bookkeeping */
  }
}

function safeSend(ws: WebSocket, msg: ServerMessage): void {
  rawSend(ws, JSON.stringify(msg));
}

function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* already closed */
  }
}

function handKey(seat: SeatState, hand: HandState): string {
  return `${seat.userId}:${hand.index}`;
}

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('');
}

export function publicRules(): PublicRules {
  return {
    decks: RULES.decks,
    blackjackPays: '3:2',
    dealerStandsOnSoft17: !RULES.dealerHitsSoft17,
    dealerPeeksForBlackjack: RULES.dealerPeeksForBlackjack,
    doubleOnAnyFirstTwo: RULES.doubleOnAnyFirstTwo,
    doubleAfterSplit: RULES.doubleAfterSplit,
    maxSplitHandsPerSeat: RULES.maxSplitHandsPerSeat,
    insurance: false,
    surrender: false,
    bettingSeconds: RULES.bettingSeconds,
    turnSeconds: RULES.turnSeconds,
  };
}

function actionDeniedMessage(action: string, legality: LegalActions): string {
  switch (legality.blocked[0]) {
    case 'NEED_FUNDS_FOR_DOUBLE':
      return 'Not enough chips to double.';
    case 'NEED_FUNDS_FOR_SPLIT':
      return 'Not enough chips to split.';
    case 'SHOE_EMPTY':
      return 'The shoe is out of cards.';
    case 'BUST':
      return 'That hand is bust.';
    case 'SPLIT_ACE_ONE_CARD':
      return 'Split aces take one card only.';
    default:
      return `You cannot ${action} here.`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { TRANSITION_WATCHDOG_MS };
