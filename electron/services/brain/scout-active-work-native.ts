// Model-backed WRITE — port of scout_active_work (server.py:6511) + _recent_vault_edits (6468):
// the proactive SCOUT. Reads harness signals (recently-edited notes + engaged moves), asks the
// model to infer 1-4 work-items the operator is plainly doing but hasn't logged, adversarially
// judges (default-kill), dedups against open tasks, and STAGES them in the cascade review tray
// (kind=active-work). Approving one runs captureWork (scout finds; capture grounds). 2h debounce.
//
// The model call is injected (proposeThenJudge). Never throws (background). Composes: recent-edits
// vault walk + openTaskTexts + entityMatch dedup + proposeThenJudge + stageCascade.

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, sep } from 'path'
import { arenaDirs } from './throughput'
import { loadTrackRegistry } from './tracks-native'
import { LANG_RULE } from './stream-sync-write-native'
import { entityMatch } from './stream-nudge-write-native'
import { openTaskTexts } from './task-corpus-native'
import { proposeThenJudge, stageCascade, type GenerateFn, type StageDeps } from './cascade-native'
import { messageOf } from '../guarded'

const futuresPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'future-nodes.jsonl')

const WORK_DIRS = [
  '02 Cards', '03 Projects', '04 Notes', '05 Decisions', '10 Action', '06 Tasks',
  'DUIN/Knowledge', 'DUIN/Planning', 'DUIN/Decisions', 'DUIN/Active', 'DUIN/Tasks', 'DUIN/00 Inbox'
]

export interface RecentEdit {
  mt: number
  path: string
  title: string
  snippet: string
}

function walkMd(root: string, out: string[]): void {
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(root, e.name)
    if (e.isDirectory()) {
      // isolation + internal: skip ProjectB anywhere, and any underscored path segment
      if (full.includes('ProjectB') || full.includes(`${sep}_`)) continue
      walkMd(full, out)
    } else if (e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_') && !e.name.includes('Template') && !e.name.includes('ProjectB')) {
      out.push(full)
    }
  }
}

/** Recently-edited work notes (mtime within `days`), snippet-summarized, newest first. Port of
 *  _recent_vault_edits. `now` injectable for deterministic tests. */
export function recentVaultEdits(vaultDir: string, opts: { days?: number; limit?: number; now?: () => Date } = {}): RecentEdit[] {
  const days = opts.days ?? 3
  const limit = opts.limit ?? 15
  const cutoff = ((opts.now ?? (() => new Date()))().getTime() - days * 86400_000) / 1000
  const dirs = [...WORK_DIRS, ...arenaDirs(vaultDir)]
  const out: RecentEdit[] = []
  for (const d of dirs) {
    const root = join(vaultDir, d)
    const files: string[] = []
    walkMd(root, files)
    for (const fp of files) {
      let mt: number
      try {
        mt = statSync(fp).mtimeMs / 1000
      } catch {
        continue
      }
      if (mt < cutoff) continue
      const rel = fp.slice(vaultDir.length).split(sep).join('/').replace(/^\/+/, '')
      let head: string
      try {
        head = readFileSync(fp, 'utf-8').slice(0, 600)
      } catch {
        continue
      }
      const snippet = head.replace(/^---[\s\S]*?---/, '').replace(/\s+/g, ' ').trim().slice(0, 200)
      const name = fp.split(sep).pop() ?? ''
      out.push({ mt, path: rel, title: name.slice(0, -3), snippet })
    }
  }
  out.sort((a, b) => b.mt - a.mt)
  return out.slice(0, limit)
}

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
    } catch (e) { console.debug('[scout-active-work-native] skip malformed:', messageOf(e)) }
  }
  return rows
}

/** Build the scout generator prompt — verbatim from server.py:6532-6540. Exported for diffing. */
export function buildScoutPrompt(notes: RecentEdit[], engaged: unknown[], openTasks: string[], laneEnum: string): string {
  return (
    'You are DUIN\'s proactive SCOUT. From the SIGNALS below (notes the operator edited recently + the ' +
    'moves they\'ve engaged), infer 1-4 concrete WORK-ITEMS they are plainly working on but have NOT ' +
    'logged as a task. Each must be grounded in a specific signal — NOT generic. Do NOT propose anything ' +
    'already covered by an OPEN TASK. Pick the track lane from: ' + laneEnum + '.\n' + LANG_RULE +
    '\nRECENT EDITS: ' + JSON.stringify(notes.map((n) => ({ note: n.title, snippet: n.snippet }))) +
    '\nENGAGED MOVES: ' + JSON.stringify(engaged) +
    '\nOPEN TASKS (do NOT duplicate): ' + JSON.stringify(openTasks.slice(0, 60)) +
    '\nOutput ONLY a JSON array: [{"title":"the work-item","track":"<lane>","why":"the signal it\'s grounded in (<=80 chars)"}].'
  )
}

export interface ScoutDeps extends StageDeps {
  generate: GenerateFn
  now?: () => Date
}

/**
 * The scout WORK (no debounce — that's the wrapper): gather signals → propose → judge → dedup vs
 * open tasks → stage. Returns the count staged. Never throws. Port of scout_active_work's inner work().
 */
export async function runScout(vaultDir: string, deps: ScoutDeps): Promise<number> {
  try {
    if (!vaultDir) return 0
    const notes = recentVaultEdits(vaultDir, { now: deps.now })
    const engaged = loadFutureNodes(vaultDir)
      .filter((s) => s.status === 'engaged')
      .slice(0, 15)
      .map((s) => ({ title: String(s.title ?? '').slice(0, 60), track: s.track ?? '' }))
    if (!notes.length && !engaged.length) return 0
    const openTasks = openTaskTexts(vaultDir)
    const lanes = [...new Set(loadTrackRegistry(vaultDir).map((t) => t.lane).filter((l): l is string => !!l))]
    const laneEnum = lanes.join('|') || 'ProjectA|PartnerCo|personal|duin'
    const gen = buildScoutPrompt(notes, engaged, openTasks, laneEnum)
    const surv = await proposeThenJudge(gen, 'active work the operator is doing but hasn\'t logged', { generate: deps.generate })
    const fresh = surv.filter((s) => !openTasks.some((ot) => entityMatch(String(s.title ?? ''), ot)))
    return fresh.length ? stageCascade(vaultDir, 'active-work', 'scout', fresh, deps) : 0
  } catch {
    return 0
  }
}

// 2h debounce state (module-level, matches Python _last_scout). Route/cadence fires this; the
// work runs fire-and-forget so the HTTP response returns immediately.
let lastScoutMs = 0
export function __resetScoutDebounceForTesting(): void {
  lastScoutMs = Number.NEGATIVE_INFINITY // "never scouted" — first call always runs
}

/** The route entrypoint: debounce (2h unless force), then kick the scout in the background. Port
 *  of scout_active_work's outer shape. `nowMs` injectable for tests. */
export function scoutActiveWork(
  vaultDir: string,
  deps: ScoutDeps,
  opts: { force?: boolean; nowMs?: number } = {}
): { ok: boolean; scanning?: boolean; skipped?: string } {
  const now = opts.nowMs ?? Date.now()
  if (!opts.force && now - lastScoutMs < 7_200_000) return { ok: true, skipped: 'debounced' }
  lastScoutMs = now
  void runScout(vaultDir, deps)
  return { ok: true, scanning: true }
}
