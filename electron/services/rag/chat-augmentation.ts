import { randomUUID } from 'crypto'
import { app } from 'electron'
import { listAttachments } from './store'
import { retrieveWithMeta, persistRetrieval, type RetrievedChunk } from './retrieve'
import { rerank, resolveRerankMode, type RerankMode } from './rerank'
import { rewriteQuery, fuseAcrossVariants } from './multi-query'
import { buildContext, type ContextBuildOutput } from './context-builder'
import { getEmbeddingsService } from './embeddings/service'

// Single entry point the chat handler (R10/R13) calls to enrich a turn
// with retrieved context. Bundles attachment lookup, optional multi-query
// rewrite, hybrid retrieval, optional rerank, context-block assembly, and
// rag_retrievals persistence into one function.
//
// Returns null when there's nothing attached for this conversation — the
// caller uses that as "no augmentation, skip the <retrieved_context> block".

export type RagAugmentOptions = {
  conversationId: string
  query: string
  /** Conversation correlation id from chat:send. Threaded into rag_retrievals
   *  so Activity Timeline can group the retrieval with model + tool events. */
  correlationId?: string
  /** Tag for the rag_retrievals row. Defaults to 'user-turn'; the agent
   *  pipeline (R13) sets 'planner-rewrite' / 'coder-followup' /
   *  'reviewer-fixed' per role. */
  queryKind?: string
  /** Settings shape from settings.json's rag block. */
  settings?: {
    lexK?: number
    vecK?: number
    fusedTopN?: number
    rerankMode?: RerankMode
    /** Reranker id from the catalog (local-cross-encoder mode). Defaults to
     *  the catalog default when omitted. */
    rerankerId?: string
    /** Drop reranked chunks below this calibrated cross-encoder score (0..1).
     *  The cross score is the first threshold-worthy relevance signal (BM25 /
     *  cosine aren't commensurable). Omitted ⇒ no floor. */
    minRerankScore?: number
    multiQueryRewrite?: boolean
    citationRequired?: boolean
  }
  /** Optional planner runner for multi-query rewrite. When omitted and
   *  multiQueryRewrite is on, the multi-query step is skipped. */
  planner?: (prompt: string) => Promise<string>
  /** Optional rerank deps. The cross-encoder/LLM rerank kicks in only when
   *  the matching dep is supplied. */
  rerankDeps?: Parameters<typeof rerank>[1]
}

export interface RagAugmentResult {
  /** Pre-generated id the caller will pass to persistRetrieval(...) once the
   *  assistant message exists. Threaded into rag_retrievals so the message
   *  row's retrieval_id column links cleanly. */
  retrievalId: string
  context: ContextBuildOutput
  chunks: RetrievedChunk[]
  rewrites?: string[]
  scopes: string[]
  stats: {
    lexHitsTotal: number
    vecHitsTotal: number
    durationMs: number
  }
}

