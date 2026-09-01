import { BrowserWindow } from 'electron'
import type { LampreyToolDescriptor, ToolRisk } from './tool-registry'
import type { SandboxTier } from './sandbox'
import {
  clearPoliciesForConversation,
  deletePolicy,
  listPolicies,
  resolveDecision as resolvePersistedDecision,
  upsertPolicy,
  type PolicyDecision
} from './permission-policies-store'
import {
  recordEvent,
  type EventActorKind,
  type EventType
} from './event-log'
import { getActiveWorkspace } from './workspace-state'

// Permission and approval service. Driven by descriptor risk metadata; works
// for any tool the registry flags as requiresApproval (and additionally any
// tool with one of the GATING_RISKS below).
//
// Decision sources, in resolution order:
//   1. Persisted policies (permission-policies-store) — conversation/workspace
//      /global scope at tool or risk subject, deny precedence within a level.
//   2. The user, via the approval modal — answer can persist as a policy when
//      the user picks "This conversation" / "This workspace" / "Always".
//
// "Just this once" answers do not persist; they answer the single call.

export type ApprovalScope = 'once' | 'conversation' | 'workspace' | 'always'
export type ApprovalDecision = PolicyDecision

export interface ToolApprovalRequest {
  callId: string
  toolId: string
  name: string
  serverId: string
  providerKind: 'native' | 'mcp' | 'plugin'
  risks: ToolRisk[]
  args: Record<string, unknown>
  conversationId?: string
  /**
   * Chat-turn correlation id from `chat:send`. Threaded into the approval
   * event so a single run can be reconstructed across approval / model /
   * tool / agent rows.
   */
  correlationId?: string
  /**
   * Predicted sandbox tier for the call's execution context. Populated
   * for shell tools so the approval modal can render a tier badge (amber
   * for `'none'` on Windows, green for kernel-level wrappers).
   */
  sandboxTier?: SandboxTier
  /**
   * S7 — the caller has opted into sandbox bypass for this single call.
   * When true, {@link PermissionsService.requestApprovalDetailed} skips
   * persisted "always allow" policies entirely and re-prompts the user.
   * Approval events are tagged so audit logs can isolate bypasses.
   */
  dangerous?: boolean
  /**
   * Headless capability mode (background runs — loops/automations/subagents).
   * When present, NO human is available to answer a modal, so approval is
   * resolved from this run's EPHEMERAL allow-list ONLY, and FAIL-CLOSED:
   *   - sandbox-bypass tools are never eligible unattended  → deny
   *   - toolId in `allowedTools`                            → allow
   *   - anything else                                       → deny
   * Never opens a modal, never consults persisted policies, never persists.
   */
  capability?: {
    /** The exact tool ids this background run is permitted to call. */
    allowedTools: string[]
  }
  /**
   * R7 (Phase-4) — the turn's abort signal. When present and the approval
   * blocks on the modal, an abort (chat:cancel, deadline, app shutdown)
   * resolves the pending request as a one-time deny instead of deadlocking the
   * tool loop while the user is AFK. NEVER forwarded to the renderer (an
   * AbortSignal is not structured-cloneable — it is stripped before send).
   */
  signal?: AbortSignal
}

export interface ToolApprovalResponse {
  callId: string
  decision: ApprovalDecision
  scope: ApprovalScope
}

/**
 * Outcome of resolving a tool-call approval. `source` tells the audit layer
 * how the decision was reached — `'policy:<id>'` references a persisted policy
 * row, `'modal'` is a user answer through the approval dialog, and
 * `'no-window'` is the headless / shutdown fallback when no BrowserWindow
 * exists to receive the request. There is intentionally no timeout source:
 * an approval request stays pending until the user definitively answers
 * (or the chat round explicitly calls cancelPending).
 */
export interface ApprovalOutcome {
  decision: ApprovalDecision
  source: string
  /**
   * The DURATION the user picked in the modal ('once' | 'conversation' |
   * 'workspace' | 'always'), when — and only when — a human actually
   * answered. Undefined for every non-modal resolution (persisted policy,
   * capability allow-list, no-window/aborted deny), because in those cases
   * no human expressed a duration and callers must not invent one.
   *
   * This exists because `decision` alone is lossy: 'allow' does not say
   * whether the user consented to a STICKY grant. A caller that widens an
   * approval into persisted policy (see `executeRequestPermissions` in
   * native-aux-tools.ts) MUST consult this, or it silently upgrades a
   * "Just this once" answer into a durable one.
   */
  scope?: ApprovalScope
}

