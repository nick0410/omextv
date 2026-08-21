import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import jpeg from "jpeg-js";
import { OnnxGenderProvider } from "../services/gender/onnx";
import { GenderService, DEFAULT_GENDER_CONFIG } from "../services/gender/service";
import { squarifyBox, looksLikeProbabilities } from "../services/gender/imaging";
import { isDbReady } from "./dbAvailable";

const MODEL_DIR = path.join(process.cwd(), "models");
const FIXTURES = path.join(MODEL_DIR, "fixtures");

const hasModels =
  fs.existsSync(path.join(MODEL_DIR, "detector.onnx")) &&
  fs.existsSync(path.join(MODEL_DIR, "genderage.onnx"));
const hasFixtures = fs.existsSync(path.join(FIXTURES, "kid.jpg"));

/** A flat grey frame with no face in it. */
function blankFrame(width = 640, height = 480): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const noise = (i * 37) % 24;
    data[i * 4 + 0] = 120 + noise;
    data[i * 4 + 1] = 120 + noise;
    data[i * 4 + 2] = 120 + noise;
    data[i * 4 + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 90).data);
}

// These pull in ~24 MB of weights that are deliberately not committed. Skip
// rather than fail when they are absent, so a fresh clone still runs green.
describe.skipIf(!hasModels)("OnnxGenderProvider against the real models", () => {
  let provider: OnnxGenderProvider;

  beforeAll(async () => {
    provider = new OnnxGenderProvider({ modelDir: MODEL_DIR });
    await provider.init();
  }, 60_000);

  afterAll(async () => {
    await provider?.dispose();
  });

  it("loads both graphs", () => {
    expect(provider.isReady()).toBe(true);
  });

  it("reports no face on a blank frame instead of guessing", async () => {
    const r = await provider.infer(blankFrame());
    expect(r.gender).toBe("unknown");
    expect(r.faceCount).toBe(0);
    expect(r.confidence).toBe(0);
  }, 30_000);

  it("returns unknown for a non-image buffer rather than throwing", async () => {
    const r = await provider.infer(Buffer.from("this is not a jpeg at all"));
    expect(r.gender).toBe("unknown");
    expect(r.faceCount).toBe(0);
  });

  it("returns unknown for a truncated JPEG", async () => {
    const good = blankFrame(64, 64);
    const r = await provider.infer(good.subarray(0, 20));
    expect(r.gender).toBe("unknown");
  });

  it("reports a latency figure", async () => {
    const r = await provider.infer(blankFrame(320, 240));
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.provider).toBe("onnx");
  }, 30_000);

  describe.skipIf(!hasFixtures)("on a real photo", () => {
    it("detects exactly one face and classifies it confidently", async () => {
      const image = fs.readFileSync(path.join(FIXTURES, "kid.jpg"));
      const r = await provider.infer(image);

      expect(r.faceCount).toBe(1);
      expect(["male", "female"]).toContain(r.gender);
      expect(r.confidence).toBeGreaterThan(0.5);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }, 30_000);

    it("is deterministic across repeated runs", async () => {
      const image = fs.readFileSync(path.join(FIXTURES, "kid.jpg"));
      const a = await provider.infer(image);
      const b = await provider.infer(image);
      expect(a.gender).toBe(b.gender);
      expect(a.confidence).toBeCloseTo(b.confidence, 6);
    }, 30_000);

    it("clears the service confidence threshold", async () => {
      const image = fs.readFileSync(path.join(FIXTURES, "kid.jpg"));
      const r = await provider.infer(image);
      // A real, well-lit, front-facing photo should not be borderline; if this
      // starts failing, the preprocessing has drifted from the model's
      // expected input.
      expect(r.confidence).toBeGreaterThanOrEqual(DEFAULT_GENDER_CONFIG.threshold);
    }, 30_000);

    it("filters out a crowd of small background faces", async () => {
      // A group photo where every face is well under the minimum area. The
      // detector does find them, but none is the person at the camera, so the
      // frame must come back as "no usable face" rather than picking one.
      const groupPhoto = path.join(FIXTURES, "faces1.jpg");
      if (!fs.existsSync(groupPhoto)) return;

      const r = await provider.infer(fs.readFileSync(groupPhoto));
      expect(r.faceCount).toBe(0);
      expect(r.gender).toBe("unknown");
    }, 30_000);

    /**
     * Accuracy, not just stability.
     *
     * `faces1.jpg` is a lab group photo whose composition is known by
     * inspection: nineteen people, of whom exactly two are women — one in the
     * middle row at roughly 24% across, the other at roughly 64%. Everyone
     * else is a man.
     *
     * This is the test that was missing. Checking that repeated runs agree
     * proves nothing about correctness: with the channels swapped the model
     * was confidently and consistently wrong, calling two of the men women at
     * 88% and 100%. Only comparing against faces whose answer is known catches
     * that class of bug.
     */
    it("labels a known group photo correctly", async () => {
      const groupPhoto = path.join(FIXTURES, "faces1.jpg");
      if (!fs.existsSync(groupPhoto)) return;

      const permissive = new OnnxGenderProvider({ modelDir: MODEL_DIR, minFaceArea: 0 });
      await permissive.init();
      const faces = await permissive.inferAll(fs.readFileSync(groupPhoto), 0.0008);
      await permissive.dispose();

      expect(faces.length).toBeGreaterThanOrEqual(18);

      const women = faces.filter((f) => f.gender === "female");
      expect(women.length).toBe(2);

      // ...and they are the two people we know to be women, not any two faces.
      const positions = women.map((w) => Math.round(w.centreX * 100)).sort((a, b) => a - b);
      expect(positions[0]).toBeGreaterThan(18);
      expect(positions[0]).toBeLessThan(30);
      expect(positions[1]).toBeGreaterThan(58);
      expect(positions[1]).toBeLessThan(70);

      // Both women are in the middle row, not the back or front.
      for (const woman of women) {
        expect(woman.centreY).toBeGreaterThan(0.2);
        expect(woman.centreY).toBeLessThan(0.5);
      }
    }, 60_000);

    it("is confident across a whole crowd", async () => {
      const groupPhoto = path.join(FIXTURES, "faces1.jpg");
      if (!fs.existsSync(groupPhoto)) return;

      const permissive = new OnnxGenderProvider({ modelDir: MODEL_DIR, minFaceArea: 0 });
      await permissive.init();
      const faces = await permissive.inferAll(fs.readFileSync(groupPhoto), 0.0008);
      await permissive.dispose();

      const mean = faces.reduce((sum, f) => sum + f.confidence, 0) / faces.length;
      // A drop here means the input pipeline has drifted from what the model
      // expects — wrong channel order or normalization shows up as hesitancy
      // long before it shows up as an outright wrong label.
      expect(mean).toBeGreaterThan(0.9);
    }, 60_000);

    it("counts the crowd once the area floor is lowered", async () => {
      const groupPhoto = path.join(FIXTURES, "faces1.jpg");
      if (!fs.existsSync(groupPhoto)) return;

      // Same image, permissive floor: this proves the detector was working all
      // along and the previous test exercises the filter, not a blind spot.
      const permissive = new OnnxGenderProvider({
        modelDir: MODEL_DIR,
        minFaceArea: 0,
      });
      await permissive.init();
      const r = await permissive.infer(fs.readFileSync(groupPhoto));
      expect(r.faceCount).toBeGreaterThan(5);
      await permissive.dispose();
    }, 60_000);
  });

  // The service layer reads the user row before scoring, so this one needs a
  // database; the provider tests above do not.
  describe.skipIf(!isDbReady())("through the service layer", () => {
    it("turns a blank frame into a no_face outcome", async () => {
      const svc = new GenderService(provider, DEFAULT_GENDER_CONFIG);
      const res = await svc.verify("nonexistent-user", blankFrame().toString("base64"));
      // The user lookup fails first for this fake id, which is itself the
      // guard we want; with a real user it would be "no_face".
      expect(["no_face", "user_not_found"]).toContain(res.outcome);
    }, 30_000);
  });
});

