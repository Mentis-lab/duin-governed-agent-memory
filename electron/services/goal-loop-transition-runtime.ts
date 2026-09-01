import type { Goal, GoalAction } from './plan-goal-store'

// Runtime seam between plan-goal-store (which owns the goal lifecycle state machine)
// and goal-automation-loop-bridge (which owns the goal→loop side-effects). The store
// must not import the bridge directly — the bridge imports the store — so the store
// calls applyGoalLoopTransition and the bridge installs the handler at module load.
// Absent handler ⇒ goal transitions are pure state changes with no loop side-effect
// (the default, and the whole loop bridge is default-off).

export type GoalLoopTransitionHandler = (
  conversationId: string | undefined,
  goal: Goal,
  action: GoalAction
) => void

let handler: GoalLoopTransitionHandler | null = null

export function setGoalLoopTransitionHandler(next: GoalLoopTransitionHandler | null): void {
  handler = next
}

export function applyGoalLoopTransition(
  conversationId: string | undefined,
  goal: Goal,
  action: GoalAction
): void {
  handler?.(conversationId, goal, action)
}
