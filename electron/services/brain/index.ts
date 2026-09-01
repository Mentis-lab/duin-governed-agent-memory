// Brain — in-process cognition module (Phase A: causal graph + propagation).
//
// The single home for DUIN's ported engines. A module-level Store backs the
// engines; swap it (notes-derived, then SQLite) in later phases without
// touching callers. Consumed two ways, both thin wrappers over the same
// functions: the local-brain HTTP server (/state/* — curl-debuggable + keeps
// the AG-UI surface so an external governed brain can still be swapped in) and
// IPC fast-path handlers (no serialization tax) for the renderer.

import type { CausalGraph, PropagationResult, PredictedRisk, CausalNode, CausalEdge } from './types'
import { setNotesExtraction } from './notes-store'
import { extractTemporal } from './notes-extract'
import { constructBrain, type ConstructResult } from './construct'
import { BrowserWindow } from 'electron'
import { routeModel } from '../providers/registry'
import { propagateGraph } from './causal-engine'
import { substrateCausalGraph } from './causal-substrate'
import { type WorldState } from './world-state'
import { insightsFromVault, insightsFromVaultWithGenerative } from './insights'
import { worldState as worldStateNative } from './world-state-native'
import { predictedRisks as predictedRisksNative } from './predicted-risks-native'
import type { OpenLoop } from './types'
import { derivePeople } from './derive-knowledge'
import { autoVerdict } from './calibration'
import { empiricalRateForKind } from './calibration-weight'
import { forecastRecord } from './forecast-record-native'
import { calibration as nativeCalibration } from './calibration-native'
import { buildHomeDigest, featureOf, type HomeDigest } from './home-digest'
import { peopleOwed } from './people-owed-native'
import * as brainDb from './brain-db'
import { isSubstantiveOutcome } from './types'
import type {
  Insight,
  MadeDecision,
  DecisionLoop,
  CalibrationReport,
  CalibrationBucket,
  VerdictOutcome,
  DecisionOutcome
} from './types'

// Onboarding seed — VESTIGIAL. The interview-derived seed was read by the retired in-memory Store;
// the brain now reads the fs-native Stack-B substrate, so a seed no longer feeds the graph. The
// setter/getter are kept as harmless no-ops so the onboarding IPC + renderer push don't break.
let seedData: { nodes: CausalNode[]; edges: CausalEdge[] } | null = null

/** Set (or clear) the onboarding seed. Vestigial — no longer feeds the Stack-B brain. */
export function setBrainSeed(nodes: CausalNode[] | null, edges: CausalEdge[] | null): void {
  seedData = nodes && nodes.length ? { nodes, edges: edges ?? [] } : null
}

export function hasSeed(): boolean {
  return seedData !== null
}

/** Run the (key-gated) notes-extraction pass and cache the result so the
 *  NotesStore enriches the structural graph with temporal data. Returns true if
 *  extraction produced data (a provider key was configured). Best-effort. */
export async function refreshNotesExtraction(): Promise<boolean> {
  try {
    const ex = await extractTemporal()
    setNotesExtraction(ex)
    return ex != null
  } catch (err) {
    console.warn('[brain] refreshNotesExtraction failed:', (err as Error)?.message)
    return false
  }
}

/** "Build my brain" — run the (key-gated) construction pass over the raw notes,
 *  caching the inferred entities/edges/classifications so the graph + panels
 *  read them without re-running the LLM. Returns a small summary, or a no-model
 *  status when key-gated off (structural-only). Best-effort: any failure →
 *  no-model. */
/** Renderer signal for the (invisible, multi-minute) entity-graph build. The onboarding "ready"
 *  step + any live Brain view subscribe via preload `brain.onBuild` so the construction pass is
 *  legible instead of running silently after indexing shows "ready". */
export interface BrainBuildEvent {
  phase: 'started' | 'done'
  status?: ConstructResult['status']
  entities?: number
  edges?: number
}

function emitBuild(evt: BrainBuildEvent): void {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('brain:build', evt)
    }
  } catch {
    /* no windows yet (very early boot) — best-effort progress signal */
  }
}

