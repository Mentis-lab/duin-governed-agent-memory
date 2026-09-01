// approval-roundtrip — the AFK OPERATOR APPROVAL LOOP (#1).
//
// When a gated action fires while the operator is away from the desk, DUIN can no
// longer answer the in-process approval modal (agui-approval.ts / agui-gate.ts). The
// historical fallback under the default `trusted-afk` posture is to BLANKET
// auto-allow (fail-open, audited). This module upgrades that AFK path: instead of
// silently allowing, it pushes the pending approval OUT to the operator's home
// channel and waits for the operator to reply approve / deny — a strictly SAFER
// resolution than auto-allow. On timeout it defaults to DENY.
//
// It EXTENDS the existing approval machinery; it does not reinvent it:
//   • The pure verdict core (agui-approval.decideAguiGate) still decides IF an
//     action is gated and whether the turn is even authorized. This module only
//     handles the "prompt the operator" step for the AFK case, the channel analog
//     of agui-gate's `permissionsService.requestApprovalDetailed` modal.
//   • The pending-interactions store (Stage 1) is the awaiting-reply substrate: it
//     gives us single-use + expiry + (channel,user) scoping for free.
//
// SECURITY — the guarantees this module must uphold (all tested):
//   (a) OPERATOR-GATED. Only the configured operator identity (settings.operator
//       {channelId,userId}) can approve. Any other paired user's reply is REFUSED
//       and audited — it can neither approve nor consume the pending interaction.
//   (b) ACTION-BOUND, SINGLE-USE, EXPIRY-BOUNDED, REPLAY-SAFE. An approval targets
//       one SPECIFIC actionId. The reply resolves exactly that interaction (via
//       resolveById) and settles exactly that action's waiter — never a different or
//       broader one. A second reply, or a reply after expiry, resolves nothing.
//   (c) NO PRIVILEGE ESCALATION. This module returns a decision to the ORIGINAL
//       turn's gate; it NEVER executes the action itself and NEVER mints exec
//       authority. The de-privileged inbound turn that CARRIES the operator's reply
//       (channel-runtime, execToken:null) only settles a boolean — the gated action
//       still runs under its original turn's authority or not at all. Structurally,
//       a de-privileged turn (execOk:false) is denied at the exec-token rule long
//       before the trusted-afk branch that reaches this loop, so a channel reply can
//       never turn an unprivileged turn into a privileged one.
//   (d) AUDITED. Every phase (requested / approved / denied / refused / ambiguous /
//       expired) is written to the event spine.
//
// The pending-interactions record and its audit trail are PERSISTED; the in-memory
// waiter that unblocks the awaiting gated call is per-process. If the app restarts
// mid-wait the awaiting call has already unwound — the interaction then simply
// expires to DENY on the next sweep, which is the fail-safe direction.

import { randomUUID } from 'crypto'
import {
  createInteraction,
  resolveById,
  listOpen,
  cancelInteraction,
  type PendingInteraction,
  type InteractionKind
} from './pending-interactions'
import { readSettings } from '../settings-helper'
import { listPairings } from '../channels/pairing-store'
import { messageOf } from '../guarded'
// Type-only: keep this module free of channel-dispatch's heavy runtime graph so its
// pure helpers stay trivially unit-testable. Callers inject a real dispatch fn.
import type { ChannelRef, DispatchResult } from '../channel-dispatch'

export type ApprovalDecision = 'approve' | 'deny'

/** The designated operator for a channel — the ONLY identity whose reply may
 *  approve a gated action on it. Both fields must be non-empty to be in effect. */
export interface OperatorIdentity {
  channelId: string
  userId: string
}

export interface ApprovalOutcome {
  decision: ApprovalDecision
  /** Provenance of the decision: 'operator-approve' | 'operator-deny' | 'timeout' |
   *  'no-operator' | 'dispatch-failed' | 'superseded'. */
  source: string
  actionId: string
}

