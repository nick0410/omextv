import { describe, it, expect, beforeEach } from "vitest";
import { PairingRegistry } from "../services/pairing";

const T0 = 1_000_000;

describe("PairingRegistry", () => {
  let p: PairingRegistry;

  beforeEach(() => {
    p = new PairingRegistry();
  });

  describe("create", () => {
    it("registers both directions", () => {
      p.create("room1", "a", "b", T0);
      expect(p.partnerOf("a")).toBe("b");
      expect(p.partnerOf("b")).toBe("a");
      expect(p.isPaired("a")).toBe(true);
      expect(p.activeCount).toBe(1);
      expect(p.pairedUserCount).toBe(2);
    });

    it("is resolvable by room id", () => {
      p.create("room1", "a", "b", T0);
      expect(p.pairByRoom("room1")?.userAId).toBe("a");
      expect(p.pairByRoom("nope")).toBeNull();
    });

    it("tears down a stale pair rather than double-booking a user", () => {
      p.create("room1", "a", "b", T0);
      // "a" somehow ends up matched again without room1 being closed.
      p.create("room2", "a", "c", T0);

      expect(p.pairByRoom("room1")).toBeNull();
      expect(p.partnerOf("a")).toBe("c");
      // "b" is released rather than left pointing at a dead pair.
      expect(p.isPaired("b")).toBe(false);
      expect(p.activeCount).toBe(1);
    });

    it("records each participant as a recent partner of the other", () => {
      p.create("room1", "a", "b", T0);
      expect(p.recentPartnersOf("a").get("b")).toBe(T0);
      expect(p.recentPartnersOf("b").get("a")).toBe(T0);
    });
  });

  describe("membership", () => {
    it("accepts genuine participants", () => {
      p.create("room1", "a", "b", T0);
      expect(p.isMember("a", "room1")).toBe(true);
      expect(p.isMember("b", "room1")).toBe(true);
    });

    it("rejects an outsider guessing the room id", () => {
      p.create("room1", "a", "b", T0);
      expect(p.isMember("intruder", "room1")).toBe(false);
    });

    it("rejects a participant naming the wrong room", () => {
      p.create("room1", "a", "b", T0);
      expect(p.isMember("a", "room2")).toBe(false);
    });

    it("rejects everyone once the room is gone", () => {
      p.create("room1", "a", "b", T0);
      p.end("room1");
      expect(p.isMember("a", "room1")).toBe(false);
    });
  });

  describe("end", () => {
    it("frees both users", () => {
      p.create("room1", "a", "b", T0);
      expect(p.end("room1")?.roomId).toBe("room1");
      expect(p.isPaired("a")).toBe(false);
      expect(p.isPaired("b")).toBe(false);
      expect(p.activeCount).toBe(0);
    });

    it("is idempotent", () => {
      p.create("room1", "a", "b", T0);
      p.end("room1");
      expect(p.end("room1")).toBeNull();
    });

    it("endForUser resolves the room", () => {
      p.create("room1", "a", "b", T0);
      expect(p.endForUser("b")?.roomId).toBe("room1");
      expect(p.activeCount).toBe(0);
    });

    it("endForUser returns null for an unpaired user", () => {
      expect(p.endForUser("nobody")).toBeNull();
    });

    it("keeps the recent-partner memory after the chat ends", () => {
      p.create("room1", "a", "b", T0);
      p.end("room1");
      // This is what stops an instant rematch after a skip.
      expect(p.recentPartnersOf("a").has("b")).toBe(true);
    });
  });

  describe("activity", () => {
    it("counts messages", () => {
      p.create("room1", "a", "b", T0);
      p.noteMessage("room1", T0 + 100);
      p.noteMessage("room1", T0 + 200);
      expect(p.pairByRoom("room1")?.messageCount).toBe(2);
      expect(p.pairByRoom("room1")?.lastActivityAt).toBe(T0 + 200);
    });

    it("ignores messages for an unknown room", () => {
      expect(() => p.noteMessage("ghost")).not.toThrow();
    });

    it("touch refreshes without counting a message", () => {
      p.create("room1", "a", "b", T0);
      p.touch("room1", T0 + 500);
      expect(p.pairByRoom("room1")?.messageCount).toBe(0);
      expect(p.pairByRoom("room1")?.lastActivityAt).toBe(T0 + 500);
    });
  });

  describe("findIdle", () => {
    it("finds pairs past the threshold", () => {
      p.create("room1", "a", "b", T0);
      p.create("room2", "c", "d", T0 + 60_000);
      const idle = p.findIdle(30_000, T0 + 61_000);
      expect(idle.map((x) => x.roomId)).toEqual(["room1"]);
    });

    it("returns nothing when all pairs are active", () => {
      p.create("room1", "a", "b", T0);
      expect(p.findIdle(30_000, T0 + 1_000)).toEqual([]);
    });
  });

  describe("recent partners", () => {
    it("returns a copy that cannot mutate internal state", () => {
      p.create("room1", "a", "b", T0);
      const snapshot = p.recentPartnersOf("a");
      snapshot.set("hacked", 1);
      expect(p.recentPartnersOf("a").has("hacked")).toBe(false);
    });

    it("is empty for an unknown user", () => {
      expect(p.recentPartnersOf("ghost").size).toBe(0);
    });

    it("refreshes the timestamp on a repeat pairing", () => {
      p.rememberPartner("a", "b", T0);
      p.rememberPartner("a", "b", T0 + 5_000);
      const map = p.recentPartnersOf("a");
      expect(map.size).toBe(1);
      expect(map.get("b")).toBe(T0 + 5_000);
    });

    it("evicts the least recent once the cap is hit", () => {
      // Default RECENT_PARTNER_LIMIT is 50.
      for (let i = 0; i < 60; i++) p.rememberPartner("a", `p${i}`, T0 + i);
      const map = p.recentPartnersOf("a");
      expect(map.size).toBe(50);
      expect(map.has("p0")).toBe(false);
      expect(map.has("p59")).toBe(true);
    });

    it("sweeps entries older than the window", () => {
      p.rememberPartner("a", "old", T0);
      p.rememberPartner("a", "new", T0 + 50_000);
      expect(p.sweepRecent(30_000, T0 + 60_000)).toBe(1);
      const map = p.recentPartnersOf("a");
      expect(map.has("old")).toBe(false);
      expect(map.has("new")).toBe(true);
    });

    it("forgetUser drops everything for one user", () => {
      p.rememberPartner("a", "b", T0);
      p.forgetUser("a");
      expect(p.recentPartnersOf("a").size).toBe(0);
    });
  });

  it("clear empties every index", () => {
    p.create("room1", "a", "b", T0);
    p.clear();
    expect(p.activeCount).toBe(0);
    expect(p.pairedUserCount).toBe(0);
    expect(p.recentPartnersOf("a").size).toBe(0);
  });

  it("stays consistent across many pair/unpair cycles", () => {
    for (let i = 0; i < 500; i++) {
      p.create(`room${i}`, `a${i}`, `b${i}`, T0 + i);
    }
    expect(p.activeCount).toBe(500);
    expect(p.pairedUserCount).toBe(1000);

    for (let i = 0; i < 500; i += 2) p.end(`room${i}`);
    expect(p.activeCount).toBe(250);
    expect(p.pairedUserCount).toBe(500);

    for (const pair of p.allPairs()) {
      expect(p.partnerOf(pair.userAId)).toBe(pair.userBId);
      expect(p.partnerOf(pair.userBId)).toBe(pair.userAId);
    }
  });
});
