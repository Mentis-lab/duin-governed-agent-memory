// Backlog finding 11 (critical). The New Skill wizard labelled the field "Allowed tools
// … leave empty for no restriction", which reads as enforcement. Nothing enforces it:
// SKILL_FIELD_DISPOSITION.allowedTools is `kind: 'advisory'` with an explicit
// notEnforcedBy note, and both renderers emit it as `suggested-tools` precisely so the
// wording does not imply a gate. Anyone who scoped a skill down for safety — a read-only
// helper, a lower-trust delegation — was running with every tool they believed removed.
// The sibling allowedTools mechanisms in this same app (subagents, permissions) ARE
// enforced, which is exactly what made this one read as trustworthy.
//
// Lives on the electron side because the contract does, and asserts against the wizard's
// SOURCE because this repo has no jsdom — the rendered label cannot be queried. The
// contract is the authority; this pins the UI copy to it so they cannot drift apart
// again in silence.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { SKILL_FIELD_DISPOSITION } from '../shared/skill-contract'

const WIZARD = join(__dirname, '..', '..', 'src', 'components', 'customize', 'NewSkillWizard.tsx')
const wizard = readFileSync(WIZARD, 'utf-8')

describe('New Skill wizard — the tool list is labelled as what it is', () => {
  it('the contract still says this field is advisory, not enforced', () => {
    const d = SKILL_FIELD_DISPOSITION.allowedTools
    // Narrowed rather than cast: if allowedTools ever becomes 'wired', this fails FIRST,
    // and the label below is meant to change WITH it, never before it.
    expect(d.kind).toBe('advisory')
    if (d.kind !== 'advisory') throw new Error('allowedTools is no longer advisory')
    expect(d.uiLabel).toBe('suggested-tools')
    expect(d.notEnforcedBy).toBeTruthy()
  })

  it('uses the contract wording rather than promising a restriction', () => {
    expect(wizard).toMatch(/Suggested tools/)
    expect(wizard).toMatch(/not a restriction/i)
  })

  it('no longer tells the user an empty list means "no restriction"', () => {
    // The exact phrasing that made an advisory hint read as a safety control.
    expect(wizard).not.toMatch(/leave empty for no\s+restriction/)
    expect(wizard).not.toMatch(/Allowed tools \(/)
  })
})
