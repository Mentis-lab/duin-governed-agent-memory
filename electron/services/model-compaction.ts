// A3 — model-driven compaction as PREFIX-EXTENSION (deepseek-harness graft,
// 2026-08-15). Flag-gated: DUIN_MODEL_COMPACTION=1, default OFF.
//
// dsh's compaction insight: the summarization request should not be a fresh
// prompt shape — it should be the conversation's OWN request (same system
// prompt, same history, byte-identical) plus ONE trailing user directive.
// Because the request is a pure extension of the prefix the chat loop just
// sent, the provider serves almost the entire summarization input from its
// prefix cache (~10x cheaper on DeepSeek) instead of re-billing the full
// context at cold price.
//
// Placement in the turn (chat.ts):
//   - post-turn, fire-and-forget, on the SAME model as the conversation
//     (the cache is per model+provider — switching models would forfeit the
//     prefix hit and is exactly what this module must not do);
//   - the pre-turn deterministic compressor stays armed as a BACKSTOP at a
//     higher emergency threshold (0.9 vs the normal 0.75), so a dead or
//     misbehaving provider can never let a conversation overflow — the
//     model path merely gets first claim on the 0.75→0.9 band.
//
// Failure policy: any failure (provider error, empty reply, summary not
// actually smaller, concurrent compaction) returns null and persists
// NOTHING. There is no retry — the next turn re-trips the threshold and
// tries again, and the deterministic backstop is the hard floor.

import {
  estimateTokens,
  selectMessagesToCompress,
  shouldCompress,
  persistCompressionSummary,
  DEFAULT_COMPRESS_THRESHOLD_PCT,
  type CompressionResult,
  type CompressorRow
} from './context-compressor'

/** Emergency threshold for the pre-turn deterministic pass while the model
 *  path owns the normal 0.75 trip point. */
export const DETERMINISTIC_BACKSTOP_THRESHOLD_PCT = 0.9

export function modelCompactionEnabled(): boolean {
  return process.env.DUIN_MODEL_COMPACTION === '1'
}

/** Minimal structural slice of ChatCompletionMessageParam this module needs —
 *  keeps the module importable without the openai types (and unit-testable
 *  with plain objects). */
export interface CompactionMessage {
  role: string
  content?: unknown
}

export interface ModelCompactionDeps {
  shouldCompress: (conversationId: string, contextWindow: number, thresholdPct: number) => boolean
  selectMessages: (conversationId: string, contextWindow: number) => CompressorRow[]
  persist: (
    conversationId: string,
    selection: CompressorRow[],
    summaryText: string,
    source: 'model'
  ) => CompressionResult | null
  /** One-shot completion on the conversation's model. `tools` is the SAME
   *  (sorted) tool list the turn's own request carried — the provider
   *  renders tools into the prompt ahead of the messages, so omitting them
   *  would diverge the bytes at position ~0 and forfeit the entire prefix
   *  hit this module exists for. Returns reply content. */
  complete: (
    messages: CompactionMessage[],
    modelId: string,
    conversationId: string,
    tools?: unknown[]
  ) => Promise<string>
}

const ANCHOR_EXCERPT_LEN = 100
const COMPLETION_TIMEOUT_MS = 120_000

/** The trailing directive. The boundary anchor scopes the summary to the
 *  rows that will actually be hidden — everything after the anchor stays in
 *  the conversation verbatim and must NOT be summarized. */
export function buildCompactionDirective(anchorExcerpt: string): string {
  return [
    'Pause the conversation. Produce a compaction summary of the EARLIEST part of this conversation:',
    `everything from the start of the conversation up to and INCLUDING the message whose text contains, at or near its start: "${anchorExcerpt}".`,
    'Do not summarize anything after that message — those messages remain in the conversation verbatim.',
    '',
    'The summary replaces those early messages permanently, so preserve everything a future turn could need:',
    'decisions and their reasons, constraints, names/paths/identifiers, unresolved questions, and user preferences.',
    'Omit pleasantries and dead ends. Write it as compact factual notes.',
    'Reply with ONLY the summary text — no preamble, no code fences, no XML tags.'
  ].join('\n')
}

/** Last selected row with visible content — the scope boundary the model can
 *  actually locate. Rows whose content is empty (pure tool-call rows) cannot
 *  anchor. */
