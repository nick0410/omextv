import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import { env } from "../config/env";
import { RazorpayPaymentProvider } from "../services/coins/providers/razorpayProvider";

/**
 * The signature checks, which are the only thing standing between the webhook
 * endpoint and anyone who finds the URL.
 *
 * It takes no session and no token — Razorpay has neither — so if the digest
 * check is wrong in either direction the endpoint either credits strangers or
 * silently credits nobody. Both fail quietly, which is why these are exact.
 */

const KEY_SECRET = "test_secret_value_1234";
const WEBHOOK_SECRET = "webhook_secret_value_5678";

const sign = (payload: string, secret: string) =>
  crypto.createHmac("sha256", secret).update(payload).digest("hex");

let provider: RazorpayPaymentProvider;
const original = {
  id: env.RAZORPAY_KEY_ID,
  secret: env.RAZORPAY_KEY_SECRET,
  webhook: env.RAZORPAY_WEBHOOK_SECRET,
};

beforeEach(() => {
  env.RAZORPAY_KEY_ID = "rzp_test_abc123";
  env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  provider = new RazorpayPaymentProvider();
});

afterEach(() => {
  env.RAZORPAY_KEY_ID = original.id;
  env.RAZORPAY_KEY_SECRET = original.secret;
  env.RAZORPAY_WEBHOOK_SECRET = original.webhook;
  vi.unstubAllGlobals();
});

describe("the checkout handshake", () => {
  it("accepts a signature Razorpay would have produced", () => {
    const signature = sign("order_A|pay_B", KEY_SECRET);
    expect(provider.verifyCheckout("order_A", "pay_B", signature)).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    // What an attacker who knows the algorithm but not the secret produces.
    const forged = sign("order_A|pay_B", "not_the_secret");
    expect(provider.verifyCheckout("order_A", "pay_B", forged)).toBe(false);
  });

  it("rejects a signature for a different order", () => {
    // Replaying a real signature from a payment of one rupee against an order
    // for two thousand is the obvious attack, and the order id is in the digest
    // precisely to stop it.
    const signature = sign("order_CHEAP|pay_B", KEY_SECRET);
    expect(provider.verifyCheckout("order_EXPENSIVE", "pay_B", signature)).toBe(false);
  });

  it("rejects a signature for a different payment", () => {
    const signature = sign("order_A|pay_OTHER", KEY_SECRET);
    expect(provider.verifyCheckout("order_A", "pay_B", signature)).toBe(false);
  });

  it("rejects an empty or missing signature", () => {
    for (const junk of ["", "   ", "deadbeef"]) {
      expect(provider.verifyCheckout("order_A", "pay_B", junk)).toBe(false);
    }
  });

  it("rejects everything when no secret is configured", () => {
    // Otherwise an unconfigured deployment would verify nothing and accept
    // anything, which is the worst possible default.
    env.RAZORPAY_KEY_SECRET = "";
    const signature = sign("order_A|pay_B", KEY_SECRET);
    expect(provider.verifyCheckout("order_A", "pay_B", signature)).toBe(false);
  });
});

