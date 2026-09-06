// Keeps the two generated/derived SQL artefacts honest: the D1 migration must be
// exactly schema.sql, and the workerd test bundle must embed the same schema.
// Both are cheap checks that catch the "edited one copy" class of bug.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('schema artefacts are in sync', () => {
  const schema = readFileSync('schema.sql', 'utf8');

  it('migrations/0001_init.sql is derived from schema.sql', () => {
    expect(() => execFileSync('node', ['scripts/sync-migration.mjs', '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it('tests/worker/schema.generated.ts embeds schema.sql verbatim', () => {
    expect(() => execFileSync('node', ['scripts/gen-test-schema.mjs', '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it('declares the invariants the application layer relies on', () => {
    // These names are referenced by SQL strings and trigger RAISE() messages in
    // src/lib/db/*.ts — a rename on one side must fail here, not at 3am.
    for (const needle of [
      'INSUFFICIENT_BANKROLL',
      'LEDGER_IS_APPEND_ONLY',
      'UNKNOWN_USER',
      'CREATE TRIGGER IF NOT EXISTS ledger_after_insert',
      'CREATE TRIGGER IF NOT EXISTS ledger_require_funds',
      'CREATE TRIGGER IF NOT EXISTS ledger_requires_user',
      'UNIQUE (idempotency_key)',
      'CREATE VIEW IF NOT EXISTS v_ledger_drift',
      "reason           TEXT NOT NULL CHECK (reason IN (",
      "'welcome_grant'",
      "'refund_clawback'",
    ]) {
      expect(schema, `schema.sql must contain: ${needle}`).toContain(needle);
    }
  });

  it('contains no cashout or withdrawal surface', () => {
    // The product rule is that chips can never leave. If someone adds a payout
    // column, transfer table or withdraw reason, this test must fail.
    //
    // Comments are stripped first: the header banner *documents* the absence of a
    // cashout path, and grepping prose would only ever produce false positives.
    const structural = schema
      .split('\n')
      .map((line) => line.replace(/\s*--.*$/, ''))
      .join('\n')
      .toLowerCase();

    const forbidden = ['withdraw', 'cashout', 'cash_out', 'payout_address', 'ton_address', 'redeem', 'transfer_to', 'refund_to_user'];
    for (const word of forbidden) {
      expect(structural, `schema must not define anything named "${word}"`).not.toContain(word);
    }

    // And the reasons the ledger may record stay a closed set: no 'payout_withdraw'.
    const reasonBlock = /reason\s+text not null check \(reason in \(([^)]*)\)/.exec(structural);
    expect(reasonBlock, 'ledger reason CHECK list must be findable').not.toBeNull();
    const reasons = (reasonBlock?.[1] ?? '').split(',').map((r) => r.trim().replace(/'/g, '')).filter(Boolean);
    expect(reasons).toContain('buy_in');
    expect(reasons).toContain('welcome_grant');
    expect(reasons).toContain('refund_clawback');
    expect(reasons.some((r) => /withdraw|cashout|redeem/.test(r))).toBe(false);
  });
});
