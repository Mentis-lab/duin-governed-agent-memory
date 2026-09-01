import { describe, it, expect } from 'vitest'
import { endorsementFact } from './endorsement-fact'
import type { Correction } from '../brain/learn-native'

const row = (o: Partial<Correction>): Correction => ({ polarity: 'positive', candidate_rule: 'lead with the outcome', skill: 'capture-hook', ...o })

describe('endorsementFact — positive-governed capture (SIA activation)', () => {
  it('mints a governed operator candidate from a genuine operator endorsement', () => {
    expect(endorsementFact(row({}))).toEqual({ fact: 'lead with the outcome', kind: 'preference', source: 'operator' })
  })
  it('ignores corrections (only endorsements enter via this path)', () => {
    expect(endorsementFact(row({ polarity: 'correction' }))).toBeNull()
  })
  it('ignores machine rows (never govern a machine-authored signal)', () => {
    expect(endorsementFact(row({ source: 'agent' } as Partial<Correction>))).toBeNull()
  })
  it('ignores the operator-model promote-weld (its rule is already governed)', () => {
    expect(endorsementFact(row({ skill: 'operator-model' }))).toBeNull()
  })
  it('ignores an endorsement with no distilled rule', () => {
    expect(endorsementFact(row({ candidate_rule: '' }))).toBeNull()
    expect(endorsementFact(row({ candidate_rule: 'ok' }))).toBeNull() // < 3 chars
  })
})
