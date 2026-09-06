// =============================================================================
// Bust relief: the automatic $10 when a player reaches exactly zero.
//
// The properties that matter are (a) it fires on a bust and only on a bust,
// (b) two racing calls cannot mint twice, (c) a *later* bust does get topped up
// again — that is the product decision, "every single bust" — and (d) it never
// touches the welcome-grant accounting that Stars refunds are clawed back against.
// =============================================================================
import { beforeAll, describe, expect, it } from 'vitest';
import { db, dbReady, seedUser, send } from './harness.ts';
import { applyLedgerOp } from '../../src/lib/db/ledger.ts';
import { getUser } from '../../src/lib/db/users.ts';
import { ensureBustRelief, bustReliefCentsFrom, BUST_RELIEF_REF_ID } from '../../src/lib/db/relief.ts';

const RELIEF = 1_000;
const FRESH = 7_300_001;
const RACER = 7_300_002;
const SEATER = 7_300_003;

async function bankroll(userId: number): Promise<number> {
  const row = await getUser(db(), userId);
  return row?.bankroll_cents ?? -1;
}

beforeAll(async () => {
  await dbReady();
  for (const id of [FRESH, RACER, SEATER]) await seedUser(id, 0, { ageAccepted: true });
});

describe('ensureBustRelief', () => {
  it('credits the house stack to an account at exactly zero', async () => {
    const r = await ensureBustRelief(db(), FRESH, RELIEF);
    expect(r.granted).toBe(true);
    expect(r.bankrollCents).toBe(RELIEF);
    expect(await bankroll(FRESH)).toBe(RELIEF);
  });

  it('is a no-op for an account that still holds chips', async () => {
    const r = await ensureBustRelief(db(), FRESH, RELIEF);
    expect(r.granted).toBe(false);
    expect(r.reason).toBe('has_balance');
    expect(await bankroll(FRESH)).toBe(RELIEF);
  });

  it('mints twice for two busts, because that is the product decision', async () => {
    // Take FRESH back to zero with a real debit, then bust again.
    const bet = await applyLedgerOp(db(), {
      userId: FRESH,
      centsDelta: -RELIEF,
      reason: 'bet',
      idempotencyKey: 'test:relief:bet1',
    });
    expect(bet.ok).toBe(true);
    expect(await bankroll(FRESH)).toBe(0);

    const again = await ensureBustRelief(db(), FRESH, RELIEF);
    expect(again.granted).toBe(true);
    expect(again.bankrollCents).toBe(RELIEF);
  });

  it('cannot be double-credited by two calls that race on the same bust', async () => {
    const [a, b] = await Promise.all([ensureBustRelief(db(), RACER, RELIEF), ensureBustRelief(db(), RACER, RELIEF)]);
    const granted = [a, b].filter((r) => r.granted).length;
    expect(granted).toBe(1);
    // The loser sees the duplicate key, not a second mint.
    expect([a, b].some((r) => r.reason === 'duplicate' || r.reason === 'has_balance')).toBe(true);
    expect(await bankroll(RACER)).toBe(RELIEF);
  });

  it('grants nothing when the feature is configured off', async () => {
    await applyLedgerOp(db(), { userId: RACER, centsDelta: -RELIEF, reason: 'bet', idempotencyKey: 'test:relief:bet2' });
    expect(await bankroll(RACER)).toBe(0);
    const r = await ensureBustRelief(db(), RACER, 0);
    expect(r.granted).toBe(false);
    expect(r.reason).toBe('zero_amount');
    expect(await bankroll(RACER)).toBe(0);
  });

  it('journals as admin_adjust with the relief ref_id, and leaves welcome accounting alone', async () => {
    const row = await db()
      .prepare(`SELECT reason, ref_id, cents_delta FROM ledger_entries WHERE user_id = ?1 AND ref_id = ?2 LIMIT 1`)
      .bind(FRESH, BUST_RELIEF_REF_ID)
      .first<{ reason: string; ref_id: string; cents_delta: number }>();
    expect(row?.reason).toBe('admin_adjust');
    expect(row?.cents_delta).toBe(RELIEF);

    // `welcome_grant_cents` is the non-clawbackable floor in Stars refund
    // accounting. If relief ever stamped it, a refund could no longer reclaim the
    // difference and free chips would silently inflate the clawback floor.
    const user = await getUser(db(), FRESH);
    expect(user?.welcome_grant_cents ?? 0).toBe(0);
    expect(user?.welcome_granted_at ?? null).toBe(null);
  });
});

describe('the Table DO tops a busting player up instead of refusing them', () => {
  it('seats an account at zero, with the credited balance on the wire', async () => {
    const { status, ack, view } = await send(SEATER, { t: 'sit' });
    expect(status).toBe(200);
    if (ack && !ack.ok) throw new Error(`sit refused: ${ack.code} ${ack.error}`);
    expect(view?.you.bankrollCents).toBe(RELIEF);
    expect(view?.you.needsRebuy).toBe(false);
    expect(await bankroll(SEATER)).toBe(RELIEF);
  });
});

describe('bustReliefCentsFrom', () => {
  // A var that arrives as '' or 'abc' must not read as "configured" and then
  // silently disable the feature in production.
  it('falls back unless the value is a non-negative safe integer', () => {
    expect(bustReliefCentsFrom(undefined, RELIEF)).toBe(RELIEF);
    expect(bustReliefCentsFrom(null, RELIEF)).toBe(RELIEF);
    expect(bustReliefCentsFrom('', RELIEF)).toBe(RELIEF);
    expect(bustReliefCentsFrom('abc', RELIEF)).toBe(RELIEF);
    expect(bustReliefCentsFrom('12.5', RELIEF)).toBe(RELIEF);
    expect(bustReliefCentsFrom('-5', RELIEF)).toBe(RELIEF);
    expect(bustReliefCentsFrom('500', RELIEF)).toBe(500);
    expect(bustReliefCentsFrom(0, RELIEF)).toBe(0);
    expect(bustReliefCentsFrom('0', RELIEF)).toBe(0);
  });
});
