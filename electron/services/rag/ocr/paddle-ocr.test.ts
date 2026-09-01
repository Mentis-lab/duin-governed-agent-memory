import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ctcDecode, dbPostprocess, sortBoxesReadingOrder, type DbBox } from './paddle-db'
import {
  loadPaddleDict,
  paddleModelsAvailable,
  resolvePaddleModels,
  requiredModelsApproxBytes
} from './paddle-catalog'
import {
  __resetPaddleOcr,
  __setPaddleWorkerFactory,
  paddleOcrImage
} from './paddle-ocr'
import { ocrEngine } from '../loaders/ocr'

// These tests exercise the DB/CTC decode (pure numeric), the model catalog
// resolver, the façade dispatch (with a FAKE worker — the real onnxruntime
// utilityProcess is integration-only), and the engine flag. No native ONNX or
// sharp is loaded here.

const ORIG_MODELS = process.env.DUIN_OCR_PADDLE_MODELS
const ORIG_ENGINE = process.env.DUIN_OCR_ENGINE

afterEach(() => {
  if (ORIG_MODELS === undefined) delete process.env.DUIN_OCR_PADDLE_MODELS
  else process.env.DUIN_OCR_PADDLE_MODELS = ORIG_MODELS
  if (ORIG_ENGINE === undefined) delete process.env.DUIN_OCR_ENGINE
  else process.env.DUIN_OCR_ENGINE = ORIG_ENGINE
  __resetPaddleOcr()
})

// ──────────────────── CTC decode ────────────────────

describe('ctcDecode (adapted from paddleocr.js, MIT)', () => {
  // Build a [seqLen*numClasses] logit buffer where each timestep's argmax is
  // `seq[t]` (that class gets a high score, the rest 0).
  function logitsFor(seq: number[], numClasses: number): Float32Array {
    const buf = new Float32Array(seq.length * numClasses)
    seq.forEach((cls, t) => {
      buf[t * numClasses + cls] = 10
    })
    return buf
  }

  it('collapses repeats and drops the CTC blank (dict WITHOUT blank)', () => {
    const dict = ['a', 'b', 'c'] // classes: 0=blank, 1=a, 2=b, 3=c
    const seq = [1, 1, 0, 2, 2, 3] // a,a(repeat),blank,b,b(repeat),c → "abc"
    const r = ctcDecode(logitsFor(seq, 4), seq.length, 4, dict)
    expect(r.text).toBe('abc')
    expect(r.confidence).toBeGreaterThan(0)
  })

  it('maps class indices directly when the dict CARRIES a leading blank', () => {
    const dict = ['', 'a', 'b'] // dictHasBlank → class c maps to dict[c]
    const seq = [1, 2, 2, 0, 1] // a,b,b(repeat),blank,a → "aba"
    const r = ctcDecode(logitsFor(seq, 3), seq.length, 3, dict)
    expect(r.text).toBe('aba')
  })

  it('returns empty text + zero confidence for an all-blank sequence', () => {
    const dict = ['a', 'b']
    const seq = [0, 0, 0]
    const r = ctcDecode(logitsFor(seq, 3), seq.length, 3, dict)
    expect(r).toEqual({ text: '', confidence: 0 })
  })
})

// ──────────────────── DB post-process ────────────────────

