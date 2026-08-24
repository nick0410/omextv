import { Prisma } from "@prisma/client";
import { prisma } from "../../../config/database";
import {
  CoinOrderRecord,
  CoinOrderRepository,
  CoinOrderWithBuyer,
  CoinRepositories,
  CoinUnitOfWork,
  LedgerEntryRecord,
  LedgerReason,
  OrderStatus,
  PremiumRepository,
  PremiumState,
  WalletRepository,
} from "../ports";
import { OPEN_STATUSES } from "../orderState";

/**
 * The Postgres backing.
 *
 * Everything that has to be atomic is expressed as a conditional write — the
 * condition that makes the change legal goes into the WHERE clause and the row
 * count reports whether it happened. Reading a row, deciding, and then writing
 * is the shape that loses money here: two callers both read the same balance,
 * both decide it is enough, and both write.
 */

type Client = Prisma.TransactionClient;

/** Prisma's status column is a plain string; the domain narrows it. */
function toRecord(row: {
  id: string;
  userId: string;
  packId: string;
  coins: number;
  amountPaise: number;
  status: string;
  upiRef: string | null;
  note: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}): CoinOrderRecord {
  return {
    id: row.id,
    userId: row.userId,
    packId: row.packId,
    coins: row.coins,
    amountPaise: row.amountPaise,
    status: row.status as OrderStatus,
    paymentRef: row.upiRef,
    note: row.note,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
  };
}

class PrismaOrderRepository implements CoinOrderRepository {
  constructor(private readonly db: Client) {}

  async create(input: {
    userId: string;
    packId: string;
    coins: number;
    amountPaise: number;
  }): Promise<CoinOrderRecord> {
    const row = await this.db.coinOrder.create({
      data: { ...input, status: "awaiting_payment" },
    });
    return toRecord(row);
  }

  async findById(id: string): Promise<CoinOrderRecord | null> {
    const row = await this.db.coinOrder.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  countOpen(userId: string): Promise<number> {
    return this.db.coinOrder.count({
      where: { userId, status: { in: [...OPEN_STATUSES] } },
    });
  }

  async listForUser(userId: string, limit: number): Promise<CoinOrderRecord[]> {
    const rows = await this.db.coinOrder.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(toRecord);
  }

  async listByStatus(
    status: OrderStatus | "all",
    limit: number,
  ): Promise<CoinOrderWithBuyer[]> {
    const rows = await this.db.coinOrder.findMany({
      where: status === "all" ? {} : { status },
      orderBy: { createdAt: "asc" },
      take: limit,
      include: { user: { select: { username: true, email: true } } },
    });
    return rows.map((row) => ({
      ...toRecord(row),
      username: row.user.username,
      email: row.user.email,
    }));
  }

  async attachReference(id: string, reference: string): Promise<"ok" | "duplicate"> {
    try {
      await this.db.coinOrder.update({
        where: { id },
        // Clearing the note matters on a resubmission: leaving the old
        // rejection reason on an order now waiting again is just confusing.
        data: { upiRef: reference, status: "under_review", note: null },
      });
      return "ok";
    } catch (e) {
      // The unique index is what makes this safe under concurrency — checking
      // first and inserting after would let two accounts past together.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return "duplicate";
      }
      throw e;
    }
  }

  async claim(
    id: string,
    from: OrderStatus,
    to: OrderStatus,
    patch?: { note?: string | null; reviewedBy?: string; reviewedAt?: Date },
  ): Promise<boolean> {
    const changed = await this.db.coinOrder.updateMany({
      where: { id, status: from },
      data: { status: to, ...patch },
    });
    return changed.count === 1;
  }

  async clearReference(id: string): Promise<void> {
    await this.db.coinOrder.update({ where: { id }, data: { upiRef: null } });
  }
}

class PrismaWalletRepository implements WalletRepository {
  constructor(private readonly db: Client) {}

  async balanceOf(userId: string): Promise<number> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { coins: true },
    });
    return user?.coins ?? 0;
  }

  async credit(
    userId: string,
    amount: number,
    reason: LedgerReason,
    refId: string | null = null,
  ): Promise<number> {
    requirePositive(amount, "credit");

    const user = await this.db.user.update({
      where: { id: userId },
      data: { coins: { increment: amount } },
      select: { coins: true },
    });
    await this.writeLedger(userId, amount, user.coins, reason, refId);
    return user.coins;
  }

  async debit(
    userId: string,
    amount: number,
    reason: LedgerReason,
    refId: string | null = null,
  ): Promise<number | null> {
    requirePositive(amount, "debit");

    // The balance check and the decrement are one statement. A second
    // concurrent spend finds the balance already lowered and matches nothing.
    const changed = await this.db.user.updateMany({
      where: { id: userId, coins: { gte: amount } },
      data: { coins: { decrement: amount } },
    });
    if (changed.count === 0) return null;

    const balance = await this.balanceOf(userId);
    await this.writeLedger(userId, -amount, balance, reason, refId);
    return balance;
  }

  async history(userId: string, limit: number): Promise<LedgerEntryRecord[]> {
    const rows = await this.db.coinLedger.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      delta: row.delta,
      balanceAfter: row.balanceAfter,
      reason: row.reason as LedgerReason,
      createdAt: row.createdAt,
    }));
  }

  private async writeLedger(
    userId: string,
    delta: number,
    balanceAfter: number,
    reason: LedgerReason,
    refId: string | null,
  ): Promise<void> {
    await this.db.coinLedger.create({
      data: { userId, delta, balanceAfter, reason, refId },
    });
  }
}

class PrismaPremiumRepository implements PremiumRepository {
  constructor(private readonly db: Client) {}

  async get(userId: string): Promise<PremiumState | null> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { isPremium: true, premiumExpiry: true },
    });
    return user ? { isPremium: user.isPremium, premiumExpiry: user.premiumExpiry } : null;
  }

  async extendTo(userId: string, expiry: Date): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { isPremium: true, premiumExpiry: expiry },
    });
  }
}

function bind(db: Client): CoinRepositories {
  return {
    orders: new PrismaOrderRepository(db),
    wallet: new PrismaWalletRepository(db),
    premium: new PrismaPremiumRepository(db),
  };
}

/**
 * A zero or negative amount is always a bug upstream, and the two directions
 * cancel out in ways that read as theft: a negative credit drains a balance
 * while the ledger records a purchase.
 */
function requirePositive(amount: number, what: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`${what} amount must be a positive integer, got ${amount}`);
  }
}

export function createPrismaCoinStore(): CoinUnitOfWork {
  const root = bind(prisma as unknown as Client);
  return {
    ...root,
    transact: <T>(work: (repos: CoinRepositories) => Promise<T>): Promise<T> =>
      prisma.$transaction((tx) => work(bind(tx))),
  };
}
