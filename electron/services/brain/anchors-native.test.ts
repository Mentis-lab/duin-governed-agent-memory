import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { anchors } from './anchors-native'

describe('anchors-native (unification: /state/anchors)', () => {
  let dir: string
  const NOW = new Date('2026-07-01T09:00:00+08:00') // local day 2026-07-01

  const anchorFile = (proj: string, file: string, fm: Record<string, string>): void => {
    const p = join(dir, '03 Projects', proj)
    mkdirSync(p, { recursive: true })
    const body = ['---', 'type: anchor', ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), '---', '# ' + (fm.name || file)]
    writeFileSync(join(p, file), body.join('\n'), 'utf-8')
  }
  const tasksFile = (proj: string, lines: string[]): void => {
    const p = join(dir, '03 Projects', proj)
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'Tasks.md'), lines.join('\n'), 'utf-8')
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-anch-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('no anchor decls → the empty note', () => {
    const r = anchors(dir, NOW)
    expect(r.anchors).toEqual([])
    expect(r.convergence).toEqual([])
    expect(r.note).toBe('no (C) anchor-*.md declarations found')
    expect(r.generated).toBeUndefined()
  })

  it('binds tasks, rolls up branch risk red, computes days_out + critical path', () => {
    anchorFile('Launch', '(C) anchor-launch.md', {
      'anchor-id': 'launch',
      name: 'Launch',
      kind: 'event',
      date: '2026-07-10',
      'binds-contexts': 'launch',
      attendees: 'Theo, Sam',
    })
    tasksFile('Launch', [
      '- [ ] Ship the build {{contexts:: launch}} {{priority:: 1}} {{dateDue:: 2020-01-01}}', // overdue P1 → red
      '- [ ] Write notes {{contexts:: launch}} {{dateDue:: 2026-07-05}}',
      '- [x] done thing {{contexts:: launch}}', // done → excluded
    ])
    const r = anchors(dir, NOW)
    expect(r.anchors).toHaveLength(1)
    const a = r.anchors[0]
    expect(a.id).toBe('launch')
    expect(a.item_count).toBe(2) // done task excluded
    expect(a.days_out).toBe(9) // 07-10 minus 07-01
    expect(a.risk).toBe('red') // an overdue P1 is present
    // critical path sorted by due ascending; the 2020 overdue task first, slack negative
    expect(a.critical_path[0].due).toBe('2020-01-01')
    expect(a.critical_path[0].slack_days).toBeLessThan(0)
    expect(a.critical_path[1].due).toBe('2026-07-05')
    expect(r.generated).toBe('2026-07-01')
    expect(r.invariant).toContain('never by date proximity')
  })

  it('surfaces DECLARED convergence on a shared attendee (not date proximity)', () => {
    anchorFile('A', '(C) anchor-a.md', { 'anchor-id': 'a1', name: 'Alpha', date: '2026-07-10', attendees: 'Theo, Sam' })
    anchorFile('B', '(C) anchor-b.md', { 'anchor-id': 'b1', name: 'Beta', date: '2026-08-01', attendees: 'Theo, Zoe' })
    const r = anchors(dir, NOW)
    expect(r.convergence).toHaveLength(1)
    const c = r.convergence[0] as { anchors: string[]; shared_resource: string[] }
    expect(c.anchors).toEqual(['a1', 'b1'])
    expect(c.shared_resource).toEqual(['Theo'])
  })

  it('confidential anchors never enter a shared convergence node', () => {
    anchorFile('A', '(C) anchor-a.md', { 'anchor-id': 'a1', name: 'Alpha', date: '2026-07-10', attendees: 'Theo' })
    anchorFile('B', '(C) anchor-b.md', {
      'anchor-id': 'b1',
      name: 'Beta',
      date: '2026-08-01',
      attendees: 'Theo',
      confidential: 'true',
    })
    expect(anchors(dir, NOW).convergence).toEqual([])
  })
})
