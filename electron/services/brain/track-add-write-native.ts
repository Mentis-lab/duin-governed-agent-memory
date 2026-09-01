// track-add (native) — append a user-authored TRACK to the registry (deterministic), then run
// the low-stakes cascade: propose 2-4 MOVES for it, adversarially judge, AUTO-LAND survivors as
// provisional streams. Port of add_track (server.py:7158) + cascade_track (server.py:1571).
//
// Two halves, mirroring Python:
//  - addTrack: pure tracks.json write (reuses the tracks-native registry loader + DEFAULT_TRACKS;
//    same id-derivation, CJK-hash fallback, keyword seeding). Returns the new track.
//  - runCascadeTrack: the background generative cascade (proposeThenJudge → normalizeStream →
//    append to future-nodes.jsonl as source:'cascade'). The model call is injected. The route
//    handler fires this fire-and-forget after addTrack returns (Python runs it in a daemon thread).

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { randomUUID, createHash } from 'crypto'
import { loadTrackRegistry, DEFAULT_TRACKS, type Track } from './tracks-native'
import { normalizeStream, LANG_RULE } from './stream-sync-write-native'
import { proposeThenJudge, localIsoSeconds, type GenerateFn } from './cascade-native'
import { messageOf } from '../guarded'

const tracksPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'tracks.json')
const futuresPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'future-nodes.jsonl')

export interface AddTrackResult {
  ok: boolean
  id?: string
  error?: string
  track?: Track
}

/** Append a user-authored track to the registry. Port of add_track's deterministic half
 *  (server.py:7158-7191, minus the cascade_track call — the caller fires runCascadeTrack). */
export function addTrack(vaultDir: string | null, payload: Record<string, unknown>): AddTrackResult {
  const label = String(payload.label ?? '').trim()
  if (!label) return { ok: false, error: 'label required' }
  if (!vaultDir) return { ok: false, error: 'no vault' }

  let reg = loadTrackRegistry(vaultDir)
  // Always copy the DEFAULT_TRACKS constant before mutating (loadTrackRegistry returns it
  // by-ref on fallback). Python add_track guarded this on a named built-in id instead, which was a
  // latent bug — the guard skipped the copy and mutated the module constant. Since cold-start A2
  // the constant is empty, so the copy is cheap and the by-ref hazard is gone either way; the
  // safe form is kept (matches set_track_project / track-write-native).
  if (reg === DEFAULT_TRACKS) reg = DEFAULT_TRACKS.map((t) => ({ ...t }))

  // Base id: ascii-slug of the label; CJK/non-ascii → an ascii keyword slug, else a label hash.
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!base) {
    const extras = Array.isArray(payload.keywords) ? (payload.keywords as unknown[]) : []
    const kwSeed = extras.map((k) => String(k)).find((k) => /[a-z0-9]/.test(k.toLowerCase())) ?? ''
    base =
      kwSeed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') ||
      'track-' + createHash('md5').update(label, 'utf-8').digest('hex').slice(0, 6)
  }
  const ids = new Set(reg.map((t) => t.id))
  let tid = base
  let n = 2
  while (ids.has(tid)) {
    tid = `${base}-${n}`
    n += 1
  }

  // Keywords: split the label on separators (len>1, cap 8) + any extras.
  const kws = label
    .toLowerCase()
    .split(/[\s·/,，、:：]+/)
    .filter((w) => w.length > 1)
    .slice(0, 8)
  const extra = payload.keywords
  if (Array.isArray(extra)) {
    for (const k of extra) {
      const s = String(k).trim().toLowerCase()
      if (s) kws.push(s)
    }
  } else if (typeof extra === 'string') {
    for (const k of extra.split(',')) {
      const s = k.trim().toLowerCase()
      if (s) kws.push(s)
    }
  }

  const newTrack: Track = {
    id: tid,
    label,
    goal: String(payload.goal ?? ''),
    lane: String(payload.lane ?? ''),
    project: String(payload.project ?? ''),
    keywords: [...new Set(kws)]
  }
  reg.push(newTrack)
  const path = tracksPath(vaultDir)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf-8') // Python json.dump(indent=2)
  renameSync(tmp, path)
  return { ok: true, id: tid, track: newTrack }
}

