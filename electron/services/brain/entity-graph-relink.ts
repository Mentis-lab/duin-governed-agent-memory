// entity-graph-relink — the two MUTATION passes over the persistent entity graph (entity-graph-store):
//
//   1. WRITE-TIME RELINK (relinkNeighbors / writeTimeRelink) — on the 15-min metabolism tick, as
//      claims arrive it does a write-time `neighborsOf` + `upsertEdge` for each claim's subject→object,
//      so the graph's edges EVOLVE incrementally between the (batch, ~30-min) construction rebuilds.
//      It REUSES the whitelist (aliasCanonicalId) as the sole identity authority and the SHARED
//      disjoint-subgraph tripwire (neighboursDisjointSets) so it NEVER merges — it only ADDS edges
//      within a whitelist-sanctioned identity.
//
//   2. RETIREMENT CASCADE (cascadeInvalidate / barrierRepair) — fired ONLY as a CONSEQUENCE of an
//      alias-merge / entity-removal that is already whitelist-sanctioned (isAliasCanonicalId). It does
//      retireNode + a real `.every`-semantics multi-parent orphan walk over the now-persistent graph,
//      and EXCLUDES shared entities (a node with ≥1 live parent is NOT orphaned — the over-orphan trap).
//
// SAFETY. Both passes are gated behind DUIN_ENTITY_GRAPH, which is `!== '0'` — DEFAULT ON, opt-out
// (see entityGraphEnabled below). Set DUIN_ENTITY_GRAPH=0 and every entrypoint becomes a
// zero-DB-access no-op, leaving the tick + metabolism byte-identical; on a default install they run.
// No path here ever makes an autonomous merge decision — the whitelist stays the sole merge gate and
// this module only PERSISTS its consequences. (The whitelist itself is appended to unattended by
// entity-automerge-tick.ts under the containment-spine policy — that decision is made there, not
// here.) Every store call is best-effort/fail-open, so a DB error can never crash the tick.
//
// This module unifies the two blocked activations (auto-relink, cascade-invalidation): both needed the
// same missing thing — a persistent node/edge store with single-node writes + a neighbour index.

import type { Claim } from './claim-metabolism'
import type { ConstructedData } from './types'
import { aliasCanonicalId, isAliasCanonicalId, neighboursDisjointSets, slugifyLabel } from './entity-resolver'
import { loadPersistedLedger } from './claim-extract'
import {
  upsertNode,
  upsertEdge,
  neighborsOf,
  parentsOf,
  retireNode,
  rekeyNode,
  liveNodeIds,
  liveNodes,
  isNodeLive,
  type EntityNode
} from './entity-graph-store'
import { edgeTypeForClaimRelation, RELATION_TO_EDGE } from './construct'

/** Default ON (world-model Stage 1). It was default-OFF while the persisted graph was a
 *  WRITTEN·NEVER·READ sink — nothing read the rows back, so every capture burned a reveal pass into
 *  a dead store. `kg-query.ts` is now that reader (multi-hop + as-of traversal), which satisfies the
 *  "make the sink productive" branch of the GAPS.md recipe, so the gate flips. Set
 *  DUIN_ENTITY_GRAPH=0 to opt out; this is a staging flag, NOT a safety gate — it governs graph
 *  persistence only, never enactment or permissions. */
export function entityGraphEnabled(): boolean {
  return process.env.DUIN_ENTITY_GRAPH !== '0'
}

// Matches entity-resolver's default tripwire degree — a fold is only vetoed when BOTH sides carry a
// genuinely high-degree, edge-disjoint neighbourhood (low-degree LLM fragments never trip it).
const TRIPWIRE_HIGH_DEGREE = 6

// Cap on whitelist-merge cascades performed in ONE sync pass, and the reason it exists.
//
// The whitelist can GROW by hundreds of groups in a single pass (entity-kind-collapse-tick took it
// from 14 to 489 on 2026-08-04), and every group it adds can make many live raw nodes newly
// foldable at once. Each fold is a rekey + retire; the batch then pays one barrierRepair. That is
// cheap now, but "cheap × unbounded" is how the 2026-08-04 incident started, so the pass takes a
// bounded bite and leaves the rest for the next tick. The backlog is logged, never silently
// dropped — a fold deferred here is re-found by the identical scan 15 minutes later.
const DEFAULT_MAX_FOLDS_PER_PASS = 200

