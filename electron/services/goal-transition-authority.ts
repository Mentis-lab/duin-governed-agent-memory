import type { GoalAction, GoalActor } from './plan-goal-store'
import { classify, recordFeedback } from './ans/capability-ledger'

// DUIN ADAPTATION of upstream Lamprey's static "model authority cannot abort/clear
// a goal" rule. Upstream hard-codes: a `model` actor may never issue a TERMINAL goal
// transition. DUIN instead routes a model-initiated terminal transition through the
// ANS capability-ledger rung gate for the seeded `goal-terminal-transition`
// capability — so the model can EARN the authority (governor promotes the rung on a
// clean ratify record) rather than being permanently barred. A `user` or `system`
// actor always bypasses this gate (a human/deterministic caller is the authority).
//
// The three terminal actions are the ones that END or DELETE a goal's lifecycle:
//   • abort    — mark the goal aborted (terminal)
//   • clear    — delete the goal entirely
//   • complete — mark the goal completed (terminal)
// A non-terminal transition (start/pause/resume/block/edit/record_usage) is never
// gated here — those are reversible and belong to the ordinary lifecycle machine.
//
// Rung semantics (capability-ledger.classify):
//   • 'run'   (reflexive, earned) → AUTHORIZED: the model may issue the transition.
//   • 'stage' / 'hold' (default)  → DENIED: the transition throws; the model must ask
//     a human. The capability seeds at 'stage', so the DEFAULT behaviour matches
//     upstream's static deny — but is now promotable. This keeps the feature
//     default-OFF for model autonomy without a code change.
//
// Feedback: every gated DECISION records a ratify/dismiss verdict against the
// capability so the governor's promotion math sees real usage — an AUTHORIZED
// terminal transition is a 'ratify' (the earned autonomy was exercised and stood),
// a DENIED one is a 'dismiss' (attempted-but-refused, no positive evidence).

export const GOAL_TERMINAL_TRANSITION_CAP_ID = 'goal-terminal-transition'

const TERMINAL_ACTIONS: ReadonlySet<GoalAction> = new Set<GoalAction>(['abort', 'clear', 'complete'])

/** Whether an action ends or deletes a goal's lifecycle (the gated class). */
export function isTerminalGoalAction(action: GoalAction): boolean {
  return TERMINAL_ACTIONS.has(action)
}

export interface GoalTransitionAuthorityResult {
  authorized: boolean
  /** The gate that decided it: 'actor-bypass' (user/system), 'non-terminal' (not
   *  gated), or 'ans-rung' (routed through the capability-ledger). */
  via: 'actor-bypass' | 'non-terminal' | 'ans-rung'
  /** The capability rung at decision time (only when via === 'ans-rung'). `'unknown'` means the
   *  ledger has no such capability — this gate already fails closed on it (`authorized` requires
   *  `'run'`), and it is surfaced rather than flattened so the thrown message says which of "held"
   *  and "never registered" actually happened. */
  rung?: 'run' | 'stage' | 'hold' | 'unknown'
}

/**
 * Decide whether `actor` may issue `action` on a goal. Pure decision + a best-effort
 * feedback write; the caller (transitionGoal) enforces by throwing on !authorized.
 *
 *  - user/system actor            → always authorized (via 'actor-bypass').
 *  - non-terminal action          → always authorized (via 'non-terminal'); NOT gated.
 *  - model actor + terminal action → routed through the ANS rung ('ans-rung').
 */
export function authorizeGoalTransition(
  action: GoalAction,
  actor: GoalActor
): GoalTransitionAuthorityResult {
  if (actor !== 'model') return { authorized: true, via: 'actor-bypass' }
  if (!isTerminalGoalAction(action)) return { authorized: true, via: 'non-terminal' }

  const rung = classify(GOAL_TERMINAL_TRANSITION_CAP_ID)
  const authorized = rung === 'run'
  // Record the exercised/refused verdict so the governor's promotion evidence is fed
  // by real terminal-transition attempts, not just synthetic ratify calls. Best-effort:
  // an unseeded capability (recordFeedback → false) simply records nothing.
  try {
    recordFeedback(GOAL_TERMINAL_TRANSITION_CAP_ID, authorized ? 'ratify' : 'dismiss')
  } catch {
    // never let a ledger write failure block or corrupt the transition decision
  }
  return { authorized, via: 'ans-rung', rung }
}

/** Throwing enforcement wrapper for transitionGoal. Mirrors upstream's error shape
 *  so callers/tests that expected "model authority cannot <action>" still match. */
export function assertGoalTransitionAuthorized(action: GoalAction, actor: GoalActor): void {
  const decision = authorizeGoalTransition(action, actor)
  if (!decision.authorized) {
    throw new Error(
      `update_goal: model authority cannot ${action} a goal ` +
        `(ANS capability "${GOAL_TERMINAL_TRANSITION_CAP_ID}" rung is "${decision.rung}", not earned). ` +
        'Ask a human to confirm, or let the governor promote this capability once its ratify record earns it.'
    )
  }
}
