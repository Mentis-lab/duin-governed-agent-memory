// Feedback channel — DUIN autonomic nervous system, organ #1.
//
// Every proactive surface (inline transcript notice, OS notification follow-up,
// activity card) offers a four-way verdict: act / snooze / dismiss /
// not-relevant. Each click is a typed OBSERVATION, persisted append-only to the
// shared `events` audit table (no schema migration — we reuse the sanctioned
// writer in event-log.ts).
//
// Two things come out of one click:
//
//   1. A typed SEED for the starved engine loops:
//        • act          → forecast-resolution-seed (P6 fuel — the surfaced
//                          forecast was useful enough to act on; its real
//                          outcome resolves later, status starts 'pending').
//        • dismiss /     → correction-seed (P5 fuel — the surface mis-fired;
//          not-relevant    this is a labelled negative the judgment loop needs
//                          to climb past its min_n gate). not-relevant is the
//                          stronger correction (wrong to surface at all) vs
//                          dismiss (right kind, wrong moment).
//        • snooze        → no seed; a soft defer ('deferred'). Kept as signal
//                          but neither a correction nor a resolution.
//
//   2. A per-detectorClass tally (see getEngagementByClass) — the loudness gate
//      and the earned-autonomy governor read this to decide whether a detector
//      class has earned the right to keep speaking (or to be promoted toward
//      autonomic). Autonomy granted slowly, revoked fast: a run of
//      dismiss/not-relevant should quiet a class long before a run of acts
//      promotes it.
//
// This module owns ONLY the typing + the read aggregation. Persistence,
// redaction, and size caps belong to event-log.ts.

import { listEvents, recordEvent, type EventRecord } from './event-log'

export const FEEDBACK_EVENT_TYPE = 'feedback.observation.recorded' as const

/** The four-way verdict a user can give a proactive surface. */
export type FeedbackAction = 'act' | 'snooze' | 'dismiss' | 'not-relevant'

/** Which proactive surface the verdict came from. */
export type FeedbackSourceKind = 'notice' | 'notification' | 'activity-card'

/**
 * The typed seed a verdict manufactures for the engine loops. `null` means the
 * verdict (snooze) intentionally produces no seed.
 */
export type SeedType = 'forecast-resolution-seed' | 'correction-seed' | null

/**
 * Lifecycle of the seed. 'pending' = an act whose real-world outcome is not yet
 * known (the resolution loop closes it later). 'deferred' = a snooze. 'rejected'
 * = a dismiss/not-relevant (a settled negative — no further outcome to await).
 */
export type OutcomeStatus = 'pending' | 'deferred' | 'rejected'

const ALL_ACTIONS: readonly FeedbackAction[] = [
  'act',
  'snooze',
  'dismiss',
  'not-relevant'
]

/** True for verdicts the loudness gate should read as the user engaging. */
function isEngaged(action: FeedbackAction): boolean {
  return action === 'act' || action === 'snooze'
}

/** Map a verdict to the seed it manufactures. Pure — unit-testable. */
export function seedTypeForAction(action: FeedbackAction): SeedType {
  switch (action) {
    case 'act':
      return 'forecast-resolution-seed'
    case 'dismiss':
    case 'not-relevant':
      return 'correction-seed'
    case 'snooze':
      return null
  }
}

/** Map a verdict to the lifecycle status its seed starts in. Pure. */
export function outcomeStatusForAction(action: FeedbackAction): OutcomeStatus {
  switch (action) {
    case 'act':
      return 'pending'
    case 'snooze':
      return 'deferred'
    case 'dismiss':
    case 'not-relevant':
      return 'rejected'
  }
}

/**
 * Which engine artifact a proactive surface came from. When a notice is born
 * from a real engine output (a forecast-mode prediction, a risk prediction, an
 * insight, a cascade), the producer stamps this so the consumption bridge can
 * forward the verdict back to the engine's matching /state/* endpoint. Absent
 * for generic app surfaces (a raw async-event nudge) — those have no engine row
 * to resolve, so their only value is the engagement tally (the loudness gate).
 */
export type EngineRefKind = 'forecast' | 'prediction' | 'insight' | 'cascade'

export interface EngineRef {
  kind: EngineRefKind
  /** The engine-side id of the artifact (forecast/prediction/insight id). */
  id: string
  /** Optional domain, only meaningful for prediction-feedback. */
  domain?: string | null
}

export interface FeedbackObservationInput {
  /** Stable id of the card/notice/notification the user acted on. */
  sourceCardId: string
  /** Which surface it came from. */
  sourceKind: FeedbackSourceKind
  /** The user's verdict. */
  action: FeedbackAction
  /**
   * The detector class that produced the surface (e.g. 'deadline-collision',
   * 'surprise-consolidation'). Real detectors don't exist yet — callers should
   * fall back to a coarse label (the notice title / async-event kind) until
   * organ #2 lands. Used as the aggregation key for the governor.
   */
  detectorClass?: string | null
  /** Optional conversation the surface belonged to (for timeline scoping). */
  conversationId?: string | null
  /** Optional short human label, metadata only (no secrets). */
  title?: string | null
  /**
   * Optional pointer back to the engine artifact this surface came from. When
   * present, the consumption bridge (organ #2 of the pump) can forward the
   * verdict to the engine's matching /state/* endpoint. When absent, the
   * observation stays app-local (engagement tally only).
   */
  engineRef?: EngineRef | null
}

