import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../config/database";
import { isDbReady } from "./dbAvailable";
import { balanceOf, credit, creditIn, debit, extendFrom } from "../services/coins/wallet";

/**
 * The balance, under the conditions that actually break balances.
 *
 * Single-threaded arithmetic is not where coin systems go wrong — concurrency
 * is. Every test that matters here fires two requests at once and checks that
 * exactly one of them won.
 */

const suite = isDbReady() ? describe : describe.skip;
const PREFIX = `wtest_${Date.now()}_`;
const created: string[] = [];
let seq = 0;

async function makeUser(coins = 0): Promise<string> {
  const name = `${PREFIX}${++seq}`;
  const user = await prisma.user.create({
    data: {
      email: `${name}@test.local`,
      passwordHash: "x",
      username: name,
      gender: "male",
      coins,
    },
    select: { id: true },
  });
  created.push(user.id);
  return user.id;
}

suite("coin wallet", () => {
  beforeAll(() => {
    if (!isDbReady()) console.warn("skipping wallet tests: no database");
  });

  afterAll(async () => {
    if (created.length === 0) return;
    await prisma.coinLedger.deleteMany({ where: { userId: { in: created } } });
    await prisma.coinOrder.deleteMany({ where: { userId: { in: created } } });
    await prisma.user.deleteMany({ where: { id: { in: created } } });
  });

  it("credits and records the balance it produced", async () => {
    const id = await makeUser();
    const { balance } = await credit(id, 500, { reason: "purchase", refId: "o1" });

    expect(balance).toBe(500);
    const entries = await prisma.coinLedger.findMany({ where: { userId: id } });
    expect(entries).toHaveLength(1);
    expect(entries[0].delta).toBe(500);
    expect(entries[0].balanceAfter).toBe(500);
  });

  it("debits down to exactly zero", async () => {
    const id = await makeUser(500);
    const result = await debit(id, 500, { reason: "pass", refId: "month" });

    expect(result?.balance).toBe(0);
    expect(await balanceOf(id)).toBe(0);
  });

  it("refuses to overdraw, and changes nothing when it does", async () => {
    const id = await makeUser(100);
    const result = await debit(id, 101, { reason: "pass" });

    expect(result).toBeNull();
    expect(await balanceOf(id)).toBe(100);
    // A declined spend must not leave a ledger row either, or the history
    // stops adding up to the balance.
    expect(await prisma.coinLedger.count({ where: { userId: id } })).toBe(0);
  });

  it("lets only one of two simultaneous spends succeed", async () => {
    // The whole reason the check lives in the WHERE clause. Read-then-write
    // would let both of these see 500, both decide it is enough, and both
    // grant a pass off one payment.
    const id = await makeUser(500);

    const [a, b] = await Promise.all([
      debit(id, 500, { reason: "pass", refId: "month" }),
      debit(id, 500, { reason: "pass", refId: "month" }),
    ]);

    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(await balanceOf(id)).toBe(0);
    expect(await prisma.coinLedger.count({ where: { userId: id } })).toBe(1);
  });

  it("keeps the running balance correct across many concurrent spends", async () => {
    const id = await makeUser(1000);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => debit(id, 100, { reason: "pass" })),
    );

    const succeeded = results.filter(Boolean).length;
    expect(succeeded).toBe(10);
    expect(await balanceOf(id)).toBe(0);

    // Every ledger row should agree with the balance at the time it was
    // written, so the history can be replayed.
    const entries = await prisma.coinLedger.findMany({
      where: { userId: id },
      orderBy: { createdAt: "asc" },
    });
    expect(entries).toHaveLength(10);
    expect(Math.min(...entries.map((e) => e.balanceAfter))).toBe(0);
  });

  it("rejects a nonsense amount rather than quietly reversing direction", async () => {
    const id = await makeUser(100);

    // A negative "credit" would drain a balance while the ledger recorded a
    // purchase — the shape of a bug that reads as theft.
    await expect(credit(id, -50, { reason: "purchase" })).rejects.toThrow();
    await expect(credit(id, 0, { reason: "purchase" })).rejects.toThrow();
    await expect(debit(id, 1.5, { reason: "pass" })).rejects.toThrow();
    expect(await balanceOf(id)).toBe(100);
  });

  it("rolls the credit back if the ledger write fails", async () => {
    const id = await makeUser(100);

    // reason is constrained by the caller, not the column, so force a failure
    // the transaction has to undo: a ledger row for a user that is not there.
    await expect(
      prisma.$transaction(async (tx) => {
        await creditIn(tx, id, 500, { reason: "purchase" });
        await creditIn(tx, "no-such-user", 1, { reason: "purchase" });
      }),
    ).rejects.toThrow();

    expect(await balanceOf(id)).toBe(100);
  });
});

describe("premium expiry arithmetic", () => {
  const now = new Date("2026-01-10T00:00:00Z");

  it("starts from now when there is no pass", () => {
    expect(extendFrom(null, 30, now).toISOString()).toBe("2026-02-09T00:00:00.000Z");
  });

  it("starts from now when the old pass already lapsed", () => {
    const lapsed = new Date("2026-01-01T00:00:00Z");
    expect(extendFrom(lapsed, 30, now).toISOString()).toBe("2026-02-09T00:00:00.000Z");
  });

  it("stacks on top of a pass that is still running", () => {
    // Topping up early must not burn the remaining days — otherwise renewing
    // a week ahead costs you that week.
    const running = new Date("2026-01-20T00:00:00Z");
    expect(extendFrom(running, 30, now).toISOString()).toBe("2026-02-19T00:00:00.000Z");
  });
});
