// cumulative-consequence.ts — govern.cumulative: a SESSION-scoped consequence accumulator.
//
// DUIN's action gate classifies + gates each action by its PER-CALL consequence tier. But a
// sequence of individually-permissible actions can be cumulatively consequential — the
// death-by-a-thousand-cuts case a per-call tier gate is blind to (100 "reversible" writes, a
// steady drip of external sends, a runaway autonomous loop). This module scores the RUNNING
// consequence a conversation has authorized and reports when it crosses a ceiling, so the gate
// can ESCALATE to review (tighten allow→prompt) even though this one action's tier is low.
//
// Design constraints (mirrors the ANS-rung composer at the same choke-point):
//   - TIGHTEN-ONLY at the gate: crossing the ceiling can only turn an allow into a prompt, never
//     loosen anything → additive + safe by construction. A prompt fail-closes in AFK (the safe
//     direction) and shows a modal interactively.
//   - REVERSIBILITY-WEIGHTED: a reversible write is cheap (it's undoable — low cumulative DAMAGE);
//     external effects and irreversible actions dominate the budget. Reads never accrue.
//   - SESSION-scoped by conversationId, in-memory (a conversation runs in one process); a new
//     conversation starts with a fresh budget. PURE + electron-free → unit-testable headless.

/** Consequence weight of a gate tier. Reversible writes are cheap (undoable); external + irreversible
 *  effects carry the real cumulative risk. Unknown tiers → 1 (conservative non-zero).
 *
 *  Covers TWO vocabularies, because two callers speak different tier dialects and both must weigh
 *  correctly:
 *    - ActionTier (action-tier.ts): 'read' | 'write-reversible' | 'irreversible' — plus the
 *      derived 'external-write' / 'external-irreversible' the gate composes for ACT effectors.
 *    - AguiTier (agui-approval.ts): 'host-exec' | 'irreversible-file' | 'irreversible-send' |
 *      'spawn-recursive' | 'mcp-external' | 'external-write' | 'external-irreversible' | 'none'.
 *
 *  The SOLE production caller (agui-gate.ts) passes `verdict.tier`, which is an AguiTier — so the
 *  native irreversible tiers (host-exec/irreversible-file/irreversible-send/spawn-recursive) and
 *  mcp-external MUST be enumerated here. Before this, they matched no case and fell to the default
 *  weight of 1, silently under-counting exactly the actions the accumulator exists to catch (an
 *  irreversible send scored 1, so ~20 were needed to trip a ceiling designed for ~3). The bug was
 *  invisible because the switch LOOKED complete against ActionTier — the mismatch was that the gate
 *  never speaks ActionTier at this seam. */
export function tierWeight(tier: string): number {
  switch (tier) {
    case 'read':
    case 'none':
      return 0
    case 'write-reversible':
      return 1
    // External-but-reversible effects (ActionTier-derived write, plus any mounted MCP tool: an
    // arbitrary but not inherently unrecallable external effect).
    case 'external-write':
    case 'mcp-external':
      return 3
    // Irreversible / unrecallable effects — native (AguiTier) and ACT-derived alike. host-exec runs
    // arbitrary host commands; spawn-recursive can fan out autonomous work; capability-write mints
    // persistent new behavior (a live-loaded SKILL.md); the rest send/delete/overwrite. All carry
    // the real cumulative risk.
    case 'irreversible':
    case 'external-irreversible':
    case 'host-exec':
    case 'irreversible-file':
    case 'irreversible-send':
    case 'spawn-recursive':
    case 'capability-write':
      return 6
    default:
      return 1
  }
}

/** Recommended ceiling for an operator turning the gate on: ~20 weighted units is generous headroom
 *  for a normal session (20 reversible writes / ~6 external sends / a couple irreversible) while still
 *  tripping a runaway. A documented suggestion, NOT the default — see consequenceCeiling(). */
export const RECOMMENDED_CONSEQUENCE_CEILING = 20

