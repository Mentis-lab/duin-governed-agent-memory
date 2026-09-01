// Query-time embedder-SPACE guard for the RAG vector leg (pure — catalogue-free,
// no db / no electron, so it is unit-testable without native sqlite and can never
// hide inside a describe.skipIf(!HAS_NATIVE_SQLITE) silent-skip).
//
// WHY THIS EXISTS — the invisible corruption it closes:
//   `rag_chunk_vec` is ONE physical index shared by every collection, and the
//   vector leg (retrieve.ts runVectorLeg) runs KNN across it, comparing the
//   QUERY embedding against the STORED chunk embeddings. KNN is only meaningful
//   when both vectors live in the SAME embedding space — i.e. were produced by
//   the same embedder. Equal WIDTH is NOT the same thing: bge-small-en-v1.5,
//   all-MiniLM-L6-v2 and multilingual-e5-small are three UNRELATED 384-dim
//   spaces, so the only wired guard — assertEmbedderFitsRagVec, which checks
//   `dimensions === 384` — passes a model swap that silently ruins ranking.
//
//   This bites users with NO action of their own: the shipped default embedder
//   was promoted bge-small-en-v1.5 → multilingual-e5-small (catalog.ts), both
//   384-dim. The active embedder resets to the DEFAULT on every boot and is NOT
//   persisted (embeddings/service.ts), so after the upgrade every query embeds
//   with e5 while existing collections' chunks are still bge-small vectors.
//   Same width ⇒ no INSERT/KNN error, no banner — just confidently mis-ranked
//   (garbage) top-k, indistinguishable from a healthy result.
//
//   A collection records the embedder it was created under (rag_collections
//   .embedder_id — the space its vectors live in for the reachable no-manual-
//   switch case). When the embedder used to embed the QUERY differs from a
//   queried collection's embedder, that collection's vector leg is comparing
//   two different spaces. The safe response is to DROP the vector leg and serve
//   lexical-only (this module's documented degraded mode — mirroring how
//   resolveQueryVec/runVectorLeg already swallow-and-degrade) rather than
//   return silently-wrong vector hits. A reindex under the new embedder
//   realigns the spaces and re-enables the vector leg.
//
// NOTE — why NOT rag_embedder_meta / assertEmbedderDimensionMatch (PS7): that
//   guard is a GLOBAL singleton row that (a) has zero production callers, (b)
//   compares dimensions only (never the embedder id, so it too passes a same-
//   width swap), and (c) is EMPTY on every pre-PS7 database, so it has no record
//   of the bge-small vectors an upgrading user already holds. The per-collection
//   embedder_id is populated on existing DBs and needs no backfill, so the guard
//   is correct on the very first post-upgrade query.

export interface VecLegEmbedderCheck {
  /** True ⇒ run the vector leg. False ⇒ skip it (degrade to lexical-only). */
  safe: boolean
  /** Human-readable reason, present only when `safe` is false. */
  reason?: string
  /** The distinct queried-collection embedder ids that differ from the query
   *  embedder — the evidence behind a `safe: false` verdict. */
  mismatched?: string[]
}

/**
 * Decide whether the RAG vector leg is safe to run.
 *
 * @param queryEmbedderId  the embedder that will embed (or embedded) the QUERY —
 *   the active embedder. `undefined` means the caller opted out of the check, so
 *   the historical behaviour (run the leg) is preserved — the guard is inert.
 * @param collectionEmbedderIds  the `embedder_id` of every collection in scope.
 *
 * Unsafe iff `queryEmbedderId` is set AND at least one *known* queried-collection
 * embedder id differs from it. Empty / falsy collection ids are ignored (missing
 * data must never force a skip — the guard fails OPEN toward running the leg),
 * so this only suppresses the vector leg on a genuine, evidenced mismatch.
 */
export function vectorLegEmbedderMatch(
  queryEmbedderId: string | undefined,
  collectionEmbedderIds: readonly string[]
): VecLegEmbedderCheck {
  if (!queryEmbedderId) return { safe: true }
  const mismatched = [...new Set(collectionEmbedderIds)].filter(
    (id) => !!id && id !== queryEmbedderId
  )
  if (mismatched.length === 0) return { safe: true }
  return {
    safe: false,
    mismatched,
    reason:
      `query embedder "${queryEmbedderId}" does not match the embedder(s) the ` +
      `queried collection(s) were indexed with (${mismatched.join(', ')}); their ` +
      `vectors live in a different embedding space (equal width is not equal space). ` +
      `Skipping the vector leg (lexical-only) to avoid silently mis-ranked results — ` +
      `reindex the collection under the active embedder to re-enable vector search.`
  }
}
