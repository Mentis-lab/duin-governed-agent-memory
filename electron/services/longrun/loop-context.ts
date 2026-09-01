// Long-run L3 — bounded per-iteration context. Each iteration runs on a FRESH,
// bounded message stack = {plan/spec + rolling summary + current artifact
// state}, never the accumulated 24h transcript. This is what kills
// context-window blowup (and the cost/latency creep + "lost in the middle"
// failure) over thousands of turns.
//
// Everything here is PURE and deterministic — no I/O, no clock, no randomness —
// so the carried state is reproducible and unit-testable.

import { elideMiddle, keepTail } from '../elide-middle'

/** The bounded message stack handed to runTurn — never the full transcript. */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** The three durable carried-state pieces + a hard char budget. */
export interface BoundedContextInput {
  plan: string
  rollingSummary: string
  artifactState: string
  maxChars: number
}

/**
 * Default cap for the persisted rolling summary. The summary is carried forward
 * across iterations INSTEAD of transcript growth, so it must stay bounded.
 */
export const DEFAULT_ROLLING_SUMMARY_MAX_CHARS = 4000

/** Plan and artifact state: keep both ends, and say a middle was dropped. */
function truncate(s: string, budget: number): string {
  if (budget <= 0) return ''
  return elideMiddle(s, budget)
}

/**
 * The rolling summary keeps its TAIL, not its head.
 *
 * `updateRollingSummary` appends — it evicts the OLDEST lines, so the summary is ordered
 * newest-last. Head-slicing it therefore deleted the most recent iterations: an unattended loop
 * resumed from a memory of its own progress with the newest progress removed, and silently,
 * because the old truncate emitted no marker at all. The whole point of the summary is "where
 * did I get to", which lives at the end.
 */
function truncateNewestFirst(s: string, budget: number): string {
  if (budget <= 0) return ''
  return keepTail(s, budget)
}

/**
 * PURE. Compose [system:plan, system:rollingSummary, user:artifactState] so the
 * total content length is <= maxChars. Allocation priority (what is PROTECTED):
 * plan first, then rollingSummary, then artifactState — i.e. artifactState is
 * TRIMMED first, plan last. Empty pieces are dropped so the stack never carries
 * blank messages. Deterministic: same input -> same output.
 */
export function buildBoundedContext(input: BoundedContextInput): ChatMessage[] {
  const maxChars = Math.max(0, input.maxChars)

  // Greedy allocation in protection order: plan keeps as much as fits, the
  // remainder flows to the rolling summary, and artifactState gets what is left.
  let remaining = maxChars
  const plan = truncate(input.plan, remaining)
  remaining -= plan.length
  const summary = truncateNewestFirst(input.rollingSummary, remaining)
  remaining -= summary.length
  const artifact = truncate(input.artifactState, remaining)

  const messages: ChatMessage[] = []
  if (plan.length > 0) messages.push({ role: 'system', content: plan })
  if (summary.length > 0) messages.push({ role: 'system', content: summary })
  if (artifact.length > 0) messages.push({ role: 'user', content: artifact })
  return messages
}

/** What one completed iteration contributes to the rolling summary. */
export interface IterSummaryInput {
  itemTask: string
  outcome: string
  gitSha?: string | null
  advanced: boolean
}

function shortSha(sha: string | null | undefined): string {
  if (!sha) return '-'
  return sha.length > 7 ? sha.slice(0, 7) : sha
}

/**
 * PURE. Append a one-line "[sha] task -> outcome" fact to `prev` and evict the
 * OLDEST lines until the whole summary is <= maxChars. A non-advancing
 * iteration is tagged " [no-progress]" so the L4 watchdog signal survives in the
 * carried context. This persisted string is what the loop carries forward
 * instead of a growing transcript.
 */
export function updateRollingSummary(
  prev: string,
  iter: IterSummaryInput,
  maxChars: number = DEFAULT_ROLLING_SUMMARY_MAX_CHARS
): string {
  const flag = iter.advanced ? '' : ' [no-progress]'
  const line = `[${shortSha(iter.gitSha)}] ${iter.itemTask} -> ${iter.outcome}${flag}`

  const cap = Math.max(0, maxChars)
  // Existing lines (dropping blanks) followed by the new fact, newest last.
  const lines = prev ? prev.split('\n').filter((l) => l.length > 0) : []
  lines.push(line)

  // Evict oldest lines until within budget.
  while (lines.length > 1 && lines.join('\n').length > cap) {
    lines.shift()
  }

  let result = lines.join('\n')
  // A single line longer than the whole budget is hard-truncated (still bounded).
  if (result.length > cap) result = result.slice(0, cap)
  return result
}
