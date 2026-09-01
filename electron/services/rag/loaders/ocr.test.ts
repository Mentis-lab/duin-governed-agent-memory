import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  OCR_IMAGE_EXTENSIONS,
  isImageExtension,
  imageMime,
  ocrEnabled,
  ocrImage
} from './ocr'
import { loadDocument } from './index'
import { isIngestable } from '../../local-brain/index-store'

// Mock tesseract.js so the heavy WASM worker is NEVER loaded. ocr.ts lazily
// `require`s the module inside createWorkerFor(); a hoisted vi.mock intercepts
// that require. Tests that don't resolve a tessdata dir return before this is
// ever touched.
const { mockCreateWorker } = vi.hoisted(() => ({ mockCreateWorker: vi.fn() }))
vi.mock('tesseract.js', () => ({ createWorker: mockCreateWorker }))

// Mock the PaddleOCR façade so the paddle branch of ocrImage can be exercised
// without spawning a utilityProcess. paddleOcrImage is best-effort and NEVER
// rejects — a paddle failure resolves to { text: '' } — which is exactly the
// condition the fallback-to-tesseract test below depends on.
const { mockPaddleModelsAvailable, mockPaddleOcrImage } = vi.hoisted(() => ({
  mockPaddleModelsAvailable: vi.fn(),
  mockPaddleOcrImage: vi.fn()
}))
vi.mock('../ocr/paddle-ocr', () => ({
  paddleModelsAvailable: mockPaddleModelsAvailable,
  paddleOcrImage: mockPaddleOcrImage
}))

// The heavy tesseract.js WASM worker is NEVER exercised here — we mock the module
// so the dispatch + flag-gating + best-effort contract is tested fast and
// deterministically. (A real recognize run is integration-only.)

const ORIGINAL_DUIN_OCR = process.env.DUIN_OCR
const ORIGINAL_TESSDATA = process.env.DUIN_OCR_TESSDATA
const ORIGINAL_ENGINE = process.env.DUIN_OCR_ENGINE

afterEach(() => {
  if (ORIGINAL_DUIN_OCR === undefined) delete process.env.DUIN_OCR
  else process.env.DUIN_OCR = ORIGINAL_DUIN_OCR
  if (ORIGINAL_TESSDATA === undefined) delete process.env.DUIN_OCR_TESSDATA
  else process.env.DUIN_OCR_TESSDATA = ORIGINAL_TESSDATA
  if (ORIGINAL_ENGINE === undefined) delete process.env.DUIN_OCR_ENGINE
  else process.env.DUIN_OCR_ENGINE = ORIGINAL_ENGINE
})

// ──────────────────── extension classification ────────────────────

describe('image extension classification', () => {
  it('recognizes the OCR image extensions', () => {
    for (const ext of OCR_IMAGE_EXTENSIONS) {
      expect(isImageExtension(`shot${ext}`)).toBe(true)
      expect(isImageExtension(`SHOT${ext.toUpperCase()}`)).toBe(true) // case-insensitive
    }
  })

  it('rejects non-image extensions', () => {
    expect(isImageExtension('note.md')).toBe(false)
    expect(isImageExtension('scan.pdf')).toBe(false)
    expect(isImageExtension('noext')).toBe(false)
  })

  it('maps extensions to image mimes', () => {
    expect(imageMime('a.png')).toBe('image/png')
    expect(imageMime('a.JPG')).toBe('image/jpeg')
    expect(imageMime('a.jpeg')).toBe('image/jpeg')
    expect(imageMime('a.tif')).toBe('image/tiff')
    expect(imageMime('a.tiff')).toBe('image/tiff')
  })
})

// ──────────────────── feature flag ────────────────────

describe('ocrEnabled (default ON, settings-backed, DUIN_OCR overrides)', () => {
  it('defaults ON when the env var is unset (settings fallback; no settings.json in tests → default)', () => {
    // No electron `app` under vitest → readSettings() sees no file and returns
    // {}, so ocrEnabled falls to its default: ON.
    delete process.env.DUIN_OCR
    expect(ocrEnabled()).toBe(true)
  })

  it('treats an empty env var as "unset" and follows the setting (default ON)', () => {
    process.env.DUIN_OCR = ''
    expect(ocrEnabled()).toBe(true)
  })

  it('env OFF override wins over the default (0/false/off/no) — force-off for debug', () => {
    for (const v of ['0', 'false', 'off', 'no', 'nope']) {
      process.env.DUIN_OCR = v
      expect(ocrEnabled()).toBe(false)
    }
  })

  it('env ON override for 1/true/on/yes (any case)', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'Yes']) {
      process.env.DUIN_OCR = v
      expect(ocrEnabled()).toBe(true)
    }
  })
})

// ──────────────────── dispatcher gating ────────────────────

describe('loadDocument image gating', () => {
  it('does NOT intercept images when OCR is force-off via DUIN_OCR=0', async () => {
    process.env.DUIN_OCR = '0'
    await expect(loadDocument('screenshot.png')).rejects.toThrow(/Unsupported/i)
  })

  it('routes images through OCR when enabled (default ON, or DUIN_OCR=1)', async () => {
    process.env.DUIN_OCR = '1'
    process.env.DUIN_OCR_TESSDATA = '/definitely/not/a/real/tessdata/dir'
    // No tessdata dir resolvable → best-effort empty text, and importantly it
    // resolves as a `text` doc (kind), never throws.
    const r = await loadDocument('screenshot.png')
    expect(r.kind).toBe('text')
    if (r.kind === 'text') {
      expect(r.text).toBe('')
      expect(r.mime).toBe('image/png')
    }
  })
})

// ──────────────────── isIngestable gating (flag-off == today) ────────────────────

