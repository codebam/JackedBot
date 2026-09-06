// =============================================================================
// Sliding-window rate limiter.
//
// Two deployment shapes, same class:
//   * inside a Table Durable Object  -> strongly consistent, one process, exact
//   * inside a stateless API route   -> per-isolate best-effort (documented:
//     Workers isolates are not shared, so treat this as a spam brake, not a
//     quota. For a hard global quota use DO or KV with a reserved- counter.)
// =============================================================================

export interface RateCheck {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until a slot frees up (0 when allowed). */
  retryAfterMs: number;
  limit: number;
  windowMs: number;
}

export class SlidingWindowRateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 5_000,
  ) {
    if (!Number.isInteger(limit) || limit <= 0) throw new RangeError('limit must be a positive integer');
    if (!Number.isInteger(windowMs) || windowMs <= 0) throw new RangeError('windowMs must be a positive integer');
  }

  check(key: string, now: number = Date.now()): RateCheck {
    const cutoff = now - this.windowMs;
    let bucket = this.hits.get(key);
    if (!bucket) {
      bucket = [];
      this.hits.set(key, bucket);
    } else {
      // Drop expired entries from the front; timestamps are appended in order.
      let drop = 0;
      while (drop < bucket.length && bucket[drop]! <= cutoff) drop++;
      if (drop > 0) bucket.splice(0, drop);
    }

    if (bucket.length >= this.limit) {
      const earliest = bucket[0]!;
      this.sweep(now);
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, earliest + this.windowMs - now), limit: this.limit, windowMs: this.windowMs };
    }

    bucket.push(now);
    const oldest = bucket[0]!;
    this.sweep(now);
    return {
      allowed: true,
      remaining: Math.max(0, this.limit - bucket.length),
      retryAfterMs: 0,
      limit: this.limit,
      windowMs: Math.max(1, oldest + this.windowMs - now),
    };
  }

  /** Forget a key entirely (e.g. after a successful action, to avoid double-charging). */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Bound memory: evict the oldest-touched keys when the map grows too large. */
  private sweep(now: number): void {
    if (this.hits.size <= this.maxKeys) return;
    for (const [k, bucket] of this.hits) {
      if (bucket.length === 0 || bucket[bucket.length - 1]! + this.windowMs < now) this.hits.delete(k);
      if (this.hits.size <= this.maxKeys) break;
    }
    // Still oversized: keep the most recently active keys.
    if (this.hits.size > this.maxKeys) {
      const sorted = [...this.hits.entries()].sort((a, b) => (a[1][a[1].length - 1] ?? 0) - (b[1][b[1].length - 1] ?? 0));
      for (const [k] of sorted.slice(0, this.hits.size - this.maxKeys)) this.hits.delete(k);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

/** Convenience: throw-shaped helper for API routes. */
export function rateLimitOr429(check: RateCheck, message = 'Too many requests, slow down.'): Response | null {
  if (check.allowed) return null;
  return Response.json(
    { ok: false, error: message, code: 'RATE_LIMITED' } as const,
    {
      status: 429,
      headers: {
        'cache-control': 'no-store',
        'retry-after': String(Math.ceil(check.retryAfterMs / 1000)),
        'x-ratelimit-limit': String(check.limit),
        'x-ratelimit-remaining': '0',
      },
    },
  );
}
