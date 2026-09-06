// =============================================================================
// Card model, shoe and cryptographically-secure shuffle.
// Zero Cloudflare / Node imports: safe to unit-test anywhere and to bundle into
// either the Worker or the browser island.
// =============================================================================

export const SUITS = ['S', 'H', 'D', 'C'] as const;
export type Suit = (typeof SUITS)[number];

/** Ace is 1 here; value/soft-total logic lives in `hand.ts`. */
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
export type Rank = (typeof RANKS)[number];

export const DECK_SIZE = 52;
export const SHOE_DECKS = 6;
export const SHOE_SIZE = DECK_SIZE * SHOE_DECKS; // 312

/**
 * A card is its position in the shoe: `id = deckIndex * 52 + cardIndex`.
 * Encoding cards as small integers keeps WebSocket frames tiny. An id only ever
 * discloses a *face* — never a position — so publishing revealed ids is exactly
 * as informative as a physical shoe: opponents see the board, not the draw.
 */
export function rankOf(id: number): Rank {
  return RANKS[(id % DECK_SIZE) % 13]!;
}
export function suitOf(id: number): Suit {
  return SUITS[Math.floor((id % DECK_SIZE) / 13)]!;
}
/** Pip value. Ace returns 11 here; `handTotal` resolves soft/hard. */
export function faceValue(id: number): number {
  const r = id % DECK_SIZE % 13;
  return r === 0 ? 11 : Math.min(r + 1, 10);
}
export function isAce(id: number): boolean {
  return id % DECK_SIZE % 13 === 0;
}
/** True for 10, J, Q, K — used by the dealer blackjack peek. */
export function isTenValue(id: number): boolean {
  return faceValue(id) === 10;
}
export function cardLabel(id: number): string {
  return `${rankOf(id)}${suitOf(id)}`;
}

export interface Shoe {
  /** Opaque identifier, echoed into `rounds` for audit. */
  id: string;
  /** Frozen permutation of 0..SHOE_SIZE-1. NEVER sent to a client. */
  order: number[];
  /** Next index to draw from. */
  pos: number;
  /** SHA-256(order || seed) published at shoe creation; seed revealed at retire. */
  commitment: string;
  /** Random per-shoe salt, revealed only once the shoe is exhausted/retired. */
  seed: string;
  decks: number;
}

/** Reshuffle point: 75% penetration, matching a real cut card. */
export const PENETRATION = 0.75;
export const PENETRATED_CARDS = Math.floor(SHOE_SIZE * PENETRATION); // 234

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function shuffleRandom(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return out;
}

export function randomHex(bytes: number): string {
  return toHex(shuffleRandom(bytes).buffer as ArrayBuffer);
}

/**
 * Uniform integer in [0, bound) by rejection sampling.
 *
 * `crypto.getRandomValues()` + `%` is biased whenever `bound` does not divide
 * 2^32 (every `bound` here). We discard the overflowing tail instead. Expected
 * rejection rate is < 0.00002% for bounds under a few hundred, so cost is one
 * 32-bit draw per swap.
 */
export function uniformIntBelow(bound: number, draw: () => number): number {
  if (bound <= 0) throw new RangeError('bound must be positive');
  if (bound === 1) return 0;
  const range = 0x1_0000_0000; // 2^32
  const limit = range - (range % bound); // largest multiple of bound below 2^32
  for (;;) {
    const x = draw() >>> 0;
    if (x < limit) return x % bound;
  }
}

/**
 * Fisher-Yates (Durstenfeld) in-place, over an externally supplied 32-bit source.
 * `source` is injected purely so tests can drive it with a deterministic PRNG and
 * assert the permutation is uniform; production always passes the CSPRNG.
 */
export function fisherYates<T>(items: T[], draw: () => number = cryptoRandomUint32): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = uniformIntBelow(i + 1, draw);
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/** Consume 32-bit words from the CSPRNG one at a time (no big allocations). */
function cryptoRandomUint32(): number {
  return cryptoRandomUint32Batch(1)[0]!;
}
const U32_BUF = new Uint32Array(64);
function cryptoRandomUint32Batch(n: number): Uint32Array {
  if (n <= U32_BUF.length) {
    crypto.getRandomValues(U32_BUF.subarray(0, n));
    return U32_BUF.subarray(0, n);
  }
  const big = new Uint32Array(n);
  crypto.getRandomValues(big);
  return big;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(digest);
}

/** Build a fresh, committed 6-deck shoe. */
export async function createShoe(decks: number = SHOE_DECKS): Promise<Shoe> {
  const seed = randomHex(32);
  const ids: number[] = [];
  for (let d = 0; d < decks; d++) for (let c = 0; c < DECK_SIZE; c++) ids.push(d * DECK_SIZE + c);

  const order = fisherYates(ids, cryptoRandomUint32);
  const commitment = await sha256Hex(`${seed}|${order.join(',')}`);
  const id = randomHex(8);
  return { id, order, pos: 0, commitment, seed, decks };
}

export function cardsRemaining(shoe: Shoe): number {
  return shoe.order.length - shoe.pos;
}

/** Shoe is past the cut card and must be replaced. */
export function needsShuffle(shoe: Shoe): boolean {
  return shoe.pos >= PENETRATED_CARDS || cardsRemaining(shoe) < 15;
}

export function drawCard(shoe: Shoe): number {
  if (shoe.pos >= shoe.order.length) throw new Error('SHOE_EXHAUSTED');
  const card = shoe.order[shoe.pos]!;
  shoe.pos += 1;
  return card;
}

/**
 * Verify a retired shoe: recomputes the commitment from the revealed seed and
 * permutation. Lets a player prove the deal was fixed in advance — the house
 * shows its work without ever exposing a future card during play.
 */
export async function verifyShoe(shoe: Pick<Shoe, 'order' | 'seed'>): Promise<string> {
  return sha256Hex(`${shoe.seed}|${shoe.order.join(',')}`);
}
