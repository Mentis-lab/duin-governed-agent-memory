// reveal-outcomes.ts — the CALIBRATION domain for "live node reveal": per-(source, edge-type) trust.
//
// Each propose->operator-outcome in a reveal is a calibration sample: the brain proposed an edge from a
// SOURCE (wiki|alias|sim|llm) at a CONFIDENCE; the operator ENDORSED (materialized) or VETOED (refuted).
// Aggregated per kind = `${source}:${edgeType}`, the Wilson lower bound is exactly "how much should DUIN
// trust this source for this edge-type" — the number the autonomy governor reads to decide auto-accept
// vs surface-for-review (see PLANNING/DUIN_LIVE_NODE_REVEAL_DESIGN.md, Governance section).
//
// Append-only jsonl under .duin/_state, mirroring promotion-retention. The canonical reader
// (calRowsReveal) lives in calibration-native.ts alongside the other domains so these outcomes also
// flow into calibration().domains + the fitness vector; revealTrust() here is the direct per-kind read
// for the governor, computed with the SAME Wilson lower bound + CAL_MIN_N gate as the rest of calibration.

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { wilson, CAL_MIN_N } from './calibration-resolve-native'

const revealOutcomesPath = (vault: string): string => join(vault, '.duin', '_state', 'reveal-outcomes.jsonl')

export type EdgeSource = 'wiki' | 'alias' | 'sim' | 'llm'
/** materialized = the operator endorsed the proposal; refuted = the operator vetoed it. */
export type RevealVerdict = 'materialized' | 'refuted'

export interface RevealOutcomeRecord {
  /** the calibration kind, `${source}:${edgeType}` (e.g. "llm:contradicts") */
  kind: string
  source: EdgeSource
  edgeType: string
  /** the proposed confidence (0..1) at reveal time */
  confidence: number
  verdict: RevealVerdict
  ts: string
  /** optional edge provenance (from|to), for audit — not used by scoring */
  from?: string
  to?: string
}

/** The calibration kind key for an edge's source + type. */
export function revealKind(source: EdgeSource, edgeType: string): string {
  return source + ':' + edgeType
}

/** WRITER — append a resolved reveal outcome (ensures the state dir exists). */
export function registerRevealOutcome(vault: string, rec: RevealOutcomeRecord): void {
  const path = revealOutcomesPath(vault)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(rec) + '\n', 'utf-8')
}

/** Read the reveal-outcomes ledger (missing ⇒ []). */
export function readRevealOutcomes(vault: string): RevealOutcomeRecord[] {
  const path = revealOutcomesPath(vault)
  if (!existsSync(path)) return []
  const out: RevealOutcomeRecord[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as RevealOutcomeRecord)
    } catch {
      /* skip a corrupt row */
    }
  }
  return out
}

export interface RevealTrust {
  /** endorse rate, Beta(1,1)-smoothed like the other calibration domains */
  rate: number
  /** Wilson 95% lower bound — the conservative "trust" number the governor should act on */
  wilson_lo: number
  n: number
  /** true until n >= CAL_MIN_N — not enough evidence to act on yet */
  gated: boolean
}

/** PURE — per-kind (source:edgeType) trust from a set of outcome records. */
export function revealTrustFromOutcomes(records: RevealOutcomeRecord[]): Map<string, RevealTrust> {
  const agg = new Map<string, { k: number; n: number }>() // endorsed / total
  for (const r of records) {
    if (!r || !r.kind) continue
    const a = agg.get(r.kind) ?? { k: 0, n: 0 }
    a.n++
    if (r.verdict === 'materialized') a.k++
    agg.set(r.kind, a)
  }
  const out = new Map<string, RevealTrust>()
  for (const [kind, { k, n }] of agg) {
    out.set(kind, { rate: (k + 1) / (n + 2), wilson_lo: wilson(k, n)[0] ?? 0, n, gated: n < CAL_MIN_N })
  }
  return out
}

/** Per-kind trust read straight from the vault ledger — the direct read for the autonomy governor. */
export function revealTrust(vault: string): Map<string, RevealTrust> {
  return revealTrustFromOutcomes(readRevealOutcomes(vault))
}
