// =============================================================================
// GameTable — the live Preact island.
//
// Zero-trust rendering: this component holds no game logic whatsoever. It renders
// `TableView` + `YouView`, and its buttons only *request* actions. The server
// answers with a new snapshot, and if it refused, `you.legal` no longer offers the
// button. There is no client-side rule, payout or card prediction anywhere.
// =============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { TableSocket, type ConnectionStatus } from '../lib/client/socket.ts';
import { api, humanError } from '../lib/client/api.ts';
import { haptic, readyTelegramUi, setViewportVars } from '../lib/client/telegram.ts';
import { formatCents, formatDelta } from '../shared/money.ts';
import { Card } from './Card.tsx';
import { SeatRow } from './SeatRow.tsx';
import { ChipTray } from './ChipTray.tsx';
import type { EventData, EventKind, PlayerAction, PublicRules, ServerMessage, TableView, YouView } from '../shared/protocol.ts';

export interface GameTableProps {
  tableId: string;
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
  PLAYER_TURNS: 'Your move',
  DEALER_TURN: 'Dealer',
  SETTLEMENT: 'Payouts',
  IDLE: 'Table closed',
};

export function GameTable({ tableId, initialState = null, initialYou = null, initialRules = null, houseWarning }: GameTableProps) {
  const [state, setState] = useState<TableView | null>(initialState);
  const [you, setYou] = useState<YouView | null>(initialYou);
  const [rules] = useState<PublicRules | null>(initialRules);
  const [status, setStatus] = useState<ConnectionStatus>(initialState ? 'connecting' : 'connecting');
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [stack, setStack] = useState<number[]>(initialYou ? [] : []);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [revealSettle, setRevealSettle] = useState(false);

  const socketRef = useRef<TableSocket | null>(null);
  const feedId = useRef(0);
  const lastDealRef = useRef<string | null>(null);

  // ------------------------------------------------------------------ feed
  const push = useCallback((kind: EventKind, text: string, tone: FeedItem['tone'] = 'info') => {
    setFeed((prev) => [{ id: ++feedId.current, kind, text, tone }, ...prev].slice(0, 24));
  }, []);

  // ----------------------------------------------------------------- socket
  useEffect(() => {
    readyTelegramUi({ bgColor: '#0c1f17' });
    setViewportVars();

    const sock = new TableSocket(tableId, {
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
        setError(msg.error ?? 'Rejected.');
        haptic('error');
        push('error', msg.error ?? msg.code ?? 'Rejected', 'bad');
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
  }, [tableId]);

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
        case 'settlement':
          setRevealSettle(true);
          haptic('success');
          break;
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
  useEffect(() => {
    const active = state && (state.phase === 'BETTING' || state.phase === 'PLAYER_TURNS' || state.phase === 'SETTLEMENT');
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [state?.phase, state]);

  const remaining = useMemo(() => {
    const sock = socketRef.current;
    if (!state) return { phase: 0, turn: 0 };
    const rem = (dueAt: number | null) => (sock ? sock.remainingMs(dueAt) : Math.max(0, (dueAt ?? 0) - now));
    return { phase: rem(state.phaseDueAt), turn: rem(state.turnDueAt) };
    // `now` re-renders the bar; the socket supplies the drift-corrected value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, now]);

  // Reset the local chip stack when the round changes underneath us.
  useEffect(() => {
    if (!state) return;
    if (lastDealRef.current !== state.roundId && state.phase !== 'BETTING') {
      lastDealRef.current = state.roundId;
    }
  }, [state]);

  // ---------------------------------------------------------------- actions
  const send = useCallback((msg: Parameters<TableSocket['send']>[0]) => {
    const sock = socketRef.current;
    if (sock?.send(msg)) return;
    // Socket down: fall back to HTTP so a player on a flaky mobile link can still
    // stand. Same handler, same authorisation, same server-side checks.
    void api(`/api/tables/${encodeURIComponent(tableId)}/action`, { method: 'POST', body: msg }).catch((e) => setError(humanError(e)));
  }, [tableId]);

  const bet = (next: number[]) => {
    setStack(next);
    send({ t: 'wager', chips: next });
  };

  const act = (a: PlayerAction) => {
    haptic('light');
    send({ t: 'action', a });
  };

  const sit = async (seatIndex?: number) => {
    haptic('medium');
    send({ t: 'sit', ...(seatIndex === undefined ? {} : { seat: seatIndex }) });
    // The socket ack carries errors, but a full/locked table is worth surfacing
    // promptly even if the frame races our own render.
    try {
      await api(`/api/tables/${encodeURIComponent(tableId)}/action`, { method: 'POST', body: { t: 'sit', ...(seatIndex === undefined ? {} : { seat: seatIndex }) } });
    } catch (e) {
      const msg = humanError(e);
      if (msg) setError(msg);
    }
  };

  // ----------------------------------------------------------------- render
  if (!state) {
    return (
      <div class="table table--loading">
        <div class="loader" />
        <p>{status === 'auth-failed' ? 'Re-authenticating with Telegram…' : 'Connecting to the felt…'}</p>
      </div>
    );
  }

  const betting = state.phase === 'BETTING';
  const seated = you?.seatIndex !== null && you?.seatIndex !== undefined;
  const legal = you?.legal ?? null;
  const myActiveHand = seated && state.activeHandKey && state.seats[state.activeSeat ?? -1]?.hands.find((h) => h.key === state.activeHandKey);
  const showControls = Boolean(myActiveHand) && you?.seatIndex === state.activeSeat;
  const progress = state.phaseDurationMs > 0 ? remaining.phase / state.phaseDurationMs : 0;
  const turnProgress = state.turnDueAt ? remaining.turn / (rules?.turnSeconds ?? 15) / 1000 : 0;
  const settlement = revealSettle ? state.settlement : null;

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
          <span class={`status status--${status}`}>
            {status === 'open' ? 'live' : status === 'reconnecting' ? 'reconnecting…' : status === 'auth-failed' ? 're-auth…' : status}
          </span>
        </div>
      </header>

      {/* ------------------------------------------------------- phase bar */}
      <div class={`phasebar phasebar--${state.phase}`}>
        <div class="phasebar__row">
          <strong>{PHASE_LABEL[state.phase] ?? state.phase}</strong>
          <span class="phasebar__clock">
            {betting ? `bets close in ${Math.ceil(remaining.phase / 1000)}s` : state.phase === 'PLAYER_TURNS' ? `${Math.ceil(remaining.turn / 1000)}s` : state.phase === 'SETTLEMENT' ? 'next round soon' : ''}
          </span>
        </div>
        {betting || state.phase === 'SETTLEMENT' ? (
          <div class="phasebar__track">
            <div class="phasebar__fill" style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%` }} />
          </div>
        ) : null}
      </div>

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
        {state.dealer.visibleTotal !== null && state.dealer.holeRevealed ? (
          <span class="dealer__total">{handTotalLabel(state.dealer.cards.length ? state.dealer : null, state.dealer.visibleTotal)}</span>
        ) : state.dealer.cards.length ? (
          <span class="dealer__total dealer__total--up">showing {state.dealer.visibleTotal}</span>
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
            turnProgress={state.activeSeat === i ? turnProgress : 0}
            turnRemainingMs={state.activeSeat === i ? remaining.turn : 0}
            bettingOpen={betting}
            minBetCents={state.config.minBetCents}
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
        ) : showControls && legal ? (
          <div class="controls__actions">
            <ActionButton label="Hit" tone="hit" disabled={!legal.hit || !socketRef.current?.isOpen} onClick={() => act('hit')} />
            <ActionButton label="Stand" tone="stand" disabled={!legal.stand} onClick={() => act('stand')} />
            <ActionButton label="Double" tone="double" disabled={!legal.double} hint={legal.blocked[0]} onClick={() => act('double')} />
            <ActionButton label="Split" tone="split" disabled={!legal.split} hint={legal.blocked[0]} onClick={() => act('split')} />
            <p class="controls__who">
              {myActiveHand ? `${(myActiveHand as { total?: number }).total ?? ''}` : ''} cards · {formatCents(state.seats[state.activeSeat ?? 0]?.hands.find((h) => h.key === state.activeHandKey)?.betCents ?? 0)} at stake
            </p>
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

      <ul class="feed" aria-live="polite">
        {feed.map((f) => (
          <li key={f.id} class={`feed__item feed__item--${f.tone}`}>
            {f.text}
          </li>
        ))}
      </ul>

      {/* ------------------------------------------------------ settlement */}
      {settlement ? (
        <div class="overlay" role="dialog" aria-label="Round result" onClick={() => setRevealSettle(false)}>
          <div class="overlay__card" onClick={(e) => e.stopPropagation()}>
            <h2>Round {settlement.seq}</h2>
            <div class="overlay__dealer">
              {settlement.dealerCards.map((c, i) => (
                <Card key={`${c}-${i}`} id={c} size="sm" index={i} />
              ))}
              <span class="overlay__dt">{settlement.dealerTotal}</span>
            </div>
            <ul class="results">
              {settlement.hands.map((h, i) => (
                <li key={`${h.userId}-${h.handIndex}-${i}`} class={`results__row results__row--${h.outcome}`}>
                  <span class="results__who">{h.displayName}</span>
                  <span class="results__cards">{h.cards.length} cards</span>
                  <span class="results__outcome">{h.outcome}</span>
                  <span class="results__net">{formatDelta(h.netCents)}</span>
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

function handTotalLabel(_d: unknown, total: number): string {
  return String(total);
}

function ActionButton({
  label,
  tone,
  disabled,
  hint,
  onClick,
}: {
  label: string;
  tone: string;
  disabled?: boolean;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" class={`act act--${tone}`} onClick={onClick} disabled={disabled} title={hint ?? ''}>
      {label}
    </button>
  );
}

export type { ServerMessage };