// ── Extraction failure breaker ──────────────────────────────────────────────
// QA 2026-08-24 (F3): with a drained provider account, the notes-watcher re-ran the key-gated
// construction every CONSTRUCT_MIN_GAP_MS forever — 705 consecutive quota failures ledgered over
// ~2 weeks, each one a full batch of doomed paid-API calls, and none of it surfaced to the
// operator. Three consecutive model-error builds now OPEN this breaker: background builds skip
// the LLM pass (structural indexing is untouched; the previous construction cache stands) until
// an operator-shaped event closes it — a provider key is saved, an explicit Rebuild/Build runs,
// or the app restarts. Opening it files ONE deduped jobFail notice so "Needs you" says what broke.
const EXTRACTION_BREAKER_THRESHOLD = 3
let modelErrorStreak = 0
let extractionBreakerOpen = false

/** Close the breaker on operator intent (key saved, explicit rebuild). Safe to call anytime. */
export function resetExtractionBreaker(reason: string): void {
  if (extractionBreakerOpen) console.warn(`[brain] extraction breaker closed (${reason})`)
  modelErrorStreak = 0
  extractionBreakerOpen = false
}

export function extractionBreakerIsOpen(): boolean {
  return extractionBreakerOpen
}

/** Did this build fail in the way the breaker exists to stop — doomed PAID calls that cannot
 *  succeed until the operator acts? 'model-error' means every batch failed. But a run where
 *  most batches died on quota reports 'built', so the breaker never saw the exact outage it was
 *  written for: 738 quota-dropped batches accrued while every build looked successful. A
 *  majority of batches lost to quota is the same outage, just partially served. */
export function isProviderStarvedBuild(result: Pick<ConstructResult, 'providerDropped' | 'totalBatches'>): boolean {
  const dropped = result.providerDropped ?? 0
  const total = result.totalBatches ?? 0
  return total > 0 && dropped > total / 2
}

function noteBuildOutcome(status: ConstructResult['status'], detail?: string): void {
  if (status === 'model-error') {
    modelErrorStreak++
    if (!extractionBreakerOpen && modelErrorStreak >= EXTRACTION_BREAKER_THRESHOLD) {
      extractionBreakerOpen = true
      console.warn(
        `[brain] extraction breaker OPEN after ${modelErrorStreak} consecutive model-error builds — background builds paused`
      )
      // jobFail watcher (deduped per id): the one channel that reaches "Needs you".
      void import('../proactive/watchers')
        .then(({ watchJobFailed }) =>
          watchJobFailed({
            automationId: 'brain-extraction',
            label: 'Brain extraction',
            error:
              detail ||
              'the extraction model keeps failing — check the provider balance/quota in Settings → API Keys. Background builds are paused until a key is saved or you run Rebuild.'
          })
        )
        .catch(() => {
          /* notices are advisory — never let telemetry break a build path */
        })
    }
  } else if (status === 'built' || status === 'kept-cache') {
    modelErrorStreak = 0
    if (extractionBreakerOpen) resetExtractionBreaker('a build succeeded')
  }
}

// Concurrent-build coalescing. Four independent triggers share this function — boot
// (server.ts), the settings:set auto-reindex AND the renderer's explicit reindex (which
// the onboarding folder pick fires back-to-back), the notes-watcher, and the post-key
// build — and constructBrain running twice concurrently is exactly the "two LLM passes
// race … auto-build silently produced nothing" failure settings.ts documents, plus a
// doubled LLM bill and interleaved brain:build started/done pairs in the renderer.
// A second call while one is in flight JOINS it instead of racing it.
let buildInFlight: Promise<ConstructResult> | null = null

export function buildBrain(): Promise<ConstructResult> {
  if (buildInFlight) return buildInFlight
  if (extractionBreakerOpen) {
    // The previous construction cache still stands — that is exactly what 'kept-cache' means.
    return Promise.resolve({ entities: 0, edges: 0, status: 'kept-cache' })
  }
  buildInFlight = buildBrainImpl().finally(() => {
    buildInFlight = null
  })
  return buildInFlight
}

/** Single-flight wrapper for the whole key-gated extraction→construction tail
 *  (refreshNotesExtraction → buildBrain), with ONE queued re-run when a call
 *  lands mid-flight — so the newest trigger's content still gets a pass without
 *  N callers stacking N passes. All background build tails route through here. */
