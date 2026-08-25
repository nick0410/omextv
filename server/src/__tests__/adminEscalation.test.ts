import { describe, it, expect, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

import { prisma } from "../config/database";
import { env } from "../config/env";
import { isDbReady } from "./dbAvailable";
import { registerSchema, loginSchema } from "../utils/validation";
import adminRoutes from "../routes/admin";

/**
 * The administrator gate, against the way it was actually got past.
 *
 * Addresses were stored exactly as typed and Postgres compares by bytes, so
 * the uppercase spelling of the administrator's address was a free, ordinary
 * account. The gate lowercased before comparing and accepted it — which is the
 * ability to approve payments and credit any balance to anyone who knew an
 * address published on the contact page.
 *
 * These are written from the attacker's side, because that is the only
 * direction that would have caught it.
 */

const suite = isDbReady() ? describe : describe.skip;

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

const PREFIX = `esc_${Date.now()}_`;
const created: string[] = [];
let seq = 0;

async function makeUser(email: string) {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: "x",
      username: `${PREFIX}${++seq}`,
      gender: "male",
    },
    select: { id: true, email: true },
  });
  created.push(user.id);
  return {
    ...user,
    token: jwt.sign({ userId: user.id, email: user.email }, env.JWT_SECRET, {
      expiresIn: "1h",
    }),
  };
}

const asAdmin = (token: string) =>
  request(app).get("/api/admin/overview").set({ Authorization: `Bearer ${token}` });

describe("addresses arriving from outside", () => {
  it("are lowercased before anything sees them", () => {
    // The fix, at the only place it can be applied once: both entry points
    // share this schema, so a new one cannot forget.
    const parsed = registerSchema.safeParse({
      email: "  MiXeD@Example.COM ",
      password: "longenoughpassword",
        username: "someone",
      gender: "male",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.email).toBe("mixed@example.com");
  });

  it("are lowercased on sign-in too", () => {
    // Otherwise the account exists and its owner cannot reach it.
    const parsed = loginSchema.safeParse({
      email: "MiXeD@Example.COM",
      password: "longenoughpassword",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.email).toBe("mixed@example.com");
  });

  it("still rejects something that is not an address", () => {
    expect(loginSchema.safeParse({ email: "NOT AN EMAIL", password: "x".repeat(12) }).success)
      .toBe(false);
  });
});

suite("getting into the review queue", () => {
  const original = env.ADMIN_EMAILS;

  beforeEach(() => {
    env.ADMIN_EMAILS = ["owner@example.com"];
  });

  afterAll(async () => {
    env.ADMIN_EMAILS = original;
    if (created.length === 0) return;
    await prisma.user.deleteMany({ where: { id: { in: created } } });
  });

  it("lets the administrator in", async () => {
    const owner = await makeUser("owner@example.com");
    expect((await asAdmin(owner.token)).status).toBe(200);
  });

  it("keeps out an account spelled with different capitals", async () => {
    /*
     * The escalation. This row is a separate account by every measure Postgres
     * applies, and it used to be handed the review queue because the check
     * lowercased it into a match.
     *
     * Addresses are normalised on the way in now, so this row can no longer be
     * created through the API at all — but it is written directly here, so the
     * gate is tested rather than only the thing in front of it.
     */
    const impostor = await makeUser("OWNER@example.com");
    expect((await asAdmin(impostor.token)).status).toBe(403);
  });

  it("keeps out an address that merely looks similar", async () => {
    for (const email of [
      "owner@example.com.evil.com",
      "notowner@example.com",
      "owner@example.co",
      " owner@example.com",
    ]) {
      const other = await makeUser(email);
      expect((await asAdmin(other.token)).status, email).toBe(403);
    }
  });

  it("ignores the address written on the token", async () => {
    // A token lasts a week and carries whatever was true when it was issued.
    // The account decides, not the claim.
    const nobody = await makeUser("nobody@example.com");
    const forged = jwt.sign(
      { userId: nobody.id, email: "owner@example.com" },
      env.JWT_SECRET,
      { expiresIn: "1h" },
    );

    expect((await asAdmin(forged)).status).toBe(403);
  });

  it("lets nobody in when nobody is configured", async () => {
    env.ADMIN_EMAILS = [];
    const owner = await makeUser("owner2@example.com");
    expect((await asAdmin(owner.token)).status).toBe(403);
  });
});
