import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/database";
import { authenticate, requireAdmin } from "../middleware/auth";
import { COIN_PACKS, COIN_PASSES, findPack, findPass } from "../services/coins/catalog";
import { buildUpiRequest, isUpiConfigured, looksLikeUpiRef } from "../services/coins/upi";
import { creditIn, debitIn, extendFrom } from "../services/coins/wallet";

const router = Router();

/**
 * Buying coins, and spending them.
 *
 * The shape of this is dictated by one fact: a direct UPI transfer tells the
 * server nothing. Card and gateway flows end with a signed callback saying
 * "this order was paid"; a QR ends with money arriving in a bank account and
 * silence here. So an order cannot be completed by the person who owes the
 * money — every path that grants coins runs through an administrator who has
 * seen the payment. That is slower than a gateway and it is the only honest
 * way to do it without one.
 */

/**
 * Express types this as string | string[], because a route pattern can bind a
 * parameter more than once. Ours cannot, but the narrowing has to happen
 * somewhere and it may as well happen where the value is read.
 */
function pathId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? (raw[0] ?? "") : String(raw ?? "");
}

/** How many unfinished orders one account may stack up. */
const OPEN_ORDER_LIMIT = 5;

type OrderStatus = "awaiting_payment" | "under_review" | "approved" | "rejected";

const OPEN: OrderStatus[] = ["awaiting_payment", "under_review"];

function publicOrder(order: {
  id: string;
  packId: string;
  coins: number;
  amountPaise: number;
  status: string;
  upiRef: string | null;
  note: string | null;
  createdAt: Date;
}) {
  return {
    id: order.id,
    packId: order.packId,
    coins: order.coins,
    amountPaise: order.amountPaise,
    status: order.status,
    upiRef: order.upiRef,
    note: order.note,
    createdAt: order.createdAt.toISOString(),
  };
}

/** Premium is only real until it expires; a stale flag would sell nothing. */
function premiumActive(user: { isPremium: boolean; premiumExpiry: Date | null }): boolean {
  return user.isPremium && (!user.premiumExpiry || user.premiumExpiry.getTime() > Date.now());
}

// GET /api/coins/me — balance, entitlement, and what is on sale.
router.get("/me", authenticate, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { coins: true, isPremium: true, premiumExpiry: true },
  });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    coins: user.coins,
    isPremium: premiumActive(user),
    premiumExpiry: user.premiumExpiry?.toISOString() ?? null,
    packs: COIN_PACKS,
    passes: COIN_PASSES,
    // The client hides the whole purchase path when this is false, rather than
    // showing a QR that would pay nobody.
    upiEnabled: isUpiConfigured(),
  });
});

// POST /api/coins/orders — start a purchase and get something to pay.
router.post("/orders", authenticate, async (req: Request, res: Response) => {
  if (!isUpiConfigured()) {
    res.status(503).json({ error: "Payments are not set up yet." });
    return;
  }

  const pack = findPack(req.body?.packId);
  if (!pack) {
    res.status(400).json({ error: "Unknown pack" });
    return;
  }

  // Orders are free to create and a human has to look at each one, so an
  // unbounded queue of them is a way to waste the reviewer's time rather than
  // an attack on the balance. Cap it.
  const open = await prisma.coinOrder.count({
    where: { userId: req.user!.userId, status: { in: OPEN } },
  });
  if (open >= OPEN_ORDER_LIMIT) {
    res.status(429).json({
      error: "You have too many unfinished orders. Finish or cancel one first.",
    });
    return;
  }

  const order = await prisma.coinOrder.create({
    data: {
      userId: req.user!.userId,
      packId: pack.id,
      // Copied, not looked up later: repricing the catalogue must not change
      // what an order already paid for is worth.
      coins: pack.coins,
      amountPaise: pack.amountPaise,
      status: "awaiting_payment",
    },
  });

  const upi = buildUpiRequest({
    amountPaise: pack.amountPaise,
    reference: order.id,
    note: `Omextv ${pack.name}`,
  });

  res.status(201).json({ order: publicOrder(order), upi });
});

// POST /api/coins/orders/:id/reference — "I have paid, here is the reference".
router.post("/orders/:id/reference", authenticate, async (req: Request, res: Response) => {
  const upiRef = String(req.body?.upiRef ?? "").trim();
  if (!looksLikeUpiRef(upiRef)) {
    res.status(400).json({
      error: "Enter the UPI reference or UTR from your payment app (6-35 letters or digits).",
    });
    return;
  }

  const order = await prisma.coinOrder.findUnique({ where: { id: pathId(req) } });
  if (!order || order.userId !== req.user!.userId) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  if (order.status !== "awaiting_payment" && order.status !== "rejected") {
    res.status(409).json({ error: `This order is already ${order.status.replace("_", " ")}.` });
    return;
  }

  try {
    const updated = await prisma.coinOrder.update({
      where: { id: order.id },
      // Clearing the note matters on a resubmission: leaving the old rejection
      // reason attached to an order now waiting again is just confusing.
      data: { upiRef, status: "under_review", note: null },
    });
    res.json({ order: publicOrder(updated) });
  } catch (err) {
    // The unique index on upiRef is what stops one transfer being claimed by
    // several orders — or by several accounts, which is the version that costs
    // real money.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      res.status(409).json({ error: "That reference has already been submitted." });
      return;
    }
    throw err;
  }
});

