// nudges — TWO-WAY PROACTIVE PROMPTS (#4).
//
// A watch/notify signal (Stage 2) is one-way: DUIN pushes a notice and that is the
// end of it. A NUDGE is two-way: DUIN asks a short question, the operator answers,
// and the answer DRIVES A FOLLOW-UP. Example: the resolution loop notices three
// forecasts are due and nudges "3 forecasts due — want the digest? reply Y"; a Y
// reply triggers the digest delivery.
//
// Mechanism, reusing the Stage-1 substrate:
//   • sendNudge() creates a 'nudge' PendingInteraction (single-use + expiry +
//     (channelId,userId) scoping for free) BOUND TO THE OPERATOR identity, registers
//     an in-process follow-up handler keyed by the interaction id, and dispatches the
//     question through the reliable delivery-queue.
//   • When the operator later replies, the channel runtime's generic two-way path
//     resolveByReply()s the nudge (kinds:['nudge'] — it can NEVER consume an
//     operator-gated 'approval') and calls handleNudgeReply(), which parses the
//     answer and runs the registered follow-up.
//
// SECURITY / scoping:
//   • The nudge is created for the OPERATOR's exact (channelId,userId). resolveByReply
//     only ever matches that pair, so a different paired chatter cannot drive it — the
//     operator-binding IS the gate. sendNudge is FAIL-CLOSED: with no operator
//     configured it creates nothing and sends nothing (no dangling approvable window).
//   • The follow-up handler is IN-PROCESS (a function cannot be persisted). If the app
//     restarts mid-wait, the interaction still expires safely; a late reply that finds
//     no registered handler falls back to a neutral ack and drives nothing. This is the
//     same fail-safe tradeoff as the approval waiter registry.
//   • A nudge NEVER carries exec authority. Its follow-up runs whatever the caller
//     wired (e.g. deliver a digest that was already destined for the operator) — it
//     cannot approve, escalate a de-privileged turn, or run a gated tool.

import {
  createInteraction,
  cancelInteraction,
  type PendingInteraction
} from './pending-interactions'
import type { ChannelRef } from '../channel-dispatch'
import { enqueue, type DeliveryReceipt } from './delivery-queue'
import { parseApprovalReply, type OperatorIdentity } from './approval-roundtrip'
import { messageOf } from '../guarded'

export type NudgeAnswer = 'yes' | 'no' | 'other'

export interface NudgeReplyContext {
  interactionId: string
  question: string
  rawText: string
  answer: NudgeAnswer
}

/** A follow-up driver. Returns an optional custom ack string (else a default ack is
 *  used). May be async. Best-effort: a throw is swallowed and a neutral ack returned. */
export type NudgeReplyHandler = (ctx: NudgeReplyContext) => Promise<string | void> | string | void

// ──────────────────── in-process handler registry ────────────────────

interface Registered {
  handler: NudgeReplyHandler
  question: string
}

const handlers = new Map<string, Registered>()

/** Test/introspection: number of nudges with a live follow-up handler. */
export function pendingNudgeCount(): number {
  return handlers.size
}

/** Test-only: drop all registered follow-up handlers. */
export function __resetNudges(): void {
  handlers.clear()
}

// ──────────────────── answer parsing (pure) ────────────────────

/** Parse a nudge reply into yes / no / other. Reuses the approval yes/no lexicon so
 *  the two reply surfaces agree on what "Y" means. Anything unclear → 'other'. PURE. */
export function parseNudgeAnswer(text: unknown): NudgeAnswer {
  const d = parseApprovalReply(text)
  if (d === 'approve') return 'yes'
  if (d === 'deny') return 'no'
  return 'other'
}

const DEFAULT_NUDGE_ACK = 'Got it — thanks, recorded.'

// ──────────────────── send ────────────────────

export interface SendNudgeInput {
  /** The short question to ask (e.g. "3 forecasts due — want the digest? reply Y"). */
  question: string
  /** A stable tag for this nudge kind (audit / dedup), stored in the payload. */
  nudgeType?: string
  /** Extra opaque payload merged into the interaction record. */
  payload?: Record<string, unknown>
}

