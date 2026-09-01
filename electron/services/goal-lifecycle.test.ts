import { describe, it, expect, beforeEach, vi } from 'vitest'

// plan-goal-store → loop-config → electron. Mock electron so the store loads headless;
// force the persistence memory fallback so no real DB is needed.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/lamprey-test-irrelevant' },
  BrowserWindow: { getAllWindows: () => [] }
}))

import {
  createGoal,
  transitionGoal,
  getGoal,
  __resetPlanGoalStore
} from './plan-goal-store'
import { __forceMemoryFallback } from './plan-goal-persistence'
import { __resetCapabilityLedger, registerCapability, setRung } from './ans/capability-ledger'
import { GOAL_TERMINAL_TRANSITION_CAP_ID } from './goal-transition-authority'

const CONV = 'conv-lifecycle'

describe('operational-goal lifecycle', () => {
  beforeEach(() => {
    __resetPlanGoalStore()
    __forceMemoryFallback()
    __resetCapabilityLedger()
  })

  it('walks open → active → paused → active (resume) → completed by a user actor', () => {
    const g = createGoal(CONV, { title: 'ship it', actor: 'user' })
    expect(g.lifecycleStatus).toBe('open')

    const started = transitionGoal(CONV, { goalId: g.id, action: 'start', actor: 'user' })!
    expect(started.lifecycleStatus).toBe('active')
    expect(started.status).toBe('in_progress') // legacy mirror

    const paused = transitionGoal(CONV, { goalId: g.id, action: 'pause', actor: 'user' })!
    expect(paused.lifecycleStatus).toBe('paused')

    const resumed = transitionGoal(CONV, { goalId: g.id, action: 'resume', actor: 'user' })!
    expect(resumed.lifecycleStatus).toBe('active')

    const done = transitionGoal(CONV, {
      goalId: g.id,
      action: 'complete',
      actor: 'user',
      completion: 'shipped v1'
    })!
    expect(done.lifecycleStatus).toBe('completed')
    expect(done.status).toBe('done')
    expect(done.completion).toBe('shipped v1')
  })

  it('blocks a model actor from a terminal transition by default, allows once earned', () => {
    const g = createGoal(CONV, { title: 'risky', actor: 'user' })
    transitionGoal(CONV, { goalId: g.id, action: 'start', actor: 'user' })

    // default (unseeded capability) → model abort denied
    expect(() => transitionGoal(CONV, { goalId: g.id, action: 'abort', actor: 'model' })).toThrow(
      /model authority cannot abort/i
    )
    // still active (the throw happened before any mutation)
    expect(getGoal(CONV, g.id)!.lifecycleStatus).toBe('active')

    // earn the capability → model abort now allowed
    registerCapability({ id: GOAL_TERMINAL_TRANSITION_CAP_ID, title: 'terminal', rung: 'stage' })
    setRung(GOAL_TERMINAL_TRANSITION_CAP_ID, 'reflexive')
    const aborted = transitionGoal(CONV, { goalId: g.id, action: 'abort', actor: 'model' })!
    expect(aborted.lifecycleStatus).toBe('aborted')
    expect(aborted.status).toBe('abandoned')
  })

  it('lets user/system actors bypass the terminal gate regardless of the capability rung', () => {
    const g = createGoal(CONV, { title: 'chore', actor: 'user' })
    transitionGoal(CONV, { goalId: g.id, action: 'start', actor: 'user' })
    // no capability seeded → user complete still works (bypass)
    const done = transitionGoal(CONV, {
      goalId: g.id,
      action: 'complete',
      actor: 'system',
      completion: 'auto-closed'
    })!
    expect(done.lifecycleStatus).toBe('completed')
  })

  it('auto-blocks a goal that exhausts its token budget via record_usage (a SYSTEM block)', () => {
    const g = createGoal(CONV, { title: 'budgeted', actor: 'user', tokenBudget: 100 })
    transitionGoal(CONV, { goalId: g.id, action: 'start', actor: 'user' })
    const after = transitionGoal(CONV, {
      goalId: g.id,
      action: 'record_usage',
      actor: 'model',
      tokensUsed: 150
    })!
    expect(after.lifecycleStatus).toBe('blocked')
    expect(after.blocker).toBe('token-budget-exhausted')
    expect(after.lastActor).toBe('system') // the system block wins over the model actor
  })

  it('clear deletes the goal entirely', () => {
    const g = createGoal(CONV, { title: 'temp', actor: 'user' })
    const result = transitionGoal(CONV, { goalId: g.id, action: 'clear', actor: 'user' })
    expect(result).toBeNull()
    expect(getGoal(CONV, g.id)).toBeNull()
  })

  it('refuses to pause a goal that is not active', () => {
    const g = createGoal(CONV, { title: 'idle', actor: 'user' })
    expect(() => transitionGoal(CONV, { goalId: g.id, action: 'pause', actor: 'user' })).toThrow(
      /pause requires active/i
    )
  })
})
