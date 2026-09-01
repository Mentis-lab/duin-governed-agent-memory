// calibration-store — the read→resolve→write ORCHESTRATION that owns the
// calibration loop's files in TS (risk-predictions.jsonl + forecast-track-record.json).
// Completes the native calibration loop: forecast-ledger.ts logs → this resolves+scores
// (via calibration-resolve-native) → writes back. Atomic writes (temp+rename) so this is
// the SINGLE writer once the Python resolver routines are retired (the coordinated flip
// that closes the two-writer state). Port of the file-I/O half of
// server.py:_resolve_risk_ledger_unlocked (the pure logic lives in the -native module).
import { readFileSync, copyFileSync } from 'fs'
import { atomicWriteFileSync } from '../atomic-write'
import { join, relative } from 'path'
import { taskFiles } from './throughput'
import { loadFutures, parseTaskLine } from './causal-substrate'
import { resolveAndScore, CAL_MIN_N, KIND_MODE, wilson, type LedgerRow } from './calibration-resolve-native'
import { extractScoredForecasts, properScore, type ProperScore } from './calibration-scoring'
import { preResolutionSignals, type OpenForecast } from './pre-resolution'
import { perLabelReliability, type LabeledOutcome } from './label-calibration'
import { messageOf } from '../guarded'

const stateDir = (vaultDir: string): string => join(vaultDir, '.duin', '_state')
const isoOf = (d: Date): string => d.toISOString().slice(0, 10)

const TRACK_NOTE =
  'Honest scorecard (2026-06-17): averted=useful (not a miss); signal-mode kinds (decision-window) ' +
  'now scored on falsifiable EFFICACY (decided-on-time vs slipped) as their own domain — kept out of ' +
  'probabilistic tier-calibration but resolvable so observed climbs; self_prune disabled pending a ' +
  'false-alarm signal; tier rates Beta(1,1)-smoothed + Wilson 95%, gated below min_n. These tier ' +
  'rates are EFFICACY, not probability — the proper score (Brier / base-rate Brier / Murphy skill / ' +
  'ECE) over the probabilistic kinds is reported separately as `properScore` on this payload, with ' +
  'skillScore gated to null below min_n.'

/** open_ids = every NON-DONE task id (NO stale filter — matches _load_task_corpus,
 *  NOT gatherTasks) + every OPEN stream id. A still-open subject = the work didn't
 *  land = the forecast materialized. */
export function computeOpenIds(vaultDir: string): Set<string> {
  const ids = new Set<string>()
  for (const fp of taskFiles(vaultDir)) {
    let txt: string
    try {
      txt = readFileSync(fp, 'utf-8')
    } catch {
      continue
    }
    const rel = relative(vaultDir, fp).replace(/\\/g, '/')
    const lines = txt.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const t = parseTaskLine(lines[i], rel, i)
      if (t && !t.done && t.id) ids.add(t.id)
    }
  }
  for (const s of loadFutures(vaultDir)) if (s.status === 'open' && s.id) ids.add(s.id)
  return ids
}

/**
 * PRE-RESOLUTION (Milkyway) — compute the leading signal for every OPEN forecast
 * (verdict unset, deadline not yet passed, subjects-bearing) and persist a current-
 * state snapshot to pre-resolution.json for confidence-weighted surfaces to read
 * BEFORE ground truth. Reuses computeOpenIds — the SAME open/closed notion the
 * resolver uses — so the leading signal and the eventual verdict agree on the facts.
 * Best-effort + idempotent (overwrites the snapshot each pass); returns the count.
 */
export function runPreResolution(vaultDir: string | null, today: Date = new Date()): number {
  if (!vaultDir) return 0
  try {
    const sd = stateDir(vaultDir)
    const rows = readJsonl(join(sd, 'risk-predictions.jsonl'))
    if (!rows.length) return 0
    const open: OpenForecast[] = []
    for (const r of rows) {
      if (r.verdict != null && r.verdict !== '') continue // already resolved → resolver's job
      const subjects = Array.isArray(r.subjects) ? r.subjects.filter((s) => typeof s === 'string') : []
      if (!subjects.length) continue
      const evalAfter = r.eval_after?.by
      if (!evalAfter || !Number.isFinite(Date.parse(evalAfter))) continue
      if (Date.parse(evalAfter) <= today.getTime()) continue // past deadline → not a LEADING signal
      open.push({
        id: String(r.id ?? ''),
        subjects,
        created: String((r as { created?: string }).created ?? ''),
        evalAfter,
        confidence: typeof r.confidence === 'number' ? r.confidence : null
      })
    }
    if (!open.length) return 0
    const signals = preResolutionSignals(open, computeOpenIds(vaultDir), today)
    atomicWrite(
      join(sd, 'pre-resolution.json'),
      JSON.stringify({ builtAt: today.toISOString(), signals }, null, 2) + '\n'
    )
    return signals.length
  } catch (e) {
    console.debug('[calibration-store] pre-resolution pass skipped:', messageOf(e))
    return 0
  }
}

