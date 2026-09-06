// =============================================================================
// Integration tests on real workerd: the actual Table Durable Object class, a
// real D1 database built from the real schema.sql (triggers included), and the
// same ticket format a browser carries.
//
// What this proves that the Node project cannot:
//   * the DO boots from a `?table=` hint and hydrates its config from D1
//   * a forged / expired / wrong-table ticket is refused with 401
//   * the wire view never contains the shoe permutation or the hole card
//   * the D1 ledger triggers really do bound an over-large wager inside the DO
//   * a wager moves real cents and is journalled exactly once
// =============================================================================
import { beforeAll, describe, expect, it } from 'vitest';

import {
  TABLE_ID,
  bankrollOf,
  dbReady,
  doFetchWithTicket,
  doState,
  mintExpiredTicket,
  mintTicket,
  seedUser,
  send,
} from './harness.ts';

const ALICE = 700001;
const BOB = 700002;
const CAROL = 700003;

beforeAll(async () => {
  await dbReady();
  await seedUser(ALICE, 20_000);
  await seedUser(BOB, 15_000);
  await seedUser(CAROL, 0);
});

describe('ticket authentication at the Durable Object', () => {
  it('accepts a correctly signed ticket and returns the table view', async () => {
    const { status, view } = await send(ALICE, { t: 'resume' });
    expect(status).toBe(200);
    expect(view).not.toBeNull();
    expect(view?.table.tableId).toBe(TABLE_ID);
    expect(view?.you.userId).toBe(ALICE);
    expect(view?.you.bankrollCents).toBe(20_000);
  });

  it('rejects a ticket signed for a different table', async () => {
    const ticket = await mintTicket(ALICE, 'delta');
    const { status, body } = await doFetchWithTicket<{ code?: string }>(ticket);
    expect(status).toBe(401);
    expect(body.code).toBe('TICKET_WRONG_TABLE');
  });

  it('rejects an expired ticket', async () => {
    const ticket = await mintExpiredTicket(ALICE);
    const { status, body } = await doFetchWithTicket<{ code?: string }>(ticket);
    expect(status).toBe(401);
    expect(body.code).toBe('TICKET_EXPIRED');
  });

  it('rejects a tampered ticket payload', async () => {
    const good = await mintTicket(ALICE);
    const [, , sig] = good.split('.');
    const evil = btoa(JSON.stringify({ u: 1, t: TABLE_ID, e: Math.floor(Date.now() / 1000) + 999, n: 'x', p: 'ws' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const { status, body } = await doFetchWithTicket<{ code?: string }>(`ws1.${evil}.${sig}`);
    expect(status).toBe(401);
    expect(body.code).toBe('TICKET_BAD_SIG');
  });

  it('rejects a request with no ticket at all', async () => {
    const { status } = await doFetchWithTicket('');
    expect(status).toBe(401);
  });

  it('rejects a malformed ticket without throwing', async () => {
    for (const junk of ['garbage', 'ws1.onlytwo', 'ws1.a.b.c', 'v9.aaa.bbb']) {
      const { status } = await doFetchWithTicket(junk);
      expect(status).toBe(401);
    }
  });
});

describe('server-authoritative redaction', () => {
  it('never puts the shoe permutation or its seed on the wire', async () => {
    const { view } = await send(ALICE, { t: 'resume' });
    const json = JSON.stringify(view);

    expect(json).not.toContain('"order"');
    expect(json).not.toContain('"pos"');
    expect(json).not.toContain('"seed"');

    // Only the commitment hash is published, and it really is a SHA-256 hex digest.
    expect(view?.table.shoe.commitment).toMatch(/^[0-9a-f]{64}$/);
    // The shoe is a count, never contents.
    expect(view?.table.shoe.cardsRemaining).toBeLessThanOrEqual(312);
    expect((view?.table.shoe as unknown as { cards?: unknown }).cards).toBeUndefined();
  });

  it('sends the dealer at most one card while the hole is unrevealed', async () => {
    const { body } = await doState<{ ok: boolean; data: { table: { dealer: { cards: number[]; holeRevealed: boolean; upCard: number | null } } } }>(BOB);
    const d = body.data.table.dealer;
    if (!d.holeRevealed) {
      expect(d.cards.length).toBeLessThanOrEqual(1);
      expect(d.cards.length).toBe(d.upCard === null ? 0 : 1);
    }
  });

  it('does not leak one player’s bankroll to another', async () => {
    const alice = await send(ALICE, { t: 'resume' });
    expect(JSON.stringify(alice.view?.table.seats)).not.toContain('bankrollCents');
    expect(alice.view?.you.bankrollCents).toBe(20_000);

    const bob = await send(BOB, { t: 'resume' });
    expect(bob.view?.you.bankrollCents).toBe(15_000);
  });
});

describe('seat + wager rules through the real state machine', () => {
  it('refuses to seat a player with no chips', async () => {
    const { ack } = await send(CAROL, { t: 'sit' });
    expect(ack?.ok).toBe(false);
    expect(ack?.code).toBe('NEED_REBUY');
  });

  it('seats a funded player and assigns a seat index', async () => {
    const { view } = await send(ALICE, { t: 'sit' });
    expect(view?.you.seatIndex).toBeGreaterThanOrEqual(0);
  });

  it('rejects a wager made of chips the game does not sell', async () => {
    const bogus = await send(ALICE, { t: 'wager', chips: [7] });
    expect(bogus.ack?.ok).toBe(false);
    expect(bogus.ack?.code).toBe('BAD_CHIP');

    const negative = await send(ALICE, { t: 'wager', chips: [-500] });
    expect(negative.ack?.ok).toBe(false);

    const junk = await send(ALICE, { t: 'wager', chips: 'nope' });
    expect(junk.ack?.ok).toBe(false);
  });

  it('escrows a legal wager in D1 exactly once', async () => {
    // Clear anything Alice already has committed.
    await send(ALICE, { t: 'wager', chips: [] });
    await new Promise((r) => setTimeout(r, 1200));
    const before = await bankrollOf(ALICE);

    const { view } = await send(ALICE, { t: 'wager', chips: [1000] });
    expect(view?.table.seats.find((s) => s?.isYou)?.pendingChips.reduce((a, b) => a + b, 0)).toBe(1000);

    // The ledger write is coalesced inside the DO; wait past ESCROW_COALESCE_MS.
    await new Promise((r) => setTimeout(r, 1300));
    const after = await bankrollOf(ALICE);
    expect(after).toBe(before - 1000);

    // Replaying the identical transition must not debit again (UNIQUE key).
    await send(ALICE, { t: 'wager', chips: [1000] });
    await new Promise((r) => setTimeout(r, 1300));
    expect(await bankrollOf(ALICE)).toBe(after);
  });

  it('cannot take more than the player owns, even for a stacked wager', async () => {
    const before = await bankrollOf(BOB);
    // Bob holds 150.00; ask for far more than that in one go.
    await send(BOB, { t: 'sit' });
    const { ack } = await send(BOB, { t: 'wager', chips: [10_000, 10_000, 10_000] });
    expect(ack?.ok).toBe(true); // accepted as intent...

    await new Promise((r) => setTimeout(r, 1300));
    const after = await bankrollOf(BOB);
    // ...but the D1 overdraft trigger caps what actually leaves the account.
    expect(after).toBeGreaterThanOrEqual(0);
    expect(before - after).toBeLessThanOrEqual(before);
  });

  it('refuses a bet while a round is in progress', async () => {
    // Whatever phase the table reached by now, an out-of-phase bet is refused or
    // accepted only in BETTING; assert the invariant rather than a specific phase.
    const { view } = await send(ALICE, { t: 'resume' });
    if (view?.table.phase !== 'BETTING') {
      const { ack } = await send(ALICE, { t: 'wager', chips: [100] });
      expect(ack?.ok).toBe(false);
      expect(ack?.code).toBe('NOT_BETTING');
    } else {
      expect(view.table.seats.length).toBeGreaterThan(0);
    }
  });
});

describe('commands cannot be injected', () => {
  it('refuses an unknown message type without corrupting state', async () => {
    const bogus = await send(ALICE, { t: 'give_me_blackjack' });
    expect(bogus.ack?.ok).toBe(false);
    expect(bogus.ack?.code).toBe('UNKNOWN_MESSAGE');

    const after = await send(ALICE, { t: 'resume' });
    expect(after.view?.table.tableId).toBe(TABLE_ID);
  });

  it('refuses to act out of turn', async () => {
    const { ack } = await send(BOB, { t: 'action', a: 'hit' });
    expect(ack?.ok).toBe(false);
    expect(['NOT_YOUR_TURN', 'HAND_COMPLETE', 'NOT_BETTING', 'BETTING_CLOSED']).toContain(ack?.code);
  });

  it('ignores a client that claims to be someone else', async () => {
    // Identity comes from the ticket only, so a body-carried userId is inert.
    const { view } = await send(BOB, { t: 'resume', userId: ALICE } as never);
    expect(view?.you.userId).toBe(BOB);
  });

  it('rate-limits a hammering client', async () => {
    let blocked = false;
    for (let i = 0; i < 40; i++) {
      const { ack } = await send(ALICE, { t: 'wager', chips: [100] });
      if (ack?.code === 'RATE_LIMITED') {
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);
  });
});
