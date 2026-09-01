// Brain — Home Digest (the right-panel "Today" home).
//
// Replaces the ~20-pill launcher's role as the default face of the right panel
// with ONE triaged digest: a single focal item, a co-equal "brain noticed"
// (insights) section, a co-equal "needs you" (obligations) section, and a quiet
// "since you were away" line. Design + ranking spec: PLANNING/DUIN_HOME_DIGEST.md.
//
// Ranking: S = Base · Affinity · Novelty · Decay, with an urgency floor for obligations.
//   Base = weighted sum of Urgency(due) / Importance(graph centrality) / Confidence,
//          each 0..1; weight vectors differ by kind so insights lean Importance+Confidence
//          and needs lean Urgency. Base is the INTRINSIC salience; the three multiplicative
//          terms are second-brain ATTENTION modulators on top of it (all neutral by default).
//   A type bias leans the mix toward insights (~60/40) — "risk is a type of
//   insight", so risk/problem open-loops are NOT surfaced as obligations here;
//   they inform through the insight pool (getInsights already emits risk-type).
//
// Affinity (the moat term) is WIRED: a Beta(1,1)-smoothed useful-rate per insight
//   FEATURE (the id's rule family, e.g. conv / riskconc / orphan), read from the
//   persisted insight-verdict ledger (brain_insight_verdicts). It leans the digest
//   toward the KIND of insight the operator keeps marking useful and fades the ones
//   they dismiss. Gated below AFFINITY_MIN_N verdicts → neutral 1.0 (correct
//   cold-start): with no accumulated taste it changes nothing, so an empty ledger
//   ranks exactly as before.
//
// Novelty + Decay are LEDGER-BACKED (brain_insight_first_seen / brain_insight_impressions,
// loaded via HomeDigestInput like Affinity — see brain-db.recordInsightSalience). Both are
// cold-start neutral: an empty ledger yields Novelty=peak-uniform and Decay=1.0, so the FIRST
// build ranks exactly as the pre-salience digest; they only diverge as attention-state accrues.

import type { Insight, OpenLoop, CalibrationReport, CausalGraph } from './types'
import type { OwedPerson } from './people-owed-native'

export interface DigestItem {
  id: string
  kind: 'insight' | 'need'
  /** insight type (tension|risk|insight|opportunity) or loop kind (owed). */
  subtype: string
  title: string
  why: string
  track?: string
  due?: string
  score: number
  /** Self-explaining one-liner: why this ranked where it did. */
  reason: string
  tone: 'accent' | 'warning' | 'neutral'
  verdict?: string
}

/** An active work-track for the "Jump back in" launcher. */
export interface TrackDigest {
  key: string
  label: string
  open: number
  dueSoon: number
  risks: number
  status: string
  /** "3 open · 1 due soon · 2 risks" — what's live in this lane. */
  reason: string
  tone: 'accent' | 'warning' | 'neutral'
}

export interface HomeDigest {
  /** Active tracks to jump back into (replaces the old single focal card). */
  tracks: TrackDigest[]
  insights: DigestItem[]
  needs: DigestItem[]
  away: string | null
  /** A single compact "come back for X" line — the session-end return reason.
   *  Always non-empty: the operator-learning review queue when it dominates, else the
   *  top thing owed / to resume / noticed, or a friendly "as your brain fills" nudge
   *  when the vault is empty. */
  returnReason: string
  generatedAt: string
}

/** Raw track input (from world-state). */
export interface TrackInput {
  key: string
  label: string
  open: number
  due_soon: number
  risks: number
  status: string
}

