// predicted-kinds-ledger — PORT of the three Python-only calibration-ledger loggers
// (server.py:_log_predictions for deadline-collision + decision-window, and
// server.py:_log_anchor_predictions for anchor-risk) onto the TS single writer.
//
// WHY: the TS forecast loop (forecast-generator → forecast-ledger) logs ONLY the
// graph-derived kinds (driver/convergence/cascade). Retiring the Python :8765 write
// path (ticket Item 2) would stop NEW deadline-collision / decision-window / anchor-risk
// rows from ever being logged. This module keeps those three kinds alive, generated +
// logged by the SAME native single writer (runForecastLoop) so the ledger has one owner.
//
// REUSE (not reimplement): deadline-collision + decision-window are already computed as a
// READ by predicted-risks-native.ts (predictedRisks); anchor negative-slack risk is already
// computed by anchors-native.ts (anchors). This module maps those existing computations to
// ledger rows and appends them idempotently — matching the Python schema/ids so the
// kind-agnostic resolver (calibration-resolve-native) scores them unchanged. decision-window
// is signal-mode via KIND_MODE (inferred from `kind` by the resolver — no row-level flag).
import { join } from 'path'
import { existingLedgerIds } from './forecast-ledger'
import { durableAppend } from './durable-write'
import { predictedRisks } from './predicted-risks-native'
import { anchors } from './anchors-native'

const ledgerPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'risk-predictions.jsonl')
const isoOf = (d: Date): string => d.toISOString().slice(0, 10)

/** A calibration-ledger row in the exact shape the resolver reads — schema-parity with the
 *  Python loggers: id/created/source/kind/trigger_signature/predicted/subjects/sources/
 *  track/confidence/eval_after/verdict. `verdict:null` = pre-act (unresolved). */
export interface KindLedgerRow {
  id: string
  created: string
  source: string
  kind: string
  trigger_signature: { type: string; value: string }
  predicted: string
  subjects: string[]
  sources: string[]
  track: string
  confidence: number
  eval_after: { by: string }
  verdict: null
}

/** deadline-collision + decision-window rows, REUSING the predicted-risks-native READ
 *  (predictedRisks) — the same detector the /state/predicted-risks route serves. Port of the
 *  Python `_log_predictions(out)` side effect (server.py:2876): it logged every row `out`
 *  produced (both kinds), so we do too. Mirrors `_log_predictions_unlocked` schema:
 *  source='duin-predicted', trigger_signature.value=leading_indicator, predicted=title,
 *  eval_after.by=due, confidence default 0.5 (deadline-collision carries none). */
export function predictedRiskForecasts(vaultDir: string | null, today: Date = new Date()): KindLedgerRow[] {
  if (!vaultDir) return []
  const created = isoOf(today)
  const { risks } = predictedRisks(vaultDir, today)
  const rows: KindLedgerRow[] = []
  for (const r of risks) {
    if (r.kind !== 'deadline-collision' && r.kind !== 'decision-window') continue
    rows.push({
      id: r.id,
      created,
      source: 'duin-predicted',
      kind: r.kind,
      trigger_signature: { type: r.kind, value: r.leading_indicator || '' },
      predicted: r.title,
      subjects: r.subjects ?? [],
      sources: r.sources ?? [],
      track: r.track ?? '',
      confidence: r.confidence ?? 0.5, // deadline-collision has no confidence → Python's 0.5 default
      eval_after: { by: r.due ?? '' },
      verdict: null
    })
  }
  return rows
}

/** anchor-risk rows — PORT of the negative-slack computation in
 *  server.py:_log_anchor_predictions_unlocked (server.py:3013). Reuses the anchors-native
 *  READ (anchors) for the branch/critical-path/risk rollup, then applies the logger's gates:
 *  skip confidential / undated / green anchors and past-dated anchors; subjects = critical_path
 *  gate ids with slack_days<0; confidence 0.8 red / 0.6 amber; id `anchor::<id>`;
 *  eval_after.by = anchor date (future by construction). */
export function anchorRiskForecasts(vaultDir: string | null, today: Date = new Date()): KindLedgerRow[] {
  if (!vaultDir) return []
  const created = isoOf(today)
  // Match anchors-native's local-day semantics (todayUTC) for the past-date gate, so
  // `a.date < today` agrees with the Python `date.today()` comparison, not raw UTC.
  const todayIso = isoOf(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())))
  const { anchors: list } = anchors(vaultDir, today)
  const rows: KindLedgerRow[] = []
  for (const a of list) {
    if (a.confidential || !a.date || a.risk === 'green') continue
    // Python: `if date.fromisoformat(a["date"]) < today: continue` — drop past-dated anchors
    // (ValueError on an unparseable date also skips; our date is already ISO-validated upstream).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date) || a.date < todayIso) continue
    const gates = a.critical_path.filter((c) => c.slack_days != null && c.slack_days < 0).map((c) => c.id)
    rows.push({
      id: `anchor::${a.id}`,
      created,
      source: 'duin-anchor',
      kind: 'anchor-risk',
      trigger_signature: { type: 'anchor-risk', value: 'branch negative-slack' },
      predicted: `${a.name} at risk (${a.risk}) — ${gates.length} gate(s) past slack`,
      subjects: gates,
      sources: [],
      track: a.track ?? '',
      confidence: a.risk === 'red' ? 0.8 : 0.6,
      eval_after: { by: a.date },
      verdict: null
    })
  }
  return rows
}

/** Generate + log all three Python-only kinds through the single-writer ledger, idempotent
 *  by stable id (a re-run appends nothing). Returns the number of NEW rows appended. Mirrors
 *  the O_APPEND complete-line write forecast-ledger.ts uses so the resolver's RMW never tears
 *  a row. Best-effort: a read/write failure returns what was written so far without throwing. */
export function logPredictedKindsToLedger(vaultDir: string | null, today: Date = new Date()): number {
  if (!vaultDir) return 0
  const path = ledgerPath(vaultDir)
  const have = existingLedgerIds(path)
  const candidates = [...predictedRiskForecasts(vaultDir, today), ...anchorRiskForecasts(vaultDir, today)]
  const rows: string[] = []
  const seen = new Set<string>()
  for (const row of candidates) {
    if (!row.id || have.has(row.id) || seen.has(row.id)) continue // dedup vs ledger + within-batch
    seen.add(row.id)
    rows.push(JSON.stringify(row))
  }
  if (!rows.length) return 0
  try {
    // durableAppend (O_APPEND + fsync), matching the sibling logger forecast-ledger.ts:72 —
    // this call site's docstring always CLAIMED that parity but used a bare appendFileSync,
    // which returns before the page cache flushes. A crash there leaves a torn tail that the
    // next append concatenates a whole new row onto, producing one unparseable line holding a
    // real row — precisely the residue runCalibration's rewrite must now preserve.
    durableAppend(path, rows.join('\n') + '\n')
    return rows.length
  } catch {
    return 0
  }
}
