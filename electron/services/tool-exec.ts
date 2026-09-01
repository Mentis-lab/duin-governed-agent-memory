// tool-exec.ts — the shared per-call execution core: approval → preToolUse
// hook → native dispatch. Extracted so the HEADLESS agent runner and the
// interactive chat path can share ONE audited gate (same permissionsService,
// same hooks, same toolRegistry) rather than drifting apart.
//
// Headless (background loop/automation) runs pass `capabilityAllowedTools`,
// which routes approval through capability mode (permissions-store):
// fail-closed, no modal, sandbox-bypass tools permanently ineligible. The
// interactive path omits it and keeps today's policy/modal behavior.
//
// Native (registry-registered) tools only. Chat-specific special cases
// (memory_add, create_document, ask_user, chapter marks, …) stay in chat.ts —
// they are interactive by nature and have no place in an unattended run.

import { randomUUID } from 'crypto'
import { permissionsService, descriptorNeedsApproval } from './permissions-store'
import { toolRegistry } from './tool-registry'
import { mcpManager } from './mcp-manager'
import { fireHooks } from './hooks-runner'
import { capFloorForDescriptor, isMutatingDescriptorForFloor } from './governance/action-class'
import { reviewAction } from './governance/action-reviewer'
import { raceToolCallTimeout, toolWallClockBudgetMs } from './tool-timeout'
import { DEFAULT_TIMEOUT_MS as SHELL_DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS as SHELL_MAX_TIMEOUT_MS } from './shell-tool'
import { taintFloorForDescriptor, isUntrustedSource, type TaintStore } from './governance/taint-guard'
import { ruleOfTwoCheck, noteExecutedTool, ruleOfTwoProfile } from './governance/rule-of-two'
import { recordEvent } from './event-log'

export type ToolExecStatus = 'ok' | 'denied' | 'error'

export interface ToolExecResult {
  result: string
  status: ToolExecStatus
  /** Audit provenance of the approval decision ('capability', 'capability-miss',
   *  'policy:<id>', 'modal', 'none', …). */
  approvalSource: string
}

export interface ToolExecContext {
  /** Workspace root the call is scoped to. Workspace-relative native tools
   *  (apply_patch, etc.) anchor here; for a background run this is the vault. */
  workspacePath: string
  /** Ephemeral capability allow-list for a headless run. When set, approval
   *  resolves capability-mode (fail-closed); when undefined, the interactive
   *  policy/modal path is used. */
  capabilityAllowedTools?: string[]
  conversationId?: string
  correlationId?: string
  model?: string
  signal?: AbortSignal
  /** Per-conversation untrusted-content store for the injection-containment taint floor.
   *  When present, results from untrusted sources (screen/web/MCP) are recorded, and an
   *  irreversible/outward tool whose arg was lifted from that content is refused in
   *  unattended runs. Attended runs keep the human approval gate. */
  taintStore?: TaintStore
}

/** W3.1 — headless-face denial audit. Until now every floor denial on this face (CAP,
 *  taint, Rule-of-Two, capability-miss, reviewer) was invisible to the event spine —
 *  the only trace was the returned result string. Approval denials are NOT recorded
 *  here: permissionsService emits its own audit event (double-recording would skew
 *  deny counts). Best-effort — audit must never break the call. */
function auditDenied(
  ctx: ToolExecContext,
  toolName: string,
  source: string,
  reason: string
): void {
  try {
    recordEvent({
      type: 'tool.call.denied',
      actorKind: 'system',
      severity: 'warning',
      conversationId: ctx.conversationId,
      workspacePath: ctx.workspacePath,
      entityKind: 'tool',
      entityId: toolName,
      payload: { toolId: toolName, source, reason: reason.slice(0, 300), surface: 'headless' }
    })
  } catch { /* audit is upkeep; the denial itself already happened */ }
}

/** Record an untrusted-source tool result so later taint checks can see it. */
function markUntrustedResult(
  descriptor: { name: string; providerKind?: 'native' | 'mcp' | 'plugin'; providerId?: string; risks?: readonly string[] },
  result: string,
  store: TaintStore | undefined
): void {
  if (store && isUntrustedSource(descriptor)) store.markUntrusted(result)
}

