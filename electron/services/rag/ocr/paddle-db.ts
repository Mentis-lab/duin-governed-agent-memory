// PP-OCR post-processing core: DB (Differentiable Binarization) box extraction
// for the detector, and CTC-greedy decode for the recognizer. These are the two
// numeric steps that turn raw ONNX tensors into text-region boxes and characters.
//
// ── Attribution / license ────────────────────────────────────────────────────
// The CTC-greedy decode (`ctcDecode`) is adapted from paddleocr.js
//   https://github.com/X3ZvaWQ/paddleocr.js  (MIT License, © X3ZvaWQ)
//   src/modules/text-recognition/service.ts → `ctcLabelDecode`
// paddleocr.js is not published to npm, so its logic is VENDORED here (per the
// repo's no-extra-runtime-dep rule) rather than installed. The MIT license text
// permits this with attribution; see NOTICE.
//
// The DB box extraction (`dbPostprocess`) is a self-contained ADAPTATION of the
// PaddleOCR "boxes-from-bitmap" step. paddleocr.js implements the full research
// path (findContours → rotating-calipers minAreaRect → Vatti/Clipper unclip →
// rotated quads). That pulls ~1k lines of geometry (contours.ts + clipper-offset.ts)
// that must pass this repo's strict tsc; for the DUIN use-case (screenshots and
// scanned document pages, i.e. axis-aligned text) we use the well-established
// simplification: threshold the probability map, take connected components, emit
// each component's axis-aligned box, score it by the mean map probability inside
// it, and expand ("unclip") it by the DB unclip ratio. Same thresholds/defaults
// as PP-OCR (textPixelThreshold 0.3, boxScoreThreshold 0.6, unclipRatio 1.5).

export interface DbBox {
  /** Axis-aligned box in ORIGINAL (source) image pixel coordinates, inclusive. */
  x1: number
  y1: number
  x2: number
  y2: number
  /** Mean DB probability inside the region (0..1) — the box confidence. */
  score: number
}

export interface DbOptions {
  /** Binarize the probability map above this (PP default 0.3). */
  thresh: number
  /** Drop boxes whose mean probability is below this (PP default 0.6). */
  boxThresh: number
  /** DB unclip ratio — how much to grow the box (PP default 1.5). */
  unclipRatio: number
  /** Discard components smaller than this many pixels / shorter than this side. */
  minSize: number
  /** Cap the number of returned boxes. */
  maxCandidates: number
}

export const DEFAULT_DB_OPTIONS: DbOptions = {
  thresh: 0.3,
  boxThresh: 0.6,
  unclipRatio: 1.5,
  minSize: 3,
  maxCandidates: 1000
}

/**
 * DB post-process: probability map → text-region boxes (original-image coords).
 *
 * @param prob   flattened [mapH*mapW] probability map (0..1), row-major.
 * @param mapW   probability-map width  (== detector input width  / 1).
 * @param mapH   probability-map height (== detector input height / 1).
 * @param srcW   original image width  (boxes are scaled back to this).
 * @param srcH   original image height.
 */
export function dbPostprocess(
  prob: Float32Array | number[],
  mapW: number,
  mapH: number,
  srcW: number,
  srcH: number,
  opts: DbOptions = DEFAULT_DB_OPTIONS
): DbBox[] {
  const n = mapW * mapH
  if (n <= 0 || prob.length < n) return []

  // Binary mask of "text" pixels.
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) mask[i] = prob[i] > opts.thresh ? 1 : 0

  const scaleX = srcW / mapW
  const scaleY = srcH / mapH
  const boxes: DbBox[] = []

  // Connected-component labelling via an explicit stack (8-connectivity). The
  // `visited` flag doubles as "already assigned to a component".
  const visited = new Uint8Array(n)
  const stack: number[] = []
  for (let start = 0; start < n; start++) {
    if (mask[start] === 0 || visited[start] === 1) continue
    // Flood-fill this component, tracking bbox + probability sum.
    let minX = mapW
    let minY = mapH
    let maxX = -1
    let maxY = -1
    let area = 0
    let probSum = 0
    stack.length = 0
    stack.push(start)
    visited[start] = 1
    while (stack.length > 0) {
      const idx = stack.pop() as number
      const y = (idx / mapW) | 0
      const x = idx - y * mapW
      area++
      probSum += prob[idx]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      // 8 neighbours.
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= mapH) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          if (nx < 0 || nx >= mapW) continue
          const nIdx = ny * mapW + nx
          if (mask[nIdx] === 1 && visited[nIdx] === 0) {
            visited[nIdx] = 1
            stack.push(nIdx)
          }
        }
      }
    }

    const boxW = maxX - minX + 1
    const boxH = maxY - minY + 1
    // Reject specks (both by area and by shortest side, mirroring DB_MIN_SIZE).
    if (area < opts.minSize || Math.min(boxW, boxH) < opts.minSize) continue

    // Box confidence = mean probability over the component's own pixels
    // (tighter than PP's bbox-mean "fast" score, and cheap since we accumulated it).
    const score = probSum / area
    if (score < opts.boxThresh) continue

    // DB "unclip": grow the region by distance d = area * ratio / perimeter.
    const perimeter = 2 * (boxW + boxH)
    const d = perimeter > 0 ? (area * opts.unclipRatio) / perimeter : 0
    const ex1 = minX - d
    const ey1 = minY - d
    const ex2 = maxX + d
    const ey2 = maxY + d

    // Scale back to original image pixels and clamp.
    const x1 = clamp(Math.floor(ex1 * scaleX), 0, srcW - 1)
    const y1 = clamp(Math.floor(ey1 * scaleY), 0, srcH - 1)
    const x2 = clamp(Math.ceil(ex2 * scaleX), 0, srcW - 1)
    const y2 = clamp(Math.ceil(ey2 * scaleY), 0, srcH - 1)
    if (x2 <= x1 || y2 <= y1) continue
    boxes.push({ x1, y1, x2, y2, score })
  }

  const ordered = sortBoxesReadingOrder(boxes)
  return ordered.length > opts.maxCandidates ? ordered.slice(0, opts.maxCandidates) : ordered
}

