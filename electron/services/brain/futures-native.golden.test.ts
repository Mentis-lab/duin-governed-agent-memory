// GOLDEN lock for calibrate_streams' WRITE side-effect + list_futures shaping.
// The live vault has a settled ledger (new=0), so the append path never runs there
// — this exercises it on a synthetic vault so a regression in the ledger write (the
// thing that keeps self-correction alive) can't pass silently.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { calibrateStreams, listFutures } from './futures-native'

describe('futures-native — calibrate write path + list_futures', () => {
  let dir: string
  const stateDir = (): string => join(dir, '.duin', '_state')
  const writeFutures = (rows: unknown[]): void =>
    writeFileSync(join(stateDir(), 'future-nodes.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8')
  const ledgerPath = (): string => join(stateDir(), 'stream-verdicts.jsonl')
  const now = new Date('2026-07-06T00:00:00')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-fut-'))
    mkdirSync(stateDir(), { recursive: true })
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('appends a verdict for a passed decision (open → unobserved), idempotently', () => {
    writeFutures([{ id: 's1', title: 'X', status: 'open', decide_by: '2026-05' }]) // month < 2026-07
    const r1 = calibrateStreams(dir, now)
    expect(r1.new).toBe(1)
    const rows = readFileSync(ledgerPath(), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows).toEqual([{ id: 's1', what: 'decide:2026-05', kind: 'decision', outcome: 'unobserved', ts: '2026-07-06' }])
    // re-run: already logged → no new rows
    expect(calibrateStreams(dir, now).new).toBe(0)
  })

  it('scores an engaged passed decision as a hit; hit_rate over observed', () => {
    writeFutures([{ id: 's1', title: 'X', status: 'engaged', decide_by: '2026-05' }])
    const r = calibrateStreams(dir, now)
    expect(r.new).toBe(1)
    expect(r).toMatchObject({ hit_rate: 1, scored: 1 }) // one observed hit
    const row = JSON.parse(readFileSync(ledgerPath(), 'utf-8').trim())
    expect(row.outcome).toBe('hit')
  })

  it('does not write when nothing is newly scorable', () => {
    writeFutures([{ id: 's1', title: 'X', status: 'open', decide_by: '2027-01' }]) // future month
    expect(calibrateStreams(dir, now).new).toBe(0)
    expect(existsSync(ledgerPath())).toBe(false)
  })

  it('list_futures groups open/engaged streams into objectives with roll-up', () => {
    writeFutures([
      { id: 'a', title: 'TapTap', status: 'engaged', track: 'ProjectA', parent: 'p1', decide_by: '2026-09', levels: { risk: 0.4, progress: 0.5, confidence: 0.6 } },
      { id: 'b', title: 'B站', status: 'open', track: 'ProjectA', parent: 'p1', kept: true, decide_by: '2026-08', levels: { risk: 0.2, progress: 0.3, confidence: 0.5 } }
    ])
    const out = listFutures(dir, now)
    expect(out.today).toBe('2026-07-06')
    // both ProjectA streams fold into the projecta-gtm objective (cold-start A4 renamed the
    // hardcoded GTM group key off the operator's real project)
    const objs = out.objectives as Record<string, unknown>[]
    expect(objs.length).toBe(1)
    expect(objs[0]).toMatchObject({ key: 'projecta-gtm', count: 2, engaged: 1 })
    expect((objs[0].members as string[]).sort()).toEqual(['a', 'b'])
  })
})
