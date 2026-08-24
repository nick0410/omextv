import { Prisma } from "@prisma/client";
import { prisma } from "../../config/database";

/**
 * Moving coins around, without ever inventing or losing one.
 *
 * Two things go wrong with balances, and both are races rather than bugs you
 * can see by reading a single request:
 *
 *   - spending twice from one balance, because two requests each read 500,
 *     each decide 500 >= 500, and both write 0 while granting two passes;
 *   - crediting an order twice, because approve was clicked twice, or clicked
 *     while the first click was still in flight.
 *
 * Both are closed the same way: never read-then-write. The condition that
 * makes the change legal goes into the WHERE clause, and the row count says
 * whether it actually happened. The database decides, once, under a lock it
 * already holds.
 */

/**
 * Either the client or an open transaction.
 *
 * Approving an order has to mark it approved and credit the coins as one
 * unit — a crash between the two either pays twice or not at all — so the
 * money-moving helpers take whichever client the caller is already inside
 * rather than opening a transaction of their own and nesting.
 */
export type CoinClient = Prisma.TransactionClient;

export interface LedgerEntry {
  delta: number;
  reason: "purchase" | "pass" | "refund" | "adjustment";
  refId?: string | null;
}

/**
 * Take coins off a balance, or report that there were not enough.
 *
 * `gte` in the WHERE is doing the real work: the check and the decrement are
 * one statement, so a second concurrent spend finds the balance already
 * lowered and matches nothing. Returns null when it did not happen, which
 * callers must treat as "declined" rather than retrying.
 */
export async function debitIn(
  tx: CoinClient,
  userId: string,
  amount: number,
  entry: Omit<LedgerEntry, "delta">,
): Promise<{ balance: number } | null> {
  requirePositive(amount, "debit");

  const changed = await tx.user.updateMany({
    where: { id: userId, coins: { gte: amount } },
    data: { coins: { decrement: amount } },
  });
  if (changed.count === 0) return null;

  const after = await tx.user.findUnique({
    where: { id: userId },
    select: { coins: true },
  });
  const balance = after?.coins ?? 0;

  await tx.coinLedger.create({
    data: {
      userId,
      delta: -amount,
      balanceAfter: balance,
      reason: entry.reason,
      refId: entry.refId ?? null,
    },
  });

  return { balance };
}

/**
 * Add coins to a balance.
 *
 * Callers decide *whether* to credit exactly once — for a purchase that is the
 * order's status transition, which only one caller can win. This helper will
 * happily add coins as many times as it is asked to.
 */
export async function creditIn(
  tx: CoinClient,
  userId: string,
  amount: number,
  entry: Omit<LedgerEntry, "delta">,
): Promise<{ balance: number }> {
  requirePositive(amount, "credit");

  const user = await tx.user.update({
    where: { id: userId },
    data: { coins: { increment: amount } },
    select: { coins: true },
  });

  await tx.coinLedger.create({
    data: {
      userId,
      delta: amount,
      balanceAfter: user.coins,
      reason: entry.reason,
      refId: entry.refId ?? null,
    },
  });

  return { balance: user.coins };
}

export async function debit(
  userId: string,
  amount: number,
  entry: Omit<LedgerEntry, "delta">,
): Promise<{ balance: number } | null> {
  return prisma.$transaction((tx) => debitIn(tx, userId, amount, entry));
}

export async function credit(
  userId: string,
  amount: number,
  entry: Omit<LedgerEntry, "delta">,
): Promise<{ balance: number }> {
  return prisma.$transaction((tx) => creditIn(tx, userId, amount, entry));
}

export async function balanceOf(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { coins: true },
  });
  return user?.coins ?? 0;
}

/**
 * Extend premium from whichever is later: now, or an unexpired existing pass.
 *
 * Stacking from `now` would silently burn whatever was left of the current
 * pass — someone topping up a week early would pay to lose six days.
 */
export function extendFrom(current: Date | null, days: number, now = new Date()): Date {
  const base = current && current.getTime() > now.getTime() ? current : now;
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * A zero or negative amount is always a bug upstream, and the two directions
 * cancel out in ways that look like theft: a negative "credit" silently drains
 * a balance while the ledger records a purchase.
 */
function requirePositive(amount: number, what: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`${what} amount must be a positive integer, got ${amount}`);
  }
}
