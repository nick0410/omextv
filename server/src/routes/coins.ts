import { Router, Request, Response } from "express";
import { authenticate, requireAdmin } from "../middleware/auth";
import { asyncRoute } from "../utils/asyncRoute";
import { coins, paymentProvider } from "../services/coins";
import { RazorpayPaymentProvider } from "../services/coins/providers/razorpayProvider";
import type { WithRawBody } from "../index";
import {
  CoinOrderRecord,
  OrderStatus,
  PaymentInstruction,
  Result,
} from "../services/coins/ports";

const router = Router();

/**
 * HTTP in front of the coin service.
 *
 * Nothing here decides anything. It reads the request, calls one method, and
 * turns the answer into a status code — the rules about who may buy what, and
 * when an order may be credited, all live in the service, which has no idea
 * this is a web application.
 *
 * That split is what the earlier version lacked: order limits, status
 * transitions, Prisma queries and status codes were interleaved in the same
 * handlers, so the paywall could not be tested without a database and could
 * not be reused anywhere else.
 */

/**
 * The only place a domain failure becomes a number.
 *
 * A new failure mode is a new row, not a new branch somewhere in a handler —
 * which is what keeps two endpoints from answering the same refusal with
 * different codes.
 */
const STATUS_FOR: Record<string, number> = {
  payments_unavailable: 503,
  unknown_pack: 400,
  unknown_pass: 400,
  bad_reference: 400,
  not_found: 404,
  wrong_state: 409,
  duplicate_reference: 409,
  not_awaiting_review: 409,
  too_many_open: 429,
  insufficient_coins: 402,
  not_confirmable: 409,
  already_credited: 200,
  bad_signature: 400,
};

/** Send a service result, or the failure it reported. */
function send<T, C extends string>(
  res: Response,
  result: Result<T, C>,
  present: (value: T) => unknown,
  okStatus = 200,
): void {
  if (!result.ok) {
    // An unmapped code is a programming error, not a client one: 500 says so
    // rather than inventing a plausible-looking 400.
    res.status(STATUS_FOR[result.code] ?? 500).json({ error: result.message });
    return;
  }
  res.status(okStatus).json(present(result.value));
}

/**
 * Express types a route parameter as string | string[], because a pattern can
 * bind one twice. Ours cannot, but the narrowing has to happen somewhere.
 */
function pathId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? (raw[0] ?? "") : String(raw ?? "");
}

const userId = (req: Request): string => req.user!.userId;

// --- Presentation -----------------------------------------------------------

function orderDto(order: CoinOrderRecord) {
  return {
    id: order.id,
    packId: order.packId,
    coins: order.coins,
    amountPaise: order.amountPaise,
    status: order.status,
    paymentRef: order.paymentRef,
    note: order.note,
    createdAt: order.createdAt.toISOString(),
  };
}

function paymentDto(payment: PaymentInstruction) {
  return payment;
}

// --- Buyer ------------------------------------------------------------------

router.get("/me", authenticate, asyncRoute(async (req: Request, res: Response) => {
  const wallet = await coins().walletFor(userId(req));
  if (!wallet) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    coins: wallet.coins,
    isPremium: wallet.isPremium,
    premiumExpiry: wallet.premiumExpiry?.toISOString() ?? null,
    packs: wallet.packs,
    passes: wallet.passes,
    purchasesEnabled: wallet.purchasesEnabled,
  });
}));

router.post("/orders", authenticate, asyncRoute(async (req: Request, res: Response) => {
  const result = await coins().createOrder(userId(req), req.body?.packId);
  send(
    res,
    result,
    ({ order, payment }) => ({ order: orderDto(order), payment: paymentDto(payment) }),
    201,
  );
}));

router.post("/orders/:id/reference", authenticate, asyncRoute(async (req: Request, res: Response) => {
  const result = await coins().submitReference(
    userId(req),
    pathId(req),
    String(req.body?.paymentRef ?? req.body?.upiRef ?? ""),
  );
  send(res, result, (order) => ({ order: orderDto(order) }));
}));

router.get("/orders/:id/payment", authenticate, asyncRoute(async (req: Request, res: Response) => {
  const result = await coins().reopenOrder(userId(req), pathId(req));
  send(res, result, ({ order, payment }) => ({
    order: orderDto(order),
    payment: paymentDto(payment),
  }));
}));

router.post("/orders/:id/cancel", authenticate, asyncRoute(async (req: Request, res: Response) => {
  const result = await coins().cancelOrder(userId(req), pathId(req));
  send(res, result, () => ({ ok: true }));
}));

router.get("/orders", authenticate, asyncRoute(async (req: Request, res: Response) => {
  const orders = await coins().ordersFor(userId(req));
  res.json({ orders: orders.map(orderDto) });
}));

router.post("/passes", authenticate, asyncRoute(async (req: Request, res: Response) => {
  const result = await coins().redeemPass(userId(req), req.body?.passId);
  send(res, result, ({ coins: balance, premiumExpiry }) => ({
    coins: balance,
    isPremium: true,
    premiumExpiry: premiumExpiry.toISOString(),
  }));
}));

