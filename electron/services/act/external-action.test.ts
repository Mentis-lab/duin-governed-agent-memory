import { describe, it, expect, beforeEach, vi } from 'vitest'

// external-action.ts imports tool-registry, which transitively pulls electron via
// mcp-manager. Mock electron (node test env) so importing the substrate — and its
// registerNative side effect — doesn't touch a real app. (Same pattern as
// output-tool-pack.test.ts.)
vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-external-action', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import {
  decideExternalAction,
  runExternalAction,
  execOkFromToken,
  setActExecContext,
  clearActExecContext,
  resolveActContext,
  type ExternalActionSpec,
  type ActAuditEvent
} from './external-action'
import { __clearExternalActionRegistry } from './action-tier'
import type { ApprovalOutcome } from '../proactive/approval-roundtrip'

// A capturing audit sink so every path can be asserted to be audited.
function auditCollector() {
  const events: ActAuditEvent[] = []
  return { events, sink: (e: ActAuditEvent) => events.push(e) }
}

const approve: ApprovalOutcome = { decision: 'approve', source: 'operator-approve', actionId: 'a1' }
const denyOutcome: ApprovalOutcome = { decision: 'deny', source: 'operator-deny', actionId: 'a1' }
const timeoutOutcome: ApprovalOutcome = { decision: 'deny', source: 'timeout', actionId: 'a1' }

function spec(over: Partial<ExternalActionSpec> = {}): ExternalActionSpec {
  return {
    id: 'test_action',
    description: 'test',
    tier: 'irreversible',
    handler: async () => 'side-effect-done',
    ...over
  }
}

beforeEach(() => {
  __clearExternalActionRegistry()
  clearActExecContext()
})

// ──────────────────── pure decision core ────────────────────

describe('decideExternalAction — pure deny-first tier gate', () => {
  it('a read action is ungated regardless of privilege', () => {
    expect(decideExternalAction({ tier: 'read', execOk: false }).kind).toBe('allow')
    expect(decideExternalAction({ tier: 'read', execOk: true }).kind).toBe('allow')
  })
  it('a write-reversible action is DENIED without an exec token', () => {
    const v = decideExternalAction({ tier: 'write-reversible', execOk: false })
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('exec-token')
  })
  it('a write-reversible action is allowed on a privileged turn (soft gate)', () => {
    const v = decideExternalAction({ tier: 'write-reversible', execOk: true })
    expect(v.kind).toBe('allow')
  })
  it('an irreversible action is DENIED without an exec token', () => {
    const v = decideExternalAction({ tier: 'irreversible', execOk: false })
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('exec-token')
  })
  it('an irreversible action on a privileged turn needs operator approval', () => {
    const v = decideExternalAction({ tier: 'irreversible', execOk: true })
    expect(v.kind).toBe('needs-approval')
  })
})

describe('execOkFromToken', () => {
  it('maps a non-empty string to privileged; null/empty to de-privileged', () => {
    expect(execOkFromToken('tok')).toBe(true)
    expect(execOkFromToken('')).toBe(false)
    expect(execOkFromToken(null)).toBe(false)
    expect(execOkFromToken(undefined)).toBe(false)
  })
})

// ──────────────────── the CRUX: runExternalAction enforcement ────────────────────

describe('runExternalAction — de-privileged turn is denied write + irreversible', () => {
  it('DENIES a write-reversible action for a de-privileged (execOk:false) turn and does NOT run the handler', async () => {
    const { events, sink } = auditCollector()
    const handler = vi.fn(async () => 'wrote')
    const r = await runExternalAction(
      spec({ tier: 'write-reversible', handler }),
      {},
      { execOk: false, audit: sink }
    )
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(r.source).toBe('exec-token')
    expect(handler).not.toHaveBeenCalled()
    expect(events.map((e) => e.phase)).toEqual(['denied'])
    expect(events[0].source).toBe('exec-token')
  })

  it('DENIES an irreversible action for a de-privileged turn BEFORE approval is even solicited', async () => {
    const { events, sink } = auditCollector()
    const handler = vi.fn(async () => 'sent')
    const requestApproval = vi.fn(async () => approve)
    const r = await runExternalAction(
      spec({ tier: 'irreversible', handler }),
      {},
      { execOk: false, audit: sink, requestApproval }
    )
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(r.source).toBe('exec-token')
    expect(handler).not.toHaveBeenCalled()
    // The critical proof: approval was never even requested for the unprivileged turn.
    expect(requestApproval).not.toHaveBeenCalled()
    expect(events.map((e) => e.phase)).toEqual(['denied'])
  })
})

