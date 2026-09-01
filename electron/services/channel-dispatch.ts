// channel-dispatch.ts — the OUTBOUND router. Where channel-runtime.ts runs an
// inbound turn, this delivers a piece of text OUT to a destination the caller
// names as a {kind, target} ref:
//
//   kind 'push' / 'os' / 'notification'  → an OS notification (no external creds)
//   kind matching a registered ChannelAdapter (telegram/discord/feishu) → adapter.send()
//   kind 'feishu' (fallback if the adapter registry ever drops it)      → sendFeishuMessage()
//
// It is the single delivery seam shared by the send_message tool (comms-tool-pack)
// and cron→channel delivery (automations-runner). It performs ONE attempt and
// returns a structured result; callers own any retry/backoff policy.
//
// It carries NO exec authority and mints no privilege — it only forwards text to
// a surface. The security gate for WHO may trigger a send lives at the callers
// (the send_message tool's approval gate + backgroundAutonomy; the pairing gate
// on inbound). Dispatch is deny-nothing but does-nothing-privileged.

import { getChannel } from './channels/index'
import { pushNotification } from './notifications-service'
import { sendFeishuMessage } from './brain/feishu-comms-native'
import { larkExec } from './lark-exec'
import { ttsEnabled, synthesizeSpeech } from './tts-service'
import { messageOf } from './guarded'

/** A destination for an outbound message: a channel `kind` + a surface-specific
 *  `target` (chat name, user id, thread id). For OS push, `target` is unused. */
export interface ChannelRef {
  kind: string
  target: string
  /** Wave-3 (opt-in): also synthesize the text to speech. Best-effort + fully
   *  gated (needs the TTS flag on AND a provider key/binary); when unset or the
   *  flag is off, dispatch behaves byte-identically to today. Audio delivery
   *  itself is a human-verify scaffold — synthesis is fire-and-forget here. */
  voice?: boolean
}

export interface DispatchResult {
  ok: boolean
  /** The normalized kind we routed to (lower-cased). */
  kind: string
  error?: string
}

/** Optional delivery extras — attachments (local file paths) so a produced
 *  artifact (pdf/html) can ride along, plus email-specific header fields for the
 *  `email`/`gmail` kind. All fields are optional; omitting `opts` entirely keeps
 *  dispatch byte-identical to the text-only path. */
export interface DispatchOptions {
  /** Local file paths to attach. Delivered where the surface supports files
   *  (email always; a ChannelAdapter only if it implements `sendFile`); otherwise
   *  dropped best-effort while the text still goes out. */
  attachments?: string[]
  /** Email subject (email/gmail kind). Falls back to the first line of the body. */
  subject?: string
  /** Render the email body as HTML (email/gmail kind). */
  html?: boolean
  /** Cc recipients (email/gmail kind). */
  cc?: string | string[]
  /** Where clicking the delivered notification should land, e.g. `duin://tool/loop`.
   *  Honoured by the OS-push path; other surfaces carry their own affordances. */
  deepLink?: string | null
  /** Notification title for the OS-push path. Defaults to "DUIN", which is what every
   *  proactive message used to say regardless of what it was about. */
  title?: string
}

/** kinds that map to an OS notification rather than an external channel. */
const PUSH_KINDS = new Set(['push', 'os', 'notification', 'notify'])

/** kinds that deliver over email (Gmail send), where `target` is the recipient. */
const EMAIL_KINDS = new Set(['email', 'gmail', 'mail'])

/** Derive an email subject: explicit override, else the first non-empty body line
 *  (trimmed, capped), else a sensible default. PURE. */
