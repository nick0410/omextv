import { env } from "../../config/env";

/**
 * Building the `upi://pay` link a payer's app opens.
 *
 * The format is a plain query string, which makes it easy to get subtly wrong
 * in ways that still "work": an unescaped payee name truncates the note, a
 * mistyped amount is silently editable in some apps, and a missing reference
 * leaves the payment impossible to match against an order afterwards. All
 * three end with real money in the right account and no way to tell whose it
 * was, so every field here is deliberate.
 *
 * On a phone the link opens the UPI app directly. On a desktop it is rendered
 * as a QR for the phone to scan — the same string either way, which is why the
 * QR is generated from this rather than being an image somebody uploads: an
 * uploaded QR cannot carry the amount or the per-order reference, and cannot
 * be checked against the configured payee at all.
 */

export interface UpiRequest {
  /** The full upi:// link, and what the QR encodes. */
  link: string;
  /** Shown next to the QR so the payer can check who they are paying. */
  payeeVpa: string;
  payeeName: string;
  amountRupees: string;
  /** Echoed into the payer's app and their statement, to match the order later. */
  reference: string;
}

export function isUpiConfigured(): boolean {
  return env.UPI_ID.trim().length > 0;
}

/**
 * A UPI id is `handle@provider`. Checked rather than trusted because the cost
 * of a typo is a stranger receiving payments that cannot be clawed back.
 */
export function looksLikeVpa(value: string): boolean {
  return /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.-]{1,32}$/.test(value.trim());
}

export function buildUpiRequest(opts: {
  amountPaise: number;
  reference: string;
  note: string;
}): UpiRequest {
  const vpa = env.UPI_ID.trim();
  if (!vpa) throw new Error("UPI_ID is not configured");

  // Two decimals, always. Some apps read "500" and "500.0" differently, and a
  // rounded-off paisa is a mismatch against the statement later.
  const amount = (opts.amountPaise / 100).toFixed(2);

  // Alphanumeric only: several apps drop the reference entirely if it carries
  // punctuation, which loses the one field that ties money to an order.
  const reference = opts.reference.replace(/[^a-zA-Z0-9]/g, "").slice(0, 35);

  const params = new URLSearchParams({
    pa: vpa,
    pn: env.UPI_PAYEE_NAME,
    am: amount,
    cu: "INR",
    tn: opts.note.slice(0, 50),
    tr: reference,
  });

  return {
    link: `upi://pay?${params.toString()}`,
    payeeVpa: vpa,
    payeeName: env.UPI_PAYEE_NAME,
    amountRupees: amount,
    reference,
  };
}

/**
 * A UPI reference (UTR) as printed by the payer's bank app.
 *
 * Banks are not consistent — 12 digits is the common UTR, but app-generated
 * reference ids run longer and some include letters. Accepting a broad shape
 * and letting a human do the real check beats rejecting a genuine payer over a
 * format guess; the uniqueness constraint is what stops the same reference
 * being used twice.
 */
export function looksLikeUpiRef(value: string): boolean {
  return /^[a-zA-Z0-9]{6,35}$/.test(value.trim());
}
