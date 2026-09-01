// track-write-native — track registry writes (set_track_project + add_track). Owns tracks.json
// (.duin/_state/tracks.json). Reuses the track registry loader + DEFAULT_TRACKS from tracks-native.
import { writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { loadTrackRegistry, DEFAULT_TRACKS, type Track } from './tracks-native'

const tracksPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'tracks.json')
function writeRegistry(vaultDir: string, reg: Track[]): void {
  const path = tracksPath(vaultDir)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf-8')
  renameSync(tmp, path)
}

export interface TrackAssignResult {
  ok: boolean
  error?: string
}

/** Set a track's project field (project='' clears it). Port of set_track_project.
 *  Returns {ok:false,'track not found'} if the id isn't in the registry. */
export function setTrackProject(vaultDir: string | null, trackId: string, project: string): TrackAssignResult {
  if (!vaultDir) return { ok: false, error: 'track not found' }
  let reg = loadTrackRegistry(vaultDir)
  // Don't mutate the DEFAULT_TRACKS constant (loadTrackRegistry returns it by-ref on fallback).
  if (reg === DEFAULT_TRACKS) reg = DEFAULT_TRACKS.map((t) => ({ ...t }))
  let hit = false
  for (const t of reg as Track[]) {
    if (t.id === trackId) {
      t.project = String(project || '')
      hit = true
      break
    }
  }
  if (!hit) return { ok: false, error: 'track not found' }
  writeRegistry(vaultDir, reg as Track[])
  return { ok: true }
}

export interface AddTrackResult {
  ok: boolean
  error?: string
  id?: string
  track?: Track
}

/** Append a user-authored track to the registry (id derived from label/keywords, keywords seeded
 *  from label + extras). Port of add_track's deterministic core. Returns the new track so the
 *  caller can fire the generative cascade_track. */
export function addTrack(vaultDir: string | null, payload: Record<string, unknown>): AddTrackResult {
  const label = String(payload.label ?? '').trim()
  if (!label) return { ok: false, error: 'label required' }
  if (!vaultDir) return { ok: false, error: 'label required' }
  let reg = loadTrackRegistry(vaultDir)
  if (reg === DEFAULT_TRACKS) reg = DEFAULT_TRACKS.map((t) => ({ ...t })) // never mutate the constant
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!base) {
    // CJK/non-ascii label → a readable id from an ascii keyword, else a stable label hash
    const extras = Array.isArray(payload.keywords) ? (payload.keywords as unknown[]) : []
    const kwSeed = extras.map((k) => String(k)).find((k) => /[a-z0-9]/.test(k.toLowerCase())) ?? ''
    base = kwSeed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `track-${createHash('md5').update(label, 'utf8').digest('hex').slice(0, 6)}`
  }
  const ids = new Set((reg as Track[]).map((t) => t.id))
  let tid = base
  let n = 2
  while (ids.has(tid)) {
    tid = `${base}-${n}`
    n += 1
  }
  let kws = label.toLowerCase().split(/[\s·/,，、:：]+/).filter((w) => w.length > 1).slice(0, 8)
  const extra = payload.keywords
  if (Array.isArray(extra)) kws = kws.concat((extra as unknown[]).map((k) => String(k).trim().toLowerCase()).filter(Boolean))
  else if (typeof extra === 'string') kws = kws.concat(extra.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean))
  const newTrack: Track = {
    id: tid,
    label,
    goal: String(payload.goal ?? ''),
    lane: String(payload.lane ?? ''),
    project: String(payload.project ?? ''),
    keywords: [...new Set(kws)]
  }
  const out = [...(reg as Track[]), newTrack]
  writeRegistry(vaultDir, out)
  return { ok: true, id: tid, track: newTrack }
}
