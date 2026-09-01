import { describe, it, expect } from 'vitest'
import { runBench, formatReport } from './harness'
import { BENCH_TASKS, PERFECT_SOLVER, NOOP_SOLVER } from './tasks'

// Self-validation of the benchmark itself: the graders must ACCEPT a correct
// solution and REJECT the broken starting state. This is what makes the suite a
// trustworthy yardstick for the real agent — the graders spawn node and actually
// run the resulting code, so a green here means "working code," not "looks right."
describe('BENCH_TASKS graders', () => {
  it('the perfect solver passes every task (graders accept a correct solution)', async () => {
    const r = await runBench(BENCH_TASKS, PERFECT_SOLVER)
    const failed = r.results.filter((x) => !x.passed).map((x) => `${x.id}: ${x.error || x.detail}`)
    expect(failed, `unexpected failures: ${failed.join('; ')}`).toEqual([])
    expect(r.score).toBe(1)
  }, 60_000)

  it('the no-op solver fails every task (graders reject the broken starting state)', async () => {
    const r = await runBench(BENCH_TASKS, NOOP_SOLVER)
    expect(r.passed, formatReport(r)).toBe(0)
  }, 60_000)
})
