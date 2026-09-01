// stream-write-native — edit a stream (future-node) node's fields directly. Port of
// update_stream. Owns future-nodes.jsonl. An edited stream becomes source='synced' so
// operator hand-edits persist across re-projection.
//
// IMPORTANT: reads/writes ONLY future-nodes.jsonl (a dedicated single-file loader), NOT the
// merging causal-substrate.loadFutures (which unions channel-futures.jsonl for graph reads).
// Saving the merged set back would duplicate channel-futures into future-nodes. Python's
// _load_futures/_save_futures both operate on future-nodes.jsonl alone — matched here.
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join, relative, sep } from 'path'
import { taskFiles } from './task-write-native'
import { parseTaskLine, readAnchorDecls } from './causal-substrate'
import { generateOnce } from './generate-once-native'
import { WORLD_TRACK_KEYS, trackOf } from './world-update-native'
import { normalizeTrackKey } from './ontology'
import { messageOf } from '../guarded'

const futuresPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'future-nodes.jsonl')

const ALLOWED = new Set([
  'title', 'objective', 'decision', 'trigger', 'decide_by', 'target', 'cleared', 'blocked',
  'confirm', 'track', 'kind', 'parent', 'parent_label'
])

/** Normalize a date to a clean YYYY-MM(-DD), killing en/em-dash range garbage. Port of _clean_when. */
export function cleanWhen(w: string): string {
  const s = (w || '').replace(/–/g, '-').replace(/—/g, '-').trim()
  const m = /\d{4}-\d{2}(?:-\d{2})?/.exec(s)
  return m ? m[0] : ''
}

export function loadFutureNodes(vaultDir: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  let txt: string
  try {
    txt = readFileSync(futuresPath(vaultDir), 'utf-8')
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return rows
    throw e // a transient lock/IO error must not degrade to [] → the append below would overwrite the file empty
  }
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      rows.push(JSON.parse(s) as Record<string, unknown>)
    } catch (e) { console.debug('[stream-write-native] skip malformed:', messageOf(e)) }
  }
  return rows
}

export function saveFutureNodes(vaultDir: string, rows: Record<string, unknown>[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
  const path = futuresPath(vaultDir)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body, 'utf-8')
  renameSync(tmp, path)
}

// Local-time ISO to seconds (matches Python datetime.now().isoformat(timespec='seconds') —
// naive local, no tz). Nondeterministic; excluded from parity diffs.
function localIsoSeconds(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export interface UpdateStreamResult {
  ok: boolean
  stream: Record<string, unknown> | null
}

/** Edit a stream's fields; mark it curated (source='synced'). Port of update_stream. */
export function updateStream(
  vaultDir: string | null,
  nodeId: string,
  patch: Record<string, unknown>,
  now: Date = new Date()
): UpdateStreamResult {
  if (!vaultDir) return { ok: false, stream: null }
  const nodes = loadFutureNodes(vaultDir)
  let updated: Record<string, unknown> | null = null
  const p = patch || {}
  for (const n of nodes) {
    if (n.id !== nodeId) continue
    for (const [k, v] of Object.entries(p)) {
      if (ALLOWED.has(k)) {
        // Match Python str(): a bool becomes 'True'/'False' (capitalized), a number → String(n).
        // Never store a bare bool/number in a text field (Python's rule).
        n[k] = typeof v === 'boolean' ? (v ? 'True' : 'False') : typeof v === 'number' ? String(v) : v
      } else if (k === 'steps' && Array.isArray(v)) {
        n.steps = (v as unknown[])
          .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && !!(s as Record<string, unknown>).event)
          .map((s) => ({
            event: String(s.event ?? '').slice(0, 160),
            when: cleanWhen(String(s.when ?? '')),
            lead: String(s.lead ?? '').slice(0, 24),
            done: Boolean(s.done)
          }))
      } else if (k === 'levels' && v && typeof v === 'object' && !Array.isArray(v)) {
        const lv = v as Record<string, unknown>
        for (const lk of ['risk', 'progress', 'confidence']) {
          if (typeof lv[lk] === 'number') {
            const levels = (n.levels as Record<string, number>) ?? {}
            levels[lk] = Math.round(Math.max(0, Math.min(1, lv[lk] as number)) * 100) / 100
            n.levels = levels
          }
        }
      }
    }
    if ('decide_by' in p) n.decide_by = cleanWhen(String(p.decide_by))
    n.source = 'synced'
    n.refreshed = localIsoSeconds(now)
    updated = n
  }
  saveFutureNodes(vaultDir, nodes)
  return { ok: updated !== null, stream: updated }
}

