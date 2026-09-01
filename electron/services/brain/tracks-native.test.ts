import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listTracks, DEFAULT_TRACKS } from './tracks-native'

// Cold-start A2 made DEFAULT_TRACKS empty — the six defaults were one operator's real lanes, and
// loadTrackRegistry falls back to that constant on every fresh vault, so they RENDERED as a
// stranger's own work. The registry is now per-vault (`.duin/_state/tracks.json`), which is what
// this suite declares. Same bucketing assertions, now over the path the product actually uses.
const REGISTRY = [
  { id: 'alpha-channels', label: 'Alpha · channels', goal: 'alpha ships', lane: 'alpha', keywords: ['taptap', 'distribution', 'channel'] },
  { id: 'alpha-intl', label: 'Alpha · international', goal: 'alpha ships', lane: 'alpha', keywords: ['steam', 'localization'] },
  { id: 'alpha-product', label: 'Alpha · product', goal: 'alpha ships', lane: 'alpha', keywords: ['art', 'qa'] },
  { id: 'beta', label: 'Beta · M&A', goal: 'deliver value', lane: 'beta', keywords: ['m&a', 'pipeline'] },
  { id: 'duin', label: 'DUIN · second brain', goal: 'build leverage', lane: 'duin', keywords: ['duin', 'harness'] },
  { id: 'personal', label: 'Personal', goal: 'personal direction', lane: 'personal', keywords: ['capacity', 'career'] }
]

describe('listTracks', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-trk-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    writeFileSync(join(vault, '.duin', '_state', 'tracks.json'), JSON.stringify(REGISTRY))
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('buckets a stream into the best-keyword track + marks it active; others quiet', () => {
    writeFileSync(
      join(vault, '.duin', '_state', 'future-nodes.jsonl'),
      JSON.stringify({ id: 's1', title: 'TapTap distribution channel push', status: 'open', decide_by: '2026-08-01' }) + '\n'
    )
    const { tracks } = listTracks(vault, new Date('2026-07-01T00:00:00Z')) as { tracks: Record<string, unknown>[]; today: string }
    const chan = tracks.find((t) => t.id === 'alpha-channels')!
    expect(chan.status).toBe('active') // taptap/distribution/channel keywords hit
    expect(chan.move_count).toBe(1)
    expect((chan.moves as unknown[]).length).toBe(1)
    // every declared track always present (quiet if empty)
    expect(tracks).toHaveLength(REGISTRY.length)
    expect(tracks.find((t) => t.id === 'duin')!.status).toBe('quiet')
  })

  it('always returns all tracks + today; null vault → empty tracks', () => {
    expect((listTracks(vault, new Date('2026-07-01T00:00:00Z')) as { tracks: unknown[] }).tracks).toHaveLength(REGISTRY.length)
    expect((listTracks(null) as { tracks: unknown[] }).tracks).toEqual([])
  })

  it('an EMPTY registry (the A2 shipped default) yields no tracks and does not throw', () => {
    // Regression guard: the last-resort bucket used to index `reg[reg.length - 1].id`, which
    // throws the moment the default registry is empty — i.e. on every fresh install, for any
    // vault that has a stream but no tracks.json yet.
    expect(DEFAULT_TRACKS).toEqual([])
    rmSync(join(vault, '.duin', '_state', 'tracks.json'))
    writeFileSync(
      join(vault, '.duin', '_state', 'future-nodes.jsonl'),
      JSON.stringify({ id: 's1', title: 'an unfiled stream', status: 'open', track: 'nowhere' }) + '\n'
    )
    const { tracks } = listTracks(vault, new Date('2026-07-01T00:00:00Z')) as { tracks: unknown[] }
    expect(tracks).toEqual([])
  })
})