describe('dbPostprocess', () => {
  it('extracts a box around a bright region and scales to source coords', () => {
    const W = 20
    const H = 20
    const prob = new Float32Array(W * H) // all 0
    // Bright 6x6 block at (x=5..10, y=6..11).
    for (let y = 6; y <= 11; y++) {
      for (let x = 5; x <= 10; x++) prob[y * W + x] = 0.95
    }
    // srcW/srcH == map dims (scale 1) for an easy assertion.
    const boxes = dbPostprocess(prob, W, H, W, H)
    expect(boxes.length).toBe(1)
    const b = boxes[0]
    // Unclip expands the box outward, so it should CONTAIN the bright block.
    expect(b.x1).toBeLessThanOrEqual(5)
    expect(b.y1).toBeLessThanOrEqual(6)
    expect(b.x2).toBeGreaterThanOrEqual(10)
    expect(b.y2).toBeGreaterThanOrEqual(11)
    expect(b.score).toBeGreaterThan(0.6)
  })

  it('drops regions below the box-score threshold', () => {
    const W = 16
    const H = 16
    const prob = new Float32Array(W * H)
    // A block that clears the 0.3 binarize but not the 0.6 box-score mean.
    for (let y = 4; y <= 9; y++) {
      for (let x = 4; x <= 9; x++) prob[y * W + x] = 0.35
    }
    const boxes = dbPostprocess(prob, W, H, W, H)
    expect(boxes.length).toBe(0)
  })

  it('returns [] for an empty / degenerate map', () => {
    expect(dbPostprocess(new Float32Array(0), 0, 0, 10, 10)).toEqual([])
    expect(dbPostprocess(new Float32Array(100), 10, 10, 10, 10)).toEqual([])
  })

  it('scales boxes from map coords to a larger source image', () => {
    const W = 10
    const H = 10
    const prob = new Float32Array(W * H)
    for (let y = 2; y <= 7; y++) {
      for (let x = 2; x <= 7; x++) prob[y * W + x] = 0.9
    }
    const boxes = dbPostprocess(prob, W, H, 100, 100) // 10x upscale
    expect(boxes.length).toBe(1)
    // A box near (2..7) in map coords maps to ~(20..70) in source coords.
    expect(boxes[0].x2).toBeGreaterThan(50)
    expect(boxes[0].y2).toBeGreaterThan(50)
  })
})

describe('sortBoxesReadingOrder', () => {
  it('orders top-to-bottom then left-to-right within a line', () => {
    const boxes: DbBox[] = [
      { x1: 50, y1: 0, x2: 60, y2: 10, score: 1 }, // line 1, right
      { x1: 0, y1: 1, x2: 10, y2: 11, score: 1 }, // line 1, left
      { x1: 5, y1: 40, x2: 15, y2: 50, score: 1 } // line 2
    ]
    const sorted = sortBoxesReadingOrder(boxes)
    expect(sorted.map((b) => b.x1)).toEqual([0, 50, 5])
  })
})

// ──────────────────── catalog resolver ────────────────────

describe('paddle-catalog resolver', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'paddle-models-'))
  })
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('resolves a dir holding det + rec onnx + dict txt', () => {
    writeFileSync(join(dir, 'PP-OCRv5_mobile_det.onnx'), 'x')
    writeFileSync(join(dir, 'PP-OCRv5_mobile_rec.onnx'), 'x')
    writeFileSync(join(dir, 'ppocrv5_dict.txt'), 'a\nb\nc\n')
    process.env.DUIN_OCR_PADDLE_MODELS = dir
    const r = resolvePaddleModels()
    expect(r).not.toBeNull()
    expect(r!.det.endsWith('det.onnx')).toBe(true)
    expect(r!.rec.endsWith('rec.onnx')).toBe(true)
    expect(r!.dict.endsWith('ppocrv5_dict.txt')).toBe(true)
    expect(paddleModelsAvailable()).toBe(true)
  })

  it('returns null when rec or dict is missing', () => {
    writeFileSync(join(dir, 'det.onnx'), 'x')
    process.env.DUIN_OCR_PADDLE_MODELS = dir
    expect(resolvePaddleModels()).toBeNull()
    expect(paddleModelsAvailable()).toBe(false)
  })

  it('picks up an optional cls model when present', () => {
    writeFileSync(join(dir, 'det.onnx'), 'x')
    writeFileSync(join(dir, 'rec.onnx'), 'x')
    writeFileSync(join(dir, 'cls.onnx'), 'x')
    writeFileSync(join(dir, 'ppocrv5_dict.txt'), 'a\n')
    process.env.DUIN_OCR_PADDLE_MODELS = dir
    const r = resolvePaddleModels()
    expect(r!.cls?.endsWith('cls.onnx')).toBe(true)
  })

  it('loadPaddleDict preserves a trailing space entry and drops the EOF newline', () => {
    const p = join(dir, 'd.txt')
    writeFileSync(p, 'a\nb\n \n') // last real entry is a single space
    const d = loadPaddleDict(p)
    expect(d).toEqual(['a', 'b', ' '])
  })

  it('the required-models bundle is ~20MB', () => {
    const mb = requiredModelsApproxBytes() / (1024 * 1024)
    expect(mb).toBeGreaterThan(15)
    expect(mb).toBeLessThan(30)
  })
})

