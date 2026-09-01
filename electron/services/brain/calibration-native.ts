// Native port of Python `calibration()` (server.py) — the honest, FEDERATED
// forecast scorecard across prediction domains (risk · decision-window · stream ·
// plan-adherence · promotion). Read-only: each domain reads its OWN .duin/_state
// file (no merged ledger, single-writer invariant preserved). Tier rates are
// Beta(1,1)-smoothed + Wilson-95 + gated below min_n; human false-alarm feedback
// is overlaid so a confirmed false alarm counts against 'useful'.
//
// SKIPPED side effect (per unification §2): Python calls resolve_risk_ledger()
// first (idempotent RMW that refreshes verdicts). In steady state the stores are
// already resolved, so a pure read matches; parity is captured after one live hit.
// Reuses forecastRecord() for the generated/note/patterns/tier passthrough.
// Part of the brain unification (retire the Python engine); see DUIN_UNIFICATION_HANDOFF.

import { readFileSync } from 'fs'
import { join } from 'path'
import { forecastRecord } from './forecast-record-native'
import { messageOf } from '../guarded'

const CAL_MIN_N = 20 // below this many observed outcomes a rate is noise — gate it
const KIND_MODE: Record<string, string> = { 'decision-window': 'signal' }

function stateDir(vaultDir: string): string {
  return join(vaultDir, '.duin', '_state')
}

/** Read a .jsonl file → array of parsed objects, skipping blank/corrupt lines
 *  (mirrors Python's line-by-line json.loads with per-line try/except). */
function readJsonl(path: string): Record<string, unknown>[] {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return []
  }
  const out: Record<string, unknown>[] = []
  for (const raw of text.split(/\r?\n/)) {
    const ln = raw.trim()
    if (!ln) continue
    try {
      out.push(JSON.parse(ln) as Record<string, unknown>)
    } catch (e) { console.debug('[calibration-native] skip corrupt line:', messageOf(e)) }
  }
  return out
}

/** Python round(x, nd): round-half-to-even over the same IEEE-754 float x. */
function pyRound(x: number, nd: number): number {
  const m = Math.pow(10, nd)
  const y = x * m
  const f = Math.floor(y)
  const diff = y - f
  let r: number
  if (Math.abs(diff - 0.5) < 1e-9) {
    r = f % 2 === 0 ? f : f + 1 // tie → even
  } else {
    r = Math.round(y)
  }
  return r / m
}

/** 95% Wilson score interval for k 'useful' in n observed, or [null,null] if n=0. */
function wilson(k: number, n: number): [number | null, number | null] {
  if (!n) return [null, null]
  const z = 1.96
  const p = k / n
  const denom = 1 + (z * z) / n
  const center = p + (z * z) / (2 * n)
  const half = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)
  return [pyRound((center - half) / denom, 3), pyRound((center + half) / denom, 3)]
}

interface CalRow {
  domain: string
  id: string | null
  kind: string
  mode: string
  predicted: string
  confidence: unknown
  track: string
  verdict: unknown
  outcome: unknown
  resolved: string
  false_alarm?: boolean
  outcome_scored?: unknown
}

const str = (v: unknown): string => (v == null ? '' : String(v))
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v)

function calRowsRisk(vaultDir: string): CalRow[] {
  return readJsonl(join(stateDir(vaultDir), 'risk-predictions.jsonl')).map((r) => {
    const mode = KIND_MODE[str(r.kind)] ?? 'forecast'
    return {
      domain: mode === 'signal' ? 'decision-window' : 'risk',
      id: orNull(r.id as string | undefined),
      kind: str(r.kind),
      mode,
      predicted: str(r.predicted),
      confidence: orNull(r.confidence),
      track: str(r.track),
      verdict: orNull(r.verdict),
      outcome: orNull(r.outcome),
      resolved: str(r.resolved),
    }
  })
}

function calRowsStream(vaultDir: string): CalRow[] {
  const rows: CalRow[] = []
  for (const r of readJsonl(join(stateDir(vaultDir), 'stream-verdicts.jsonl'))) {
    const oc = str(r.outcome)
    if (r.kind === 'step') {
      rows.push({
        domain: 'plan-adherence',
        id: orNull(r.id as string | undefined),
        kind: 'step',
        mode: 'signal',
        predicted: 'step hits its planned date: ' + str(r.what).replace('step:', '').trim(),
        confidence: null,
        track: '',
        verdict: oc === 'hit' ? 'averted' : oc === 'miss' ? 'materialized' : 'unobserved',
        outcome: oc === 'hit' ? 'on-time' : oc === 'miss' ? 'slipped' : 'moot',
        resolved: str(r.ts),
      })
    } else {
      rows.push({
        domain: 'stream',
        id: orNull(r.id as string | undefined),
        kind: str(r.kind) || 'decision',
        mode: 'forecast',
        predicted: 'engaged by ' + str(r.what).replace('decide:', '').trim(),
        confidence: null,
        track: '',
        verdict: oc === 'hit' ? 'materialized' : oc === 'miss' ? 'missed' : 'unobserved',
        outcome: oc === 'hit' ? 'hit' : oc === 'miss' ? 'wrong' : 'unresolved',
        resolved: str(r.ts),
      })
    }
  }
  return rows
}