// Risks that, even without descriptor.requiresApproval, cause chat.ts to route
// through this service. Pure 'read' and 'write' alone do NOT gate (memory_add,
// update_plan are local writes); 'network', 'destructive', 'secret', and
// 'sandboxBypass' do. Sandbox-bypass calls additionally skip any persisted
// "always allow" policy — see `requestApprovalDetailed`.
export const GATING_RISKS: ReadonlySet<ToolRisk> = new Set([
  'network',
  'destructive',
  'secret',
  'sandboxBypass'
])

/** True when the per-call risks include `'sandboxBypass'`. Bypasses any
 *  persisted policy and re-prompts every call. */
export function risksCarrySandboxBypass(risks: ToolRisk[]): boolean {
  return risks.includes('sandboxBypass')
}

/** True if a descriptor with these risks should pass through requestApproval. */
export function shouldGateOnRisks(risks: ToolRisk[]): boolean {
  return risks.some((r) => GATING_RISKS.has(r))
}

/**
 * Authoritative dispatch-time predicate: should this tool call be routed
 * through the approval service? A tool gates when it declares
 * `requiresApproval` or carries a gating risk — UNLESS it self-approves
 * (its handler is the gate; see `LampreyToolDescriptor.selfApproves`).
 * Centralized here so the rule has one definition shared by chat.ts and tests.
 */
export function descriptorNeedsApproval(
  descriptor:
    | Pick<LampreyToolDescriptor, 'requiresApproval' | 'risks' | 'selfApproves'>
    | undefined
): boolean {
  if (!descriptor) return false
  if (descriptor.selfApproves) return false
  return descriptor.requiresApproval || shouldGateOnRisks(descriptor.risks)
}

interface PendingApproval {
  resolve: (response: ToolApprovalResponse) => void
  /** Conversation the approval belongs to, so a per-conversation cancel
   *  (chat:cancel) can target exactly its in-flight approvals. */
  conversationId?: string
  /** Detach any abort listener registered for this pending entry. */
  cleanup: () => void
}

class PermissionsService {
  private pending = new Map<string, PendingApproval>()

  /**
   * Resolve approval for a tool call. Consults persisted policies first; if
   * none match, dispatches a request to the UI and persists the answer
   * according to the user's chosen scope. The request stays pending
   * indefinitely until the user answers — there is no timeout. A run that
   * needs to abandon a pending approval (chat round cancelled, app
   * shutdown) calls {@link cancelPending} explicitly.
   *
   * Returns the decision only. Use {@link requestApprovalDetailed} when the
   * caller wants the audit `source` string alongside the decision.
   */
  async requestApproval(req: ToolApprovalRequest): Promise<ApprovalDecision> {
    const outcome = await this.requestApprovalDetailed(req)
    return outcome.decision
  }