/** Default wait before an unanswered channel approval defaults to DENY: 5 minutes. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000

// ──────────────────── audit ────────────────────

export type ApprovalAuditPhase =
  | 'requested'
  | 'approved'
  | 'denied'
  | 'refused-non-operator'
  | 'ambiguous'
  | 'expired'

export interface ApprovalAuditEvent {
  phase: ApprovalAuditPhase
  actionId: string
  channelId: string
  /** The replier's user id (for the resolution phases). */
  by?: string
  /** The configured operator's user id, if any. */
  operator?: string
  source?: string
  tool?: string
}

export type ApprovalAudit = (e: ApprovalAuditEvent) => void

/** Default audit sink — writes a `security.decision` event (metadata only; no
 *  message bodies). Best-effort: an audit failure never blocks the decision. */
export const defaultApprovalAudit: ApprovalAudit = (e) => {
  // FIRE-AND-FORGET `import()`, not `require()` — the identical fix act/external-action.ts already
  // carries for this same module. A bare `require('../event-log')` is copied verbatim into
  // out/main/index.js, where '../event-log' cannot resolve, so it threw on every call and the
  // catch swallowed it as a debug line. Every channel-approval decision therefore went UNAUDITED
  // in every shipped build, silently. `ApprovalAudit` is synchronous by contract, so the row is
  // enqueued rather than awaited — which matches this sink's existing best-effort semantics,
  // where a failed audit already never blocked or reversed a decision.
  void import('../event-log')
    .then(({ recordEvent }) => {
      recordEvent({
        type: 'security.decision',
        actorKind: 'system',
        severity: e.phase === 'approved' ? 'info' : e.phase === 'requested' ? 'info' : 'warning',
        entityKind: 'channel-approval',
        entityId: e.actionId,
        payload: {
          surface: 'channel-approval',
          phase: e.phase,
          channelId: e.channelId,
          by: e.by,
          operator: e.operator,
          source: e.source,
          tool: e.tool
        }
      })
    })
    .catch((err: unknown) => {
      console.debug('[approval-roundtrip] audit best-effort:', messageOf(err))
    })
}

// ──────────────────── pure helpers ────────────────────

const APPROVE_WORDS = new Set([
  'yes', 'y', 'yeah', 'yep', 'yup', 'ok', 'okay', 'approve', 'approved', 'allow',
  'confirm', 'confirmed', 'go', 'accept', 'accepted', 'ack', '👍', '✅'
])
const DENY_WORDS = new Set([
  'no', 'n', 'nope', 'nah', 'deny', 'denied', 'reject', 'rejected', 'decline',
  'declined', 'cancel', 'stop', 'block', 'blocked', 'veto', '👎', '❌', '🚫'
])

