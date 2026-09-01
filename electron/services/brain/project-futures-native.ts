// project_futures (native) — the projection engine's orchestration (Generative-Agents' third loop:
// observe → reflect → PROJECT). Composes the context layer + the model call + the reconciliation
// core into the full route. Port of project_futures (server.py:1365) + _resolve_step_to_task (2036).
//
// Flow: 60-min debounce (future-meta.json) → build the 5 context blocks → the projection prompt →
// injected model call → extractFirstJsonArray → reconcileProjection (with per-step task grounding) →
// persist future-nodes.jsonl + future-meta.json. Model call injected (no /agui grounding / learn ticks).

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { readAnchorDecls, anchorBinds, type Task, type AnchorDecl } from './causal-substrate'
import { extractFirstJsonArray } from './extraction-util'
import { loadTaskCorpus } from './task-corpus-native'
import { entityMatch } from './stream-nudge-write-native'
import { LANG_RULE } from './stream-sync-write-native'
import { reconcileProjection } from './reconcile-projection-native'
import { loadOntology } from './ontology'
import {
  operatorProfile, projectionContext, projectionLanes, strategyContext, goalsContext
} from './projection-context-native'
import { messageOf } from '../guarded'
import { CJK_CLASS } from './cjk-tokens'

const futuresPath = (v: string): string => join(v, '.duin', '_state', 'future-nodes.jsonl')
const metaPath = (v: string): string => join(v, '.duin', '_state', 'future-meta.json')

