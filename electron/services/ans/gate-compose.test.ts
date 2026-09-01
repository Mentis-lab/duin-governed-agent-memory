import { describe, it, expect } from 'vitest'
import { composeTierRung } from './gate-compose'

// Govern — least-permissive meet of the consequence-tier gate and the ANS rung. Pure.

describe('composeTierRung', () => {
  it('rung=null (not an ANS capability) leaves the tier verdict untouched', () => {
    expect(composeTierRung('allow', null)).toEqual({ kind: 'allow', tightenedByRung: false, rung: null })
    expect(composeTierRung('deny', null)).toEqual({ kind: 'deny', tightenedByRung: false, rung: null })
  })

  it('reflexive rung never tightens (fully autonomous capability)', () => {
    expect(composeTierRung('allow', 'reflexive')).toMatchObject({ kind: 'allow', tightenedByRung: false })
    expect(composeTierRung('prompt', 'reflexive')).toMatchObject({ kind: 'prompt', tightenedByRung: false })
  })

  it('stage rung downgrades a tier-allow to prompt (needs staging)', () => {
    expect(composeTierRung('allow', 'stage')).toMatchObject({ kind: 'prompt', tightenedByRung: true })
  })

  it('hold rung denies a tier-allow (pinned capability)', () => {
    expect(composeTierRung('allow', 'hold')).toMatchObject({ kind: 'deny', tightenedByRung: true })
  })

  it('hold rung denies even a tier-prompt', () => {
    expect(composeTierRung('prompt', 'hold')).toMatchObject({ kind: 'deny', tightenedByRung: true })
  })

  it('the rung can only TIGHTEN — a tier-deny is never loosened by a permissive rung', () => {
    expect(composeTierRung('deny', 'reflexive')).toMatchObject({ kind: 'deny', tightenedByRung: false })
    expect(composeTierRung('deny', 'stage')).toMatchObject({ kind: 'deny', tightenedByRung: false })
  })

  it('a stage rung does not loosen a tier-prompt (meet is prompt, unchanged)', () => {
    expect(composeTierRung('prompt', 'stage')).toMatchObject({ kind: 'prompt', tightenedByRung: false })
  })
})
