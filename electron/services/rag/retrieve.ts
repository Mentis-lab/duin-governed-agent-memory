import { randomUUID } from 'crypto'
import { getDb } from '../database'
import { boundedJsonPreview, recordEvent } from '../event-log'
import { isVecAvailable } from './vec-loader'
import { __peekMemoryChunks } from './store'
import { vectorLegEmbedderMatch } from './vec-leg-embedder-guard'
import { getEmbedder } from './embeddings/catalog'

// Hybrid retrieval: BM25 (FTS5) + cosine (sqlite-vec) fused via Reciprocal
// Rank Fusion. See LAMPREY_RAG_PLAN.md §2.5.
//
// Why RRF and not weighted sum:
//   The two scales (BM25 score vs cosine distance) are not commensurable.
//   Tuning a weight is a hyperparameter the user shouldn't have to set.
//   RRF is parameter-light, robust to scale, and used in practice by major
//   hybrid search systems (Elastic, Vespa). The constant `k=60` is the
//   reference value from Cormack & Clarke (2009).
//
// Persistence:
//   `retrieve()` is read-only. The chat handler (R10) creates the
//   rag_retrievals row when it knows the message_id; we hand back the
//   ranked chunks + the per-leg scores and let the caller persist.

const RRF_K = 60

// ──────────────────── optional freshness boost (Phase 4) ────────────────────
// Flag-gated, default-OFF recency prior on the fused RRF score. When the flag is
// unset the entire freshness path is skipped and RRF output is byte-identical to
// the pure-ranking behavior — this is the moat-critical path used by ALL
// retrieval, so flag-OFF MUST NOT change scores or ordering.
//
// PLACEHOLDER CONSTANTS. EVAL (2026-07-16): the constants are NOT the bottleneck —
// the SIGNAL is. On the live dogfood vault, note/doc mtimes are bulk-clustered
// (p10=p25=median≈10d, 96.6% ≤30d) from the 2026-06-25 arena migration + reindexes,
// NOT spread by true edit recency — so a file-mtime freshness boost is ~uniform
// (≈×1.13 for everything) and cannot discriminate. Tuning W/half-life won't help;
// keep DUIN_RRF_FRESHNESS OFF until recency comes from a real signal (frontmatter
// `updated`/`created` date, not filesystem mtime). Constants mirror the sibling
// `recencyMultiplier` in local-brain/index-store.ts for consistency if ever enabled.
const FRESHNESS_WEIGHT = 0.15 // freshest chunk gets at most ×(1 + W) on its fused score
const FRESHNESS_HALFLIFE_DAYS = 30 // boost halves every ~30 days of chunk/doc age
const DAY_MS = 86_400_000

/**
 * True when `DUIN_RRF_FRESHNESS === '1'`. Default OFF ⇒ the RRF path is
 * byte-identical to today (no mtime hydration, no factor, same sort).
 */
export function rrfFreshnessEnabled(): boolean {
  return process.env.DUIN_RRF_FRESHNESS === '1'
}

/**
 * Bounded, monotone recency multiplier in (1, 1 + FRESHNESS_WEIGHT]. Rows with
 * an unknown/absent mtime get factor 1 (no boost, never a penalty). PURE.
 * PLACEHOLDER formula/constants — pending human eval before default-on.
 */
function freshnessFactor(mtimeMs: number | undefined, now: number): number {
  if (mtimeMs === undefined || !(mtimeMs > 0)) return 1
  const ageMs = Math.max(0, now - mtimeMs)
  const halfLifeMs = FRESHNESS_HALFLIFE_DAYS * DAY_MS
  return 1 + FRESHNESS_WEIGHT * Math.exp((-ageMs * Math.LN2) / halfLifeMs)
}

