// decision-loop.test — the automated closing arrow for owed decisions.
//
// The behaviour that matters most here is what it REFUSES to do. Retiring the Active Work
// panel removed the only path that resolved an owed decision, so this runs unattended in its
// place — and an unattended adjudicator that guessed 'cleared' would be manufacturing the
// ground truth the calibration metric exists to measure. These tests pin that it only ever
// closes a window as UNOBSERVED (excluded from hit-rate), never as a substantive call.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseDecideBy,
  daysPast,
  isUnobserved,
  runDecisionLoop,
  UNOBSERVED_GRACE_DAYS
} from './decision-loop'
import type { OpenLoop } from './types'

vi.mock('./decision-write-native', () => ({
  resolveNode: vi.fn(() => ({ ok: true }))
}))
import { resolveNode } from './decision-write-native'

const TODAY = new Date('2026-07-27T00:00:00Z')
const owed = (id: string, due?: string): OpenLoop =>
  ({ id: `owed::${id}`, kind: 'owed', title: id, node_id: id, due }) as OpenLoop

beforeEach(() => vi.mocked(resolveNode).mockClear())

describe('parseDecideBy / daysPast', () => {
  it('parses a plain ISO date and a datetime prefix', () => {
    expect(parseDecideBy('2026-07-01')?.toISOString().slice(0, 10)).toBe('2026-07-01')
    expect(parseDecideBy('2026-07-01T09:30:00Z')?.toISOString().slice(0, 10)).toBe('2026-07-01')
  })

  it('returns null for anything it cannot read, rather than a bogus date', () => {
    for (const bad of [undefined, null, '', 'someday', 'Q3', '2026-13-45']) {
      const d = parseDecideBy(bad as string | undefined)
      expect(d === null || !Number.isNaN(d.getTime())).toBe(true)
    }
    expect(parseDecideBy('someday')).toBeNull()
  })

  it('counts whole days past, negative while still open', () => {
    expect(daysPast(new Date('2026-07-20T00:00:00Z'), TODAY)).toBe(7)
    expect(daysPast(new Date('2026-08-01T00:00:00Z'), TODAY)).toBe(-5)
  })
})

describe('isUnobserved — when a window has genuinely lapsed', () => {
  it('an owed decision with NO deadline is never auto-closed', () => {
    // No window means nothing lapsed. Closing these would silently delete real pending work.
    expect(isUnobserved(undefined, TODAY)).toBe(false)
    expect(isUnobserved('someday', TODAY)).toBe(false)
  })

  it('stays open inside the window and through the grace period', () => {
    expect(isUnobserved('2026-08-10', TODAY)).toBe(false) // future
    expect(isUnobserved('2026-07-26', TODAY)).toBe(false) // 1d past
    expect(isUnobserved('2026-07-13', TODAY)).toBe(false) // exactly at grace (14d)
  })

  it('closes only once past the grace period', () => {
    expect(isUnobserved('2026-07-12', TODAY)).toBe(true) // 15d past
    expect(UNOBSERVED_GRACE_DAYS).toBe(14)
  })
})

describe('runDecisionLoop', () => {
  it('closes a lapsed window as ARCHIVE (unobserved), never as a substantive call', () => {
    const res = runDecisionLoop('/vault', [owed('D1', '2026-06-01')], TODAY)
    expect(res.unobserved).toBe(1)
    // The critical assertion: it must NOT claim the operator made a call.
    expect(res.resolved).toBe(0)
    const [, , action, note] = vi.mocked(resolveNode).mock.calls[0]
    expect(action).toBe('archive')
    expect(action).not.toBe('resolve')
    expect(String(note)).toMatch(/unobserved|not scored/)
  })

  it('leaves everything inside its window untouched', () => {
    const res = runDecisionLoop(
      '/vault',
      [owed('A', '2026-08-01'), owed('B', '2026-07-26'), owed('C')],
      TODAY
    )
    expect(res.open).toBe(3)
    expect(res.unobserved).toBe(0)
    expect(resolveNode).not.toHaveBeenCalled()
  })

  it('ignores loops that are not owed decisions', () => {
    const risk = { id: 'risk::r1', kind: 'risk', title: 'r', due: '2026-01-01' } as OpenLoop
    const res = runDecisionLoop('/vault', [risk], TODAY)
    expect(res.seen).toBe(0)
    expect(resolveNode).not.toHaveBeenCalled()
  })

  it('is a no-op without a vault, and never throws', () => {
    expect(runDecisionLoop(null, [owed('D1', '2026-01-01')], TODAY)).toEqual({
      seen: 0,
      resolved: 0,
      unobserved: 0,
      open: 0
    })
    vi.mocked(resolveNode).mockImplementationOnce(() => {
      throw new Error('register unreadable')
    })
    expect(() => runDecisionLoop('/vault', [owed('D1', '2026-01-01')], TODAY)).not.toThrow()
  })

  it('counts a failed close as still-open rather than reporting success', () => {
    vi.mocked(resolveNode).mockReturnValueOnce({ ok: false, error: 'not in register' })
    const res = runDecisionLoop('/vault', [owed('D1', '2026-01-01')], TODAY)
    expect(res.unobserved).toBe(0)
    expect(res.open).toBe(1)
  })
})
