import { randomUUID } from 'crypto'
import { resolvePaddleModels } from './paddle-catalog'
import type { OcrLine } from './paddle-worker'
import { messageOf } from '../../guarded'

// PaddleOCR (PP-OCRv5) engine façade — the OCR Tier-2 counterpart to
// embeddings/service.ts. Owns the lazily-spawned inference worker (an Electron
// utilityProcess, for native-segfault isolation) and exposes a single best-effort
// entry point, `paddleOcrImage`.
//
// Contract (identical spirit to the Tier-1 tesseract loader):
//   - LOCAL-FIRST / OFFLINE: models are read from the bundled/cached dir resolved
//     by paddle-catalog. No network at call time.
//   - BEST-EFFORT: ANY failure (models absent, worker crash, decode error,
//     timeout) resolves to `{ text: '' }`. OCR must NEVER throw into ingest.
//   - LAZY: the worker (native onnxruntime-node + ~21 MB of models) is spawned on
//     the first successful `paddleOcrImage` and reused thereafter.

export type { OcrLine } from './paddle-worker'
export { paddleModelsAvailable, resolvePaddleModels } from './paddle-catalog'

export interface PaddleOcrResult {
  text: string
  lines?: OcrLine[]
}

type Outbound =
  | { type: 'init:done'; id: string }
  | { type: 'ocr:done'; id: string; text: string; lines: OcrLine[] }
  | { type: 'error'; id: string; message: string }

interface WorkerLike {
  postMessage(msg: unknown): void
  on(event: 'message' | 'exit', listener: (arg: unknown) => void): void
  terminate(): void
}

interface Pending {
  resolve: (r: PaddleOcrResult) => void
  reject: (e: Error) => void
}

// Bound a single OCR call so a wedged native session can't hang ingest forever.
const OCR_TIMEOUT_MS = Number(process.env.DUIN_OCR_PADDLE_TIMEOUT_MS) || 30_000 // signal-lint-ignore: 0 means instant timeout, i.e. OCR could never complete

let worker: WorkerLike | null = null
const pending = new Map<string, Pending>()

// Test seam: inject a fake worker so the dispatch/decode contract can be exercised
// without spawning a real utilityProcess (which only exists in the main process).
let workerFactory: (() => WorkerLike) | null = null
/** Test-only: install a fake worker factory (or null to restore real spawn). */
export function __setPaddleWorkerFactory(factory: (() => WorkerLike) | null): void {
  workerFactory = factory
}

function handleMessage(raw: unknown): void {
  const msg = raw as Outbound
  if (!msg || typeof msg !== 'object' || typeof (msg as { type?: string }).type !== 'string') return
  if (msg.type === 'ocr:done') {
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p.resolve({ text: msg.text, lines: msg.lines })
    }
  } else if (msg.type === 'error') {
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p.reject(new Error(msg.message))
    }
  }
  // 'init:done' is fire-and-forget: we init on the same call we OCR.
}

function ensureWorker(): WorkerLike {
  if (worker) return worker
  worker = workerFactory ? workerFactory() : spawnRealWorker()
  worker.on('message', handleMessage)
  worker.on('exit', () => {
    // A native crash surfaces as an exit — reject every in-flight call and drop the
    // handle so the next call re-spawns cleanly.
    for (const [, p] of pending) p.reject(new Error('paddle-ocr worker exited'))
    pending.clear()
    worker = null
  })
  return worker
}

function spawnRealWorker(): WorkerLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { utilityProcess } = require('electron') as typeof import('electron')
  // require.resolve returns the app.asar VIRTUAL path in a packaged build; the
  // worker's native deps (onnxruntime-node, sharp) must load from REAL fs, so
  // redirect to the asarUnpack'd copy (electron-builder.yml). No-op in dev.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const resolved = require.resolve('./paddle-worker.js')
  const workerPath = resolved.includes('app.asar')
    ? resolved.replace('app.asar', 'app.asar.unpacked')
    : resolved
  const child = utilityProcess.fork(workerPath, [], { serviceName: 'duin-paddle-ocr' })
  return {
    postMessage: (m: unknown) => child.postMessage(m),
    on: (event, listener) => {
      ;(child as unknown as { on(e: string, l: (a: unknown) => void): void }).on(event, listener)
    },
    terminate: () => {
      child.kill()
    }
  }
}

/**
 * OCR an image with the PaddleOCR PP-OCRv5 engine. BEST-EFFORT: returns
 * `{ text: '' }` on ANY failure and never throws.
 *
 * @param input a file path OR an in-memory image Buffer.
 */
export async function paddleOcrImage(input: Buffer | string): Promise<PaddleOcrResult> {
  try {
    const models = resolvePaddleModels()
    if (!models) return { text: '' } // no bundled models → degrade (offline safe)

    // Transfer a Buffer as a plain Uint8Array (structured-clone friendly); a path
    // goes across as a string and is read inside the worker.
    const payload: string | Uint8Array =
      typeof input === 'string' ? input : new Uint8Array(input)

    const w = ensureWorker()
    const id = randomUUID()
    const result = await new Promise<PaddleOcrResult>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error('paddle-ocr timed out'))
      }, OCR_TIMEOUT_MS)
      // Ensure the timer never keeps the process alive.
      if (typeof timer.unref === 'function') timer.unref()
      w.postMessage({
        type: 'ocr',
        id,
        det: models.det,
        rec: models.rec,
        dict: models.dict,
        input: payload
      })
    })
    return result
  } catch {
    // Swallow — ingest treats an unreadable image as a 0-chunk viewable doc.
    return { text: '' }
  }
}

/** Terminate the lazily-spawned worker (best-effort; for app shutdown / tests). */
export async function terminatePaddleOcr(): Promise<void> {
  const w = worker
  worker = null
  for (const [, p] of pending) p.reject(new Error('paddle-ocr disposed'))
  pending.clear()
  try {
    w?.terminate()
  } catch (e) { console.debug('[paddle-ocr] ignore:', messageOf(e)) }
}

/** Test-only: reset module state (worker handle, pending, factory). */
export function __resetPaddleOcr(): void {
  worker = null
  pending.clear()
  workerFactory = null
}
