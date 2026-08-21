import { describe, it, expect } from "vitest";
import { sniffImage, decodeImagePayload } from "../services/gender/provider";
import {
  normalizeBox,
  expandBox,
  boxArea,
  cropResizeToTensor,
  softmax,
  RgbaImage,
} from "../services/gender/imaging";
import {
  iou,
  nms,
  decodeUltraFace,
  filterByMinArea,
  primaryFace,
  Detection,
} from "../services/gender/postprocess";
import { fakeJpeg, fakePng, toDataUrl } from "./helpers";

describe("sniffImage", () => {
  it("recognises JPEG and PNG by magic bytes", () => {
    expect(sniffImage(fakeJpeg())).toBe("jpeg");
    expect(sniffImage(fakePng())).toBe("png");
  });

  it("rejects anything else, whatever the client claims", () => {
    expect(sniffImage(Buffer.from("GIF89a-and-then-some-padding"))).toBe("unknown");
    expect(sniffImage(Buffer.from("<?php echo 1; ?>...."))).toBe("unknown");
  });

  it("rejects a buffer too short to identify", () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8]))).toBe("unknown");
    expect(sniffImage(Buffer.alloc(0))).toBe("unknown");
  });
});

describe("decodeImagePayload", () => {
  const MAX = 1_000_000;

  it("decodes a bare base64 string", () => {
    const jpeg = fakeJpeg();
    const decoded = decodeImagePayload(jpeg.toString("base64"), MAX);
    expect(decoded).not.toBeNull();
    expect(sniffImage(decoded!)).toBe("jpeg");
  });

  it("decodes a data URL", () => {
    const decoded = decodeImagePayload(toDataUrl(fakeJpeg()), MAX);
    expect(decoded).not.toBeNull();
  });

  it("decodes a PNG data URL", () => {
    const decoded = decodeImagePayload(toDataUrl(fakePng(), "image/png"), MAX);
    expect(sniffImage(decoded!)).toBe("png");
  });

  it("rejects a data URL that is not base64-encoded", () => {
    expect(decodeImagePayload("data:image/svg+xml,<svg/>", MAX)).toBeNull();
  });

  it("rejects a data URL with no comma", () => {
    expect(decodeImagePayload("data:image/jpeg;base64", MAX)).toBeNull();
  });

  it("rejects non-strings and empties", () => {
    expect(decodeImagePayload(null, MAX)).toBeNull();
    expect(decodeImagePayload(123, MAX)).toBeNull();
    expect(decodeImagePayload("", MAX)).toBeNull();
    expect(decodeImagePayload({}, MAX)).toBeNull();
  });

  it("rejects a payload whose real type is not an image", () => {
    // Valid base64, but the bytes are an executable, not a JPEG.
    const evil = Buffer.from("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00");
    expect(decodeImagePayload(evil.toString("base64"), MAX)).toBeNull();
  });

  it("rejects an oversized image", () => {
    const big = Buffer.concat([fakeJpeg(), Buffer.alloc(5000)]);
    expect(decodeImagePayload(big.toString("base64"), 1000)).toBeNull();
  });

  it("refuses an over-long base64 string before allocating it", () => {
    // 10 MB of base64 against a 1 KB cap must not be decoded into memory.
    const huge = "A".repeat(10_000_000);
    expect(decodeImagePayload(huge, 1024)).toBeNull();
  });

  it("rejects malformed base64", () => {
    expect(decodeImagePayload("!!!!not base64!!!!", MAX)).toBeNull();
  });
});

describe("box maths", () => {
  it("normalizeBox clamps to the frame", () => {
    const b = normalizeBox({ x1: -0.5, y1: -1, x2: 1.5, y2: 2 });
    expect(b).toEqual({ x1: 0, y1: 0, x2: 1, y2: 1 });
  });

  it("normalizeBox repairs inverted corners", () => {
    const b = normalizeBox({ x1: 0.8, y1: 0.9, x2: 0.2, y2: 0.1 });
    expect(b.x1).toBeLessThan(b.x2);
    expect(b.y1).toBeLessThan(b.y2);
  });

  it("boxArea is zero for a degenerate box", () => {
    expect(boxArea({ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.9 })).toBe(0);
  });

  it("expandBox grows symmetrically", () => {
    const b = expandBox({ x1: 0.4, y1: 0.4, x2: 0.6, y2: 0.6 }, 0.5);
    expect(b.x1).toBeCloseTo(0.35, 5);
    expect(b.x2).toBeCloseTo(0.65, 5);
  });

  it("expandBox stays inside the frame at the edges", () => {
    const b = expandBox({ x1: 0, y1: 0, x2: 0.2, y2: 0.2 }, 2);
    expect(b.x1).toBe(0);
    expect(b.y1).toBe(0);
    expect(b.x2).toBeLessThanOrEqual(1);
  });
});