export interface HomeDigestInput {
  insights: (Insight & { verdict?: string })[]
  openLoops: OpenLoop[]
  graph: CausalGraph
  calibration: CalibrationReport
  /** ISO yyyy-mm-dd treated as "now". */
  today: string
  /** People with open follow-ups owed (Needs You). Empty = none / no vault. */
  owedPeople?: OwedPerson[]
  /** Per-feature useful/dismissed tallies for the Affinity term. {} = neutral. */
  affinity?: Record<string, { pos: number; neg: number }>
  /** Active work-tracks (world-state). Powers "Jump back in". */
  tracks?: TrackInput[]
  /** Operator-learning review queue: CANDIDATE facts awaiting the human promote/veto gate
   *  (operator-model.getPendingReview). Only `count` is needed to surface the daily nudge;
   *  0 / undefined = empty queue → no item is emitted (degrade honestly, never nag). */
  pendingReview?: { count: number }
  /** Novelty ledger: insight id → yyyy-mm-dd first NOTICED. Missing/{} → every insight is
   *  brand-new (peak novelty, uniform → order-preserving). brain-db.loadInsightSalience. */
  firstSeen?: Record<string, string>
  /** Decay ledger: insight id → distinct DAYS shown in the digest. Missing/{} → no anti-nag. */
  impressions?: Record<string, number>
}

// ── tuning constants ────────────────────────────────────────────────────────
const URGENCY_HORIZON_DAYS = 14
// Lean insights over needs (~60/40) per the risk demotion — ranking order only.
const TYPE_BIAS: Record<DigestItem['kind'], number> = { insight: 1.15, need: 0.85 }
const WEIGHTS = {
  insight: { u: 0.1, i: 0.45, n: 0.0, c: 0.45 },
  need: { u: 0.6, i: 0.3, n: 0.0, c: 0.1 }
}
// Default-visible rows per section; the UI reveals the rest on "show all".
const MAX_SECTION = 3
// Hard cap on what's returned per section (the expandable pool).
const MAX_LIST = 12
// Active tracks shown in "Jump back in".
const MAX_TRACKS = 4

// ── Affinity (the moat term) ─────────────────────────────────────────────────
// Per-feature verdicts required before taste expresses. Deliberately lower than
// the forecast ledger's min_n=20: insight verdicts accrue far slower per feature
// (one per distinct insight the operator judges), and the Beta(1,1) prior below
// already damps small samples toward neutral — so a hard gate of 4 is enough to
// keep a single click from swinging the digest while still letting real taste
// surface within a few sessions.
const AFFINITY_MIN_N = 4
// Max multiplier swing around neutral 1.0 (a useful-rate of 1.0 → ×1.3, 0 → ×0.7).
// Same magnitude band as TYPE_BIAS so affinity nudges, never dominates.
const AFFINITY_BAND = 0.3

/** An insight's affinity FEATURE = its rule family (id prefix before `::`, e.g.
 *  `conv`, `riskconc`, `orphan`). Exported so the verdict writer keys on the same
 *  feature the ranker reads. */
export function featureOf(id: string): string {
  const i = id.indexOf('::')
  return i >= 0 ? id.slice(0, i) : id
}

/** Affinity multiplier from a feature's useful/dismissed tally. Neutral (1.0)
 *  below AFFINITY_MIN_N; else a Beta(1,1)-smoothed useful-rate mapped into
 *  [1-BAND, 1+BAND]. PURE. */
function affinityMult(stat: { pos: number; neg: number } | undefined): number {
  if (!stat) return 1
  const n = stat.pos + stat.neg
  if (n < AFFINITY_MIN_N) return 1
  const rate = (stat.pos + 1) / (n + 2) // Beta(1,1)-smoothed
  return 1 + (rate - 0.5) * 2 * AFFINITY_BAND
}

// ── Novelty + Decay (second-brain attention modulators; multiplicative, neutral by default) ──
// Novelty: a newly-NOTICED insight is more salient — a second brain should surface what it just
//   learned, not only what's most central. The boost fades to 0 as the insight ages (it's no
//   longer news). An unknown id is treated as brand-new (first sighting = peak), so a cold-start
//   ledger boosts every candidate UNIFORMLY → the ranking ORDER is unchanged (multiplicative).
const NOVELTY_WINDOW_DAYS = 21 // novelty boost decays to 0 over ~3 weeks of age
const NOVELTY_BOOST = 0.4 // peak ×1.4 at first sighting → ×1.0 once aged out
// Decay: habituation / anti-nag — an insight the brain has SHOWN on many days without the operator
//   acting on it fades, so a stale suggestion stops crowding the panel. Acting on it records a
//   verdict → it graduates to the earned-taste Affinity term instead. Floored so a still-live
//   insight is never fully buried.
const DECAY_GRACE_DAYS = 3 // shown on up to 3 distinct days before anti-nag begins
const DECAY_PER_DAY = 0.1 // each further shown-day fades the score by this…
const DECAY_FLOOR = 0.5 // …down to this multiplier floor

