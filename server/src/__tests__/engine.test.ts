import { describe, it, expect, beforeEach } from "vitest";
import {
  MatchmakingEngine,
  isCompatible,
  filtersAccept,
  genderAccepts,
  stageFor,
  RELAX_STAGES,
} from "../services/matchmaking/engine";
import { makeEntry, resetSeq } from "./helpers";
import { DEFAULT_FILTERS } from "../types";

const T0 = 1_000_000;

describe("genderAccepts", () => {
  it("'any' accepts every gender", () => {
    expect(genderAccepts("any", "male")).toBe(true);
    expect(genderAccepts("any", "female")).toBe(true);
    expect(genderAccepts("any", "other")).toBe(true);
  });

  it("a specific preference accepts only that gender", () => {
    expect(genderAccepts("female", "female")).toBe(true);
    expect(genderAccepts("female", "male")).toBe(false);
    expect(genderAccepts("other", "other")).toBe(true);
    expect(genderAccepts("other", "female")).toBe(false);
  });
});

describe("filtersAccept", () => {
  it("passes when no constraints are set", () => {
    expect(filtersAccept(DEFAULT_FILTERS, makeEntry(), true)).toBe(true);
  });

  it("rejects a candidate with no country when a country is required", () => {
    const filters = { ...DEFAULT_FILTERS, countries: ["JP"] };
    expect(filtersAccept(filters, makeEntry({ country: null }), true)).toBe(false);
  });

  it("accepts any country in a multi-country filter", () => {
    const filters = { ...DEFAULT_FILTERS, countries: ["JP", "IN", "BR"] };
    expect(filtersAccept(filters, makeEntry({ country: "IN" }), true)).toBe(true);
    expect(filtersAccept(filters, makeEntry({ country: "US" }), true)).toBe(false);
  });

  it("matches city case-insensitively", () => {
    const filters = { ...DEFAULT_FILTERS, countries: ["IN"], city: "Mumbai" };
    expect(filtersAccept(filters, makeEntry({ country: "IN", city: "mumbai" }), true)).toBe(true);
    expect(filtersAccept(filters, makeEntry({ country: "IN", city: "Delhi" }), true)).toBe(false);
  });

  it("ignores the city filter when city enforcement is off", () => {
    const filters = { ...DEFAULT_FILTERS, countries: ["IN"], city: "Mumbai" };
    const candidate = makeEntry({ country: "IN", city: "Delhi" });
    expect(filtersAccept(filters, candidate, true)).toBe(false);
    expect(filtersAccept(filters, candidate, false)).toBe(true);
  });

  it("rejects a candidate with no city when a city is required", () => {
    const filters = { ...DEFAULT_FILTERS, countries: ["IN"], city: "Mumbai" };
    expect(filtersAccept(filters, makeEntry({ country: "IN", city: null }), true)).toBe(false);
  });
});

describe("stageFor", () => {
  it("advances at each configured threshold", () => {
    expect(stageFor(0)).toBe(0);
    expect(stageFor(19_999)).toBe(0);
    expect(stageFor(20_000)).toBe(1);
    expect(stageFor(59_999)).toBe(1);
    expect(stageFor(60_000)).toBe(2);
    expect(stageFor(10 * 60_000)).toBe(2);
  });

  it("never exceeds the configured ladder", () => {
    expect(stageFor(Number.MAX_SAFE_INTEGER)).toBe(RELAX_STAGES.length - 1);
  });
});

