import { describe, it, expect, beforeEach } from "vitest";
import { MemoryCoinStore } from "../services/coins/adapters/memory";
import { CoinService, OPEN_ORDER_LIMIT } from "../services/coins/service";
import { PaymentInstruction, PaymentProvider } from "../services/coins/ports";

/**
 * Every rule about buying and spending, with no database and no HTTP.
 *
 * This is what the port split bought. The same behaviour used to be reachable
 * only through supertest against Postgres, which meant the rules could not be
 * exercised at all on a machine without one, and each case cost a round trip.
 * These run in milliseconds and can drive the awkward states — a lapsed pass,
 * a payment provider that confirms itself, a clock at a chosen instant —
 * directly, rather than by contriving them through the API.
 */

class FakeProvider implements PaymentProvider {
  readonly id = "fake";
  readonly confirmsAutomatically = false;
  configured = true;

  isConfigured(): boolean {
    return this.configured;
  }

  instructionFor(order: { id: string; amountPaise: number; description: string }): PaymentInstruction {
    return {
      kind: this.id,
      link: `fake://pay?ref=${order.id}&amt=${order.amountPaise}`,
      payee: "someone@bank",
      payeeName: "Someone",
      amountRupees: (order.amountPaise / 100).toFixed(2),
      reference: order.id,
    };
  }

  isPlausibleReference(value: string): boolean {
    return /^[a-zA-Z0-9]{6,35}$/.test(value);
  }
}

let store: MemoryCoinStore;
let provider: FakeProvider;
let service: CoinService;
let now: Date;
let buyer: string;
let reviewer: string;

beforeEach(() => {
  store = new MemoryCoinStore();
  provider = new FakeProvider();
  now = new Date("2026-03-01T00:00:00Z");
  service = new CoinService(store, provider, () => now);
  buyer = store.addUser();
  reviewer = store.addUser();
});

/** Take an order all the way to "waiting for a human". */
async function orderAwaitingReview(reference = "REF123456") {
  const created = await service.createOrder(buyer, "starter");
  if (!created.ok) throw new Error(`order failed: ${created.code}`);
  const submitted = await service.submitReference(buyer, created.value.order.id, reference);
  if (!submitted.ok) throw new Error(`reference failed: ${submitted.code}`);
  return created.value.order.id;
}

describe("starting a purchase", () => {
  it("hands back something payable, tied to the order", async () => {
    const result = await service.createOrder(buyer, "starter");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.order.status).toBe("awaiting_payment");
    expect(result.value.order.coins).toBe(500);
    // The reference is the only thread from the money back to the order.
    expect(result.value.payment.reference).toBe(result.value.order.id);
  });

  it("refuses when no payee is configured", async () => {
    // Better than rendering a QR that would pay nobody.
    provider.configured = false;

    const result = await service.createOrder(buyer, "starter");
    expect(result).toMatchObject({ ok: false, code: "payments_unavailable" });
  });

  it("refuses anything not on the price list", async () => {
    // These arrive straight off a request body.
    for (const junk of [undefined, null, "", "free", 42, {}, []]) {
      expect(await service.createOrder(buyer, junk)).toMatchObject({ code: "unknown_pack" });
    }
  });

  it("credits nothing for merely placing an order", async () => {
    await service.createOrder(buyer, "starter");
    expect(await store.wallet.balanceOf(buyer)).toBe(0);
  });

  it("caps how many unfinished orders one account can pile up", async () => {
    for (let i = 0; i < OPEN_ORDER_LIMIT; i++) {
      expect((await service.createOrder(buyer, "starter")).ok).toBe(true);
    }
    expect(await service.createOrder(buyer, "starter")).toMatchObject({ code: "too_many_open" });
  });

  it("frees a slot when an order is finished", async () => {
    const ids: string[] = [];
    for (let i = 0; i < OPEN_ORDER_LIMIT; i++) {
      const r = await service.createOrder(buyer, "starter");
      if (r.ok) ids.push(r.value.order.id);
    }
    await service.cancelOrder(buyer, ids[0]);

    expect((await service.createOrder(buyer, "starter")).ok).toBe(true);
  });

  it("prices the order from the catalogue at the time it was placed", async () => {
    const result = await service.createOrder(buyer, "plus");
    expect(result.ok && result.value.order.amountPaise).toBe(100_000);
    expect(result.ok && result.value.order.coins).toBe(1_150);
  });
});