/** Validate + normalize an engine ref; returns null for anything unusable. */
export function normalizeEngineRef(ref?: EngineRef | null): EngineRef | null {
  if (!ref || typeof ref !== 'object') return null
  const kinds: readonly EngineRefKind[] = ['forecast', 'prediction', 'insight', 'cascade']
  const id = typeof ref.id === 'string' ? ref.id.trim() : ''
  if (!id || !kinds.includes(ref.kind)) return null
  return {
    kind: ref.kind,
    id,
    domain:
      typeof ref.domain === 'string' && ref.domain.trim() ? ref.domain.trim() : undefined
  }
}

export interface RecordedFeedback {
  id: string
  action: FeedbackAction
  seedType: SeedType
  outcomeStatus: OutcomeStatus
  detectorClass: string
  recordedAt: number
}

const UNCLASSIFIED = 'unclassified'

function normalizeClass(detectorClass?: string | null): string {
  const c = (detectorClass ?? '').trim()
  return c.length > 0 ? c : UNCLASSIFIED
}

/**
 * Record a single feedback observation. Returns the derived seed metadata so the
 * caller (IPC → renderer) can reflect it immediately. Never throws on a bad
 * action — unknown actions are coerced to 'dismiss' (the safe negative).
 */
export function recordFeedback(input: FeedbackObservationInput): RecordedFeedback {
  const action: FeedbackAction = ALL_ACTIONS.includes(input.action)
    ? input.action
    : 'dismiss'
  const detectorClass = normalizeClass(input.detectorClass)
  const seedType = seedTypeForAction(action)
  const outcomeStatus = outcomeStatusForAction(action)
  const engineRef = normalizeEngineRef(input.engineRef)

  const rec = recordEvent({
    type: FEEDBACK_EVENT_TYPE,
    actorKind: 'user',
    conversationId: input.conversationId ?? undefined,
    entityKind: input.sourceKind,
    entityId: input.sourceCardId,
    payload: {
      action,
      seedType,
      outcomeStatus,
      detectorClass,
      sourceKind: input.sourceKind,
      title: input.title ?? undefined,
      // Engine pointer for the consumption bridge. Omitted (not null) when
      // absent so the payload stays compact for generic app surfaces.
      engineRef: engineRef ?? undefined
    }
  })

  return {
    id: rec.id,
    action,
    seedType,
    outcomeStatus,
    detectorClass,
    recordedAt: rec.createdAt
  }
}

export interface ClassEngagement {
  detectorClass: string
  act: number
  snooze: number
  dismiss: number
  notRelevant: number
  total: number
  /**
   * Fraction of verdicts where the user engaged (act or snooze) vs total. The
   * loudness gate's read on whether this class has earned the right to keep
   * speaking. 0..1; `null` when total is 0 (no signal yet).
   */
  engagementScore: number | null
  /** Epoch ms of the most recent verdict for this class. */
  lastAt: number | null
}

function emptyEngagement(detectorClass: string): ClassEngagement {
  return {
    detectorClass,
    act: 0,
    snooze: 0,
    dismiss: 0,
    notRelevant: 0,
    total: 0,
    engagementScore: null,
    lastAt: null
  }
}

function actionOf(e: EventRecord): FeedbackAction | null {
  const a = e.payload?.action
  return typeof a === 'string' && (ALL_ACTIONS as string[]).includes(a)
    ? (a as FeedbackAction)
    : null
}

function classOf(e: EventRecord): string {
  const c = e.payload?.detectorClass
  return typeof c === 'string' && c.trim().length > 0 ? c : UNCLASSIFIED
}

/**
 * Aggregate every recorded feedback observation by detector class. This is the
 * governor/loudness-gate sensor: a class with a sinking engagementScore should
 * be quieted; a class with a sustained high score is a promotion candidate.
 *
 * Reads through listEvents so it transparently uses the memory fallback in
 * headless tests. Bounded by listEvents' MAX_LIST_LIMIT.
 */
export function getEngagementByClass(
  opts: { sinceMs?: number; limit?: number } = {}
): ClassEngagement[] {
  const rows = listEvents({
    type: FEEDBACK_EVENT_TYPE,
    sinceMs: opts.sinceMs,
    limit: opts.limit ?? 1000,
    order: 'desc'
  })

  const byClass = new Map<string, ClassEngagement>()
  for (const e of rows) {
    const action = actionOf(e)
    if (!action) continue
    const cls = classOf(e)
    const agg = byClass.get(cls) ?? emptyEngagement(cls)
    agg.total += 1
    if (action === 'act') agg.act += 1
    else if (action === 'snooze') agg.snooze += 1
    else if (action === 'dismiss') agg.dismiss += 1
    else if (action === 'not-relevant') agg.notRelevant += 1
    if (agg.lastAt === null || e.createdAt > agg.lastAt) agg.lastAt = e.createdAt
    byClass.set(cls, agg)
  }

  for (const agg of byClass.values()) {
    const engaged = agg.act + agg.snooze
    agg.engagementScore = agg.total > 0 ? engaged / agg.total : null
  }

  // Loudest-first by total, then most-recently-active — the order the governor
  // wants when scanning for the class most in need of a decision.
  return [...byClass.values()].sort(
    (a, b) => b.total - a.total || (b.lastAt ?? 0) - (a.lastAt ?? 0)
  )
}

/** Convenience single-class lookup. Returns an empty tally when unseen. */
export function getEngagementForClass(detectorClass: string): ClassEngagement {
  const cls = normalizeClass(detectorClass)
  return (
    getEngagementByClass().find((c) => c.detectorClass === cls) ??
    emptyEngagement(cls)
  )
}

// Re-export for callers that want to derive the seed without recording (e.g.
// a UI tooltip explaining what a click will do).
export { isEngaged }
