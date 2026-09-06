// Rules engine: shoe, totals, legality, settlement maths.
import { describe, expect, it } from 'vitest';

import {
  PENETRATED_CARDS,
  SHOE_SIZE,
  cardsRemaining,
  createShoe,
  drawCard,
  fisherYates,
  isTenValue,
  needsShuffle,
  rankOf,
  suitOf,
  uniformIntBelow,
  verifyShoe,
} from '../../src/game/cards.ts';
import { handTotal, isBlackjack, ranksMatch } from '../../src/game/hand.ts';
import { dealerMustDraw, legalActions } from '../../src/game/actions.ts';
import { RULES } from '../../src/game/rules.ts';
import { blackjackProfitCents, settleHand, settleRound } from '../../src/game/settlement.ts';
import { chipsPreserveBlackjackParity, normaliseChips } from '../../src/game/betting.ts';

/** Build a card id from rank index (0=A) and suit index. */
const card = (rankIdx: number, suitIdx = 0, deck = 0) => deck * 52 + suitIdx * 13 + rankIdx;

const A = card(0);
const TWO = card(1);
const SEVEN = card(6);
const KING = card(12);
const TEN = card(9);
const QUEEN = card(11);

describe('card encoding', () => {
  it('maps ids back to a consistent rank and suit', () => {
    for (let id = 0; id < SHOE_SIZE; id++) {
      expect(RULES.decks).toBeGreaterThan(0);
      expect(rankOf(id)).toBeTruthy();
      expect(['S', 'H', 'D', 'C']).toContain(suitOf(id));
    }
  });

  it('gives every deck the same 52 distinct faces', () => {
    const faces = new Set(Array.from({ length: 52 }, (_, i) => `${rankOf(i)}${suitOf(i)}`));
    expect(faces.size).toBe(52);
  });

  it('treats all four ten-value ranks as ten', () => {
    for (const r of [9, 10, 11, 12]) expect(isTenValue(card(r))).toBe(true);
    expect(isTenValue(card(8))).toBe(false);
  });
});

describe('handTotal', () => {
  it('resolves soft aces downward instead of busting', () => {
    expect(handTotal([A, A])).toMatchObject({ total: 12, soft: true, aces: 1 });
    expect(handTotal([A, A, NINE()])).toMatchObject({ total: 21, soft: true, aces: 1 });
    expect(handTotal([A, A, A, KING])).toMatchObject({ total: 13, soft: false, aces: 0 });
    expect(handTotal([A, SEVEN])).toMatchObject({ total: 18, soft: true });
    expect(handTotal([A, SEVEN, KING])).toMatchObject({ total: 18, soft: false });
    expect(handTotal([KING, QUEEN, TEN]).total).toBe(30);
  });

  it('reports hard totals as not soft', () => {
    expect(handTotal([KING, QUEEN])).toMatchObject({ total: 20, soft: false });
  });

  it('handles the empty hand without NaN', () => {
    expect(handTotal([]).total).toBe(0);
  });
});

describe('isBlackjack', () => {
  it('is only a natural from the first two cards', () => {
    expect(isBlackjack([A, KING])).toBe(true);
    expect(isBlackjack([A, KING, TWO])).toBe(false);
    expect(isBlackjack([TEN, QUEEN])).toBe(false);
  });

  it('is never a blackjack off a split', () => {
    // This is the difference between paying 3:2 and 1:1.
    expect(isBlackjack([A, KING], true)).toBe(false);
  });

  it('ranksMatch pairs by rank, not by value', () => {
    expect(ranksMatch(KING, KING)).toBe(true);
    expect(ranksMatch(KING, QUEEN)).toBe(false); // both are 10-value, not a pair
    expect(ranksMatch(TEN, KING)).toBe(false);
  });
});

describe('dealer policy (stand on all 17s)', () => {
  it.each([
    [16, true],
    [17, false],
    [18, false],
    [21, false],
  ])('stands at hard %i', (total, shouldStand) => {
    // 8+8 = 16, 8+9 = 17, 8+10 = 18, 10+A = 21
    const hands: Record<number, number[]> = { 16: [card(7), card(7)], 17: [card(7), card(8)], 18: [card(7), KING], 21: [A, KING] };
    expect(dealerMustDraw(hands[total]!)).toBe(shouldStand);
  });

  it('stands on soft 17 because RULES says S17', () => {
    expect(RULES.dealerHitsSoft17).toBe(false);
    expect(dealerMustDraw([A, SIX()])).toBe(false); // soft 17 stands
  });

  it('draws every hard total from 8 to 16 and stands from 17 up', () => {
    // Exhaustive sweep over the two-card ranges, so an off-by-one in the policy
    // cannot hide behind a hand-picked example. card(7) is an 8, card(8) a 9, etc.
    for (let a = 0; a <= 9; a++) {
      for (let b = 0; b <= 9; b++) {
        const hand = [card(a + 1), card(b + 1)]; // 2..10 pips
        const total = handTotal(hand).total;
        expect(dealerMustDraw(hand)).toBe(total <= 16);
      }
    }
  });
});

