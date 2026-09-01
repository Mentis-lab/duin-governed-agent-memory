// external-action.ts — the EXTERNAL-EFFECTOR SUBSTRATE. Every ACT connector (Stage
// 5: calendar write, Slack post, file transfer, …) registers its side-effecting
// handler THROUGH this module rather than calling `toolRegistry.registerNative`
// directly, so all of DUIN's "hands" share ONE enforcement + audit pipeline:
//
//   (a) CONSEQUENCE TIER — the action is classified read / write-reversible /
//       irreversible (action-tier.ts).
//   (b) EXEC-TOKEN GATE — a non-read action requires a PRIVILEGED turn. A
//       de-privileged inbound turn (channel/runtime, execToken:null / execOk:false)
//       is DENIED a write or irreversible action before the handler runs. This is
//       the same deny-first rule the brain's gate enforces at dispatch; enforcing it
//       AGAIN at the substrate is defense-in-depth (belt and suspenders).
//   (c) OPERATOR APPROVAL — an irreversible action ALWAYS routes to the operator via
//       approval-roundtrip.requestOperatorApproval and only proceeds on an explicit
//       approve (timeout / no-operator / deny → the action does not fire).
//   (d) AUDIT — every external side effect (and every refusal) is written to the
//       event spine, metadata-only.
//
// SECURITY INVARIANT (proven in tests): a remote channel message runs de-privileged
// (execOk:false), so it can NEVER cause an unapproved irreversible external write —
// it is denied at (b) before approval is even solicited.
//
// The PURE decision core `decideExternalAction({tier, execOk})` is unit-tested across
// the whole matrix. `runExternalAction` is the async pipeline the registered tool
// handler runs; its side effects (approval routing, audit) are injectable so the
// crux tests exercise it with no live credentials.

import {
  classifyActionTier,
  tierNeedsGate,
  tierRequiresApproval,
  registerExternalActionTier,
  type ActionTier,
  type TierClassifiable
} from './action-tier'
import { toolRegistry, type ToolRisk } from '../tool-registry'
import { registerCapability } from '../ans/capability-ledger'
// STATIC, deliberately — see channelEnablementVerdict. A bare `require('../x')` of a
// sibling source module does NOT survive bundling (electron-vite emits the call
// verbatim into out/main/index.js, where '../channels/index' resolves to the
// non-existent out/channels/index), so the lazy form these two used to take could
// only ever throw. The channel registry + its enable-state store are light (adapters,
// keychain, pairing-store) and carry no import back into act/ or tool-registry, so
// there is no cycle and nothing heavy to defer. The genuinely heavy graph — approval
// roundtrip + channel dispatch — stays lazy via `await import` in
// defaultRequestApproval, which the bundler DOES resolve.
import { getChannel } from '../channels/index'
import { isChannelEnabled } from '../channels/channels-store'
import type { AuditStatus } from '../tool-result-status'
import { messageOf } from '../guarded'
import type { ApprovalOutcome } from '../proactive/approval-roundtrip'

// ──────────────────── audit ────────────────────

export type ActAuditPhase =
  /** The side effect actually happened. */
  | 'executed'
  /** Refused: exec-token gate, denied approval, timeout, or no operator. */
  | 'denied'
  /** The handler threw while performing the side effect. */
  | 'failed'
  /** Irreversible action routed to the operator (awaiting their reply). */
  | 'approval-requested'

export interface ActAuditEvent {
  phase: ActAuditPhase
  /** The external action's tool name. */
  action: string
  tier: ActionTier
  /** Was the turn privileged (carried a valid exec token)? */
  execOk: boolean
  /** Provenance of a denial / approval (e.g. 'exec-token', 'operator-deny'). */
  source?: string
  error?: string
}

export type ActAudit = (e: ActAuditEvent) => void

