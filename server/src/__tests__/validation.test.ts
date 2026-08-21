import { describe, it, expect } from "vitest";
import {
  normalizeCountry,
  normalizeCountryList,
  isValidCountry,
  COUNTRY_CODES,
} from "../config/countries";
import { parseMatchFilters, registerSchema, reportSchema } from "../utils/validation";

describe("countries", () => {
  it("accepts a valid code in any case", () => {
    expect(normalizeCountry("in")).toBe("IN");
    expect(normalizeCountry("In")).toBe("IN");
    expect(normalizeCountry(" jp ")).toBe("JP");
  });

  it("rejects names and invented codes", () => {
    expect(normalizeCountry("India")).toBeNull();
    expect(normalizeCountry("USA")).toBeNull();
    expect(normalizeCountry("ZZ")).toBeNull();
    expect(normalizeCountry("")).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(normalizeCountry(42)).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry(["IN"])).toBeNull();
  });

  it("isValidCountry agrees with the list", () => {
    expect(isValidCountry("US")).toBe(true);
    expect(isValidCountry("XX")).toBe(false);
  });

  it("has no duplicate codes", () => {
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
  });

  it("every code is two uppercase letters", () => {
    for (const code of COUNTRY_CODES) expect(code).toMatch(/^[A-Z]{2}$/);
  });

  describe("normalizeCountryList", () => {
    it("normalizes, dedupes and drops invalid entries", () => {
      expect(normalizeCountryList(["in", "IN", "bogus", "jp"])).toEqual(["IN", "JP"]);
    });

    it("returns empty for a non-array", () => {
      expect(normalizeCountryList("IN")).toEqual([]);
      expect(normalizeCountryList(null)).toEqual([]);
    });

    it("caps the list length", () => {
      const many = COUNTRY_CODES.slice(0, 40);
      expect(normalizeCountryList(many).length).toBe(10);
      expect(normalizeCountryList(many, 3).length).toBe(3);
    });

    it("survives junk inside the array", () => {
      expect(normalizeCountryList([null, 5, {}, "IN", undefined])).toEqual(["IN"]);
    });
  });
});

describe("parseMatchFilters", () => {
  it("defaults to no constraints", () => {
    expect(parseMatchFilters(undefined)).toEqual({ gender: "any", countries: [], city: null });
    expect(parseMatchFilters(null)).toEqual({ gender: "any", countries: [], city: null });
  });

  it("falls back to defaults for junk input", () => {
    expect(parseMatchFilters("nonsense").gender).toBe("any");
    expect(parseMatchFilters(123).countries).toEqual([]);
  });

  it("keeps a valid gender preference", () => {
    expect(parseMatchFilters({ gender: "female" }).gender).toBe("female");
    // Sign-up is binary now, but the filter still accepts "other" so accounts
    // created before that change remain reachable.
    expect(parseMatchFilters({ gender: "other" }).gender).toBe("other");
  });

  it("coerces an unknown gender to 'any' rather than erroring", () => {
    expect(parseMatchFilters({ gender: "attack helicopter" }).gender).toBe("any");
    expect(parseMatchFilters({ gender: 42 }).gender).toBe("any");
  });

  it("normalizes the country list", () => {
    expect(parseMatchFilters({ countries: ["in", "JP", "zz"] }).countries).toEqual(["IN", "JP"]);
  });

  it("keeps a city only when exactly one country is selected", () => {
    expect(parseMatchFilters({ countries: ["IN"], city: "Mumbai" }).city).toBe("Mumbai");
    // Ambiguous across two countries.
    expect(parseMatchFilters({ countries: ["IN", "JP"], city: "Mumbai" }).city).toBeNull();
    // Meaningless with no country.
    expect(parseMatchFilters({ city: "Mumbai" }).city).toBeNull();
  });

  it("trims the city", () => {
    expect(parseMatchFilters({ countries: ["IN"], city: "  Delhi  " }).city).toBe("Delhi");
  });

  it("drops an over-long city instead of truncating it", () => {
    const long = "x".repeat(200);
    expect(parseMatchFilters({ countries: ["IN"], city: long }).city).toBeNull();
  });

  it("ignores extra properties", () => {
    const parsed = parseMatchFilters({ gender: "male", isAdmin: true, __proto__: { x: 1 } });
    expect(parsed).toEqual({ gender: "male", countries: [], city: null });
  });
});

describe("registerSchema", () => {
  const valid = {
    email: "a@b.com",
    password: "longenough1",
    username: "user_1",
    gender: "male",
  };

  it("accepts a valid payload", () => {
    expect(registerSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a short password", () => {
    expect(registerSchema.safeParse({ ...valid, password: "short" }).success).toBe(false);
  });

  it("rejects an absurdly long password before it reaches bcrypt", () => {
    const parsed = registerSchema.safeParse({ ...valid, password: "x".repeat(5000) });
    expect(parsed.success).toBe(false);
  });

  it("rejects a username with punctuation", () => {
    expect(registerSchema.safeParse({ ...valid, username: "bad name!" }).success).toBe(false);
  });

  it("rejects an unknown gender", () => {
    expect(registerSchema.safeParse({ ...valid, gender: "unknown" }).success).toBe(false);
  });

  it("no longer accepts 'other' at sign-up", () => {
    expect(registerSchema.safeParse({ ...valid, gender: "other" }).success).toBe(false);
  });

  it("rejects a country name and accepts a code", () => {
    expect(registerSchema.safeParse({ ...valid, country: "India" }).success).toBe(false);
    const ok = registerSchema.safeParse({ ...valid, country: "in" });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.country).toBe("IN");
  });
});

describe("reportSchema", () => {
  const valid = { reportedId: "u2", reason: "They were being abusive on camera" };

  it("accepts a valid report", () => {
    expect(reportSchema.safeParse(valid).success).toBe(true);
  });

  it("defaults the category", () => {
    const parsed = reportSchema.safeParse(valid);
    expect(parsed.success && parsed.data.category).toBe("other");
  });

  it("rejects a too-short reason", () => {
    expect(reportSchema.safeParse({ ...valid, reason: "bad" }).success).toBe(false);
  });

  it("rejects an unknown category", () => {
    expect(reportSchema.safeParse({ ...valid, category: "vibes" }).success).toBe(false);
  });
});
