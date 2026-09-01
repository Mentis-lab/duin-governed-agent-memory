import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Automation } from './automations-store'

// Digest automations (#duin-digest:{mode}) short-circuit the LLM path: runOne calls
// runDigestJob → deliverDigest, which is documented "never throws" and returns
// {delivered:false, error} on a compose failure (e.g. getHomeDigest throwing on a
// corrupt ontology). This suite pins the invariant that such a failure surfaces as
// {status:'error'} — not the silent 'completed'/exit-0 that the caught-and-returned
// result used to produce. We mock the store, brain readers, watcher, and event log so
// the branch is tested without a DB, the brain graph, or a live channel.

const listAutomations = vi.fn(() => [] as Automation[])
const recordRun = vi.fn()
const watchJobFailed = vi.fn()
const recordEvent = vi.fn()
const getHomeDigest = vi.fn()
const getCalibration = vi.fn()

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/lamprey-test-irrelevant' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('./automations-store', () => ({
  listAutomations: () => listAutomations(),
  recordRun: (...a: unknown[]) => recordRun(...a)
}))
vi.mock('./headless-agent', () => ({
  runHeadlessAgent: async () => ({ status: 'ok', output: '', turns: 0, toolUses: [] })
}))
vi.mock('./channel-dispatch', () => ({ channelDispatch: async () => ({ ok: true, kind: 'push' }) }))
vi.mock('./settings-helper', () => ({ readSettings: () => ({}) }))
vi.mock('./event-log', () => ({
  boundedJsonPreview: (v: unknown) => v,
  recordEvent: (...a: unknown[]) => recordEvent(...a)
}))
vi.mock('./hooks-runner', () => ({ fireHooks: () => undefined }))
vi.mock('./proactive/watchers', () => ({ watchJobFailed: (...a: unknown[]) => watchJobFailed(...a) }))
// The digest readers are lazily `await import('./brain/index')`d inside runDigestJob;
// mock the module so getHomeDigest can throw the way a corrupt/unreadable ontology would.
vi.mock('./brain/index', () => ({
  getHomeDigest: (...a: unknown[]) => getHomeDigest(...a),
  getCalibration: (...a: unknown[]) => getCalibration(...a)
}))

import { runAutomation } from './automations-runner'

function digestAuto(over: Partial<Automation> = {}): Automation {
  return {
    id: 'dig1',
    label: 'Morning brief',
    cron: '0 8 * * *',
    prompt: '#duin-digest:morning',
    model: null,
    enabled: true,
    createdAt: 0,
    lastRunAt: null,
    lastResult: null,
    scheduleLabel: null,
    deliverTo: JSON.stringify({ kind: 'push', target: '' }),
    // `trigger` became required with the UA automations control plane (v34). This
    // fixture predates it; mirror the legacy-cron wrap the migration backfills —
    // a schedule trigger carrying the same cron + the default retry policy, the
    // shape every sibling automations-runner test uses.
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

beforeEach(() => {
  listAutomations.mockReset()
  recordRun.mockReset()
  watchJobFailed.mockReset()
  watchJobFailed.mockResolvedValue(undefined)
  recordEvent.mockReset()
  getHomeDigest.mockReset()
  getCalibration.mockReset()
  getCalibration.mockReturnValue({ totals: { resolved: 0 }, recent: [] })
})

describe('runOne digest failure', () => {
  it('reports {status:"error"} when the digest compose throws (never a silent completion)', async () => {
    // getHomeDigest throwing is exactly the corrupt-ontology scenario. deliverDigest
    // catches it and returns {delivered:false, error}; the runner must NOT treat that
    // as success.
    getHomeDigest.mockImplementation(() => {
      throw new Error('ontology read failed')
    })
    listAutomations.mockReturnValue([digestAuto()])

    const outcome = await runAutomation('dig1')

    expect(outcome.status).toBe('error')
    expect(outcome.status === 'error' && outcome.error).toMatch(/ontology read failed/)
    // The opt-in jobFail watcher must SEE the failure (blind before the fix).
    expect(watchJobFailed).toHaveBeenCalledTimes(1)
    // The event log must record a failure, not a completion.
    const types = recordEvent.mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(types).toContain('automation.failed')
    expect(types).not.toContain('automation.completed')
  })

  it('reports {status:"ok"} on a normal digest delivery', async () => {
    getHomeDigest.mockReturnValue({ tracks: [], needs: [], insights: [], away: null, returnReason: '' })
    listAutomations.mockReturnValue([digestAuto()])

    const outcome = await runAutomation('dig1')

    expect(outcome.status).toBe('ok')
    expect(watchJobFailed).not.toHaveBeenCalled()
    const types = recordEvent.mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(types).toContain('automation.completed')
    expect(types).not.toContain('automation.failed')
  })
})
