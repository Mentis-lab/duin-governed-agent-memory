import { describe, it, expect } from 'vitest'
import {
  clampHeadingLevel,
  normalizeDocxSpec,
  normalizeXlsxSpec,
  normalizeXlsxCell,
  normalizePptxSpec,
  sanitizeSheetName,
  xlsxCellValue,
  buildDocxDocument,
  buildXlsxWorkbook,
  buildPptxPresentation,
  csvField,
  specToCsv,
  type DocxLib,
  type ExcelJSLike,
  type PptxCtor
} from './doc-generate'

// ─── recording fakes for the injected libs (the "mock the lib" seam) ───

interface CtorCall {
  name: string
  opts: unknown
}
function fakeDocx(): { lib: DocxLib; calls: CtorCall[] } {
  const calls: CtorCall[] = []
  const mk =
    (name: string) =>
    class {
      opts: unknown
      constructor(opts: unknown) {
        this.opts = opts
        calls.push({ name, opts })
      }
    }
  const lib = {
    Document: mk('Document'),
    Paragraph: mk('Paragraph'),
    TextRun: mk('TextRun'),
    Table: mk('Table'),
    TableRow: mk('TableRow'),
    TableCell: mk('TableCell'),
    HeadingLevel: {
      TITLE: 'TITLE',
      HEADING_1: 'HEADING_1',
      HEADING_2: 'HEADING_2',
      HEADING_3: 'HEADING_3',
      HEADING_4: 'HEADING_4',
      HEADING_5: 'HEADING_5',
      HEADING_6: 'HEADING_6'
    }
  } as unknown as DocxLib
  return { lib, calls }
}

interface FakeRow {
  values: unknown[]
  font?: unknown
}
interface FakeSheet {
  name: string
  rows: FakeRow[]
}
function fakeExcel(): { lib: ExcelJSLike; sheets: FakeSheet[] } {
  const sheets: FakeSheet[] = []
  class Workbook {
    addWorksheet(name: string): { addRow(values: unknown[]): FakeRow } {
      const sheet: FakeSheet = { name, rows: [] }
      sheets.push(sheet)
      return {
        addRow(values: unknown[]): FakeRow {
          const row: FakeRow = { values }
          sheet.rows.push(row)
          return row
        }
      }
    }
  }
  return { lib: { Workbook } as unknown as ExcelJSLike, sheets }
}

interface FakeText {
  text: unknown
  opts: unknown
}
interface FakeSlide {
  texts: FakeText[]
}
function fakePptx(): { Ctor: PptxCtor; slides: FakeSlide[]; meta: { layout?: string; title?: string } } {
  const slides: FakeSlide[] = []
  const meta: { layout?: string; title?: string } = {}
  class Deck {
    set layout(v: string) {
      meta.layout = v
    }
    set title(v: string) {
      meta.title = v
    }
    addSlide(): { addText(text: unknown, opts?: unknown): void } {
      const slide: FakeSlide = { texts: [] }
      slides.push(slide)
      return {
        addText(text: unknown, opts?: unknown): void {
          slide.texts.push({ text, opts })
        }
      }
    }
  }
  return { Ctor: Deck as unknown as PptxCtor, slides, meta }
}

// ─────────────────────────── pure normalization ───────────────────────────

describe('clampHeadingLevel', () => {
  it('clamps to 1..6 and defaults non-numbers to 1', () => {
    expect(clampHeadingLevel(3)).toBe(3)
    expect(clampHeadingLevel(0)).toBe(1)
    expect(clampHeadingLevel(9)).toBe(6)
    expect(clampHeadingLevel('x')).toBe(1)
    expect(clampHeadingLevel(2.7)).toBe(2)
  })
})

describe('normalizeDocxSpec', () => {
  it('keeps valid blocks, drops empty paragraphs and empty tables', () => {
    const s = normalizeDocxSpec({
      title: '  Report ',
      blocks: [
        { type: 'heading', level: 2, text: 'H' },
        { type: 'paragraph', text: '   ' }, // dropped (empty)
        { type: 'paragraph', text: 'body' },
        { type: 'table', rows: [] }, // dropped (no rows)
        { type: 'table', rows: [['a', 'b']] },
        { type: 'nonsense' } as never
      ]
    })
    expect(s.title).toBe('Report')
    expect(s.blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'table'])
    expect(s.blocks[0].level).toBe(2)
    expect(s.blocks[2].rows).toEqual([['a', 'b']])
  })
  it('tolerates garbage input', () => {
    expect(normalizeDocxSpec(null)).toEqual({ title: '', blocks: [] })
    expect(normalizeDocxSpec({ blocks: 'x' } as never).blocks).toEqual([])
  })
})

