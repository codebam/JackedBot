// =============================================================================
// GameTable — the live Preact island.
//
// Zero-trust rendering: this component holds no game logic whatsoever. It renders
// `TableView` + `YouView`, and its buttons only *request* actions. The server
// answers with a new snapshot, and if it refused, `you.legal` no longer offers the
// button. There is no client-side rule, payout or card prediction anywhere.
// =============================================================================
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { TableSocket, type ConnectionStatus } from '../lib/client/socket.ts';
import { api, humanError } from '../lib/client/api.ts';
import { haptic, readyTelegramUi, setViewportVars } from '../lib/client/telegram.ts';
import { formatCents, formatDelta } from '../shared/money.ts';
import { OUTCOME_LABEL } from '../game/settlement.ts';
import { Card } from './Card.tsx';
import { SeatRow } from './SeatRow.tsx';
import { ChipTray } from './ChipTray.tsx';
import type { ClientMessage, EventData, EventKind, PlayerAction, PublicRules, ServerMessage, TableView, YouView } from '../shared/protocol.ts';
// `protocol.ts` imports LegalActions but does not re-export it; the type is pure
// (no Cloudflare imports), so take it from where it is defined.
import type { LegalActions } from '../game/actions.ts';

export interface GameTableProps {
  tableId: string;
  /** Set when the URL carried ?invite= — redeems membership before the ticket mint. */
  redeemInvite?: boolean;
  initialState?: TableView | null;
  initialYou?: YouView | null;
  initialRules?: PublicRules | null;
  houseWarning: string;
}

interface FeedItem {
  id: number;
  kind: EventKind;
  text: string;
  tone: 'info' | 'good' | 'bad' | 'warn';
}

const PHASE_LABEL: Record<string, string> = {
  BETTING: 'Place your bets',
  DEALING: 'Dealing',
  DEALER_TURN: 'Dealer',
  SETTLEMENT: 'Payouts',
  IDLE: 'Table closed',
};

/** Plain words for each socket state. The old labels ("live", "re-auth…") told a
 *  stuck player nothing about what was happening or what they could do. */
const CONN_COPY: Record<ConnectionStatus, string> = {
  connecting: 'Connecting to the table…',
  open: '',
  reconnecting: 'Connection lost — your seat is being held, reconnecting…',
  'auth-failed': 'Telegram session expired — signing you back in…',
  error: 'Connection error — trying again…',
  closed: 'Disconnected from the table.',
};

/** Tiny persistent header chip. The banner carries the sentence; this carries the dot. */
const STATUS_CHIP: Record<ConnectionStatus, string> = {
  connecting: 'connecting',
  open: 'live',
  reconnecting: 'reconnecting',
  'auth-failed': 'session expired',
  error: 'connection error',
  closed: 'offline',
};

/** Statuses worth interrupting the player with a banner and a retry button. */
const CONN_STUCK: ReadonlySet<ConnectionStatus> = new Set(['reconnecting', 'auth-failed', 'error', 'closed']);

/** Server-corrected "ms left on this deadline". */
type Measure = (dueAt: number | null) => number;

/** A push is not a win, and "+$0.00" reads like one at a glance. */
function netLabel(cents: number): string {
  return cents === 0 ? formatCents(0) : formatDelta(cents);
}

/** Fast enough to flip a whole-second label on time, slow enough to stay cheap. */
const TICK_MS = 200;

/**
 * A countdown that re-renders only the element showing it.
 *
 * The table used to tick at 10 Hz from the top, which re-rendered all six seats —
 * and every card in them — ten times a second to change digits that only move once
 * a second. Each countdown now owns its own interval and its own tiny subtree.
 */
function useCountdown(dueAt: number | null, durationMs: number, measure: Measure) {
  const read = useCallback(() => {
    const ms = measure(dueAt);
    return {
      secondsLeft: Math.max(0, Math.ceil(ms / 1000)),
      fraction: durationMs > 0 ? Math.max(0, Math.min(1, ms / durationMs)) : 0,
    };
  }, [dueAt, durationMs, measure]);

  const [tick, setTick] = useState(read);

  useEffect(() => {
    setTick(read());
    if (!dueAt) return;
    const t = setInterval(() => {
      // A backgrounded WebView paints nothing; skipping the tick stops a phone in
      // someone's pocket from burning battery on a table they are not looking at.
      if (typeof document !== 'undefined' && document.hidden) return;
      setTick(read());
    }, TICK_MS);
    return () => clearInterval(t);
  }, [dueAt, read]);

  return tick;
}

