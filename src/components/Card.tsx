// A single playing card. Card data arrives from the server as an integer shoe id
// — the client derives only its face, and can only ever render ids it was sent.
import { suitOf, rankOf, isAce } from '../game/cards.ts';

export interface CardProps {
  id?: number | null;
  faceDown?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** Deal animation stagger index. */
  index?: number;
  highlight?: 'blackjack' | 'bust' | 'win' | 'push' | null;
}

const GLYPH: Record<string, string> = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };

// Spoken forms. A screen reader given `A♠` says "A" and then a glyph it has to
// guess at, so the accessible name is spelled out instead. Presentation only —
// the face still comes from the id the server sent.
const SPOKEN_RANK: Record<string, string> = { A: 'Ace', J: 'Jack', Q: 'Queen', K: 'King' };
const SPOKEN_SUIT: Record<string, string> = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };

function spokenLabel(id: number): string {
  const rank = rankOf(id);
  return `${SPOKEN_RANK[rank] ?? rank} of ${SPOKEN_SUIT[suitOf(id)] ?? ''}`.trim();
}

export function Card({ id, faceDown = false, size = 'md', index = 0, highlight = null }: CardProps) {
  const cls = ['card', `card--${size}`];
  const back = faceDown || id === null || id === undefined;
  if (back) cls.push('card--back');
  if (highlight) cls.push(`card--${highlight}`);

  if (back) {
    return (
      // role="img" is what makes the accessible name actually apply: a bare div
      // with aria-label is skipped by several screen readers.
      <div class={cls.join(' ')} style={{ animationDelay: `${index * 90}ms` }} role="img" aria-label="Face-down card">
        <div class="card__back-pattern" />
      </div>
    );
  }

  const rank = rankOf(id);
  const suit = suitOf(id);
  const red = suit === 'H' || suit === 'D';
  cls.push(red ? 'card--red' : 'card--black');

  return (
    <div class={cls.join(' ')} style={{ animationDelay: `${index * 90}ms` }} role="img" aria-label={spokenLabel(id)}>
      <span class="card__corner card__corner--tl" aria-hidden="true">
        <b>{rank}</b>
        <i>{GLYPH[suit]}</i>
      </span>
      <span class={`card__pip${isAce(id) ? ' card__pip--ace' : ''}`} aria-hidden="true">
        {GLYPH[suit]}
      </span>
      <span class="card__corner card__corner--br" aria-hidden="true">
        <b>{rank}</b>
        <i>{GLYPH[suit]}</i>
      </span>
    </div>
  );
}

/** Compact text form used in the hand-history list. */
export function cardText(id: number): string {
  return `${rankOf(id)}${GLYPH[suitOf(id)] ?? ''}`;
}
