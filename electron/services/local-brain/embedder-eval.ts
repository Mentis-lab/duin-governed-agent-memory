// Embedder A/B eval runner (Spec §C, live). For each candidate model: probe it
// (Part A — load + 1 embed, reverts on failure), reindex the dogfood vault under
// it (Part B — the dim-flexible vec table migrates), run the labeled queries via
// the real hybrid search, and score recall@5/MRR per bucket (Part C). Restores
// the prior embedder + reindexes at the end so the live brain returns to
// baseline. Long-running + fire-and-forget: progress lands in
// userData/embedder-eval-result.json.

import { writeFileSync } from 'fs'
import { join } from 'path'
import {
  reindex,
  search,
  setEmbedderOverride,
  getEmbedderOverride,
  getLocalBrainUserDataPath
} from './index-store'
import { getEmbeddingsService } from '../rag/embeddings/service'
import {
  scoreByBucket,
  multilingualWins,
  type LabeledQuery,
  type BucketScore
} from '../rag/embeddings/_eval/scoring'
import { messageOf } from '../guarded'

export interface EvalCandidateResult {
  candidate: string
  ok: boolean
  error?: string
  dims?: number
  indexed?: number
  scores?: BucketScore[]
}

export interface EvalReport {
  startedAt: string
  finishedAt?: string
  status: 'running' | 'done' | 'error'
  error?: string
  candidates: string[]
  results: EvalCandidateResult[]
  /** candidate → does it beat the baseline (first candidate) per multilingualWins. */
  verdict: Record<string, boolean>
}

const OUT_FILE = 'embedder-eval-result.json'

export function evalResultPath(): string | null {
  const ud = getLocalBrainUserDataPath()
  return ud ? join(ud, OUT_FILE) : null
}

/**
 * Run the A/B. `candidates[0]` is treated as the baseline for the verdict.
 * Resilient: a candidate that fails to probe or crashes its reindex is recorded
 * with the error and the loop continues; the prior embedder is always restored.
 */
export async function runEmbedderEval(
  notesDir: string,
  candidates: string[],
  labeled: LabeledQuery[],
  startedAt: string
): Promise<void> {
  const outPath = evalResultPath()
  const report: EvalReport = {
    startedAt,
    status: 'running',
    candidates,
    results: [],
    verdict: {}
  }

  // SAFETY GUARD (2026-07-23): this eval is DESTRUCTIVE — it reindexes the wired
  // local-brain.db under each candidate (DROP+re-embed notes_vec) twice, then restores.
  // `resolveDbPath()` is not parameterizable, so on a LIVE instance it re-embeds the
  // real index (~24min/candidate) and a crash before the finally-restore leaves the live
  // index built under a candidate model. So refuse unless the caller is an ISOLATED
  // instance that has opted in via DUIN_EMBEDDER_EVAL_ALLOW=1 (set only by the
  // run-embedder-ab launcher, which also passes Electron --user-data-dir=<throwaway>).
  // This closes the in-live /debug/embedder-eval hazard that left a mid-flight
  // embedder-eval-result.json:"running" on the live userData.
  if (process.env.DUIN_EMBEDDER_EVAL_ALLOW !== '1') {
    report.status = 'error'
    report.error =
      'refused: embedder A/B is destructive (reindexes the live index under each candidate). ' +
      'Run it in an ISOLATED instance via scripts/run-embedder-ab.ps1 (sets --user-data-dir + DUIN_EMBEDDER_EVAL_ALLOW=1).'
    report.finishedAt = startedAt
    if (outPath) { try { writeFileSync(outPath, JSON.stringify(report, null, 2)) } catch { /* best-effort */ } }
    console.warn('[embedder-eval] REFUSED on a non-isolated instance (set DUIN_EMBEDDER_EVAL_ALLOW=1 in a --user-data-dir throwaway to run).')
    return
  }
  const write = (): void => {
    if (!outPath) return
    try {
      writeFileSync(outPath, JSON.stringify(report, null, 2))
    } catch (e) { console.debug('[embedder-eval] best-effort progress file:', messageOf(e)) }
  }
  write()

  // Pass the wired userData path explicitly — the singleton may not exist yet if
  // the boot reindex hasn't reached its embed phase (a no-arg call throws there).
  const prior = getEmbedderOverride()
  try {
    const svc = getEmbeddingsService(getLocalBrainUserDataPath() ?? undefined)
    for (const cand of candidates) {
      setEmbedderOverride(cand)
      const probe = await svc.probeModel(cand)
      if (!probe.ok) {
        report.results.push({ candidate: cand, ok: false, error: `probe: ${probe.error}` })
        write()
        continue
      }
      try {
        const indexed = await reindex(notesDir) // re-embeds under cand; vec table migrates
        const retrieved = new Map<string, string[]>()
        for (const q of labeled) {
          const hits = await search(q.query, 5)
          retrieved.set(q.query, hits.map((h) => h.file))
        }
        report.results.push({
          candidate: cand,
          ok: true,
          dims: probe.dims,
          indexed,
          scores: scoreByBucket(labeled, retrieved, 5)
        })
      } catch (err) {
        report.results.push({ candidate: cand, ok: false, error: `reindex/search: ${(err as Error)?.message}` })
      }
      write()
    }
    // Success path: verdict (each candidate vs the first/baseline) + done.
    const baseline = report.results.find((r) => r.ok && r.scores)?.scores ?? []
    for (const r of report.results) {
      if (r.ok && r.scores) report.verdict[r.candidate] = multilingualWins(baseline, r.scores)
    }
    report.status = 'done'
  } catch (err) {
    // An early/structural failure (e.g. no embeddings service) — surface it in
    // the result file instead of vanishing as an unhandled rejection.
    report.status = 'error'
    report.error = (err as Error)?.message ?? String(err)
  } finally {
    // Always restore the live brain to its prior embedder + reindex.
    setEmbedderOverride(prior)
    try {
      await reindex(notesDir)
    } catch (e) { console.debug('[embedder-eval] restore is best-effort:', messageOf(e)) }
    try {
      report.finishedAt = new Date().toISOString()
    } catch (e) { console.debug('[embedder-eval] keep startedAt:', messageOf(e)) }
    write()
  }
}
