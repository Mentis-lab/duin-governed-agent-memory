import { getEmbedder, type EmbedderInfo } from './catalog'

// RAG vec-table dimension guard (pure — catalogue only, no db/electron so it is
// unit-testable without native sqlite, i.e. it can never hide inside a
// describe.skipIf(!HAS_NATIVE_SQLITE) silent-skip).
//
// WHY THIS EXISTS — the invisible failure it closes:
//   The RAG vec0 table `rag_chunk_vec` is created with a FIXED width of
//   FLOAT[384] in schema-init.ts (initVecTable) and — unlike the local-brain
//   `notes_vec` table, which re-creates itself at the active embedder's width
//   via maybeMigrateVecTable — there is NO migration or rebuild path that
//   changes the RAG table's width. So any embedder used for RAG MUST emit
//   384-dim vectors.
//
//   `EMBEDDING_CATALOG` gained bge-m3 (1024-dim) after this table's width was
//   frozen. Selecting it for RAG used to just set the shared service field:
//   ingest then writes 1024-dim buffers into a FLOAT[384] table, and — the
//   silent half — every query embedding is 1024-dim, so the vector leg's
//   `embedding MATCH ?` throws and is SWALLOWED at retrieve.ts (runVectorLeg's
//   catch returns []). Retrieval degrades to lexical-only permanently with no
//   banner and no event. `assertEmbedderDimensionMatch` (embedder-meta.ts) was
//   meant to catch this but has zero production callers, and its stored-vs-
//   configured comparison stamps-and-passes on a fresh DB — it cannot see the
//   physical 384 pin. This guard compares against that pin directly, so it is
//   correct on every DB state and has no side effects.
//
// Keep RAG_VEC_DIMENSIONS in sync with initVecTable's `FLOAT[384]`.
export const RAG_VEC_DIMENSIONS = 384

/** Thrown when a would-be RAG embedder emits vectors the fixed-width
 *  `rag_chunk_vec` table cannot store. Carries the offending dims so the caller
 *  / renderer can explain the refusal precisely. */
export class RagEmbedderDimensionError extends Error {
  readonly embedderId: string
  readonly embedderDimensions: number
  readonly vecDimensions: number

  constructor(embedderId: string, embedderDimensions: number) {
    super(
      `embedder "${embedderId}" emits ${embedderDimensions}-dim vectors, but the ` +
        `RAG vector index is fixed at ${RAG_VEC_DIMENSIONS} dimensions and cannot be ` +
        `rebuilt to another width. Choose a ${RAG_VEC_DIMENSIONS}-dim embedder for the library.`
    )
    this.name = 'RagEmbedderDimensionError'
    this.embedderId = embedderId
    this.embedderDimensions = embedderDimensions
    this.vecDimensions = RAG_VEC_DIMENSIONS
  }
}

/**
 * Assert a catalogue embedder is usable for RAG — i.e. its output dimension
 * matches the fixed `rag_chunk_vec` width. Returns the resolved catalogue entry
 * on success; throws RagEmbedderDimensionError on a width mismatch, or a plain
 * Error for an unknown id. No side effects, no DB — safe to call before
 * committing an embedder switch.
 */
export function assertEmbedderFitsRagVec(embedderId: string): EmbedderInfo {
  const info = getEmbedder(embedderId)
  if (!info) {
    throw new Error(`unknown embedder "${embedderId}"`)
  }
  if (info.dimensions !== RAG_VEC_DIMENSIONS) {
    throw new RagEmbedderDimensionError(embedderId, info.dimensions)
  }
  return info
}
