import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scenarioForks } from './scenario-forks-native'

describe('scenario-forks-native (unification: /state/scenario-forks)', () => {
  let dir: string
  const stateDir = (): string => join(dir, '.duin', '_state')
  const writeFutures = (rows: unknown[]): void =>
    writeFileSync(join(stateDir(), 'future-nodes.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-sf-'))
    mkdirSync(stateDir(), { recursive: true })
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  const NOW = new Date('2026-07-01T09:00:00+08:00') // local day = 2026-07-01

  it('empty when no stream has both cleared AND blocked', () => {
    writeFutures([{ title: 'A', decide_by: '2026-08-01', cleared: 'good' }]) // no blocked → not a fork
    const r = scenarioForks(dir, NOW)
    expect(r.forks).toEqual([])
    expect(r.generated).toBe('2026-07-01')
  })

  it('surfaces a two-way fork with computed overdue / days_to_decide / pending steps', () => {
    writeFutures([
      {
        title: 'Ship v2',
        track: 'work',
        decision: 'go or hold',
        decide_by: '2026-07-10',
        target: 'Q3',
        cleared: 'launch',
        blocked: 'slip a quarter',
        steps: [
          { event: 'draft', when: '2026-07-02', done: true },
          { event: 'review', when: '2026-07-05' },
        ],
      },
    ])
    const r = scenarioForks(dir, NOW)
    expect(r.forks).toHaveLength(1)
    const f = r.forks[0]
    expect(f).toEqual({
      stream: 'Ship v2',
      track: 'work',
      decision: 'go or hold',
      decide_by: '2026-07-10',
      overdue: false,
      days_to_decide: 9,
      target: 'Q3',
      fork: { if_cleared: 'launch', if_blocked: 'slip a quarter' },
      pending_steps: [{ event: 'review', when: '2026-07-05' }], // done step filtered out
    })
  })

  it('marks overdue when decide_by is in the past, and sorts empty decide_by last', () => {
    writeFutures([
      { title: 'later', decide_by: '2026-09-01', cleared: 'a', blocked: 'b' },
      { title: 'no-date', cleared: 'a', blocked: 'b' },
      { title: 'past', decide_by: '2026-06-01', cleared: 'a', blocked: 'b' },
    ])
    const r = scenarioForks(dir, NOW)
    expect(r.forks.map((f) => f.stream)).toEqual(['past', 'later', 'no-date'])
    expect(r.forks[0].overdue).toBe(true)
    expect(r.forks[0].days_to_decide).toBe(-30)
    expect(r.forks[2].days_to_decide).toBeNull()
  })

  it('isolates personal/confidential streams from the shared view', () => {
    writeFutures([{ title: 'secret', track: 'personal', decide_by: '2026-07-05', cleared: 'a', blocked: 'b' }])
    expect(scenarioForks(dir, NOW).forks).toEqual([])
  })

  it('truncates stream/decision/fork/step fields to Python widths', () => {
    const long = 'x'.repeat(300)
    writeFutures([{ title: long, decision: long, cleared: long, blocked: long, steps: [{ event: long, when: 'w' }] }])
    const f = scenarioForks(dir, NOW).forks[0]
    expect(f.stream.length).toBe(80)
    expect(f.decision.length).toBe(200)
    expect(f.fork.if_cleared.length).toBe(200)
    expect(f.pending_steps[0].event.length).toBe(80)
  })
})
