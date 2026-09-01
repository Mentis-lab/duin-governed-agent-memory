import { readFile } from 'fs/promises'
import { ocrEnabled } from './ocr'
import { rasterizePdfPages } from './pdf-raster'
import { messageOf } from '../../guarded'

// PDF loader. Uses `pdf-parse` to extract per-page text. Returns one page
// record per page so the chunker can stamp the `page` column on each chunk.
//
// Failure modes that get explicit error messages:
//   - Encrypted PDFs (`pdf-parse` throws on these).
//   - Scanned PDFs (no extractable text) — fall through and check the
//     total text length post-extraction.
//
// Scanned-PDF OCR seam (Tier 2): when a PDF yields little/no extractable text AND
// OCR is enabled, we rasterize each page to an image and OCR it (routing through
// the engine selector — paddle or tesseract). See `maybeOcrScannedPdf`.

export interface LoadedPdf {
  pages: { page: number; text: string }[]
  mime: 'application/pdf'
}

// pdf-parse v2 API: a `PDFParse` CLASS (v1 was a callable `pdfParse(buffer)`).
// `new PDFParse({ data }).getText()` → `{ pages: [{num, text}], text }`. The v1
// callable/pagerender interface no longer exists — calling the module as a
// function threw "pdfParse is not a function", which is what broke every PDF
// ingest after the v2 bump.
interface PDFParseTextResult {
  pages: { num: number; text: string }[]
  text: string
}
interface PDFParseInstance {
  getText: () => Promise<PDFParseTextResult>
  destroy?: () => Promise<void> | void
}
interface PDFParseCtor {
  new (opts: { data: Uint8Array; password?: string }): PDFParseInstance
}

export async function loadPdf(path: string): Promise<LoadedPdf> {
  const buf = await readFile(path)
  // Late require so tests that don't exercise this path don't pull pdf-parse
  // (and its pdfjs worker) into their module graph.
  let PDFParse: PDFParseCtor
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    PDFParse = (require('pdf-parse') as { PDFParse: PDFParseCtor }).PDFParse
    if (typeof PDFParse !== 'function') throw new Error('PDFParse export missing')
  } catch (err) {
    throw new Error(
      `pdf-parse unavailable: ${(err as Error)?.message ?? 'unknown'}`,
      { cause: err }
    )
  }

  let result: PDFParseTextResult
  // A fresh Uint8Array (not the Buffer itself): v2 may transfer the typed array
  // to its worker and take ownership, which would detach a reused buffer.
  const parser = new PDFParse({ data: new Uint8Array(buf) })
  try {
    result = await parser.getText()
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    if (/password|encrypted/i.test(msg)) {
      throw new Error('PDF is encrypted', { cause: err })
    }
    throw new Error(`PDF parse failed: ${msg}`, { cause: err })
  } finally {
    // Free the underlying pdfjs worker/document. Best-effort.
    try {
      await parser.destroy?.()
    } catch (e) { console.debug('[pdf] ignore cleanup errors:', messageOf(e)) }
  }

  // v2 gives page-wise text with 1-based `num`; keep the chunker's `page` shape.
  let pages = (result.pages ?? []).map((p) => ({
    page: p.num,
    text: cleanPageText(p.text ?? '')
  }))

  // Scanned-PDF OCR seam (Tier 2): if the text layer is empty/near-empty AND OCR
  // is enabled, try to recover text by rasterizing + OCR-ing each page. Best-effort
  // — any failure leaves `pages` exactly as extracted.
  if (ocrEnabled() && isScannedPdf(pages)) {
    pages = await maybeOcrScannedPdf(buf, pages)
  }

  // Extraction is BEST-EFFORT: a scanned / text-layerless PDF yields little or
  // no text. Do NOT throw — return what we have so ingest stores it as a
  // viewable (ready, 0-chunk) doc rather than a hard "error". The viewer reads
  // the original file from disk independently of extraction (rag:document:file),
  // so a scanned PDF still opens and renders; it just isn't searchable. Genuine
  // failures (encrypted / corrupt) already threw above.
  return { pages, mime: 'application/pdf' }
}

function cleanPageText(s: string): string {
  // Strip form feed (U+000C) and collapse 3+ newlines into 2.
  return s.replace(/\f/g, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** A PDF is "scanned" (image-only, no usable text layer) when its extracted text
 *  averages fewer than ~8 characters per page. Cheap heuristic — a genuine text
 *  PDF blows past this immediately. */
export function isScannedPdf(pages: { page: number; text: string }[]): boolean {
  if (pages.length === 0) return false
  const total = pages.reduce((n, p) => n + p.text.length, 0)
  return total < pages.length * 8
}

/**
 * Rasterize + OCR a scanned PDF's pages. BEST-EFFORT: returns the OCR'd pages when
 * rasterization succeeds, otherwise the original `pages` untouched.
 *
 * ── PDF RASTERIZATION (Tier 2, landed) ───────────────────────────────────────
 * `rasterizePdfPages` (see ./pdf-raster) renders each page to a PNG via the
 * pdfjs-dist LEGACY build + its built-in Node canvas factory (backed by the
 * prebuilt native @napi-rs/canvas). Both deps are declared and externalized, so
 * the rasterizer is bundleable and lazy — the pdfjs/canvas graph only loads the
 * first time a scanned PDF with OCR enabled is actually hit. Any failure there
 * returns null, and this function then keeps `pages` exactly as extracted, so a
 * scanned PDF still degrades to a 0-chunk viewable doc with no regression.
 */
async function maybeOcrScannedPdf(
  buf: Buffer,
  pages: { page: number; text: string }[]
): Promise<{ page: number; text: string }[]> {
  try {
    const images = await rasterizePdfPages(buf)
    if (!images) return pages // no rasterizer available (TODO) → unchanged
    // Lazy import so the tesseract/paddle module graph is only pulled when we
    // actually have page images to OCR.
    const { ocrImage } = await import('./ocr')
    const out: { page: number; text: string }[] = []
    for (let i = 0; i < images.length; i++) {
      const { text } = await ocrImage(images[i])
      out.push({ page: i + 1, text: cleanPageText(text) })
    }
    return out
  } catch {
    return pages
  }
}