describe("cropResizeToTensor", () => {
  /** A 2x2 image: red, green / blue, white. */
  const img: RgbaImage = {
    width: 2,
    height: 2,
    data: new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255,
    ]),
  };

  const noNorm = [0, 0, 0] as const;
  const unit = [1, 1, 1] as const;

  it("produces a planar CHW tensor of the right size", () => {
    const t = cropResizeToTensor(img, { x1: 0, y1: 0, x2: 1, y2: 1 }, 4, noNorm, unit);
    expect(t.length).toBe(3 * 4 * 4);
  });

  it("samples the corner pixels exactly at the corners", () => {
    const t = cropResizeToTensor(img, { x1: 0, y1: 0, x2: 1, y2: 1 }, 2, noNorm, unit);
    const plane = 4;
    // Top-left is pure red.
    expect(t[0]).toBeCloseTo(1, 5);
    expect(t[plane]).toBeCloseTo(0, 5);
    expect(t[2 * plane]).toBeCloseTo(0, 5);
  });

  it("applies mean/std normalization", () => {
    const t = cropResizeToTensor(img, { x1: 0, y1: 0, x2: 1, y2: 1 }, 2, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    // Red channel of a pure-red pixel: (1 - 0.5) / 0.5 = 1
    expect(t[0]).toBeCloseTo(1, 5);
    // Green channel of that pixel: (0 - 0.5) / 0.5 = -1
    expect(t[4]).toBeCloseTo(-1, 5);
  });

  it("handles a 1x1 output without dividing by zero", () => {
    const t = cropResizeToTensor(img, { x1: 0, y1: 0, x2: 1, y2: 1 }, 1, noNorm, unit);
    expect(t.length).toBe(3);
    expect(Number.isFinite(t[0])).toBe(true);
  });

  it("handles a degenerate crop box without producing NaN", () => {
    const t = cropResizeToTensor(img, { x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 }, 2, noNorm, unit);
    for (const v of t) expect(Number.isFinite(v)).toBe(true);
  });

  it("never reads outside the source buffer", () => {
    const t = cropResizeToTensor(img, { x1: 0.99, y1: 0.99, x2: 1, y2: 1 }, 3, noNorm, unit);
    for (const v of t) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("softmax", () => {
  it("sums to one", () => {
    const p = softmax([1, 2, 3]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("preserves ordering", () => {
    const p = softmax([0.1, 5]);
    expect(p[1]).toBeGreaterThan(p[0]);
  });

  it("does not overflow on large logits", () => {
    const p = softmax([1000, 1001]);
    expect(p.every((v) => Number.isFinite(v))).toBe(true);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("is uniform for equal logits", () => {
    expect(softmax([2, 2])).toEqual([0.5, 0.5]);
  });

  it("returns empty for empty input", () => {
    expect(softmax([])).toEqual([]);
  });
});

describe("iou", () => {
  const a = { x1: 0, y1: 0, x2: 0.5, y2: 0.5 };

  it("is 1 for identical boxes", () => {
    expect(iou(a, a)).toBeCloseTo(1, 10);
  });

  it("is 0 for disjoint boxes", () => {
    expect(iou(a, { x1: 0.6, y1: 0.6, x2: 1, y2: 1 })).toBe(0);
  });

  it("is 0 for boxes that only touch at an edge", () => {
    expect(iou(a, { x1: 0.5, y1: 0, x2: 1, y2: 0.5 })).toBe(0);
  });

  it("computes partial overlap correctly", () => {
    // Half of "a" overlaps, union is 0.375.
    const b = { x1: 0.25, y1: 0, x2: 0.75, y2: 0.5 };
    expect(iou(a, b)).toBeCloseTo(0.125 / 0.375, 6);
  });

  it("is 0 when a box is degenerate", () => {
    expect(iou(a, { x1: 0.2, y1: 0.2, x2: 0.2, y2: 0.2 })).toBe(0);
  });
});

describe("nms", () => {
  const det = (score: number, x1: number, y1: number, size = 0.2): Detection => ({
    score,
    box: { x1, y1, x2: x1 + size, y2: y1 + size },
  });

  it("collapses duplicate detections of one face", () => {
    const kept = nms([det(0.9, 0.1, 0.1), det(0.8, 0.11, 0.11), det(0.7, 0.105, 0.105)], 0.3);
    expect(kept).toHaveLength(1);
    expect(kept[0].score).toBe(0.9);
  });

  it("keeps genuinely separate faces", () => {
    const kept = nms([det(0.9, 0.0, 0.0), det(0.8, 0.6, 0.6)], 0.3);
    expect(kept).toHaveLength(2);
  });

  it("returns highest score first", () => {
    const kept = nms([det(0.5, 0.0, 0.0), det(0.95, 0.6, 0.6)], 0.3);
    expect(kept[0].score).toBe(0.95);
  });

  it("handles an empty input", () => {
    expect(nms([], 0.3)).toEqual([]);
  });

  it("respects topK", () => {
    const many = Array.from({ length: 10 }, (_, i) => det(0.9 - i * 0.01, i * 0.09, 0));
    expect(nms(many, 0.3, 3)).toHaveLength(3);
  });

  it("does not mutate its input", () => {
    const input = [det(0.5, 0, 0), det(0.9, 0.6, 0.6)];
    const copy = [...input];
    nms(input, 0.3);
    expect(input).toEqual(copy);
  });
});

describe("decodeUltraFace", () => {
  it("keeps only detections above the score threshold", () => {
    // Two anchors: [bg, face] pairs.
    const scores = new Float32Array([0.9, 0.1, 0.2, 0.8]);
    const boxes = new Float32Array([0, 0, 0.1, 0.1, 0.2, 0.2, 0.5, 0.5]);
    const out = decodeUltraFace(scores, boxes, 0.5);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBeCloseTo(0.8, 6);
    expect(out[0].box.x1).toBeCloseTo(0.2, 6);
  });

  it("returns empty when nothing clears the threshold", () => {
    const scores = new Float32Array([0.9, 0.1]);
    const boxes = new Float32Array([0, 0, 0.5, 0.5]);
    expect(decodeUltraFace(scores, boxes, 0.7)).toEqual([]);
  });

  it("drops degenerate boxes even at a high score", () => {
    const scores = new Float32Array([0.01, 0.99]);
    const boxes = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    expect(decodeUltraFace(scores, boxes, 0.5)).toEqual([]);
  });

  it("clamps out-of-range coordinates", () => {
    const scores = new Float32Array([0.01, 0.99]);
    const boxes = new Float32Array([-0.5, -0.5, 1.4, 1.4]);
    const out = decodeUltraFace(scores, boxes, 0.5);
    expect(out[0].box).toEqual({ x1: 0, y1: 0, x2: 1, y2: 1 });
  });

  it("returns empty on truncated tensors rather than reading garbage", () => {
    expect(decodeUltraFace(new Float32Array([]), new Float32Array([]), 0.5)).toEqual([]);
    // Two anchors of scores but only one box worth of data.
    expect(
      decodeUltraFace(new Float32Array([0, 1, 0, 1]), new Float32Array([0, 0, 1, 1]), 0.5),
    ).toEqual([]);
  });
});

describe("filterByMinArea / primaryFace", () => {
  const big: Detection = { score: 0.9, box: { x1: 0.1, y1: 0.1, x2: 0.7, y2: 0.7 } };
  const tiny: Detection = { score: 0.95, box: { x1: 0.0, y1: 0.0, x2: 0.02, y2: 0.02 } };

  it("drops a face that is a negligible part of the frame", () => {
    expect(filterByMinArea([big, tiny], 0.01)).toEqual([big]);
  });

  it("keeps everything when the minimum is zero", () => {
    expect(filterByMinArea([big, tiny], 0)).toHaveLength(2);
  });

  it("primaryFace picks the largest, not the highest scoring", () => {
    expect(primaryFace([tiny, big])).toBe(big);
  });

  it("primaryFace returns null for an empty list", () => {
    expect(primaryFace([])).toBeNull();
  });
});