let tailInFlight: Promise<ConstructResult> | null = null
let tailQueued = false
export function runExtractionAndBuild(): Promise<ConstructResult> {
  if (tailInFlight) {
    tailQueued = true
    return tailInFlight
  }
  if (extractionBreakerOpen) {
    return Promise.resolve({ entities: 0, edges: 0, status: 'kept-cache' })
  }
  tailInFlight = (async () => {
    let result: ConstructResult
    do {
      tailQueued = false
      await refreshNotesExtraction().catch((e) =>
        console.warn('[brain] notes extraction failed:', (e as Error)?.message)
      )
      result = await buildBrain()
    } while (tailQueued)
    return result
  })().finally(() => {
    tailInFlight = null
  })
  return tailInFlight
}

async function buildBrainImpl(): Promise<ConstructResult> {
  // Only show the "building…" spinner when a model will actually run the construction (a BYO key OR a
  // local Ollama) — otherwise the pass is a structural no-op and the no-model banner is the right cue.
  const hasModel = (() => {
    try { return routeModel('extraction') !== null } catch { return false }
  })()
  try {
    if (hasModel) emitBuild({ phase: 'started' })
    const result = await constructBrain()
    const status: ConstructResult['status'] = result?.status ?? 'no-model'
    if (!result || status === 'no-model') {
      maybeNotifyNeedsExtractionKey()
      // Always emit done (even without a model) so the renderer can resolve the indicator AND surface
      // the prominent "connect a model to build the graph" state, not just the once-per-session toast.
      emitBuild({ phase: 'done', status: 'no-model', entities: 0, edges: 0 })
      return result ?? { entities: 0, edges: 0, status: 'no-model' }
    }
    emitBuild({ phase: 'done', status, entities: result.entities, edges: result.edges })
    // A majority-quota-starved run counts as a model error FOR THE BREAKER only: the build's own
    // status stays honest ('built' — a partial graph really was written and persisted).
    if (status === 'built' && isProviderStarvedBuild(result)) {
      console.warn(
        `[brain] ${result.providerDropped}/${result.totalBatches} extraction batch(es) lost to provider quota - counting this build as a model error for the breaker`
      )
      noteBuildOutcome(
        'model-error',
        `${result.providerDropped} of ${result.totalBatches} extraction batches were refused for quota/billing - check the provider balance in Settings > API Keys.`
      )
    } else {
      noteBuildOutcome(status)
    }
    return result
  } catch (err) {
    console.warn('[brain] buildBrain failed:', (err as Error)?.message)
    emitBuild({ phase: 'done', status: 'model-error', entities: 0, edges: 0 })
    noteBuildOutcome('model-error', (err as Error)?.message)
    // 'model-error', matching what we just emitted to the renderer. This returned 'no-model' — so
    // the function DISAGREED WITH ITSELF: the event said the provider failed while the return value
    // said none was configured. The consequence reached the user, because BrainSettings maps
    // 'no-model' to "Connect an AI model in API Keys" — telling them to connect the model they
    // already have, for a build that crashed. A thrown build is not an absent model.
    return { entities: 0, edges: 0, status: 'model-error' }
  }
}

let notifiedNeedsKey = false
/** Cold-start signal: construction found no callable extraction model (no API key for any
 *  extraction-capable provider). Warns once per session AND pushes a renderer toast prompting the
 *  user to add a key. Only fires when `routeModel('extraction')` is genuinely null — a present-but-
 *  failing model (rate limit / balance) is a different situation and stays quiet here. */
function maybeNotifyNeedsExtractionKey(): void {
  if (notifiedNeedsKey) return
  if (routeModel('extraction') !== null) return
  notifiedNeedsKey = true
  const message = 'Add an API key in Settings → API Keys so DUIN can build the entity graph from your notes.'
  console.warn('[brain] no extraction model configured —', message)
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('brain:needs-key', { message })
    }
  } catch {
    /* no windows yet (very early boot) — the Brain settings panel's hasModel flag still covers it */
  }
}

// Made-decisions register. In-memory for now (persists for the app session);
// moves to the SQLite store in a later phase — the single writer of the loop's
// `made` side, keyed by node so a re-decide replaces the prior call. Capped so
// a pathological session can't grow it unbounded.
const MAX_DECISIONS = 10_000
let madeDecisions: MadeDecision[] = []

