import {
  COIN_PACKS,
  COIN_PASSES,
  CoinPack,
  CoinPass,
  findPack,
  findPass,
} from "./catalog";
import {
  CoinOrderRecord,
  CoinOrderWithBuyer,
  CoinUnitOfWork,
  LedgerEntryRecord,
  OrderStatus,
  PaymentInstruction,
  PaymentProvider,
  Result,
  err,
  ok,
} from "./ports";
import { acceptsReference, describe } from "./orderState";

/**
 * Buying coins and spending them, with nothing in here that knows about HTTP.
 *
 * Every rule about what is allowed lives at this level, stated once. The route
 * layer above translates results into status codes and the adapters below
 * translate calls into SQL, and neither gets a say in the rules — which is
 * what stops the paywall from being enforced in three places that disagree.
 */

/** How many unfinished orders one account may stack up. */
export const OPEN_ORDER_LIMIT = 5;

const ORDER_PAGE = 25;
const REVIEW_PAGE = 100;
const LEDGER_PAGE = 50;

export interface WalletView {
  coins: number;
  isPremium: boolean;
  premiumExpiry: Date | null;
  packs: CoinPack[];
  passes: CoinPass[];
  /** False when no payee is configured, so the client can hide buying. */
  purchasesEnabled: boolean;
}

export interface Checkout {
  order: CoinOrderRecord;
  payment: PaymentInstruction;
}

export type CreateOrderError = "payments_unavailable" | "unknown_pack" | "too_many_open";
export type ReferenceError =
  | "not_found"
  | "bad_reference"
  | "wrong_state"
  | "duplicate_reference";
export type RedeemError = "unknown_pass" | "insufficient_coins";
export type ReopenError = "not_found" | "wrong_state" | "payments_unavailable";
export type ReviewError = "not_awaiting_review";