/** Strip surrounding whitespace/punctuation and lowercase (emoji preserved). */
function normalizeWord(s: string): string {
  return s.trim().toLowerCase().replace(/^[\s!.,;:'"()[\]-]+|[\s!.,;:'"()[\]-]+$/g, '')
}

/**
 * Parse an operator reply into a decision. DENY-FIRST / conservative: recognizes a
 * clear yes/no as the whole message or its FIRST word; anything ambiguous returns
 * null (the caller then re-asks rather than guessing). Never throws.
 */
export function parseApprovalReply(text: unknown): ApprovalDecision | null {
  if (typeof text !== 'string') return null
  const whole = normalizeWord(text)
  if (!whole) return null
  if (APPROVE_WORDS.has(whole)) return 'approve'
  if (DENY_WORDS.has(whole)) return 'deny'
  const first = normalizeWord(whole.split(/\s+/)[0] ?? '')
  if (APPROVE_WORDS.has(first)) return 'approve'
  if (DENY_WORDS.has(first)) return 'deny'
  return null
}

/** True only when `op` is a fully-specified operator identity that matches the
 *  (channelId, userId) of the replier. An unset operator (null / blank fields) can
 *  never match, so a channel with no configured operator can approve NOTHING. */
export function isDesignatedOperator(
  op: OperatorIdentity | null | undefined,
  channelId: string,
  userId: string
): boolean {
  if (!op) return false
  if (!op.channelId || !op.userId) return false
  return op.channelId === channelId && op.userId === userId
}

const PUSH_KINDS = new Set(['push', 'os', 'notification', 'notify'])

/**
 * PURE gate for the PRODUCER side (agui-gate): should a trusted-afk gated action be
 * routed to the channel operator instead of blanket auto-allowing? True ONLY when:
 *   • the feature is explicitly enabled (env opt-in — default OFF, live app unchanged),
 *   • an operator identity is configured,
 *   • the posture is trusted-afk with NO interactive window (genuinely AFK), and
 *   • the home channel is a real two-way channel (not a one-way OS push the
 *     operator can't reply to).
 * Any missing condition → false (fall back to the existing behavior).
 */
export function shouldRouteToChannelApproval(input: {
  enabled: boolean
  // Widened for the `review` posture (composer Auto-review). Channel routing is
  // AFK-only: any non-`trusted-afk` posture short-circuits to false below, so a
  // `review`/`interactive` turn routes to the local modal, never the channel.
  posture: 'interactive' | 'review' | 'trusted-afk'
  hasWindow: boolean
  operator: OperatorIdentity | null
  homeChannelKind: string
}): boolean {
  if (!input.enabled) return false
  if (input.posture !== 'trusted-afk') return false
  if (input.hasWindow) return false
  if (!input.operator || !input.operator.channelId || !input.operator.userId) return false
  const kind = String(input.homeChannelKind ?? '').trim().toLowerCase()
  if (!kind || PUSH_KINDS.has(kind)) return false
  return true
}

// ──────────────────── config reader ────────────────────

export interface ApprovalConfig {
  operator: OperatorIdentity | null
  timeoutMs: number
  homeChannel: ChannelRef
  /** Producer-side opt-in (env DUIN_CHANNEL_APPROVAL truthy). */
  enabled: boolean
}

function parseOperator(raw: unknown): OperatorIdentity | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const channelId = typeof o.channelId === 'string' ? o.channelId.trim() : ''
  const userId = typeof o.userId === 'string' ? o.userId.trim() : ''
  if (!channelId || !userId) return null
  return { channelId, userId }
}

/** Read operator identity, timeout, and home channel from persisted settings.
 *  Tolerates a missing settings file (vitest / first run) → operator null. */
export function readApprovalConfig(
  env: NodeJS.ProcessEnv = process.env
): ApprovalConfig {
  const s = readSettings()
  const rawTimeout = s.approvalTimeoutMs
  const timeoutMs =
    typeof rawTimeout === 'number' && rawTimeout > 0 ? rawTimeout : DEFAULT_APPROVAL_TIMEOUT_MS
  let homeChannel: ChannelRef = { kind: 'push', target: '' }
  if (s.homeChannel && typeof s.homeChannel === 'object') {
    const h = s.homeChannel as Record<string, unknown>
    homeChannel = { kind: String(h.kind ?? 'push'), target: String(h.target ?? '') }
  }
  const flag = String(env.DUIN_CHANNEL_APPROVAL ?? '').trim().toLowerCase()
  const enabled = flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes'
  const operator = parseOperator(s.operator) ?? soleApprovedPairing(homeChannel.kind)
  return { operator, timeoutMs, homeChannel, enabled }
}

/** Fall back to the approved pairing on the home channel when `settings.operator`
 *  is unset.
 *
 *  `operator` defaults to `{ channelId: '', userId: '' }` (default-app-settings) and
 *  NOTHING in the product writes it — there is no settings field, no IPC handler, no
 *  onboarding step. So parseOperator returned null on every install, and every
 *  irreversible ACT action denied with source 'no-operator': the whole approval
 *  roundtrip was unreachable in a shipped build, not just unconfigured.
 *
 *  Channel pairing is the identity gate the product DOES ship (channels:pair →
 *  channels:approve), and an approved pairing already means "this external user may
 *  talk to my brain on this channel". Promoting the single approved identity on the
 *  home channel to operator reuses that decision rather than adding a second one.
 *
 *  Deliberately conservative on two axes.
 *
 *  Only a SOLE approved pairing counts. Zero is unset, two or more is ambiguous --
 *  picking one there would silently hand irreversible approval to whichever record
 *  sorts first. Both keep the fail-closed 'no-operator' deny, and an explicit
 *  `settings.operator` always wins.
 *
 *  NOT gated on DUIN_CHANNEL_APPROVAL, though the first version of this was. That flag
 *  has NO writer anywhere in the product — no settings field, no IPC handler, no UI — and
 *  external-action's defaultRequestApproval passes cfg.operator without consulting
 *  cfg.enabled at all. Gating on it therefore did not make the promotion opt-in; it made
 *  the operator null on every default install and reverted the fix this fallback IS,
 *  restoring the deny-forever the ledger recorded. An unsettable flag is a disable switch
 *  wearing a consent label.
 *
 *  The privilege concern behind that attempt is real and stays acknowledged here:
 *  channels:approve is the de-privileged "may run a turn" gate, channel-runtime's
 *  resolveOperator reads this same value, and nothing in the pairing UI says that
 *  approving a chat identity also lets it authorize an irreversible action. The answer to
 *  that is an explicit operator designation the user can SET — a real writer for
 *  settings.operator — not a flag they cannot reach. Until that exists, the promotion is
 *  made OBSERVABLE instead of silent: it records an event the first time it is used, so
 *  the grant appears in the audit trail rather than only in this comment. */
function soleApprovedPairing(channelId: string): OperatorIdentity | null {
  if (!channelId) return null
  try {
    const approved = listPairings(channelId).filter((r) => r.status === 'approved')
    if (approved.length !== 1) return null
    const userId = approved[0].externalUserId.trim()
    if (!userId) return null
    noteImplicitOperator(channelId, userId)
    return { channelId, userId }
  } catch {
    return null
  }
}

// One event per (channel,user) per process. readApprovalConfig is called on every
// approval decision, so an un-deduped record would bury the grant it exists to surface.
const notedImplicitOperators = new Set<string>()

/** Record that an identity gained approval authority WITHOUT an explicit designation.
 *  Best-effort and fire-and-forget: an audit failure must never change the decision. */
function noteImplicitOperator(channelId: string, userId: string): void {
  const key = `${channelId}:${userId}`
  if (notedImplicitOperators.has(key)) return
  notedImplicitOperators.add(key)
  void import('../event-log')
    .then(({ recordEvent }) =>
      recordEvent({
        type: 'security.decision',
        actorKind: 'system',
        severity: 'warning',
        entityKind: 'operator',
        entityId: key,
        payload: {
          surface: 'approval-roundtrip',
          decision: 'implicit-operator',
          reason: 'settings.operator is unset; promoted the sole approved pairing on the home channel',
          channelId,
          userId
        }
      })
    )
    .catch(() => undefined)
}

// ──────────────────── waiter registry (per-process) ────────────────────

interface Waiter {
  resolve: (o: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
  actionId: string
}

const waiters = new Map<string, Waiter>()

/**
 * Block until the operator settles `actionId`, or until `timeoutMs` elapses → the
 * fail-safe DENY (source 'timeout'). Exactly one waiter per actionId; a duplicate
 * registration supersedes the prior one (deny/superseded) so no promise leaks.
 */
export function awaitApproval(actionId: string, timeoutMs: number): Promise<ApprovalOutcome> {
  const existing = waiters.get(actionId)
  if (existing) {
    clearTimeout(existing.timer)
    existing.resolve({ decision: 'deny', source: 'superseded', actionId })
    waiters.delete(actionId)
  }
  return new Promise<ApprovalOutcome>((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(actionId)
      resolve({ decision: 'deny', source: 'timeout', actionId })
    }, Math.max(1, timeoutMs))
    // Don't keep the event loop alive solely for an approval wait.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref?: () => void }).unref!()
    }
    waiters.set(actionId, { resolve, timer, actionId })
  })
}