export interface RetrievalInput {
  query: string
  collectionIds: string[]
  lexK?: number
  vecK?: number
  topN?: number
  filters?: {
    sourceKind?: string
    pathPrefix?: string
  }
  /** Optional pre-computed query embedding. Lets the agent pipeline reuse
   *  the same vector across planner/coder/reviewer calls without re-
   *  embedding the same text three times. */
  queryEmbedding?: Float32Array
  /** Embedder used to vectorize the query. Defaults to the active embedder
   *  in the embeddings service. Required when `queryEmbedding` is omitted. */
  embed?: (texts: string[]) => Promise<Float32Array[]>
  /** Embed in a NAMED embedding space. When supplied, and when every queried
   *  collection agrees on one `embedder_id`, the QUERY is embedded in THAT space
   *  instead of the process-active one — so the vector leg keeps working after
   *  the user changes their default embedder, instead of degrading to lexical.
   *  See resolveQueryVec / soleCollectionSpace. */
  embedWith?: (
    embedderId: string,
    texts: string[],
    kind: 'query' | 'passage' | 'none'
  ) => Promise<Float32Array[]>
  /** Id of the embedder that produces the QUERY vector (the active embedder).
   *  When set, the vector leg is SKIPPED for a query whose embedder differs
   *  from a queried collection's stored embedder — same-width model swaps
   *  (all 384-dim) otherwise run KNN across incompatible spaces and return
   *  silently mis-ranked hits. Omitted ⇒ the check is inert (legacy path).
   *  See vec-leg-embedder-guard.ts. */
  queryEmbedderId?: string
}

export interface RetrievedChunk {
  chunkId: string
  documentId: string
  collectionId: string
  text: string
  displayName: string
  sourcePath?: string
  headingPath?: string
  page?: number
  lineStart?: number
  lineEnd?: number
  scores: { lex?: number; vec?: number; fused: number; cross?: number }
  ranks: { lex?: number; vec?: number }
}

export interface RetrievalRunInfo {
  retrievalId: string
  results: RetrievedChunk[]
  lexHits: number
  vecHits: number
  fusedCount: number
  durationMs: number
}

interface LexLegRow {
  rowid: number
  chunk_id: string
  score: number
  /** Doc mtime (ms). Only populated when the freshness flag is on; undefined
   *  otherwise so the flag-OFF path pays no hydration cost. */
  mtimeMs?: number
}

interface VecLegRow {
  rowid: number
  chunk_id: string
  distance: number
  /** Doc mtime (ms). See LexLegRow.mtimeMs. */
  mtimeMs?: number
}

interface ChunkHydrationRow {
  id: string
  document_id: string
  collection_id: string
  text: string
  heading_path: string | null
  page: number | null
  line_start: number | null
  line_end: number | null
  display_name: string
  source_path: string | null
}

// ──────────────────── public API ────────────────────

export async function retrieve(input: RetrievalInput): Promise<RetrievedChunk[]> {
  const out = await retrieveWithMeta(input)
  return out.results
}

export async function retrieveWithMeta(
  input: RetrievalInput
): Promise<RetrievalRunInfo> {
  const lexK = input.lexK ?? 30
  const vecK = input.vecK ?? 30
  const topN = input.topN ?? 8
  const startedAt = Date.now()

  if (!input.query || !input.query.trim()) {
    return {
      retrievalId: randomUUID(),
      results: [],
      lexHits: 0,
      vecHits: 0,
      fusedCount: 0,
      durationMs: 0
    }
  }
  if (!Array.isArray(input.collectionIds) || input.collectionIds.length === 0) {
    return {
      retrievalId: randomUUID(),
      results: [],
      lexHits: 0,
      vecHits: 0,
      fusedCount: 0,
      durationMs: 0
    }
  }

  // Try the real DB path; on failure fall through to the memory-fallback
  // lex-only path so unit tests and dev-without-Electron can still exercise
  // ranking semantics.
  let db: ReturnType<typeof getDb> | null
  try {
    db = getDb()
  } catch {
    db = null
  }

  if (db) {
    return await retrieveFromDb(db, input, lexK, vecK, topN, startedAt)
  }
  return retrieveFromMemory(input, topN, startedAt)
}

// ──────────────────── DB-backed path ────────────────────