describe('isIngestable image gating', () => {
  it('images are NOT ingestable when OCR is force-off via DUIN_OCR=0', () => {
    process.env.DUIN_OCR = '0'
    expect(isIngestable('a.png')).toBe(false)
    expect(isIngestable('a.jpg')).toBe(false)
    // non-image ingestables are unaffected
    expect(isIngestable('a.md')).toBe(true)
    expect(isIngestable('a.pdf')).toBe(true)
  })

  it('images ARE ingestable when OCR is enabled (default ON, or DUIN_OCR=1)', () => {
    process.env.DUIN_OCR = '1'
    expect(isIngestable('a.png')).toBe(true)
    expect(isIngestable('a.jpeg')).toBe(true)
    expect(isIngestable('a.tiff')).toBe(true)
  })
})

// ──────────────────── ocrImage best-effort ────────────────────

describe('ocrImage best-effort contract', () => {
  it('returns empty text (never throws) when no usable tessdata dir resolves', async () => {
    // Override points at a nonexistent dir; the repo's resources/ocr/tessdata
    // holds only a .gitkeep (no .traineddata), so resolveTessdataDir yields null
    // and ocrImage degrades WITHOUT ever spinning the real WASM worker.
    process.env.DUIN_OCR_TESSDATA = '/definitely/not/a/real/tessdata/dir'
    const r = await ocrImage(Buffer.from([0, 1, 2, 3]))
    expect(r).toEqual({ text: '' })
  })
})

// ──────────────────── ocrImage with a mocked worker ────────────────────

describe('ocrImage with a mocked tesseract worker', () => {
  let tessDir: string

  beforeEach(() => {
    mockCreateWorker.mockReset()
    process.env.DUIN_OCR = '1'
    // A real dir containing a dummy `.traineddata` so resolveTessdataDir resolves
    // it — but tesseract.js is mocked, so the file is never actually parsed. A
    // fresh dir per test also keeps ocr.ts's per-langs@dir worker cache distinct.
    tessDir = mkdtempSync(join(tmpdir(), 'ocr-tessdata-'))
    writeFileSync(join(tessDir, 'eng.traineddata'), 'dummy')
    process.env.DUIN_OCR_TESSDATA = tessDir
  })

  afterEach(() => {
    if (existsSync(tessDir)) rmSync(tessDir, { recursive: true, force: true })
  })

  it('maps a successful recognize to trimmed text', async () => {
    mockCreateWorker.mockResolvedValue({
      recognize: vi.fn(async () => ({ data: { text: '  hello 世界  \n' } })),
      terminate: vi.fn(async () => {})
    })
    const r = await ocrImage(Buffer.from([9, 9, 9]))
    expect(r.text).toBe('hello 世界')
    expect(mockCreateWorker).toHaveBeenCalledWith(
      'eng+chi_sim+jpn',
      1, // OEM.LSTM_ONLY
      expect.objectContaining({ langPath: tessDir, cacheMethod: 'none', gzip: false })
    )
  })

  it('swallows a recognize/worker failure and returns empty text', async () => {
    mockCreateWorker.mockRejectedValue(new Error('worker boom'))
    const r = await ocrImage(Buffer.from([1]))
    expect(r).toEqual({ text: '' })
  })
})

// ──────────────────── paddle → tesseract fallback ────────────────────
//
// Regression guard: paddleOcrImage is best-effort and NEVER throws — an
// unhealthy paddle engine (worker crash, timeout, decode error) resolves to
// { text: '' }, not a rejection. The old code returned that empty result
// directly (relying on a dead catch), so a user who opted into paddle got ZERO
// text from every image whenever paddle was unhealthy. ocrImage must instead
// branch on the paddle RESULT and fall through to tesseract on empty text.

describe('ocrImage paddle → tesseract fallback', () => {
  let tessDir: string

  beforeEach(() => {
    mockCreateWorker.mockReset()
    mockPaddleModelsAvailable.mockReset()
    mockPaddleOcrImage.mockReset()
    process.env.DUIN_OCR = '1'
    process.env.DUIN_OCR_ENGINE = 'paddle'
    tessDir = mkdtempSync(join(tmpdir(), 'ocr-tessdata-'))
    writeFileSync(join(tessDir, 'eng.traineddata'), 'dummy')
    process.env.DUIN_OCR_TESSDATA = tessDir
  })

  afterEach(() => {
    if (existsSync(tessDir)) rmSync(tessDir, { recursive: true, force: true })
  })

  it('falls through to tesseract when paddle resolves empty text (paddle unhealthy)', async () => {
    // paddle is selected, models present, but the engine yields no text WITHOUT
    // throwing (its documented best-effort behaviour). The fallback MUST fire.
    mockPaddleModelsAvailable.mockReturnValue(true)
    mockPaddleOcrImage.mockResolvedValue({ text: '' })
    mockCreateWorker.mockResolvedValue({
      recognize: vi.fn(async () => ({ data: { text: 'tesseract saved it' } })),
      terminate: vi.fn(async () => {})
    })
    const r = await ocrImage(Buffer.from([9, 9, 9]))
    expect(r.text).toBe('tesseract saved it')
    expect(mockCreateWorker).toHaveBeenCalled() // tesseract path was reached
  })

  it('short-circuits on a successful paddle extraction (no tesseract call)', async () => {
    mockPaddleModelsAvailable.mockReturnValue(true)
    mockPaddleOcrImage.mockResolvedValue({ text: 'paddle 世界' })
    const r = await ocrImage(Buffer.from([9, 9, 9]))
    expect(r.text).toBe('paddle 世界')
    expect(mockCreateWorker).not.toHaveBeenCalled() // tesseract never spun up
  })
})
