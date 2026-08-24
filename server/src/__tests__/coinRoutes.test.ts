import { describe, it, expect, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

import { prisma } from "../config/database";
import { env } from "../config/env";
import { isDbReady } from "./dbAvailable";
import coinRoutes from "../routes/coins";

/**
 * The HTTP layer, and only the HTTP layer.
 *
 * What the rules are is settled in coinService.test.ts, without a database.
 * What is left for this file is the part that only exists over the wire: who
 * is allowed through the door, and which number a refusal comes back as. Those
 * are the things a service test cannot see and a client depends on exactly.
 */

const suite = isDbReady() ? describe : describe.skip;

const app = express();
app.use(express.json());
app.use("/api/coins", coinRoutes);

const PREFIX = `rtest_${Date.now()}_`;
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

suite("coin endpoints", () => {
  const originalUpi = env.UPI_ID;
  const originalAdmins = env.ADMIN_EMAILS;

  beforeEach(() => {
    env.UPI_ID = "test@paytm";
    env.ADMIN_EMAILS = [];
  });

  afterAll(async () => {
    env.UPI_ID = originalUpi;
    env.ADMIN_EMAILS = originalAdmins;
    if (created.length === 0) return;
    await prisma.coinLedger.deleteMany({ where: { userId: { in: created } } });
    await prisma.coinOrder.deleteMany({ where: { userId: { in: created } } });
    await prisma.user.deleteMany({ where: { id: { in: created } } });
  });

  describe("who gets in", () => {
    it("turns every endpoint away without a token", async () => {
      const routes: Array<[string, string]> = [
        ["get", "/api/coins/me"],
        ["get", "/api/coins/orders"],
        ["get", "/api/coins/ledger"],
        ["post", "/api/coins/orders"],
        ["post", "/api/coins/passes"],
        ["get", "/api/coins/admin/orders"],
      ];

      for (const [method, path] of routes) {
        const res = await (method === "get" ? request(app).get(path) : request(app).post(path));
        expect(res.status, path).toBe(401);
      }
    });

    it("refuses review to an ordinary account", async () => {
      const admin = await makeUser();
      const outsider = await makeUser();
      env.ADMIN_EMAILS = [admin.email];

      const res = await request(app).get("/api/coins/admin/orders").set(auth(outsider));
      expect(res.status).toBe(403);
    });

    it("refuses review to everyone when no administrator is configured", async () => {
      // An empty list must not read as "anyone".
      const user = await makeUser();
      env.ADMIN_EMAILS = [];

      const res = await request(app).get("/api/coins/admin/orders").set(auth(user));
      expect(res.status).toBe(403);
    });

    it("checks the administrator against the database, not the token", async () => {
      // A token lasts seven days and carries whatever the address was when it
      // was issued. This is the check standing between a stranger and the
      // ability to credit themselves any balance they like.
      const admin = await makeUser();
      env.ADMIN_EMAILS = [admin.email];

      const forged = jwt.sign(
        { userId: admin.id, email: "someone-else@test.local" },
        env.JWT_SECRET,
        { expiresIn: "1h" },
      );
      const res = await request(app)
        .get("/api/coins/admin/orders")
        .set({ Authorization: `Bearer ${forged}` });

      // The email on the token is ignored, so this still succeeds — and the
      // reverse case, a token claiming an admin address for a non-admin
      // account, is refused for the same reason.
      expect(res.status).toBe(200);

      const impostor = await makeUser();
      const claiming = jwt.sign(
        { userId: impostor.id, email: admin.email },
        env.JWT_SECRET,
        { expiresIn: "1h" },
      );
      const denied = await request(app)
        .get("/api/coins/admin/orders")
        .set({ Authorization: `Bearer ${claiming}` });
      expect(denied.status).toBe(403);
    });
  });

  describe("what a refusal comes back as", () => {
    it("400 for something not on the price list", async () => {
      const user = await makeUser();
      const res = await request(app)
        .post("/api/coins/orders")
        .set(auth(user))
        .send({ packId: "free" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    });

    it("503 when no payee is configured", async () => {
      env.UPI_ID = "";
      const user = await makeUser();

      const res = await request(app)
        .post("/api/coins/orders")
        .set(auth(user))
        .send({ packId: "starter" });
      expect(res.status).toBe(503);
    });

    it("402 when the balance is short", async () => {
      // Distinct from 400: the request was fine, the money was not.
      const user = await makeUser(10);
      const res = await request(app)
        .post("/api/coins/passes")
        .set(auth(user))
        .send({ passId: "month" });

      expect(res.status).toBe(402);
    });

    it("404 for an order belonging to someone else", async () => {
      const owner = await makeUser();
      const stranger = await makeUser();
      const created = await request(app)
        .post("/api/coins/orders")
        .set(auth(owner))
        .send({ packId: "starter" });

      const res = await request(app)
        .post(`/api/coins/orders/${created.body.order.id}/reference`)
        .set(auth(stranger))
        .send({ paymentRef: "ABC123456" });
      expect(res.status).toBe(404);
    });

    it("409 for an order that is not awaiting review", async () => {
      const admin = await makeUser();
      env.ADMIN_EMAILS = [admin.email];
      const user = await makeUser();

      const created = await request(app)
        .post("/api/coins/orders")
        .set(auth(user))
        .send({ packId: "starter" });

      const res = await request(app)
        .post(`/api/coins/admin/orders/${created.body.order.id}/approve`)
        .set(auth(admin));
      expect(res.status).toBe(409);
    });

    it("429 once too many orders are left unfinished", async () => {
      const user = await makeUser();
      let last = 0;
      for (let i = 0; i < 8; i++) {
        const res = await request(app)
          .post("/api/coins/orders")
          .set(auth(user))
          .send({ packId: "starter" });
        last = res.status;
      }
      expect(last).toBe(429);
    });
  });

  describe("what the client is handed", () => {
    it("describes the wallet without the client restating any prices", async () => {
      const user = await makeUser(250);
      const res = await request(app).get("/api/coins/me").set(auth(user));

      expect(res.status).toBe(200);
      expect(res.body.coins).toBe(250);
      expect(res.body.isPremium).toBe(false);
      expect(Array.isArray(res.body.packs)).toBe(true);
      expect(Array.isArray(res.body.passes)).toBe(true);
      expect(res.body.purchasesEnabled).toBe(true);
    });

    it("returns 201 and a payment instruction when an order is created", async () => {
      const user = await makeUser();
      const res = await request(app)
        .post("/api/coins/orders")
        .set(auth(user))
        .send({ packId: "starter" });

      expect(res.status).toBe(201);
      expect(res.body.order.status).toBe("awaiting_payment");
      expect(res.body.payment.kind).toBe("upi");
      expect(res.body.payment.link.startsWith("upi://pay?")).toBe(true);
      expect(res.body.payment.amountRupees).toBe("500.00");
    });

    it("never leaks the reviewer or the buyer's email to the buyer", async () => {
      const user = await makeUser();
      const created = await request(app)
        .post("/api/coins/orders")
        .set(auth(user))
        .send({ packId: "starter" });

      const listed = await request(app).get("/api/coins/orders").set(auth(user));
      const order = listed.body.orders.find(
        (o: { id: string }) => o.id === created.body.order.id,
      );
      expect(order).toBeTruthy();
      expect(order.reviewedBy).toBeUndefined();
      expect(order.email).toBeUndefined();
    });

    it("shows the reviewer who placed each order", async () => {
      const admin = await makeUser();
      env.ADMIN_EMAILS = [admin.email];
      const user = await makeUser();

      const created = await request(app)
        .post("/api/coins/orders")
        .set(auth(user))
        .send({ packId: "starter" });
      await request(app)
        .post(`/api/coins/orders/${created.body.order.id}/reference`)
        .set(auth(user))
        .send({ paymentRef: `R${Date.now()}` });

      const res = await request(app)
        .get("/api/coins/admin/orders")
        .set(auth(admin));

      const order = res.body.orders.find((o: { id: string }) => o.id === created.body.order.id);
      expect(order.email).toBe(user.email);
      expect(order.paymentRef).toBeTruthy();
    });
  });
});
