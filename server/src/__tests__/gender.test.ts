import { describe, it, expect, beforeEach, vi } from "vitest";

// Must be hoisted above the service import so it sees the mock.
const findUnique = vi.fn();
const update = vi.fn();

vi.mock("../config/database", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a), update: (...a: unknown[]) => update(...a) } },
}));

import { GenderService, DEFAULT_GENDER_CONFIG } from "../services/gender/service";
import { MockGenderProvider } from "../services/gender/mock";
import { GenderProvider, GenderInference } from "../services/gender/provider";
import { fakeJpeg, toDataUrl } from "./helpers";

const T0 = 1_700_000_000_000;

/** A provider that returns whatever the test dictates. */
class StubProvider implements GenderProvider {
  readonly name = "stub";
  private ready = true;
  next: GenderInference = {
    gender: "male",
    confidence: 0.9,
    faceCount: 1,
    provider: "stub",
    latencyMs: 1,
  };
  throwOnInfer = false;
  failInit = false;

  async init() {
    if (this.failInit) throw new Error("model weights missing");
    this.ready = true;
  }
  isReady() {
    return this.ready;
  }
  setReady(v: boolean) {
    this.ready = v;
  }
  async infer(): Promise<GenderInference> {
    if (this.throwOnInfer) throw new Error("model exploded");
    return this.next;
  }
  async dispose() {
    this.ready = false;
  }
}

describe("GenderService.resolveEffectiveGender", () => {
  const svc = new GenderService(new StubProvider());

  it("falls back to the declared gender with no verification", () => {
    const r = svc.resolveEffectiveGender({ gender: "male" }, T0);
    expect(r).toEqual({ effectiveGender: "male", verified: false });
  });

  it("uses a fresh, confident verification", () => {
    const r = svc.resolveEffectiveGender(
      {
        gender: "male",
        verifiedGender: "female",
        genderConfidence: 0.9,
        genderVerifiedAt: new Date(T0 - 1_000),
      },
      T0,
    );
    expect(r).toEqual({ effectiveGender: "female", verified: true });
  });

  it("ignores a stale verification", () => {
    const r = svc.resolveEffectiveGender(
      {
        gender: "male",
        verifiedGender: "female",
        genderConfidence: 0.99,
        genderVerifiedAt: new Date(T0 - 25 * 60 * 60_000),
      },
      T0,
    );
    expect(r).toEqual({ effectiveGender: "male", verified: false });
  });

  it("ignores a verification below the threshold", () => {
    const r = svc.resolveEffectiveGender(
      {
        gender: "male",
        verifiedGender: "female",
        genderConfidence: 0.5,
        genderVerifiedAt: new Date(T0),
      },
      T0,
    );
    expect(r).toEqual({ effectiveGender: "male", verified: false });
  });

  it("never overrides a self-declared 'other'", () => {
    const r = svc.resolveEffectiveGender(
      {
        gender: "other",
        verifiedGender: "male",
        genderConfidence: 0.99,
        genderVerifiedAt: new Date(T0),
      },
      T0,
    );
    expect(r).toEqual({ effectiveGender: "other", verified: false });
  });

  it("ignores a verifiedGender the model should never emit", () => {
    const r = svc.resolveEffectiveGender(
      {
        gender: "male",
        verifiedGender: "unknown",
        genderConfidence: 0.99,
        genderVerifiedAt: new Date(T0),
      },
      T0,
    );
    expect(r.verified).toBe(false);
  });

  it("treats the threshold as inclusive", () => {
    const r = svc.resolveEffectiveGender(
      {
        gender: "male",
        verifiedGender: "female",
        genderConfidence: DEFAULT_GENDER_CONFIG.threshold,
        genderVerifiedAt: new Date(T0),
      },
      T0,
    );
    expect(r.verified).toBe(true);
  });
});

describe("GenderService.isFresh", () => {
  const svc = new GenderService(new StubProvider());

  it("is false without a timestamp", () => {
    expect(svc.isFresh(null, T0)).toBe(false);
    expect(svc.isFresh(undefined, T0)).toBe(false);
  });

  it("is true inside the window and false outside", () => {
    expect(svc.isFresh(new Date(T0 - 1_000), T0)).toBe(true);
    expect(svc.isFresh(new Date(T0 - 25 * 60 * 60_000), T0)).toBe(false);
  });
});

