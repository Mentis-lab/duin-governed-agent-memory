// Pure helpers extracted from chat-store's oversized-file (RAG) attachment path.
//
// They live here rather than in chat-store.ts so they are testable at all: importing
// chat-store pulls model-store and the rest of the renderer graph, which needs browser
// globals this repo's node-only vitest env does not provide (same constraint
// FoundationsSettings.test.tsx documents).

/** A pending chip, narrowed to the two fields these decisions actually read. */
export interface AttachmentLike {
  kind?: string
  collectionId?: string
}

/**
 * After removing a chip, may we unlink `collectionId` from the conversation?
 *
 * Only when NOTHING else still needs it. Every oversized file in one conversation
 * shares a single auto-collection, and removeAttachment unlinked it whenever the
 * removed chip was rag-pending — so attaching three large files and removing the one
 * you didn't want silently stripped RAG grounding from the other two, with no warning.
 * "Remove this chip" had come to mean "unlink the shared collection".
 *
 * `remaining` is the chip list AFTER the removal. PURE.
 */
export function shouldUnlinkCollection(
  remaining: readonly AttachmentLike[],
  collectionId: string | undefined
): boolean {
  if (!collectionId) return false
  return !remaining.some((a) => a.kind === 'rag-pending' && a.collectionId === collectionId)
}

/**
 * Wrap an async factory so concurrent callers share ONE invocation.
 *
 * Dropping several oversized files fired one independent closure per file, and each
 * did `if (!activeConversationId) await createConversation()`. With no conversation
 * open they all observed null before any of them finished, so N files produced N
 * conversations instead of one shared one. The check-then-create pair has to be
 * shared, not repeated.
 *
 * A rejection is not cached — the next caller retries rather than inheriting a
 * failure it never caused.
 */
export function singleFlight<T>(factory: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return () => {
    if (!inFlight) {
      inFlight = factory().catch((err) => {
        inFlight = null
        throw err
      })
    }
    return inFlight
  }
}