// Insight verdicts register. The verdict the user records on a cross-cutting
// insight (useful / dismissed / acted / inaccurate), keyed by insight id. Same
// in-process brain that getInsights() reads, so the verdict matches the
// insights shown (the read-brain == write-brain fix). In-memory for now (mirrors
// the madeDecisions module pattern); persists for the app session.
type InsightVerdict = 'useful' | 'dismissed' | 'acted' | 'inaccurate'
const insightVerdicts = new Map<string, InsightVerdict>()

// Durable persistence (SQLite) is OFF by default so unit tests run purely
// in-memory; main enables it at boot via enableBrainPersistence(), which also
// hydrates the made-decisions register from the DB.
let persistenceEnabled = false

export function enableBrainPersistence(): void {
  persistenceEnabled = true
  const rows = brainDb.loadDecisions()
  if (rows) madeDecisions = rows.slice(0, MAX_DECISIONS)
}

export function getCausalGraph(vaultDir: string | null = null): CausalGraph {
  // Demo provenance died with the demo vault (removed 2026-08-22): every causal graph is
  // operator state now, so no `demo` marker is stamped and no renderer reads one.
  return substrateCausalGraph(vaultDir)
}

export function runPropagate(vaultDir: string | null, nodeId = '', shiftDays = 0, decision = ''): PropagationResult {
  // Two-brain fuse: propagate over the SAME fs-native Stack-B substrate graph the UI renders
  // (`/state/causal-graph`), not the in-memory Stack-A store. A/B-verified — Stack A produced 0
  // (empty in-memory store); Stack B produces real slippage over the vault's release milestones.
  // vaultDir passed by the caller (server/IPC) to avoid a settings-helper import cycle here.
  return propagateGraph(substrateCausalGraph(vaultDir), nodeId, shiftDays, decision)
}

export function getPredictedRisks(vaultDir: string | null = null): { risks: PredictedRisk[] } {
  // Stack-B: foreseen risks off the fs-native substrate (same PredictedRisk[] shape). Keeps the
  // append-once log into the calibration ledger so foresight accrues a track record over time.
  const result = predictedRisksNative(vaultDir)
  const risks = result.risks as unknown as PredictedRisk[]
  if (persistenceEnabled) brainDb.logPredictions(risks)
  return { risks }
}

export function getWorldState(vaultDir: string | null = null): WorldState {
  // Stack-B: per-track world rollup off the fs-native substrate (the ActiveWorkPanel reads .tracks
  // dynamically; the preload contract is `unknown`, so the native shape flows through).
  return worldStateNative(vaultDir) as unknown as WorldState
}

// An Insight annotated with the user's stored verdict (if any). The base
// Insight type is shared/closed (types.ts), so the verdict rides as a widened
// field on the returned shape rather than a schema change.
type VerdictedInsight = Insight & { verdict?: InsightVerdict }

export function getInsights(vaultDir: string | null = null): { insights: VerdictedInsight[] } {
  // Stack-B: analytical insights over the fs-native substrate (same data the UI renders), with the
  // user's verdict layer preserved. vaultDir passed by the caller (IPC/HTTP).
  const out: VerdictedInsight[] = []
  for (const i of insightsFromVault(vaultDir).insights) {
    const v = insightVerdicts.get(i.id)
    // Dismiss/inaccurate visibly remove the insight; useful/acted annotate it so
    // the UI can show the saved state.
    if (v === 'dismissed' || v === 'inaccurate') continue
    out.push(v ? { ...i, verdict: v } : i)
  }
  return { insights: out }
}

/** Record the user's verdict on a cross-cutting insight (same in-process brain
 *  getInsights() reads, so the id always matches what the panel showed).
 *  In-memory for the session — best-effort, mirrors the madeDecisions pattern. */
export function recordInsightVerdict(id: string, verdict: InsightVerdict): void {
  if (!id) return
  insightVerdicts.set(id, verdict)
  // Persist per-feature so the Home Digest Affinity term accrues across sessions
  // (the in-memory map above is session-only; this is the durable moat signal).
  if (persistenceEnabled) brainDb.saveInsightVerdict(id, featureOf(id), verdict)
}

/** Test/reset hook — clears the in-memory insight-verdict register. */
export function __resetInsightVerdicts(): void {
  insightVerdicts.clear()
}

