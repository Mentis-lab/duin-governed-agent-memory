import { extname, basename } from 'path'
import { readFile } from 'fs/promises'
import JSZip from 'jszip'

// Apple iWork loader (P3). iWork bundles (.pages/.numbers/.key) are ZIPs.
// The honest state of OSS support (offline, license-clean):
//   - iWork '08/'09 with "include preview" ON → a full QuickLook/Preview.pdf is
//     embedded → we extract + pdf-parse it for real text.
//   - Modern 2013+ bundles → IWA/protobuf streams with NO embedded PDF, only
//     JPEG previews. There is no production Node text parser (numbers-parser /
//     keynote-parser are a Python-sidecar follow-up). So we index the document
//     by title (it still becomes a searchable node) and expose the first-page
//     JPEG preview for viewing. `.pages` modern has no text path at all.
// This degrades gracefully instead of throwing on an unsupported bundle.

const IWORK_EXTS = new Set(['.pages', '.numbers', '.key'])

const MIME: Record<string, string> = {
  '.pages': 'application/vnd.apple.pages',
  '.numbers': 'application/vnd.apple.numbers',
  '.key': 'application/vnd.apple.keynote'
}

export function isIWorkExtension(name: string): boolean {
  return IWORK_EXTS.has(extname(name).toLowerCase())
}

export interface LoadedIWork {
  text: string
  mime: string
}

/** First-match file whose name matches `re` anywhere in the zip. */
function firstMatch(zip: JSZip, re: RegExp): JSZip.JSZipObject | null {
  const hits = zip.file(re)
  return hits && hits.length > 0 ? hits[0] : null
}

export async function loadIWork(path: string): Promise<LoadedIWork> {
  const ext = extname(path).toLowerCase()
  const mime = MIME[ext] ?? 'application/octet-stream'
  const title = basename(path, ext)

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(await readFile(path))
  } catch {
    // A flat-file (non-zip) legacy iWork doc — nothing to extract; index by title.
    return { text: title, mime }
  }

  // Best case: an embedded full PDF preview (iWork '08/'09) → real text.
  const pdfEntry = zip.file('QuickLook/Preview.pdf') ?? firstMatch(zip, /(^|\/)Preview\.pdf$/i)
  if (pdfEntry) {
    try {
      const buf = (await pdfEntry.async('nodebuffer')) as Buffer
      // pdf-parse v2: a `PDFParse` CLASS, not a callable (v1 `pdfParse(buf)` threw
      // "pdfParse is not a function" after the v2 bump — same break as pdf.ts).
      // `new PDFParse({ data }).getText()` → `{ text }`. Fresh Uint8Array because
      // v2 may transfer the typed array to its worker and detach a reused buffer.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const PDFParse = (require('pdf-parse') as {
        PDFParse: new (opts: { data: Uint8Array }) => {
          getText: () => Promise<{ text: string }>
          destroy?: () => Promise<void> | void
        }
      }).PDFParse
      const parser = new PDFParse({ data: new Uint8Array(buf) })
      try {
        const parsed = await parser.getText()
        if (parsed.text?.trim()) return { text: parsed.text, mime }
      } finally {
        try {
          await parser.destroy?.()
        } catch {
          /* best-effort worker cleanup */
        }
      }
    } catch {
      // fall through to title-only indexing
    }
  }

  // Modern bundle: no OSS text path here yet. Index by title so it still becomes
  // a node; the viewer surfaces the JPEG preview via extractIWorkPreview().
  return { text: title, mime }
}

/**
 * Extract the first-page JPEG preview from an iWork bundle (present in every
 * era) → base64. The practical VIEW for modern iWork, which has no obtainable
 * PDF. Returns null when the bundle has no preview or isn't a zip.
 */
export async function extractIWorkPreview(path: string): Promise<string | null> {
  try {
    const zip = await JSZip.loadAsync(await readFile(path))
    const entry =
      zip.file('preview.jpg') ??
      zip.file('preview-web.jpg') ??
      firstMatch(zip, /preview[^/]*\.jpe?g$/i)
    if (!entry) return null
    return await entry.async('base64')
  } catch {
    return null
  }
}
