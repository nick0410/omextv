import { prisma } from "../../config/database";
import { env } from "../../config/env";
import { RateLimiter } from "../../utils/rateLimiter";
import { Gender, InferredGender } from "../../types";
import {
  GenderProvider,
  GenderInference,
  decodeImagePayload,
} from "./provider";
import { MockGenderProvider } from "./mock";

/**
 * Automated gender inference from a live camera frame.
 *
 * A deliberate caveat, because it shapes every rule below: a vision model
 * cannot actually observe gender, only appearance. It misreads trans and
 * non-binary people by construction, and accuracy drops with lighting, angle,
 * skin tone and age. So the model is treated as a *signal*, never as truth:
 *  - it can only ever output male/female/unknown — never "other";
 *  - a reading below the confidence threshold is discarded entirely;
 *  - a user whose self-declared gender is "other" is never overwritten;
 *  - a disagreement is recorded as a flag for moderation, not auto-enforced.
 * Self-declared gender remains the fallback whenever verification is missing,
 * stale, or low-confidence.
 */

export type VerificationOutcome =
  | "accepted"
  | "low_confidence"
  | "unstable"
  | "no_face"
  | "multiple_faces"
  | "rate_limited"
  | "invalid_image"
  | "provider_unavailable"
  | "user_not_found";

export interface VerificationResult {
  outcome: VerificationOutcome;
  gender: InferredGender | null;
  confidence: number;
  /** Set when the model disagrees with the self-declared value at high confidence. */
  mismatch: boolean;
  /** Only present on rate_limited. */
  retryAfterMs?: number;
  inference?: GenderInference;
  /** How many of the submitted frames produced a usable reading. */
  framesUsed?: number;
  /** Fraction of usable frames that agreed with the winning label, 0..1. */
  agreement?: number;
}

/**
 * Aggregate several single-frame readings into one verdict.
 *
 * A single webcam frame is a noisy sample. Blink, turn slightly, or let a
 * shadow fall across half your face and an adult sitting near the model's
 * decision boundary flips between male and female between one frame and the
 * next. Classifying one still and treating it as final is what makes the
 * result look random to the user.
 *
 * Probabilities are averaged rather than votes counted, so a run of hesitant
 * 0.51 readings cannot outvote a couple of confident 0.97 ones. `agreement`
 * is then reported separately: a high mean confidence built out of frames that
 * disagreed is exactly the unstable case we want to reject rather than round
 * off into a confident-looking answer.
 */
export function aggregateReadings(readings: GenderInference[]): {
  gender: InferredGender;
  confidence: number;
  agreement: number;
  framesUsed: number;
} {
  const usable = readings.filter((r) => r.faceCount === 1 && r.gender !== "unknown");
  if (usable.length === 0) {
    return { gender: "unknown", confidence: 0, agreement: 0, framesUsed: 0 };
  }

  let maleSum = 0;
  let femaleSum = 0;
  for (const reading of usable) {
    // Each reading gives the winner's probability; the other side is 1 - that.
    if (reading.gender === "male") {
      maleSum += reading.confidence;
      femaleSum += 1 - reading.confidence;
    } else {
      femaleSum += reading.confidence;
      maleSum += 1 - reading.confidence;
    }
  }

  const meanMale = maleSum / usable.length;
  const meanFemale = femaleSum / usable.length;
  const gender: InferredGender = meanMale >= meanFemale ? "male" : "female";
  const confidence = Math.max(meanMale, meanFemale);

  const agreeing = usable.filter((r) => r.gender === gender).length;

  return {
    gender,
    confidence: Number(confidence.toFixed(4)),
    agreement: Number((agreeing / usable.length).toFixed(4)),
    framesUsed: usable.length,
  };
}

export interface GenderServiceConfig {
  /** Minimum confidence to accept a reading. */
  threshold: number;
  /** Frames accepted in one batch. More frames, steadier verdict. */
  maxFrames: number;
  /** Fraction of usable frames that must agree before a verdict is accepted. */
  minAgreement: number;
  /**
   * A stored verdict is only overturned by a clearly stronger one. Without
   * this, two verifications either side of the threshold flip the user's
   * label back and forth and everyone's filters see them change.
   */
  flipMargin: number;
  /**
   * Ceiling on what a flip may be asked to beat.
   *
   * Without it the margin makes a correction impossible at the top of the
   * range: a stored 0.92 would demand 1.02, which no softmax can produce, so a
   * user the model misread once could never fix it. Capping the requirement
   * keeps hysteresis a speed bump rather than a one-way door.
   */
  flipCeiling: number;
  /** A verification older than this no longer counts as fresh. */
  freshnessMs: number;
  /** Max verification attempts per user per window. */
  maxAttempts: number;
  /** Token refill rate, attempts/sec. */
  refillPerSec: number;
  /** Hard cap on decoded image size. */
  maxImageBytes: number;
}

