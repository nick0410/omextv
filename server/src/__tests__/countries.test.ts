import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COUNTRY_CODES } from "../config/countries";

/**
 * The client bundles its own copy of the country list so the picker keeps
 * working when the API is unreachable. Two copies can drift, and drift is
 * invisible until someone cannot find their country — so assert they match.
 */
function clientCodes(): string[] {
  const file = join(__dirname, "../../../client/src/lib/countries.ts");
  const source = readFileSync(file, "utf-8");
  const block = /export const COUNTRY_CODES: readonly string\[\] = \[([\s\S]*?)\];/.exec(source);
  if (!block) throw new Error("COUNTRY_CODES not found in the client's countries.ts");
  return [...block[1].matchAll(/"([A-Z]{2})"/g)].map((m) => m[1]);
}

describe("country list", () => {
  it("is identical on the client and the server", () => {
    expect(clientCodes()).toEqual([...COUNTRY_CODES]);
  });

  it("has no duplicates", () => {
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
  });

  it("is every code the validator accepts", () => {
    // A code the picker offers but the server rejects means a user can pick a
    // country and then never match anyone.
    expect(COUNTRY_CODES.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
  });
});