describe("the webhook signature", () => {
  const body = Buffer.from(JSON.stringify({ event: "payment.captured", payload: {} }));

  it("accepts a body signed with the webhook secret", () => {
    expect(provider.verifyWebhook(body, sign(body.toString(), WEBHOOK_SECRET))).toBe(true);
  });

  it("rejects a body signed with the API key secret instead", () => {
    // The two secrets are different and easy to confuse; using the wrong one
    // would let every genuine webhook through only if the check were sloppy.
    expect(provider.verifyWebhook(body, sign(body.toString(), KEY_SECRET))).toBe(false);
  });

  it("rejects a body that was altered after signing", () => {
    // The whole point: the amount, the order reference and the event are all
    // inside the signed bytes.
    const signature = sign(body.toString(), WEBHOOK_SECRET);
    const tampered = Buffer.from(
      JSON.stringify({ event: "payment.captured", payload: { extra: true } }),
    );
    expect(provider.verifyWebhook(tampered, signature)).toBe(false);
  });

  it("rejects a signature of the same content re-serialised", () => {
    // Why the raw bytes are kept rather than JSON.stringify(req.body): the
    // same object with keys in another order is a different digest.
    const reordered = Buffer.from(JSON.stringify({ payload: {}, event: "payment.captured" }));
    expect(provider.verifyWebhook(reordered, sign(body.toString(), WEBHOOK_SECRET))).toBe(false);
  });

  it("rejects everything when no webhook secret is configured", () => {
    env.RAZORPAY_WEBHOOK_SECRET = "";
    expect(provider.verifyWebhook(body, sign(body.toString(), WEBHOOK_SECRET))).toBe(false);
    expect(provider.canVerifyWebhooks()).toBe(false);
  });

  it("does not throw on a signature of a different length", () => {
    // timingSafeEqual throws when the buffers differ in length, which would
    // turn a malformed header into a 500 instead of a rejection.
    expect(() => provider.verifyWebhook(body, "abc")).not.toThrow();
    expect(provider.verifyWebhook(body, "abc")).toBe(false);
  });
});

describe("finding our order in a webhook", () => {
  it("reads the order id we attached when creating it", () => {
    const payload = {
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_1", notes: { omextvOrderId: "cm_order_1" } } } },
    };
    expect(RazorpayPaymentProvider.orderIdFrom(payload)).toBe("cm_order_1");
  });

  it("returns nothing for a payment that is not ours", () => {
    // A signed webhook for a payment made outside the app. Acknowledged, not
    // credited to somebody at random.
    for (const payload of [
      {},
      { payload: {} },
      { payload: { payment: { entity: {} } } },
      { payload: { payment: { entity: { notes: {} } } } },
      { payload: { payment: { entity: { notes: { omextvOrderId: "" } } } } },
      null,
    ]) {
      expect(RazorpayPaymentProvider.orderIdFrom(payload)).toBeNull();
    }
  });
});

describe("creating the order", () => {
  it("sends the amount in paise and carries our id in the notes", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "order_gw_1" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const instruction = await provider.instructionFor({
      id: "cm_order_1",
      amountPaise: 50_000,
      description: "Omextv 500 coins",
    });

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
    expect(body.amount).toBe(50_000);
    expect(body.currency).toBe("INR");
    // Without this the webhook has no way back to the order it paid for.
    expect(body.notes.omextvOrderId).toBe("cm_order_1");

    expect(instruction.kind).toBe("gateway");
    if (instruction.kind !== "gateway") return;
    expect(instruction.gatewayOrderId).toBe("order_gw_1");
    expect(instruction.amountRupees).toBe("500.00");
    // The publishable key goes to the browser; the secret must not.
    expect(instruction.keyId).toBe("rzp_test_abc123");
    expect(JSON.stringify(instruction)).not.toContain(KEY_SECRET);
  });

  it("fails loudly when Razorpay refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { description: "Authentication failed" } }),
      }),
    );

    await expect(
      provider.instructionFor({ id: "cm_1", amountPaise: 50_000, description: "x" }),
    ).rejects.toThrow(/Authentication failed/);
  });

  it("refuses to build anything without keys", async () => {
    env.RAZORPAY_KEY_ID = "";
    env.RAZORPAY_KEY_SECRET = "";

    await expect(
      provider.instructionFor({ id: "cm_1", amountPaise: 50_000, description: "x" }),
    ).rejects.toThrow(/not configured/);
  });

  it("refuses an amount Razorpay would reject anyway", async () => {
    // Their floor is one rupee, and hitting it upstream returns an opaque 400.
    await expect(
      provider.instructionFor({ id: "cm_1", amountPaise: 99, description: "x" }),
    ).rejects.toThrow(/at least 100 paise/);
  });

  it("confirms its own payments, which is the point of using it", () => {
    expect(provider.confirmsAutomatically).toBe(true);
  });
});
