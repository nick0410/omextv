import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../config/database";
import { isDbReady } from "./dbAvailable";
import { createPrismaCoinStore } from "../services/coins/adapters/prisma";

/**
 * The balance, under the conditions that actually break balances.
 *
 * Single-threaded arithmetic is not where coin systems go wrong — concurrency
 * is. Every test that matters here fires several requests at once and checks
 * that exactly the right number of them won.
 *
 * Pointed at the Postgres adapter rather than at the service, deliberately.
 * The guarantee under test is the conditional write itself, and the in-memory
 * backing cannot demonstrate it: nothing interleaves there. The service's own
 * rules are covered without a database in coinService.test.ts.
 */

const store = createPrismaCoinStore();
const wallet = store.wallet;

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
    const balance = await wallet.credit(id, 500, "purchase", "o1");

    expect(balance).toBe(500);
    const entries = await prisma.coinLedger.findMany({ where: { userId: id } });
    expect(entries).toHaveLength(1);
    expect(entries[0].delta).toBe(500);
    expect(entries[0].balanceAfter).toBe(500);
  });

  it("debits down to exactly zero", async () => {
    const id = await makeUser(500);
    expect(await wallet.debit(id, 500, "pass", "month")).toBe(0);
    expect(await wallet.balanceOf(id)).toBe(0);
  });

  it("refuses to overdraw, and changes nothing when it does", async () => {
    const id = await makeUser(100);

    expect(await wallet.debit(id, 101, "pass")).toBeNull();
    expect(await wallet.balanceOf(id)).toBe(100);
    // A declined spend must not leave a ledger row either, or the history
    // stops adding up to the balance.
    expect(await prisma.coinLedger.count({ where: { userId: id } })).toBe(0);
  });

  it("lets only one of two simultaneous spends succeed", async () => {
    // The whole reason the check lives in the WHERE clause. Read-then-write
    // would let both of these see 500, both decide it is enough, and both
    // grant a pass off one payment.
    const id = await makeUser(500);

    const results = await Promise.all([
      wallet.debit(id, 500, "pass", "month"),
      wallet.debit(id, 500, "pass", "month"),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await wallet.balanceOf(id)).toBe(0);
    expect(await prisma.coinLedger.count({ where: { userId: id } })).toBe(1);
  });

  it("keeps the running balance correct across many concurrent spends", async () => {
    const id = await makeUser(1000);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => wallet.debit(id, 100, "pass")),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(10);
    expect(await wallet.balanceOf(id)).toBe(0);

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
    await expect(wallet.credit(id, -50, "purchase")).rejects.toThrow();
    await expect(wallet.credit(id, 0, "purchase")).rejects.toThrow();
    await expect(wallet.debit(id, 1.5, "pass")).rejects.toThrow();
    expect(await wallet.balanceOf(id)).toBe(100);
  });

  it("rolls the whole unit of work back when part of it fails", async () => {
    const id = await makeUser(100);

    // Credit one real account and one that does not exist. The transaction has
    // to undo the first, or an approval that half-failed leaves coins behind.
    await expect(
      store.transact(async (repos) => {
        await repos.wallet.credit(id, 500, "purchase");
        await repos.wallet.credit("no-such-user", 1, "purchase");
      }),
    ).rejects.toThrow();

    expect(await wallet.balanceOf(id)).toBe(100);
    expect(await prisma.coinLedger.count({ where: { userId: id } })).toBe(0);
  });

  it("claims an order exactly once when two callers race", async () => {
    // The same guarantee as the balance floor, applied to a status change:
    // this is what stops a double-clicked approval crediting twice.
    const id = await makeUser();
    const order = await store.orders.create({
      userId: id,
      packId: "starter",
      coins: 500,
      amountPaise: 50_000,
    });
    await store.orders.attachReference(order.id, `R${Date.now()}`);

    const claims = await Promise.all([
      store.orders.claim(order.id, "under_review", "approved"),
      store.orders.claim(order.id, "under_review", "approved"),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("will not let two orders hold the same payment reference", async () => {
    const id = await makeUser();
    const ref = `DUP${Date.now()}`;
    const first = await store.orders.create({
      userId: id, packId: "starter", coins: 500, amountPaise: 50_000,
    });
    const second = await store.orders.create({
      userId: id, packId: "starter", coins: 500, amountPaise: 50_000,
    });

    expect(await store.orders.attachReference(first.id, ref)).toBe("ok");
    expect(await store.orders.attachReference(second.id, ref)).toBe("duplicate");
  });
});
