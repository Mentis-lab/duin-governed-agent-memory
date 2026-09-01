// calibration-resolve — TS port of server.py:_resolve_risk_ledger_unlocked, the
// RESOLVE+SCORE half of the calibration loop (the MOAT). PURE: (ledger rows +
// open ids + today) → resolved rows + recomputed track record. No file I/O here —
// the read/write wiring is deliberately separate so this can be tested + parity-
// verified without touching the two-writer'd ledger. Owning this in TS is what
// lets DUIN's calibration loop be self-contained (log→resolve→score all native),
// closing the transitional two-writer state forecast-ledger.ts opened.
//
// Resolution (kind-agnostic for subjects-bearing rows): a row past eval_after
// materializes iff any subject is still open, else averts; subjects-empty rows
// honor an operator resolution (hit/miss/moot) or stay open. Scoring: per-kind
// patterns + per-confidence-tier rates, Beta(1,1)-smoothed + Wilson-95% gated
// below min_n. Signal-mode kinds (decision-window) scored on efficacy, not tiers.

export const CAL_MIN_N = 20
export const KIND_MODE: Record<string, string> = { 'decision-window': 'signal' }

// Multi-subject COUPLING forecasts (forecast-generator: driver / convergence / cascade)
// claim their subjects share a common cause and therefore move TOGETHER. Their subjects
// are long-lived stream/task ids that stay open the entire eval window, so the old rule
// ("any subject still open → materialized") made EVERY such forecast a trivial hit —
// the record-inflation the calibration panel named. resolveCoupling below tests actual
// co-movement instead, which is falsifiable (it can MISS). Kept to these known kinds so
// nothing else changes; n≤1 subjects-bearing rows keep the legacy persistence rule.
export const COUPLING_KINDS = new Set(['driver', 'convergence', 'cascade'])
// A minority this large (≥ a third of subjects) on the opposite side of open/closed is a
// genuine divergence → the common-cause claim is falsified. Below it, a lone stray in a
// larger set is read as noise and the majority direction wins.
export const COUPLING_DIVERGENCE_MIN = 0.33

/**
 * Falsifiable resolution for an n≥2 coupling forecast from its subjects' open/closed
 * fate. PURE. Verdicts and why:
 *   • all open   → 'unobserved' — no falsifiable movement; "still open" is uninformative
 *                  (streams just didn't resolve in the window). A scoring NO-OP, so it
 *                  can never inflate the hit rate. THIS is what replaces the old auto-hit.
 *   • all closed → 'averted'    — the subjects resolved together → coupling confirmed useful.
 *   • real split → 'refuted'    — subjects did NOT share fate → common-cause hypothesis
 *                  falsified (a MISS the old openness rule could never produce).
 *   • stray split→ majority read (mostly-closed → 'averted'; mostly-open → 'unobserved').
 * Note: a coupling forecast never yields 'materialized' — a driver "hit" isn't observable
 * from open/closed state alone, so we don't claim one (honesty-by-construction).
 */
export function resolveCoupling(subjects: string[], openIds: Set<string>): string {
  const n = subjects.length
  const open = subjects.reduce((acc, s) => acc + (openIds.has(s) ? 1 : 0), 0)
  const closed = n - open
  if (open === n) return 'unobserved'
  if (closed === n) return 'averted'
  const divergence = Math.min(open, closed) / n
  if (divergence >= COUPLING_DIVERGENCE_MIN) return 'refuted'
  return closed > open ? 'averted' : 'unobserved'
}

export interface LedgerRow {
  id?: string
  kind?: string
  verdict?: string | null
  subjects?: string[]
  confidence?: number
  eval_after?: { by?: string }
  outcome?: string
  error?: unknown
  resolution?: string
  resolved?: string
  [k: string]: unknown
}
type Tier = 'high' | 'med' | 'low' | 'untagged'
export interface ResolveResult {
  rows: LedgerRow[]
  patterns: Record<string, Record<string, unknown>>
  confidence_calibration: Record<Tier, Record<string, unknown>>
  resolved_this_run: number
  dirty: boolean
}

