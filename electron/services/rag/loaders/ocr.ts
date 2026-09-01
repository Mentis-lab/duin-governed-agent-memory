import { existsSync, readdirSync } from 'fs'
import { extname, join } from 'path'
// Static (cheap) import: paddle-ocr.ts only pulls the fs-based model catalog — the
// heavy onnxruntime/sharp work lives in the SEPARATELY-spawned paddle-worker.js,
// loaded lazily at OCR time. Importing statically (rather than via `import()`) keeps
// paddle-ocr in the main bundle so its `require.resolve('./paddle-worker.js')`
// resolves from out/main/ (a dynamic import would code-split it into out/main/chunks/,
// breaking that relative resolve). The tesseract-default path pays nothing at runtime.
import { paddleModelsAvailable, paddleOcrImage } from '../ocr/paddle-ocr'
// Persisted OCR preferences (sync JSON read). ocrEnabled()/ocrEngine() fall back
// to these when the corresponding env var is unset, so a user's Settings choice
// survives an app restart (env vars don't). Cheap: readSettings() is a small
// synchronous JSON read with a `{}` fallback outside the main process.
import { readSettings } from '../../settings-helper'
import { messageOf } from '../../guarded'

// OCR loader (Tier 1 — image files). Turns raster images (screenshots, scans,
// photos of text) into searchable text so a pasted screenshot stops being
// invisible to the vault index / RAG library.
//
// Design constraints (see the OCR Tier-1 scope):
//   - LOCAL-FIRST / OFFLINE: tesseract.js defaults to fetching `.traineddata`
//     from the jsdelivr CDN. We override `langPath` to a BUNDLED local dir
//     (resources/ocr/tessdata) so recognition works with no network. In Node
//     the WASM core is `require()`d straight from node_modules/tesseract.js-core
//     (never CDN), so `langPath` is the only remote dependency to neutralize.
//   - SETTING-GATED, default ON. `ocrEnabled()` reads the persisted `ocrEnabled`
//     setting (Settings → RAG), with the `DUIN_OCR` env var still overriding it
//     for debug force-off/on. When off, images are not ingestable and this
//     module's worker is never spun up — zero cost / zero bundle bloat.
//   - BEST-EFFORT: any failure (missing traineddata, corrupt image, worker
//     crash) resolves to `{ text: '' }`. OCR must NEVER throw into the ingest
//     pipeline — a screenshot that can't be read should degrade to a 0-chunk
//     viewable doc, exactly like a scanned/text-layerless PDF.
//   - LAZY worker init: the tesseract.js worker (a worker_thread + WASM core +
//     multi-MB language data) is only created the first time OCR actually runs,
//     and is then reused across calls.
//
// Scope: IMAGE FILES ONLY. Scanned-PDF OCR (PDF rasterization) is Tier 2 and is
// intentionally NOT handled here.

// Type-only import: never pulls tesseract.js (or its WASM worker) into the
// module graph. The real module is lazy-`require`d inside getWorker().
type TesseractModule = typeof import('tesseract.js')
type TesseractWorker = import('tesseract.js').Worker

/** Raster image extensions we can OCR. */
export const OCR_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff'
] as const

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
}

/** True when `name` has an extension we route to OCR. */
export function isImageExtension(name: string): boolean {
  return extname(name).toLowerCase() in IMAGE_MIME
}

