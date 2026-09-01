import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Automation } from './automations-store'

// REGRESSION — a LOST ledger claim on the retry path permanently silences the automation.
//
// tick() checks the armed backoff BEFORE the cron match and `continue`s past it:
//
//   if (a.retryAt != null && now.getTime() >= a.retryAt) {
//     dispatchAutomationRun(a, `retry:${a.retryAt}`, a.retryAttempt || 1, a.retryAt, true)
//     continue                                    // <- cron fire skipped this tick
//   }
//
// dispatchAutomationRun consumes the armed retry (clearAutomationRetry) only AFTER it
// WINS the claim:
//
//   const runId = beginAutomationRun({...})
//   if (!runId) return                            // <- retry_at left armed forever
//   if (isRetry) clearAutomationRetry(a.id)
//
// So if the ledger row for (automationId, `retry:<ts>`, attempt) already exists — e.g. the
// app died between the claim INSERT and clearAutomationRetry, and boot recovery flipped the
// row to 'interrupted' — retry_at stays armed with a timestamp permanently in the past.
// Every subsequent tick then takes the retry branch, loses the claim, returns, and `continue`s
// past the cron match. The automation NEVER runs again: not the retry, and not its schedule.
// Nothing clears the state and disabled_reason is never set, so the UI still shows it enabled.
//
// Same mocking posture as automations-runner-retry.test.ts.

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
// Ledger rows that already exist before the test starts (the crash-window survivor).
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

import { tick } from './automations-runner'

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

let current: Automation

const T0 = new Date(2026, 0, 1, 8, 0, 0).getTime()
const ARMED_AT = T0 + 60_000 // 08:01 — a minute the `0 8 * * *` cron does NOT match.

beforeEach(() => {
  __claimedRuns.clear()
  listAutomations.mockReset()
  recordRun.mockReset()
  runHeadlessAgent.mockReset()
  armAutomationRetry.mockReset()
  clearAutomationRetry.mockReset()
  settings = { backgroundAutonomy: true, automationsEnabled: true }
  current = auto({ retryAt: ARMED_AT, retryAttempt: 2 })
  listAutomations.mockImplementation(() => [current])
  armAutomationRetry.mockImplementation((id: string, at: number, attempt: number) => {
    current = { ...current, retryAt: at, retryAttempt: attempt }
  })
  clearAutomationRetry.mockImplementation(() => {
    current = { ...current, retryAt: null, retryAttempt: 0 }
  })
  runHeadlessAgent.mockResolvedValue({ status: 'ok', output: 'done', turns: 1, toolUses: [] })
  // The crash-window survivor: the ledger already holds the claim this armed retry
  // would make, so beginAutomationRun returns null for it.
  __claimedRuns.add(`retry-1:retry:${ARMED_AT}:2`)
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('automations tick — an unclaimable armed retry must not silence the automation', () => {
  it('clears the armed retry when its ledger claim is already taken', async () => {
    vi.setSystemTime(new Date(ARMED_AT))
    tick()
    await flush()

    // The claim is lost, so nothing runs — that part is correct (idempotency held).
    expect(runHeadlessAgent).not.toHaveBeenCalled()
    // ...but the armed retry MUST be consumed, otherwise it is due forever.
    expect(clearAutomationRetry).toHaveBeenCalledWith('retry-1')
  })

  it('still fires the normal cron schedule after an unclaimable retry', async () => {
    // Tick at the armed (unclaimable) retry time.
    vi.setSystemTime(new Date(ARMED_AT))
    tick()
    await flush()
    expect(runHeadlessAgent).not.toHaveBeenCalled()

    // Next day at 08:00 the cron matches. The automation is enabled and nothing is
    // running, so it must fire.
    vi.setSystemTime(new Date(2026, 0, 2, 8, 0, 0))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)

    // And the day after that.
    vi.setSystemTime(new Date(2026, 0, 3, 8, 0, 0))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(2)
  })
})
