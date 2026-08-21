import { Box, boxArea, normalizeBox } from "./imaging";

export interface Detection {
  box: Box;
  score: number;
}

/** Intersection over union of two normalized boxes. */
export function iou(a: Box, b: Box): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);

  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;

  const union = boxArea(a) + boxArea(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * Greedy non-maximum suppression: keep the highest-scoring box, drop everything
 * overlapping it beyond `iouThreshold`, repeat.
 *
 * Without this a single face yields dozens of near-identical detections and the
 * service would reject the frame as "multiple faces".
 */
export function nms(
  detections: readonly Detection[],
  iouThreshold: number,
  topK = 100,
): Detection[] {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];

  for (const candidate of sorted) {
    if (kept.length >= topK) break;
    let overlaps = false;
    for (const k of kept) {
      if (iou(candidate.box, k.box) > iouThreshold) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) kept.push(candidate);
  }

  return kept;
}

/**
 * Decode UltraFace (version-RFB / version-slim) ONNX output.
 *
 * The exported graph emits two tensors, already decoded to corner form — no
 * anchor arithmetic needed on our side:
 *   scores: [1, N, 2]  -> [background, face] probabilities
 *   boxes:  [1, N, 4]  -> [x1, y1, x2, y2] normalized to [0,1]
 *
 * `scoreData` and `boxData` are the flattened tensors.
 */
export function decodeUltraFace(
  scoreData: Float32Array | number[],
  boxData: Float32Array | number[],
  scoreThreshold: number,
): Detection[] {
  const n = Math.floor(scoreData.length / 2);
  if (n === 0 || boxData.length < n * 4) return [];

  const out: Detection[] = [];
  for (let i = 0; i < n; i++) {
    const faceScore = scoreData[i * 2 + 1];
    if (faceScore < scoreThreshold) continue;

    const box = normalizeBox({
      x1: boxData[i * 4 + 0],
      y1: boxData[i * 4 + 1],
      x2: boxData[i * 4 + 2],
      y2: boxData[i * 4 + 3],
    });

    // Degenerate boxes (zero width/height) are noise, not faces.
    if (boxArea(box) <= 0) continue;
    out.push({ box, score: faceScore });
  }
  return out;
}

/**
 * Ignore faces that are a negligible share of the frame.
 *
 * A person in a video call fills a good chunk of the view; a 0.5%-of-frame
 * blob is a poster on the wall or a passer-by, and counting it would flip an
 * otherwise valid frame into a "multiple faces" rejection.
 */
export function filterByMinArea(detections: readonly Detection[], minArea: number): Detection[] {
  return detections.filter((d) => boxArea(d.box) >= minArea);
}

/** The largest-area detection — the person actually sitting at the camera. */
export function primaryFace(detections: readonly Detection[]): Detection | null {
  if (detections.length === 0) return null;
  let best = detections[0];
  let bestArea = boxArea(best.box);
  for (let i = 1; i < detections.length; i++) {
    const area = boxArea(detections[i].box);
    if (area > bestArea) {
      best = detections[i];
      bestArea = area;
    }
  }
  return best;
}
