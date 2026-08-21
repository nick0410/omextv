import path from "path";
import fs from "fs";
import type * as Ort from "onnxruntime-node";
import { GenderProvider, GenderInference, GenderProviderError } from "./provider";
import {
  decodeImage,
  cropResizeToTensor,
  expandBox,
  squarifyBox,
  boxArea,
  softmax,
  looksLikeProbabilities,
} from "./imaging";
import { decodeUltraFace, nms, filterByMinArea, primaryFace } from "./postprocess";
import { InferredGender } from "../../types";

export interface OnnxProviderOptions {
  /** Directory holding detector.onnx and gender.onnx. */
  modelDir: string;
  detectorFile?: string;
  classifierFile?: string;
  /** Which classifier architecture the file is. Drives all preprocessing. */
  classifierKind?: ClassifierKind;
  /** UltraFace default input geometry. */
  detectorWidth?: number;
  detectorHeight?: number;
  scoreThreshold?: number;
  iouThreshold?: number;
  /** Faces smaller than this share of the frame are ignored. */
  minFaceArea?: number;
  /** How much to pad the detector box before classifying. */
  cropPadding?: number;
  /** Index 0 of the classifier output. Some models are [female, male]. */
  classOrder?: readonly ["male", "female"] | readonly ["female", "male"];
}

const DEFAULTS = {
  detectorFile: "detector.onnx",
  classifierFile: "genderage.onnx",
  classifierKind: "insightface" as ClassifierKind,
  detectorWidth: 320,
  detectorHeight: 240,
  scoreThreshold: 0.7,
  iouThreshold: 0.35,
  minFaceArea: 0.01,
};

/**
 * Everything that differs between classifier architectures.
 *
 * `cropResizeToTensor` computes `(v/255 - mean) / std`, so `mean = m/255` with
 * `std = 1/255` yields `v - m`, and `mean = 0` with `std = 1/255` yields raw
 * 0-255 values.
 */
interface ClassifierSpec {
  size: number;
  /** Channel order the graph was trained on. */
  bgr: boolean;
  mean: readonly [number, number, number];
  std: readonly [number, number, number];
  /** How much to grow the squared face box before cropping. */
  padding: number;
  /** What index 0 of the gender head means. */
  classOrder: readonly ["male", "female"] | readonly ["female", "male"];
  /** True when the graph already ends in a softmax. */
  preSoftmaxed: boolean;
}

export const CLASSIFIER_SPECS = {
  /**
   * InsightFace `genderage` (buffalo_l). RGB, raw 0-255, 96x96, and the box
   * scaled to 1.5x the longer side — that is what `_scale` works out to in the
   * reference implementation.
   *
   * The default, and by a wide margin the better of the two: on the bundled
   * 19-person group photo it labels every face correctly, including the two
   * that GoogLeNet confidently got wrong.
   */
  insightface: {
    size: 96,
    bgr: false,
    mean: [0, 0, 0],
    std: [1 / 255, 1 / 255, 1 / 255],
    padding: 0.5,
    classOrder: ["female", "male"],
    preSoftmaxed: false,
  },

  /**
   * Caffe-converted GoogLeNet (Levi & Hassner, Adience, 2015). BGR, mean
   * [104,117,123] subtracted from raw pixels, 224x224.
   *
   * Kept as an option, not recommended. Its published accuracy is around 86%
   * and that is what it delivers: 17 of 19 on the group photo, with two men
   * labelled women confidently enough to clear the threshold. Note also that
   * the model card says BGR while the repository's own reference script uses
   * RGB — the card is right, and following the script silently degrades it
   * further.
   */
  googlenet: {
    size: 224,
    bgr: true,
    mean: [104 / 255, 117 / 255, 123 / 255],
    std: [1 / 255, 1 / 255, 1 / 255],
    padding: 0,
    classOrder: ["male", "female"],
    preSoftmaxed: true,
  },
} as const satisfies Record<string, ClassifierSpec>;

export type ClassifierKind = keyof typeof CLASSIFIER_SPECS;

/**
 * Two-stage local inference: UltraFace finds the faces, a small classifier
 * labels the largest one.
 *
 * Runs on onnxruntime-node, which ships prebuilt binaries — unlike
 * @tensorflow/tfjs-node, it needs no C++ toolchain to install.
 *
 * Model weights are NOT bundled. Point GENDER_MODEL_DIR at a directory holding
 * detector.onnx and gender.onnx; without them init() throws and the service
 * falls back to the mock provider with a loud log line.
 */
