// GOLDEN output locks for the simple-reads port (stream-verdicts / cascade-pending
// / meetings / forecast-owed). These freeze the EXACT native output for fixed
// fixtures — the deterministic, no-live-Python parity net (WS0). The native fns
// are already parity-verified vs the Python sidecar (see parity.ts), so the frozen
// output IS the Python-equivalent golden. If a shared-code refactor (or the Python
// deletion) silently drifts one of these routes, this goes red instead of shipping.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { streamVerdicts, cascadePending, listMeetings, forecastOwed } from './simple-reads-native'

describe('simple-reads-native — golden output locks (parity net)', () => {
  let dir: string
  const st = (): string => join(dir, '.duin', '_state')
  const wj = (name: string, rows: unknown[]): void =>
    writeFileSync(join(st(), name), rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8')
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-sr-gold-'))
    mkdirSync(st(), { recursive: true })
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('streamVerdicts — raw dump in file order', () => {
    wj('stream-verdicts.jsonl', [{ id: 'v1', verdict: 'hit' }, { id: 'v2', verdict: 'miss' }])
    expect(JSON.stringify(streamVerdicts(dir))).toBe('{"verdicts":[{"id":"v1","verdict":"hit"},{"id":"v2","verdict":"miss"}]}')
  })

  it('cascadePending — only status===pending survives', () => {
    wj('cascade-pending.jsonl', [{ id: 'c1', status: 'pending' }, { id: 'c2', status: 'applied' }, { id: 'c3', status: 'pending' }])
    expect(JSON.stringify(cascadePending(dir))).toBe('{"pending":[{"id":"c1","status":"pending"},{"id":"c3","status":"pending"}]}')
  })

  it('listMeetings — dismissed hidden; unconfirmed-by-when, then confirmed', () => {
    wj('meetings.jsonl', [
      { id: 'm1', status: 'confirmed', when: '2026-07-10' },
      { id: 'm2', status: 'unconfirmed', when: '2026-07-20' },
      { id: 'm3', status: 'dismissed', when: '2026-07-01' },
      { id: 'm4', status: 'unconfirmed', when: '2026-07-05' }
    ])
    expect(JSON.stringify(listMeetings(dir))).toBe(
      '{"meetings":[{"id":"m4","status":"unconfirmed","when":"2026-07-05"},{"id":"m2","status":"unconfirmed","when":"2026-07-20"},{"id":"m1","status":"confirmed","when":"2026-07-10"}]}'
    )
  })

  it('forecastOwed — unresolved past-eval only; days_overdue desc (subjects/verdict/resolution/future excluded)', () => {
    wj('risk-predictions.jsonl', [
      { id: 'r1', kind: 'deadline', predicted: 'X happens', confidence: 0.7, track: '北澜', verdict: null, eval_after: { by: '2026-07-01' } },
      { id: 'r2', kind: 'signal', predicted: 'Y risk', confidence: 0.5, track: 'orbis', verdict: null, eval_after: { by: '2026-07-04' } },
      { id: 'r3', kind: 'x', verdict: 'hit', eval_after: { by: '2026-07-01' } },
      { id: 'r4', kind: 'x', verdict: null, subjects: ['a'], eval_after: { by: '2026-07-01' } },
      { id: 'r5', kind: 'x', verdict: null, resolution: 'done', eval_after: { by: '2026-07-01' } },
      { id: 'r6', kind: 'x', verdict: null, eval_after: { by: '2026-08-01' } }
    ])
    expect(JSON.stringify(forecastOwed(dir, new Date('2026-07-06T12:00:00Z')))).toBe(
      '{"owed":[{"id":"r1","kind":"deadline","predicted":"X happens","confidence":0.7,"track":"北澜","eval_by":"2026-07-01","days_overdue":5},{"id":"r2","kind":"signal","predicted":"Y risk","confidence":0.5,"track":"orbis","eval_by":"2026-07-04","days_overdue":2}],"count":2,"selfResolving":1,"notDueYet":1}'
    )
  })
})
