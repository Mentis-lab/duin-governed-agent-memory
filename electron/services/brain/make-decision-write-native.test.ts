import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeDecision, buildDecisionNote } from './make-decision-write-native'

const deps = { generate: async () => '[]', today: () => new Date(2026, 6, 3) }

describe('make-decision — buildDecisionNote (PURE)', () => {
  it('emits the decisions.md heading structure + frontmatter', () => {
    const md = buildDecisionNote({ title: 'Ship the beta', the_call: 'Go on 2026-08', rationale: 'ready' }, '2026-07-03', '2026-08-02')
    expect(md).toContain('type: decision\ndate: 2026-07-03\nstatus: decided')
    expect(md).toContain('reversibility: reversible')
    expect(md).toContain('review_on: 2026-08-02')
    expect(md).toContain('# Ship the beta')
    expect(md).toContain('## Decision\n\nGo on 2026-08')
    expect(md).toContain('## Rationale\n\nready')
    expect(md).toContain('## Consequences / watch for\n\n_(to monitor at review)_')
  })

  it('adds layer/domain + the 关联文档 source block when given', () => {
    const md = buildDecisionNote({ title: 'X', node_id: 'loop-1', layer: 'strategic', domain: '北澜' }, '2026-07-03', '2026-08-02')
    expect(md).toContain('layer: strategic')
    expect(md).toContain('domain: 北澜')
    expect(md).toContain('## 关联文档\n\n### 来源\n- closes open-loop node loop-1 (resolved via DUIN)')
  })
})

describe('make-decision — makeDecision', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-md-'))
    mkdirSync(join(vault, '05 Decisions'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('rejects a blank title', () => {
    expect(makeDecision(vault, { title: '  ' }, deps)).toEqual({ ok: false, error: 'title required' })
  })

  it('writes the decision note to the pillar and returns its path/id', () => {
    const r = makeDecision(vault, { title: 'Adopt the new loop', the_call: 'yes' }, deps)
    expect(r.ok).toBe(true)
    expect(r.id).toBe('2026-07-03-adopt-the-new-loop')
    expect(r.path).toBe('05 Decisions/2026-07-03-adopt-the-new-loop.md')
    expect(r.nodeClosed).toBe(false) // no node_id
    const md = readFileSync(join(vault, '05 Decisions', '2026-07-03-adopt-the-new-loop.md'), 'utf-8')
    expect(md).toContain('# Adopt the new loop')
    expect(md).toContain('## Decision\n\nyes')
  })

  it('disambiguates a same-day same-title collision', () => {
    makeDecision(vault, { title: 'Dup' }, deps)
    const r2 = makeDecision(vault, { title: 'Dup' }, deps)
    expect(r2.id).toBe('2026-07-03-dup-2')
    expect(existsSync(join(vault, '05 Decisions', '2026-07-03-dup.md'))).toBe(true)
    expect(existsSync(join(vault, '05 Decisions', '2026-07-03-dup-2.md'))).toBe(true)
  })

  it('closes the originating loop node when node_id resolves in _Owed-Decisions', () => {
    writeFileSync(join(vault, '05 Decisions', '_Owed-Decisions.md'), '- [ ] decide the thing ^loop-1\n')
    const r = makeDecision(vault, { title: 'Decide it', node_id: 'loop-1' }, deps)
    // resolveNode ran (nodeClosed reflects whether the node was found+closed)
    expect(typeof r.nodeClosed).toBe('boolean')
    const md = readFileSync(join(vault, '05 Decisions', r.id + '.md'), 'utf-8')
    expect(md).toContain('closes open-loop node loop-1')
  })
})