const isoOf = (d: Date): string => d.toISOString().slice(0, 10)
/** Python round(x, nd): round-half-to-even over the IEEE double. */
export function pyRound(x: number, nd = 3): number {
  if (!isFinite(x)) return x
  const m = 10 ** nd
  const s = x * m
  const fl = Math.floor(s)
  const diff = s - fl
  let r: number
  if (Math.abs(diff - 0.5) < 1e-9) r = fl % 2 === 0 ? fl : fl + 1 // half → even
  else r = Math.round(s)
  return r / m
}
/** 95% Wilson score interval for k useful in n observed (matches server.py:_wilson). */
export function wilson(k: number, n: number): [number | null, number | null] {
  if (!n) return [null, null]
  const z = 1.96
  const p = k / n
  const denom = 1 + (z * z) / n
  const center = p + (z * z) / (2 * n)
  const half = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)
  return [pyRound((center - half) / denom, 3), pyRound((center + half) / denom, 3)]
}
const tierOf = (c: unknown): Tier =>
  typeof c === 'number' ? (c >= 0.85 ? 'high' : c >= 0.5 ? 'med' : 'low') : 'untagged'

const SIGNAL_NOTE =
  'signal (decision-window) efficacy = decided-on-time / resolved windows (falsifiable, not a forecast)'

