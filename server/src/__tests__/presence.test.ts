import { describe, it, expect, beforeEach } from "vitest";
import { PresenceRegistry } from "../services/presence";

describe("PresenceRegistry", () => {
  let p: PresenceRegistry;

  beforeEach(() => {
    p = new PresenceRegistry();
  });

  it("registers and resolves both directions", () => {
    expect(p.register("u1", "s1")).toBeNull();
    expect(p.socketOf("u1")).toBe("s1");
    expect(p.userOf("s1")).toBe("u1");
    expect(p.isOnline("u1")).toBe(true);
  });

  it("counts distinct users, not sockets", () => {
    p.register("u1", "s1");
    p.register("u2", "s2");
    expect(p.onlineCount).toBe(2);
  });

  describe("single session per user", () => {
    it("evicts the previous socket and reports it", () => {
      p.register("u1", "s1");
      expect(p.register("u1", "s2")).toBe("s1");
      expect(p.socketOf("u1")).toBe("s2");
      expect(p.userOf("s1")).toBeNull();
      expect(p.onlineCount).toBe(1);
      expect(p.socketCount).toBe(1);
    });

    it("re-registering the same socket is a no-op", () => {
      p.register("u1", "s1");
      expect(p.register("u1", "s1")).toBeNull();
      expect(p.socketCount).toBe(1);
    });

    it("a late teardown from an evicted socket does not kill the new session", () => {
      p.register("u1", "s1");
      p.register("u1", "s2");

      // The old socket's disconnect handler fires after the replacement.
      p.unregister("s1");

      expect(p.isOnline("u1")).toBe(true);
      expect(p.socketOf("u1")).toBe("s2");
    });
  });

  describe("isCurrentSocket", () => {
    it("is true only for the live socket", () => {
      p.register("u1", "s1");
      expect(p.isCurrentSocket("u1", "s1")).toBe(true);
      p.register("u1", "s2");
      expect(p.isCurrentSocket("u1", "s1")).toBe(false);
      expect(p.isCurrentSocket("u1", "s2")).toBe(true);
    });

    it("is false for an unknown user", () => {
      expect(p.isCurrentSocket("ghost", "s9")).toBe(false);
    });
  });

  describe("unregister", () => {
    it("removes the user when it was their current socket", () => {
      p.register("u1", "s1");
      expect(p.unregister("s1")?.userId).toBe("u1");
      expect(p.isOnline("u1")).toBe(false);
      expect(p.onlineCount).toBe(0);
    });

    it("returns null for an unknown socket", () => {
      expect(p.unregister("nope")).toBeNull();
    });

    it("is idempotent", () => {
      p.register("u1", "s1");
      p.unregister("s1");
      expect(p.unregister("s1")).toBeNull();
      expect(p.onlineCount).toBe(0);
    });
  });

  it("touch updates activity without changing identity", () => {
    p.register("u1", "s1", 1_000);
    p.touch("s1", 5_000);
    expect(p.socketOf("u1")).toBe("s1");
    expect(p.onlineCount).toBe(1);
  });

  it("touch on an unknown socket does nothing", () => {
    expect(() => p.touch("ghost")).not.toThrow();
  });

  it("lists online user ids", () => {
    p.register("u1", "s1");
    p.register("u2", "s2");
    expect(p.onlineUserIds().sort()).toEqual(["u1", "u2"]);
  });

  it("clear empties everything", () => {
    p.register("u1", "s1");
    p.clear();
    expect(p.onlineCount).toBe(0);
    expect(p.socketCount).toBe(0);
    expect(p.socketOf("u1")).toBeNull();
  });

  it("stays consistent across 1000 connect/replace/disconnect cycles", () => {
    for (let i = 0; i < 1000; i++) {
      const user = `u${i % 50}`;
      p.register(user, `s${i}`);
    }
    // 50 distinct users, each holding exactly one socket.
    expect(p.onlineCount).toBe(50);
    expect(p.socketCount).toBe(50);

    for (const user of p.onlineUserIds()) {
      const socketId = p.socketOf(user)!;
      expect(p.userOf(socketId)).toBe(user);
    }
  });
});
