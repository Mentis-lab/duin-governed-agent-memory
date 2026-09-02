// W5 — the human verbs the Learning panel and the keyless card need.
//
// Before this, the only human verbs on learned facts were promote (candidate → probation) and veto.
// A keyless install parked every fact at 'ratify' with nothing to press; a veto could not be taken
// back; a supersession could not be reversed. These are the person's words for those decisions —
// Ratify (the glossary reserves "confirm" for the govern loop's automatic verification), Un-veto,
// and Revert on a superseded fact — plus the two readers the surfaces list from.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  setOperatorModelPath,
  setMaterializeHook,
  recordFacts,
  promoteFact,
  vetoFact,
  supersedeFact,
  ratifyFact,
  unvetoFact,
  revertSupersession,
  getAwaitingRatify,
  getSupersededFacts,
  getOperatorFacts,
  getAllOperatorFacts,
  recordGovernProvenance,
  __resetOperatorModel
} from './operator-model'

const seam: Array<{ id: string; action: string }> = []
const byText = (t: string) => getAllOperatorFacts().find((f) => f.fact === t)!
const byId = (id: string) => getAllOperatorFacts().find((f) => f.id === id)!
const govern = (verdict: 'ratify' | 'hold'): Parameters<typeof recordGovernProvenance>[1] =>
  ({ juryModelId: null, juryProvider: null, crossModel: false, verdict, behavioralFlip: false, ts: Date.now() }) as unknown as Parameters<typeof recordGovernProvenance>[1]

beforeEach(() => {
  setOperatorModelPath(join(mkdtempSync(join(tmpdir(), 'duin-hv-')), 'operator-model.json'))
  __resetOperatorModel()
  seam.length = 0
  setMaterializeHook((f, action) => { seam.push({ id: f.id, action }) })
})
afterEach(() => setMaterializeHook(null))

describe('ratifyFact', () => {
  it('lands a live provisional fact as promoted under human authority and projects it; refuses everything else', () => {
    recordFacts([{ fact: 'Operator prefers tea in the afternoon', kind: 'context', source: 'machine' }])
    const f = byText('Operator prefers tea in the afternoon')
    expect(ratifyFact(f.id)).toBe(false) // a candidate has nothing to ratify
    expect(promoteFact(f.id)).toBe(true) // → provisional
    seam.length = 0

    expect(ratifyFact(f.id, 'looks right')).toBe(true)
    const g = byId(f.id)
    expect(g.status).toBe('promoted')
    expect(g.adjudicatedBy).toBe('human')
    expect(g.promotedAt).toEqual(expect.any(Number))
    expect(seam).toEqual([{ id: f.id, action: 'promote' }])
    expect(ratifyFact(f.id)).toBe(false) // already a rule
    expect(ratifyFact('nope')).toBe(false)
  })

  it('refuses a superseded provisional row (retired rows never come back through ratify)', () => {
    recordFacts([{ fact: 'Operator uses VSCode as the main code editor', kind: 'context', source: 'operator' }])
    const f = byText('Operator uses VSCode as the main code editor')
    promoteFact(f.id)
    expect(supersedeFact(f.id, 'Operator uses Neovim as the main code editor', 'context', 'operator').superseded).toBe(true)
    expect(ratifyFact(f.id)).toBe(false)
    expect(byId(f.id).status).toBe('provisional') // untouched
  })
})

describe('unvetoFact', () => {
  it('takes a veto back into probation under human authority and projects it; refuses non-vetoed rows', () => {
    recordFacts([{ fact: 'Operator ships releases on Fridays', kind: 'context', source: 'operator' }])
    const f = byText('Operator ships releases on Fridays')
    expect(unvetoFact(f.id)).toBe(false) // not vetoed
    expect(vetoFact(f.id, 'wrong')).toBe(true)
    expect(byId(f.id).status).toBe('vetoed')
    seam.length = 0

    expect(unvetoFact(f.id, 'actually right')).toBe(true)
    const g = byId(f.id)
    expect(g.status).toBe('provisional')
    expect(g.adjudicatedBy).toBe('human')
    expect(g.provisionalAt).toEqual(expect.any(Number))
    expect(seam).toEqual([{ id: f.id, action: 'promote' }])
    expect(unvetoFact(f.id)).toBe(false)
  })
})

describe('revertSupersession', () => {
  it('reinstates the superseded fact under human authority and vetoes its replacement', () => {
    recordFacts([{ fact: 'Operator prefers tea in the afternoon', kind: 'context', source: 'operator' }])
    const old = byText('Operator prefers tea in the afternoon')
    promoteFact(old.id)
    const r = supersedeFact(old.id, 'Operator prefers coffee in the afternoon', 'context', 'operator')
    expect(r.superseded).toBe(true)
    expect(revertSupersession('nope')).toBe(false)
    expect(revertSupersession(r.newId!)).toBe(false) // the replacement was never superseded
    seam.length = 0

    expect(revertSupersession(old.id, 'no, tea')).toBe(true)
    const o = byId(old.id)
    expect(o.invalidatedAt).toBeUndefined()
    expect(o.supersededBy).toBeUndefined()
    expect(o.adjudicatedBy).toBe('human')
    expect(o.status).toBe('provisional') // keeps the standing it had
    expect(byId(r.newId!).status).toBe('vetoed')
    expect(seam).toEqual(expect.arrayContaining([{ id: r.newId!, action: 'retire' }, { id: old.id, action: 'promote' }]))
    expect(getOperatorFacts().map((f) => f.id)).toContain(old.id)
    expect(getSupersededFacts()).toEqual([])
    expect(revertSupersession(old.id)).toBe(false) // nothing left to revert
  })
})

describe('getAwaitingRatify / getSupersededFacts', () => {
  it('lists live provisional facts the govern pass parked at ratify, and retired rows newest first', () => {
    recordFacts([
      { fact: 'Operator prefers tea in the afternoon', kind: 'context', source: 'operator' },
      { fact: 'Operator ships releases on Fridays', kind: 'context', source: 'machine' }
    ])
    const a = byText('Operator prefers tea in the afternoon')
    const b = byText('Operator ships releases on Fridays')
    promoteFact(a.id)
    promoteFact(b.id)
    recordGovernProvenance(a.id, govern('ratify'))
    recordGovernProvenance(b.id, govern('hold'))
    expect(getAwaitingRatify().map((f) => f.id)).toEqual([a.id])
    expect(getSupersededFacts()).toEqual([])

    expect(supersedeFact(a.id, 'Operator prefers coffee in the afternoon', 'context', 'operator').superseded).toBe(true)
    expect(getAwaitingRatify()).toEqual([]) // retired rows are never awaiting
    expect(getSupersededFacts().map((f) => f.id)).toEqual([a.id])
  })
})