describe("isCompatible", () => {
  it("never matches a user with themselves", () => {
    const a = makeEntry({ userId: "same" });
    const b = makeEntry({ userId: "same" });
    expect(isCompatible(a, b, 0, T0)).toBe(false);
  });

  it("respects a block in either direction", () => {
    const a = makeEntry({ userId: "a", blocked: ["b"] });
    const b = makeEntry({ userId: "b" });
    expect(isCompatible(a, b, 0, T0)).toBe(false);
    expect(isCompatible(b, a, 0, T0)).toBe(false);
  });

  it("keeps blocks in force at the most relaxed stage", () => {
    const a = makeEntry({ userId: "a", blocked: ["b"] });
    const b = makeEntry({ userId: "b" });
    expect(isCompatible(a, b, RELAX_STAGES.length - 1, T0)).toBe(false);
  });

  it("requires both sides to accept each other", () => {
    // A wants women; B is a man who wants anyone.
    const a = makeEntry({ userId: "a", filters: { gender: "female" } });
    const b = makeEntry({ userId: "b", gender: "male", effectiveGender: "male" });
    expect(isCompatible(a, b, 0, T0)).toBe(false);
  });

  it("matches when both filters are satisfied", () => {
    const a = makeEntry({
      userId: "a",
      gender: "male",
      effectiveGender: "male",
      filters: { gender: "female" },
    });
    const b = makeEntry({
      userId: "b",
      gender: "female",
      effectiveGender: "female",
      filters: { gender: "male" },
    });
    expect(isCompatible(a, b, 0, T0)).toBe(true);
  });

  it("filters on effective gender, not the self-declared value", () => {
    // Declares male, model says female with confidence — B asked for women.
    const a = makeEntry({
      userId: "a",
      gender: "male",
      effectiveGender: "female",
      genderIsVerified: true,
    });
    const b = makeEntry({ userId: "b", filters: { gender: "female" } });
    expect(isCompatible(a, b, 0, T0)).toBe(true);
  });

  describe("recent partners", () => {
    it("blocks a rematch inside the stage-0 window", () => {
      const a = makeEntry({ userId: "a", recent: { b: T0 - 60_000 } });
      const b = makeEntry({ userId: "b" });
      expect(isCompatible(a, b, 0, T0)).toBe(false);
    });

    it("is symmetric — one side remembering is enough", () => {
      const a = makeEntry({ userId: "a" });
      const b = makeEntry({ userId: "b", recent: { a: T0 - 60_000 } });
      expect(isCompatible(a, b, 0, T0)).toBe(false);
    });

    it("allows a rematch once the memory is older than the window", () => {
      const a = makeEntry({ userId: "a", recent: { b: T0 - 31 * 60_000 } });
      const b = makeEntry({ userId: "b" });
      expect(isCompatible(a, b, 0, T0)).toBe(true);
    });

    it("shrinks the window at stage 1", () => {
      const a = makeEntry({ userId: "a", recent: { b: T0 - 10 * 60_000 } });
      const b = makeEntry({ userId: "b" });
      expect(isCompatible(a, b, 0, T0)).toBe(false); // 30 min window
      expect(isCompatible(a, b, 1, T0)).toBe(true); //  5 min window
    });

    it("drops the rule entirely at stage 2", () => {
      const a = makeEntry({ userId: "a", recent: { b: T0 - 1_000 } });
      const b = makeEntry({ userId: "b" });
      expect(isCompatible(a, b, 1, T0)).toBe(false);
      expect(isCompatible(a, b, 2, T0)).toBe(true);
    });
  });

  describe("what relaxation must never touch", () => {
    it("never relaxes the country filter", () => {
      const a = makeEntry({ userId: "a", filters: { countries: ["JP"] } });
      const b = makeEntry({ userId: "b", country: "BR" });
      for (let stage = 0; stage < RELAX_STAGES.length; stage++) {
        expect(isCompatible(a, b, stage, T0)).toBe(false);
      }
    });

    it("never relaxes the gender filter", () => {
      const a = makeEntry({ userId: "a", filters: { gender: "female" } });
      const b = makeEntry({ userId: "b", gender: "male", effectiveGender: "male" });
      for (let stage = 0; stage < RELAX_STAGES.length; stage++) {
        expect(isCompatible(a, b, stage, T0)).toBe(false);
      }
    });
  });
});