// Task text by id — mirrors list_tasks' gather (parse_task_line over _task_files, no stale
// filter) but only to resolve one title. Returns '' if not found (caller falls back to the id).
function taskTextById(vaultDir: string, taskId: string): string {
  for (const fp of taskFiles(vaultDir)) {
    let txt: string
    try {
      txt = readFileSync(fp, 'utf-8').replace(/\r\n?/g, '\n')
    } catch {
      continue
    }
    const rel = relative(vaultDir, fp).split(sep).join('/')
    const lines = txt.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const t = parseTaskLine(lines[i], rel, i)
      if (t && t.id === taskId) return t.text
    }
  }
  return ''
}

const ISO_DATE_FULL = /^\d{4}-\d{2}-\d{2}$/

export interface BindResult {
  ok: boolean
  error?: string
  already?: boolean
  stream_id?: string
  title?: string
  track?: string
}

/** Bind a task to the stream (move) it advances — append a task-linked step, idempotent.
 *  Port of bind_task. Owns future-nodes.jsonl. */
export function bindTask(vaultDir: string | null, taskId: string, streamId: string, due = ''): BindResult {
  if (!vaultDir || !taskId || !streamId) return { ok: false, error: 'task_id and stream_id required' }
  const nodes = loadFutureNodes(vaultDir)
  const s = nodes.find((x) => x.id === streamId)
  if (!s) return { ok: false, error: 'stream not found' }
  const steps = (s.steps as Record<string, unknown>[]) ?? []
  if (steps.some((st) => st.task_id === taskId)) return { ok: true, already: true, stream_id: streamId }
  const title = String(taskTextById(vaultDir, taskId) || taskId).slice(0, 80)
  const cleanDue = due && ISO_DATE_FULL.test(due) ? due : ''
  s.steps = [...steps, { event: title, when: cleanDue, task_id: taskId, gap: false, done: false }]
  saveFutureNodes(vaultDir, nodes)
  return { ok: true, stream_id: streamId, title: String(s.title ?? '').slice(0, 80), track: (s.track as string) ?? '' }
}

/** Disposition a stream: engage/pass/keep/delete/reset. Port of act_future. Owns future-nodes.jsonl. */
export function actFuture(vaultDir: string | null, nodeId: string, action: string): { ok: boolean; id?: string; action?: string } {
  if (!vaultDir) return { ok: false }
  const nodes = loadFutureNodes(vaultDir)
  if (action === 'delete') {
    saveFutureNodes(vaultDir, nodes.filter((n) => n.id !== nodeId))
    return { ok: true, id: nodeId, action: 'delete' }
  }
  const smap: Record<string, string> = { engage: 'engaged', pass: 'declined', reset: 'open' }
  for (const n of nodes) {
    if (n.id !== nodeId) continue
    if (action === 'keep') {
      n.kept = true
    } else {
      n.status = smap[action] ?? (n.status as string) ?? 'open'
      if (action === 'pass') n.kept = false
    }
  }
  saveFutureNodes(vaultDir, nodes)
  return { ok: true, id: nodeId, action }
}

/** Remove a task's binding(s) — from one stream (streamId given) or all. Port of unbind_task. */
export function unbindTask(vaultDir: string | null, taskId: string, streamId = ''): { ok: boolean; error?: string; removed?: number } {
  if (!vaultDir || !taskId) return { ok: false, error: 'task_id required' }
  const nodes = loadFutureNodes(vaultDir)
  let changed = 0
  for (const s of nodes) {
    if (streamId && s.id !== streamId) continue
    const steps = (s.steps as Record<string, unknown>[]) ?? []
    const kept = steps.filter((st) => st.task_id !== taskId)
    if (kept.length !== steps.length) {
      s.steps = kept
      changed += steps.length - kept.length
    }
  }
  if (changed) saveFutureNodes(vaultDir, nodes)
  return { ok: true, removed: changed }
}

const LANG_RULE =
  'LANGUAGE — write each item in the language of its DOMAIN: ProjectA / VendorCo (Chinese game business) in 中文; ' +
  'PartnerCo (a Japanese company) in 日本語 (Japanese); DUIN / harness, ProjectB, and personal in English. ' +
  'Match all field text to it.'
const randId = (): string => Math.random().toString(16).slice(2, 10).padEnd(8, '0')

/** Extract a JSON object/array from a model reply — tolerant of ```json fences + prose. Port of _json_from_model. */
export function jsonFromModel(raw: string, array = false): unknown {
  let s = (raw || '').trim()
  s = s.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '')
  const m = (array ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/).exec(s)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