export interface SendNudgeDeps {
  /** The designated operator to ask. FAIL-CLOSED: null / blank → nothing is sent. */
  operator: OperatorIdentity | null
  /** Destination channel for the question. */
  ref: ChannelRef
  /** The follow-up driven when the operator replies. */
  onReply: NudgeReplyHandler
  /** Override the delivery seam (else the reliable delivery-queue enqueue). */
  enqueue?: (ref: ChannelRef, text: string, meta: Record<string, unknown>) => Promise<DeliveryReceipt>
  /** Interaction TTL; defaults to the pending-interactions default (15 min). */
  ttlMs?: number
  now?: number
}

export type NudgeSkip = 'no-operator' | 'error'

export interface SendNudgeResult {
  sent: boolean
  interactionId?: string
  receipt?: DeliveryReceipt
  skipped?: NudgeSkip
  error?: string
}

/**
 * Ask the operator a two-way nudge. Registers the follow-up, creates the pending
 * interaction bound to the operator, and dispatches the question reliably. Never
 * throws. FAIL-CLOSED with no operator (creates + sends nothing).
 */
export async function sendNudge(input: SendNudgeInput, deps: SendNudgeDeps): Promise<SendNudgeResult> {
  const op = deps.operator
  if (!op || !op.channelId || !op.userId) {
    return { sent: false, skipped: 'no-operator' }
  }
  const now = deps.now ?? Date.now()
  const question = String(input.question ?? '').trim()
  if (!question) return { sent: false, skipped: 'error', error: 'empty question' }

  let interaction: PendingInteraction
  try {
    interaction = createInteraction({
      channelId: op.channelId,
      userId: op.userId,
      kind: 'nudge',
      prompt: question,
      payload: { nudgeType: input.nudgeType ?? 'generic', ...(input.payload ?? {}) },
      ttlMs: deps.ttlMs,
      now
    })
  } catch (e) {
    return { sent: false, skipped: 'error', error: messageOf(e) }
  }

  // Register the follow-up BEFORE dispatch so a very-fast reply still finds it.
  handlers.set(interaction.id, { handler: deps.onReply, question })
  // Bound the registry: a rare full clear is acceptable (worst case a late reply
  // falls back to the neutral ack) — the interaction store remains the source of truth.
  if (handlers.size > 512) {
    const first = handlers.keys().next().value
    if (first !== undefined && first !== interaction.id) handlers.delete(first)
  }

  const enq =
    deps.enqueue ??
    ((ref: ChannelRef, t: string, meta: Record<string, unknown>) => enqueue(ref, t, { meta, now }))

  let receipt: DeliveryReceipt
  try {
    receipt = await enq(deps.ref, question, { source: 'nudge', interactionId: interaction.id, nudgeType: input.nudgeType ?? 'generic' })
  } catch (e) {
    // Dispatch seam threw (delivery-queue never does, but a test seam might): don't
    // leave an approvable/answerable window the operator never saw.
    cancelInteraction(interaction.id, now)
    handlers.delete(interaction.id)
    return { sent: false, interactionId: interaction.id, skipped: 'error', error: messageOf(e) }
  }

  // A pending (queued-for-retry) receipt is still "sent" from our POV — the delivery
  // queue owns retry, and the interaction window stays open for the reply. Only report
  // sent=receipt.ok, but keep the nudge live either way.
  return { sent: receipt.ok, interactionId: interaction.id, receipt }
}

// ──────────────────── reply driver ────────────────────

/**
 * Drive the follow-up for a resolved nudge interaction. Called by the channel runtime
 * AFTER resolveByReply has already consumed the interaction (single-use). Looks up the
 * in-process handler, parses the answer, runs the follow-up, and returns the ack text
 * to send back. If no handler is registered (e.g. after a restart), returns a neutral
 * ack and drives nothing. Never throws.
 */
export async function handleNudgeReply(
  interaction: PendingInteraction,
  rawText: string
): Promise<string> {
  const reg = handlers.get(interaction.id)
  // Single-use: drop the handler regardless of outcome so a duplicate can't re-fire.
  handlers.delete(interaction.id)
  if (!reg) return DEFAULT_NUDGE_ACK
  const ctx: NudgeReplyContext = {
    interactionId: interaction.id,
    question: reg.question,
    rawText,
    answer: parseNudgeAnswer(rawText)
  }
  try {
    const custom = await reg.handler(ctx)
    return typeof custom === 'string' && custom.trim() ? custom : DEFAULT_NUDGE_ACK
  } catch (e) {
    console.debug('[nudges] follow-up best-effort:', messageOf(e))
    return DEFAULT_NUDGE_ACK
  }
}
