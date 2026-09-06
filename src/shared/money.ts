// =============================================================================
// Money helpers. Bankroll is stored as integer cents everywhere; these are the
// only sanctioned conversions.
// =============================================================================

export const STARS_TO_CENTS = 1_000; // 1 Star == $10.00 of play money

export function starsToCents(stars: number): number {
  if (!Number.isInteger(stars) || stars <= 0) throw new RangeError('stars must be a positive integer');
  return stars * STARS_TO_CENTS;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** Signed form for deltas: `+$15.00` / `-$10.00`. */
export function formatDelta(cents: number): string {
  return `${cents >= 0 ? '+' : ''}${formatCents(cents)}`;
}

/**
 * Parse user/DB input into cents. Rejects NaN, non-finite and sub-cent values so
 * a rounding slip can never become a real balance change.
 */
export function toCents(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  return n;
}

/** Sum a chip stack with an upper bound; guards against float add drift by staying integral. */
export function sumChips(chips: readonly number[], max: number): number {
  let total = 0;
  for (const c of chips) {
    if (!Number.isInteger(c) || c <= 0) continue;
    total += c;
  }
  return Math.min(total, max);
}