function maxFoldsPerPass(): number {
  const raw = Number(process.env.DUIN_GRAPH_MAX_FOLDS_PER_PASS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_FOLDS_PER_PASS
}

/** Resolve a surface label to its persistent node identity, REUSING the whitelist as the sole merge
 *  authority and the SHARED disjoint-subgraph tripwire as the over-merge guard. Returns null for an
 *  empty/unsluggable label.
 *   - not whitelisted ⇒ its own derived id `entity:<slug>` (never merged with anything).
 *   - whitelisted ⇒ the group's canonical id, UNLESS a raw node for this label already carries a
 *     high-degree neighbourhood edge-disjoint from the canonical's (the signature of two distinct
 *     entities sharing a label) — then the tripwire blocks the fold and the raw id is kept. */
export function resolveNodeId(label: string): EntityNode | null {
  const clean = (label ?? '').trim()
  if (!clean) return null
  const slug = slugifyLabel(clean)
  const canon = aliasCanonicalId(clean)
  if (!canon) {
    if (!slug) return null
    return { id: `entity:${slug}`, kind: 'entity', label: clean }
  }
  const rawId = `entity:${slug}`
  if (rawId !== canon) {
    const na = new Set(neighborsOf(canon))
    const nb = new Set(neighborsOf(rawId))
    if (na.size >= TRIPWIRE_HIGH_DEGREE && nb.size >= TRIPWIRE_HIGH_DEGREE && neighboursDisjointSets(na, nb, canon, rawId)) {
      return { id: rawId, kind: 'entity', label: clean } // tripwire vetoed the merge → keep raw identity
    }
  }
  const kind = canon.includes(':') ? canon.slice(0, canon.indexOf(':')) : 'entity'
  return { id: canon, kind, label: clean }
}

export interface RelinkResult {
  /** claims examined. */ claims: number
  /** node upserts issued. */ nodes: number
  /** NEW edges added (existing neighbours are skipped via the neighbour index). */ edges: number
  /** true when the flag was off ⇒ a zero-DB no-op (proof of byte-identical flag-off). */ skipped: boolean
}

/**
 * WRITE-TIME RELINK (the auto-relink activation). For each ACTIVE claim, upsert its subject + object
 * nodes and add the subject→object edge — but only after a write-time `neighborsOf(subject)` read
 * confirms the edge is genuinely new (so the neighbour index is load-bearing, not decorative). Never
 * merges: identity comes from the whitelist + tripwire in resolveNodeId; this only ADDS edges.
 * Best-effort throughout. Flag-off ⇒ immediate no-op (no store access at all).
 */
export function relinkNeighbors(claims: Claim[], now: string = new Date().toISOString()): RelinkResult {
  if (!entityGraphEnabled()) return { claims: 0, nodes: 0, edges: 0, skipped: true }
  let nodes = 0
  let edges = 0
  let seen = 0
  for (const c of claims) {
    if (c.validTo !== null) continue // only live claims contribute edges
    const subj = resolveNodeId(c.subject)
    const obj = resolveNodeId(c.object)
    if (!subj || !obj || subj.id === obj.id) continue
    seen++
    // 'claim': this path resolves a LABEL and has no kind for it, so its kind='entity' is honest
    // ignorance rather than a failed extraction. Stamping the plane is what makes that readable.
    upsertNode(subj, now, 'claim')
    upsertNode(obj, now, 'claim')
    nodes += 2
    // Bounded to the closed edge vocabulary. This used to write
    // `canonicalRelation()` — a supersession SORT KEY that alphabetizes tokens —
    // straight into entity_edges.type, which is why the column holds 692 types
    // like `and ceo founder`. See edgeTypeForClaimRelation.
    const rel = edgeTypeForClaimRelation(c.relation)
    // write-time incremental read: only add the edge if this neighbour isn't already linked.
    const existing = neighborsOf(subj.id)
    if (!existing.includes(obj.id)) {
      upsertEdge(subj.id, obj.id, rel, now)
      edges++
    }
  }
  return { claims: seen, nodes, edges, skipped: false }
}

/** Tick-facing wrapper: load the persisted claim ledger for `vaultDir` and relink its neighbours into
 *  the persistent graph. This is the write-time moment hung on the 15-min metabolism tick. Flag-off ⇒
 *  no-op before any IO. Best-effort — a bad vault / DB error never throws. */
export function writeTimeRelink(vaultDir: string | null, now: string = new Date().toISOString()): RelinkResult {
  if (!entityGraphEnabled()) return { claims: 0, nodes: 0, edges: 0, skipped: true }
  try {
    const claims = loadPersistedLedger(vaultDir)
    return relinkNeighbors(claims, now)
  } catch (err) {
    console.warn('[entity-graph-relink] writeTimeRelink failed (non-fatal):', (err as Error)?.message)
    return { claims: 0, nodes: 0, edges: 0, skipped: false }
  }
}

/**
 * BARRIER-REPAIR — the `.every`-semantics multi-parent orphan walk over the now-persistent graph.
 * A live node is ORPHANED iff it HAS parents and EVERY parent is retired; a node with ≥1 LIVE parent
 * is a shared entity and is NOT orphaned (the over-orphan exclusion). Roots (no parents) are never
 * orphaned. Runs to a fixpoint so an orphan cascades from a just-retired parent (JTMS-style), over a
 * REAL multi-parent graph — unlike claim-metabolism's dark JTMS step whose justifications array is
 * 0-or-1 element (there `.some` ≡ `.every`). Returns the ids retired by this repair. Best-effort.
 */
export function barrierRepair(now: string = new Date().toISOString()): string[] {
  const retiredHere: string[] = []
  let changed = true
  let guard = 0
  while (changed && guard++ < 10_000) {
    changed = false
    for (const id of liveNodeIds()) {
      const parents = parentsOf(id)
      if (parents.length === 0) continue // a root is not an orphan
      // `.every`: orphaned only when ALL parents are retired. One live parent ⇒ shared entity ⇒ keep.
      if (parents.every((p) => !isNodeLive(p))) {
        retireNode(id, now)
        retiredHere.push(id)
        changed = true
      }
    }
  }
  return retiredHere
}

export interface CascadeResult {
  /** ids retired directly (the merged-away / removed node). */ retired: string[]
  /** ids retired by the downstream orphan cascade. */ orphaned: string[]
  /** true when flag-off (no-op) or the merge target was not whitelist-sanctioned (refused). */ skipped: boolean
  /** set when a merge was refused because its target is not a whitelist canonical id. */ refused?: 'not-whitelisted'
}

/**
 * CASCADE-INVALIDATE (the cascade activation). Fired ONLY as a CONSEQUENCE of an alias-merge or an
 * entity-removal — NEVER an autonomous decision:
 *   - merge (`mergedInto` set): the target MUST be a whitelist canonical id (isAliasCanonicalId) or the
 *     call is REFUSED — this is how no-auto-merge is preserved (retirement can only follow a
 *     human-confirmed whitelist group). rekeyNode rewires the merged-away node's edges onto the
 *     canonical, then the merged-away id is retired.
 *   - removal (no `mergedInto`): the node is retired directly.
 * Then barrierRepair runs the `.every` orphan cascade (shared entities excluded). Flag-off ⇒ no-op.
 */
export function cascadeInvalidate(
  nodeId: string,
  now: string = new Date().toISOString(),
  opts: { mergedInto?: string; deferBarrier?: boolean } = {}
): CascadeResult {
  if (!entityGraphEnabled()) return { retired: [], orphaned: [], skipped: true }
  const { mergedInto } = opts
  if (mergedInto) {
    // no-auto-merge guard: refuse any merge whose target isn't a human-confirmed whitelist group.
    if (!isAliasCanonicalId(mergedInto)) {
      console.warn(
        `[entity-graph-relink] cascadeInvalidate REFUSED: merge target "${mergedInto}" is not a whitelist ` +
          `canonical id — the cascade only ever follows a human-confirmed alias merge.`
      )
      return { retired: [], orphaned: [], skipped: true, refused: 'not-whitelisted' }
    }
    rekeyNode(nodeId, mergedInto, now) // persisted analog of resolveEntityIdentity's edge rewire
  }
  retireNode(nodeId, now)
  // `deferBarrier` is for BATCH callers, and it is the fix for the 2026-08-04 memory incident.
  //
  // barrierRepair is a to-fixpoint pass over the WHOLE graph: it re-reads every live id and issues a
  // parentsOf query per node, repeating until a sweep changes nothing. Running it inside a per-node
  // cascade makes a batch of M folds cost M × O(graph) — measured on the live vault that was ~450
  // folds × ~24k SQLite queries, a synchronous loop that grew the working set ~450 MB per 15s and
  // never finished. Hoisting it is safe because orphanhood is MONOTONE in the set of retirements:
  // retiring more nodes can only ever create more orphans, never un-orphan one. So one sweep after
  // the batch reaches the same fixpoint as a sweep after each element — the loop's own `while
  // (changed)` is what guarantees it, and it is why this is a cost fix and not a semantics change.
  const orphaned = opts.deferBarrier ? [] : barrierRepair(now)
  return { retired: [nodeId], orphaned, skipped: false }
}

export interface SyncResult {
  /** node upserts from the construction (existence-authoritative). */ nodes: number
  /** whitelist-merge cascades fired as a consequence. */ merges: number
  /** folds this pass declined because it hit its per-pass cap — re-found by the next tick's
   *  identical scan, never dropped. Non-zero means the graph is still draining a backlog. */
  deferred: number
  /** true when flag-off. */ skipped: boolean
  /** entity node ids that did NOT exist before this sync.
   *
   *  upsertNode is a blind ON CONFLICT DO UPDATE and reports nothing, and probing existence
   *  per entity would be ~1k queries per sync. A live-id set difference costs two reads and
   *  answers the only question the caller has: did this sync introduce new entities? That is
   *  the trigger for duplicate detection — a new node is exactly when a duplicate can appear,
   *  and re-running the clusterer when nothing was created is pure cost. */
  created: string[]
}

/**
 * SHADOW-SYNC — mirror the batch construction into the persistent store. The construction is
 * authoritative for node EXISTENCE (its entities/edges are upserted); the incremental store is
 * authoritative for neighbour-evolution + retirement SINCE the last rebuild. The whitelist
 * (resolveNodeId) stays the sole merge authority: construction ids are mapped through it, so both
 * sources share one id space. When the whitelist has GROWN, a live raw node whose label now folds to a
 * live canonical is a CONSEQUENCE of that human-confirmed merge → cascadeInvalidate retires it and
 * rewires its edges (the ONLY retirement this pass performs — a node merely absent from a construction
 * rebuild is NEVER retired, guarding against the transient-wipe scar). Flag-off ⇒ no-op.
 *
 * `opts.maxFolds` overrides the per-pass fold cap, and the ONE caller that must override it is
 * rebuildEntityGraph. The cap exists because the background tick repeats: a fold it defers is
 * re-found by the identical scan 15 minutes later, so bounding the bite costs latency and nothing
 * else. A rebuild has no next tick — it purges the graph and syncs exactly ONCE — so the same cap
 * there would silently leave the graph half-folded with nothing to drain the remainder, and report
 * `after` counts that understate the work. Pass `Infinity` for a one-shot caller.
 */
export function syncGraphFromConstruction(
  construction: ConstructedData | null | undefined,
  now: string = new Date().toISOString(),
  opts: { maxFolds?: number } = {}
): SyncResult {
  if (!entityGraphEnabled()) return { nodes: 0, merges: 0, deferred: 0, skipped: true, created: [] }
  if (!construction) return { nodes: 0, merges: 0, deferred: 0, skipped: false, created: [] }
  // Snapshot BEFORE any upsert — the difference against the post-sync set is what "a new brain
  // node was created" means, and it is the trigger for duplicate detection downstream.
  const idsBefore = new Set(liveNodeIds())
  let nodes = 0
  // Existence: upsert every construction entity, keyed through the whitelist so ids align with relink.
  const idByConstructionId = new Map<string, string>()
  for (const e of construction.entities) {
    // IDENTITY from the resolver, KIND from the construction.
    //
    // This used to be `resolveNodeId(e.label) ?? { …, kind: String(e.kind), … }`, which looks
    // like it preserves the construction's kind but almost never does: resolveNodeId returns
    // null ONLY for an empty/unsluggable label, so for every real entity it returns a node —
    // and that node is `kind: 'entity'` unless the label happens to sit in the alias
    // whitelist. The `??` therefore never fired and the construction's real kind (person /
    // org / project / topic / decision / event) was discarded one line after being read.
    //
    // Measured consequence on the live vault: 2,051 of 2,065 entity_nodes carried
    // kind='entity' — everything outside the 14 hand-written whitelist groups — while
    // brain-construction.json typed all 987 of its entities correctly. Downstream surfaces
    // then had nothing to categorise or render by, which is why a person could show up under
    // Mental Models and why several categories had nothing to inspect.
    //
    // The resolver still owns the ID (that is the whole identity-spine contract and must not
    // change). It only loses the argument about KIND, and only when it has no opinion: a
    // whitelisted canonical like `person:…` carries a real kind and keeps it.
    const resolved = resolveNodeId(e.label)
    const rn = resolved
      ? { ...resolved, kind: resolved.kind === 'entity' ? String(e.kind) : resolved.kind }
      : { id: e.id, kind: String(e.kind), label: e.label }
    upsertNode(rn, now, 'construction')
    idByConstructionId.set(e.id, rn.id)
    nodes++
  }
  // Entity-entity edges (skip edges whose endpoint is a note id, i.e. not in the entity map).
  for (const ed of construction.edges) {
    const s = idByConstructionId.get(ed.source)
    const d = idByConstructionId.get(ed.target)
    // Map through RELATION_TO_EDGE, the same table the rendered graph uses.
    //
    // This wrote `ed.type` raw, which is a construction RelationType — so the
    // PERSISTED column held `depends_on` while `build-duin-graph` rendered the
    // identical relation as `depends`. Two spellings of one relation, split by
    // writer, in a column with no enum: property 1, and it survived only because
    // nothing read the store. Verified live after the 2026-07-30 deploy: of 658
    // edge rows written, 635 were in-vocabulary and the 23 exceptions were all
    // `depends_on` from this line.
    const t =
      RELATION_TO_EDGE[ed.type as keyof typeof RELATION_TO_EDGE] ??
      edgeTypeForClaimRelation(String(ed.type))
    if (s && d && s !== d) upsertEdge(s, d, t, now)
  }
  // Whitelist-merge cascade: a live raw node the whitelist now folds → retire as a consequence.
  // BOUNDED, and the orphan sweep is hoisted out of the loop — see maxFoldsPerPass and the
  // `deferBarrier` note in cascadeInvalidate for why both matter.
  let merges = 0
  let deferred = 0
  const maxFolds = opts.maxFolds ?? maxFoldsPerPass()
  for (const n of liveNodes()) {
    if (!n.id.startsWith('entity:')) continue // already canonical / not a fold candidate
    const canon = aliasCanonicalId(n.label)
    if (canon && canon !== n.id && isNodeLive(canon)) {
      if (merges >= maxFolds) {
        deferred++
        continue
      }
      const res = cascadeInvalidate(n.id, now, { mergedInto: canon, deferBarrier: true })
      if (!res.skipped) merges++
    }
  }
  // ONE orphan sweep for the whole batch, and only when the batch actually retired something —
  // an unchanged graph cannot have gained an orphan, so a no-fold pass now costs zero graph scans.
  if (merges > 0) barrierRepair(now)
  if (deferred > 0) {
    console.warn(
      `[entity-graph-relink] fold backlog: ${merges} folded this pass (cap ${maxFolds}), ` +
        `${deferred} deferred to the next tick. Raise DUIN_GRAPH_MAX_FOLDS_PER_PASS to drain faster.`
    )
  }
  const created = liveNodeIds().filter((id) => !idsBefore.has(id))
  return { nodes, merges, deferred, skipped: false, created }
}
