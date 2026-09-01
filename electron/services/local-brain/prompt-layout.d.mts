// Types for the pure ESM prompt-layout core (shared by agui-grounding + efficiency-benchmark).
export interface StableCoreBlocks {
  /** Response-language directive. Turn-INVARIANT within a thread (the operator's language choice
   *  does not change per turn), so it belongs in the stable core rather than the volatile tail —
   *  putting it in the tail would move a per-turn byte into the cached prefix's shadow for no
   *  reason. Empty for the auto/absent default → dropped from the core, keeping it byte-identical
   *  to today. */
  languageDirective?: string
  /** Static role preamble. MUST NOT embed per-turn content (no query, no retrieval framing). */
  preamble: string
  /** `.brain/` identity grounding — changes only when the user edits `.brain/`. */
  brainGrounding: string
  /** The durable memory index. Changes only when the memory store changes. */
  memoryIndex: string
}

/** A single part of multimodal message content (vision). Mirrors the OpenAI-style
 *  content-part shape the image pipeline produces (see duin-bridge / server). */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant'
  /** A plain string, OR multimodal parts when the turn carries image attachments. */
  content: string | ContentPart[]
}

export interface StableLayoutReport {
  pass: boolean
  coreStable: boolean
  grows: boolean
  noLeak: boolean
  delivered: boolean
}

export function stableCoreOf(blocks: StableCoreBlocks): string
export function layoutStablePrefixMessages(
  core: StableCoreBlocks,
  history: PromptMessage[],
  volatileTail: string
): PromptMessage[]
export function cacheablePrefixOf(msgs: PromptMessage[]): string
export function verifyStableLayout(): StableLayoutReport
