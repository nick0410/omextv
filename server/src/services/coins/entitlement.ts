import { MatchFilters } from "../../types";
import { mayChooseGender } from "./callCharge";

/**
 * What a free account is allowed to ask for.
 *
 * Free users match anyone: no gender preference, no country list, no city.
 * Choosing who you meet is the thing premium sells, and it is worth paying for
 * only if it cannot be had otherwise.
 *
 * This has to run on the server, and it has to run at the point of use.
 * Disabling the controls in the UI stops nobody — the filters arrive over a
 * socket, and a `join-queue` with any payload at all can be sent by hand from
 * a browser console in about ten seconds. A paywall enforced only in the
 * client is decoration.
 */

export const FREE_FILTERS: MatchFilters = {
  gender: "any",
  countries: [],
  city: null,
};

/** Which parts of a request a free account is not entitled to. */
export function restrictedParts(filters: MatchFilters): Array<"gender" | "country"> {
  const parts: Array<"gender" | "country"> = [];
  if (filters.gender !== "any") parts.push("gender");
  // City only ever narrows within a country, so it travels with it.
  if (filters.countries.length > 0 || filters.city) parts.push("country");
  return parts;
}

/**
 * Reduce a request to what the account may actually have.
 *
 * Deliberately clamps rather than rejects. A rejection would strand someone
 * whose saved filters became premium-only — the app remembers filters between
 * visits, so a lapsed subscriber would open the page and simply never match,
 * with an error that only fires at the moment they press start. Matching them
 * with anyone and saying what was dropped is the better failure.
 */
export function applyEntitlement(
  filters: MatchFilters,
  isPremium: boolean,
  coins = 0,
): { filters: MatchFilters; dropped: Array<"gender" | "country"> } {
  if (isPremium) return { filters, dropped: [] };

  const dropped = restrictedParts(filters);
  if (dropped.length === 0) return { filters, dropped };

  /*
   * Enough coins to pay for one call buys the gender filter for that call.
   *
   * A pass used to be the only way in, which left anyone holding coins unable
   * to spend them on the thing the coins are for. Countries stay behind the
   * pass: there is no per-call price for them, so there is nothing to charge.
   */
  if (mayChooseGender(isPremium, coins) && filters.gender !== "any") {
    const stillDropped = dropped.filter((part) => part !== "gender");
    return {
      filters: { ...FREE_FILTERS, gender: filters.gender },
      dropped: stillDropped,
    };
  }

  return { filters: { ...FREE_FILTERS }, dropped };
}
