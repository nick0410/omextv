import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { sniffImage } from "./provider";

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array;
}

export interface Box {
  /** All in normalized [0,1] coordinates, corner form. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Guard against decompression bombs: a 30 MP frame has no business here. */
const MAX_PIXELS = 40_000_000;

export function decodeImage(buf: Buffer): RgbaImage | null {
  const kind = sniffImage(buf);
  try {
    if (kind === "jpeg") {
      const raw = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 128 });
      if (!raw || raw.width <= 0 || raw.height <= 0) return null;
      if (raw.width * raw.height > MAX_PIXELS) return null;
      return { width: raw.width, height: raw.height, data: new Uint8Array(raw.data) };
    }
    if (kind === "png") {
      const raw = PNG.sync.read(buf);
      if (!raw || raw.width <= 0 || raw.height <= 0) return null;
      if (raw.width * raw.height > MAX_PIXELS) return null;
      return { width: raw.width, height: raw.height, data: new Uint8Array(raw.data) };
    }
  } catch {
    return null;
  }
  return null;
}

/** Clamp a normalized box to [0,1] and enforce x1<x2, y1<y2. */
export function normalizeBox(box: Box): Box {
  const x1 = Math.min(Math.max(box.x1, 0), 1);
  const y1 = Math.min(Math.max(box.y1, 0), 1);
  const x2 = Math.min(Math.max(box.x2, 0), 1);
  const y2 = Math.min(Math.max(box.y2, 0), 1);
  return {
    x1: Math.min(x1, x2),
    y1: Math.min(y1, y2),
    x2: Math.max(x1, x2),
    y2: Math.max(y1, y2),
  };
}

/**
 * Expand a face box by `factor` on each side, staying inside the frame.
 * Detectors crop tight to the face; classifiers are usually trained on a
 * looser crop that includes hair and jawline, so feeding the tight box
 * straight through measurably hurts accuracy.
 */
export function expandBox(box: Box, factor: number): Box {
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  const dx = (w * factor) / 2;
  const dy = (h * factor) / 2;
  return normalizeBox({
    x1: box.x1 - dx,
    y1: box.y1 - dy,
    x2: box.x2 + dx,
    y2: box.y2 + dy,
  });
}

export function boxArea(box: Box): number {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

/**
 * Grow the shorter side so the box is square *in pixels*, keeping it centred
 * and inside the frame.
 *
 * The classifier takes a 224x224 input. Feeding it a tall detector box
 * stretched to a square distorts face geometry, which is exactly the signal it
 * relies on. The reference implementation squares the box before cropping for
 * this reason, so we do the same.
 *
 * Coordinates are normalized, so the image dimensions are needed to know what
 * "square" means.
 */
export function squarifyBox(box: Box, imgWidth: number, imgHeight: number): Box {
  const nb = normalizeBox(box);
  if (imgWidth <= 0 || imgHeight <= 0) return nb;

  const wPx = (nb.x2 - nb.x1) * imgWidth;
  const hPx = (nb.y2 - nb.y1) * imgHeight;
  if (wPx <= 0 || hPx <= 0) return nb;

  const sidePx = Math.max(wPx, hPx);
  const halfW = sidePx / 2 / imgWidth;
  const halfH = sidePx / 2 / imgHeight;
  const cx = (nb.x1 + nb.x2) / 2;
  const cy = (nb.y1 + nb.y2) / 2;

  return normalizeBox({
    x1: cx - halfW,
    y1: cy - halfH,
    x2: cx + halfW,
    y2: cy + halfH,
  });
}

/**
 * Are these values already a probability distribution?
 *
 * The Caffe-converted classifier ends in a softmax, so its output is already
 * normalized. Running softmax again would not change the argmax but would
 * flatten the gap between the classes — and that gap is precisely the
 * confidence the threshold is applied to, so a 0.99 reading would be reported
 * as ~0.66 and silently rejected.
 */
export function looksLikeProbabilities(values: readonly number[]): boolean {
  if (values.length === 0) return false;
  let sum = 0;
  for (const v of values) {
    if (!Number.isFinite(v) || v < 0 || v > 1) return false;
    sum += v;
  }
  return Math.abs(sum - 1) < 0.01;
}

/**
 * Crop a normalized box out of an image and resize it to `size`x`size` with
 * bilinear sampling, returning a planar NCHW Float32Array normalized with the
 * supplied per-channel mean/std.
 */
export function cropResizeToTensor(
  img: RgbaImage,
  box: Box,
  size: number,
  mean: readonly [number, number, number],
  std: readonly [number, number, number],
  /**
   * Emit channels in BGR order. Caffe-trained models expect it, and feeding
   * them RGB does not fail loudly — it just makes the model quietly worse,
   * which is far harder to notice than a crash.
   */
  bgr = false,
): Float32Array {
  const nb = normalizeBox(box);
  const sx1 = nb.x1 * (img.width - 1);
  const sy1 = nb.y1 * (img.height - 1);
  const sx2 = nb.x2 * (img.width - 1);
  const sy2 = nb.y2 * (img.height - 1);

  const spanX = Math.max(sx2 - sx1, 1e-6);
  const spanY = Math.max(sy2 - sy1, 1e-6);

  // Planar layout: all R, then all G, then all B.
  const out = new Float32Array(3 * size * size);
  const plane = size * size;

  for (let y = 0; y < size; y++) {
    // Map destination pixel centres back into the source crop.
    const srcY = sy1 + (size === 1 ? spanY / 2 : (y / (size - 1)) * spanY);
    const y0 = Math.floor(srcY);
    const y1 = Math.min(y0 + 1, img.height - 1);
    const wy = srcY - y0;

    for (let x = 0; x < size; x++) {
      const srcX = sx1 + (size === 1 ? spanX / 2 : (x / (size - 1)) * spanX);
      const x0 = Math.floor(srcX);
      const x1 = Math.min(x0 + 1, img.width - 1);
      const wx = srcX - x0;

      const i00 = (y0 * img.width + x0) * 4;
      const i01 = (y0 * img.width + x1) * 4;
      const i10 = (y1 * img.width + x0) * 4;
      const i11 = (y1 * img.width + x1) * 4;

      const dst = y * size + x;
      for (let c = 0; c < 3; c++) {
        const v =
          img.data[i00 + c] * (1 - wx) * (1 - wy) +
          img.data[i01 + c] * wx * (1 - wy) +
          img.data[i10 + c] * (1 - wx) * wy +
          img.data[i11 + c] * wx * wy;
        // `c` indexes the source (always RGBA); `channel` is where it lands.
        // The mean is indexed by the destination channel so it stays paired
        // with the value it is meant to centre.
        const channel = bgr ? 2 - c : c;
        out[channel * plane + dst] = (v / 255 - mean[channel]) / std[channel];
      }
    }
  }

  return out;
}

/** Whole-image variant, used to feed the detector. */
export function resizeToTensor(
  img: RgbaImage,
  size: number,
  mean: readonly [number, number, number],
  std: readonly [number, number, number],
): Float32Array {
  return cropResizeToTensor(img, { x1: 0, y1: 0, x2: 1, y2: 1 }, size, mean, std);
}

export function softmax(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  // sum can only be 0 if every exp underflowed, which max-subtraction prevents.
  return exps.map((e) => e / sum);
}
