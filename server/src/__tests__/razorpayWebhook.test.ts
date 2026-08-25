import { describe, it, expect, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";

import { prisma } from "../config/database";
import { env } from "../config/env";
import { isDbReady } from "./dbAvailable";
import { setCoinService } from "../services/coins";
import coinRoutes from "../routes/coins";

/**
 * The webhook, which is the only endpoint here that anyone on the internet can
 * call without a token.
 *
 * Razorpay has no session to present, so the signature over the raw body is
 * the whole of the authentication. If that check is wrong the endpoint credits
 * coins to whoever posts the right JSON — so these tests are about what it
 * refuses, not what it accepts.
 */

const suite = isDbReady() ? describe : describe.skip;

const WEBHOOK_SECRET = "webhook_secret_for_tests";
const PREFIX = `whtest_${Date.now()}_`;
const created: string[] = [];
let seq = 0;

/** The app, wired the way index.ts wires it: raw bytes kept for this path. */
function makeApp() {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        if (req.url?.startsWith("/api/coins/webhook/")) {
          (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        }
      },
    }),
  );
  // The router resolves the provider per request rather than at import time,
  // so a static import still picks up whatever setCoinService(null) rebuilt.
  app.use("/api/coins", coinRoutes);
  return app;
}

async function makeOrder(): Promise<{ orderId: string; userId: string }> {
  const name = `${PREFIX}${++seq}`;
  const user = await prisma.user.create({
    data: { email: `${name}@test.local`, passwordHash: "x", username: name, gender: "male" },
    select: { id: true },
  });
  created.push(user.id);

  const order = await prisma.coinOrder.create({
    data: {
      userId: user.id,
      packId: "starter",
      coins: 500,
      amountPaise: 50_000,
      status: "awaiting_payment",
    },
    select: { id: true },
  });
  return { orderId: order.id, userId: user.id };
}

function body(orderId: string, event = "payment.captured") {
  return JSON.stringify({
    event,
    payload: { payment: { entity: { id: "pay_test_1", notes: { omextvOrderId: orderId } } } },
  });
}

const sign = (raw: string, secret = WEBHOOK_SECRET) =>
  crypto.createHmac("sha256", secret).update(raw).digest("hex");

const post = (app: express.Express, raw: string, signature: string) =>
  request(app)
    .post("/api/coins/webhook/razorpay")
    .set("content-type", "application/json")
    .set("x-razorpay-signature", signature)
    .send(raw);

suite("the Razorpay webhook", () => {
  const original = {
    provider: env.PAYMENT_PROVIDER,
    id: env.RAZORPAY_KEY_ID,
    secret: env.RAZORPAY_KEY_SECRET,
    webhook: env.RAZORPAY_WEBHOOK_SECRET,
  };

  beforeEach(() => {
    env.PAYMENT_PROVIDER = "razorpay";
    env.RAZORPAY_KEY_ID = "rzp_test_abc123";
    env.RAZORPAY_KEY_SECRET = "key_secret_for_tests";
    env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    // Force the factory to rebuild against this env.
    setCoinService(null);
  });

  afterAll(async () => {
    env.PAYMENT_PROVIDER = original.provider;
    env.RAZORPAY_KEY_ID = original.id;
    env.RAZORPAY_KEY_SECRET = original.secret;
    env.RAZORPAY_WEBHOOK_SECRET = original.webhook;
    setCoinService(null);

    if (created.length === 0) return;
    await prisma.coinLedger.deleteMany({ where: { userId: { in: created } } });
    await prisma.coinOrder.deleteMany({ where: { userId: { in: created } } });
    await prisma.user.deleteMany({ where: { id: { in: created } } });
  });

  it("credits an order on a properly signed capture", async () => {
    const { orderId, userId } = await makeOrder();
    const raw = body(orderId);

    const res = await post(makeApp(), raw, sign(raw));

    expect(res.status).toBe(200);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { coins: true } });
    expect(user?.coins).toBe(500);
  });

  it("credits nothing when the signature is wrong", async () => {
    // The case that decides whether this endpoint is safe to expose at all.
    const { orderId, userId } = await makeOrder();
    const raw = body(orderId);

    const res = await post(makeApp(), raw, sign(raw, "not_the_webhook_secret"));

    expect(res.status).toBe(400);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { coins: true } });
    expect(user?.coins).toBe(0);
  });

  it("credits nothing when the body was altered after signing", async () => {
    const { orderId } = await makeOrder();
    const victim = await makeOrder();
    const signature = sign(body(orderId));

    // Same signature, different order named inside. Without the raw-body check
    // this is how one payment credits somebody else's order.
    const res = await post(makeApp(), body(victim.orderId), signature);

    expect(res.status).toBe(400);
    const user = await prisma.user.findUnique({
      where: { id: victim.userId },
      select: { coins: true },
    });
    expect(user?.coins).toBe(0);
  });

  it("credits nothing with no signature at all", async () => {
    const { orderId, userId } = await makeOrder();

    const res = await post(makeApp(), body(orderId), "");

    expect(res.status).toBe(400);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { coins: true } });
    expect(user?.coins).toBe(0);
  });

  it("credits once when Razorpay retries the same event", async () => {
    // Razorpay retries until it gets a 2xx, so this arrives more than once as
    // a matter of course rather than as an edge case.
    const { orderId, userId } = await makeOrder();
    const raw = body(orderId);
    const app = makeApp();

    await post(app, raw, sign(raw));
    const second = await post(app, raw, sign(raw));

    // Answered 2xx so the retries stop, but nothing more is paid.
    expect(second.status).toBe(200);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { coins: true } });
    expect(user?.coins).toBe(500);
    expect(
      await prisma.coinLedger.count({ where: { userId, reason: "purchase" } }),
    ).toBe(1);
  });

  it("ignores an event that does not mean money moved", async () => {
    // "authorized" can still fail to capture. Crediting on it pays out for
    // payments that never complete.
    const { orderId, userId } = await makeOrder();
    const raw = body(orderId, "payment.authorized");

    const res = await post(makeApp(), raw, sign(raw));

    expect(res.status).toBe(200);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { coins: true } });
    expect(user?.coins).toBe(0);
  });

  it("acknowledges a signed payment that is not one of ours", async () => {
    // A payment made outside the app. Answered so retries stop, credited to
    // nobody.
    const raw = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_x", notes: {} } } },
    });

    const res = await post(makeApp(), raw, sign(raw));
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBeTruthy();
  });

  it("is not reachable at all when the gateway is not the active provider", async () => {
    // With UPI selected there is nothing for this endpoint to confirm, and an
    // endpoint that exists but cannot verify is worse than one that does not.
    env.PAYMENT_PROVIDER = "upi";
    setCoinService(null);
    const { orderId } = await makeOrder();
    const raw = body(orderId);

    const res = await post(makeApp(), raw, sign(raw));
    expect(res.status).toBe(404);
  });
});