describe('runExternalAction — operator approval controls irreversible actions', () => {
  it('an operator-APPROVED irreversible action proceeds (handler runs, audited executed)', async () => {
    const { events, sink } = auditCollector()
    const handler = vi.fn(async () => 'email-sent')
    const requestApproval = vi.fn(async () => approve)
    const r = await runExternalAction(
      spec({ tier: 'irreversible', handler }),
      { to: 'x@y.z' },
      { execOk: true, audit: sink, requestApproval }
    )
    expect(r.ok).toBe(true)
    expect(r.result).toBe('email-sent')
    expect(r.source).toBe('operator-approve')
    expect(handler).toHaveBeenCalledTimes(1)
    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(events.map((e) => e.phase)).toEqual(['approval-requested', 'executed'])
  })

  it('an operator-DENIED irreversible action does NOT run the handler', async () => {
    const { events, sink } = auditCollector()
    const handler = vi.fn(async () => 'email-sent')
    const requestApproval = vi.fn(async () => denyOutcome)
    const r = await runExternalAction(
      spec({ tier: 'irreversible', handler }),
      {},
      { execOk: true, audit: sink, requestApproval }
    )
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(r.source).toBe('operator-deny')
    expect(handler).not.toHaveBeenCalled()
    expect(events.map((e) => e.phase)).toEqual(['approval-requested', 'denied'])
  })

  it('an approval TIMEOUT (no reply) fails closed — handler does not run', async () => {
    const { events, sink } = auditCollector()
    const handler = vi.fn(async () => 'x')
    const r = await runExternalAction(
      spec({ tier: 'irreversible', handler }),
      {},
      { execOk: true, audit: sink, requestApproval: async () => timeoutOutcome }
    )
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(r.source).toBe('timeout')
    expect(handler).not.toHaveBeenCalled()
  })

  it('an approval router that THROWS fails closed (never silently runs irreversible)', async () => {
    const { events, sink } = auditCollector()
    const handler = vi.fn(async () => 'x')
    const r = await runExternalAction(
      spec({ tier: 'irreversible', handler }),
      {},
      {
        execOk: true,
        audit: sink,
        requestApproval: async () => {
          throw new Error('dispatch exploded')
        }
      }
    )
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(r.source).toBe('approval-error')
    expect(handler).not.toHaveBeenCalled()
    expect(events.map((e) => e.phase)).toEqual(['approval-requested', 'denied'])
  })
})

describe('runExternalAction — read needs no gate; every action is audited', () => {
  it('a read action runs with no token and no approval', async () => {
    const { events, sink } = auditCollector()
    const handler = vi.fn(async () => ['a', 'b'])
    const requestApproval = vi.fn(async () => approve)
    const r = await runExternalAction(
      spec({ tier: 'read', handler }),
      {},
      { execOk: false, audit: sink, requestApproval }
    )
    expect(r.ok).toBe(true)
    expect(r.result).toEqual(['a', 'b'])
    expect(handler).toHaveBeenCalledTimes(1)
    expect(requestApproval).not.toHaveBeenCalled()
    expect(events.map((e) => e.phase)).toEqual(['executed'])
  })

  it('a write-reversible action on a privileged turn runs without approval, audited executed', async () => {
    const { events, sink } = auditCollector()
    const handler = vi.fn(async () => 'drafted')
    const requestApproval = vi.fn(async () => approve)
    const r = await runExternalAction(
      spec({ tier: 'write-reversible', handler }),
      {},
      { execOk: true, audit: sink, requestApproval }
    )
    expect(r.ok).toBe(true)
    expect(requestApproval).not.toHaveBeenCalled()
    expect(events.map((e) => e.phase)).toEqual(['executed'])
  })

  it('a handler that THROWS is caught and audited failed (no throw escapes)', async () => {
    const { events, sink } = auditCollector()
    const r = await runExternalAction(
      spec({
        tier: 'write-reversible',
        handler: async () => {
          throw new Error('api 500')
        }
      }),
      {},
      { execOk: true, audit: sink }
    )
    expect(r.ok).toBe(false)
    expect(r.denied).toBeUndefined()
    expect(r.source).toBe('handler-error')
    expect(r.error).toContain('api 500')
    expect(events.map((e) => e.phase)).toEqual(['failed'])
  })
})

// ──────────────────── ambient exec context (dispatch handoff) ────────────────────

describe('ambient act exec context', () => {
  it('defaults to de-privileged (fail-safe) when nothing published a context', () => {
    clearActExecContext()
    expect(resolveActContext().execOk).toBe(false)
  })
  it('reflects the privilege the dispatch gate published', () => {
    setActExecContext(true)
    expect(resolveActContext().execOk).toBe(true)
    setActExecContext(false)
    expect(resolveActContext().execOk).toBe(false)
  })
})
