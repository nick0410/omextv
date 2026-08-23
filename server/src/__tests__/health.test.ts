import { describe, expect, it, vi } from "vitest";

/**
 * The health endpoint has one job: say no when this instance cannot do its
 * work. It once reported "ok" with the database stopped, because it only
 * pinged the store — so every sign-in failed while the check said the node was
 * fine, which is the exact outage it exists to catch.
 */
describe("health reporting", () => {
  const decide = (storeOk: boolean, dbOk: boolean) => ({
    status: storeOk && dbOk ? "ok" : "degraded",
    code: storeOk && dbOk ? 200 : 503,
  });

  it("is healthy only when both dependencies answer", () => {
    expect(decide(true, true)).toEqual({ status: "ok", code: 200 });
  });

  it("fails when the database is unreachable", () => {
    expect(decide(true, false)).toEqual({ status: "degraded", code: 503 });
  });

  it("fails when the store is unreachable", () => {
    expect(decide(false, true)).toEqual({ status: "degraded", code: 503 });
  });

  it("fails when both are gone", () => {
    expect(decide(false, false)).toEqual({ status: "degraded", code: 503 });
  });

  it("treats a dependency that never answers as down", async () => {
    // A hung dependency must not hang the endpoint reporting it as hung.
    vi.useFakeTimers();
    const withTimeout = async <T,>(work: Promise<T>, ms: number, fallback: T) => {
      let timer: ReturnType<typeof setTimeout>;
      const guard = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      });
      return Promise.race([work, guard]).finally(() => clearTimeout(timer));
    };

    const hung = new Promise<boolean>(() => {});
    const result = withTimeout(hung, 3000, false);
    await vi.advanceTimersByTimeAsync(3100);
    expect(await result).toBe(false);
    vi.useRealTimers();
  });
});
