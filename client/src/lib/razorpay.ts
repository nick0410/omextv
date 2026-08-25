/**
 * Razorpay's hosted checkout, loaded only when someone actually buys.
 *
 * A script tag in index.html would fetch this on every page load, for every
 * visitor, including the overwhelming majority who never open the Coins page —
 * on a video chat that is a third-party request before the first frame.
 *
 * Nothing here decides whether a payment succeeded. The modal reports what the
 * browser saw, and the browser is not a trustworthy witness to money; the
 * server verifies the signature, and the webhook confirms it independently.
 */

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

interface RazorpaySuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  on(event: string, handler: (payload: unknown) => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

let loading: Promise<void> | null = null;

/** Fetch the checkout script once, however many times this is called. */
function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (loading) return loading;

  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Let the next attempt try again: this is usually a blocked request or a
      // dropped connection, not a permanent condition.
      loading = null;
      reject(new Error("Could not load the payment window."));
    };
    document.head.appendChild(script);
  });

  return loading;
}

export type CheckoutOutcome =
  | { status: "paid"; paymentId: string; orderId: string; signature: string }
  | { status: "dismissed" }
  | { status: "failed"; message: string };

/**
 * Open the modal and wait for it to end, whichever way it ends.
 *
 * Resolves rather than rejects for all three outcomes, because none of them is
 * an error in the program: a buyer changing their mind is as ordinary as one
 * paying, and treating it as a thrown exception would put a red message on
 * screen for someone who simply pressed escape.
 */
export async function openCheckout(opts: {
  keyId: string;
  gatewayOrderId: string;
  amountPaise: number;
  currency: string;
  description: string;
  prefillEmail?: string;
  prefillName?: string;
}): Promise<CheckoutOutcome> {
  await loadCheckout();
  if (!window.Razorpay) throw new Error("Could not load the payment window.");

  return new Promise<CheckoutOutcome>((resolve) => {
    // Whichever of the callbacks fires first wins; Razorpay can call both the
    // failure handler and the dismiss handler for one closed modal.
    let done = false;
    const finish = (outcome: CheckoutOutcome) => {
      if (done) return;
      done = true;
      resolve(outcome);
    };

    const checkout = new window.Razorpay!({
      key: opts.keyId,
      order_id: opts.gatewayOrderId,
      amount: opts.amountPaise,
      currency: opts.currency,
      name: "Omextv",
      description: opts.description,
      prefill: { email: opts.prefillEmail ?? "", name: opts.prefillName ?? "" },
      theme: { color: "#2563eb" },
      handler: (response: RazorpaySuccess) =>
        finish({
          status: "paid",
          paymentId: response.razorpay_payment_id,
          orderId: response.razorpay_order_id,
          signature: response.razorpay_signature,
        }),
      modal: {
        ondismiss: () => finish({ status: "dismissed" }),
      },
    });

    checkout.on("payment.failed", (payload: unknown) => {
      const description = (payload as { error?: { description?: string } })?.error?.description;
      finish({ status: "failed", message: description ?? "The payment did not go through." });
    });

    checkout.open();
  });
}
