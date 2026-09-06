// =============================================================================
// Stake validation for owner-configured private tables.
//
// "Full control" over a table that moves chips cannot mean "whatever you typed".
// Every field is clamped to a band the game engine and the Stars economy can
// actually live inside, and the result is a discriminated union so a caller
// cannot forget to check it. This module is pure: no DB, no Request, no config —
// which is what makes the table-creation rules testable without workerd.
// =============================================================================

/** Hard bounds. `MAX_SEATS` mirrors the schema CHECK on tables.seat_count. */
export const STAKE_LIMITS = {
  nameMaxChars: 48,
  minBetCents: { lo: 50, hi: 25_000 }, // $0.50 … $250
  maxBetCents: { lo: 100, hi: 250_000 }, // $1 … $2,500
  buyInCents: { lo: 500, hi: 500_000 }, // $5 … $5,000
  seatFloorCents: { lo: 0, hi: 500_000 },
  seatCount: { lo: 1, hi: 5 },
} as const;

export interface StakesInput {
  name?: unknown;
  minBetCents?: unknown;
  maxBetCents?: unknown;
  buyInCents?: unknown;
  minBankrollCents?: unknown;
  seatCount?: unknown;
}

export interface Stakes {
  name: string;
  minBetCents: number;
  maxBetCents: number;
  buyInCents: number;
  minBankrollCents: number;
  seatCount: number;
}

export type StakesResult = { ok: true; value: Stakes; warnings: string[] } | { ok: false; code: string; message: string };

const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Integer cents only, or null. Rejects 12.5, "abc", NaN, Infinity, 1e30. */
function cents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  return value;
}

function band(field: string, v: number, lo: number, hi: number): string | null {
  if (v < lo) return `${field} must be at least ${dollars(lo)}.`;
  if (v > hi) return `${field} cannot exceed ${dollars(hi)}.`;
  return null;
}

/**
 * Validate a caller-supplied stakes object.
 *
 * The ordering is deliberate: shape errors first, then per-field bands, then the
 * relationships between fields, because the last group is the one an owner can
 * get subtly wrong (a buy-in smaller than one max bet means a player can never
 * actually risk what the table allows).
 */
export function validateStakes(input: StakesInput): StakesResult {
  const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
  if (!name) return { ok: false, code: 'NAME_REQUIRED', message: 'Give your table a name.' };
  if (name.length > STAKE_LIMITS.nameMaxChars) {
    return { ok: false, code: 'NAME_TOO_LONG', message: `Table names are limited to ${STAKE_LIMITS.nameMaxChars} characters.` };
  }

  const min = cents(input.minBetCents);
  const max = cents(input.maxBetCents);
  const buyIn = cents(input.buyInCents);
  const floor = input.minBankrollCents === undefined || input.minBankrollCents === null ? 0 : cents(input.minBankrollCents);
  const seats = cents(input.seatCount);

  if (min === null || max === null || buyIn === null || floor === null || seats === null) {
    return { ok: false, code: 'STAKES_NOT_INTEGER_CENTS', message: 'Bet, buy-in and seat amounts must be whole cent amounts.' };
  }

  for (const [field, v, lo, hi] of [
    ['Minimum bet', min, STAKE_LIMITS.minBetCents.lo, STAKE_LIMITS.minBetCents.hi],
    ['Maximum bet', max, STAKE_LIMITS.maxBetCents.lo, STAKE_LIMITS.maxBetCents.hi],
    ['Buy-in', buyIn, STAKE_LIMITS.buyInCents.lo, STAKE_LIMITS.buyInCents.hi],
    ['Seat minimum', floor, STAKE_LIMITS.seatFloorCents.lo, STAKE_LIMITS.seatFloorCents.hi],
  ] as const) {
    const msg = band(field, v, lo, hi);
    if (msg) return { ok: false, code: 'STAKE_OUT_OF_BAND', message: msg };
  }
  if (seats < STAKE_LIMITS.seatCount.lo || seats > STAKE_LIMITS.seatCount.hi) {
    return { ok: false, code: 'SEAT_COUNT_INVALID', message: `A table seats between ${STAKE_LIMITS.seatCount.lo} and ${STAKE_LIMITS.seatCount.hi} players.` };
  }

  // Relationships.
  if (max < min) return { ok: false, code: 'MAX_BELOW_MIN', message: `The maximum bet (${dollars(max)}) cannot be below the minimum bet (${dollars(min)}).` };
  if (buyIn < min) {
    return { ok: false, code: 'BUY_IN_BELOW_MIN_BET', message: `The buy-in (${dollars(buyIn)}) must cover at least one minimum bet (${dollars(min)}).` };
  }
  if (floor > 0 && floor < min) {
    return { ok: false, code: 'SEAT_FLOOR_BELOW_MIN_BET', message: `A seat minimum of ${dollars(floor)} is below the ${dollars(min)} minimum bet, so it filters nobody.` };
  }

  const warnings: string[] = [];
  // A seat minimum above the buy-in makes the table unjoinable for anyone who has
  // not bought in twice. Legal, but almost certainly not what the owner meant.
  if (floor > buyIn) {
    warnings.push(`Sitting here needs ${dollars(floor)} on hand but a single buy-in is ${dollars(buyIn)}, so a fresh player cannot take a seat.`);
  }
  // The welcome grant must not be able to buy into a private high-roller felt.
  // This is a warning rather than a rejection because the grant size is config,
  // not user input, and the DO still enforces the floor at the seat.
  if (floor === 0 && min >= 1_000) {
    warnings.push(`No seat minimum is set, so a ${dollars(min)} minimum bet is reachable straight from the welcome stack.`);
  }

  return { ok: true, value: { name, minBetCents: min, maxBetCents: max, buyInCents: buyIn, minBankrollCents: floor, seatCount: seats }, warnings };
}

/** The table name goes into HTML replies and the lobby. Angle brackets are the
 *  only thing esc() cannot undo once they are part of a nested markup string. */
export function safeTableName(name: string): string {
  return name.replace(/[<>&"'`]/g, '').trim().slice(0, STAKE_LIMITS.nameMaxChars);
}