// ──────────────────── engine flag ────────────────────

describe('ocrEngine flag (DUIN_OCR_ENGINE, default tesseract)', () => {
  it('defaults to tesseract when unset / unrecognized', () => {
    delete process.env.DUIN_OCR_ENGINE
    expect(ocrEngine()).toBe('tesseract')
    process.env.DUIN_OCR_ENGINE = 'whatever'
    expect(ocrEngine()).toBe('tesseract')
  })
  it('selects paddle for DUIN_OCR_ENGINE=paddle (any case)', () => {
    process.env.DUIN_OCR_ENGINE = 'Paddle'
    expect(ocrEngine()).toBe('paddle')
  })
})

// ──────────────────── façade dispatch (fake worker) ────────────────────

describe('paddleOcrImage dispatch', () => {
  it('returns empty text WITHOUT spawning a worker when no models resolve', async () => {
    process.env.DUIN_OCR_PADDLE_MODELS = join(tmpdir(), 'definitely-not-a-models-dir')
    let spawned = false
    __setPaddleWorkerFactory(() => {
      spawned = true
      return { postMessage() {}, on() {}, terminate() {} }
    })
    const r = await paddleOcrImage(Buffer.from([1, 2, 3]))
    expect(r).toEqual({ text: '' })
    expect(spawned).toBe(false)
  })

  it('routes an OCR request to the worker and returns its result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paddle-models-'))
    writeFileSync(join(dir, 'det.onnx'), 'x')
    writeFileSync(join(dir, 'rec.onnx'), 'x')
    writeFileSync(join(dir, 'ppocrv5_dict.txt'), 'a\n')
    process.env.DUIN_OCR_PADDLE_MODELS = dir

    // A fake worker that answers every 'ocr' message with a fixed result.
    __setPaddleWorkerFactory(() => {
      let listener: ((m: unknown) => void) | null = null
      return {
        postMessage(msg: unknown) {
          const m = msg as { type: string; id: string }
          if (m.type === 'ocr') {
            queueMicrotask(() =>
              listener?.({
                type: 'ocr:done',
                id: m.id,
                text: 'hello 世界',
                lines: [{ text: 'hello 世界', box: [0, 0, 9, 9], score: 0.9 }]
              })
            )
          }
        },
        on(event: string, l: (a: unknown) => void) {
          if (event === 'message') listener = l
        },
        terminate() {}
      }
    })

    const r = await paddleOcrImage(Buffer.from([9, 9, 9]))
    expect(r.text).toBe('hello 世界')
    expect(r.lines?.[0].box).toEqual([0, 0, 9, 9])
    rmSync(dir, { recursive: true, force: true })
  })

  it('degrades to empty text when the worker reports an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paddle-models-'))
    writeFileSync(join(dir, 'det.onnx'), 'x')
    writeFileSync(join(dir, 'rec.onnx'), 'x')
    writeFileSync(join(dir, 'ppocrv5_dict.txt'), 'a\n')
    process.env.DUIN_OCR_PADDLE_MODELS = dir
    __setPaddleWorkerFactory(() => {
      let listener: ((m: unknown) => void) | null = null
      return {
        postMessage(msg: unknown) {
          const m = msg as { type: string; id: string }
          queueMicrotask(() => listener?.({ type: 'error', id: m.id, message: 'boom' }))
        },
        on(event: string, l: (a: unknown) => void) {
          if (event === 'message') listener = l
        },
        terminate() {}
      }
    })
    const r = await paddleOcrImage('some/path.png')
    expect(r).toEqual({ text: '' })
    rmSync(dir, { recursive: true, force: true })
  })
})
