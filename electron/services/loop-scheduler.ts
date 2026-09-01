// loop-scheduler.ts — the TS loop scheduler (replaces the python loop-tick
// path). Reads .duin/loops/loops.yaml + loops-state.json, computes which loops
// are due (same schedule contract as loop_runner.py), and fires each due loop
// through the headless AGENTIC executor so it produces a real artifact.
//
// Single scheduler = no double-fire (the python tick is no longer called from
// main.ts). Gated by the backgroundAutonomy kill switch — when OFF, the tick is
// a no-op and nothing fires. Concurrency is capped at one loop per tick (serial)
// so a tick can't launch a fleet of heavy agent runs at once.

import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import yaml from 'js-yaml'
import { readSettings } from './settings-helper'
import { readLoopConfig } from './loop-config'
import { runLoopAgentic } from './loop-agent'
import { messageOf } from './guarded'

const DOW = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] // python weekday order
const TICK_MS = 5 * 60 * 1000
const INITIAL_MS = 30 * 1000

interface LoopDef {
  name: string
  enabled?: boolean
  schedule?: Record<string, unknown>
}

let timer: NodeJS.Timeout | null = null
let initial: NodeJS.Timeout | null = null
let firing = false

function vault(): string {
  return (readSettings().localBrainNotesDir as string) || ''
}

function loadLoops(v: string): LoopDef[] {
  try {
    const doc = yaml.load(readFileSync(join(v, '.duin', 'loops', 'loops.yaml'), 'utf-8'), {
      schema: yaml.JSON_SCHEMA
    }) as { loops?: LoopDef[] } | null
    return doc?.loops ?? []
  } catch {
    return []
  }
}

function loadState(v: string): Record<string, string> {
  try {
    const s = JSON.parse(readFileSync(join(v, '.duin', '_state', 'loops-state.json'), 'utf-8'))
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

function saveState(v: string, s: Record<string, string>): void {
  try {
    mkdirSync(join(v, '.duin', '_state'), { recursive: true })
    writeFileSync(join(v, '.duin', '_state', 'loops-state.json'), JSON.stringify(s, null, 2), 'utf-8')
  } catch (e) { console.debug('[loop-scheduler] best-effort:', messageOf(e)) }
}

/** Port of loop_runner.py is_due — every_hours / daily_at / weekly_on. */
export function isDue(sch: Record<string, unknown>, lastIso: string | undefined, now: Date): boolean {
  const last = lastIso ? new Date(lastIso) : null
  const lastValid = last && !Number.isNaN(last.getTime()) ? last : null

  if ('every_hours' in sch) {
    const hours = Number(sch.every_hours)
    return !lastValid || now.getTime() - lastValid.getTime() >= hours * 3600_000
  }
  if ('daily_at' in sch) {
    const [hh, mm] = String(sch.daily_at).split(':').map((x) => parseInt(x, 10))
    const target = new Date(now)
    target.setHours(hh || 0, mm || 0, 0, 0)
    return now >= target && (!lastValid || lastValid < target)
  }
  if ('weekly_on' in sch) {
    const dow = DOW.indexOf(String(sch.weekly_on).toLowerCase().slice(0, 3))
    if (dow < 0) return false
    const [hh, mm] = String(sch.at ?? '00:00').split(':').map((x) => parseInt(x, 10))
    const pyDow = (now.getDay() + 6) % 7 // JS Sun=0..Sat=6 → python Mon=0..Sun=6
    if (pyDow !== dow) {
      return !!lastValid && now.getTime() - lastValid.getTime() >= 7 * 86400_000
    }
    const target = new Date(now)
    target.setHours(hh || 0, mm || 0, 0, 0)
    return now >= target && (!lastValid || lastValid < target)
  }
  return false
}

async function tick(): Promise<void> {
  if (firing) return
  // BOTH kill switches, matching the DB loop controller.
  //
  // This scheduler used to require only `backgroundAutonomy`, while tickLoops required that
  // AND `loops.enabled`. The asymmetry was a safety bug, not a quirk: turning on background
  // autonomy armed THESE loops — which run with `apply_patch` and write to the vault — while
  // the toggle labelled "Enable loops" stayed off and the panel showed nothing running. The
  // switch a person reaches for to control loops now controls both loop engines.
  if (readSettings().backgroundAutonomy !== true) return
  if (!readLoopConfig().enabled) return
  const v = vault()
  if (!v) return
  firing = true
  try {
    const loops = loadLoops(v)
    const state = loadState(v)
    const now = new Date()
    for (const lp of loops) {
      if (!lp.name || lp.enabled === false) continue
      if (!isDue(lp.schedule ?? {}, state[lp.name], now)) continue
      try {
        const outcome = await runLoopAgentic(lp.name)
        // Stamp last-run only when it actually ran (agentic executor), so a
        // skipped (non-agentic / disabled) loop stays eligible for a dev tick.
        if (outcome.ran) {
          state[lp.name] = new Date().toISOString()
          saveState(v, state)
        }
      } catch (err) {
        console.error(`[loop-scheduler] ${lp.name} threw (continuing):`, (err as Error)?.message)
      }
    }
  } finally {
    firing = false
  }
}

export function startLoopScheduler(): void {
  if (timer) return
  initial = setTimeout(() => void tick(), INITIAL_MS)
  timer = setInterval(() => void tick(), TICK_MS)
}

export function stopLoopScheduler(): void {
  if (initial) {
    clearTimeout(initial)
    initial = null
  }
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
