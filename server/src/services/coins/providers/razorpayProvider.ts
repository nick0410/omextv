import crypto from "crypto";
import { env } from "../../../config/env";
import { PaymentInstruction, PaymentProvider } from "../ports";

/**
 * Collecting money through Razorpay, which tells us when it worked.
 *
 * This is the whole reason instant crediting is possible. A UPI QR ends with
 * money in a bank account and silence; a gateway ends with a signed message
 * saying "order X was paid", which is something the server can act on without
 * a person checking a statement.
 *
 * Three things have to line up, and only the first is visible to the buyer:
 *
 *   1. an order created through Razorpay's API, which returns an id
 *   2. the buyer paying inside Razorpay's checkout against that id
 *   3. a webhook naming that id, signed with a secret only we and Razorpay know
 *
 * The signature in (3) is what makes it safe. Without verifying it, the
 * endpoint is a public URL that credits coins to whoever posts the right JSON,
 * which is worse than the manual flow it replaces.
 *
 * A razorpay.me page is not this. It collects money perfectly well and reports
 * nothing back, so it lands in exactly the same place as the QR.
 */
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly id = "razorpay";
  readonly confirmsAutomatically = true;

  isConfigured(): boolean {
    return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
  }

  /** Whether a payment can actually be *confirmed*, not merely started. */
  canVerifyWebhooks(): boolean {
    return Boolean(env.RAZORPAY_WEBHOOK_SECRET);
  }

  async instructionFor(order: {
    id: string;
    amountPaise: number;
    description: string;
  }): Promise<PaymentInstruction> {
    if (!this.isConfigured()) throw new Error("Razorpay is not configured");

    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64");
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
      body: JSON.stringify({
        amount: order.amountPaise,
        currency: "INR",
        // Our own order id travels back on every callback, which is how the
        // webhook finds the row to credit without trusting anything the
        // browser said.
        receipt: order.id,
        notes: { omextvOrderId: order.id },
      }),
    });

    const body = (await response.json()) as { id?: string; error?: { description?: string } };
    if (!response.ok || !body.id) {
      throw new Error(`Razorpay rejected the order: ${body.error?.description ?? response.status}`);
    }

    return {
      kind: "gateway",
      provider: this.id,
      keyId: env.RAZORPAY_KEY_ID,
      gatewayOrderId: body.id,
      amountPaise: order.amountPaise,
      amountRupees: (order.amountPaise / 100).toFixed(2),
      currency: "INR",
      reference: order.id,
    };
  }

  /**
   * Razorpay's own payment ids, for the rare manual submission.
   *
   * Not normally used: with this provider the buyer never types anything.
   */
  isPlausibleReference(value: string): boolean {
    return /^pay_[a-zA-Z0-9]{6,30}$/.test(value.trim());
  }

  /**
   * Is this webhook really from Razorpay?
   *
   * HMAC-SHA256 of the exact raw body with the webhook secret. The *raw* body
   * matters: re-serialising the parsed JSON reorders keys and changes
   * whitespace, so the digest stops matching and every genuine webhook is
   * rejected — which fails safe but silently stops all crediting.
   *
   * timingSafeEqual rather than ===, so a wrong signature cannot be narrowed
   * down by measuring how long the comparison took.
   */
  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false;

    const expected = crypto
      .createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Verify the handshake the browser reports after checkout closes.
   *
   * Faster than waiting for the webhook, so the buyer sees their coins at
   * once — but it comes from the browser, so it is only trusted because the
   * signature cannot be produced without the key secret. The webhook is still
   * what guarantees the credit happens if they close the tab first.
   */
  verifyCheckout(gatewayOrderId: string, paymentId: string, signature: string): boolean {
    if (!env.RAZORPAY_KEY_SECRET || !signature) return false;

    const expected = crypto
      .createHmac("sha256", env.RAZORPAY_KEY_SECRET)
      .update(`${gatewayOrderId}|${paymentId}`)
      .digest("hex");

    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /** Our order id, as it comes back on a webhook payload. */
  static orderIdFrom(payload: unknown): string | null {
    const entity = (payload as {
      payload?: { payment?: { entity?: { notes?: Record<string, string>; receipt?: string } } };
    })?.payload?.payment?.entity;

    const fromNotes = entity?.notes?.omextvOrderId;
    return typeof fromNotes === "string" && fromNotes ? fromNotes : null;
  }
}
