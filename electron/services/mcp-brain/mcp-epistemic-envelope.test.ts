import { describe, it, expect } from 'vitest'
import { epistemicStatus, wrapEpistemic } from './mcp-epistemic-envelope'

describe('mcp-epistemic-envelope (CannotProve contract)', () => {
  it('flags structurally-empty reads as cannot-prove (incl. n:0 calibration + empty content arrays)', () => {
    for (const t of [
      '',
      '   ',
      '(none)',
      'null',
      '[]',
      '{}',
      '{"facts":[]}',
      '{"generatedAt":123,"facts":[]}',
      '{"capabilities":[],"loops":[]}',
      '{"n":0,"brier":null,"reliability":[]}'
    ]) {
      expect(epistemicStatus(t)).toBe('cannot-prove')
    }
  })

  it('treats real content as evidence', () => {
    for (const t of [
      '{"facts":[{"id":"x"}]}',
      '{"n":60,"brier":0.15,"reliability":[{"lo":0.1}]}',
      'plain non-json answer',
      '{"ok":true}'
    ]) {
      expect(epistemicStatus(t)).toBe('evidence')
    }
  })

  it('wraps cannot-prove with the not-permission guard, body preserved', () => {
    const w = wrapEpistemic('[]')
    expect(w).toMatch(/cannot-prove/)
    expect(w).toMatch(/not a green light|not.*permission/i)
    expect(w).toContain('[]')
  })

  it('wraps evidence with a status tag, body preserved verbatim', () => {
    const w = wrapEpistemic('{"n":60}')
    expect(w).toMatch(/evidence/)
    expect(w).toContain('{"n":60}')
  })
})
