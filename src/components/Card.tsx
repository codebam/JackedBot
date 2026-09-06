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

export function Card({ id, faceDown = false, size = 'md', index = 0, highlight = null }: CardProps) {
  const cls = ['card', `card--${size}`];
  if (faceDown || id === null || id === undefined) cls.push('card--back');
  if (highlight) cls.push(`card--${highlight}`);

  if (faceDown || id === null || id === undefined) {
    return (
      <div class={cls.join(' ')} style={{ animationDelay: `${index * 90}ms` }} aria-label="face-down card">
        <div class="card__back-pattern" />
      </div>
    );
  }

  const rank = rankOf(id);
  const suit = suitOf(id);
  const red = suit === 'H' || suit === 'D';
  cls.push(red ? 'card--red' : 'card--black');

  return (
    <div class={cls.join(' ')} style={{ animationDelay: `${index * 90}ms` }} aria-label={`${rank}${GLYPH[suit]}`}>
      <span class="card__corner card__corner--tl">
        <b>{rank}</b>
        <i>{GLYPH[suit]}</i>
      </span>
      <span class={`card__pip${isAce(id) ? ' card__pip--ace' : ''}`}>{GLYPH[suit]}</span>
      <span class="card__corner card__corner--br">
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