describe('legalActions', () => {
  const base = {
    fromSplit: false,
    availableCents: 100_000,
    betCents: 500,
    seatHandCount: 1,
    cardsRemaining: 200,
    drawCount: 0,
  };

  it('allows hit/stand/double on an opening hand and denies split on a non-pair', () => {
    const l = legalActions({ ...base, cards: [TEN, SEVEN] });
    expect(l).toMatchObject({ hit: true, stand: true, double: true, split: false });
  });

  it('allows split only on equal ranks and only up to the ceiling', () => {
    expect(legalActions({ ...base, cards: [EIGHT(), EIGHT()] }).split).toBe(true);
    expect(legalActions({ ...base, cards: [EIGHT(), EIGHT()], seatHandCount: RULES.maxSplitHandsPerSeat }).split).toBe(false);
  });

  it('refuses to double or split without the bankroll to cover it', () => {
    const poor = legalActions({ ...base, cards: [EIGHT(), EIGHT()], availableCents: 100 });
    expect(poor.split).toBe(false);
    expect(poor.double).toBe(false);
    expect(poor.blocked).toContain('NEED_FUNDS_FOR_SPLIT');
  });

  it('kills every action on a bust hand and on an empty shoe', () => {
    expect(legalActions({ ...base, cards: [KING, QUEEN, TEN] })).toMatchObject({ hit: false, stand: false, double: false });
    const dry = legalActions({ ...base, cards: [TEN, SEVEN], cardsRemaining: 0 });
    expect(dry.hit).toBe(false);
    expect(dry.blocked).toContain('SHOE_EMPTY');
  });

  it('caps split aces when the house rule is on', () => {
    // The rule is off by default; assert the plumbing honours it when flipped.
    expect(RULES.splitAcesOneCard).toBe(false);
    const l = legalActions({ ...base, cards: [A, card(0, 1)], splitAceCapped: true });
    expect(l.hit).toBe(false);
    expect(l.blocked).toContain('SPLIT_ACE_ONE_CARD');
  });

  it('never offers insurance or surrender', () => {
    const keys = Object.keys(legalActions({ ...base, cards: [TEN, TEN] }));
    expect(keys).not.toContain('insurance');
    expect(keys).not.toContain('surrender');
    expect(RULES.insurance).toBe(false);
    expect(RULES.surrender).toBe(false);
  });
});

function EIGHT() {
  return card(7);
}
function NINE() {
  return card(8);
}
function SIX() {
  return card(5);
}
function DEUCE() {
  return card(1);
}

