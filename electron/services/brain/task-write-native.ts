// task-write-native — DUIN task-line mutations over vault Kanban markdown
// (task-action: complete/reopen/priority/due/estimate/delete; task-move: drag to a column).
// Ports task_action + move_task + their machinery (_locate_task, _set_inline_field,
// _rewrite_task_status, _task_files, _atomic_write) from server.py. This cluster owns the
// task LINES in the vault's Tasks*.md files.
//
// DEFERRED side effect (documented, matches the calibration/forecast native-write precedent):
// Python's task_action/move_task call schedule_recompute(['owed-decisions-detector',
// 'dashboard_feed']) to debounce-refresh derived detectors. Those routines also run on
// cadence (scheduled tasks), so the native write lands correctly and the derived views
// refresh on the next tick instead of ~6s post-edit. No state correctness impact.
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'fs'
import { join, dirname, sep, relative, isAbsolute } from 'path'
import { TASK_ID_FIELD, LEGACY_TASK_ID_FIELD } from './task-fields'
import { messageOf } from '../guarded'
import { isHighPriority, watchHighPriorityTask } from '../proactive/watchers'

// /m so `$` matches before a trailing "\n" (lines are read keepends). Python's re.match
// with a plain `$` tolerates that trailing newline; JS `$` without /m would not → miss.
const TASK_LINE = /^\s*- \[([ xX])\]\s*(.*)$/m
const isoDay = (d: Date): string => d.toISOString().slice(0, 10)
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// Read a vault note the way Python does: universal-newline translate (\r\n?, lone \r → \n),
// then split into lines KEEPING the trailing \n (splitlines(keepends=True)).
function readLinesKeepEnds(fp: string): string[] {
  const text = readFileSync(fp, 'utf-8').replace(/\r\n?/g, '\n')
  const out: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      out.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}

// Atomic write: temp file in the same dir + rename (crash-safe). newline is already \n.
function atomicWrite(path: string, text: string): void {
  const tmp = join(dirname(path), `.tmp-${process.pid}-${path.length}.swp`)
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, path)
}

const PILLAR_TASKS = ['DUIN/Tasks', '06 Tasks']
const ARENA_RESERVED = new Set([
  'duin', '.duin', '.brain', '.claude', '.obsidian', '.git', '.trash', '.codex',
  '_agui_outputs', '_agui_uploads', 'node_modules', '__pycache__', 'outputs', '99 attachments'
])

function pillarDir(base: string, candidates: string[]): string {
  for (const c of candidates) {
    const full = join(base, ...c.split('/'))
    if (isDir(full)) return full
  }
  return join(base, ...candidates[0].split('/'))
}

function arenaDirs(base: string): string[] {
  let names: string[]
  try {
    names = readdirSync(base).sort()
  } catch {
    return []
  }
  return names.filter((name) => {
    if (!isDir(join(base, name))) return false
    if (name.startsWith('.') || name.startsWith('_')) return false
    if (ARENA_RESERVED.has(name.toLowerCase())) return false
    if (/^\d{2}\s/.test(name)) return false
    return true
  })
}

/** Every file that can carry task lines: tasks pillar *.md + legacy 03 Projects/<p>/Tasks.md
 *  + each arena's Tasks.md / Tasks-N.md. Port of _task_files. */
export function taskFiles(base: string): string[] {
  const files: string[] = []
  const td = pillarDir(base, PILLAR_TASKS)
  if (isDir(td)) {
    for (const f of readdirSync(td).sort()) if (f.endsWith('.md')) files.push(join(td, f))
  }
  const pd = join(base, '03 Projects')
  if (isDir(pd)) {
    for (const proj of readdirSync(pd).sort()) {
      const tf = join(pd, proj, 'Tasks.md')
      if (isFile(tf)) files.push(tf)
    }
  }
  for (const arena of arenaDirs(base)) {
    const ad = join(base, arena)
    try {
      for (const f of readdirSync(ad).sort()) {
        if (f === 'Tasks.md' || /^Tasks-\d+\.md$/.test(f)) files.push(join(ad, f))
      }
    } catch (e) { console.debug('[task-write-native] unreadable arena:', messageOf(e)) }
  }
  return files
}

interface TaskLoc {
  fp: string
  idx: number
  lines: string[]
}

/** Resolve a task id (duinTaskId, legacy operonId, or 'relpath#line') to its file + line. Port of _locate_task. */
export function locateTask(base: string, taskId: string): TaskLoc | null {
  if (taskId.includes('#')) {
    const hash = taskId.lastIndexOf('#')
    const src = taskId.slice(0, hash)
    const idxS = taskId.slice(hash + 1)
    const idx = Number.parseInt(idxS, 10)
    if (!Number.isInteger(idx) || String(idx) !== idxS.trim()) return null
    const fp = join(base, src.split('/').join(sep))
    // Containment guard: a task id like '../../x#3' must not escape the vault.
    const rel = relative(base, fp)
    if (rel.startsWith('..') || isAbsolute(rel)) return null
    if (!isFile(fp)) return null
    const lines = readLinesKeepEnds(fp)
    if (idx >= 0 && idx < lines.length && TASK_LINE.test(lines[idx])) return { fp, idx, lines }
    return null
  }
  for (const fp of taskFiles(base)) {
    let lines: string[]
    try {
      lines = readLinesKeepEnds(fp)
    } catch {
      continue
    }
    for (let i = 0; i < lines.length; i++) {
      // Match the DUIN-native id field OR the legacy Operon field so both new and pre-existing tasks resolve.
      if (
        lines[i].includes(`${TASK_ID_FIELD}:: ${taskId}`) ||
        lines[i].includes(`${LEGACY_TASK_ID_FIELD}:: ${taskId}`)
      )
        return { fp, idx: i, lines }
    }
  }
  return null
}

