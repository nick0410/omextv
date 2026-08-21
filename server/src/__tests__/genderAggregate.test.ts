import { describe, it, expect, beforeEach, vi } from "vitest";

const findUnique = vi.fn();
const update = vi.fn();

vi.mock("../config/database", () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => update(...a),
    },
  },
}));

import {
  GenderService,
  DEFAULT_GENDER_CONFIG,
  aggregateReadings,
} from "../services/gender/service";
import { GenderProvider, GenderInference } from "../services/gender/provider";
import { fakeJpeg, toDataUrl } from "./helpers";

const T0 = 1_700_000_000_000;

const reading = (
  gender: "male" | "female" | "unknown",
  confidence: number,
  faceCount = 1,
): GenderInference => ({ gender, confidence, faceCount, provider: "seq", latencyMs: 1 });

/** Returns a scripted reading per infer() call, repeating the last one. */
class SequenceProvider implements GenderProvider {
  readonly name = "seq";
  private ready = true;
  private index = 0;
  constructor(private sequence: GenderInference[] = []) {}
  async init() {
    this.ready = true;
  }
  isReady() {
    return this.ready;
  }
  async infer(): Promise<GenderInference> {
    const next = this.sequence[this.index] ?? this.sequence[this.sequence.length - 1];
    this.index++;
    return next;
  }
  async dispose() {
    this.ready = false;
  }
  reset(sequence: GenderInference[]) {
    this.sequence = sequence;
    this.index = 0;
  }
}

describe("aggregateReadings", () => {
  it("returns unknown for an empty batch", () => {
    const agg = aggregateReadings([]);
    expect(agg.gender).toBe("unknown");
    expect(agg.framesUsed).toBe(0);
  });

  it("ignores frames with no face", () => {
    const agg = aggregateReadings([
      reading("unknown", 0, 0),
      reading("male", 0.9),
      reading("male", 0.9),
    ]);
    expect(agg.framesUsed).toBe(2);
    expect(agg.gender).toBe("male");
  });

  it("ignores frames containing several faces", () => {
    const agg = aggregateReadings([reading("female", 0.99, 3), reading("male", 0.9)]);
    expect(agg.framesUsed).toBe(1);
    expect(agg.gender).toBe("male");
  });

  it("reports full agreement when every frame concurs", () => {
    const agg = aggregateReadings([
      reading("female", 0.9),
      reading("female", 0.95),
      reading("female", 0.85),
    ]);
    expect(agg.gender).toBe("female");
    expect(agg.agreement).toBe(1);
    expect(agg.confidence).toBeCloseTo(0.9, 2);
  });

  it("reports partial agreement when frames disagree", () => {
    const agg = aggregateReadings([
      reading("male", 0.8),
      reading("male", 0.8),
      reading("female", 0.8),
    ]);
    expect(agg.gender).toBe("male");
    expect(agg.agreement).toBeCloseTo(2 / 3, 2);
  });

  it("lets confident frames outweigh hesitant ones", () => {
    // Three coin-flips for female against two confident males. Counting votes
    // would answer female; averaging probabilities correctly answers male.
    const agg = aggregateReadings([
      reading("female", 0.51),
      reading("female", 0.52),
      reading("female", 0.53),
      reading("male", 0.98),
      reading("male", 0.97),
    ]);
    expect(agg.gender).toBe("male");
    // Agreement stays low, so the service still refuses it as unstable.
    expect(agg.agreement).toBeLessThan(0.7);
  });

  it("keeps confidence inside [0,1]", () => {
    const agg = aggregateReadings([
      reading("male", 1),
      reading("male", 1),
      reading("female", 0.99),
    ]);
    expect(agg.confidence).toBeLessThanOrEqual(1);
    expect(agg.confidence).toBeGreaterThanOrEqual(0);
  });

  it("is symmetric — mirroring the labels mirrors the verdict", () => {
    const a = aggregateReadings([reading("male", 0.9), reading("male", 0.8)]);
    const b = aggregateReadings([reading("female", 0.9), reading("female", 0.8)]);
    expect(a.gender).toBe("male");
    expect(b.gender).toBe("female");
    expect(a.confidence).toBeCloseTo(b.confidence, 5);
  });
});

