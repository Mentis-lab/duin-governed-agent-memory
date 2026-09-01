import { describe, it, expect, vi, beforeEach } from 'vitest'

// The impure half of the gate: operator hooks, the approval modal for `ask`, the audit spine,
// and the HTTP contract of /exec/hook. Everything DUIN-side is mocked at the module seam so the
// test pins the ORDER and the fail-closed behaviour, not the neighbours.

type HookResult = { blocked: boolean; blockReason?: string; logs: unknown[] }
type ApprovalOutcome = { decision: 'allow' | 'deny'; source: string }
const fireHooks = vi.fn(async (): Promise<HookResult> => ({ blocked: false, logs: [] }))
const requestApprovalDetailed = vi.fn(async (): Promise<ApprovalOutcome> => ({ decision: 'allow', source: 'modal' }))
const recordEvent = vi.fn()

vi.mock('../hooks-runner', () => ({ fireHooks: (...a: unknown[]) => fireHooks(...(a as [])) }))
vi.mock('../permissions-store', () => ({ permissionsService: { requestApprovalDetailed: (...a: unknown[]) => requestApprovalDetailed(...(a as [])) } }))
vi.mock('../event-log', () => ({ recordEvent: (...a: unknown[]) => recordEvent(...(a as [])) }))

import { decideForChild, handleExecutorHook, registerExecutorRun, unregisterExecutorRun, __executorCallbacksTest } from './executor-callbacks'
import type { ExecutivePrincipal } from '../executive-api/principal-store'

const wt = process.platform === 'win32' ? 'C:\\work\\wt-1' : '/work/wt-1'
const reg = { principalId: 'prin-1', worktreePath: wt, allowedTools: '*' as const, conversationId: 'conv-1', label: 'dsh: test' }

function principal(id: string): ExecutivePrincipal {
  return { id, name: 'executor:test', kind: 'cli-agent', planes: ['context.read'], tokenId: 'x', tokenHash: 'y', createdAt: '', approvedAt: '', lastSeenAt: null, observedExe: null, callCount: 0, status: 'active' } as ExecutivePrincipal
}

function fakeRes(): { status: number; body: unknown; res: any } {
  const out = { status: 0, body: undefined as unknown, res: null as any }
  out.res = {
    writeHead: (status: number) => {
      out.status = status
    },
    end: (s: string) => {
      out.body = JSON.parse(s)
    }
  }
  return out
}

beforeEach(() => {
  fireHooks.mockClear()
  requestApprovalDetailed.mockClear()
  recordEvent.mockClear()
  __executorCallbacksTest.runs.clear()
})