describe("claiming a payment", () => {
  it("moves the order to review without crediting anything", async () => {
    const id = await orderAwaitingReview();

    const order = (await service.ordersFor(buyer)).find((o) => o.id === id);
    expect(order?.status).toBe("under_review");
    // The buyer cannot talk themselves into a balance.
    expect(await store.wallet.balanceOf(buyer)).toBe(0);
  });

  it("rejects a reference that is not shaped like one", async () => {
    const created = await service.createOrder(buyer, "starter");
    if (!created.ok) return;

    for (const junk of ["", "no", "has space", "punct-uation"]) {
      expect(await service.submitReference(buyer, created.value.order.id, junk)).toMatchObject({
        code: "bad_reference",
      });
    }
  });

  it("will not let one transfer be claimed twice", async () => {
    // The version of this that costs real money: two accounts, one payment.
    const other = store.addUser();
    await orderAwaitingReview("SHARED123");

    const theirs = await service.createOrder(other, "starter");
    if (!theirs.ok) return;

    expect(await service.submitReference(other, theirs.value.order.id, "SHARED123")).toMatchObject({
      code: "duplicate_reference",
    });
  });

  it("hides other people's orders behind not-found", async () => {
    // Which order ids exist is not information a stranger needs.
    const stranger = store.addUser();
    const id = await orderAwaitingReview();

    expect(await service.submitReference(stranger, id, "OTHER1234")).toMatchObject({
      code: "not_found",
    });
  });

  it("refuses a second claim on an order already under review", async () => {
    const id = await orderAwaitingReview();
    expect(await service.submitReference(buyer, id, "AGAIN12345")).toMatchObject({
      code: "wrong_state",
    });
  });

  it("refuses to re-claim an order that was already credited", async () => {
    const id = await orderAwaitingReview();
    await service.approveOrder(id, reviewer);

    expect(await service.submitReference(buyer, id, "ONCEMORE12")).toMatchObject({
      code: "wrong_state",
    });
  });
});

describe("reviewing", () => {
  it("credits the coins on approval", async () => {
    const id = await orderAwaitingReview();

    const result = await service.approveOrder(id, reviewer);

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.value.credited).toBe(500);
    expect(await store.wallet.balanceOf(buyer)).toBe(500);
  });

  it("credits once when approve is pressed twice", async () => {
    const id = await orderAwaitingReview();

    const first = await service.approveOrder(id, reviewer);
    const second = await service.approveOrder(id, reviewer);

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ code: "not_awaiting_review" });
    expect(await store.wallet.balanceOf(buyer)).toBe(500);
    expect(store.ledgerFor(buyer).filter((e) => e.reason === "purchase")).toHaveLength(1);
  });

  it("will not approve an order nobody has claimed to have paid", async () => {
    const created = await service.createOrder(buyer, "starter");
    if (!created.ok) return;

    expect(await service.approveOrder(created.value.order.id, reviewer)).toMatchObject({
      code: "not_awaiting_review",
    });
    expect(await store.wallet.balanceOf(buyer)).toBe(0);
  });

  it("records who decided, and when", async () => {
    const id = await orderAwaitingReview();
    await service.approveOrder(id, reviewer);

    const order = (await service.ordersForReview("approved")).find((o) => o.id === id);
    expect(order?.reviewedBy).toBe(reviewer);
    expect(order?.reviewedAt).toEqual(now);
  });

  it("frees the reference on rejection so a typo can be corrected", async () => {
    const id = await orderAwaitingReview("TYPO123456");

    await service.rejectOrder(id, reviewer, "No matching payment");
    const retry = await service.submitReference(buyer, id, "CORRECT123");

    expect(retry.ok).toBe(true);
    // And the old rejection note must not still be hanging off it.
    expect(retry.ok && retry.value.note).toBeNull();
  });

  it("keeps a reference that really was used", async () => {
    // Freeing on rejection must not release one an approved order still holds.
    const id = await orderAwaitingReview("REALPAY123");
    await service.approveOrder(id, reviewer);

    const other = store.addUser();
    const theirs = await service.createOrder(other, "starter");
    if (!theirs.ok) return;

    expect(await service.submitReference(other, theirs.value.order.id, "REALPAY123")).toMatchObject(
      { code: "duplicate_reference" },
    );
  });

  it("explains a rejection to the buyer", async () => {
    const id = await orderAwaitingReview();
    await service.rejectOrder(id, reviewer, "Amount did not match");

    const order = (await service.ordersFor(buyer)).find((o) => o.id === id);
    expect(order?.note).toBe("Amount did not match");
  });

  it("supplies a reason when the reviewer gives none", async () => {
    const id = await orderAwaitingReview();
    await service.rejectOrder(id, reviewer, "   ");

    const order = (await service.ordersFor(buyer)).find((o) => o.id === id);
    expect(order?.note).toBe("No matching payment found.");
  });
});

