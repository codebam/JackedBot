#!/usr/bin/env node
// Keeps the D1 migration in lockstep with the canonical root schema.sql.
//
// `wrangler d1 migrations apply` requires files under migrations/, while the
// deliverable spec asks for a readable schema.sql at the repo root. One of them
// has to be the source of truth; it is schema.sql, and this script regenerates the
// migration from it. `npm test` asserts the result is already up to date, so the
// two can never silently drift.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'schema.sql');
const target = join(root, 'migrations', '0001_init.sql');

const BANNER = `-- JackedBot initial schema.
-- GENERATED FROM schema.sql BY scripts/sync-migration.mjs — DO NOT EDIT.
-- Edit the canonical copy at the repository root and run: npm run db:migrate:local
`;

const sql = readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
const next = `${BANNER}\n${sql}`;

const current = existsSync(target) ? readFileSync(target, 'utf8') : null;

if (process.argv.includes('--check')) {
  if (current === next) {
    console.log('schema.sql and migrations/0001_init.sql are in sync.');
    process.exit(0);
  }
  console.error('DRIFT: migrations/0001_init.sql is not derived from the current schema.sql.');
  console.error('Run: node scripts/sync-migration.mjs');
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, next);
console.log(`wrote ${target.replace(root + '/', '')} (${next.length} bytes)`);
