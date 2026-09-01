import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Automation } from './automations-store'

// The tick's double-fire guard must dedup on the FULL date+time minute, not on
// hour+minute alone. With a date-less stamp a daily cron (`0 8 * * *` — exactly
// the seeded "Morning brief" template) fires on day 1, stores 80, and then on
// day 2 at 08:00 compares equal to its own last run and is skipped forever:
// silently once-per-process, with no error and no event-log row. Same mocking
// posture as automations-runner-autonomy.test.ts — store, agent, settings and
// the proactive substrate are stubbed so the guard is tested without a DB or a
// model. Only Date is faked so the real setTimeout-based flush still works.

const listAutomations = vi.fn(() => [] as Automation[])
const recordRun = vi.fn()
const runHeadlessAgent = vi.fn()
let settings: Record<string, unknown> = {}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/lamprey-test-irrelevant' },
  BrowserWindow: { getAllWindows: () => [] }
}))
const __claimedRuns = new Set<string>()
vi.mock('./automations-store', () => ({
  listAutomations: () => listAutomations(),
  recordRun: (...a: unknown[]) => recordRun(...a),
  // Durable idempotency ledger stub: mirror UNIQUE(automation_id,trigger_key,attempt)
  // — the first claim wins, duplicates (same key) get null. This is what replaced the
  // in-memory lastFiredMinute map; the dedup semantics are identical.
  beginAutomationRun: (input: { automationId: string; triggerKey: string; attempt: number }) => {
    const key = `${input.automationId}:${input.triggerKey}:${input.attempt}`
    if (__claimedRuns.has(key)) return null
    __claimedRuns.add(key)
    return 'run-' + key
  },
  settleAutomationRun: () => undefined,
  armAutomationRetry: () => undefined,
  clearAutomationRetry: () => undefined,
  pruneAutomationRuns: () => 0
}))
vi.mock('./headless-agent', () => ({
  runHeadlessAgent: (...a: unknown[]) => runHeadlessAgent(...a)
}))
vi.mock('./channel-dispatch', () => ({ channelDispatch: async () => ({ ok: true, kind: 'push' }) }))
vi.mock('./settings-helper', () => ({ readSettings: () => settings }))
vi.mock('./event-log', () => ({
  boundedJsonPreview: (v: unknown) => v,
  recordEvent: () => undefined
}))
vi.mock('./hooks-runner', () => ({ fireHooks: () => undefined }))
vi.mock('./proactive/delivery-queue', () => ({
  redeliverDue: async () => undefined,
  pruneDelivered: () => undefined
}))
vi.mock('./proactive/pending-interactions', () => ({
  sweepExpired: () => undefined,
  pruneInteractions: () => undefined
}))
vi.mock('./proactive/watchers', () => ({ watchJobFailed: async () => undefined }))
vi.mock('./proactive/smart-digest', () => ({
  parseDigestDirective: () => undefined,
  deliverDigest: async () => ({ text: '' })
}))

import { tick } from './automations-runner'

function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    label: 'Morning brief',
    cron: '0 8 * * *',
    prompt: 'brief me',
    model: null,
    enabled: true,
    createdAt: 0,
    lastRunAt: null,
    lastResult: null,
    scheduleLabel: null,
    deliverTo: null,
    trigger: { kind: 'schedule', cron: '* * * * *', maxAttempts: 3, retryDelaySeconds: 60 },
    nextRunAt: null,
    lastTriggerKey: null,
    retryAttempt: 0,
    retryAt: null,
    disabledReason: null,
    goalId: null,
    goalConversationId: null,
    loopMaxIterations: null,
    loopMaxWallclockMs: null,
    loopTokenBudget: null,
    ...over
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  __claimedRuns.clear()
  listAutomations.mockReset()
  recordRun.mockReset()
  runHeadlessAgent.mockReset()
  runHeadlessAgent.mockResolvedValue({ status: 'ok', output: 'ok', turns: 1, toolUses: [] })
  settings = { backgroundAutonomy: true, automationsEnabled: true }
  // Fake ONLY Date: the tick dispatches via `void runOne(...)` and the flush
  // below needs a real setTimeout to drain it.
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('automations tick — double-fire guard keys on the full date', () => {
  it('fires a daily cron again the NEXT day at the same time', async () => {
    listAutomations.mockReturnValue([auto({ id: 'daily-1' })])

    vi.setSystemTime(new Date(2026, 0, 1, 8, 0, 0))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)

    // Day 2, same wall-clock minute. The date-less stamp made this a no-op.
    vi.setSystemTime(new Date(2026, 0, 2, 8, 0, 0))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(2)

    vi.setSystemTime(new Date(2026, 0, 3, 8, 0, 0))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(3)
  })

  it('still suppresses a second tick within the SAME minute (drift guard intact)', async () => {
    listAutomations.mockReturnValue([auto({ id: 'drift-1' })])

    vi.setSystemTime(new Date(2026, 0, 1, 8, 0, 0))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)

    // Timer drifted and re-entered the same minute a few seconds later.
    vi.setSystemTime(new Date(2026, 0, 1, 8, 0, 42))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)
  })

  it('does not confuse 01:11 with 11:01 on the same day', async () => {
    // Unpadded `${hours}${minutes}` collapsed both of these to "111".
    listAutomations.mockReturnValue([auto({ id: 'ambig-1', cron: '1,11 1,11 * * *' })])

    vi.setSystemTime(new Date(2026, 0, 1, 1, 11, 0))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date(2026, 0, 1, 11, 1, 0))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(2)
  })
})
