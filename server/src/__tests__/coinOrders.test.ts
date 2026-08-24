import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

import { prisma } from "../config/database";
import { env } from "../config/env";
import { isDbReady } from "./dbAvailable";
import coinRoutes from "../routes/coins";

/**
 * The purchase path, end to end.
 *
 * Everything here exists because a direct UPI transfer cannot be verified by
 * the server. Coins are handed out by a person clicking approve, so the tests
 * that matter are the ones about that click: who may make it, what happens
 * when it is made twice, and whether a payer can reach the same outcome
 * without it.
 */

const suite = isDbReady() ? describe : describe.skip;

const app = express();
app.use(express.json());
app.use("/api/coins", coinRoutes);

const PREFIX = `otest_${Date.now()}_`;
const created: string[] = [];
let seq = 0;

interface TestUser {
  id: string;
  email: string;
  token: string;
}

async function makeUser(coins = 0): Promise<TestUser> {
  const name = `${PREFIX}${++seq}`;
  const email = `${name}@test.local`;
  const user = await prisma.user.create({
    data: { email, passwordHash: "x", username: name, gender: "male", coins },
    select: { id: true },
  });
  created.push(user.id);
  return {
    id: user.id,
    email,
    token: jwt.sign({ userId: user.id, email }, env.JWT_SECRET, { expiresIn: "1h" }),
  };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

suite("buying coins over UPI", () => {
  const originalUpi = env.UPI_ID;
  const originalAdmins = env.ADMIN_EMAILS;

  beforeAll(() => {
    env.UPI_ID = "test@paytm";
  });

  afterAll(async () => {
    env.UPI_ID = originalUpi;
    env.ADMIN_EMAILS = originalAdmins;
    if (created.length === 0) return;
    await prisma.coinLedger.deleteMany({ where: { userId: { in: created } } });
    await prisma.coinOrder.deleteMany({ where: { userId: { in: created } } });
    await prisma.user.deleteMany({ where: { id: { in: created } } });
  });

  async function orderFor(user: TestUser, packId = "starter") {
    const res = await request(app).post("/api/coins/orders").set(auth(user)).send({ packId });
    expect(res.status).toBe(201);
    return res.body as {
      order: { id: string; coins: number; status: string };
      upi: { link: string; reference: string; amountRupees: string };
    };
  }

  it("hands back something payable, tied to the order", async () => {
    const user = await makeUser();
    const { order, upi } = await orderFor(user);

    expect(order.status).toBe("awaiting_payment");
    expect(upi.amountRupees).toBe("500.00");
    // The reference is the only thread from the money back to the order.
    expect(upi.link).toContain(`tr=${upi.reference}`);
    expect(order.id).toContain(upi.reference.slice(0, 8));
  });

  it("does not credit anything just for placing an order", async () => {
    const user = await makeUser();
    await orderFor(user);

    const me = await request(app).get("/api/coins/me").set(auth(user));
    expect(me.body.coins).toBe(0);
    expect(me.body.isPremium).toBe(false);
  });

  it("moves to review once a reference is submitted, still without coins", async () => {
    const user = await makeUser();
    const { order } = await orderFor(user);

    const res = await request(app)
      .post(`/api/coins/orders/${order.id}/reference`)
      .set(auth(user))
      .send({ upiRef: `REF${Date.now()}` });

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("under_review");

    // The whole point: the payer cannot talk themselves into a balance.
    const me = await request(app).get("/api/coins/me").set(auth(user));
    expect(me.body.coins).toBe(0);
  });

  it("rejects a reference that is not shaped like one", async () => {
    const user = await makeUser();
    const { order } = await orderFor(user);

    const res = await request(app)
      .post(`/api/coins/orders/${order.id}/reference`)
      .set(auth(user))
      .send({ upiRef: "no" });

    expect(res.status).toBe(400);
  });

  it("will not let two accounts claim the same transfer", async () => {
    const ref = `DUP${Date.now()}`;
    const first = await makeUser();
    const second = await makeUser();

    const a = await orderFor(first);
    const b = await orderFor(second);

    const ok = await request(app)
      .post(`/api/coins/orders/${a.order.id}/reference`)
      .set(auth(first))
      .send({ upiRef: ref });
    expect(ok.status).toBe(200);

    // One payment, two claimants. This is the version that costs real money.
    const clash = await request(app)
      .post(`/api/coins/orders/${b.order.id}/reference`)
      .set(auth(second))
      .send({ upiRef: ref });
    expect(clash.status).toBe(409);
  });

  it("will not let someone submit a reference against another person's order", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const { order } = await orderFor(owner);

    const res = await request(app)
      .post(`/api/coins/orders/${order.id}/reference`)
      .set(auth(stranger))
      .send({ upiRef: `X${Date.now()}` });

    expect(res.status).toBe(404);
  });

  it("refuses approval to an ordinary account", async () => {
    const user = await makeUser();
    const outsider = await makeUser();
    env.ADMIN_EMAILS = ["admin@test.local"];

    const { order } = await orderFor(user);
    await request(app)
      .post(`/api/coins/orders/${order.id}/reference`)
      .set(auth(user))
      .send({ upiRef: `A${Date.now()}` });

    const res = await request(app)
      .post(`/api/coins/admin/orders/${order.id}/approve`)
      .set(auth(outsider));

    expect(res.status).toBe(403);
    const me = await request(app).get("/api/coins/me").set(auth(user));
    expect(me.body.coins).toBe(0);
  });

  it("refuses approval when nobody is configured as an administrator", async () => {
    // An empty list must not read as "anyone".
    const user = await makeUser();
    env.ADMIN_EMAILS = [];

    const { order } = await orderFor(user);
    await request(app)
      .post(`/api/coins/orders/${order.id}/reference`)
      .set(auth(user))
      .send({ upiRef: `B${Date.now()}` });

    const res = await request(app)
      .post(`/api/coins/admin/orders/${order.id}/approve`)
      .set(auth(user));
    expect(res.status).toBe(403);
  });

  it("credits the coins once an administrator approves", async () => {
    const user = await makeUser();
    const admin = await makeUser();
    env.ADMIN_EMAILS = [admin.email];

    const { order } = await orderFor(user);
    await request(app)
      .post(`/api/coins/orders/${order.id}/reference`)
      .set(auth(user))
      .send({ upiRef: `C${Date.now()}` });

    const res = await request(app)
      .post(`/api/coins/admin/orders/${order.id}/approve`)
      .set(auth(admin));

    expect(res.status).toBe(200);
    expect(res.body.credited).toBe(500);

    const me = await request(app).get("/api/coins/me").set(auth(user));
    expect(me.body.coins).toBe(500);
  });

  it("credits once even when approve is pressed twice at the same moment", async () => {
    // A double click, or two reviewers working the same list. Read-then-write
    // would pay this order out twice.
    const user = await makeUser();
    const admin = await makeUser();
    env.ADMIN_EMAILS = [admin.email];

    const { order } = await orderFor(user);
    await request(app)
      .post(`/api/coins/orders/${order.id}/reference`)
      .set(auth(user))
      .send({ upiRef: `D${Date.now()}` });

    const [one, two] = await Promise.all([
      request(app).post(`/api/coins/admin/orders/${order.id}/approve`).set(auth(admin)),
      request(app).post(`/api/coins/admin/orders/${order.id}/approve`).set(auth(admin)),
    ]);

    const codes = [one.status, two.status].sort();
    expect(codes).toEqual([200, 409]);

    const me = await request(app).get("/api/coins/me").set(auth(user));
    expect(me.body.coins).toBe(500);
    expect(
      await prisma.coinLedger.count({ where: { userId: user.id, reason: "purchase" } }),
    ).toBe(1);
  });

  it("frees the reference on rejection so a genuine payer can correct a typo", async () => {
    const user = await makeUser();
    const admin = await makeUser();
    env.ADMIN_EMAILS = [admin.email];

    const { order } = await orderFor(user);
    await request(app)
      .post(`/api/coins/orders/${order.id}/reference`)
      .set(auth(user))
      .send({ upiRef: `E${Date.now()}` });

    const rejected = await request(app)
      .post(`/api/coins/admin/orders/${order.id}/reject`)
      .set(auth(admin))
      .send({ note: "No matching payment" });
    expect(rejected.status).toBe(200);

    const retry = await request(app)
      .post(`/api/coins/orders/${order.id}/reference`)
      .set(auth(user))
      .send({ upiRef: `F${Date.now()}` });
    expect(retry.status).toBe(200);
    expect(retry.body.order.status).toBe("under_review");
    // The old rejection reason must not still be hanging off it.
    expect(retry.body.order.note).toBeNull();
  });

  it("will not approve an order nobody has claimed to have paid", async () => {
    const user = await makeUser();
    const admin = await makeUser();
    env.ADMIN_EMAILS = [admin.email];

    const { order } = await orderFor(user);

    const res = await request(app)
      .post(`/api/coins/admin/orders/${order.id}/approve`)
      .set(auth(admin));
    expect(res.status).toBe(409);
  });
});

