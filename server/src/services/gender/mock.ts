import { createHash } from "crypto";
import { GenderProvider, GenderInference } from "./provider";
import { InferredGender } from "../../types";

/**
 * Deterministic stand-in for the real model.
 *
 * Used by the test suite and as the fallback when no real provider is
 * configured, so that the rest of the pipeline (rate limits, thresholds,
 * persistence, matching) is fully exercisable without a 200 MB model download
 * or native bindings.
 *
 * The output is derived from a hash of the image bytes, so the same image
 * always yields the same verdict — tests can assert exact values.
 */
export class MockGenderProvider implements GenderProvider {
  readonly name = "mock";
  private ready = false;

  /** Explicit overrides keyed by the sha256 of the image, for targeted tests. */
  private overrides = new Map<string, GenderInference>();

  async init(): Promise<void> {
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Force a specific verdict for a specific image buffer. */
  setOverride(image: Buffer, result: Partial<GenderInference>): void {
    const key = createHash("sha256").update(image).digest("hex");
    this.overrides.set(key, {
      gender: result.gender ?? "unknown",
      confidence: result.confidence ?? 0,
      faceCount: result.faceCount ?? (result.gender === "unknown" ? 0 : 1),
      provider: this.name,
      latencyMs: result.latencyMs ?? 1,
    });
  }

  clearOverrides(): void {
    this.overrides.clear();
  }

  async infer(image: Buffer): Promise<GenderInference> {
    const started = Date.now();
    const digest = createHash("sha256").update(image).digest();
    const key = digest.toString("hex");

    const override = this.overrides.get(key);
    if (override) return { ...override, latencyMs: Date.now() - started };

    // Byte 0 decides the class, byte 1 the confidence — stable and uniform.
    const genderByte = digest[0];
    const confByte = digest[1];

    let gender: InferredGender;
    let faceCount: number;
    if (genderByte % 10 === 0) {
      // ~10% of inputs: no usable face.
      gender = "unknown";
      faceCount = 0;
    } else if (genderByte % 10 === 1) {
      // ~10%: multiple faces, which the service must reject.
      gender = genderByte % 2 === 0 ? "male" : "female";
      faceCount = 2;
    } else {
      gender = genderByte % 2 === 0 ? "male" : "female";
      faceCount = 1;
    }

    const confidence = gender === "unknown" ? 0 : 0.5 + (confByte / 255) * 0.5;

    return {
      gender,
      confidence: Number(confidence.toFixed(4)),
      faceCount,
      provider: this.name,
      latencyMs: Date.now() - started,
    };
  }

  async dispose(): Promise<void> {
    this.ready = false;
    this.overrides.clear();
  }
}
