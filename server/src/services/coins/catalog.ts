/**
 * What can be bought, and what it costs.
 *
 * One file on purpose. Prices end up copied into a checkout screen, a receipt,
 * an upsell banner and a test, and the copies drift — someone is then charged
 * one number and shown another. Everything here is the single source of truth;
 * the client fetches it rather than restating it.
 *
 * Two separate steps, deliberately:
 *
 *   rupees -> coins   (a pack, paid over UPI, credited once a human confirms)
 *   coins  -> days    (a pass, spent instantly, no payment involved)
 *
 * Splitting them is what makes the balance worth holding. A single "₹500 buys
 * a month" button is one decision the buyer makes once and then re-makes from
 * scratch every renewal. A balance is already theirs, so spending it is a
 * smaller decision than paying again — and whatever is left over pulls them
 * back rather than lapsing.
 */

export interface CoinPack {
  id: string;
  name: string;
  /** Charged in paise, because money in floating point eventually loses a rupee. */
  amountPaise: number;
  /** Credited on approval. */
  coins: number;
  /** Coins above the plain 1 rupee = 1 coin rate, for display. */
  bonusCoins: number;
  best?: boolean;
}

export interface CoinPass {
  id: string;
  name: string;
  cost: number;
  days: number;
}

/*
 * The anchor is ₹500 -> 500 coins -> 30 days, so the headline price of a month
 * is exactly ₹500 and the coin has an obvious, memorable value: one rupee.
 *
 * Bigger packs pay a bonus rather than a discount. A discount lowers what a
 * month costs; a bonus hands out coins, which are only worth anything spent
 * here — so the larger pack raises the money taken today and leaves a balance
 * behind, without ever printing a cheaper price for the same month.
 */
export const COIN_PACKS: CoinPack[] = [
  { id: "starter", name: "500 coins", amountPaise: 50_000, coins: 500, bonusCoins: 0 },
  { id: "plus", name: "1,150 coins", amountPaise: 100_000, coins: 1_150, bonusCoins: 150, best: true },
  { id: "pro", name: "2,500 coins", amountPaise: 200_000, coins: 2_500, bonusCoins: 500 },
];

/*
 * The day pass exists to be bought by someone who will not spend ₹500 — it
 * turns "no" into a small yes, and a day of the filters working is the best
 * argument for the month. It is priced per-day well above the month so the
 * month stays the sensible choice for anyone who has already decided.
 */
export const COIN_PASSES: CoinPass[] = [
  { id: "day", name: "1 day", cost: 30, days: 1 },
  { id: "week", name: "7 days", cost: 150, days: 7 },
  { id: "month", name: "30 days", cost: 500, days: 30 },
];

export function findPack(id: unknown): CoinPack | null {
  return COIN_PACKS.find((p) => p.id === id) ?? null;
}

export function findPass(id: unknown): CoinPass | null {
  return COIN_PASSES.find((p) => p.id === id) ?? null;
}

/** Paise to a display string, e.g. 50000 -> "500". */
export function rupees(paise: number): string {
  return (paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
