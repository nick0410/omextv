import { describe, expect, it, vi } from "vitest";
import { detach } from "../utils/detach";

/**
 * The bug this exists to prevent: a background task rejecting and taking the
 * whole process with it. Stopping Redis did exactly that, health endpoint
 * included, so nothing was left to report the outage.
 */
describe("detach", () => {
  it("swallows a rejection instead of letting it go unhandled", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      detach(Promise.reject(new Error("redis went away")), "test:task");
      // Give the microtask queue and the rejection check a turn.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toBeNull();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      spy.mockRestore();
    }
  });

  it("logs the message under the context it was given", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    detach(Promise.reject(new Error("boom")), "socket:sweep");
    await new Promise((r) => setTimeout(r, 10));

    expect(spy).toHaveBeenCalledWith("[socket:sweep]", "boom");
    spy.mockRestore();
  });

  it("handles a rejection that is not an Error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    detach(Promise.reject("just a string"), "socket:sweep");
    await new Promise((r) => setTimeout(r, 10));

    expect(spy).toHaveBeenCalledWith("[socket:sweep]", "just a string");
    spy.mockRestore();
  });

  it("does nothing noisy when the promise resolves", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    detach(Promise.resolve("fine"), "socket:sweep");
    await new Promise((r) => setTimeout(r, 10));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