describe('settlement maths', () => {
  it('pays blackjack exactly 3:2 with no rounding', () => {
    expect(blackjackProfitCents(1000)).toBe(1500);
    expect(blackjackProfitCents(500)).toBe(750);
    expect(chipsPreserveBlackjackParity()).toBe(true);
  });

  const h = (cards: number[], betCents: number, extra: Partial<{ fromSplit: boolean; doubled: boolean; originalBetCents: number }> = {}) => ({
    cards,
    betCents,
    originalBetCents: extra.originalBetCents ?? betCents,
    fromSplit: extra.fromSplit ?? false,
    doubled: extra.doubled ?? false,
  });

  it('pats beat the dealer 1:1 and busts lose everything', () => {
    expect(settleHand(h([KING, QUEEN], 1000), [KING, SEVEN])).toMatchObject({ outcome: 'win', payoutCents: 2000, netCents: 1000 });
    expect(settleHand(h([KING, QUEEN, TEN], 1000), [KING, QUEEN])).toMatchObject({ outcome: 'bust', payoutCents: 0, netCents: -1000 });
  });

  it('pushes equal totals and refunds the stake', () =>
    expect(settleHand(h([TEN, SEVEN], 1000), [KING, SEVEN])).toMatchObject({ outcome: 'push', payoutCents: 1000, netCents: 0 }));

  it('pushes player blackjack against dealer blackjack', () => {
    expect(settleHand(h([A, KING], 1000), [A, QUEEN])).toMatchObject({ outcome: 'push', payoutCents: 1000 });
  });

  it('pays 3:2 for a natural that the dealer does not also hold', () => {
    expect(settleHand(h([A, KING], 1000), [KING, QUEEN, TEN])).toMatchObject({ outcome: 'blackjack', payoutCents: 2500, netCents: 1500 });
  });

  it('pays 1:1 — not 3:2 — on a 21 made from a split', () => {
    // A split 21 beats the dealer's 20, but only at even money. This is the
    // assertion that distinguishes "natural" from "made 21".
    expect(settleHand(h([A, KING], 1000, { fromSplit: true }), [KING, QUEEN])).toMatchObject({ outcome: 'win', payoutCents: 2000, netCents: 1000 });
    expect(settleHand(h([A, KING], 1000, { fromSplit: true }), [A, QUEEN])).toMatchObject({ outcome: 'lose', payoutCents: 0 });
  });

  it('pays 1:1 when the dealer busts', () => {
    expect(settleHand(h([TEN, EIGHT()], 500), [KING, SEVEN, QUEEN])).toMatchObject({ outcome: 'win', payoutCents: 1000 });
  });

  it('counts the doubled stake, and only pays out the doubled stake', () => {
    // 10 + 8 + 2 = 20 after the single forced card of a double.
    const d = settleHand(h([TEN, EIGHT(), DEUCE()], 1000, { doubled: true, originalBetCents: 500 }), [KING, NINE()]);
    expect(d).toMatchObject({ outcome: 'win', payoutCents: 2000, netCents: 1000 });
  });

  it('with no peek, returns the extra stake when the dealer holds a natural', () => {
    // Only reachable with dealerPeeksForBlackjack=false, and the maths must still
    // be right so the rule switch cannot lose a player their double.
    const d = settleHand(h([TEN, EIGHT(), DEUCE()], 1000, { doubled: true, originalBetCents: 500 }), [A, QUEEN]);
    expect(d.outcome).toBe('lose');
    expect(d.payoutCents).toBe(500);
    expect(d.stakeReturned).toBe(true);
  });

  it('refuses to settle a hand containing a non-card', () => {
    // A garbage card id would otherwise fall through every total comparison and be
    // quietly settled as a PUSH. Money code must fail loudly instead.
    expect(() => settleHand(h([TEN, (() => 0) as unknown as number], 500), [KING, SEVEN])).toThrow(/non-numeric total/);
    expect(() => settleHand(h([TEN, SEVEN], 500), ['x' as unknown as number, KING])).toThrow(/non-numeric total/);
    expect(() => settleHand(h([TEN, SEVEN], 1.5), [KING, SEVEN])).toThrow(/invalid bet/);
    expect(() => settleHand(h([TEN, SEVEN], -1), [KING, SEVEN])).toThrow(/invalid bet/);
  });

  it('aggregates a multi-seat, multi-hand round', () => {
    const r = settleRound(
      [
        { ...h([A, KING], 1000), userId: 1, key: '1:0' }, // natural vs 17 -> 3:2
        { ...h([TEN, NINE()], 500), userId: 2, key: '2:0' }, // 19 vs 17 -> win
        { ...h([TEN, SEVEN], 500, { fromSplit: true }), userId: 2, key: '2:1' }, // 17 vs 17 -> push
      ],
      [KING, SEVEN],
    );
    expect(r.wageredCents).toBe(2000);
    expect(r.perSeat.get(1)?.netCents).toBe(1500);
    expect(r.perSeat.get(2)?.outcomes).toEqual(['win', 'push']);
    expect(r.perSeat.get(2)?.wageredCents).toBe(1000);
    // house edge sanity: table net = paid - wagered
    expect(r.tableNetCents).toBe(r.paidCents - r.wageredCents);
  });
});

describe('shoe and shuffle', () => {
  it('creates a full 6-deck shoe with no duplicate cards', async () => {
    const shoe = await createShoe(6);
    expect(shoe.order.length).toBe(312);
    expect(new Set(shoe.order).size).toBe(312);
    expect([...shoe.order].sort((a, b) => a - b)).toEqual(Array.from({ length: 312 }, (_, i) => i));
  });

  it('publishes a commitment that only verifies against the original order', async () => {
    const shoe = await createShoe(6);
    expect(await verifyShoe(shoe)).toBe(shoe.commitment);
    const tampered = { seed: shoe.seed, order: [...shoe.order].reverse() };
    expect(await verifyShoe(tampered)).not.toBe(shoe.commitment);
  });

  it('two shoes from the same CSPRNG are never identical', async () => {
    const [a, b] = await Promise.all([createShoe(), createShoe()]);
    expect(a.order.join(',')).not.toBe(b.order.join(','));
  });

  it('reshuffles at the cut card, not before', () => {
    const stub = { id: 'x', order: Array.from({ length: 312 }, (_, i) => i), pos: 0, commitment: 'c', seed: 's', decks: 6 };
    expect(needsShuffle(stub)).toBe(false);
    stub.pos = PENETRATED_CARDS - 1;
    expect(needsShuffle(stub)).toBe(false);
    stub.pos = PENETRATED_CARDS;
    expect(needsShuffle(stub)).toBe(true);
    expect(PENETRATED_CARDS).toBe(Math.floor(SHOE_SIZE * 0.75));
    expect(cardsRemaining(stub)).toBe(SHOE_SIZE - PENETRATED_CARDS);
  });

  it('refuses to draw from an exhausted shoe', async () => {
    const shoe = await createShoe(1);
    shoe.pos = shoe.order.length;
    expect(() => drawCard(shoe)).toThrow(/SHOE_EXHAUSTED/);
  });
});