/**
 * PER-LABEL CALIBRATION (Agent-BRACE) — bucket every RESOLVED forecast by its
 * verbalized-certainty label and calibrate each label against its own realized
 * useful-rate + Wilson bound. Reuses extractScoredForecasts (the exact confidence +
 * averted-kind → outcome mapping the proper-scorer uses) and the resolver's wilson, so
 * the per-label curve agrees with the rest of calibration. Persists label-calibration.json.
 * Well-defined under degenerate base rates (unlike the Murphy skill score). Returns the
 * count of scored forecasts.
 */
export function runLabelCalibration(vaultDir: string | null, today: Date = new Date()): number {
  if (!vaultDir) return 0
  try {
    const sd = stateDir(vaultDir)
    const rows = readJsonl(join(sd, 'risk-predictions.jsonl'))
    if (!rows.length) return 0
    const scored = extractScoredForecasts(
      rows.map((r) => ({
        confidence: r.confidence,
        verdict: r.verdict,
        resolution: (r as { resolution?: string | null }).resolution,
        kind: r.kind,
        signal: (KIND_MODE[r.kind ?? ''] ?? 'forecast') === 'signal'
      }))
    )
    if (!scored.length) return 0
    const outcomes: LabeledOutcome[] = scored.map((s) => ({ confidence: s.confidence, useful: s.outcome === 1 }))
    const reliability = perLabelReliability(outcomes, wilson)
    atomicWrite(
      join(sd, 'label-calibration.json'),
      JSON.stringify({ builtAt: today.toISOString(), n: scored.length, reliability }, null, 2) + '\n'
    )
    return scored.length
  } catch (e) {
    console.debug('[calibration-store] label-calibration pass skipped:', messageOf(e))
    return 0
  }
}

/** One ledger line paired with its interpretation. `parsed === null` marks a line we do
 *  NOT understand — carried through the rewrite as an opaque STRING rather than dropped. */
interface LedgerEntry {
  raw: string
  parsed: LedgerRow | null
}

/**
 * Read the ledger as (raw line, interpretation) pairs, in FILE ORDER.
 *
 * Rule 1 of graph-history-store.ts ("PRESERVE unparseable lines VERBATIM"), applied to the
 * ledger that needs it most: risk-predictions.jsonl is an accrued track record —
 * `created` dates, resolver `verdict`s and operator-authored `resolution` values — that
 * brain-db-durability.ts:227 documents as recomputable from no source and with no vault copy
 * of its own. The generator self-heals only a row's EXISTENCE: a dropped row comes back as a
 * fresh `verdict:null` row stamped with today's date, silently resetting its history.
 *
 * A line torn by a sync conflict or an interrupted append (and then concatenated with the
 * NEXT appended row, so one unparseable line can contain a whole real row) is still
 * salvageable residue. Dropping it from the rewrite in runCalibration deletes it from the
 * only copy on disk. So lines are parsed for INTERPRETATION and never for PERSISTENCE.
 *
 * A line that parses to a non-object (`5`, `"x"`, `[]`) is treated as unparseable too:
 * the resolver cannot interpret it, so it is preserved rather than re-serialized.
 */
