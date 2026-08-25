import { describe, it, expect } from "vitest";
import { findProblems, Problem } from "../routes/admin";

/**
 * The list that decides what the status page says.
 *
 * This is the part of the admin page worth testing: the numbers are read off
 * the database, but this is judgement — what counts as broken, what is merely
 * degraded, and what a customer would actually experience. Getting it wrong in
 * the quiet direction is the expensive one, because a page that says "nothing
 * is wrong" is trusted.
 */

const healthy = {
  storeOk: true,
  dbOk: true,
  payments: {
    provider: "razorpay",
    configured: true,
    mode: "live" as string | null,
    webhookReady: true as boolean | null,
    adminCount: 1,
    confirmsAutomatically: true,
  },
  calls: { hasTurn: true, stunCount: 2 },
  money: { awaitingReview: 0, stale: 0 },
  live: { oldestWaitMs: 0 },
};

const has = (problems: Problem[], fragment: string) =>
  problems.some((p) => p.what.toLowerCase().includes(fragment.toLowerCase()));

const worst = (problems: Problem[]): string | undefined =>
  problems.find((p) => p.level === "broken")?.what;

describe("what the status page reports", () => {
  it("says nothing is wrong when nothing is", () => {
    expect(findProblems(healthy)).toEqual([]);
  });

  it("calls a dead database broken, in terms of what a customer sees", () => {
    const problems = findProblems({ ...healthy, dbOk: false });
    expect(worst(problems)).toMatch(/sign in|sign up/i);
  });

  it("calls a dead queue store broken", () => {
    const problems = findProblems({ ...healthy, storeOk: false });
    expect(has(problems, "matching is down")).toBe(true);
  });

  it("treats test-mode keys as broken, not as a note", () => {
    /*
     * The one most likely to be shrugged off, and the most expensive: a real
     * customer pays nothing, receives nothing, and both sides think it worked.
     * Test keys are the normal state of an account for days, so this has to
     * shout.
     */
    const problems = findProblems({
      ...healthy,
      payments: { ...healthy.payments, mode: "test" },
    });
    expect(problems.some((p) => p.level === "broken" && /real money/i.test(p.what))).toBe(true);
  });

  it("warns when a live gateway has no webhook secret", () => {
    // The buyer is charged and credited only if they stay on the page.
    const problems = findProblems({
      ...healthy,
      payments: { ...healthy.payments, webhookReady: false },
    });
    expect(has(problems, "closes the tab")).toBe(true);
  });

  it("does not warn about a webhook for a provider that has none", () => {
    // UPI reports null rather than false, and treating that as missing would
    // put a permanent false alarm on the page.
    const problems = findProblems({
      ...healthy,
      payments: {
        ...healthy.payments,
        provider: "upi",
        mode: null,
        webhookReady: null,
        confirmsAutomatically: false,
      },
    });
    expect(has(problems, "closes the tab")).toBe(false);
  });

  it("says nobody can buy when the provider is unconfigured", () => {
    const problems = findProblems({
      ...healthy,
      payments: { ...healthy.payments, configured: false },
    });
    expect(worst(problems)).toMatch(/buy coins/i);
  });

  it("names the right script for the provider in use", () => {
    // A fix that names the wrong command is worse than no fix.
    const razorpay = findProblems({
      ...healthy,
      payments: { ...healthy.payments, configured: false },
    });
    expect(razorpay.find((p) => /buy coins/i.test(p.what))?.fix).toMatch(/set-razorpay/);

    const upi = findProblems({
      ...healthy,
      payments: { ...healthy.payments, provider: "upi", configured: false, mode: null },
    });
    expect(upi.find((p) => /buy coins/i.test(p.what))?.fix).toMatch(/set-upi/);
  });

  it("says payments can never be approved with no administrator", () => {
    const problems = findProblems({
      ...healthy,
      payments: { ...healthy.payments, adminCount: 0 },
    });
    expect(has(problems, "never be approved")).toBe(true);
  });

  it("reports a missing TURN relay in terms of the calls that fail", () => {
    // Not "TURN is unset" — what it costs is calls between networks, which is
    // exactly what a premium customer paid for.
    const problems = findProblems({
      ...healthy,
      calls: { ...healthy.calls, hasTurn: false },
    });
    const turn = problems.find((p) => /different networks/i.test(p.what));
    expect(turn?.level).toBe("degraded");
    expect(turn?.why).toMatch(/premium/i);
  });

  it("reports customers waiting for a manual approval", () => {
    const problems = findProblems({
      ...healthy,
      payments: { ...healthy.payments, confirmsAutomatically: false },
      money: { awaitingReview: 3, stale: 0 },
    });
    expect(has(problems, "3 customers are waiting")).toBe(true);
  });

  it("says nothing about a review queue a gateway empties by itself", () => {
    // With instant crediting an order under review is a transient state, not
    // somebody stuck waiting for a human.
    const problems = findProblems({
      ...healthy,
      money: { awaitingReview: 3, stale: 0 },
    });
    expect(has(problems, "waiting for coins")).toBe(false);
  });

  it("gets the singular right for one waiting customer", () => {
    const problems = findProblems({
      ...healthy,
      payments: { ...healthy.payments, confirmsAutomatically: false },
      money: { awaitingReview: 1, stale: 0 },
    });
    expect(has(problems, "1 customer is waiting")).toBe(true);
  });

  it("mentions stale orders as a note rather than an alarm", () => {
    const problems = findProblems({ ...healthy, money: { awaitingReview: 0, stale: 4 } });
    expect(problems.find((p) => /unfinished/i.test(p.what))?.level).toBe("note");
    expect(has(problems, "4 orders are older")).toBe(true);
  });

  it("reads correctly for a single stale order", () => {
    // "1 order ... are unfinished" made it to a live page before this existed.
    const problems = findProblems({ ...healthy, money: { awaitingReview: 0, stale: 1 } });
    expect(has(problems, "1 order is older")).toBe(true);
  });

  it("notices somebody stuck in the queue", () => {
    const problems = findProblems({ ...healthy, live: { oldestWaitMs: 11 * 60_000 } });
    expect(has(problems, "waiting more than ten minutes")).toBe(true);
  });

  it("stays quiet about an ordinary wait", () => {
    const problems = findProblems({ ...healthy, live: { oldestWaitMs: 45_000 } });
    expect(has(problems, "waiting more than")).toBe(false);
  });

  it("reports every problem at once rather than only the first", () => {
    // A fresh deployment has several, and fixing them one page-load at a time
    // is how the last one gets missed.
    const problems = findProblems({
      storeOk: false,
      dbOk: false,
      payments: {
        provider: "upi",
        configured: false,
        mode: null,
        webhookReady: null,
        adminCount: 0,
        confirmsAutomatically: false,
      },
      calls: { hasTurn: false, stunCount: 0 },
      money: { awaitingReview: 2, stale: 5 },
      live: { oldestWaitMs: 20 * 60_000 },
    });

    expect(problems.length).toBeGreaterThanOrEqual(7);
    expect(problems.every((p) => p.what && p.why && p.fix)).toBe(true);
  });
});