describe('normalizeXlsxCell / xlsxCellValue', () => {
  it('passes formula objects through as {formula}', () => {
    expect(normalizeXlsxCell({ formula: 'SUM(A1:A2)' })).toEqual({ formula: 'SUM(A1:A2)' })
    expect(xlsxCellValue({ formula: 'A1+B1' })).toEqual({ formula: 'A1+B1' })
  })
  it('keeps numbers/booleans, coerces others, maps nullish to null', () => {
    expect(normalizeXlsxCell(42)).toBe(42)
    expect(normalizeXlsxCell(true)).toBe(true)
    expect(normalizeXlsxCell('hi')).toBe('hi')
    expect(normalizeXlsxCell(undefined)).toBeNull()
    expect(xlsxCellValue(7)).toBe(7)
  })
})

describe('sanitizeSheetName', () => {
  it('strips illegal chars and caps at 31', () => {
    expect(sanitizeSheetName('a/b:c*[x]')).toBe('a b c x')
    expect(sanitizeSheetName('x'.repeat(40)).length).toBe(31)
    expect(sanitizeSheetName('   ')).toBe('Sheet')
  })
})

describe('normalizeXlsxSpec', () => {
  it('names sheets and normalizes cells; guarantees a sheet', () => {
    const s = normalizeXlsxSpec({
      sheets: [{ rows: [[1, 'a', { formula: 'A1' }]] }, { name: 'Bad/Name', columns: ['h'] }]
    })
    expect(s.sheets[0].name).toBe('Sheet1')
    expect(s.sheets[0].rows![0]).toEqual([1, 'a', { formula: 'A1' }])
    expect(s.sheets[1].name).toBe('Bad Name')
    expect(normalizeXlsxSpec({}).sheets).toHaveLength(1)
  })
})

describe('normalizePptxSpec', () => {
  it('cleans slides, drops blank bullets, guarantees a slide', () => {
    const s = normalizePptxSpec({
      title: 'Deck',
      slides: [{ title: 'S1', bullets: ['a', '  ', 'b'], body: 'x' }]
    })
    expect(s.title).toBe('Deck')
    expect(s.slides[0].bullets).toEqual(['a', 'b'])
    expect(normalizePptxSpec({}).slides).toHaveLength(1)
  })
})

// ─────────── DOCX builder → docx lib call sequence (mock the lib) ───────────

describe('buildDocxDocument', () => {
  it('maps title→TITLE, heading→HEADING_n, paragraph run, and a table', () => {
    const { lib, calls } = fakeDocx()
    buildDocxDocument(
      {
        title: 'My Doc',
        blocks: [
          { type: 'heading', level: 2, text: 'Section', bold: true },
          { type: 'paragraph', text: 'Hello' },
          { type: 'table', rows: [['H1', 'H2'], ['a', 'b']], header: true }
        ]
      },
      lib
    )
    // exactly one Document, constructed with a single section of children
    const docCalls = calls.filter((c) => c.name === 'Document')
    expect(docCalls).toHaveLength(1)
    const sections = (docCalls[0].opts as { sections: { children: unknown[] }[] }).sections
    expect(sections).toHaveLength(1)

    // title paragraph carries the TITLE heading
    const paras = calls.filter((c) => c.name === 'Paragraph')
    const titlePara = paras.find((p) => (p.opts as { heading?: unknown }).heading === 'TITLE')
    expect(titlePara).toBeTruthy()
    // level-2 heading maps to HEADING_2
    expect(paras.some((p) => (p.opts as { heading?: unknown }).heading === 'HEADING_2')).toBe(true)

    // a bold TextRun exists (from the bold heading), and the plain "Hello" run
    const runs = calls.filter((c) => c.name === 'TextRun').map((c) => c.opts as { text: string; bold: boolean })
    expect(runs.some((r) => r.text === 'Section' && r.bold === true)).toBe(true)
    expect(runs.some((r) => r.text === 'Hello' && r.bold === false)).toBe(true)

    // table structure: 1 Table, 2 TableRow, 4 TableCell
    expect(calls.filter((c) => c.name === 'Table')).toHaveLength(1)
    expect(calls.filter((c) => c.name === 'TableRow')).toHaveLength(2)
    expect(calls.filter((c) => c.name === 'TableCell')).toHaveLength(4)
    // header row cells are bold, body cells are not
    expect(runs.some((r) => r.text === 'H1' && r.bold === true)).toBe(true)
    expect(runs.some((r) => r.text === 'a' && r.bold === false)).toBe(true)
  })
})