async function retrieveFromDb(
  db: ReturnType<typeof getDb>,
  input: RetrievalInput,
  lexK: number,
  vecK: number,
  topN: number,
  startedAt: number
): Promise<RetrievalRunInfo> {
  // 1. Lexical leg (BM25 via FTS5).
  const lexResults = runLexicalLeg(db, input.query, input.collectionIds, lexK)

  // 2. Vector leg (cosine via sqlite-vec MATCH).
  //    Guard the embedding SPACE first: rag_chunk_vec is one shared index, so a
  //    query embedded with a different embedder than a collection's stored
  //    vectors would KNN across incompatible 384-dim spaces and return silently
  //    mis-ranked hits (the same-width bge-small→e5 default-flip trap). On a
  //    mismatch we skip the vector leg and degrade to lexical-only — the
  //    module's documented failure mode — rather than surface garbage.
  let vecResults: VecLegRow[] = []
  if (isVecAvailable()) {
    // Normalize ONCE, here. soleCollectionSpace used to trim only its own return value
    // while the guard still compared the raw rows — so a padded stamp produced a trimmed
    // target that then failed vectorLegEmbedderMatch's strict !== against its own
    // untrimmed source, skipping the leg and telling the user to reindex a collection
    // that was already in the right space.
    const spaces = collectionEmbedderIds(db, input.collectionIds).map((id) => (id ?? '').trim())
    // Prefer embedding the QUERY in the collections' own space over skipping the
    // leg. The guard's job is to stop a cross-space KNN; meeting the collection
    // where it lives satisfies that without losing vector search. Without this,
    // changing the default embedder pinned every existing collection to
    // lexical-only, and the "reindex the collection" the guard advises does not
    // exist as an operation (reingest is per-document and re-stamps nothing).
    //
    // Only when the scope agrees on ONE space, and only when the caller did not
    // hand us a precomputed `queryEmbedding` — that vector was produced in the
    // ACTIVE space, so re-pointing the guard at a different one would wave
    // through exactly the mismatch it exists to catch.
    const target =
      !input.queryEmbedding && input.embedWith ? soleCollectionSpace(spaces) : null
    const legCheck = vectorLegEmbedderMatch(target ?? input.queryEmbedderId, spaces)
    if (!legCheck.safe) {
      console.warn(`[rag-retrieve] ${legCheck.reason}`)
    } else {
      const queryVec = await resolveQueryVec(input, target)
      if (queryVec) {
        vecResults = runVectorLeg(db, queryVec, input.collectionIds, vecK)
      }
    }
  }

  // 2b. Optional freshness plumbing. Only when the flag is on do we hydrate
  //     doc mtimes onto the leg rows so fuseRRF can apply a recency factor.
  //     Flag OFF ⇒ this block is skipped entirely, no extra query, rows
  //     untouched — the RRF path stays byte-identical.
  if (rrfFreshnessEnabled()) {
    const candidateIds = [
      ...new Set([...lexResults, ...vecResults].map((r) => r.chunk_id))
    ]
    const mtimes = hydrateMtimes(db, candidateIds)
    for (const r of lexResults) r.mtimeMs = mtimes.get(r.chunk_id)
    for (const r of vecResults) r.mtimeMs = mtimes.get(r.chunk_id)
  }

  // 3. Fuse via RRF.
  //    NB: rerank is NOT applied here — it's an AUGMENTATION-layer concern
  //    (chat-augmentation.ts over-fetches then calls rerank()), so keeping
  //    retrieve() pure avoids a double-rerank.
  const fused = fuseRRF(lexResults, vecResults, topN)
  const fusedIds = fused.map((f) => f.chunkId)

  // 4. Hydrate the top N with text + metadata.
  const hydrated = fusedIds.length > 0 ? hydrateChunks(db, fusedIds) : []

  // 5. Stitch hydration onto the fused-order ranking.
  const byId = new Map(hydrated.map((h) => [h.id, h]))
  const results: RetrievedChunk[] = []
  for (const f of fused) {
    const row = byId.get(f.chunkId)
    if (!row) continue
    results.push({
      chunkId: row.id,
      documentId: row.document_id,
      collectionId: row.collection_id,
      text: row.text,
      displayName: row.display_name,
      sourcePath: row.source_path ?? undefined,
      headingPath: row.heading_path ?? undefined,
      page: row.page ?? undefined,
      lineStart: row.line_start ?? undefined,
      lineEnd: row.line_end ?? undefined,
      scores: f.scores,
      ranks: f.ranks
    })
  }

  const out: RetrievalRunInfo = {
    retrievalId: randomUUID(),
    results,
    lexHits: lexResults.length,
    vecHits: vecResults.length,
    fusedCount: results.length,
    durationMs: Date.now() - startedAt
  }
  emitQueryEvent('rag.query.completed', input, out)
  return out
}

