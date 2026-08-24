import { OrderStatus } from "./ports";

/**
 * The one place that says which order transitions are legal.
 *
 * These used to be string literals spread across six route handlers — one
 * checked `!== "awaiting_payment" && !== "rejected"`, another guarded on
 * `"under_review"`, a third assumed it. Nothing stated the rules together, so
 * whether a rejected order could be paid again, or an approved one re-reviewed,
 * could only be answered by reading all six and hoping none had drifted.
 *
 * Money states are exactly where that goes wrong quietly: the mistake is not a
 * crash, it is an order that can be credited from a state nobody meant to
 * allow.
 */

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  // Nobody has claimed to have paid yet. It can be paid, or given up on.
  awaiting_payment: ["under_review", "rejected"],

  // A reference has been submitted and is waiting for a human.
  under_review: ["approved", "rejected"],

  // Terminal. Coins have been credited, and crediting twice is the failure
  // this whole design exists to prevent.
  approved: [],

  // Not terminal, deliberately. A rejection is usually a mistyped reference,
  // and a payer who really did send the money has to be able to correct it
  // rather than pay again.
  rejected: ["under_review"],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** States an order can still move out of — what the open-order cap counts. */
export const OPEN_STATUSES: readonly OrderStatus[] = ["awaiting_payment", "under_review"];

export function isOpen(status: OrderStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/** Can a payer still attach (or re-attach) a reference to this order? */
export function acceptsReference(status: OrderStatus): boolean {
  return canTransition(status, "under_review");
}

/** Is this order sitting in the review queue, waiting on a decision? */
export function awaitsDecision(status: OrderStatus): boolean {
  return status === "under_review";
}

/** Wording for a status, used in messages back to the payer. */
export function describe(status: OrderStatus): string {
  switch (status) {
    case "awaiting_payment":
      return "waiting for payment";
    case "under_review":
      return "being checked";
    case "approved":
      return "already credited";
    case "rejected":
      return "rejected";
  }
}
