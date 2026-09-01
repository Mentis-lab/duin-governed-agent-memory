import { getAutomation, updateAutomation, type Automation } from './automations-store'
import { abortLoopIteration } from './loop-controller'
import { readLoopConfig, type LoopConfig } from './loop-config'
import { readSettings } from './settings-helper'
import {
  createLoop,
  enqueueBacklog,
  getLoop,
  updateLoop,
  type Loop,
  type LoopMode
} from './loop-store'
import { setGoalLoopTransitionHandler } from './goal-loop-transition-runtime'
import { bindGoalLoop, getGoal, transitionGoal, type Goal } from './plan-goal-store'

// Phase 5 — the goal ⇄ automation ⇄ loop bridge (highest runaway risk, LAST). A goal
// can OWN a background loop; an automation can WAKE that goal's loop on its trigger.
//
// DUIN SAFETY ADAPTATIONS (do NOT regress DUIN's autonomy control):
//   (b) any loop WAKE must pass BOTH backgroundAutonomy===true AND loops-enabled — a
//       lone loopsEnabled boolean is NOT sufficient (DUIN's runaway-billing history).
//       requireWakeAllowed() enforces the dual gate on every wake path.
//   (c) the composed ceilings only TIGHTEN the global policy (composeLoopCeilings folds
//       tightest); the trust-scaled effectiveCeilings term still applies at run time.
//
// SHIPS DEFAULT-OFF: loopsEnabled defaults false AND backgroundAutonomy defaults false,
// so nothing here wakes a loop until BOTH are explicitly turned on.

export interface LoopCeilings {
  maxIterations: number | null
  maxWallclockMs: number | null
  tokenBudget: number | null
}

type CeilingInput = Partial<LoopCeilings> | null | undefined

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** The tightest (minimum) of the supplied positive-integer caps, or null if none. */
function tightest(...values: unknown[]): number | null {
  const caps = values.map(positiveInteger).filter((value): value is number => value !== null)
  return caps.length ? Math.min(...caps) : null
}

/**
 * Phase 4 compose helper. Global loop policy is ALWAYS included; goal and automation
 * caps may only TIGHTEN it, never loosen it. This is the create/bind-time fold; the
 * run-time effectiveCeilings trust-scaling then tightens further.
 */
export function composeLoopCeilings(
  global: Pick<LoopConfig, 'maxIterations' | 'maxWallclockMs' | 'tokenBudget'>,
  goal?: CeilingInput,
  automation?: CeilingInput
): LoopCeilings {
  return {
    maxIterations: tightest(global.maxIterations, goal?.maxIterations, automation?.maxIterations),
    maxWallclockMs: tightest(global.maxWallclockMs, goal?.maxWallclockMs, automation?.maxWallclockMs),
    tokenBudget: tightest(global.tokenBudget, goal?.tokenBudget, automation?.tokenBudget)
  }
}

function requireLoopsEnabled(): LoopConfig {
  const config = readLoopConfig()
  if (!config.enabled) throw new Error('goal loop bridge: loops are disabled.')
  return config
}

/**
 * DUIN dual gate for any WAKE (making a loop due / running). BOTH must hold:
 *   • loopsEnabled (LoopConfig.enabled), AND
 *   • backgroundAutonomy === true (the kill switch the runner + controller both honor).
 * A lone loopsEnabled boolean is intentionally NOT sufficient — that was the class bug
 * behind the runaway-billing history. Binding/creation (which does NOT itself run a
 * turn) uses requireLoopsEnabled; only the wake paths require the full dual gate.
 */
function requireWakeAllowed(): LoopConfig {
  const config = requireLoopsEnabled()
  if (readSettings().backgroundAutonomy !== true) {
    throw new Error(
      'goal loop bridge: backgroundAutonomy is OFF — refusing to wake a background loop.'
    )
  }
  return config
}

function goalCeilings(goal: Goal): LoopCeilings {
  return {
    maxIterations: goal.loopMaxIterations,
    maxWallclockMs: goal.loopMaxWallclockMs,
    tokenBudget: goal.loopTokenBudget
  }
}

function automationCeilings(automation: Automation): LoopCeilings {
  return {
    maxIterations: automation.loopMaxIterations,
    maxWallclockMs: automation.loopMaxWallclockMs,
    tokenBudget: automation.loopTokenBudget
  }
}

