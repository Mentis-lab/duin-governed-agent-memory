import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setTrackProject, addTrack } from './track-write-native'

describe('track-write-native', () => {
  let vault: string
  let tracksJson: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-trw-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    tracksJson = join(vault, '.duin', '_state', 'tracks.json')
    writeFileSync(
      tracksJson,
      JSON.stringify([
        { id: 'beilan-channels', label: '北澜渠道', keywords: ['b站'] },
        { id: 'duin', label: 'DUIN', project: '' }
      ], null, 2)
    )
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))
  const reg = (): Array<Record<string, unknown>> => JSON.parse(readFileSync(tracksJson, 'utf-8'))

  it('assigns a project to an existing track', () => {
    expect(setTrackProject(vault, 'duin', '北澜').ok).toBe(true)
    expect(reg().find((t) => t.id === 'duin')!.project).toBe('北澜')
  })
  it('clears the project with empty string', () => {
    setTrackProject(vault, 'duin', '北澜')
    expect(setTrackProject(vault, 'duin', '').ok).toBe(true)
    expect(reg().find((t) => t.id === 'duin')!.project).toBe('')
  })
  it('writes indent=2 JSON (matches Python json.dump)', () => {
    setTrackProject(vault, 'beilan-channels', 'P')
    expect(readFileSync(tracksJson, 'utf-8')).toContain('\n  {\n    "id"')
  })
  it('returns {ok:false,"track not found"} for a missing id / vault', () => {
    expect(setTrackProject(vault, 'ghost', 'x')).toEqual({ ok: false, error: 'track not found' })
    expect(setTrackProject(null, 'duin', 'x').ok).toBe(false)
  })

  describe('addTrack', () => {
    it('creates a track: slug id, keywords from label + extras, appended to tracks.json', () => {
      const r = addTrack(vault, { label: 'BW Booth Prep', goal: 'ship booth', lane: '北澜', keywords: ['bilibili', 'booth'] })
      expect(r).toMatchObject({ ok: true, id: 'bw-booth-prep' })
      expect(r.track).toMatchObject({ id: 'bw-booth-prep', label: 'BW Booth Prep', lane: '北澜', goal: 'ship booth' })
      expect(r.track!.keywords).toEqual(['bw', 'booth', 'prep', 'bilibili']) // label tokens (len>1, deduped) + extras
      expect(reg().some((t) => t.id === 'bw-booth-prep')).toBe(true)
    })
    it('collision-numbers a duplicate id', () => {
      const r = addTrack(vault, { label: 'DUIN' }) // 'duin' already seeded
      expect(r.id).toBe('duin-2')
    })
    it('derives an id from an ascii keyword for a CJK label', () => {
      const r = addTrack(vault, { label: '北澜渠道', keywords: ['channels'] })
      expect(r.id).toBe('channels')
    })
    it('rejects an empty label / null vault', () => {
      expect(addTrack(vault, { label: '  ' }).ok).toBe(false)
      expect(addTrack(null, { label: 'x' }).ok).toBe(false)
    })
  })
})