// ── the low-stakes cascade (background, model-backed) ──

function loadFutureNodes(vaultDir: string): Record<string, unknown>[] {
  let txt: string
  try {
    txt = readFileSync(futuresPath(vaultDir), 'utf-8')
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return []
    throw e // a transient lock/IO error must not degrade to [] → the re-save below would overwrite the file empty
  }
  const rows: Record<string, unknown>[] = []
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      rows.push(JSON.parse(s) as Record<string, unknown>)
    } catch (e) { console.debug('[track-add-write-native] skip malformed:', messageOf(e)) }
  }
  return rows
}
function saveFutureNodes(vaultDir: string, rows: Record<string, unknown>[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
  const path = futuresPath(vaultDir)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body, 'utf-8')
  renameSync(tmp, path)
}

/** Build cascade_track's generator prompt — verbatim from server.py:1582-1591. `existing` is the
 *  ≤40 current stream titles. Exported for string-diffing. */
export function buildCascadeTrackPrompt(track: Track, existing: string[]): string {
  const trackJson = JSON.stringify({ label: track.label, goal: track.goal, lane: track.lane, keywords: track.keywords })
  return (
    'You are the PROJECTION ENGINE. A new TRACK was just created. Propose 2-4 concrete near-term MOVES ' +
    '(streams) that advance it — each a chain from a trigger toward a goal. Ground them STRICTLY in the ' +
    'track\'s goal + keywords + the operator\'s real work; do NOT invent dates (leave decide_by empty, set ' +
    '"confirm" to a short question if a key fact is unknown). If you cannot ground a move, omit it.\n' +
    `${LANG_RULE}\nTRACK: ${trackJson}` +
    '\nEXISTING STREAMS (do NOT duplicate):\n' + JSON.stringify(existing) +
    '\nOutput ONLY a JSON array: [{"title","objective","trigger","confirm","cleared","blocked"}].'
  )
}

export interface CascadeTrackDeps {
  generate: GenerateFn
  now?: () => Date
  uid?: () => string
}

/**
 * Run the low-stakes cascade for a newly-added track: propose moves → adversarial judge →
 * AUTO-LAND survivors as provisional (source:'cascade') streams appended to future-nodes.jsonl.
 * Returns the ids landed. Port of cascade_track (server.py:1571). Never throws (background).
 */
export async function runCascadeTrack(
  vaultDir: string,
  track: Track,
  deps: CascadeTrackDeps
): Promise<string[]> {
  try {
    if (!vaultDir) return []
    const lane = track.lane || ''
    const existing = loadFutureNodes(vaultDir).map((s) => String(s.title ?? '')).slice(0, 40)
    const gen = buildCascadeTrackPrompt(track, existing)
    const survivors = await proposeThenJudge(gen, `MOVES for the track «${track.label}»`, { generate: deps.generate })
    if (!survivors.length) return []
    const now = localIsoSeconds((deps.now ?? (() => new Date()))())
    const mkId = deps.uid ?? (() => randomUUID().replace(/-/g, '').slice(0, 8))
    const landed: string[] = []
    const nodes: Record<string, unknown>[] = []
    for (const s of survivors) {
      const n = normalizeStream(s, 'cascade') as unknown as Record<string, unknown>
      n.track = lane
      n.parent = track.id
      n.parent_label = track.label
      n.id = mkId()
      n.status = 'open'
      n.created = now
      n.refreshed = now
      n.source = 'cascade'
      nodes.push(n)
      landed.push(n.id as string)
    }
    saveFutureNodes(vaultDir, [...loadFutureNodes(vaultDir), ...nodes])
    return landed
  } catch {
    return [] // background cascade never raises
  }
}
