// ── MITIGATION for an intermittent provider quirk ────────────────────────────
// DeepSeek V4 Pro (and similar agentic reasoners running WITHOUT thinking mode —
// the codebase already documents this class of model, see conversation-store's
// "inline-emitting models" note) occasionally emit a natural-language tool-call
// PREAMBLE ("Let me pull the current state of X…") — or a bare native tool call —
// as their ENTIRE turn and then stop, producing no substantive answer. The
// finish_reason in that case is typically 'stop', so there is no clean
// deterministic signal; this is a robustness MITIGATION, not a definitive fix.
//
// Persisting that bare preamble as a valid answer is worse than an explicit
// error, so the chat answer path (server.ts handleAgui) runs ONE bounded
// re-generation with a direct-answer nudge and, if that STILL yields nothing,
// surfaces an explicit error instead of the preamble.
//
// The trigger is deliberately NARROW: never a blanket "short answer = failure"
// (a legitimately terse "Yes." / "42." must pass untouched). It fires only on a
// strong signal — nothing substantive was streamed at all, OR the turn ended
// with leftover native tool calls AND the prose is only a narration preamble.
import { looksLikeIncompleteIntent } from './incomplete-intent'

export interface GenResult {
  content: string
  toolCalls: readonly unknown[]
}

/**
 * STRONG, NARROW "the turn produced no real answer" signal. Returns true only
 * when:
 *   (a) nothing substantive was streamed (empty after trim), or
 *   (b) the turn ended with leftover native tool calls AND the prose reads as a
 *       bare narration preamble ("Let me pull…", ends on a colon, etc.).
 * A normal complete answer — including a terse one like "Yes." — returns false,
 * so this never changes behaviour for a legitimate answer.
 */
export function isIncompleteAnswer(text: string, toolCalls: readonly unknown[] | undefined): boolean {
  const t = (text || '').trim()
  if (t.length === 0) return true // (a) nothing substantive at all
  // (b) the model still WANTED to act (native tool calls left over) but only
  // narrated its intent — the bare-preamble quirk. Gate on the narration
  // detector so a real answer that happens to carry a stray tool call is NOT
  // flagged.
  return (toolCalls?.length ?? 0) > 0 && looksLikeIncompleteIntent(t)
}

export interface FinalizeDeps {
  /**
   * Run EXACTLY ONE bounded answer re-generation (the caller applies the
   * direct-answer nudge and streams the tokens); resolves with the retry's
   * final prose + native tool calls. Called at most once.
   */
  regenerate: () => Promise<GenResult>
  /** Optional log sink so the retry is observable. */
  log?: (msg: string) => void
}

export type FinalizeOutcome = { status: 'ok'; text: string } | { status: 'error' }

/**
 * Decide the turn outcome for the chat answer path. If the primary answer is
 * complete → return it unchanged (no re-generation, zero behaviour change). If
 * it is INCOMPLETE (see isIncompleteAnswer), do ONE re-generation:
 *   - retry substantive  → { status: 'ok', text: <retry answer> }
 *   - retry still empty   → { status: 'error' }  (caller emits RUN_ERROR)
 * Capped at exactly one re-generation — never a loop.
 */
export async function finalizeAnswer(
  primaryText: string,
  primaryToolCalls: readonly unknown[] | undefined,
  deps: FinalizeDeps
): Promise<FinalizeOutcome> {
  if (!isIncompleteAnswer(primaryText, primaryToolCalls)) {
    return { status: 'ok', text: primaryText }
  }
  deps.log?.('turn produced only a bare tool-call preamble; regenerating the answer once')
  const retry = await deps.regenerate()
  if (isIncompleteAnswer(retry.content, retry.toolCalls)) {
    return { status: 'error' }
  }
  return { status: 'ok', text: retry.content }
}
