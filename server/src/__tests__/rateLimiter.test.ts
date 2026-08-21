import { describe, it, expect } from "vitest";
import { RateLimiter } from "../utils/rateLimiter";

const T0 = 1_000_000;

describe("RateLimiter", () => {
  it("allows up to capacity, then refuses", () => {
    const rl = new RateLimiter(3, 1);
    expect(rl.consume("a", T0).allowed).toBe(true);
    expect(rl.consume("a", T0).allowed).toBe(true);
    expect(rl.consume("a", T0).allowed).toBe(true);
    expect(rl.consume("a", T0).allowed).toBe(false);
  });

  it("reports remaining tokens", () => {
    const rl = new RateLimiter(3, 1);
    expect(rl.consume("a", T0).remaining).toBe(2);
    expect(rl.consume("a", T0).remaining).toBe(1);
  });

  it("keys are independent", () => {
    const rl = new RateLimiter(1, 1);
    expect(rl.consume("a", T0).allowed).toBe(true);
    expect(rl.consume("a", T0).allowed).toBe(false);
    expect(rl.consume("b", T0).allowed).toBe(true);
  });

  it("refills continuously rather than on a window boundary", () => {
    const rl = new RateLimiter(2, 1); // 1 token/sec
    rl.consume("a", T0);
    rl.consume("a", T0);
    expect(rl.consume("a", T0).allowed).toBe(false);

    // Half a second buys nothing.
    expect(rl.consume("a", T0 + 500).allowed).toBe(false);
    // A full second buys exactly one.
    expect(rl.consume("a", T0 + 1_000).allowed).toBe(true);
    expect(rl.consume("a", T0 + 1_000).allowed).toBe(false);
  });

  it("never refills past capacity", () => {
    const rl = new RateLimiter(2, 100);
    rl.consume("a", T0);
    // An hour later there should still only be 2 tokens, not 360,000.
    expect(rl.consume("a", T0 + 3_600_000).allowed).toBe(true);
    expect(rl.consume("a", T0 + 3_600_000).allowed).toBe(true);
    expect(rl.consume("a", T0 + 3_600_000).allowed).toBe(false);
  });

  it("reports a usable retryAfterMs", () => {
    const rl = new RateLimiter(1, 2); // 2 tokens/sec => 500ms each
    rl.consume("a", T0);
    const denied = rl.consume("a", T0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(500);
    // Waiting exactly that long works.
    expect(rl.consume("a", T0 + denied.retryAfterMs).allowed).toBe(true);
  });

  it("supports a cost greater than one", () => {
    const rl = new RateLimiter(10, 1);
    expect(rl.consume("a", T0, 6).allowed).toBe(true);
    expect(rl.consume("a", T0, 6).allowed).toBe(false);
    expect(rl.consume("a", T0, 4).allowed).toBe(true);
  });

  it("treats a clock that jumps backwards as no elapsed time", () => {
    const rl = new RateLimiter(1, 1);
    rl.consume("a", T0);
    // An NTP correction must not hand out free tokens.
    expect(rl.consume("a", T0 - 60_000).allowed).toBe(false);
  });

  it("peek does not consume", () => {
    const rl = new RateLimiter(2, 1);
    expect(rl.peek("fresh", T0)).toBe(2);
    rl.consume("fresh", T0);
    expect(rl.peek("fresh", T0)).toBe(1);
    expect(rl.peek("fresh", T0)).toBe(1);
  });

  it("reset clears a single key", () => {
    const rl = new RateLimiter(1, 1);
    rl.consume("a", T0);
    expect(rl.consume("a", T0).allowed).toBe(false);
    rl.reset("a");
    expect(rl.consume("a", T0).allowed).toBe(true);
  });

  it("sweeps idle buckets", () => {
    const rl = new RateLimiter(1, 1, 1_000);
    rl.consume("a", T0);
    rl.consume("b", T0);
    expect(rl.size).toBe(2);
    expect(rl.sweep(T0 + 5_000)).toBe(2);
    expect(rl.size).toBe(0);
  });

  it("keeps recently active buckets during a sweep", () => {
    const rl = new RateLimiter(1, 1, 10_000);
    rl.consume("a", T0);
    expect(rl.sweep(T0 + 1_000)).toBe(0);
    expect(rl.size).toBe(1);
  });
});
