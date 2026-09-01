import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadOntology, defaultOntology, clearOntologyCache, DEFAULT_ONTOLOGY } from './ontology'
import { predictedRisks } from './predicted-risks-native'

function mkVault(ontology?: unknown): string {
  const v = mkdtempSync(join(tmpdir(), 'duin-onto-'))
  mkdirSync(join(v, '.duin', '_state'), { recursive: true })
  if (ontology !== undefined) {
    writeFileSync(
      join(v, '.duin', 'ontology.json'),
      typeof ontology === 'string' ? ontology : JSON.stringify(ontology)
    )
  }
  return v
}

describe('ontology loader', () => {
  const vaults: string[] = []
  afterEach(() => {
    clearOntologyCache()
    while (vaults.length) rmSync(vaults.pop()!, { recursive: true, force: true })
  })

  it('falls back to the built-in default when no ontology.json exists', () => {
    const v = mkVault()
    vaults.push(v)
    const onto = loadOntology(v)
    // Cold-start A3: the built-in default ships NO tracks — track keys were one operator's
    // real lanes. So a vault with no ontology.json classifies nothing...
    expect(onto.tracks).toEqual([])
    expect(onto.trackOf('anything at all')).toBeNull()
    // ...but the GENERIC halves of the default are still there, which is what "falls back to the
    // built-in default" has to mean for this to be a fallback rather than an empty object.
    expect(onto.thresholds).toEqual(DEFAULT_ONTOLOGY.thresholds)
    expect(onto.riskKw.test('blocker')).toBe(true)
    expect(onto.deadlineKw.test('deadline')).toBe(true)
  })

  it('applies a per-vault override for tracks and thresholds', () => {
    const v = mkVault({
      tracks: [{ key: 'ACME', match: 'acme|widget' }],
      thresholds: { decisionWindowDays: 7 }
    })
    vaults.push(v)
    const onto = loadOntology(v)
    expect(onto.trackOf('the ACME widget launch')).toBe('ACME')
    expect(onto.trackOf('some unrelated text')).toBeNull() // override REPLACES, never unions
    expect(onto.thresholds.decisionWindowDays).toBe(7)
    // unspecified thresholds keep their defaults (shallow merge)
    expect(onto.thresholds.collisionWindowDays).toBe(DEFAULT_ONTOLOGY.thresholds.collisionWindowDays)
  })

  it('never throws on a malformed file or a bad regex — returns defaults', () => {
    // "Returns defaults" is now checked against the generic default (thresholds + keyword
    // families + zero tracks) rather than against a track key, because A3 removed the operator
    // track keys. A partial parse would show up as a non-default threshold or a surviving track.
    const badJson = mkVault('{ not valid json')
    vaults.push(badJson)
    const j = loadOntology(badJson)
    expect(j.tracks).toEqual([])
    expect(j.thresholds).toEqual(DEFAULT_ONTOLOGY.thresholds)
    expect(j.riskKw.test('blocker')).toBe(true)

    const badRegex = mkVault({ tracks: [{ key: 'X', match: '(' }] }) // unbalanced group
    vaults.push(badRegex)
    const r = loadOntology(badRegex)
    expect(r.tracks).toEqual([]) // the whole override is rejected, not just the bad track
    expect(r.trackOf('X')).toBeNull()
    expect(r.thresholds).toEqual(DEFAULT_ONTOLOGY.thresholds)
  })

  it('a null/empty vaultDir yields the default ontology', () => {
    expect(loadOntology(null)).toBe(defaultOntology())
    expect(loadOntology('')).toBe(defaultOntology())
  })

  it('a per-vault ontology changes predictedRisks output end-to-end', () => {
    // Stream decides in ~14d. Default 21d window surfaces it; a 7d override hides it.
    const streams = [
      JSON.stringify({
        id: 's1',
        title: 'acme launch decision',
        status: 'open',
        decide_by: '2026-06-15',
        target: '2026-07-01'
      })
    ].join('\n')

    const wide = mkVault({ tracks: [{ key: 'ACME', match: 'acme' }] }) // default 21d window
    vaults.push(wide)
    writeFileSync(join(wide, '.duin', '_state', 'future-nodes.jsonl'), streams)
    const wideRisks = predictedRisks(wide, new Date('2026-06-01T00:00:00Z')).risks
    expect(wideRisks.find((r) => r.id === 'decide::s1')).toBeTruthy() // inside default 21d window

    const narrow = mkVault({ tracks: [{ key: 'ACME', match: 'acme' }], thresholds: { decisionWindowDays: 7 } })
    vaults.push(narrow)
    writeFileSync(join(narrow, '.duin', '_state', 'future-nodes.jsonl'), streams)
    const narrowRisks = predictedRisks(narrow, new Date('2026-06-01T00:00:00Z')).risks
    expect(narrowRisks.find((r) => r.id === 'decide::s1')).toBeFalsy() // outside 7d window
  })
})
