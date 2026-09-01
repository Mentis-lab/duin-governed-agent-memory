import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { addTrack, runCascadeTrack, buildCascadeTrackPrompt } from './track-add-write-native'
import { DEFAULT_TRACKS, type Track } from './tracks-native'

describe('track-add — addTrack (deterministic tracks.json write)', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-ta-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('rejects a blank label', () => {
    expect(addTrack(vault, {})).toEqual({ ok: false, error: 'label required' })
  })

  it('appends onto the existing registry without mutating the constant, ascii-slug id + seeded keywords', () => {
    // Cold-start A2 made DEFAULT_TRACKS empty, so "existing tracks are preserved" is now stated
    // against a registry the vault declares — which is the case that can actually lose data.
    writeFileSync(join(sd, 'tracks.json'), JSON.stringify([{ id: 'existing-lane', label: 'Existing' }]))
    const r = addTrack(vault, { label: 'Growth Ops', goal: 'grow', lane: 'duin', keywords: ['GTM', 'launch'] })
    expect(r.ok).toBe(true)
    expect(r.id).toBe('growth-ops')
    const reg: Track[] = JSON.parse(readFileSync(join(sd, 'tracks.json'), 'utf-8'))
    const added = reg.find((t) => t.id === 'growth-ops')!
    expect(added).toMatchObject({ id: 'growth-ops', label: 'Growth Ops', goal: 'grow', lane: 'duin' })
    expect(added.keywords).toEqual(['growth', 'ops', 'gtm', 'launch']) // label split + extras, deduped, lowercased
    expect(reg.some((t) => t.id === 'existing-lane')).toBe(true)
  })

  it('a fresh vault (no tracks.json) writes just the new track and leaves DEFAULT_TRACKS alone', () => {
    const r = addTrack(vault, { label: 'Growth Ops' })
    expect(r.ok).toBe(true)
    const reg: Track[] = JSON.parse(readFileSync(join(sd, 'tracks.json'), 'utf-8'))
    expect(reg.map((t) => t.id)).toEqual(['growth-ops'])
    expect(DEFAULT_TRACKS).toEqual([]) // the module constant was copied, never appended to
  })

  it('derives a hash id for a CJK label with no ascii keyword', () => {
    const r = addTrack(vault, { label: '国内渠道' })
    expect(r.id).toMatch(/^track-[0-9a-f]{6}$/)
  })

  it('uses an ascii keyword slug for a CJK label when one is present', () => {
    const r = addTrack(vault, { label: '渠道运营', keywords: ['Channel Ops'] })
    expect(r.id).toBe('channel-ops')
  })

  it('disambiguates a colliding id with -2/-3', () => {
    writeFileSync(join(sd, 'tracks.json'), JSON.stringify([{ id: 'growth', label: 'x' }]))
    const r = addTrack(vault, { label: 'growth' })
    expect(r.id).toBe('growth-2')
  })
})

describe('track-add — runCascadeTrack (background cascade)', () => {
  let vault: string
  let sd: string
  const track: Track = { id: 'growth-ops', label: 'Growth Ops', goal: 'grow', lane: 'duin', keywords: ['gtm'] }
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-ct-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('lands judged survivors as provisional cascade streams', async () => {
    let pass = 0
    const generate = async (): Promise<string> => {
      pass++
      if (pass === 1) return JSON.stringify([{ title: 'Move A', objective: 'do A' }, { title: 'Move B', objective: 'do B' }])
      return JSON.stringify([{ idx: 0, keep: true }, { idx: 1, keep: false }]) // judge keeps only A
    }
    const landed = await runCascadeTrack(vault, track, {
      generate,
      now: () => new Date(2026, 6, 3, 10, 0, 0),
      uid: (() => {
        let i = 0
        return () => `mv${i++}`
      })()
    })
    expect(landed).toEqual(['mv0'])
    const nodes = readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({
      id: 'mv0',
      title: 'Move A',
      track: 'duin', // = track.lane
      parent: 'growth-ops',
      parent_label: 'Growth Ops',
      status: 'open',
      source: 'cascade',
      created: '2026-07-03T10:00:00'
    })
  })

  it('lands nothing (no write) when the judge kills all', async () => {
    let pass = 0
    const generate = async (): Promise<string> => {
      pass++
      return pass === 1 ? JSON.stringify([{ title: 'X' }]) : JSON.stringify([{ idx: 0, keep: false }])
    }
    const landed = await runCascadeTrack(vault, track, { generate })
    expect(landed).toEqual([])
  })

  it('never throws (background) — swallows a generate failure', async () => {
    const landed = await runCascadeTrack(vault, track, { generate: async () => { throw new Error('model down') } })
    expect(landed).toEqual([])
  })

  it('prompt embeds the track fields + existing-streams guard', () => {
    const p = buildCascadeTrackPrompt(track, ['Existing move'])
    expect(p).toContain('You are the PROJECTION ENGINE')
    expect(p).toContain('"label":"Growth Ops"')
    expect(p).toContain('EXISTING STREAMS (do NOT duplicate):\n["Existing move"]')
  })
})
