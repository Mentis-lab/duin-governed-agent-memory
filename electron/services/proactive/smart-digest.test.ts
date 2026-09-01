import { describe, it, expect } from 'vitest'
import type { HomeDigest } from '../brain/home-digest'
import type { CalibrationReport } from '../brain/types'
import type { ChannelRef } from '../channel-dispatch'
import type { DeliveryReceipt } from './delivery-queue'
import {
  buildDigestBrief,
  renderDigestBrief,
  countDueForecasts,
  parseDigestDirective,
  digestDirective,
  digestJobTemplates,
  deliverDigest,
  DIGEST_DIRECTIVE_PREFIX
} from './smart-digest'

// ──────────────────── fixtures ────────────────────

function digestFixture(over: Partial<HomeDigest> = {}): HomeDigest {
  return {
    tracks: [
      { key: 'proj-a', label: 'Project A', open: 3, dueSoon: 1, risks: 0, status: 'active', reason: '3 open · 1 due soon', tone: 'accent' }
    ],
    insights: [
      { id: 'conv::1', kind: 'insight', subtype: 'risk', title: 'Vendor slip risk', why: 'two deps late', score: 0.8, reason: 'risk pattern', tone: 'warning' }
    ],
    needs: [
      { id: 'loop-1', kind: 'need', subtype: 'owed', title: 'Decide budget', why: 'Q3 planning', score: 0.9, reason: 'due tomorrow', tone: 'warning', due: '2026-07-15' }
    ],
    away: '2 forecasts resolved · foresight 75% on point',
    returnReason: 'Decide budget is still waiting on your call (due tomorrow).',
    generatedAt: '2026-07-14T08:00:00.000Z',
    ...over
  }
}

function calFixture(over: Partial<CalibrationReport> = {}): CalibrationReport {
  return {
    buckets: [],
    totals: { logged: 10, resolved: 4, hit_rate: 0.75 },
    recent: [
      { id: 'f1', kind: 'risk', title: 'A', due: '2026-07-10', created_at: '2026-07-01', outcome: 'unobserved' },
      { id: 'f2', kind: 'risk', title: 'B', due: '2026-07-13', created_at: '2026-07-01', outcome: 'unobserved' },
      { id: 'f3', kind: 'risk', title: 'C', due: '2026-07-20', created_at: '2026-07-01', outcome: 'unobserved' }, // future → not due
      { id: 'f4', kind: 'risk', title: 'D', due: '2026-07-09', created_at: '2026-07-01', outcome: 'happened' } // resolved → not due
    ],
    ...over
  }
}

const TODAY = '2026-07-14'

// ──────────────────── countDueForecasts ────────────────────

describe('countDueForecasts', () => {
  it('counts only unobserved forecasts with a due date on/before today', () => {
    expect(countDueForecasts(calFixture(), TODAY)).toBe(2) // f1, f2
  })
  it('is 0 for an empty ledger', () => {
    expect(countDueForecasts(calFixture({ recent: [] }), TODAY)).toBe(0)
  })
  it('ignores undated and future forecasts', () => {
    const cal = calFixture({
      recent: [
        { id: 'x', kind: 'k', title: 'x', due: null, created_at: '2026-07-01', outcome: 'unobserved' },
        { id: 'y', kind: 'k', title: 'y', due: '2999-01-01', created_at: '2026-07-01', outcome: 'unobserved' }
      ]
    })
    expect(countDueForecasts(cal, TODAY)).toBe(0)
  })
})

// ──────────────────── buildDigestBrief ────────────────────

describe('buildDigestBrief', () => {
  it('composes a morning brief from digest + calibration', () => {
    const brief = buildDigestBrief({ mode: 'morning', today: TODAY, digest: digestFixture(), calibration: calFixture(), name: 'Theo' })
    expect(brief.mode).toBe('morning')
    expect(brief.headline).toContain('Good morning, Theo')
    expect(brief.needs).toEqual([{ title: 'Decide budget', reason: 'due tomorrow' }])
    expect(brief.tracks).toEqual([{ label: 'Project A', reason: '3 open · 1 due soon' }])
    expect(brief.insights[0].title).toBe('Vendor slip risk')
    expect(brief.forecasts).toEqual({ dueCount: 2, resolved: 4, hitRatePct: 75 })
    expect(brief.away).toBe('2 forecasts resolved · foresight 75% on point')
    expect(brief.empty).toBe(false)
  })

  it('EOD brief drops the away line and uses reconciliation headline', () => {
    const brief = buildDigestBrief({ mode: 'eod', today: TODAY, digest: digestFixture(), calibration: calFixture() })
    expect(brief.headline).toContain('End-of-day')
    expect(brief.away).toBeNull()
  })

  it('flags an empty vault when nothing surfaces', () => {
    const empty = digestFixture({ tracks: [], insights: [], needs: [], away: null, returnReason: '' })
    const brief = buildDigestBrief({ mode: 'morning', today: TODAY, digest: empty, calibration: calFixture({ totals: { logged: 0, resolved: 0, hit_rate: null }, recent: [] }) })
    expect(brief.empty).toBe(true)
  })

  it('caps each section to 3 rows', () => {
    const many = digestFixture({
      needs: Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, kind: 'need', subtype: 'owed', title: `Need ${i}`, why: '', score: 0.5, reason: 'x', tone: 'neutral' as const }))
    })
    const brief = buildDigestBrief({ mode: 'morning', today: TODAY, digest: many, calibration: calFixture() })
    expect(brief.needs).toHaveLength(3)
  })
})