function calRowsPromotion(vaultDir: string): CalRow[] {
  return readJsonl(join(stateDir(vaultDir), 'promotion-predictions.jsonl')).map((r) => {
    const v = str(r.verdict).trim()
    const sig = (r.trigger_signature as Record<string, unknown>) || {}
    const pred = (r.expected_behavior as string) || (sig.value as string) || str(r.landed_in)
    const evalAfter = (r.eval_after as Record<string, unknown>) || {}
    return {
      domain: 'promotion',
      id: orNull(r.id as string | undefined),
      kind: 'rule-promotion',
      mode: 'forecast',
      predicted: ('rule holds: ' + String(pred)).slice(0, 160),
      confidence: null,
      track: '',
      verdict: v || null,
      outcome: v === 'passed' ? 'hit' : v === 'failed' ? 'wrong' : v ? 'unresolved' : null,
      resolved: str(evalAfter.by) || str(r.created),
    }
  })
}

function loadPredFeedback(vaultDir: string): Record<string, { mark: string; ts: string }> {
  const out: Record<string, { mark: string; ts: string }> = {}
  for (const o of readJsonl(join(stateDir(vaultDir), 'prediction-feedback.jsonl'))) {
    if (o.id) out[String(o.id)] = { mark: str(o.mark), ts: str(o.ts) }
  }
  return out
}

// Reveal (live-node-reveal): per-(source, edge-type) propose->outcome samples. verdict 'materialized'
// = operator endorsed the proposed edge (hit); 'refuted' = vetoed (wrong). kind = `${source}:${edgeType}`
// so resolveAndScore buckets trust per source AND edge-type. Written by reveal-outcomes.registerRevealOutcome.
function calRowsReveal(vaultDir: string): CalRow[] {
  return readJsonl(join(stateDir(vaultDir), 'reveal-outcomes.jsonl')).map((r) => {
    const v = str(r.verdict)
    return {
      domain: 'reveal',
      id: orNull(r.id as string | undefined),
      kind: str(r.kind) || str(r.source) + ':' + str(r.edgeType),
      mode: 'forecast',
      predicted: ('edge holds: ' + str(r.edgeType)).slice(0, 160),
      confidence: orNull(r.confidence),
      track: '',
      verdict: v === 'materialized' ? 'materialized' : v === 'refuted' ? 'refuted' : v || null,
      outcome: v === 'materialized' ? 'hit' : v === 'refuted' ? 'wrong' : null,
      resolved: str(r.ts),
    }
  })
}

// RSI forecast (rsi-forecast): did an RSI change's ex-ante predictedDelta land within tolerance of the
// measured actualDelta on the held-out A/B? hit = the magnitude forecast landed (useful), else wrong.
// Written by rsi-forecast-store.recordRsiForecast at adjudication; the Wilson-lo of the hit-rate is how
// well-modeled the brain's self-improvement moves are — read by proposeNextRsiKnob to prefer
// well-forecast configs. kind = 'knob-forecast' (single kind — per-cell attribution is the selector's
// job via forecastByConfig, not a calibration bucket).
function calRowsRsiForecast(vaultDir: string): CalRow[] {
  return readJsonl(join(stateDir(vaultDir), 'rsi-forecast.jsonl')).map((r) => {
    const hit = r.hit === true
    const res = str(r.resolved)
    return {
      domain: 'rsi-forecast',
      id: orNull(r.id as string | undefined),
      kind: 'knob-forecast',
      mode: 'forecast',
      predicted: ('delta ~ ' + str(r.predictedDelta)).slice(0, 160),
      confidence: null,
      track: '',
      verdict: res ? (hit ? 'hit' : 'wrong') : null,
      outcome: res ? (hit ? 'hit' : 'wrong') : null,
      resolved: res,
    }
  })
}

interface Domain {
  total: number
  resolved: number
  useful: number
  wrong: number
  signal: number
  false_alarms: number
  observed?: number
  useful_rate?: number | null
  smoothed_rate?: number | null
  wilson_lo?: number | null
  wilson_hi?: number | null
  gated?: boolean
}

export interface CalibrationResponse {
  generated: string
  min_n: number
  note: string
  domains: Record<string, Domain>
  patterns: Record<string, unknown>
  tier_calibration: Record<string, unknown>
  recently_resolved: unknown[]
  totals: {
    predictions: number
    resolved: number
    open: number
    false_alarms: number
    by_domain: Record<string, { total: number; resolved: number; useful_rate: number | null; gated: boolean }>
  }
}

const isResolved = (r: CalRow): boolean => {
  const v = r.verdict
  return !(v === null || v === undefined || v === 'null' || v === '')
}