/** Map a raw model stream JSON onto the persisted schema (defensive about field types). Port of _normalize_stream. */
export function normalizeStream(g: Record<string, unknown>, source = 'inferred'): Record<string, unknown> {
  const S = (v: unknown, n: number): string => String(v ?? '').slice(0, n)
  const rawTrack = typeof g.track === 'string' ? normalizeTrackKey(g.track) : '' // legacy key → current
  const track = WORLD_TRACK_KEYS.has(rawTrack)
    ? rawTrack
    : trackOf(`${(g.title as string) ?? ''} ${(g.objective as string) ?? ''}`) ?? 'unknown'
  const steps: Record<string, unknown>[] = []
  for (const st of (Array.isArray(g.steps) ? (g.steps as unknown[]) : []).slice(0, 7)) {
    if (st && typeof st === 'object') {
      const s = st as Record<string, unknown>
      steps.push({ event: S(s.event, 160), when: cleanWhen(String(s.when ?? '')), lead: S(s.lead, 24), done: Boolean(s.done), task_id: String(s.task_id ?? ''), gap: Boolean(s.gap) })
    } else if (typeof st === 'string') {
      steps.push({ event: st.slice(0, 160), when: '', lead: '', done: false, task_id: '', gap: false })
    }
  }
  const conf = typeof g.confidence === 'number' ? g.confidence : 0.5
  const lv = g.levels && typeof g.levels === 'object' ? (g.levels as Record<string, unknown>) : {}
  const lvl = (k: string, d: number): number => (typeof lv[k] === 'number' && (lv[k] as number) >= 0 && (lv[k] as number) <= 1 ? (lv[k] as number) : d)
  const kind = g.kind === 'active' || g.kind === 'emerging' ? (g.kind as string) : source === 'synced' ? 'active' : 'emerging'
  return {
    title: S(g.title || g.objective, 80),
    objective: S(g.objective, 240),
    parent: S(g.parent, 40),
    parent_label: S(g.parent_label, 80),
    anchor_id: S(g.anchor_id, 48),
    track,
    kind,
    target: S(g.target, 40),
    trigger: S(g.trigger, 240),
    decision: S(g.decision, 240),
    decide_by: cleanWhen(String(g.decide_by ?? '')),
    steps,
    cleared: S(g.cleared, 240),
    blocked: S(g.blocked, 240),
    confirm: S(g.confirm, 160),
    levels: { risk: lvl('risk', 0.3), progress: lvl('progress', 0.1), confidence: lvl('confidence', conf) },
    confidence: conf,
    log: [],
    source
  }
}

export interface ExtractStreamDeps {
  generate: (prompt: string, task?: 'chat' | 'extraction' | 'title' | 'code' | 'reason') => Promise<string>
  now: () => Date
  id: () => string
}
const defaultExtractDeps: ExtractStreamDeps = { generate: generateOnce, now: () => new Date(), id: randId }

/** Structure a free-text strategic stream into ONE persisted stream node (model-backed).
 *  Port of extract_stream. Owns future-nodes.jsonl (append). */
export async function extractStream(
  vaultDir: string | null,
  text: string,
  deps: ExtractStreamDeps = defaultExtractDeps
): Promise<{ ok: boolean; error?: string; stream?: Record<string, unknown> }> {
  const amenu = readAnchorDecls(vaultDir)
    .filter((d) => !d.confidential)
    .map((d) => `- ${d.id} · ${d.name} · ${d.date || 'undated'} · ${d.track || ''}`)
    .join('\n')
  const today = localIsoSeconds(deps.now()).slice(0, 10)
  const prompt =
    'The operator is SYNCING a strategic STREAM to his second brain — a plan/opportunity he\'s describing in his own ' +
    'words. Structure it as ONE stream: an objective reached via an ordered chain of dependent steps, gated ' +
    'by a key decision. CRUCIAL: if the objective has a target window and steps carry lead times, ' +
    'BACK-PROPAGATE the latest the decision can be made (target − total lead time) into decide_by — surface ' +
    'the hidden deadline.\n\nReturn ONLY a JSON object: {"title": short name, "objective": the goal incl. ' +
    'its target window, "target": target date/window, "anchor_id": id of the declared ANCHOR this serves ' +
    '(from the ANCHOR MENU below; "" if none fits), "track": "ProjectA"|"PartnerCo"|"Tooling"|"personal", ' +
    '"trigger": the near-term first event, "decision": the key decision to make, "decide_by": "YYYY-MM" ' +
    '(back-propagated), "steps": [{"event", "when", "lead": e.g. "~12mo"}], "cleared": the payoff if ' +
    'the path clears, "blocked": the risk/problem if it doesn\'t, "confidence": 0.0-1.0}.\n' +
    `${LANG_RULE}\n\nToday is ${today}.\n\n` +
    `=== DECLARED ANCHORS (bind via anchor_id) ===\n${amenu || '(none)'}\n\nThe operator's description:\n${text}`
  const raw = await deps.generate(prompt, 'extraction')
  const g = jsonFromModel(raw, false)
  if (!g || typeof g !== 'object') return { ok: false, error: 'could not structure that' }
  const now = deps.now()
  const node = {
    ...normalizeStream(g as Record<string, unknown>, 'synced'),
    id: deps.id(),
    status: 'open',
    created: localIsoSeconds(now),
    refreshed: localIsoSeconds(now)
  }
  if (vaultDir) {
    const nodes = loadFutureNodes(vaultDir)
    nodes.push(node)
    saveFutureNodes(vaultDir, nodes)
  }
  return { ok: true, stream: node }
}