// ──────────────────── renderDigestBrief ────────────────────

describe('renderDigestBrief', () => {
  it('renders a full morning brief to sectioned text', () => {
    const brief = buildDigestBrief({ mode: 'morning', today: TODAY, digest: digestFixture(), calibration: calFixture() })
    const text = renderDigestBrief(brief)
    expect(text).toContain('☀️ Morning brief · 2026-07-14')
    expect(text).toContain('🔴 Needs you')
    expect(text).toContain('• Decide budget (due tomorrow)')
    expect(text).toContain('📉 Forecasts')
    expect(text).toContain('2 forecasts due for a verdict')
    expect(text).toContain('4 resolved so far · foresight 75% on point')
    expect(text).toContain('↩️ Jump back in')
    expect(text).toContain('💡 Brain noticed')
    expect(text).toContain('Since you were away:')
    expect(text).toContain('Today: Decide budget is still waiting')
  })

  it('EOD render omits the jump-back-in tracks and away line, uses Tomorrow sign-off', () => {
    const brief = buildDigestBrief({ mode: 'eod', today: TODAY, digest: digestFixture(), calibration: calFixture() })
    const text = renderDigestBrief(brief)
    expect(text).toContain('🌙 End-of-day')
    expect(text).not.toContain('↩️ Jump back in')
    expect(text).not.toContain('Since you were away')
    expect(text).toContain('Tomorrow:')
  })

  it('empty brief renders a friendly quiet message', () => {
    const empty = digestFixture({ tracks: [], insights: [], needs: [], away: null, returnReason: '' })
    const brief = buildDigestBrief({ mode: 'morning', today: TODAY, digest: empty, calibration: calFixture({ totals: { logged: 0, resolved: 0, hit_rate: null }, recent: [] }) })
    const text = renderDigestBrief(brief)
    expect(text).toContain('Nothing pressing surfaced today')
  })
})

// ──────────────────── directive + job templates ────────────────────

describe('digest directive + job templates', () => {
  it('round-trips the directive', () => {
    expect(digestDirective('morning')).toBe(`${DIGEST_DIRECTIVE_PREFIX}morning`)
    expect(parseDigestDirective(digestDirective('morning'))).toBe('morning')
    expect(parseDigestDirective(digestDirective('eod'))).toBe('eod')
  })
  it('returns null for ordinary prompts and bad modes', () => {
    expect(parseDigestDirective('summarize my inbox')).toBeNull()
    expect(parseDigestDirective(`${DIGEST_DIRECTIVE_PREFIX}weekly`)).toBeNull()
    expect(parseDigestDirective(null)).toBeNull()
  })
  it('seeds a morning + EOD job pointed at the given channel', () => {
    const ref: ChannelRef = { kind: 'telegram', target: 'chat-1' }
    const jobs = digestJobTemplates(ref)
    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toMatchObject({ label: 'Morning brief', cron: '0 8 * * *', prompt: `${DIGEST_DIRECTIVE_PREFIX}morning` })
    expect(jobs[1]).toMatchObject({ label: 'EOD reconciliation', cron: '0 18 * * *' })
    expect(JSON.parse(jobs[0].deliverTo)).toEqual({ kind: 'telegram', target: 'chat-1' })
  })
})

// ──────────────────── deliverDigest ────────────────────

describe('deliverDigest', () => {
  const ref: ChannelRef = { kind: 'telegram', target: 'chat-1' }

  it('composes the live brief and enqueues the rendered text', async () => {
    const calls: { ref: ChannelRef; text: string; meta: Record<string, unknown> }[] = []
    const enq = async (r: ChannelRef, text: string, meta: Record<string, unknown>): Promise<DeliveryReceipt> => {
      calls.push({ ref: r, text, meta })
      return { id: 'd1', ok: true, status: 'delivered' }
    }
    const res = await deliverDigest('morning', {
      getDigest: () => digestFixture(),
      getCalibration: () => calFixture(),
      ref,
      enqueue: enq,
      today: TODAY
    })
    expect(res.delivered).toBe(true)
    expect(res.text).toContain('☀️ Morning brief')
    expect(calls).toHaveLength(1)
    expect(calls[0].meta).toMatchObject({ source: 'digest', mode: 'morning' })
  })

  it('never throws — a reader failure resolves to {delivered:false}', async () => {
    const res = await deliverDigest('eod', {
      getDigest: () => { throw new Error('vault gone') },
      getCalibration: () => calFixture(),
      ref
    })
    expect(res.delivered).toBe(false)
    expect(res.error).toContain('vault gone')
  })
})