/** Faithful port of server.py:calibration(). Pure fs (skips the resolve side effect). */
export function calibration(vaultDir: string | null, since?: string, until?: string): CalibrationResponse {
  const rec = forecastRecord(vaultDir) as Record<string, unknown>
  const fb = vaultDir ? loadPredFeedback(vaultDir) : {}
  const allRowsRaw: CalRow[] = vaultDir
    ? [...calRowsRisk(vaultDir), ...calRowsStream(vaultDir), ...calRowsPromotion(vaultDir), ...calRowsReveal(vaultDir), ...calRowsRsiForecast(vaultDir)]
    : []
  // Windowed fitness for the self-improvement held-out: `since`/`until` keep only outcomes
  // resolved in [since, until) (a change applied at T is scored on outcomes it could not have
  // overfit; symmetric pre/post windows around T are comparable at equal n, avoiding the
  // small-sample wilson_lo bias). Unresolved rows carry resolved='' and drop out under `since`.
  // Both undefined = full ledger — the read-lane's unchanged behavior.
  const allRows: CalRow[] =
    since || until ? allRowsRaw.filter((r) => (!since || r.resolved >= since) && (!until || r.resolved < until)) : allRowsRaw

  for (const r of allRows) {
    const m = fb[str(r.id)]
    r.false_alarm = Boolean(m && m.mark === 'false_alarm')
    r.outcome_scored =
      r.false_alarm && (r.outcome === 'hit' || r.outcome === 'useful' || r.outcome === 'on-time')
        ? 'wrong'
        : r.outcome
  }

  const domains: Record<string, Domain> = {}
  for (const r of allRows) {
    const d = (domains[r.domain] ??= { total: 0, resolved: 0, useful: 0, wrong: 0, signal: 0, false_alarms: 0 })
    d.total += 1
    if (r.mode === 'signal') d.signal += 1
    if (isResolved(r)) {
      d.resolved += 1
      if (r.false_alarm) d.false_alarms += 1
      if (r.mode === 'signal') {
        // The false-alarm override above rewrites a signal-mode 'on-time' outcome to the
        // literal 'wrong' — the SAME literal the non-signal branch below already treats as
        // a miss. This branch used to test only the two outcomes calRowsStream/calRowsRisk
        // emit natively ('on-time'/'slipped') and never the override's output, so a false-
        // alarmed signal row satisfied neither arm here: d.resolved still counted it (above)
        // but neither d.useful nor d.wrong did, shrinking d.observed instead of moving the
        // unit from useful to wrong. Invisible because the two failure modes were each
        // covered by their own test (signal-mode scoring; false-alarm override) but never
        // together, so nothing exercised a false-alarmed signal-mode row.
        if (r.outcome_scored === 'on-time') d.useful += 1
        else if (r.outcome_scored === 'slipped' || r.outcome_scored === 'wrong') d.wrong += 1
      } else if (r.outcome_scored === 'hit' || r.outcome_scored === 'useful') {
        d.useful += 1
      } else if (r.outcome_scored === 'wrong' || r.outcome_scored === 'miss') {
        d.wrong += 1
      }
    }
  }
  for (const d of Object.values(domains)) {
    const obs = d.useful + d.wrong
    d.observed = obs
    d.useful_rate = obs ? pyRound(d.useful / obs, 3) : null
    d.smoothed_rate = obs ? pyRound((d.useful + 1) / (obs + 2), 3) : null
    ;[d.wilson_lo, d.wilson_hi] = wilson(d.useful, obs)
    d.gated = obs < CAL_MIN_N
  }

  const resolved = allRows.filter(isResolved)
  resolved.sort((a, b) => {
    const ka = a.resolved || ''
    const kb = b.resolved || ''
    return ka < kb ? 1 : ka > kb ? -1 : 0 // reverse=True (descending), stable on ties
  })
  const nudge = resolved.slice(0, 25).map((r) => ({
    id: r.id,
    domain: r.domain,
    kind: r.kind,
    mode: r.mode,
    predicted: r.predicted,
    confidence: r.confidence,
    track: r.track,
    verdict: r.verdict,
    outcome: r.outcome,
    false_alarm: r.false_alarm,
    resolved: r.resolved,
  }))
  const totals = {
    predictions: allRows.length,
    resolved: resolved.length,
    open: allRows.length - resolved.length,
    false_alarms: resolved.filter((r) => r.false_alarm).length,
    by_domain: Object.fromEntries(
      Object.entries(domains).map(([k, v]) => [
        k,
        { total: v.total, resolved: v.resolved, useful_rate: v.useful_rate ?? null, gated: v.gated ?? false },
      ])
    ),
  }
  return {
    generated: (rec.generated as string) ?? '',
    min_n: CAL_MIN_N,
    note: (rec.note as string) ?? '',
    domains,
    patterns: (rec.patterns as Record<string, unknown>) ?? {},
    tier_calibration: (rec.confidence_calibration as Record<string, unknown>) ?? {},
    recently_resolved: nudge,
    totals,
  }
}
