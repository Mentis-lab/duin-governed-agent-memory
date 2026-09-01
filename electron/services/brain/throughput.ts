// Completion-velocity throughput — faithful TS port of server.py:throughput_history()
// (brain unification, first route parity-port). Reads completion dates from markdown
// `✅ YYYY-MM-DD` stamps in task files (DUIN's OWN completion signal), bucketed by ISO
// week. As an OPTIONAL legacy-interop bonus, it also unions in `dateCompleted` from the
// external Operon Obsidian plugin's `.operon/index.json` if that plugin happens to be
// installed — DUIN does NOT require it or depend on it. The task-file + arena discovery
// here is the first shared vault-convention substrate brick — later route ports reuse it.
//
// Pure given (vaultDir, today) → deterministic → unit-tested.

import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { messageOf } from '../guarded'

export interface Throughput {
  total: number
  recent_28d: number
  newest: string | null
  cold_days: number | null
  weekly: { week: string; count: number }[]
  stale: boolean
}

// _PILLAR_CANDIDATES["tasks"] — DUIN layout first, else legacy.
const TASKS_PILLARS = ['DUIN/Tasks', '06 Tasks']
// server.py:_ARENA_RESERVED — top-level names that are never a user arena.
const ARENA_RESERVED = new Set([
  'duin', '.duin', '.brain', '.claude', '.obsidian', '.git', '.trash', '.codex',
  '_agui_outputs', '_agui_uploads', 'node_modules', '__pycache__', 'outputs', '99 attachments'
])

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
const ls = (p: string): string[] => {
  try {
    return readdirSync(p).sort()
  } catch {
    return []
  }
}

/** Top-level arena folders (ProjectA, PartnerCo-DUIN, …): dirs that aren't reserved,
 *  hidden/underscored, or a numbered pillar ("03 Projects"). Port of _arena_dirs. */
export function arenaDirs(vault: string): string[] {
  return ls(vault).filter(
    (name) =>
      !name.startsWith('.') &&
      !name.startsWith('_') &&
      !ARENA_RESERVED.has(name.toLowerCase()) &&
      !/^\d{2}\s/.test(name) &&
      isDir(join(vault, name))
  )
}

/** Every task-carrying markdown file. Port of _task_files: the tasks pillar's
 *  *.md ∪ legacy `03 Projects/<proj>/Tasks.md` ∪ arena `Tasks.md`/`Tasks-N.md`. */
export function taskFiles(vault: string): string[] {
  const files: string[] = []
  const td = TASKS_PILLARS.map((c) => join(vault, c)).find(isDir)
  if (td) files.push(...ls(td).filter((f) => f.endsWith('.md')).map((f) => join(td, f)))
  const pd = join(vault, '03 Projects')
  if (isDir(pd)) {
    for (const proj of ls(pd)) {
      const tf = join(pd, proj, 'Tasks.md')
      if (isFile(tf)) files.push(tf)
    }
  }
  for (const arena of arenaDirs(vault)) {
    for (const f of ls(join(vault, arena))) {
      if (f === 'Tasks.md' || /^Tasks-\d+\.md$/.test(f)) files.push(join(vault, arena, f))
    }
  }
  return files
}

/** ISO-8601 (year, week) — matches Python date.isocalendar()[:2]. */
export function isoWeek(d: Date): [number, number] {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = (t.getUTCDay() + 6) % 7 // Mon=0..Sun=6
  t.setUTCDate(t.getUTCDate() - dayNum + 3) // to the Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayNum + 3)
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 86400000))
  return [t.getUTCFullYear(), week]
}

const parseDate = (s: string): Date | null => {
  const d = new Date(s + 'T00:00:00Z')
  return isNaN(d.getTime()) ? null : d
}
const daysBetween = (a: Date, b: Date): number => Math.floor((a.getTime() - b.getTime()) / 86400000)
const isoDate = (d: Date): string => d.toISOString().slice(0, 10)

/**
 * Completion velocity, weekly-bucketed. `today` is injectable for tests.
 * Faithful to server.py:throughput_history() — same sources, same shape, same
 * stale rule (newest is null OR >7 days cold OR <30 completions in 28d).
 */
export function computeThroughput(vaultDir: string | null, today: Date = new Date()): Throughput {
  // Anchor "today" to UTC-midnight of the operator's LOCAL date so it aligns with the
  // completion dates (parsed at UTC-midnight of the date string) — otherwise a wall-clock
  // `today` mis-buckets same-day completions at the UTC day boundary.
  const t0 = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))
  const dates: Date[] = []
  if (vaultDir) {
    try {
      // OPTIONAL LEGACY interop: the external Operon Obsidian plugin's index. Read only if present;
      // DUIN's own completion signal is the `✅ YYYY-MM-DD` stamps unioned in below. Absent → skipped.
      const idx = JSON.parse(readFileSync(join(vaultDir, '.operon', 'index.json'), 'utf-8')) as {
        tasks?: Record<string, { fieldValues?: { dateCompleted?: string } }>
      }
      for (const t of Object.values(idx.tasks ?? {})) {
        const dc = t?.fieldValues?.dateCompleted
        const d = dc ? parseDate(dc) : null
        if (d) dates.push(d)
      }
    } catch (e) { console.debug('[throughput] no external Operon-plugin index (optional):', messageOf(e)) }
    for (const fp of taskFiles(vaultDir)) {
      let txt: string
      try {
        txt = readFileSync(fp, 'utf-8')
      } catch {
        continue
      }
      const re = /✅\s*(\d{4}-\d{2}-\d{2})/g
      let m: RegExpExecArray | null
      while ((m = re.exec(txt))) {
        const d = parseDate(m[1])
        if (d) dates.push(d)
      }
    }
  }

  const weeks = new Map<string, number>()
  for (const d of dates) {
    const [y, w] = isoWeek(d)
    const key = `${y}-W${String(w).padStart(2, '0')}`
    weeks.set(key, (weeks.get(key) ?? 0) + 1)
  }
  const recent28 = dates.filter((d) => {
    const diff = daysBetween(t0, d)
    return diff >= 0 && diff <= 28
  }).length
  const newest = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null
  const weekly = [...weeks.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-12)
    .map(([week, count]) => ({ week, count }))

  return {
    total: dates.length,
    recent_28d: recent28,
    newest: newest ? isoDate(newest) : null,
    cold_days: newest ? daysBetween(t0, newest) : null,
    weekly,
    stale: newest === null || daysBetween(t0, newest) > 7 || recent28 < 30
  }
}
