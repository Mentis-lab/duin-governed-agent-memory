import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// PaddleOCR (PP-OCRv5) model catalogue — the OCR Tier-2 counterpart to the
// embeddings `catalog.ts`. Describes the ONNX model files + character dictionary
// the local in-process PP-OCR engine loads (via onnxruntime-node, no Python, no
// cloud), and resolves their on-disk location OFFLINE.
//
// Selection (see the OCR Tier-2 scope):
//   - PP-OCRv5 **mobile** ONNX: det (~4.6 MB) + rec (~15.8 MB) + optional cls
//     (~1 MB) ≈ 21 MB — best-in-class CJK at a bundle size that ships.
//   - ppocrv5_dict.txt — the 18,383-entry character dictionary the rec head's
//     CTC output indexes into.
//   All Apache-2.0. Sources: huggingface.co/monkt/paddleocr-onnx, RapidAI/RapidOCR.
//
// The binaries are NOT committed to git (repo-bloat rule) — they are dropped into
// `resources/ocr/models/` before a release build (electron-builder extraResources,
// mirroring the Tier-1 tessdata pattern) OR pointed at via `DUIN_OCR_PADDLE_MODELS`.
// See resources/ocr/models/README.md.

export type PaddleModelRole = 'det' | 'rec' | 'cls'

export interface PaddleModelInfo {
  role: PaddleModelRole
  /** Canonical filename we look for first (case-insensitive). */
  filename: string
  /** Substring that also identifies the file if the canonical name isn't present
   *  (downloads from different mirrors name these slightly differently). */
  match: string
  approxBytes: number
  license: string
  source: string
  /** Whether the pipeline can run without this model. Only `cls` is optional. */
  optional: boolean
  description: string
}

/** Canonical dictionary filename; any `.txt` in the dir is accepted as a fallback. */
export const PADDLE_DICT_FILENAME = 'ppocrv5_dict.txt'

export const PADDLE_OCR_CATALOG: readonly PaddleModelInfo[] = [
  {
    role: 'det',
    filename: 'PP-OCRv5_mobile_det.onnx',
    match: 'det',
    approxBytes: Math.round(4.6 * 1024 * 1024),
    license: 'Apache-2.0',
    source: 'huggingface.co/monkt/paddleocr-onnx (or RapidAI/RapidOCR)',
    optional: false,
    description:
      'PP-OCRv5 mobile text DETECTION (DB head). Emits a [1,1,H,W] probability map; ' +
      'DB post-process turns it into text-region boxes.'
  },
  {
    role: 'rec',
    filename: 'PP-OCRv5_mobile_rec.onnx',
    match: 'rec',
    approxBytes: Math.round(15.8 * 1024 * 1024),
    license: 'Apache-2.0',
    source: 'huggingface.co/monkt/paddleocr-onnx (or RapidAI/RapidOCR)',
    optional: false,
    description:
      'PP-OCRv5 mobile text RECOGNITION (SVTR/CTC head). Emits [1,T,C] logits; ' +
      'CTC-greedy decode against ppocrv5_dict.txt yields the line text.'
  },
  {
    role: 'cls',
    filename: 'PP-OCRv5_mobile_cls.onnx',
    match: 'cls',
    approxBytes: Math.round(1.0 * 1024 * 1024),
    license: 'Apache-2.0',
    source: 'huggingface.co/monkt/paddleocr-onnx (or RapidAI/RapidOCR)',
    optional: true,
    description:
      'OPTIONAL 0/180° textline orientation classifier. Not required for the det+rec ' +
      'pipeline; catalogued so an orientation-correction pass can load it when present.'
  }
] as const

/** Total approx bundle size of the REQUIRED models (det + rec + dict). */
export function requiredModelsApproxBytes(): number {
  return PADDLE_OCR_CATALOG.filter((m) => !m.optional).reduce((n, m) => n + m.approxBytes, 0)
}

export interface ResolvedPaddleModels {
  dir: string
  det: string
  rec: string
  /** Present only when an orientation classifier .onnx was found. */
  cls?: string
  dict: string
}

