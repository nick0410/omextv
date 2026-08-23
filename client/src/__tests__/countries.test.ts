import { describe, expect, it } from "vitest";
import {
  COUNTRY_CODES,
  countryFlag,
  countryName,
  buildOptions,
  matchesQuery,
  sortOptions,
} from "../lib/countries";

describe("countries", () => {
  it("bundles the full ISO list so the picker works with no API", () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(COUNTRY_CODES).toContain("IN");
    expect(COUNTRY_CODES).toContain("DE");
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
  });

  it("resolves readable names", () => {
    expect(countryName("IN")).toBe("India");
    expect(countryName("de")).toBe("Germany");
  });

  it("gives every bundled code a real name", () => {
    // The list and the platform's region data have to agree. A code the
    // platform does not recognise renders as "Unknown Region", which reads as
    // a broken app rather than an odd country.
    const unnamed = COUNTRY_CODES.filter((code) => {
      const name = countryName(code);
      return !name || name === code || /unknown/i.test(name);
    });
    expect(unnamed).toEqual([]);
  });

  it("returns something usable for a code the platform cannot name", () => {
    expect(countryName("QQ")).toBe("QQ");
  });

  it("builds flags from the code arithmetically", () => {
    expect(countryFlag("IN")).toBe("\u{1F1EE}\u{1F1F3}");
    expect(countryFlag("bad")).toBe("");
    expect(countryFlag("1A")).toBe("");
  });

  it("matches on name or code prefix", () => {
    const [india] = buildOptions(["IN"], {});
    expect(matchesQuery(india, "ind")).toBe(true);
    expect(matchesQuery(india, "IN")).toBe(true);
    expect(matchesQuery(india, "")).toBe(true);
    expect(matchesQuery(india, "germ")).toBe(false);
  });

  it("puts countries with people online first", () => {
    const sorted = sortOptions(buildOptions(["AF", "IN", "DE"], { IN: 3, DE: 1 }));
    expect(sorted.map((o) => o.code)).toEqual(["IN", "DE", "AF"]);
  });
});
