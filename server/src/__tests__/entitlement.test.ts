import { describe, it, expect } from "vitest";
import {
  FREE_FILTERS,
  applyEntitlement,
  restrictedParts,
} from "../services/coins/entitlement";
import { MatchFilters } from "../types";

/**
 * The paywall itself.
 *
 * Everything premium sells comes down to this function saying no, so it is
 * worth being exact about what "no" means: not an error, not a partial filter,
 * but a search of everyone plus a note saying what was dropped.
 */

const filters = (over: Partial<MatchFilters> = {}): MatchFilters => ({
  gender: "any",
  countries: [],
  city: null,
  ...over,
});

describe("free-tier entitlement", () => {
  it("leaves a premium request completely alone", () => {
    const wanted = filters({ gender: "female", countries: ["IN"], city: "Pune" });
    const { filters: got, dropped } = applyEntitlement(wanted, true);

    expect(got).toEqual(wanted);
    expect(dropped).toEqual([]);
  });

  it("does not touch a free request that asked for nothing", () => {
    const wanted = filters();
    const { filters: got, dropped } = applyEntitlement(wanted, false);

    expect(got).toEqual(FREE_FILTERS);
    expect(dropped).toEqual([]);
  });

  it("drops a gender preference from a free account", () => {
    const { filters: got, dropped } = applyEntitlement(filters({ gender: "male" }), false);

    expect(got.gender).toBe("any");
    expect(dropped).toContain("gender");
  });

  it("drops a country list from a free account", () => {
    const { filters: got, dropped } = applyEntitlement(
      filters({ countries: ["IN", "DE"] }),
      false,
    );

    expect(got.countries).toEqual([]);
    expect(dropped).toContain("country");
  });

  it("counts a city as part of the country restriction", () => {
    // A city only ever narrows within a country, so letting it through while
    // blocking countries would sell half the feature by accident.
    const { filters: got, dropped } = applyEntitlement(
      filters({ countries: ["IN"], city: "Pune" }),
      false,
    );

    expect(got.city).toBeNull();
    expect(dropped).toEqual(["country"]);
  });

  it("clears everything at once when several parts were restricted", () => {
    const { filters: got, dropped } = applyEntitlement(
      filters({ gender: "female", countries: ["IN"], city: "Pune" }),
      false,
    );

    expect(got).toEqual(FREE_FILTERS);
    expect(dropped).toEqual(["gender", "country"]);
  });

  it("never reports a restriction it did not apply", () => {
    // The message shown to the user is built from `dropped`, so a stray entry
    // means telling someone a filter was removed when it was not there.
    for (const wanted of [
      filters(),
      filters({ gender: "any", countries: [] }),
      filters({ city: null }),
    ]) {
      expect(restrictedParts(wanted)).toEqual([]);
    }
  });

  it("returns filters the matcher can use, not a partially cleared object", () => {
    // A free request keeps its shape — the matcher reads all three fields and
    // an undefined would be read as "no preference" only by luck.
    const { filters: got } = applyEntitlement(
      filters({ gender: "male", countries: ["US"], city: "Reno" }),
      false,
    );

    expect(Object.keys(got).sort()).toEqual(["city", "countries", "gender"]);
    expect(got.countries).toEqual([]);
  });
});
