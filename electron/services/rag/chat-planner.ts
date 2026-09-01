// chat-planner — the planner runner the RAG multi-query rewrite needs.
//
// augmentForChat skips the rewrite unless it is handed BOTH `settings.multiQueryRewrite` and a
// `planner`. ipc/chat.ts passed neither, so the whole multi-query path (rewriteQuery →
// per-variant retrieval → cross-variant RRF) was dead in production even for an operator who had
// switched the toggle on in Settings → RAG. This module is the missing half.
//
// It lives here rather than inline in ipc/chat.ts so the runner is unit-testable without dragging
// in the chat IPC handler's electron surface, and so the model-call shape (audit tags, error
// contract) is stated once.

import { chatOnce } from '../providers/registry'
import type { PlannerRunner } from './multi-query'

/** A planner backed by the turn's own model. Rewriting is an ENRICHMENT: rewriteQuery already
 *  falls back to `[originalQuery]` when the planner throws, so a planner failure degrades to
 *  single-query retrieval rather than sinking the turn. */
export function makeChatPlanner(model: string, signal?: AbortSignal): PlannerRunner {
  return async (prompt: string): Promise<string> => {
    const r = await chatOnce([{ role: 'user', content: prompt }], model, signal, {
      purpose: 'other',
      role: 'rag-multi-query-rewrite'
    })
    return r.content
  }
}
