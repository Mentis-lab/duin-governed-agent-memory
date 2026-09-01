// active-skills-grounding.test.ts — the second half of the Skills fix.
//
// The transport test (electron/shared/chat-send-contract.test.ts) proves enabled skills reach the
// /agui body. These prove the brain then puts them in the prompt — because "the value arrived" and
// "the value changed behaviour" are different claims, and conflating them is precisely how the
// original defect survived review.

import { describe, it, expect } from 'vitest'
import { renderActiveSkills } from './active-skills'

const SKILL = { name: 'Debugging', content: 'Always reproduce before fixing.' }

describe('renderActiveSkills', () => {
  it('renders an enabled skill so its body reaches the model', () => {
    const block = renderActiveSkills([SKILL])
    expect(block).toContain('ACTIVE SKILLS')
    expect(block).toContain('name="Debugging"')
    expect(block).toContain('Always reproduce before fixing.')
  })

  it('is empty when nothing is enabled — no block, no prompt change', () => {
    expect(renderActiveSkills([])).toBe('')
    expect(renderActiveSkills(undefined)).toBe('')
  })

  it('renders description and suggested-tools when present', () => {
    const block = renderActiveSkills([
      { ...SKILL, description: 'How to debug', allowedTools: ['read_file', 'run_command'] }
    ])
    expect(block).toContain('description="How to debug"')
    // Named 'suggested-tools', NOT 'allowed-tools': the gate does not enforce this list, and the
    // audit flagged the old wording as implying an enforcement that does not exist.
    expect(block).toContain('suggested-tools="read_file,run_command"')
    expect(block).not.toContain('allowed-tools=')
  })

  it('drops empty/whitespace bodies rather than emitting a hollow skill tag', () => {
    expect(renderActiveSkills([{ name: 'Empty', content: '   ' }])).toBe('')
    const block = renderActiveSkills([{ name: 'Empty', content: '' }, SKILL])
    expect(block).toContain('name="Debugging"')
    expect(block).not.toContain('name="Empty"')
  })

  it('renders every enabled skill, not just the first', () => {
    const block = renderActiveSkills([SKILL, { name: 'Writing', content: 'Lead with the outcome.' }])
    expect(block).toContain('name="Debugging"')
    expect(block).toContain('name="Writing"')
    expect(block).toContain('Lead with the outcome.')
  })
})
