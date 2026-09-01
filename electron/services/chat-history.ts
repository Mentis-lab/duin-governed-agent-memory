import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import type { StoredToolCall } from './conversation-store'
import type { VisionContentPart } from '../shared/chat-send-contract'
import { resolveModel } from './providers/registry'
import { readSettings } from './settings-helper'

export interface StoredChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: StoredToolCall[]
  /** Reasoning Audit Phase R8 — chain-of-thought the model produced
   *  on the turn that wrote this row. When the `includePastReasoningInContext`
   *  setting is enabled (default), `buildApiMessagesFromStoredMessages`
   *  prepends this as `<think>…</think>` inside the assistant content so
   *  the model on the NEXT turn can see its own prior thinking. Closes
   *  the "no session history tool exists" gap the debug-session audit
   *  surfaced. NULL on legacy rows (single-agent without thinking, or
   *  any row written pre-R5) — those go through unchanged. */
  reasoning?: string
  /** Vision attachments persisted with this turn (`messages.content_parts`).
   *  `content` still holds the turn's TEXT; these are the parts that have no text
   *  form. Present only on user rows that carried an image. */
  contentParts?: VisionContentPart[]
}

const DEEPSEEK_V4_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash'])

/** How many of the most recent image-bearing turns are replayed on the raw path.
 *  Mirrors HISTORY_MAX_IMAGE_MSGS on the brain path — same reasoning, same number. */
const MAX_REPLAYED_IMAGE_TURNS = 2

function modelNeedsReasoningContentField(modelId?: string): boolean {
  if (!modelId) return false
  return DEEPSEEK_V4_MODELS.has(modelId)
}

/** Reasoning Audit Phase R8 — read the `includePastReasoningInContext`
 *  setting from `userData/settings.json`. Defaults to `true` per the
 *  user's audit-priority direction (2026-06-06). Returns false ONLY when
 *  the user has explicitly disabled it via Settings → Reasoning Audit
 *  panel. The setting trades API token cost (each rehydrated `<think>`
 *  block inflates context) for audit transparency. */
function shouldIncludePastReasoning(): boolean {
  try {
    const raw = readSettings()
    const v = (raw as { includePastReasoningInContext?: unknown })
      .includePastReasoningInContext
    if (v === false) return false
    return true
  } catch {
    return true
  }
}

function toApiToolCalls(toolCalls: StoredToolCall[] | undefined): StoredToolCall[] {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls.filter(
    (tc) =>
      tc?.type === 'function' &&
      typeof tc.id === 'string' &&
      tc.id.trim().length > 0 &&
      typeof tc.function?.name === 'string' &&
      typeof tc.function?.arguments === 'string'
  )
}

/**
 * Convert persisted rows into the strict OpenAI chat message sequence.
 *
 * Providers require an assistant message with tool_calls to be followed by
 * one tool message for every tool_call_id before any other role appears. Old
 * or interrupted conversations can miss one side of that pair, so we buffer a
 * tool-call block until it is complete; incomplete blocks are dropped instead
 * of poisoning the next request.
 */
/** Reasoning Audit Phase R8 — when the setting is on, prepend the row's
 *  reasoning as a leading `<think>…</think>` block inside the assistant
 *  content (provided the content doesn't already start with `<think>`,
 *  which would double-tag inline-emitter rows). The model on the next
 *  turn sees the prior chain-of-thought as if it had emitted it itself.
 *
 *  When the setting is off, or the row has no reasoning, or the content
 *  already opens with `<think>`, the content is passed through unchanged. */
function reasoningRehydratedContent(
  content: string,
  reasoning: string | undefined,
  enabled: boolean
): string {
  if (!enabled) return content
  if (!reasoning || reasoning.length === 0) return content
  if (/^\s*<think>/i.test(content)) return content
  return `<think>${reasoning}</think>\n\n${content}`
}

