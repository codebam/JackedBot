// =============================================================================
// Wager validation. Pure, and imported by BOTH the Table DO (authoritative) and
// the client (to disable chips before the player taps them) — one definition of a
// legal wager, so the UI can never offer something the table will reject.
// =============================================================================
import { RULES } from './rules.ts';

export interface WagerLimits {
  minBetCents: number;
  maxBetCents: number;
}

export interface NormalisedWager {
  chips: number[];
  total: number;
  error?: string;
  code?: 'BAD_WAGER' | 'BAD_CHIP' | 'WAGER_TOO_HIGH' | 'WAGER_TOO_LOW';
}

/** Chip ladder a table may offer, given its own maximum. */
export function chipsForTable(maxBetCents: number): number[] {
  const chips = RULES.chipDenominations.filter((c) => c <= maxBetCents);
  // A table whose max sits below the smallest chip still needs one legal button.
  return chips.length ? chips : [RULES.chipDenominations[0]!];
}

/**
 * Reject anything that is not a stack of this game's own denominations summing to
 * a legal wager. Anything not explicitly allowed here is refused, so a client
 * cannot invent a denomination or slip a negative "chip" through.
 */
export function normaliseChips(chips: unknown, limits: WagerLimits): NormalisedWager {
  if (!Array.isArray(chips)) return reject('BAD_WAGER', 'Wager must be a list of chips.');
  if (chips.length > 40) return reject('BAD_WAGER', 'Keep your wager under 40 chips.');

  const out: number[] = [];
  let total = 0;
  for (const c of chips) {
    if (typeof c !== 'number' || !Number.isInteger(c) || c <= 0) return reject('BAD_WAGER', 'Chip values must be positive integers.');
    if (!(RULES.chipDenominations as readonly number[]).includes(c)) return reject('BAD_CHIP', 'Unrecognised chip.');
    if (c > limits.maxBetCents) return reject('BAD_CHIP', 'That chip exceeds the table maximum.');
    out.push(c);
    total += c;
  }

  if (total > limits.maxBetCents) return reject('WAGER_TOO_HIGH', `Table maximum is ${limits.maxBetCents / 100} dollars.`);
  // Zero is legal and means "clear my wager"; any other sub-minimum total is not.
  if (total !== 0 && total < limits.minBetCents) return reject('WAGER_TOO_LOW', `Minimum wager is ${limits.minBetCents / 100} dollars.`);

  return { chips: out, total };
}

function reject(code: NormalisedWager['code'], error: string): NormalisedWager {
  return { chips: [], total: 0, error, code };
}

/**
 * Every chip denomination is even, so every sum of chips is even and `bet * 3/2`
 * is always a whole number of cents. This is the invariant that makes "blackjack
 * pays exactly 3:2" true without a rounding policy; it fails the moment someone
 * adds a 50c or $1.50 chip, so assert it at module load in tests.
 */
export function chipsPreserveBlackjackParity(): boolean {
  return RULES.chipDenominations.every((c) => c % 2 === 0);
}
