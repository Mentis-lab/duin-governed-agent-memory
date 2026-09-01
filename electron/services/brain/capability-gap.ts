// Capability-gap detector (Spec #2 §1, DUIN_CAPABILITY_GAP_METABOLISM_SPEC.md).
// READ-ONLY: joins weakness signals that exist in isolation into ONE ranked
// "where am I systematically weak" list — which nothing produces today. No
// autonomy, no writes; the synthesizer/gap-closer are a later, gated step.
//
// Fuel note (measured 2026-07-01 on the dogfood vault): the spec's structured
// stores (failure_ledger, proof_receipts, calibration) are ~empty, but the raw
// event log carries real systematic signal (a single automation failed 170×; a
// model 170×). So the recurring-failure signal is sourced from `*.failed` EVENTS
// grouped by entity, NOT the (unpopulated) failure_ledger.

import { CJK_CLASS, hasCjk } from './cjk-tokens'

/** A detected systematic weakness, ranked by severity (higher = weaker). */
export interface CapabilityGap {
  id: string
  kind: 'recurring-failure' | 'correction-cluster' | 'calibration'
  title: string
  /** Cited source rows — corpus-grounding; every gap must show its evidence. */
  evidence: string[]
  severity: number
  count: number
}

export interface FailedEvent {
  type: string
  entityId: string | null
  entityKind?: string | null
}

export interface CalibrationRow {
  kind: string
  hitRate: number
  resolved: number
}

export interface GapInputs {
  failedEvents?: FailedEvent[]
  corrections?: string[]
  calibration?: CalibrationRow[]
}

/** A `*.failed` entity must recur at least this many times to be a gap (filters
 *  one-off/transient errors; the real signal is the 170× concentrations). */
const MIN_FAILS = 5
/** Corrections must cluster this densely to count (mirrors learn.reflect's ≥3). */
const MIN_CLUSTER = 3
/** Calibration needs a minimum resolved sample before a hit-rate is meaningful. */
const MIN_RESOLVED = 4
const CALIBRATION_FLOOR = 0.6

const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'is', 'was', 'for', 'in', 'on', 'it', 'that',
  'this', 'be', 'with', 'as', 'at', 'by', 'not', 'you', 'i', 'should', 'when', 'if', 'but'
])

/** Run splitter. The CJK alternative is the tokenizer's full class (kanji + KANA), not
 *  the bare ideograph range — Japanese kana otherwise read as punctuation and its
 *  corrections could never cluster. */
const GAP_RUN_RE = new RegExp(`[a-z0-9]+|[${CJK_CLASS}]+`, 'g')

/** Tokenize for correction clustering: Latin words (len>2, non-stop) + CJK
 *  bigrams (so Chinese corrections cluster too). PURE. */
export function gapTokens(s: string): string[] {
  const out: string[] = []
  for (const run of (s ?? '').toLowerCase().match(GAP_RUN_RE) ?? []) {
    if (hasCjk(run)) {
      for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
    } else if (run.length > 2 && !STOP.has(run)) {
      out.push(run)
    }
  }
  return out
}

/** Overlap coefficient (shared / smaller set) — better than Jaccard for theme
 *  clustering: it doesn't penalize a short correction sharing a long one's core,
 *  and it survives CJK bigram inflation (many tokens per string). */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / Math.min(a.size, b.size)
}

interface Cluster {
  members: string[]
  tokens: Set<string>
}

/** Greedy single-link clustering of correction texts by token Jaccard. Not
 *  learn.reflect (that's the Python engine's recency-weighted version); a light
 *  JS analogue so the detector needs no engine round-trip. PURE. */
export function clusterCorrections(texts: string[], threshold = 0.35): Cluster[] {
  const clusters: Cluster[] = []
  for (const text of texts) {
    const toks = new Set(gapTokens(text))
    if (toks.size === 0) continue
    let best: Cluster | null = null
    let bestScore = 0
    for (const c of clusters) {
      const s = overlap(toks, c.tokens)
      if (s > bestScore) {
        bestScore = s
        best = c
      }
    }
    if (best && bestScore >= threshold) {
      best.members.push(text)
      for (const t of toks) best.tokens.add(t)
    } else {
      clusters.push({ members: [text], tokens: new Set(toks) })
    }
  }
  return clusters
}

/** The dominant token in a cluster (for a human-readable label). */
function clusterLabel(c: Cluster): string {
  const counts = new Map<string, number>()
  for (const m of c.members) for (const t of gapTokens(m)) counts.set(t, (counts.get(t) ?? 0) + 1)
  let best = ''
  let n = 0
  for (const [t, k] of counts) if (k > n) { n = k; best = t }
  return best || 'misc'
}

/**
 * Detect systematic capability gaps from the READ signals, ranked by severity.
 * PURE given the loaded rows — the live loader (side-effectful DB/file reads) is
 * a thin wrapper. Sparse/empty inputs simply yield fewer gaps (never throws).
 */
export function detectGaps(inp: GapInputs): CapabilityGap[] {
  const gaps: CapabilityGap[] = []

  // 1. Recurring failures — group `*.failed` events by (type, entity).
  const byKey = new Map<string, { type: string; entity: string; n: number }>()
  for (const e of inp.failedEvents ?? []) {
    const entity = e.entityId ?? '(none)'
    const key = `${e.type}::${entity}`
    const g = byKey.get(key) ?? { type: e.type, entity, n: 0 }
    g.n++
    byKey.set(key, g)
  }
  for (const g of byKey.values()) {
    if (g.n < MIN_FAILS) continue
    gaps.push({
      id: `fail:${g.type}:${g.entity}`,
      kind: 'recurring-failure',
      title: `${g.type} keeps failing for ${g.entity} (${g.n}×)`,
      evidence: [`${g.n} × ${g.type} on entity ${g.entity}`],
      severity: g.n,
      count: g.n
    })
  }

  // 2. Correction clusters — a recurring theme the user keeps correcting.
  for (const c of clusterCorrections(inp.corrections ?? [])) {
    if (c.members.length < MIN_CLUSTER) continue
    gaps.push({
      id: `corr:${clusterLabel(c)}`,
      kind: 'correction-cluster',
      title: `${c.members.length} corrections cluster on "${clusterLabel(c)}"`,
      evidence: c.members.slice(0, 3),
      // weight corrections above raw failure counts — human-authored signal.
      severity: c.members.length * 4,
      count: c.members.length
    })
  }

  // 3. Calibration — a prediction kind whose hit-rate is low over a real sample.
  for (const c of inp.calibration ?? []) {
    if (c.resolved < MIN_RESOLVED || c.hitRate >= CALIBRATION_FLOOR) continue
    gaps.push({
      id: `calib:${c.kind}`,
      kind: 'calibration',
      title: `${c.kind} predictions hit ${(c.hitRate * 100).toFixed(0)}% (n=${c.resolved})`,
      evidence: [`hit_rate ${c.hitRate.toFixed(2)} over ${c.resolved} resolved`],
      severity: (1 - c.hitRate) * c.resolved * 3,
      count: c.resolved
    })
  }

  return gaps.sort((a, b) => b.severity - a.severity)
}
