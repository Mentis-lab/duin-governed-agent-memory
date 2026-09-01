import { readFile, stat } from 'fs/promises'
import { basename, extname } from 'path'
// OCR consume-only (Tier 1). Gate is ocrEnabled() — settings.ocrEnabled, overridable by DUIN_OCR.
// NOTE: it is default ON (ocr.ts returns `readSettings().ocrEnabled !== false`), not default off as
// this comment claimed until 2026-07-28. That mattered: OCR text is only a FALLBACK for models that
// cannot see, so on a vision model the image must NOT also be sent as extracted text — see the
// `!supportsVision` guard in chat-store.sendMessage, which this stale comment helped hide.
import { ocrEnabled, ocrImage } from './rag/loaders/ocr'
// Office readers, shared with the RAG ingest path so chat and retrieval extract
// the SAME text from the same file rather than disagreeing about it.
import { isOfficeExtension, loadOffice } from './rag/loaders/office'
import { loadDocx } from './rag/loaders/docx'
import { loadPdf } from './rag/loaders/pdf'

export type AttachmentKind = 'text' | 'image' | 'pdf' | 'binary' | 'rag-pending'

/** Legacy OLE2/CFB Office formats → the modern equivalent to re-save as. */
const LEGACY_OFFICE_EXTS = new Map<string, string>([
  ['.doc', '.docx'],
  ['.xls', '.xlsx'],
  ['.ppt', '.pptx']
])

export interface ProcessedFile {
  name: string
  kind: AttachmentKind
  mimeType: string
  size: number
  content: string
  previewText: string
  error?: string
  /** Absolute path on disk for files that aren't read inline. Populated for
   *  `kind: 'rag-pending'` so the auto-attach IPC can hand the path to the
   *  ingest manager without re-resolving it. Undefined for inline-read files
   *  (their content is already in `content`). */
  sourcePath?: string
  /** OCR-extracted text for `kind: 'image'` attachments. Only populated when
   *  DUIN_OCR is enabled AND OCR yields non-empty text; lets a pasted screenshot
   *  stay groundable on non-vision models. Undefined otherwise (flag-off ⇒ never
   *  set, so the vision/base64 path is unchanged). */
  ocrText?: string
}

const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.mdx',
  '.py',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.json',
  '.jsonc',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.sql',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.php',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.r',
  '.lua',
  '.svelte',
  '.vue'
])

/**
 * Longest edge, in pixels, that a vision payload is downscaled to.
 *
 * 1568 is the tile ceiling the major vision models effectively resize to anyway, so anything larger
 * is re-encoded on the provider's side and the extra pixels are paid for twice — once in upload, once
 * in latency — for no gain in what the model sees.
 */
const VISION_MAX_EDGE = 1568

/**
 * Shrink an oversized image for the vision payload. BEST-EFFORT and non-destructive: the file on disk
 * is untouched, OCR still runs on the FULL-resolution original (downscaling would cost it accuracy on
 * small type), and any failure — sharp missing, corrupt image, unknown dimensions — returns the input
 * buffer so the attachment still works exactly as before.
 */