// Analytical + GENERATIVE insights. Async: runs the key-gated LLM pass on top of
// the instant analytical set, degrading to analytical-only when no model is
// configured. getInsights() above stays the synchronous instant path so the
// panel renders immediately; this enriches it when the user has a model.
export async function getGenerativeInsights(vaultDir: string | null = null): Promise<{ insights: VerdictedInsight[] }> {
  const { insights: merged } = await insightsFromVaultWithGenerative(vaultDir)
  const out: VerdictedInsight[] = []
  for (const i of merged) {
    const v = insightVerdicts.get(i.id)
    if (v === 'dismissed' || v === 'inaccurate') continue
    out.push(v ? { ...i, verdict: v } : i)
  }
  return { insights: out }
}

// getMeetings / getOutputs / getMentalModels were RETIRED 2026-08-04 along with the Explorer
// lenses they fed — see derive-knowledge.ts for why the classification was not trustworthy.
// getPeople stays: it reads constructed `person:*` graph nodes, not an LLM's opinion of prose.
export function getPeople(): ReturnType<typeof derivePeople> {
  return derivePeople()
}

export function getDecisionLoop(vaultDir: string | null = null): DecisionLoop {
  // Stack-B: open decision-loops (owed/risk) derived from the fs-native substrate graph + prediction
  // layer (openLoopsFromVault), minus the calls already recorded. NB the Stack-B decision-loop-native
  // is a DIFFERENT concept (learning-loop viz), so it can't serve this — hence the direct derivation.
  const decided = new Set(madeDecisions.map((m) => m.node_id))
  const open = openLoopsFromVault(substrateCausalGraph(vaultDir), vaultDir).filter(
    (o) => !(o.node_id && decided.has(o.node_id))
  )
  return {
    open,
    made: madeDecisions,
    counts: {
      owed: open.filter((o) => o.kind === 'owed').length,
      risks: open.filter((o) => o.kind === 'risk').length,
      problems: open.filter((o) => o.kind === 'problem').length,
      made: madeDecisions.length
    }
  }
}

export function recordDecision(
  nodeId: string,
  choice: DecisionOutcome,
  note?: string,
  vaultDir: string | null = null
): DecisionLoop {
  // Stack-B: look up the node label from the fs-native substrate graph (not the retired store).
  const node = substrateCausalGraph(vaultDir).nodes.find((n) => n.id === nodeId)
  const entry: MadeDecision = {
    id: `dec::${nodeId}`,
    node_id: nodeId,
    title: node?.label ?? nodeId,
    choice,
    note,
    decided_at: new Date().toISOString()
  }
  madeDecisions = [entry, ...madeDecisions.filter((m) => m.node_id !== nodeId)].slice(0, MAX_DECISIONS)
  if (persistenceEnabled) brainDb.saveDecision(entry)
  return getDecisionLoop(vaultDir)
}

/** The digest's "needs you" open-loops, re-derived from the fs-native Stack-B graph + prediction
 *  layer (mirrors the Stack-A decision-loop.open: owed = decision/gate/fork nodes; risk = foreseen).
 *  The Stack-B `decision-loop-native` is a DIFFERENT concept (learning-loop viz), so it can't serve
 *  this — hence the direct derivation. */
function openLoopsFromVault(graph: CausalGraph, vaultDir: string | null): OpenLoop[] {
  const loops: OpenLoop[] = []
  for (const n of graph.nodes) {
    const needsCall = !!n.fork || (n.kind === 'gate' && !!n.decide_by) || n.kind === 'decision'
    if (!needsCall) continue
    loops.push({
      id: `owed::${n.id}`,
      kind: 'owed',
      title: n.label,
      detail: n.fork ? `cleared: ${n.fork.cleared} · blocked: ${n.fork.blocked}` : undefined,
      due: n.decide_by,
      node_id: n.id,
      fork: n.fork ?? null,
      track: n.track
    })
  }
  for (const r of predictedRisksNative(vaultDir).risks as { id: string; title: string; reason?: string; due?: string; subjects?: string[]; confidence?: number; track?: string }[]) {
    loops.push({
      id: `risk::${r.id}`,
      kind: 'risk',
      title: r.title,
      detail: r.reason,
      due: r.due,
      node_id: r.subjects?.[0],
      confidence: r.confidence,
      track: r.track
    })
  }
  return loops
}