// ─────────── XLSX builder → exceljs call sequence (mock the lib) ───────────

describe('buildXlsxWorkbook', () => {
  it('adds one worksheet per sheet, a bold header row, and formula cells', () => {
    const { lib, sheets } = fakeExcel()
    buildXlsxWorkbook(
      {
        sheets: [
          {
            name: 'Data',
            columns: ['A', 'B', 'Sum'],
            rows: [
              [1, 2, { formula: 'A2+B2' }],
              [3, 4, { formula: 'A3+B3' }]
            ]
          },
          { name: 'Empty', rows: [] }
        ]
      },
      lib
    )
    expect(sheets.map((s) => s.name)).toEqual(['Data', 'Empty'])
    // header + 2 data rows on sheet 1
    expect(sheets[0].rows).toHaveLength(3)
    expect(sheets[0].rows[0].values).toEqual(['A', 'B', 'Sum'])
    expect(sheets[0].rows[0].font).toEqual({ bold: true }) // header bolded
    // formula cell rendered as {formula}
    expect(sheets[0].rows[1].values[2]).toEqual({ formula: 'A2+B2' })
    // no header row when columns absent
    expect(sheets[1].rows).toHaveLength(0)
  })
})

// ─────────── PPTX builder → pptxgenjs call sequence (mock the lib) ───────────

describe('buildPptxPresentation', () => {
  it('creates one slide per entry with a title box and bulleted body', () => {
    const { Ctor, slides, meta } = fakePptx()
    buildPptxPresentation(
      {
        title: 'Q3',
        slides: [{ title: 'Agenda', bullets: ['one', 'two'], body: 'note' }, { title: 'End' }]
      },
      Ctor
    )
    expect(meta.title).toBe('Q3')
    expect(meta.layout).toBe('LAYOUT_WIDE')
    expect(slides).toHaveLength(2)

    // slide 1: title text + bullet runs (array of {text,options:{bullet}}) + body text
    const s1 = slides[0].texts
    expect(s1[0].text).toBe('Agenda')
    expect((s1[0].opts as { bold?: boolean }).bold).toBe(true)
    const bulletCall = s1.find((t) => Array.isArray(t.text))
    expect(bulletCall).toBeTruthy()
    expect((bulletCall!.text as { text: string; options: { bullet: boolean } }[]).map((r) => r.text)).toEqual([
      'one',
      'two'
    ])
    expect(s1.some((t) => t.text === 'note')).toBe(true)

    // slide 2: only a title box (no bullets/body)
    expect(slides[1].texts).toHaveLength(1)
    expect(slides[1].texts[0].text).toBe('End')
  })
})

// ─────────────────────────── CSV fallback (no lib) ───────────────────────────

describe('csvField', () => {
  it('quotes fields with comma/quote/newline and escapes quotes', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('he said "hi"')).toBe('"he said ""hi"""')
    expect(csvField('line1\nline2')).toBe('"line1\nline2"')
    expect(csvField(42)).toBe('42')
    expect(csvField(null)).toBe('')
  })
  it('renders a formula cell with a leading =', () => {
    expect(csvField({ formula: 'SUM(A1:A2)' })).toBe('=SUM(A1:A2)')
  })
})

describe('specToCsv', () => {
  it('emits only the first sheet: header row then data rows, CRLF-joined', () => {
    const csv = specToCsv({
      sheets: [
        { name: 'One', columns: ['x', 'y'], rows: [[1, 2], ['a,b', 3]] },
        { name: 'Two', rows: [[9]] } // ignored
      ]
    })
    expect(csv).toBe('x,y\r\n1,2\r\n"a,b",3')
  })
  it('works with no header row', () => {
    expect(specToCsv({ sheets: [{ rows: [[1], [2]] }] })).toBe('1\r\n2')
  })
})
