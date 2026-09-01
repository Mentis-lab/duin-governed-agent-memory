// Repeat-failure detection for the /agui turn loop.
//
// THE FAILURE THIS ADDRESSES. The loop had no notion of a tool failing twice. A tool result that
// begins `Error:` was stringified into a `role:'tool'` message and fed straight back to the model,
// which — reliably, in practice — tried the same call again. The same tool with the same arguments
// could fail for all 32 rounds. Two safety nets that look like they cover this did not:
//   · the stall watchdog (DUIN_TURN_STALL_MS) was refreshed by every tool result INCLUDING
//     failures, so it could never fire on the most common wedge (fixed alongside this);
//   · the round cap (DUIN_MAX_TOOL_ROUNDS, 32) is a ceiling, not a detector — by the time it
//     trips, ~32 paid model calls have been spent on a turn that was dead after the third.
//
// So this is deliberately narrow: it counts CONSECUTIVE failures of the SAME (tool, arguments)
// fingerprint and halts the turn once that reaches `k`. A different tool, different arguments, or
// any success resets the streak — a legitimately exploratory agent that retries a *different* way
// is never penalised. Mirrors the halt-at-3 threshold used by tinyagents' no-progress ladder.
//
// PURE + unit-tested. The fingerprint uses `hashState` (sorted-key stable stringify + sha256) from
// longrun/progress-watchdog rather than a second hasher.

import { hashState } from '../longrun/progress-watchdog'

// ── the round budget ────────────────────────────────────────────────────────────────
//
// A FIXED ROUND COUNT IS THE WRONG PRIMITIVE, and this file's own header already says
// why: "the round cap is a ceiling, not a detector". It cannot tell a turn that is
// getting somewhere from one that is spinning, so it has to be set high enough for the
// first — which makes it useless against the second — and it still cuts a long, healthy
// agentic chain at an arbitrary number the operator never chose.
//
// It was raised 8 → 16 → 32 over time, each bump for the same reason: real multi-hop
// work kept hitting it. That is a number being tuned to avoid the symptom of measuring
// the wrong thing.
//
// The detectors that DO measure the right thing now exist, all landed in this same
// codebase: the consecutive-repeat ladder above, the stall watchdog (which no longer
// counts a failing tool as progress), the per-tool timeout, and the turn cost meter.
// With those in place the round count can go back to being what it should always have
// been — a backstop against the case where every one of them misses.
//
// So: rounds are GRANTED while the turn is demonstrably progressing. `lastProgressAt`
// is stamped by markProgress() on streamed tokens, reasoning tokens, and SUCCESSFUL
// tool results. If a turn reaches its soft budget having produced something recently,
// it gets another grant, up to a hard ceiling. If it reaches the budget silent, it
// stops there exactly as before.
//
// The wall-clock deadline (DUIN_TURN_DEADLINE_MS) and the cost ceiling remain the real
// bounds — this only stops an arbitrary counter from being the thing that ends useful
// work.

export interface RoundBudgetInput {
  /** Rounds consumed so far (0-based round index that is about to run). */
  round: number
  /** The budget in force right now. */
  budget: number
  /** Ceiling past which no further grants are made, however well it is going. */
  hardCap: number
  /** Epoch ms of the last markProgress(). */
  lastProgressAt: number
  now: number
  /** Progress newer than this counts as "still getting somewhere". */
  progressWindowMs: number
  /** Rounds added per grant. */
  grant: number
}

/**
 * The budget for the next round — unchanged, or extended because the turn is working.
 *
 * Only ever extends on the LAST round of the current budget, so a healthy turn is not
 * silently handed an unbounded loop the moment it starts: each grant is re-earned by
 * fresh progress at the point the previous grant runs out.
 *
 * Pure; `now` and `lastProgressAt` are injected.
 */
