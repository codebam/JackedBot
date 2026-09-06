import { defineConfig } from 'vitest/config';

// Project 1: pure logic in Node. These modules must not import `cloudflare:workers`
// or any Durable Object — that is what keeps the rules engine unit-testable.
export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    globals: true,
    // The CSPRNG uniformity test needs a few thousand samples.
    testTimeout: 30_000,
  },
});