export function pickAnchorRow(selection: CompressorRow[]): CompressorRow | null {
  for (let i = selection.length - 1; i >= 0; i--) {
    if ((selection[i].content ?? '').trim().length > 0) return selection[i]
  }
  return null
}

function excerptOf(row: CompressorRow): string {
  // Collapse whitespace and drop quote-ish delimiters so the excerpt cannot
  // close its own quotation in the directive.
  return (row.content ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[«»"]/g, "'")
    .slice(0, ANCHOR_EXCERPT_LEN)
}

/** Strip any summary-envelope tags the model might have echoed so the wrap
 *  below stays the only envelope. */
function sanitize(text: string): string {
  return text.replace(/<\/?conversation_summary>/g, '').trim()
}

// One compaction per conversation at a time. The persist layer has its own
// stale-row guard, but this keeps us from paying for two overlapping
// summarization calls in the first place.
const inFlight = new Set<string>()

export interface ModelCompactionInput {
  conversationId: string
  contextWindow: number
  modelId: string
  /** The EXACT message array the turn just sent (system + history + final
   *  user message) — the prefix the summarization request extends. */
  apiMessages: CompactionMessage[]
  /** The exact (sorted) tool list the turn's request carried, if any. */
  tools?: unknown[]
  thresholdPct?: number
  minReductionPct?: number
}

export async function runModelCompaction(
  input: ModelCompactionInput,
  deps: ModelCompactionDeps
): Promise<CompressionResult | null> {
  const {
    conversationId,
    contextWindow,
    modelId,
    apiMessages,
    tools,
    thresholdPct = DEFAULT_COMPRESS_THRESHOLD_PCT,
    minReductionPct = 0.05
  } = input

  if (inFlight.has(conversationId)) return null
  if (!deps.shouldCompress(conversationId, contextWindow, thresholdPct)) return null

  const selection = deps.selectMessages(conversationId, contextWindow)
  if (selection.length === 0) return null
  const anchor = pickAnchorRow(selection)
  if (!anchor) return null
  const originalTokens = selection.reduce((s, r) => s + estimateTokens(r.content), 0)
  if (originalTokens === 0) return null

  inFlight.add(conversationId)
  try {
    const directive = buildCompactionDirective(excerptOf(anchor))
    const reply = await deps.complete(
      [...apiMessages, { role: 'user', content: directive }],
      modelId,
      conversationId,
      tools
    )
    const body = sanitize(reply ?? '')
    if (!body) return null

    const summaryText = [
      '<conversation_summary>',
      `Compressed ${selection.length} earlier messages from this conversation (model-compacted).`,
      '',
      body,
      '</conversation_summary>'
    ].join('\n')

    const reductionPct = 1 - estimateTokens(summaryText) / originalTokens
    if (reductionPct < minReductionPct) return null

    return deps.persist(conversationId, selection, summaryText, 'model')
  } finally {
    inFlight.delete(conversationId)
  }
}

/** Production wiring. The registry import stays dynamic so importing this
 *  module never drags provider/keychain initialization into test processes.
 *  The compaction call runs on the TURN's own engine (chat.ts passes `modelId`) on
 *  purpose: the summary rides that provider's warm prefix cache, so a cheaper
 *  'title'-role model would re-bill the whole context cold. */
export function productionModelCompactionDeps(): ModelCompactionDeps {
  return {
    shouldCompress: (conversationId, contextWindow, thresholdPct) =>
      shouldCompress(conversationId, contextWindow, thresholdPct),
    selectMessages: (conversationId, contextWindow) =>
      selectMessagesToCompress(conversationId, contextWindow),
    persist: (conversationId, selection, summaryText, source) =>
      persistCompressionSummary(conversationId, selection, summaryText, source),
    complete: async (messages, modelId, conversationId, tools) => {
      const { chatOnce } = await import('./providers/registry')
      const result = await chatOnce(
        messages as Parameters<typeof chatOnce>[0],
        modelId,
        AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
        { purpose: 'other', role: 'compactor', conversationId },
        tools && tools.length > 0
          ? { tools: tools as NonNullable<Parameters<typeof chatOnce>[4]>['tools'] }
          : undefined
      )
      return result.content
    }
  }
}
