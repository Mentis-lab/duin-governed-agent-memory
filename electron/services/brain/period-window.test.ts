// The window a periodic-report question is actually asking about.
//
// Measured on the real vault before this existed: 138 notes fell inside a given fortnight and
// retrieval returned 6 of them — 4% coverage — and the operator got a confident report built on it.
// searchK is clamped to 30, so breadth could never have closed that; the repo's own
// aggregation-arms.eval found stock DUIN 0/18 and searchK=30 also 0/18. Eligibility is the fix, and
// these are the rules that decide it.

import { describe, it, expect } from 'vitest'
import { looksLikePeriodicReport, resolvePeriodWindow } from './period-window'

const NOW = Date.parse('2026-06-21T14:30:00Z') // a Sunday afternoon, mid-request
const DAY = 86_400_000
const days = (w: { from: number; to: number }): number => Math.round((w.to - w.from) / DAY)
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10)

describe('looksLikePeriodicReport', () => {
  it('matches the CJK family that ends in a bare 报', () => {
    // 报告 does NOT match these, which is exactly why 双周报 used to fall through to the tool loop
    // while the English "biweekly report" routed correctly.
    for (const q of ['写一份双周报', '这周的周报', '本月月报', '季度报', '年报']) {
      expect(looksLikePeriodicReport(q), q).toBe(true)
    }
  })

  it('matches the English forms', () => {
    for (const q of ['draft my biweekly report', 'weekly report please', 'monthly report']) {
      expect(looksLikePeriodicReport(q), q).toBe(true)
    }
  })

  it('does not fire on an ordinary question', () => {
    for (const q of ['what did I decide about pricing', '帮我总结这份文档', '', 'report a bug']) {
      expect(looksLikePeriodicReport(q), q).toBe(false)
    }
  })

  it('still fires when the request ALSO wants a file written', () => {
    // Wanting the output saved is a separate question from which notes are eligible as input, so
    // this deliberately does not inherit generative-intent's file-signal suppression.
    expect(looksLikePeriodicReport('写双周报存到 reports/w29.md')).toBe(true)
  })
})

describe('resolvePeriodWindow — period lengths', () => {
  it('双周 is 14 days ending at the end of today', () => {
    const w = resolvePeriodWindow('写一份双周报', NOW)!
    expect(days(w)).toBe(14)
    // Ends at the end of TODAY, not at the last period boundary: someone asking mid-period wants
    // the days they most need to write about included.
    expect(iso(w.to - 1)).toBe('2026-06-21')
    expect(iso(w.from)).toBe('2026-06-08')
  })

  it('周 is 7, 月 is 30, 季度 is 91, 年 is 365', () => {
    expect(days(resolvePeriodWindow('周报', NOW)!)).toBe(7)
    expect(days(resolvePeriodWindow('月报', NOW)!)).toBe(30)
    expect(days(resolvePeriodWindow('季度报', NOW)!)).toBe(91)
    expect(days(resolvePeriodWindow('年报', NOW)!)).toBe(365)
  })

  it('双周 wins over 周, and 半月 over 月 — the longer period is tested first', () => {
    // 双周 CONTAINS 周; matching in the wrong order would silently halve the window and produce a
    // fortnightly report built on one week of evidence.
    expect(days(resolvePeriodWindow('双周报', NOW)!)).toBe(14)
    expect(days(resolvePeriodWindow('半月报', NOW)!)).toBe(14)
    expect(days(resolvePeriodWindow('biweekly report', NOW)!)).toBe(14)
  })
})

describe('resolvePeriodWindow — explicit ranges beat the inferred period', () => {
  it('reads an ISO range', () => {
    const w = resolvePeriodWindow('双周报 2026-06-08..2026-06-21', NOW)!
    expect(iso(w.from)).toBe('2026-06-08')
    expect(days(w)).toBe(14)
    expect(w.label).toBe('explicit range')
  })

  it('includes the LAST day the operator named', () => {
    // They wrote an inclusive range; a half-open window that stopped at midnight on the 21st would
    // drop that whole day's notes without saying so.
    const w = resolvePeriodWindow('2026-06-08 to 2026-06-21 的总结报告', NOW)!
    expect(iso(w.to - 1)).toBe('2026-06-21')
  })

  it('accepts CJK date shapes and normalises the order', () => {
    const w = resolvePeriodWindow('2026年6月21日 到 2026年6月8日 周报', NOW)!
    expect(iso(w.from)).toBe('2026-06-08')
    expect(iso(w.to - 1)).toBe('2026-06-21')
  })
})

describe('resolvePeriodWindow — refusing to guess', () => {
  it('returns null for a non-periodic question, which means "search unwindowed"', () => {
    // Null is a real answer and the common one. A wrong window is worse than no window: it silently
    // excludes evidence instead of visibly failing to narrow.
    expect(resolvePeriodWindow('what did I decide about pricing', NOW)).toBeNull()
    expect(resolvePeriodWindow('', NOW)).toBeNull()
    expect(resolvePeriodWindow('   ', NOW)).toBeNull()
  })

  it('returns null for a single date with no range and no period word', () => {
    expect(resolvePeriodWindow('2026-06-08 那天发生了什么', NOW)).toBeNull()
  })

  it('is deterministic for a given now', () => {
    expect(resolvePeriodWindow('双周报', NOW)).toEqual(resolvePeriodWindow('双周报', NOW))
  })
})