function CountdownLabel({ dueAt, measure, format }: { dueAt: number | null; measure: Measure; format: (secondsLeft: number) => string }) {
  const { secondsLeft } = useCountdown(dueAt, 0, measure);
  return <span class="phasebar__clock">{format(secondsLeft)}</span>;
}

function CountdownBar({ dueAt, durationMs, measure }: { dueAt: number | null; durationMs: number; measure: Measure }) {
  const { fraction } = useCountdown(dueAt, durationMs, measure);
  return (
    <div class="phasebar__track">
      <div class="phasebar__fill" style={{ width: `${(fraction * 100).toFixed(2)}%` }} />
    </div>
  );
}

/** The per-seat turn ring: seconds to act plus the conic-gradient it drives. */
function TurnRing({ dueAt, durationMs, measure }: { dueAt: number | null; durationMs: number; measure: Measure }) {
  const { secondsLeft, fraction } = useCountdown(dueAt, durationMs, measure);
  return (
    <div class="seat__clock" aria-label={`${secondsLeft} seconds left to act`}>
      {/* Inline string style: the ring's conic-gradient reads --p, and a string
          keeps Preact's CSSProperties happy without a cast. */}
      <div class="ring" style={`--p: ${fraction.toFixed(3)}`}>
        {secondsLeft}s
      </div>
    </div>
  );
}

/**
 * Why a dead button is dead, in words, on the screen.
 *
 * `title=` is the only place this used to live and a tooltip never appears on a
 * touch device — which is the only device anyone plays on. The reasons themselves
 * are the server's own `legal.blocked` codes: this translates them, it does not
 * decide legality.
 */
function blockedCopy(legal: LegalActions, betCents: number): string | null {
  const notes: string[] = [];
  const blocked = legal.blocked;

  if (blocked.includes('SHOE_EMPTY')) return 'No cards left in the shoe this hand.';
  if (blocked.includes('SPLIT_ACE_ONE_CARD')) notes.push('split aces take one card each');

  const doubleReason = blocked.includes('NEED_FUNDS_FOR_DOUBLE') ? `needs another ${formatCents(betCents)} in chips` : null;
  const splitReason = blocked.includes('NEED_FUNDS_FOR_SPLIT') ? `needs another ${formatCents(betCents)} in chips` : null;
  if (doubleReason) notes.push(`Double ${doubleReason}`);
  if (splitReason) notes.push(`Split ${splitReason}`);

  // No funds/shoe code means the server simply did not offer it — most often
  // because the hand is past its first two cards. Say so without guessing which
  // rule applied: the button state is the server's, and so is the reason.
  if (!notes.length) {
    const off = [!legal.double ? 'Double' : null, !legal.split ? 'Split' : null].filter((x): x is string => x !== null);
    if (off.length) notes.push(`${off.join(' and ')} not offered on this hand`);
  }

  if (!notes.length) return null;
  return `${notes[0]}${notes.length > 1 ? ` · ${notes.slice(1).join(' · ')}` : ''}`;
}