export function nextRoundBudget(i: RoundBudgetInput): number {
  if (i.grant <= 0 || i.budget >= i.hardCap) return i.budget
  // Not at the edge yet — nothing to decide.
  if (i.round < i.budget - 1) return i.budget
  const sinceProgress = i.now - i.lastProgressAt
  if (sinceProgress > i.progressWindowMs) return i.budget
  return Math.min(i.hardCap, i.budget + i.grant)
}

/** Rounds added each time a turn earns an extension. Env `DUIN_ROUND_GRANT` (default 8); <= 0 disables extension entirely, restoring the old fixed cap. */
export function roundGrant(): number {
  const raw = Number(process.env.DUIN_ROUND_GRANT)
  return Number.isFinite(raw) && process.env.DUIN_ROUND_GRANT ? Math.floor(raw) : 8
}

/** Absolute ceiling on granted rounds. Env `DUIN_MAX_TOOL_ROUNDS_HARD`; defaults to 8× the soft cap. */
export function roundHardCap(softCap: number): number {
  const raw = Number(process.env.DUIN_MAX_TOOL_ROUNDS_HARD)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : softCap * 8
}

/** How recent progress must be for a turn to earn another grant. Env `DUIN_ROUND_PROGRESS_WINDOW_MS` (default 120s — generous, because one legitimate tool round can be slow). */
export function roundProgressWindowMs(): number {
  const raw = Number(process.env.DUIN_ROUND_PROGRESS_WINDOW_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120_000
}

/** Consecutive-failure threshold. Env `DUIN_AGUI_REPEAT_K` (default 3); <= 0 disables the ladder. */
export function repeatFailureK(): number {
  const raw = Number(process.env.DUIN_AGUI_REPEAT_K)
  return Number.isFinite(raw) && process.env.DUIN_AGUI_REPEAT_K != null && process.env.DUIN_AGUI_REPEAT_K !== ''
    ? raw
    : 3
}

/** Stable identity of one attempted call: the tool plus its arguments. */
export function callFingerprint(name: string, args: unknown): string {
  return hashState({ name, args })
}

/** A tool result is a failure iff it is the loop's own error shape. Same discriminant the round
 *  loop uses for markProgress() and for reindex scheduling — one definition of "this went wrong". */
export function isFailureResult(result: string): boolean {
  return /^Error:/.test(result)
}

export interface RepeatState {
  /** Fingerprint of the currently-repeating failure, or null when the last call succeeded. */
  fingerprint: string | null
  /** How many times in a row that fingerprint has failed. */
  count: number
  /** Human label of the repeating tool, for the halt message. */
  toolName: string
}

export function emptyRepeatState(): RepeatState {
  return { fingerprint: null, count: 0, toolName: '' }
}

/**
 * PURE. Fold one completed call into the streak.
 *
 * A success — of ANY call — clears the streak: the turn demonstrably moved. A failure either
 * extends the streak (same fingerprint) or starts a new one (different fingerprint), so an agent
 * cycling between two different broken calls is not mistaken for one wedged call.
 */
export function noteCallOutcome(prev: RepeatState, name: string, args: unknown, result: string): RepeatState {
  if (!isFailureResult(result)) return emptyRepeatState()
  const fp = callFingerprint(name, args)
  return fp === prev.fingerprint
    ? { fingerprint: fp, count: prev.count + 1, toolName: name }
    : { fingerprint: fp, count: 1, toolName: name }
}

/** PURE. Halt once the same failing call has been made `k` times in a row. */
export function shouldHaltOnRepeat(state: RepeatState, k: number): boolean {
  return k > 0 && state.count >= k
}

/** The root cause handed to the operator on halt — what repeated, and how many times. Concrete,
 *  because "the turn stopped" without the offending call is the diagnosis problem this replaces. */
export function repeatRootCause(state: RepeatState): string {
  const tool = state.toolName || 'a tool'
  return `${tool} failed ${state.count} times in a row with identical arguments`
}
