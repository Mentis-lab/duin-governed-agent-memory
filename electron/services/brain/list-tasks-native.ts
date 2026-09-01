// Native port of resources/brain/server.py :: list_tasks (6347) + parse_task_line
// (6271) + _build_bind_index (6316) + _feeds_from_index (6329).
//
// The existing causal-substrate parseTaskLine is a PARTIAL port (drops movable/
// estimate/assignees, different key order) — fine for its internal uses but not
// byte-exact for the /state/tasks payload, which serialises the full 15-key card.
// So this is a standalone full port. Verified byte-exact vs the Python oracle.
import { readFileSync } from 'fs'
import { relative as relpath } from 'path'
import { taskFiles } from './throughput'
import { loadFutures } from './causal-substrate'
import { TASK_ID_FIELD, LEGACY_TASK_ID_FIELD } from './task-fields'

const TASK_COLUMNS = ['Inbox', 'Today', 'ThisWeek', 'Soon', 'Someday', 'Waiting', 'Done']
const TASK_LINE = /^\s*- \[([ xX])\]\s*(.*)$/
const TASK_FIELD = /\{\{(\w+)::\s*([^}]*)\}\}/g

function readLines(fp: string): string[] {
  try {
    return readFileSync(fp, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  } catch {
    return []
  }
}
function sliceCp(s: string, n: number): string {
  return [...s].slice(0, n).join('')
}
/** Python str.strip(chars): remove any leading/trailing char in `chars`. */
function stripChars(s: string, chars: string): string {
  const set = new Set([...chars])
  let a = 0
  let b = s.length
  while (a < b && set.has(s[a])) a++
  while (b > a && set.has(s[b - 1])) b--
  return s.slice(a, b)
}

export interface TaskCard {
  id: string
  movable: boolean
  text: string
  done: boolean
  status: string
  priority: string
  due: string
  estimate: string
  assignees: string
  tags: string[]
  people: string[]
  contexts: string[]
  project: string
  source: string
  line: number
  feeds?: Record<string, string>[]
  grounded?: boolean
}

/** Full port of parse_task_line — the 15-key Kanban card, keys in Python order. */
export function parseTaskLineFull(line: string, source: string, idx: number): TaskCard | null {
  const m = TASK_LINE.exec(line)
  if (!m) return null
  const done = m[1].toLowerCase() === 'x'
  const rest = m[2]
  const fields: Record<string, string> = {}
  for (const fm of rest.matchAll(TASK_FIELD)) fields[fm[1]] = fm[2].trim()
  const clean = rest.replace(TASK_FIELD, '') // drop {{key:: val}} before tags/@mentions
  const tags = [...clean.matchAll(/#([^\s#]+)/g)].map((x) => x[1])
  const people = [...clean.matchAll(/@([^\s@]+)/g)].map((x) => x[1].replace(/[)}\];,.，。、]+$/, ''))
  const contexts = (fields.contexts || '')
    .split(';')
    .map((c) => c.trim())
    .filter(Boolean)
  let text = clean
    .replace(/#\S+/g, '')
    .replace(/@\S+/g, '')
    .replace(/[📩📅✅🔁⏳]/gu, '')
    .replace(/https?:\/\/\S+/g, '')
  text = stripChars(text.replace(/\s+/g, ' '), ' -—|')
  const status = (fields.status || '').replace(/Project\./g, '').trim() || (done ? 'Done' : 'Inbox')
  let project = ''
  if (source.startsWith('03 Projects/')) project = source.split('/')[1]
  else if (source.startsWith('06 Tasks/') || source.startsWith('DUIN/Tasks/'))
    project = source.slice(source.lastIndexOf('/') + 1).slice(0, -3)
  else if (source.endsWith('/Tasks.md') || /\/Tasks-\d+\.md$/.test(source)) project = source.split('/')[0]
  return {
    id: fields[TASK_ID_FIELD] ?? fields[LEGACY_TASK_ID_FIELD] ?? `${source}#${idx}`,
    movable: true,
    text: sliceCp(text, 220) || '(untitled task)',
    done,
    status,
    priority: fields.priority || '',
    due: fields.dateDue || '',
    estimate: fields.estimate || '',
    assignees: fields.assignees || '',
    tags: tags.slice(0, 6),
    people: people.slice(0, 6),
    contexts: contexts.slice(0, 6),
    project,
    source,
    line: idx
  }
}

type Stream = Record<string, unknown>
type BindIndex = Map<string, [Stream, Stream][]>

/** Port of _build_bind_index: task_id → [(stream, step)]. */
function buildBindIndex(streams: Stream[]): BindIndex {
  const idx: BindIndex = new Map()
  for (const s of streams) {
    for (const st of ((s.steps as Stream[]) || []) ?? []) {
      const tid = st.task_id as string | undefined
      if (tid) {
        if (!idx.has(tid)) idx.set(tid, [])
        idx.get(tid)!.push([s, st])
      }
    }
  }
  return idx
}

/** Port of _feeds_from_index: provenance for one task (dedup by stream id). */
function feedsFromIndex(taskId: string, idx: BindIndex): Record<string, string>[] {
  const out: Record<string, string>[] = []
  const seen = new Set<string>()
  for (const [s, st] of idx.get(taskId) || []) {
    const sid = String(s.id ?? '')
    if (seen.has(sid)) continue
    seen.add(sid)
    out.push({
      stream_id: sid,
      title: sliceCp(String(s.title ?? ''), 80),
      track: String(s.track ?? ''),
      goal: String(s.parent_label ?? ''),
      step: sliceCp(String(st.event ?? ''), 80)
    })
  }
  return out
}

export interface ListTasksResult {
  columns: string[]
  tasks: TaskCard[]
  counts: Record<string, number>
  grounded: number
  open: number
}

/** Port of list_tasks. */
export function listTasks(vaultDir: string | null): ListTasksResult {
  if (!vaultDir) return { columns: ['Inbox', 'Done'], tasks: [], counts: {}, grounded: 0, open: 0 }
  const tasks: TaskCard[] = []
  for (const fp of taskFiles(vaultDir)) {
    const rel = relpath(vaultDir, fp).replace(/\\/g, '/')
    const lines = readLines(fp)
    for (let i = 0; i < lines.length; i++) {
      const t = parseTaskLineFull(lines[i], rel, i)
      if (t) tasks.push(t)
    }
  }
  const present = new Set(tasks.map((t) => t.status))
  const columns = [
    ...TASK_COLUMNS.filter((c) => present.has(c)),
    ...[...present].filter((c) => !TASK_COLUMNS.includes(c)).sort()
  ]
  const capped: TaskCard[] = []
  const counts: Record<string, number> = {}
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] || 0) + 1
    if (counts[t.status] <= 60) capped.push(t)
  }
  const idx = buildBindIndex(loadFutures(vaultDir) as Stream[])
  let groundedN = 0
  for (const t of capped) {
    t.feeds = feedsFromIndex(t.id, idx)
    t.grounded = t.feeds.length > 0
    if (t.grounded && !t.done) groundedN++
  }
  const openN = capped.filter((t) => !t.done).length
  return {
    columns: columns.length ? columns : ['Inbox', 'Done'],
    tasks: capped,
    counts,
    grounded: groundedN,
    open: openN
  }
}
