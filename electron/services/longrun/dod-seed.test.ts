import { describe, it, expect } from 'vitest'
import { seedDefinitionOfDone, evaluateDoD, type DefinitionOfDone } from './dod-seed'

// DoD-SEED (2BRAIN) — the seed half of the per-task falsifiable contract. Pure.

describe('seedDefinitionOfDone', () => {
  it('a covering task seeds covers-active-tracks + no-orphan-claims', () => {
    const dod = seedDefinitionOfDone({
      activeTracks: ['北澜', 'orbis', 'AIT'],
      expectsCoverage: true
    })
    expect(dod.acceptanceCriteria.map((c) => c.kind)).toEqual([
      'covers-active-tracks',
      'no-orphan-claims'
    ])
    expect(dod.acceptanceCriteria[0].requiredTracks).toEqual(['北澜', 'orbis', 'AIT'])
    expect(dod.seededFromTracks).toEqual(['北澜', 'orbis', 'AIT'])
  })

  it('a point-task (no coverage) seeds only no-orphan-claims', () => {
    const dod = seedDefinitionOfDone({ activeTracks: ['北澜'], expectsCoverage: false })
    expect(dod.acceptanceCriteria.map((c) => c.kind)).toEqual(['no-orphan-claims'])
  })

  it('a covering task with NO active tracks seeds only no-orphan-claims (nothing to cover)', () => {
    const dod = seedDefinitionOfDone({ activeTracks: [], expectsCoverage: true })
    expect(dod.acceptanceCriteria.map((c) => c.kind)).toEqual(['no-orphan-claims'])
  })

  it('drops blank track labels from the coverage universe', () => {
    const dod = seedDefinitionOfDone({ activeTracks: ['北澜', '  ', ''], expectsCoverage: true })
    expect(dod.seededFromTracks).toEqual(['北澜'])
  })
})

describe('evaluateDoD', () => {
  const covering: DefinitionOfDone = seedDefinitionOfDone({
    activeTracks: ['北澜', 'orbis', 'AIT'],
    expectsCoverage: true
  })

  it('passes when the output covers every seeded track and has no orphan claims', () => {
    const e = evaluateDoD(covering, {
      coveredTracks: ['orbis', '北澜', 'AIT'],
      orphanClaims: []
    })
    expect(e.pass).toBe(true)
    expect(e.perCriterion).toEqual([
      { kind: 'covers-active-tracks', state: 'pass' },
      { kind: 'no-orphan-claims', state: 'pass' }
    ])
  })

  it('BLOCKS when the output silently drops an active track', () => {
    const e = evaluateDoD(covering, { coveredTracks: ['北澜', 'orbis'], orphanClaims: [] })
    expect(e.pass).toBe(false)
    expect(e.failures[0]).toMatch(/missed 1 active track.*AIT/)
  })

  it('BLOCKS on an orphan claim (no supporting note)', () => {
    const e = evaluateDoD(covering, {
      coveredTracks: ['北澜', 'orbis', 'AIT'],
      orphanClaims: ['revenue up 40%']
    })
    expect(e.pass).toBe(false)
    expect(e.failures[0]).toMatch(/1 orphan claim/)
  })

  it('track coverage is case/whitespace-insensitive (forgiving fold)', () => {
    const e = evaluateDoD(covering, {
      coveredTracks: [' 北澜 ', 'ORBIS', 'ait'],
      orphanClaims: []
    })
    expect(e.pass).toBe(true)
  })

  it('SKIPS a criterion whose observation is absent (fail-safe-open)', () => {
    const e = evaluateDoD(covering, {}) // no coveredTracks, no orphanClaims
    expect(e.pass).toBe(true)
    expect(e.perCriterion.every((c) => c.state === 'skip')).toBe(true)
  })

  it('reports BOTH failures when a task drops a track AND orphans a claim', () => {
    const e = evaluateDoD(covering, { coveredTracks: ['北澜'], orphanClaims: ['x'] })
    expect(e.pass).toBe(false)
    expect(e.failures.length).toBe(2)
  })
})