async function downscaleForVision(buf: Buffer, mime: string): Promise<Buffer> {
  // GIFs may be animated; resizing would silently flatten them to one frame.
  if (mime === 'image/gif') return buf
  try {
    const sharp = (await import('sharp')).default
    const img = sharp(buf, { failOn: 'none' })
    const meta = await img.metadata()
    const w = meta.width ?? 0
    const h = meta.height ?? 0
    if (!w || !h || Math.max(w, h) <= VISION_MAX_EDGE) return buf
    const out = await img
      .resize({ width: VISION_MAX_EDGE, height: VISION_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .toBuffer()
    // A re-encode can occasionally grow a small file; only take the win.
    return out.byteLength < buf.byteLength ? out : buf
  } catch {
    return buf
  }
}

const IMAGE_EXTS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

// Inline ingest threshold. At or below this size the file's content is read,
// previewed, and sent inline in the user message. Above it (up to the
// per-file hard cap below) the file is marked `kind: 'rag-pending'`: the
// renderer routes it through the RAG ingest pipeline into a per-conversation
// auto-collection, and augmentForChat retrieves only the relevant chunks at
// send time. This keeps prompt budgets bounded for large PDFs / corpora.
const INLINE_THRESHOLD_BYTES = 5 * 1024 * 1024
const MAX_BYTES_PER_FILE = 100 * 1024 * 1024
const MAX_BYTES_TOTAL = 250 * 1024 * 1024
const PREVIEW_CHARS = 200

function previewOf(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length <= PREVIEW_CHARS ? trimmed : trimmed.slice(0, PREVIEW_CHARS) + '…'
}

function lineCount(text: string): number {
  if (!text) return 0
  return text.split(/\r?\n/).length
}

async function processOne(filePath: string): Promise<ProcessedFile> {
  const name = basename(filePath)
  const ext = extname(filePath).toLowerCase()
  let size: number
  try {
    size = (await stat(filePath)).size
  } catch (err) {
    return {
      name,
      kind: 'binary',
      mimeType: 'application/octet-stream',
      size: 0,
      content: '',
      previewText: '',
      error: `Could not read file: ${(err as Error).message}`
    }
  }

  if (size > MAX_BYTES_PER_FILE) {
    return {
      name,
      kind: 'binary',
      mimeType: 'application/octet-stream',
      size,
      content: '',
      previewText: '',
      error: `File exceeds 100MB limit (${Math.round(size / 1024 / 1024)} MB). Split into smaller files.`
    }
  }

  // Images always go inline (base64 in the request body); vision models need
  // the bytes, RAG can't index them. The 100 MB cap above still applies.
  // Everything else over the inline threshold gets routed to RAG ingest.
  if (size > INLINE_THRESHOLD_BYTES && !IMAGE_EXTS[ext]) {
    return {
      name,
      kind: 'rag-pending',
      mimeType: ext === '.pdf' ? 'application/pdf' : 'application/octet-stream',
      size,
      content: '',
      previewText: '',
      sourcePath: filePath
    }
  }

  if (IMAGE_EXTS[ext]) {
    try {
      const buf = await readFile(filePath)
      // Downscale for the VISION payload only. Images deliberately bypass the 5MB
      // inline threshold, and nothing resized them, so a 100MB screenshot became a
      // ~133MB base64 string pushed through IPC and an HTTP body. Vision models
      // resize to roughly this ceiling server-side anyway, so sending the full
      // original bought nothing and cost latency, bandwidth and tokens.
      const visionBuf = await downscaleForVision(buf, IMAGE_EXTS[ext])
      const base64 = visionBuf.toString('base64')
      const dataUrl = `data:${IMAGE_EXTS[ext]};base64,${base64}`
      // OCR (best-effort, flag-gated): additively transcribe the image so its
      // text survives even on non-vision models. Never disturbs the base64/vision
      // path — ocrImage never throws, and ocrText stays undefined when the flag is
      // off or no text is found.
      let ocrText: string | undefined
      if (ocrEnabled()) {
        const { text } = await ocrImage(buf)
        if (text) ocrText = text
      }
      return {
        name,
        kind: 'image',
        mimeType: IMAGE_EXTS[ext],
        size,
        content: dataUrl,
        previewText: `Image (${Math.round(size / 1024)} KB)`,
        ...(ocrText ? { ocrText } : {})
      }
    } catch (err) {
      return {
        name,
        kind: 'image',
        mimeType: IMAGE_EXTS[ext],
        size,
        content: '',
        previewText: '',
        error: `Could not read image: ${(err as Error).message}`
      }
    }
  }

  if (ext === '.pdf') {
    try {
      // Use the SHARED loader rather than calling pdf-parse directly. The private
      // copy this replaces read only the flat `result.text` and had no OCR seam,
      // so a SCANNED pdf under the 5MB inline threshold returned '' with no
      // `error` — the user saw a normal chip and the model got
      // "(no extractable text)" with no hint why. Push the same file over 5MB and
      // the RAG path OCR'd it properly. loadPdf brings the scanned-page OCR
      // fallback, encrypted detection and page structure, so chat and retrieval
      // now extract the same text from the same file.
      const loaded = await loadPdf(filePath)
      const text = loaded.pages.map((p) => p.text).join('\n\n').trim()
      return {
        name,
        kind: 'pdf',
        mimeType: 'application/pdf',
        size,
        content: text,
        previewText: previewOf(text) || `PDF (${Math.round(size / 1024)} KB)`,
        // A PDF that yields nothing after OCR is a real outcome (an image-only
        // scan with OCR disabled, a pure-vector document). Name it instead of
        // emitting a silently empty attachment.
        ...(text ? {} : { error: `No extractable text in ${name} (scanned or image-only PDF)` })
      }
    } catch (err) {
      return {
        name,
        kind: 'pdf',
        mimeType: 'application/pdf',
        size,
        content: '',
        previewText: '',
        error: `PDF extraction failed: ${(err as Error).message}`
      }
    }
  }

  // Office documents. These loaders already existed and were already wired into
  // the RAG path — the chat path simply never asked for them, so a .docx fell
  // through to the binary fallthrough below and reached the model as one line
  // saying the file existed. The effect was inverted from intuition: a >5MB
  // .xlsx went to `rag-pending` and got fully indexed, while a 200KB one became
  // an opaque stub. Same file, opposite outcome, decided only by size.
  if (ext === '.docx' || isOfficeExtension(name)) {
    try {
      const loaded = ext === '.docx' ? await loadDocx(filePath) : await loadOffice(filePath)
      const text = loaded.text || ''
      return {
        name,
        kind: 'text',
        mimeType: loaded.mime || 'application/octet-stream',
        size,
        content: text,
        previewText: previewOf(text) || `${ext.slice(1).toUpperCase()} (${Math.round(size / 1024)} KB)`,
        // An Office file that parses to nothing is a real outcome (an empty
        // deck, an all-formula sheet). Say so rather than emitting a blank
        // attachment block the user has to guess at.
        ...(text.trim() ? {} : { error: `No extractable text in ${name}` })
      }
    } catch (err) {
      return {
        name,
        kind: 'binary',
        mimeType: 'application/octet-stream',
        size,
        content: '',
        previewText: '',
        error: `Office extraction failed: ${(err as Error).message}`
      }
    }
  }

  // Legacy OLE2/CFB Office formats. Nothing in the tree can read these —
  // officeparser handles only the OOXML/ODF set — and no maintained Node reader
  // exists. Say so plainly instead of letting them look like any other opaque
  // binary: to the user a .doc is obviously a document, so silence reads as a
  // bug rather than an unsupported format. The advice is actionable and the
  // re-save is lossless.
  if (LEGACY_OFFICE_EXTS.has(ext)) {
    return {
      name,
      kind: 'binary',
      mimeType: 'application/octet-stream',
      size,
      content: '',
      previewText: '',
      error: `${ext} is a legacy Office format DUIN cannot read — re-save as ${LEGACY_OFFICE_EXTS.get(ext)} and attach again`
    }
  }

  if (TEXT_EXTS.has(ext) || ext === '') {
    try {
      const text = await readFile(filePath, 'utf-8')
      return {
        name,
        kind: 'text',
        mimeType: 'text/plain',
        size,
        content: text,
        previewText: `${lineCount(text)} lines · ${previewOf(text)}`
      }
    } catch (err) {
      return {
        name,
        kind: 'binary',
        mimeType: 'application/octet-stream',
        size,
        content: '',
        previewText: '',
        error: `Could not decode as UTF-8: ${(err as Error).message}`
      }
    }
  }

  return {
    name,
    kind: 'binary',
    mimeType: 'application/octet-stream',
    size,
    content: '',
    previewText: `Binary file (${Math.round(size / 1024)} KB) — content not included.`
  }
}

export async function processFiles(paths: string[]): Promise<ProcessedFile[]> {
  const results: ProcessedFile[] = []
  let totalBytes = 0
  for (const p of paths) {
    if (totalBytes > MAX_BYTES_TOTAL) {
      results.push({
        name: basename(p),
        kind: 'binary',
        mimeType: 'application/octet-stream',
        size: 0,
        content: '',
        previewText: '',
        error: 'Skipped — combined attachment size would exceed 250MB.'
      })
      continue
    }
    const processed = await processOne(p)
    totalBytes += processed.size
    results.push(processed)
  }
  return results
}

/**
 * Process an image pasted from the clipboard.
 *
 * A pasted screenshot never touches the filesystem, so it cannot go through `processFiles` (which
 * takes paths). Before this existed the renderer built the attachment itself, which meant a pasted
 * image skipped BOTH of main's guarantees: it was never OCR'd (so on a text-only model a pasted
 * screenshot contributed literally nothing), and its type was never checked (any `image/*` was
 * accepted, including SVG — which is script-bearing markup, not a raster the vision models take).
 *
 * Pastes are the most common way a screenshot enters a chat, so this was the widest gap in the
 * image path, not the narrowest.
 */
export async function processPastedImage(input: {
  dataUrl: string
  name: string
  mimeType: string
}): Promise<ProcessedFile> {
  const accepted = new Set(Object.values(IMAGE_EXTS))
  const mimeType = (input.mimeType || '').toLowerCase()
  const base = { name: input.name, kind: 'image' as const, mimeType, content: '', previewText: '' }

  if (!accepted.has(mimeType)) {
    return {
      ...base,
      size: 0,
      error: `Unsupported image type ${mimeType || '(unknown)'} — paste a PNG, JPEG, GIF or WebP`
    }
  }

  const comma = input.dataUrl.indexOf(',')
  if (!input.dataUrl.startsWith('data:') || comma < 0) {
    return { ...base, size: 0, error: 'Pasted image was not a data: URL' }
  }

  let buf: Buffer
  try {
    buf = Buffer.from(input.dataUrl.slice(comma + 1), 'base64')
  } catch (err) {
    return { ...base, size: 0, error: `Could not decode pasted image: ${(err as Error).message}` }
  }
  if (buf.byteLength > MAX_BYTES_PER_FILE) {
    return { ...base, size: buf.byteLength, error: `Pasted image too large (${Math.round(buf.byteLength / 1024 / 1024)} MB)` }
  }

  // Same best-effort OCR as the on-disk image branch — never throws, and leaves
  // ocrText undefined when disabled or when nothing is found. Runs on the FULL
  // resolution buffer, before any downscale, so small type stays legible to it.
  let ocrText: string | undefined
  try {
    if (ocrEnabled()) {
      const { text } = await ocrImage(buf)
      if (text) ocrText = text
    }
  } catch {
    // OCR is additive; a failure must not cost the user the image itself.
  }

  // Pasted screenshots are often full-monitor grabs, so they need the same
  // downscale as on-disk images.
  const visionBuf = await downscaleForVision(buf, mimeType)
  const dataUrl =
    visionBuf === buf ? input.dataUrl : `data:${mimeType};base64,${visionBuf.toString('base64')}`

  return {
    name: input.name,
    kind: 'image',
    mimeType,
    size: visionBuf.byteLength,
    content: dataUrl,
    previewText: `Pasted image (${Math.round(buf.byteLength / 1024)} KB)`,
    ...(ocrText ? { ocrText } : {})
  }
}
