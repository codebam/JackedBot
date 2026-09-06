// Private tables against real D1 + the real Table DO.
//
// The unit tests cover the pure rules; this covers the parts that only exist at
// runtime: that a private table is absent from the lobby, that the gate has teeth
// for a stranger, and - the reason membership is checked inside the DO and not only
// in the routes - that `sit` is refused even when it arrives over the internal
// command path that bypasses HTTP entirely.
import { beforeAll, describe, expect, it } from 'vitest';
import { db, dbReady, seedUser, send } from './harness.ts';
import { createPrivateTable, redeemInvite, getMembership, listShareableTables, listMemberTableIds, closePrivateTable } from '../../src/lib/db/privateTables.ts';
import { listLobbyTables, getTableConfig, ensureDefaultTables } from '../../src/lib/db/tablesRepo.ts';
import { resolveTableAccess } from '../../src/lib/table-access.ts';

const OWNER = 7_100_001;
const INVITED = 7_100_002;
const STRANGER = 7_100_003;

const STAKES = { name: 'Game night', minBetCents: 500, maxBetCents: 20_000, buyInCents: 10_000, minBankrollCents: 0, seatCount: 3 };

let tableId = '';

beforeAll(async () => {
  await dbReady();
  await ensureDefaultTables(db());
  for (const id of [OWNER, INVITED, STRANGER]) await seedUser(id, 50_000, { ageAccepted: true });
  const created = await createPrivateTable(db(), OWNER, STAKES);
  tableId = created.tableId;
});

describe('private table creation', () => {
  it('stores it as unlisted and enrolls the creator as owner', async () => {
    const cfg = await getTableConfig(db(), tableId);
    expect(cfg?.isPublic).toBe(false);
    expect(cfg?.seatCount).toBe(3);
    expect(await getMembership(db(), tableId, OWNER)).toBe('owner');
  });

  it('generates a slug that fits the shared table-id shape', async () => {
    expect(tableId).toMatch(/^[a-z0-9][a-z0-9_-]{1,31}$/);
    expect(tableId).toHaveLength(32);
  });

  it('does not appear in the public lobby listing', async () => {
    const ids = (await listLobbyTables(db())).map((t) => t.id);
    expect(ids).toContain('bravo');
    expect(ids).not.toContain(tableId);
  });

  it('shows up in the owner\'s shareable list and nowhere else', async () => {
    expect((await listShareableTables(db(), OWNER)).map((t) => t.id)).toContain(tableId);
    expect(await listShareableTables(db(), STRANGER)).toEqual([]);
    expect(await listMemberTableIds(db(), STRANGER)).toEqual([]);
  });
});