/** Novelty multiplier (≥1): peak ×(1+BOOST) at first sighting, linearly to ×1 by
 *  NOVELTY_WINDOW_DAYS. Unknown id ⇒ brand-new (peak). PURE. */
function noveltyMult(id: string, firstSeen: Record<string, string> | undefined, today: string): number {
  const seen = firstSeen?.[id]
  if (!seen) return 1 + NOVELTY_BOOST // never recorded → first sighting → peak novelty
  const ageDays = Math.round((Date.parse(today) - Date.parse(seen)) / 86_400_000)
  if (!Number.isFinite(ageDays) || ageDays >= NOVELTY_WINDOW_DAYS) return 1
  const freshness = 1 - Math.max(0, ageDays) / NOVELTY_WINDOW_DAYS // 1 at age 0 → 0 at window
  return 1 + NOVELTY_BOOST * freshness
}

/** Decay multiplier (≤1): 1.0 until DECAY_GRACE_DAYS distinct shown-days, then fades
 *  DECAY_PER_DAY per further day down to DECAY_FLOOR. Unknown/0 ⇒ 1.0. PURE. */
function decayMult(id: string, impressions: Record<string, number> | undefined): number {
  const days = impressions?.[id] ?? 0
  if (days <= DECAY_GRACE_DAYS) return 1
  return Math.max(DECAY_FLOOR, 1 - DECAY_PER_DAY * (days - DECAY_GRACE_DAYS))
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

function daysUntil(due: string | undefined, today: string): number | null {
  if (!due) return null
  const d = Date.parse(due)
  const t = Date.parse(today)
  if (Number.isNaN(d) || Number.isNaN(t)) return null
  return Math.floor((d - t) / 86_400_000)
}

/** Urgency 0..1 from a due date: overdue = 1, horizon-out ≈ 0. */
function urgency(days: number | null): number {
  if (days === null) return 0
  if (days <= 0) return 1
  return clamp01(1 - days / URGENCY_HORIZON_DAYS)
}

/** node id → normalized inbound-edge centrality (0..1). */
function centralityMap(graph: CausalGraph): Map<string, number> {
  const m = new Map<string, number>()
  let max = 0
  for (const n of graph.nodes) {
    const d = n.in_degree ?? 0
    m.set(n.id, d)
    if (d > max) max = d
  }
  if (max > 0) for (const [k, v] of m) m.set(k, v / max)
  return m
}

/** Importance from the item's grounding: peak centrality across its sources,
 *  floored so a lightly-connected but real item isn't zeroed out. */
function importance(sources: string[], cent: Map<string, number>): number {
  let peak = 0
  for (const s of sources) peak = Math.max(peak, cent.get(s) ?? 0)
  return clamp01(0.25 + 0.75 * peak)
}

function needDue(days: number | null): string {
  if (days === null) return 'no deadline'
  if (days < 0) return `${-days}d overdue`
  if (days === 0) return 'due today'
  if (days === 1) return 'due tomorrow'
  return `due in ${days}d`
}

export function buildHomeDigest(input: HomeDigestInput): HomeDigest {
  const { insights, openLoops, graph, calibration, today } = input
  const owedPeople = input.owedPeople ?? []
  const affinity = input.affinity ?? {}
  const firstSeen = input.firstSeen // Novelty ledger (undefined → every insight brand-new)
  const impressions = input.impressions // Decay ledger (undefined → no anti-nag)
  const cent = centralityMap(graph)
  const items: DigestItem[] = []

  // ── Insight candidates (includes risk-type; risk IS an insight) ───────────
  for (const ins of insights) {
    const w = WEIGHTS.insight
    const days = daysUntil(undefined, today) // insights carry no user deadline
    const U = urgency(days)
    const I = importance(ins.sources ?? [], cent)
    const C = clamp01(ins.confidence ?? 0.5)
    const base = w.u * U + w.i * I + w.c * C // intrinsic salience (Novelty/Decay moved to modulators)
    const aff = affinityMult(affinity[featureOf(ins.id)]) // moat term; 1.0 cold-start
    // Second-brain attention modulators (neutral cold-start): novelty boosts newly-noticed
    // insights; decay fades ones shown on many days without action. See noveltyMult / decayMult.
    const score = base * TYPE_BIAS.insight * aff * noveltyMult(ins.id, firstSeen, today) * decayMult(ins.id, impressions)
    const nSrc = (ins.sources ?? []).length
    items.push({
      id: ins.id,
      kind: 'insight',
      subtype: ins.type,
      title: ins.headline,
      why: ins.why,
      track: ins.sources?.[0],
      score,
      reason: nSrc > 0 ? `${ins.type} pattern, ${nSrc} source${nSrc > 1 ? 's' : ''}` : `${ins.type} pattern`,
      tone: ins.type === 'risk' ? 'warning' : 'accent',
      verdict: ins.verdict
    })
  }

  // ── Needs candidates: obligations only = owed loops (decisions/gates/forks) ─
  // risk/problem loops are intentionally excluded — they inform via insights.
  for (const loop of openLoops) {
    if (loop.kind !== 'owed') continue
    const w = WEIGHTS.need
    const days = daysUntil(loop.due, today)
    const U = loop.due ? urgency(days) : 0.3
    const I = importance(loop.node_id ? [loop.node_id] : [], cent)
    const C = clamp01(loop.confidence ?? 0.7)
    let score = (w.u * U + w.i * I + w.n * 0 + w.c * C) * TYPE_BIAS.need
    // Urgency floor: an imminent obligation can be reordered by score but never buried.
    if (days !== null && days <= 1) score = Math.max(score, 0.85)
    items.push({
      id: loop.id,
      kind: 'need',
      subtype: loop.kind,
      title: loop.title,
      why: loop.detail ?? '',
      track: loop.track,
      due: loop.due,
      score,
      reason: needDue(days),
      tone: days !== null && days <= 1 ? 'warning' : 'neutral'
    })
  }

  // ── People-owed candidates: a person with open follow-ups (Needs You) ──────
  // No graph node + no due date, so urgency rides the open-count (5+ = full).
  for (const p of owedPeople) {
    const w = WEIGHTS.need
    const U = clamp01(p.open / 5)
    const I = 0.3
    const C = 0.7
    const score = (w.u * U + w.i * I + w.n * 0 + w.c * C) * TYPE_BIAS.need
    items.push({
      id: `person-owed::${p.name}`,
      kind: 'need',
      subtype: 'person-owed',
      title: p.name,
      why: p.top,
      track: p.org || undefined,
      score,
      reason: `${p.open} open`,
      tone: 'neutral'
    })
  }

  // ── Operator-learning review queue (Needs You) ────────────────────────────
  // CANDIDATE facts DUIN has captured about the operator sit here until a human
  // clicks promote/veto — the ONLY path candidate→rule. So a non-empty queue is a
  // genuine obligation (the promotion valve is idle precisely because nothing
  // surfaces it). Emit it as a need; NEVER at 0 (no nag). No auto-promote — this
  // only makes the queue visible + one-tap actionable.
  const pendingCount = input.pendingReview?.count ?? 0
  if (pendingCount > 0) {
    const w = WEIGHTS.need
    // No due date; urgency rides the backlog size (5+ waiting ≈ full), same shape
    // as people-owed so the two Needs sources rank on a comparable scale.
    const U = clamp01(pendingCount / 5)
    const score = (w.u * U + w.i * 0.3 + w.n * 0 + w.c * 0.7) * TYPE_BIAS.need
    items.push({
      id: 'operator-review',
      kind: 'need',
      subtype: 'operator-review',
      title: pendingCount === 1 ? '1 fact waiting for your review' : `${pendingCount} facts waiting for your review`,
      why: 'DUIN learned these about you. Promote one to a rule it follows, or veto it.',
      score,
      reason: 'Review',
      tone: 'accent'
    })
  }

  // ── Tracks ("Jump back in") — active lanes, most-live first. ───────────────
  const trackWeight = (t: TrackInput): number => t.open + t.due_soon * 2 + t.risks * 1.5
  const tracks: TrackDigest[] = (input.tracks ?? [])
    .filter((t) => t.open > 0 || t.due_soon > 0 || t.risks > 0)
    .sort((a, b) => trackWeight(b) - trackWeight(a))
    .slice(0, MAX_TRACKS)
    .map((t) => ({
      key: t.key,
      label: t.label,
      open: t.open,
      dueSoon: t.due_soon,
      risks: t.risks,
      status: t.status,
      reason:
        [
          t.open ? `${t.open} open` : '',
          t.due_soon ? `${t.due_soon} due soon` : '',
          t.risks ? `${t.risks} risk${t.risks > 1 ? 's' : ''}` : ''
        ]
          .filter(Boolean)
          .join(' · ') || t.status,
      tone: t.risks > 0 ? 'warning' : 'accent'
    }))

  // ── Sections — ranked; the UI shows MAX_SECTION and expands to the full list.
  const byScore = (a: DigestItem, b: DigestItem): number => b.score - a.score
  const insightItems = items.filter((i) => i.kind === 'insight').sort(byScore).slice(0, MAX_LIST)

  // Needs: pin overdue/soon to the top, then by score.
  const needSort = (a: DigestItem, b: DigestItem): number => {
    const da = daysUntil(a.due, today)
    const db = daysUntil(b.due, today)
    const soonA = da !== null && da <= 1 ? 0 : 1
    const soonB = db !== null && db <= 1 ? 0 : 1
    return soonA - soonB || b.score - a.score
  }
  const needAll = items.filter((i) => i.kind === 'need').sort(needSort)
  // Guarantee a person you owe appears within the DEFAULT-visible window (first
  // MAX_SECTION), since overdue decisions carry an urgency floor and would
  // otherwise bury "who you owe" until the section is expanded.
  const topOwedPerson = needAll.find((i) => i.subtype === 'person-owed')
  let needOrdered = needAll
  if (topOwedPerson && !needAll.slice(0, MAX_SECTION).some((i) => i.subtype === 'person-owed')) {
    needOrdered = needAll.filter((i) => i !== topOwedPerson)
    needOrdered.splice(MAX_SECTION - 1, 0, topOwedPerson)
  }
  const needItems = needOrdered.slice(0, MAX_LIST)

  // ── "Since you were away" — honest, from what's available (calibration). ──
  // Real ingest deltas (docs/people) + last-visit diffing are a later hook.
  const resolved = calibration.totals?.resolved ?? 0
  const hit = calibration.totals?.hit_rate
  const away =
    resolved > 0
      ? `${resolved} forecast${resolved > 1 ? 's' : ''} resolved` +
        (typeof hit === 'number' ? ` · foresight ${Math.round(hit * 100)}% on point` : '')
      : null

  const returnReason = computeReturnReason(needItems, tracks, insightItems, away)

  return {
    tracks,
    insights: insightItems,
    needs: needItems,
    away,
    returnReason,
    generatedAt: new Date().toISOString()
  }
}

/** The session-end "come back for X" line. Picks the single most compelling reason
 *  to return — the operator-learning review queue when it ranks first, else the top
 *  thing owed, else a track to resume, else something noticed, else the away summary —
 *  and always falls back to a friendly nudge so a sparse or empty vault still gets an
 *  honest, non-empty promise. PURE. */
export function computeReturnReason(
  needs: DigestItem[],
  tracks: TrackDigest[],
  insights: DigestItem[],
  away: string | null
): string {
  const need = needs[0]
  if (need) {
    if (need.subtype === 'operator-review') {
      return `${need.title} — a quick review keeps your brain learning what fits you.`
    }
    if (need.subtype === 'person-owed') {
      return `You still owe ${need.title} a reply (${need.reason}) — I'll keep it up top.`
    }
    return `${need.title} is still waiting on your call (${need.reason}).`
  }
  const track = tracks[0]
  if (track) {
    return `Pick back up on ${track.label} — ${track.reason}.`
  }
  const ins = insights[0]
  if (ins) {
    return `Come back for what I noticed: ${ins.title}.`
  }
  if (away) {
    return `Since you were away: ${away}.`
  }
  return "As your brain fills, I'll surface what needs you — check back tomorrow."
}