/** The image mime for a path/name (defaults to a generic image mime). */
export function imageMime(name: string): string {
  return IMAGE_MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * OCR feature flag. Composition (env override → persisted setting → default ON):
 *   1. `DUIN_OCR` env var, when SET (non-empty), always wins — parsed as
 *      1/true/on/yes → on, anything else (e.g. `DUIN_OCR=0`) → off. This is the
 *      debug force-off/force-on knob and is unchanged from the flag-only era.
 *   2. Otherwise the persisted `ocrEnabled` setting (Settings → RAG toggle).
 *   3. Default ON when the setting is unset — OCR is proven + best-effort (no
 *      models → empty text, never a crash), so it's safe on by default, and the
 *      choice now survives an app restart (env vars don't persist).
 */
export function ocrEnabled(): boolean {
  const raw = process.env.DUIN_OCR
  if (raw != null && raw.trim() !== '') {
    const v = raw.trim().toLowerCase()
    return v === '1' || v === 'true' || v === 'on' || v === 'yes'
  }
  // Unset only when EXPLICITLY false; undefined/true both mean on (default ON).
  return readSettings().ocrEnabled !== false
}

/** OCR engine selector. `DUIN_OCR_ENGINE` env var wins when SET (non-empty);
 *  else the persisted `ocrEngine` setting; else `tesseract` (Tier-1 default).
 *  `paddle` routes recognition through the local PP-OCRv5 engine (Tier-2, higher
 *  CJK quality). Any unrecognized value falls back to `tesseract`. */
export type OcrEngine = 'tesseract' | 'paddle'
export function ocrEngine(): OcrEngine {
  const raw = process.env.DUIN_OCR_ENGINE
  if (raw != null && raw.trim() !== '') {
    return raw.trim().toLowerCase() === 'paddle' ? 'paddle' : 'tesseract'
  }
  return readSettings().ocrEngine === 'paddle' ? 'paddle' : 'tesseract'
}

// Default language set. Screenshots for this ICP are frequently CJK, so we ship
// English + Simplified Chinese + Japanese by default. `chi_sim`/`jpn` model
// files must be present in the tessdata dir (see resources/ocr/README.md);
// if a requested language's file is missing tesseract throws and we return ''.
const DEFAULT_LANGS = 'eng+chi_sim+jpn'

/**
 * Locate the bundled tessdata directory (the `.traineddata` language files),
 * OFFLINE — no CDN. Resolution order:
 *   1. `DUIN_OCR_TESSDATA` env override (explicit path).
 *   2. `process.resourcesPath/ocr/tessdata` (packaged app — see electron-builder.yml).
 *   3. `resources/ocr/tessdata` walked up from this file (dev / repo run).
 * A candidate must exist AND contain at least one `.traineddata` file — an
 * empty/placeholder dir (only the committed `.gitkeep`, no models dropped in
 * yet) is useless, so we skip it and ultimately return null. Returns null when
 * no usable directory is found, so the caller degrades to empty text.
 */
export function resolveTessdataDir(): string | null {
  const candidates: string[] = []
  const override = process.env.DUIN_OCR_TESSDATA?.trim()
  if (override) candidates.push(override)
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'ocr', 'tessdata'))
  // Walk up from the compiled/loaded location looking for the repo's resources dir.
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    candidates.push(join(dir, 'resources', 'ocr', 'tessdata'))
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  for (const c of candidates) {
    if (hasTraineddata(c)) return c
  }
  return null
}

function hasTraineddata(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).some((f) => f.toLowerCase().endsWith('.traineddata'))
  } catch {
    return false
  }
}

// Lazy, per-language-set worker cache. Creating a worker spins a worker_thread,
// loads the WASM core, and reads multi-MB language data — do it once per langs.
const workers = new Map<string, Promise<TesseractWorker>>()

async function getWorker(langs: string, tessdataDir: string): Promise<TesseractWorker> {
  const key = `${langs}@${tessdataDir}`
  let existing = workers.get(key)
  if (!existing) {
    existing = createWorkerFor(langs, tessdataDir)
    workers.set(key, existing)
    // If creation rejects, drop the cached rejected promise so a later call can retry.
    existing.catch(() => workers.delete(key))
  }
  return existing
}

