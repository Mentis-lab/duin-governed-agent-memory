// tracks-native — TS port of server.py:list_tracks. The middle layer Goal > Track >
// Move: declared work lanes with the projection engine's streams assigned underneath
// as moves (by keyword scoring, never date). Tracks always show (quiet if no active
// move). Pure read over tracks.json (else DEFAULT_TRACKS) + loadFutures.
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadFutures, parseDeadline, type FutureStream } from './causal-substrate'
import { normalizeTrackKey } from './ontology'

export interface Track {
  id: string
  label: string
  goal?: string
  lane?: string
  project?: string
  keywords?: string[]
}

// COLD-START A2 (2026-07-25): the shipped default is EMPTY.
//
// This was six of the AUTHOR's real strategic lanes — project names, partner companies and
// colleagues' names embedded in the keyword lists. Because loadTrackRegistry falls back to this
// constant whenever `tracks.json` is absent — which is ALWAYS true on a fresh vault — those lanes
// RENDERED on a stranger's first launch as their own work. That made it a leak with a UI surface,
// not just a dead constant.
//
// A fresh vault now gets an empty registry and the Tracks rail is empty until the operator (or the
// scaffolder) defines lanes. Empty-and-honest beats populated-and-wrong.
export const DEFAULT_TRACKS: Track[] = []

export function loadTrackRegistry(vaultDir: string): Track[] {
  try {
    const data = JSON.parse(readFileSync(join(vaultDir, '.duin', '_state', 'tracks.json'), 'utf-8'))
    if (!Array.isArray(data) || !data.length) return DEFAULT_TRACKS
    // Read boundary: a registry saved before the built-in lane keys were renamed still says
    // `3rd` / `AIX`; fold to the current keys so every consumer sees one vocabulary.
    return (data as Track[]).map((t) =>
      t && typeof t.lane === 'string' ? { ...t, lane: normalizeTrackKey(t.lane) } : t
    )
  } catch {
    return DEFAULT_TRACKS
  }
}
const isoOf = (d: Date): string => d.toISOString().slice(0, 10)
const dayDiff = (a: Date, b: Date): number => Math.floor((a.getTime() - b.getTime()) / 86400000)

/** Assign each live future (move) to exactly one track by the SAME keyword-bucketing
 *  listTracks uses (declined futures dropped; keyword score, then lane default, then the
 *  last track). Returns bare {trackId, futureId} pairs — the source of the track→move
 *  `contains` edges. Reused by the native store-graph assembler (graph-native.ts). */
export function bucketFuturesByTrack(vaultDir: string | null): { trackId: string; futureId: string }[] {
  if (!vaultDir) return []
  const reg = loadTrackRegistry(vaultDir)
  const laneDefault = new Map<string, string>()
  for (const t of reg) if (t.lane && !laneDefault.has(t.lane)) laneDefault.set(t.lane, t.id)
  const out: { trackId: string; futureId: string }[] = []
  for (const s of loadFutures(vaultDir)) {
    if (s.status === 'declined') continue
    const hay = [s.title, s.objective, s.decision, s.parent_label, s.track].filter(Boolean).join(' ').toLowerCase()
    let best: string | null = null
    let scoreBest = 0
    for (const t of reg) {
      const sc = (t.keywords ?? []).filter((k) => k && hay.includes(k.toLowerCase())).length
      if (sc > scoreBest) {
        best = t.id
        scoreBest = sc
      }
    }
    // Last-resort bucket = the last declared track. With an EMPTY registry (the A2 default on a
    // fresh vault) there is no such track, and a future simply has no lane to file under — drop
    // it rather than index off the end of an empty array.
    if (!best) best = laneDefault.get((s.track ?? '').trim()) ?? reg[reg.length - 1]?.id ?? null
    if (!best) continue
    const fid = s.id || s.title || ''
    if (fid) out.push({ trackId: best, futureId: fid })
  }
  return out
}

export function listTracks(vaultDir: string | null, today: Date = new Date()): { tracks: unknown[]; today: string } {
  if (!vaultDir) return { tracks: [], today: isoOf(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))) }
  const t0 = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))
  const reg = loadTrackRegistry(vaultDir)
  const ddays = (s: FutureStream): number | null => {
    const d = parseDeadline(s.decide_by)
    return d ? dayDiff(d, t0) : null
  }
  // lane → first track id in that lane (insertion order of distinct lanes)
  const laneDefault = new Map<string, string>()
  for (const t of reg) if (t.lane && !laneDefault.has(t.lane)) laneDefault.set(t.lane, t.id)

  const buckets = new Map<string, FutureStream[]>(reg.map((t) => [t.id, []]))
  for (const s of loadFutures(vaultDir)) {
    if (s.status === 'declined') continue
    const hay = [s.title, s.objective, s.decision, s.parent_label, s.track].filter(Boolean).join(' ').toLowerCase()
    let best: string | null = null
    let scoreBest = 0
    for (const t of reg) {
      const sc = (t.keywords ?? []).filter((k) => k && hay.includes(k.toLowerCase())).length
      if (sc > scoreBest) {
        best = t.id
        scoreBest = sc
      }
    }
    // Same empty-registry guard as bucketFuturesByTrack: no declared track → nothing to bucket
    // into. `out` below maps over `reg`, so an unbucketed future is simply not rendered.
    if (!best) best = laneDefault.get((s.track ?? '').trim()) ?? reg[reg.length - 1]?.id ?? null
    if (!best) continue
    ;(buckets.get(best) ?? buckets.set(best, []).get(best)!).push(s)
  }

  const out = reg.map((t) => {
    const ms = [...(buckets.get(t.id) ?? [])].sort((a, b) => {
      const da = ddays(a)
      const db = ddays(b)
      const ka = da === null ? 1 : 0
      const kb = db === null ? 1 : 0
      if (ka !== kb) return ka - kb
      return (da ?? 99999) - (db ?? 99999)
    })
    const active = ms.filter((m) => m.status === 'open' || m.status === 'engaged')
    const nxt =
      ms.find((m) => ddays(m) !== null && (m.status === 'open' || m.status === 'engaged')) ?? (active[0] ?? (ms[0] ?? null))
    return {
      id: t.id,
      label: t.label,
      goal: t.goal ?? '',
      lane: t.lane ?? '',
      project: t.project ?? '',
      move_count: ms.length,
      active_count: active.length,
      status: active.length ? 'active' : 'quiet',
      next_move: nxt ? nxt.title ?? '' : '',
      next_decide_by: nxt ? nxt.decide_by ?? '' : '',
      moves: ms.slice(0, 6).map((m) => ({ id: m.id, title: m.title, decide_by: m.decide_by, status: m.status }))
    }
  })
  return { tracks: out, today: isoOf(t0) }
}
