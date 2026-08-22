import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { MemoryStores } from "../services/store/memory";
import { RedisStores } from "../services/store/redis";
import { Stores } from "../services/store/types";
import { serializeEntry, deserializeEntry } from "../services/store/serialize";
import { makeEntry } from "./helpers";

import { isRedisReady } from "./dbAvailable";

const REDIS_URL = isRedisReady() ? process.env.REDIS_TEST_URL : undefined;

describe("queue entry serialization", () => {
  it("round-trips every field", () => {
    const entry = makeEntry({
      userId: "u1",
      gender: "female",
      effectiveGender: "female",
      genderIsVerified: true,
      country: "JP",
      city: "Tokyo",
      isPremium: true,
      filters: { gender: "male", countries: ["IN", "US"], city: null },
      blocked: ["b1", "b2"],
      recent: { p1: 111, p2: 222 },
      joinedAt: 5_000,
    });

    const back = deserializeEntry(serializeEntry(entry))!;
    expect(back.userId).toBe("u1");
    expect(back.effectiveGender).toBe("female");
    expect(back.genderIsVerified).toBe(true);
    expect(back.country).toBe("JP");
    expect(back.isPremium).toBe(true);
    expect(back.filters.countries).toEqual(["IN", "US"]);
    expect(back.joinedAt).toBe(5_000);
  });

  it("preserves the Set of blocked ids", () => {
    // Plain JSON.stringify turns a Set into {} — losing every block silently.
    const entry = makeEntry({ blocked: ["x", "y", "z"] });
    const back = deserializeEntry(serializeEntry(entry))!;
    expect(back.blockedIds).toBeInstanceOf(Set);
    expect(back.blockedIds.has("x")).toBe(true);
    expect(back.blockedIds.size).toBe(3);
  });

  it("preserves the Map of recent partners with timestamps", () => {
    const entry = makeEntry({ recent: { a: 100, b: 200 } });
    const back = deserializeEntry(serializeEntry(entry))!;
    expect(back.recentPartners).toBeInstanceOf(Map);
    expect(back.recentPartners.get("b")).toBe(200);
  });

  it("returns null for junk rather than throwing", () => {
    expect(deserializeEntry(null)).toBeNull();
    expect(deserializeEntry("not json")).toBeNull();
    expect(deserializeEntry("{}")).toBeNull();
    expect(deserializeEntry("[]")).toBeNull();
  });

  it("tolerates an entry written by an older version", () => {
    const partial = JSON.stringify({ u: "u1", b: null, r: null });
    const back = deserializeEntry(partial)!;
    expect(back.userId).toBe("u1");
    expect(back.blockedIds.size).toBe(0);
    expect(back.recentPartners.size).toBe(0);
    expect(back.relaxStage).toBe(0);
  });
});

/**
 * The same contract is run against both backends.
 *
 * That is the point: the socket layer talks only to this interface, so if
 * memory and Redis both satisfy it, swapping REDIS_URL cannot change
 * behaviour. Redis tests skip when no server is reachable.
 */
