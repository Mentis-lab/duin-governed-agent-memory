// PaddleOCR (PP-OCRv5) inference worker. Runs as an Electron **utilityProcess**
// (a separate OS process) spawned by paddle-ocr.ts — the SAME crash-isolation
// pattern as the embeddings worker (rag/embeddings/worker.ts): PP-OCR runs on the
// native onnxruntime-node addon, which can segfault on a bad forward pass; in this
// child a fault kills ONLY the child, and the host re-spawns on the next call.
//
// It hosts the det + rec ONNX sessions (InferenceSession.create — NOT the
// transformers.js pipeline(), since PP-OCR isn't a transformers task) and drives
// the full image→text pipeline:
//   decode → det preprocess → det.run → DB post-process → per-box crop →
//   rec preprocess → rec.run → CTC decode → assemble reading-order text.
//
// Image decode / resize / crop reuse @huggingface/transformers' RawImage (a thin
// wrapper over the sharp instance the embeddings worker already ships) so NO new
// dependency is added. onnxruntime-node 1.21.0 is resolved out of the transformers
// dependency closure (it is not hoisted to the top-level node_modules).

import { dirname } from 'path'
import { readFileSync } from 'fs'
import { ctcDecode, dbPostprocess, DEFAULT_DB_OPTIONS, type DbBox } from './paddle-db'
import { createRetryableMemo, type RetryableMemo } from './retryable-memo'

// Read the character dictionary. Inlined here (rather than imported from
// paddle-catalog) so this worker stays SELF-CONTAINED — a shared import would make
// rollup emit a common chunk, but this file is asarUnpack'd and a packed sibling
// chunk wouldn't resolve from the unpacked copy at runtime. Mirror of
// paddle-catalog.loadPaddleDict (kept in lockstep): split on \n, strip a trailing
// \r, preserve a deliberate space entry, drop the single trailing EOF newline.
function loadDict(dictPath: string): string[] {
  const raw = readFileSync(dictPath, 'utf-8')
  const lines = raw.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// utilityProcess messaging: inbound arrives as `{ data }`, outbound via postMessage.
// userDataPath (unused today, kept for parity with the embeddings worker) is argv[2].
const parentPort = process.parentPort
function post(msg: unknown): void {
  parentPort.postMessage(msg)
}

// ── Minimal onnxruntime-node typings (loaded via require, so untyped at the edge). ──
interface OrtTensor {
  data: Float32Array | Int32Array | BigInt64Array | Uint8Array
  dims: number[]
}
interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>
  inputNames: string[]
  outputNames: string[]
}
interface OrtModule {
  InferenceSession: {
    create(path: string, opts?: Record<string, unknown>): Promise<OrtSession>
  }
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OrtTensor
}

interface RawImageLike {
  data: Uint8Array | Uint8ClampedArray
  width: number
  height: number
  channels: number
  rgb(): RawImageLike
  resize(w: number, h: number): Promise<RawImageLike>
  crop(box: [number, number, number, number]): Promise<RawImageLike>
}
interface TransformersModule {
  RawImage: {
    read(input: string): Promise<RawImageLike>
    fromBlob(blob: Blob): Promise<RawImageLike>
  }
}

// ── Detector / recognizer normalization constants (PP-OCR defaults). ──
// det: (pixel/255 - imagenet_mean) / imagenet_std, expressed as (pixel - mean)*recip.
const DET_MEAN = [0.485 * 255, 0.456 * 255, 0.406 * 255]
const DET_STD_RECIP = [1 / 0.229 / 255, 1 / 0.224 / 255, 1 / 0.225 / 255]
const DET_MAX_SIDE = 960
// rec: (pixel - 127.5) / 127.5.
const REC_MEAN = 127.5
const REC_STD_RECIP = 1 / 127.5
const REC_HEIGHT = 48
const REC_MAX_WIDTH = 320

