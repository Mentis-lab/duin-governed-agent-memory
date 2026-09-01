// The bench runner: isolate → setup → run agent → grade → score. Each task gets a
// fresh temp workspace so tasks can't leak into each other; a task that throws is a
// FAIL (not a crash) so one broken task never sinks the run.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BenchTask, BenchReport, BenchTaskResult, RunAgent } from './types'
import { messageOf } from '../guarded'

export interface RunBenchOptions {
  /** Keep the temp workspaces on disk for inspection (default: clean up). */
  keep?: boolean
  /** Called after each task with its result — lets a CLI stream progress. */
  onResult?: (r: BenchTaskResult) => void
}

export async function runBench(
  tasks: BenchTask[],
  runAgent: RunAgent,
  opts: RunBenchOptions = {}
): Promise<BenchReport> {
  const results: BenchTaskResult[] = []
  for (const task of tasks) {
    const dir = mkdtempSync(join(tmpdir(), `duin-bench-${task.id}-`))
    const t0 = Date.now()
    let passed = false
    let detail: string
    let error: string | undefined
    try {
      task.setup(dir)
      await runAgent({ dir, prompt: task.prompt, task })
      const g = task.grade(dir)
      passed = g.passed
      detail = g.detail
    } catch (e) {
      error = (e as Error).message
      detail = 'errored before grading'
    } finally {
      if (!opts.keep) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch (e) { console.debug('[harness] best-effort cleanup:', messageOf(e)) }
      }
    }
    const result: BenchTaskResult = { id: task.id, title: task.title, passed, detail, error, ms: Date.now() - t0 }
    results.push(result)
    opts.onResult?.(result)
  }
  const passedN = results.filter((r) => r.passed).length
  return { results, passed: passedN, total: tasks.length, score: tasks.length ? passedN / tasks.length : 0 }
}

/** Render a report as a compact scorecard string (for CLI / logs). */
export function formatReport(report: BenchReport): string {
  const lines = report.results.map((r) => {
    const mark = r.passed ? 'PASS' : 'FAIL'
    const note = r.error ? ` — error: ${r.error}` : r.detail ? ` — ${r.detail}` : ''
    return `  [${mark}] ${r.id} (${r.ms}ms)${note}`
  })
  const pct = Math.round(report.score * 100)
  return [`Agent bench: ${report.passed}/${report.total} passed (${pct}%)`, ...lines].join('\n')
}