/**
 * Resolve the query embedding for the vector leg. A caller-supplied
 * `queryEmbedding` wins; otherwise the query is embedded via `input.embed`.
 *
 * Why the try/catch — and why the naked `await` it replaces was a live defect:
 * the embedder autoloads its model on first use and REJECTS (typed
 * MODEL_DOWNLOAD_FAILED) when offline or the weights were never downloaded.
 * sqlite-vec is a bundled native extension, so isVecAvailable() stays true even
 * while the embedder is down — the vec branch is entered, and an unguarded
 * `await input.embed(...)` propagates the reject out of retrieveFromDb,
 * discarding the lexical results already computed one line earlier. Both
 * production callers (chat-augmentation, rag:query:run) then lose ALL retrieved
 * context instead of the good BM25/FTS5 hits. Swallowing here degrades hybrid
 * retrieval to lexical-only — the module's documented invariant — mirroring how
 * runLexicalLeg/runVectorLeg/hydrateChunks/hydrateMtimes each catch and return
 * empty rather than aborting the whole retrieval. Exported for direct testing.
 */
export async function resolveQueryVec(
  input: RetrievalInput,
  targetSpace?: string | null
): Promise<Float32Array | null> {
  if (input.queryEmbedding) return input.queryEmbedding
  if (targetSpace && input.embedWith) {
    try {
      return (await input.embedWith(targetSpace, [input.query], 'none'))[0] ?? null
    } catch (err) {
      console.warn(
        '[rag-retrieve] query embed in collection space failed; degrading to lexical-only:',
        err
      )
      return null
    }
  }
  if (!input.embed) return null
  try {
    return (await input.embed([input.query]))[0] ?? null
  } catch (err) {
    console.warn(
      '[rag-retrieve] query embed failed; degrading to lexical-only:',
      err
    )
    return null
  }
}

/**
 * The distinct `embedder_id` of the queried collections — the embedding SPACE
 * each collection's stored vectors live in. Feeds vectorLegEmbedderMatch so the
 * vector leg is suppressed when the query embedder disagrees. Best-effort: a
 * read failure returns [] (⇒ the guard fails OPEN and the leg runs), because a
 * missing lookup must never suppress vector search on its own.
 */
/** The one embedding space every queried collection shares, or null when the
 *  scope is empty, unstamped, or spans two spaces. Deliberately all-or-nothing:
 *  with a mixed scope there is no single query vector that is correct for every
 *  collection, so the guard's skip remains the right answer. */
export function soleCollectionSpace(embedderIds: string[]): string | null {
  const distinct = [...new Set(embedderIds.map((id) => (id ?? '').trim()).filter(Boolean))]
  if (distinct.length !== 1) return null
  // Only re-target at a stamp this build can actually resolve. embedWith rejects an
  // unknown id, and a stamp that merely equals ITSELF still satisfies the guard — so
  // without this the leg is cleared and then throws inside resolveQueryVec, degrading
  // the whole query to lexical instead of simply skipping the re-target.
  return getEmbedder(distinct[0]) ? distinct[0] : null
}

function collectionEmbedderIds(
  db: ReturnType<typeof getDb>,
  collectionIds: string[]
): string[] {
  if (collectionIds.length === 0) return []
  const placeholders = collectionIds.map(() => '?').join(',')
  try {
    const rows = db
      .prepare(
        `SELECT embedder_id AS embedderId FROM rag_collections
          WHERE id IN (${placeholders})`
      )
      .all(...collectionIds) as { embedderId: string }[]
    return rows.map((r) => r.embedderId)
  } catch (err) {
    console.warn('[rag-retrieve] collection embedder-id lookup failed:', err)
    return []
  }
}

