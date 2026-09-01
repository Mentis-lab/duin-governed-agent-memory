import { dirname, join } from 'path'
import { messageOf } from '../../guarded'

// PDF → image rasterizer (Tier 2, scanned-PDF OCR). Renders each page of a PDF
// to a PNG Buffer so the caller can OCR image-only / text-layerless PDFs.
//
// WHY THIS IS A SEPARATE MODULE:
//   pdfjs-dist + @napi-rs/canvas are HEAVY (a multi-MB PDF engine and a native
//   Skia canvas). Isolating the glue here keeps pdf.ts's fast text path free of
//   that graph, and lets tests mock the pdfjs ESM module in one place.
//
// HOW IT STAYS LAZY / BUNDLEABLE:
//   - Both pdfjs-dist and @napi-rs/canvas are declared `dependencies`, so
//     electron-vite's `externalizeDepsPlugin()` leaves them as runtime
//     `require`/`import` (never bundled) — the huge pdf.mjs and the native
//     .node binary ship in the packaged node_modules untouched by the bundler.
//   - pdfjs is pulled via a `import()` INSIDE rasterizePdfPages, so nothing
//     loads unless a scanned PDF with OCR enabled is actually hit.
//   - We use the LEGACY build (`pdfjs-dist/legacy/build/pdf.mjs`): it runs
//     without a DOM and, in Node, auto-selects its built-in `NodeCanvasFactory`
//     (which itself `require`s `@napi-rs/canvas`) and a main-thread "fake
//     worker" — no worker asset wiring, no browser globals needed.
//
// BEST-EFFORT: any failure (bad PDF, missing native canvas, wasm decode error)
// resolves to `null`, so the caller degrades to the original (untouched) pages
// exactly as before this path existed.

/** Hard cap on pages rasterized per PDF — bounds runaway work/memory on a huge
 *  scan. A 50-page scan already yields plenty of OCR text; beyond that the cost
 *  isn't worth it for a best-effort index. */
export const MAX_RASTER_PAGES = 50

/** Render scale. PDF user space is 72 DPI; scale 2.0833 ≈ 150 DPI, a good
 *  legibility/size trade-off for OCR (higher DPI helps small type but balloons
 *  the PNG and OCR time). Overridable via `DUIN_OCR_PDF_DPI`. */
function renderScale(): number {
  const dpi = Number.parseInt((process.env.DUIN_OCR_PDF_DPI ?? '').trim(), 10)
  const effective = Number.isFinite(dpi) && dpi >= 72 && dpi <= 600 ? dpi : 150
  return effective / 72
}

// ── Minimal structural types for the bits of pdfjs we touch ──────────────────
// The legacy build ships full .d.ts, but its canvas types assume the DOM
// (HTMLCanvasElement / CanvasRenderingContext2D) while we run against a native
// @napi-rs/canvas that only duck-types those. Rather than fight the mismatch we
// pin a narrow surface and cast the imported module to it.
interface NapiCanvas {
  toBuffer(mime: 'image/png'): Buffer
  width: number
  height: number
}
interface CanvasAndContext {
  canvas: NapiCanvas
  context: unknown
}
interface CanvasFactory {
  create(width: number, height: number): CanvasAndContext
  destroy(canvasAndContext: CanvasAndContext): void
}
interface PdfViewport {
  width: number
  height: number
}
interface PdfPage {
  getViewport(opts: { scale: number }): PdfViewport
  render(opts: {
    canvasContext: unknown
    canvas: unknown
    viewport: PdfViewport
  }): { promise: Promise<void> }
  cleanup(): void
}
interface PdfDocument {
  numPages: number
  canvasFactory: CanvasFactory
  getPage(n: number): Promise<PdfPage>
}
interface PdfLoadingTask {
  promise: Promise<PdfDocument>
  destroy(): Promise<void>
}
interface PdfjsModule {
  getDocument(src: Record<string, unknown>): PdfLoadingTask
  GlobalWorkerOptions: { workerSrc?: string }
}

