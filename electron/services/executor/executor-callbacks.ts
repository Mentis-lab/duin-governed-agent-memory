// executor-callbacks — the parent's side of the in-child gate.
//
// The delegated child (duin-gate plugin) POSTs every tool call to /exec/hook with the run's
// own bearer. This module registers live runs, authenticates the caller against the per-run
// principal, and turns the PURE verdict from executor-gate.ts into an answer by adding the
// impure parts DUIN already has: operator preToolUse hooks, the approval modal for `ask`, and
// the audit spine. Fail-closed at every step — an error is a deny, and the child is told.

import { randomUUID } from 'crypto'
import type { ServerResponse } from 'http'
import { decideChildToolCall, type ChildToolVerdict } from './executor-gate'
import { fireHooks } from '../hooks-runner'
import { permissionsService } from '../permissions-store'
import { recordEvent } from '../event-log'
import { messageOf } from '../guarded'
import type { ExecutivePrincipal } from '../executive-api/principal-store'
import type { AllowedTools } from '../subagent-types'
import type { ToolRisk } from '../tool-registry'

export const EXEC_HOOK_PATH = '/exec/hook'

export interface ExecutorRunRegistration {
  /** The principal minted for this run; the bearer must resolve to it. */
  principalId: string
  worktreePath: string
  allowedTools: AllowedTools
  conversationId?: string
  label: string
  /** Observed decisions, for the run's own tally. */
  onDecision?: (d: { toolName: string; decision: 'allow' | 'deny'; classId: string; source: string }) => void
}

const runs = new Map<string, ExecutorRunRegistration>()

export function registerExecutorRun(runId: string, reg: ExecutorRunRegistration): void {
  runs.set(runId, reg)
}

export function unregisterExecutorRun(runId: string): void {
  runs.delete(runId)
}

export function liveExecutorRunIds(): string[] {
  return [...runs.keys()]
}

export interface ChildDecision {
  decision: 'allow' | 'deny'
  reason?: string
  source: string
  classId: string
}

function parseInput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return { raw }
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v }
}

/**
 * Decide one child tool call: pure verdict → operator hooks → approval for `ask` → audit.
 * Exported for tests and for any other transport that wants the same answer.
 */
export async function decideForChild(
  runId: string,
  reg: ExecutorRunRegistration,
  call: { toolName: string; toolInput: unknown; cwd: string; callId?: string | null }
): Promise<ChildDecision> {
  const input = parseInput(call.toolInput)
  const verdict: ChildToolVerdict = decideChildToolCall(
    { toolName: call.toolName, toolInput: input, cwd: call.cwd || reg.worktreePath },
    { worktreePath: reg.worktreePath, allowedTools: reg.allowedTools }
  )
  const args = asRecord(input)
  const toolLabel = `dsh:${call.toolName}`

  let out: ChildDecision
  if (verdict.kind === 'deny') {
    out = { decision: 'deny', reason: verdict.reason, source: 'gate', classId: verdict.classId }
  } else {
    // The operator's own preToolUse hooks see the child's calls too — same event, tagged.
    let hookBlock: string | null = null
    try {
      const fired = await fireHooks('preToolUse', {
        conversationId: reg.conversationId,
        toolName: toolLabel,
        args,
        cwd: reg.worktreePath,
        trigger: 'executor',
        sourceId: runId,
        label: reg.label
      })
      if (fired.blocked) hookBlock = fired.blockReason ?? 'blocked by a preToolUse hook'
    } catch (err) {
      hookBlock = `hook error: ${messageOf(err)}`
    }
    if (hookBlock) {
      out = { decision: 'deny', reason: hookBlock, source: 'hook', classId: verdict.classId }
    } else if (verdict.kind === 'allow') {
      out = { decision: 'allow', source: 'gate', classId: verdict.classId }
    } else {
      // `ask` → the same approval service the parent turn uses (persisted policy → modal →
      // fail-closed). The operator sees "dsh:bash" and the command, decides once.
      try {
        const outcome = await permissionsService.requestApprovalDetailed({
          callId: randomUUID(),
          toolId: `delegate:${call.toolName}`,
          name: toolLabel,
          serverId: 'executor',
          providerKind: 'native',
          risks: verdict.risks as ToolRisk[],
          args,
          conversationId: reg.conversationId,
          correlationId: runId
        })
        out =
          outcome.decision === 'allow'
            ? { decision: 'allow', source: outcome.source, classId: verdict.classId }
            : { decision: 'deny', reason: `'${call.toolName}' was not approved (${outcome.source}): ${verdict.title}`, source: outcome.source, classId: verdict.classId }
      } catch (err) {
        out = { decision: 'deny', reason: `approval unavailable (${messageOf(err)})`, source: 'approval-error', classId: verdict.classId }
      }
    }
  }

  try {
    recordEvent({
      type: out.decision === 'allow' ? 'tool.call.approved' : 'tool.call.denied',
      actorKind: 'agent',
      severity: out.decision === 'allow' ? 'info' : 'warning',
      conversationId: reg.conversationId,
      workspacePath: reg.worktreePath,
      correlationId: runId,
      entityKind: 'tool',
      entityId: toolLabel,
      payload: { runId, executor: 'dsh', toolId: call.toolName, classId: out.classId, source: out.source, surface: 'executor', reason: out.reason ?? null }
    })
  } catch (err) {
    console.debug('[executor-callbacks] audit is best-effort; the decision itself is the load-bearing side effect:', messageOf(err))
  }
  try {
    reg.onDecision?.({ toolName: call.toolName, decision: out.decision, classId: out.classId, source: out.source })
  } catch {
    /* observer errors never change a verdict */
  }
  return out
}

function reply(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/**
 * POST /exec/hook. `principal` is whatever the bearer resolved to (null = none); `body` is the
 * parsed JSON. The caller has already enforced the loopback host/origin fence.
 */
export async function handleExecutorHook(res: ServerResponse, principal: ExecutivePrincipal | null, body: unknown): Promise<void> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const runId = typeof b.runId === 'string' ? b.runId : ''
  const toolName = typeof b.toolName === 'string' ? b.toolName : ''
  if (!principal) {
    reply(res, 401, { decision: 'deny', reason: 'no valid bearer for this run' })
    return
  }
  if (!runId || !toolName) {
    reply(res, 400, { decision: 'deny', reason: 'runId and toolName are required' })
    return
  }
  const reg = runs.get(runId)
  if (!reg) {
    reply(res, 404, { decision: 'deny', reason: 'no live delegated run with that id' })
    return
  }
  if (reg.principalId !== principal.id) {
    reply(res, 403, { decision: 'deny', reason: 'bearer does not belong to this run' })
    return
  }
  try {
    const out = await decideForChild(runId, reg, {
      toolName,
      toolInput: b.toolInput,
      cwd: typeof b.cwd === 'string' ? b.cwd : reg.worktreePath,
      callId: typeof b.callId === 'string' ? b.callId : null
    })
    reply(res, 200, out.decision === 'allow' ? { decision: 'allow' } : { decision: 'deny', reason: out.reason ?? 'denied by DUIN' })
  } catch (err) {
    reply(res, 200, { decision: 'deny', reason: `DUIN gate error: ${messageOf(err)}` })
  }
}

export const __executorCallbacksTest = { runs }