describe("MatchmakingEngine", () => {
  let engine: MatchmakingEngine;

  beforeEach(() => {
    engine = new MatchmakingEngine();
    resetSeq();
  });

  describe("joining", () => {
    it("queues the first arrival instead of matching", () => {
      const a = makeEntry({ userId: "a" });
      expect(engine.joinQueue(a, T0)).toBeNull();
      expect(engine.size).toBe(1);
      expect(engine.has("a")).toBe(true);
    });

    it("matches the second arrival and empties the queue", () => {
      engine.joinQueue(makeEntry({ userId: "a", joinedAt: T0 }), T0);
      const match = engine.joinQueue(makeEntry({ userId: "b", joinedAt: T0 }), T0);

      expect(match).not.toBeNull();
      expect(engine.size).toBe(0);
      expect([match!.a.userId, match!.b.userId].sort()).toEqual(["a", "b"]);
    });

    it("issues a distinct room id per match", () => {
      engine.joinQueue(makeEntry({ userId: "a" }), T0);
      const m1 = engine.joinQueue(makeEntry({ userId: "b" }), T0);
      engine.joinQueue(makeEntry({ userId: "c" }), T0);
      const m2 = engine.joinQueue(makeEntry({ userId: "d" }), T0);

      expect(m1!.roomId).not.toBe(m2!.roomId);
      expect(m1!.roomId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("does not leave a stale copy when a user rejoins", () => {
      const a = makeEntry({ userId: "a", filters: { gender: "female" } });
      engine.joinQueue(a, T0);
      engine.joinQueue(makeEntry({ userId: "a", filters: { gender: "male" } }), T0);

      expect(engine.size).toBe(1);
      expect(engine.get("a")!.filters.gender).toBe("male");
    });

    it("a rejoin with changed filters can match immediately", () => {
      engine.joinQueue(
        makeEntry({ userId: "a", gender: "male", effectiveGender: "male" }),
        T0,
      );
      // B initially wants "other", so no match.
      expect(
        engine.joinQueue(makeEntry({ userId: "b", filters: { gender: "other" } }), T0),
      ).toBeNull();
      // B widens to "male" and should now pair with A.
      const match = engine.joinQueue(
        makeEntry({ userId: "b", filters: { gender: "male" } }),
        T0,
      );
      expect(match).not.toBeNull();
      expect(engine.size).toBe(0);
    });
  });

  describe("FIFO fairness", () => {
    it("hands the newcomer the longest-waiting compatible user", () => {
      // All three waiters are men looking for women, so they queue up behind
      // each other instead of pairing among themselves.
      for (const [i, id] of ["first", "second", "third"].entries()) {
        engine.joinQueue(
          makeEntry({
            userId: id,
            joinedAt: T0 + i,
            gender: "male",
            effectiveGender: "male",
            filters: { gender: "female" },
          }),
          T0 + i,
        );
      }
      expect(engine.size).toBe(3);

      const match = engine.joinQueue(
        makeEntry({
          userId: "new",
          joinedAt: T0 + 3,
          gender: "female",
          effectiveGender: "female",
          filters: { gender: "male" },
        }),
        T0 + 3,
      );
      expect(match!.b.userId).toBe("first");
      expect(engine.size).toBe(2);
    });

    it("skips incompatible waiters without disturbing their order", () => {
      // Two men who each want "other" — so they never pair with each other —
      // followed by a man who will talk to anyone.
      engine.joinQueue(
        makeEntry({ userId: "m1", gender: "male", effectiveGender: "male", filters: { gender: "other" } }),
        T0,
      );
      engine.joinQueue(
        makeEntry({ userId: "m2", gender: "male", effectiveGender: "male", filters: { gender: "other" } }),
        T0,
      );
      engine.joinQueue(
        makeEntry({ userId: "open", gender: "male", effectiveGender: "male" }),
        T0,
      );

      // A woman wanting anyone can only pair with "open".
      const match = engine.joinQueue(
        makeEntry({ userId: "w", gender: "female", effectiveGender: "female" }),
        T0,
      );

      expect(match!.b.userId).toBe("open");
      expect(engine.snapshot().standard.map((e) => e.userId)).toEqual(["m1", "m2"]);
    });

    it("serves 100 arrivals in strict pairing order", () => {
      const matched: string[] = [];
      for (let i = 0; i < 100; i++) {
        const m = engine.joinQueue(makeEntry({ userId: `u${i}`, joinedAt: T0 + i }), T0 + i);
        if (m) matched.push(`${m.b.userId}+${m.a.userId}`);
      }
      // u0 pairs with u1, u2 with u3, and so on.
      expect(matched.length).toBe(50);
      expect(matched[0]).toBe("u0+u1");
      expect(matched[1]).toBe("u2+u3");
      expect(matched[49]).toBe("u98+u99");
      expect(engine.size).toBe(0);
    });
  });

  describe("premium priority", () => {
    // Waiters are men who want women, so they never pair with one another and
    // both stay queued until a compatible arrival shows up.
    const manSeekingWoman = (userId: string, extra: Record<string, unknown> = {}) =>
      makeEntry({
        userId,
        gender: "male",
        effectiveGender: "male",
        filters: { gender: "female" },
        ...extra,
      });

    const womanSeekingMan = (userId: string, joinedAt: number) =>
      makeEntry({
        userId,
        gender: "female",
        effectiveGender: "female",
        filters: { gender: "male" },
        joinedAt,
      });

    it("serves a premium waiter before an older standard waiter", () => {
      engine.joinQueue(manSeekingWoman("std", { joinedAt: T0 }), T0);
      engine.joinQueue(manSeekingWoman("prem", { isPremium: true, joinedAt: T0 + 5 }), T0 + 5);

      const match = engine.joinQueue(womanSeekingMan("new", T0 + 10), T0 + 10);
      expect(match!.b.userId).toBe("prem");
      expect(engine.has("std")).toBe(true);
    });

    it("keeps FIFO order within the premium lane", () => {
      engine.joinQueue(manSeekingWoman("p1", { isPremium: true, joinedAt: T0 }), T0);
      engine.joinQueue(manSeekingWoman("p2", { isPremium: true, joinedAt: T0 + 1 }), T0 + 1);

      const match = engine.joinQueue(womanSeekingMan("new", T0 + 2), T0 + 2);
      expect(match!.b.userId).toBe("p1");
    });

    it("counts the lanes separately", () => {
      engine.joinQueue(makeEntry({ userId: "p", isPremium: true, filters: { gender: "other" } }), T0);
      engine.joinQueue(makeEntry({ userId: "s", filters: { gender: "other" } }), T0);
      expect(engine.premiumSize).toBe(1);
      expect(engine.standardSize).toBe(1);
      expect(engine.size).toBe(2);
    });
  });

  describe("country matching", () => {
    it("pairs users who each want the other's country", () => {
      engine.joinQueue(
        makeEntry({ userId: "jp", country: "JP", filters: { countries: ["IN"] } }),
        T0,
      );
      const match = engine.joinQueue(
        makeEntry({ userId: "in", country: "IN", filters: { countries: ["JP"] } }),
        T0,
      );
      expect(match).not.toBeNull();
    });

    it("leaves a one-sided country preference unmatched", () => {
      engine.joinQueue(
        makeEntry({ userId: "jp", country: "JP", filters: { countries: ["IN"] } }),
        T0,
      );
      const match = engine.joinQueue(makeEntry({ userId: "br", country: "BR" }), T0);
      expect(match).toBeNull();
      expect(engine.size).toBe(2);
    });

    it("keeps a user with an unsatisfiable country filter waiting rather than mismatching", () => {
      engine.joinQueue(
        makeEntry({ userId: "picky", country: "US", filters: { countries: ["AQ"] } }),
        T0,
      );
      for (let i = 0; i < 20; i++) {
        engine.joinQueue(makeEntry({ userId: `x${i}`, country: "US" }), T0);
      }
      expect(engine.has("picky")).toBe(true);
    });
  });

  describe("leaveQueue", () => {
    it("removes from the standard lane", () => {
      engine.joinQueue(makeEntry({ userId: "a" }), T0);
      expect(engine.leaveQueue("a")?.userId).toBe("a");
      expect(engine.size).toBe(0);
    });

    it("removes from the premium lane", () => {
      engine.joinQueue(makeEntry({ userId: "a", isPremium: true }), T0);
      expect(engine.leaveQueue("a")?.userId).toBe("a");
      expect(engine.size).toBe(0);
    });

    it("returns null for someone who is not queued", () => {
      expect(engine.leaveQueue("ghost")).toBeNull();
    });

    it("a departed user is never handed out as a partner", () => {
      engine.joinQueue(makeEntry({ userId: "a" }), T0);
      engine.leaveQueue("a");
      expect(engine.joinQueue(makeEntry({ userId: "b" }), T0)).toBeNull();
    });
  });

  describe("sweep", () => {
    it("does nothing when nobody has become compatible", () => {
      engine.joinQueue(makeEntry({ userId: "a", filters: { gender: "other" } }), T0);
      engine.joinQueue(makeEntry({ userId: "b", filters: { gender: "other" } }), T0);
      expect(engine.sweep(T0)).toHaveLength(0);
    });

    it("pairs two users who only become compatible once relaxed", () => {
      // They just talked, so stage 0 and 1 both refuse the rematch.
      const a = makeEntry({ userId: "a", recent: { b: T0 }, joinedAt: T0 });
      const b = makeEntry({ userId: "b", recent: { a: T0 }, joinedAt: T0 });
      engine.joinQueue(a, T0);
      engine.joinQueue(b, T0);

      expect(engine.sweep(T0 + 1_000)).toHaveLength(0);
      expect(engine.sweep(T0 + 30_000)).toHaveLength(0);

      const matches = engine.sweep(T0 + 61_000);
      expect(matches).toHaveLength(1);
      expect(matches[0].stage).toBe(2);
      expect(engine.size).toBe(0);
    });

    it("never returns the same user in two matches", () => {
      for (let i = 0; i < 9; i++) {
        engine.joinQueue(makeEntry({ userId: `u${i}`, joinedAt: T0, recent: { all: T0 } }), T0);
      }
      // 9 users queued but pairs form on join, so only the odd one remains.
      const matches = engine.sweep(T0);
      const seen = new Set<string>();
      for (const m of matches) {
        expect(seen.has(m.a.userId)).toBe(false);
        expect(seen.has(m.b.userId)).toBe(false);
        seen.add(m.a.userId);
        seen.add(m.b.userId);
      }
    });

    it("serves the longest waiter first", () => {
      // Two men wanting women, so they never pair with each other, plus one
      // woman they have both just talked to. Everyone is still at stage 0 when
      // they join, so nothing pairs until the sweep relaxes the rematch rule.
      const man = (userId: string, joinedAt: number) =>
        makeEntry({
          userId,
          joinedAt,
          gender: "male",
          effectiveGender: "male",
          filters: { gender: "female" },
          recent: { target: T0 },
        });

      engine.joinQueue(man("old", T0 - 2_000), T0);
      engine.joinQueue(man("mid", T0 - 1_000), T0);
      engine.joinQueue(
        makeEntry({
          userId: "target",
          joinedAt: T0,
          gender: "female",
          effectiveGender: "female",
          filters: { gender: "male" },
          recent: { old: T0, mid: T0 },
        }),
        T0,
      );
      expect(engine.size).toBe(3);

      const matches = engine.sweep(T0 + 61_000);
      expect(matches).toHaveLength(1);
      // "old" waited longest, so it is served before "mid".
      expect(matches[0].a.userId).toBe("old");
      expect(matches[0].b.userId).toBe("target");
      expect(engine.has("mid")).toBe(true);
    });
  });

  describe("stage propagation", () => {
    it("applies the more generous of the two waits", () => {
      // "waiter" has been queued long enough to reach stage 2.
      const waiter = makeEntry({ userId: "waiter", joinedAt: T0, recent: { newbie: T0 } });
      engine.joinQueue(waiter, T0);

      // A brand-new arrival that they recently talked to would be blocked at
      // stage 0, but the waiter's stage 2 lets it through.
      const match = engine.joinQueue(
        makeEntry({ userId: "newbie", joinedAt: T0 + 61_000, recent: { waiter: T0 } }),
        T0 + 61_000,
      );

      expect(match).not.toBeNull();
      expect(match!.stage).toBe(2);
    });
  });

  describe("positionOf", () => {
    it("is 1-based and puts the premium lane first", () => {
      engine.joinQueue(makeEntry({ userId: "s1", filters: { gender: "other" } }), T0);
      engine.joinQueue(
        makeEntry({ userId: "p1", isPremium: true, filters: { gender: "other" } }),
        T0,
      );
      expect(engine.positionOf("p1")).toBe(1);
      expect(engine.positionOf("s1")).toBe(2);
    });

    it("returns -1 when not queued", () => {
      expect(engine.positionOf("nobody")).toBe(-1);
    });
  });

  describe("oldestWaitMs", () => {
    it("is 0 for an empty queue", () => {
      expect(engine.oldestWaitMs(T0)).toBe(0);
    });

    it("reports the longest current wait", () => {
      engine.joinQueue(makeEntry({ userId: "a", joinedAt: T0 - 5_000, filters: { gender: "other" } }), T0);
      engine.joinQueue(makeEntry({ userId: "b", joinedAt: T0 - 90_000, filters: { gender: "other" } }), T0);
      expect(engine.oldestWaitMs(T0)).toBe(90_000);
    });
  });

  describe("reentrancy", () => {
    it("refuses a nested joinQueue rather than corrupting the lanes", () => {
      const engine2 = new MatchmakingEngine();
      // Force the guard by reaching into the private flag the same way a
      // synchronous listener re-entering mid-match would.
      (engine2 as unknown as { matching: boolean }).matching = true;
      expect(() => engine2.joinQueue(makeEntry({ userId: "a" }), T0)).toThrow(/reentrant/);
    });

    it("clears the guard after a throw so the engine stays usable", () => {
      const engine3 = new MatchmakingEngine();
      (engine3 as unknown as { matching: boolean }).matching = true;
      expect(() => engine3.joinQueue(makeEntry({ userId: "a" }), T0)).toThrow();
      (engine3 as unknown as { matching: boolean }).matching = false;
      expect(engine3.joinQueue(makeEntry({ userId: "a" }), T0)).toBeNull();
    });

    it("sweep returns empty rather than throwing when already matching", () => {
      const engine4 = new MatchmakingEngine();
      (engine4 as unknown as { matching: boolean }).matching = true;
      expect(engine4.sweep(T0)).toEqual([]);
    });
  });

  describe("clear", () => {
    it("empties both lanes and stays usable", () => {
      engine.joinQueue(makeEntry({ userId: "a", isPremium: true, filters: { gender: "other" } }), T0);
      engine.joinQueue(makeEntry({ userId: "b", filters: { gender: "other" } }), T0);
      engine.clear();
      expect(engine.size).toBe(0);
      expect(engine.joinQueue(makeEntry({ userId: "c" }), T0)).toBeNull();
    });
  });

  describe("no double-booking under load", () => {
    it("gives every matched user exactly one partner across 500 joins", () => {
      const partners = new Map<string, string>();

      for (let i = 0; i < 500; i++) {
        const m = engine.joinQueue(makeEntry({ userId: `u${i}`, joinedAt: T0 + i }), T0 + i);
        if (m) {
          // Neither side may already be paired.
          expect(partners.has(m.a.userId)).toBe(false);
          expect(partners.has(m.b.userId)).toBe(false);
          partners.set(m.a.userId, m.b.userId);
          partners.set(m.b.userId, m.a.userId);
        }
      }

      expect(partners.size).toBe(500);
      // Pairings are mutual.
      for (const [user, partner] of partners) {
        expect(partners.get(partner)).toBe(user);
      }
      expect(engine.size).toBe(0);
    });
  });
});