// The right-panel "Today" home. Composes the fs-native Stack-B readers (the SAME data the UI
// renders) and ranks them into one triaged digest. See home-digest.ts for the scoring model.
/**
 * Keyless-answer insight inputs: the causal graph + open decision loops, computed
 * from the fs-native substrate (same source as getHomeDigest). Lets the deterministic
 * `computeFirstInsight` surface its richest tiers (overdue owed decision, most-connected
 * note / orphan hub) on the keyless default path, not just the world-track rollup.
 */
export function getKeylessInsightInputs(
  vaultDir: string | null = null
): { graph: CausalGraph; openLoops: OpenLoop[] } {
  const graph = substrateCausalGraph(vaultDir)
  return { graph, openLoops: openLoopsFromVault(graph, vaultDir) }
}

export function getHomeDigest(vaultDir: string | null = null): HomeDigest {
  // Two-brain fuse: compose the digest from the fs-native Stack-B readers (the SAME data the UI
  // renders), not the empty in-memory Stack-A store. All four read the vault dir the caller passes.
  const graph = substrateCausalGraph(vaultDir)
  const today = new Date().toISOString().slice(0, 10)
  const insightList = insightsFromVault(vaultDir).insights
  // Salience attention state (Novelty first-seen + Decay impressions); null → neutral modulators.
  const salience = persistenceEnabled ? brainDb.loadInsightSalience() : null
  const digest = buildHomeDigest({
    insights: insightList,
    openLoops: openLoopsFromVault(graph, vaultDir),
    graph,
    calibration: getCalibration(vaultDir),
    today,
    // Person-owed follow-ups (Needs You) read straight from the vault tasks;
    // affinity is the persisted per-feature useful-rate (neutral until it fills).
    owedPeople: vaultDir ? peopleOwed(vaultDir) : [],
    affinity: persistenceEnabled ? (brainDb.loadInsightAffinity() ?? {}) : {},
    firstSeen: salience?.firstSeen,
    impressions: salience?.impressions,
    // Active work-tracks power "Jump back in".
    tracks: (worldStateNative(vaultDir).tracks as unknown as { key: string; label: string; open: number; due_soon: number; risks: number; status: string }[]).map((t) => ({
      key: t.key,
      label: t.label,
      open: t.open,
      due_soon: t.due_soon,
      risks: t.risks,
      status: t.status
    }))
  })
  // Record salience sightings AFTER ranking: stamp first-seen for every CANDIDATE insight (the
  // Novelty age clock), bump the per-day impression for the ones actually SURFACED (Decay
  // anti-nag). Best-effort + idempotent per day, so frequent panel reads can't inflate it.
  if (persistenceEnabled) {
    brainDb.recordInsightSalience(
      insightList.map((i) => i.id),
      digest.insights.map((i) => i.id),
      today
    )
  }
  return digest
}

/**
 * Item 1 (calibration unification, 2026-07-07) — the CANONICAL calibration surface.
 *
 * Adapter that projects the ONE scored ledger (`forecast-track-record.json`, the
 * same source `loadKindRates` + the HTTP `/state/calibration` panel read) onto the
 * `CalibrationReport` shape the in-process consumers (Home digest, capability-gap)
 * want. Retires the SQLite Stack-A `computeCalibration` count — the three surfaces
 * now agree on source (two projections: per-kind `hit_rate` here + for chat; a
 * domain rollup for the panel).
 *
 * Load-bearing: the per-kind `hit_rate` field here is the SAME `rate` `loadKindRates`
 * exposes — both call `empiricalRateForKind` (the single source of truth) so the display
 * and the feedback/ranking wire can never disagree (the E1 parity invariant). That helper
 * selects per framing: signal → efficacy_rate; COUPLING (driver/convergence/cascade) →
 * useful_rate (their averted = confirmed co-movement, refuted = falsified; materialized
 * never fires); other forecast kinds → hit_rate. Keep this projection routed THROUGH the
 * helper — do not re-inline a raw `hit_rate` pick, which drifts from the wire.
 */