// GET /api/coins/orders — your own orders.
router.get("/orders", authenticate, async (req: Request, res: Response) => {
  const orders = await prisma.coinOrder.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: "desc" },
    take: 25,
  });
  res.json({ orders: orders.map(publicOrder) });
});

// POST /api/coins/orders/:id/cancel — give up on an unpaid order.
router.post("/orders/:id/cancel", authenticate, async (req: Request, res: Response) => {
  // Only an order nobody has claimed to have paid. Cancelling something under
  // review would let a payer hide a transfer that has already gone through.
  const cancelled = await prisma.coinOrder.updateMany({
    where: { id: pathId(req), userId: req.user!.userId, status: "awaiting_payment" },
    data: { status: "rejected", note: "Cancelled" },
  });
  if (cancelled.count === 0) {
    res.status(409).json({ error: "That order cannot be cancelled." });
    return;
  }
  res.json({ ok: true });
});

// POST /api/coins/passes — spend coins on premium days.
router.post("/passes", authenticate, async (req: Request, res: Response) => {
  const pass = findPass(req.body?.passId);
  if (!pass) {
    res.status(400).json({ error: "Unknown pass" });
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const spent = await debitIn(tx, req.user!.userId, pass.cost, {
      reason: "pass",
      refId: pass.id,
    });
    if (!spent) return null;

    const user = await tx.user.findUnique({
      where: { id: req.user!.userId },
      select: { premiumExpiry: true },
    });

    const premiumExpiry = extendFrom(user?.premiumExpiry ?? null, pass.days);
    await tx.user.update({
      where: { id: req.user!.userId },
      data: { isPremium: true, premiumExpiry },
    });

    return { balance: spent.balance, premiumExpiry };
  });

  if (!result) {
    res.status(402).json({ error: "Not enough coins.", needed: pass.cost });
    return;
  }

  res.json({
    coins: result.balance,
    isPremium: true,
    premiumExpiry: result.premiumExpiry.toISOString(),
  });
});

// GET /api/coins/ledger — where the coins went.
router.get("/ledger", authenticate, async (req: Request, res: Response) => {
  const entries = await prisma.coinLedger.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json({
    entries: entries.map((e) => ({
      id: e.id,
      delta: e.delta,
      balanceAfter: e.balanceAfter,
      reason: e.reason,
      createdAt: e.createdAt.toISOString(),
    })),
  });
});

// --- Review -----------------------------------------------------------------

// GET /api/coins/admin/orders — the queue of claims to check against the bank.
router.get("/admin/orders", authenticate, requireAdmin, async (req: Request, res: Response) => {
  const status = String(req.query.status ?? "under_review");
  const orders = await prisma.coinOrder.findMany({
    where: status === "all" ? {} : { status },
    orderBy: { createdAt: "asc" },
    take: 100,
    include: { user: { select: { username: true, email: true } } },
  });

  res.json({
    orders: orders.map((o) => ({
      ...publicOrder(o),
      username: o.user.username,
      email: o.user.email,
    })),
  });
});

// POST /api/coins/admin/orders/:id/approve — the money arrived; credit it.
router.post(
  "/admin/orders/:id/approve",
  authenticate,
  requireAdmin,
  async (req: Request, res: Response) => {
    const result = await prisma.$transaction(async (tx) => {
      /*
       * Claim the order by transitioning it, and let the row count decide.
       *
       * This is the guard against paying twice. Two approvals racing — a
       * double click, or two reviewers on the same list — both run this, and
       * only the one that finds the order still under review matches a row.
       * The loser credits nothing.
       */
      const claimed = await tx.coinOrder.updateMany({
        where: { id: pathId(req), status: "under_review" },
        data: {
          status: "approved",
          reviewedBy: req.user!.userId,
          reviewedAt: new Date(),
        },
      });
      if (claimed.count === 0) return null;

      const order = await tx.coinOrder.findUnique({ where: { id: pathId(req) } });
      if (!order) return null;

      const { balance } = await creditIn(tx, order.userId, order.coins, {
        reason: "purchase",
        refId: order.id,
      });

      return { userId: order.userId, coins: order.coins, balance };
    });

    if (!result) {
      res.status(409).json({ error: "That order is not awaiting review." });
      return;
    }

    res.json({ ok: true, credited: result.coins, balance: result.balance });
  },
);

// POST /api/coins/admin/orders/:id/reject — no matching payment found.
router.post(
  "/admin/orders/:id/reject",
  authenticate,
  requireAdmin,
  async (req: Request, res: Response) => {
    const note = String(req.body?.note ?? "").trim().slice(0, 200);

    const rejected = await prisma.coinOrder.updateMany({
      where: { id: pathId(req), status: "under_review" },
      data: {
        status: "rejected",
        note: note || "No matching payment found.",
        reviewedBy: req.user!.userId,
        reviewedAt: new Date(),
      },
    });

    if (rejected.count === 0) {
      res.status(409).json({ error: "That order is not awaiting review." });
      return;
    }

    // The reference is freed deliberately: a genuine payer who mistyped it
    // must be able to submit the correct one, and it is still unique among
    // everything not yet rejected.
    await prisma.coinOrder.update({
      where: { id: pathId(req) },
      data: { upiRef: null },
    });

    res.json({ ok: true });
  },
);

export default router;
