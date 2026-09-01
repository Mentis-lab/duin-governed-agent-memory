import { extname } from 'path'
import { isSupportedTextExtension, loadFromBuffer, loadText } from './text'
import { loadHtml } from './html'
import { loadPdf } from './pdf'
import { loadDocx } from './docx'
import { isOfficeExtension, loadOffice } from './office'
import { isIWorkExtension, loadIWork } from './iwork'
import { isCanvasExtension, loadCanvas } from './canvas'
import { isImageExtension, imageMime, ocrEnabled, ocrImage } from './ocr'
import {
  isAudioExtension,
  audioMime,
  audioTranscribeEnabled,
  transcribeAudio
} from './audio'

// Discriminated union — chunker.ts dispatches on `kind` to apply page-level
// stamping for paged docs and recursive split for unpaged ones.

export type LoadedDocument =
  | { kind: 'text'; text: string; mime: string }
  | { kind: 'paged'; pages: { page: number; text: string }[]; mime: string }

export async function loadDocument(path: string): Promise<LoadedDocument> {
  const ext = extname(path).toLowerCase()
  if (ext === '.pdf') {
    const pdf = await loadPdf(path)
    return { kind: 'paged', pages: pdf.pages, mime: pdf.mime }
  }
  if (ext === '.docx') {
    const docx = await loadDocx(path)
    return { kind: 'text', text: docx.text, mime: docx.mime }
  }
  if (isOfficeExtension(path)) {
    const o = await loadOffice(path)
    return { kind: 'text', text: o.text, mime: o.mime }
  }
  if (isIWorkExtension(path)) {
    const iw = await loadIWork(path)
    return { kind: 'text', text: iw.text, mime: iw.mime }
  }
  // Image OCR (Tier 1) — gated by ocrEnabled() (settings.ocrEnabled, DUIN_OCR overrides).
  // That gate is default ON, not default OFF as this comment claimed until 2026-07-28.
  // When it IS off we do NOT intercept images: they fall through to the "Unsupported
  // extension" throw below, so a flag-off vault behaves byte-identically to
  // today (images not ingestable). OCR is best-effort: on failure ocrImage
  // returns empty text, which stores as a 0-chunk viewable doc (never an error).
  if (ocrEnabled() && isImageExtension(path)) {
    const r = await ocrImage(path)
    return { kind: 'text', text: r.text, mime: imageMime(path) }
  }
  // Voice-memo transcription (Wave-3) — GATED behind DUIN_AUDIO_TRANSCRIBE
  // (default OFF; needs a human-provided whisper binary). Flag-off, audio files
  // fall through to the "Unsupported extension" throw below, byte-identical to
  // today. Best-effort: no binary → empty text → a 0-chunk viewable doc.
  if (audioTranscribeEnabled() && isAudioExtension(path)) {
    const r = await transcribeAudio(path)
    return { kind: 'text', text: r.text, mime: audioMime(path) }
  }
  // HTML is a supported text extension, but must be intercepted BEFORE loadText
  // so we index the rendered text, not the raw markup.
  if (ext === '.html' || ext === '.htm') {
    const h = await loadHtml(path)
    return { kind: 'text', text: h.text, mime: h.mime }
  }
  // JSON Canvas blueprints. Same reasoning as HTML above — index what the canvas
  // SAYS (blocks, connections, referenced notes), never the raw coordinate JSON.
  if (isCanvasExtension(path)) {
    const c = await loadCanvas(path)
    return { kind: 'text', text: c.text, mime: c.mime }
  }
  if (isSupportedTextExtension(path)) {
    const t = await loadText(path)
    return { kind: 'text', text: t.text, mime: t.mime }
  }
  throw new Error(`Unsupported document extension: ${ext || '(none)'}`)
}

export { loadText, loadFromBuffer, isSupportedTextExtension } from './text'
export { loadCanvas, isCanvasExtension } from './canvas'
export { loadPdf } from './pdf'
export { loadDocx } from './docx'
export { isOfficeExtension, loadOffice } from './office'
export { isIWorkExtension, loadIWork, extractIWorkPreview } from './iwork'
export {
  ocrImage,
  ocrEnabled,
  ocrEngine,
  isImageExtension,
  imageMime,
  OCR_IMAGE_EXTENSIONS,
  resolveTessdataDir,
  terminateOcrWorkers
} from './ocr'
export type { OcrEngine } from './ocr'
export {
  transcribeAudio,
  audioTranscribeEnabled,
  isAudioExtension,
  audioMime,
  AUDIO_EXTENSIONS,
  resolveWhisperBinary,
  resolveWhisperModel
} from './audio'
export type { AudioTranscript } from './audio'