interface Loaded {
  ort: OrtModule
  transformers: TransformersModule
  det: OrtSession
  rec: OrtSession
  dict: string[]
}
// Wrapped in a retryable memo so a TRANSIENT load failure isn't cached forever: a
// plain `if (loadedP) return loadedP` would pin the first rejected promise for the
// life of the process and silently disable OCR (paddleOcrImage swallows the error
// into { text: '' }). createRetryableMemo clears the slot on rejection, matching the
// tesseract worker cache in loaders/ocr.ts. The first caller's paths win (later
// paths are ignored while a load is memoized), preserving the old loadOnce semantics.
let loadedMemo: RetryableMemo<Loaded> | null = null

async function loadOnce(paths: {
  det: string
  rec: string
  dict: string
}): Promise<Loaded> {
  if (!loadedMemo) {
    loadedMemo = createRetryableMemo<Loaded>(async () => {
      const transformers = (await import('@huggingface/transformers')) as unknown as TransformersModule
      // onnxruntime-node is nested under @huggingface/transformers/node_modules (it is
      // NOT hoisted to the top-level node_modules), so resolve it relative to the
      // transformers package dir rather than the top level. `require` is the global
      // CJS require of the bundled main process (mirrors service.ts's spawn code).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const transformersEntry = require.resolve('@huggingface/transformers')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ortPath = require.resolve('onnxruntime-node', { paths: [dirname(transformersEntry)] })
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ort = require(ortPath) as OrtModule
      const det = await ort.InferenceSession.create(paths.det)
      const rec = await ort.InferenceSession.create(paths.rec)
      const dict = loadDict(paths.dict)
      return { ort, transformers, det, rec, dict }
    })
  }
  return loadedMemo.get()
}

async function decode(l: Loaded, input: string | Uint8Array): Promise<RawImageLike> {
  const RawImage = l.transformers.RawImage
  const img =
    typeof input === 'string'
      ? await RawImage.read(input)
      : await RawImage.fromBlob(new Blob([input as Uint8Array]))
  return img.rgb()
}

/** Round DOWN to a positive multiple of 32 (the detector's stride). */
function roundTo32(v: number): number {
  const r = Math.max(32, Math.round(v / 32) * 32)
  return r
}

/** Build a CHW Float32 NCHW tensor from an HWC-interleaved RGB RawImage, applying
 *  per-channel `(pixel - mean) * recip`. Region outside [0,srcW)×[0,srcH) is 0. */
function toNchw(
  src: RawImageLike,
  outW: number,
  outH: number,
  mean: number[] | number,
  recip: number[] | number
): Float32Array {
  const out = new Float32Array(3 * outH * outW)
  const { data, width, height } = src
  const m = (c: number): number => (Array.isArray(mean) ? mean[c] : mean)
  const r = (c: number): number => (Array.isArray(recip) ? recip[c] : recip)
  const copyH = Math.min(height, outH)
  const copyW = Math.min(width, outW)
  for (let c = 0; c < 3; c++) {
    const cm = m(c)
    const cr = r(c)
    const plane = c * outH * outW
    for (let y = 0; y < copyH; y++) {
      const rowIn = y * width * 3
      const rowOut = plane + y * outW
      for (let x = 0; x < copyW; x++) {
        const px = data[rowIn + x * 3 + c]
        out[rowOut + x] = (px - cm) * cr
      }
    }
  }
  return out
}

async function detect(l: Loaded, img: RawImageLike): Promise<DbBox[]> {
  const srcW = img.width
  const srcH = img.height
  // Limit the longest side to DET_MAX_SIDE, then snap both sides to a /32 grid.
  const longest = Math.max(srcW, srcH)
  const ratio = longest > DET_MAX_SIDE ? DET_MAX_SIDE / longest : 1
  const inW = roundTo32(srcW * ratio)
  const inH = roundTo32(srcH * ratio)
  const resized = await img.resize(inW, inH)
  const feed = toNchw(resized, inW, inH, DET_MEAN, DET_STD_RECIP)
  const input = new l.ort.Tensor('float32', feed, [1, 3, inH, inW])
  const outputs = await l.det.run({ [l.det.inputNames[0]]: input })
  const out = outputs[l.det.outputNames[0]]
  // Expected [1,1,H,W]; the prob map is the last two dims.
  const dims = out.dims
  const mapH = dims[dims.length - 2]
  const mapW = dims[dims.length - 1]
  const prob = out.data as Float32Array
  return dbPostprocess(prob, mapW, mapH, srcW, srcH, DEFAULT_DB_OPTIONS)
}