export function getCalibration(vaultDir: string | null = null): CalibrationReport {
  const patterns = (forecastRecord(vaultDir).patterns ?? {}) as Record<string, Record<string, unknown>>
  const buckets: CalibrationBucket[] = []
  let heeded = 0
  let resolvedAll = 0
  for (const [kind, p] of Object.entries(patterns)) {
    const materialized = Number(p.materialized ?? 0)
    const averted = Number(p.averted ?? 0)
    const refuted = Number(p.refuted ?? 0)
    const unobserved = Number(p.unobserved ?? 0)
    const resolved = materialized + averted + refuted
    // Per-kind rate == loadKindRates' `rate` (both off forecast-track-record.json) via the
    // shared empiricalRateForKind selector: signal → efficacy_rate, coupling → useful_rate,
    // else → hit_rate. Routing both through the one helper keeps the E1 parity by construction.
    const rate = empiricalRateForKind(kind, p)
    buckets.push({
      kind,
      total: Number(p.fired ?? resolved + unobserved),
      // happened == materialized (the foresight occurred); refuted maps to false_alarm.
      happened: materialized,
      averted,
      false_alarm: refuted,
      unobserved,
      resolved,
      hit_rate: typeof rate === 'number' ? rate : null
    })
    heeded += materialized
    resolvedAll += resolved
  }
  buckets.sort((a, b) => b.total - a.total)

  // Totals from the federated native scorecard (E1: `+ calibration(vaultDir).totals`).
  // Overall hit_rate stays consistent with the per-kind north-star (materialized/resolved).
  const totals = nativeCalibration(vaultDir).totals
  return {
    buckets,
    totals: {
      logged: totals.predictions,
      resolved: totals.resolved,
      hit_rate: resolvedAll > 0 ? heeded / resolvedAll : null
    },
    // `recent` fed the retired Stack-A verdict UI (preload bridge now @deprecated,
    // zero renderer callers); the live consumers read buckets/totals only.
    recent: []
  }
}

/** Apply keyless auto-resolution: mark each unresolved (or previously-auto)
 *  prediction with the verdict its signals imply (a recorded decision, a passed
 *  decide-by). Human verdicts are never overridden. Best-effort.
 *  NOTE (Item 1, 2026-07-07): now UNWIRED from getCalibration — the canonical
 *  ledger (forecast-track-record.json) is resolved by the TS forecastTick loop, not
 *  this SQLite Stack-A path. Retained with recordVerdict for the (deprecated) manual
 *  Stack-A verdict IPC; delete when that bridge is removed. */
function autoResolvePredictions(): void {
  try {
    const rows = brainDb.loadPredictionsForResolve()
    if (!rows) return
    // Substantive calls (cleared/blocked/done) → 'averted'; non-substantive
    // (dismissed/cancelled) → 'unobserved' (left owed, excluded from hit-rate).
    const decisions = brainDb.loadDecisions() ?? []
    const decided = new Set(
      decisions.filter((d) => isSubstantiveOutcome(d.choice)).map((d) => d.node_id)
    )
    const neutral = new Set(
      decisions.filter((d) => !isSubstantiveOutcome(d.choice)).map((d) => d.node_id)
    )
    const today = new Date().toISOString().slice(0, 10)
    for (const p of rows) {
      if (p.manual) continue
      const v = autoVerdict(p, decided, today, neutral)
      if (v && v !== p.outcome) brainDb.recordVerdict(p.id, v, `auto: ${p.kind}`)
    }
  } catch (err) {
    console.warn('[brain] autoResolvePredictions failed:', (err as Error)?.message)
  }
}

export function recordVerdict(
  predictionId: string,
  outcome: VerdictOutcome,
  note?: string
): CalibrationReport {
  // Stack-A manual-verdict path (SQLite). Post-Item-1 getCalibration reads the
  // canonical native ledger, so this write no longer feeds the returned report; the
  // auto-resolve pass is kept reachable here for the (deprecated) Stack-A IPC.
  if (persistenceEnabled) {
    brainDb.recordVerdict(predictionId, outcome, note)
    autoResolvePredictions()
  }
  return getCalibration()
}

/** Test/reset hook — clears the in-memory made-decisions register. */
export function __resetDecisions(): void {
  madeDecisions = []
}

export type {
  CausalGraph,
  PropagationResult,
  PredictedRisk,
  Insight,
  DecisionLoop,
  OpenLoop,
  MadeDecision,
  DecisionOutcome,
  CalibrationReport,
  CalibrationBucket,
  LoggedPrediction,
  VerdictOutcome
} from './types'
export type { WorldState, WorldTrack } from './world-state'
