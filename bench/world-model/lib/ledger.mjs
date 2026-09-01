// Shared ledger loader + scoring primitives for the DUIN world-model benchmark loop (Stage 0).
//
// RECONCILED SEMANTICS — this resolves the TODO left in score-calibration.mjs ("exact per-kind
// binary semantics should be reconciled with the resolver"). The rules below mirror the app's
// own authority, electron/services/brain/calibration-scoring.ts:
//
//   * SIGNAL-MODE kinds (decision-window) are EXCLUDED from proper scoring. The app demotes them
//     with the comment "a deadline reminder, not a forecast" (predicted-risks-native.ts). They are
//     scored separately here as EFFICACY (decided-on-time vs slipped), never mixed into Brier.
//   * materialized | hit -> 1
//   * averted -> 1 for the STRUCTURAL kinds (driver, convergence), where averted means the
//     structure HELD; -> 0 for risk/event kinds, where averted means the threat did not happen.
//   * refuted | miss -> 0
//   * unobserved | moot | open -> excluded (unresolved)
//
// Why this matters: scoring both populations together conflates a 0.851 efficacy rate over ~200
// deadline reminders with a probabilistic Brier over a handful of real forecasts. They are
// different quantities and the headline number must never borrow the other's n.
//
// ZERO app imports, ZERO enactment. Read-and-score only.

import { readFileSync } from 'node:fs'

/** Kinds the app scores as efficacy, not probability (calibration-scoring.ts SIGNAL_KINDS). */
export const SIGNAL_KINDS = new Set(['decision-window'])
/** Kinds where `averted` means the structure HELD = a correct positive (AVERTED_MEANS_HELD). */
export const AVERTED_MEANS_HELD = new Set(['driver', 'convergence'])

const POSITIVE_EFFICACY = new Set(['on-time', 'decided-on-time', 'decided', 'useful', 'hit'])
const NEGATIVE_EFFICACY = new Set(['slipped', 'wrong', 'false-alarm', 'false_alarm'])

export function loadLedger(path) {
  const out = []
  let malformed = 0
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s))
    } catch {
      malformed++
    }
  }
  return { rows: out, malformed }
}

const clamp01 = (x) => Math.min(1, Math.max(0, x))
const conf = (r) =>
  typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? clamp01(r.confidence) : null

/** The proper-scorable population: probabilistic forecasts only, app-parity outcome mapping. */
export function properSet(rows) {
  const out = []
  for (const r of rows) {
    const kind = String(r.kind ?? '').toLowerCase()
    if (SIGNAL_KINDS.has(kind)) continue
    const c = conf(r)
    if (c == null) continue
    const v = String(r.verdict ?? r.resolution ?? '').toLowerCase()
    let y
    if (v === 'materialized' || v === 'hit') y = 1
    else if (v === 'averted') y = AVERTED_MEANS_HELD.has(kind) ? 1 : 0
    else if (v === 'refuted' || v === 'miss') y = 0
    else continue // unobserved / moot / open
    out.push({ p: c, y, kind, at: r.resolved ?? r.created ?? null, id: r.id ?? null })
  }
  return out
}

/** The signal-mode population: efficacy (did the decision land on time), NOT a probability. */
export function signalSet(rows) {
  const out = []
  for (const r of rows) {
    const kind = String(r.kind ?? '').toLowerCase()
    if (!SIGNAL_KINDS.has(kind)) continue
    const o = String(r.outcome ?? r.verdict ?? '').toLowerCase()
    let y
    if (POSITIVE_EFFICACY.has(o) || o === 'averted') y = 1
    else if (NEGATIVE_EFFICACY.has(o) || o === 'materialized') y = 0
    else continue // moot / unobserved / unresolved
    out.push({ p: conf(r), y, kind, at: r.resolved ?? r.created ?? null, id: r.id ?? null })
  }
  return out
}

// ---- scoring primitives (pure) ----

export function wilsonLo(k, n, z = 1.96) {
  if (!n) return null
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)
  return Math.max(0, (c - m) / d)
}

