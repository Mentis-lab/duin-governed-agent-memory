// Backlog finding 17. The minimum-dispatch-gap floor was measured from `lastRunAt`,
// which automations-store writes on recordRun — at COMPLETION. The built-in preset list's
// second entry is a five-minute cron, and the floor is five minutes, so the next tick
// landed exactly 5 minutes after the run STARTED, i.e. LESS than 5 minutes after it
// finished. That tick was skipped, and the automation actually ran at ~10-minute cadence
// forever, with nothing in the Automations panel indicating the schedule wasn't what was
// configured.
//
// Measuring from DISPATCH makes the floor mean what it says.

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-cadence-floor', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('./settings-helper', () => ({ readSettings: () => ({}) }))

import { cadenceFloorPasses } from './automations-runner'

const MIN = 5 * 60_000
const T0 = 1_000_000

describe('cadenceFloorPasses — a five-minute schedule must run every five minutes', () => {
  it('admits the tick 5 minutes after DISPATCH, even though the run finished later', () => {
    // Dispatched at T0, took 40s. The old code compared against the completion time,
    // so at T0+5min it saw only 4m20s elapsed and skipped — halving the cadence.
    expect(
      cadenceFloorPasses({
        nowMs: T0 + MIN,
        lastDispatchAt: T0,
        lastRunAt: T0 + 40_000,
        retryDue: false,
        minGapMs: MIN
      })
    ).toBe(true)
  })

  it('still refuses a tick closer than the floor', () => {
    expect(
      cadenceFloorPasses({
        nowMs: T0 + MIN - 1,
        lastDispatchAt: T0,
        lastRunAt: null,
        retryDue: false,
        minGapMs: MIN
      })
    ).toBe(false)
  })

  it('falls back to the persisted completion time when this process has not dispatched yet', () => {
    // After a restart there is no in-process dispatch record. Conservative, never faster
    // than the floor: measuring from completion can only ever delay a tick.
    expect(
      cadenceFloorPasses({
        nowMs: T0 + MIN,
        lastDispatchAt: null,
        lastRunAt: T0 + 40_000,
        retryDue: false,
        minGapMs: MIN
      })
    ).toBe(false)
    expect(
      cadenceFloorPasses({
        nowMs: T0 + MIN + 40_000,
        lastDispatchAt: null,
        lastRunAt: T0 + 40_000,
        retryDue: false,
        minGapMs: MIN
      })
    ).toBe(true)
  })

  it('admits an automation that has never run', () => {
    expect(
      cadenceFloorPasses({
        nowMs: T0,
        lastDispatchAt: null,
        lastRunAt: null,
        retryDue: false,
        minGapMs: MIN
      })
    ).toBe(true)
  })

  it('exempts a due retry — retryAt is already backoff-paced', () => {
    expect(
      cadenceFloorPasses({
        nowMs: T0 + 1000,
        lastDispatchAt: T0,
        lastRunAt: T0,
        retryDue: true,
        minGapMs: MIN
      })
    ).toBe(true)
  })
})
