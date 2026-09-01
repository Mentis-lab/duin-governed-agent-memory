// brain-client — the SINGLE authoritative WRITE seam for TS-brain-owned derived state.
//
// See ../DUIN_BRAIN_WRITER_CONSOLIDATION_SPEC.md (M6). The in-process TS causal brain is the
// single authoritative writer of derived state (FUSION-DESIGN.md §"three layers"). Concepts it
// OWNS — owed/decision resolution, insight verdicts, prediction/calibration verdicts — MUST be
// written through here (the `window.api.brain.*` IPC), NOT via state.ts `fetch(BASE()/state/*)`,
// which reaches the Python sidecar with a DIFFERENT id-space. Reading a concept over one brain
// and writing it over the other is the recurring "read-brain ≠ write-brain" bug class
// (2026-06-30 ×3: owed Resolve 400, insight-verdict "not found", …).
//
// The guarantee: ids are BRANDED per concept, minted only at the matching read boundary. A
// read-id for one concept cannot be passed to another concept's writer — the compiler rejects it.
// Enforced by the eslint `no-cross-brain-write` guard (raw POST to an owned /state/* is banned).

// ADOPTION STATUS (verified 2026-07-30): this module currently has NO production consumer.
// `brain-client.ts` is imported by exactly one file — its own test — so all four writers below
// have zero callers, and every owned-concept write in the app still goes through the legacy
// /state/* fetches in duin/lib/state.ts that this client was built to replace.
//
// Kept deliberately, not deleted. The design is the sanctioned one (branded ids + a single
// bridge, guarded by the eslint rule above); what is missing is adoption. `coherence-map.ts`
// used to record this subsystem as LIVE with the gap "resolved", which made the gap invisible
// to the coherence check — that entry now reads DEAD / gap OPEN on the wiring axis. If you are adding an
// owned-concept write, route it through here rather than adding another raw fetch.
//
// ── Branded ids ──────────────────────────────────────────────────────────────
// A bare `string` is NOT assignable to these; mint via the constructors below, at the
// point you read the item, so the id that flows read → write is provably the right concept's.
export type OwedNodeId = string & { readonly __brand: 'OwedNodeId' }
export type InsightId = string & { readonly __brand: 'InsightId' }
export type PredictionId = string & { readonly __brand: 'PredictionId' }

/** Mint an owed/decision-loop node id (from `brain.decisionLoop()` items). */
export const asOwedNodeId = (id: string): OwedNodeId => id as OwedNodeId
/** Mint an insight id (from `brain.insights()` items). */
export const asInsightId = (id: string): InsightId => id as InsightId
/** Mint a logged-prediction id (from `brain.calibration()` / predicted-risks items). */
export const asPredictionId = (id: string): PredictionId => id as PredictionId

// ── Concept vocabularies (mirror the IPC contract in electron/preload.ts) ─────
/** 5-outcome decision taxonomy (electron/services/brain/types.ts `DecisionOutcome`). */
export type DecisionOutcome = 'cleared' | 'blocked' | 'done' | 'dismissed' | 'cancelled'
export type InsightVerdict = 'useful' | 'dismissed' | 'acted' | 'inaccurate'
/** Prediction outcome (TS calibration ledger vocab). NOTE: state.ts `recordVerdict` still uses the
 *  legacy python `right|wrong|partial|unobserved` vocab — the two-ledger reconciliation is M6.1. */
export type PredictionOutcome = 'happened' | 'averted' | 'false_alarm' | 'unobserved'

export type WriteResult = { ok: boolean; error?: string }

/** Thrown when the brain IPC bridge is absent (e.g. a web/tunnel context without preload).
 *  Owned-concept writes are Electron-only by design; callers surface this instead of silently
 *  falling back to the wrong brain. Web-target parity is a tracked M6 follow-up. */
export class BrainUnavailableError extends Error {
  constructor() {
    super('brain IPC bridge unavailable (owned-concept writes require the Electron preload)')
    this.name = 'BrainUnavailableError'
  }
}

// Minimal structural view of the preload `window.api.brain` write surface we depend on.
type BrainWriteBridge = {
  recordDecision: (nodeId: string, choice: DecisionOutcome, note?: string) => Promise<{ success: boolean; error?: string }>
  insightVerdict: (id: string, verdict: InsightVerdict) => Promise<{ success: boolean; error?: string }>
  recordVerdict: (predictionId: string, outcome: PredictionOutcome, note?: string) => Promise<{ success: boolean; error?: string }>
}

function bridge(): BrainWriteBridge {
  const api = typeof window !== 'undefined' ? (window as unknown as { api?: { brain?: BrainWriteBridge } }).api : undefined
  const b = api?.brain
  if (!b) throw new BrainUnavailableError()
  return b
}

function normalize(r: { success: boolean; error?: string }): WriteResult {
  return r.success ? { ok: true } : { ok: false, error: r.error ?? 'brain write failed' }
}

// ── Authoritative writers (the only sanctioned path for these concepts) ───────

/** Resolve an owed/decision-loop node with a 5-outcome call. Replaces the wrong-brain
 *  `resolveNode(id,'resolve')` → `/state/resolve-node` path that 400'd (the 2026-06-30 bug). */
export async function resolveOwed(nodeId: OwedNodeId, choice: DecisionOutcome, note?: string): Promise<WriteResult> {
  return normalize(await bridge().recordDecision(nodeId, choice, note))
}

/** Record a verdict on a cross-cutting insight. Replaces `postInsightVerdict` → `/state/insight-verdict`. */
export async function recordInsightVerdict(id: InsightId, verdict: InsightVerdict): Promise<WriteResult> {
  return normalize(await bridge().insightVerdict(id, verdict))
}

/** Record a verdict on a logged prediction (foresight calibration). Replaces the python
 *  `recordVerdict` → `/state/verdict` path (different id-space + vocab). */
export async function recordPredictionVerdict(id: PredictionId, outcome: PredictionOutcome, note?: string): Promise<WriteResult> {
  return normalize(await bridge().recordVerdict(id, outcome, note))
}

/** True when owned-concept writes are available (Electron preload present). */
export function brainWritesAvailable(): boolean {
  try {
    bridge()
    return true
  } catch {
    return false
  }
}
