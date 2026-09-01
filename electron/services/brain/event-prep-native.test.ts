import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { eventPrep } from './event-prep-native'

describe('event-prep-native (unification: /state/event-prep)', () => {
  let dir: string

  const anchorFile = (proj: string, file: string, fm: Record<string, string>): void => {
    const p = join(dir, '03 Projects', proj)
    mkdirSync(p, { recursive: true })
    writeFileSync(
      join(p, file),
      ['---', 'type: anchor', ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), '---', '# ' + (fm.name || file)].join('\n'),
      'utf-8'
    )
  }
  const tasksFile = (proj: string, lines: string[]): void => {
    const p = join(dir, '03 Projects', proj)
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'Tasks.md'), lines.join('\n'), 'utf-8')
  }
  const futures = (rows: unknown[]): void => {
    const sd = join(dir, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
    writeFileSync(join(sd, 'future-nodes.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8')
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-ep-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('unknown event id → ok:false with empty tasks/moves', () => {
    anchorFile('L', '(C) anchor-l.md', { 'anchor-id': 'launch', name: 'Launch', date: '2026-07-10', 'binds-contexts': 'launch' })
    const r = eventPrep(dir, 'nope')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('unknown event')
    expect(r.tasks).toEqual([])
    expect(r.moves).toEqual([])
    expect(r.counts).toBeUndefined()
  })

  it('null vaultDir → ok:false, never throws', () => {
    expect(() => eventPrep(null, 'launch')).not.toThrow()
    expect(eventPrep(null, 'launch').ok).toBe(false)
  })

  it('binds prep tasks (drops done) + feeds moves, truncates text to 140', () => {
    anchorFile('L', '(C) anchor-l.md', { 'anchor-id': 'launch', name: 'Launch', date: '2026-07-10', 'binds-contexts': 'launch' })
    tasksFile('L', [
      `- [ ] ${'x'.repeat(200)} {{contexts:: launch}} {{dateDue:: 2026-07-05}}`, // bound, text > 140
      '- [ ] unrelated task {{contexts:: other}}', // not bound
      '- [x] finished {{contexts:: launch}}' // done → excluded
    ])
    futures([
      { id: 's1', title: 'Platform stream', track: 'work', status: 'open', anchor_id: 'launch' },
      { id: 's2', title: 'declined one', status: 'declined', anchor_id: 'launch' }, // declined → excluded
      { id: 's3', title: 'other anchor', status: 'open', anchor_id: 'else' } // wrong anchor → excluded
    ])
    const r = eventPrep(dir, 'launch')
    expect(r.ok).toBe(true)
    expect(r.event).toEqual({ id: 'launch', name: 'Launch', date: '2026-07-10' })
    expect(r.tasks).toHaveLength(1)
    expect(r.tasks[0].text.length).toBe(140)
    expect(r.tasks[0].due).toBe('2026-07-05')
    expect(r.moves).toEqual([{ id: 's1', title: 'Platform stream', track: 'work' }])
    expect(r.counts).toEqual({ tasks: 1, moves: 1 })
  })
})
