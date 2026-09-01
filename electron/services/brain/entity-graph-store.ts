// entity-graph-store — Foundation 3, the PERSISTENT entity node/edge substrate.
//
// DUIN's other durable stores are structurally the wrong shape for incremental identity work:
//   - operator-facts (operator-model.ts) is FLAT — facts, no edges.
//   - claim-ledger (claim-ledger.ts saveLedger) is a WHOLE-FILE rewrite.
//   - construction JSON (construct.ts getResolvedConstruction) is a full-rebuild BATCH artifact,
//     memoised per generation.
// None supports a SINGLE-NODE incremental write or an O(deg) neighbour read — the two primitives a
// write-time relink and a retirement cascade both need. This module is that store: a thin better-
// sqlite3 module mirroring brain-db.ts (getDb + withWriteRetry, every call BEST-EFFORT / fail-open),
// backed by the entity_nodes / entity_edges tables (brain-schema.ts, migration v27).
//
// It is RETIRE-NOT-DELETE (retireNode sets valid_to, never DELETEs — mirrors the claim ledger) and
// it is NOT a merge gate: entity-resolver's ENTITY_ALIAS whitelist + disjoint-subgraph tripwire stay
// the SOLE merge authority. This store only adds persistence, a neighbour index, and reversible
// retirement.
//
// TEST LOAD: like brain-db this reaches the DB via getDb() (which imports electron). To let the store
// be unit-tested against a real in-memory better-sqlite3 WITHOUT the electron module graph, a test may
// inject a handle via __setEntityGraphDbForTests(db); production always resolves getDb(). The injected
// handle only shortcuts the accessor — the SQL executed is identical to production.

import type { Database } from 'better-sqlite3'
import { getDb, withWriteRetry } from '../database'
import { checkLabel } from './label-sanity'

/** A persistent entity node. `canonicalId` is set only once the node has been folded into another
 *  identity (rekeyNode); a live first-class node leaves it null. */
export interface EntityNode {
  id: string
  kind: string
  label: string
  canonicalId?: string | null
}

/** Which plane minted a node. `claim` rows legitimately carry kind='entity' — that path knows a
 *  label and has no kind to assign — so this is what lets the two populations be told apart
 *  instead of being read as one number. Never inferred; see migration v46. */
export type NodeSource = 'construction' | 'claim' | 'operator' | 'unknown'

function nowISO(): string {
  return new Date().toISOString()
}

// ──────────────────── DB accessor (production getDb; test-injectable) ────────────────────

let injectedDb: Database | null = null

/** TEST-ONLY: inject an in-memory better-sqlite3 handle (with ENTITY_GRAPH_SCHEMA_SQL applied) so the
 *  store's real SQL runs without the electron module graph. Pass null to clear. */
export function __setEntityGraphDbForTests(db: Database | null): void {
  injectedDb = db
}

/** Resolve the DB handle — the injected test handle if present, else the app DB (getDb). */
function egDb(): Database {
  return injectedDb ?? (getDb() as unknown as Database)
}

// ──────────────────── writes (single-node incremental UPSERTs) ────────────────────

/** Upsert one entity node (one row per id; a re-observation refreshes label/kind + updated_at). A
 *  node already retired (valid_to set) stays retired — upsert does NOT resurrect it (use unretire via
 *  a re-key). Best-effort: DB error ⇒ no-op.
 *
 *  REFUSES a byte-level corrupt label (label-sanity.ts). This is the single choke point every node
 *  write passes through, so it is the only place the guard has to live. Measured 2026-08-03: five
 *  such nodes existed, each a duplicate identity of a healthy node — and the entity auto-merge can
 *  never reclaim them, because it matches on embedding similarity and garbled bytes are near
 *  nothing. Refusing the write is what keeps them from accruing on the rim forever. */
// One warning per node id per process. Bounded so a pathological extractor cannot grow it
// without limit; at the cap the set stops admitting new ids and later rejects go quiet,
// which is the right failure for a log-noise guard.
const warnedCorruptLabels = new Set<string>()
const WARNED_CORRUPT_LABEL_CAP = 500

/** Test seam — the set is module state and would otherwise leak between cases. */
export function __resetCorruptLabelWarnings(): void {
  warnedCorruptLabels.clear()
}