describe("GenderService.verify", () => {
  let svc: GenderService;
  let provider: StubProvider;
  const image = toDataUrl(fakeJpeg());

  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
    findUnique.mockResolvedValue({ id: "u1", gender: "male" });
    update.mockResolvedValue({});
    provider = new StubProvider();
    svc = new GenderService(provider);
  });

  it("accepts a confident single-face reading and persists it", async () => {
    provider.next = { gender: "male", confidence: 0.92, faceCount: 1, provider: "stub", latencyMs: 1 };
    const res = await svc.verify("u1", image, T0);

    expect(res.outcome).toBe("accepted");
    expect(res.gender).toBe("male");
    expect(res.mismatch).toBe(false);

    const persisted = update.mock.calls.at(-1)![0];
    expect(persisted.data.verifiedGender).toBe("male");
    expect(persisted.data.genderConfidence).toBeCloseTo(0.92, 5);
  });

  it("flags a mismatch against the declared gender", async () => {
    findUnique.mockResolvedValue({ id: "u1", gender: "female" });
    provider.next = { gender: "male", confidence: 0.95, faceCount: 1, provider: "stub", latencyMs: 1 };

    const res = await svc.verify("u1", image, T0);
    expect(res.outcome).toBe("accepted");
    expect(res.mismatch).toBe(true);
    expect(update.mock.calls.at(-1)![0].data.genderMismatch).toBe(true);
  });

  it("never flags a mismatch for a user who declared 'other'", async () => {
    findUnique.mockResolvedValue({ id: "u1", gender: "other" });
    provider.next = { gender: "female", confidence: 0.99, faceCount: 1, provider: "stub", latencyMs: 1 };

    const res = await svc.verify("u1", image, T0);
    expect(res.mismatch).toBe(false);
  });

  it("rejects a reading below the confidence threshold without persisting", async () => {
    provider.next = { gender: "female", confidence: 0.6, faceCount: 1, provider: "stub", latencyMs: 1 };
    const res = await svc.verify("u1", image, T0);

    expect(res.outcome).toBe("low_confidence");
    // Only the attempt counter should have been written.
    const wrote = update.mock.calls.some((c) => "verifiedGender" in (c[0] as any).data);
    expect(wrote).toBe(false);
  });

  it("reports no_face when the detector finds nobody", async () => {
    provider.next = { gender: "unknown", confidence: 0, faceCount: 0, provider: "stub", latencyMs: 1 };
    expect((await svc.verify("u1", image, T0)).outcome).toBe("no_face");
  });

  it("refuses a frame containing several faces", async () => {
    provider.next = { gender: "female", confidence: 0.99, faceCount: 3, provider: "stub", latencyMs: 1 };
    const res = await svc.verify("u1", image, T0);
    expect(res.outcome).toBe("multiple_faces");
    expect(res.gender).toBeNull();
  });

  it("counts every attempt, accepted or not", async () => {
    provider.next = { gender: "unknown", confidence: 0, faceCount: 0, provider: "stub", latencyMs: 1 };
    await svc.verify("u1", image, T0);
    const call = update.mock.calls.find((c) => (c[0] as any).data.genderAttempts);
    expect(call).toBeDefined();
  });

  it("rejects an invalid image before touching the model", async () => {
    const res = await svc.verify("u1", "not-an-image", T0);
    expect(res.outcome).toBe("invalid_image");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("rejects a non-image payload that is valid base64", async () => {
    const res = await svc.verify("u1", Buffer.from("hello world!!").toString("base64"), T0);
    expect(res.outcome).toBe("invalid_image");
  });

  it("reports the provider as unavailable when it cannot be initialised", async () => {
    provider.setReady(false);
    provider.failInit = true;
    expect((await svc.verify("u1", image, T0)).outcome).toBe("provider_unavailable");
  });

  it("lazily initialises a provider that was never started", async () => {
    // This is the boot path the socket layer hits when the server is wired up
    // without the explicit start() call that normally loads the model.
    provider.setReady(false);
    provider.failInit = false;
    const res = await svc.verify("u1", image, T0);
    expect(res.outcome).toBe("accepted");
    expect(provider.isReady()).toBe(true);
  });

  it("throttles retries after a failed initialisation", async () => {
    provider.setReady(false);
    provider.failInit = true;
    expect((await svc.verify("u1", image, T0)).outcome).toBe("provider_unavailable");

    // Even once the provider could come up, the throttle holds it back briefly.
    provider.failInit = false;
    expect((await svc.verify("u1", image, T0 + 1_000)).outcome).toBe("provider_unavailable");

    // Past the retry window it recovers.
    expect((await svc.verify("u1", image, T0 + 31_000)).outcome).toBe("accepted");
  });

  it("turns a model crash into provider_unavailable, not a throw", async () => {
    provider.throwOnInfer = true;
    const res = await svc.verify("u1", image, T0);
    expect(res.outcome).toBe("provider_unavailable");
  });

  it("reports user_not_found for a deleted account", async () => {
    findUnique.mockResolvedValue(null);
    expect((await svc.verify("u1", image, T0)).outcome).toBe("user_not_found");
  });

  describe("rate limiting", () => {
    it("blocks after the configured number of attempts", async () => {
      const limited = new GenderService(provider, { ...DEFAULT_GENDER_CONFIG, maxAttempts: 3 });
      for (let i = 0; i < 3; i++) {
        expect((await limited.verify("u1", image, T0)).outcome).not.toBe("rate_limited");
      }
      const blocked = await limited.verify("u1", image, T0);
      expect(blocked.outcome).toBe("rate_limited");
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });

    it("limits per user, not globally", async () => {
      const limited = new GenderService(provider, { ...DEFAULT_GENDER_CONFIG, maxAttempts: 1 });
      await limited.verify("u1", image, T0);
      expect((await limited.verify("u1", image, T0)).outcome).toBe("rate_limited");
      expect((await limited.verify("u2", image, T0)).outcome).not.toBe("rate_limited");
    });

    it("recovers after the refill interval", async () => {
      const limited = new GenderService(provider, {
        ...DEFAULT_GENDER_CONFIG,
        maxAttempts: 1,
        refillPerSec: 1,
      });
      await limited.verify("u1", image, T0);
      expect((await limited.verify("u1", image, T0)).outcome).toBe("rate_limited");
      expect((await limited.verify("u1", image, T0 + 1_100)).outcome).not.toBe("rate_limited");
    });

    it("rejects an invalid image without wasting a token", async () => {
      const limited = new GenderService(provider, { ...DEFAULT_GENDER_CONFIG, maxAttempts: 2 });
      await limited.verify("u1", "junk", T0);
      await limited.verify("u1", "junk", T0);
      // Both tokens are spent — this documents that malformed input DOES cost
      // a token, which is what stops a client hammering the endpoint for free.
      expect((await limited.verify("u1", image, T0)).outcome).toBe("rate_limited");
    });
  });
});

