// calibration-weight — the FEEDBACK wire: reads forecast-track-record.json into
// per-kind empirical rates so the forecast generator can weight/rank connections by
// how often that KIND has actually proven useful. This is the "connections that
// adjust over time to instruct judgment" mechanism (the convergence-engine north
// star): a kind that keeps materializing strengthens; one that never bites decays.
// Honest by construction — a kind below min_n observations is GATED (keep the prior,
// don't manufacture confidence you can't support).
import { readFileSync } from 'fs'
import { join } from 'path'
import { CAL_MIN_N, COUPLING_KINDS } from './calibration-resolve-native'
import { messageOf } from '../guarded'

export interface KindRate {
  rate: number | null // empirical useful_rate (forecast) / efficacy_rate (signal); null if unobserved
  observed: number
  gated: boolean // observed < min_n → insufficient data, use the prior not the rate
}

/**
 * The empirical "how often was this KIND right" rate from a track-record pattern —
 * the SINGLE SOURCE OF TRUTH so the feedback wire (loadKindRates) and the display
 * projection (index.ts getCalibration) can never disagree (the E1 parity invariant).
 * Which rate is correct depends on the kind's framing:
 *   • signal (decision-window) → efficacy_rate (decided-on-time / resolved).
 *   • COUPLING (driver/convergence/cascade) → useful_rate. Their statement is "these
 *     streams move together": co-moving to resolution (averted) CONFIRMS the coupling;
 *     diverging (refuted) falsifies it; materialized never fires (see resolveCoupling).
 *     So the honest success rate is averted/(averted+refuted) = useful_rate. hit_rate is
 *     materialized-only → a permanent 0 for coupling → it would zero their confidence in a
 *     skilled ledger and discard the confirmed-useful signal. The old "useful_rate pins
 *     subjects-bearing kinds ~1.0 → inert" worry held under the pre-fix rule where averted
 *     was rare and refuted impossible; now refuted fires on divergence, so useful_rate
 *     carries real, non-pinned signal.
 *   • other forecast kinds (operator-logged risk/materialization framing) → hit_rate, where
 *     an AVERTED forecast means the predicted event did NOT occur (the forecast was wrong).
 */
export function empiricalRateForKind(kind: string, p: Record<string, unknown>): number | null {
  const raw =
    p.mode === 'signal' ? p.efficacy_rate : COUPLING_KINDS.has(kind) ? p.useful_rate : p.hit_rate
  return typeof raw === 'number' ? raw : null
}

/** kind → empirical rate from the calibration track record. Gated below min_n. */
export function loadKindRates(vaultDir: string | null, minN = CAL_MIN_N): Map<string, KindRate> {
  const m = new Map<string, KindRate>()
  if (!vaultDir) return m
  try {
    const tr = JSON.parse(
      readFileSync(join(vaultDir, '.duin', '_state', 'forecast-track-record.json'), 'utf-8')
    ) as { patterns?: Record<string, Record<string, unknown>> }
    for (const [kind, p] of Object.entries(tr.patterns ?? {})) {
      const observed = Number(p.materialized ?? 0) + Number(p.averted ?? 0) + Number(p.refuted ?? 0)
      m.set(kind, { rate: empiricalRateForKind(kind, p), observed, gated: observed < minN })
    }
  } catch (e) { console.debug('[calibration-weight] no track record yet  empty map  every kind uses its prior:', messageOf(e)) }
  return m
}
