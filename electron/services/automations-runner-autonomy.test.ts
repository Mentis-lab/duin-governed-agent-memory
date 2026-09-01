import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Automation } from './automations-store'

// Phase B3 — the automations tick MUST honor the backgroundAutonomy kill
// switch. A cron automation dispatches a real, billable tool-capable agent
// (runHeadlessAgent), so with autonomy OFF no enabled automation may fire.
// With autonomy ON, an enabled + due automation dispatches normally. We mock
// the store, the headless agent, settings, and the proactive substrate so the
// gate is tested without a DB, a model, or the proactive stores.

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
// Proactive substrate rides the same tick — stub it so the test doesn't drag
// in the proactive stores. These are delivery plumbing, NOT gated by autonomy.
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
    label: 'QA every-min',
    cron: '* * * * *', // matches every minute so `matches()` is always true
    prompt: 'run QA',
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

// tick() dispatches runOne via `void runOne(...)` (fire-and-forget). Flush the
// microtask + macrotask queue so the async runOne reaches runHeadlessAgent.
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  __claimedRuns.clear()
  listAutomations.mockReset()
  recordRun.mockReset()
  runHeadlessAgent.mockReset()
  runHeadlessAgent.mockResolvedValue({ status: 'ok', output: 'ok', turns: 1, toolUses: [] })
  settings = {}
})

describe('automations tick — backgroundAutonomy kill switch (B3)', () => {
  it('dispatches NOTHING when autonomy is OFF, even with an enabled due automation', async () => {
    settings = { backgroundAutonomy: false }
    listAutomations.mockReturnValue([auto({ id: 'off-1' })])
    tick()
    await flush()
    expect(runHeadlessAgent).not.toHaveBeenCalled()
    expect(recordRun).not.toHaveBeenCalled()
  })

  it('treats a missing/undefined backgroundAutonomy as OFF (default-safe)', async () => {
    settings = {} // no backgroundAutonomy key
    listAutomations.mockReturnValue([auto({ id: 'off-2' })])
    tick()
    await flush()
    expect(runHeadlessAgent).not.toHaveBeenCalled()
  })

  it('dispatches an enabled due automation when autonomy is ON', async () => {
    settings = { backgroundAutonomy: true, automationsEnabled: true }
    listAutomations.mockReturnValue([auto({ id: 'on-1' })])
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)
    expect(runHeadlessAgent.mock.calls[0][0].prompt).toBe('run QA')
  })

  it('still skips a DISABLED automation when autonomy is ON', async () => {
    settings = { backgroundAutonomy: true, automationsEnabled: true }
    listAutomations.mockReturnValue([auto({ id: 'on-2', enabled: false })])
    tick()
    await flush()
    expect(runHeadlessAgent).not.toHaveBeenCalled()
  })
})

describe('automations tick — cron needs its OWN switch', () => {
  // backgroundAutonomy also arms the self-improve tick, so an install that turned it on for
  // self-improvement silently re-armed every enabled cron to dispatch billable agents. That
  // side door is the runaway class this gate exists to close; cron now needs a deliberate yes.
  it('dispatches NOTHING when autonomy is ON but automations were never enabled', async () => {
    settings = { backgroundAutonomy: true }
    listAutomations.mockReturnValue([auto({ id: 'sidedoor-1' })])
    tick()
    await flush()
    expect(runHeadlessAgent).not.toHaveBeenCalled()
    expect(recordRun).not.toHaveBeenCalled()
  })

  it('keeps backgroundAutonomy as the master kill — off beats automationsEnabled on', async () => {
    settings = { backgroundAutonomy: false, automationsEnabled: true }
    listAutomations.mockReturnValue([auto({ id: 'sidedoor-2' })])
    tick()
    await flush()
    expect(runHeadlessAgent).not.toHaveBeenCalled()
  })
})

describe('automations tick — cadence floor', () => {
  // The named pathology: cron accepts `* * * * *` and each dispatch is a real billable agent.
  it('skips an automation that ran inside the floor, whatever its schedule says', async () => {
    settings = { backgroundAutonomy: true, automationsEnabled: true }
    listAutomations.mockReturnValue([
      auto({ id: 'fast-1', lastRunAt: Date.now() - 60_000 }) // one minute ago
    ])
    tick()
    await flush()
    expect(runHeadlessAgent).not.toHaveBeenCalled()
  })

  it('dispatches again once the floor has elapsed', async () => {
    settings = { backgroundAutonomy: true, automationsEnabled: true }
    listAutomations.mockReturnValue([
      auto({ id: 'fast-2', lastRunAt: Date.now() - 10 * 60_000 })
    ])
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)
  })

  it('never blocks a first run', async () => {
    settings = { backgroundAutonomy: true, automationsEnabled: true }
    listAutomations.mockReturnValue([auto({ id: 'fresh-1', lastRunAt: null })])
    tick()
    await flush()
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)
  })
})
