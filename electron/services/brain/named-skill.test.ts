import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { distillToSkill, selectSkills, DEFAULT_NAMED_SKILL_POLICY, type NamedSkill } from './named-skill'
import { loadNamedSkills, appendNamedSkill } from './named-skill-store'

const TRACE = { id: 'sx-1', query: 'how do I bind a rule?', answer: 'call POST /state/bind-candidate' }
const D = {
  name: 'Bind a rule',
  description: 'When a recurrence should become a durable rule',
  procedure: 'POST /state/bind-candidate with theme + rule'
}

describe('named-skill — distillToSkill', () => {
  it('mints a record from the trace + injected distillation, with a deterministic id', () => {
    const s = distillToSkill(TRACE, D, 1000, 'seed-x')
    expect(s.name).toBe('Bind a rule')
    expect(s.procedure).toMatch(/bind-candidate/)
    expect(s.sourceTraceIds).toEqual(['sx-1'])
    expect(s.createdAt).toBe(1000)
    expect(distillToSkill(TRACE, D, 1000, 'seed-x').id).toBe(s.id) // deterministic (no clock/random)
  })
  it('falls back to "unnamed skill" on an empty name', () => {
    expect(distillToSkill(TRACE, { name: '', description: 'd', procedure: 'p' }, 1).name).toBe('unnamed skill')
  })
})

describe('named-skill — selectSkills', () => {
  const skills: NamedSkill[] = [
    { id: 'a', name: 'Bind', description: 'bind a recurring rule', procedure: '', sourceTraceIds: [], relatedSkillIds: [], createdAt: 0 },
    { id: 'b', name: 'Forecast', description: 'log a prediction', procedure: '', sourceTraceIds: [], relatedSkillIds: [], createdAt: 0 }
  ]
  // injected scorer: fraction of query words present in the text
  const score = (q: string, text: string): number => {
    const qw = q.toLowerCase().split(/\W+/).filter(Boolean)
    const t = text.toLowerCase()
    return qw.length ? qw.filter((w) => t.includes(w)).length / qw.length : 0
  }
  it('ranks by the injected scorer and respects floor + topK', () => {
    const out = selectSkills('bind a rule', skills, score, { topK: 1, floor: 0.2 })
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('a')
  })
  it('drops everything below the floor', () => {
    expect(selectSkills('xyzzy quux', skills, score, DEFAULT_NAMED_SKILL_POLICY)).toEqual([])
  })
})

describe('named-skill-store — append + dedup (composability-safe)', () => {
  it('appends once, then dedups by id so a re-distill cannot duplicate/corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-'))
    mkdirSync(join(dir, '.duin', '_state'), { recursive: true })
    const s = distillToSkill(TRACE, D, 5, 'seed-y')
    expect(appendNamedSkill(dir, s)).toBe(true)
    expect(appendNamedSkill(dir, s)).toBe(false) // dedup by id
    expect(loadNamedSkills(dir)).toHaveLength(1)
  })
})