  async requestApprovalDetailed(req: ToolApprovalRequest): Promise<ApprovalOutcome> {
    const workspacePath = (() => {
      try {
        return getActiveWorkspace()
      } catch {
        return undefined
      }
    })()

    // Headless capability mode: resolve from the run's ephemeral allow-list
    // ONLY, fail-closed. No human is present, so we never reach the modal and
    // never consult/persist policies. Sandbox-bypass tools are permanently
    // ineligible unattended; anything not explicitly granted is denied.
    if (req.capability) {
      const bypass = req.dangerous === true || risksCarrySandboxBypass(req.risks)
      const granted = !bypass && req.capability.allowedTools.includes(req.toolId)
      const outcome: ApprovalOutcome = granted
        ? { decision: 'allow', source: 'capability' }
        : { decision: 'deny', source: bypass ? 'capability-bypass-denied' : 'capability-miss' }
      // Headless: no human is present, so this is a system decision.
      emitApprovalEvent(req, outcome, workspacePath, 'system')
      return outcome
    }

    // S7 / S12 — when `dangerous: true` OR the per-call risks include
    // `'sandboxBypass'`, skip any persisted "always allow" / "this
    // workspace" / "this conversation" policy and force the modal every
    // time. The bypass is one-shot by design: a user who said "always
    // allow shell_command" did not consent to sandbox bypass.
    const isBypass = req.dangerous === true || risksCarrySandboxBypass(req.risks)
    if (!isBypass) {
      const persisted = resolvePersistedDecision({
        toolId: req.toolId,
        risks: req.risks,
        conversationId: req.conversationId,
        workspacePath
      })
      if (persisted) {
        const outcome: ApprovalOutcome = {
          decision: persisted.decision,
          source: `policy:${persisted.policyId}`
        }
        // A persisted policy decided WITHOUT a human this call → system.
        emitApprovalEvent(req, outcome, workspacePath, 'system', persisted.policyId)
        return outcome
      }
    }

    const userOutcome = await this.askUser(req, workspacePath)
    // A human answered iff askUser produced a modal answer — either the
    // transient 'modal' source or a 'policy:<id>' when the answer was made
    // sticky ("Always allow" / "This workspace" / "This conversation"). A
    // 'no-window' / 'aborted' resolution is NOT a human decision. This is
    // read off the UN-wrapped source, BEFORE the '+sandbox-bypass' suffix is
    // appended below, so it never has to pattern-match a compound string.
    // (At this point a 'policy:' source can only be the persist branch: the
    // no-human persisted-policy match returned earlier and never reaches here.)
    const humanDecided =
      userOutcome.source === 'modal' || userOutcome.source.startsWith('policy:')
    // Tag bypass outcomes distinctly so the audit log can filter them.
    const finalOutcome: ApprovalOutcome = isBypass
      ? { ...userOutcome, source: `${userOutcome.source}+sandbox-bypass` }
      : userOutcome
    emitApprovalEvent(req, finalOutcome, workspacePath, humanDecided ? 'user' : 'system')
    return finalOutcome
  }

  /**
   * Set a sticky policy for a single risk category. Used by
   * request_permissions after the user grants a scope. Writes through to the
   * persisted policies table so the grant survives a restart.
   *
   * Passing `null` removes the existing policy for that risk at the given
   * scope.
   */
  setRiskPolicy(
    risk: ToolRisk,
    scope: 'conversation' | 'always',
    decision: ApprovalDecision | null,
    conversationId?: string
  ): void {
    const policyScope = scope === 'always' ? 'global' : 'conversation'
    if (decision === null) {
      const matches = listPolicies().filter(
        (p) =>
          p.scope === policyScope &&
          p.subjectKind === 'risk' &&
          p.subject === risk &&
          (policyScope === 'global' ? true : p.conversationId === conversationId)
      )
      for (const m of matches) deletePolicy(m.id)
      return
    }
    if (policyScope === 'conversation' && !conversationId) return
    upsertPolicy({
      scope: policyScope,
      subjectKind: 'risk',
      subject: risk,
      decision,
      conversationId: policyScope === 'conversation' ? conversationId : undefined
    })
  }

  /**
   * Read-back for a single risk's current decision. Returns the matched policy
   * folded into the legacy "scope" shape so existing callers (settings UI,
   * native tools) don't need to know about the wider policy model.
   */
  getRiskPolicy(
    risk: ToolRisk,
    conversationId?: string
  ): { scope: 'conversation' | 'always'; decision: ApprovalDecision } | null {
    const all = listPolicies()
    const conv = conversationId
      ? all.find(
          (p) =>
            p.scope === 'conversation' &&
            p.subjectKind === 'risk' &&
            p.subject === risk &&
            p.conversationId === conversationId
        )
      : undefined
    const glob = all.find(
      (p) => p.scope === 'global' && p.subjectKind === 'risk' && p.subject === risk
    )
    if (conv?.decision === 'deny') return { scope: 'conversation', decision: 'deny' }
    if (glob?.decision === 'deny') return { scope: 'always', decision: 'deny' }
    if (conv) return { scope: 'conversation', decision: conv.decision }
    if (glob) return { scope: 'always', decision: glob.decision }
    return null
  }

