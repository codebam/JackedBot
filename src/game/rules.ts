// =============================================================================
// House rules — the single source of truth for how this table plays.
// Every value is consumed by the Table Durable Object only. The client receives
// the *resolved* legality in its own `legalActions` block and can never negotiate
// a rule change.
// =============================================================================

export const RULES = {
  /** Shoe composition. */
  decks: 6,
  /** Reshuffle once this fraction of the shoe has been dealt (cut card). */
  penetration: 0.75,

  /** Blackjack pays 3:2 as an exact ratio; bet parity guarantees whole cents. */
  blackjackPaysNumerator: 3,
  blackjackPaysDenominator: 2,

  /** "Dealer hits to 16, stands on all 17s" -> S17, soft included. */
  dealerHitsSoft17: false,
  dealerStandsOnAllSeventeens: true,
  dealerMustDrawTo16: true,

  /**
   * US-style peek: the dealer exposes the hole card for a natural before any
   * player acts, so nobody can hit, double or split into a dealer blackjack.
   * Set false for the European no-peek hole-card rule (which loses players an
   * extra double/split stake on the dealer's natural) — the settlement maths
   * below already handles both branches.
   */
  dealerPeeksForBlackjack: true,

  /** Double on any first two cards, and after a split. */
  doubleOnAnyFirstTwo: true,
  doubleAfterSplit: true,
  /** Only the two aces-once constraint that "no re-split" implies. */
  maxSplitHandsPerSeat: 2,
  splitRequiresSameRank: true,
  /** House knob: true = split aces get one card each and are stood automatically. */
  splitAcesOneCard: false,

  /** Explicitly absent, per product spec. */
  insurance: false,
  surrender: false,

  /** Timing (seconds). */
  bettingSeconds: 15,
  dealSeconds: 2,
  turnSeconds: 15,
  dealerPlaySeconds: 1,
  settleSeconds: 6,
  /** Physical seats at the felt. Spec: max 5 per table. */
  seatCount: 5,
  /** Grace period a seat is held for a reconnecting player mid-hand. */
  seatReconnectGraceMs: 90_000,
  /** Idle table with zero sockets flushes to D1 and lets the DO go dormant. */
  tableIdleStanddownMs: 5 * 60_000,

  /** Chip ladder, in cents. All even -> 3:2 blackjack pays in whole cents. */
  chipDenominations: [100, 500, 1_000, 5_000, 10_000, 50_000] as const,
  defaultMinBetCents: 100,
  defaultMaxBetCents: 50_000,
  defaultBuyInCents: 1_000,

  /**
   * One-time free play-money stack for a brand-new account, in cents.
   * $20.00 = exactly two Stars' worth (see RULES.starsToCentsPerStar), which is
   * ~20 minimum bets at the $1 table. Override with WELCOME_GRANT_CENTS; set to
   * 0 to disable the grant entirely.
   */
  welcomeGrantCents: 2_000,

  /** Stars -> play money. 1 Star = $10.00 of chips. Non-reversible. */
  starsToCentsPerStar: 1_000,

  /** Rate limits (sliding window, per user, inside the Table DO). */
  betActionsPerWindow: 12,
  betWindowMs: 1_000,
  gameActionsPerWindow: 8,
  gameWindowMs: 1_000,
} as const;

export type Rules = typeof RULES;

/** Chip values the UI may offer for a given table, filtered by its min/max. */
export function chipsForLimits(minBetCents: number, maxBetCents: number): number[] {
  return RULES.chipDenominations.filter((c) => c <= maxBetCents * 2 && c >= Math.min(minBetCents, 100));
}

/** Sum a stack of chip values into a wager, capped by the table maximum. */
export function wagerFromChips(chips: readonly number[], maxBetCents: number): number {
  const total = chips.reduce((a, b) => a + b, 0);
  return Math.min(total, maxBetCents);
}

export type Phase = 'BETTING' | 'DEALING' | 'PLAYER_TURNS' | 'DEALER_TURN' | 'SETTLEMENT' | 'IDLE';

/** Ordered, so the state machine's `next()` is a table lookup, not an if-chain. */
export const PHASE_ORDER: readonly Phase[] = [
  'BETTING',
  'DEALING',
  'PLAYER_TURNS',
  'DEALER_TURN',
  'SETTLEMENT',
];

export function nextPhase(p: Phase): Phase {
  const i = PHASE_ORDER.indexOf(p);
  if (i === -1 || i === PHASE_ORDER.length - 1) return 'BETTING';
  return PHASE_ORDER[i + 1]!;
}

export function phaseDurationMs(p: Phase): number {
  switch (p) {
    case 'BETTING':
      return RULES.bettingSeconds * 1000;
    case 'DEALING':
      return RULES.dealSeconds * 1000;
    case 'PLAYER_TURNS':
      return RULES.turnSeconds * 1000; // per acting hand; see TurnClock
    case 'DEALER_TURN':
      return RULES.dealerPlaySeconds * 1000;
    case 'SETTLEMENT':
      return RULES.settleSeconds * 1000;
    default:
      return 1000;
  }
}
