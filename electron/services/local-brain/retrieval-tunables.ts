// retrieval-tunables.ts — the RETRIEVAL action space: the ranking constants that were previously
// hardcoded in index-store.ts, lifted into ONE bounded, clamped-on-read config object.
//
// WHY this exists. Every knob below was a source constant, so the only way to try a different value
// was to edit and rebuild — which is why they were tuned once, by hand, on whatever corpus happened
// to be in front of the author, and then never revisited. That has already cost measured recall:
// graph-expand-retrieve's `alpha`/`beta`/`hubDfCap` were "tuned on 10-20-note corpora" and measured
// -9.0pp recall@5 against plain RRF fusion on the real vault (see graph-expand-adapt.ts). Constants
// that cannot be varied cannot be measured, and constants that cannot be measured drift wrong.
//
// This is deliberately NOT a settings-UI surface. It is a machine-writable search space: bounded on
// every dimension, clamped on read, and byte-identical to the previous hardcoded behavior when the
// file is absent. Missing file => DEFAULTS => today's behavior exactly. That property is what makes
// it safe to ship default-inert.
//
// Mirrors brain/rsi-tunables.ts (same clamp-on-read contract, same .duin/_state home) so the RSI
// proposer can eventually treat these as additional knobs without a second config mechanism.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface RetrievalTunables {
  /** hits returned by search() into the grounding context. The single most-implicated knob:
   *  the live call site uses 6 while comparable systems retrieve ~20-30. clamp [3,30]. */
  searchK: number
  /** recall pool = max(searchK * poolMultiplier, poolFloor). Over-fetch breadth per leg. clamp [2,15]. */
  poolMultiplier: number
  /** floor on the recall pool so a small k still over-fetches enough to fuse. clamp [10,120]. */
  poolFloor: number
  /** weighted-RRF weight on the LEXICAL (BM25) leg. clamp [0.1,5]. */
  fuseWLex: number
  /** weighted-RRF weight on the VECTOR leg. clamp [0.1,5]. */
  fuseWVec: number
  /** RRF rank-flattening constant; higher = flatter (rank differences matter less). clamp [1,200]. */
  fuseK: number
  /** max multiplicative temporal-recency boost on the fused score. 0 disables. clamp [0,1]. */
  recencyMaxBoost: number
  /** age in days at which the recency boost halves. clamp [1,365]. */
  recencyHalfLifeDays: number
}

/** Byte-identical to the constants these replaced (index-store.ts search/fuseSearchHits). */
export const RETRIEVAL_TUNABLE_DEFAULTS: RetrievalTunables = {
  searchK: 6,
  poolMultiplier: 5,
  poolFloor: 30,
  fuseWLex: 2.0,
  fuseWVec: 1.0,
  fuseK: 60,
  recencyMaxBoost: 0.15,
  recencyHalfLifeDays: 30
}

type Bound = { min: number; max: number; int: boolean }

export const RETRIEVAL_TUNABLE_BOUNDS: Record<keyof RetrievalTunables, Bound> = {
  searchK: { min: 3, max: 30, int: true },
  poolMultiplier: { min: 2, max: 15, int: true },
  poolFloor: { min: 10, max: 120, int: true },
  fuseWLex: { min: 0.1, max: 5, int: false },
  fuseWVec: { min: 0.1, max: 5, int: false },
  fuseK: { min: 1, max: 200, int: true },
  recencyMaxBoost: { min: 0, max: 1, int: false },
  recencyHalfLifeDays: { min: 1, max: 365, int: false }
}

export function retrievalTunablesPath(vault: string): string {
  return join(vault, '.duin', '_state', 'retrieval-tunables.json')
}

/** Clamp one value into its bound. Non-finite => default. Rounds when the bound is integral. */
export function clampTunable(key: keyof RetrievalTunables, v: unknown): number {
  const b = RETRIEVAL_TUNABLE_BOUNDS[key]
  const dflt = RETRIEVAL_TUNABLE_DEFAULTS[key]
  const raw = Number(v)
  if (!Number.isFinite(raw)) return dflt
  // Float dimensions are rounded to 4dp. Not cosmetic: a sweep that steps 0.15 down by 0.05 lands on
  // 0.09999999999999999, which fingerprints differently from 0.1 — so the archive would fail to
  // recognise a cell it had already paid for, and re-measure it forever.
  const n = b.int ? Math.round(raw) : Math.round(raw * 10_000) / 10_000
  return Math.min(b.max, Math.max(b.min, n))
}

/** Clamp a whole (possibly partial, possibly hostile) object into the safe envelope. PURE. */
export function clampRetrievalTunables(raw: Partial<RetrievalTunables> | null | undefined): RetrievalTunables {
  const out = { ...RETRIEVAL_TUNABLE_DEFAULTS }
  if (!raw || typeof raw !== 'object') return out
  for (const key of Object.keys(RETRIEVAL_TUNABLE_DEFAULTS) as (keyof RetrievalTunables)[]) {
    if (raw[key] !== undefined) out[key] = clampTunable(key, raw[key])
  }
  return out
}

/** Read the tunables, CLAMPED. Missing/corrupt file => defaults (today's behavior). Never throws. */
export function readRetrievalTunables(vault: string | null): RetrievalTunables {
  if (!vault) return { ...RETRIEVAL_TUNABLE_DEFAULTS }
  try {
    const p = retrievalTunablesPath(vault)
    if (!existsSync(p)) return { ...RETRIEVAL_TUNABLE_DEFAULTS }
    return clampRetrievalTunables(JSON.parse(readFileSync(p, 'utf-8')) as Partial<RetrievalTunables>)
  } catch {
    return { ...RETRIEVAL_TUNABLE_DEFAULTS }
  }
}

/** True when every dimension still sits at its default — i.e. retrieval is in stock configuration. */
export function isDefaultRetrievalConfig(t: RetrievalTunables): boolean {
  return (Object.keys(RETRIEVAL_TUNABLE_DEFAULTS) as (keyof RetrievalTunables)[]).every(
    (k) => t[k] === RETRIEVAL_TUNABLE_DEFAULTS[k]
  )
}

/**
 * Stable, human-readable stamp of a config — the thing every benchmark artifact was missing.
 * A graded run that does not record WHICH config produced it cannot be compared to another run,
 * which is why the LongMemEval/LoCoMo config search had to be reconstructed from prose. Keys are
 * sorted so the same config always fingerprints identically.
 */
export function retrievalConfigFingerprint(t: RetrievalTunables): string {
  return (Object.keys(t) as (keyof RetrievalTunables)[])
    .sort()
    .map((k) => `${k}=${t[k]}`)
    .join(',')
}
