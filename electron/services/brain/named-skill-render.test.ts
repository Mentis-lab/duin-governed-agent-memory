import { describe, it, expect } from 'vitest'
import { renderNamedSkills, selectSkills, type NamedSkill } from './named-skill'
import { tokens, scoreOverlap } from './skill-library'

const skill = (over: Partial<NamedSkill>): NamedSkill => ({
  id: 's', name: 'n', description: '', procedure: '', sourceTraceIds: [], relatedSkillIds: [], createdAt: 0, ...over,
})

describe('named-skill read-back (Phase 1)', () => {
  it('renderNamedSkills → empty for no skills, PROVEN PROCEDURES block otherwise', () => {
    expect(renderNamedSkills([])).toBe('')
    const block = renderNamedSkills([skill({ name: 'Draft biweekly', description: 'summarize 2 weeks', procedure: 'gather → bucket → draft' })])
    expect(block).toMatch(/PROVEN PROCEDURES/)
    expect(block).toMatch(/Draft biweekly: summarize 2 weeks/)
    expect(block).toMatch(/gather → bucket → draft/)
  })

  it('selectSkills + overlap scorer retrieves the matching skill (the read-back path)', () => {
    const skills = [
      skill({ id: 'a', name: 'Biweekly report', description: 'draft a biweekly progress report' }),
      skill({ id: 'b', name: 'OCR a scan', description: 'extract text from an image' }),
    ]
    const q = 'help me draft the biweekly report'
    const qTok = tokens(q)
    const picked = selectSkills(q, skills, (_q, text) => scoreOverlap(qTok, text))
    expect(picked.map((s) => s.id)).toContain('a')
    expect(picked.map((s) => s.id)).not.toContain('b')
  })
})