/** Locate a pdfjs-dist asset directory (e.g. `wasm`, `standard_fonts`) as a
 *  filesystem path with a trailing slash — the shape pdfjs's Node binary data
 *  factory expects. pdfjs (a) VALIDATES a trailing slash (`getFactoryUrlProp`
 *  throws "must include trailing slash" otherwise) and (b) builds each asset URL
 *  by STRING concat (`${baseUrl}${filename}`) then `fs.readFile(url)`. So this
 *  must be a FORWARD-slash filesystem path ending in '/':
 *    - a Windows back-slash path (`join`'s native `\`) fails pdfjs's URL
 *      validation → getDocument throws → best-effort null → scanned PDFs get
 *      NO OCR on Windows (the bug this normalizes away);
 *    - a `file://` URL passes validation but `fs.readFile('file://…')` reads it
 *      as a literal path → ENOENT for scans that need JBIG2/JPX/standard fonts.
 *  Returns undefined if pdfjs can't be resolved, in which case we omit the option
 *  and let pdfjs fall back (only PDFs that actually need those assets are
 *  affected — most scans aren't). */
function pdfjsAssetDir(sub: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require.resolve('pdfjs-dist/package.json')
    return join(dirname(pkg), sub).replace(/\\/g, '/') + '/'
  } catch {
    return undefined
  }
}

/**
 * Rasterize up to {@link MAX_RASTER_PAGES} pages of a PDF to PNG Buffers, one per
 * page (index 0 = page 1). Returns `null` on ANY failure — the caller treats
 * null as "no rasterizer output" and keeps the original extracted pages.
 */
export async function rasterizePdfPages(buf: Buffer): Promise<Buffer[] | null> {
  let loadingTask: PdfLoadingTask | undefined
  try {
    // Lazy ESM import of the LEGACY (DOM-less) build. Kept as a runtime import
    // (pdfjs is externalized) so the engine only loads when a scanned PDF is hit.
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule

    const wasmUrl = pdfjsAssetDir('wasm')
    const standardFontDataUrl = pdfjsAssetDir('standard_fonts')

    loadingTask = pdfjs.getDocument({
      // Fresh Uint8Array: pdfjs may take ownership of / detach the backing buffer.
      data: new Uint8Array(buf),
      // No arbitrary JS eval — hardening; we never need it for rasterization.
      isEvalSupported: false,
      // Silence pdfjs's console spam (incl. the "Setting up fake worker" warn).
      verbosity: 0,
      // Give the Node binary-data factory local asset dirs so image codecs
      // (JBIG2/JPX via wasm) and the standard-14 fonts resolve offline. Omitted
      // silently if pdfjs can't be located — best-effort.
      ...(wasmUrl ? { wasmUrl } : {}),
      ...(standardFontDataUrl ? { standardFontDataUrl } : {})
    })

    const doc = await loadingTask.promise
    const pageCount = Math.min(doc.numPages, MAX_RASTER_PAGES)
    if (pageCount <= 0) return null

    const factory = doc.canvasFactory
    const out: Buffer[] = []
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n)
      const viewport = page.getViewport({ scale: renderScale() })
      const cc = factory.create(viewport.width, viewport.height)
      try {
        // canvasContext (+ canvas) is the Node render path: pdfjs draws the page
        // into the native @napi-rs/canvas 2D context, which we then encode.
        await page.render({ canvasContext: cc.context, canvas: cc.canvas, viewport }).promise
        out.push(cc.canvas.toBuffer('image/png'))
      } finally {
        factory.destroy(cc)
        page.cleanup()
      }
    }
    return out.length > 0 ? out : null
  } catch {
    // Best-effort: any failure → null (no regression; caller keeps orig pages).
    return null
  } finally {
    try {
      await loadingTask?.destroy()
    } catch (e) { console.debug('[pdf-raster] ignore cleanup errors:', messageOf(e)) }
  }
}
