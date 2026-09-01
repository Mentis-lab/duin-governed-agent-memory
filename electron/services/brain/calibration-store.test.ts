import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runCalibration, computeOpenIds } from './calibration-store'

describe('calibration-store', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-cal-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
    writeFileSync(join(sd, 'future-nodes.jsonl'), '')
    mkdirSync(join(vault, '北澜'), { recursive: true })
    // t1 open, t2 done — open_ids = {t1}
    writeFileSync(join(vault, '北澜', 'Tasks.md'), '- [ ] open one {{duinTaskId:: t1}}\n- [x] done two {{duinTaskId:: t2}}\n')
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('computeOpenIds includes non-done tasks only (no stale filter)', () => {
    const ids = computeOpenIds(vault)
    expect(ids.has('t1')).toBe(true)
    expect(ids.has('t2')).toBe(false)
  })

  it('resolves due rows (open subject→materialized, closed→averted) + writes both files', () => {
    writeFileSync(
      join(sd, 'risk-predictions.jsonl'),
      [
        JSON.stringify({ id: 'r1', kind: 'cascade', verdict: null, subjects: ['t1'], confidence: 0.85, eval_after: { by: '2026-06-01' } }),
        JSON.stringify({ id: 'r2', kind: 'cascade', verdict: null, subjects: ['t2'], confidence: 0.85, eval_after: { by: '2026-06-01' } })
      ].join('\n') + '\n'
    )
    const out = runCalibration(vault, new Date('2026-07-01T00:00:00Z'))
    expect(out.resolved).toBe(2)
    const rows = readFileSync(join(sd, 'risk-predictions.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows.find((r) => r.id === 'r1').verdict).toBe('materialized') // t1 still open
    expect(rows.find((r) => r.id === 'r2').verdict).toBe('averted') // t2 done
    const track = JSON.parse(readFileSync(join(sd, 'forecast-track-record.json'), 'utf-8'))
    expect(track.patterns.cascade.fired).toBe(2)
    expect(track.min_n).toBe(20)
    expect(track.confidence_calibration.high.observed).toBe(2)
  })

  // REGRESSION (data loss): runCalibration read the ledger through a readJsonl that dropped
  // any line failing JSON.parse, then rewrote the WHOLE file from that surviving subset on
  // res.dirty — permanently deleting every unparseable line from the only copy on disk. The
  // ledger is an accrued track record (created dates, verdicts, operator resolutions) that
  // cannot be recomputed; the generator would at best re-append the row as a fresh
  // verdict:null row dated today, silently resetting its calibration history.
  // graph-history-store.ts exists to enforce exactly this preservation rule; this call site
  // implemented its atomic-write rule and skipped its preserve-verbatim rule.
  it('preserves unparseable lines VERBATIM through the dirty rewrite', () => {
    // The live scenario: a sync/crash tears the last line, then the next append concatenates
    // a complete new row onto the fragment → ONE unparseable line that CONTAINS a real row
    // (with its own created date and a resolved verdict). r1 resolves → res.dirty → rewrite.
    const torn =
      '{"id":"r0","kind":"cascade","created":"2026-01-05","verdict":"averted","subjects":["t2"]' +
      JSON.stringify({ id: 'r9', kind: 'cascade', created: '2026-01-06', verdict: 'materialized', subjects: ['t1'], confidence: 0.9, eval_after: { by: '2026-06-01' } })
    writeFileSync(
      join(sd, 'risk-predictions.jsonl'),
      [
        JSON.stringify({ id: 'r1', kind: 'cascade', verdict: null, subjects: ['t1'], confidence: 0.85, eval_after: { by: '2026-06-01' } }),
        torn
      ].join('\n') + '\n'
    )

    const out = runCalibration(vault, new Date('2026-07-01T00:00:00Z'))
    expect(out.resolved).toBe(1) // r1 newly resolved → the ledger WAS rewritten
    expect(out.preservedCorruptLines).toBe(1) // and the damage is reported, not silent

    const after = readFileSync(join(sd, 'risk-predictions.jsonl'), 'utf-8').trim().split('\n')
    // The torn line survives byte-for-byte, in place — with the r0 created date, the r9
    // payload and both verdicts still recoverable by hand.
    expect(after).toContain(torn)
    expect(after.length).toBe(2)
    // The parsed row is still resolved + rewritten as before (preservation is not refusal).
    expect(JSON.parse(after[0]).verdict).toBe('materialized')
  })

  it('does not lose an unparseable line even when it is the ONLY line', () => {
    const torn = '{"id":"r0","created":"2026-01-05","verdict":"averted"'
    writeFileSync(join(sd, 'risk-predictions.jsonl'), torn + '\n')
    const out = runCalibration(vault, new Date('2026-07-01T00:00:00Z'))
    expect(out.preservedCorruptLines).toBe(1)
    expect(readFileSync(join(sd, 'risk-predictions.jsonl'), 'utf-8')).toContain(torn)
  })

  it('null vault → no-op', () => {
    // both additive fields on a no-op run: drift map empty, proper-score at n=0
    const out = runCalibration(null)
    expect(out.resolved).toBe(0)
    expect(out.patterns).toBe(0)
    expect(out.confidenceCalibration).toEqual({})
    expect(out.properScore.n).toBe(0)
    expect(out.properScore.brier).toBe(null)
  })

  it('computes a Brier proper score over resolved probabilistic rows', () => {
    // Two already-resolved cascade forecasts (verdict set → idempotent, resolver leaves them):
    //   materialized @ conf 0.8 → (0.8-1)^2 = 0.04
    //   refuted      @ conf 0.3 → (0.3-0)^2 = 0.09
    //   Brier = mean(0.04, 0.09) = 0.065
    writeFileSync(
      join(sd, 'risk-predictions.jsonl'),
      [
        JSON.stringify({ id: 'r1', kind: 'cascade', verdict: 'materialized', subjects: ['t1'], confidence: 0.8, eval_after: { by: '2026-06-01' } }),
        JSON.stringify({ id: 'r2', kind: 'cascade', verdict: 'refuted', subjects: ['t2'], confidence: 0.3, eval_after: { by: '2026-06-01' } })
      ].join('\n') + '\n'
    )
    const out = runCalibration(vault, new Date('2026-07-01T00:00:00Z'))
    expect(out.properScore.n).toBe(2)
    expect(out.properScore.brier).toBeCloseTo(0.065, 9)
  })
})