function runLexicalLeg(
  db: ReturnType<typeof getDb>,
  query: string,
  collectionIds: string[],
  k: number
): LexLegRow[] {
  // The FTS5 MATCH escape strategy: wrap each whitespace-separated token in
  // quotes so reserved chars (- + : NEAR etc.) don't fall through as
  // operators. Empty after trim → empty array.
  const ftsQuery = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ')
  if (!ftsQuery) return []
  const placeholders = collectionIds.map(() => '?').join(',')
  try {
    const rows = db
      .prepare(
        `SELECT c.rowid AS rowid, c.id AS chunk_id,
                bm25(rag_chunks_fts) AS score
           FROM rag_chunks_fts f
           JOIN rag_chunks c ON c.rowid = f.rowid
          WHERE rag_chunks_fts MATCH ?
            AND c.collection_id IN (${placeholders})
          ORDER BY score
          LIMIT ?`
      )
      .all(ftsQuery, ...collectionIds, k) as LexLegRow[]
    return rows
  } catch (err) {
    console.warn('[rag-retrieve] lexical leg failed:', err)
    return []
  }
}

/**
 * Vector leg — cosine/L2 KNN over `rag_chunk_vec`, restricted to the queried
 * collections. Exported for tests: the property that matters here is only
 * observable when the statement runs against a REAL vec0 index holding more
 * than one collection, so the regression guard executes this function rather
 * than asserting on a query string.
 */
export function runVectorLeg(
  db: ReturnType<typeof getDb>,
  queryVec: Float32Array,
  collectionIds: string[],
  k: number
): VecLegRow[] {
  // sqlite-vec KNN syntax: SELECT chunk_rowid, distance FROM rag_chunk_vec
  // WHERE embedding MATCH ? AND k = ?.
  //
  // WHY the scope filter is `chunk_rowid IN (<rowids in scope>)` and NOT the
  // obvious `c.collection_id IN (...)` on the joined rag_chunks row:
  //
  //   `rag_chunk_vec` is ONE physical index shared by every collection (see
  //   vec-leg-embedder-guard.ts) and `rag:auto-attach` mints a collection per
  //   conversation, so this index routinely holds dozens of unrelated scopes.
  //   vec0's xBestIndex can only consume constraints on its OWN columns
  //   (`embedding MATCH ?`, `k = ?`); a predicate on the JOINED table is not
  //   visible to it, so it was a pure POST-filter — EXPLAIN QUERY PLAN put vec0
  //   in the outer loop ("SCAN v VIRTUAL TABLE INDEX 0:3") with rag_chunks as a
  //   per-row rowid lookup. The KNN therefore spent its entire k budget picking
  //   the globally nearest chunks and only then discarded everything out of
  //   scope. That is invisible in code review because the WHERE clause reads
  //   like a filter and the SQL is correct — it returns no wrong rows, just far
  //   too few right ones, and the loss surfaces only as a low `vecHits`, which
  //   is indistinguishable from "nothing was relevant".
  //
  //   Restricting the rowids up front pushes the scope INTO the KNN, so the
  //   whole budget is spent inside the requested collections. Measured on a
  //   6000-chunk / 60-collection index with a single collection in scope:
  //   10.7/30 in-scope hits before vs 30/30 after — and ~2x faster, because a
  //   skipped vector costs no distance computation.
  const placeholders = collectionIds.map(() => '?').join(',')
  try {
    const rows = db
      .prepare(
        `SELECT v.chunk_rowid AS rowid, c.id AS chunk_id,
                v.distance AS distance
           FROM rag_chunk_vec v
           JOIN rag_chunks c ON c.rowid = v.chunk_rowid
          WHERE v.embedding MATCH ?
            AND k = ?
            AND v.chunk_rowid IN (
                  SELECT rowid FROM rag_chunks
                   WHERE collection_id IN (${placeholders})
                )
          ORDER BY distance
          LIMIT ?`
      )
      .all(Buffer.from(queryVec.buffer), k, ...collectionIds, k) as VecLegRow[]
    return rows
  } catch (err) {
    console.warn('[rag-retrieve] vector leg failed:', err)
    return []
  }
}