/** Default audit sink → an append-only event-spine row (metadata only; no bodies).
 *  Lazily imports the DB layer so the pure decision core + tests stay light.
 *  Best-effort: an audit failure never blocks or reverses the decision.
 *
 *  FIRE-AND-FORGET `import()`, not `require()`. This was a bare
 *  `require('../event-log')`, which the bundler copies verbatim into
 *  out/main/index.js where '../event-log' cannot resolve (see
 *  defaultRequestApproval for the full account). It threw on every call and the
 *  try/catch swallowed it as a debug line, so module invariant (d) at the top of
 *  this file — "every external side effect (and every refusal) is written to the
 *  event spine" — did not hold in any shipped build: the sink silently wrote
 *  nothing. `ActAudit` is synchronous by contract, so the row is enqueued rather
 *  than awaited; that matches the sink's existing best-effort semantics, where a
 *  failed audit already never blocked or reversed a decision. */
export const defaultActAudit: ActAudit = (e) => {
  const type =
    e.phase === 'executed'
      ? 'tool.call.completed'
      : e.phase === 'failed'
        ? 'tool.call.failed'
        : e.phase === 'approval-requested'
          ? 'security.decision'
          : 'tool.call.denied'
  void import('../event-log')
    .then(({ recordEvent }) =>
      recordEvent({
        type,
        actorKind: 'system',
        severity: e.phase === 'executed' || e.phase === 'approval-requested' ? 'info' : 'warning',
        entityKind: 'external-action',
        entityId: e.action,
        payload: {
          surface: 'act',
          phase: e.phase,
          action: e.action,
          tier: e.tier,
          execOk: e.execOk,
          source: e.source,
          error: e.error
        }
      })
    )
    .catch((err) => console.debug('[external-action] audit best-effort:', messageOf(err)))
}

// ──────────────────── pure decision core ────────────────────

export type ActGateVerdict =
  /** Run the handler now (read, or a write-reversible action on a privileged turn). */
  | { kind: 'allow'; source: string }
  /** Privileged turn but irreversible → must get explicit operator approval first. */
  | { kind: 'needs-approval'; source: string }
  /** Refused outright (de-privileged turn attempting a non-read action). */
  | { kind: 'deny'; source: string; reason: string }

export interface ExternalActionDecisionInput {
  tier: ActionTier
  /** Does THIS turn carry a valid exec token (privileged)? A de-privileged inbound
   *  channel turn is execOk:false. */
  execOk: boolean
}

/**
 * Resolve an external action to a verdict. DENY-FIRST and monotonic in consequence:
 *   1. read              → allow (ungated).
 *   2. non-read, no token → DENY (exec-token). The critical rule: a de-privileged
 *                           inbound turn can never take a write/irreversible action.
 *   3. irreversible, token → needs-approval (operator must confirm).
 *   4. write-reversible, token → allow (soft gate; privileged turn is sufficient).
 * PURE — no I/O, never throws.
 */
export function decideExternalAction(input: ExternalActionDecisionInput): ActGateVerdict {
  if (!tierNeedsGate(input.tier)) return { kind: 'allow', source: 'read-ungated' }

  // Exec-token gate — a non-read external effect requires a privileged turn.
  if (!input.execOk) {
    return {
      kind: 'deny',
      source: 'exec-token',
      reason:
        `Error: this action ('${input.tier}') is an external side effect and this turn is not ` +
        `authorized to perform it. An inbound/channel turn cannot take write or irreversible ` +
        `actions — it can only read. Continue with a read action or answer directly.`
    }
  }

  // Irreversible → operator approval is mandatory, even on a privileged turn.
  if (tierRequiresApproval(input.tier)) return { kind: 'needs-approval', source: 'irreversible' }

  // Write-reversible on a privileged turn → allowed (audited).
  return { kind: 'allow', source: 'write-reversible' }
}