export function upsertNode(node: EntityNode, now: string = nowISO(), source: NodeSource = 'unknown'): void {
  const verdict = checkLabel(node.label)
  if (!verdict.ok) {
    // Loud, not silent: a dropped node must be explainable, and the recovered text (when there is
    // one) names what upstream should have produced.
    //
    // ONCE PER ID, though. Extraction re-offers the same rejects on every tick, so warning per
    // occurrence turned a working guard into a log flood that buries everything else — reported
    // from a real session as "I keep seeing not-a-name". The refusal is unchanged; only the
    // repetition is suppressed, and the first one still says exactly what was dropped and why.
    if (!warnedCorruptLabels.has(node.id)) {
      if (warnedCorruptLabels.size < WARNED_CORRUPT_LABEL_CAP) warnedCorruptLabels.add(node.id)
      console.warn(
        `[entity-graph] refused a corrupt label (${verdict.reason}) id=${node.id} label=${JSON.stringify(node.label)}` +
          (verdict.recovered ? ` — reads as ${JSON.stringify(verdict.recovered)}` : '') +
          ' (further refusals of this id are silent)'
      )
    }
    return
  }
  try {
    withWriteRetry(
      () =>
        egDb()
          .prepare(
            `INSERT INTO entity_nodes (id, kind, label, canonical_id, valid_to, source, created_at, updated_at)
             VALUES (@id, @kind, @label, @canonical_id, NULL, @source, @now, @now)
             ON CONFLICT(id) DO UPDATE SET
               -- Never DOWNGRADE a typed node to the defect marker. 'entity' means
               -- "typed extraction failed", so it must not overwrite a successful
               -- extraction. The claim path resolves most labels to kind='entity'
               -- and re-stamped every node it touched on each 15-minute tick, which
               -- is why the entity-kind share sat at 63% and would not decay even
               -- after the identity-spine repair re-typed 2,032 rows.
               kind = CASE WHEN excluded.kind = 'entity' THEN entity_nodes.kind ELSE excluded.kind END,
               label = excluded.label,
               canonical_id = COALESCE(excluded.canonical_id, entity_nodes.canonical_id),
               -- The same asymmetry as the kind column above, for the same reason. Claims re-observe
               -- labels on every 15-minute tick; if a re-observation could rewrite provenance, the
               -- two populations would collapse back into one number within the hour — which is
               -- exactly how the graph read before this column existed.
               source = CASE WHEN excluded.source = 'claim' AND entity_nodes.source = 'construction'
                             THEN entity_nodes.source ELSE excluded.source END,
               updated_at = excluded.updated_at`
          )
          .run({ id: node.id, kind: node.kind, label: node.label, canonical_id: node.canonicalId ?? null, source, now }),
      { label: 'entity-graph-store.upsertNode' }
    )
  } catch (err) {
    console.warn('[entity-graph-store] upsertNode failed:', (err as Error)?.message)
  }
}

/** Upsert one directed edge (src --type--> dst). Idempotent on (src,dst,type): a re-observation just
 *  bumps updated_at (and un-retires the edge, since a fresh observation means it's live again).
 *  Best-effort. */
export function upsertEdge(src: string, dst: string, type: string, now: string = nowISO()): void {
  try {
    withWriteRetry(
      () =>
        egDb()
          .prepare(
            `INSERT INTO entity_edges (src, dst, type, valid_to, created_at, updated_at)
             VALUES (@src, @dst, @type, NULL, @now, @now)
             ON CONFLICT(src, dst, type) DO UPDATE SET
               valid_to = NULL, updated_at = excluded.updated_at`
          )
          .run({ src, dst, type, now }),
      { label: 'entity-graph-store.upsertEdge' }
    )
  } catch (err) {
    console.warn('[entity-graph-store] upsertEdge failed:', (err as Error)?.message)
  }
}

// ──────────────────── reads (indexed neighbour lookups) ────────────────────

/** Live neighbours of `id` in BOTH directions (out via src, in via dst), deduped. Served by the
 *  src/dst indexes — an O(deg) read, the primitive write-time relink is built on. Returns [] on any
 *  DB error (fail-open). */
export function neighborsOf(id: string): string[] {
  try {
    const rows = egDb()
      .prepare(
        `SELECT dst AS n FROM entity_edges WHERE src = @id AND valid_to IS NULL
         UNION
         SELECT src AS n FROM entity_edges WHERE dst = @id AND valid_to IS NULL`
      )
      .all({ id }) as Array<{ n: string }>
    return rows.map((r) => r.n)
  } catch (err) {
    console.warn('[entity-graph-store] neighborsOf failed:', (err as Error)?.message)
    return []
  }
}

