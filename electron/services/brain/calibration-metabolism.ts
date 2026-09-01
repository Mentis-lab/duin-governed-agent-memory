// calibration-metabolism — the THIRD client of the metabolism substrate: the currency axis on
// the calibration engine. `loadKindRates` gives each fact/forecast KIND a LIFETIME empirical
// useful-rate — but a lifetime average silently mixes evidence from a year ago with last week's,
// so a kind whose track record is all OLD reflects who you WERE, not who you are (concept drift).
// This surfaces, per kind, how RECENT its evidence is and flags rates built on stale evidence, so
// calibration can be trusted by currency, not just by count. SHADOW — it annotates, it does not
// change the live gating (that flip is a later, separately-gated step).
//
// Reuses loadKindRates verbatim (no re-implementation of the useful-rate scoring) + reads the
// resolved rows only for their dates. Same half-life idea as the graph (HALO); deterministic.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { loadKindRates, type KindRate } from './calibration-weight'
import { messageOf } from '../guarded'

const DAY = 86_400_000
export const CAL_HALF_LIFE_DAYS = 90 // a quarter — evidence older than this is discounted

interface ResolvedRow {
  kind: string
  resolvedMs: number
}

/** Read resolved rows from risk-predictions.jsonl for their kind + resolution date only. */
export function loadResolvedRows(vaultDir: string): ResolvedRow[] {
  const p = join(vaultDir, '.duin', '_state', 'risk-predictions.jsonl')
  if (!existsSync(p)) return []
  const out: ResolvedRow[] = []
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const r = JSON.parse(t) as { kind?: string; resolved?: string }
      if (!r.resolved) continue
      const ms = Date.parse(r.resolved)
      if (Number.isNaN(ms)) continue
      out.push({ kind: r.kind ?? 'unknown', resolvedMs: ms })
    } catch (e) { console.debug('[calibration-metabolism] skip a corrupt line:', messageOf(e)) }
  }
  return out
}

export interface KindCurrency {
  kind: string
  rate: number | null
  observed: number
  gated: boolean
  newestDaysAgo: number | null // days since the most recent resolution for this kind
  currency: number // e^(-ln2·Δt/halfLife) on the newest evidence — 1=fresh, →0=stale
  stale: boolean // newest evidence older than the half-life
}

export interface CalibrationMetabolism {
  halfLifeDays: number
  kinds: KindCurrency[]
  fresh: number
  stale: number
}

/** PURE: fold lifetime rates + resolution dates into a per-kind currency view. */
export function computeCalibrationMetabolism(
  rates: Map<string, KindRate>,
  rows: ResolvedRow[],
  now: number,
  halfLifeDays = CAL_HALF_LIFE_DAYS
): CalibrationMetabolism {
  const newestByKind = new Map<string, number>()
  for (const r of rows) {
    const cur = newestByKind.get(r.kind)
    if (cur === undefined || r.resolvedMs > cur) newestByKind.set(r.kind, r.resolvedMs)
  }
  const hlMs = halfLifeDays * DAY
  const kinds: KindCurrency[] = []
  for (const [kind, kr] of rates) {
    const newest = newestByKind.get(kind)
    const daysAgo = newest === undefined ? null : Math.max(0, Math.round((now - newest) / DAY))
    const currency = newest === undefined ? 0 : Math.pow(0.5, Math.max(0, now - newest) / hlMs)
    kinds.push({
      kind,
      rate: kr.rate,
      observed: kr.observed,
      gated: kr.gated,
      newestDaysAgo: daysAgo,
      currency: Number(currency.toFixed(3)),
      stale: !kr.gated && daysAgo !== null && daysAgo > halfLifeDays
    })
  }
  kinds.sort((a, b) => a.currency - b.currency) // stalest first — the ones to distrust
  return {
    halfLifeDays,
    kinds,
    fresh: kinds.filter((k) => !k.gated && !k.stale && k.rate !== null).length,
    stale: kinds.filter((k) => k.stale).length
  }
}

export function runCalibrationMetabolism(vaultDir: string | null, now = Date.now()): CalibrationMetabolism {
  if (!vaultDir) return { halfLifeDays: CAL_HALF_LIFE_DAYS, kinds: [], fresh: 0, stale: 0 }
  return computeCalibrationMetabolism(loadKindRates(vaultDir), loadResolvedRows(vaultDir), now)
}

/**
 * FUSE WS2.3 — `loadKindRates` with the currency axis folded into the gate: a kind whose newest
 * evidence is older than the half-life is GATED (stale evidence should not instruct judgment even
 * past min_n). Lives here (not in calibration-weight) to keep the dependency one-way — metabolism
 * imports weight, not the reverse. Best-effort: a metabolism failure falls back to the plain,
 * un-currency-gated rates, so this can never break rate loading. Pure but for the fs reads it wraps.
 */
/** PURE: a copy of `rates` with each kind the metabolism flagged `stale` set to `gated: true`
 *  (stale evidence should not instruct judgment even past min_n). Fresh kinds pass through. */
export function gateStaleKinds(rates: Map<string, KindRate>, meta: CalibrationMetabolism): Map<string, KindRate> {
  const out = new Map(rates)
  for (const k of meta.kinds) {
    if (k.stale) {
      const r = out.get(k.kind)
      if (r && !r.gated) out.set(k.kind, { ...r, gated: true })
    }
  }
  return out
}

export function loadKindRatesWithCurrency(vaultDir: string | null, now = Date.now()): Map<string, KindRate> {
  const rates = loadKindRates(vaultDir)
  if (!vaultDir) return rates
  try {
    return gateStaleKinds(rates, computeCalibrationMetabolism(rates, loadResolvedRows(vaultDir), now))
  } catch {
    return rates // best-effort — a metabolism failure must not break rate loading
  }
}
