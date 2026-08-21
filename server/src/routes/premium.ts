import { Router, Request, Response } from "express";
import crypto from "crypto";
import { prisma } from "../config/database";
import { authenticate } from "../middleware/auth";
import { env } from "../config/env";

const router = Router();

const PLANS: Record<string, { name: string; price: number; days: number }> = {
  monthly: { name: "Omextv Premium Monthly", price: 49900, days: 30 },
  yearly: { name: "Omextv Premium Yearly", price: 399900, days: 365 },
};

// GET /api/premium/plans
router.get("/plans", (_req: Request, res: Response) => {
  res.json({
    plans: [
      {
        id: "monthly",
        name: "Omextv Premium Monthly",
        price: 499,
        currency: "INR",
        interval: "month",
        features: ["Gender filter", "Location filter", "Premium badge", "Priority matching"],
      },
      {
        id: "yearly",
        name: "Omextv Premium Yearly",
        price: 3999,
        currency: "INR",
        interval: "year",
        features: ["Everything in Monthly", "Save 33%", "Early access features", "Priority support"],
      },
    ],
  });
});

// POST /api/premium/create-order — Create Razorpay order
router.post("/create-order", authenticate, async (req: Request, res: Response) => {
  try {
    const { planId } = req.body;
    if (!planId || !PLANS[planId]) {
      res.status(400).json({ error: "Invalid plan" });
      return;
    }

    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      res.status(503).json({ error: "Payment system not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env" });
      return;
    }

    const plan = PLANS[planId];

    // Create Razorpay order via REST API
    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64");
    const orderRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: plan.price,
        currency: "INR",
        receipt: `omextv_${req.user!.userId}_${Date.now()}`,
        notes: { userId: req.user!.userId, plan: planId },
      }),
    });

    const order = (await orderRes.json()) as any;
    if (!orderRes.ok) {
      console.error("Razorpay order error:", order);
      res.status(500).json({ error: "Failed to create order" });
      return;
    }

    // Save payment record
    await prisma.payment.create({
      data: {
        userId: req.user!.userId,
        razorpayOrderId: order.id,
        amount: plan.price,
        plan: planId,
        status: "created",
      },
    });

    res.json({
      orderId: order.id,
      amount: plan.price,
      currency: "INR",
      keyId: env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/premium/verify — Verify Razorpay payment
router.post("/verify", authenticate, async (req: Request, res: Response) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      res.status(400).json({ error: "Missing payment details" });
      return;
    }

    if (!env.RAZORPAY_KEY_SECRET) {
      res.status(503).json({ error: "Payment verification not configured" });
      return;
    }

    // Verify signature
    const expectedSignature = crypto
      .createHmac("sha256", env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      res.status(400).json({ error: "Invalid payment signature" });
      return;
    }

    // Find payment record
    const payment = await prisma.payment.findUnique({
      where: { razorpayOrderId: razorpay_order_id },
    });

    if (!payment || payment.userId !== req.user!.userId) {
      res.status(400).json({ error: "Payment not found" });
      return;
    }

    if (payment.status === "paid") {
      res.json({ success: true, message: "Already verified" });
      return;
    }

    const plan = PLANS[payment.plan];
    const premiumExpiry = new Date();
    premiumExpiry.setDate(premiumExpiry.getDate() + (plan?.days || 30));

    // Update payment and user in transaction
    await prisma.$transaction([
      prisma.payment.update({
        where: { id: payment.id },
        data: { razorpayPaymentId: razorpay_payment_id, status: "paid" },
      }),
      prisma.user.update({
        where: { id: req.user!.userId },
        data: { isPremium: true, premiumExpiry },
      }),
    ]);

    res.json({ success: true, message: "Payment verified. You are now Premium!" });
  } catch (err) {
    console.error("Verify error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
