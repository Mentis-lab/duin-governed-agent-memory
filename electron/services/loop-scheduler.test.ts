import { describe, it, expect, vi } from 'vitest'

// isDue is pure, but the module imports settings-helper (electron) + loop-agent
// (provider chain). Mock them so only the pure due-logic is exercised.
vi.mock('./settings-helper', () => ({ readSettings: () => ({}) }))
vi.mock('./loop-agent', () => ({ runLoopAgentic: async () => ({ ran: false, loop: '' }) }))

import { isDue } from './loop-scheduler'

// Fixed "now": Friday 2026-06-26 16:45 (parity with the python is_due check).
const NOW = new Date(2026, 5, 26, 16, 45, 0)

describe('isDue — parity with loop_runner.py', () => {
  it('daily_at past + already ran today → NOT due', () => {
    expect(isDue({ daily_at: '08:00' }, '2026-06-26T11:47:19', NOW)).toBe(false)
  })
  it('daily_at past + never ran → due', () => {
    expect(isDue({ daily_at: '08:00' }, undefined, NOW)).toBe(true)
  })
  it('daily_at in the future today → NOT due', () => {
    expect(isDue({ daily_at: '21:30' }, undefined, NOW)).toBe(false)
  })

  it('every_hours: last 5h ago → NOT due', () => {
    expect(isDue({ every_hours: 6 }, '2026-06-26T11:45:00', NOW)).toBe(false)
  })
  it('every_hours: last 7h ago → due', () => {
    expect(isDue({ every_hours: 6 }, '2026-06-26T09:30:00', NOW)).toBe(true)
  })
  it('every_hours: never ran → due', () => {
    expect(isDue({ every_hours: 6 }, undefined, NOW)).toBe(true)
  })

  it('weekly other day, never ran → NOT due', () => {
    expect(isDue({ weekly_on: 'sun', at: '18:00' }, undefined, NOW)).toBe(false)
  })
  it('weekly other day, last >7d ago → due (missed week catch-up)', () => {
    expect(isDue({ weekly_on: 'sun', at: '18:00' }, '2026-06-18T18:00:00', NOW)).toBe(true)
  })
  it('weekly today, target passed, never ran → due', () => {
    expect(isDue({ weekly_on: 'fri', at: '12:00' }, undefined, NOW)).toBe(true)
  })
  it('weekly today, before target → NOT due', () => {
    expect(isDue({ weekly_on: 'fri', at: '18:00' }, undefined, NOW)).toBe(false)
  })

  it('unknown schedule → NOT due (fail-safe)', () => {
    expect(isDue({}, undefined, NOW)).toBe(false)
    expect(isDue({ weekly_on: 'xyz' }, undefined, NOW)).toBe(false)
  })
})