export function deriveSubject(body: string, explicit?: string): string {
  const s = String(explicit ?? '').trim()
  if (s) return s
  const firstLine = String(body ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (firstLine) return firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine
  return 'Message from DUIN'
}

/**
 * Deliver `text` to `ref`. ONE attempt, never throws — the outcome is always a
 * structured DispatchResult so a scheduler/tool can decide whether to retry.
 */
export async function channelDispatch(
  ref: ChannelRef,
  text: string,
  opts?: DispatchOptions
): Promise<DispatchResult> {
  const kind = String(ref?.kind ?? '').trim().toLowerCase()
  const target = String(ref?.target ?? '')
  const body = String(text ?? '').trim()
  const attachments = (opts?.attachments ?? []).filter((p) => typeof p === 'string' && p.trim())
  if (!body) return { ok: false, kind, error: 'empty message' }

  // Wave-3 voice (opt-in, flag-gated): best-effort speech synthesis alongside the
  // text delivery. Fire-and-forget — a synthesis failure NEVER affects the text
  // dispatch result below. Actual audio playback/attachment is a human-verify
  // scaffold; here we only kick synthesis so the wiring is exercised end-to-end.
  if (ref?.voice && ttsEnabled()) {
    void synthesizeSpeech(body)
      .then((r) => {
        if (!r.ok) console.debug('[channel-dispatch] tts skipped:', r.error)
      })
      .catch((e) => console.debug('[channel-dispatch] tts error:', messageOf(e)))
  }

  try {
    // 1) OS push — always available, needs no external credential. Attachments
    //    have no meaning on an OS notification; the text still delivers.
    if (PUSH_KINDS.has(kind)) {
      // Proactive messages used to arrive titled "DUIN" with no link, so the toast said
      // nothing at a glance and clicking it went nowhere. The caller names the title
      // (it knows what kind of thing this is) and supplies the link; deriving a title
      // from the body here would just print the same sentence twice.
      const r = pushNotification({
        title: opts?.title?.trim() || 'DUIN',
        body,
        ...(opts?.deepLink ? { deepLink: opts.deepLink } : {})
      })
      return { ok: r.shown, kind, error: r.shown ? undefined : r.reason }
    }

    // 1b) Email (Gmail send) — `target` is the recipient. Carries attachments
    //     natively (the produced artifact rides along). Lazy-imported so this
    //     module stays free of the Google-auth/keychain graph at load time.
    if (EMAIL_KINDS.has(kind)) {
      if (!target.trim()) return { ok: false, kind, error: 'email requires a recipient (target)' }
      const { sendGmail } = await import('./output/gmail-send')
      const r = await sendGmail(target, deriveSubject(body, opts?.subject), body, {
        html: opts?.html,
        cc: opts?.cc,
        attachments
      })
      return { ok: r.ok, kind, error: r.ok ? undefined : r.error }
    }

    // 2) A registered ChannelAdapter (telegram / discord / feishu). Delivery is
    //    shaped to the adapter contract: send(to, text). When attachments are
    //    present and the adapter can carry files, use sendFile; otherwise fall
    //    back to send() (text delivers, files dropped best-effort).
    const adapter = getChannel(kind)
    if (adapter) {
      // EGRESS readiness, not inbound readiness. `isConfigured()` answers "may the
      // gateway START this adapter", and for Feishu that means "is there an inbound
      // watchlist" — an unrelated, inbound-only setting. Gating sends on it refused
      // every DUIN-driven Feishu delivery on installs without a watchlist (the common
      // outbound-only case) with "channel feishu is not configured", while the very
      // same send mechanism worked. Adapters whose single credential governs both
      // directions (telegram, discord) don't define canSend and keep today's answer.
      const sendable = typeof adapter.canSend === 'function' ? adapter.canSend() : adapter.isConfigured()
      if (!sendable) {
        return { ok: false, kind, error: `channel ${kind} is not configured` }
      }
      if (attachments.length > 0 && typeof adapter.sendFile === 'function') {
        await adapter.sendFile(target, body, attachments)
      } else {
        await adapter.send(target, body)
      }
      // `ok: true` rests entirely on the ChannelAdapter.send contract: resolving
      // means delivered, failing means throwing (the catch below turns that into
      // ok:false). There is no result type to consult. All three adapters used to
      // swallow their own errors and return, so a bad token / rate limit / blocked
      // bot reported as delivered and every caller's retry logic was dead code.
      return { ok: true, kind }
    }

    // 3) Feishu fallback via the native lark-cli comms — reached only if the
    //    channel registry no longer carries a 'feishu' adapter.
    if (kind === 'feishu') {
      const r = await sendFeishuMessage(target, body, false, { exec: larkExec() })
      return { ok: r.ok, kind, error: r.ok ? undefined : r.error || 'send failed' }
    }

    return { ok: false, kind, error: `unknown channel kind: ${kind || '(empty)'}` }
  } catch (e) {
    return { ok: false, kind, error: messageOf(e) }
  }
}