/**
 * Locate the bundled PP-OCR model directory OFFLINE (no download at call time).
 * Resolution order mirrors ocr.ts's tessdata resolver:
 *   1. `DUIN_OCR_PADDLE_MODELS` env override (explicit path).
 *   2. `process.resourcesPath/ocr/models` (packaged app — electron-builder.yml).
 *   3. `resources/ocr/models` walked up from this file (dev / repo run).
 * A candidate qualifies only if it holds BOTH a det and a rec `.onnx` AND a dict
 * `.txt` — an empty/placeholder dir (only the committed `.gitkeep`) is useless, so
 * it's skipped. Returns null when nothing usable is found so callers degrade to
 * empty text (best-effort).
 */
export function resolvePaddleModels(): ResolvedPaddleModels | null {
  const candidates: string[] = []
  const override = process.env.DUIN_OCR_PADDLE_MODELS?.trim()
  if (override) {
    // AUTHORITATIVE (2026-07-21): an EXPLICIT override is the whole answer, not the first guess.
    // Previously an unusable override fell through to the packaged/dev directories, so pointing
    // DUIN_OCR_PADDLE_MODELS at the wrong place silently ran a DIFFERENT model set than the one
    // configured — a misconfiguration that reports success. If you named a directory, you get that
    // directory or you get null (callers already degrade to empty text, best-effort).
    const resolved = resolveInDir(override)
    if (!resolved) {
      console.debug(
        `[paddle-catalog] DUIN_OCR_PADDLE_MODELS="${override}" has no usable det+rec .onnx and dict .txt — ` +
          'OCR is disabled rather than silently falling back to the bundled models.'
      )
    }
    return resolved
  }
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'ocr', 'models'))
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    candidates.push(join(dir, 'resources', 'ocr', 'models'))
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  for (const c of candidates) {
    const resolved = resolveInDir(c)
    if (resolved) return resolved
  }
  return null
}

function resolveInDir(dir: string): ResolvedPaddleModels | null {
  if (!existsSync(dir)) return null
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  const onnx = entries.filter((f) => f.toLowerCase().endsWith('.onnx'))
  const txt = entries.filter((f) => f.toLowerCase().endsWith('.txt'))
  const det = pickModel(onnx, 'det')
  const rec = pickModel(onnx, 'rec')
  const cls = pickModel(onnx, 'cls')
  const dict = pickDict(txt)
  if (!det || !rec || !dict) return null
  const out: ResolvedPaddleModels = {
    dir,
    det: join(dir, det),
    rec: join(dir, rec),
    dict: join(dir, dict)
  }
  // cls must not be mistaken for det/rec (its match substring is distinct), and
  // must be a different file than det/rec.
  if (cls && cls !== det && cls !== rec) out.cls = join(dir, cls)
  return out
}

function pickModel(files: string[], role: PaddleModelRole): string | undefined {
  const info = PADDLE_OCR_CATALOG.find((m) => m.role === role)!
  const exact = files.find((f) => f.toLowerCase() === info.filename.toLowerCase())
  if (exact) return exact
  return files.find((f) => f.toLowerCase().includes(info.match))
}

function pickDict(files: string[]): string | undefined {
  const exact = files.find((f) => f.toLowerCase() === PADDLE_DICT_FILENAME.toLowerCase())
  if (exact) return exact
  // Prefer a filename that looks like a dict/keys file over an arbitrary .txt.
  return (
    files.find((f) => /dict|keys|char/i.test(f)) ?? (files.length === 1 ? files[0] : undefined)
  )
}

/**
 * Read the character dictionary into an ordered array. PaddleOCR's CTC head has
 * `dict.length + 1` output classes: index 0 is the CTC blank (NOT in the file),
 * indices 1..N map to dict lines 0..N-1. A trailing space entry (a real class in
 * PP-OCRv5) is preserved. Blank lines other than a deliberate space char are kept
 * as-is so line-index alignment with the model is exact.
 */
export function loadPaddleDict(dictPath: string): string[] {
  const raw = readFileSync(dictPath, 'utf-8')
  // Split on \n, strip a trailing \r; do NOT trim the line itself (a space line is
  // a legitimate dictionary entry). Drop a single trailing empty line from EOF.
  const lines = raw.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** True when a usable PP-OCR model set is present on disk (offline-ready). */
export function paddleModelsAvailable(): boolean {
  return resolvePaddleModels() !== null
}
