import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Automation } from './automations-store'

// The v34-v36 trigger taxonomy was INERT: tick() did `parseCron(a.cron)` with
// `catch { continue }`, while automations-store's cronForTrigger writes '' for
// one_shot / event / monitor / schedule{everySeconds}. parseCron('') throws, so every
// one of those kinds was skipped on every tick, forever, with nothing logged and
// disabled_reason unset — the panel showed them enabled and healthy. `next_run_at` was
// written by create/update and read by nothing.
//
// tick() now dispatches on the taxonomy. These tests pin what fires, what is refused
// LOUDLY, and that nothing silently no-ops.

const listAutomations = vi.fn(() => [] as Automation[])
const recordRun = vi.fn()
const runHeadlessAgent = vi.fn()
const armAutomationRetry = vi.fn()
const clearAutomationRetry = vi.fn()
const setAutomationNextRun = vi.fn()
const disableAutomation = vi.fn()
const wakeGoalFromAutomation = vi.fn()
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
  setAutomationNextRun: (...a: unknown[]) => setAutomationNextRun(...a),
  disableAutomation: (...a: unknown[]) => disableAutomation(...a),
  pruneAutomationRuns: () => 0
}))
vi.mock('./goal-automation-loop-bridge', () => ({
  wakeGoalFromAutomation: (...a: unknown[]) => wakeGoalFromAutomation(...a)
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

function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    label: 'Job',
    cron: '',
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
const T0 = new Date(2026, 0, 1, 8, 0, 0).getTime()

beforeEach(() => {
  __lastDispatchAt.clear()
  __claimedRuns.clear()
  for (const m of [
    listAutomations,
    recordRun,
    runHeadlessAgent,
    armAutomationRetry,
    clearAutomationRetry,
    setAutomationNextRun,
    disableAutomation,
    wakeGoalFromAutomation
  ]) {
    m.mockReset()
  }
  settings = { backgroundAutonomy: true, automationsEnabled: true }
  runHeadlessAgent.mockResolvedValue({ status: 'ok', output: 'done', turns: 1, toolUses: [] })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(T0))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('automations tick — one_shot', () => {
  it('fires when its due time has arrived, then clears its cursor so it never repeats', async () => {
    const a = auto({
      trigger: { kind: 'one_shot', at: T0, maxAttempts: 3, retryDelaySeconds: 60 },
      nextRunAt: T0
    })
    listAutomations.mockReturnValue([a])

    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)
    // nextRunAfterSettlement returns null for one_shot -> cursor cleared.
    expect(setAutomationNextRun).toHaveBeenCalledWith('a1', null)

    // With the cursor cleared it cannot come due again.
    listAutomations.mockReturnValue([{ ...a, nextRunAt: null }])
    vi.setSystemTime(new Date(T0 + 3_600_000))
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)
  })

  it('does not fire before its due time', async () => {
    listAutomations.mockReturnValue([
      auto({
        trigger: { kind: 'one_shot', at: T0 + 60_000, maxAttempts: 3, retryDelaySeconds: 60 },
        nextRunAt: T0 + 60_000
      })
    ])
    tick()
    await flush()
    expect(runHeadlessAgent).not.toHaveBeenCalled()
    expect(disableAutomation).not.toHaveBeenCalled()
  })
})

describe('automations tick — schedule { everySeconds }', () => {
  it('fires on its interval boundary and advances the cursor', async () => {
    const a = auto({
      trigger: { kind: 'schedule', everySeconds: 300, maxAttempts: 3, retryDelaySeconds: 60 },
      nextRunAt: T0
    })
    listAutomations.mockReturnValue([a])

    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)
    const advancedTo = setAutomationNextRun.mock.calls.at(-1)![1] as number
    expect(advancedTo).toBeGreaterThan(T0)
  })

  it('seeds a missing cursor instead of skipping the row forever', async () => {
    listAutomations.mockReturnValue([
      auto({
        trigger: { kind: 'schedule', everySeconds: 300, maxAttempts: 3, retryDelaySeconds: 60 },
        nextRunAt: null
      })
    ])
    tick()
    await flush()
    // Not due yet (the first boundary is one interval away) — but the cursor is now
    // written, so the row will come due instead of being invisible forever.
    expect(setAutomationNextRun).toHaveBeenCalledWith('a1', T0 + 300_000)
    expect(disableAutomation).not.toHaveBeenCalled()
  })

  it('does not re-attempt forever when the boundary claim is already taken', async () => {
    __claimedRuns.add('a1:schedule:' + T0 + ':1')
    listAutomations.mockReturnValue([
      auto({
        trigger: { kind: 'schedule', everySeconds: 300, maxAttempts: 3, retryDelaySeconds: 60 },
        nextRunAt: T0
      })
    ])
    tick()
    await flush()
    expect(runHeadlessAgent).not.toHaveBeenCalled()
    // The cursor still advances, so the automation is not stuck on a dead boundary.
    expect(setAutomationNextRun).toHaveBeenCalled()
  })
})

describe('automations tick — kinds this build does not dispatch fail LOUDLY', () => {
  it('disables an event trigger with a reason instead of silently never firing', async () => {
    listAutomations.mockReturnValue([
      auto({
        trigger: {
          kind: 'event',
          eventName: 'mail.received',
          maxAttempts: 3,
          retryDelaySeconds: 60
        }
      })
    ])
    tick()
    await flush()
    expect(runHeadlessAgent).not.toHaveBeenCalled()
    expect(disableAutomation).toHaveBeenCalledTimes(1)
    expect(disableAutomation.mock.calls[0][0]).toBe('a1')
    expect(String(disableAutomation.mock.calls[0][1])).toMatch(/event triggers/)
  })

  it('disables a monitor trigger with a reason', async () => {
    listAutomations.mockReturnValue([
      auto({
        trigger: { kind: 'monitor', everySeconds: 300, maxAttempts: 3, retryDelaySeconds: 60 }
      })
    ])
    tick()
    await flush()
    expect(runHeadlessAgent).not.toHaveBeenCalled()
    expect(String(disableAutomation.mock.calls[0][1])).toMatch(/monitor triggers/)
  })

  it('disables an invalid cron with a reason instead of `catch { continue }`', async () => {
    listAutomations.mockReturnValue([
      auto({
        cron: '5abc * * * *',
        trigger: {
          kind: 'schedule',
          cron: '5abc * * * *',
          maxAttempts: 3,
          retryDelaySeconds: 60
        }
      })
    ])
    tick()
    await flush()
    expect(runHeadlessAgent).not.toHaveBeenCalled()
    expect(String(disableAutomation.mock.calls[0][1])).toMatch(/not a valid cron/)
  })

  it('disables a row whose stored trigger could not be read at all', async () => {
    listAutomations.mockReturnValue([
      auto({
        cron: '',
        // The sentinel parseStoredAutomationTrigger returns when both the trigger
        // JSON and the legacy cron column are unusable.
        trigger: {
          kind: 'schedule',
          maxAttempts: 3,
          retryDelaySeconds: 60,
          unreadable: 'bad field value: 5abc'
        }
      })
    ])
    tick()
    await flush()
    expect(runHeadlessAgent).not.toHaveBeenCalled()
    expect(String(disableAutomation.mock.calls[0][1])).toMatch(/could not be read/)
  })

  it('leaves a plain cron automation alone', async () => {
    listAutomations.mockReturnValue([auto({ cron: '0 8 * * *' })])
    tick()
    await flush()
    expect(disableAutomation).not.toHaveBeenCalled()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)
  })
})

