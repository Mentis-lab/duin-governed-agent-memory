import { elideMiddle } from './elide-middle'

// brain-history — bound the conversation history sent to the DUIN brain so multi-turn
// context is DURABLE over long chats. Without history the brain is stateless per turn (it
// only ever saw the latest message + retrieval grounding), so a follow-up like "yes, save
// it" had no memory of the note just made. Sending the WHOLE thread would overflow the
// context window on a long chat, so this keeps the most-recent turns within a char budget,
// caps the count, and truncates any single huge message — always keeping ≥ the latest turn.
// PURE + unit-tested.

export const HISTORY_MAX_MSGS = 40
export const HISTORY_MAX_CHARS = 24000
export const HISTORY_PER_MSG_CAP = 8000

/**
 * Per-message cap for the NEWEST assistant turn.
 *
 * That turn is the one the operator is almost always reacting to — "resume", "continue",
 * "finish it", "now save that". Capping it like any other message is what broke a real
 * session (2026-08-05): the assistant had emitted a 15,564-char document inline, the
 * operator typed "resume", and the 8,000-char cap handed the model back its OWN document
 * severed at `### 16. \`lamprey.db\` (SQ` — mid-word, inside a heading. The model reported
 * exactly what it saw ("the file write got cut off mid-section 16"), promised to finish,
 * and could not: the remaining 7,564 characters were not in its context to finish FROM.
 *
 * Held at HISTORY_MAX_CHARS so the newest answer can be carried whole while the total
 * budget still binds — a long answer evicts older turns rather than being cut itself,
 * which is the right trade when the operator is continuing that answer.
 */
export const HISTORY_LAST_ASSISTANT_CAP = HISTORY_MAX_CHARS

/**
 * Cache-aligned eviction step (opt-in via `evictChunk`; see `buildBrainHistory`).
 *
 * The default window slides by ONE message per turn once the budget binds, which means the FIRST
 * message of the history changes every turn. For a provider prefill cache that is fatal: caching is
 * prefix-anchored, so a front that shifts every turn means the shared prefix is destroyed on every
 * request past the cap — exactly in the long threads where caching should pay the most. Snapping
 * the window start UP to a multiple of this chunk holds the front byte-stable for a run of turns
 * and then evicts in one coarse step, so the prefix is reusable between evictions instead of never.
 *
 * 8 messages ≈ 4 exchanges of stability per eviction. Larger = better cache reuse but a bigger
 * context drop at each eviction; the value is a trade, not a tuning constant to maximise.
 */
export const HISTORY_EVICT_CHUNK = 8

/**
 * How many of the most recent image-bearing turns keep their images on replay.
 *
 * Images are base64 data URLs — a single screenshot dwarfs HISTORY_MAX_CHARS. Replaying every image
 * a thread ever contained would therefore cost more than the entire text budget, every turn, and
 * grow without bound. Keeping the most recent few preserves "what was in that picture?" follow-ups
 * (the reason images are persisted at all) while keeping the payload bounded.
 */
export const HISTORY_MAX_IMAGE_MSGS = 2

export interface HistoryMsg {
  role: string
  content: string
  /**
   * Vision attachments for this turn. Deliberately NOT counted against the char budget: the budget
   * exists to bound the TEXT context window, and measuring a data URL's length against it would
   * evict the whole conversation the moment anyone attached a screenshot. Images are bounded by
   * count instead — see HISTORY_MAX_IMAGE_MSGS.
   */
  parts?: { type: 'image_url'; image_url: { url: string } }[]
}

/** Recent user/assistant turns within the budget, oldest→newest. */
export function buildBrainHistory(
  messages: HistoryMsg[],
  opts: {
    maxMsgs?: number
    maxChars?: number
    perMsgCap?: number
    lastAssistantCap?: number
    evictChunk?: number
    maxImageMsgs?: number
  } = {}
): HistoryMsg[] {
  const maxMsgs = opts.maxMsgs ?? HISTORY_MAX_MSGS
  const maxChars = opts.maxChars ?? HISTORY_MAX_CHARS
  const perMsgCap = opts.perMsgCap ?? HISTORY_PER_MSG_CAP
  const evictChunk = opts.evictChunk ?? 0
  const lastAssistantCap = opts.lastAssistantCap ?? HISTORY_LAST_ASSISTANT_CAP
  const filtered = messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && (m.content ?? '').trim()
  )
  // The newest assistant turn is the one a follow-up continues FROM, so it gets the
  // larger cap. See HISTORY_LAST_ASSISTANT_CAP.
  let newestAssistant = -1
  for (let i = filtered.length - 1; i >= 0; i--) {
    if (filtered[i].role === 'assistant') {
      newestAssistant = i
      break
    }
  }
  const usable = filtered.map((m, i) => ({
    role: m.role,
    content: elideMiddle(m.content, i === newestAssistant ? lastAssistantCap : perMsgCap),
    ...(m.parts?.length ? { parts: m.parts } : {})
  }))
  const kept: HistoryMsg[] = []
  let chars = 0
  for (let i = usable.length - 1; i >= 0 && kept.length < maxMsgs; i--) {
    const len = usable[i].content.length
    if (kept.length > 0 && chars + len > maxChars) break // keep ≥ the latest turn
    kept.push(usable[i])
    chars += len
  }
  kept.reverse()

  // Cache-aligned eviction (opt-in). `kept` currently starts at the oldest message that still fits,
  // which advances by one every turn once the budget binds. Snap that start FORWARD to the next
  // chunk boundary so it only moves in coarse steps and stays byte-stable in between. Snapping
  // forward (never backward) can only drop messages, so the budget is still respected. The newest
  // message is always preserved, mirroring the ≥-latest-turn guarantee above.
  if (evictChunk > 1 && kept.length < usable.length) {
    const start = usable.length - kept.length
    const aligned = Math.min(Math.ceil(start / evictChunk) * evictChunk, usable.length - 1)
    if (aligned > start) return capImages(usable.slice(aligned), opts.maxImageMsgs)
  }
  return capImages(kept, opts.maxImageMsgs)
}

/**
 * Keep images on only the most recent `max` image-bearing turns; older turns keep their text and
 * lose their attachments. Returns the input untouched when nothing exceeds the cap, so a text-only
 * thread is byte-for-byte unchanged and allocates nothing extra.
 */
export function capImages(msgs: HistoryMsg[], max = HISTORY_MAX_IMAGE_MSGS): HistoryMsg[] {
  const withImages: number[] = []
  for (let i = 0; i < msgs.length; i++) if (msgs[i].parts?.length) withImages.push(i)
  if (withImages.length <= max) return msgs
  const keep = new Set(withImages.slice(-max))
  return msgs.map((m, i) => {
    if (!m.parts?.length || keep.has(i)) return m
    const { parts: _dropped, ...rest } = m
    return rest
  })
}
