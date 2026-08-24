import { Router, Request, Response } from "express";
import { authenticate, requireAdmin } from "../middleware/auth";
import { asyncRoute } from "../utils/asyncRoute";
import { coins } from "../services/coins";
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