async function recognize(l: Loaded, crop: RawImageLike): Promise<string> {
  const w = crop.width
  const h = crop.height
  if (w < 2 || h < 2) return ''
  const targetW = Math.max(2, Math.min(REC_MAX_WIDTH, Math.round((REC_HEIGHT * w) / h)))
  const resized = await crop.resize(targetW, REC_HEIGHT)
  // Pad on the right to REC_MAX_WIDTH (zeros → neutral after normalization is not
  // exactly zero, but PP pads the RESIZED pixels with 0; toNchw leaves the pad
  // region at 0.0 which the CTC blank absorbs).
  const feed = toNchw(resized, REC_MAX_WIDTH, REC_HEIGHT, REC_MEAN, REC_STD_RECIP)
  const input = new l.ort.Tensor('float32', feed, [1, 3, REC_HEIGHT, REC_MAX_WIDTH])
  const outputs = await l.rec.run({ [l.rec.inputNames[0]]: input })
  const out = outputs[l.rec.outputNames[0]]
  const dims = out.dims // [1, T, C]
  const seqLen = dims[dims.length - 2]
  const numClasses = dims[dims.length - 1]
  const { text } = ctcDecode(out.data as Float32Array, seqLen, numClasses, l.dict)
  return text
}

export interface OcrLine {
  text: string
  box: [number, number, number, number]
  score: number
}

async function runPipeline(
  paths: { det: string; rec: string; dict: string },
  input: string | Uint8Array
): Promise<{ text: string; lines: OcrLine[] }> {
  const l = await loadOnce(paths)
  const img = await decode(l, input)
  const boxes = await detect(l, img)
  const lines: OcrLine[] = []
  for (const b of boxes) {
    let text: string
    try {
      const crop = await img.crop([b.x1, b.y1, b.x2, b.y2])
      text = await recognize(l, crop)
    } catch {
      text = ''
    }
    if (text) lines.push({ text, box: [b.x1, b.y1, b.x2, b.y2], score: b.score })
  }
  return { text: lines.map((li) => li.text).join('\n'), lines }
}

interface InitMessage {
  type: 'init'
  id: string
  det: string
  rec: string
  dict: string
}
interface OcrMessage {
  type: 'ocr'
  id: string
  det: string
  rec: string
  dict: string
  input: string | Uint8Array
}
interface DisposeMessage {
  type: 'dispose'
}
type Inbound = InitMessage | OcrMessage | DisposeMessage

async function handleInit(msg: InitMessage): Promise<void> {
  try {
    await loadOnce({ det: msg.det, rec: msg.rec, dict: msg.dict })
    post({ type: 'init:done', id: msg.id })
  } catch (err) {
    post({ type: 'error', id: msg.id, message: (err as Error)?.message ?? String(err) })
  }
}

async function handleOcr(msg: OcrMessage): Promise<void> {
  try {
    const result = await runPipeline({ det: msg.det, rec: msg.rec, dict: msg.dict }, msg.input)
    post({ type: 'ocr:done', id: msg.id, text: result.text, lines: result.lines })
  } catch (err) {
    post({ type: 'error', id: msg.id, message: (err as Error)?.message ?? String(err) })
  }
}

parentPort.on('message', (e: { data: Inbound }) => {
  const msg = e.data
  if (!msg || typeof msg !== 'object' || typeof (msg as { type?: string }).type !== 'string') return
  switch (msg.type) {
    case 'init':
      void handleInit(msg)
      break
    case 'ocr':
      void handleOcr(msg)
      break
    case 'dispose':
      // Drop the memo entirely so a re-init can pick up (possibly new) paths, and
      // release the ONNX sessions for GC — same effect as the old loadedP = null.
      loadedMemo = null
      break
  }
})
