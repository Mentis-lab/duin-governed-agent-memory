import { describe, it, expect, vi } from 'vitest'

// The pane imports ipc-client, which reads `window.api` at module scope. This env is
// node-only (no jsdom), so the import alone would throw before a single assertion runs.
// Only the pure helpers below are under test; the IPC surface is exercised by
// electron/services/event-log-policy-usage-node.test.ts on the other side of the wire.
vi.mock('@/lib/ipc-client', () => ({ query: vi.fn() }))

import { buildUsageIndex, formatUsage } from './PermissionsSettings'
import type { PolicyUsage } from '@/lib/types'

// The Permissions pane's activity line — what a standing grant has decided on its own.
// Node-only helpers, no jsdom render, per the ChannelsSettings.test.tsx convention.
//
// The pane already lists and revokes policies. What it could not tell you was whether a
// given grant had ever been USED, which is the fact that decides whether you keep it.
//
// The load-bearing assertion in here is the same shape as the one this pane already
// carries for its policy list (U1): on a security surface, "I could not read it" must
// never render as "there is nothing there".

const usage = (over: Partial<PolicyUsage> = {}): PolicyUsage => ({
  policyId: 'p1',
  n: 4,
  denied: 0,
  lastAt: Date.now() - 3_600_000,
  ...over
})

describe('buildUsageIndex — unknown is not zero', () => {
  it('indexes usage by policy id when the read succeeded', () => {
    const idx = buildUsageIndex({
      policies: [],
      memoryFallback: false,
      usage: [usage({ policyId: 'a' }), usage({ policyId: 'b' })]
    })
    expect(idx?.get('a')?.policyId).toBe('a')
    expect(idx?.size).toBe(2)
  })

  it('an empty array from a SUCCESSFUL read means genuinely zero, and is kept', () => {
    const idx = buildUsageIndex({ policies: [], memoryFallback: false, usage: [] })
    expect(idx).not.toBeNull()
    expect(idx?.size).toBe(0)
  })

  // The one that matters. A failed aggregate returns [] — identical on the wire to
  // "no policy has ever fired". Collapsing to null makes the rows render no claim at all.
  it('a FAILED read is null, never an empty index, so no row can claim "Never used"', () => {
    const idx = buildUsageIndex({
      policies: [],
      memoryFallback: false,
      usage: [],
      usageError: 'database is locked'
    })
    expect(idx).toBeNull()
  })

  it('an older main process that reports no usage field at all is also unknown', () => {
    expect(buildUsageIndex({ policies: [], memoryFallback: false })).toBeNull()
  })
})

describe('formatUsage', () => {
  it('says a grant has never fired — the row you can delete for free', () => {
    expect(formatUsage(undefined)).toBe('Never used')
  })

  it('counts what the policy decided without asking', () => {
    expect(formatUsage(usage({ n: 47 }))).toMatch(/47 calls/)
    expect(formatUsage(usage({ n: 47 }))).toMatch(/on its own/)
  })

  it('singularizes one call', () => {
    expect(formatUsage(usage({ n: 1 }))).toMatch(/1 call\b/)
  })

  it('surfaces denies — a grant quietly blocking work is not an idle grant', () => {
    expect(formatUsage(usage({ n: 10, denied: 3 }))).toMatch(/3 denied/)
  })

  it('omits the denied clause entirely when there are none', () => {
    expect(formatUsage(usage({ n: 10, denied: 0 }))).not.toMatch(/denied/)
  })

  // Resolution matters here: on the coarse policy-age scale a grant that fired four
  // minutes ago and one that last fired twenty hours ago both read "today", and those
  // are not the same fact when deciding whether to revoke.
  it('resolves recent activity to minutes and hours, not "today"', () => {
    expect(formatUsage(usage({ lastAt: Date.now() - 4 * 60_000 }))).toMatch(/4 minutes ago/)
    expect(formatUsage(usage({ lastAt: Date.now() - 20 * 3_600_000 }))).toMatch(/20 hours ago/)
    expect(formatUsage(usage({ lastAt: Date.now() - 5_000 }))).toMatch(/just now/)
  })

  it('falls back to the coarse scale beyond a day', () => {
    expect(formatUsage(usage({ lastAt: Date.now() - 3 * 86_400_000 }))).toMatch(/3 days ago/)
  })
})