export const DEFAULT_GENDER_CONFIG: GenderServiceConfig = {
  threshold: 0.75,
  maxFrames: 7,
  minAgreement: 0.7,
  flipMargin: 0.1,
  flipCeiling: 0.95,
  freshnessMs: 24 * 60 * 60_000,
  maxAttempts: 10,
  refillPerSec: 10 / 300, // 10 per 5 minutes
  maxImageBytes: 2 * 1024 * 1024,
};

export class GenderService {
  private limiter: RateLimiter;
  /** Epoch ms of the last failed lazy init, to throttle retries. */
  private lastInitFailure = 0;
  private static readonly INIT_RETRY_MS = 30_000;

  constructor(
    private provider: GenderProvider,
    private config: GenderServiceConfig = DEFAULT_GENDER_CONFIG,
  ) {
    this.limiter = new RateLimiter(config.maxAttempts, config.refillPerSec);
  }

  /**
   * Bring the provider up if it is not already.
   *
   * The provider is normally initialised at boot, but a model load can fail
   * transiently (a cold mount, a slow disk) and permanently disabling
   * verification because of one bad moment is the wrong trade. Retries are
   * throttled so a genuinely broken provider is not re-attempted on every
   * single request.
   */
  private async ensureReady(now: number): Promise<boolean> {
    if (this.provider.isReady()) return true;
    if (now - this.lastInitFailure < GenderService.INIT_RETRY_MS) return false;

    try {
      await this.provider.init();
      return this.provider.isReady();
    } catch (err) {
      this.lastInitFailure = now;
      console.error(`[gender] provider "${this.provider.name}" init failed:`, err);
      return false;
    }
  }

  getProviderName(): string {
    return this.provider.name;
  }

  async init(): Promise<void> {
    await this.provider.init();
  }

  isReady(): boolean {
    return this.provider.isReady();
  }

  /** Swap the provider at runtime — used by tests and by the fallback path. */
  setProvider(provider: GenderProvider): void {
    this.provider = provider;
    // The retry throttle belongs to the old provider, not this one.
    this.lastInitFailure = 0;
  }

  resetLimits(): void {
    this.limiter.clear();
  }

