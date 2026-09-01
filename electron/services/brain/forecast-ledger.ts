// forecast-ledger — logs graph-derived forecasts PRE-ACT to the calibration ledger
// (.duin/_state/risk-predictions.jsonl), so the existing resolver
// (server.py:_resolve_risk_ledger, kind-agnostic for subjects-bearing rows:
// materialized iff a subject is still open after eval_after, else averted) scores
// them into forecast-track-record.json. THIS is what closes the loop: generate →
// log (here) → resolve+score (existing) → re-audit.
//
// TRANSITIONAL two-writer note: the resolver is designed single-writer (it rewrites
// the file). This appends (O_APPEND, complete lines) with STABLE ids + dedup, so a
// row lost to a rare append-during-rewrite race is simply re-appended next run
// (self-healing). Clean fix = own the whole ledger in TS at Tier 3.
import { readFileSync } from 'fs'
import { join } from 'path'
import { trackOf } from './predicted-risks-native'
import { durableAppend } from './durable-write'
import type { Forecast } from './forecast-generator'
import { messageOf } from '../guarded'

const ledgerPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'risk-predictions.jsonl')

/** Every `id` already in the ledger — the dedup set both this logger and the ported
 *  predicted-kinds logger (predicted-kinds-ledger.ts) use so a re-run appends nothing. */
export function existingLedgerIds(path: string): Set<string> {
  try {
    const ids = new Set<string>()
    for (const l of readFileSync(path, 'utf-8').split(/\r?\n/)) {
      if (!l.trim()) continue
      try {
        const id = (JSON.parse(l) as { id?: string }).id
        if (id) ids.add(id)
      } catch (e) { console.debug('[forecast-ledger] skip malformed:', messageOf(e)) }
    }
    return ids
  } catch {
    return new Set()
  }
}

/** Append any forecast not already in the ledger, pre-act (verdict:null). Returns
 *  the number newly logged. Idempotent per stable id → safe to call every surface. */
export function logForecastsToLedger(vaultDir: string | null, forecasts: Forecast[], today: Date = new Date()): number {
  if (!vaultDir) return 0
  const path = ledgerPath(vaultDir)
  const have = existingLedgerIds(path)
  const created = today.toISOString().slice(0, 10)
  const rows: string[] = []
  for (const f of forecasts) {
    if (have.has(f.id) || !f.subjects.length) continue // dedup + skip un-resolvable (no subjects)
    rows.push(
      JSON.stringify({
        id: f.id,
        created,
        source: 'duin-graph-forecast',
        kind: f.kind,
        trigger_signature: { type: f.kind, value: f.subject },
        predicted: f.statement,
        eval_after: { by: f.eval_after },
        verdict: null,
        subjects: f.subjects,
        sources: [],
        track: trackOf(`${f.subject} ${f.basis.join(' ')}`) ?? '',
        // Log the BASE (pre-calibration) confidence — what was actually PREDICTED — not the
        // recalibrated display value. The resolved ledger is what the proper-scorer + the Platt
        // recalibrator train on; logging the post-calibration confidence would make the corrector
        // train on its own output (a self-referential loop, live only once skillScore can fire).
        confidence: f.baseConfidence ?? f.confidence
      })
    )
  }
  if (!rows.length) return 0
  try {
    durableAppend(path, rows.join('\n') + '\n') // O_APPEND + fsync: atomic complete-line writes, crash-safe
    return rows.length
  } catch {
    return 0
  }
}
