// Onboarding seed brain — turns a new user's first-run interview answers into a
// small causal graph so their Brain view isn't empty before they add notes.
// Deterministic + keyless (no LLM): work items → streams, the decision → a fork
// gate (with a decide-by so the prediction layer surfaces a real risk), worries
// → risk nodes — all building toward a "focus" anchor. Persisted in
// localStorage (the demo/preview fallback).
//
// REDIRECT (OKF Phase B): `brain.setSeed` was VESTIGIAL — the brain reads the
// fs-native substrate now, so a pushed in-memory seed never reached the graph.
// The live path is `scaffoldSeed()` → the `brain:scaffoldOkf` IPC, which
// MATERIALIZES the same interview answers (work→project, decision→decision,
// worry→risk) as TYPED concepts in `<vault>/.brain/memory/` — so they flow into
// the REAL first-run graph (deriveGraph / build-graph-native read those concepts
// when the notes index is empty). buildSeed/saveSeed survive for the localStorage
// preview + the existing unit tests.

import type { CausalNode, CausalEdge } from '@/components/brain/graph-types'

export interface InterviewAnswers {
  working: string
  deciding: string
  worried: string
}

export interface SeedGraph {
  nodes: CausalNode[]
  edges: CausalEdge[]
}

const SEED_KEY = 'brainframe.seed.v1'
const ONBOARD_KEY = 'brainframe.onboarded.v1'

/** Split a free-text answer into discrete items (newlines, commas, or semicolons). */
function items(text: string, max = 6): string[] {
  return text
    .split(/[\n;,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max)
}

function isoPlusDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Build the seed causal graph from interview answers. Empty answers → empty
 *  graph (caller treats that as "skip / no seed"). */
export function buildSeed(a: InterviewAnswers): SeedGraph {
  const work = items(a.working)
  const worries = items(a.worried)
  const decision = a.deciding.trim()
  if (work.length === 0 && worries.length === 0 && !decision) {
    return { nodes: [], edges: [] }
  }

  const nodes: CausalNode[] = []
  const edges: CausalEdge[] = []

  // The convergence anchor everything builds toward.
  const focusId = 'seed:focus'
  nodes.push({
    id: focusId,
    kind: 'anchor',
    label: 'My focus',
    track: 'focus',
    date: isoPlusDays(60),
    risk: 'amber'
  })

  // Work items → stream nodes building toward focus, spaced out in time.
  const workIds: string[] = []
  work.forEach((label, i) => {
    const id = `seed:work:${i}`
    workIds.push(id)
    nodes.push({ id, kind: 'stream', label, track: 'work', date: isoPlusDays(14 + i * 10) })
    edges.push({ source: id, target: focusId, type: 'builds_toward', lag_days: 46 - i * 10, confidence: 0.7 })
  })

  // The decision → a fork gate with a decide-by inside the prediction horizon,
  // so a decision-window risk surfaces immediately (shows the brain "thinking").
  if (decision) {
    const id = 'seed:decision'
    nodes.push({
      id,
      kind: 'gate',
      label: decision,
      track: 'decisions',
      date: isoPlusDays(14),
      decide_by: isoPlusDays(14),
      fork: { cleared: 'Proceed', blocked: 'Hold / rethink' }
    })
    edges.push({ source: id, target: focusId, type: 'gates', lag_days: 46, confidence: 0.6 })
  }

  // Worries → risk nodes that threaten the nearest work stream (else focus).
  worries.forEach((label, i) => {
    const id = `seed:risk:${i}`
    nodes.push({ id, kind: 'risk', label, track: 'risks', date: isoPlusDays(10 + i * 7), risk: 'amber' })
    const target = workIds[i % workIds.length] ?? focusId
    edges.push({ source: id, target, type: 'threatens', confidence: 0.45 })
  })

  return { nodes, edges }
}

// ── localStorage persistence (renderer-owned; re-pushed to main on boot) ──

export function saveSeed(graph: SeedGraph): void {
  try {
    localStorage.setItem(SEED_KEY, JSON.stringify(graph))
  } catch {
    /* storage unavailable — seed stays session-only via the IPC push */
  }
}

export function loadSeed(): SeedGraph | null {
  try {
    const raw = localStorage.getItem(SEED_KEY)
    if (!raw) return null
    const g = JSON.parse(raw) as SeedGraph
    return Array.isArray(g?.nodes) && Array.isArray(g?.edges) ? g : null
  } catch {
    return null
  }
}

export function isOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARD_KEY) === '1'
  } catch {
    return true // storage blocked → don't nag with onboarding
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARD_KEY, '1')
  } catch {
    /* ignore */
  }
}

/** Push a seed graph to the in-process brain. DEPRECATED — `setSeed` is vestigial
 *  (no longer feeds the fs-native graph). Kept no-op-safe for back-compat; use
 *  {@link scaffoldSeed} to materialize typed concepts into the real graph. */
export async function pushSeed(graph: SeedGraph): Promise<void> {
  try {
    await window.api.brain.setSeed(graph.nodes, graph.edges)
  } catch {
    /* brain not reachable — Brain view falls back to demo */
  }
}

/** Shape of the `brain:scaffoldOkf` result (defensively typed — the preload may
 *  expose the method after this module compiles). */
interface ScaffoldResult {
  success: boolean
  data?: { conceptsWritten?: number; conceptsIndexed?: number; indexPath?: string | null }
  error?: string
}
interface ScaffoldApi {
  scaffoldOkf?: (
    vaultDir: string,
    answers?: InterviewAnswers,
    overwrite?: boolean,
    reindexAfter?: boolean
  ) => Promise<ScaffoldResult>
}

/**
 * The LIVE redirect for the dead interview seed: materialize the interview answers
 * as TYPED OKF concepts in `<notesDir>/.brain/memory/` (work→project,
 * decision→decision, worry→risk) via the `brain:scaffoldOkf` IPC, so they flow
 * into the REAL first-run graph. Idempotent + no-clobber on the main side. No-op
 * safe: returns `{ ok:false }` when there's no vault or the API is absent.
 */
export async function scaffoldSeed(
  answers: InterviewAnswers,
  notesDir: string,
  reindexAfter = true
): Promise<{ ok: boolean; conceptsWritten: number }> {
  try {
    const brain = (window as unknown as { api?: { brain?: ScaffoldApi } }).api?.brain
    if (!brain?.scaffoldOkf || !notesDir) return { ok: false, conceptsWritten: 0 }
    const res = await brain.scaffoldOkf(notesDir, answers, false, reindexAfter)
    return { ok: !!res?.success, conceptsWritten: res?.data?.conceptsWritten ?? 0 }
  } catch {
    return { ok: false, conceptsWritten: 0 }
  }
}
