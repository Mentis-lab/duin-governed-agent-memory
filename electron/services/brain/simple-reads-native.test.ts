import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { streamVerdicts, forecastOwed, cascadePending, listMeetings, confidentMisses } from './simple-reads-native'

describe('simple-reads-native', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-sr-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('streamVerdicts dumps the jsonl verbatim', () => {
    writeFileSync(join(sd, 'stream-verdicts.jsonl'), JSON.stringify({ id: 'a', outcome: 'hit' }) + '\n')
    expect(streamVerdicts(vault)).toEqual({ verdicts: [{ id: 'a', outcome: 'hit' }] })
  })

  it('forecastOwed surfaces subjects-empty, unresolved, past-due forecasts (sorted by overdue)', () => {
    writeFileSync(
      join(sd, 'risk-predictions.jsonl'),
      [
        JSON.stringify({ id: 'owed1', kind: 'forecast', predicted: 'x', eval_after: { by: '2026-06-01' } }), // owed (past, no verdict/subjects)
        JSON.stringify({ id: 'has-subj', subjects: ['t1'], eval_after: { by: '2026-06-01' } }), // has subjects → skip
        JSON.stringify({ id: 'resolved', verdict: 'materialized', eval_after: { by: '2026-06-01' } }), // resolved → skip
        JSON.stringify({ id: 'future', eval_after: { by: '2099-01-01' } }) // not due → skip
      ].join('\n') + '\n'
    )
    const r = forecastOwed(vault, new Date('2026-07-01T00:00:00Z'))
    expect(r.count).toBe(1)
    expect((r.owed[0] as { id: string }).id).toBe('owed1')
    expect((r.owed[0] as { days_overdue: number }).days_overdue).toBe(30)
  })

  it('confidentMisses surfaces subjects-empty, conf>=0.6, refuted forecasts (highest conf first)', () => {
    writeFileSync(
      join(sd, 'risk-predictions.jsonl'),
      [
        JSON.stringify({ id: 'm-hi', predicted: 'a', confidence: 0.9, outcome: 'miss' }), // confident miss
        JSON.stringify({ id: 'm-mid', predicted: 'b', confidence: 0.7, verdict: 'refuted' }), // confident miss (verdict form)
        JSON.stringify({ id: 'm-res', predicted: 'c', confidence: 0.8, resolution: 'miss' }), // confident miss (resolution form)
        JSON.stringify({ id: 'hedged', predicted: 'd', confidence: 0.5, outcome: 'miss' }), // <0.6 → skip
        JSON.stringify({ id: 'hit', predicted: 'e', confidence: 0.9, outcome: 'hit' }), // not a miss → skip
        JSON.stringify({ id: 'struct', predicted: 'f', outcome: 'miss' }), // no confidence → skip
        JSON.stringify({ id: 'signal', predicted: 'g', confidence: 0.9, outcome: 'miss', subjects: ['t'] }) // has subjects → skip
      ].join('\n') + '\n'
    )
    const r = confidentMisses(vault)
    expect(r.count).toBe(3)
    expect((r.misses as { id: string }[]).map((m) => m.id)).toEqual(['m-hi', 'm-res', 'm-mid']) // 0.9, 0.8, 0.7
  })

  it('cascadePending returns only status==pending items', () => {
    writeFileSync(
      join(sd, 'cascade-pending.jsonl'),
      [JSON.stringify({ id: 'p', status: 'pending' }), JSON.stringify({ id: 'a', status: 'applied' })].join('\n') + '\n'
    )
    expect(cascadePending(vault)).toEqual({ pending: [{ id: 'p', status: 'pending' }] })
  })

  it('listMeetings hides dismissed + sorts unconfirmed-before-confirmed then by when', () => {
    writeFileSync(
      join(sd, 'meetings.jsonl'),
      [
        JSON.stringify({ id: 'c', status: 'confirmed', when: '2026-07-01' }),
        JSON.stringify({ id: 'u', status: 'pending', when: '2026-07-05' }),
        JSON.stringify({ id: 'x', status: 'dismissed', when: '2026-07-02' })
      ].join('\n') + '\n'
    )
    const { meetings } = listMeetings(vault) as { meetings: { id: string }[] }
    expect(meetings.map((m) => m.id)).toEqual(['u', 'c']) // dismissed gone; unconfirmed first
  })

  it('null vault → empty', () => {
    expect(streamVerdicts(null)).toEqual({ verdicts: [] })
    expect(forecastOwed(null)).toEqual({ owed: [], count: 0, selfResolving: 0, notDueYet: 0 })
    expect(confidentMisses(null)).toEqual({ misses: [], count: 0 })
    expect(cascadePending(null)).toEqual({ pending: [] })
    expect(listMeetings(null)).toEqual({ meetings: [] })
  })
})
