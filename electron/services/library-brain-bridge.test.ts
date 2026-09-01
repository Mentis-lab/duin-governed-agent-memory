import { describe, it, expect } from 'vitest'
import { buildSidecar, sanitizeTitle, stripLeadingFrontmatter } from './library-brain-bridge'
import type { DocumentReadyInfo } from './rag/ingest'

const doc = (over: Partial<DocumentReadyInfo>): DocumentReadyInfo => ({
  documentId: 'doc-1',
  collectionId: 'c',
  displayName: 'Q3 Budget.pptx',
  sourcePath: 'C:\\Users\\me\\Q3 Budget.pptx',
  mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  text: 'Budget review covered server costs and cloud infrastructure.',
  ...over
})

describe('sanitizeTitle', () => {
  it('drops the extension and illegal filename chars', () => {
    expect(sanitizeTitle('Q3 Budget.pptx')).toBe('Q3_Budget')
    expect(sanitizeTitle('a/b:c*?.md')).toBe('a_b_c')
    expect(sanitizeTitle('.pdf')).toBe('document') // no name → fallback
  })
})

describe('stripLeadingFrontmatter', () => {
  it('removes a single leading YAML block (officeParser md output)', () => {
    const t = '---\nauthor: "openpyxl"\ncreated: 2026\n---\nActual body text here.'
    expect(stripLeadingFrontmatter(t)).toBe('Actual body text here.')
  })
  it('leaves text without frontmatter untouched', () => {
    expect(stripLeadingFrontmatter('no frontmatter here')).toBe('no frontmatter here')
  })
})

describe('buildSidecar', () => {
  it('emits frontmatter + heading + body with a sanitized title', () => {
    const out = buildSidecar(doc({}), '2026-07-02')
    expect(out).not.toBeNull()
    expect(out!.title).toBe('Q3_Budget')
    expect(out!.content).toContain('type: document')
    expect(out!.content).toContain('doc_id: doc-1')
    expect(out!.content).toContain('ingested: 2026-07-02')
    expect(out!.content).toContain('tags: [document, library]')
    expect(out!.content).toContain('# Q3_Budget')
    expect(out!.content).toContain('Budget review covered server costs')
    // forward-slashed source path in frontmatter
    expect(out!.content).toContain('C:/Users/me/Q3 Budget.pptx')
  })

  it('does not nest officeParser frontmatter under ours', () => {
    const out = buildSidecar(doc({ text: '---\nauthor: "openpyxl"\n---\nReal content.' }), '2026-07-02')
    // exactly ONE frontmatter block (ours), then the body
    expect(out!.content.match(/^---$/gm)?.length).toBe(2)
    expect(out!.content).toContain('Real content.')
    expect(out!.content).not.toContain('openpyxl')
  })

  it('returns null for an empty/whitespace document (nothing to bridge)', () => {
    expect(buildSidecar(doc({ text: '   \n  ' }), '2026-07-02')).toBeNull()
  })
})
