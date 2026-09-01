import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { decisionLoop } from './decision-loop-native'

describe('decisionLoop (list_loops)', () => {
  let vault: string
  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-dl-'))
    const state = join(vault, '.duin', '_state')
    mkdirSync(state, { recursive: true })
    mkdirSync(join(vault, '.duin', 'routines'), { recursive: true })
    writeFileSync(join(vault, '.duin', 'routines', 'daily.py'), '# routine')
    writeFileSync(
      join(state, 'corrections.jsonl'),
      [
        JSON.stringify({ ts: '2026-06-01', skill: '(feishu)', correction: 'a', candidate_rule: 'r1', status: 'promoted', polarity: 'correction' }),
        JSON.stringify({ ts: '2026-06-03', skill: 'note', correction: 'b', polarity: 'positive' })
      ].join('\n')
    )
    writeFileSync(
      join(state, 'autonomous-log.jsonl'),
      [
        JSON.stringify({ ts: '2026-06-01T08:00', routine: 'daily', message: 'run1', level: 'info' }),
        JSON.stringify({ ts: '2026-06-02T08:00', routine: 'daily', message: 'run2', level: 'warn' })
      ].join('\n')
    )
  })
  afterAll(() => rmSync(vault, { recursive: true, force: true }))

  it('reads learnings (ts desc) + strips skill parens + summary counts', () => {
    const r = decisionLoop(vault)
    expect(r.learnings.map((l) => l.ts)).toEqual(['2026-06-03', '2026-06-01']) // desc
    expect(r.learnings.find((l) => l.rule === 'r1')!.skill).toBe('feishu') // '(feishu)' → 'feishu'
    expect(r.summary).toEqual({ learnings: 2, promoted: 1, corrections: 1, positives: 1, routines: 1 })
  })

  it('groups routine runs, keeps latest ts, resolves the path', () => {
    const r = decisionLoop(vault)
    const daily = r.routines.find((x) => x.routine === 'daily')!
    expect(daily.runs).toBe(2)
    expect(daily.lastTs).toBe('2026-06-02T08:00')
    expect(daily.lastMessage).toBe('run2')
    expect(daily.level).toBe('warn')
    expect(daily.path).toBe('.duin/routines/daily.py')
  })

  it('null vault → empty', () => {
    expect(decisionLoop(null).summary.learnings).toBe(0)
  })
})
