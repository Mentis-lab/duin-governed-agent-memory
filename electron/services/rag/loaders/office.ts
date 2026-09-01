import { extname } from 'path'
import { convert, parseOffice } from 'officeparser'

// Office loader (P3 — MS Office + OpenDocument text extraction). Uses
// officeParser (MIT, pure Node) for the formats mammoth/pdf-parse don't cover:
// pptx, xlsx, and the OpenDocument family, plus rtf. `.docx` deliberately stays
// on the existing mammoth loader (tested + wired); `.pdf` on pdf-parse.
//
// We prefer a MARKDOWN conversion (headings/tables preserved) so the heading-
// aware chunker + breadcrumb-embed get real structure; fall back to flat text.

const OFFICE_EXTS = new Set(['.pptx', '.xlsx', '.odt', '.odp', '.ods', '.rtf'])

const MIME: Record<string, string> = {
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.rtf': 'application/rtf'
}

export function isOfficeExtension(name: string): boolean {
  return OFFICE_EXTS.has(extname(name).toLowerCase())
}

export interface LoadedOffice {
  text: string
  mime: string
}

export async function loadOffice(path: string): Promise<LoadedOffice> {
  const mime = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  // 1. Markdown conversion — keeps headings/tables so downstream chunking has
  //    structure. Some formats/files the converter can't render fall through.
  try {
    const res = (await convert(path, 'md')) as { value?: string }
    const md = res?.value ?? ''
    if (md.trim()) return { text: md, mime }
  } catch {
    // fall through to plain-text extraction
  }
  // 2. Flat text fallback — the AST's toText() always yields something usable.
  const ast = await parseOffice(path)
  const text = typeof (ast as { toText?: () => string })?.toText === 'function'
    ? (ast as { toText: () => string }).toText()
    : String(ast ?? '')
  return { text, mime }
}