/**
 * Settle a waiting approval for `actionId`. Returns true if a waiter was present.
 * Idempotent/replay-safe: a second settle finds no waiter and returns false, so a
 * duplicate reply can't re-fire the decision.
 */
export function settleApproval(
  actionId: string,
  decision: ApprovalDecision,
  source: string
): boolean {
  const w = waiters.get(actionId)
  if (!w) return false
  clearTimeout(w.timer)
  waiters.delete(actionId)
  w.resolve({ decision, source, actionId })
  return true
}

/** Test/introspection aid: number of approvals currently awaiting a reply. */
export function pendingApprovalCount(): number {
  return waiters.size
}

/** Test-only: clear all in-flight waiters (each resolved as a superseded deny). */
export function __resetApprovalWaiters(): void {
  for (const w of waiters.values()) {
    clearTimeout(w.timer)
    w.resolve({ decision: 'deny', source: 'superseded', actionId: w.actionId })
  }
  waiters.clear()
}

// ──────────────────── orchestrator (producer side) ────────────────────

export interface ApprovalRequest {
  /** Human-readable summary of the action awaiting approval (audited + sent). */
  summary: string
  /** Optional tool/action name for the audit trail. */
  tool?: string
  /** Stable id binding this approval; auto-generated if omitted. */
  actionId?: string
}

