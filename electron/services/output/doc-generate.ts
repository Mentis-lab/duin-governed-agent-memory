// doc-generate.ts — DUIN's OFFICE DOCUMENT suite ("hands" / PRODUCE): turn a
// structured spec into a real .docx / .xlsx / .pptx FILE under
// userData/artifacts/docs, returning an absolute path that the stage-1 delivery
// tools (export_artifact / send_email attachments) can ship.
//
// Libraries: docx (Word), exceljs (Excel), pptxgenjs (PowerPoint) — installed as
// deps. To keep this module unit-testable WITHOUT the heavy libs or the Electron
// app, the SPEC→BUILDER mapping for each format is a PURE function that takes the
// library as an argument (dependency injection): `buildDocxDocument(spec, docx)`,
// `buildXlsxWorkbook(spec, ExcelJS)`, `buildPptxPresentation(spec, Pptx)`. A test
// passes a recording fake for the lib and asserts the exact construction/call
// sequence — no vi.mock module wrangling, no real binary.
//
// The `generate*` writers lazy-import the real library (electron-lazy pattern,
// mirroring audio-tools / artifact-export), run the pure builder, serialize, and
// write the bytes. xlsx additionally carries a NO-LIB CSV fallback (`specToCsv`)
// used when exceljs can't be imported — so the tool still yields a deliverable.
//
// SECURITY POSTURE: these are PRODUCE tools — reversible LOCAL writes under the app
// data dir, same class as generate_pdf_document / generate_audio. They are NOT in
// AGUI_GATED_TOOLS and requiresApproval:false: no external side effect, nothing to
// recall. Only the irreversible SEND (send_email) is gated.

import { messageOf } from '../guarded'
import { sanitizeBaseName } from './audio-tools'
import { assertNotOverwriting } from '../path-jail'

// ─────────────────────────────── Spec types ───────────────────────────────

/** A single Word document block. */
export interface DocxBlock {
  /** 'heading' → a heading of `level`; 'paragraph' → body text; 'table' → `rows`. */
  type: 'heading' | 'paragraph' | 'table'
  /** heading/paragraph text. */
  text?: string
  /** heading level 1..6 (clamped). Default 1. */
  level?: number
  /** table cell grid (rows × cols) of strings. */
  rows?: string[][]
  /** render paragraph/heading text bold. */
  bold?: boolean
  /** when a table, treat the first row as a bold header row. */
  header?: boolean
}

export interface DocxSpec {
  /** Optional document title → a top TITLE heading + default filename. */
  title?: string
  blocks: DocxBlock[]
}

/** A spreadsheet cell: literal string/number, or an Excel formula. */
export type XlsxCell = string | number | boolean | null | { formula: string }

export interface XlsxSheet {
  name?: string
  /** Optional header row (bolded) rendered above the data rows. */
  columns?: string[]
  rows?: XlsxCell[][]
}

export interface XlsxSpec {
  sheets: XlsxSheet[]
}

export interface PptxSlide {
  title?: string
  /** Bulleted body lines. */
  bullets?: string[]
  /** Optional free-text body block (rendered under bullets). */
  body?: string
}

export interface PptxSpec {
  title?: string
  slides: PptxSlide[]
}

// ─────────────────────────── normalization (PURE) ───────────────────────────

/** Clamp a heading level to 1..6. Non-numbers → 1. PURE. */
export function clampHeadingLevel(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 1
  return Math.min(6, Math.max(1, n))
}