function readJsonlEntries(path: string): LedgerEntry[] {
  try {
    return readFileSync(path, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((raw) => {
        try {
          const v = JSON.parse(raw) as unknown
          const ok = v !== null && typeof v === 'object' && !Array.isArray(v)
          return { raw, parsed: ok ? (v as LedgerRow) : null }
        } catch {
          return { raw, parsed: null }
        }
      })
  } catch {
    return []
  }
}

/** Parsed rows only — for the READ-ONLY passes (pre-resolution, label calibration), which
 *  never rewrite the ledger and so cannot lose an unparseable line by ignoring it. */
function readJsonl(path: string): LedgerRow[] {
  return readJsonlEntries(path)
    .map((e) => e.parsed)
    .filter((x): x is LedgerRow => x !== null)
}

/** Atomic write: temp + rename (same-dir → atomic on the fs). The single-writer form. */
function atomicWrite(path: string, content: string): void {
  // temp -> fdatasync -> rename: the calibration ledger must survive a crash mid-write.
  atomicWriteFileSync(path, content, 0o644)
}

/** Resolve + rescore the calibration ledger and persist. Idempotent (never
 *  overwrites a set verdict; rewrites the ledger only when something newly resolved).
 *  Returns {resolved, patterns, confidenceCalibration, properScore, preservedCorruptLines}
 *  — all additive: confidenceCalibration is the recomputed per-tier calibration map for the
 *  proactive drift watcher; properScore is the Brier/log-loss/ECE proper-score;
 *  preservedCorruptLines counts lines carried through the rewrite unparsed (the
 *  observability graph-history-store.ts surfaces for the same preservation rule).
 *  Existing callers that destructure {resolved, patterns} are unaffected. */
export function runCalibration(
  vaultDir: string | null,
  today: Date = new Date()
): {
  resolved: number
  patterns: number
  confidenceCalibration: Record<string, unknown>
  properScore: ProperScore
  preservedCorruptLines: number
} {
  if (!vaultDir)
    return {
      resolved: 0,
      patterns: 0,
      confidenceCalibration: {},
      properScore: properScore([]),
      preservedCorruptLines: 0
    }
  const sd = stateDir(vaultDir)
  const ledgerPath = join(sd, 'risk-predictions.jsonl')
  const trackPath = join(sd, 'forecast-track-record.json')
  // Pair every line with its interpretation. `rows` (parsed only) drives resolve+score
  // exactly as before; `entries` is what gets written back, so an unparseable line is
  // interpreted by nobody yet deleted by nobody either.
  const entries = readJsonlEntries(ledgerPath)
  const rows = entries.map((e) => e.parsed).filter((x): x is LedgerRow => x !== null)
  const preservedCorruptLines = entries.length - rows.length
  if (preservedCorruptLines > 0)
    console.warn(
      `[calibration-store] ${preservedCorruptLines} unparseable line(s) in ${ledgerPath} — preserved verbatim through the rewrite, excluded from scoring`
    )
  if (!rows.length)
    return {
      resolved: 0,
      patterns: 0,
      confidenceCalibration: {},
      properScore: properScore([]),
      preservedCorruptLines
    }

  const observable = (process.env.DUIN_FORECAST_OBSERVABLE ?? 'on').trim().toLowerCase()
  const res = resolveAndScore(rows, computeOpenIds(vaultDir), today, {
    forecastObservable: !['0', 'off', 'false', 'no'].includes(observable)
  })

  if (res.dirty) {
    try {
      copyFileSync(ledgerPath, `${ledgerPath}.bak`)
    } catch (e) { console.debug('[calibration-store] best-effort backup:', messageOf(e)) }
    // Parsed rows are re-serialized because resolveAndScore MUTATES them in place (that is
    // the point of the rewrite). Unparseable lines go back byte-for-byte at their original
    // position — we cannot interpret them, so we must not rewrite or drop them.
    atomicWrite(
      ledgerPath,
      entries.map((e) => (e.parsed !== null ? JSON.stringify(e.parsed) : e.raw)).join('\n') + '\n'
    )
  }
  atomicWrite(
    trackPath,
    JSON.stringify(
      {
        generated: isoOf(today),
        resolved_this_run: res.resolved_this_run,
        min_n: CAL_MIN_N,
        note: TRACK_NOTE,
        patterns: res.patterns,
        confidence_calibration: res.confidence_calibration
      },
      null,
      2
    )
  )
  const scored = extractScoredForecasts(
    rows.map((r) => ({
      confidence: r.confidence,
      verdict: r.verdict,
      resolution: (r as any).resolution,
      kind: r.kind, // thread kind through so `averted` is scored with the right (structural vs risk) semantics
      signal: (KIND_MODE[r.kind ?? ''] ?? 'forecast') === 'signal'
    }))
  )
  return {
    resolved: res.resolved_this_run,
    patterns: Object.keys(res.patterns).length,
    confidenceCalibration: res.confidence_calibration as unknown as Record<string, unknown>,
    properScore: properScore(scored),
    preservedCorruptLines
  }
}
