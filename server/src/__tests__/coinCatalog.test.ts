import { describe, it, expect, afterEach } from "vitest";
import { COIN_PACKS, COIN_PASSES, findPack, findPass, rupees } from "../services/coins/catalog";
import { buildUpiRequest, looksLikeUpiRef, looksLikeVpa } from "../services/coins/upi";
import { env } from "../config/env";

/**
 * The catalogue is the price list, and a price list that contradicts itself
 * charges someone the wrong amount. These are the invariants worth failing a
 * build over — not the exact numbers, which are meant to be tuned.
 */
describe("coin catalogue", () => {
  it("keeps the headline promise: 500 rupees is a month", () => {
    const starter = findPack("starter")!;
    const month = findPass("month")!;

    expect(starter.amountPaise).toBe(50_000);
    expect(starter.coins).toBe(month.cost);
  });

  it("prices every pack and pass positively", () => {
    for (const pack of COIN_PACKS) {
      expect(pack.amountPaise).toBeGreaterThan(0);
      expect(pack.coins).toBeGreaterThan(0);
    }
    for (const pass of COIN_PASSES) {
      expect(pass.cost).toBeGreaterThan(0);
      expect(pass.days).toBeGreaterThan(0);
    }
  });

  it("never sells a bigger pack for fewer coins", () => {
    // Sorted by price, coins must climb too. Otherwise someone paying more
    // gets less, which no amount of copy explains away.
    const byPrice = [...COIN_PACKS].sort((a, b) => a.amountPaise - b.amountPaise);
    for (let i = 1; i < byPrice.length; i++) {
      expect(byPrice[i].coins).toBeGreaterThan(byPrice[i - 1].coins);
    }
  });

  it("states a bonus that matches the coins actually given", () => {
    // The bonus is shown to the buyer. If it disagrees with the arithmetic,
    // the screen is lying about the deal.
    for (const pack of COIN_PACKS) {
      expect(pack.bonusCoins).toBe(pack.coins - pack.amountPaise / 100);
      expect(pack.bonusCoins).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps the longer pass cheaper per day", () => {
    const byDays = [...COIN_PASSES].sort((a, b) => a.days - b.days);
    for (let i = 1; i < byDays.length; i++) {
      const cheaper = byDays[i].cost / byDays[i].days;
      const dearer = byDays[i - 1].cost / byDays[i - 1].days;
      expect(cheaper).toBeLessThan(dearer);
    }
  });

  it("has no duplicate ids", () => {
    expect(new Set(COIN_PACKS.map((p) => p.id)).size).toBe(COIN_PACKS.length);
    expect(new Set(COIN_PASSES.map((p) => p.id)).size).toBe(COIN_PASSES.length);
  });

  it("refuses to find something that is not on sale", () => {
    // These come straight off a request body, so anything at all can arrive.
    for (const junk of [undefined, null, "", "free", 42, {}, []]) {
      expect(findPack(junk)).toBeNull();
      expect(findPass(junk)).toBeNull();
    }
  });

  it("formats paise as rupees", () => {
    expect(rupees(50_000)).toBe("500");
    expect(rupees(100_000)).toBe("1,000");
  });
});

describe("UPI request", () => {
  // These tests reconfigure the payee. Restoring it keeps one case from
  // deciding what a later one is testing against.
  const original = { id: env.UPI_ID, name: env.UPI_PAYEE_NAME };
  afterEach(() => {
    env.UPI_ID = original.id;
    env.UPI_PAYEE_NAME = original.name;
  });

  it("accepts real-looking VPAs and rejects the rest", () => {
    for (const good of ["nikhil@paytm", "9876543210@ybl", "a.b-c_d@okhdfcbank"]) {
      expect(looksLikeVpa(good)).toBe(true);
    }
    // A typo here sends a stranger money that cannot be recovered.
    for (const bad of ["", "nikhil", "@paytm", "nikhil@", "a@b@c", "nikhil paytm"]) {
      expect(looksLikeVpa(bad)).toBe(false);
    }
  });

  it("builds a payable link with the amount fixed to two decimals", () => {
    env.UPI_ID = "test@paytm";
    env.UPI_PAYEE_NAME = "Omextv";

    const req = buildUpiRequest({ amountPaise: 50_000, reference: "abc123", note: "Omextv 500" });
    const params = new URLSearchParams(req.link.replace("upi://pay?", ""));

    expect(req.link.startsWith("upi://pay?")).toBe(true);
    expect(params.get("pa")).toBe("test@paytm");
    expect(params.get("cu")).toBe("INR");
    // "500" and "500.00" are not read the same way by every app.
    expect(params.get("am")).toBe("500.00");
    expect(params.get("tr")).toBe("abc123");
  });

  it("escapes a payee name that would otherwise break the query string", () => {
    env.UPI_ID = "test@paytm";
    env.UPI_PAYEE_NAME = "Omex & Co";

    const req = buildUpiRequest({ amountPaise: 50_000, reference: "abc123", note: "hi" });
    const params = new URLSearchParams(req.link.replace("upi://pay?", ""));

    // Unescaped, the "&" would end the name field and invent a new parameter.
    expect(params.get("pn")).toBe("Omex & Co");
  });

  it("strips punctuation out of the reference", () => {
    env.UPI_ID = "test@paytm";

    // Several apps drop a reference containing punctuation entirely, losing
    // the only field that ties the money to an order.
    const req = buildUpiRequest({
      amountPaise: 50_000,
      reference: "cm-t68_4z.pq0034",
      note: "hi",
    });

    expect(req.reference).toBe("cmt684zpq0034");
  });

  it("refuses to build a link when no payee is configured", () => {
    env.UPI_ID = "";
    expect(() => buildUpiRequest({ amountPaise: 1, reference: "x", note: "y" })).toThrow();
  });

  it("accepts the range of references banks actually print", () => {
    for (const good of ["123456789012", "AXIS0001234567", "abc123"]) {
      expect(looksLikeUpiRef(good)).toBe(true);
    }
    for (const bad of ["", "12345", "has space", "punct-uation", "x".repeat(36)]) {
      expect(looksLikeUpiRef(bad)).toBe(false);
    }
  });
});