/** The live PARENTS of `id` — nodes with an edge pointing INTO id (dst = id). This is the multi-parent
 *  set the retirement cascade's `.every` orphan test walks. Served by idx_entity_edges_dst. */
export function parentsOf(id: string): string[] {
  try {
    const rows = egDb()
      .prepare(`SELECT DISTINCT src AS p FROM entity_edges WHERE dst = @id AND valid_to IS NULL`)
      .all({ id }) as Array<{ p: string }>
    return rows.map((r) => r.p)
  } catch (err) {
    console.warn('[entity-graph-store] parentsOf failed:', (err as Error)?.message)
    return []
  }
}

/** A live, typed edge row — the shape `neighborsOf` erases (it returns bare ids). The Relations
 *  surface needs type + endpoints to render a labeled drawer, so this is the read it rides. */
export interface EntityEdgeRow {
  src: string
  dst: string
  type: string
}

/** The live edges INCIDENT to `id`, both directions, WITH their types. Returns [] on error. */
export function edgesOf(id: string): EntityEdgeRow[] {
  try {
    return egDb()
      .prepare(
        `SELECT src, dst, type FROM entity_edges WHERE (src = @id OR dst = @id) AND valid_to IS NULL`
      )
      .all({ id }) as EntityEdgeRow[]
  } catch (err) {
    console.warn('[entity-graph-store] edgesOf failed:', (err as Error)?.message)
    return []
  }
}

/** Hydrate a set of node ids (live only), preserving ask order and dropping unknowns. */
export function nodesByIds(ids: string[]): Array<{ id: string; label: string; kind: string; source: NodeSource }> {
  const want = (ids ?? []).filter(Boolean)
  if (!want.length) return []
  try {
    const placeholders = want.map(() => '?').join(',')
    const rows = egDb()
      .prepare(`SELECT id, label, kind, source FROM entity_nodes WHERE valid_to IS NULL AND id IN (${placeholders})`)
      .all(...want) as Array<{ id: string; label: string; kind: string; source: NodeSource }>
    const byId = new Map(rows.map((r) => [r.id, r]))
    return want.map((i) => byId.get(i)).filter((r): r is NonNullable<typeof r> => !!r)
  } catch (err) {
    console.warn('[entity-graph-store] nodesByIds failed:', (err as Error)?.message)
    return []
  }
}

/** Resolve a human label to a live node id, case-insensitively. First match wins (deterministic
 *  by id order); null on miss/error — the Relations anchor box accepts labels, ids are exact. */
export function findNodeIdByLabel(label: string): string | null {
  const key = String(label ?? '').trim().toLowerCase()
  if (!key) return null
  try {
    const row = egDb()
      .prepare(`SELECT id FROM entity_nodes WHERE valid_to IS NULL AND lower(label) = ? ORDER BY id LIMIT 1`)
      .get(key) as { id: string } | undefined
    return row?.id ?? null
  } catch (err) {
    console.warn('[entity-graph-store] findNodeIdByLabel failed:', (err as Error)?.message)
    return null
  }
}

/** Ids of the currently-live (valid_to IS NULL) nodes. Returns [] on error. */
export function liveNodeIds(): string[] {
  try {
    const rows = egDb().prepare(`SELECT id FROM entity_nodes WHERE valid_to IS NULL`).all() as Array<{ id: string }>
    return rows.map((r) => r.id)
  } catch (err) {
    console.warn('[entity-graph-store] liveNodeIds failed:', (err as Error)?.message)
    return []
  }
}

/** The currently-live nodes (id + label + kind) — shadow-sync reads these to spot a raw node the
 *  whitelist now folds. Returns [] on error. */
export function liveNodes(): Array<{ id: string; label: string; kind: string; source: NodeSource }> {
  try {
    return egDb()
      .prepare(`SELECT id, label, kind, source FROM entity_nodes WHERE valid_to IS NULL`)
      .all() as Array<{ id: string; label: string; kind: string; source: NodeSource }>
  } catch (err) {
    console.warn('[entity-graph-store] liveNodes failed:', (err as Error)?.message)
    return []
  }
}