export interface ApprovalRequestDeps {
  operator: OperatorIdentity | null
  homeChannel: ChannelRef
  timeoutMs: number
  dispatch: (ref: ChannelRef, text: string) => Promise<DispatchResult>
  audit?: ApprovalAudit
}

const APPROVAL_KIND: InteractionKind = 'approval'

function timeoutLabel(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins >= 1) return `${mins} min`
  return `${Math.max(1, Math.round(ms / 1000))}s`
}

/**
 * Ask the operator to approve a gated action over their home channel, and await the
 * reply. Returns the resolved decision (defaulting to DENY on timeout / no operator /
 * failed dispatch). Never throws.
 *
 * Fail-closed short-circuits (all return DENY without opening an approvable window):
 *   • no operator configured  → nobody can legitimately approve.
 *   • the outbound push fails  → the operator never saw the request.
 */
export async function requestOperatorApproval(
  req: ApprovalRequest,
  deps: ApprovalRequestDeps
): Promise<ApprovalOutcome> {
  const actionId = req.actionId ?? randomUUID()
  const audit = deps.audit ?? defaultApprovalAudit
  const operator = deps.operator

  if (!operator || !operator.channelId || !operator.userId) {
    audit({ phase: 'denied', actionId, channelId: operator?.channelId ?? '', source: 'no-operator', tool: req.tool })
    return { decision: 'deny', source: 'no-operator', actionId }
  }

  // Register the interaction (single-use + expiry substrate) BEFORE dispatch so a
  // very fast reply can't race a not-yet-created record.
  const interaction = createInteraction({
    channelId: operator.channelId,
    userId: operator.userId,
    kind: APPROVAL_KIND,
    prompt: req.summary,
    payload: { actionId, tool: req.tool ?? null, summary: req.summary },
    ttlMs: deps.timeoutMs
  })

  // Arm the waiter before the (awaited) dispatch, so a reply that lands during
  // dispatch still finds a waiter to settle.
  const waiter = awaitApproval(actionId, deps.timeoutMs)

  const body =
    `Approval needed: ${req.summary}\n\n` +
    `Reply YES to approve or NO to deny. This expires in ${timeoutLabel(deps.timeoutMs)} (default: deny).`

  let disp: DispatchResult
  try {
    disp = await deps.dispatch(deps.homeChannel, body)
  } catch (e) {
    disp = { ok: false, kind: deps.homeChannel.kind, error: messageOf(e) }
  }

  if (!disp.ok) {
    // The operator never received the request → don't leave an approvable window.
    cancelInteraction(interaction.id)
    settleApproval(actionId, 'deny', 'dispatch-failed')
    audit({ phase: 'denied', actionId, channelId: operator.channelId, source: 'dispatch-failed', operator: operator.userId, tool: req.tool })
    return waiter
  }

  audit({ phase: 'requested', actionId, channelId: operator.channelId, operator: operator.userId, tool: req.tool })

  const outcome = await waiter
  // Best-effort: if we timed out, make sure the stale interaction can't be resolved
  // by a very-late reply after we've already returned DENY.
  if (outcome.source === 'timeout') {
    cancelInteraction(interaction.id)
    audit({ phase: 'expired', actionId, channelId: operator.channelId, operator: operator.userId, source: 'timeout', tool: req.tool })
  }
  return outcome
}

