import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_RASTER_PAGES, rasterizePdfPages } from './pdf-raster'

// Mock the pdfjs LEGACY ESM build so no real PDF engine / native canvas / wasm
// is ever loaded. rasterizePdfPages does `await import('pdfjs-dist/legacy/build/
// pdf.mjs')`; this hoisted mock intercepts that import. We assert the
// render→encode flow, the page cap, and the best-effort (null-on-failure)
// contract without any I/O.
const { mockGetDocument } = vi.hoisted(() => ({ mockGetDocument: vi.fn() }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: mockGetDocument
}))

// Build a fake pdfjs document whose pages each encode to a distinct PNG buffer,
// so the returned array's order/length is observable.
function fakeDoc(numPages: number, opts?: { renderThrowsOnPage?: number }) {
  const created: Array<{ destroyed: boolean }> = []
  const getPage = vi.fn(async (n: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
    render: ({ viewport }: { viewport: { width: number; height: number } }) => ({
      promise: (async () => {
        if (opts?.renderThrowsOnPage === n) throw new Error('render boom')
        // touch viewport so the fake mirrors the real call shape
        void viewport.width
      })()
    }),
    cleanup: vi.fn()
  }))
  const canvasFactory = {
    create: (_w: number, _h: number) => {
      const cc = {
        destroyed: false,
        canvas: { width: _w, height: _h, toBuffer: (_m: string) => Buffer.from(`png`) },
        context: {}
      }
      created.push(cc)
      return cc
    },
    destroy: (cc: { destroyed: boolean }) => {
      cc.destroyed = true
    }
  }
  const destroy = vi.fn(async () => {})
  const loadingTask = { promise: Promise.resolve({ numPages, canvasFactory, getPage }), destroy }
  return { loadingTask, getPage, destroy, created }
}

afterEach(() => {
  mockGetDocument.mockReset()
})

describe('rasterizePdfPages', () => {
  it('renders every page to a PNG buffer (index 0 = page 1)', async () => {
    const { loadingTask, getPage, destroy } = fakeDoc(3)
    mockGetDocument.mockReturnValue(loadingTask)

    const out = await rasterizePdfPages(Buffer.from('%PDF-'))
    expect(out).not.toBeNull()
    expect(out).toHaveLength(3)
    expect(out!.every((b) => Buffer.isBuffer(b))).toBe(true)
    // pages requested 1..3 in order
    expect(getPage.mock.calls.map((c) => c[0])).toEqual([1, 2, 3])
    // loading task always torn down
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('passes a fresh Uint8Array of the PDF bytes to getDocument (never the Buffer)', async () => {
    const { loadingTask } = fakeDoc(1)
    mockGetDocument.mockReturnValue(loadingTask)

    await rasterizePdfPages(Buffer.from([1, 2, 3]))
    const src = mockGetDocument.mock.calls[0][0]
    expect(src.data).toBeInstanceOf(Uint8Array)
    expect(Buffer.isBuffer(src.data)).toBe(false)
    expect(src.isEvalSupported).toBe(false)
  })

  it('passes pdfjs asset dirs as forward-slash paths WITH a trailing slash (Windows regression)', async () => {
    // pdfjs 6.x (a) validates a trailing slash (`getFactoryUrlProp` throws
    // otherwise) and (b) reads assets via `fs.readFile(`${baseUrl}${filename}`)`.
    // A Windows back-slash path fails (a) → getDocument throws → scanned PDFs get
    // NO OCR on Windows; a file:// URL fails (b). Both asset dirs must therefore
    // be forward-slash FS paths ending in '/'.
    const { loadingTask } = fakeDoc(1)
    mockGetDocument.mockReturnValue(loadingTask)

    await rasterizePdfPages(Buffer.from('%PDF-'))
    const src = mockGetDocument.mock.calls[0][0]
    for (const key of ['wasmUrl', 'standardFontDataUrl'] as const) {
      // Present because pdfjs-dist resolves in the test env; if ever absent the
      // option is omitted (best-effort) — only assert the shape when provided.
      if (src[key] == null) continue
      expect(src[key].endsWith('/'), `${key} must end with '/'`).toBe(true)
      expect(src[key].includes('\\'), `${key} must not contain a backslash`).toBe(false)
      expect(src[key].startsWith('file:'), `${key} must be a path, not a file:// URL`).toBe(false)
    }
  })

  it('caps rasterization at MAX_RASTER_PAGES for a huge PDF', async () => {
    const { loadingTask, getPage } = fakeDoc(MAX_RASTER_PAGES + 25)
    mockGetDocument.mockReturnValue(loadingTask)

    const out = await rasterizePdfPages(Buffer.from('%PDF-'))
    expect(out).toHaveLength(MAX_RASTER_PAGES)
    expect(getPage).toHaveBeenCalledTimes(MAX_RASTER_PAGES)
  })

  it('destroys each per-page canvas (no native canvas leak)', async () => {
    const { loadingTask, created } = fakeDoc(2)
    mockGetDocument.mockReturnValue(loadingTask)

    await rasterizePdfPages(Buffer.from('%PDF-'))
    expect(created).toHaveLength(2)
    expect(created.every((c) => c.destroyed)).toBe(true)
  })

  it('is best-effort: returns null when getDocument throws', async () => {
    mockGetDocument.mockImplementation(() => {
      throw new Error('not a pdf')
    })
    expect(await rasterizePdfPages(Buffer.from('garbage'))).toBeNull()
  })

  it('is best-effort: returns null when a page render fails', async () => {
    const { loadingTask, destroy } = fakeDoc(3, { renderThrowsOnPage: 2 })
    mockGetDocument.mockReturnValue(loadingTask)

    expect(await rasterizePdfPages(Buffer.from('%PDF-'))).toBeNull()
    // still cleaned up the loading task even on the failure path
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('returns null for a zero-page document', async () => {
    const { loadingTask } = fakeDoc(0)
    mockGetDocument.mockReturnValue(loadingTask)
    expect(await rasterizePdfPages(Buffer.from('%PDF-'))).toBeNull()
  })
})
