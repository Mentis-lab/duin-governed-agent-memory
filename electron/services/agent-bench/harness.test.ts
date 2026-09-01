import { describe, it, expect } from 'vitest'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { runBench, formatReport } from './harness'
import type { BenchTask, RunAgent } from './types'

// Hermetic harness tests — simple file-based tasks (no spawning) so they exercise
// isolation / scoring / error-handling deterministically.
const fileTask = (id: string): BenchTask => ({
  id,
  title: id,
  prompt: 'write ok to out.txt',
  setup: (dir) => writeFileSync(join(dir, 'out.txt'), 'start'),
  grade: (dir) => {
    const t = readFileSync(join(dir, 'out.txt'), 'utf8')
    return { passed: t === 'ok', detail: t }
  }
})

describe('runBench', () => {
  it('scores a solver that satisfies the grader', async () => {
    const solve: RunAgent = async ({ dir }) => writeFileSync(join(dir, 'out.txt'), 'ok')
    const r = await runBench([fileTask('t1'), fileTask('t2')], solve)
    expect(r.passed).toBe(2)
    expect(r.total).toBe(2)
    expect(r.score).toBe(1)
  })

  it('marks unsatisfied tasks as fail (no false pass)', async () => {
    const noop: RunAgent = async () => {}
    const r = await runBench([fileTask('t1')], noop)
    expect(r.passed).toBe(0)
    expect(r.score).toBe(0)
    expect(r.results[0].detail).toBe('start')
  })

  it('a throwing agent is a FAIL not a crash; sibling tasks still run', async () => {
    const flaky: RunAgent = async ({ task, dir }) => {
      if (task.id === 'bad') throw new Error('boom')
      writeFileSync(join(dir, 'out.txt'), 'ok')
    }
    const r = await runBench([fileTask('bad'), fileTask('good')], flaky)
    expect(r.total).toBe(2)
    const bad = r.results.find((x) => x.id === 'bad')!
    expect(bad.passed).toBe(false)
    expect(bad.error).toBe('boom')
    expect(r.results.find((x) => x.id === 'good')!.passed).toBe(true)
  })

  it('isolates workspaces — one task cannot see another task\'s files', async () => {
    const A: BenchTask = { id: 'A', title: 'A', prompt: '', setup: () => {}, grade: () => ({ passed: true, detail: '' }) }
    const B: BenchTask = {
      id: 'B',
      title: 'B',
      prompt: '',
      setup: () => {},
      grade: (dir) => ({ passed: !existsSync(join(dir, 'marker')), detail: '' })
    }
    const solve: RunAgent = async ({ dir, task }) => {
      if (task.id === 'A') writeFileSync(join(dir, 'marker'), 'x')
    }
    const r = await runBench([A, B], solve)
    expect(r.results.find((x) => x.id === 'B')!.passed).toBe(true)
  })

  it('formatReport renders a scorecard', async () => {
    const solve: RunAgent = async ({ dir }) => writeFileSync(join(dir, 'out.txt'), 'ok')
    const s = formatReport(await runBench([fileTask('t1')], solve))
    expect(s).toContain('1/1 passed (100%)')
    expect(s).toContain('[PASS] t1')
  })
})
