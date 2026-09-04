// Brain — shared causal types (main-process side).
//
// These mirror the renderer's contract in src/components/brain/graph-types.ts.
// The electron tsconfig project can't import across the src/ boundary, so the
// shape is duplicated here — keep field names in lockstep with graph-types.ts
// (same precedent as graph-derive.ts / index-store.ts mirroring the renderer).
//
// This is the first slice of the DUIN brain port (Phase A): the
// causal graph + lag-aware propagation. Later phases add the other engines
// (insights, futures, calibration, decision-loop) behind the same Store seam.

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
  // Mapped to colors+sizing in the renderer; kept here so the engines can match on them.
  | 'decision'
  | 'milestone'
  | 'release'
  | 'event'
  // A built, viewable page surface (HTML docs) — lockstep with graph-derive.ts.
  | 'page'
  // Entity kinds surfaced by the "Build my brain" construction pass (construct.ts)
  // from raw prose. The renderer already colours person/org/project/topic.
  | 'person'
  | 'org'
  | 'project'
  | 'topic'
  // Additive graph-unification kinds (Phase 0): a product/offering and a place/
  // location surfaced by the construction pass. `concept` is intentionally NOT
  // added — it already maps onto the existing `topic` kind. Coloured in
  // graph-schemes.ts DEFAULT_KIND_COLOR + every BRAIN_GRAPH_SCHEMES scheme.
  | 'product'
  | 'place'

export type RiskLevel = 'red' | 'amber' | 'green'

/** What a raw note IS, inferred by the construction LLM pass from its prose
 *  (no frontmatter/tags needed). Stamped onto the note's CausalNode so the
 *  panels (Meetings / Outputs / Mental Models) and the graph can use it. */
export type NoteClassification = 'meeting' | 'output' | 'mental_model' | 'decision' | 'note'

export interface CausalNode {
  id: string
  kind: CausalKind
  label: string
  /** Lane the node sits in (free-form; the renderer derives the visible lanes). */
  track?: string
  /** LLM-inferred nature of the note (construct.ts), so a raw prose note shows
   *  up in Meetings/Outputs/Mental Models with no frontmatter. */
  classification?: NoteClassification
  /** ISO date — pins the node on the time (x) axis when present. */
  date?: string
  /** File last-modified time (ms) — for recency display in the graph. */
  mtime?: number
  risk?: RiskLevel
  /** Inbound edge count — inflates the node radius in the renderer. */
  in_degree?: number
  /** in_degree >= 2 — a convergence point in the causal field. */
  converges?: boolean
  decide_by?: string
  decision_id?: string
  fork?: { cleared: string; blocked: string } | null
  steps?: { event: string; when: string; done: boolean }[]
  /** Slack in days (negative = overdue). Drives live-slippage propagation. */
  slack?: number | null
}

export interface CausalEdge {
  source: string
  target: string
  type: string
  /** Temporal distance carried by the edge (à la CausalFormer's d(e)). */
  lag_days?: number | null
  polarity?: '+' | '-'
  /** 0..1 — edges below 0.55 render dashed (unvalidated). */
  confidence?: number
  /** A decision node's per-outcome out-edge (if_cleared / if_blocked). */
  branch?: boolean
  evidence?: string
}

export interface CausalGraph {
  nodes: CausalNode[]
  edges: CausalEdge[]
  anchor?: string | null
  /** ISO date treated as "now" on the time axis. */
  today?: string
  stats?: { nodes: number; edges: number; converge_nodes?: number }
  /** True when the graph is the bundled demo brain (no notes indexed) rather
   *  than the user's real notes — drives the "Demo data" badge truthfully. */
  demo?: boolean
}