function hydrateChunks(
  db: ReturnType<typeof getDb>,
  chunkIds: string[]
): ChunkHydrationRow[] {
  if (chunkIds.length === 0) return []
  const placeholders = chunkIds.map(() => '?').join(',')
  try {
    return db
      .prepare(
        `SELECT c.id, c.document_id, c.collection_id, c.text,
                c.heading_path, c.page, c.line_start, c.line_end,
                d.display_name, d.source_path
           FROM rag_chunks c
           JOIN rag_documents d ON d.id = c.document_id
          WHERE c.id IN (${placeholders})`
      )
      .all(...chunkIds) as ChunkHydrationRow[]
  } catch (err) {
    console.warn('[rag-retrieve] hydration failed:', err)
    return []
  }
}

/**
 * Fetch doc mtime (ms) for a set of chunk ids. Only called when the freshness
 * flag is on. Chunks whose doc has a NULL mtime are simply absent from the map
 * (⇒ factor 1 downstream). Best-effort: a failure yields an empty map, so
 * freshness degrades to a no-op rather than breaking retrieval.
 */
function hydrateMtimes(
  db: ReturnType<typeof getDb>,
  chunkIds: string[]
): Map<string, number> {
  if (chunkIds.length === 0) return new Map()
  const placeholders = chunkIds.map(() => '?').join(',')
  try {
    const rows = db
      .prepare(
        `SELECT c.id AS id, d.mtime AS mtime
           FROM rag_chunks c
           JOIN rag_documents d ON d.id = c.document_id
          WHERE c.id IN (${placeholders})`
      )
      .all(...chunkIds) as { id: string; mtime: number | null }[]
    const m = new Map<string, number>()
    for (const r of rows) if (r.mtime != null) m.set(r.id, r.mtime)
    return m
  } catch (err) {
    console.warn('[rag-retrieve] mtime hydration failed:', err)
    return new Map()
  }
}

// ──────────────────── memory-fallback path (lex-only) ────────────────────