export class CoinService {
  constructor(
    private readonly repos: CoinUnitOfWork,
    private readonly payments: PaymentProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // --- Reading ------------------------------------------------------------

  async walletFor(userId: string): Promise<WalletView | null> {
    const [coins, premium] = await Promise.all([
      this.repos.wallet.balanceOf(userId),
      this.repos.premium.get(userId),
    ]);
    if (!premium) return null;

    return {
      coins,
      isPremium: this.premiumIsLive(premium),
      premiumExpiry: premium.premiumExpiry,
      packs: COIN_PACKS,
      passes: COIN_PASSES,
      purchasesEnabled: this.payments.isConfigured(),
    };
  }

  /**
   * Is premium in force for this account right now?
   *
   * Asked at the moment it is used, not remembered. A socket authenticates
   * once and can live for hours: a pass bought during that session, or one
   * that lapsed during it, would otherwise not take effect until the user
   * happened to reconnect. Someone paying and finding the filters still locked
   * is the worst failure this feature has.
   */
  async isPremiumNow(userId: string): Promise<boolean> {
    const premium = await this.repos.premium.get(userId);
    return premium ? this.premiumIsLive(premium) : false;
  }

  ordersFor(userId: string): Promise<CoinOrderRecord[]> {
    return this.repos.orders.listForUser(userId, ORDER_PAGE);
  }

  ledgerFor(userId: string): Promise<LedgerEntryRecord[]> {
    return this.repos.wallet.history(userId, LEDGER_PAGE);
  }

  ordersForReview(status: OrderStatus | "all"): Promise<CoinOrderWithBuyer[]> {
    return this.repos.orders.listByStatus(status, REVIEW_PAGE);
  }

  // --- Buying -------------------------------------------------------------

  async createOrder(userId: string, packId: unknown): Promise<Result<Checkout, CreateOrderError>> {
    if (!this.payments.isConfigured()) {
      return err("payments_unavailable", "Payments are not set up yet.");
    }

    const pack = findPack(packId);
    if (!pack) return err("unknown_pack", "That pack is not on sale.");

    // Orders are free to create and a person has to look at each one, so an
    // unbounded pile of them wastes the reviewer's time rather than attacking
    // the balance. Still worth capping.
    const open = await this.repos.orders.countOpen(userId);
    if (open >= OPEN_ORDER_LIMIT) {
      return err(
        "too_many_open",
        "You have too many unfinished orders. Finish or cancel one first.",
      );
    }

    const order = await this.repos.orders.create({
      userId,
      packId: pack.id,
      // Copied onto the order, not looked up at approval time: repricing the
      // catalogue must not change what an already-paid order is worth.
      coins: pack.coins,
      amountPaise: pack.amountPaise,
    });

    return ok({
      order,
      payment: this.payments.instructionFor({
        id: order.id,
        amountPaise: order.amountPaise,
        description: `Omextv ${pack.name}`,
      }),
    });
  }

  /** "I have paid — here is the reference from my bank app." */
  async submitReference(
    userId: string,
    orderId: string,
    reference: string,
  ): Promise<Result<CoinOrderRecord, ReferenceError>> {
    const trimmed = reference.trim();
    if (!this.payments.isPlausibleReference(trimmed)) {
      return err(
        "bad_reference",
        "Enter the reference your payment app shows on the receipt (6-35 letters or digits).",
      );
    }

    const order = await this.repos.orders.findById(orderId);
    // Someone else's order is reported as missing rather than forbidden: which
    // order ids exist is not information a stranger needs.
    if (!order || order.userId !== userId) {
      return err("not_found", "Order not found.");
    }

    if (!acceptsReference(order.status)) {
      return err("wrong_state", `This order is ${describe(order.status)}.`);
    }

    const outcome = await this.repos.orders.attachReference(order.id, trimmed);
    if (outcome === "duplicate") {
      // One transfer, two claimants. This is the version that costs real money.
      return err("duplicate_reference", "That reference has already been submitted.");
    }

    const updated = await this.repos.orders.findById(order.id);
    return updated ? ok(updated) : err("not_found", "Order not found.");
  }

  /**
   * Get the payment instruction for an order that was started earlier.
   *
   * Without this a buyer who closed the page had no way back to the QR: the
   * order sat in their list marked unpaid, with nothing to click. They would
   * start another, hit the open-order cap after five, and be stuck holding
   * five orders they could neither pay nor abandon.
   *
   * Rebuilt rather than stored, so it always reflects the configured payee —
   * an instruction saved a week ago could name an account that has since
   * changed.
   */
  async reopenOrder(
    userId: string,
    orderId: string,
  ): Promise<Result<Checkout, ReopenError>> {
    if (!this.payments.isConfigured()) {
      return err("payments_unavailable", "Payments are not set up yet.");
    }

    const order = await this.repos.orders.findById(orderId);
    if (!order || order.userId !== userId) return err("not_found", "Order not found.");

    if (!acceptsReference(order.status)) {
      return err("wrong_state", `This order is ${describe(order.status)}.`);
    }

    const pack = findPack(order.packId);
    return ok({
      order,
      payment: this.payments.instructionFor({
        id: order.id,
        amountPaise: order.amountPaise,
        description: `Omextv ${pack?.name ?? "coins"}`,
      }),
    });
  }

  async cancelOrder(userId: string, orderId: string): Promise<Result<true, ReferenceError>> {
    const order = await this.repos.orders.findById(orderId);
    if (!order || order.userId !== userId) return err("not_found", "Order not found.");

    // Only an order nobody has claimed to have paid. Cancelling one under
    // review would let a payer hide a transfer that already went through, and
    // an approved one has already been credited.
    const moved = await this.repos.orders.claim(order.id, "awaiting_payment", "rejected", {
      note: "Cancelled",
    });
    if (!moved) {
      return err(
        "wrong_state",
        `This order is ${describe(order.status)} and cannot be cancelled.`,
      );
    }
    return ok(true);
  }

  // --- Review -------------------------------------------------------------

  /**
   * The money arrived. Credit it.
   *
   * The claim and the credit are one transaction, and the claim is what makes
   * this safe to call twice: two reviewers, or one double click, both run it
   * and only the caller that finds the order still under review moves it. The
   * other credits nothing and is told so.
   */
  async approveOrder(
    orderId: string,
    reviewerId: string,
  ): Promise<Result<{ credited: number; balance: number; userId: string }, ReviewError>> {
    const result = await this.repos.transact(async (repos) => {
      const claimed = await repos.orders.claim(orderId, "under_review", "approved", {
        reviewedBy: reviewerId,
        reviewedAt: this.now(),
      });
      if (!claimed) return null;

      const order = await repos.orders.findById(orderId);
      if (!order) return null;

      const balance = await repos.wallet.credit(order.userId, order.coins, "purchase", order.id);
      return { credited: order.coins, balance, userId: order.userId };
    });

    return result ? ok(result) : err("not_awaiting_review", "That order is not awaiting review.");
  }

  async rejectOrder(
    orderId: string,
    reviewerId: string,
    note: string,
  ): Promise<Result<true, ReviewError>> {
    const moved = await this.repos.orders.claim(orderId, "under_review", "rejected", {
      note: note.trim().slice(0, 200) || "No matching payment found.",
      reviewedBy: reviewerId,
      reviewedAt: this.now(),
    });
    if (!moved) return err("not_awaiting_review", "That order is not awaiting review.");

    // Freeing the reference is what lets a genuine payer who mistyped it try
    // again. A reference that really was used stays held by the approved order
    // it belongs to, so this cannot release one that mattered.
    await this.repos.orders.clearReference(orderId);
    return ok(true);
  }

  // --- Spending -----------------------------------------------------------

  async redeemPass(
    userId: string,
    passId: unknown,
  ): Promise<Result<{ coins: number; premiumExpiry: Date }, RedeemError>> {
    const pass = findPass(passId);
    if (!pass) return err("unknown_pass", "That pass is not on sale.");

    const result = await this.repos.transact(async (repos) => {
      const balance = await repos.wallet.debit(userId, pass.cost, "pass", pass.id);
      if (balance === null) return null;

      const premium = await repos.premium.get(userId);
      const premiumExpiry = this.extendFrom(premium?.premiumExpiry ?? null, pass.days);
      await repos.premium.extendTo(userId, premiumExpiry);

      return { coins: balance, premiumExpiry };
    });

    return result ? ok(result) : err("insufficient_coins", "Not enough coins.");
  }

  // --- Rules --------------------------------------------------------------

  /** A stored flag outlives the pass it was set for; the expiry is the truth. */
  private premiumIsLive(state: { isPremium: boolean; premiumExpiry: Date | null }): boolean {
    if (!state.isPremium) return false;
    if (!state.premiumExpiry) return true;
    return state.premiumExpiry.getTime() > this.now().getTime();
  }

  /**
   * Extend from whichever is later: now, or an unexpired pass.
   *
   * Stacking from now would burn what was left — topping up a week early would
   * cost you that week.
   */
  private extendFrom(current: Date | null, days: number): Date {
    const now = this.now();
    const base = current && current.getTime() > now.getTime() ? current : now;
    return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  }
}