/** Sort boxes top-to-bottom, then left-to-right within a line (a box is on the
 *  same line as the previous one when their vertical centres are within half the
 *  smaller box height). Mirrors PP-OCR's reading-order sort. */
export function sortBoxesReadingOrder(boxes: DbBox[]): DbBox[] {
  const sorted = [...boxes].sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)
  for (let i = 0; i < sorted.length - 1; i++) {
    for (let j = i; j >= 0; j--) {
      const cur = sorted[j + 1]
      const prev = sorted[j]
      const prevH = prev.y2 - prev.y1
      const curCentre = (cur.y1 + cur.y2) / 2
      const prevCentre = (prev.y1 + prev.y2) / 2
      if (Math.abs(curCentre - prevCentre) < prevH / 2 && cur.x1 < prev.x1) {
        sorted[j] = cur
        sorted[j + 1] = prev
      } else {
        break
      }
    }
  }
  return sorted
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export interface CtcResult {
  text: string
  /** Mean of the winning per-timestep scores of the emitted characters (0..1 if
   *  the logits were already softmax probabilities; raw-logit magnitude otherwise). */
  confidence: number
}

/**
 * CTC-greedy decode. Adapted from paddleocr.js `ctcLabelDecode` (MIT — see file
 * header). For each timestep pick the argmax class; collapse consecutive repeats;
 * drop the CTC blank (class 0); map the remaining class indices through `dict`.
 *
 * PaddleOCR convention: class 0 is the blank and is NOT present in the dictionary
 * file, so a class index `c` (c ≥ 1) maps to `dict[c - 1]`. We also accept a
 * dictionary that itself carries a leading blank entry ("" or "blank"), in which
 * case `c` maps to `dict[c]`.
 *
 * @param logits  flattened [seqLen * numClasses], row-major (timestep-major).
 * @param seqLen  number of timesteps T.
 * @param numClasses  number of classes C (== dict length or dict length + 1).
 */
export function ctcDecode(
  logits: Float32Array | number[],
  seqLen: number,
  numClasses: number,
  dict: string[]
): CtcResult {
  const dictHasBlank = dict[0] === '' || dict[0] === 'blank'
  let text = ''
  let confSum = 0
  let confCount = 0
  let lastIndex = -1

  for (let t = 0; t < seqLen; t++) {
    const offset = t * numClasses
    let maxScore = -Infinity
    let maxIndex = 0
    for (let i = 0; i < numClasses; i++) {
      const v = logits[offset + i]
      if (v > maxScore) {
        maxScore = v
        maxIndex = i
      }
    }
    // Collapse repeats.
    if (maxIndex === lastIndex) continue
    lastIndex = maxIndex
    // Blank class (index 0) — skip.
    if (maxIndex === 0) continue
    const dictIndex = dictHasBlank ? maxIndex : maxIndex - 1
    const char = dict[dictIndex] ?? ''
    if (!char) continue
    text += char
    confSum += maxScore
    confCount++
  }

  return {
    text,
    confidence: confCount > 0 ? confSum / confCount : 0
  }
}
