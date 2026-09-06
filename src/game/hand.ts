// =============================================================================
// Hand arithmetic. Pure functions — no mutable hand objects here; the Table DO
// owns state, this file only answers questions about a list of card ids.
// =============================================================================
import { faceValue, isAce, isTenValue } from './cards.ts';

export interface HandTotal {
  /** Best non-bust total, or the bust total if over 21. */
  total: number;
  /** True while at least one Ace is still counted as 11. */
  soft: boolean;
  /** Aces still valued at 11 — i.e. precisely what makes this hand "soft".
   *  [A,A] resolves to 12 with aces:1, not aces:2. */
  aces: number;
}

/**
 * Total a hand, resolving aces greedily: count all aces as 11, demote to 1 while
 * over 21. Equivalent to the classic `11*s + 1*(n-s)` search but O(n).
 */
export function handTotal(cards: readonly number[]): HandTotal {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += faceValue(c);
    if (isAce(c)) aces += 1;
  }
  // Aces contributed 11 each; demote (11 -> 1) until we fit under 21.
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0, aces };
}

export function isBust(cards: readonly number[]): boolean {
  return handTotal(cards).total > 21;
}

/**
 * A "natural" 21. Only ever from the initial two cards, and never on a split
 * hand — 21 after a split is an ordinary 21 and pays 1:1.
 */
export function isBlackjack(cards: readonly number[], fromSplit = false): boolean {
  if (fromSplit || cards.length !== 2) return false;
  return handTotal(cards).total === 21;
}

/** Dealer must draw on a 2-card 21 too before we can call it a blackjack. */
export function dealerHasBlackjack(cards: readonly number[]): boolean {
  return isBlackjack(cards, false);
}

/** Split legality: pairs must match by rank, not merely by value (K cannot pair with Q). */
export function ranksMatch(a: number, b: number): boolean {
  return rankIndex(a) === rankIndex(b);
}

/** 0..12 rank index within a deck; suits are cosmetic for rule purposes. */
export function rankIndex(id: number): number {
  return ((id % 52) % 13 + 13) % 13;
}

/** Loose "any two 10s" pairing, kept for the configurable house rule. */
export function tenValuesMatch(a: number, b: number): boolean {
  return isTenValue(a) && isTenValue(b);
}

/**
 * Optimal play for the automatic stand-down of a timed-out or disconnected hand.
 * We deliberately only ever *stand* automatically (see `AUTO_PLAY_ON_TIMEOUT`)
 * so a dropped connection can never make a wagering decision for the player.
 */
export function basicStrategyTotal(cards: readonly number[]): number {
  return handTotal(cards).total;
}

/** Human-facing summary used in the settlement trace. */
export function describeHand(cards: readonly number[]): string {
  const t = handTotal(cards);
  return `${cards.join(',')}=${t.total}${t.soft && t.total <= 21 ? 's' : ''}`;
}
