// rule-of-two.ts — Meta's "Agents Rule of Two" as a structural session invariant (W1,
// PLANNING/DUIN_FIELD_DEBTS_BUILD_PLAN.md).
//
// The rule: an agent session may combine at most TWO of
//   [A] processed untrusted input   [B] touched secret-class material
//   [C] state-changing / external-comms actions
// — all three together requires a human gate. Assume injection SUCCEEDS and bound the
// blast radius; this floor does not detect attacks, it makes the tripled session shape
// structurally require a person.
//
// Owner discipline (one concept, one owner): each leg is DERIVED from the module that
// already owns its meaning — [A] from taint-guard's `isUntrustedSource` (the same
// predicate that decides what gets marked untrusted), [B]/[C] from the descriptor
// `risks` vocabulary that already arms the approval gate, the CAP floor and the taint
// floor. This module adds NO new classification lists.
//
// Composition discipline (same shape as the ANS-rung meet and cumulative-consequence in
// agui-gate.ts): tighten-only. A completed triple can only escalate allow→prompt/deny;
// nothing here ever loosens a verdict another gate produced.
//
// Leg semantics, deliberately asymmetric:
//   • [A] counts from HISTORY only. An incoming action's own result is not yet ingested
//     at check time, and a session with no untrusted input has no injected instruction to
//     contain — gating a deliberate outbound call in a clean session would over-block.
//   • [B] counts from history OR this action (a tool that reads a credential and sends it
//     completes the triple in one call).
//   • [C] is the gated leg: only actions CONTRIBUTING state-change/external-comms are ever
//     blocked. Reads are never gated (CAP principle — the blast radius lives in the next
//     consequential action, which is exactly the one this floor will see).
//
// Keyed by conversationId — the continuity id shared by the chat IPC face, the shared
// headless core (tool-exec) and the :8799 /agui face, so legs accrued on one face gate
// the others. In-memory per-process (like the taint store): a restart clears profiles,
// which is the safe direction (legs re-accrue from actual behavior).

import { isUntrustedSource } from './taint-guard'

export interface RoTDescriptor {
  name: string
  providerKind?: 'native' | 'mcp' | 'plugin'
  providerId?: string
  risks?: readonly string[]
}

export interface RoTProfile {
  untrustedIngested: boolean
  secretTouched: boolean
  stateChanged: boolean
}

/** The consequential leg: external comms / irreversible / containment-escape risks.
 *  Deliberately excludes 'secret' (that is leg B) and 'write' (reversible local edits
 *  are routine work — same stance as the CAP floor's reversible-write allow). */
const STATE_CHANGE_RISKS = new Set<string>(['network', 'destructive', 'sandboxBypass'])

const profiles = new Map<string, RoTProfile>()
/** LRU bound, same as taint-guard's conversation stores. */
const MAX_PROFILES = 64

/** Flag: DUIN_RULE_OF_TWO — default ON; '0' disables (read per call so tests/ops can flip). */
export function ruleOfTwoEnabled(): boolean {
  return process.env.DUIN_RULE_OF_TWO !== '0'
}

function profileFor(conversationId: string): RoTProfile {
  let p = profiles.get(conversationId)
  if (!p) {
    p = { untrustedIngested: false, secretTouched: false, stateChanged: false }
    profiles.set(conversationId, p)
    while (profiles.size > MAX_PROFILES) {
      const oldest = profiles.keys().next().value
      if (oldest === undefined) break
      profiles.delete(oldest)
    }
  }
  return p
}

/** Which legs does executing this descriptor contribute? PURE. */
export function legsOf(d: RoTDescriptor): { untrusted: boolean; secret: boolean; stateChange: boolean } {
  const risks = d.risks ?? []
  return {
    untrusted: isUntrustedSource(d),
    secret: risks.includes('secret'),
    stateChange: risks.some((r) => STATE_CHANGE_RISKS.has(r))
  }
}

/** Record an EXECUTED (gate-allowed, dispatched) tool against the session profile.
 *  Called post-allow on every face; over-marking on a later handler error is accepted —
 *  it only ever makes the floor MORE likely to ask a human (the safe direction). */
export function noteExecutedTool(conversationId: string | undefined, d: RoTDescriptor): void {
  if (!conversationId || !ruleOfTwoEnabled()) return
  const legs = legsOf(d)
  if (!legs.untrusted && !legs.secret && !legs.stateChange) return
  const p = profileFor(conversationId)
  if (legs.untrusted) p.untrustedIngested = true
  if (legs.secret) p.secretTouched = true
  if (legs.stateChange) p.stateChanged = true
}

export interface RoTBlock {
  blocked: true
  /** Model/operator-facing explanation naming the completed triple. */
  reason: string
  /** Which legs came from session history vs the incoming action (audit payload). */
  legs: { fromHistory: string[]; fromThisAction: string[] }
}

/**
 * The floor. Returns null to allow; a {@link RoTBlock} when executing `d` would complete
 * the triple — the caller must escalate to a human (interactive: re-ask even past an
 * always-allow policy; unattended: deny). Only C-contributing actions are ever blocked.
 */
export function ruleOfTwoCheck(conversationId: string | undefined, d: RoTDescriptor): RoTBlock | null {
  if (!conversationId || !ruleOfTwoEnabled()) return null
  const legs = legsOf(d)
  if (!legs.stateChange) return null
  const p = profiles.get(conversationId)
  const untrusted = p?.untrustedIngested ?? false // history only — see header
  const secret = (p?.secretTouched ?? false) || legs.secret
  if (!(untrusted && secret)) return null
  const fromHistory: string[] = ['untrusted-input']
  const fromThisAction: string[] = ['state-change']
  if (p?.secretTouched) fromHistory.push('secret-access')
  else fromThisAction.push('secret-access')
  return {
    blocked: true,
    reason:
      `this session has already processed untrusted content${p?.secretTouched ? ' and touched secret-class material' : ''}, ` +
      `and '${d.name}' is a state-changing/external action${legs.secret && !p?.secretTouched ? ' that also touches secret-class material' : ''} — ` +
      `all three Rule-of-Two legs together require a human decision (set DUIN_RULE_OF_TWO=0 to disable this floor).`,
    legs: { fromHistory, fromThisAction }
  }
}

/** Session teardown hook (parity with clearConversationTaintStore). */
export function clearRuleOfTwoProfile(conversationId: string): void {
  profiles.delete(conversationId)
}

/** Read-only view for audit/telemetry surfaces. */
export function ruleOfTwoProfile(conversationId: string): RoTProfile | null {
  const p = profiles.get(conversationId)
  return p ? { ...p } : null
}

export const __testing = { profiles, STATE_CHANGE_RISKS, MAX_PROFILES }