/**
 * Execute one tool call through the standard gate. Never throws — every
 * failure (unknown tool, denial, hook block, handler error) returns a
 * model-facing `result` + a `status` so the caller can thread it back into the
 * agent loop as the tool result.
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolExecContext
): Promise<ToolExecResult> {
  const descriptor = toolRegistry.getById(toolName)
  if (!descriptor) {
    return { result: `Error: unknown tool '${toolName}'`, status: 'error', approvalSource: 'none' }
  }

  // 0) Capability MEMBERSHIP — enforced unconditionally, before and independent
  //    of the approval path. This was the hole: the allow-list was threaded ONLY
  //    into `requestApprovalDetailed`, which is reached only when
  //    `descriptorNeedsApproval(descriptor)` is true — i.e. `requiresApproval`
  //    or a GATING_RISK ('network'|'destructive'|'secret'|'sandboxBypass').
  //    A tool declaring `risks: ['read']` / `['write']` with
  //    `requiresApproval: false` (browser_evaluate_readonly, browser_screenshot,
  //    …) skipped the approval branch entirely, so the list was never consulted,
  //    and the 1b action-class floor cannot cover it either (reads are never
  //    floored; reversible writes are allowed). The runners only ever used the
  //    allow-list to filter the tools OFFERED to the model — nothing stopped the
  //    model from naming a tool outside it, and `getById` resolves against the
  //    FULL registry. Invisible because the code *looked* wired: the list did
  //    cross the boundary, just down a branch most tools never take.
  //    Offered set == executable set. The capability-mode approval below stays
  //    as defence in depth. `descriptor.id` is the right key: the registry's
  //    OpenAI tool names match descriptor ids, and permissions-store's capability
  //    check already compares against `toolId`.
  if (ctx.capabilityAllowedTools && !ctx.capabilityAllowedTools.includes(descriptor.id)) {
    auditDenied(ctx, toolName, 'capability-miss', 'tool not in the capability allow-list')
    return {
      result: `Action denied (capability-miss).`,
      status: 'denied',
      approvalSource: 'capability-miss'
    }
  }

  const callId = randomUUID()

  // 1) Approval. Capability mode (fail-closed) when a headless allow-list is
  //    present; otherwise the standard policy/modal path.
  const approval = descriptorNeedsApproval(descriptor)
    ? await permissionsService.requestApprovalDetailed({
        callId,
        toolId: descriptor.id,
        name: descriptor.name,
        serverId: descriptor.providerId,
        providerKind: descriptor.providerKind,
        risks: descriptor.risks,
        args,
        conversationId: ctx.conversationId,
        correlationId: ctx.correlationId,
        // R7 (Phase-4) — thread the run's abort signal so a cancel resolves an
        // AFK modal as a deny instead of deadlocking the tool loop.
        signal: ctx.signal,
        capability: ctx.capabilityAllowedTools
          ? { allowedTools: ctx.capabilityAllowedTools }
          : undefined
      })
    : { decision: 'allow' as const, source: 'none' }

  if (approval.decision === 'deny') {
    return { result: `Action denied (${approval.source}).`, status: 'denied', approvalSource: approval.source }
  }

  // 1b) Action-class FLOOR for UNATTENDED runs (the irreversibility taxonomy),
  //     keyed off the descriptor's STRUCTURED signals (mutates / requiresApproval
  //     / risks) rather than free text. A headless run has no human to approve a
  //     CAP-class act, so refuse it even if the capability list would allow it.
  //     `capFloorForDescriptor` never floors a read (a danger word in an arg no
  //     longer over-blocks), catches snake_case CAP tools like `shell_command`
  //     the old `\b` classifier missed, allows reversible writes (`apply_patch`),
  //     and FAILS SAFE — an unclassifiable mutating tool is refused.
  if (ctx.capabilityAllowedTools && approval.decision === 'allow') {
    const floored = capFloorForDescriptor(descriptor, args)
    if (floored) {
      auditDenied(ctx, toolName, `action-class:${floored.classId}`, floored.title)
      return {
        result: `Action refused: '${descriptor.name}' is a ${floored.title} (CAP-class — needs human approval) and this is an unattended run.`,
        status: 'denied',
        approvalSource: `action-class:${floored.classId}`
      }
    }
  }

  // 1c) Taint floor — injection containment (CaMeL invariant), enforced in BOTH modes.
  //     If an argument to this irreversible/outward tool was lifted from untrusted content
  //     read earlier this session, refuse it: a scraped or on-screen instruction must not
  //     drive a shell / send / delete / navigate — not unattended (belt-and-suspenders over
  //     the action-class floor), and not by rubber-stamping a modal in an attended run.
  const tainted = taintFloorForDescriptor(descriptor, args, ctx.taintStore)
  if (tainted) {
    auditDenied(ctx, toolName, 'taint-floor', tainted.reason)
    return { result: `Action refused: ${tainted.reason}`, status: 'denied', approvalSource: 'taint-floor' }
  }

  // 1d) Rule-of-Two floor (W1) — a session that has already ingested untrusted content AND
  //     touched secret-class material must not take a state-changing/external action without
  //     a human. This face is headless/fork — no human — so a completed triple is a refusal.
  //     Tighten-only over the CAP floor; legs derive from the same risks vocabulary that arms
  //     the gates above (see governance/rule-of-two.ts).
  const rot = ruleOfTwoCheck(ctx.conversationId, descriptor)
  if (rot) {
    auditDenied(ctx, toolName, 'rule-of-two', rot.reason)
    return { result: `Action refused: ${rot.reason}`, status: 'denied', approvalSource: 'rule-of-two' }
  }

  // 1e) Action-reviewer lane (W3) — capability (headless) runs only, MUTATING calls only
  //     (reads never cost a model call, same stance as the CAP floor). A separate cheap
  //     model reviews the action; with no human anywhere on this face, BOTH critical and
  //     high refuse. 'skipped' (keyless/disabled) leaves the pipeline unchanged — the
  //     deterministic floors above remain the baseline.
  if (ctx.capabilityAllowedTools && isMutatingDescriptorForFloor(descriptor)) {
    const profile = ruleOfTwoProfile(ctx.conversationId ?? '')
    const review = await reviewAction({
      toolName: descriptor.name,
      args,
      surface: 'headless',
      actorModel: ctx.model,
      context: {
        taintPresent: (ctx.taintStore?.size() ?? 0) > 0,
        untrustedIngested: profile?.untrustedIngested,
        secretTouched: profile?.secretTouched
      }
    })
    if (review.source !== 'skipped' && (review.tier === 'critical' || review.tier === 'high')) {
      auditDenied(ctx, toolName, `action-reviewer:${review.tier}`, review.reason)
      return {
        result: `Action refused: the independent action reviewer rated '${descriptor.name}' ${review.tier} (${review.reason}) and this is an unattended run.`,
        status: 'denied',
        approvalSource: `action-reviewer:${review.tier}`
      }
    }
  }

  // 2) preToolUse hook — user hooks (e.g. the seeded destructive-command
  //    guard) gate unattended runs too. A throwing/ blocking hook refuses.
  const preHook = await fireHooks('preToolUse', {
    conversationId: ctx.conversationId,
    toolName,
    args,
    cwd: ctx.workspacePath
  })
  if (preHook.blocked) {
    return {
      result: `Blocked by hook: ${preHook.blockReason ?? 'preToolUse refused'}`,
      status: 'denied',
      approvalSource: approval.source
    }
  }

  // 3) Dispatch. MCP tools go through the manager — now reachable in HEADLESS
  //    runs too (autonomous agents can use integrations), having already passed
  //    the same approval + action-class + hook gate above as native tools.
  if (descriptor.providerKind === 'mcp') {
    try {
      const out = await mcpManager.callTool(descriptor.providerId, descriptor.title ?? descriptor.name, args)
      const result = typeof out === 'string' ? out : JSON.stringify(out)
      markUntrustedResult(descriptor, result, ctx.taintStore)
      noteExecutedTool(ctx.conversationId, descriptor)
      return { result, status: 'ok', approvalSource: approval.source }
    } catch (err) {
      return {
        result: `Error: ${(err as Error)?.message ?? String(err)}`,
        status: 'error',
        approvalSource: approval.source
      }
    }
  }

  // Native dispatch via the registry.
  if (!toolRegistry.hasHandler(toolName)) {
    return {
      result: `Error: tool '${toolName}' has no native handler`,
      status: 'error',
      approvalSource: approval.source
    }
  }
  try {
    // R4 (Phase-4) — race the native handler against a per-call wall-clock
    // timeout (`DUIN_TOOL_TIMEOUT_MS`) and the run's abort signal. A timeout or
    // abort rejects here and is caught below as an 'error' row, so a hung tool
    // can't stall an unattended run. Never throws past the catch.
    const dispatched = await raceToolCallTimeout(
      () =>
        toolRegistry.executeNative(toolName, args, {
          conversationId: ctx.conversationId,
          workspacePath: ctx.workspacePath,
          model: ctx.model,
          signal: ctx.signal,
          callId,
          correlationId: ctx.correlationId
        }),
      {
        signal: ctx.signal,
        toolName,
        // shell_command advertises its own 120s/600s budget to the model; without
        // this the flat 60s backstop would clip it. Threads the tool's effective
        // timeout into the race so the backstop fires only after the tool's own.
        timeoutMs: toolWallClockBudgetMs(toolName, args, {
          defaultMs: SHELL_DEFAULT_TIMEOUT_MS,
          maxMs: SHELL_MAX_TIMEOUT_MS
        })
      }
    )
    const result = typeof dispatched === 'string' ? dispatched : dispatched.result
    const rawStatus = typeof dispatched === 'string' ? 'ok' : dispatched.status
    const status: ToolExecStatus = rawStatus === 'denied' || rawStatus === 'error' ? rawStatus : 'ok'
    if (status === 'ok') {
      markUntrustedResult(descriptor, result, ctx.taintStore)
      noteExecutedTool(ctx.conversationId, descriptor)
    }
    return { result, status, approvalSource: approval.source }
  } catch (err) {
    return {
      result: `Error: ${(err as Error)?.message ?? String(err)}`,
      status: 'error',
      approvalSource: approval.source
    }
  }
}