/** One downstream node touched by a propagation, with the shift it absorbs. */
export interface PropagationAffected {
  id: string
  label: string
  kind: string
  /** Days the node slips (for FLOW cascades). */
  shift_days?: number
  /** 'activated' | 'pruned' (for decision-branch propagation). */
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

// Predicted (not-yet-tripped) leading-indicator risk — the prediction layer
// (TS port of server.py predicted_risks()). Falsifiable: each closes after its
// due date so it can feed a calibration ledger in a later phase.
export interface PredictedRisk {
  id: string
  kind: 'deadline-collision' | 'decision-window'
  title: string
  detail?: string
  /** ISO date the indicator resolves on. */
  due: string
  leading_indicator: string
  /** Causal-node ids this risk is about. */
  subjects: string[]
  /** 0..1 — calibrated per pattern. */
  confidence: number
  track?: string
  reason: string
  /** Cognition→action: the move the brain proposes to handle this risk. The UI
   *  schedules it (loop wakeup) on one-click confirm; the brain doesn't act
   *  unilaterally. */
  suggested_action?: SuggestedAction
}

/** A proposed, schedulable follow-up derived from a risk. `delay_seconds` is
 *  the brain's lead-time proposal (urgency-tiered); the wakeup fires a brain
 *  turn with `prompt`. */
export interface SuggestedAction {
  prompt: string
  delay_seconds: number
  reason: string
}

// Cross-cutting insight — a pattern the brain notices across the whole field.
// (TS port of the ANALYTICAL half of DUIN's generate_insights(): tensions +
// patterns + opportunities derived deterministically; the GENERATIVE half —
// ideas/inspiration via an LLM pass — is a documented seam for when a provider
// key is configured, out of scope for the keyless slice.)
export interface Insight {
  id: string
  type: 'tension' | 'risk' | 'insight' | 'opportunity'
  headline: string
  why: string
  /** Node ids / track keys the insight is grounded in. */
  sources: string[]
  confidence: number
  /** True for the GENERATIVE (LLM) half — higher-level ideas/questions/opportunities
   *  appended when a provider key or local model is configured. Absent/false = the
   *  deterministic ANALYTICAL half. Lets the UI badge generative-vs-analytical. */
  generative?: boolean
}

// Adaptive decision loop (TS port of list_problems() + the decision register,
// server.py:4008): the open-loop register ↔ made decisions. Open loops are
// what needs a call (owed decisions), what might trip (risks), what's already
// tripped (problems); making a call moves an owed item to `made` (and later
// feeds the calibration ledger).
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

/**
 * The call recorded on an owed decision. Five outcomes, two classes:
 *   Substantive (cleared/blocked/done) — a real call; the node leaves the owed
 *     loop AND its decision-window prediction auto-resolves to 'averted'.
 *   Non-substantive (dismissed/cancelled) — not a real call; the node leaves
 *     owed but its prediction auto-resolves to 'unobserved' (excluded from the
 *     calibration hit-rate denominator), so dismissing noise neither inflates
 *     nor deflates the brain's foresight score.
 */
export type DecisionOutcome = 'cleared' | 'blocked' | 'done' | 'dismissed' | 'cancelled'

/** The outcomes that count as a real call (auto-resolve the prediction → 'averted'). */
export const SUBSTANTIVE_OUTCOMES = ['cleared', 'blocked', 'done'] as const

export function isSubstantiveOutcome(c: string): boolean {
  return (SUBSTANTIVE_OUTCOMES as readonly string[]).includes(c)
}

export interface MadeDecision {
  id: string
  node_id: string
  title: string
  choice: DecisionOutcome
  note?: string
  /** ISO timestamp, stamped by the facade when recorded. */
  decided_at: string
}

export interface DecisionLoop {
  open: OpenLoop[]
  made: MadeDecision[]
  counts: { owed: number; risks: number; problems: number; made: number }
}

// Calibration ledger — closes the prediction→verdict loop so the brain learns
// how trustworthy its foresight is over time (the self-improving moat).
// 'expired-unconfirmed' (P4a, 2026-07): a decision-window whose decide-by date passed
// with NO recorded decision. It is NOT a success — it is EXCLUDED from the hit-rate
// denominator (like 'unobserved') but kept DISTINCT so the honesty audit can tell a
// dismissed/cancelled call ('unobserved') apart from a silently-lapsed window.
export type VerdictOutcome =
  | 'happened'
  | 'averted'
  | 'false_alarm'
  | 'unobserved'
  | 'expired-unconfirmed'

/** A logged prediction joined with its verdict (if any). */
export interface LoggedPrediction {
  id: string
  kind: string
  title: string
  due?: string | null
  confidence?: number | null
  track?: string | null
  created_at: string
  outcome: VerdictOutcome
  /** True when the outcome was set by auto-resolution (not a human verdict). */
  auto?: boolean
}

export interface CalibrationBucket {
  kind: string
  total: number
  happened: number
  averted: number
  false_alarm: number
  unobserved: number
  /** decide-by lapsed with no recorded decision — excluded from resolved, distinct from
   *  unobserved (which is a dismissed/cancelled call). Optional: only the Stack-A
   *  computeCalibration populates it. */
  expired?: number
  /** resolved = total - unobserved - expired. */
  resolved: number
  /** (happened + averted) / resolved — how often the foresight was worth heeding. */
  hit_rate: number | null
}

export interface CalibrationReport {
  buckets: CalibrationBucket[]
  totals: { logged: number; resolved: number; hit_rate: number | null }
  /** Recent predictions (newest first) for the UI to render + verdict. */
  recent: LoggedPrediction[]
}

// Notes extraction — the LLM pass that lifts a plain notes folder into temporal
// structure so the foresight engines light up (propagation, decision-windows).
// Each item references a note by its id (relpath) so it can enrich the
// structural graph; the parse + merge are pure (testable), the LLM call is
// key-gated (no provider key → no-op → structural-only, as before).
export interface ExtractedCommitment {
  /** Node id (note relpath) this dated milestone belongs to. */
  note: string
  date: string
}
export interface ExtractedDecision {
  note: string
  decide_by: string
  cleared?: string
  blocked?: string
}
export interface ExtractedRisk {
  id: string
  label: string
  severity?: RiskLevel
  /** Node id this risk threatens (gets a 'threatens' edge), if any. */
  about?: string
}
export interface ExtractedData {
  commitments: ExtractedCommitment[]
  decisions: ExtractedDecision[]
  risks: ExtractedRisk[]
}

// "Build my brain" construction — the LLM pass that lifts a folder of RAW,
// UNLINKED prose notes (no wikilinks / frontmatter / tags) into a connected
// knowledge graph: entities (people / projects / decisions / …) inferred from
// the prose, typed relationships between them, and a classification of each
// note's nature. Parse + merge are PURE (testable); the LLM call is key-gated
// (no model → null → structural-only). See construct.ts.

/** Kinds of entity the construction pass can surface from prose. */
export type EntityKind = 'person' | 'project' | 'decision' | 'event' | 'org' | 'topic' | 'product' | 'place'

/** Relationship the construction pass can assert between two ids. */
export type RelationType =
  | 'owns'
  | 'depends_on'
  | 'blocks'
  | 'attends'
  | 'affects'
  | 'mentions'
  | 'about'

export interface ConstructedEntity {
  /** Stable slug of the form `<kind>:<slug>` (kind + short hyphenated slug). */
  id: string
  kind: EntityKind
  label: string
  /** The exact note id (relpath) the entity was found in. */
  note: string
  /** How many consecutive runs re-extracted this entity's note without producing it. One miss is
   *  tolerated (extraction is flaky); the second retires the entity. Absent = never missed. */
  missed?: number
}

export interface ConstructedEdge {
  /** Source id — an entity id or a note id (relpath). */
  source: string
  /** Target id — an entity id or a note id (relpath). */
  target: string
  /** An LLM-extracted relation, OR the construction-COMPUTED `'synonym'` alias bridge (L3):
   *  a structural edge between two entities the offline embedder clustered as the same real
   *  thing. `'synonym'` is never emitted by the LLM parse path (not in RELATION_TYPES), only by
   *  synonymEdges() at construction time, so surface-form variants ("ProjectA"↔"《ProjectA》") become 1 hop. */
  type: RelationType | 'synonym'
}

export interface ConstructedClassification {
  /** The note id (relpath) being classified. */
  note: string
  type: NoteClassification
}

/** An OPEN-VOCABULARY fact lifted from note prose — arbitrary subject/relation/object, not the
 *  fixed entity-edge relation set. The Graphiti-style S-R-O triple the metabolism judges as a claim. */
export interface ConstructedTriple {
  /** As on ConstructedEntity: consecutive covered runs that did not re-extract this triple. */
  missed?: number
  subject: string
  /** A natural relation phrase — any verb/phrase ("has deadline", "prefers", "reports to"). */
  relation: string
  object: string
  /** The note id (relpath) the fact came from, for provenance. */
  note: string
  /** LLM-EXTRACTED bitemporal validity (Graphiti-style per-fact valid interval), when the prose
   *  states it — ISO date the fact became true. Absent/null ⇒ unknown (defaults to observed time). */
  validFrom?: string | null
  /** LLM-extracted date the fact STOPPED being true / was superseded. A past validUntil ⇒ the claim
   *  is born already-retired (LLM temporal invalidation). Absent/null ⇒ still valid. */
  validUntil?: string | null
}

export interface ConstructedData {
  entities: ConstructedEntity[]
  edges: ConstructedEdge[]
  classifications: ConstructedClassification[]
  /** Open-vocabulary prose facts (optional — present once a construction is built with the triple
   *  pass; absent in older caches). Bridged into the claim ledger as open-relation prose claims. */
  triples?: ConstructedTriple[]
}