describe("cancelling", () => {
  it("lets a buyer give up on an unpaid order", async () => {
    const created = await service.createOrder(buyer, "starter");
    if (!created.ok) return;

    expect(await service.cancelOrder(buyer, created.value.order.id)).toMatchObject({ ok: true });
  });

  it("will not cancel one that is already being checked", async () => {
    // Otherwise a payer could hide a transfer that already went through.
    const id = await orderAwaitingReview();
    expect(await service.cancelOrder(buyer, id)).toMatchObject({ code: "wrong_state" });
  });

  it("will not cancel somebody else's order", async () => {
    const stranger = store.addUser();
    const created = await service.createOrder(buyer, "starter");
    if (!created.ok) return;

    expect(await service.cancelOrder(stranger, created.value.order.id)).toMatchObject({
      code: "not_found",
    });
  });
});

describe("spending coins", () => {
  it("turns 500 coins into thirty days", async () => {
    await store.wallet.credit(buyer, 500, "purchase");

    const result = await service.redeemPass(buyer, "month");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.coins).toBe(0);
    expect(result.value.premiumExpiry.toISOString()).toBe("2026-03-31T00:00:00.000Z");
  });

  it("declines when the balance is short, and takes nothing", async () => {
    await store.wallet.credit(buyer, 499, "purchase");

    expect(await service.redeemPass(buyer, "month")).toMatchObject({ code: "insufficient_coins" });
    expect(await store.wallet.balanceOf(buyer)).toBe(499);
    expect(store.userOf(buyer)?.isPremium).toBe(false);
  });

  it("stacks onto a pass that is still running", async () => {
    // Topping up early must not burn the remaining days.
    await store.wallet.credit(buyer, 530, "purchase");
    await service.redeemPass(buyer, "month");
    const second = await service.redeemPass(buyer, "day");

    expect(second.ok && second.value.premiumExpiry.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("restarts from now when the old pass has lapsed", async () => {
    const lapsed = store.addUser({
      coins: 500,
      isPremium: true,
      premiumExpiry: new Date("2026-02-01T00:00:00Z"),
    });

    const result = await service.redeemPass(lapsed, "month");
    expect(result.ok && result.value.premiumExpiry.toISOString()).toBe("2026-03-31T00:00:00.000Z");
  });

  it("refuses a pass that is not on the list", async () => {
    await store.wallet.credit(buyer, 1000, "purchase");

    expect(await service.redeemPass(buyer, "forever")).toMatchObject({ code: "unknown_pass" });
    expect(await store.wallet.balanceOf(buyer)).toBe(1000);
  });
});

describe("the wallet view", () => {
  it("reports premium as off once the expiry has passed", async () => {
    // The stored flag outlives the pass. Reading it alone would leave the
    // filters looking unlocked while the server ignored them.
    const lapsed = store.addUser({
      isPremium: true,
      premiumExpiry: new Date("2026-02-01T00:00:00Z"),
    });

    expect((await service.walletFor(lapsed))?.isPremium).toBe(false);
  });

  it("reports premium as on while the pass is still running", async () => {
    const live = store.addUser({
      isPremium: true,
      premiumExpiry: new Date("2026-03-15T00:00:00Z"),
    });

    expect((await service.walletFor(live))?.isPremium).toBe(true);
  });

  it("says purchases are off when no payee is configured", async () => {
    provider.configured = false;
    expect((await service.walletFor(buyer))?.purchasesEnabled).toBe(false);
  });

  it("returns nothing for an account that does not exist", async () => {
    expect(await service.walletFor("nobody")).toBeNull();
  });

  it("carries the price list, so the client never restates it", async () => {
    const wallet = await service.walletFor(buyer);
    expect(wallet?.packs.length).toBeGreaterThan(0);
    expect(wallet?.passes.length).toBeGreaterThan(0);
  });
});

describe("the ledger", () => {
  it("records every movement with the balance it produced", async () => {
    await store.wallet.credit(buyer, 500, "purchase");
    await service.redeemPass(buyer, "month");

    const entries = await service.ledgerFor(buyer);
    expect(entries.map((e) => e.delta)).toEqual([-500, 500]);
    expect(entries.map((e) => e.balanceAfter)).toEqual([0, 500]);
  });
});