/** The effective ceiling from the env. OPT-IN: unset/empty/0/garbage → 0 (DISABLED → the gate is
 *  byte-identical, so shipping this can't surprise an AFK session); a positive DUIN_CONSEQUENCE_CEILING
 *  enables it at that value. Default-off matches the DUIN_FUSE_STALENESS / channel-approval precedent —
 *  cumulative escalation changes real gate behavior (a crossed ceiling can fail-close an AFK action), so
 *  the operator opts in and tunes it. Kept here so the gate and tests agree. */
export function consequenceCeiling(): number {
  const raw = process.env.DUIN_CONSEQUENCE_CEILING
  if (raw === undefined || raw === '') return 0
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// Per-conversation running totals. Bounded by MAX_TRACKED (evict the oldest key) so a long-lived
// app that opens many conversations can't leak unboundedly — the accumulator is a safety signal,
// not durable state, so dropping the oldest session's total is harmless.
const totals = new Map<string, number>()
const MAX_TRACKED = 512

/** The consequence a conversation has accrued so far (0 if untracked). PURE. */
export function sessionConsequence(conversationId: string): number {
  return totals.get(conversationId) ?? 0
}

/** Should authorizing `weight` more consequence ESCALATE this action — i.e. would it bring the
 *  conversation's running total AT OR OVER the ceiling? Fires on the crossing action AND every
 *  consequential action after it: once a session's autonomous consequence budget is spent it stays
 *  spent (until a fresh conversation), so a FLOOD is escalated throughout — not beeped once and then
 *  waved through (which would defeat the point). A ceiling of 0 disables. PURE — does not mutate. */
export function overConsequenceCeiling(conversationId: string, weight: number, ceiling: number = consequenceCeiling()): boolean {
  if (ceiling <= 0) return false
  return sessionConsequence(conversationId) + weight >= ceiling
}

/** Accrue an action's consequence into the conversation's running total; returns the new total.
 *  No-op for zero weight (a read never moves the budget). */
export function accrueConsequence(conversationId: string, weight: number): number {
  if (weight <= 0) return sessionConsequence(conversationId)
  const next = sessionConsequence(conversationId) + weight
  if (!totals.has(conversationId) && totals.size >= MAX_TRACKED) {
    // Evict the oldest tracked conversation (Map preserves insertion order).
    const oldest = totals.keys().next().value
    if (oldest !== undefined) totals.delete(oldest)
  }
  totals.set(conversationId, next)
  return next
}

/** Reset a conversation's budget (e.g. the operator ratifies "continue" or a new session begins).
 *  This is the LOOP-CLOSING hook (Govern P2): without a reset the accumulator is a one-way ratchet
 *  that escalates forever once the ceiling is crossed. The gate calls this when an operator explicitly
 *  approves continuation. It zeroes ONLY the cumulative accumulator — it does not and cannot touch the
 *  per-action tier verdict (that floor is decided upstream by decideAguiGate). */
export function resetConsequence(conversationId: string): void {
  totals.delete(conversationId)
}

/** PURE escalation decision for the gate composer. Given the current per-action verdict + this action's
 *  tier, does the cumulative accumulator ESCALATE (tighten allow→ask)? TIGHTEN-ONLY by construction:
 *  returns true ONLY for an `allow` whose weight>0 crosses the ceiling — never for a `prompt`/`deny`
 *  (already tightened) and never for a read (weight 0). So it can only turn an allow into an ask; it can
 *  never loosen the per-action tier floor. Does NOT mutate the accumulator — the caller accrues. */
export function shouldEscalateCumulative(
  verdictKind: 'allow' | 'prompt' | 'deny',
  tier: string,
  conversationId: string,
  ceiling: number = consequenceCeiling()
): boolean {
  if (verdictKind !== 'allow') return false
  const weight = tierWeight(tier)
  if (weight <= 0) return false
  return overConsequenceCeiling(conversationId, weight, ceiling)
}

/** Test-only: clear all tracked totals. */
export function __resetAllConsequence(): void {
  totals.clear()
}