async function createWorkerFor(langs: string, tessdataDir: string): Promise<TesseractWorker> {
  // Lazy dynamic import: keeps tesseract.js + its WASM worker out of the module
  // graph (and out of tests) until OCR is actually invoked. (tesseract.js is a
  // CommonJS `export =` module; Node synthesizes the `createWorker` named export,
  // with `.default` as the interop fallback.)
  const mod = (await import('tesseract.js')) as TesseractModule & { default?: TesseractModule }
  const createWorker = mod.createWorker ?? mod.default?.createWorker
  if (!createWorker) throw new Error('tesseract.js createWorker unavailable')
  // OEM 1 = LSTM_ONLY — matches the lstm-only `tessdata_fast`/`_best` models and
  // selects the smaller lstm WASM core.
  const LSTM_ONLY = 1
  return createWorker(langs, LSTM_ONLY, {
    // OFFLINE: read `.traineddata` from the bundled dir instead of the CDN.
    langPath: tessdataDir,
    // Don't read/write a `.traineddata` cache in the cwd — we always load from
    // the bundled langPath, so caching is pure filesystem litter.
    cacheMethod: 'none',
    // Bundled files are plain `<lang>.traineddata` (gunzip is still auto-detected
    // from the content magic bytes, so gzipped files also work).
    gzip: false,
    logger: () => {},
    errorHandler: () => {}
  })
}

export interface OcrResult {
  text: string
}

/**
 * OCR an image to text. BEST-EFFORT: returns `{ text: '' }` on ANY failure
 * (disabled feature, missing traineddata, unreadable image, worker crash) and
 * never throws into the ingest pipeline.
 *
 * @param input  a file path OR an in-memory image Buffer.
 * @param opts.langs tesseract language string (e.g. `eng+chi_sim`); defaults to
 *                   `eng+chi_sim+jpn`.
 */
export async function ocrImage(
  input: Buffer | string,
  opts?: { langs?: string }
): Promise<OcrResult> {
  try {
    // Tier-2 engine selector: when DUIN_OCR_ENGINE=paddle AND the PP-OCRv5 models
    // are present, route through the local PaddleOCR engine (higher CJK quality).
    // If the models aren't bundled/cached (or paddle errors), fall through to the
    // tesseract path below so the feature still works — tesseract stays the
    // default/fallback. paddle-ocr is lazily imported so the tesseract-default
    // path never pulls the onnxruntime worker into its module graph.
    if (ocrEngine() === 'paddle') {
      if (paddleModelsAvailable()) {
        // paddleOcrImage is contractually BEST-EFFORT and NEVER throws — any
        // paddle-side failure (worker crash, 30s timeout, decode error, poisoned
        // load) resolves to { text: '' } rather than rejecting. So a try/catch
        // here is dead code: we must branch on the RESULT. Only a non-empty
        // extraction short-circuits; empty text falls through to the tesseract
        // path below so a user who opted into an *unhealthy* paddle engine still
        // gets text, instead of silently ingesting every image as 0 chunks.
        const r = await paddleOcrImage(input)
        if (r.text.trim()) return { text: r.text }
        // else: fall through to tesseract fallback
      }
    }
    const tessdataDir = resolveTessdataDir()
    if (!tessdataDir) {
      // No bundled language data present → nothing we can do offline. Degrade.
      return { text: '' }
    }
    const langs = opts?.langs?.trim() || DEFAULT_LANGS
    const worker = await getWorker(langs, tessdataDir)
    const { data } = await worker.recognize(input)
    return { text: (data.text ?? '').trim() }
  } catch {
    // Swallow — the pipeline treats an image with no extractable text as a
    // 0-chunk viewable doc, never a hard error.
    return { text: '' }
  }
}

/** Terminate any lazily-created OCR workers (best-effort; for app shutdown). */
export async function terminateOcrWorkers(): Promise<void> {
  const pending = [...workers.values()]
  workers.clear()
  await Promise.all(
    pending.map(async (p) => {
      try {
        const w = await p
        await w.terminate()
      } catch (e) { console.debug('[ocr] ignore:', messageOf(e)) }
    })
  )
}