export async function augmentForChat(
  opts: RagAugmentOptions
): Promise<RagAugmentResult | null> {
  const attachments = listAttachments(opts.conversationId)
  if (attachments.length === 0) return null
  const collectionIds = attachments
    .map((a) => a.collectionId)
    .filter((id): id is string => !!id)
  if (collectionIds.length === 0) return null

  const userDataPath = app.getPath('userData')
  const embeddings = getEmbeddingsService(userDataPath)
  const settings = opts.settings ?? {}
  // Resolve the mode through the shared resolver, NOT settings.rerankMode raw.
  // On a fresh install settings.json has no rag key, so settings.rerankMode is
  // undefined — reading it raw silently means "off" (no over-fetch, no rerank),
  // even though DEFAULT_RERANK_MODE is 'local-cross-encoder' and the notes-brain
  // pipeline (server.ts, retrieve-agent.ts) already resolves the same default.
  // That divergence is exactly the "wired-looking but inert" trap: the Settings
  // dropdown shows local-cross-encoder while this path never reranked.
  const rerankMode = resolveRerankMode(settings)

  const startedAt = Date.now()
  let rewrites: string[] | undefined

  // 1. Optional multi-query rewrite.
  let variantQueries = [opts.query]
  if (settings.multiQueryRewrite && opts.planner) {
    rewrites = await rewriteQuery(opts.query, opts.planner)
    variantQueries = rewrites
  }

  // 2. Retrieve per variant. The plan calls for over-fetch when rerank is
  //    on; we 3× fusedTopN so rerank has headroom to reorder meaningfully.
  const fusedTopN = settings.fusedTopN ?? 8
  const fetchN = rerankMode !== 'off' ? fusedTopN * 3 : fusedTopN
  const allVariantResults: RetrievedChunk[][] = []
  let lexHitsTotal = 0
  let vecHitsTotal = 0
  for (const q of variantQueries) {
    const info = await retrieveWithMeta({
      query: q,
      collectionIds,
      lexK: settings.lexK,
      vecK: settings.vecK,
      topN: fetchN,
      embed: (texts) => embeddings.embed(texts),
      // Embed the query in the collections' own space when they share one — see
      // retrieve.ts soleCollectionSpace.
      embedWith: (id, texts, kind) => embeddings.embedWith(id, texts, kind),
      // The active embedder produces the query vector; retrieve skips the vector
      // leg for any collection indexed under a DIFFERENT embedder so a same-width
      // swap can't KNN across incompatible spaces (silent garbage).
      queryEmbedderId: embeddings.getActiveEmbedderId()
    })
    allVariantResults.push(info.results)
    lexHitsTotal += info.lexHits
    vecHitsTotal += info.vecHits
  }

  // 3. Fuse across variants (no-op when only one).
  const fused =
    allVariantResults.length === 1
      ? allVariantResults[0]
      : fuseAcrossVariants(allVariantResults, fetchN)

  // 4. Optional rerank. For local-cross-encoder mode, default the dep to the
  //    embeddings-worker cross-encoder (service.rerank) so the reranker is
  //    actually wired without every caller having to supply it; an explicit
  //    opts.rerankDeps still wins (tests / llm mode).
  let postRerank = fused
  if (rerankMode !== 'off') {
    const deps: Parameters<typeof rerank>[1] =
      rerankMode === 'local-cross-encoder' && !opts.rerankDeps?.crossEncoderScore
        ? {
            ...opts.rerankDeps,
            crossEncoderScore: (q, cands) =>
              embeddings.rerank(q, cands.map((c) => c.text), settings.rerankerId)
          }
        : opts.rerankDeps ?? {}
    postRerank = await rerank(
      {
        query: opts.query,
        candidates: fused,
        mode: rerankMode,
        maxCandidates: fetchN
      },
      deps
    )
    // Relevance floor — drop chunks below the calibrated cross score. Strict
    // (may return zero): for a genuinely off-topic query, no context beats eight
    // weak chunks. `?? 1` means a failed rerank (no cross score) is never
    // floored away. The floor is opt-in + configurable, so aggressiveness is the
    // operator's call.
    if (typeof settings.minRerankScore === 'number') {
      postRerank = postRerank.filter((c) => (c.scores.cross ?? 1) >= settings.minRerankScore!)
    }
  }
  const topResults = postRerank.slice(0, fusedTopN)

  // 5. Build the context block.
  const context = buildContext({
    chunks: topResults,
    citationRequired: settings.citationRequired
  })

  // Generate the retrieval id NOW so the caller can both stamp it onto the
  // assistant message row AND call persistRetrieval(retrievalId, ...) once
  // the message lands. Earlier-then-later id assignment is the standard
  // Lamprey pattern (chat correlationId works the same way).
  const retrievalId = randomUUID()
  return {
    retrievalId,
    context,
    chunks: topResults,
    rewrites,
    scopes: collectionIds,
    stats: {
      lexHitsTotal,
      vecHitsTotal,
      durationMs: Date.now() - startedAt
    }
  }
}

export { persistRetrieval } from './retrieve'
