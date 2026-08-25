import { describe, it, expect } from "vitest";
import {
  CALL_CHARGE_AFTER_MS,
  CALL_CHARGE_COINS,
  mayChooseGender,
  owesForCall,
} from "../services/coins/callCharge";
import { applyEntitlement } from "../services/coins/entitlement";
import { makeEntry } from "./helpers";
import { MatchFilters } from "../types";

/**
 * Who pays for a call, and who does not.
 *
 * This decides whether real balances go down, so the tests are mostly about
 * refusing to charge. Charging somebody who did not ask is the failure that
 * matters: they did not choose it and cannot avoid it, and they will notice.
 */

const filters = (over: Partial<MatchFilters> = {}): MatchFilters => ({
  gender: "any",
  countries: [],
  city: null,
  ...over,
});

describe("who owes for a call", () => {
  it("charges someone who asked for the opposite gender and got it", () => {
    const seeker = makeEntry({ gender: "male", filters: { gender: "female" } });
    const partner = makeEntry({ gender: "female" });

    expect(owesForCall(seeker, partner)).toBe(true);
  });

  it("charges nothing to the person who was simply matched", () => {
    /*
     * The one that matters. She did not ask for a man, she asked for anyone —
     * so billing her is charging for something she neither chose nor could
     * decline.
     */
    const chooser = makeEntry({ gender: "male", filters: { gender: "female" } });
    const partner = makeEntry({ gender: "female", filters: { gender: "any" } });

    expect(owesForCall(partner, chooser)).toBe(false);
  });

  it("charges nothing when both took whoever came", () => {
    const a = makeEntry({ gender: "male" });
    const b = makeEntry({ gender: "female" });

    expect(owesForCall(a, b)).toBe(false);
    expect(owesForCall(b, a)).toBe(false);
  });

  it("charges nothing for a same-gender match, even when asked for", () => {
    // The price is for choosing across genders, which is what was asked for.
    const seeker = makeEntry({ gender: "male", filters: { gender: "male" } });
    const partner = makeEntry({ gender: "male" });

    expect(owesForCall(seeker, partner)).toBe(false);
  });

  it("charges nothing to a pass holder", () => {
    // A pass already covers this; charging as well sells the same thing twice.
    const seeker = makeEntry({
      gender: "male",
      isPremium: true,
      filters: { gender: "female" },
    });
    const partner = makeEntry({ gender: "female" });

    expect(owesForCall(seeker, partner)).toBe(false);
  });

  it("uses the gender the camera read, not the one declared", () => {
    // Matching already prefers the verified value, and the charge has to agree
    // with what actually happened or it bills for a pairing that never was.
    const seeker = makeEntry({
      gender: "male",
      effectiveGender: "female",
      filters: { gender: "female" },
    });
    const partner = makeEntry({ gender: "male", effectiveGender: "female" });

    expect(owesForCall(seeker, partner)).toBe(false);
  });

  it("waits long enough that a failed connection is free", () => {
    // A call nobody managed to have is not the thing being sold.
    expect(CALL_CHARGE_AFTER_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe("who may choose a gender at all", () => {
  it("lets a pass holder through with no coins", () => {
    expect(mayChooseGender(true, 0)).toBe(true);
  });

  it("lets anyone through who can pay for one call", () => {
    expect(mayChooseGender(false, CALL_CHARGE_COINS)).toBe(true);
  });

  it("turns away anyone who cannot", () => {
    // Not a punishment: they simply match everyone, which is the free product.
    expect(mayChooseGender(false, CALL_CHARGE_COINS - 1)).toBe(false);
    expect(mayChooseGender(false, 0)).toBe(false);
  });
});

describe("what the filter rules allow now", () => {
  it("keeps a gender filter for someone holding enough coins", () => {
    const { filters: got, dropped } = applyEntitlement(
      filters({ gender: "female" }),
      false,
      CALL_CHARGE_COINS,
    );

    expect(got.gender).toBe("female");
    expect(dropped).not.toContain("gender");
  });

  it("still clears it for someone who cannot pay", () => {
    const { filters: got, dropped } = applyEntitlement(
      filters({ gender: "female" }),
      false,
      10,
    );

    expect(got.gender).toBe("any");
    expect(dropped).toContain("gender");
  });

  it("keeps countries behind the pass, coins or not", () => {
    /*
     * There is no per-call price for a country, so there is nothing to charge
     * and nothing to unlock. Letting coins buy it here would give it away.
     */
    const { filters: got, dropped } = applyEntitlement(
      filters({ gender: "female", countries: ["IN"] }),
      false,
      10_000,
    );

    expect(got.gender).toBe("female");
    expect(got.countries).toEqual([]);
    expect(dropped).toContain("country");
    expect(dropped).not.toContain("gender");
  });

  it("leaves a pass holder untouched", () => {
    const wanted = filters({ gender: "male", countries: ["IN"], city: "Pune" });
    const { filters: got, dropped } = applyEntitlement(wanted, true, 0);

    expect(got).toEqual(wanted);
    expect(dropped).toEqual([]);
  });

  it("says nothing was dropped when nothing was asked for", () => {
    const { dropped } = applyEntitlement(filters(), false, 0);
    expect(dropped).toEqual([]);
  });
});
