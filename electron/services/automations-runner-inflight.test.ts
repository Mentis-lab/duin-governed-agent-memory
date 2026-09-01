import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Automation } from './automations-store'

// In-flight guard: an automation whose agent run outlives its 60s minute must
// NOT be re-dispatched by the next tick. runHeadlessAgent's default timeout is
// 120s, so a slow run spans two ticks; at t+60s the next tick sees a fresh
// minuteKey and — before this guard — passed the per-minute stamp and launched
// a SECOND concurrent agent for the same automation (racing recordRun and
// double-delivering). Same mocking posture as automations-runner-dedup.test.ts.

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

import { tick, runAutomation, __lastDispatchAt } from './automations-runner'

function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    label: 'Every minute',
    cron: '* * * * *',
    prompt: 'do work',
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
  __lastDispatchAt.clear()
  __claimedRuns.clear()
  listAutomations.mockReset()
  recordRun.mockReset()
  runHeadlessAgent.mockReset()
  settings = { backgroundAutonomy: true, automationsEnabled: true }
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('automations tick — in-flight guard', () => {
  it('does NOT re-dispatch an automation whose previous run is still running across a new minute', async () => {
    listAutomations.mockReturnValue([auto({ id: 'slow-1' })])

    // A run that never resolves within the test: simulates an agent still
    // executing when the next minute's tick arrives.
    let release: () => void = () => undefined
    const pending = new Promise<{ status: 'ok'; output: string }>((res) => {
      release = () => res({ status: 'ok', output: 'ok' })
    })
    runHeadlessAgent.mockReturnValue(pending)

    vi.setSystemTime(new Date(2026, 0, 1, 8, 0, 0))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)

    // Next minute — same automation, run still in flight. Without the guard the
    // fresh minuteKey would pass the per-minute stamp and fire a SECOND agent.
    vi.setSystemTime(new Date(2026, 0, 1, 8, 1, 0))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)

    // Once the first run completes, a later tick may dispatch again.
    //
    // 08:06, not 08:02: the cadence floor is five minutes and is now measured from
    // DISPATCH (08:00), so an 08:02 tick is legitimately refused by that floor rather
    // than by the in-flight guard this test is about. It only used to pass because the
    // mocked store never advanced lastRunAt, so the floor was never exercised here.
    release()
    await flush()
    vi.setSystemTime(new Date(2026, 0, 1, 8, 6, 0))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(2)
  })
})

// ── backlog finding 57 ──────────────────────────────────────────────────────

describe('runAutomation ("Run now") honours the in-flight guard', () => {
  it('refuses while the same automation is already running', async () => {
    // "Run now" called runOne directly and bypassed runningAutomations entirely, so
    // clicking it while the scheduled tick had that automation in flight ran the agent
    // CONCURRENTLY against one automation — both runs writing the same row,
    // last-write-wins, two model conversations for one job.
    listAutomations.mockReturnValue([auto({ id: 'slow-1' })])
    let release: () => void = () => undefined
    runHeadlessAgent.mockReturnValue(
      new Promise((res) => {
        release = () => res({ status: 'ok', output: 'ok' })
      })
    )

    vi.setSystemTime(new Date(2026, 0, 1, 9, 0, 0))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)

    // The scheduled run is still in flight — a manual Run now must not start a second.
    const r = await runAutomation('slow-1')
    expect(r).toMatchObject({ status: 'error' })
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)

    release()
    await flush()
  })
})