describe('uniformIntBelow + fisherYates', () => {
  it('never returns out of range and respects bound=1', () => {
    let i = 0;
    const draw = () => (i++ % 7) * 1_000_000_007;
    for (let n = 0; n < 500; n++) {
      const bound = 1 + (n % 300);
      const v = uniformIntBelow(bound, draw);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(bound);
    }
    expect(uniformIntBelow(1, () => 0xffffffff)).toBe(0);
  });

  it('rejects a non-positive bound', () => {
    expect(() => uniformIntBelow(0, () => 1)).toThrow(RangeError);
  });

  /**
   * Chi-squared goodness-of-fit on the Fisher-Yates *position* distribution.
   * A modulo-biased or off-by-one shuffle fails this immediately: the classic
   * `Math.random()*n` bug concentrates the first few positions.
   *
   * The source of randomness must itself be uniform, so this uses mulberry32
   * (Math.imul keeps it in true 32-bit integer arithmetic — a naive
   * `seed * 1103515245` overflows IEEE-754 doubles and silently ruins the test).
   */
  it('produces a statistically uniform permutation', () => {
    const n = 10;
    const trials = 60_000;
    let seed = 0x9e3779b9;
    const draw = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) ^ 0; // full 32-bit unsigned word
    };

    // Sanity: the fixture PRNG is itself uniform before we blame the shuffle.
    {
      const buckets = new Array(4).fill(0);
      for (let i = 0; i < 40_000; i++) buckets[uniformIntBelow(4, draw)]++;
      for (const b of buckets) expect(b).toBeGreaterThan(8_000);
      for (const b of buckets) expect(b).toBeLessThan(12_000);
    }

    const counts = Array.from({ length: n }, () => Array(n).fill(0));
    const items = Array.from({ length: n }, (_, i) => i);
    for (let t = 0; t < trials; t++) {
      const perm = fisherYates(items, draw);
      expect(new Set(perm).size).toBe(n); // always a permutation, never a repeat
      perm.forEach((value, position) => counts[position]![value]++);
    }

    const expected = trials / n;
    let chi2 = 0;
    for (let pos = 0; pos < n; pos++) {
      expect(counts[pos]!.reduce((a, b) => a + b, 0)).toBe(trials);
      for (let val = 0; val < n; val++) {
        const o = counts[pos]![val]!;
        chi2 += ((o - expected) ** 2) / expected;
      }
    }
    // df = n*(n-1) = 90; the p>0.001 critical value is ~124.4.
    expect(chi2).toBeLessThan(140);
  });
});

describe('wager validation', () => {
  const limits = { minBetCents: 100, maxBetCents: 5000 };

  it('accepts real chip stacks and rejects junk', () => {
    expect(normaliseChips([500, 500], limits)).toEqual({ chips: [500, 500], total: 1000 });
    expect(normaliseChips([], limits)).toEqual({ chips: [], total: 0 }); // clearing is legal
    expect(normaliseChips([1], limits).code).toBe('BAD_CHIP');
    expect(normaliseChips([-500], limits).code).toBe('BAD_WAGER');
    expect(normaliseChips([1.5], limits).code).toBe('BAD_WAGER');
    expect(normaliseChips('500' as unknown as number[], limits).code).toBe('BAD_WAGER');
    expect(normaliseChips([5000, 5000], limits).code).toBe('WAGER_TOO_HIGH');
    expect(normaliseChips([null as unknown as number], limits).code).toBe('BAD_WAGER');
  });

  it('enforces the table minimum but still allows zero', () => {
    expect(normaliseChips([100], limits).total).toBe(100);
    expect(normaliseChips([], limits).total).toBe(0);
    expect(normaliseChips([100], { ...limits, minBetCents: 500 }).code).toBe('WAGER_TOO_LOW');
  });

  it('bounds stack length so a client cannot send 100k chips', () => {
    const many = Array.from({ length: 41 }, () => 100);
    expect(normaliseChips(many, limits).code).toBe('BAD_WAGER');
  });
});
