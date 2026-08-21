/**
 * Token-bucket rate limiter, in memory.
 *
 * Buckets refill continuously rather than resetting on a fixed window, so a
 * user cannot burst 2x the limit by straddling a window boundary — the classic
 * fixed-window flaw.
 *
 * Single-process only. Behind multiple instances this needs to move to Redis;
 * the interface is deliberately narrow so that swap is contained.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** Tokens left after this call. */
  remaining: number;
  /** Ms until at least one token is available. 0 when allowed. */
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    /** Maximum burst. */
    private readonly capacity: number,
    /** Tokens added per second. */
    private readonly refillPerSec: number,
    /** Idle buckets older than this are swept. */
    private readonly idleTtlMs: number = 10 * 60_000,
  ) {}

  /** Consume one token. `now` is injectable for deterministic tests. */
  consume(key: string, now: number = Date.now(), cost = 1): RateLimitResult {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // Refill by elapsed time, capped at capacity.
    const elapsedSec = Math.max(0, now - bucket.lastRefill) / 1000;
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }

    const deficit = cost - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillPerSec) * 1000);
    return { allowed: false, remaining: Math.floor(bucket.tokens), retryAfterMs };
  }

  /** Inspect without consuming. */
  peek(key: string, now: number = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.capacity;
    const elapsedSec = Math.max(0, now - bucket.lastRefill) / 1000;
    return Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }

  /** Drop buckets that have been idle and are back at full capacity. */
  sweep(now: number = Date.now()): number {
    let dropped = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > this.idleTtlMs) {
        this.buckets.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.buckets.size;
  }
}
