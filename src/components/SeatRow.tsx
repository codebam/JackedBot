// One seat at the felt. Renders exactly what the Table DO broadcast — it has no
// idea what the next card will be and cannot ask. Every state shown here (turn,
// bust, blackjack, away) is a field the server sent, never a local inference.
import { Card } from './Card.tsx';
import { formatCents } from '../shared/money.ts';
import { OUTCOME_LABEL } from '../game/settlement.ts';
import type { ComponentChildren } from 'preact';
import type { HandView, SeatView } from '../shared/protocol.ts';

export interface SeatRowProps {
  seat: SeatView | null;
  index: number;
  isTurn: boolean;
  /** The server's `activeHandKey`; the authoritative answer to "which hand is playing". */
  activeHandKey: string | null;
  bettingOpen: boolean;
  minBetCents: number;
  /** Present only while betting is open; turns an empty seat into a "sit here" affordance. */
  onSit?: (seatIndex: number) => void;
  /**
   * The turn ring, rendered by the caller so the countdown ticks inside its own
   * subtree. This row therefore never re-renders just because a second passed.
   */
  clock?: ComponentChildren;
}

const OUTCOME_TONE: Record<string, string> = {
  blackjack: 'win',
  win: 'win',
  push: 'push',
  lose: 'lose',
  bust: 'lose',
};

function Hand({ hand, isCurrent }: { hand: HandView; isCurrent: boolean }) {
  const bust = hand.status === 'bust';
  return (
    <div class={`hand${isCurrent ? ' hand--active' : ''}${bust ? ' hand--bust' : ''}`}>
      <div class="hand__cards">
        {hand.cards.length === 0 ? (
          <span class="hand__empty">—</span>
        ) : (
          hand.cards.map((c, i) => <Card key={`${c}-${i}`} id={c} size={hand.cards.length > 4 ? 'sm' : 'md'} index={i} />)
        )}
      </div>
      <div class="hand__foot">
        <span class={`hand__total${bust ? ' hand__total--bust' : ''}`}>
          {hand.soft && !bust && hand.cards.length > 1 ? <em>soft </em> : null}
          {hand.total}
        </span>
        <span class="hand__bet">{formatCents(hand.betCents)}</span>
        {hand.doubled ? <span class="badge badge--dd">DD</span> : null}
        {hand.fromSplit ? <span class="badge badge--split">split</span> : null}
        {/* Which of a split seat's hands is live — a gold left border was the only
            signal before, so it was invisible to a colour-blind player. */}
        {isCurrent ? <span class="badge badge--now">acting</span> : null}
        {/* The server stamps `outcome` the moment a hand busts or makes a natural,
            so this word — not the red tint — is what says "bust" or "blackjack". */}
        {hand.outcome ? <span class={`badge badge--${OUTCOME_TONE[hand.outcome] ?? 'push'}`}>{OUTCOME_LABEL[hand.outcome]}</span> : null}
      </div>
    </div>
  );
}

export function SeatRow({ seat, index, isTurn, activeHandKey, bettingOpen, minBetCents, onSit, clock }: SeatRowProps) {
  if (!seat) {
    const body = (
      <>
        <span class="seat__num">{index + 1}</span>
        <span class="seat__hint">{bettingOpen ? (onSit ? 'Tap to sit here' : 'empty seat') : 'waiting for next round'}</span>
        {bettingOpen ? <span class="seat__min">min {formatCents(minBetCents)}</span> : null}
      </>
    );
    // An empty seat during betting is the most obvious tap target on the screen,
    // so make it one rather than leaving the "Sit down" button as the only route.
    return bettingOpen && onSit ? (
      <button type="button" class="seat seat--empty seat--joinable" onClick={() => onSit(index)}>
        {body}
      </button>
    ) : (
      <div class="seat seat--empty">{body}</div>
    );
  }

  const waiting = seat.graceUntil !== null && seat.graceUntil > Date.now();
  const pot = seat.committedCents || 0;
  const tray = seat.pendingChips.reduce((a, b) => a + b, 0);

  return (
    <div
      class={`seat${isTurn ? ' seat--turn' : ''}${seat.isYou ? ' seat--you' : ''}${waiting ? ' seat--waiting' : ''}`}
      aria-current={isTurn ? 'true' : undefined}
    >
      <div class="seat__head">
        <span class="seat__num">{index + 1}</span>
        <span class="seat__who">
          <b>{seat.displayName}</b>
          {seat.isYou ? <em class="seat__you">you</em> : null}
        </span>
        {/* The turn badge takes the connection slot: while a seat is acting, who is
            acting matters more than whether their socket is warm, and it keeps the
            row height constant so the felt does not jump as the turn moves. */}
        {isTurn ? (
          <span class={`seat__turn${seat.isYou ? ' seat__turn--you' : ''}`}>{seat.isYou ? 'Your turn' : 'Acting'}</span>
        ) : (
          <span class={`seat__conn seat__conn--${seat.connected ? 'on' : waiting ? 'wait' : 'off'}`}>
            {seat.connected ? '' : waiting ? 'reconnecting' : 'away'}
          </span>
        )}
      </div>

      {seat.hands.length === 0 ? (
        <div class="seat__idle">
          {tray > 0 ? <span class="seat__tray">{formatCents(tray)} wagered</span> : <span class="seat__nobet">no wager</span>}
        </div>
      ) : (
        <div class="seat__hands">
          {seat.hands.map((h) => (
            <Hand key={h.key} hand={h} isCurrent={isTurn && activeHandKey !== null && h.key === activeHandKey} />
          ))}
        </div>
      )}

      {pot > 0 ? (
        <div class="seat__pot">
          <span class="chip chip--mini" aria-hidden="true" />
          {formatCents(pot)}
        </div>
      ) : null}

      {clock}
    </div>
  );
}
