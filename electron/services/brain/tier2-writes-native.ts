// tier2-writes-native — small pure operator writers, each owning one state file:
//   recordPredictionFeedback → .duin/_state/prediction-feedback.jsonl (append audit trail)
//   dismissAnchorCandidate   → .duin/_state/anchor-dismissed.json (sorted dismissed set)
// Ports of record_prediction_feedback + dismiss_anchor_candidate. No model side effects.
import { appendFileSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'fs'
import { join, dirname } from 'path'

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const stateDir = (vaultDir: string): string => join(vaultDir, '.duin', '_state')
const feedbackPath = (vaultDir: string): string => join(stateDir(vaultDir), 'prediction-feedback.jsonl')
const dismissedPath = (vaultDir: string): string => join(stateDir(vaultDir), 'anchor-dismissed.json')

// Local-time ISO to seconds (matches Python datetime.now().isoformat(timespec='seconds')).
// Nondeterministic; excluded from parity diffs.
function localIsoSeconds(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const FEEDBACK_MARKS = new Set(['false_alarm', 'correct', 'clear'])

export interface FeedbackResult {
  ok: boolean
  error?: string
  id?: string
  mark?: string
}

/** Append a human verdict-correction on a prediction (latest-per-id wins downstream). Port of
 *  record_prediction_feedback. mark ∈ {false_alarm,correct,clear}. */
export function recordPredictionFeedback(
  vaultDir: string | null,
  pid: string,
  domain: string,
  mark: string,
  now: Date = new Date()
): FeedbackResult {
  if (!pid || !FEEDBACK_MARKS.has(mark)) {
    return { ok: false, error: 'id + mark in {false_alarm,correct,clear} required' }
  }
  if (!vaultDir) return { ok: false, error: 'no vault' }
  const p = feedbackPath(vaultDir)
  try {
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify({ id: pid, domain: domain || '', mark, ts: localIsoSeconds(now) }) + '\n', 'utf-8')
    return { ok: true, id: pid, mark }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) }
  }
}

function loadDismissed(vaultDir: string): Set<string> {
  try {
    const arr = JSON.parse(readFileSync(dismissedPath(vaultDir), 'utf-8')) as unknown
    return new Set(Array.isArray(arr) ? (arr as string[]) : [])
  } catch {
    return new Set()
  }
}

export interface DismissResult {
  ok: boolean
  error?: string
  dismissed?: string
  total_dismissed?: number
}

/** Reject an anchor candidate so detection stops proposing it. Port of dismiss_anchor_candidate.
 *  Writes the sorted dismissed set (json indent=2), matching Python json.dump(sorted(s), indent=2). */
export function dismissAnchorCandidate(vaultDir: string | null, referent: string): DismissResult {
  const ref = (referent || '').trim()
  if (!ref) return { ok: false, error: 'referent required' }
  if (!vaultDir) return { ok: false, error: 'no vault' }
  const s = loadDismissed(vaultDir)
  s.add(ref)
  const p = dismissedPath(vaultDir)
  try {
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true })
    const body = JSON.stringify([...s].sort(), null, 2)
    const tmp = `${p}.tmp-${process.pid}`
    writeFileSync(tmp, body, 'utf-8')
    renameSync(tmp, p)
    return { ok: true, dismissed: ref, total_dismissed: s.size }
  } catch (e) {
    return { ok: false, error: `write failed: ${String((e as Error)?.message ?? e)}` }
  }
}

export interface CreateProjectResult {
  ok: boolean
  error?: string
  name?: string
}

/** Create a project folder + hub note (03 Projects/<name> on a legacy vault, else a top-level arena).
 *  Port of create_project's deterministic core; returns the name so the caller can fire cascade_project.
 *  DEFERRED: _reproject_async (background). */
export function createProject(vaultDir: string | null, rawName: string): CreateProjectResult {
  const name = (rawName || '').trim().replace(/^[/\\]+|[/\\]+$/g, '')
  if (!name || /[\\/:*?"<>|]/.test(name)) return { ok: false, error: 'invalid name' }
  if (!vaultDir) return { ok: false, error: 'invalid name' }
  const legacyRoot = join(vaultDir, '03 Projects')
  const d = isDir(legacyRoot) ? join(legacyRoot, name) : join(vaultDir, name)
  if (isDir(d)) return { ok: false, error: 'a project with that name already exists' }
  try {
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'BRAIN.md'), `---\ntype: project-hub\ncreated-by: duin\n---\n\n# ${name} — Project Hub\n`, 'utf-8')
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
  return { ok: true, name }
}
