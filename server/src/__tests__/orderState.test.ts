import { describe, it, expect } from "vitest";
import {
  OPEN_STATUSES,
  acceptsReference,
  awaitsDecision,
  canTransition,
  describe as describeStatus,
  isOpen,
} from "../services/coins/orderState";
import { OrderStatus } from "../services/coins/ports";

const ALL: OrderStatus[] = ["awaiting_payment", "under_review", "approved", "rejected"];

/**
 * The transitions, stated as a table so the whole shape is visible at once.
 *
 * These rules used to be implicit in six route handlers — one testing
 * `!== "awaiting_payment" && !== "rejected"`, another guarding on
 * `"under_review"`, a third assuming it. Whether an approved order could be
 * credited again could only be answered by reading all six.
 */
describe("order transitions", () => {
  it("allows exactly the moves that make sense", () => {
    const allowed = new Set([
      "awaiting_payment->under_review",
      "awaiting_payment->rejected",
      "under_review->approved",
      "under_review->rejected",
      "rejected->under_review",
    ]);

    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransition(from, to), `${from}->${to}`).toBe(allowed.has(`${from}->${to}`));
      }
    }
  });

  it("makes approved terminal", () => {
    // Crediting twice is the failure the whole design exists to prevent, and
    // this is where it is ruled out rather than caught later.
    for (const to of ALL) {
      expect(canTransition("approved", to), `approved->${to}`).toBe(false);
    }
  });

  it("lets a rejected order be paid again", () => {
    // A rejection is usually a mistyped reference. Someone who really did send
    // the money has to be able to correct it rather than pay a second time.
    expect(canTransition("rejected", "under_review")).toBe(true);
  });

  it("never lets an order go straight from unpaid to credited", () => {
    // The step it would skip is the only one that checks a bank statement.
    expect(canTransition("awaiting_payment", "approved")).toBe(false);
  });

  it("counts as open exactly the states an order can still move out of", () => {
    for (const status of ALL) {
      const movable = ALL.some((to) => canTransition(status, to));
      expect(isOpen(status), status).toBe(movable && OPEN_STATUSES.includes(status));
    }
    expect([...OPEN_STATUSES]).toEqual(["awaiting_payment", "under_review"]);
  });

  it("accepts a reference in just the states that lead to review", () => {
    for (const status of ALL) {
      expect(acceptsReference(status), status).toBe(canTransition(status, "under_review"));
    }
  });

  it("waits on a decision only while under review", () => {
    for (const status of ALL) {
      expect(awaitsDecision(status), status).toBe(status === "under_review");
    }
  });

  it("has wording for every state", () => {
    // These reach the buyer, so a missing one would surface as "undefined".
    for (const status of ALL) {
      expect(describeStatus(status)).toMatch(/\w/);
    }
  });

  it("refuses a status it has never heard of", () => {
    expect(canTransition("nonsense" as OrderStatus, "approved")).toBe(false);
  });
});
