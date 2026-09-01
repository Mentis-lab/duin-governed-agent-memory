// transfer-ab-store — durable history for the whole-brain A/B litmus (transfer pilot #4b).
//
// runTransferAB is MEASUREMENT-ONLY and returned its verdict to whoever asked, which was only ever a
// manual `POST /debug/transfer-ab`. Nothing kept the result, so the pilot's headline moat-fit number
// could not be consumed by anything that runs on its own — which is why the RSI bench left its
// `named-skill-lift` slot hardcoded null. This is the ledger that closes that loop: producers append
// a run, and the bench reads the freshest one back.
//
// Append-only JSONL under the vault's .duin/_state, same shape and failure stance as the other
// brain ledgers: a write is best-effort, a read tolerates partial/corrupt lines.

import { join, dirname } from 'path'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { durableAppend } from './durable-write'
import type { FitLift } from './transfer-ab'

export interface TransferRunRecord {
  ts: string
  withMoatWins: number
  coldWins: number
  ties: number
  inconclusive: number
  decided: number
  samples: number
  /** withMoatWins − coldWins; null below the sample floor (never a lift claimed on thin data). */
  fitLift: number | null
  verdict: FitLift['verdict']
  /** WHICH RUBRIC GRADED THIS RUN. Added 2026-08-02, and it is not bookkeeping.
   *
   *  Until 2026-08-01 the judge was handed the GROUNDED arm's own prompt as its scoring rubric, so
   *  it rewarded the grounded answer for echoing text the cold answer never saw. The constitution
   *  now says the numbers those runs produced "must not be cited" — but every daily run from
   *  2026-07-25 to 07-31 is sitting in this ledger, byte-INDISTINGUISHABLE from a held-out one, and
   *  `self-improve-bench.resolveNamedSkillLift` reads the freshest record under a 7-day cap. So a
   *  discredited measurement was still machine-consumable and the prohibition was enforced only by
   *  a human remembering a date. Two situations, one representation — property 8, in a store.
   *
   *  Absent ⇒ the record predates this field, which means it was written by the circular judge.
   *  That is why the reader treats missing as `'circular'` rather than as unknown-and-probably-fine
   *  (`rubricOf`): the fail-safe direction is refusing a number, not citing one. */
  rubric?: TransferRubric
}

/** `held-out` = graded against operator rulings withheld from the grounded arm (the only kind that
 *  can support a claim). `circular` = graded against the grounded arm's own prompt. */
export type TransferRubric = 'held-out' | 'circular'

/** The rubric a record was graded with, treating pre-field records as circular. Exported because
 *  every consumer must make the same call, and because "which rubric" is now a decision anything
 *  reading this ledger has to make. */
export function rubricOf(rec: Pick<TransferRunRecord, 'rubric'>): TransferRubric {
  return rec.rubric === 'held-out' ? 'held-out' : 'circular'
}

const historyPath = (vaultDir: string): string =>
  join(vaultDir, '.duin', '_state', 'transfer-ab-history.jsonl')

/** Append one measured run. Best-effort — a failed history write never invalidates the measurement
 *  the caller already has in hand. */
export function recordTransferRun(
  vaultDir: string,
  result: FitLift,
  nowISO: string,
  /** Defaults to 'held-out' because that is what the shipped judge now does. A caller that
   *  reintroduces a self-referential rubric must say so — and then the bench will refuse it. */
  rubric: TransferRubric = 'held-out'
): void {
  if (!vaultDir) return
  const rec: TransferRunRecord = {
    rubric,
    ts: nowISO,
    withMoatWins: result.withMoatWins,
    coldWins: result.coldWins,
    ties: result.ties,
    inconclusive: result.inconclusive,
    decided: result.decided,
    samples: result.samples,
    fitLift: result.fitLift,
    verdict: result.verdict
  }
  try {
    const p = historyPath(vaultDir)
    // COLD VAULT: durableAppend opens with 'a' and does NOT create parent dirs, so on a vault where
    // no other subsystem has made .duin/_state yet this throws ENOENT — and because the write is
    // best-effort, the throw is swallowed and the bench then reports "the grader has never been
    // asked" about a grader that ran daily and spent the model calls. Mirrors learn-store.
    mkdirSync(dirname(p), { recursive: true })
    durableAppend(p, JSON.stringify(rec) + '\n')
  } catch {
    /* history is best-effort */
  }
}

/** The most recent run, or null when none was ever recorded. Scans from the end and skips
 *  unparseable lines (a truncated tail must not hide an older good record). */
export function latestTransferRun(vaultDir: string): TransferRunRecord | null {
  if (!vaultDir) return null
  const p = historyPath(vaultDir)
  if (!existsSync(p)) return null
  let lines: string[]
  try {
    lines = readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim())
  } catch {
    return null
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i]) as TransferRunRecord
      if (r && typeof r.ts === 'string' && typeof r.decided === 'number') return r
    } catch {
      /* skip a partial line */
    }
  }
  return null
}