// ──────────────────── per-turn exec context (ambient) ────────────────────
// The registered tool handler receives only `(args)`; it has no direct view of the
// turn's exec token. The dispatch gate (agui-gate) publishes the current turn's
// privilege here right before it dispatches a call, so the handler's defense-in-depth
// re-check (runExternalAction) sees the same execOk the gate decided on.
//
// FAIL-SAFE DEFAULT: `false` (de-privileged). If nothing published a context, a
// non-read action is denied — a missing wire degrades to "no external write", never
// to an unguarded one.

let ambientExecOk = false

/** Publish the current turn's privilege for the handler-level re-check. */
export function setActExecContext(execOk: boolean): void {
  ambientExecOk = execOk === true
}

/** Reset the ambient exec context to the fail-safe default (de-privileged). */
export function clearActExecContext(): void {
  ambientExecOk = false
}

/** Derive execOk from a raw exec token (non-empty string = privileged). */
export function execOkFromToken(token: unknown): boolean {
  return typeof token === 'string' && token.length > 0
}

// ──────────────────── run pipeline ────────────────────

export interface ExternalActionContext {
  /** Does the turn carry a valid exec token? De-privileged inbound turn → false. */
  execOk: boolean
  /** Audit sink (default: event spine). Injectable for tests. */
  audit?: ActAudit
  /** Operator-approval router for irreversible actions. Injected in tests; defaults
   *  to a real approval-roundtrip over the configured home channel. Returning a
   *  non-'approve' decision (deny / timeout / no-operator) blocks the action. */
  requestApproval?: (summary: string, tool: string) => Promise<ApprovalOutcome>
}

export interface ExternalActionResult {
  ok: boolean
  /** True when the action was refused by the gate/approval (not an execution error). */
  denied?: boolean
  /** The handler's return value on success. */
  result?: unknown
  error?: string
  tier: ActionTier
  /** Provenance: the verdict source, or 'operator-approve' / 'handler-error'. */
  source: string
}

/** Human-readable one-liner an operator sees for an approval prompt. */
function approvalSummary(action: string, tier: ActionTier): string {
  return `DUIN wants to run the ${tier} external action '${action}'.`
}

/**
 * Run one external action through the full ACT pipeline: classify → exec-token gate
 * → (irreversible) operator approval → handler → audit. Never throws — always
 * resolves a structured result. This is what the registered tool handler calls, and
 * what the crux tests drive directly with an injected context.
 */
export async function runExternalAction(
  spec: ExternalActionSpec,
  args: Record<string, unknown>,
  ctx: ExternalActionContext
): Promise<ExternalActionResult> {
  const tier = classifyActionTier(spec)
  const action = spec.name ?? spec.id
  const audit = ctx.audit ?? defaultActAudit
  const execOk = ctx.execOk === true

  const verdict = decideExternalAction({ tier, execOk })

  if (verdict.kind === 'deny') {
    audit({ phase: 'denied', action, tier, execOk, source: verdict.source })
    return { ok: false, denied: true, error: verdict.reason, tier, source: verdict.source }
  }

  if (verdict.kind === 'needs-approval') {
    audit({ phase: 'approval-requested', action, tier, execOk, source: verdict.source })
    const requestApproval = ctx.requestApproval ?? defaultRequestApproval
    let outcome: ApprovalOutcome
    try {
      outcome = await requestApproval(approvalSummary(action, tier), action)
    } catch (e) {
      // Approval plumbing failed → fail-closed DENY (never silently run irreversible).
      audit({ phase: 'denied', action, tier, execOk, source: 'approval-error', error: messageOf(e) })
      return { ok: false, denied: true, error: `approval failed: ${messageOf(e)}`, tier, source: 'approval-error' }
    }
    if (outcome.decision !== 'approve') {
      audit({ phase: 'denied', action, tier, execOk, source: outcome.source })
      return {
        ok: false,
        denied: true,
        error: `Error: '${action}' was not approved by the operator (${outcome.source}).`,
        tier,
        source: outcome.source
      }
    }
  }

  // Authorized (and approved, if irreversible) — perform the side effect.
  try {
    const result = await spec.handler(args)
    audit({
      phase: 'executed',
      action,
      tier,
      execOk,
      source: verdict.kind === 'needs-approval' ? 'operator-approve' : verdict.source
    })
    return {
      ok: true,
      result,
      tier,
      source: verdict.kind === 'needs-approval' ? 'operator-approve' : verdict.source
    }
  } catch (e) {
    audit({ phase: 'failed', action, tier, execOk, source: 'handler-error', error: messageOf(e) })
    return { ok: false, error: messageOf(e), tier, source: 'handler-error' }
  }
}