function loadFutureNodes(v: string): Record<string, unknown>[] {
  let txt: string
  try {
    txt = readFileSync(futuresPath(v), 'utf-8')
  } catch {
    return []
  }
  const rows: Record<string, unknown>[] = []
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      rows.push(JSON.parse(s) as Record<string, unknown>)
    } catch (e) { console.debug('[project-futures-native] skip:', messageOf(e)) }
  }
  return rows
}
function atomicWrite(path: string, body: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body, 'utf-8')
  renameSync(tmp, path)
}
function saveFutureNodes(v: string, rows: Record<string, unknown>[]): void {
  atomicWrite(futuresPath(v), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
}
function readMeta(v: string): { last?: string; count?: number } {
  try {
    return JSON.parse(readFileSync(metaPath(v), 'utf-8')) as { last?: string; count?: number }
  } catch {
    return {}
  }
}
function localIsoSeconds(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function isoDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const STOP_TOK = new Set(['task', 'risk', 'with', 'that', 'this', 'from', 'into', 'biweekly', 'report', 'project', 'delivery'])
// CJK runs of >=2, with the tokenizer's full CJK class (kanji + KANA) rather than the bare
// ideograph range — kana bounded a run, so a Japanese step/task produced no bigrams and
// could never ground against its task.
const CJK_RUN_RE = new RegExp(`[${CJK_CLASS}]{2,}`, 'g')
function sigTokenCount(a: string, b: string): number {
  const toks = (s: string): Set<string> => {
    const lc = (s || '').toLowerCase()
    const t = new Set([...lc.matchAll(/[a-z0-9]{4,}/g)].map((m) => m[0]))
    for (const run of lc.matchAll(CJK_RUN_RE)) {
      const r = run[0]
      for (let i = 0; i < r.length - 1; i++) t.add(r.slice(i, i + 2))
    }
    for (const st of STOP_TOK) t.delete(st)
    return t
  }
  const A = toks(a)
  const B = toks(b)
  let c = 0
  for (const x of A) if (B.has(x)) c++
  return c
}

interface Step { event?: string; when?: string; task_id?: string; gap?: boolean; [k: string]: unknown }

/**
 * Match one stream step to a real task — sets task_id (+gap=false) on a hit, else gap=true. Prefers
 * tasks bound to the stream's anchor, then the full corpus; a dated step requires the same month.
 * Mutates+returns the step. Port of _resolve_step_to_task (server.py:2036).
 */
export function resolveStepToTask(step: Step, tasks: Task[], anchorDecl?: AnchorDecl | null): Step {
  const ev = step.event ?? ''
  if (!ev) {
    step.task_id = ''
    step.gap = true
    return step
  }
  const when = step.when ?? ''
  const bound: Task[] = []
  const rest: Task[] = []
  for (const t of tasks) {
    const isBound = !!anchorDecl && anchorBinds(t, anchorDecl)
    ;(isBound ? bound : rest).push(t)
  }
  const best = (pool: Task[]): Task | null => {
    const cands: { score: number; t: Task }[] = []
    for (const t of pool) {
      if (!entityMatch(ev, t.text ?? '')) continue
      const tdue = t.due ?? ''
      if (when && tdue && when.slice(0, 7) !== tdue.slice(0, 7)) continue // both dated → same month
      let score = sigTokenCount(ev, t.text ?? '')
      if (when && tdue && when.slice(0, 7) === tdue.slice(0, 7)) score += 1
      cands.push({ score, t })
    }
    cands.sort((a, b) => b.score - a.score)
    return cands.length ? cands[0].t : null
  }
  const hit = best(bound) || best(rest)
  if (hit) {
    step.task_id = hit.id ?? ''
    step.gap = false
  } else {
    step.task_id = ''
    step.gap = true
  }
  return step
}

/** The full projection prompt — verbatim from server.py:1401-1444. `lanesEnum` is the quoted,
 *  pipe-joined lane list; the context blocks fall back to their Python placeholders. */
export function buildProjectionPrompt(
  prof: string, goals: string, strat: string, ctx: string, anchorMenu: string, lanesEnum: string, todayIso: string
): string {
  return (
    'You are the PROJECTION ENGINE of the operator\'s second brain. Understand the DIRECTIONS of his work and project ' +
    'the future timeline. Project STREAMS — chains from a near-term TRIGGER toward a GOAL, gated by a ' +
    'DECISION; when steps carry long lead times, BACK-PROPAGATE the decision deadline (target − total lead ' +
    'time = decide_by) to surface deadlines effectively due NOW. Streams serving the same goal share one ' +
    'parent (a few goals organize many streams).\n\n' +
    'SIGNIFICANCE RULE (critical): a stream must be THE OPERATOR\'S OWN WORK in his actual ROLE — something HE drives. ' +
    'EXCLUDE other functions\' work even when it concerns the same project — product art, game design, ' +
    'localization/engineering are the DEV team\'s lane, NOT his. Discard polite/perfunctory partner feedback ' +
    'and routine tasks.\n' +
    'THROUGH-LINE (how to judge importance): every stream must trace from his IDENTITY + PERSONAL GOALS, down ' +
    'through a specific PROJECT, into the concrete cards/actions/tasks that advance it. Importance and ' +
    'confidence follow that chain AND how often the thing RECURS — the more it is mentioned and the more ' +
    'other items converge on it, the more important and confident. If two candidates are the same underlying ' +
    'thing, MERGE them into ONE stronger stream — never duplicate.\n' +
    'ACTIVITY GATE (pipeline, critical): only project what he is ACTIVELY working on — it must appear in his ' +
    'RECENT updates/tasks/actions in the CURRENT STATE below, not merely in older foundation/project/card ' +
    'files. The KB establishes importance and grounding, but it cannot ORIGINATE a projection: if something ' +
    'lives only in the KB with no recent activity or task, it is DORMANT — do NOT project it.\n' +
    'PRIORITY + LANES (operator-specific — read from the OPERATOR PROFILE below, do NOT assume): weight ' +
    'streams by the operator\'s stated priorities, NOT equally; be COMPREHENSIVE across their real lanes ' +
    '(~6-10 streams); and respect their stated EXCLUSIONS (never project an excluded/dead item). If the ' +
    'profile is empty, weight by recurrence + convergence in the CURRENT STATE and don\'t invent priorities.\n' +
    'ASK WHEN UNSURE: if a stream matters but a key date/fact is unconfirmed (e.g. 二测 is Aug–Sep, not ' +
    'locked), set "confirm" to a short question for the operator — do NOT silently assert a guessed date.\n' +
    `${LANG_RULE}\n` +
    'NO MANUFACTURED URGENCY: set decide_by only when a real target date minus real lead times forces it; ' +
    'never label anything \'due today\' or \'IMMEDIATE\' unless an actual dated commitment truly requires it.\n' +
    'DATE HYGIENE: every step "when" and "decide_by" is a SINGLE clean date — "YYYY-MM-DD" or ' +
    '"YYYY-MM" — never a range, never dash-joined.\n\n' +
    'Return ONLY a JSON array; each stream: {"title", "objective", "parent": a short slug for the goal ' +
    'it serves (same goal ⇒ identical slug; "" if standalone), "parent_label": that goal in plain words, ' +
    '"target": date or "", "anchor_id": id of the declared ANCHOR this stream feeds (from the ' +
    `ANCHOR MENU below; "" only if none fits), "track": ${lanesEnum}, "kind": "active"|"emerging", ` +
    '"trigger", "decision", "decide_by": date or "", "steps": [{"event","when","lead"}], ' +
    '"cleared", "blocked", "confirm": a short question if a key date/fact needs the operator to confirm else "", ' +
    '"levels": {"risk":0-1,"progress":0-1,"confidence":0-1}, "confidence":0-1}.\n' +
    `Keep real names/dates/lead-times. Today is ${todayIso}.\n\n` +
    `=== OPERATOR PROFILE (priorities · lanes · exclusions · vocabulary — the operator layer) ===\n${prof || '(none — run operator-neutral)'}\n\n` +
    `=== THE OPERATOR'S PERSONAL GOALS (the significance lens) ===\n${goals || '(none)'}\n\n` +
    `=== HIS STRATEGY (knowledge base) ===\n${strat || '(none)'}\n\n` +
    `=== CURRENT STATE: tracks, risks, decisions, recent updates ===\n${ctx}\n\n` +
    `=== DECLARED ANCHORS (bind each stream to one by id via anchor_id) ===\n${anchorMenu || '(none)'}`
  )
}

export interface ProjectFuturesDeps {
  generate: (prompt: string) => Promise<string>
  force?: boolean
  now?: () => Date
  uid?: () => string
}

export interface ProjectFuturesResult {
  ok: boolean
  error?: string
  skipped?: string
  empty?: boolean
  generated?: number
  streams?: Record<string, unknown>[]
  nodes?: Record<string, unknown>[]
}

const liveStreams = (nodes: Record<string, unknown>[]): Record<string, unknown>[] =>
  nodes.filter((s) => s.status === 'open' || s.status === 'engaged')

/**
 * Generate + reconcile + persist the anticipated future streams. Port of project_futures. 60-min
 * debounce unless force; empty context ⇒ empty; empty model output or empty reconcile ⇒ keep existing.
 */
export async function runProjectFutures(vaultDir: string, deps: ProjectFuturesDeps): Promise<ProjectFuturesResult> {
  if (!vaultDir) return { ok: false, error: 'no vault' }
  const now = (deps.now ?? (() => new Date()))()
  const existing = loadFutureNodes(vaultDir)
  const meta = readMeta(vaultDir)
  if (!deps.force && meta.last) {
    const last = new Date(meta.last).getTime()
    if (Number.isFinite(last) && (now.getTime() - last) / 1000 < 3600) {
      return { ok: true, skipped: 'recent', nodes: existing.filter((n) => n.status === 'predicted') }
    }
  }

  const ctx = projectionContext(vaultDir, now)
  const strat = strategyContext(vaultDir)
  const goals = goalsContext(vaultDir)
  const prof = operatorProfile(vaultDir)
  const lanesEnum = projectionLanes(vaultDir).map((L) => `"${L}"`).join('|')
  if (!ctx.trim() && !strat.trim()) return { ok: true, streams: [], empty: true }

  const decls = readAnchorDecls(vaultDir)
  const anchorMenu = decls
    .filter((d) => !d.confidential)
    .map((d) => `- ${d.id} · ${d.name} · ${d.date || 'undated'} · ${d.track || ''}`)
    .join('\n')

  const prompt = buildProjectionPrompt(prof, goals, strat, ctx, anchorMenu, lanesEnum, isoDate(now))
  const raw = await deps.generate(prompt)
  const gen = extractFirstJsonArray(raw) ?? []
  if (!gen.length) return { ok: false, error: 'no projection', streams: liveStreams(existing) }

  const taskCorpus = loadTaskCorpus(vaultDir)
  const declsById = new Map(decls.map((d) => [d.id, d]))
  const groundSteps = (nf: Record<string, unknown>): void => {
    const adecl = declsById.get(String(nf.anchor_id ?? '')) ?? null
    const steps = Array.isArray(nf.steps) ? (nf.steps as Step[]) : []
    for (const st of steps) resolveStepToTask(st, taskCorpus, adecl)
  }
  const uid = deps.uid ?? (() => randomUUID().replace(/-/g, '').slice(0, 8))
  const allnodes = reconcileProjection(existing, gen as Record<string, unknown>[], {
    now: () => now,
    uid,
    groundSteps,
    ontology: loadOntology(vaultDir)
  })
  if (!allnodes) return { ok: false, error: 'empty projection (kept existing)', streams: liveStreams(existing) }

  saveFutureNodes(vaultDir, allnodes)
  atomicWrite(metaPath(vaultDir), JSON.stringify({ last: localIsoSeconds(now), count: allnodes.length }))
  return { ok: true, generated: gen.length, streams: liveStreams(allnodes) }
}
