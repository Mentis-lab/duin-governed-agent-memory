// Channel runtime — run ONE inbound channel turn through the brain, DE-PRIVILEGED.
//
// This is the connectivity security keystone. A channel turn arrives from an
// external surface with no trusted renderer behind it, so it must NOT be able to
// authorize host-exec / destructive / vault-mutating tools. We reuse the exact
// turn engine (streamFromDuin) via its injected-emit seam, but pass
// `execToken: null` so an EMPTY x-duin-exec header goes to the brain → the brain's
// deny-first gate refuses gated tools. We do NOT fork or reimplement the brain's
// streaming logic — only the emit collector and the de-privilege flag are ours.

import { streamFromDuin, type ChatEmit } from '../duin-bridge'
import type { ChannelAdapter, InboundMessage } from './channel-adapter'
import { resolveByReply, type PendingInteraction } from '../proactive/pending-interactions'
import {
  resolveApprovalReply,
  readApprovalConfig,
  type OperatorIdentity,
  type ApprovalAudit
} from '../proactive/approval-roundtrip'
import { handleNudgeReply } from '../proactive/nudges'

/**
 * Run a de-privileged brain turn for one inbound message. Builds a per-channel
 * COLLECTOR emit that accumulates the visible answer (chat:chunk deltas, honoring
 * chat:reset) and returns the final text. No renderer, no IPC broadcast — a
 * channel turn is headless.
 */
export async function runInboundTurn(msg: InboundMessage): Promise<{ text: string; ok: boolean }> {
  let collected = ''
  const emit: ChatEmit = (channel, payload) => {
    if (channel === 'chat:chunk') {
      collected += (payload as { content: string }).content
    } else if (channel === 'chat:reset') {
      // Brain discarded a tool-call preamble and is re-streaming clean prose.
      collected = ''
    }
  }

  const result = await streamFromDuin(msg.text, msg.threadId, {
    emit,
    threadId: msg.threadId,
    // SECURITY KEYSTONE — de-privileged. null → streamFromDuin attaches an EMPTY exec
    // header (it does NOT resolve getBrainExecToken()), so this turn never carries the
    // per-launch exec token no matter what token the running brain minted. THE REAL RULE:
    // that keeps every gated tool behind the deny-first exec-token rule ONLY while
    // `fullComputerAccess` is OFF (the public default). When the operator turns full access
    // ON, agui-gate.ts authorizes the LOCAL computer surface (run/start_command, delete/move,
    // vault-escaping write_file) for EVERY turn INCLUDING this one, regardless of the empty
    // header — an inbound paired message can then run host commands unattended. External
    // effects (send_email, MCP tools, spawn_agent, create_skill, delegate_task) stay behind
    // the token in both modes. Pinned by agui-gate-full-access.test.ts.
    execToken: null
  })

  // result.text is the authoritative accumulator inside streamFromDuin; the local
  // collector is the spec'd per-channel seam and a resilient fallback if a future
  // caller wants to observe deltas. They agree in practice.
  return { text: result.text || collected, ok: result.ok }
}


/**
 * Full inbound path for one message: pairing gate → (two-way primitive) → turn.
 * The adapter's authorizeUser() consults the pairing store (deny-first). Only an
 * 'approved' user proceeds; 'pending' / 'denied' are dropped here.
 *
 * TWO-WAY: an approved user's message is FIRST offered to resolveByReply(). If it
 * resolves an open pending interaction for this exact (channel, user), the reply is
 * routed to that interaction (acknowledged, NOT run as a fresh de-privileged turn) —
 * this is how an approval/nudge round-trip closes. Only when nothing is pending does
 * the message fall through to a fresh de-privileged brain turn. The pairing gate is
 * always first, so a non-approved user can never resolve an interaction.
 *
 * Returns the outcome so a caller/test can assert what happened.
 */
export interface HandleInboundDeps {
  /** The designated operator for approval replies. `undefined` → read from
   *  settings; explicit `null` → no operator (used by tests). */
  operator?: OperatorIdentity | null
  /** Override the audit sink (tests). */
  audit?: ApprovalAudit
}

/** Resolve the operator for approval routing: explicit dep wins, else settings. */
function resolveOperator(deps: HandleInboundDeps): OperatorIdentity | null {
  if (deps.operator !== undefined) return deps.operator
  try {
    return readApprovalConfig().operator
  } catch {
    return null
  }
}

export async function handleInbound(
  adapter: ChannelAdapter,
  msg: InboundMessage,
  deps: HandleInboundDeps = {}
): Promise<{
  status: 'sent' | 'unauthorized' | 'empty' | 'resolved' | 'clarify'
  text?: string
  interaction?: PendingInteraction
  approval?: 'approve' | 'deny'
}> {
  const auth = await adapter.authorizeUser(msg.userId)
  if (auth !== 'approved') return { status: 'unauthorized' }

  // (1) OPERATOR-GATED APPROVAL first. An 'approval' interaction can ONLY be
  // resolved by the designated operator's clear yes/no. A non-operator reply is
  // refused (not consumed) and falls through to ordinary handling; an ambiguous
  // operator reply is re-asked without consuming the pending approval.
  const operator = resolveOperator(deps)
  const appr = resolveApprovalReply(
    { channelId: msg.channelId, userId: msg.userId, text: msg.text },
    { operator, audit: deps.audit }
  )
  if (appr.status === 'decided') {
    const ack =
      appr.decision === 'approve'
        ? 'Approved — releasing the pending action.'
        : 'Denied — the pending action was blocked.'
    await adapter.send(msg.userId, ack)
    // NO fresh turn, and — critically — this reply only settled the ORIGINAL turn's
    // gate decision; it did not itself run or authorize anything.
    return { status: 'resolved', text: ack, interaction: appr.interaction, approval: appr.decision }
  }
  if (appr.status === 'ambiguous') {
    const ack = 'Reply YES to approve or NO to deny the pending action.'
    await adapter.send(msg.userId, ack)
    return { status: 'clarify', text: ack, interaction: appr.interaction }
  }
  // 'none' | 'refused' | 'expired' → fall through to the generic path below.

  // (2) Generic two-way primitive — NUDGE interactions only, so this can never
  // consume an operator-gated approval. Scoped by (channelId, userId), single-use.
  const resolved = resolveByReply(msg.channelId, msg.userId, msg.text, Date.now(), {
    kinds: ['nudge']
  })
  if (resolved) {
    // The reply resolved (single-use, scope-checked) a pending nudge; drive its
    // in-process follow-up. handleNudgeReply never throws and returns the ack text
    // (a custom follow-up message, or a neutral ack if no handler is registered).
    const ack = await handleNudgeReply(resolved, msg.text)
    await adapter.send(msg.userId, ack)
    return { status: 'resolved', text: ack, interaction: resolved }
  }

  const { text, ok } = await runInboundTurn(msg)
  if (!ok || !text.trim()) return { status: 'empty' }

  await adapter.send(msg.userId, text)
  return { status: 'sent', text }
}