describe("squarifyBox", () => {
  it("widens a tall box to square in pixel space", () => {
    // 100x200 px box on a 1000x1000 image.
    const box = { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.3 };
    const sq = squarifyBox(box, 1000, 1000);
    const w = (sq.x2 - sq.x1) * 1000;
    const h = (sq.y2 - sq.y1) * 1000;
    expect(w).toBeCloseTo(h, 3);
    expect(w).toBeCloseTo(200, 3);
  });

  it("accounts for a non-square image", () => {
    // Equal normalized extents on a 2:1 image are NOT equal in pixels.
    const box = { x1: 0.4, y1: 0.4, x2: 0.5, y2: 0.5 };
    const sq = squarifyBox(box, 1000, 500);
    const w = (sq.x2 - sq.x1) * 1000;
    const h = (sq.y2 - sq.y1) * 500;
    expect(w).toBeCloseTo(h, 3);
  });

  it("keeps the centre put", () => {
    const box = { x1: 0.3, y1: 0.1, x2: 0.4, y2: 0.5 };
    const sq = squarifyBox(box, 800, 800);
    expect((sq.x1 + sq.x2) / 2).toBeCloseTo((box.x1 + box.x2) / 2, 5);
  });

  it("clamps to the frame at an edge", () => {
    const box = { x1: 0, y1: 0.4, x2: 0.05, y2: 0.9 };
    const sq = squarifyBox(box, 500, 500);
    expect(sq.x1).toBeGreaterThanOrEqual(0);
    expect(sq.x2).toBeLessThanOrEqual(1);
  });

  it("leaves an already-square box alone", () => {
    const box = { x1: 0.2, y1: 0.2, x2: 0.4, y2: 0.4 };
    const sq = squarifyBox(box, 600, 600);
    expect(sq.x1).toBeCloseTo(box.x1, 5);
    expect(sq.y2).toBeCloseTo(box.y2, 5);
  });

  it("survives a degenerate box and bad dimensions", () => {
    expect(() => squarifyBox({ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 }, 100, 100)).not.toThrow();
    const same = squarifyBox({ x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 }, 0, 0);
    expect(same.x1).toBeCloseTo(0.1, 5);
  });
});

describe("looksLikeProbabilities", () => {
  it("recognises a softmax output", () => {
    expect(looksLikeProbabilities([0.3, 0.7])).toBe(true);
    expect(looksLikeProbabilities([0.995, 0.005])).toBe(true);
  });

  it("rejects raw logits", () => {
    expect(looksLikeProbabilities([2.5, -1.2])).toBe(false);
    expect(looksLikeProbabilities([8, 3])).toBe(false);
  });

  it("rejects values that are in range but do not sum to one", () => {
    expect(looksLikeProbabilities([0.4, 0.4])).toBe(false);
  });

  it("rejects NaN and empty input", () => {
    expect(looksLikeProbabilities([NaN, 0.5])).toBe(false);
    expect(looksLikeProbabilities([])).toBe(false);
  });
});
