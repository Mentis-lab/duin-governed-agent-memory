// Brain-graph data contract. A generic, product-agnostic causal field: every
// node is first-class (anchor · driver · stream · gate · risk · dependency ·
// resource) and points to others, anchored in TIME (x) and LANES (y: track).
// Ported from the DUIN dashboard's CausalGraphView but with NO product-specific
// content — the shape below is the only thing the renderer depends on, so any
// source (bundled demo or a live URL) that emits this JSON works.

// NOTE: keep in lockstep with electron/services/brain/types.ts (the engine
// contract). Drift here silently desyncs the renderer from the engine.
export type CausalKind =
  | 'anchor'
  | 'driver'
  | 'stream'
  | 'gate'
  | 'risk'
  | 'dependency'
  | 'resource'
  | 'outcome'
  | 'step'
  // Richer kinds the live governed brain emits (decision/milestone/release/event).
  // Mapped to colors+sizing in the renderer; kept here so the engine contract in
  // electron/services/brain/types.ts stays in lockstep (the renderer's KIND_COLOR /
  // nodeRadius already branch on these).
  | 'decision'
  | 'milestone'
  | 'release'
  | 'event'
  // A built, viewable page surface (HTML docs). Lockstep with graph-derive.ts
  // + electron/services/brain/types.ts; coloured in KIND_COLOR below.
  | 'page'
  // Additive graph-unification kinds (Phase 0) — lockstep with graph-derive.ts
  // + electron/services/brain/types.ts; coloured in graph-schemes.ts.
  | 'product'
  | 'place'

export type RiskLevel = 'red' | 'amber' | 'green'

export interface CausalNode {
  id: string
  kind: CausalKind
  label: string
  /** Lane the node sits in (free-form; the loader derives the visible lanes). */
  track?: string
  /** ISO date — pins the node on the time (x) axis when present. */
  date?: string
  risk?: RiskLevel
  /** Inbound edge count — inflates the node radius. */
  in_degree?: number
  /** in_degree >= 2 — a convergence point (set by the causal engine). */
  converges?: boolean
  decide_by?: string
  decision_id?: string
  fork?: { cleared: string; blocked: string } | null
  steps?: { event: string; when: string; done: boolean }[]
  /** Slack in days (negative = overdue) — drives live-slippage propagation. */
  slack?: number | null
}

export interface CausalEdge {
  source: string
  target: string
  type: string
  lag_days?: number | null
  polarity?: '+' | '-'
  /** 0..1 — edges below 0.55 render dashed (unvalidated). */
  confidence?: number
  branch?: boolean
  evidence?: string
}

export interface CausalGraph {
  nodes: CausalNode[]
  edges: CausalEdge[]
  anchor?: string | null
  /** ISO date treated as "now" on the time axis. Defaults to today. */
  today?: string
  stats?: { nodes: number; edges: number; converge_nodes?: number }
  /** True when this is the bundled demo brain (no notes indexed). */
  demo?: boolean
}

// Propagation (what-if) result — mirrors the main-process brain engine
// (electron/services/brain/types.ts). A slip/decision flows along causal edges;
// `affected` is the prediction stream the renderer highlights.
export interface PropagationAffected {
  id: string
  label: string
  kind: string
  shift_days?: number
  branch?: 'activated' | 'pruned'
}

export interface PropagationResult {
  origin: string
  shift_days: number
  decision: string | null
  affected: PropagationAffected[]
  count: number
  note: string
}

// Predicted leading-indicator risk — mirrors the brain engine
// (electron/services/brain/types.ts PredictedRisk).
export interface PredictedRisk {
  id: string
  kind: 'deadline-collision' | 'decision-window'
  title: string
  detail?: string
  due: string
  leading_indicator: string
  subjects: string[]
  confidence: number
  track?: string
  reason: string
  suggested_action?: SuggestedAction
}

export interface SuggestedAction {
  prompt: string
  delay_seconds: number
  reason: string
}

// Per-track situation — mirrors the brain engine (world-state.ts).
export interface WorldEvent {
  date: string
  label: string
  kind: 'milestone' | 'risk' | 'deadline'
  confidence: number
}

export interface WorldTrack {
  key: string
  label: string
  open: number
  due_soon: number
  next_due: string | null
  risks: number
  top_risk: string | null
  risk_list: string[]
  drivers: string[]
  status: string
  events: WorldEvent[]
}

export interface WorldState {
  tracks: WorldTrack[]
  generated: string
}

// Cross-cutting insight — mirrors the brain engine (insights.ts).
export interface Insight {
  id: string
  type: 'tension' | 'risk' | 'insight' | 'opportunity'
  headline: string
  why: string
  sources: string[]
  confidence: number
}

// Adaptive decision loop — mirrors the brain engine (decision-loop.ts).
export interface OpenLoop {
  id: string
  kind: 'owed' | 'risk' | 'problem'
  title: string
  detail?: string
  due?: string
  node_id?: string
  fork?: { cleared: string; blocked: string } | null
  confidence?: number
  track?: string
}

export interface MadeDecision {
  id: string
  node_id: string
  title: string
  choice: 'cleared' | 'blocked'
  note?: string
  decided_at: string
}

export interface DecisionLoop {
  open: OpenLoop[]
  made: MadeDecision[]
  counts: { owed: number; risks: number; problems: number; made: number }
}

// Calibration ledger — mirrors the brain engine (calibration.ts / types.ts).
export type VerdictOutcome = 'happened' | 'averted' | 'false_alarm' | 'unobserved'

export interface LoggedPrediction {
  id: string
  kind: string
  title: string
  due?: string | null
  confidence?: number | null
  track?: string | null
  created_at: string
  outcome: VerdictOutcome
  auto?: boolean
}

export interface CalibrationBucket {
  kind: string
  total: number
  happened: number
  averted: number
  false_alarm: number
  unobserved: number
  resolved: number
  hit_rate: number | null
}

export interface CalibrationReport {
  buckets: CalibrationBucket[]
  totals: { logged: number; resolved: number; hit_rate: number | null }
  recent: LoggedPrediction[]
}
