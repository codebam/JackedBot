import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * Miniflare loads `.dev.vars` from the config directory and it **overrides**
 * `[vars]` in the wrangler file. So the secret the runtime actually holds is
 * whatever `.dev.vars` says — and the test harness has to sign tickets with the
 * same value or every request comes back `TICKET_BAD_SIG`. Read it here (Node
 * side) and inject it into the test bundle as a literal.
 */
function devVar(name: string, fallback: string): string {
  try {
    const line = readFileSync('.dev.vars', 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith(`${name}=`));
    const value = line?.slice(name.length + 1).trim();
    if (value && !value.startsWith('#')) return value;
  } catch {
    /* no .dev.vars: fall back to wrangler.test.toml's [vars] */
  }
  return fallback;
}

const TEST_APP_SECRET = devVar('APP_SECRET', '0123456789abcdef0123456789abcdef0123456789abcdef');

export default defineConfig({
  define: {
    __TEST_APP_SECRET__: JSON.stringify(TEST_APP_SECRET),
  },
  plugins: [
    cloudflareTest({
      // The test Worker exports the real Table class but skips the Astro handler,
      // which would drag build-time virtual modules into the test bundle.
      main: './tests/worker/test-worker.ts',
      wrangler: { configPath: './wrangler.test.toml' },
    }),
  ],
  test: {
    name: 'worker',
    pool: 'workers',
    include: ['tests/worker/**/*.test.ts'],
    globals: true,
    // Durable Object alarms and the 600 ms escrow coalescer need real wall-clock
    // room, so these wait rather than being faked.
    testTimeout: 60_000,
    hooksTimeout: 60_000,
    // One file at a time: the DO instance and D1 state are shared per runner.
    fileParallelism: false,
  },
});