// ──────────────────── outbound enablement gate (ACT approval seam) ────────────────────
//
// ASYMMETRY THIS CLOSES. A channel has TWO independent conditions: `isConfigured()`
// (the credential exists) and `isChannelEnabled()` (the operator turned it on,
// default OFF). The gateway requires BOTH before it start()s an adapter — so the
// INBOUND receive loop, and therefore `handleInbound` → `resolveApprovalReply`,
// only exists for an ENABLED channel. Outbound `channelDispatch` requires only
// `isConfigured()`.
//
// The trap that falls out of that: with a home channel that is configured but NOT
// enabled, DUIN sends the operator "Approval needed: … reply YES", the message
// arrives, the operator replies — and no receive loop exists to hear it. The
// approval sits for the full timeout and then denies. Fail-CLOSED, so no
// irreversible action escapes; but DUIN asked into a void, stalled the turn for
// the whole timeout window (5 min by default), and left the operator believing
// they answered.
//
// The fix is to make the ask UNDELIVERABLE rather than merely unanswerable: refuse
// the dispatch up front. `requestOperatorApproval` already has exactly the right
// handling for an outbound failure — it cancels the pending interaction (so no
// approvable window is left dangling), settles the waiter as a 'dispatch-failed'
// DENY, audits it, and returns immediately. So this reuses that tested path rather
// than inventing a second refusal route, and the outcome stays a DENY.
//
// SCOPE, stated plainly: this gates the ACT substrate's OWN approval dispatch only.
// `channelDispatch` itself is still enablement-blind, so every other outbound caller
// (send_message, cron→channel delivery, agui-gate's approval routing) can still
// deliver over a configured-but-disabled channel. Closing that needs an edit to
// channel-dispatch.ts, which this lane does not own.

/** Verdict for dispatching to `kind`. PURE given its deps; never throws. */
export function channelEnablementVerdict(
  kind: string,
  deps: {
    /** Is a ChannelAdapter registered under this id? Defaults to the real registry. */
    hasAdapter?: (id: string) => boolean
    /** Has the operator enabled it? Defaults to the real channels store. */
    isEnabled?: (id: string) => boolean
  } = {}
): { ok: true } | { ok: false; error: string } {
  const id = String(kind ?? '').trim().toLowerCase()
  if (!id) return { ok: true } // not ours to judge — channelDispatch reports the empty kind
  try {
    const hasAdapter = deps.hasAdapter ?? ((x: string) => !!getChannel(x))
    // Only a REGISTRY adapter has an enablement toggle. OS push / email carry no
    // adapter and no enable switch, and gating them would silently break the
    // fallback surfaces an approval must always be able to reach.
    if (!hasAdapter(id)) return { ok: true }
    const isEnabled = deps.isEnabled ?? ((x: string) => isChannelEnabled(x))
    if (!isEnabled(id)) return { ok: false, error: 'channel not enabled' }
    return { ok: true }
  } catch (e) {
    // FAIL-CLOSED. We could not establish that the operator can hear a reply, so we
    // refuse to ask. The consequence of being wrong here is that an IRREVERSIBLE
    // action does not happen — the safe direction — whereas fail-open would restore
    // the ask-into-a-void the gate exists to remove.
    console.debug('[external-action] channel enablement lookup failed  refusing dispatch:', messageOf(e))
    return { ok: false, error: 'channel not enabled' }
  }
}