// ──────────────────── resolver (consumer side, called from channel-runtime) ────────────────────

export type ApprovalReplyResult =
  | { status: 'none' }
  | { status: 'refused'; interaction: PendingInteraction }
  | { status: 'ambiguous'; interaction: PendingInteraction }
  | { status: 'expired' }
  | { status: 'decided'; decision: ApprovalDecision; interaction: PendingInteraction }

export interface ResolveApprovalInput {
  channelId: string
  userId: string
  text: string
  now?: number
}

export interface ResolveApprovalDeps {
  operator: OperatorIdentity | null
  audit?: ApprovalAudit
}

/**
 * Offer an inbound reply to the OPERATOR-GATED approval path. Called by the channel
 * runtime BEFORE the generic nudge reply routing.
 *
 * Returns:
 *   • 'none'      — no pending approval on this channel; caller proceeds normally.
 *   • 'refused'   — a pending approval exists but the replier is NOT the operator.
 *                   The interaction is NOT consumed; caller may treat the message as
 *                   ordinary chat. (Audited.)
 *   • 'ambiguous' — the operator replied but the text isn't a clear yes/no. NOT
 *                   consumed; caller should re-ask.
 *   • 'expired'   — the matched interaction lapsed between listing and resolving.
 *   • 'decided'   — the operator approved/denied; the specific action's waiter has
 *                   been settled and the interaction consumed (single-use).
 *
 * The action-id binding: we resolve the OLDEST open approval for the channel and
 * settle EXACTLY its payload.actionId — never a different or broader pending action.
 */
export function resolveApprovalReply(
  input: ResolveApprovalInput,
  deps: ResolveApprovalDeps
): ApprovalReplyResult {
  const now = input.now ?? Date.now()
  const audit = deps.audit ?? defaultApprovalAudit

  const open = listOpen({ channelId: input.channelId, kind: APPROVAL_KIND }, now)
  const target = open[0]
  if (!target) return { status: 'none' }

  const actionId = String((target.payload as Record<string, unknown>).actionId ?? '')
  const tool =
    typeof (target.payload as Record<string, unknown>).tool === 'string'
      ? ((target.payload as Record<string, unknown>).tool as string)
      : undefined

  // (a) OPERATOR GATE — deny-first. A non-operator reply is refused and NOT allowed
  //     to consume the interaction (so it can't be replay-burned by a paired chatter).
  if (!isDesignatedOperator(deps.operator, input.channelId, input.userId)) {
    audit({
      phase: 'refused-non-operator',
      actionId,
      channelId: input.channelId,
      by: input.userId,
      operator: deps.operator?.userId,
      tool
    })
    return { status: 'refused', interaction: target }
  }

  // The operator replied — parse the decision. Ambiguous → don't consume; re-ask.
  const decision = parseApprovalReply(input.text)
  if (!decision) {
    audit({ phase: 'ambiguous', actionId, channelId: input.channelId, by: input.userId, operator: deps.operator?.userId, tool })
    return { status: 'ambiguous', interaction: target }
  }

  // (b) Resolve exactly THIS interaction (single-use + expiry + kind-checked).
  const resolved = resolveById(target.id, input.text, now, { expectKind: APPROVAL_KIND })
  if (!resolved) return { status: 'expired' }

  // Settle exactly this action's waiter — never a different/broader one.
  settleApproval(actionId, decision, decision === 'approve' ? 'operator-approve' : 'operator-deny')
  audit({
    phase: decision === 'approve' ? 'approved' : 'denied',
    actionId,
    channelId: input.channelId,
    by: input.userId,
    operator: deps.operator?.userId,
    source: 'operator-reply',
    tool
  })
  return { status: 'decided', decision, interaction: resolved }
}