export const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d))

/** Brier / base-rate Brier / Murphy skill / ECE / log-loss over {p,y} rows.
 *  `minN` gates the DEFENSIBLE claim (skill) to null on a thin sample — the same honesty
 *  discipline the app applies, so an 8-row ledger cannot announce a skill score. */
export function properScore(rows, { bins = 10, minN = 20 } = {}) {
  const n = rows.length
  if (!n) return { n: 0, baseRate: null, brier: null, baselineBrier: null, skillScore: null, ece: null, logLoss: null, reliability: [], gated: true }
  const baseRate = rows.reduce((s, r) => s + r.y, 0) / n
  const brier = rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / n
  const baselineBrier = baseRate * (1 - baseRate)
  const skill = baselineBrier > 0 ? 1 - brier / baselineBrier : null
  const eps = 1e-12
  const logLoss =
    -rows.reduce((s, r) => {
      const p = Math.min(1 - eps, Math.max(eps, r.p))
      return s + (r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p))
    }, 0) / n
  const bucket = Array.from({ length: bins }, () => ({ n: 0, sp: 0, sy: 0 }))
  for (const r of rows) {
    const i = Math.min(bins - 1, Math.floor(r.p * bins))
    bucket[i].n++
    bucket[i].sp += r.p
    bucket[i].sy += r.y
  }
  let ece = 0
  const reliability = []
  bucket.forEach((b, i) => {
    if (!b.n) return
    const avgP = b.sp / b.n
    const avgY = b.sy / b.n
    ece += (b.n / n) * Math.abs(avgP - avgY)
    reliability.push({ bin: `${(i / bins).toFixed(1)}-${((i + 1) / bins).toFixed(1)}`, n: b.n, avgP: round(avgP, 3), avgY: round(avgY, 3) })
  })
  const gated = n < minN
  return {
    n,
    baseRate: round(baseRate),
    brier: round(brier),
    baselineBrier: round(baselineBrier),
    // Gated: below minN the skill claim is withheld, not estimated.
    skillScore: gated ? null : round(skill),
    skillUngated: round(skill),
    ece: round(ece),
    logLoss: round(logLoss),
    reliability,
    gated,
    // Distinct confidence levels — a near-constant predictor cannot be probability-calibrated
    // however good its hit rate is. This is the diagnostic behind "rate-calibrated, not
    // probability-calibrated".
    distinctConfidences: new Set(rows.map((r) => r.p)).size
  }
}

/** Rate + Wilson lower bound for an efficacy population (no probability involved). */
export function efficacyScore(rows) {
  const n = rows.length
  if (!n) return { n: 0, rate: null, wilsonLo: null }
  const k = rows.reduce((s, r) => s + r.y, 0)
  return { n, positives: k, rate: round(k / n), wilsonLo: round(wilsonLo(k, n)) }
}

/** Ordinary-least-squares slope of y over x. Returns null for < 3 points.
 *  Accepts an optional per-point weight `w` (default 1). Weighting MATTERS here: periods carry
 *  wildly different sample counts (a 3-row week next to a 90-row week), and an unweighted fit
 *  lets a near-empty period swing the trend as hard as a full one. The weighted slope is the
 *  defensible headline; the unweighted one is reported alongside so the gap is visible. */
export function olsSlope(points) {
  if (points.length < 3) return null
  const W = points.reduce((s, p) => s + (p.w ?? 1), 0)
  if (W === 0) return null
  const mx = points.reduce((s, p) => s + (p.w ?? 1) * p.x, 0) / W
  const my = points.reduce((s, p) => s + (p.w ?? 1) * p.y, 0) / W
  let num = 0
  let den = 0
  for (const p of points) {
    const w = p.w ?? 1
    num += w * (p.x - mx) * (p.y - my)
    den += w * (p.x - mx) ** 2
  }
  return den === 0 ? null : num / den
}

export const byDate = (a, b) => String(a.at ?? '').localeCompare(String(b.at ?? ''))
