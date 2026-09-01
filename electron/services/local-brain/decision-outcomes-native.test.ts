import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadDecisionOutcomes, decisionTrackRecord, renderDecisionTrackRecord } from './decision-outcomes-native'

describe('decision-outcomes-native — reader + compaction (Phase 2)', () => {
  let dir: string
  const ledger = (): string => join(dir, '.duin', '_state', 'decision-outcomes.jsonl')
  const write = (lines: string[]): void => {
    mkdirSync(join(dir, '.duin', '_state'), { recursive: true })
    writeFileSync(ledger(), lines.join('\n') + '\n', 'utf-8')
  }
  const row = (o: Record<string, unknown>): string => JSON.stringify({ ts: '2026-07-01', surfaced_by: 'self', reversibility: 'low', review_on: '', note: '', ...o })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-decout-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('returns [] when the ledger is absent', () => {
    expect(loadDecisionOutcomes(dir)).toEqual([])
    expect(loadDecisionOutcomes(null)).toEqual([])
  })

  it('compacts to latest-per-id (the deferred Phase 0.4 dedup, applied at the reader)', () => {
    write([
      row({ id: 'd1', title: 'Ship it', verdict: 'partial' }),
      row({ id: 'd2', title: 'Hire', verdict: 'right' }),
      row({ id: 'd1', title: 'Ship it', verdict: 'right' }) // later verdict on d1 supersedes
    ])
    const rows = loadDecisionOutcomes(dir)
    expect(rows.length).toBe(2) // d1 deduped
    expect(rows.find((r) => r.id === 'd1')!.verdict).toBe('right') // latest wins
  })

  it('skips malformed lines and unknown verdicts', () => {
    write([
      'not json',
      row({ id: 'd1', title: 'A', verdict: 'right' }),
      row({ id: 'd2', title: 'B', verdict: 'maybe' }), // invalid verdict
      JSON.stringify({ title: 'no id', verdict: 'right' }) // missing id
    ])
    const rows = loadDecisionOutcomes(dir)
    expect(rows.map((r) => r.id)).toEqual(['d1'])
  })

  it('aggregates a track record with graded excluding unobserved', () => {
    write([
      row({ id: 'a', title: 'A', verdict: 'right' }),
      row({ id: 'b', title: 'B', verdict: 'wrong' }),
      row({ id: 'c', title: 'C', verdict: 'partial' }),
      row({ id: 'd', title: 'D', verdict: 'unobserved' })
    ])
    const rec = decisionTrackRecord(dir)
    expect(rec).toMatchObject({ total: 4, right: 1, wrong: 1, partial: 1, unobserved: 1, graded: 3 })
    expect(rec.recent.map((r) => r.verdict)).not.toContain('unobserved')
  })

  it('renders a compact block only when something is graded', () => {
    write([row({ id: 'd', title: 'D', verdict: 'unobserved' })])
    expect(renderDecisionTrackRecord(decisionTrackRecord(dir))).toBe('') // nothing graded → byte-identical prompt

    write([
      row({ id: 'a', title: 'Adopt X', verdict: 'right' }),
      row({ id: 'b', title: 'Kill Y', verdict: 'wrong' })
    ])
    const out = renderDecisionTrackRecord(decisionTrackRecord(dir))
    expect(out).toContain('OPERATOR DECISION TRACK RECORD')
    expect(out).toContain('1 right, 1 wrong')
    expect(out).toContain('"Kill Y" (wrong)')
  })
})
