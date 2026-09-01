// The cascade review tray — approve (→ apply per kind) or dismiss a staged cascade. Port of
// _apply_cascade (server.py:1657) + resolve_cascade (server.py:1702). This is where the staged
// high-stakes proposals (project→tracks, decision→affected, capture→new-move) get committed once
// the operator approves. Composes the whole cascade stack: addTrack + runCascadeTrack (project-
// track), future-node edits (decision-affected), captureWork / normalizeStream (active-work).
//
// The model call is injected (needed by the project-track sub-cascade + the active-work capture
// branch). applyCascade is async; resolveCascade awaits it.

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { addTrack, runCascadeTrack } from './track-add-write-native'
import { captureWork } from './capture-work-write-native'
import { normalizeStream } from './stream-sync-write-native'
import {
  loadCascadePending,
  saveCascadePending,
  localIsoSeconds,
  type GenerateFn
} from './cascade-native'
import { messageOf } from '../guarded'

const futuresPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'future-nodes.jsonl')

function loadFutureNodes(vaultDir: string): Record<string, unknown>[] {
  let txt: string
  try {
    txt = readFileSync(futuresPath(vaultDir), 'utf-8')
  } catch {
    return []
  }
  const rows: Record<string, unknown>[] = []
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      rows.push(JSON.parse(s) as Record<string, unknown>)
    } catch (e) { console.debug('[cascade-apply-native] skip malformed:', messageOf(e)) }
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

export interface ApplyDeps {
  generate: GenerateFn
  now?: () => Date
  uid?: () => string
}

/**
 * Apply a staged cascade item per its kind, returning a human-readable result string. Port of
 * _apply_cascade (server.py:1657). Kinds: project-track (addTrack + fire its own cascade),
 * decision-affected (link the decision onto the stream), active-work (capture a scout item, or
 * materialize a new grounded move).
 */
export async function applyCascade(
  vaultDir: string,
  item: { kind?: string; source?: string; created?: string; proposal?: Record<string, unknown> },
  deps: ApplyDeps
): Promise<string> {
  const kind = item.kind
  const p = item.proposal ?? {}
  const source = String(item.source ?? '')

  if (kind === 'project-track') {
    const r = addTrack(vaultDir, {
      label: String(p.label ?? ''),
      lane: String(p.lane || source),
      project: source,
      goal: String(p.goal ?? ''),
      keywords: Array.isArray(p.keywords) ? p.keywords : []
    })
    if (r.ok && r.track) void runCascadeTrack(vaultDir, r.track, { generate: deps.generate })
    return `track added: ${r.id ?? '?'} (will cascade its own moves)`
  }

  if (kind === 'decision-affected') {
    const sid = String(p.stream_id ?? '')
    const change = String(p.change ?? '')
    const streams = loadFutureNodes(vaultDir)
    let hit = false
    for (const s of streams) {
      if (s.id === sid) {
        s.decided_by = source
        const log = Array.isArray(s.log) ? (s.log as unknown[]) : []
        log.push({ ts: item.created ?? '', note: `[decision] ${change}` })
        s.log = log.slice(-6)
        hit = true
      }
    }
    if (hit) {
      saveFutureNodes(vaultDir, streams)
      return 'stream linked to the decision'
    }
    return 'affected stream no longer present'
  }

  if (kind === 'active-work') {
    if (!p.task_id) {
      // scout-originated → capture it for real (writes the task + binds it)
      const r = await captureWork(vaultDir, String(p.title ?? ''), { generate: deps.generate })
      const tgt = r.bound_to
      const captured = String(r.task?.title ?? '').slice(0, 40)
      return `captured: ${captured}` + (tgt ? ` → ${String(tgt.title).slice(0, 30)}` : '')
    }
    const now = localIsoSeconds((deps.now ?? (() => new Date()))())
    const uid = (deps.uid ?? (() => randomUUID().replace(/-/g, '').slice(0, 8)))()
    const n = normalizeStream({ title: p.title, objective: p.change }, 'cascade') as unknown as Record<string, unknown>
    n.track = String(p.track ?? '')
    n.id = uid
    n.status = 'open'
    n.created = now
    n.refreshed = now
    n.source = 'cascade'
    n.steps = [{ event: String(p.task_title ?? ''), when: String(p.due ?? ''), task_id: String(p.task_id), gap: false, done: false }]
    saveFutureNodes(vaultDir, [...loadFutureNodes(vaultDir), n])
    return `move created: ${String(n.title ?? '').slice(0, 40)} (grounded by the captured work)`
  }

  return 'no-op'
}

export interface ResolveCascadeResult {
  ok: boolean
  error?: string
  action?: string
  applied?: string
}

/**
 * Approve (→ apply per kind) or dismiss a staged cascade. Port of resolve_cascade (server.py:1702).
 * Single-writer over cascade-pending.jsonl: flips the item's status and persists.
 */
export async function resolveCascade(
  vaultDir: string,
  cid: string,
  action: string,
  deps: ApplyDeps
): Promise<ResolveCascadeResult> {
  if (action !== 'approve' && action !== 'dismiss') {
    return { ok: false, error: 'action must be approve|dismiss' }
  }
  const items = loadCascadePending(vaultDir)
  const hit = items.find((i) => i.id === cid)
  if (!hit) return { ok: false, error: 'not found' }
  if (hit.status !== 'pending') return { ok: false, error: 'already resolved' }

  let applied = ''
  if (action === 'approve') {
    try {
      applied = await applyCascade(vaultDir, hit, deps)
    } catch (e) {
      return { ok: false, error: `apply failed: ${(e as Error)?.message ?? e}` }
    }
  }
  // applyCascade (e.g. captureWork -> stageCascade) may have appended new rows to
  // cascade-pending.jsonl during the approve. Re-load the fresh file and flip the
  // status there, so we don't write back the stale pre-apply snapshot and silently
  // delete the row(s) apply just staged.
  const status = action === 'approve' ? 'approved' : 'dismissed'
  const fresh = loadCascadePending(vaultDir)
  const target = fresh.find((i) => i.id === cid)
  if (target) target.status = status
  saveCascadePending(vaultDir, fresh)
  return { ok: true, action: status, applied }
}
