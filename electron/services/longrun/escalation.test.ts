import { describe, it, expect, vi } from 'vitest'
import { shouldEscalate, escalate, type DeliverSeam, type EscalationReason } from './escalation'
import type { Loop } from '../loop-store'

function loop(over: Partial<Loop> = {}): Loop {
  return {
    id: 'loop-42',
    conversationId: 'conv-1',
    mode: 'autonomous',
    status: 'paused',
    instruction: 'ship the migration',
    model: 'duin-brain',
    intervalSeconds: null,
    maxIterations: null,
    maxWallclockMs: null,
    tokenBudget: null,
    iteration: 12,
    tokensUsed: 0,
    startedAt: 1_000,
    lastIterationAt: null,
    nextFireAt: null,
    stopReason: null,
    costSpent: 0,
    costBudgetUsd: null,
    stallCount: 0,
    lastStateHash: null,
    rollingSummary: null,
    artifactDir: null,
    lastGitSha: null,
    providerChain: null,
    currentProvider: null,
    lastDigestAt: null,
    goalId: null,
    goalConversationId: null,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

const ok: DeliverSeam = async () => ({ ok: true })

describe('shouldEscalate — the closed trigger set', () => {
  it('accepts every known reason', () => {
    const reasons: EscalationReason[] = [
      'stalled',
      'repeated-failure',
      'budget-breach',
      'resource-exhaustion',
      'approval-timeout',
      'permanent-error',
      'turn-incomplete'
    ]
    for (const r of reasons) expect(shouldEscalate(r)).toBe(true)
  })

  it('rejects anything outside the set (no wasted operator ping)', () => {
    for (const r of ['', 'backlog-empty', 'done', 'cost-budget', 'unknown', 'STALLED']) {
      expect(shouldEscalate(r)).toBe(false)
    }
  })
})

describe('escalate — happy path', () => {
  it('delivers a human-readable notice and reports delivered:true', async () => {
    const deliver = vi.fn(ok)
    const res = await escalate('stalled', loop(), deliver)
    expect(res.delivered).toBe(true)
    expect(deliver).toHaveBeenCalledOnce()
    const body = deliver.mock.calls[0][0]
    expect(body).toContain('Loop loop-42 paused: stalled')
    expect(body).toContain('iteration 12')
    expect(body).toContain('mode autonomous')
    expect(body).toContain('task: ship the migration')
    expect(body).toContain('Operator attention needed')
  })

  it('includes a distinct blurb per reason', async () => {
    const deliver = vi.fn(ok)
    await escalate('budget-breach', loop(), deliver)
    expect(deliver.mock.calls[0][0]).toContain('cost budget was exceeded')
  })
})

describe('escalate — the failure the invariant kills (silent stall), fail-closed delivery', () => {
  it('reports delivered:false when the seam returns !ok', async () => {
    const deliver: DeliverSeam = async () => ({ ok: false, error: 'channel down' })
    const res = await escalate('resource-exhaustion', loop(), deliver)
    expect(res.delivered).toBe(false)
  })

  it('never throws when the seam throws — returns delivered:false', async () => {
    const deliver: DeliverSeam = async () => {
      throw new Error('boom')
    }
    await expect(escalate('permanent-error', loop(), deliver)).resolves.toEqual({
      delivered: false
    })
  })

  it('treats a malformed seam result as not delivered', async () => {
    const deliver = (async () => undefined) as unknown as DeliverSeam
    const res = await escalate('approval-timeout', loop(), deliver)
    expect(res.delivered).toBe(false)
  })
})

describe('escalate — edge cases', () => {
  it('omits the task clause when instruction is null/blank', async () => {
    const deliver = vi.fn(ok)
    await escalate('repeated-failure', loop({ instruction: null }), deliver)
    expect(deliver.mock.calls[0][0]).not.toContain('task:')
  })
})