export function GameTable({ tableId, initialState = null, initialYou = null, initialRules = null, houseWarning, redeemInvite = false }: GameTableProps) {
  const [state, setState] = useState<TableView | null>(initialState);
  const [you, setYou] = useState<YouView | null>(initialYou);
  const [rules] = useState<PublicRules | null>(initialRules);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [stack, setStack] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revealSettle, setRevealSettle] = useState(false);

  const socketRef = useRef<TableSocket | null>(null);
  const feedId = useRef(0);
  const youRef = useRef<YouView | null>(initialYou);
  /** The wager we last asked the server for, so a frame that disagrees can be spotted. */
  const sentStackRef = useRef('');
  const overlayRef = useRef<HTMLDivElement>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);

  // ------------------------------------------------------------------ feed
  const push = useCallback((kind: EventKind, text: string, tone: FeedItem['tone'] = 'info') => {
    setFeed((prev) => [{ id: ++feedId.current, kind, text, tone }, ...prev].slice(0, 24));
  }, []);

  /** One reporter for every refusal, whichever transport carried it. */
  const reportRefusal = useCallback(
    (message: string, code?: string) => {
      const text = message || code || 'Rejected.';
      setError(text);
      haptic('error');
      push('error', text, 'bad');
    },
    [push],
  );

  useEffect(() => {
    youRef.current = you;
  }, [you]);

  // ----------------------------------------------------------------- socket
  useEffect(() => {
    readyTelegramUi({ bgColor: '#0c1f17' });
    setViewportVars();

    const sock = new TableSocket(tableId, {
      invite: redeemInvite,
      onState: (s, y) => {
        setState(s);
        setYou(y);
        setError(null);
      },
      onOpen: () => setStatus('open'),
      onStatus: (s) => setStatus(s),
      onEvent: (msg) => handleEvent(msg.kind, msg.data),
      onAck: (msg) => {
        if (msg.ok) return;
        reportRefusal(msg.error ?? 'Rejected.', msg.code);
      },
      onPong: () => setError(null),
    });
    socketRef.current = sock;
    void sock.connect();

    return () => {
      sock.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, redeemInvite]);

  const handleEvent = useCallback(
    (kind: EventKind, data: EventData) => {
      switch (kind) {
        case 'deal':
          haptic('medium');
          push('deal', data.message ?? 'Cards dealt', 'info');
          break;
        case 'phase':
          if (data.phase === 'BETTING') {
            setStack([]);
            sentStackRef.current = '';
            setRevealSettle(false);
            push('phase', 'Betting is open', 'info');
          } else if (data.phase === 'DEALING') {
            push('phase', 'No more bets', 'warn');
          }
          break;
        case 'turn':
          haptic('light');
          break;
        case 'dealer_reveal':
          push('dealer_reveal', `Dealer shows ${data.cards?.length ?? 0} cards`, 'info');
          break;
        case 'settlement': {
          setRevealSettle(true);
          haptic('success');
          // The overlay can be dismissed by one stray tap on the backdrop, so the
          // result also lands in the feed, where it survives.
          const s = data.settlement;
          const me = youRef.current?.userId;
          if (s && me !== undefined) {
            const mine = s.hands.filter((h) => h.userId === me);
            if (mine.length) {
              const net = mine.reduce((acc, h) => acc + h.netCents, 0);
              const label = mine.map((h) => OUTCOME_LABEL[h.outcome]).join(' + ');
              push('settlement', `${label} · ${netLabel(net)}`, net > 0 ? 'good' : net < 0 ? 'bad' : 'info');
            }
          }
          break;
        }
        case 'shoe_retired':
          push('shoe_retired', 'Shoe finished — new 6 decks, seed published', 'info');
          break;
        case 'seat':
          if (data.message) push('seat', data.message, 'info');
          break;
        case 'player_action':
          if (data.message) push('player_action', data.message, 'warn');
          break;
        case 'error':
          push('error', data.message ?? 'error', 'bad');
          break;
      }
    },
    [push],
  );

  // ------------------------------------------------------------- countdowns
  /**
   * Server-corrected "ms left". Stable identity so the countdown components below
   * never re-mount on an unrelated render.
   */
  const measure = useCallback<Measure>((dueAt) => {
    const sock = socketRef.current;
    if (sock) return sock.remainingMs(dueAt);
    if (!dueAt) return 0;
    return Math.max(0, dueAt - Date.now());
  }, []);

  // The server is the only writer of a wager. If the tray's draft is not what we
  // last sent for, the server moved it (a rejected or clamped bet, or a frame that
  // beat our render) and the tray must stop advertising a wager that does not exist.
  useEffect(() => {
    if (!state || state.phase !== 'BETTING') return;
    const seatIndex = you?.seatIndex;
    if (seatIndex === null || seatIndex === undefined) return;
    const seat = state.seats[seatIndex];
    if (!seat) return;
    const server = seat.pendingChips.join(',');
    if (server === sentStackRef.current) return;
    sentStackRef.current = server;
    setStack((prev) => (prev.join(',') === server ? prev : seat.pendingChips.slice()));
  }, [state, you?.seatIndex]);

  // ---------------------------------------------------------------- actions
  const send = useCallback(
    (msg: ClientMessage) => {
      const sock = socketRef.current;
      if (sock?.send(msg)) return;
      // Socket down: fall back to HTTP so a player on a flaky mobile link can still
      // act. Same handler, same authorisation, same server-side checks.
      void api<ServerMessage>(`/api/tables/${encodeURIComponent(tableId)}/action`, { method: 'POST', body: msg })
        .then((reply) => {
          if (!reply) return;
          // The DO wraps every reply in {ok:true,data}, so a *refused* command still
          // arrives as HTTP 200 carrying an ack with ok:false. Handling only thrown
          // errors — as this did before — silently swallowed every one of them: the
          // player tapped Stand, nothing happened, nothing was said.
          if (reply.t === 'ack') {
            if (!reply.ok) reportRefusal(reply.error ?? 'Rejected.', reply.code);
            return;
          }
          // Nothing else will tell this player their action landed. Apply the
          // snapshot the server just returned — but never over a socket that has
          // come back up, whose frames are ordered by the socket itself.
          if (reply.t === 'state' && !socketRef.current?.isOpen) {
            setState(reply.state);
            setYou(reply.you);
          }
        })
        .catch((e) => reportRefusal(humanError(e)));
    },
    [tableId, reportRefusal],
  );

  const bet = useCallback(
    (next: number[]) => {
      setStack(next);
      sentStackRef.current = next.join(',');
      send({ t: 'wager', chips: next });
    },
    [send],
  );

  const act = useCallback(
    (a: PlayerAction) => {
      haptic('light');
      send({ t: 'action', a });
    },
    [send],
  );

  /**
   * Take a seat. Sent exactly once.
   *
   * This used to fire the command over the socket *and* then over HTTP as an
   * "even if the frame races" insurance policy. `send()` already falls back to
   * HTTP when the socket is down, so the second call was never a safety net: on a
   * dead socket it doubled the requests (and the error toast) for one tap, and on
   * a live one it paid a pointless second round trip through D1 and the DO.
   */
  const sit = useCallback(
    (seatIndex?: number) => {
      haptic('medium');
      send({ t: 'sit', ...(seatIndex === undefined ? {} : { seat: seatIndex }) });
    },
    [send],
  );

  /** Force an immediate reconnect instead of waiting out the backoff. */
  const retryConnection = useCallback(() => {
    const sock = socketRef.current;
    if (!sock) return;
    haptic('light');
    // close() first: it clears the pending backoff timer. Calling connect() on its
    // own would leave that timer armed and stack a second socket on the first.
    sock.close();
    void sock.connect();
  }, []);

  // --------------------------------------------------------- settlement modal
  const settlement = state && revealSettle ? state.settlement : null;
  // Keyed on the round, not the object: SETTLEMENT broadcasts several frames for
  // the same result, and re-running the effect on each would steal focus back from
  // the player and overwrite the element we are supposed to restore focus to.
  const settlementKey = settlement ? `${settlement.roundId}:${settlement.seq}` : null;

  useEffect(() => {
    if (!settlementKey) return;
    const node = overlayRef.current;
    focusReturnRef.current = (document.activeElement as HTMLElement | null) ?? null;

    const focusable = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [],
      );

    // Land on the primary action so a keyboard or TalkBack player is not left
    // behind the dialog.
    const initial = focusable();
    (initial[initial.length - 1] ?? node)?.focus?.();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setRevealSettle(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (!node?.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      focusReturnRef.current?.focus?.();
      focusReturnRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settlementKey]);

  // ----------------------------------------------------------------- render
  if (!state) {
    const stuck = CONN_STUCK.has(status);
    return (
      <div class="table table--loading">
        <div class="loader" />
        <p>{CONN_COPY[status] || 'Connecting to the felt…'}</p>
        {error ? <p class="alert">{error}</p> : null}
        {/* A spinner with no way out is how a player ends up force-closing the app.
            If the socket has given up, offer the two real exits. */}
        {stuck ? (
          <div class="loader__actions">
            <button class="btn btn--primary" type="button" onClick={retryConnection}>
              Try again
            </button>
            <a class="btn btn--ghost" href="/">
              Back to the lobby
            </a>
          </div>
        ) : null}
      </div>
    );
  }

  const betting = state.phase === 'BETTING';
  const seatIndex = you?.seatIndex ?? null;
  const seated = seatIndex !== null;
  const legal = you?.legal ?? null;
  const mySeat = seated ? state.seats[seatIndex] ?? null : null;
  const myTurn = state.phase === 'PLAYER_TURNS' && state.activeSeat !== null && state.activeSeat === seatIndex;
  const activeSeat = state.activeSeat !== null ? state.seats[state.activeSeat] ?? null : null;
  const myActiveHand = myTurn && state.activeHandKey ? mySeat?.hands.find((h) => h.key === state.activeHandKey) ?? null : null;
  const showControls = myActiveHand !== null && legal !== null;
  const why = myActiveHand && legal ? blockedCopy(legal, myActiveHand.betCents) : null;
  const connDown = CONN_STUCK.has(status);

  // The turn clock's denominator is the server's own phase length, not a client
  // constant: `turnDueAt` is `phaseDueAt` during PLAYER_TURNS, and `phaseDurationMs`
  // is that phase's total, so the ring and the deadline can never disagree.
  const turnDurationMs = state.phaseDurationMs > 0 ? state.phaseDurationMs : (rules?.turnSeconds ?? 15) * 1000;

  const phaseLabel =
    state.phase === 'PLAYER_TURNS'
      ? myTurn
        ? 'Your move'
        : activeSeat
          ? `Waiting on ${activeSeat.displayName}`
          : 'In play'
      : PHASE_LABEL[state.phase] ?? state.phase;

  return (
    <div class="table" data-phase={state.phase}>
      {/* ---------------------------------------------------------- header */}
      <header class="table__head">
        <div class="table__id">
          <h1>{state.name}</h1>
          <span class="table__meta">
            round #{state.seq} · shoe {state.shoe.cardsRemaining}/{state.shoe.shoeSize} ({state.shoe.penetrationPct}%)
          </span>
        </div>
        <div class="table__wallet">
          <span class="table__bal">{formatCents(you?.bankrollCents ?? 0)}</span>
          <span class={`status status--${status}`}>{STATUS_CHIP[status]}</span>
        </div>
      </header>

      {/* ------------------------------------------------------- phase bar */}
      <div class={`phasebar phasebar--${state.phase}`}>
        <div class="phasebar__row">
          <strong>{phaseLabel}</strong>
          {betting ? (
            <CountdownLabel dueAt={state.phaseDueAt} measure={measure} format={(s) => `bets close in ${s}s`} />
          ) : state.phase === 'PLAYER_TURNS' ? (
            <CountdownLabel dueAt={state.turnDueAt} measure={measure} format={(s) => (myTurn ? `${s}s to act` : `${s}s`)} />
          ) : (
            <span class="phasebar__clock">{state.phase === 'SETTLEMENT' ? 'next round soon' : ''}</span>
          )}
        </div>
        {state.phaseDurationMs > 0 ? <CountdownBar dueAt={state.phaseDueAt} durationMs={state.phaseDurationMs} measure={measure} /> : null}
      </div>

      {/* ------------------------------------------------------ connection */}
      {connDown ? (
        <div class="connbar" role="status">
          <span class="connbar__msg">{CONN_COPY[status] ?? CONN_COPY.reconnecting}</span>
          <button class="btn btn--ghost btn--sm connbar__btn" type="button" onClick={retryConnection}>
            Retry
          </button>
        </div>
      ) : null}

      {error ? <p class="alert">{error}</p> : null}
      {you?.needsRebuy && !seated ? (
        <p class="alert alert--gold">
          No chips on account. Buy 1 ⭐ for {formatCents(state.config.buyInCents * 10)} of play money — or grab the free starter
          stack from the lobby.
        </p>
      ) : null}

      {/* ---------------------------------------------------------- dealer */}
      <section class="dealer">
        <div class="dealer__label">
          Dealer stands on all 17s{rules?.dealerPeeksForBlackjack ? ' · peeks for blackjack' : ''}
        </div>
        <div class="dealer__cards">
          {state.dealer.cards.length === 0 ? <span class="dealer__wait">waiting</span> : null}
          {state.dealer.cards.map((c, i) => (
            <Card key={`d${c}-${i}`} id={c} size="md" index={i} />
          ))}
          {/* The hole card is not in the payload until the server reveals it, so a
              second face-down slot is derived purely from card count. */}
          {!state.dealer.holeRevealed && state.dealer.cards.length === 1 ? <Card faceDown size="md" index={1} /> : null}
        </div>
        {/* `DealerView` carries `visibleTotal` and no `soft` flag (unlike `HandView`),
            so the number is shown exactly as sent. Calling a 17 "soft" would mean
            re-totaling the dealer's cards here, which the zero-trust rule forbids. */}
        {state.dealer.visibleTotal !== null && state.dealer.cards.length ? (
          <span class={`dealer__total${state.dealer.holeRevealed ? '' : ' dealer__total--up'}`}>
            {state.dealer.holeRevealed ? `dealer ${state.dealer.visibleTotal}` : `showing ${state.dealer.visibleTotal}`}
          </span>
        ) : null}
      </section>

      {/* ----------------------------------------------------------- seats */}
      <section class="seats">
        {state.seats.map((seat, i) => (
          <SeatRow
            key={i}
            seat={seat}
            index={i}
            isTurn={state.activeSeat === i && state.phase === 'PLAYER_TURNS'}
            activeHandKey={state.activeHandKey}
            bettingOpen={betting}
            minBetCents={state.config.minBetCents}
            // Only an unseated player is offered a chair; for anyone already at the
            // table an empty seat is scenery, not a button.
            onSit={seated || !betting ? undefined : sit}
            clock={
              state.activeSeat === i && state.phase === 'PLAYER_TURNS' ? (
                <TurnRing dueAt={state.turnDueAt} durationMs={turnDurationMs} measure={measure} />
              ) : null
            }
          />
        ))}
      </section>

      {/* -------------------------------------------------------- controls */}
      <section class="controls">
        {!seated ? (
          <div class="controls__sit">
            <p class="controls__hint">
              {betting ? 'Take a seat to play this round.' : 'Seating opens between rounds.'}
              {state.config.minBankrollCents > 0 ? ` Requires ${formatCents(state.config.minBankrollCents)} on hand.` : ''}
            </p>
            <button class="btn btn--primary btn--block" type="button" disabled={!betting} onClick={() => sit()}>
              Sit down
            </button>
          </div>
        ) : showControls && legal && myActiveHand ? (
          <div class="controls__actions">
            {/* Hit is deliberately not gated on the socket: `send()` falls back to
                HTTP, and greying out the one button a player needs during a drop is
                exactly when they need it. Stand was never gated, so neither is Hit. */}
            <ActionButton label="Hit" tone="hit" disabled={!legal.hit} onClick={() => act('hit')} />
            <ActionButton label="Stand" tone="stand" disabled={!legal.stand} onClick={() => act('stand')} />
            <ActionButton label="Double" tone="double" disabled={!legal.double} onClick={() => act('double')} />
            <ActionButton label="Split" tone="split" disabled={!legal.split} onClick={() => act('split')} />
            {/* Three separate facts, labelled. This line used to read "17 cards ·
                $10.00 at stake" because it printed the hand total where the card
                count belonged. */}
            <p class="controls__who" id="controls-who">
              <span class="controls__fact">
                hand <b>{myActiveHand.soft && myActiveHand.status !== 'bust' ? `soft ${myActiveHand.total}` : myActiveHand.total}</b>
              </span>
              <span class="controls__fact">
                <b>{myActiveHand.cards.length}</b> cards
              </span>
              <span class="controls__fact">
                <b>{formatCents(myActiveHand.betCents)}</b> at stake
              </span>
            </p>
            {why ? <p class="controls__why">{why}</p> : null}
          </div>
        ) : betting ? (
          <ChipTray
            chips={state.config.chips}
            stack={stack}
            minBetCents={state.config.minBetCents}
            maxBetCents={state.config.maxBetCents}
            availableCents={you?.availableCents ?? 0}
            onChange={setStack}
            onSend={bet}
          />
        ) : (
          <p class="controls__wait">
            {state.phase === 'SETTLEMENT' ? 'Collecting chips…' : you?.escrowCents ? `Wager locked: ${formatCents(you.escrowCents)}` : 'Waiting for the action…'}
          </p>
        )}
        {seated && betting ? (
          <button class="btn btn--ghost btn--sm controls__leave" type="button" onClick={() => send({ t: 'leave' })}>
            Leave table
          </button>
        ) : null}
      </section>

      {/* -------------------------------------------------------- feed/rules */}
      <details class="sheet">
        <summary>Table rules &amp; fairness</summary>
        <ul class="sheet__list">
          <li>{rules?.decks ?? 6} decks · reshuffled at 75% penetration</li>
          <li>Blackjack pays {rules?.blackjackPays ?? '3:2'}</li>
          <li>Double any two cards{rules?.doubleAfterSplit ? ' · after split' : ''}</li>
          <li>Split once ({rules?.maxSplitHandsPerSeat ?? 2} hands max)</li>
          <li>No insurance · no surrender</li>
          <li class="sheet__fair">
            Shoe commitment <code>{state.shoe.commitment.slice(0, 16)}…</code> — published before play, seed revealed when the shoe
            retires, so you can verify the order was fixed in advance.
          </li>
          <li class="sheet__warn">{houseWarning}</li>
        </ul>
      </details>

      {/* role=log with additions-only relevance: the newest entry is prepended, and
          a plain aria-live region makes a screen reader re-read the whole list on
          every deal. */}
      <ul class="feed" role="log" aria-label="Table activity" aria-live="polite" aria-relevant="additions" aria-atomic="false">
        {feed.map((f) => (
          <li key={f.id} class={`feed__item feed__item--${f.tone}`}>
            {f.text}
          </li>
        ))}
      </ul>

      {/* ------------------------------------------------------ settlement */}
      {settlement ? (
        <div
          class="overlay"
          ref={overlayRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="settle-title"
          onClick={() => setRevealSettle(false)}
        >
          <div class="overlay__card" onClick={(e) => e.stopPropagation()}>
            <h2 id="settle-title">Round {settlement.seq}</h2>
            <div class="overlay__dealer">
              {settlement.dealerCards.map((c, i) => (
                <Card key={`${c}-${i}`} id={c} size="sm" index={i} />
              ))}
              <span class="overlay__dt">dealer {settlement.dealerTotal}</span>
            </div>
            <ul class="results">
              {settlement.hands.map((h, i) => (
                <li
                  key={`${h.userId}-${h.handIndex}-${i}`}
                  class={`results__row results__row--${h.outcome}${h.userId === you?.userId ? ' results__row--mine' : ''}`}
                >
                  <span class="results__who">
                    {h.displayName}
                    {h.userId === you?.userId ? <em class="results__you">you</em> : null}
                  </span>
                  <span class="results__cards">{h.cards.length} cards</span>
                  <span class="results__outcome">{OUTCOME_LABEL[h.outcome]}</span>
                  <span class="results__net">{netLabel(h.netCents)}</span>
                </li>
              ))}
            </ul>
            <button class="btn btn--primary btn--block" type="button" onClick={() => setRevealSettle(false)}>
              Continue
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ActionButton({ label, tone, disabled, onClick }: { label: string; tone: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" class={`act act--${tone}`} onClick={onClick} disabled={disabled} aria-describedby="controls-who">
      {label}
    </button>
  );
}

export type { ServerMessage };
