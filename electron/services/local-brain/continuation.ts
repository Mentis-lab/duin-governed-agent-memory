// continuation.ts — decide whether a capped answer should keep writing. PURE +
// unit-testable off the HTTP server, like turn-watchdog and incomplete-intent.
//
// `max_tokens` is a PER-RESPONSE protocol limit, not a limit on what the operator is
// allowed to ask for. Every provider ends an over-long response with finishReason
// 'length', and DUIN used to treat that as the end of the turn: the answer to "write me
// the whole thing" was half a document plus an apology, and the operator's only recourse
// was to type "continue" and hope the model could reconstruct where it stopped. (It could
// not — see brain-history.ts, which had already removed the end of it from context.)
//
// Continuation removes the operator-visible cap entirely: feed the partial back, ask for
// the remainder, stream into the same message. What is left is not a cap but a set of
// honest stopping conditions — the model went quiet, the budget ran out, or the answer no
// longer fits the context window. Each is named, so the terminal can say which one.

/** The instruction that accompanies a partial answer on the continuation round. It has to
 *  suppress three reflexes that would otherwise corrupt the seam: repeating the tail it
 *  just wrote, re-introducing the document, and apologising for the interruption. */
export const CONTINUE_PROMPT =
  'Your previous message stopped because it reached the output length limit, not because it was finished. ' +
  'Continue from EXACTLY where it stopped — resume mid-sentence or mid-word if that is where it ended. ' +
  'Do not repeat any text you already wrote, do not summarise what came before, do not re-introduce the ' +
  'document, and do not apologise. Output only the continuation.'

/** Fraction of the context window the accumulated ANSWER may occupy before we stop
 *  continuing. Each slice is appended to the prompt, so the request grows with the answer;
 *  stopping here trades a bounded answer for an opaque provider-side
 *  `context_length_exceeded` fired mid-document, which has no good user-facing form. */
export const CONTEXT_HEADROOM = 0.7

// Chars per token, per script. A single ratio cannot serve both, and getting it wrong is not
// symmetric: UNDER-counting tokens means the guard fires too late and the provider rejects the
// request instead, which surfaces as an opaque error with the answer discarded.
//
// A flat 3 was wrong for exactly the case this operator hits most. CJK is DENSER — measured on
// this provider at ~1.26 chars/token for content — and denser means FEWER chars per token, so
// dividing Chinese text by 3 under-counts its tokens by well over half. A 128k-window model
// would have been ~1.7x past its real limit at the moment the guard declared it safe.
const CHARS_PER_TOKEN_CJK = 1.3
const CHARS_PER_TOKEN_LATIN = 3.5

/**
 *  CJK ideographs, kana, and fullwidth punctuation — the ranges that tokenize densely.
 *  Written as escapes, not literal characters: the range opens on U+3000 IDEOGRAPHIC SPACE,
 *  which is invisible in source and trips no-irregular-whitespace. */
const CJK_RE = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g

/** Token estimate that holds for both scripts the operator writes in, and for a mix of them. */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0
  const latin = text.length - cjk
  return Math.ceil(cjk / CHARS_PER_TOKEN_CJK + latin / CHARS_PER_TOKEN_LATIN)
}

export interface ContinuationState {
  /** Did the provider report finishReason 'length' on the round that just finished? */
  truncated: boolean
  /** How many continuations this turn has already taken. */
  continuations: number
  maxContinuations: number
  /** Characters of content the capped round produced. */
  sliceChars: number
  /** The answer accumulated across the whole turn so far. Passed as TEXT, not a length, because
   *  the token estimate is script-dependent — see estimateTokens. */
  answerText: string
  /** The model's context window in tokens; 0 when unknown (then it is not a constraint). */
  contextWindow: number
}

export type ContinuationVerdict =
  | 'continue'
  | 'not-truncated'
  | 'budget-exhausted'
  | 'empty-slice'
  | 'context-full'

/**
 * Should the turn write another slice?
 *
 * `empty-slice` is the anti-livelock guard and the reason this returns a reason rather than
 * a boolean: a model that reports 'length' while emitting nothing would otherwise be asked
 * to continue forever, each round producing nothing and re-latching truncated.
 */
export function continuationVerdict(s: ContinuationState): ContinuationVerdict {
  if (!s.truncated) return 'not-truncated'
  if (s.sliceChars <= 0) return 'empty-slice'
  if (s.continuations >= s.maxContinuations) return 'budget-exhausted'
  if (s.contextWindow > 0) {
    if (estimateTokens(s.answerText) > s.contextWindow * CONTEXT_HEADROOM) return 'context-full'
  }
  return 'continue'
}

/** 64 slices is ~1M tokens of output at a typical 16k per-response cap — far past any real
 *  request, and present only so a looping model cannot run unbounded. The stall watchdog and
 *  the operator's Cancel remain the responsive limits. `DUIN_MAX_CONTINUATIONS=0` disables
 *  continuation and restores the old stop-at-the-cap behaviour. */
export function maxContinuations(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DUIN_MAX_CONTINUATIONS)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 64
}
