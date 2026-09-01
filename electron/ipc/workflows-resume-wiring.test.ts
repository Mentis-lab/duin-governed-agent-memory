// Reachability test for the journal/resume wiring gap (coherence-map.ts's
// "Workflow journal + resume" entry). workflow-runner.ts's runWorkflow() has
// fully supported `journalDir` + `resumeFromRunId` since B2 — proven by the
// resume suite in workflow-runner.test.ts, which calls runWorkflow()
// directly. But the ONLY production callers of runWorkflow() are the two IPC
// handlers below (workflows:runInline / workflows:run) in workflows.ts, and
// until now neither one forwarded either field: a resumeFromRunId from a
// renderer/script caller was silently dropped and no run was ever
// journaled, so the tested resume path was unreachable end to end.
//
// This test only proves the WIRING — that the IPC layer now forwards
// resumeFromRunId and turns journaling on for every run. The caching/replay
// behaviour itself is already covered exhaustively by workflow-runner.test.ts
// and is not re-tested here.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args?: unknown) => Promise<unknown>): void => {
      handlers.set(channel, fn)
    }
  },
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
  app: { getPath: (): string => '/tmp/duin-test-userdata' }
}))

const runWorkflowCalls: Array<Record<string, unknown>> = []

function fakeHandle(): { runId: string; abort: () => void; promise: Promise<unknown> } {
  return {
    runId: 'fake-run-id',
    abort: (): void => {},
    promise: Promise.resolve({
      runId: 'fake-run-id',
      meta: { name: 'fake' },
      output: null,
      durationMs: 0,
      agentCount: 0,
      budget: { total: null, spent: 0, remaining: Infinity, byTier: {} }
    })
  }
}

// Real workflow-runner is not exercised here — it's the module the resume
// suite already covers. Swapping it for a spy isolates this test to the one
// thing that was actually broken: does the IPC handler pass the fields on?
vi.mock('../services/workflow-runner', () => ({
  runWorkflow: (input: Record<string, unknown>): ReturnType<typeof fakeHandle> => {
    runWorkflowCalls.push(input)
    return fakeHandle()
  }
}))

vi.mock('../services/workflow-library', () => ({
  WorkflowSaveError: class extends Error {},
  getWorkflow: (name: string): unknown =>
    name === 'flow'
      ? {
          name: 'flow',
          source: `export const meta = { name: 'flow', description: 'd' }`,
          description: 'd',
          origin: 'user'
        }
      : null,
  listWorkflows: (): unknown[] => [],
  validateWorkflowSource: (): unknown => ({ name: 'w', description: 'd' }),
  saveUserWorkflow: (): unknown => ({}),
  deleteUserWorkflow: (): unknown => ({ deleted: false })
}))

const { registerWorkflowsHandlers, setWorkflowChatRunner } = await import('./workflows')

// buildDeps() throws until a chat runner is registered. Production wires this
// at startup; our fake runWorkflow never reads forkDeps either way, but the
// handler builds them before calling runWorkflow(), so this must be set for
// the call to be reached at all.
setWorkflowChatRunner({ runner: async () => 'ok', defaultModel: 'test-model' })
registerWorkflowsHandlers()

function call(channel: string, args?: unknown): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return fn({}, args)
}

beforeEach(() => {
  runWorkflowCalls.length = 0
})

describe('workflows IPC — journal/resume now reaches runWorkflow', () => {
  it('runInline forwards resumeFromRunId and sets a journalDir', async () => {
    const res = (await call('workflows:runInline', {
      script: `export const meta = { name: 't', description: 'd' }`,
      resumeFromRunId: 'prior-run-id'
    })) as { success: boolean }
    expect(res.success).toBe(true)
    expect(runWorkflowCalls).toHaveLength(1)
    const input = runWorkflowCalls[0]
    expect(input.resumeFromRunId).toBe('prior-run-id')
    expect(typeof input.journalDir).toBe('string')
    expect(input.journalDir as string).toContain('workflows')
    expect(input.journalDir as string).toContain('runs')
  })

  it('run (named workflow) forwards resumeFromRunId and sets a journalDir', async () => {
    const res = (await call('workflows:run', {
      name: 'flow',
      resumeFromRunId: 'prior-run-id-2'
    })) as { success: boolean }
    expect(res.success).toBe(true)
    expect(runWorkflowCalls).toHaveLength(1)
    const input = runWorkflowCalls[0]
    expect(input.resumeFromRunId).toBe('prior-run-id-2')
    expect(typeof input.journalDir).toBe('string')
    expect(input.journalDir as string).toContain('workflows')
    expect(input.journalDir as string).toContain('runs')
  })

  it('runInline still works with no resumeFromRunId (field stays optional)', async () => {
    const res = (await call('workflows:runInline', {
      script: `export const meta = { name: 't', description: 'd' }`
    })) as { success: boolean }
    expect(res.success).toBe(true)
    const input = runWorkflowCalls[0]
    expect(input.resumeFromRunId).toBeUndefined()
    // Journaling is unconditional — even a fresh run needs to be journaled
    // so a LATER run has something to resume from.
    expect(typeof input.journalDir).toBe('string')
  })
})