  /**
   * Run inference on a client-supplied frame and persist the verdict.
   *
   * The frame is of the *caller's own* camera, not their partner's: video is
   * peer-to-peer so the server never sees the remote stream, and asking a peer
   * to classify the person they are talking to would let anyone forge a label
   * for someone else.
   */
  async verify(
    userId: string,
    payload: unknown,
    now: number = Date.now(),
  ): Promise<VerificationResult> {
    const limit = this.limiter.consume(`gender:${userId}`, now);
    if (!limit.allowed) {
      return {
        outcome: "rate_limited",
        gender: null,
        confidence: 0,
        mismatch: false,
        retryAfterMs: limit.retryAfterMs,
      };
    }

    // One frame or many — a batch costs a single rate-limit token, because
    // charging per frame would push clients back to the noisy single-shot
    // behaviour this is meant to replace.
    const raw = Array.isArray(payload) ? payload : [payload];
    const images: Buffer[] = [];
    for (const item of raw.slice(0, this.config.maxFrames)) {
      const decoded = decodeImagePayload(item, this.config.maxImageBytes);
      if (decoded) images.push(decoded);
    }

    if (images.length === 0) {
      return { outcome: "invalid_image", gender: null, confidence: 0, mismatch: false };
    }

    if (!(await this.ensureReady(now))) {
      return { outcome: "provider_unavailable", gender: null, confidence: 0, mismatch: false };
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        gender: true,
        verifiedGender: true,
        genderConfidence: true,
      },
    });
    if (!user) {
      return { outcome: "user_not_found", gender: null, confidence: 0, mismatch: false };
    }

    const readings: GenderInference[] = [];
    for (const image of images) {
      try {
        readings.push(await this.provider.infer(image));
      } catch {
        // One bad frame should not sink the batch.
      }
    }

    if (readings.length === 0) {
      return { outcome: "provider_unavailable", gender: null, confidence: 0, mismatch: false };
    }

    // Every attempt counts toward the abuse signal, accepted or not.
    await prisma.user.update({
      where: { id: userId },
      data: { genderAttempts: { increment: 1 } },
    });

    // A frame with several faces cannot be attributed to this user. If that is
    // what most frames look like, say so rather than quietly using the rest.
    const crowded = readings.filter((r) => r.faceCount > 1).length;
    if (crowded > readings.length / 2) {
      return {
        outcome: "multiple_faces",
        gender: null,
        confidence: 0,
        mismatch: false,
        framesUsed: 0,
      };
    }

    const agg = aggregateReadings(readings);

    if (agg.framesUsed === 0 || agg.gender === "unknown") {
      return {
        outcome: "no_face",
        gender: null,
        confidence: 0,
        mismatch: false,
        framesUsed: 0,
      };
    }

    // Frames disagreed with each other — the honest answer is "we don't know",
    // not whichever side happened to win by a hair.
    if (agg.agreement < this.config.minAgreement) {
      return {
        outcome: "unstable",
        gender: null,
        confidence: agg.confidence,
        mismatch: false,
        framesUsed: agg.framesUsed,
        agreement: agg.agreement,
      };
    }

    if (agg.confidence < this.config.threshold) {
      return {
        outcome: "low_confidence",
        gender: agg.gender,
        confidence: agg.confidence,
        mismatch: false,
        framesUsed: agg.framesUsed,
        agreement: agg.agreement,
      };
    }

    // Hysteresis: overturning an existing verdict takes a clearly stronger
    // reading, so a user's label does not oscillate between sessions.
    const previous = user.verifiedGender as InferredGender | null;
    const previousConfidence = user.genderConfidence ?? 0;
    const wouldFlip =
      previous === "male" || previous === "female"
        ? previous !== agg.gender
        : false;

    const flipBar = Math.min(
      previousConfidence + this.config.flipMargin,
      this.config.flipCeiling,
    );
    if (wouldFlip && agg.confidence < flipBar) {
      return {
        outcome: "unstable",
        gender: null,
        confidence: agg.confidence,
        mismatch: false,
        framesUsed: agg.framesUsed,
        agreement: agg.agreement,
      };
    }

    // A self-declared "other" is never contradicted by the model.
    const declared = user.gender as Gender;
    const mismatch = declared !== "other" && declared !== agg.gender;

    await prisma.user.update({
      where: { id: userId },
      data: {
        verifiedGender: agg.gender,
        genderConfidence: agg.confidence,
        genderVerifiedAt: new Date(now),
        genderMismatch: mismatch,
      },
    });

    return {
      outcome: "accepted",
      gender: agg.gender,
      confidence: agg.confidence,
      mismatch,
      framesUsed: agg.framesUsed,
      agreement: agg.agreement,
    };
  }

  /** Is a stored verification still within the freshness window? */
  isFresh(verifiedAt: Date | null | undefined, now: number = Date.now()): boolean {
    if (!verifiedAt) return false;
    return now - verifiedAt.getTime() <= this.config.freshnessMs;
  }

  /**
   * The gender other users' filters are tested against.
   *
   * Prefers a fresh, confident model reading; otherwise falls back to what the
   * user declared. A declared "other" always wins, because the model has no
   * way to represent it and silently reclassifying such a user would be wrong.
   */
  resolveEffectiveGender(
    user: {
      gender: string;
      verifiedGender?: string | null;
      genderConfidence?: number | null;
      genderVerifiedAt?: Date | null;
    },
    now: number = Date.now(),
  ): { effectiveGender: Gender; verified: boolean } {
    const declared = user.gender as Gender;

    if (declared === "other") return { effectiveGender: "other", verified: false };

    const fresh = this.isFresh(user.genderVerifiedAt, now);
    const confident = (user.genderConfidence ?? 0) >= this.config.threshold;
    const usable =
      fresh && confident && (user.verifiedGender === "male" || user.verifiedGender === "female");

    if (usable) {
      return { effectiveGender: user.verifiedGender as Gender, verified: true };
    }
    return { effectiveGender: declared, verified: false };
  }

  async dispose(): Promise<void> {
    await this.provider.dispose();
  }
}

/**
 * Build the provider named by GENDER_PROVIDER, falling back to the mock if the
 * real one cannot load. The fallback is loud on purpose — silently degrading
 * to a hash-based guess in production would be far worse than a log line.
 */
export async function createGenderProvider(): Promise<GenderProvider> {
  const requested = env.GENDER_PROVIDER;

  if (requested === "mock") {
    const mock = new MockGenderProvider();
    await mock.init();
    return mock;
  }

  try {
    if (requested === "onnx") {
      const { OnnxGenderProvider } = await import("./onnx");
      const provider = new OnnxGenderProvider({
        modelDir: env.GENDER_MODEL_DIR,
        classifierKind: env.GENDER_CLASSIFIER,
        classOrder: env.GENDER_CLASS_ORDER,
        minFaceArea: env.GENDER_MIN_FACE_AREA,
        scoreThreshold: env.GENDER_DETECT_THRESHOLD,
      });
      await provider.init();
      return provider;
    }
    if (requested === "http") {
      const { HttpGenderProvider } = await import("./http");
      const provider = new HttpGenderProvider(env.GENDER_API_URL, env.GENDER_API_KEY);
      await provider.init();
      return provider;
    }
  } catch (err) {
    console.error(
      `[gender] provider "${requested}" failed to load, falling back to mock. ` +
        `Inference results will NOT be real:`,
      err instanceof Error ? err.message : err,
    );
  }

  const mock = new MockGenderProvider();
  await mock.init();
  return mock;
}

export const genderService = new GenderService(new MockGenderProvider(), {
  ...DEFAULT_GENDER_CONFIG,
  threshold: env.GENDER_CONFIDENCE_THRESHOLD,
  freshnessMs: env.GENDER_FRESHNESS_HOURS * 60 * 60_000,
});