/** Wrap a dispatch fn so an approval is never pushed to a channel the operator has
 *  not enabled (and therefore cannot reply on). Refuses BEFORE the inner dispatch
 *  runs, so no message is sent. */
export function gateDispatchOnChannelEnabled<
  D extends (ref: { kind: string; target: string }, text: string) => Promise<{ ok: boolean; kind: string; error?: string }>
>(dispatch: D, deps: Parameters<typeof channelEnablementVerdict>[1] = {}): D {
  return (async (ref, text) => {
    const kind = String(ref?.kind ?? '').trim().toLowerCase()
    const verdict = channelEnablementVerdict(kind, deps)
    if (!verdict.ok) return { ok: false, kind, error: verdict.error }
    return dispatch(ref, text)
  }) as D
}

/** Real operator-approval router: read config, dispatch over the home channel, await
 *  the reply. Lazily imported so the heavy approval/dispatch graph stays out of the
 *  pure core's static import chain.
 *
 *  `await import`, NOT `require`. These two were bare `require('../…')` calls, and a
 *  bare require of a sibling SOURCE module does not survive bundling: electron-vite
 *  copies the call verbatim into out/main/index.js, so at runtime Node resolved
 *  '../proactive/approval-roundtrip' against out/main/ → out/proactive/…, which does
 *  not exist (out/ holds only main/, preload/, renderer/). The require therefore threw
 *  on EVERY call, runExternalAction's approval try/catch turned it into a fail-closed
 *  'approval-error', and the entire operator-approval roundtrip for external actions
 *  could never run in a shipped build — including the channel-enablement gate composed
 *  one line below. Fail-closed, so nothing unsafe escaped; but the mechanism existed
 *  without ever firing. `import()` is statically analysed by the bundler and emitted as
 *  a real chunk reference, which is why the rest of this codebase (channel-dispatch's
 *  gmail-send, automations-runner's brain/index, loop-controller's channel-dispatch)
 *  already uses that form. */
async function defaultRequestApproval(summary: string, tool: string): Promise<ApprovalOutcome> {
  const { requestOperatorApproval, readApprovalConfig } = await import('../proactive/approval-roundtrip')
  const { channelDispatch } = await import('../channel-dispatch')
  const cfg = readApprovalConfig()
  return requestOperatorApproval(
    { summary, tool },
    {
      operator: cfg.operator,
      homeChannel: cfg.homeChannel,
      timeoutMs: cfg.timeoutMs,
      dispatch: gateDispatchOnChannelEnabled(channelDispatch)
    }
  )
}

// ──────────────────── registration ────────────────────

