import { describe, expect, it } from "vitest";
import { explainIncompatibility, isCompatible } from "../services/matchmaking/engine";
import { makeEntry } from "./helpers";

/**
 * The explainer exists because two people waiting forever is otherwise a
 * silent outcome. It has to agree with the matchmaker exactly — an explanation
 * that disagrees with the rule it describes is worse than none.
 */
describe("explainIncompatibility", () => {
  it("says nothing when the pair is fine", () => {
    const a = makeEntry({ userId: "a" });
    const b = makeEntry({ userId: "b" });
    expect(explainIncompatibility(a, b, 0, 0)).toBeNull();
    expect(isCompatible(a, b, 0, 0)).toBe(true);
  });

  it("names the gender filter that rejects, in either direction", () => {
    // The trap two friends of the same gender fall into: the detected-gender
    // default points each of them at the other gender.
    const a = makeEntry({ userId: "a", gender: "male", filters: { gender: "female" } });
    const b = makeEntry({ userId: "b", gender: "male", filters: { gender: "female" } });

    const why = explainIncompatibility(a, b, 0, 0);
    expect(why).toContain("female");
    expect(why).toContain("male");
    expect(isCompatible(a, b, 0, 0)).toBe(false);
  });

  it("blames the other person's filter when only they reject", () => {
    const a = makeEntry({ userId: "a", gender: "male" });
    const b = makeEntry({ userId: "b", gender: "male", filters: { gender: "female" } });
    expect(explainIncompatibility(a, b, 0, 0)).toMatch(/^B is searching/);
  });

  it("names the country filter and the country that missed it", () => {
    const a = makeEntry({ userId: "a", country: "IN", filters: { countries: ["IN"] } });
    const b = makeEntry({ userId: "b", country: "DE" });
    const why = explainIncompatibility(a, b, 0, 0);
    expect(why).toContain("IN");
    expect(why).toContain("DE");
  });

  it("explains a country filter meeting someone with no country", () => {
    const a = makeEntry({ userId: "a", filters: { countries: ["IN"] } });
    const b = makeEntry({ userId: "b", country: null });
    expect(explainIncompatibility(a, b, 0, 0)).toContain("no country");
  });

  it("reports the rematch window with the numbers involved", () => {
    const a = makeEntry({ userId: "a", recent: { b: 0 } });
    const b = makeEntry({ userId: "b" });
    const why = explainIncompatibility(a, b, 0, 60_000);
    expect(why).toContain("60s ago");
    expect(isCompatible(a, b, 0, 60_000)).toBe(false);
  });

  it("stops reporting the rematch window once the stage drops it", () => {
    const a = makeEntry({ userId: "a", recent: { b: 0 } });
    const b = makeEntry({ userId: "b" });
    expect(explainIncompatibility(a, b, 2, 60_000)).toBeNull();
    expect(isCompatible(a, b, 2, 60_000)).toBe(true);
  });

  it("reports blocks before anything else", () => {
    const a = makeEntry({ userId: "a", blocked: ["b"] });
    const b = makeEntry({ userId: "b", filters: { gender: "female" } });
    expect(explainIncompatibility(a, b, 0, 0)).toBe("A has blocked B");
  });

  it("never disagrees with isCompatible", () => {
    // A small matrix, checked both ways: any pair the matchmaker rejects must
    // produce a reason, and any pair it accepts must produce none.
    const variants = [
      {},
      { gender: "female" as const },
      { filters: { gender: "female" as const } },
      { filters: { countries: ["IN"] } },
      { country: "IN" },
      { country: null },
      { city: "Pune", filters: { city: "Pune" } },
    ];

    for (const [i, av] of variants.entries()) {
      for (const [j, bv] of variants.entries()) {
        const a = makeEntry({ userId: `a${i}`, ...av });
        const b = makeEntry({ userId: `b${j}`, ...bv });
        for (const stage of [0, 1, 2]) {
          const compatible = isCompatible(a, b, stage, 0);
          const why = explainIncompatibility(a, b, stage, 0);
          expect(why === null, `stage ${stage}, a=${i} b=${j}: reason "${why}"`).toBe(
            compatible,
          );
        }
      }
    }
  });
});