export function buildApiMessagesFromStoredMessages(
  systemPrompt: string,
  storedMessages: StoredChatMessage[],
  modelId?: string
): ChatCompletionMessageParam[] {
  const apiMessages: ChatCompletionMessageParam[] = [
    { role: 'system' as const, content: systemPrompt }
  ]
  const includePastReasoning = shouldIncludePastReasoning()
  const useReasoningField = modelNeedsReasoningContentField(modelId)

  // Vision replay on the raw/headless path needs the same two guards the brain path
  // has, and for the same reasons:
  //
  //  1. CAPABILITY. This path rebuilds from stored rows, so once a thread contains an
  //     image every later turn would replay it — including after the user switches the
  //     picker to a text-only model, where an image_url block is not "ignored" but
  //     REJECTED, failing the whole turn. Stored rows were text-only before
  //     content_parts existed, so this failure is new and must be closed here.
  //  2. VOLUME. Unbounded replay re-uploads every image the thread ever held, on every
  //     turn, forever. Bound it the same way brain-history does.
  const modelSeesImages = modelId ? resolveModel(modelId).supportsVision !== false : false
  const imageTurnIdx = modelSeesImages
    ? storedMessages.reduce<number[]>((acc, m, i) => {
        if (m.role === 'user' && m.contentParts?.length) acc.push(i)
        return acc
      }, [])
    : []
  const replayImagesAt = new Set(imageTurnIdx.slice(-MAX_REPLAYED_IMAGE_TURNS))

  let pendingAssistant:
    | (ChatCompletionMessageParam & { tool_calls: Array<{ id: string }> })
    | null = null
  let pendingToolIds = new Set<string>()
  let pendingTools: ChatCompletionMessageParam[] = []

  const flushPending = () => {
    if (!pendingAssistant) return
    if (pendingToolIds.size === 0) {
      apiMessages.push(pendingAssistant as ChatCompletionMessageParam, ...pendingTools)
    }
    pendingAssistant = null
    pendingToolIds = new Set()
    pendingTools = []
  }

  for (const [i, m] of storedMessages.entries()) {
    if (m.role === 'system') {
      // Compression summaries (context-compressor / model-compaction) are
      // stored as system rows STANDING IN for the history they hide. They
      // must reach the model or compaction is silent history deletion —
      // the effective view has already dropped the originals. Other stored
      // system rows (renderer-facing notes) stay request-invisible as
      // before.
      if (m.content?.startsWith('<conversation_summary>')) {
        flushPending()
        apiMessages.push({ role: 'system' as const, content: m.content })
      }
      continue
    }

    if (pendingAssistant) {
      if (m.role === 'tool' && m.toolCallId && pendingToolIds.has(m.toolCallId)) {
        pendingTools.push({
          role: 'tool' as const,
          content: m.content,
          tool_call_id: m.toolCallId
        })
        pendingToolIds.delete(m.toolCallId)
        continue
      }
      flushPending()
    }

    if (m.role === 'tool') {
      continue
    }

    if (m.role === 'assistant') {
      const toolCalls = toApiToolCalls(m.toolCalls)
      const rehydratedContent = useReasoningField
        ? m.content
        : reasoningRehydratedContent(m.content, m.reasoning, includePastReasoning)
      const reasoningField = useReasoningField && m.reasoning
        ? m.reasoning
        : undefined
      if (toolCalls.length > 0) {
        pendingAssistant = {
          role: 'assistant' as const,
          content: rehydratedContent || null,
          ...(reasoningField && { reasoning_content: reasoningField }),
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments }
          }))
        } as ChatCompletionMessageParam & { tool_calls: Array<{ id: string }> }
        pendingToolIds = new Set(toolCalls.map((tc) => tc.id))
      } else {
        apiMessages.push({
          role: 'assistant' as const,
          content: rehydratedContent,
          ...(reasoningField && { reasoning_content: reasoningField })
        } as ChatCompletionMessageParam)
      }
      continue
    }

    // A user turn with persisted vision parts is rebuilt into the OpenAI
    // multimodal form. Without this the `raw:` provider path silently discarded
    // every image — it rebuilds its messages from stored rows, and stored rows
    // used to be text-only. Absent parts ⇒ a plain string, byte-for-byte as before.
    apiMessages.push(
      m.contentParts?.length && replayImagesAt.has(i)
        ? {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: m.content }, ...m.contentParts]
          }
        : { role: 'user' as const, content: m.content }
    )
  }

  flushPending()
  return apiMessages
}
