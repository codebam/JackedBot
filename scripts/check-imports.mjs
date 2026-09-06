#!/usr/bin/env node
// Repo-wide sanity check: every relative import must resolve on disk.
// Cheap, and it catches the `../../` vs `../../../` depth mistakes that a
// page-route tree invites. Run with: node scripts/check-imports.mjs
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ROOT = process.argv[2] || 'src';
const SKIP = new Set(['node_modules', 'dist', '.astro', '.wrangler']);
const files = [];

(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP.has(entry)) walk(p);
    } else if (/\.(ts|tsx|astro)$/.test(entry)) {
      files.push(p);
    }
  }
})(ROOT);

const bad = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const spec = m[1];
    const abs = resolve(dirname(f), spec);
    const candidates = [abs, abs.replace(/\.(ts|tsx)$/, '.$1'), `${abs}.ts`, `${abs}.tsx`, join(abs, 'index.ts'), join(abs, 'index.tsx')];
    if (!candidates.some((c) => existsSync(c))) bad.push(`${f}  ->  ${spec}`);
  }
}

console.log(`scanned ${files.length} source files under ${ROOT}/ (ts, tsx, astro)`);
if (bad.length) {
  console.log(`\nBROKEN IMPORTS (${bad.length}):`);
  for (const b of bad) console.log('  ' + b);
  process.exit(1);
}
console.log('all relative imports resolve ✔');