  private async askUser(
    req: ToolApprovalRequest,
    workspacePath: string | undefined
  ): Promise<ApprovalOutcome> {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    // No active window → default deny (headless test runs, app shutdown
    // mid-request). Source labeled distinctly so the audit row reads
    // 'no-window' rather than 'modal' for a non-event.
    if (!mainWindow) return { decision: 'deny', source: 'no-window' }

    // R7 (Phase-4) — cancel-aware. If the turn's abort signal has ALREADY
    // fired by the time we would ask, deny immediately without popping a modal
    // (the run is being torn down).
    const signal = req.signal
    if (signal?.aborted) {
      return { decision: 'deny', source: 'aborted' }
    }

    return new Promise<ApprovalOutcome>((resolve) => {
      // No timeout. A pending approval stays pending until the user
      // definitively answers, cancelPending fires, or — new in Phase-4 — the
      // turn's abort signal trips. The old 30s auto-deny (which silently
      // refused tool calls when the user stepped away) stays removed; the
      // abort path only fires on an EXPLICIT cancel/deadline, not on idle.
      let onAbort: (() => void) | undefined
      const cleanup = (): void => {
        if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(req.callId, {
        conversationId: req.conversationId,
        cleanup,
        resolve: (response) => {
          const persistedId = this.persistAnswer(response, req, workspacePath)
          resolve({
            decision: response.decision,
            source: persistedId ? `policy:${persistedId}` : 'modal',
            // Carry the answered duration out to the caller. `persistAnswer`
            // already honours it for the synthetic toolId, but callers that
            // fan a grant out to OTHER subjects need it too.
            scope: response.scope
          })
        }
      })

      // Abort → resolve the pending approval as a one-time deny so an AFK
      // modal can be cancelled instead of deadlocking the awaiting tool loop.
      if (signal) {
        onAbort = () => {
          const entry = this.pending.get(req.callId)
          if (!entry) return
          this.pending.delete(req.callId)
          resolve({ decision: 'deny', source: 'aborted' })
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      // Strip the AbortSignal before crossing the IPC boundary — it is not
      // structured-cloneable and would throw in webContents.send.
      const { signal: _signal, ...reqForRenderer } = req
      void _signal
      mainWindow.webContents.send('tools:approvalRequired', reqForRenderer)

      // Backwards-compat shim — the prior modal listened to this event; any
      // external code that subscribed to mcp:confirmationRequired before the
      // refactor still sees the request. New modal uses tools:approvalRequired.
      const legacyToolName = req.name.includes('__')
        ? req.name.split('__').slice(1).join('__')
        : req.name
      mainWindow.webContents.send('mcp:confirmationRequired', {
        callId: req.callId,
        serverId: req.serverId,
        toolName: legacyToolName,
        args: req.args
      })
    })
  }

  /**
   * Persist the user's answer when their chosen scope is anything other than
   * 'once'. Returns the persisted policy id so the audit row can reference
   * it as the decision source for the next run that hits the same policy.
   */
  private persistAnswer(
    response: ToolApprovalResponse,
    req: ToolApprovalRequest,
    workspacePath: string | undefined
  ): string | null {
    if (response.scope === 'once') return null
    if (response.scope === 'conversation' && !req.conversationId) return null
    if (response.scope === 'workspace' && !workspacePath) return null
    try {
      const policy = upsertPolicy({
        scope:
          response.scope === 'always'
            ? 'global'
            : response.scope === 'workspace'
            ? 'workspace'
            : 'conversation',
        subjectKind: 'tool',
        subject: req.toolId,
        decision: response.decision,
        conversationId: response.scope === 'conversation' ? req.conversationId : undefined,
        workspacePath: response.scope === 'workspace' ? workspacePath : undefined
      })
      return policy.id
    } catch (err) {
      console.error('[permissions-store] failed to persist policy:', err)
      return null
    }
  }

  /** Renderer response to a pending approval request. */
  respond(response: ToolApprovalResponse): void {
    const entry = this.pending.get(response.callId)
    if (entry) {
      this.pending.delete(response.callId)
      entry.cleanup()
      entry.resolve(response)
    }
  }

  /** Backwards-compat for the legacy mcp.approveToolCall(callId, boolean) IPC. */
  respondLegacy(callId: string, approved: boolean): void {
    this.respond({
      callId,
      decision: approved ? 'allow' : 'deny',
      scope: 'once'
    })
  }

  /**
   * Legacy per-tool global API — kept as a thin wrapper over the policy store
   * so the existing IPC channels (permissions:listGlobalPolicies /
   * :setGlobalPolicy / :clearConversationPolicies) continue to work while the
   * UI migrates to the wider policy CRUD surface.
   */
  listGlobalPolicies(): Array<{ toolId: string; decision: ApprovalDecision }> {
    return listPolicies()
      .filter((p) => p.scope === 'global' && p.subjectKind === 'tool')
      .map((p) => ({ toolId: p.subject, decision: p.decision }))
  }

  setGlobalPolicy(toolId: string, decision: ApprovalDecision | null): void {
    if (decision === null) {
      const matches = listPolicies().filter(
        (p) => p.scope === 'global' && p.subjectKind === 'tool' && p.subject === toolId
      )
      for (const m of matches) deletePolicy(m.id)
      return
    }
    upsertPolicy({
      scope: 'global',
      subjectKind: 'tool',
      subject: toolId,
      decision
    })
  }

  clearConversationPolicies(conversationId: string): void {
    clearPoliciesForConversation(conversationId)
  }

  /** Cancel a pending request — used when a chat round is aborted. */
  cancelPending(callId: string): void {
    const entry = this.pending.get(callId)
    if (entry) {
      this.pending.delete(callId)
      entry.cleanup()
      entry.resolve({ callId, decision: 'deny', scope: 'once' })
      // ...and TELL THE RENDERER. Main resolved the promise, so the tool call is
      // settled, but nothing ever informed the window — so the full-screen approval
      // modal stayed up over a turn that had already been cancelled, and answering it
      // did nothing at all. The request half of this conversation had an event
      // (tools:approvalRequired); the cancel half had none.
      try {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('tools:approvalCancelled', { callId })
        }
      } catch (err) {
        // Best-effort UI notice — never let it affect the settled decision above.
        console.debug('[permissions] could not notify the renderer of a cancel:', (err as Error)?.message)
      }
    }
  }

  /**
   * R7 (Phase-4) — cancel EVERY in-flight approval belonging to a conversation
   * (each resolves as a one-time deny). Called from chat:cancel so a cancelled
   * turn can't be left deadlocked on an unanswered modal. Returns the count of
   * approvals cancelled. Snapshot the ids first — cancelPending mutates the map.
   */
  cancelPendingForConversation(conversationId: string): number {
    const ids = [...this.pending.entries()]
      .filter(([, entry]) => entry.conversationId === conversationId)
      .map(([callId]) => callId)
    for (const callId of ids) this.cancelPending(callId)
    return ids.length
  }
}

export const permissionsService = new PermissionsService()

/**
 * Mirror an approval outcome into the event spine. Every decision path is
 * recorded — policy match, modal answer, no-window default-deny — so the
 * audit timeline shows why a tool ran or didn't.
 *
 * `actorKind` is supplied by the CALLER, not derived from `outcome.source`,
 * because `source` alone cannot identify the actor. A human who clicks "Always
 * allow" yields source `policy:<id>` — byte-identical to a no-human
 * persisted-policy short-circuit — and a human sandbox-bypass answer yields
 * `modal+sandbox-bypass`. The old `outcome.source === 'modal'` test therefore
 * misfiled BOTH human consents (the sticky grant and every bypass — the single
 * most security-sensitive human decision) as `system`, so an audit filter on
 * actorKind='user' saw none of them. Only the caller, which knows whether this
 * decision came from askUser (human) or a policy/capability path (system), can
 * attribute it correctly.
 *
 * Failures here are swallowed: the approval decision itself is the
 * load-bearing side-effect, and event-log already owns its memory fallback.
 */
function emitApprovalEvent(
  req: ToolApprovalRequest,
  outcome: ApprovalOutcome,
  workspacePath: string | undefined,
  actorKind: EventActorKind,
  policyId?: string
): void {
  try {
    const type: EventType =
      outcome.decision === 'allow' ? 'tool.call.approved' : 'tool.call.denied'
    recordEvent({
      type,
      actorKind,
      severity: type === 'tool.call.denied' ? 'warning' : 'info',
      conversationId: req.conversationId,
      correlationId: req.correlationId,
      workspacePath,
      toolCallId: req.callId,
      entityKind: 'tool',
      entityId: req.toolId,
      payload: {
        toolId: req.toolId,
        name: req.name,
        providerKind: req.providerKind,
        serverId: req.serverId,
        risks: req.risks,
        source: outcome.source,
        policyId
      }
    })
  } catch (err) {
    console.error('[permissions-store] approval event failed:', err)
  }
}
