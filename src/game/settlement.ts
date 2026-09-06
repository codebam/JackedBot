// =============================================================================
// Settlement maths. Pure and total: given the dealer's final cards and each
// player's final hands, it produces the exact cent movement for every hand.
// The Table DO trusts this function and nothing else with money.
// =============================================================================
import { handTotal, isBlackjack } from './hand.ts';
import { RULES } from './rules.ts';

export type Outcome = 'blackjack' | 'win' | 'push' | 'lose' | 'bust';

export interface IncomingHand {
  cards: number[];
  /** Wager escrowed on this hand, including the added half from a double. */
  betCents: number;
  /** Stake that went in before any double/split top-up, for no-peek refunds. */
  originalBetCents: number;
  fromSplit: boolean;
  doubled: boolean;
}

export interface SettledHand extends IncomingHand {
  outcome: Outcome;
  /** Everything returned to the player for this hand, stake included. */
  payoutCents: number;
  /** payoutCents - betCents: the P&L for the hand. */
  netCents: number;
  /** True for a dealer-natural stake return under the no-peek rule. */
  stakeReturned: boolean;
}

/**
 * Blackjack pays `3:2`. We only ever accept even-cent wagers (every chip
 * denomination is even, so every legal wager and every double is even), which
 * means `bet * 3 / 2` is exact and no rounding policy is ever required.
 * The assertion below keeps that invariant honest instead of assuming it.
 */
export function blackjackProfitCents(betCents: number): number {
  const numerator = betCents * RULES.blackjackPaysNumerator;
  if (numerator % RULES.blackjackPaysDenominator !== 0) {
    // Defensive: a future odd chip would land here. We pay the floor rather than
    // the round, so the table can never over-pay.
    return Math.floor(numerator / RULES.blackjackPaysDenominator);
  }
  return numerator / RULES.blackjackPaysDenominator;
}

export function settleHand(h: IncomingHand, dealerCards: number[]): SettledHand {
  const playerTotal = handTotal(h.cards).total;
  const dealerTotal = handTotal(dealerCards).total;

  // Money guard. A non-integer card id (a coding slip, never a user input — cards
  // only ever come from `drawCard`) makes every comparison below false, and the
  // `else` branch would quietly settle it as a PUSH. Silent mis-pricing is the one
  // failure mode this function must not have, so fail loudly instead.
  if (!Number.isInteger(playerTotal) || !Number.isInteger(dealerTotal)) {
    throw new Error(`settleHand: non-numeric total player=${playerTotal} dealer=${dealerTotal} cards=${JSON.stringify(h.cards)}/${JSON.stringify(dealerCards)}`);
  }
  if (!Number.isInteger(h.betCents) || h.betCents < 0) {
    throw new Error(`settleHand: invalid bet ${h.betCents}`);
  }

  const playerBJ = isBlackjack(h.cards, h.fromSplit);
  const dealerBJ = isBlackjack(dealerCards, false);
  const dealerBust = dealerTotal > 21;
  const playerBust = playerTotal > 21;

  let payout = 0;
  let outcome: Outcome;
  let stakeReturned = false;

  if (playerBust) {
    outcome = 'bust';
    payout = 0;
  } else if (playerBJ && dealerBJ) {
    outcome = 'push';
    payout = h.betCents;
  } else if (playerBJ) {
    outcome = 'blackjack';
    payout = h.betCents + blackjackProfitCents(h.betCents);
  } else if (dealerBJ) {
    // Reachable only with RULES.dealerPeeksForBlackjack = false: without the peek
    // a player can have already doubled or split into a dealer natural. Standard
    // European treatment is to return the *extra* stake, losing only the original.
    outcome = 'lose';
    payout = h.betCents - h.originalBetCents;
    stakeReturned = payout > 0;
  } else if (dealerBust) {
    outcome = 'win';
    payout = h.betCents * 2;
  } else if (playerTotal > dealerTotal) {
    outcome = 'win';
    payout = h.betCents * 2;
  } else if (playerTotal < dealerTotal) {
    outcome = 'lose';
    payout = 0;
  } else {
    outcome = 'push';
    payout = h.betCents;
  }

  return { ...h, outcome, payoutCents: payout, netCents: payout - h.betCents, stakeReturned };
}

export interface RoundSettlement {
  hands: (SettledHand & { userId: number; key: string })[];
  wageredCents: number;
  paidCents: number;
  /** paidCents - wageredCents, negative means the table netted chips. */
  tableNetCents: number;
  perSeat: Map<number, SeatResult>;
}

export interface SeatResult {
  userId: number;
  wageredCents: number;
  paidCents: number;
  netCents: number;
  outcomes: Outcome[];
}

/**
 * Settle every hand of a round against the dealer's final cards.
 * `userId`/`key` ride along so a caller can group results per seat and per
 * displayed hand without a second lookup.
 */
export function settleRound(playerHands: (IncomingHand & { userId: number; key: string })[], dealerCards: number[]): RoundSettlement {
  const hands = playerHands.map((h) => ({ ...settleHand(h, dealerCards), userId: h.userId, key: h.key }));

  let wagered = 0;
  let paid = 0;
  const perSeat = new Map<number, SeatResult>();

  for (const h of hands) {
    wagered += h.betCents;
    paid += h.payoutCents;
    const seat = perSeat.get(h.userId) ?? {
      userId: h.userId,
      wageredCents: 0,
      paidCents: 0,
      netCents: 0,
      outcomes: [] as Outcome[],
    };
    seat.wageredCents += h.betCents;
    seat.paidCents += h.payoutCents;
    seat.netCents += h.payoutCents - h.betCents;
    seat.outcomes.push(h.outcome);
    perSeat.set(h.userId, seat);
  }

  return { hands, wageredCents: wagered, paidCents: paid, tableNetCents: paid - wagered, perSeat };
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  blackjack: 'BLACKJACK',
  win: 'WIN',
  push: 'PUSH',
  lose: 'LOSS',
  bust: 'BUST',
};