describe("multi-frame verification", () => {
  let svc: GenderService;
  let provider: SequenceProvider;
  const frame = (n: number) => toDataUrl(fakeJpeg(n));

  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
    findUnique.mockResolvedValue({
      id: "u1",
      gender: "male",
      verifiedGender: null,
      genderConfidence: null,
    });
    update.mockResolvedValue({});
    provider = new SequenceProvider([]);
    svc = new GenderService(provider, DEFAULT_GENDER_CONFIG);
  });

  it("accepts a consistent batch", async () => {
    provider.reset([reading("male", 0.95), reading("male", 0.93), reading("male", 0.9)]);
    const res = await svc.verify("u1", [frame(1), frame(2), frame(3)], T0);
    expect(res.outcome).toBe("accepted");
    expect(res.framesUsed).toBe(3);
    expect(res.agreement).toBe(1);
  });

  it("rejects a batch whose frames disagree", async () => {
    // Exactly the flip-flop the single-frame path used to report as a
    // confident answer.
    provider.reset([
      reading("male", 0.8),
      reading("female", 0.78),
      reading("male", 0.6),
      reading("female", 0.82),
    ]);
    const res = await svc.verify("u1", [frame(1), frame(2), frame(3), frame(4)], T0);
    expect(res.outcome).toBe("unstable");
    expect(res.gender).toBeNull();

    const wrote = update.mock.calls.some(
      (c) => "verifiedGender" in ((c[0] as { data: object }).data as object),
    );
    expect(wrote).toBe(false);
  });

  it("still accepts a single frame", async () => {
    provider.reset([reading("female", 0.96)]);
    const res = await svc.verify("u1", frame(9), T0);
    expect(res.outcome).toBe("accepted");
    expect(res.framesUsed).toBe(1);
  });

  it("skips unreadable frames and uses the rest", async () => {
    provider.reset([reading("male", 0.9), reading("male", 0.92)]);
    const res = await svc.verify("u1", [frame(1), "garbage", frame(2)], T0);
    expect(res.outcome).toBe("accepted");
    expect(res.framesUsed).toBe(2);
  });

  it("reports no_face when no frame contains one", async () => {
    provider.reset([reading("unknown", 0, 0)]);
    expect((await svc.verify("u1", [frame(1), frame(2)], T0)).outcome).toBe("no_face");
  });

  it("reports multiple_faces when most frames are crowded", async () => {
    provider.reset([
      reading("male", 0.9, 3),
      reading("male", 0.9, 2),
      reading("male", 0.9, 4),
    ]);
    expect((await svc.verify("u1", [frame(1), frame(2), frame(3)], T0)).outcome).toBe(
      "multiple_faces",
    );
  });

  it("charges one rate-limit token per batch, not per frame", async () => {
    // Otherwise clients would be pushed back to single-shot verification,
    // which is what produced the unstable results in the first place.
    const limited = new GenderService(provider, { ...DEFAULT_GENDER_CONFIG, maxAttempts: 2 });
    provider.reset([reading("male", 0.95)]);
    await limited.verify("u1", [frame(1), frame(2), frame(3), frame(4)], T0);
    await limited.verify("u1", [frame(5), frame(6)], T0);
    expect((await limited.verify("u1", [frame(7)], T0)).outcome).toBe("rate_limited");
  });

  it("caps how many frames it will process", async () => {
    provider.reset([reading("male", 0.95)]);
    const many = Array.from({ length: 30 }, (_, i) => frame(i));
    const res = await svc.verify("u1", many, T0);
    expect(res.framesUsed).toBeLessThanOrEqual(DEFAULT_GENDER_CONFIG.maxFrames);
  });

  describe("hysteresis", () => {
    beforeEach(() => {
      // Already stored as male at 0.90.
      findUnique.mockResolvedValue({
        id: "u1",
        gender: "male",
        verifiedGender: "male",
        genderConfidence: 0.9,
      });
    });

    it("refuses to flip on a marginally stronger reading", async () => {
      provider.reset([reading("female", 0.93), reading("female", 0.93)]);
      expect((await svc.verify("u1", [frame(1), frame(2)], T0)).outcome).toBe("unstable");
    });

    it("allows a flip when the new reading is clearly stronger", async () => {
      provider.reset([reading("female", 0.99), reading("female", 0.99)]);
      const res = await svc.verify("u1", [frame(1), frame(2)], T0);
      expect(res.outcome).toBe("accepted");
      expect(res.gender).toBe("female");
    });

    it("does not block re-confirming the same label", async () => {
      provider.reset([reading("male", 0.8), reading("male", 0.82)]);
      const res = await svc.verify("u1", [frame(1), frame(2)], T0);
      expect(res.outcome).toBe("accepted");
      expect(res.gender).toBe("male");
    });
  });
});