describe('decideForChild', () => {
  it('an in-worktree read: allowed, hooks consulted, no approval, audited as approved', async () => {
    const out = await decideForChild('run-1', reg, { toolName: 'read', toolInput: '{"path":"src/a.ts"}', cwd: wt })
    expect(out).toEqual({ decision: 'allow', source: 'gate', classId: 'read' })
    expect(fireHooks).toHaveBeenCalledWith('preToolUse', expect.objectContaining({ toolName: 'dsh:read', trigger: 'executor', sourceId: 'run-1', cwd: wt }))
    expect(requestApprovalDetailed).not.toHaveBeenCalled()
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool.call.approved', correlationId: 'run-1', entityId: 'dsh:read' }))
  })

  it('a gate deny never reaches hooks or approval, and is audited as denied', async () => {
    const out = await decideForChild('run-1', reg, { toolName: 'write', toolInput: { path: '../../outside.txt' }, cwd: wt })
    expect(out.decision).toBe('deny')
    expect(out.classId).toBe('path-escape')
    expect(fireHooks).not.toHaveBeenCalled()
    expect(requestApprovalDetailed).not.toHaveBeenCalled()
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool.call.denied' }))
  })

  it("the operator's preToolUse hook can block an otherwise-allowed call", async () => {
    fireHooks.mockResolvedValueOnce({ blocked: true, blockReason: 'nope', logs: [] })
    const out = await decideForChild('run-1', reg, { toolName: 'bash', toolInput: { command: 'npm test' }, cwd: wt })
    expect(out).toMatchObject({ decision: 'deny', reason: 'nope', source: 'hook' })
  })

  it('a floored shell command asks the approval service with the risk class; the answer decides', async () => {
    requestApprovalDetailed.mockResolvedValueOnce({ decision: 'deny', source: 'modal' })
    const denied = await decideForChild('run-1', reg, { toolName: 'bash', toolInput: { command: 'rm -rf /' }, cwd: wt })
    expect(denied.decision).toBe('deny')
    expect(requestApprovalDetailed).toHaveBeenCalledWith(expect.objectContaining({ name: 'dsh:bash', serverId: 'executor', correlationId: 'run-1', conversationId: 'conv-1' }))
    requestApprovalDetailed.mockResolvedValueOnce({ decision: 'allow', source: 'modal' })
    const allowed = await decideForChild('run-1', reg, { toolName: 'bash', toolInput: { command: 'rm -rf /' }, cwd: wt })
    expect(allowed).toMatchObject({ decision: 'allow', source: 'modal' })
  })

  it('approval plumbing failure is a deny, not an allow', async () => {
    requestApprovalDetailed.mockRejectedValueOnce(new Error('no window'))
    const out = await decideForChild('run-1', reg, { toolName: 'bash', toolInput: { command: 'rm -rf /' }, cwd: wt })
    expect(out).toMatchObject({ decision: 'deny', source: 'approval-error' })
  })

  it('reports each decision to the run and survives a throwing observer', async () => {
    const seen: string[] = []
    const withObserver = { ...reg, onDecision: (d: { toolName: string; decision: string }) => { seen.push(`${d.toolName}:${d.decision}`); throw new Error('observer bug') } }
    const out = await decideForChild('run-1', withObserver, { toolName: 'read', toolInput: {}, cwd: wt })
    expect(out.decision).toBe('allow')
    expect(seen).toEqual(['read:allow'])
  })
})

describe('handleExecutorHook — POST /exec/hook', () => {
  it('401 without a principal, 400 without runId/toolName, 404 for an unknown run, 403 for a foreign bearer', async () => {
    let r = fakeRes()
    await handleExecutorHook(r.res, null, { runId: 'run-1', toolName: 'read' })
    expect(r.status).toBe(401)
    r = fakeRes()
    await handleExecutorHook(r.res, principal('prin-1'), { runId: 'run-1' })
    expect(r.status).toBe(400)
    r = fakeRes()
    await handleExecutorHook(r.res, principal('prin-1'), { runId: 'run-1', toolName: 'read' })
    expect(r.status).toBe(404)
    registerExecutorRun('run-1', reg)
    r = fakeRes()
    await handleExecutorHook(r.res, principal('prin-OTHER'), { runId: 'run-1', toolName: 'read' })
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ decision: 'deny' })
  })

  it('200 with the verdict for the run’s own principal; the run disappears on unregister', async () => {
    registerExecutorRun('run-1', reg)
    let r = fakeRes()
    await handleExecutorHook(r.res, principal('prin-1'), { runId: 'run-1', toolName: 'read', toolInput: '{"path":"a.ts"}', cwd: wt, callId: 'c1' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ decision: 'allow' })
    r = fakeRes()
    await handleExecutorHook(r.res, principal('prin-1'), { runId: 'run-1', toolName: 'subagent', toolInput: {}, cwd: wt })
    expect(r.body).toMatchObject({ decision: 'deny', reason: expect.stringContaining('subagent') })
    unregisterExecutorRun('run-1')
    r = fakeRes()
    await handleExecutorHook(r.res, principal('prin-1'), { runId: 'run-1', toolName: 'read' })
    expect(r.status).toBe(404)
  })
})