describe('automations tick — goal-bound automation wakes its loop', () => {
  it('calls the bridge instead of running a headless agent', async () => {
    wakeGoalFromAutomation.mockReturnValue({
      goalId: 'g1',
      loopId: 'l1',
      nextFireAt: T0,
      ceilings: {}
    })
    listAutomations.mockReturnValue([
      auto({ cron: '0 8 * * *', goalId: 'g1', goalConversationId: 'c1' })
    ])
    tick()
    await flush()
    expect(wakeGoalFromAutomation).toHaveBeenCalledTimes(1)
    expect(runHeadlessAgent).not.toHaveBeenCalled()
  })

  it('records a refused wake and does NOT arm a backoff retry for it', async () => {
    wakeGoalFromAutomation.mockImplementation(() => {
      throw new Error('goal loop bridge: backgroundAutonomy is OFF')
    })
    listAutomations.mockReturnValue([
      auto({ cron: '0 8 * * *', goalId: 'g1', goalConversationId: 'c1' })
    ])
    tick()
    await flush()
    expect(recordRun).toHaveBeenCalled()
    expect(String(recordRun.mock.calls.at(-1)![1])).toMatch(/goal wake refused/)
    // A policy refusal is not a transient fault — no exponential re-fire.
    expect(armAutomationRetry).not.toHaveBeenCalled()
  })
})