function retrieveFromMemory(
  input: RetrievalInput,
  topN: number,
  startedAt: number
): RetrievalRunInfo {
  // No FTS in the memory store — score by term-frequency over the chunk
  // text. This is enough to exercise the orchestration tests (R7 unit test
  // verifies that scope is respected and RRF math is correct); production
  // ranking quality comes from the real FTS5 + vec0 path.
  const tokens = input.query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 1)
  const chunks = __peekMemoryChunks().filter((c) =>
    input.collectionIds.includes(c.collectionId)
  )
  const scored = chunks
    .map((c, idx) => {
      const text = c.text.toLowerCase()
      let score = 0
      for (const t of tokens) {
        let from = 0
        while ((from = text.indexOf(t, from)) !== -1) {
          score++
          from += t.length
        }
      }
      return { idx, chunk: c, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)

  const results: RetrievedChunk[] = scored.map((s, rank) => ({
    chunkId: s.chunk.id,
    documentId: s.chunk.documentId,
    collectionId: s.chunk.collectionId,
    text: s.chunk.text,
    displayName: s.chunk.documentId, // memory mode doesn't join to documents
    sourcePath: undefined,
    headingPath: s.chunk.headingPath,
    page: s.chunk.page,
    lineStart: s.chunk.lineStart,
    lineEnd: s.chunk.lineEnd,
    scores: { lex: s.score, fused: 1 / (RRF_K + rank + 1) },
    ranks: { lex: rank + 1 }
  }))
  const out: RetrievalRunInfo = {
    retrievalId: randomUUID(),
    results,
    lexHits: scored.length,
    vecHits: 0,
    fusedCount: results.length,
    durationMs: Date.now() - startedAt
  }
  emitQueryEvent('rag.query.completed', input, out)
  return out
}

// ──────────────────── RRF fusion ────────────────────

interface FusedRanking {
  chunkId: string
  scores: { lex?: number; vec?: number; fused: number }
  ranks: { lex?: number; vec?: number }
}

/**
 * Reciprocal Rank Fusion. Each candidate's fused score is the sum of
 * `1 / (k + rank)` across legs that returned it; a candidate missing from a
 * leg contributes 0. Exported for tests.
 */
export function fuseRRF(
  lex: LexLegRow[],
  vec: VecLegRow[],
  topN: number,
  k: number = RRF_K
): FusedRanking[] {
  const byChunk = new Map<
    string,
    {
      scores: { lex?: number; vec?: number; fused: number }
      ranks: { lex?: number; vec?: number }
      mtimeMs?: number
    }
  >()
  lex.forEach((row, idx) => {
    const rank = idx + 1
    const fused = 1 / (k + rank)
    byChunk.set(row.chunk_id, {
      scores: { lex: row.score, fused },
      ranks: { lex: rank },
      mtimeMs: row.mtimeMs
    })
  })
  vec.forEach((row, idx) => {
    const rank = idx + 1
    const contribution = 1 / (k + rank)
    const existing = byChunk.get(row.chunk_id)
    if (existing) {
      existing.scores.vec = row.distance
      existing.scores.fused += contribution
      existing.ranks.vec = rank
      if (existing.mtimeMs === undefined) existing.mtimeMs = row.mtimeMs
    } else {
      byChunk.set(row.chunk_id, {
        scores: { vec: row.distance, fused: contribution },
        ranks: { vec: rank },
        mtimeMs: row.mtimeMs
      })
    }
  })

  // Optional freshness boost — flag-gated, default OFF. Applied AFTER fusion,
  // BEFORE the sort. When OFF this whole block is skipped and the fused scores
  // and ordering are byte-identical to the pure-RRF path. The factor is a
  // bounded, monotone multiplier in (1, 1 + FRESHNESS_WEIGHT], so it can only
  // reorder near-ties — it never pushes a note below one that is both newer AND
  // higher-fused. Unknown-mtime rows get factor 1 (unchanged).
  if (rrfFreshnessEnabled()) {
    const now = Date.now()
    for (const info of byChunk.values()) {
      const factor = freshnessFactor(info.mtimeMs, now)
      if (factor !== 1) info.scores.fused *= factor
    }
  }

  const sorted = [...byChunk.entries()]
    .map(([chunkId, info]) => ({
      chunkId,
      scores: info.scores,
      ranks: info.ranks
    }))
    .sort((a, b) => b.scores.fused - a.scores.fused)
  return sorted.slice(0, topN)
}

// ──────────────────── events ────────────────────

function emitQueryEvent(
  type: 'rag.query.completed' | 'rag.query.failed',
  input: RetrievalInput,
  info: RetrievalRunInfo
): void {
  try {
    recordEvent({
      type,
      actorKind: 'system',
      severity: type === 'rag.query.failed' ? 'error' : 'info',
      entityKind: 'rag-retrieval',
      entityId: info.retrievalId,
      payload: {
        retrievalId: info.retrievalId,
        scopes: input.collectionIds,
        lexHits: info.lexHits,
        vecHits: info.vecHits,
        fusedCount: info.fusedCount,
        durationMs: info.durationMs,
        queryPreview: boundedJsonPreview(input.query, 200)
      }
    })
  } catch (err) {
    console.error(`[rag-retrieve] ${type} event failed:`, err)
  }
}

/** Persist a retrieval row after the chat handler knows the message id. */
export function persistRetrieval(args: {
  retrievalId: string
  messageId: string
  conversationId: string
  queryText: string
  queryKind: string
  scopes: string[]
  results: RetrievedChunk[]
  durationMs: number
  correlationId?: string
}): void {
  try {
    const db = getDb()
    db.prepare(
      `INSERT INTO rag_retrievals
         (id, message_id, conversation_id, query_text, query_kind,
          scopes_json, results_json, duration_ms, created_at, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      args.retrievalId,
      args.messageId,
      args.conversationId,
      args.queryText,
      args.queryKind,
      JSON.stringify(args.scopes),
      JSON.stringify(
        args.results.map((r) => ({
          chunkId: r.chunkId,
          documentId: r.documentId,
          scores: r.scores,
          ranks: r.ranks
        }))
      ),
      args.durationMs,
      Date.now(),
      args.correlationId ?? null
    )
  } catch (err) {
    console.error('[rag-retrieve] persistRetrieval failed:', err)
  }
}
