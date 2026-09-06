// One seat at the felt. Renders exactly what the Table DO broadcast — it has no
// idea what the next card will be and cannot ask.
import { Card } from './Card.tsx';
import { formatCents } from '../shared/money.ts';
import type { HandView, SeatView } from '../shared/protocol.ts';

export interface SeatRowProps {
  seat: SeatView | null;
  index: number;
  isTurn: boolean;
  /** 0..1 remaining fraction of this seat's turn clock. */
  turnProgress: number;
  /** Ms left, already corrected against the server clock. */
  turnRemainingMs: number;
  bettingOpen: boolean;
  minBetCents: number;
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
          {hand.total}
          {hand.soft && !bust && hand.cards.length > 1 ? <em> soft</em> : null}
        </span>
        <span class="hand__bet">{formatCents(hand.betCents)}</span>
        {hand.doubled ? <span class="badge badge--dd">DD</span> : null}
        {hand.fromSplit ? <span class="badge badge--split">split</span> : null}
        {hand.outcome ? <span class={`badge badge--${OUTCOME_TONE[hand.outcome] ?? 'push'}`}>{hand.outcome}</span> : null}
      </div>
    </div>
  );
}

export function SeatRow({ seat, index, isTurn, turnProgress, turnRemainingMs, bettingOpen, minBetCents }: SeatRowProps) {
  if (!seat) {
    return (
      <div class="seat seat--empty">
        <span class="seat__num">{index + 1}</span>
        <span class="seat__hint">{bettingOpen ? 'empty seat' : 'waiting for next round'}</span>
        {bettingOpen ? <span class="seat__min">min {formatCents(minBetCents)}</span> : null}
      </div>
    );
  }

  const waiting = seat.graceUntil && seat.graceUntil > Date.now();
  const pot = seat.committedCents || 0;
  const tray = seat.pendingChips.reduce((a, b) => a + b, 0);

  return (
    <div class={`seat${isTurn ? ' seat--turn' : ''}${seat.isYou ? ' seat--you' : ''}${waiting ? ' seat--waiting' : ''}`}>
      <div class="seat__head">
        <span class="seat__num">{index + 1}</span>
        <span class="seat__who">
          <b>{seat.displayName}</b>
          {seat.isYou ? <em class="seat__you">you</em> : null}
        </span>
        <span class={`seat__conn seat__conn--${seat.connected ? 'on' : waiting ? 'wait' : 'off'}`}>
          {seat.connected ? '' : waiting ? 'reconnecting' : 'away'}
        </span>
      </div>

      {seat.hands.length === 0 ? (
        <div class="seat__idle">
          {tray > 0 ? <span class="seat__tray">{formatCents(tray)} wagered</span> : <span class="seat__nobet">no wager</span>}
        </div>
      ) : (
        <div class="seat__hands">
          {seat.hands.map((h, i) => (
            <Hand key={h.key} hand={h} isCurrent={isTurn && i === seat.hands.findIndex((x) => x.status === 'open')} />
          ))}
        </div>
      )}

      {pot > 0 ? (
        <div class="seat__pot">
          <span class="chip chip--mini" />
          {formatCents(pot)}
        </div>
      ) : null}

      {isTurn ? (
        <div class="seat__clock" aria-label="time left to act">
          {/* Inline string style: the ring's conic-gradient reads --p, and a string
              keeps Preact's CSSProperties happy without a cast. */}
          <div class="ring" style={`--p: ${Math.max(0, Math.min(1, turnProgress))}`}>{Math.ceil(turnRemainingMs / 1000)}s</div>
        </div>
      ) : null}
    </div>
  );
}
