import { env } from "../../config/env";
import { CoinService } from "./service";
import { createPrismaCoinStore } from "./adapters/prisma";
import { UpiPaymentProvider } from "./providers/upiProvider";
import { RazorpayPaymentProvider } from "./providers/razorpayProvider";
import { PaymentProvider } from "./ports";

/**
 * Where the coin system is wired together.
 *
 * One place picks the implementations, so everything else names only the
 * interfaces — the same arrangement `services/store` uses to choose between
 * Redis and memory.
 */

let instance: CoinService | null = null;
let provider: PaymentProvider | null = null;

/**
 * Build the configured provider, complaining loudly about the two ways this
 * goes wrong quietly.
 *
 * Both are about money reaching nobody. A gateway selected without keys hands
 * every buyer an error; a gateway selected with *test* keys hands them a
 * checkout that looks real, takes nothing, and credits nothing — and test keys
 * are the normal state of an account for as long as activation takes, so this
 * is the likely mistake rather than the exotic one.
 */
function buildProvider(): PaymentProvider {
  if (env.PAYMENT_PROVIDER !== "razorpay") return new UpiPaymentProvider();

  const razorpay = new RazorpayPaymentProvider();

  if (!razorpay.isConfigured()) {
    throw new Error(
      "PAYMENT_PROVIDER is razorpay but RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set.",
    );
  }

  if (env.IS_PROD && env.RAZORPAY_KEY_ID.startsWith("rzp_test_")) {
    throw new Error(
      "Refusing to serve real buyers a Razorpay test checkout: RAZORPAY_KEY_ID is a test key " +
        "while NODE_ENV is production. Use live keys, or set PAYMENT_PROVIDER=upi.",
    );
  }

  if (!razorpay.canVerifyWebhooks()) {
    // Not fatal: the browser handshake still credits anyone who stays on the
    // page. But a buyer who closes the tab at the wrong moment has paid and
    // will never be credited, and nothing else will notice.
    console.warn(
      "  ⚠️  RAZORPAY_WEBHOOK_SECRET is not set. Payments are only credited when the buyer " +
        "stays on the page; a closed tab means paid-but-not-credited.",
    );
  }

  if (env.RAZORPAY_KEY_ID.startsWith("rzp_test_")) {
    console.warn("  ⚠️  Razorpay is in TEST mode. No real money will move.");
  }

  return razorpay;
}

export function coins(): CoinService {
  if (!instance) {
    provider = buildProvider();
    instance = new CoinService(createPrismaCoinStore(), provider);
  }
  return instance;
}

/** The active provider, for the routes that need provider-specific verification. */
export function paymentProvider(): PaymentProvider {
  coins();
  return provider!;
}

/** Replace the wired instance. Tests use this to inject in-memory backings. */
export function setCoinService(service: CoinService | null): void {
  instance = service;
  if (!service) provider = null;
}

export { CoinService } from "./service";
export * from "./ports";