/**
 * Node counts split by PLANE — the reading the coherence axis needs and could not previously make.
 *
 * `kind='entity'` means two different things depending on where a row came from: from
 * `construction` it is a FAILED typed extraction (a real defect), from `claim` it is honest
 * ignorance, because that path resolves a label and has no kind to assign. Reported as one number,
 * 3,630 of 5,776 nodes read as "63% carry a defect marker" when almost none of them did.
 */
export function nodeCountsByPlane(): Record<NodeSource, { total: number; untyped: number }> {
  const empty = (): { total: number; untyped: number } => ({ total: 0, untyped: 0 })
  const out: Record<NodeSource, { total: number; untyped: number }> = {
    construction: empty(),
    claim: empty(),
    operator: empty(),
    unknown: empty()
  }
  try {
    const rows = egDb()
      .prepare(
        `SELECT source, kind, COUNT(*) AS n FROM entity_nodes WHERE valid_to IS NULL GROUP BY source, kind`
      )
      .all() as Array<{ source: string; kind: string; n: number }>
    for (const r of rows) {
      const key: NodeSource = r.source in out ? (r.source as NodeSource) : 'unknown'
      out[key].total += r.n
      if (r.kind === 'entity') out[key].untyped += r.n
    }
  } catch (err) {
    console.warn('[entity-graph-store] nodeCountsByPlane failed:', (err as Error)?.message)
  }
  return out
}

/** Whether a node exists and is currently live (valid_to IS NULL). False on error/absent. */
export function isNodeLive(id: string): boolean {
  try {
    const row = egDb()
      .prepare(`SELECT 1 AS ok FROM entity_nodes WHERE id = @id AND valid_to IS NULL`)
      .get({ id }) as { ok: number } | undefined
    return !!row
  } catch (err) {
    console.warn('[entity-graph-store] isNodeLive failed:', (err as Error)?.message)
    return false
  }
}

// ──────────────────── retirement (retire-not-delete) ────────────────────

/** Retire a node — set valid_to (reversible), NEVER delete the row. Mirrors the claim ledger's
 *  retire pattern. Idempotent: a re-retire refreshes valid_to only if it was still live. Best-effort. */
export function retireNode(id: string, now: string = nowISO()): void {
  try {
    withWriteRetry(
      () =>
        egDb()
          .prepare(`UPDATE entity_nodes SET valid_to = @now, updated_at = @now WHERE id = @id AND valid_to IS NULL`)
          .run({ id, now }),
      { label: 'entity-graph-store.retireNode' }
    )
  } catch (err) {
    console.warn('[entity-graph-store] retireNode failed:', (err as Error)?.message)
  }
}

/** The persisted analog of entity-resolver.resolveEntityIdentity's edge rewire: rewrite every edge
 *  endpoint `oldId → newId` (both src and dst), and stamp `canonical_id = newId` on the old node so
 *  the fold is recorded and reversible. Does NOT retire the old node itself — the caller (cascade)
 *  decides that, keeping rekey a pure rewire. Idempotent; best-effort. */
export function rekeyNode(oldId: string, newId: string, now: string = nowISO()): void {
  if (oldId === newId) return
  try {
    withWriteRetry(
      () => {
        const db = egDb()
        const tx = db.transaction(() => {
          // Rewire edges. A rewire can collide with an existing (newId,dst,type) row; OR IGNORE keeps
          // the surviving row and drops the now-duplicate old one (edge identity is the triple).
          db.prepare(`UPDATE OR IGNORE entity_edges SET src = @newId, updated_at = @now WHERE src = @oldId`).run({ oldId, newId, now })
          db.prepare(`UPDATE OR IGNORE entity_edges SET dst = @newId, updated_at = @now WHERE dst = @oldId`).run({ oldId, newId, now })
          // Any edge rows that survived as duplicates under the old id are removed (they were folded).
          db.prepare(`DELETE FROM entity_edges WHERE src = @oldId OR dst = @oldId`).run({ oldId })
          // Record the fold on the old node (reversible bookkeeping).
          db.prepare(`UPDATE entity_nodes SET canonical_id = @newId, updated_at = @now WHERE id = @oldId`).run({ oldId, newId, now })
        })
        tx()
      },
      { label: 'entity-graph-store.rekeyNode' }
    )
  } catch (err) {
    console.warn('[entity-graph-store] rekeyNode failed:', (err as Error)?.message)
  }
}
