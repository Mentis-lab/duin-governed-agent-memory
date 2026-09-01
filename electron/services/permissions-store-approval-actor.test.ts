import { describe, it, expect, beforeEach, vi } from 'vitest'

// Regression guard for the actorKind attribution of tool.call.approved /
// tool.call.denied audit events (permissions-store.emitApprovalEvent).
//
// The bug: actorKind was derived as `outcome.source === 'modal' ? 'user' :
// 'system'`. But a HUMAN decision does not always carry source 'modal':
//   - clicking "Always allow" persists a policy and rewrites source to
//     'policy:<id>'  → mis-filed as 'system';
//   - answering a sandbox-bypass modal rewrites source to
//     'modal+sandbox-bypass' → mis-filed as 'system'.
// Both are human consents — the sticky grant and the single most
// security-sensitive human decision (a bypass) — and both were being logged as
// system actions, so an operator filtering actorKind='user' saw none of them.
//
// We install a fake BrowserWindow (so the modal round-trip is reachable) and
// drive the event-log memory fallback (so listEvents can read back the actor).
const h = vi.hoisted(() => {
  const fakeWindow = {
    webContents: { send: (_channel: string, _payload: unknown) => {} }
  }
  return { fakeWindow, state: { windows: [fakeWindow] as unknown[] } }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => h.state.windows },
  app: {
    getPath: () => {
      throw new Error('electron app not available in test environment')
    }
  }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { permissionsService, type ToolApprovalRequest } from './permissions-store'
import {
  __forceMemoryFallback as forcePolicyMemory,
  __resetPolicyStore
} from './permission-policies-store'
import {
  __forceMemoryFallback as forceEventMemory,
  __resetEventLog,
  listEvents
} from './event-log'

let seq = 0
function makeReq(partial: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest {
  return {
    callId: `call-${++seq}`,
    toolId: 'shell_command',
    name: 'shell_command',
    serverId: 'internal',
    providerKind: 'native',
    risks: ['write', 'network'],
    args: { command: 'git status' },
    conversationId: 'conv-A',
    ...partial
  }
}

function actorOf(callId: string): string | undefined {
  const [ev] = listEvents({ toolCallId: callId })
  return ev?.actorKind
}

beforeEach(() => {
  __resetEventLog()
  forceEventMemory()
  __resetPolicyStore()
  forcePolicyMemory()
  h.state.windows = [h.fakeWindow]
})

describe('emitApprovalEvent actorKind attribution', () => {
  it('a human "Always allow" (source becomes policy:<id>) is logged as actorKind "user"', async () => {
    const req = makeReq()
    const p = permissionsService.requestApprovalDetailed(req)
    permissionsService.respond({ callId: req.callId, decision: 'allow', scope: 'always' })
    const outcome = await p

    // The answer persisted, so the audit source is a policy id — the exact
    // string that used to be mis-attributed.
    expect(outcome.source).toMatch(/^policy:/)
    // A human pressed the button → must be 'user', not 'system'. FAILS before
    // the fix (the source !== 'modal' test bucketed this as 'system').
    expect(actorOf(req.callId)).toBe('user')
  })

  it('a human sandbox-bypass approval (source modal+sandbox-bypass) is logged as actorKind "user"', async () => {
    const req = makeReq({ dangerous: true })
    const p = permissionsService.requestApprovalDetailed(req)
    permissionsService.respond({ callId: req.callId, decision: 'allow', scope: 'once' })
    const outcome = await p

    expect(outcome.source).toBe('modal+sandbox-bypass')
    // The most security-sensitive human consent must read as 'user'. FAILS
    // before the fix.
    expect(actorOf(req.callId)).toBe('user')
  })

  it('a plain "just this once" modal answer stays actorKind "user"', async () => {
    const req = makeReq()
    const p = permissionsService.requestApprovalDetailed(req)
    permissionsService.respond({ callId: req.callId, decision: 'allow', scope: 'once' })
    await p
    expect(actorOf(req.callId)).toBe('user')
  })

  it('a no-human persisted-policy short-circuit (same policy:<id> shape) stays actorKind "system"', async () => {
    // Seed an "always" grant via a human answer...
    const seed = makeReq()
    const ps = permissionsService.requestApprovalDetailed(seed)
    permissionsService.respond({ callId: seed.callId, decision: 'allow', scope: 'always' })
    await ps

    // ...then a second call resolves from that policy with NO modal. Its source
    // is also 'policy:<id>', proving the actor cannot be read off the string:
    // this one must remain 'system'.
    const next = makeReq()
    const outcome = await permissionsService.requestApprovalDetailed(next)
    expect(outcome.source).toMatch(/^policy:/)
    expect(actorOf(next.callId)).toBe('system')
  })

  it('a no-window default-deny stays actorKind "system"', async () => {
    h.state.windows = []
    const req = makeReq()
    const outcome = await permissionsService.requestApprovalDetailed(req)
    expect(outcome.source).toBe('no-window')
    expect(actorOf(req.callId)).toBe('system')
  })
})
