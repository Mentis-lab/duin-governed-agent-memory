import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import { meritAutonomyEnabled } from './loop-controller'

describe('merit-autonomy flag (Phase 3b enforcement gate)', () => {
  const OLD = process.env.DUIN_MERIT_AUTONOMY
  afterEach(() => {
    if (OLD === undefined) delete process.env.DUIN_MERIT_AUTONOMY
    else process.env.DUIN_MERIT_AUTONOMY = OLD
  })

  it('default OFF (unset or not exactly "1") — so no other install changes', () => {
    delete process.env.DUIN_MERIT_AUTONOMY
    expect(meritAutonomyEnabled()).toBe(false)
    process.env.DUIN_MERIT_AUTONOMY = '0'
    expect(meritAutonomyEnabled()).toBe(false)
    process.env.DUIN_MERIT_AUTONOMY = 'true'
    expect(meritAutonomyEnabled()).toBe(false)
  })

  it('ON only when exactly "1"', () => {
    process.env.DUIN_MERIT_AUTONOMY = '1'
    expect(meritAutonomyEnabled()).toBe(true)
  })
})
