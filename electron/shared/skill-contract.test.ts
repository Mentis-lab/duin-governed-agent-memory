// skill-contract.test.ts — keeps the skill schema honest as it grows.
//
// The compile-time Record already forces a new field to declare a disposition. These tests enforce
// the parts types cannot: that a 'wired' claim names a consumer, that an 'unwired' field is a
// deliberate recorded decision rather than an oversight, and that the advisory tool list is
// rendered with wording that does not imply a gate.

import { describe, it, expect } from 'vitest'
import {
  SKILL_FIELD_DISPOSITION,
  SKILL_FIELDS_REACHING_MODEL,
  UNWIRED_SKILL_FIELDS,
  type SkillField
} from './skill-contract'
import { renderActiveSkills, ACTIVE_SKILLS_TOTAL_CHAR_BUDGET } from '../services/local-brain/active-skills'

describe('skill field contract', () => {
  it('every field declares a disposition (the Record type; asserted at runtime too)', () => {
    const fields: SkillField[] = ['id', 'name', 'description', 'content', 'allowedTools', 'model', 'autoInvoke']
    for (const f of fields) expect(SKILL_FIELD_DISPOSITION[f], `'${f}' has no disposition`).toBeDefined()
  })

  it('a WIRED field names its consumer and its effect — no bare claims', () => {
    for (const [field, d] of Object.entries(SKILL_FIELD_DISPOSITION)) {
      if (d.kind !== 'wired') continue
      expect(d.consumer.length, `'${field}' claims wired with no consumer`).toBeGreaterThan(5)
      expect(d.effect.length, `'${field}' claims wired with no stated effect`).toBeGreaterThan(10)
    }
  })

  it('an UNWIRED field records why, and what wiring it would take', () => {
    for (const field of UNWIRED_SKILL_FIELDS) {
      const d = SKILL_FIELD_DISPOSITION[field]
      if (d.kind !== 'unwired') continue
      expect(d.reason.length, `'${field}' is unwired with no recorded reason`).toBeGreaterThan(30)
      expect(d.wouldNeed.length, `'${field}' is unwired with no path to wiring it`).toBeGreaterThan(20)
    }
  })

  it('the known dead controls are exactly model + autoInvoke', () => {
    // If this fails, either a dead field was fixed (update the list) or a NEW one appeared. Both
    // deserve a human deciding, which is the point.
    expect([...UNWIRED_SKILL_FIELDS].sort()).toEqual(['autoInvoke', 'model'])
  })

  it('an ADVISORY field states what does NOT enforce it', () => {
    for (const [field, d] of Object.entries(SKILL_FIELD_DISPOSITION)) {
      if (d.kind !== 'advisory') continue
      expect(d.notEnforcedBy.length, `'${field}' is advisory without naming what fails to enforce it`).toBeGreaterThan(20)
    }
  })

  it('allowedTools renders under its advisory label, never as an enforcement promise', () => {
    const d = SKILL_FIELD_DISPOSITION.allowedTools
    expect(d.kind).toBe('advisory')
    const block = renderActiveSkills([
      { name: 'S', content: 'body', allowedTools: ['read_file'] }
    ])
    if (d.kind === 'advisory') expect(block).toContain(`${d.uiLabel}=`)
    expect(block).not.toContain('allowed-tools=')
  })

  it('every field reaching the model is actually rendered by renderActiveSkills', () => {
    const block = renderActiveSkills([
      { name: 'TheName', content: 'TheBody', description: 'TheDescription', allowedTools: ['read_file'] }
    ])
    // id is the selection key, not rendered text — it reaches the model by choosing WHICH skill.
    for (const f of SKILL_FIELDS_REACHING_MODEL.filter((k) => k !== 'id')) {
      const probe = { name: 'TheName', description: 'TheDescription', content: 'TheBody', allowedTools: 'read_file' }[
        f as 'name' | 'description' | 'content' | 'allowedTools'
      ]
      expect(block, `'${f}' claims to reach the model but is absent from the block`).toContain(probe)
    }
  })
})

describe('ACTIVE SKILLS budget discipline', () => {
  const big = (name: string, chars: number) => ({ name, content: 'x'.repeat(chars) })

  it('a single oversized skill is truncated, not dropped', () => {
    const block = renderActiveSkills([big('Huge', ACTIVE_SKILLS_TOTAL_CHAR_BUDGET * 3)])
    expect(block).toContain('name="Huge"')
    expect(block).toContain('skill truncated')
    expect(block.length).toBeLessThan(ACTIVE_SKILLS_TOTAL_CHAR_BUDGET * 2)
  })

  it('skills beyond the budget are NAMED, never silently dropped', () => {
    const block = renderActiveSkills([big('First', 5_000), big('Second', 5_000), big('Third', 5_000)])
    expect(block).toContain('name="First"')
    // Whatever does not fit must be announced by name.
    const omittedNamed = ['Second', 'Third'].filter((n) => block.includes(n))
    expect(omittedNamed.length).toBeGreaterThan(0)
    if (!block.includes('name="Third"')) expect(block).toContain('omitted here because')
  })

  it('the budget never yields an empty block when skills are enabled', () => {
    // Silently rendering nothing would recreate the original defect intermittently — the worst
    // possible outcome, because it would only bite on long conversations.
    expect(renderActiveSkills([big('OnlyOne', 999_999)])).not.toBe('')
  })

  it('a normal skill set is untouched by the budget', () => {
    const block = renderActiveSkills([
      { name: 'A', content: 'short a' },
      { name: 'B', content: 'short b' }
    ])
    expect(block).toContain('short a')
    expect(block).toContain('short b')
    expect(block).not.toContain('omitted here because')
    expect(block).not.toContain('truncated')
  })
})
