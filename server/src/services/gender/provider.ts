import { InferredGender } from "../../types";

export interface GenderInference {
  gender: InferredGender;
  /** 0..1. Meaningless when gender is "unknown". */
  confidence: number;
  /** How many faces the detector found. We only trust exactly 1. */
  faceCount: number;
  /** Which provider produced this, recorded for auditing. */
  provider: string;
  /** Wall-clock inference cost, for latency budgets. */
  latencyMs: number;
  /**
   * Estimated age, when the model has an age head. Rough — treat it as a
   * safeguard signal, never as proof of anything.
   */
  age?: number;
}

export interface GenderProvider {
  readonly name: string;
  /** Lazy model load. Safe to call repeatedly; must be idempotent. */
  init(): Promise<void>;
  /** True once init() has completed successfully. */
  isReady(): boolean;
  /** `image` is a decoded JPEG/PNG buffer. Must never throw for bad pixels — return "unknown". */
  infer(image: Buffer): Promise<GenderInference>;
  /** Release native handles. */
  dispose(): Promise<void>;
}

export class GenderProviderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GenderProviderError";
  }
}

/** Image sniffing — we accept only real JPEG/PNG, never trust a client MIME. */
export type ImageKind = "jpeg" | "png" | "unknown";

export function sniffImage(buf: Buffer): ImageKind {
  if (buf.length < 12) return "unknown";
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "png";
  }
  return "unknown";
}

/**
 * Parse a data URL or bare base64 string into a buffer.
 * Returns null rather than throwing on anything malformed.
 */
export function decodeImagePayload(payload: unknown, maxBytes: number): Buffer | null {
  if (typeof payload !== "string" || payload.length === 0) return null;

  let b64 = payload;
  const comma = payload.indexOf(",");
  if (payload.startsWith("data:")) {
    if (comma === -1) return null;
    const header = payload.slice(0, comma);
    if (!header.includes("base64")) return null;
    b64 = payload.slice(comma + 1);
  }

  // Cheap size guard before allocating: base64 is ~4/3 of the decoded size.
  if ((b64.length * 3) / 4 > maxBytes * 1.1) return null;

  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return null;
  }

  if (buf.length === 0 || buf.length > maxBytes) return null;
  if (sniffImage(buf) === "unknown") return null;
  return buf;
}