/** Create a loop OWNED by a goal, bound + transitioned to active. Creation alone does
 *  not run a turn, so it requires loops-enabled but not the full wake gate; the goal
 *  going active triggers the transition handler, which DOES apply the wake gate. */
export function createGoalOwnedLoop(input: {
  conversationId: string
  goalId: string
  mode: LoopMode
  instruction?: string | null
  model?: string | null
  intervalSeconds?: number | null
  tasks?: string[]
  maxIterations?: number | null
  maxWallclockMs?: number | null
  tokenBudget?: number | null
}): { goal: Goal; loop: Loop } {
  const config = requireLoopsEnabled()
  const goal = getGoal(input.conversationId, input.goalId)
  if (!goal) throw new Error(`goal loop bridge: no goal with id "${input.goalId}".`)
  if (goal.lifecycleStatus === 'completed' || goal.lifecycleStatus === 'aborted') {
    throw new Error(`goal loop bridge: cannot bind a ${goal.lifecycleStatus} goal.`)
  }
  if (goal.loopId) throw new Error(`goal loop bridge: goal already owns loop "${goal.loopId}".`)

  const ceilings = composeLoopCeilings(config, {
    maxIterations: input.maxIterations,
    maxWallclockMs: input.maxWallclockMs,
    tokenBudget: input.tokenBudget
  })
  const loop = createLoop({
    conversationId: input.conversationId,
    mode: input.mode,
    instruction: input.instruction?.trim() || goal.description || goal.title,
    model: input.model,
    intervalSeconds: input.intervalSeconds,
    goalId: goal.id,
    goalConversationId: input.conversationId,
    ...ceilings
  })
  const tasks = (input.tasks ?? [goal.title]).map((task) => task.trim()).filter(Boolean)
  if (tasks.length) enqueueBacklog(loop.id, tasks)
  let bound = bindGoalLoop(input.conversationId, goal.id, { loopId: loop.id, ...ceilings })
  if (bound.lifecycleStatus === 'open') {
    bound = transitionGoal(input.conversationId, {
      goalId: bound.id,
      action: 'start',
      actor: 'system',
      reason: 'goal-owned-loop-started'
    })!
  }
  return { goal: bound, loop: getLoop(loop.id) ?? loop }
}

/** Bind an automation to a goal that already owns a loop, tightening the loop's
 *  ceilings by the automation's per-automation caps. */
export function bindAutomationToGoal(input: {
  automationId: string
  conversationId: string
  goalId: string
  maxIterations?: number | null
  maxWallclockMs?: number | null
  tokenBudget?: number | null
}): { automation: Automation; goal: Goal; loop: Loop } {
  const config = requireLoopsEnabled()
  const automation = getAutomation(input.automationId)
  if (!automation) throw new Error(`goal loop bridge: no automation with id "${input.automationId}".`)
  const goal = getGoal(input.conversationId, input.goalId)
  if (!goal?.loopId) throw new Error('goal loop bridge: the goal does not own a loop.')
  const loop = getLoop(goal.loopId)
  if (!loop) throw new Error(`goal loop bridge: no loop with id "${goal.loopId}".`)

  const requested = {
    maxIterations: input.maxIterations,
    maxWallclockMs: input.maxWallclockMs,
    tokenBudget: input.tokenBudget
  }
  const ceilings = composeLoopCeilings(
    config,
    {
      maxIterations: loop.maxIterations,
      maxWallclockMs: loop.maxWallclockMs,
      tokenBudget: loop.tokenBudget
    },
    requested
  )
  const tightened = updateLoop(loop.id, ceilings)
  const bound = updateAutomation(automation.id, {
    goalId: goal.id,
    goalConversationId: input.conversationId,
    loopMaxIterations: positiveInteger(input.maxIterations),
    loopMaxWallclockMs: positiveInteger(input.maxWallclockMs),
    loopTokenBudget: positiveInteger(input.tokenBudget)
  })
  if (!tightened || !bound) throw new Error('goal loop bridge: binding could not be persisted.')
  return { automation: bound, goal, loop: tightened }
}

