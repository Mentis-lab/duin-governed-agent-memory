// gated-action.ts — Long-run L8 (HITL). The pre-act gate for irreversible steps
// an autonomous loop is about to take (deploy, delete, publish, spend). It
// reuses DUIN's existing three-tier irreversibility ladder (../act/action-tier)
// so a loop turn is held to the SAME action-class floor as an interactive turn:
// only 'irreversible' actions ALWAYS require explicit operator approval.
//
// Both I/O boundaries are injected seams so this module never drags in the heavy
// ACT substrate, electron, or a channel:
//   - IrreversibilityFloorSeam classifies an action's tier (production =
//     classifyActionTier / externalActionTier from action-tier.ts).
//   - ApprovalSeam is the operator round-trip (production = the channel
//     operator-approval flow; a timeout resolves 'deny'). FAIL-CLOSED: anything
//     that is not an explicit 'allow' — a 'deny', an unknown verdict, or a
//     thrown seam — is treated as 'deny', so the loop never acts unattended.

import type { Loop } from '../loop-store'
import type { ActionTier } from '../act/action-tier'
import {
  tierRequiresApproval,
  tierForVerb,
  classifyActionTier,
  externalActionTier
} from '../act/action-tier'

/** A prospective irreversible/costly step the loop is about to take. `summary`
 *  is the human-readable description shown to the operator; `tier`/`verb` feed
 *  the injected classifier. Reuses ActionTier from ../act/action-tier. */
export interface GatedAction {
  tool?: string
  verb?: string
  tier?: ActionTier
  summary: string
}

/** Injected classifier (production = classifyActionTier / externalActionTier;
 *  tests pass a stub). Keeps gated-action from importing the heavy ACT
 *  substrate while still resolving an action to its consequence tier. */
export type IrreversibilityFloorSeam = (action: GatedAction) => ActionTier

/**
 * PURE. True when the action's resolved tier ALWAYS needs explicit operator
 * approval — i.e. it is 'irreversible', matching the existing action-class
 * floor (tierRequiresApproval). Reversible / read actions gate through the
 * normal exec-token path, not through here.
 */
export function requiresApproval(action: GatedAction, floor: IrreversibilityFloorSeam): boolean {
  return tierRequiresApproval(floor(action))
}

/**
 * PURE. The PRODUCTION irreversibility floor (wired as `deps.irreversibilityFloor`
 * in loop-controller's productionLongRunDeps).
 *
 * WHY this is not just `classifyActionTier`: that classifier's unknown-verb
 * fail-safe is `'irreversible'`, which is correct for a DECLARED external action
 * (a connector that named a tool/tier must never slip past the hard gate through a
 * verb nobody recognised). It is WRONG for the other kind of action that reaches
 * this seam — a loop backlog item, whose "verb" is merely the first word of free
 * prose the operator typed ("Implement the parser refactor" → verb 'Implement').
 * Such a word is not a connector verb at all, and running it through a connector-
 * verb lexicon means every task not starting with a word in READ_VERBS/WRITE_VERBS
 * classified 'irreversible' → requiresApproval → no approval channel is wired in
 * production → verdict 'deny' → item skipped 'no-approval-channel'. The loop
 * drained its entire backlog doing zero work while reporting normal iterations.
 *
 * What made it invisible: every link looked individually correct and deliberately
 * fail-closed, and the unit tests drove the seam with stubs or with genuine
 * connector verbs ('deploy', 'delete'), never with prose. The defect only exists at
 * the junction where prose is fed to a classifier built for connectors.
 *
 * So the fail-safe is applied ONLY where it belongs — to an action that declared a
 * `tier` or a `tool`. An undeclared prose task is classified by verb LOOKUP alone:
 * an explicit irreversible verb ("Delete the staging DB", "Deploy the release",
 * "Send the summary email") still gates, and an unrecognised verb falls to
 * 'write-reversible' — not approval-requiring, but still non-read, so it remains
 * gated at the exec-token layer (tierNeedsGate) rather than being waved through.
 */
export function productionIrreversibilityFloor(action: GatedAction): ActionTier {
  // Declared tier wins outright.
  if (action.tier) return classifyActionTier(action)
  // A declared tool is a connector: registry first, then the strict fail-safe.
  if (action.tool !== undefined) return externalActionTier(action.tool) ?? classifyActionTier(action)
  // Undeclared → free-text backlog prose. Lexicon match only; no unknown⇒irreversible.
  return tierForVerb(action.verb) ?? 'write-reversible'
}

/** Injected operator round-trip. Production = the channel operator-approval
 *  round-trip (a timeout resolves 'deny'). Fail-closed by construction. */
export type ApprovalSeam = (prompt: string, loop: Loop) => Promise<'allow' | 'deny'>

/** Build the operator-facing approval prompt from the action + loop context.
 *  Pure so the wording is unit-assertable. */
function formatApprovalPrompt(action: GatedAction, loop: Loop): string {
  const what = action.tool ?? action.verb ?? 'action'
  return (
    `Loop ${loop.id} (iteration ${loop.iteration}) requests approval for an ` +
    `irreversible ${what}: ${action.summary}. Reply allow or deny.`
  )
}

/**
 * Build the approval prompt from `action.summary` and await the operator verdict
 * via the seam. FAIL-CLOSED: only an explicit 'allow' is honored; a 'deny', any
 * other resolved value, or a thrown seam all return 'deny' so the loop skips the
 * step (and journals it) rather than acting unattended (the L8 HITL gate).
 */
export async function requestApproval(
  action: GatedAction,
  loop: Loop,
  approval: ApprovalSeam
): Promise<'allow' | 'deny'> {
  const prompt = formatApprovalPrompt(action, loop)
  try {
    const verdict = await approval(prompt, loop)
    return verdict === 'allow' ? 'allow' : 'deny'
  } catch {
    return 'deny'
  }
}
