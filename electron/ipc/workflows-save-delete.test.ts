// U10 (IPC half) — the renderer must be able to TELL a conflict from a generic
// failure, and must have a way to delete a workflow at all.
//
// Before: workflows:save passed the script straight to a bare writeFileSync, so
// a second author saving under the same name (MetaScaffolder gives everyone
// 'new-workflow') destroyed the first file with no prompt and no backup — and
// no workflows:delete channel existed anywhere to undo or clean up.

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

// Real error class, faked disk: the IPC contract is what is under test here.
class WorkflowSaveError extends Error {
  code: string
  workflowName: string
  filePath?: string
  constructor(code: string, workflowName: string, message: string) {
    super(message)
    this.name = 'WorkflowSaveError'
    this.code = code
    this.workflowName = workflowName
  }
}

const saved: Array<{ source: string; overwrite?: boolean }> = []
let saveImpl: (source: string, opts?: { overwrite?: boolean }) => unknown = () => ({
  name: 'w',
  description: 'd',
  filePath: '/tmp/w.js',
  origin: 'user'
})
let deleteImpl: (name: string) => unknown = () => ({ deleted: true, filePath: '/tmp/w.js', backup: null })

vi.mock('../services/workflow-library', () => ({
  WorkflowSaveError,
  getWorkflow: (): null => null,
  listWorkflows: (): unknown[] => [],
  validateWorkflowSource: (): unknown => ({ name: 'w', description: 'd' }),
  saveUserWorkflow: (source: string, opts?: { overwrite?: boolean }) => {
    saved.push({ source, overwrite: opts?.overwrite })
    return saveImpl(source, opts)
  },
  deleteUserWorkflow: (name: string) => deleteImpl(name)
}))

const { registerWorkflowsHandlers } = await import('./workflows')

registerWorkflowsHandlers()

function call(channel: string, args?: unknown): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return fn({}, args)
}

beforeEach(() => {
  saved.length = 0
  saveImpl = () => ({ name: 'w', description: 'd', filePath: '/tmp/w.js', origin: 'user' })
  deleteImpl = () => ({ deleted: true, filePath: '/tmp/w.js', backup: null })
})

describe('workflows:save — conflicts are structured, not silent', () => {
  it('does not overwrite unless the caller explicitly asks', async () => {
    await call('workflows:save', { script: 'x' })
    expect(saved[0].overwrite).toBe(false)
  })

  it('surfaces a name conflict with a code the renderer can prompt on', async () => {
    saveImpl = () => {
      throw new WorkflowSaveError('conflict', 'my-flow', 'A workflow named "my-flow" already exists.')
    }
    const res = (await call('workflows:save', { script: 'x' })) as {
      success: boolean
      code?: string
      name?: string
      error?: string
    }
    expect(res.success).toBe(false)
    expect(res.code).toBe('conflict')
    expect(res.name).toBe('my-flow')
    expect(res.error).toContain('already exists')
  })

  it('surfaces the scaffold-placeholder refusal distinctly from a conflict', async () => {
    saveImpl = () => {
      throw new WorkflowSaveError('scaffold-name', 'new-workflow', 'scaffold placeholder')
    }
    const res = (await call('workflows:save', { script: 'x' })) as { success: boolean; code?: string }
    expect(res.success).toBe(false)
    expect(res.code).toBe('scaffold-name')
  })

  it('forwards overwrite:true once the caller has confirmed', async () => {
    await call('workflows:save', { script: 'x', overwrite: true })
    expect(saved[0].overwrite).toBe(true)
  })
})

describe('workflows:delete — the channel exists', () => {
  it('is registered', () => {
    expect(handlers.has('workflows:delete')).toBe(true)
  })

  it('deletes a user workflow and reports where the recoverable copy went', async () => {
    deleteImpl = () => ({ deleted: true, filePath: '/tmp/w.js', backup: '/tmp/.trash/w.js' })
    const res = (await call('workflows:delete', { name: 'w' })) as {
      success: boolean
      data: { name: string; backup: string | null }
    }
    expect(res.success).toBe(true)
    expect(res.data).toEqual({ name: 'w', backup: '/tmp/.trash/w.js' })
  })

  it('refuses to delete a built-in', async () => {
    deleteImpl = () => ({ deleted: false, reason: 'builtin' })
    const res = (await call('workflows:delete', { name: 'judge-panel' })) as {
      success: boolean
      code?: string
      error?: string
    }
    expect(res.success).toBe(false)
    expect(res.code).toBe('builtin')
    expect(res.error).toContain('built-in')
  })

  it('requires a name', async () => {
    const res = (await call('workflows:delete', { name: '  ' })) as { success: boolean }
    expect(res.success).toBe(false)
  })
})
