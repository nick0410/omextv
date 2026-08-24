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
 * An in-memory backing, so the rules can be tested without a database.
 *
 * Not a mock: it enforces the same guarantees the Postgres adapter does — the
 * unique reference, the conditional claim, the balance floor — because a fake
 * that is more permissive than the real thing makes tests that pass while the
 * rules are broken. The one honest difference is `transact`, which just runs
 * the callback: this runtime is single-threaded, so there is no interleaving
 * to protect against and nothing to roll back to.
 *
 * It also mirrors `services/store/memory.ts`, which exists for the same reason.
 */

interface MemoryUser {
  id: string;
  username: string;
  email: string;
  coins: number;
  isPremium: boolean;
  premiumExpiry: Date | null;
}

export class MemoryCoinStore implements CoinUnitOfWork {
  readonly orders: CoinOrderRepository;
  readonly wallet: WalletRepository;
  readonly premium: PremiumRepository;

  private readonly users = new Map<string, MemoryUser>();
  private readonly orderRows: CoinOrderRecord[] = [];
  private readonly ledger: Array<LedgerEntryRecord & { userId: string; refId: string | null }> = [];
  private seq = 0;
  private clock = 0;

  constructor() {
    this.orders = this.makeOrders();
    this.wallet = this.makeWallet();
    this.premium = this.makePremium();
  }

  /** Seed an account. Returns its id. */
  addUser(over: Partial<MemoryUser> = {}): string {
    const id = over.id ?? `u${++this.seq}`;
    this.users.set(id, {
      id,
      username: over.username ?? id,
      email: over.email ?? `${id}@test.local`,
      coins: over.coins ?? 0,
      isPremium: over.isPremium ?? false,
      premiumExpiry: over.premiumExpiry ?? null,
    });
    return id;
  }

  userOf(id: string): MemoryUser | undefined {
    return this.users.get(id);
  }

  ledgerFor(userId: string): LedgerEntryRecord[] {
    return this.ledger.filter((e) => e.userId === userId);
  }

  transact<T>(work: (repos: CoinRepositories) => Promise<T>): Promise<T> {
    return work(this);
  }

  /** Distinct, increasing timestamps so ordering in tests is deterministic. */
  private tick(): Date {
    return new Date(1_700_000_000_000 + ++this.clock);
  }

  private makeOrders(): CoinOrderRepository {
    const rows = this.orderRows;

    return {
      create: async (input) => {
        const row: CoinOrderRecord = {
          id: `o${++this.seq}`,
          userId: input.userId,
          packId: input.packId,
          coins: input.coins,
          amountPaise: input.amountPaise,
          status: "awaiting_payment",
          paymentRef: null,
          note: null,
          reviewedBy: null,
          reviewedAt: null,
          createdAt: this.tick(),
        };
        rows.push(row);
        return { ...row };
      },

      findById: async (id) => {
        const row = rows.find((r) => r.id === id);
        return row ? { ...row } : null;
      },

      countOpen: async (userId) =>
        rows.filter((r) => r.userId === userId && OPEN_STATUSES.includes(r.status)).length,

      listForUser: async (userId, limit) =>
        rows
          .filter((r) => r.userId === userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
          .map((r) => ({ ...r })),

      listByStatus: async (status, limit) =>
        rows
          .filter((r) => status === "all" || r.status === status)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit)
          .map((r): CoinOrderWithBuyer => {
            const user = this.users.get(r.userId);
            return {
              ...r,
              username: user?.username ?? "unknown",
              email: user?.email ?? "unknown",
            };
          }),

      attachReference: async (id, reference) => {
        // The same uniqueness the database index gives, so a test cannot pass
        // here and fail in production.
        const taken = rows.some((r) => r.id !== id && r.paymentRef === reference);
        if (taken) return "duplicate";

        const row = rows.find((r) => r.id === id);
        if (!row) return "duplicate";
        row.paymentRef = reference;
        row.status = "under_review";
        row.note = null;
        return "ok";
      },

      claim: async (id, from, to, patch) => {
        const row = rows.find((r) => r.id === id && r.status === from);
        if (!row) return false;
        row.status = to;
        if (patch?.note !== undefined) row.note = patch.note;
        if (patch?.reviewedBy !== undefined) row.reviewedBy = patch.reviewedBy;
        if (patch?.reviewedAt !== undefined) row.reviewedAt = patch.reviewedAt;
        return true;
      },

      clearReference: async (id) => {
        const row = rows.find((r) => r.id === id);
        if (row) row.paymentRef = null;
      },
    };
  }

  private makeWallet(): WalletRepository {
    const record = (
      userId: string,
      delta: number,
      balanceAfter: number,
      reason: LedgerReason,
      refId: string | null,
    ) => {
      this.ledger.push({
        id: `l${++this.seq}`,
        userId,
        delta,
        balanceAfter,
        reason,
        refId,
        createdAt: this.tick(),
      });
    };

    return {
      balanceOf: async (userId) => this.users.get(userId)?.coins ?? 0,

      credit: async (userId, amount, reason, refId = null) => {
        requirePositive(amount, "credit");
        const user = this.users.get(userId);
        if (!user) throw new Error(`no such user: ${userId}`);
        user.coins += amount;
        record(userId, amount, user.coins, reason, refId);
        return user.coins;
      },

      debit: async (userId, amount, reason, refId = null) => {
        requirePositive(amount, "debit");
        const user = this.users.get(userId);
        // The floor is enforced here too — a fake that lets a balance go
        // negative would make the overdraw tests meaningless.
        if (!user || user.coins < amount) return null;
        user.coins -= amount;
        record(userId, -amount, user.coins, reason, refId);
        return user.coins;
      },

      history: async (userId, limit) =>
        this.ledger
          .filter((e) => e.userId === userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
          .map(({ id, delta, balanceAfter, reason, createdAt }) => ({
            id,
            delta,
            balanceAfter,
            reason,
            createdAt,
          })),
    };
  }

  private makePremium(): PremiumRepository {
    return {
      get: async (userId): Promise<PremiumState | null> => {
        const user = this.users.get(userId);
        return user ? { isPremium: user.isPremium, premiumExpiry: user.premiumExpiry } : null;
      },
      extendTo: async (userId, expiry) => {
        const user = this.users.get(userId);
        if (!user) throw new Error(`no such user: ${userId}`);
        user.isPremium = true;
        user.premiumExpiry = expiry;
      },
    };
  }
}

function requirePositive(amount: number, what: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`${what} amount must be a positive integer, got ${amount}`);
  }
}

/** A status the domain understands, for tests that need to name one. */
export const anyStatus = (s: string): OrderStatus => s as OrderStatus;