suite("spending coins on premium", () => {
  const created2: string[] = [];

  afterAll(async () => {
    if (created2.length === 0) return;
    await prisma.coinLedger.deleteMany({ where: { userId: { in: created2 } } });
    await prisma.user.deleteMany({ where: { id: { in: created2 } } });
  });

  async function funded(coins: number): Promise<TestUser> {
    const user = await makeUser(coins);
    created2.push(user.id);
    return user;
  }

  it("turns 500 coins into thirty days", async () => {
    const user = await funded(500);

    const res = await request(app)
      .post("/api/coins/passes")
      .set(auth(user))
      .send({ passId: "month" });

    expect(res.status).toBe(200);
    expect(res.body.coins).toBe(0);
    expect(res.body.isPremium).toBe(true);

    const days = (new Date(res.body.premiumExpiry).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("declines when the balance is short, and takes nothing", async () => {
    const user = await funded(499);

    const res = await request(app)
      .post("/api/coins/passes")
      .set(auth(user))
      .send({ passId: "month" });

    expect(res.status).toBe(402);
    const me = await request(app).get("/api/coins/me").set(auth(user));
    expect(me.body.coins).toBe(499);
    expect(me.body.isPremium).toBe(false);
  });

  it("stacks a second pass instead of restarting the clock", async () => {
    const user = await funded(560);

    await request(app).post("/api/coins/passes").set(auth(user)).send({ passId: "month" });
    const second = await request(app)
      .post("/api/coins/passes")
      .set(auth(user))
      .send({ passId: "day" });

    const days = (new Date(second.body.premiumExpiry).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(30.9);
  });

  it("rejects a pass that is not on the list", async () => {
    const user = await funded(1000);
    const res = await request(app)
      .post("/api/coins/passes")
      .set(auth(user))
      .send({ passId: "forever" });

    expect(res.status).toBe(400);
    const me = await request(app).get("/api/coins/me").set(auth(user));
    expect(me.body.coins).toBe(1000);
  });
});