router.get("/ledger", authenticate, asyncRoute(async (req: Request, res: Response) => {
  const entries = await coins().ledgerFor(userId(req));
  res.json({
    entries: entries.map((e) => ({
      id: e.id,
      delta: e.delta,
      balanceAfter: e.balanceAfter,
      reason: e.reason,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}));

// --- Gateway confirmation ---------------------------------------------------

/**
 * The buyer finished paying and their browser is telling us so.
 *
 * Trusted only because of the signature: HMAC of "order|payment" with the key
 * secret, which nothing in the browser can produce. Without that check this is
 * a public endpoint that credits coins to whoever posts the right shape.
 *
 * This is the fast path, for the buyer watching the screen. The webhook below
 * is the reliable one — it arrives whether or not they stay.
 */
router.post(
  "/orders/:id/verify",
  authenticate,
  asyncRoute(async (req: Request, res: Response) => {
    const provider = paymentProvider();
    if (!(provider instanceof RazorpayPaymentProvider)) {
      res.status(409).json({ error: "This payment method is not verified that way." });
      return;
    }

    const gatewayOrderId = String(req.body?.razorpay_order_id ?? "");
    const paymentId = String(req.body?.razorpay_payment_id ?? "");
    const signature = String(req.body?.razorpay_signature ?? "");

    if (!gatewayOrderId || !paymentId || !signature) {
      res.status(400).json({ error: "Missing payment details." });
      return;
    }

    if (!provider.verifyCheckout(gatewayOrderId, paymentId, signature)) {
      // Never credit on a bad signature, and never explain which part failed.
      res.status(400).json({ error: "That payment could not be verified." });
      return;
    }

    const order = await coins().ordersFor(userId(req));
    const owned = order.some((o) => o.id === pathId(req));
    if (!owned) {
      res.status(404).json({ error: "Order not found." });
      return;
    }

    const result = await coins().confirmPayment(pathId(req), paymentId);
    // "already credited" is a success from the buyer's point of view: the
    // webhook simply got there first. Saying 409 would show them an error over
    // a payment that worked.
    if (!result.ok && result.code === "already_credited") {
      res.json({ ok: true, alreadyCredited: true });
      return;
    }
    send(res, result, ({ credited, balance }) => ({ ok: true, credited, balance }));
  }),
);

/**
 * Razorpay telling us directly, server to server.
 *
 * The authoritative path. The browser handshake above is faster but optional —
 * a buyer who pays and closes the tab produces no handshake at all, and
 * without this they would have paid and never been credited.
 *
 * Deliberately unauthenticated: Razorpay has no session. The signature over
 * the raw body is what stands in for one, which is why the body parser keeps
 * those exact bytes.
 *
 * Always answers 2xx once the signature is good, including for a payment
 * already credited. Razorpay retries anything else, and retrying something
 * that already succeeded is noise rather than recovery.
 */
router.post(
  "/webhook/razorpay",
  asyncRoute(async (req: Request, res: Response) => {
    const provider = paymentProvider();
    if (!(provider instanceof RazorpayPaymentProvider)) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const raw = (req as Request & WithRawBody).rawBody;
    const signature = String(req.headers["x-razorpay-signature"] ?? "");

    if (!raw || !provider.verifyWebhook(raw, signature)) {
      res.status(400).json({ error: "Bad signature" });
      return;
    }

    const event = String((req.body as { event?: string })?.event ?? "");
    // Only the event that means money actually moved. Razorpay sends several
    // for one payment, and crediting on "authorized" would pay out for a
    // payment that can still fail to capture.
    if (event !== "payment.captured") {
      res.json({ ok: true, ignored: event });
      return;
    }

    const orderId = RazorpayPaymentProvider.orderIdFrom(req.body);
    if (!orderId) {
      // Signed by Razorpay but not one of ours — a payment made outside the
      // app, for instance. Acknowledge it so they stop retrying.
      res.json({ ok: true, ignored: "no order reference" });
      return;
    }

    const paymentId = String(
      (req.body as { payload?: { payment?: { entity?: { id?: string } } } })?.payload?.payment
        ?.entity?.id ?? "",
    );

    const result = await coins().confirmPayment(orderId, paymentId);
    if (!result.ok && result.code === "not_found") {
      res.json({ ok: true, ignored: "unknown order" });
      return;
    }
    res.json({ ok: true, credited: result.ok ? result.value.credited : 0 });
  }),
);

// --- Review -----------------------------------------------------------------

router.get("/admin/orders", authenticate, requireAdmin, asyncRoute(async (req: Request, res: Response) => {
  // Validated rather than cast. An unrecognised value used to reach the query
  // and quietly return nothing, which reads as "no payments waiting" — the one
  // answer a reviewer must never be given wrongly.
  const allowed: Array<OrderStatus | "all"> = [
    "awaiting_payment",
    "under_review",
    "approved",
    "rejected",
    "all",
  ];
  const requested = String(req.query.status ?? "under_review") as OrderStatus | "all";
  if (!allowed.includes(requested)) {
    res.status(400).json({ error: "Unknown status filter" });
    return;
  }
  const status = requested;

  const orders = await coins().ordersForReview(status);
  res.json({
    orders: orders.map((order) => ({
      ...orderDto(order),
      username: order.username,
      email: order.email,
    })),
  });
}));

router.post(
  "/admin/orders/:id/approve",
  authenticate,
  requireAdmin,
  asyncRoute(async (req: Request, res: Response) => {
    const result = await coins().approveOrder(pathId(req), userId(req));
    send(res, result, ({ credited, balance }) => ({ ok: true, credited, balance }));
  }),
);

router.post(
  "/admin/orders/:id/reject",
  authenticate,
  requireAdmin,
  asyncRoute(async (req: Request, res: Response) => {
    const result = await coins().rejectOrder(
      pathId(req),
      userId(req),
      String(req.body?.note ?? ""),
    );
    send(res, result, () => ({ ok: true }));
  }),
);

export default router;