export class OnnxGenderProvider implements GenderProvider {
  readonly name = "onnx";

  private ort: typeof Ort | null = null;
  private detector: Ort.InferenceSession | null = null;
  private classifier: Ort.InferenceSession | null = null;
  private opts: OnnxProviderOptions & typeof DEFAULTS;
  private ready = false;
  private initPromise: Promise<void> | null = null;

  constructor(options: OnnxProviderOptions) {
    // Drop undefined overrides so they do not clobber the defaults.
    const clean = Object.fromEntries(
      Object.entries(options).filter(([, v]) => v !== undefined),
    );
    this.opts = { ...DEFAULTS, ...clean } as OnnxProviderOptions & typeof DEFAULTS;
  }

  private get spec() {
    return CLASSIFIER_SPECS[this.opts.classifierKind];
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Idempotent, and concurrent callers share one load. */
  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInit(): Promise<void> {
    const detectorPath = path.join(this.opts.modelDir, this.opts.detectorFile);
    const classifierPath = path.join(this.opts.modelDir, this.opts.classifierFile);

    for (const p of [detectorPath, classifierPath]) {
      if (!fs.existsSync(p)) {
        throw new GenderProviderError(
          `ONNX model missing: ${p}. Set GENDER_MODEL_DIR or run scripts/fetch-models.`,
        );
      }
    }

    try {
      this.ort = await import("onnxruntime-node");
    } catch (err) {
      throw new GenderProviderError("onnxruntime-node failed to load", err);
    }

    // These graphs carry their weights as named inputs, which makes onnxruntime
    // emit hundreds of "initializer appears in graph inputs" warnings on load.
    // They are cosmetic; silence them rather than drowning the boot log.
    const options = { logSeverityLevel: 3 as const };

    this.detector = await this.ort.InferenceSession.create(detectorPath, options);
    this.classifier = await this.ort.InferenceSession.create(classifierPath, options);
    this.ready = true;
  }

  /**
   * Classify one already-located face.
   *
   * Split out from `infer` so the accuracy regression test can label every
   * face in a group photo, not just the largest. A stability check is not
   * enough on its own — wrong preprocessing is confidently stable, and only
   * comparing against known faces catches it.
   */
  private async classifyFace(
    img: { width: number; height: number; data: Uint8Array },
    box: Parameters<typeof squarifyBox>[0],
  ): Promise<{ gender: InferredGender; confidence: number; age?: number }> {
    if (!this.ort || !this.classifier) return { gender: "unknown", confidence: 0 };

    const spec = this.spec;
    const padding = this.opts.cropPadding ?? spec.padding;

    const squared = squarifyBox(box, img.width, img.height);
    const cropBox = padding > 0 ? expandBox(squared, padding) : squared;

    const crop = cropResizeToTensor(
      img,
      cropBox,
      spec.size,
      spec.mean,
      spec.std,
      spec.bgr,
    );

    const out = await this.classifier.run({
      [this.classifier.inputNames[0]]: new this.ort.Tensor("float32", crop, [
        1,
        3,
        spec.size,
        spec.size,
      ]),
    });

    const tensor = out[this.classifier.outputNames[0]];
    if (!tensor) return { gender: "unknown", confidence: 0 };

    const all = Array.from(tensor.data as Float32Array);
    const raw = all.slice(0, 2);
    if (raw.length < 2) return { gender: "unknown", confidence: 0 };

    // InsightFace's genderage head emits [femaleLogit, maleLogit, age/100].
    // The age is free here and worth keeping: an adult-only chat wants some
    // signal when the person on camera looks like a child.
    const age = all.length >= 3 ? Math.round(all[2] * 100) : undefined;

    // Some graphs end in a softmax already; normalizing those a second time
    // would shrink the margin the confidence threshold is applied to.
    const probs =
      spec.preSoftmaxed && looksLikeProbabilities(raw) ? raw : softmax(raw);
    const idx = probs[0] >= probs[1] ? 0 : 1;
    const order = this.opts.classOrder ?? spec.classOrder;

    return {
      gender: order[idx] as InferredGender,
      confidence: Number(probs[idx].toFixed(4)),
      age,
    };
  }

  /**
   * Detect and classify every face in the frame.
   *
   * `minArea` overrides the configured floor, so callers that genuinely want
   * small background faces (the accuracy test, moderation tooling) can ask for
   * them without changing the provider's own behaviour.
   */
  async inferAll(
    image: Buffer,
    minArea = this.opts.minFaceArea,
  ): Promise<
    {
      gender: InferredGender;
      confidence: number;
      age?: number;
      centreX: number;
      centreY: number;
    }[]
  > {
    if (!this.ready || !this.ort || !this.detector || !this.classifier) return [];

    const img = decodeImage(image);
    if (!img) return [];

    const detections = await this.detect(img, minArea);
    const out = [];
    for (const detection of detections) {
      const { gender, confidence, age } = await this.classifyFace(img, detection.box);
      out.push({
        gender,
        confidence,
        age,
        centreX: (detection.box.x1 + detection.box.x2) / 2,
        centreY: (detection.box.y1 + detection.box.y2) / 2,
      });
    }
    return out;
  }

  /** Stage one: locate faces, deduplicate, drop anything too small. */
  private async detect(
    img: { width: number; height: number; data: Uint8Array },
    minArea: number,
  ) {
    if (!this.ort || !this.detector) return [];

    const detTensor = new this.ort.Tensor(
      "float32",
      this.letterboxToDetector(img),
      [1, 3, this.opts.detectorHeight, this.opts.detectorWidth],
    );

    const detOut = await this.detector.run({
      [this.detector.inputNames[0]]: detTensor,
    });

    // UltraFace emits scores then boxes; identify by trailing dimension.
    let scores: Float32Array | null = null;
    let boxes: Float32Array | null = null;
    for (const name of this.detector.outputNames) {
      const t = detOut[name];
      if (!t) continue;
      const last = t.dims[t.dims.length - 1];
      if (last === 2) scores = t.data as Float32Array;
      else if (last === 4) boxes = t.data as Float32Array;
    }
    if (!scores || !boxes) return [];

    let detections = decodeUltraFace(scores, boxes, this.opts.scoreThreshold);
    detections = nms(detections, this.opts.iouThreshold);
    return filterByMinArea(detections, minArea);
  }

  async infer(image: Buffer): Promise<GenderInference> {
    const started = Date.now();
    const miss = (): GenderInference => ({
      gender: "unknown",
      confidence: 0,
      faceCount: 0,
      provider: this.name,
      latencyMs: Date.now() - started,
    });

    if (!this.ready || !this.ort || !this.detector || !this.classifier) return miss();

    const img = decodeImage(image);
    if (!img) return miss();

    const detections = await this.detect(img, this.opts.minFaceArea);
    if (detections.length === 0) return miss();

    // The largest face is the person actually sitting at the camera.
    const face = primaryFace(detections);
    if (!face || boxArea(face.box) <= 0) return miss();

    const { gender, confidence, age } = await this.classifyFace(img, face.box);
    if (gender === "unknown") return miss();

    return {
      gender,
      confidence,
      age,
      faceCount: detections.length,
      provider: this.name,
      latencyMs: Date.now() - started,
    };
  }

  /**
   * The detector wants a fixed non-square 320x240. Rather than distort the
   * frame (which skews face geometry and costs accuracy) we sample the source
   * directly into that rectangle.
   */
  private letterboxToDetector(img: {
    width: number;
    height: number;
    data: Uint8Array;
  }): Float32Array {
    const { detectorWidth: W, detectorHeight: H } = this.opts;
    const out = new Float32Array(3 * W * H);
    const plane = W * H;

    for (let y = 0; y < H; y++) {
      const srcY = (y / (H - 1)) * (img.height - 1);
      const y0 = Math.floor(srcY);
      const y1 = Math.min(y0 + 1, img.height - 1);
      const wy = srcY - y0;

      for (let x = 0; x < W; x++) {
        const srcX = (x / (W - 1)) * (img.width - 1);
        const x0 = Math.floor(srcX);
        const x1 = Math.min(x0 + 1, img.width - 1);
        const wx = srcX - x0;

        const i00 = (y0 * img.width + x0) * 4;
        const i01 = (y0 * img.width + x1) * 4;
        const i10 = (y1 * img.width + x0) * 4;
        const i11 = (y1 * img.width + x1) * 4;

        const dst = y * W + x;
        for (let c = 0; c < 3; c++) {
          const v =
            img.data[i00 + c] * (1 - wx) * (1 - wy) +
            img.data[i01 + c] * wx * (1 - wy) +
            img.data[i10 + c] * (1 - wx) * wy +
            img.data[i11 + c] * wx * wy;
          out[c * plane + dst] = (v - 127) / 128;
        }
      }
    }
    return out;
  }

  async dispose(): Promise<void> {
    await this.detector?.release?.();
    await this.classifier?.release?.();
    this.detector = null;
    this.classifier = null;
    this.ready = false;
  }
}
