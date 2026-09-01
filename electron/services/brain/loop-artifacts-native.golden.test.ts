// GOLDEN lock for the loop-artifact read routes (§4e — the loop_runner deletion
// gate). Live-diff already proved schedules/intel byte-exact on the real vault;
// this covers the empty-live cases (documents / read_document_bytes) + the schedule
// string formatting + from_schedule matching on synthetic fixtures.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listSchedules, listIntel, listDocuments, readDocumentBytes } from './loop-artifacts-native'

describe('loop-artifacts-native — golden', () => {
  let dir: string
  const w = (rel: string, text: string): void => {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text, 'utf-8')
  }
  const now = new Date('2026-07-07T12:00:00')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-la-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('listSchedules: matches loop_runner --list row shape + schedule strings', () => {
    w(
      '.duin/loops/loops.yaml',
      [
        'loops:',
        '- name: daily-digest',
        '  schedule: {daily_at: "21:30"}',
        '  run: {executor: brain, target: do it}',
        '  enabled: true',
        '  note: EOD',
        '- name: wk',
        '  schedule: {weekly_on: sun, at: "18:00"}',
        '  run: {executor: signal}',
        '  enabled: false',
        '- name: hourly',
        '  schedule: {every_hours: 6}'
      ].join('\n')
    )
    w('.duin/_state/loops-state.json', JSON.stringify({ 'daily-digest': '2026-07-07T09:00:00Z' }))
    const rows = listSchedules(dir, now).schedules
    expect(rows[0]).toEqual({
      name: 'daily-digest',
      schedule: 'daily@21:30',
      executor: 'brain',
      target: 'do it',
      enabled: true,
      paused: false,
      due: false, // now 12:00 is before today's 21:30 target → NOT due
      last: '2026-07-07T09:00:00Z',
      note: 'EOD'
    })
    expect(rows[1]).toMatchObject({ name: 'wk', schedule: 'weekly:sun@18:00', executor: 'signal', enabled: false, paused: true, due: false })
    expect(rows[2]).toMatchObject({ name: 'hourly', schedule: 'every:6h', executor: '?', target: '', last: '', due: true }) // no last → due
  })

  it('listIntel: frontmatter fields, source/from_schedule, date-desc sort', () => {
    w('.duin/loops/loops.yaml', 'loops:\n- name: daily-news-sweep\n  schedule: {every_hours: 24}')
    w('04 Notes/intel/news-sweep/a.md', '---\ntitle: Alpha\ndate: 2026-07-01\nsource: news-sweep\nsummary: s1\n---\n# Alpha\n')
    w('04 Notes/intel/b.md', '---\ndate: 2026-07-05\n---\n# Beta heading\n')
    const items = listIntel(dir).intel
    expect(items.map((i) => i.path)).toEqual(['04 Notes/intel/b.md', '04 Notes/intel/news-sweep/a.md']) // 07-05 before 07-01
    expect(items[1]).toMatchObject({
      title: 'Alpha',
      date: '2026-07-01',
      source: 'news-sweep',
      from_schedule: 'daily-news-sweep', // 'news-sweep' ⊂ 'daily-news-sweep'
      summary: 's1'
    })
    expect(items[0]).toMatchObject({ title: 'Beta heading', source: 'manual', from_schedule: '' }) // root file → manual
  })

  it('listDocuments: format/ext/source; excludes .md; read_document_bytes path-safe', () => {
    w('Outputs/reports/q2.docx', 'PK-fake-docx')
    w('Outputs/notes.md', '# not a doc')
    const docs = listDocuments(dir).documents
    expect(docs.length).toBe(1)
    expect(docs[0]).toMatchObject({ path: 'Outputs/reports/q2.docx', name: 'q2.docx', format: 'word', ext: 'docx', source: 'reports', from_schedule: '' })

    const ok = readDocumentBytes(dir, 'Outputs/reports/q2.docx')
    expect(ok?.contentType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(ok?.bytes.toString()).toBe('PK-fake-docx')
    // path traversal / outside Outputs → null
    expect(readDocumentBytes(dir, '../secret.txt')).toBeNull()
    expect(readDocumentBytes(dir, 'Outputs/missing.docx')).toBeNull()
  })
})
