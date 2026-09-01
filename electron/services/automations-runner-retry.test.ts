import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Automation } from './automations-store'

// Retry / backoff is now WIRED (previously inert): retryAt() computed an exponential
// backoff and the automations table carried retry_at/retry_attempt, but no code path
// ever re-fired a failed run — tick() always claimed attempt 1 and settled failures to
// 'failed' without arming or consuming a retry. These tests pin the live behavior:
//   - a transiently failing run arms the next attempt with the trigger's backoff,
//   - a due retry re-fires on a distinct ledger key and consumes its retry_at,
//   - the retry budget is capped at maxAttempts (no unbounded re-fire),
//   - success and deliberate 'aborted' never arm a retry.
// Same mocking posture as automations-runner-dedup.test.ts. automation-trigger is NOT
// mocked, so the real retryAt() backoff drives the timing.

const listAutomations = vi.fn(() => [] as Automation[])
const recordRun = vi.fn()
const runHeadlessAgent = vi.fn()
const armAutomationRetry = vi.fn()
const clearAutomationRetry = vi.fn()
let settings: Record<string, unknown> = {}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/lamprey-test-irrelevant' },
  BrowserWindow: { getAllWindows: () => [] }
}))
const __claimedRuns = new Set<string>()
vi.mock('./automations-store', () => ({
  listAutomations: () => listAutomations(),
  recordRun: (...a: unknown[]) => recordRun(...a),
  beginAutomationRun: (input: { automationId: string; triggerKey: string; attempt: number }) => {
    const key = `${input.automationId}:${input.triggerKey}:${input.attempt}`
    if (__claimedRuns.has(key)) return null
    __claimedRuns.add(key)
    return 'run-' + key
  },
  settleAutomationRun: () => undefined,
  armAutomationRetry: (...a: unknown[]) => armAutomationRetry(...a),
  clearAutomationRetry: (...a: unknown[]) => clearAutomationRetry(...a),
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

import { tick, __lastDispatchAt } from './automations-runner'

// A daily-08:00 cron so the retries (which land at :01 and :03) never coincide with a
// fresh cron fire — this isolates the retry path from the cron path.
function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: 'retry-1',
    label: 'Nightly',
    cron: '0 8 * * *',
    prompt: 'do work',
    model: null,
    enabled: true,
    createdAt: 0,
    lastRunAt: null,
    lastResult: null,
    scheduleLabel: null,
    deliverTo: null,
    trigger: { kind: 'schedule', cron: '0 8 * * *', maxAttempts: 3, retryDelaySeconds: 60 },
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

// A live store holder: arm/clear mutate `current` and listAutomations returns it, so a
// retry armed by one tick is visible to the next — mirroring the persisted retry_at.
let current: Automation

beforeEach(() => {
  __lastDispatchAt.clear()
  __claimedRuns.clear()
  listAutomations.mockReset()
  recordRun.mockReset()
  runHeadlessAgent.mockReset()
  armAutomationRetry.mockReset()
  clearAutomationRetry.mockReset()
  settings = { backgroundAutonomy: true, automationsEnabled: true }
  current = auto()
  listAutomations.mockImplementation(() => [current])
  armAutomationRetry.mockImplementation((id: string, at: number, attempt: number) => {
    current = { ...current, retryAt: at, retryAttempt: attempt }
  })
  clearAutomationRetry.mockImplementation(() => {
    current = { ...current, retryAt: null, retryAttempt: 0 }
  })
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

const T0 = new Date(2026, 0, 1, 8, 0, 0).getTime()

describe('automations tick — retry / backoff', () => {
  it('arms the next attempt with the trigger backoff when a run fails transiently', async () => {
    runHeadlessAgent.mockResolvedValue({ status: 'error', error: 'model down' })

    vi.setSystemTime(new Date(T0))
    tick()
    await flush()

    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)
    // attempt 1 failed → arm attempt 2 at failedAt + retryDelaySeconds*1000 (60s).
    expect(armAutomationRetry).toHaveBeenCalledTimes(1)
    expect(armAutomationRetry).toHaveBeenCalledWith('retry-1', T0 + 60_000, 2)
  })

  it('re-fires a due retry on a distinct ledger key and caps at maxAttempts', async () => {
    runHeadlessAgent.mockResolvedValue({ status: 'error', error: 'model down' })

    // attempt 1 (cron fire) fails → arms attempt 2 @ T0+60s.
    vi.setSystemTime(new Date(T0))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)

    // attempt 2 (retry) fires when the backoff elapses; consumes retry_at, then fails
    // → arms attempt 3 @ (T0+60s)+120s.
    vi.setSystemTime(new Date(T0 + 60_000))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(2)
    expect(clearAutomationRetry).toHaveBeenCalledTimes(1)
    expect(armAutomationRetry).toHaveBeenLastCalledWith('retry-1', T0 + 60_000 + 120_000, 3)

    // attempt 3 (retry) fires and fails — but the budget (maxAttempts=3) is spent, so
    // NO fourth attempt is armed.
    const armsBefore = armAutomationRetry.mock.calls.length
    vi.setSystemTime(new Date(T0 + 60_000 + 120_000))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(3)
    expect(clearAutomationRetry).toHaveBeenCalledTimes(2)
    expect(armAutomationRetry.mock.calls.length).toBe(armsBefore) // no attempt 4

    // A further tick past the (now-cleared) retry window must not re-fire.
    vi.setSystemTime(new Date(T0 + 10 * 60_000))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(3)
  })

  it('does not arm a retry when the run succeeds', async () => {
    runHeadlessAgent.mockResolvedValue({ status: 'ok', output: 'done', turns: 1, toolUses: [] })

    vi.setSystemTime(new Date(T0))
    tick()
    await flush()

    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)
    expect(armAutomationRetry).not.toHaveBeenCalled()
  })

  it('does not retry a deliberately aborted run', async () => {
    runHeadlessAgent.mockResolvedValue({ status: 'aborted', error: 'cancelled' })

    vi.setSystemTime(new Date(T0))
    tick()
    await flush()

    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)
    expect(armAutomationRetry).not.toHaveBeenCalled()
  })
})
