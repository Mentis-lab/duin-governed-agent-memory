import { describe, it, expect, vi } from 'vitest'

// `automations-runner` imports `automations-store` (→ database) and
// `providers/registry` (→ electron). The describeCron + nextFireAfter
// helpers are pure of those deps but module-load triggers the chain;
// stub electron + the store so the test stays self-contained.

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/lamprey-test-irrelevant' },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('./automations-store', () => ({
  listAutomations: () => [],
  recordRun: () => undefined
}))

// runOne now imports the headless-agent + channel-dispatch chains (tool-registry,
// tool-exec, plugin-loader …). These pure-helper tests don't exercise runOne, so
// stub those modules to keep the import graph light and electron-free.
vi.mock('./headless-agent', () => ({ runHeadlessAgent: async () => ({ status: 'ok', output: '', turns: 0, toolUses: [] }) }))
vi.mock('./channel-dispatch', () => ({ channelDispatch: async () => ({ ok: true, kind: 'push' }) }))
vi.mock('./settings-helper', () => ({ readSettings: () => ({}) }))

vi.mock('./event-log', () => ({
  boundedJsonPreview: (v: unknown) => v,
  recordEvent: () => undefined
}))

import { describeCron, nextFireAfter, parseCron } from './automations-runner'

describe('parseCron', () => {
  it('accepts 5-field expressions', () => {
    expect(() => parseCron('*/5 * * * *')).not.toThrow()
    expect(() => parseCron('0 9 * * 1-5')).not.toThrow()
  })

  it('rejects non-5-field expressions', () => {
    expect(() => parseCron('*/5 *')).toThrow(/5 fields/)
    expect(() => parseCron('* * * * * *')).toThrow(/5 fields/)
  })

  it('rejects out-of-range numbers', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/bad field/)
    expect(() => parseCron('* 24 * * *')).toThrow(/bad field/)
  })

  it('rejects ranges whose endpoints exceed the field bounds', () => {
    // Regression: the range branch used to iterate lo..hi without bounding
    // the endpoints, so `1-20000000` spun a 20M-iteration loop on the main
    // thread (freezing Electron) instead of rejecting fast. Must throw
    // promptly, not hang.
    expect(() => parseCron('0 0 1-20000000 * *')).toThrow(/bad field range/)
    expect(() => parseCron('0-99 * * * *')).toThrow(/bad field range/)
  })

  it('rejects the explicit-range form of a step whose endpoints exceed bounds', () => {
    // Same unbounded-loop hazard via the `lo-hi/N` step form.
    expect(() => parseCron('0 0 1-20000000/1 * *')).toThrow(/bad field range/)
    expect(() => parseCron('0-99/2 * * * *')).toThrow(/bad field range/)
  })

  it('rejects inverted ranges', () => {
    expect(() => parseCron('30-10 * * * *')).toThrow(/bad field range/)
  })

  it('still accepts valid in-bounds ranges and steps', () => {
    expect(() => parseCron('0 9 * * 1-5')).not.toThrow()
    expect(() => parseCron('0-30/5 * * * *')).not.toThrow()
  })
})

describe('describeCron', () => {
  it('returns presets verbatim for common patterns', () => {
    expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes')
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 09:00')
    expect(describeCron('0 0 * * *')).toBe('Daily at midnight')
  })

  // REGRESSION PIN. This used to be a 12-entry lookup table with a fallback that described
  // ONLY minutes and hours, so every schedule outside the table silently lost its DAY. The
  // commonest real one there is — `0 21 * * 0` — came out as "at minute 0, at hour 21":
  // true, useless, and missing the word "Sunday". The day is what someone is actually
  // checking when they scan a list of automations.
  it('names the day, not just the clock', () => {
    expect(describeCron('0 21 * * 0')).toBe('Every Sunday 21:00')
    expect(describeCron('30 17 * * 5')).toBe('Every Friday 17:30')
    expect(describeCron('0 17 28 * *')).toBe('Monthly on the 28th 17:00')
    expect(describeCron('0 8 * * 0,6')).toBe('Weekends 08:00')
  })

  it('renders an ordinary daily time as a time, not as two field summaries', () => {
    expect(describeCron('15 14 * * *')).toBe('Every day 14:15')
  })

  it('still summarises genuinely irregular patterns rather than lying', () => {
    // Multiple hours on specific weekdays has no short phrasing — it must degrade, but it
    // must not silently drop the weekday the way the old fallback did.
    const out = describeCron('0 9,17 * * 1')
    expect(out).toContain('Monday')
  })

  it('returns null on a malformed expression', () => {
    expect(describeCron('not a cron')).toBeNull()
  })
})

describe('nextFireAfter', () => {
  it('returns a Date at second 0 for a future minute', () => {
    const from = new Date('2026-06-03T12:34:00Z')
    const next = nextFireAfter('*/5 * * * *', from)
    expect(next).not.toBeNull()
    expect(next!.getSeconds()).toBe(0)
    // Must be strictly after `from`.
    expect(next!.getTime()).toBeGreaterThan(from.getTime())
  })

  it('returns null for an unparseable expression', () => {
    expect(nextFireAfter('not a cron')).toBeNull()
  })

  it('finds the next "0 9 * * *" within 24h', () => {
    const from = new Date('2026-06-03T12:00:00')
    const next = nextFireAfter('0 9 * * *', from)
    expect(next).not.toBeNull()
    expect(next!.getHours()).toBe(9)
    expect(next!.getMinutes()).toBe(0)
  })
})
