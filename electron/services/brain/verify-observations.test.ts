import { describe, it, expect } from 'vitest'
import {
  parseCitedNotes,
  orphanCitations,
  coveredTracksIn,
  expectsCoverage
} from './verify-observations'

// PURE observation parsers for the 2BRAIN verify/DoD gates.

describe('parseCitedNotes', () => {
  it('extracts [x.md], (path/x.md), and `x.md` references, deduped', () => {
    const t = 'See [design.md] and (03 Projects/DUIN/plan.md), also `design.md` again.'
    expect(parseCitedNotes(t).sort()).toEqual(['03 Projects/DUIN/plan.md', 'design.md'])
  })
  it('ignores non-.md brackets and empty text', () => {
    expect(parseCitedNotes('a [b] (c) `d`')).toEqual([])
    expect(parseCitedNotes('')).toEqual([])
  })
})

describe('orphanCitations', () => {
  it('flags only citations the lookup positively rejects', () => {
    const exists = (r: string): boolean => r === 'real.md'
    expect(orphanCitations(['real.md', 'ghost.md'], exists)).toEqual(['ghost.md'])
  })
  it('a throwing lookup is treated as present (fail-safe-open, no false orphan)', () => {
    const exists = (): boolean => {
      throw new Error('lookup down')
    }
    expect(orphanCitations(['whatever.md'], exists)).toEqual([])
  })
})

describe('coveredTracksIn', () => {
  it('reports track keys present in the text (case-insensitive)', () => {
    const t = 'Progress on 北澜 and ait this week; nothing on the other line.'
    expect(coveredTracksIn(t, ['北澜', 'orbis', 'AIT']).sort()).toEqual(['AIT', '北澜'])
  })
  it('empty text covers nothing', () => {
    expect(coveredTracksIn('', ['北澜'])).toEqual([])
  })
})

describe('expectsCoverage', () => {
  it('true for digest/summary/roll-up/overview instructions', () => {
    for (const s of ['EOD digest across all tracks', 'weekly summary', 'roll-up of progress', 'overview recap']) {
      expect(expectsCoverage(s)).toBe(true)
    }
  })
  it('false for a point task', () => {
    expect(expectsCoverage('fix the flaky import test')).toBe(false)
    expect(expectsCoverage(null)).toBe(false)
  })
})
