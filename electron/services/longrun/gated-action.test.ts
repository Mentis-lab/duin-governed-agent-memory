import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  requiresApproval,
  requestApproval,
  productionIrreversibilityFloor,
  type GatedAction,
  type IrreversibilityFloorSeam,
  type ApprovalSeam
} from './gated-action'
import type { ActionTier } from '../act/action-tier'
import {
  registerExternalActionTier,
  __clearExternalActionRegistry
} from '../act/action-tier'
import type { Loop } from '../loop-store'

function loop(over: Partial<Loop> = {}): Loop {
  return {
    id: 'loop-7',
    conversationId: 'conv-1',
    mode: 'autonomous',
    status: 'running',
    instruction: 'nightly build',
    model: 'duin-brain',
    intervalSeconds: null,
    maxIterations: null,
    maxWallclockMs: null,
    tokenBudget: null,
    iteration: 3,
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

const floorOf = (tier: ActionTier): IrreversibilityFloorSeam => () => tier

describe('requiresApproval — irreversibility floor', () => {
  it('only irreversible actions ALWAYS require approval', () => {
    const action: GatedAction = { verb: 'deploy', summary: 'deploy to prod' }
    expect(requiresApproval(action, floorOf('irreversible'))).toBe(true)
    expect(requiresApproval(action, floorOf('write-reversible'))).toBe(false)
    expect(requiresApproval(action, floorOf('read'))).toBe(false)
  })

  it('passes the action through to the injected classifier', () => {
    const floor = vi.fn<IrreversibilityFloorSeam>(() => 'irreversible')
    const action: GatedAction = { tool: 'publish_release', summary: 'cut v2' }
    requiresApproval(action, floor)
    expect(floor).toHaveBeenCalledWith(action)
  })
})

describe('requestApproval — happy path', () => {
  it('returns allow only on an explicit allow verdict', async () => {
    const approval = vi.fn<ApprovalSeam>(async () => 'allow')
    const verdict = await requestApproval(
      { verb: 'delete', summary: 'drop the temp table' },
      loop(),
      approval
    )
    expect(verdict).toBe('allow')
  })

  it('builds a prompt from the action summary + loop context', async () => {
    const approval = vi.fn<ApprovalSeam>(async () => 'allow')
    await requestApproval({ tool: 'send_email', summary: 'email the client' }, loop(), approval)
    const [prompt, passedLoop] = approval.mock.calls[0]
    expect(prompt).toContain('Loop loop-7')
    expect(prompt).toContain('iteration 3')
    expect(prompt).toContain('send_email')
    expect(prompt).toContain('email the client')
    expect(passedLoop.id).toBe('loop-7')
  })
})

describe('requestApproval — the failure the invariant kills (unattended act), fail-closed', () => {
  it('an explicit deny skips the step', async () => {
    const approval: ApprovalSeam = async () => 'deny'
    expect(await requestApproval({ summary: 'x' }, loop(), approval)).toBe('deny')
  })

  it('an approval timeout (seam throws) fails closed to deny', async () => {
    const approval: ApprovalSeam = async () => {
      throw new Error('operator-approval timed out')
    }
    expect(await requestApproval({ summary: 'x' }, loop(), approval)).toBe('deny')
  })

  it('any non-allow verdict (unknown value) is treated as deny', async () => {
    const approval = (async () => 'maybe') as unknown as ApprovalSeam
    expect(await requestApproval({ summary: 'x' }, loop(), approval)).toBe('deny')
  })
})

// The REAL production floor (what productionLongRunDeps wires), driven with the
// exact GatedAction shape runLoopIteration step 3.5 builds from a backlog item:
//   { verb: item.task.trim().split(/\s+/)[0], summary: item.task }
// — no `tool`, no `tier`. Before the fix this classified ordinary prose as
// 'irreversible', so with no approval channel wired every such item was skipped
// 'no-approval-channel' and the loop drained its backlog doing zero work.
describe('productionIrreversibilityFloor — free-text backlog tasks', () => {
  const fromTask = (task: string): GatedAction => ({
    verb: task.trim().split(/\s+/)[0],
    summary: task
  })

  afterEach(() => __clearExternalActionRegistry())

  it('does NOT require approval for ordinary prose backlog tasks', () => {
    for (const task of [
      'Implement the parser refactor',
      'Investigate the flaky test',
      "Summarize this week's notes",
      'Refactor loop-controller step 3.5'
    ]) {
      const action = fromTask(task)
      expect(productionIrreversibilityFloor(action)).not.toBe('irreversible')
      expect(requiresApproval(action, productionIrreversibilityFloor)).toBe(false)
    }
  })

  it('still gates a backlog task whose verb IS explicitly irreversible', () => {
    for (const task of [
      'Delete the staging database',
      'Deploy the release to prod',
      'Send the summary email to the client'
    ]) {
      const action = fromTask(task)
      expect(productionIrreversibilityFloor(action)).toBe('irreversible')
      expect(requiresApproval(action, productionIrreversibilityFloor)).toBe(true)
    }
  })

  it('leaves read/write prose verbs on their own tier', () => {
    expect(productionIrreversibilityFloor(fromTask('Read the config file'))).toBe('read')
    expect(productionIrreversibilityFloor(fromTask('Draft the changelog'))).toBe('write-reversible')
  })

  it('keeps an unrecognised prose verb non-read, so the exec-token gate still applies', () => {
    expect(productionIrreversibilityFloor(fromTask('Frobnicate the widget'))).toBe(
      'write-reversible'
    )
  })
})

describe('productionIrreversibilityFloor — declared actions keep the strict fail-safe', () => {
  afterEach(() => __clearExternalActionRegistry())

  it('an explicit tier wins', () => {
    expect(productionIrreversibilityFloor({ tier: 'read', verb: 'delete', summary: 's' })).toBe(
      'read'
    )
  })

  it('a registered tool resolves through the external-action registry', () => {
    registerExternalActionTier('gcal_add_event', 'write-reversible')
    expect(productionIrreversibilityFloor({ tool: 'gcal_add_event', summary: 's' })).toBe(
      'write-reversible'
    )
  })

  it('an UNREGISTERED tool with an unknown verb still fails closed to irreversible', () => {
    expect(productionIrreversibilityFloor({ tool: 'mystery_tool', summary: 's' })).toBe(
      'irreversible'
    )
  })
})

describe('gated-action — edge cases', () => {
  it('falls back to a generic label when no tool/verb given', async () => {
    const approval = vi.fn<ApprovalSeam>(async () => 'deny')
    await requestApproval({ summary: 'do the thing' }, loop(), approval)
    expect(approval.mock.calls[0][0]).toContain('irreversible action')
  })
})