/** Coerce/clean a DocxSpec: drop empty blocks, normalize shapes. PURE. */
export function normalizeDocxSpec(spec: unknown): DocxSpec {
  const s = (spec ?? {}) as Partial<DocxSpec>
  const title = typeof s.title === 'string' ? s.title.trim() : ''
  const rawBlocks = Array.isArray(s.blocks) ? s.blocks : []
  const blocks: DocxBlock[] = []
  for (const b of rawBlocks) {
    if (!b || typeof b !== 'object') continue
    const type = (b as DocxBlock).type
    if (type === 'table') {
      const rows = Array.isArray((b as DocxBlock).rows)
        ? (b as DocxBlock).rows!.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []))
        : []
      if (rows.length === 0) continue
      blocks.push({ type: 'table', rows, header: (b as DocxBlock).header === true })
    } else if (type === 'heading' || type === 'paragraph') {
      const text = typeof (b as DocxBlock).text === 'string' ? (b as DocxBlock).text! : ''
      if (type === 'paragraph' && text.trim() === '') continue
      blocks.push({
        type,
        text,
        level: type === 'heading' ? clampHeadingLevel((b as DocxBlock).level) : undefined,
        bold: (b as DocxBlock).bold === true
      })
    }
  }
  return { title, blocks }
}

/** Coerce/clean an XlsxSpec: at least one sheet, string-safe names. PURE. */
export function normalizeXlsxSpec(spec: unknown): XlsxSpec {
  const s = (spec ?? {}) as Partial<XlsxSpec>
  const rawSheets = Array.isArray(s.sheets) ? s.sheets : []
  const sheets: XlsxSheet[] = rawSheets
    .filter((sh): sh is XlsxSheet => !!sh && typeof sh === 'object')
    .map((sh, i) => ({
      name: sanitizeSheetName(typeof sh.name === 'string' && sh.name.trim() ? sh.name : `Sheet${i + 1}`),
      columns: Array.isArray(sh.columns) ? sh.columns.map((c) => String(c ?? '')) : undefined,
      rows: Array.isArray(sh.rows)
        ? sh.rows.map((r) => (Array.isArray(r) ? r.map(normalizeXlsxCell) : []))
        : []
    }))
  if (sheets.length === 0) sheets.push({ name: 'Sheet1', rows: [] })
  return { sheets }
}

/** Normalize a single spreadsheet cell. Objects with a string `formula` become an
 *  exceljs formula value; everything else is passed through as a literal. PURE. */
export function normalizeXlsxCell(c: unknown): XlsxCell {
  if (c && typeof c === 'object' && typeof (c as { formula?: unknown }).formula === 'string') {
    return { formula: (c as { formula: string }).formula }
  }
  if (typeof c === 'number' || typeof c === 'boolean') return c
  if (c === null || c === undefined) return null
  return String(c)
}

