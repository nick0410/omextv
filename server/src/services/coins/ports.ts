/**
 * What the coin system needs from the outside world, stated as interfaces.
 *
 * The routes used to call Prisma directly, which tied four separate things
 * together: what a purchase *means*, how it is stored, who is allowed to do
 * it, and what HTTP status says so. Changing any one of them meant reading all
 * four, and none of it could be tested without a database.
 *
 * These are the seams. The service below depends only on what is declared
 * here; Prisma and UPI are two implementations of it, and the in-memory pair
 * used by the fast tests are two more. Same shape as `services/store`, which
 * already splits its ports from its Redis and memory backings.
 */

// --- Results ----------------------------------------------------------------

/**
 * What a use case returns.
 *
 * Deliberately not exceptions. Most of the ways buying coins fails are
 * ordinary answers — not enough balance, already reviewed, someone else
 * claimed that reference — and throwing for them means the caller cannot tell
 * an expected refusal from a bug, so both end up as a 500 or both get
 * swallowed. A code the caller must look at keeps that distinction.
 */
export type Result<T, C extends string> =
  | { ok: true; value: T }
  | { ok: false; code: C; message: string };

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

export const err = <C extends string>(code: C, message: string): { ok: false; code: C; message: string } =>
  ({ ok: false, code, message });

// --- Records ----------------------------------------------------------------

export type OrderStatus = "awaiting_payment" | "under_review" | "approved" | "rejected";

export type LedgerReason = "purchase" | "pass" | "refund" | "adjustment";

export interface CoinOrderRecord {
  id: string;
  userId: string;
  packId: string;
  coins: number;
  amountPaise: number;
  status: OrderStatus;
  paymentRef: string | null;
  note: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

/** An order plus who placed it, for the review queue. */
export interface CoinOrderWithBuyer extends CoinOrderRecord {
  username: string;
  email: string;
}

export interface LedgerEntryRecord {
  id: string;
  delta: number;
  balanceAfter: number;
  reason: LedgerReason;
  createdAt: Date;
}

export interface PremiumState {
  isPremium: boolean;
  premiumExpiry: Date | null;
}

// --- Repositories -----------------------------------------------------------

export interface CoinOrderRepository {
  create(input: {
    userId: string;
    packId: string;
    coins: number;
    amountPaise: number;
  }): Promise<CoinOrderRecord>;

  findById(id: string): Promise<CoinOrderRecord | null>;

  /** How many orders this user has left unfinished, to cap the review queue. */
  countOpen(userId: string): Promise<number>;

  listForUser(userId: string, limit: number): Promise<CoinOrderRecord[]>;

  listByStatus(status: OrderStatus | "all", limit: number): Promise<CoinOrderWithBuyer[]>;

  /**
   * Attach a payment reference and move the order to review.
   *
   * Returns "duplicate" when the reference is already recorded against another
   * order. That check belongs to the store because only the store can make it
   * atomic — two accounts submitting the same reference at once must not both
   * succeed, and no amount of checking first prevents that.
   */
  attachReference(id: string, reference: string): Promise<"ok" | "duplicate">;

  /**
   * Move an order between states, but only from the state given.
   *
   * The `from` guard is the whole point: it makes the transition a claim. Two
   * approvals racing both call this, and the row count decides which one won,
   * so coins are credited by exactly one of them. A read followed by a write
   * cannot do that.
   *
   * @returns whether this caller was the one that moved it.
   */
  claim(
    id: string,
    from: OrderStatus,
    to: OrderStatus,
    patch?: { note?: string | null; reviewedBy?: string; reviewedAt?: Date },
  ): Promise<boolean>;

  /** Free a rejected order's reference so a genuine payer can correct a typo. */
  clearReference(id: string): Promise<void>;
}

export interface WalletRepository {
  balanceOf(userId: string): Promise<number>;

  /**
   * Add coins.
   *
   * Deciding *whether* to credit exactly once is the caller's job — for a
   * purchase that is `claim` above. This will add coins as often as it is
   * asked to.
   */
  credit(userId: string, amount: number, reason: LedgerReason, refId?: string | null): Promise<number>;

  /**
   * Remove coins, or report that there were not enough.
   *
   * Must check and decrement in one operation. Returning null is a refusal,
   * not an error: the balance was short and nothing changed.
   */
  debit(
    userId: string,
    amount: number,
    reason: LedgerReason,
    refId?: string | null,
  ): Promise<number | null>;

  history(userId: string, limit: number): Promise<LedgerEntryRecord[]>;
}

export interface PremiumRepository {
  get(userId: string): Promise<PremiumState | null>;
  /** Set the expiry, marking the account premium. */
  extendTo(userId: string, expiry: Date): Promise<void>;
}

export interface CoinRepositories {
  orders: CoinOrderRepository;
  wallet: WalletRepository;
  premium: PremiumRepository;
}

/**
 * Run several repository calls as one atomic unit.
 *
 * Approving an order marks it approved *and* credits coins; spending debits
 * *and* extends premium. A crash between the halves either pays twice or takes
 * money for nothing, so they cannot be two independent calls.
 *
 * Expressing that as a port rather than reaching for `prisma.$transaction` in
 * the service is what keeps the service free of the ORM. The Prisma adapter
 * opens a real transaction; the in-memory one just runs the callback, which is
 * honest because that runtime is single-threaded and has nothing to roll back
 * to.
 */
export interface CoinUnitOfWork extends CoinRepositories {
  transact<T>(work: (repos: CoinRepositories) => Promise<T>): Promise<T>;
}

// --- Payment ----------------------------------------------------------------

/** What a buyer needs in order to actually pay. */
export interface PaymentInstruction {
  /** Which provider produced this, so the client can render it appropriately. */
  kind: string;
  /** The URI a payment app opens, and what the QR encodes. */
  link: string;
  /** Where the money goes, shown so the buyer can check it before confirming. */
  payee: string;
  payeeName: string;
  amountRupees: string;
  /** Echoed into the buyer's app, to tie the payment back to the order. */
  reference: string;
}

/**
 * A way of collecting money.
 *
 * UPI is the one implemented. It is an interface because the alternative — a
 * gateway that confirms payments itself — differs from it in exactly one
 * respect that matters here, `confirmsAutomatically`, and everything else in
 * the purchase flow is identical. Wiring a gateway in later should not mean
 * rewriting orders, ledgers or the review queue.
 */
export interface PaymentProvider {
  readonly id: string;

  /** False when no payee is set. The client hides buying entirely rather than
   * showing a QR that would pay nobody. */
  isConfigured(): boolean;

  /**
   * Whether this provider tells the server when a payment succeeds.
   *
   * False for a direct UPI transfer: money arrives in a bank account and
   * nothing reaches the server, which is why approval is a person matching a
   * reference against a statement. A provider that returns true could credit
   * without review.
   */
  readonly confirmsAutomatically: boolean;

  instructionFor(order: {
    id: string;
    amountPaise: number;
    description: string;
  }): PaymentInstruction;

  /** Does this look like a reference this provider's payers would have? */
  isPlausibleReference(value: string): boolean;
}