/** Set/replace/remove an inline {{key:: value}} field on a task line. Port of _set_inline_field. */
export function setInlineField(line: string, key: string, value: string): string {
  const k = escRe(key)
  if (!value) return line.replace(new RegExp(`\\s*\\{\\{${k}::[^}]*\\}\\}`, 'g'), '')
  if (line.includes(`{{${key}::`)) {
    return line.replace(new RegExp(`\\{\\{${k}::[^}]*\\}\\}`), `{{${key}:: ${value}}}`)
  }
  const nl = line.endsWith('\n') ? '\n' : ''
  return line.replace(/\n+$/, '') + ` {{${key}:: ${value}}}` + nl
}

/** Rewrite a task's {{status:: Project.X}} + checkbox for a column move. Port of _rewrite_task_status. */
export function rewriteTaskStatus(line: string, status: string): string {
  if (line.includes('{{status::')) {
    line = line.replace(/\{\{status::\s*[^}]*\}\}/, `{{status:: Project.${status}}}`)
  } else {
    const nl = line.endsWith('\n') ? '\n' : ''
    line = line.replace(/\n+$/, '') + ` {{status:: Project.${status}}}` + nl
  }
  if (status === 'Done') line = line.replace(/- \[ \]/, '- [x]')
  else line = line.replace(/- \[[xX]\]/, '- [ ]')
  return line
}

export interface TaskActionResult {
  ok: boolean
  error?: string
}

/** Human title of a task line: the checkbox body with inline {{key:: val}} fields and
 *  trailing emoji-date stamps stripped. Best-effort display text for a notice. PURE. */
export function taskTitleOf(line: string): string {
  const m = line.match(TASK_LINE)
  const body = (m ? m[2] : line) || ''
  return body
    .replace(/\{\{[^}]*\}\}/g, '') // inline fields
    // The `u` flag is load-bearing. Without it this class is 5 UTF-16 code units, not 4 emoji:
    // 🔺/🔴 decompose into \uD83D + \uDD3A/\uDD34, so the bare high surrogate \uD83D matches on
    // its own and — the date tail being fully optional — strips the high surrogate off ANY
    // \uD83D-family emoji in a title (🔥 🚀 💡 …), leaving an orphan low surrogate in the notice.
    .replace(/[✅⏫🔺🔴]\s*\d{0,4}-?\d{0,2}-?\d{0,2}/gu, '') // status/date/priority stamps
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Board task edit: complete / reopen / priority|due|estimate / delete. Port of task_action. */
export function taskAction(
  base: string | null,
  taskId: string,
  action: string,
  value = '',
  today: Date = new Date()
): TaskActionResult {
  if (!base) return { ok: false, error: 'task not found' }
  const loc = locateTask(base, taskId)
  if (!loc) return { ok: false, error: 'task not found' }
  const { fp, idx, lines } = loc
  let line = lines[idx]
  if (action === 'delete') {
    lines.splice(idx, 1)
  } else if (action === 'complete') {
    line = line.replace(/- \[ \]/, '- [x]')
    if (!line.includes('✅')) {
      const nl = line.endsWith('\n') ? '\n' : ''
      line = line.replace(/\n+$/, '') + ` ✅ ${isoDay(today)}` + nl
    }
    lines[idx] = setInlineField(line, 'status', 'Project.Done')
  } else if (action === 'reopen') {
    line = line.replace(/- \[[xX]\]/, '- [ ]')
    line = line.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/g, '')
    lines[idx] = setInlineField(line, 'status', 'Project.Inbox')
  } else if (action === 'priority' || action === 'due' || action === 'estimate') {
    const key = action === 'priority' ? 'priority' : action === 'due' ? 'dateDue' : 'estimate'
    lines[idx] = setInlineField(line, key, value.trim())
  } else {
    return { ok: false, error: `unknown action ${action}` }
  }
  atomicWrite(fp, lines.join(''))
  // Proactive watch/notify (#2): a task just turned high-priority (P0). Fire the
  // (opt-in, default-OFF) task watcher as a post-step call — best-effort, never
  // throws, and does not affect the write above. Guarded so only a genuinely-high
  // priority even consults the watcher.
  if (action === 'priority' && isHighPriority(value)) {
    void watchHighPriorityTask({ taskId, title: taskTitleOf(lines[idx]), priority: value.trim() })
  }
  return { ok: true }
}

/** Move a task to a new column (rewrite {{status}} + checkbox). Port of move_task; returns bool. */
export function moveTask(base: string | null, taskId: string, status: string): boolean {
  if (!base || !taskId) return false
  const st = status.replace(/[^A-Za-z]/g, '') || 'Inbox'
  const loc = locateTask(base, taskId)
  if (!loc) return false
  const { fp, idx, lines } = loc
  lines[idx] = rewriteTaskStatus(lines[idx], st)
  atomicWrite(fp, lines.join(''))
  return true
}
