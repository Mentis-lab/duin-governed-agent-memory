import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Automation } from './automations-store'

// Cron→channel delivery: after a run's result is recorded, runOne pushes the
// reply to the automation's deliver_to channel (one bounded retry). We mock the
// store, the headless agent, and channelDispatch so the delivery wiring is
// tested without a DB, a model, or a live channel.

const listAutomations = vi.fn(() => [] as Automation[])
const recordRun = vi.fn()
const runHeadlessAgent = vi.fn()
const channelDispatch = vi.fn()

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
  settleAutomationRun: () => undefined
}))
vi.mock('./headless-agent', () => ({
  runHeadlessAgent: (...a: unknown[]) => runHeadlessAgent(...a)
}))
vi.mock('./channel-dispatch', () => ({
  channelDispatch: (...a: unknown[]) => channelDispatch(...a)
}))
vi.mock('./settings-helper', () => ({ readSettings: () => ({}) }))
vi.mock('./event-log', () => ({
  boundedJsonPreview: (v: unknown) => v,
  recordEvent: () => undefined
}))
vi.mock('./hooks-runner', () => ({ fireHooks: () => undefined }))

import { runAutomation, parseDeliverTo, __lastDispatchAt } from './automations-runner'

function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    label: 'Nightly',
    cron: '0 9 * * *',
    prompt: 'summarize my day',
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

beforeEach(() => {
  __lastDispatchAt.clear()
  __claimedRuns.clear()
  listAutomations.mockReset()
  recordRun.mockReset()
  runHeadlessAgent.mockReset()
  channelDispatch.mockReset()
  runHeadlessAgent.mockResolvedValue({ status: 'ok', output: 'the reply', turns: 1, toolUses: [] })
})

describe('parseDeliverTo', () => {
  it('parses a valid ChannelRef JSON', () => {
    expect(parseDeliverTo('{"kind":"feishu","target":"Theo"}')).toEqual({
      kind: 'feishu',
      target: 'Theo'
    })
  })
  it('defaults target to empty string when absent', () => {
    expect(parseDeliverTo('{"kind":"push"}')).toEqual({ kind: 'push', target: '' })
  })
  it('returns null for null / empty / malformed / kindless input', () => {
    expect(parseDeliverTo(null)).toBeNull()
    expect(parseDeliverTo('')).toBeNull()
    expect(parseDeliverTo('not json')).toBeNull()
    expect(parseDeliverTo('{"target":"x"}')).toBeNull()
    expect(parseDeliverTo('{"kind":"   "}')).toBeNull()
  })
})

describe('runOne cron delivery', () => {
  it('runs the headless agent with read-only vault tools', async () => {
    // Was `['send_message', 'read_file', 'list_dir']`. That assertion pinned a contract
    // production could never honour: send_message carries the `network` risk, which is in
    // action-class.ts's CAP_RISKS, so tool-exec's unattended CAP floor — which sits BELOW
    // the capability allow-list and overrides it — refused every call. The suite was
    // proving an allow that never took. Delivery itself is unaffected: it goes through the
    // automation's configured deliver_to via channelDispatch, a different path entirely
    // (asserted separately below). See automations-cron-allowlist-floor.test.ts, which now
    // fails if anything CAP-floored is added back to this list.
    listAutomations.mockReturnValue([auto()])
    await runAutomation('a1')
    expect(runHeadlessAgent).toHaveBeenCalledTimes(1)
    const spec = runHeadlessAgent.mock.calls[0][0]
    expect(spec.allowedTools).toEqual(['read_file', 'list_dir'])
    expect(spec.prompt).toBe('summarize my day')
    expect(recordRun).toHaveBeenCalledWith('a1', 'the reply')
  })

  it('does NOT dispatch when deliver_to is unset', async () => {
    listAutomations.mockReturnValue([auto({ deliverTo: null })])
    await runAutomation('a1')
    expect(channelDispatch).not.toHaveBeenCalled()
  })

  it('dispatches the reply to the configured channel after recording', async () => {
    channelDispatch.mockResolvedValue({ ok: true, kind: 'feishu' })
    listAutomations.mockReturnValue([
      auto({ deliverTo: JSON.stringify({ kind: 'feishu', target: 'Theo' }) })
    ])
    await runAutomation('a1')
    expect(channelDispatch).toHaveBeenCalledTimes(1)
    expect(channelDispatch).toHaveBeenCalledWith({ kind: 'feishu', target: 'Theo' }, 'the reply')
    // Recording happens regardless of delivery.
    expect(recordRun).toHaveBeenCalledWith('a1', 'the reply')
  })

  it('retries once on a failed dispatch', async () => {
    channelDispatch
      .mockResolvedValueOnce({ ok: false, kind: 'feishu', error: 'transient' })
      .mockResolvedValueOnce({ ok: true, kind: 'feishu' })
    listAutomations.mockReturnValue([
      auto({ deliverTo: JSON.stringify({ kind: 'feishu', target: 'Theo' }) })
    ])
    await runAutomation('a1')
    expect(channelDispatch).toHaveBeenCalledTimes(2)
  })

  it('does not retry more than once (bounded)', async () => {
    channelDispatch.mockResolvedValue({ ok: false, kind: 'push', error: 'down' })
    listAutomations.mockReturnValue([
      auto({ deliverTo: JSON.stringify({ kind: 'push', target: '' }) })
    ])
    await runAutomation('a1')
    expect(channelDispatch).toHaveBeenCalledTimes(2)
  })

  it('skips delivery when the reply is empty', async () => {
    runHeadlessAgent.mockResolvedValue({ status: 'ok', output: '', turns: 1, toolUses: [] })
    listAutomations.mockReturnValue([
      auto({ deliverTo: JSON.stringify({ kind: 'push', target: '' }) })
    ])
    await runAutomation('a1')
    expect(channelDispatch).not.toHaveBeenCalled()
  })
})