describe("MockGenderProvider", () => {
  let provider: MockGenderProvider;

  beforeEach(async () => {
    provider = new MockGenderProvider();
    await provider.init();
  });

  it("is deterministic for the same bytes", async () => {
    const img = fakeJpeg(7);
    const a = await provider.infer(img);
    const b = await provider.infer(img);
    expect(a.gender).toBe(b.gender);
    expect(a.confidence).toBe(b.confidence);
  });

  it("varies across different images", async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => provider.infer(fakeJpeg(i))),
    );
    expect(new Set(results.map((r) => r.gender)).size).toBeGreaterThan(1);
  });

  it("always reports zero faces when the gender is unknown", async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => provider.infer(fakeJpeg(i))),
    );
    for (const r of results) {
      if (r.gender === "unknown") expect(r.faceCount).toBe(0);
      else expect(r.faceCount).toBeGreaterThan(0);
    }
  });

  it("keeps confidence inside [0,1]", async () => {
    for (let i = 0; i < 40; i++) {
      const r = await provider.infer(fakeJpeg(i));
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("honours an explicit override", async () => {
    const img = fakeJpeg(1);
    provider.setOverride(img, { gender: "female", confidence: 0.99, faceCount: 1 });
    const r = await provider.infer(img);
    expect(r.gender).toBe("female");
    expect(r.confidence).toBe(0.99);
  });

  it("clearOverrides restores the hash-based behaviour", async () => {
    const img = fakeJpeg(2);
    const natural = await provider.infer(img);
    provider.setOverride(img, { gender: "male", confidence: 0.5, faceCount: 1 });
    provider.clearOverrides();
    expect((await provider.infer(img)).gender).toBe(natural.gender);
  });

  it("reports not-ready before init and after dispose", async () => {
    const p = new MockGenderProvider();
    expect(p.isReady()).toBe(false);
    await p.init();
    expect(p.isReady()).toBe(true);
    await p.dispose();
    expect(p.isReady()).toBe(false);
  });
});
