// fullComputerAccess() — the reader behind every "may DUIN act outside the vault?" decision
// (file tools, the file browser, the shell sandbox, and the agui gate). Public-build default is
// CONFINED, and the reader is FAIL-CLOSED: only an explicit `true` in settings.json opens the
// machine. The previous reading (`!== false`, catch → true) made a fresh install AND a torn or
// unreadable settings file both unconfined — the polarity A4 F1 / A6 F1 flagged as the binary
// blocker. These pins fail on any build that drifts back to that reading.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state: { settings: Record<string, unknown>; throws: boolean } = { settings: {}, throws: false }

vi.mock('../settings-helper', () => ({
  readSettings: (): Record<string, unknown> => {
    if (state.throws) throw new Error('settings unreadable')
    return state.settings
  }
}))

import { fullComputerAccess } from './operator-write-paths'

beforeEach(() => {
  state.settings = {}
  state.throws = false
})

describe('fullComputerAccess — OFF by default, fail-closed', () => {
  it('is OFF on a fresh install (no key persisted)', () => {
    expect(fullComputerAccess()).toBe(false)
  })

  it('is ON only for an explicit boolean true', () => {
    state.settings = { fullComputerAccess: true }
    expect(fullComputerAccess()).toBe(true)
  })

  it('treats every non-true value as OFF — a string, a number, null, undefined', () => {
    for (const v of ['true', 1, null, undefined, 'yes', {}]) {
      state.settings = { fullComputerAccess: v }
      expect(fullComputerAccess(), `value ${String(v)} must read as OFF`).toBe(false)
    }
  })

  it('reads as OFF when the settings file cannot be read (fail-closed, never fail-open)', () => {
    state.throws = true
    expect(fullComputerAccess()).toBe(false)
  })

  it('an explicit false is OFF', () => {
    state.settings = { fullComputerAccess: false }
    expect(fullComputerAccess()).toBe(false)
  })
})