/** Excel worksheet names: ≤31 chars, none of : \ / ? * [ ]. PURE. */
export function sanitizeSheetName(raw: string): string {
  const cleaned = String(raw ?? '')
    .replace(/[:\\/?*[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31)
  return cleaned || 'Sheet'
}

/** Coerce/clean a PptxSpec: at least one slide. PURE. */
export function normalizePptxSpec(spec: unknown): PptxSpec {
  const s = (spec ?? {}) as Partial<PptxSpec>
  const title = typeof s.title === 'string' ? s.title.trim() : ''
  const rawSlides = Array.isArray(s.slides) ? s.slides : []
  const slides: PptxSlide[] = rawSlides
    .filter((sl): sl is PptxSlide => !!sl && typeof sl === 'object')
    .map((sl) => ({
      title: typeof sl.title === 'string' ? sl.title : '',
      bullets: Array.isArray(sl.bullets)
        ? sl.bullets.map((b) => String(b ?? '')).filter((b) => b.trim() !== '')
        : undefined,
      body: typeof sl.body === 'string' && sl.body.trim() ? sl.body : undefined
    }))
  if (slides.length === 0) slides.push({ title: title || 'Slide 1' })
  return { title, slides }
}

// ─────────────── DOCX builder (PURE given the injected `docx` lib) ───────────────

/** The subset of the `docx` module the builder needs. Injected so tests pass a
 *  recording fake and assert the construction sequence. */
export interface DocxLib {
  Document: new (opts: unknown) => unknown
  Paragraph: new (opts: unknown) => unknown
  TextRun: new (opts: unknown) => unknown
  Table: new (opts: unknown) => unknown
  TableRow: new (opts: unknown) => unknown
  TableCell: new (opts: unknown) => unknown
  HeadingLevel: Record<string, unknown>
}

/** Build a single-run paragraph (bold optional). */
function docxParagraph(lib: DocxLib, text: string, opts: { bold?: boolean; heading?: unknown } = {}): unknown {
  const run = new lib.TextRun({ text, bold: opts.bold === true })
  return new lib.Paragraph({ children: [run], heading: opts.heading })
}

/**
 * PURE transform: DocxSpec → a `docx` Document, using the injected lib. Headings map
 * to HeadingLevel.HEADING_n (title → TITLE); paragraphs to a bold-aware run; tables
 * to Table/TableRow/TableCell with an optional bold header row.
 */
export function buildDocxDocument(spec: DocxSpec, lib: DocxLib): unknown {
  const norm = normalizeDocxSpec(spec)
  const children: unknown[] = []

  if (norm.title) {
    children.push(docxParagraph(lib, norm.title, { bold: true, heading: lib.HeadingLevel.TITLE }))
  }

  for (const b of norm.blocks) {
    if (b.type === 'heading') {
      const heading = lib.HeadingLevel[`HEADING_${clampHeadingLevel(b.level)}`]
      children.push(docxParagraph(lib, b.text ?? '', { bold: b.bold, heading }))
    } else if (b.type === 'paragraph') {
      children.push(docxParagraph(lib, b.text ?? '', { bold: b.bold }))
    } else if (b.type === 'table') {
      const rows = (b.rows ?? []).map((row, ri) => {
        const cells = row.map(
          (cell) =>
            new lib.TableCell({
              children: [docxParagraph(lib, cell, { bold: b.header === true && ri === 0 })]
            })
        )
        return new lib.TableRow({ children: cells })
      })
      children.push(new lib.Table({ rows }))
    }
  }

  return new lib.Document({ sections: [{ children }] })
}

// ─────────────── XLSX builder (PURE given the injected `exceljs` lib) ───────────────

export interface ExcelWorksheetLike {
  addRow(values: unknown[]): { font?: unknown; eachCell?: unknown } | unknown
  getRow?(n: number): { font?: unknown }
}
export interface ExcelWorkbookLike {
  addWorksheet(name: string): ExcelWorksheetLike
}
export interface ExcelJSLike {
  Workbook: new () => ExcelWorkbookLike
}

/** Map a normalized XlsxCell to the value exceljs expects: a literal, or a
 *  `{ formula }` object it renders as a live formula. PURE. */
export function xlsxCellValue(cell: XlsxCell): unknown {
  if (cell && typeof cell === 'object' && 'formula' in cell) return { formula: cell.formula }
  return cell
}

/**
 * PURE transform: XlsxSpec → an exceljs Workbook, using the injected lib. One
 * worksheet per sheet; an optional bold header row from `columns`; then each data
 * row (formula cells become live formulas). Returns the built workbook.
 */
export function buildXlsxWorkbook(spec: XlsxSpec, lib: ExcelJSLike): ExcelWorkbookLike {
  const norm = normalizeXlsxSpec(spec)
  const wb = new lib.Workbook()
  for (const sheet of norm.sheets) {
    const ws = wb.addWorksheet(sheet.name ?? 'Sheet1')
    if (sheet.columns && sheet.columns.length > 0) {
      const headerRow = ws.addRow(sheet.columns) as { font?: unknown }
      // Bold the header row where the lib exposes a mutable font (real exceljs Row).
      if (headerRow && typeof headerRow === 'object') headerRow.font = { bold: true }
    }
    for (const row of sheet.rows ?? []) {
      ws.addRow(row.map(xlsxCellValue))
    }
  }
  return wb
}

// ─────────────── PPTX builder (PURE given the injected pptxgenjs ctor) ───────────────

export interface PptxSlideLike {
  addText(text: unknown, opts?: unknown): unknown
}
export interface PptxDeckLike {
  addSlide(): PptxSlideLike
  layout?: string
  title?: string
  author?: string
}
export type PptxCtor = new () => PptxDeckLike

/**
 * PURE transform: PptxSpec → a pptxgenjs presentation, using the injected ctor. One
 * slide per entry: a title text box, then a bulleted body (each bullet a paragraph),
 * then any free-text body. Returns the built deck.
 */
export function buildPptxPresentation(spec: PptxSpec, Ctor: PptxCtor): PptxDeckLike {
  const norm = normalizePptxSpec(spec)
  const deck = new Ctor()
  deck.layout = 'LAYOUT_WIDE'
  if (norm.title) deck.title = norm.title

  for (const slide of norm.slides) {
    const s = deck.addSlide()
    if (slide.title) {
      s.addText(slide.title, { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28, bold: true })
    }
    let y = 1.3
    if (slide.bullets && slide.bullets.length > 0) {
      const runs = slide.bullets.map((b) => ({ text: b, options: { bullet: true } }))
      s.addText(runs, { x: 0.7, y, w: 8.5, h: 3.5, fontSize: 18 })
      y += 3.7
    }
    if (slide.body) {
      s.addText(slide.body, { x: 0.7, y, w: 8.5, h: 2, fontSize: 14 })
    }
  }
  return deck
}

// ─────────────────────── CSV fallback (no lib, PURE) ───────────────────────

/** RFC4180-ish CSV escaping of a single field. PURE. */
export function csvField(cell: XlsxCell): string {
  let v: string
  if (cell && typeof cell === 'object' && 'formula' in cell) v = `=${cell.formula}`
  else if (cell === null || cell === undefined) v = ''
  else v = String(cell)
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/**
 * Render an XlsxSpec to CSV text — the NO-LIBRARY fallback when exceljs is
 * unavailable. Only the FIRST sheet is emitted (CSV is single-table); a header row
 * from `columns` precedes the data rows. PURE.
 */
export function specToCsv(spec: XlsxSpec): string {
  const norm = normalizeXlsxSpec(spec)
  const sheet = norm.sheets[0]
  const lines: string[] = []
  if (sheet.columns && sheet.columns.length > 0) lines.push(sheet.columns.map(csvField).join(','))
  for (const row of sheet.rows ?? []) lines.push(row.map(csvField).join(','))
  return lines.join('\r\n')
}

// ─────────────────────────── file writers (impure) ───────────────────────────

export interface DocGenResult {
  ok: boolean
  path?: string
  bytes?: number
  format?: string
  error?: string
}

/** Resolve (and mkdir) the userData/artifacts/docs directory + a filename stem.
 *  Electron-lazy so the pure builders above stay usable in node-only tests. */
async function resolveDocPath(base: string, ext: string): Promise<string> {
  const { app } = await import('electron')
  const { join } = await import('path')
  const { existsSync, mkdirSync } = await import('fs')
  const dir = join(app.getPath('userData'), 'artifacts', 'docs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const rand = Math.random().toString(36).slice(2, 8)
  const stem = base ? `${base}-${Date.now().toString(36)}-${rand}` : `doc-${Date.now().toString(36)}-${rand}`
  return join(dir, `${stem}${ext}`)
}

/** Generate a .docx from a DocxSpec and write it. Returns the absolute path. */
export async function generateDocx(spec: DocxSpec, outPath?: string): Promise<DocGenResult> {
  try {
    const docx = (await import('docx')) as unknown as DocxLib & { Packer: { toBuffer(d: unknown): Promise<Buffer> } }
    const doc = buildDocxDocument(spec, docx)
    const buf = await docx.Packer.toBuffer(doc)
    const norm = normalizeDocxSpec(spec)
    const dest = outPath?.trim() || (await resolveDocPath(sanitizeBaseName(norm.title), '.docx'))
    // Only a path the CALLER named can clobber something; the generated fallback
    // lands in the app's own docs folder and keeps its existing behaviour.
    if (outPath?.trim()) assertNotOverwriting(dest, 'generate_docx')
    const { writeFileSync } = await import('fs')
    writeFileSync(dest, buf)
    return { ok: true, path: dest, bytes: buf.length, format: 'docx' }
  } catch (e) {
    return { ok: false, error: `docx generation failed: ${messageOf(e)}`, format: 'docx' }
  }
}

/** Generate an .xlsx from an XlsxSpec and write it. Falls back to a .csv (no lib)
 *  when exceljs is unavailable. Returns the absolute path. */
export async function generateXlsx(spec: XlsxSpec, outPath?: string): Promise<DocGenResult> {
  const norm = normalizeXlsxSpec(spec)
  const base = sanitizeBaseName(norm.sheets[0]?.name)
  try {
    const mod = await import('exceljs')
    const ExcelJS = ((mod as unknown as { default?: ExcelJSLike }).default ?? mod) as unknown as ExcelJSLike
    const wb = buildXlsxWorkbook(spec, ExcelJS) as unknown as {
      xlsx: { writeFile(p: string): Promise<void>; writeBuffer(): Promise<ArrayBuffer | Buffer> }
    }
    const dest = outPath?.trim() || (await resolveDocPath(base, '.xlsx'))
    // Only a path the CALLER named can clobber something; the generated fallback
    // lands in the app's own docs folder and keeps its existing behaviour.
    if (outPath?.trim()) assertNotOverwriting(dest, 'generate_xlsx')
    await wb.xlsx.writeFile(dest)
    const { statSync } = await import('fs')
    return { ok: true, path: dest, bytes: statSync(dest).size, format: 'xlsx' }
  } catch (e) {
    // NO-LIB fallback: write CSV so the caller still gets a deliverable.
    try {
      const csv = specToCsv(spec)
      const dest = (outPath?.trim()?.replace(/\.xlsx$/i, '.csv')) || (await resolveDocPath(base, '.csv'))
      const { writeFileSync } = await import('fs')
      writeFileSync(dest, csv, 'utf-8')
      return {
        ok: true,
        path: dest,
        bytes: Buffer.byteLength(csv, 'utf8'),
        format: 'csv',
        error: `exceljs unavailable (${messageOf(e)}); wrote CSV fallback`
      }
    } catch (e2) {
      return { ok: false, error: `xlsx generation failed: ${messageOf(e2)}`, format: 'xlsx' }
    }
  }
}

/** Generate a .pptx from a PptxSpec and write it. Returns the absolute path. */
export async function generatePptx(spec: PptxSpec, outPath?: string): Promise<DocGenResult> {
  try {
    const mod = await import('pptxgenjs')
    const Ctor = ((mod as unknown as { default?: PptxCtor }).default ?? mod) as unknown as PptxCtor
    const deck = buildPptxPresentation(spec, Ctor) as unknown as {
      writeFile(p: { fileName: string }): Promise<string>
    }
    const norm = normalizePptxSpec(spec)
    const dest = outPath?.trim() || (await resolveDocPath(sanitizeBaseName(norm.title || norm.slides[0]?.title), '.pptx'))
    // Only a path the CALLER named can clobber something; the generated fallback
    // lands in the app's own docs folder and keeps its existing behaviour.
    if (outPath?.trim()) assertNotOverwriting(dest, 'generate_pptx')
    await deck.writeFile({ fileName: dest })
    const { statSync } = await import('fs')
    return { ok: true, path: dest, bytes: statSync(dest).size, format: 'pptx' }
  } catch (e) {
    return { ok: false, error: `pptx generation failed: ${messageOf(e)}`, format: 'pptx' }
  }
}
