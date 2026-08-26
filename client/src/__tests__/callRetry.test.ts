import { describe, expect, it } from "vitest";

/**
 * Moving on by itself after a connection that will not come up.
 *
 * Failing to reach one stranger says something about the two networks, not
 * about this person, so the next one may well work — and being left on a dead
 * screen holding a sentence about TURN relays is how someone decides the site
 * is broken. The retry has to stop, though: repeating without end is
 * indistinguishable from a frozen page, and on a network where nothing will
 * ever connect that is what it becomes.
 *
 * The policy is tested here rather than the peer connection, because what
 * matters is when it gives up and what it says at each point. It is imported
 * rather than restated: a copy of the rule in the test would agree with itself
 * however the app behaved.
 */

import { decideAfterFailure as decide } from "../hooks/useCall";

const AUTO_ADVANCE_LIMIT = 3;

describe("what happens after a call fails to connect", () => {
  it("tries the next person rather than stopping on the first failure", () => {
    const d = decide(0, true);
    expect(d.willRetry).toBe(true);
    expect(d.message).toMatch(/Finding you someone else/);
  });

  it("keeps trying up to the limit", () => {
    expect(decide(1, true).willRetry).toBe(true);
    expect(decide(2, true).willRetry).toBe(true);
  });

  it("stops after the limit, and says so in words a stranger can act on", () => {
    const d = decide(AUTO_ADVANCE_LIMIT, true);
    expect(d.willRetry).toBe(false);
    expect(d.message).toMatch(/Press Start to try again/);
    // No jargon in front of the customer.
    expect(d.message).not.toMatch(/TURN|relay|NAT/i);
  });

  it("does not retry when there are no filters to rejoin with", () => {
    // Nothing to send to the queue, so a retry would join with nothing.
    expect(decide(0, false).willRetry).toBe(false);
  });
});