export interface ExternalActionSpec extends TierClassifiable {
  /** Stable tool id (also the default name). */
  id: string
  name?: string
  title?: string
  description: string
  /** JSON schema for the tool's arguments. Defaults to a permissive object. */
  inputSchema?: Record<string, unknown>
  /** Override the descriptor risks; defaults derive from the tier. */
  risks?: ToolRisk[]
  /** The side-effecting handler. Only ever invoked past the gate (+ approval). */
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

export interface RegisterExternalActionDeps {
  /** Resolve the context for a handler invocation. Defaults to the ambient exec
   *  context published by the dispatch gate. Injectable for tests. */
  contextResolver?: () => ExternalActionContext
}

/** Descriptor risks implied by a tier when the connector doesn't specify them. */
function defaultRisksForTier(tier: ActionTier): ToolRisk[] {
  switch (tier) {
    case 'read':
      return ['read', 'network']
    case 'write-reversible':
      return ['write', 'network']
    case 'irreversible':
      return ['destructive', 'network']
  }
}

/** The default handler context: the ambient per-turn exec privilege + real approval. */
export function resolveActContext(): ExternalActionContext {
  return { execOk: ambientExecOk }
}

/**
 * Register an external-write action as a GATED native tool AND record its tier in the
 * pure registry the dispatch gate reads. The published handler runs every call through
 * `runExternalAction`, so the consequence-tier + exec-token + approval + audit
 * pipeline is enforced uniformly for every ACT connector.
 *
 * `requiresApproval` on the descriptor is set for irreversible actions so the brain's
 * approval service also treats it as a hard gate on a trusted interactive turn; the
 * exec-token denial for de-privileged turns is enforced by the gate (decideAguiGate,
 * which now recognizes registered external actions) BEFORE the handler is reached.
 */
export function registerExternalAction(
  spec: ExternalActionSpec,
  deps: RegisterExternalActionDeps = {}
): ActionTier {
  const tier = classifyActionTier(spec)
  const name = spec.name ?? spec.id
  registerExternalActionTier(name, tier)

  // GOVERN (ANS composition, wiring fix): the gate's ANS composer looks a tool up with
  // `getCapability(toolName)`, but the ledger only ever held ANS-native ids
  // ('operator-fact-promotion', 'memory-consolidation', 'autonomous-loop', 'named-skill:*').
  // No tool name could ever match, so composeTierRung ALWAYS saw rung=null and the composer
  // was a permanent no-op — a governor that could not govern. ACT effectors are exactly the
  // capabilities the ANS is meant to hold: their registered id IS the gate's tool name, so
  // publishing them here makes the lookup resolve with no namespace translation.
  //
  // Registered at rung 'reflexive' DELIBERATELY, so this fix changes wiring and NOT today's
  // permissions: composeTierRung takes the least-permissive MEET of tier and rung, and the
  // consequence tier remains the binding constraint for every one of these actions (an
  // irreversible delete is still tier-gated exactly as before). What changes is that a
  // governor DEMOTION ('stage'/'hold') now actually tightens the gate, which is the whole
  // point of the composer. floorRung is tier-derived so a write can never earn its way to
  // silent autonomy: only a read-shaped action may rest at 'reflexive'.
  try {
    registerCapability({
      id: name,
      title: spec.title ?? name,
      rung: 'reflexive',
      floorRung: tier === 'read' ? 'reflexive' : 'stage'
    })
  } catch (e) { console.debug('[external-action] ANS capability publish is best-effort  the tier gate still governs:', messageOf(e)) }

  const resolver = deps.contextResolver ?? resolveActContext

  toolRegistry.registerNative(
    {
      id: spec.id,
      name,
      title: spec.title ?? name,
      description: spec.description,
      providerKind: 'native',
      providerId: 'internal',
      inputSchema: spec.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true },
      risks: spec.risks ?? defaultRisksForTier(tier),
      requiresApproval: tierRequiresApproval(tier),
      enabled: true,
      mutates: tierNeedsGate(tier)
    },
    async (args) => {
      const r = await runExternalAction(spec, (args ?? {}) as Record<string, unknown>, resolver())
      if (!r.ok) {
        const msg = r.error ?? (r.denied ? 'Error: denied by the ACT safety gate.' : 'Error: action failed.')
        return { result: msg, status: r.denied ? 'denied' : 'error' }
      }
      if (typeof r.result === 'string') return { result: r.result, status: 'done' }
      if (r.result && typeof r.result === 'object') {
        // Pass through an already-shaped {result,status}; otherwise JSON-encode.
        const obj = r.result as Record<string, unknown>
        if (typeof obj.result === 'string' && (obj.status === 'done' || obj.status === 'error' || obj.status === 'denied')) {
          return obj as { result: string; status: AuditStatus }
        }
        return { result: JSON.stringify(r.result), status: 'done' }
      }
      return { result: `Ran external action '${name}'.`, status: 'done' }
    }
  )

  return tier
}
