// =============================================================================
// Dealer policy + per-action legality. Pure.
// =============================================================================
import { handTotal, ranksMatch, tenValuesMatch } from './hand.ts';
import { RULES } from './rules.ts';

/**
 * House rule as specified: hit to 16, stand on all 17s — soft 17 included.
 * `RULES.dealerHitsSoft17` is the only switch, and turning it on makes the game
 * marginally worse for the player (H17 adds ~0.2% house edge).
 */
export function dealerMustDraw(cards: readonly number[]): boolean {
  const { total, soft } = handTotal(cards);
  if (total <= 11) return true;
  if (total >= 17) {
    if (total === 17 && soft && RULES.dealerHitsSoft17) return true;
    return false;
  }
  return true; // 12..16
}

export function isDealerComplete(cards: readonly number[]): boolean {
  return !dealerMustDraw(cards);
}

/** The dealer's upcard is an Ace or a ten -> a natural is possible, peek now. */
export function dealerCouldHaveBlackjack(upCard: number): boolean {
  return upCard % 52 === 0 || (upCard % 52) % 13 >= 9;
}

export interface ActionContext {
  cards: number[];
  fromSplit: boolean;
  /** Second card came from an ace split and the one-card rule is in force. */
  splitAceCapped?: boolean;
  /** Free bankroll left for a double/split top-up (escrow already taken out). */
  availableCents: number;
  /** Wager already on this hand; a double or split needs to match it again. */
  betCents: number;
  /** Hands this seat already has (split ceiling). */
  seatHandCount: number;
  /** Cards still in the shoe — you cannot split or double into an empty shoe. */
  cardsRemaining: number;
  /** Number of actions already taken on this hand. Reserved for future rules
   *  (late surrender, five-card charlie) and reported in the action trace. */
  drawCount: number;
}

export interface LegalActions {
  hit: boolean;
  stand: boolean;
  double: boolean;
  split: boolean;
  /** Short reason codes the UI turns into tooltips when an action is dead. */
  blocked: string[];
}

/**
 * Exactly one place decides what a player may do. The DO consults this before
 * mutating state and again before broadcasting `legalActions`, so the client's
 * buttons and the server's truth can never diverge.
 */
export function legalActions(ctx: ActionContext): LegalActions {
  const blocked: string[] = [];
  const total = handTotal(ctx.cards).total;
  const firstTwo = ctx.cards.length === 2;

  let hit = true;
  if (ctx.splitAceCapped) {
    hit = false;
    blocked.push('SPLIT_ACE_ONE_CARD');
  }
  if (total > 21) {
    hit = false;
    blocked.push('BUST');
  }
  if (ctx.cardsRemaining < 1) {
    hit = false;
    blocked.push('SHOE_EMPTY');
  }

  // Standing is always available on a live hand; bust hands never reach a turn.
  const stand = total <= 21;
  if (!stand) blocked.push('BUST');

  let dbl = firstTwo && RULES.doubleOnAnyFirstTwo && (RULES.doubleAfterSplit || !ctx.fromSplit);
  if (dbl && ctx.availableCents < ctx.betCents) {
    dbl = false;
    blocked.push('NEED_FUNDS_FOR_DOUBLE');
  }
  if (dbl && ctx.cardsRemaining < 2) {
    dbl = false;
    blocked.push('SHOE_EMPTY');
  }

  let split =
    firstTwo &&
    ctx.seatHandCount < RULES.maxSplitHandsPerSeat &&
    (RULES.splitRequiresSameRank
      ? ranksMatch(ctx.cards[0]!, ctx.cards[1]!)
      : tenValuesMatch(ctx.cards[0]!, ctx.cards[1]!));
  if (split && ctx.availableCents < ctx.betCents) {
    split = false;
    blocked.push('NEED_FUNDS_FOR_SPLIT');
  }
  if (split && ctx.cardsRemaining < 3) {
    split = false;
    blocked.push('SHOE_EMPTY');
  }

  // Insurance and surrender are out of scope for this table: they are simply
  // never produced as legal actions, so no client state can enable them.
  return { hit, stand, double: dbl, split, blocked: [...new Set(blocked)] };
}

/** Was this action legal for a hand at decision time? Used to reject stale input. */
export function assertActionLegal(kind: 'hit' | 'stand' | 'double' | 'split', ctx: ActionContext): true | string {
  const l = legalActions(ctx);
  if (!l[kind]) return l.blocked[0] ?? `ACTION_${kind.toUpperCase()}_ILLEGAL`;
  return true;
}
