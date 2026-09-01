// Backward compatibility for the built-in track keys renamed on 2026-09-01 (`3rd` -> `PartnerCo`,
// `AIX` -> `Tooling`). A vault written before the rename carries the OLD keys in its deltas,
// registry, ontology override and futures. Every read boundary funnels through
// `normalizeTrackKey`, so that data resolves to the new keys with no ontology file and no rewrite.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LEGACY_TRACK_KEYS, normalizeTrackKey, loadOntology, clearOntologyCache } from './ontology'
import { loadTrackRegistry } from './tracks-native'
import { projectionLanes } from './projection-context-native'
import { laneOf } from './telos-native'
import { langFor } from './stream-nudge-write-native'
import { extractWorldUpdate } from './world-update-native'
import { normalizeStream as normalizeWriteStream } from './stream-write-native'
import { normalizeStream as normalizeSyncStream } from './stream-sync-write-native'
import { actWorldUpdate } from './world-update-act-write-native'
import { worldState } from './world-state-native'

describe('normalizeTrackKey', () => {
  it('maps every legacy built-in key to its current key, any case, whitespace tolerated', () => {
    expect(LEGACY_TRACK_KEYS).toEqual({ '3rd': 'PartnerCo', AIX: 'Tooling' })
    expect(normalizeTrackKey('3rd')).toBe('PartnerCo')
    expect(normalizeTrackKey('AIX')).toBe('Tooling')
    expect(normalizeTrackKey('aix')).toBe('Tooling')
    expect(normalizeTrackKey('3RD')).toBe('PartnerCo')
    expect(normalizeTrackKey('  3rd ')).toBe('PartnerCo')
  })
  it('leaves current and unknown keys untouched (not even trimmed)', () => {
    for (const k of ['PartnerCo', 'Tooling', 'ProjectA', 'SupplierCo', 'ProjectB', 'personal', 'unknown', ' custom ', '']) {
      expect(normalizeTrackKey(k)).toBe(k)
    }
  })
})

describe('legacy keys at every read boundary', () => {
  let vault: string
  let state: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-trackcompat-'))
    state = join(vault, '.duin', '_state')
    mkdirSync(state, { recursive: true })
    clearOntologyCache(vault)
  })
  afterEach(() => {
    clearOntologyCache(vault)
    rmSync(vault, { recursive: true, force: true })
  })

  it('.duin/ontology.json written with the old keys compiles to the new ones (tracks + decideNoun)', () => {
    writeFileSync(
      join(vault, '.duin', 'ontology.json'),
      JSON.stringify({
        tracks: [
          { key: '3rd', match: 'partner|m&a' },
          { key: 'AIX', match: 'harness|tooling' },
          { key: 'personal', match: 'health' }
        ],
        decideNoun: { '3rd': '判断', AIX: 'decision', personal: 'choice' }
      })
    )
    const onto = loadOntology(vault)
    expect(onto.tracks.map((t) => t.key)).toEqual(['PartnerCo', 'Tooling', 'personal'])
    expect(onto.trackOf('the M&A partner pipeline')).toBe('PartnerCo')
    expect(onto.trackOf('harness work')).toBe('Tooling')
    expect(onto.decideNoun).toEqual({ PartnerCo: '判断', Tooling: 'decision', personal: 'choice' })
  })

  it('tracks.json lanes saved as 3rd / aix read back as PartnerCo / Tooling, and projectionLanes sees only new keys', () => {
    writeFileSync(
      join(state, 'tracks.json'),
      JSON.stringify([
        { id: 'x', label: 'X', lane: 'aix' },
        { id: 'y', label: 'Y', lane: '3rd' },
        { id: 'z', label: 'Z', lane: 'ProjectA' }
      ])
    )
    expect(loadTrackRegistry(vault).map((t) => t.lane)).toEqual(['Tooling', 'PartnerCo', 'ProjectA'])
    const lanes = projectionLanes(vault)
    expect(lanes).toContain('Tooling')
    expect(lanes).toContain('PartnerCo')
    expect(lanes).not.toContain('aix')
    expect(lanes).not.toContain('3rd')
    // and the core lanes are not duplicated by their legacy spelling
    expect(lanes.filter((l) => l === 'PartnerCo')).toHaveLength(1)
  })

  it('laneOf and langFor give a legacy key the same answer as its current key', () => {
    expect(laneOf('3rd')).toBe(laneOf('PartnerCo'))
    expect(laneOf('AIX')).toBe(laneOf('Tooling'))
    expect(laneOf('aix')).toBe(laneOf('Tooling'))
    expect(langFor('3rd')).toBe('Write in 日本語 (Japanese).')
    expect(langFor('3rd')).toBe(langFor('PartnerCo'))
    expect(langFor('AIX')).toBe(langFor('Tooling'))
  })

  it('a model that echoes a legacy track key produces a delta under the current key', async () => {
    const row = await extractWorldUpdate(null, 'the partner M&A pipeline moved', {
      generate: async () => '{"track":"3rd","type":"situation","summary":"moved","change":"","affects":"pipeline","confidence":0.7}',
      now: () => new Date('2026-09-01T09:00:00'),
      id: () => 'id1'
    })
    expect(row.track).toBe('PartnerCo')
  })

  it('stream normalizers accept a legacy key and persist the current one', () => {
    expect(normalizeWriteStream({ track: 'AIX', title: 'harness', objective: 'tooling' }).track).toBe('Tooling')
    writeFileSync(join(vault, '.duin', 'ontology.json'), JSON.stringify({ tracks: [{ key: 'PartnerCo', match: 'partner' }] }))
    expect(normalizeSyncStream({ track: '3rd', title: 't', objective: 'o' }, 'inferred', loadOntology(vault)).track).toBe('PartnerCo')
  })

  it('confirming a delta supersedes a prior accepted one written under the legacy key', async () => {
    const rows = [
      { id: 'old', ts: '2026-07-01T09:00:00', text: '', track: '3rd', type: 'situation', summary: 'old', change: '', affects: 'launch window', confidence: 0.5, status: 'accepted' },
      { id: 'new', ts: '2026-07-02T09:00:00', text: '', track: 'PartnerCo', type: 'situation', summary: 'new', change: '', affects: 'launch window', confidence: 0.5, status: 'proposed' }
    ]
    writeFileSync(join(state, 'world-state-deltas.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const res = await actWorldUpdate(vault, 'new', 'confirm', { generate: async () => '', reproject: () => {} })
    expect(res.ok).toBe(true)
    const after = readFileSync(join(state, 'world-state-deltas.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(after.find((r) => r.id === 'old')?.status).toBe('superseded')
    expect(after.find((r) => r.id === 'new')?.status).toBe('accepted')
  })

  it('worldState files an accepted delta written under the legacy key on its current lane', () => {
    writeFileSync(join(vault, '.duin', 'ontology.json'), JSON.stringify({ tracks: [{ key: 'PartnerCo', match: 'partner' }] }))
    writeFileSync(
      join(state, 'world-state-deltas.jsonl'),
      JSON.stringify({ id: 'd1', ts: '2026-08-30T10:00:00', text: '', track: '3rd', type: 'situation', summary: 'legacy row', change: '', affects: '', confidence: 0.5, status: 'accepted' }) + '\n'
    )
    const ws = worldState(vault, new Date('2026-09-01T00:00:00Z'))
    const partner = ws.tracks.find((t) => t.key === 'PartnerCo') as { updates: { summary: string }[] } | undefined
    expect(partner).toBeDefined()
    expect(partner!.updates.map((u) => u.summary)).toContain('legacy row')
  })
})