describe('access gate', () => {
  it('refuses a stranger with an explanatory 403', async () => {
    const r = await resolveTableAccess(db(), tableId, STRANGER);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('NOT_A_MEMBER');
      expect(r.status).toBe(403);
      expect(r.message.toLowerCase()).toContain('invite');
    }
  });

  it('allows the public tables for everyone', async () => {
    expect((await resolveTableAccess(db(), 'bravo', STRANGER)).ok).toBe(true);
  });

  it('admits a player once they have redeemed the invite', async () => {
    expect(await getMembership(db(), tableId, INVITED)).toBeNull();
    expect((await resolveTableAccess(db(), tableId, INVITED)).ok).toBe(false);
    expect(await redeemInvite(db(), tableId, INVITED)).toBe('member');
    expect((await resolveTableAccess(db(), tableId, INVITED)).ok).toBe(true);
  });

  it('is idempotent: redeeming twice keeps one row and the original role', async () => {
    await redeemInvite(db(), tableId, INVITED);
    await redeemInvite(db(), tableId, INVITED);
    expect(await getMembership(db(), tableId, INVITED)).toBe('member');
    const rows = await db()
      .prepare(`SELECT COUNT(*) AS n FROM table_members WHERE table_id = ?1 AND user_id = ?2`)
      .bind(tableId, INVITED)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('never downgrades an owner to a member', async () => {
    await redeemInvite(db(), tableId, OWNER);
    expect(await getMembership(db(), tableId, OWNER)).toBe('owner');
  });
});

describe('Table DO enforcement', () => {
  it('refuses to seat a non-member over the internal command path', async () => {
    // Deliberately STRANGER, who has never been enrolled: the point is that the DO
    // itself refuses, so no future route can forget to check.
    const r = await send(STRANGER, { t: 'sit' }, tableId);
    expect(r.ack?.ok).toBe(false);
    expect(r.ack?.code ?? (r.raw as { code?: string } | null)?.code).toBe('NOT_A_MEMBER');
  });

  it('seats a member at the same private table', async () => {
    const r = await send(INVITED, { t: 'sit' }, tableId);
    expect(r.ack?.ok, JSON.stringify(r.raw)).toBe(true);
    // A successful seat comes back as a full state view, which is what the island
    // needs anyway - asserting its presence proves the DO took the seat.
    expect(r.view?.table).toBeTruthy();
    expect(r.view?.you).toBeTruthy();
  });
});

describe('closing a private table', () => {
  // Close, not delete: the ledger journals every chip movement against the table, so
  // the row has to survive. These tests pin the end state the routes depend on.
  async function makeTable() {
    // OWNER / INVITED / STRANGER are seeded once in beforeAll; re-seeding here would
    // just re-assert the same rows.
    const { tableId } = await createPrivateTable(db(), OWNER, STAKES);
    await redeemInvite(db(), tableId, INVITED);
    return tableId;
  }

  it('lets the owner close it, and the gate then refuses everyone', async () => {
    const tableId = await makeTable();
    expect(await closePrivateTable(db(), tableId, OWNER)).toBe(true);

    const cfg = await getTableConfig(db(), tableId);
    expect(cfg).not.toBe(null);
    expect(cfg!.status).toBe('closed');

    // A member who is already inside is refused too: closing means no new business,
    // not "no new business for strangers".
    for (const who of [OWNER, INVITED, STRANGER]) {
      const access = await resolveTableAccess(db(), tableId, who);
      expect(access.ok).toBe(false);
      if (!access.ok) expect(access.status).toBeGreaterThanOrEqual(400);
    }
  });

  it('leaves the lobby and the inline picker as soon as it is closed', async () => {
    const tableId = await makeTable();
    expect((await listShareableTables(db(), OWNER)).map((t) => t.id)).toContain(tableId);
    await closePrivateTable(db(), tableId, OWNER);
    expect((await listShareableTables(db(), OWNER)).map((t) => t.id)).not.toContain(tableId);
    expect((await listShareableTables(db(), INVITED)).map((t) => t.id)).not.toContain(tableId);
    // Membership is NOT revoked by closing: the ledger still has to resolve who was in
    // the table, and listMemberTableIds is that raw membership query (it has no
    // caller in src/ - the lobby and inline both use listShareableTables above).
    // Asserting `not.toContain` here would contradict the survival test below.
    expect(await listMemberTableIds(db(), OWNER)).toContain(tableId);
  });

  it('refuses a member who did not create the table', async () => {
    // The route checks the role, and the UPDATE carries created_by - so even a bug in
    // the route cannot close somebody else's table.
    const tableId = await makeTable();
    expect(await closePrivateTable(db(), tableId, INVITED)).toBe(false);
    const cfg = await getTableConfig(db(), tableId);
    expect(cfg!.status).toBe('open');
    expect((await listShareableTables(db(), OWNER)).map((t) => t.id)).toContain(tableId);
  });

  it('refuses a stranger and tolerates being closed twice', async () => {
    const tableId = await makeTable();
    expect(await closePrivateTable(db(), tableId, STRANGER)).toBe(false);
    expect(await closePrivateTable(db(), tableId, OWNER)).toBe(true);
    // Second close matches no rows (status <> 'closed'), which the route reports as
    // closed-but-unchanged rather than an error.
    expect(await closePrivateTable(db(), tableId, OWNER)).toBe(false);
  });

  it('cannot close a public table', async () => {
    await ensureDefaultTables(db());
    const publicTables = await listLobbyTables(db());
    expect(publicTables.length).toBeGreaterThan(0);
    expect(await closePrivateTable(db(), publicTables[0]!.id, OWNER)).toBe(false);
  });

  it('keeps membership rows after closing, so the ledger still resolves', async () => {
    const tableId = await makeTable();
    await closePrivateTable(db(), tableId, OWNER);
    expect(await getMembership(db(), tableId, INVITED)).toBe('member');
    expect(await getMembership(db(), tableId, OWNER)).toBe('owner');
  });
});
