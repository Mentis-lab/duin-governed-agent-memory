import { describe, it, expect, vi, beforeEach } from 'vitest'

// The bridge (and loop-controller it imports) reach for electron at module load.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '/tmp/lamprey-test-irrelevant' }
}))

// Both wake gates ON — so a wrongful wake would actually fire (and be observable).
vi.mock('./loop-config', () => ({
  readLoopConfig: () => ({ enabled: true, maxIterations: 25, maxWallclockMs: 1_800_000, tokenBudget: 500_000 })
}))
vi.mock('./settings-helper', () => ({
  readSettings: () => ({ backgroundAutonomy: true })
}))

const updateLoop = vi.fn((_id: string, patch: Record<string, unknown>) => ({ id: 'loop-1', ...patch }))
const getLoop = vi.fn(() => ({
  id: 'loop-1',
  status: 'paused',
  nextFireAt: null,
  intervalSeconds: 3600,
  stopReason: 'stalled'
}))
vi.mock('./loop-store', () => ({
  getLoop: (...a: unknown[]) => (getLoop as unknown as (...x: unknown[]) => unknown)(...a),
  updateLoop: (...a: unknown[]) => (updateLoop as unknown as (...x: unknown[]) => unknown)(...a),
  createLoop: vi.fn(),
  enqueueBacklog: vi.fn()
}))

const abortLoopIteration = vi.fn()
vi.mock('./loop-controller', () => ({
  abortLoopIteration: (...a: unknown[]) => (abortLoopIteration as unknown as (...x: unknown[]) => unknown)(...a),
  effectiveCeilings: vi.fn()
}))

// Importing the bridge installs the goal→loop transition handler as a module side-effect.
import './goal-automation-loop-bridge'
import { applyGoalLoopTransition } from './goal-loop-transition-runtime'
import type { Goal, GoalAction } from './plan-goal-store'

function activeGoal(): Goal {
  // Only the fields the handler reads matter here.
  return { id: 'g1', loopId: 'loop-1', lifecycleStatus: 'active' } as unknown as Goal
}

function fire(action: GoalAction, goal: Goal = activeGoal()): void {
  applyGoalLoopTransition('conv-1', goal, action)
}

describe('goal→loop transition handler — wake keys on ACTION, not on residual lifecycleStatus', () => {
  beforeEach(() => {
    updateLoop.mockClear()
    abortLoopIteration.mockClear()
    getLoop.mockClear()
  })

  it('does NOT resurrect a controller-paused loop on an edit of an already-active goal', () => {
    fire('edit')
    // The loop-controller paused L (stall/resource/cost); an edit must leave it untouched.
    expect(updateLoop).not.toHaveBeenCalled()
    expect(abortLoopIteration).not.toHaveBeenCalled()
  })

  it('does NOT wake / re-pace the loop on a record_usage accrual of an active goal', () => {
    fire('record_usage')
    expect(updateLoop).not.toHaveBeenCalled()
    expect(abortLoopIteration).not.toHaveBeenCalled()
  })

  it('DOES wake the loop on a genuine start transition', () => {
    fire('start')
    expect(updateLoop).toHaveBeenCalledWith(
      'loop-1',
      expect.objectContaining({ status: 'running', stopReason: null })
    )
  })

  it('DOES wake the loop on a genuine resume transition', () => {
    fire('resume')
    expect(updateLoop).toHaveBeenCalledWith(
      'loop-1',
      expect.objectContaining({ status: 'running', stopReason: null })
    )
  })
})