export function resolveAndScore(
  rows: LedgerRow[],
  openIds: Set<string>,
  today: Date,
  opts: { forecastObservable?: boolean; minN?: number } = {}
): ResolveResult {
  const todayIso = isoOf(today)
  const observable = opts.forecastObservable ?? true
  const minN = opts.minN ?? CAL_MIN_N
  let dirty = false
  let resolvedNow = 0

  // One-time REOPEN: a subjects-empty forecast the pre-observable default buried as
  // "unobserved" (no operator resolution) is reopened so the observable path can adjudicate.
  if (observable) {
    for (const r of rows) {
      if (
        r.verdict === 'unobserved' &&
        !(r.resolution || '') &&
        !(r.subjects || []).length &&
        (KIND_MODE[r.kind ?? ''] ?? 'forecast') !== 'signal'
      ) {
        r.verdict = null
        delete r.resolved
        dirty = true
      }
    }
  }

  const resolve = (r: LedgerRow): string | null => {
    const by = r.eval_after?.by || ''
    if (!by || by >= todayIso) return null // not past its eval date → stay open
    const subjects = r.subjects || []
    if (!subjects.length) {
      if (!observable || (KIND_MODE[r.kind ?? ''] ?? 'forecast') === 'signal') return 'unobserved'
      const res = (r.resolution || '').trim().toLowerCase()
      if (res === 'hit') return 'materialized'
      if (res === 'miss') return 'refuted'
      if (res === 'moot' || res === 'unobservable' || res === 'unobserved') return 'unobserved'
      return null // no verdict yet → stay OPEN for adjudication
    }
    // n===1 is not a co-movement claim → keep the legacy persistence rule (still-open =
    // the lone subject persisted). n≥2 coupling forecasts get the falsifiable test above.
    if (subjects.length >= 2 && COUPLING_KINDS.has(r.kind ?? '')) {
      return resolveCoupling(subjects, openIds)
    }
    // HONEST decision-window grading (P4a, 2026-07) — the signal analog of the resolveCoupling
    // de-inflation. A decision-window's subject is its stream id; a stream leaves open_ids for
    // ANY reason (decided, dropped, archived, aged out), so the old "closed → averted" rule
    // handed a free ON-TIME credit to every close — the self-graded 0.887. A close is NOT proof
    // an on-time decision was recorded. So:
    //   • an explicit operator resolution is honoured first (the genuine recorded outcome):
    //       hit → 'averted' (decided on time) · miss → 'materialized' (slipped)
    //   • still-OPEN past the eval date → 'materialized' (slipped — observably NOT decided; a
    //       real, falsifiable MISS that correctly counts AGAINST efficacy)
    //   • CLOSED with no operator confirmation → 'unobserved' (EXCLUDED — we never observed the
    //       on-time decision; a scoring NO-OP that can never inflate the rate)
    // Net: efficacy = confirmed-on-time / (confirmed-on-time + observed-slips) — the honest value.
    if ((KIND_MODE[r.kind ?? ''] ?? 'forecast') === 'signal') {
      const res = (r.resolution || '').trim().toLowerCase()
      if (res === 'hit') return 'averted'
      if (res === 'miss') return 'materialized'
      if (res === 'moot' || res === 'unobserved' || res === 'unobservable') return 'unobserved'
      return subjects.some((s) => openIds.has(s)) ? 'materialized' : 'unobserved'
    }
    return subjects.some((s) => openIds.has(s)) ? 'materialized' : 'averted'
  }

  for (const r of rows) {
    if (r.verdict == null || r.verdict === 'null') {
      const v = resolve(r)
      if (v) {
        r.verdict = v
        r.resolved = todayIso
        resolvedNow++
        dirty = true
      }
    }
    const v = r.verdict
    if (v != null && v !== 'null') {
      const mode = KIND_MODE[r.kind ?? ''] ?? 'forecast'
      const newOutcome =
        mode === 'signal'
          ? v === 'averted'
            ? 'on-time'
            : v === 'materialized'
              ? 'slipped'
              : 'moot'
          : v === 'materialized'
            ? 'hit'
            : v === 'averted'
              ? 'useful'
              : v === 'refuted'
                ? 'miss'
                : 'unresolved'
      if (r.outcome !== newOutcome) {
        r.outcome = newOutcome
        dirty = true
      }
      if (!('error' in r)) {
        r.error = null
        dirty = true
      }
    }
  }

  // ── score: per-kind patterns + per-tier calibration ──
  const record: Record<string, Record<string, unknown>> = {}
  const confCal: Record<Tier, Record<string, number>> = {
    high: { fired: 0, materialized: 0, useful: 0, observed: 0 },
    med: { fired: 0, materialized: 0, useful: 0, observed: 0 },
    low: { fired: 0, materialized: 0, useful: 0, observed: 0 },
    untagged: { fired: 0, materialized: 0, useful: 0, observed: 0 }
  }
  for (const r of rows) {
    const v = r.verdict
    if (v == null || v === 'null') continue
    const kind = r.kind ?? 'unknown'
    const mode = KIND_MODE[kind] ?? 'forecast'
    const d = (record[kind] ??= { mode, fired: 0, materialized: 0, averted: 0, refuted: 0, unobserved: 0 }) as Record<string, number> & { mode: string }
    d.fired++
    if (v === 'materialized') d.materialized++
    else if (v === 'averted') d.averted++
    else if (v === 'refuted') d.refuted++
    else d.unobserved++
    if (mode === 'signal') continue
    const ct = confCal[tierOf(r.confidence)]
    ct.fired++
    if (v === 'materialized' || v === 'averted' || v === 'refuted') ct.observed++
    if (v === 'materialized' || v === 'averted') {
      ct.useful++
      if (v === 'materialized') ct.materialized++
    }
  }
  for (const d of Object.values(record)) {
    const dm = d as Record<string, number> & { mode: string }
    const observed = dm.materialized + dm.averted + (dm.refuted ?? 0)
    if (dm.mode === 'signal') {
      d.on_time = dm.averted
      d.slipped = dm.materialized
      d.efficacy_rate = observed ? pyRound(dm.averted / observed, 3) : null
      d.hit_rate = null
      d.self_prune = false
      d.note = SIGNAL_NOTE
    } else {
      d.useful = dm.materialized + dm.averted
      d.useful_rate = observed ? pyRound((dm.materialized + dm.averted) / observed, 3) : null
      d.hit_rate = observed ? pyRound(dm.materialized / observed, 3) : null
      d.self_prune = false
    }
  }
  for (const ct of Object.values(confCal)) {
    const obs = ct.observed
    const c = ct as Record<string, number | null>
    c.materialize_rate = obs ? pyRound(ct.materialized / obs, 3) : null
    c.useful_rate = obs ? pyRound(ct.useful / obs, 3) : null
    c.smoothed_rate = obs ? pyRound((ct.useful + 1) / (obs + 2), 3) : null
    const [lo, hi] = wilson(ct.useful, obs)
    c.wilson_lo = lo
    c.wilson_hi = hi
    c.gated = (obs < minN) as unknown as number
  }

  return { rows, patterns: record, confidence_calibration: confCal, resolved_this_run: resolvedNow, dirty }
}
