import { GenderProvider, GenderInference, GenderProviderError } from "./provider";
import { InferredGender } from "../../types";

interface HttpGenderResponse {
  gender?: string;
  confidence?: number;
  faceCount?: number;
  faces?: unknown[];
}

/**
 * Calls a hosted inference endpoint instead of running a model locally.
 *
 * This is the production-shaped option: keeps the API container small, and
 * lets the model scale (and be retrained) independently of the chat server.
 * The endpoint is expected to accept `{ image: <base64> }` and answer with
 * `{ gender, confidence, faceCount }`.
 */
export class HttpGenderProvider implements GenderProvider {
  readonly name = "http";
  private ready = false;

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 5_000,
  ) {}

  async init(): Promise<void> {
    if (!this.url) {
      throw new GenderProviderError("GENDER_API_URL is not set");
    }
    try {
      // eslint-disable-next-line no-new
      new URL(this.url);
    } catch {
      throw new GenderProviderError(`GENDER_API_URL is not a valid URL: ${this.url}`);
    }
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
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

    // A hung model server must not hold a socket handler open forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ image: image.toString("base64") }),
        signal: controller.signal,
      });

      if (!res.ok) return miss();

      const body = (await res.json()) as HttpGenderResponse;

      const raw = typeof body.gender === "string" ? body.gender.toLowerCase() : "";
      const gender: InferredGender =
        raw === "male" || raw === "female" ? (raw as InferredGender) : "unknown";

      // Trust the explicit count, else infer it from the faces array.
      const faceCount =
        typeof body.faceCount === "number"
          ? body.faceCount
          : Array.isArray(body.faces)
            ? body.faces.length
            : gender === "unknown"
              ? 0
              : 1;

      const confidence =
        typeof body.confidence === "number" && Number.isFinite(body.confidence)
          ? Math.min(Math.max(body.confidence, 0), 1)
          : 0;

      return {
        gender,
        confidence,
        faceCount,
        provider: this.name,
        latencyMs: Date.now() - started,
      };
    } catch {
      // Network failure, timeout, or malformed JSON — all mean "no reading".
      return miss();
    } finally {
      clearTimeout(timer);
    }
  }

  async dispose(): Promise<void> {
    this.ready = false;
  }
}
