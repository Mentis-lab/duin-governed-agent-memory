// list_loops() — TS port of server.py:list_loops (brain unification, route 4,
// served at /state/loops — the path the renderer actually calls). A read-only
// VISUALIZATION of what runs under the hood: the learning loop (corrections.jsonl)
// + the autonomous routine pulse (autonomous-log.jsonl). Verified live vs :8765.

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const BRAIN_DIR = '.duin'

export interface Learning {
  ts: string
  skill: string
  correction: string
  rule: string
  status: string
  polarity: string
}
export interface RoutineRun {
  routine: string
  runs: number
  lastTs: string
  lastMessage: string
  level: string
  path: string
}
export interface DecisionLoop {
  learnings: Learning[]
  routines: RoutineRun[]
  summary: { learnings: number; promoted: number; corrections: number; positives: number; routines: number }
}

function readJsonl(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((x): x is Record<string, unknown> => x !== null)
  } catch {
    return []
  }
}

const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

export function decisionLoop(vaultDir: string | null): DecisionLoop {
  const empty: DecisionLoop = {
    learnings: [],
    routines: [],
    summary: { learnings: 0, promoted: 0, corrections: 0, positives: 0, routines: 0 }
  }
  if (!vaultDir) return empty
  const state = join(vaultDir, BRAIN_DIR, '_state')

  const learnings: Learning[] = readJsonl(join(state, 'corrections.jsonl')).map((o) => ({
    ts: s(o.ts),
    skill: s(o.skill).replace(/^[() ]+|[() ]+$/g, ''),
    correction: s(o.correction).slice(0, 260),
    rule: s(o.candidate_rule).slice(0, 260),
    status: s(o.status),
    polarity: s(o.polarity)
  }))
  learnings.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)) // ts desc

  const runs = new Map<string, RoutineRun>()
  for (const o of readJsonl(join(state, 'autonomous-log.jsonl'))) {
    const r = s(o.routine) || '?'
    const e = runs.get(r) ?? { routine: r, runs: 0, lastTs: '', lastMessage: '', level: 'info', path: '' }
    e.runs++
    const ts = s(o.ts)
    if (ts >= e.lastTs) {
      e.lastTs = ts
      e.lastMessage = s(o.message).slice(0, 160)
      e.level = s(o.level) || 'info'
    }
    runs.set(r, e)
  }
  for (const e of runs.values()) {
    e.path =
      ['.py', '.ps1']
        .map((ext) => `${BRAIN_DIR}/routines/${e.routine}${ext}`)
        .find((p) => existsSync(join(vaultDir, p))) ?? ''
  }
  const routines = [...runs.values()].sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0))

  return {
    learnings: learnings.slice(0, 60),
    routines,
    summary: {
      learnings: learnings.length,
      promoted: learnings.filter((x) => x.status === 'promoted').length,
      corrections: learnings.filter((x) => x.polarity === 'correction').length,
      positives: learnings.filter((x) => x.polarity === 'positive').length,
      routines: routines.length
    }
  }
}
