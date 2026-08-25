import { QueueEntry } from "../../types";

/**
 * Charging for a call where somebody chose who they met.
 *
 * Matching is free and always has been. What costs money is choosing — and
 * there are two ways to pay for it: a pass, which covers everything for a
 * fixed period, or fifty coins for the one call. A pass holder is never
 * charged per call; charging both would be selling the same thing twice.
 *
 * Only the person who asked pays. Somebody matched with the opposite gender by
 * chance did not ask for anything and cannot avoid it, so billing them would
 * be charging for something they neither chose nor can decline.
 */

/** What one such call costs. */
export const CALL_CHARGE_COINS = 50;

/**
 * How long the call has to last before it counts.
 *
 * A connection that fails, or a person who leaves immediately, is not the
 * thing being sold. Fifteen seconds is long enough to be a conversation and
 * short enough that nobody games it.
 */
export const CALL_CHARGE_AFTER_MS = 15_000;

/**
 * Should this person be charged for this pairing?
 *
 * Three things have to hold. They asked for a gender rather than taking
 * whoever came; they got somebody of a different gender than their own, which
 * is the thing they were asking for; and they have no pass covering it.
 */
export function owesForCall(seeker: QueueEntry, partner: QueueEntry): boolean {
  // A pass already covers this.
  if (seeker.isPremium) return false;

  // They took whoever was available, so there is nothing to charge for.
  const wanted = seeker.filters.gender;
  if (wanted !== "male" && wanted !== "female") return false;

  // Same gender is not what the charge is for.
  return partner.effectiveGender !== seeker.effectiveGender;
}

/**
 * Whether an account can use a gender filter at all.
 *
 * A pass, or enough coins to pay for one call. Without either the filter is
 * cleared, exactly as it was before per-call charging existed — the difference
 * is that a pass is no longer the only way in.
 */
export function mayChooseGender(isPremium: boolean, coins: number): boolean {
  return isPremium || coins >= CALL_CHARGE_COINS;
}