function contractTests(name: string, makeStores: () => Stores, enabled = true) {
  describe.skipIf(!enabled)(`${name} store`, () => {
    let store: Stores;

    beforeAll(async () => {
      store = makeStores();
    });

    beforeEach(async () => {
      await store.presence.clear();
      await store.pairing.clear();
      await store.queue.clear();
    });

    afterAll(async () => {
      await store?.close();
    });

    describe("presence", () => {
      it("registers and resolves a user", async () => {
        expect(await store.presence.register("u1", "s1", "i1")).toBeNull();
        expect(await store.presence.socketOf("u1")).toBe("s1");
        expect(await store.presence.isOnline("u1")).toBe(true);
      });

      it("evicts the previous socket and reports it", async () => {
        await store.presence.register("u1", "s1", "i1");
        expect(await store.presence.register("u1", "s2", "i1")).toBe("s1");
        expect(await store.presence.socketOf("u1")).toBe("s2");
      });

      it("a late unregister from a replaced socket keeps the new session", async () => {
        await store.presence.register("u1", "s1", "i1");
        await store.presence.register("u1", "s2", "i1");
        await store.presence.unregister("s1");
        expect(await store.presence.isOnline("u1")).toBe(true);
        expect(await store.presence.socketOf("u1")).toBe("s2");
      });

      it("unregistering the current socket takes the user offline", async () => {
        await store.presence.register("u1", "s1", "i1");
        const rec = await store.presence.unregister("s1");
        expect(rec?.userId).toBe("u1");
        expect(await store.presence.isOnline("u1")).toBe(false);
      });

      it("counts distinct users", async () => {
        await store.presence.register("u1", "s1", "i1");
        await store.presence.register("u2", "s2", "i1");
        await store.presence.register("u1", "s3", "i1"); // replaces, not adds
        expect(await store.presence.onlineCount()).toBe(2);
      });

      it("isCurrentSocket only accepts the live socket", async () => {
        await store.presence.register("u1", "s1", "i1");
        expect(await store.presence.isCurrentSocket("u1", "s1")).toBe(true);
        expect(await store.presence.isCurrentSocket("u1", "old")).toBe(false);
      });

      it("unregistering an unknown socket is a no-op", async () => {
        expect(await store.presence.unregister("ghost")).toBeNull();
      });
    });

    describe("pairing", () => {
      const pair = (roomId: string, a: string, b: string, at = 1000) => ({
        roomId,
        userAId: a,
        userBId: b,
        startedAt: at,
        dbId: null,
        messageCount: 0,
        lastActivityAt: at,
      });

      it("creates a pair resolvable from both sides", async () => {
        await store.pairing.create(pair("r1", "a", "b"));
        expect(await store.pairing.partnerOf("a")).toBe("b");
        expect(await store.pairing.partnerOf("b")).toBe("a");
        expect(await store.pairing.activeCount()).toBe(1);
      });

      it("enforces room membership", async () => {
        await store.pairing.create(pair("r1", "a", "b"));
        expect(await store.pairing.isMember("a", "r1")).toBe(true);
        expect(await store.pairing.isMember("intruder", "r1")).toBe(false);
        expect(await store.pairing.isMember("a", "other-room")).toBe(false);
      });

      it("tears down a stale pair instead of double-booking", async () => {
        await store.pairing.create(pair("r1", "a", "b"));
        await store.pairing.create(pair("r2", "a", "c"));
        expect(await store.pairing.pairByRoom("r1")).toBeNull();
        expect(await store.pairing.partnerOf("a")).toBe("c");
        expect(await store.pairing.isPaired("b")).toBe(false);
        expect(await store.pairing.activeCount()).toBe(1);
      });

      it("ends a pair and frees both users", async () => {
        await store.pairing.create(pair("r1", "a", "b"));
        expect((await store.pairing.end("r1"))?.roomId).toBe("r1");
        expect(await store.pairing.isPaired("a")).toBe(false);
        expect(await store.pairing.end("r1")).toBeNull();
      });

      it("counts messages", async () => {
        await store.pairing.create(pair("r1", "a", "b"));
        await store.pairing.noteMessage("r1", 2000);
        await store.pairing.noteMessage("r1", 3000);
        const found = await store.pairing.pairByRoom("r1");
        expect(found?.messageCount).toBe(2);
        expect(found?.lastActivityAt).toBe(3000);
      });

      it("finds idle rooms by last activity", async () => {
        await store.pairing.create(pair("r1", "a", "b", 1000));
        await store.pairing.create(pair("r2", "c", "d", 90_000));
        const idle = await store.pairing.findIdle(30_000, 100_000);
        expect(idle.map((p) => p.roomId)).toEqual(["r1"]);
      });

      it("remembers recent partners with timestamps", async () => {
        await store.pairing.rememberPartner("a", "b", 5_000);
        const recent = await store.pairing.recentPartnersOf("a");
        expect(recent.get("b")).toBe(5_000);
      });

      it("records both directions when a pair forms", async () => {
        await store.pairing.create(pair("r1", "a", "b", 7_000));
        expect((await store.pairing.recentPartnersOf("a")).has("b")).toBe(true);
        expect((await store.pairing.recentPartnersOf("b")).has("a")).toBe(true);
      });

      it("refreshes rather than duplicates a repeat partner", async () => {
        await store.pairing.rememberPartner("a", "b", 1_000);
        await store.pairing.rememberPartner("a", "b", 9_000);
        const recent = await store.pairing.recentPartnersOf("a");
        expect(recent.size).toBe(1);
        expect(recent.get("b")).toBe(9_000);
      });

      it("sweeps recent partners older than the window", async () => {
        await store.pairing.rememberPartner("a", "old", 1_000);
        await store.pairing.rememberPartner("a", "new", 90_000);
        await store.pairing.sweepRecent(30_000, 100_000);
        const recent = await store.pairing.recentPartnersOf("a");
        expect(recent.has("old")).toBe(false);
        expect(recent.has("new")).toBe(true);
      });
    });

    describe("queue", () => {
      it("enqueues and reads back an entry intact", async () => {
        await store.queue.enqueue(
          makeEntry({ userId: "u1", blocked: ["x"], recent: { p: 5 } }),
        );
        const back = await store.queue.get("u1");
        expect(back?.userId).toBe("u1");
        expect(back?.blockedIds.has("x")).toBe(true);
        expect(back?.recentPartners.get("p")).toBe(5);
      });

      it("orders each lane oldest-first", async () => {
        await store.queue.enqueue(makeEntry({ userId: "b", joinedAt: 2_000 }));
        await store.queue.enqueue(makeEntry({ userId: "a", joinedAt: 1_000 }));
        await store.queue.enqueue(makeEntry({ userId: "c", joinedAt: 3_000 }));
        const { standard } = await store.queue.snapshot();
        expect(standard.map((e) => e.userId)).toEqual(["a", "b", "c"]);
      });

      it("separates the premium lane", async () => {
        await store.queue.enqueue(makeEntry({ userId: "p", isPremium: true }));
        await store.queue.enqueue(makeEntry({ userId: "s" }));
        expect(await store.queue.laneSizes()).toEqual({ premium: 1, standard: 1 });
        expect(await store.queue.size()).toBe(2);
      });

      it("puts premium first in positionOf", async () => {
        await store.queue.enqueue(makeEntry({ userId: "s", joinedAt: 1_000 }));
        await store.queue.enqueue(
          makeEntry({ userId: "p", isPremium: true, joinedAt: 2_000 }),
        );
        expect(await store.queue.positionOf("p")).toBe(1);
        expect(await store.queue.positionOf("s")).toBe(2);
        expect(await store.queue.positionOf("nobody")).toBe(-1);
      });

      it("a re-join keeps the original wait time", async () => {
        await store.queue.enqueue(makeEntry({ userId: "a", joinedAt: 1_000 }));
        await store.queue.enqueue(makeEntry({ userId: "b", joinedAt: 2_000 }));
        // "a" changes filters; its joinedAt is preserved by the caller.
        await store.queue.enqueue(
          makeEntry({ userId: "a", joinedAt: 1_000, filters: { gender: "female" } }),
        );
        const { standard } = await store.queue.snapshot();
        expect(standard.map((e) => e.userId)).toEqual(["a", "b"]);
        expect((await store.queue.get("a"))?.filters.gender).toBe("female");
      });

      it("moving between lanes leaves no duplicate", async () => {
        await store.queue.enqueue(makeEntry({ userId: "u", isPremium: false }));
        await store.queue.enqueue(makeEntry({ userId: "u", isPremium: true }));
        expect(await store.queue.size()).toBe(1);
        expect(await store.queue.laneSizes()).toEqual({ premium: 1, standard: 0 });
      });

      it("removes from either lane", async () => {
        await store.queue.enqueue(makeEntry({ userId: "u", isPremium: true }));
        expect((await store.queue.remove("u"))?.userId).toBe("u");
        expect(await store.queue.has("u")).toBe(false);
        expect(await store.queue.remove("u")).toBeNull();
      });

      it("reports the longest wait", async () => {
        await store.queue.enqueue(makeEntry({ userId: "a", joinedAt: 40_000 }));
        await store.queue.enqueue(makeEntry({ userId: "b", joinedAt: 10_000 }));
        expect(await store.queue.oldestWaitMs(100_000)).toBe(90_000);
        await store.queue.clear();
        expect(await store.queue.oldestWaitMs(100_000)).toBe(0);
      });

      it("runs the callback while holding the lock", async () => {
        const result = await store.queue.withLock(async () => "matched");
        expect(result).toBe("matched");
      });

      it("releases the lock even when the callback throws", async () => {
        await expect(
          store.queue.withLock(async () => {
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        // Still usable afterwards — the lock was not leaked.
        expect(await store.queue.withLock(async () => "ok")).toBe("ok");
      });
    });

    describe("bus", () => {
      it("delivers a published message to a subscriber", async () => {
        const received: unknown[] = [];
        await store.bus.subscribe("test-channel", (m) => received.push(m));
        await new Promise((r) => setTimeout(r, 50));

        await store.bus.publish("test-channel", { hello: "world" });
        await new Promise((r) => setTimeout(r, 150));

        expect(received).toContainEqual({ hello: "world" });
      });

      it("does not cross channels", async () => {
        const received: unknown[] = [];
        await store.bus.subscribe("channel-a", (m) => received.push(m));
        await new Promise((r) => setTimeout(r, 50));

        await store.bus.publish("channel-b", { nope: true });
        await new Promise((r) => setTimeout(r, 150));

        expect(received).toHaveLength(0);
      });
    });

    it("reports itself healthy", async () => {
      expect(await store.ping()).toBe(true);
    });
  });
}

contractTests("memory", () => new MemoryStores());
contractTests("redis", () => new RedisStores(REDIS_URL!), Boolean(REDIS_URL));

describe.skipIf(!REDIS_URL)("redis-specific behaviour", () => {
  let a: Stores;
  let b: Stores;

  beforeAll(async () => {
    a = new RedisStores(REDIS_URL!);
    b = new RedisStores(REDIS_URL!);
    await a.queue.clear();
    await a.presence.clear();
  });

  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  it("shares queue state across two instances", async () => {
    // The whole reason Redis exists here: a user queued on node A must be
    // visible to node B, or they can never be matched with each other.
    await a.queue.enqueue(makeEntry({ userId: "shared-1", joinedAt: 1_000 }));
    const seen = await b.queue.get("shared-1");
    expect(seen?.userId).toBe("shared-1");
    expect(await b.queue.size()).toBeGreaterThanOrEqual(1);
    await a.queue.clear();
  });

  it("shares presence across instances", async () => {
    await a.presence.register("shared-2", "sock-a", "instance-a");
    expect(await b.presence.isOnline("shared-2")).toBe(true);
    expect(await b.presence.instanceOf("shared-2")).toBe("instance-a");
    await a.presence.clear();
  });

  it("grants the matchmaking lock to only one instance at a time", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const work = async (store: Stores) =>
      store.queue.withLock(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 120));
        concurrent--;
        return true;
      });

    const [first, second] = await Promise.all([work(a), work(b)]);

    // One of them must have been turned away rather than matching in parallel.
    expect(maxConcurrent).toBe(1);
    expect([first, second].filter((r) => r === true)).toHaveLength(1);
    expect([first, second].filter((r) => r === null)).toHaveLength(1);
  });

  it("delivers bus messages between instances", async () => {
    const received: unknown[] = [];
    await b.bus.subscribe("cross-instance", (m) => received.push(m));
    await new Promise((r) => setTimeout(r, 100));

    await a.bus.publish("cross-instance", { from: "a" });
    await new Promise((r) => setTimeout(r, 250));

    expect(received).toContainEqual({ from: "a" });
  });
});

describe.skipIf(!REDIS_URL)("queue entry expiry", () => {
  let store: Stores;

  beforeAll(async () => {
    store = new RedisStores(REDIS_URL!);
    await store.queue.clear();
  });

  afterAll(async () => {
    await store?.close();
  });

  it("gives every queue entry a TTL", async () => {
    // Without one, a hard shutdown leaves the entry in Redis forever: the
    // sweep keeps pairing live users with a ghost, `queued` never returns to
    // zero, and `oldestWaitMs` climbs without bound.
    await store.queue.enqueue(makeEntry({ userId: "ttl-check" }));

    const redis = (store as unknown as { clients: { ttl(k: string): Promise<number> }[] })
      .clients[0];
    const ttl = await redis.ttl("omextv:queue:entry:ttl-check");

    expect(ttl).toBeGreaterThan(0);
    await store.queue.clear();
  });
});
