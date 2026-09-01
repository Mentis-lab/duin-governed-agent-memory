// External executor — shared types.
//
// DUIN delegates a bounded task to another agent harness running as a CHILD PROCESS: the
// child does the typing, DUIN keeps the goal, the judgment, the approval and the record.
// Design: PLANNING/DUIN_EXTERNAL_EXECUTOR_PLAN.md. One kind today (dsh); a second member is
// added only on a measured need (plan §11), never for symmetry.

/** A union of one, on purpose. */
export type ExecutorKind = 'dsh'

export const EXECUTOR_KINDS: readonly ExecutorKind[] = ['dsh']

export function isExecutorKind(v: unknown): v is ExecutorKind {
  return typeof v === 'string' && (EXECUTOR_KINDS as readonly string[]).includes(v)
}

/** Hard limits a run may not exceed. Every one produces status `aborted` with its reason. */
export interface ExecutorCeilings {
  /** Wall clock for the whole run, ms. */
  wallclockMs: number
  /** Model steps (one model call + its tool calls). */
  maxSteps: number
  /** No event from the child for this long → stalled. */
  stallMs: number
  /** USD; null = meter only. */
  budgetUsd: number | null
  /** Output-token cap handed to the child (`initialize.maxTokens` for dsh). */
  maxTokens: number
}

export const DEFAULT_EXECUTOR_CEILINGS: ExecutorCeilings = {
  wallclockMs: 10 * 60_000,
  maxSteps: 40,
  stallMs: 3 * 60_000,
  budgetUsd: null,
  maxTokens: 16_384
}

/** Disjoint token buckets, the same accounting shape as providers/usage-accounting.ts. */
export interface ExecutorUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Model steps observed. */
  steps: number
}

export function emptyExecutorUsage(): ExecutorUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, steps: 0 }
}

/** The child's session, normalised. The adapter maps the harness's own vocabulary onto this. */
export type ExecutorEvent =
  | { type: 'session.init'; serverName: string; serverVersion: string }
  | { type: 'status'; sessionId: string; status: 'idle' | 'running' }
  | { type: 'assistant.text'; sessionId: string; step: number; text: string }
  | { type: 'usage'; sessionId: string; step: number; usage: Partial<ExecutorUsage> }
  | { type: 'tool.call'; sessionId: string; callId: string; name: string; args: string }
  | { type: 'tool.result'; sessionId: string; callId: string; ok: boolean; text: string }
  | { type: 'turn.end'; sessionId: string; reason: string }
  | { type: 'child.stderr'; line: string }
  | { type: 'child.exit'; code: number | null; signal: string | null }
  | { type: 'other'; sessionId: string; eventType: string }

export type ExecutorRunStatus = 'done' | 'error' | 'aborted'

export interface ExecutorRunResult {
  status: ExecutorRunStatus
  /** Why the run ended when not `done` (ceiling name, abort reason, error). */
  reason?: string
  /** The child's final assistant text (last step), or '' when none. */
  outputText: string
  usage: ExecutorUsage
  /** dsh session id — the child's durable session, resumable by a later prompt. */
  sessionId: string
  /** Every tool the child asked for, with DUIN's verdict, in order. */
  toolCalls: number
  deniedToolCalls: number
  elapsedMs: number
}