/**
 * An automation wake never calls a provider directly; it makes the owned loop due.
 * DUIN dual gate (requireWakeAllowed) — BOTH loopsEnabled AND backgroundAutonomy — plus
 * the goal must be active. Ceilings are recomposed from the live goal + automation caps.
 */
export function wakeGoalFromAutomation(automation: Automation): {
  goalId: string
  loopId: string
  nextFireAt: number
  ceilings: LoopCeilings
} {
  const config = requireWakeAllowed()
  if (!automation.goalId || !automation.goalConversationId) {
    throw new Error('goal loop bridge: automation is not bound to a goal.')
  }
  const goal = getGoal(automation.goalConversationId, automation.goalId)
  if (!goal?.loopId) throw new Error('goal loop bridge: bound goal has no owned loop.')
  if (goal.lifecycleStatus !== 'active') {
    throw new Error(`goal loop bridge: bound goal is ${goal.lifecycleStatus}; wake refused.`)
  }
  const loop = getLoop(goal.loopId)
  if (!loop) throw new Error(`goal loop bridge: no loop with id "${goal.loopId}".`)
  const ceilings = composeLoopCeilings(config, goalCeilings(goal), automationCeilings(automation))
  const nextFireAt = Date.now()
  const updated = updateLoop(loop.id, { ...ceilings, status: 'running', nextFireAt, stopReason: null })
  if (!updated) throw new Error('goal loop bridge: loop wake could not be persisted.')
  return { goalId: goal.id, loopId: loop.id, nextFireAt, ceilings }
}

// Install the goal → loop side-effect handler. plan-goal-store calls this on every
// transition; a goal that owns a loop mirrors its lifecycle onto the loop:
//   • active            → wake the loop (DUAL GATE), running.
//   • paused / blocked  → abort the in-flight turn + pause the loop.
//   • completed         → abort + mark the loop done.
//   • aborted / clear   → abort + stop the loop.
// Never runs a turn itself; only flips loop scheduling state + cancels a live turn.
setGoalLoopTransitionHandler((_conversationId, goal, action) => {
  if (!goal.loopId) return
  const loop = getLoop(goal.loopId)
  if (!loop) return
  if (action === 'clear') {
    abortLoopIteration(loop.id)
    updateLoop(loop.id, { status: 'stopped', nextFireAt: null, stopReason: 'goal-cleared' })
    return
  }
  // Wake ONLY on a genuine start/resume transition — the two actions that actually move
  // a goal INTO 'active'. Keying on the resulting lifecycleStatus alone is a runaway-safety
  // hole: an 'edit' / 'record_usage' (or any non-lifecycle action) on an ALREADY-active
  // goal would otherwise force status='running' + nextFireAt=now(), resurrecting a loop the
  // loop-controller had deliberately paused/stopped (stall / resource / cost) and collapsing
  // its interval pacing (Date.now() has no MIN_INTERVAL floor). The loop-controller never
  // transitions the goal, so such a pause leaves the goal 'active' and would be undone here.
  if (action === 'start' || action === 'resume') {
    if (goal.lifecycleStatus !== 'active') return
    // DUAL GATE on wake — BOTH loopsEnabled AND backgroundAutonomy. Throws if either
    // is off, so a goal cannot silently resurrect a background loop while autonomy is
    // suppressed. (requireWakeAllowed centralizes the two checks.)
    requireWakeAllowed()
    updateLoop(loop.id, { status: 'running', nextFireAt: Date.now(), stopReason: null })
    return
  }
  // A non-lifecycle action (edit / record_usage) on an active goal must leave the loop's
  // scheduling untouched — do NOT abort the in-flight turn or re-pace it.
  if (goal.lifecycleStatus === 'active') return
  abortLoopIteration(loop.id)
  if (goal.lifecycleStatus === 'paused' || goal.lifecycleStatus === 'blocked') {
    updateLoop(loop.id, {
      status: 'paused',
      nextFireAt: null,
      stopReason: goal.blocker ?? `goal-${goal.lifecycleStatus}`
    })
  } else if (goal.lifecycleStatus === 'completed') {
    updateLoop(loop.id, { status: 'done', nextFireAt: null, stopReason: 'goal-completed' })
  } else if (goal.lifecycleStatus === 'aborted') {
    updateLoop(loop.id, { status: 'stopped', nextFireAt: null, stopReason: 'goal-aborted' })
  }
})
