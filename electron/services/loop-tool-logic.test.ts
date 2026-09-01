import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  applyLoopEnqueue,
  applyLoopCompleteTask,
  applyLoopControl,
  MIN_LOOP_DELAY_SECONDS,
  type LoopToolStore
} from './loop-tool-logic'
import type { Loop, BacklogItem } from './loop-store'

// LP-4 — pure tool logic, injected fake store: these RUN (no DB, no skip).

function makeLoop(over: Partial<Loop> = {}): Loop {
  return {
    id: 'loop-1',
    conversationId: 'conv-1',
    mode: 'autonomous',
    status: 'running',
    instruction: null,
    model: 'deepseek-chat',
    intervalSeconds: null,
    maxIterations: null,
    maxWallclockMs: null,
    tokenBudget: null,
    iteration: 0,
    tokensUsed: 0,
    startedAt: 0,
    lastIterationAt: null,
    nextFireAt: 0,
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

function makeFake(loop: Loop | null, inProgress: BacklogItem | null = null) {
  const loopPatches: Array<{ id: string; patch: Record<string, unknown> }> = []
  const backlogPatches: Array<{ id: string; patch: Record<string, unknown> }> = []
  const enqueued: BacklogItem[] = []
  const seam: LoopToolStore = {
    getActiveLoopForConversation: () => loop,
    enqueueBacklog: (loopId, tasks) => {
      const items = tasks.map(
        (t, i) =>
          ({
            id: `b${enqueued.length + i}`,
            loopId,
            position: enqueued.length + i,
            task: t,
            status: 'pending',
            result: null,
            createdAt: 0,
            startedAt: null,
            finishedAt: null
          }) as BacklogItem
      )
      enqueued.push(...items)
      return items
    },
    inProgressBacklogItem: () => inProgress,
    updateBacklogItem: (id, patch) => {
      backlogPatches.push({ id, patch: patch as Record<string, unknown> })
      return null
    },
    updateLoop: (id, patch) => {
      loopPatches.push({ id, patch: patch as Record<string, unknown> })
      return loop
    }
  }
  return { seam, loopPatches, backlogPatches, enqueued }
}

describe('applyLoopEnqueue', () => {
  it('fails with no active loop', () => {
    const f = makeFake(null)
    expect(applyLoopEnqueue(f.seam, 'conv-1', ['a']).ok).toBe(false)
  })
  it('enqueues non-empty tasks and drops blanks', () => {
    const f = makeFake(makeLoop())
    const r = applyLoopEnqueue(f.seam, 'conv-1', ['  do x ', '', '   ', 'do y'])
    expect(r).toMatchObject({ ok: true, enqueued: 2 })
    expect(f.enqueued.map((e) => e.task)).toEqual(['do x', 'do y'])
  })
  it('fails when all tasks are blank', () => {
    const f = makeFake(makeLoop())
    expect(applyLoopEnqueue(f.seam, 'conv-1', ['', '  ']).ok).toBe(false)
  })
})

describe('applyLoopCompleteTask', () => {
  it('fails with no in-progress item', () => {
    const f = makeFake(makeLoop(), null)
    expect(applyLoopCompleteTask(f.seam, 'conv-1', 'done').ok).toBe(false)
  })
  it('records the outcome WITHOUT flagging the item done (the controller owns close-out)', () => {
    // This assertion used to demand `status: 'done'` — that was the defect, not the
    // contract. The tool runs mid-turn; `done` must be written only by runLoopIteration,
    // after the durable commit + the 2BRAIN verify gate. See applyLoopCompleteTask.
    const item: BacklogItem = {
      id: 'b1',
      loopId: 'loop-1',
      position: 0,
      task: 't',
      status: 'in_progress',
      result: null,
      createdAt: 0,
      startedAt: 0,
      finishedAt: null
    }
    const f = makeFake(makeLoop(), item)
    const r = applyLoopCompleteTask(f.seam, 'conv-1', 'shipped the fix')
    expect(r).toMatchObject({ ok: true, completed: 'b1' })
    expect(f.backlogPatches).toHaveLength(1)
    expect(f.backlogPatches[0]).toMatchObject({ id: 'b1', patch: { result: 'shipped the fix' } })
    // No lifecycle fields at all — not even a stale finishedAt on an unfinished item.
    expect(f.backlogPatches[0].patch).not.toHaveProperty('status')
    expect(f.backlogPatches[0].patch).not.toHaveProperty('finishedAt')
  })
})

describe('applyLoopControl', () => {
  it('pause / stop / mission_complete set terminal-ish state + clear nextFireAt', () => {
    const f = makeFake(makeLoop())
    applyLoopControl(f.seam, 'conv-1', 'pause', { now: 0 })
    applyLoopControl(f.seam, 'conv-1', 'stop', { now: 0, reason: 'user asked' })
    applyLoopControl(f.seam, 'conv-1', 'mission_complete', { now: 0 })
    expect(f.loopPatches[0].patch).toMatchObject({ status: 'paused', nextFireAt: null })
    expect(f.loopPatches[1].patch).toMatchObject({ status: 'stopped', stopReason: 'user asked', nextFireAt: null })
    expect(f.loopPatches[2].patch).toMatchObject({ status: 'done', stopReason: 'mission-complete', nextFireAt: null })
  })
  it('continue sets a future nextFireAt clamped to the floor', () => {
    const f = makeFake(makeLoop())
    const r = applyLoopControl(f.seam, 'conv-1', 'continue', { now: 1000, delaySeconds: 5 })
    // 5s requested but clamped to the 30s floor
    expect(r).toMatchObject({ ok: true, status: 'running', nextFireAt: 1000 + MIN_LOOP_DELAY_SECONDS * 1000 })
    expect(f.loopPatches[0].patch).toMatchObject({ status: 'running' })
  })
  it('continue honours a delay above the floor', () => {
    const f = makeFake(makeLoop())
    const r = applyLoopControl(f.seam, 'conv-1', 'continue', { now: 1000, delaySeconds: 120 })
    expect(r.nextFireAt).toBe(1000 + 120 * 1000)
  })
  it('fails with no active loop', () => {
    const f = makeFake(null)
    expect(applyLoopControl(f.seam, 'conv-1', 'pause', { now: 0 }).ok).toBe(false)
  })
})

// ── backlog finding 48 ──────────────────────────────────────────────────────

describe('applyLoopControl — the configured delay floor is honoured', () => {
  it('uses minDelaySeconds when supplied, not the hardcoded floor', () => {
    // The production handler never passed one, so every loop_control{delaySeconds} was
    // floored at MIN_LOOP_DELAY_SECONDS and raising the operator's configured
    // minIntervalSeconds changed nothing for the model's own reschedules.
    const f = makeFake(makeLoop())
    applyLoopControl(f.seam, 'conv-1', 'continue', {
      delaySeconds: 30,
      minDelaySeconds: 600,
      now: 1_000_000
    })
    expect(f.loopPatches.at(-1)!.patch.nextFireAt).toBe(1_000_000 + 600 * 1000)
  })

  it('still respects a delay ABOVE the floor', () => {
    const f = makeFake(makeLoop())
    applyLoopControl(f.seam, 'conv-1', 'continue', {
      delaySeconds: 900,
      minDelaySeconds: 600,
      now: 1_000_000
    })
    expect(f.loopPatches.at(-1)!.patch.nextFireAt).toBe(1_000_000 + 900 * 1000)
  })

  it('falls back to the hardcoded floor when no config value is threaded', () => {
    // Absent minDelaySeconds keeps today's behaviour exactly.
    const f = makeFake(makeLoop())
    applyLoopControl(f.seam, 'conv-1', 'continue', { delaySeconds: 1, now: 1_000_000 })
    expect(f.loopPatches.at(-1)!.patch.nextFireAt).toBeGreaterThan(1_000_000)
  })
})

describe('the production loop_control handler threads the configured floor', () => {
  it('passes minDelaySeconds through, which is the half that was missing', () => {
    // The three cases above pass with or without the fix: applyLoopControl always
    // honoured minDelaySeconds. The DEFECT was that loop-tool-pack never supplied it, so
    // this is the assertion that actually guards it. Source-level because registering the
    // pack pulls the whole tool-registry graph for one call-shape check.
    const src = readFileSync(join(__dirname, 'loop-tool-pack.ts'), 'utf-8')
    expect(src).toMatch(/minDelaySeconds:\s*readLoopConfig\(\)\.minIntervalSeconds/)
  })
})
