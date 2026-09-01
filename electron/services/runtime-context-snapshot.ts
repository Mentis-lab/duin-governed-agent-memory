// Runtime-context snapshot (A2b, dsh graft — chat-loop half of the
// DUIN_STABLE_PREFIX layout).
//
// The chat loop injected four PER-TURN-VOLATILE blocks into the SYSTEM
// prompt (retrieved context, task notifications, memory index, chapters).
// Any RAG turn, task change, or memory write therefore rewrote message[0]
// and invalidated the provider's cached prefix for the ENTIRE conversation
// — the exact anti-pattern the /agui half of the stable layout already
// fixed (prompt-layout.mjs, efficiency campaign §5.1).
//
// Under DUIN_STABLE_PREFIX=1 the blocks move here instead: one combined
// snapshot PREPENDED INTO the final user message's content — the same
// tail-rides-the-last-user-message layout the /agui half uses
// (prompt-layout.mjs), and for the same reasons: no consecutive-user
// alternation break on Anthropic-via-OpenRouter, and the message
// IMMEDIATELY BEFORE the last user message stays stable history, which
// is exactly where prefill-cache.ts plants its second Anthropic cache
// breakpoint. A separate spliced user message (this module's first
// design) put volatile bytes on that breakpoint and broke alternation —
// reviewed out 2026-08-15. The system prompt and the whole retained
// history stay byte-stable; a changed snapshot busts only the final
// message. The "supersedes earlier snapshots" framing is dsh's: models
// treat the latest snapshot as current without the earlier prefix ever
// moving.
//
// Pure module: no electron imports; structural message type so both the
// chat loop and the headless runner (and tests) can use it.

export interface RuntimeContextBlocks {
  retrievedContextBlock?: string
  taskNotificationsBlock?: string
  memoryIndexBlock?: string
  chaptersBlock?: string
}

const SECTION_ORDER: Array<{ key: keyof RuntimeContextBlocks; label: string }> = [
  { key: 'memoryIndexBlock', label: 'MEMORY INDEX' },
  { key: 'chaptersBlock', label: 'CHAPTERS' },
  { key: 'taskNotificationsBlock', label: 'TASK NOTIFICATIONS' },
  { key: 'retrievedContextBlock', label: 'RETRIEVED CONTEXT' }
]

/**
 * Combine the volatile blocks into one user-role snapshot body, or return
 * undefined when every block is empty (no message is inserted — an empty
 * snapshot would itself be prefix noise).
 */
export function buildRuntimeContextSnapshot(
  blocks: RuntimeContextBlocks
): string | undefined {
  const sections: string[] = []
  for (const { key, label } of SECTION_ORDER) {
    const value = (blocks[key] ?? '').trim()
    if (value) sections.push(`## ${label}\n${value}`)
  }
  if (sections.length === 0) return undefined
  return (
    '<runtime_context>\n' +
    'Current runtime context. This snapshot supersedes any earlier runtime-context snapshot in this conversation.\n\n' +
    sections.join('\n\n') +
    '\n</runtime_context>'
  )
}

/** Structural slice of an OpenAI-shaped message — enough to place the
 *  snapshot without importing provider types. */
export interface SnapshotTargetMessage {
  role: string
  content?: unknown
}

/**
 * Place the runtime snapshot into an already-built apiMessages array,
 * mutating it in place. Returns true when a snapshot was inserted.
 *
 * Placement: PREPEND into the last user message's content (string or
 * vision-parts array). Degenerate case (no user message at all — e.g.
 * compression hid every user row): append a trailing SYSTEM message,
 * mirroring prompt-layout.mjs's degenerate case, so the snapshot is never
 * mistaken for the user's prompt.
 */
export function applyRuntimeSnapshotToApiMessages(
  apiMessages: SnapshotTargetMessage[],
  blocks: RuntimeContextBlocks
): boolean {
  const snapshot = buildRuntimeContextSnapshot(blocks)
  if (!snapshot) return false
  for (let i = apiMessages.length - 1; i >= 0; i--) {
    const m = apiMessages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') {
      m.content = `${snapshot}\n\n${m.content}`
    } else if (Array.isArray(m.content)) {
      m.content = [{ type: 'text', text: snapshot }, ...m.content]
    } else {
      m.content = snapshot
    }
    return true
  }
  apiMessages.push({ role: 'system', content: snapshot })
  return true
}
