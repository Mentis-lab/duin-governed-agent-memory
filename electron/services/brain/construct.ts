// "Build my brain" — turn a folder of RAW, UNLINKED prose notes (what normal
// people actually have: no [[wikilinks]], no frontmatter, no tags) into a
// connected knowledge graph + classified notes, via ONE LLM extraction pass.
//
// This MIRRORS notes-extract.ts exactly: `buildConstructionPrompt` /
// `parseConstruction` (PURE, tolerant JSON parse) / `applyConstruction` (PURE
// merge into a CausalGraph) are unit-tested; `constructBrain` is the key-gated
// orchestration (routeModel('extraction') + chatStream → null when no model).
//
// Where notes-extract lifts TEMPORAL structure (dates/decisions/risks),
// construct lifts STRUCTURAL knowledge the prose implies but never linked:
//   - entities  — people / projects / decisions / events / orgs / topics the
//                 prose mentions, deduped across notes (one id per real thing)
//   - edges     — typed relationships between those entities (and/or notes)
//   - classifications — what each note IS (meeting / output / mental_model / …)
//
// The result is CACHED to userData keyed by the notes dir, so the graph/panels
// read constructed structure on boot without re-running the LLM every launch.

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { join, dirname } from 'path'
import type {
  CausalGraph,
  CausalNode,
  CausalEdge,
  ConstructedData,
  ConstructedEntity,
  ConstructedEdge,
  ConstructedClassification,
  ConstructedTriple,
  EntityKind,
  RelationType,
  NoteClassification
} from './types'
import { allChunks, isReindexing } from '../local-brain/index-store'
import { groupChunksByFile, extractFirstJsonObject, buildCorpus } from './extraction-util'
import { brainRootPath, BRAIN_STATE_DIR } from './brain-root'
import { clusterAliases } from './claim-entities'
import { entityResolverEnabled, resolveEntityIdentity, loadAliasGroups } from './entity-resolver'
import { migrateRetiredKinds } from './construct-kind-migration'
import { chatStream, routeModel, routeDistinctModel, routeWithinProvider, getProviderForModel } from '../providers/registry'
import { isModelNotFoundError, isProviderFailoverError } from '../providers/quota-error'
import { buildDuinGraph } from './build-duin-graph'
import { entityKey, isConstructionCorpusPath, noteOptsOutOfExtraction, pathUnderFence } from './entity-key'
import { envNum } from '../../shared/env-number'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { atomicWriteDurable } from './durable-write'

const MAX_NOTES = 40
const MAX_NOTE_CHARS = 1500
// Construction batches the whole vault MAX_NOTES notes at a time (one LLM call
// per window, merged with de-dup) instead of a single 40-note sliver. MAX_BATCHES
// bounds the fan-out so a pathological vault can't run unbounded LLM calls.
const MAX_BATCHES = 60


/** Await a bounded backoff (0 disables the sleep — used by tests / tight-loop operators). */
const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

/**
 * The entity kinds the extractor may emit. `project` was REMOVED 2026-08-04.
 *
 * It had become a catch-all for "a named thing that is not clearly a person or an org". A random
 * sample of the 1,470 construction `project` entities on the live vault contained games, companies,
 * hardware platforms, a resort, several game systems and a handful of documents. It had no crisp
 * boundary against `topic` — neither the prompt nor this file ever defined one — and it was
 * implicated in four of the top six cross-kind collision pairs, because identity is `<kind>:<slug>`
 * and an entity the model called a project on one pass and a topic on the next became two nodes.
 *
 * The operator's REAL projects are the `product` layer (cards, KRs, moves) and vault folders.
 * Construction `project` earned its keep nowhere.
 *
 * KEEP THIS IN LOCKSTEP with the two prompt literals — `buildConstructionPrompt` here and
 * `buildRevealPrompt` in construct-one-source.ts. There is no mechanical link between the three,
 * so `construct-kind-vocabulary.test.ts` asserts they agree; without it, editing this Set alone
 * would leave the model still emitting `project` and `coerceEntityKind` silently deleting every
 * one of them, on a 24-hour timer, with no log.
 */
const ENTITY_KINDS = new Set<EntityKind>(['person', 'decision', 'event', 'org', 'topic'])

/** Kinds no longer emitted, mapped to their successor rather than dropped. See `coerceEntityKind`. */
const RETIRED_ENTITY_KINDS: Record<string, EntityKind> = { project: 'topic' }
const RELATION_TYPES = new Set<RelationType>([
  'owns',
  'depends_on',
  'blocks',
  'attends',
  'affects',
  'mentions',
  'about'
])
const CLASSIFICATIONS = new Set<NoteClassification>([
  'meeting',
  'output',
  'mental_model',
  'decision',
  'note'
])

/** Map a construction relationship → the CausalEdge.type the graph renders. `'synonym'` is the
 *  construction-computed alias bridge (L3): identity-mapped so it flows unchanged through both
 *  applyConstruction (render graph) and liveGraph (retriever) — neither special-cases it. */
export const RELATION_TO_EDGE: Record<RelationType | 'synonym', string> = {
  owns: 'owns',
  depends_on: 'depends',
  blocks: 'blocks',
  attends: 'attends',
  affects: 'affects',
  mentions: 'mentions',
  about: 'about',
  synonym: 'synonym'
}

/** The closed set of edge types the graph renders, plus the honest fallback. */
export const EDGE_TYPE_FALLBACK = 'related'
const EDGE_TYPES: ReadonlySet<string> = new Set([
  ...Object.values(RELATION_TO_EDGE),
  EDGE_TYPE_FALLBACK
])

/** Token → edge type, for the free-text relations the CLAIM path carries. Small and
 *  deliberately incomplete: a relation that does not clearly match one of these is
 *  better recorded as `related` than guessed at. */
const RELATION_TOKEN_TO_EDGE: Readonly<Record<string, string>> = {
  own: 'owns',
  owns: 'owns',
  owner: 'owns',
  owned: 'owns',
  depend: 'depends',
  depends: 'depends',
  depends_on: 'depends',
  requires: 'depends',
  block: 'blocks',
  blocks: 'blocks',
  blocked: 'blocks',
  blocking: 'blocks',
  attend: 'attends',
  attends: 'attends',
  attended: 'attends',
  affect: 'affects',
  affects: 'affects',
  affected: 'affects',
  impacts: 'affects',
  mention: 'mentions',
  mentions: 'mentions',
  mentioned: 'mentions',
  about: 'about',
  synonym: 'synonym'
}

/**
 * Edge type for a free-text claim relation, bounded to the closed vocabulary.
 *
 * The claim path used to write `canonicalRelation()` straight into
 * `entity_edges.type`. That function is a SUPERSESSION SORT KEY — it alphabetizes
 * tokens — so the column filled with word-salad: `and ceo founder`,
 * `about confirmed note`, `date due`, `because wrong`. 692 distinct types, 564 of
 * them occurring exactly once, and no rebuild path to clear them. One function
 * serving two concepts, which is the drift `GLOSSARY.md` exists to prevent.
 *
 * `canonicalRelation` keeps its real job (the supersession key) untouched. This is
 * the display/traversal type, and it is closed by construction: an unrecognised
 * relation becomes `related` rather than inventing a new type.
 */
export function edgeTypeForClaimRelation(raw: string): string {
  const norm = (raw ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, ' ')
    .trim()
  if (!norm) return EDGE_TYPE_FALLBACK
  // An exact hit on an existing edge type (structured writers already emit these).
  const compact = norm.replace(/\s+/g, '_')
  if (EDGE_TYPES.has(compact)) return compact
  if (RELATION_TOKEN_TO_EDGE[compact]) return RELATION_TOKEN_TO_EDGE[compact]
  // Otherwise the first token that maps. `confirmed note about` → `about`.
  for (const tok of norm.split(/[\s-]+/)) {
    const hit = RELATION_TOKEN_TO_EDGE[tok]
    if (hit) return hit
  }
  return EDGE_TYPE_FALLBACK
}

// L3 synonym bridge — construction-time (offline). HippoRAG-2 precomputes embedding synonym edges
// at CONSTRUCTION so query-time resolution stays cheap/substring. DUIN already has the resolver in
// the MEMORY layer (claim-entities: clusterAliases = cosine + union-find over embeddings); here we
// REUSE it to cluster the extracted ENTITY labels and emit 'synonym' alias edges INTO the graph, so
// retrieval's graphNeighbors/graphExpand hop across surface-form variants ("ProjectA"↔"《ProjectA》") that
// substring resolution alone would drop. Embeddings happen ONLY here — never at retrieval.

/** Whether construction emits synonym bridge edges. Default ON; degrades to no-op with no embedder.
 *  DUIN_CONSTRUCT_SYNONYMS=0 disables. */
export function constructSynonymsEnabled(): boolean {
  return process.env.DUIN_CONSTRUCT_SYNONYMS !== '0'
}

// Bound the O(k²) clique per cluster (aliases of one real entity are few — a runaway cluster is an
// embedding over-merge, not a real synonym set) and cap the entity count we embed (offline, but keep
// it off any pathological vault). Mirrors claim-entities' MAX_RESOLVE_SUBJECTS.
const MAX_SYNONYM_CLUSTER = 12
const MAX_SYNONYM_ENTITIES = 400

/**
 * PURE: cluster the extracted entity LABELS by embedding similarity (reuse claim-entities'
 * cosine/union-find via clusterAliases) and emit 'synonym' bridge edges between same-cluster
 * entities of DIFFERENT ids. Emits the COMPLETE graph over each cluster (every cross-id pair, one
 * directed edge per unordered pair — traversal is bidirectional) so every alias is exactly 1 hop
 * from every other. Deterministic (source<target ordering, cluster iteration by insertion). Degrades
 * to [] on a vector-count mismatch (embedder unavailable) or <2 entities. `vecs[i]` = embedding of
 * `entities[i].label`; injected so this unit-tests with a hand-built vector fixture (no model).
 */
export function synonymEdges(
  entities: ConstructedEntity[],
  vecs: number[][],
  threshold = 0.86
): ConstructedEdge[] {
  if (entities.length < 2 || vecs.length !== entities.length) return []
  const map = clusterAliases(entities.map((e) => e.label), vecs, threshold)
  // Bucket entities by their cluster's canonical label. Same-label/different-id entities coalesce
  // (clusterAliases maps identical label strings to the same canonical).
  const clusters = new Map<string, ConstructedEntity[]>()
  for (const e of entities) {
    const canon = map.get(e.label)
    if (!canon) continue
    const arr = clusters.get(canon)
    if (arr) arr.push(e)
    else clusters.set(canon, [e])
  }
  const out: ConstructedEdge[] = []
  const seen = new Set<string>()
  for (const members of clusters.values()) {
    if (members.length < 2 || members.length > MAX_SYNONYM_CLUSTER) continue
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (members[i].id === members[j].id) continue
        const [a, b] =
          members[i].id < members[j].id
            ? [members[i].id, members[j].id]
            : [members[j].id, members[i].id]
        const k = a + '\0' + b
        if (seen.has(k)) continue
        seen.add(k)
        out.push({ source: a, target: b, type: 'synonym' })
      }
    }
  }
  return out
}

/** Build the construction prompt from a note corpus (id + text). */
export function buildConstructionPrompt(notes: { id: string; text: string }[]): string {
  const corpus = buildCorpus(notes, MAX_NOTES, MAX_NOTE_CHARS)
  return (
    'You build a KNOWLEDGE GRAPH from a user\'s RAW notes — plain prose with NO ' +
    'links, NO frontmatter, NO tags (what normal people actually have). Read the ' +
    'notes below (each headed by its id) and INFER the entities, relationships, ' +
    'and the nature of each note FROM THE PROSE ALONE. Output ONLY a JSON object — ' +
    'no prose, no code fence — of the form:\n' +
    '{"entities":[{"id":"<kind>:<slug>","kind":"person|decision|event|org|topic","label":"<short name>","note":"<exact note id it was found in>"}],' +
    '"edges":[{"source":"<entity id or note id>","target":"<entity id or note id>","type":"owns|depends_on|blocks|attends|affects|mentions|about"}],' +
    '"classifications":[{"note":"<exact note id>","type":"meeting|output|mental_model|decision|note"}],' +
    '"triples":[{"subject":"<thing>","relation":"<any natural relation phrase>","object":"<thing or value>","note":"<exact note id>","validFrom":"<YYYY-MM-DD or null>","validUntil":"<YYYY-MM-DD or null>"}]}\n' +
    'Rules:\n' +
    '- Infer entities + relationships from PROSE even with no links.\n' +
    '- id MUST be a stable slug of the form `<kind>:<slug>` (a lowercase kind then a ' +
    'short hyphenated slug, e.g. matching the id shape shown above) — the SAME person/project ' +
    'across different notes MUST get the SAME id (merge duplicates into one).\n' +
    '- `note` MUST match exactly one of the headings below.\n' +
    '- classifications: classify each note\'s nature; `note` MUST match a heading.\n' +
    '- triples: the important FACTS stated in the prose, as subject–relation–object. Use a NATURAL, ' +
    'specific relation (any phrase — "has deadline", "prefers", "reports to", "is blocked by", ' +
    '"decided to"), NOT the fixed edge set. Prefer stable entity names as subject/object. This is ' +
    'the open-vocabulary layer — capture concrete claims a reader would want remembered.\n' +
    '- triple validFrom/validUntil: ONLY when the prose states or clearly implies WHEN a fact became ' +
    'true (validFrom) or stopped/will stop being true / was superseded (validUntil), give the date ' +
    'as YYYY-MM-DD; otherwise use null. A fact with a validUntil already in the past is no longer ' +
    'current. Do NOT guess dates.\n' +
    '- Omit anything uncertain; empty arrays are fine.\n\n' +
    '=== NOTES ===\n' +
    corpus
  )
}

/**
 * Narrow the model's `kind` to one this build accepts.
 *
 * REMAPS BEFORE IT REJECTS, and that ordering is the whole point. An unrecognised kind returns
 * undefined and the entity is FILTERED OUT downstream — not defaulted, not logged. So removing a
 * kind from `ENTITY_KINDS` without a remap does not reclassify those entities, it DELETES them:
 * the model keeps emitting `project` for a while (it is a natural word for a named thing, and no
 * prompt edit stops that immediately), and every one would vanish silently on the construction
 * floor's 24-hour timer.
 *
 * Mapping `project -> topic` instead means the entity survives, lands in the kind that always
 * shared its boundary, and — because identity is `<kind>:<slug>` — collapses onto the same node as
 * its existing `topic:` twin rather than becoming a third one.
 */
function coerceEntityKind(v: unknown): EntityKind | undefined {
  if (typeof v !== 'string') return undefined
  const remapped = RETIRED_ENTITY_KINDS[v]
  if (remapped) return remapped
  return ENTITY_KINDS.has(v as EntityKind) ? (v as EntityKind) : undefined
}
function coerceRelation(v: unknown): RelationType | undefined {
  return typeof v === 'string' && RELATION_TYPES.has(v as RelationType)
    ? (v as RelationType)
    : undefined
}
function coerceClassification(v: unknown): NoteClassification | undefined {
  return typeof v === 'string' && CLASSIFICATIONS.has(v as NoteClassification)
    ? (v as NoteClassification)
    : undefined
}

/**
 * Parse the LLM's construction output into validated ConstructedData. Tolerant:
 * a fenced block, leading prose, or malformed items don't throw — bad items are
 * dropped, the rest kept. Validates kinds/types against the allowed sets.
 * Returns empty arrays on total failure (→ structural-only, unchanged).
 */
export function parseConstruction(text: string): ConstructedData {
  const empty: ConstructedData = { entities: [], edges: [], classifications: [] }
  if (!text) return empty
  // Pull the first {...} block (handles ```json fences / leading prose).
  const obj = extractFirstJsonObject(text)
  if (!obj) return empty

  const entities: ConstructedEntity[] = (Array.isArray(obj.entities) ? obj.entities : [])
    .map((e) => e as Record<string, unknown>)
    .filter(
      (e) =>
        typeof e.id === 'string' &&
        (e.id as string).trim() !== '' &&
        typeof e.label === 'string' &&
        (e.label as string).trim() !== '' &&
        typeof e.note === 'string' &&
        coerceEntityKind(e.kind)
    )
    .map((e) => ({
      id: (e.id as string).trim(),
      kind: coerceEntityKind(e.kind) as EntityKind,
      label: (e.label as string).trim(),
      note: e.note as string
    }))

  const edges: ConstructedEdge[] = (Array.isArray(obj.edges) ? obj.edges : [])
    .map((e) => e as Record<string, unknown>)
    .filter(
      (e) =>
        typeof e.source === 'string' &&
        (e.source as string).trim() !== '' &&
        typeof e.target === 'string' &&
        (e.target as string).trim() !== '' &&
        coerceRelation(e.type)
    )
    .map((e) => ({
      source: (e.source as string).trim(),
      target: (e.target as string).trim(),
      type: coerceRelation(e.type) as RelationType
    }))

  const classifications: ConstructedClassification[] = (
    Array.isArray(obj.classifications) ? obj.classifications : []
  )
    .map((c) => c as Record<string, unknown>)
    .filter((c) => typeof c.note === 'string' && (c.note as string).trim() !== '' && coerceClassification(c.type))
    .map((c) => ({
      note: (c.note as string).trim(),
      type: coerceClassification(c.type) as NoteClassification
    }))

  // Open-vocabulary triples — any relation phrase (no enum). All three fields required + non-empty;
  // cap so a runaway extraction can't bloat the ledger. `note` is provenance (kept even if it
  // doesn't match a heading — a triple's value doesn't depend on note-id resolution).
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  // A YYYY-MM(-DD) date string, else null (the model is told to use null when unstated; guard junk).
  const dateOrNull = (v: unknown): string | null => {
    const s = str(v)
    return /^\d{4}-\d{2}(-\d{2})?$/.test(s) ? s : null
  }
  const triples: ConstructedTriple[] = (Array.isArray(obj.triples) ? obj.triples : [])
    .map((t) => t as Record<string, unknown>)
    .filter((t) => str(t.subject) && str(t.relation) && str(t.object))
    .map((t) => ({
      subject: str(t.subject),
      relation: str(t.relation),
      object: str(t.object),
      note: str(t.note),
      validFrom: dateOrNull(t.validFrom),
      validUntil: dateOrNull(t.validUntil)
    }))
    .slice(0, 400)

  return { entities, edges, classifications, triples }
}

/**
 * Merge constructed structure into a base graph (PURE, deterministic):
 *   - add entity nodes (dedup by id; an existing node is NOT clobbered),
 *   - stamp each note node with its classification,
 *   - add edges, mapping relationship → edge type. An edge whose endpoint is an
 *     UNKNOWN id is skipped — unless that id is one of the new entities (so a
 *     person→note `attends` edge survives even though the person didn't exist
 *     before this pass).
 * Entity kinds (person/org/topic/…) are valid CausalKinds and the renderer
 * already colours them.
 */
export function applyConstruction(base: CausalGraph, c: ConstructedData): CausalGraph {
  // Phase B-2: the SHARED merge substance (entity-node dedup, relation->type edge
  // mapping, self/dangling drop, directed-triple edge dedup) now lives in the ONE
  // builder buildDuinGraph (dedup:'directed'). buildDuinGraph clones base, so `base`
  // is never mutated. This wrapper re-applies applyConstruction's THREE decorations
  // as a post-pass so /graph + graph-insight output is byte-UNCHANGED.
  const built = buildDuinGraph({
    base: { nodes: base.nodes, edges: base.edges },
    construction: c,
    dedup: 'directed'
  })
  const nodes = built.nodes as unknown as CausalNode[]
  const edges = built.edges as unknown as CausalEdge[]
  const byId = new Map(nodes.map((n) => [n.id, n]))

  // (c) Added construction entity nodes are appended AFTER the base nodes, in
  //     entities order (collisions skipped). Derive `track` from the source note,
  //     then drop the retrieval-shape `note` key -> original {id,kind,label,track?}.
  //     NOTE (identity-spine ②): the entity→note SPINE edge is already emitted inside
  //     buildDuinGraph above (it reads e.note directly from `c`), so deleting this
  //     render-shape `note` key here no longer severs the entity from its provenance
  //     note — the edge persists in `edges`. Ordering is load-bearing: buildDuinGraph
  //     MUST see `note` before this loop deletes it (it does — it runs at line ~296).
  for (let i = base.nodes.length; i < nodes.length; i++) {
    const n = nodes[i] as CausalNode & { note?: string }
    const track = n.note ? byId.get(n.note)?.track : undefined
    delete n.note
    if (track) n.track = track
  }

  // (a) `confidence: 0.6` on every construction-added edge (appended after base edges).
  for (let i = base.edges.length; i < edges.length; i++) edges[i].confidence = 0.6

  // (b) Classifications - stamp the note node (if it exists in the graph).
  for (const cl of c.classifications) {
    const n = byId.get(cl.note)
    if (n) n.classification = cl.type
  }

  return { ...base, nodes, edges }
}

/**
 * CONVERGENT MERGE (PURE, deterministic): union a fresh construction into the PRIOR cache so the graph
 * accumulates a stable superset instead of being re-rolled every rebuild. constructBrain re-extracts
 * the WHOLE vault through a non-deterministic LLM, so a full REPLACE makes the entity count bounce
 * (live: 44↔260 from identical notes — the stability churn). Convergence keeps:
 *   - every entity/edge/triple THIS run produced, PLUS
 *   - prior entities the run MISSED whose source `note` still exists (retain a flakily-missed entity;
 *     the ONLY things dropped are entities whose provenance note was genuinely deleted).
 * Edges/triples are likewise unioned + dangling-pruned (an endpoint must resolve to a kept entity or a
 * live note). Deterministic (current-first order, stable dedup keys). First build (no prior) is a pass-
 * through. Idempotent once extraction settles: re-running over the same notes is a fixpoint. Combined
 * with temperature:0 extraction (fewer run-to-run id variants), the count converges instead of churning.
 */
export function convergeConstruction(
  prior: ConstructedData | null,
  current: ConstructedData,
  liveNoteIds: Set<string>,
  coveredNoteIds: Set<string> = new Set()
): ConstructedData {
  if (!prior) return current
  const SEP = '\0'
  // COVERED notes are the ones this run actually re-extracted (their batch returned a parse).
  // Before 2026-09-03 a prior entity was retained whenever its note still EXISTED, so a note
  // re-read fifty times kept every variant every run and every model ever produced for it:
  // the store was a monotone union (15,274 entities for 1,181 notes, half attached to nothing).
  // Now an entity of a covered note survives only by being re-extracted, with ONE miss
  // tolerated (extraction is flaky on a 1,500-char slice) and retirement on the second.
  const MISS_TOLERANCE = 1

  // Entities: current ∪ (prior entities the run missed whose source note still exists).
  //
  // Keyed on KIND + NORMALIZED LABEL, exactly like the cross-batch merge below — NOT on `e.id`.
  // The reason is the same one that merge documents: extraction is non-deterministic about slugs,
  // so the model mints a FRESH id every time it meets the same entity. Keying convergence on `e.id`
  // therefore made every re-extraction look like a brand-new entity and retained the prior one
  // beside it, so duplicates accumulated once per run forever. Measured on the live brain
  // 2026-07-31, after partial runs began accumulating: 2,277 entities carrying only 1,970 distinct
  // kind+label pairs, with 204 labels holding more than one id — the worst offenders were common
  // orgs and projects at 5-7 copies each. Two merge paths over one concept, only one ever fixed.
  const labelKey = (e: ConstructedEntity): string => entityKey(String(e.kind), String(e.label ?? ''))
  //
  // BOTH keys are checked, not one instead of the other. Same-id-different-label is the model
  // RENAMING an entity it kept the slug for; different-id-same-label is it re-slugging one it kept
  // the name for. Either is one entity, and dropping either check reintroduces duplicates from the
  // other direction.
  // Fold CURRENT-first, then prior. First occurrence of a (kind,label) or an id wins, and every
  // id that loses is recorded so its edges can follow it. Folding rather than filtering also
  // collapses duplicates that are already sitting INSIDE the prior — without that this fix would
  // only stop the bleeding, leaving the accumulated backlog (307 surplus entities on the live
  // brain) to sit there forever, since a duplicate is only re-collapsed on a run that happens to
  // re-extract that same label.
  const entities: ConstructedEntity[] = []
  const seenIds = new Set<string>()
  const seenLabels = new Set<string>()
  const supersededBy = new Map<string, string>()
  const winnerFor = new Map<string, string>() // labelKey -> surviving id
  // THE ID IS THE ONE THE ENTITY WAS FIRST KNOWN BY. The model re-slugs on every run
  // (`person:liang-jianbin`, then `person:liangjianbin`), and "current wins" used to carry the
  // new slug into the store: after one converged run 765 of 5,078 map entities (15%) had a new
  // id, so their carried positions, locks and cluster memberships were lost and they jumped.
  // Content still comes from the current run (label, kind, note); only the id is inherited, and
  // the current run's own edges and triples follow it through `supersededBy`.
  const priorIdByKey = new Map<string, string>()
  for (const e of prior.entities) {
    const lk = labelKey(e)
    if (!priorIdByKey.has(lk)) priorIdByKey.set(lk, e.id)
  }
  for (const e0 of current.entities) {
    const lk = labelKey(e0)
    const inherited = priorIdByKey.get(lk)
    const e = inherited && inherited !== e0.id ? { ...e0, id: inherited } : e0
    if (inherited && inherited !== e0.id) supersededBy.set(e0.id, inherited)
    if (seenIds.has(e.id) || seenLabels.has(lk)) {
      const w = winnerFor.get(lk)
      if (w && w !== e0.id) supersededBy.set(e0.id, w)
      continue
    }
    seenIds.add(e.id)
    seenLabels.add(lk)
    winnerFor.set(lk, e.id)
    entities.push(e.missed ? { ...e, missed: undefined } : e)
  }
  for (const e of prior.entities) {
    // A prior entity whose source note is gone (or no longer in the corpus) is a REAL deletion.
    if (!liveNoteIds.has(e.note)) continue
    const lk = labelKey(e)
    if (seenIds.has(e.id) || seenLabels.has(lk)) {
      const w = winnerFor.get(lk)
      if (w && w !== e.id) supersededBy.set(e.id, w)
      continue
    }
    // Its note was re-extracted and it did not come back: one miss is tolerated, the second retires it.
    let keep: ConstructedEntity = e
    if (coveredNoteIds.has(e.note)) {
      const missed = (e.missed ?? 0) + 1
      if (missed > MISS_TOLERANCE) continue
      keep = { ...e, missed }
    }
    seenIds.add(e.id)
    seenLabels.add(lk)
    winnerFor.set(lk, e.id)
    entities.push(keep)
  }

  // A superseded id must not take its EDGES down with it. Remap those endpoints onto the surviving
  // id instead of letting the dangling-prune drop them — dedup should collapse duplicate nodes, not
  // quietly delete the relationships they carried.
  const remap = (id: string): string => supersededBy.get(id) ?? id

  // An endpoint resolves iff it's a kept entity id or a live note id (else the edge is dangling → drop).
  const keptIds = new Set(entities.map((e) => e.id))
  const resolves = (id: string): boolean => keptIds.has(id) || liveNoteIds.has(id)
  const edgeKey = (e: ConstructedEdge): string => e.source + SEP + e.target + SEP + e.type
  // The current run's edges reference the current run's ids; where an id was inherited from the
  // prior, the edge follows it (and a remap that lands on a self-loop is dropped).
  const currentEdges = current.edges
    .map((e) => (supersededBy.has(e.source) || supersededBy.has(e.target) ? { ...e, source: remap(e.source), target: remap(e.target) } : e))
    .filter((e) => e.source !== e.target)
  const curEdgeKeys = new Set(currentEdges.map(edgeKey))
  const retainedEdges = prior.edges
    .map((e) => (supersededBy.has(e.source) || supersededBy.has(e.target)
      ? { ...e, source: remap(e.source), target: remap(e.target) }
      : e))
    // Drop self-loops the remap may have created (two duplicate ids collapsing onto one entity).
    .filter((e) => e.source !== e.target && !curEdgeKeys.has(edgeKey(e)) && resolves(e.source) && resolves(e.target))
  const edges = [...currentEdges, ...retainedEdges]

  // Classifications: current wins per note; retain prior for still-live notes the run didn't reclassify.
  const curClassNotes = new Set(current.classifications.map((c) => c.note))
  const retainedClass = (prior.classifications ?? []).filter(
    (c) => !curClassNotes.has(c.note) && liveNoteIds.has(c.note)
  )
  const classifications = [...current.classifications, ...retainedClass]

  // Triples: union; retain prior triples whose provenance note still exists (or is unattributed).
  const tripleKey = (t: ConstructedTriple): string => t.subject + SEP + t.relation + SEP + t.object + SEP + t.note
  const curTriples = current.triples ?? []
  const curTripleKeys = new Set(curTriples.map(tripleKey))
  // Triples follow the same covered-note rule: a triple from a re-extracted note that did not come
  // back is tolerated once, then retired. Unattributed triples (note '') are kept as before.
  const retainedTriples: ConstructedTriple[] = []
  for (const t of prior.triples ?? []) {
    if (curTripleKeys.has(tripleKey(t))) continue
    if (t.note !== '' && !liveNoteIds.has(t.note)) continue
    if (t.note !== '' && coveredNoteIds.has(t.note)) {
      const missed = (t.missed ?? 0) + 1
      if (missed > MISS_TOLERANCE) continue
      retainedTriples.push({ ...t, missed })
    } else retainedTriples.push(t)
  }
  const triples = [...curTriples.map((t) => (t.missed ? { ...t, missed: undefined } : t)), ...retainedTriples]

  return { entities, edges, classifications, triples }
}

// ── Cache (userData) ─────────────────────────────────────────────────────────
// The constructed result is cached to a JSON file keyed by the notes dir, so
// the graph/panels read constructed structure on boot without re-running the
// (expensive, key-gated) LLM pass every launch. Re-run on demand via
// constructBrain(); the in-memory copy is also exposed to the NotesStore/derive
// layer through getConstruction().

interface ConstructionCacheFile {
  /** Hash of the notes dir this construction was built from. */
  key: string
  /** ISO timestamp of the build. */
  builtAt: string
  /**
   * Which batch the NEXT run should start from — the rotating coverage cursor.
   *
   * `allChunks()` orders by `file, chunk_index` and the worker pool starts at index 0, so batch
   * order is identical on every run. With a wall-clock deadline that cuts a run short, that meant
   * every run re-extracted the SAME leading batches and the tail of the vault was never reached:
   * measured 2026-07-31, 11 of 31 batches completed in 45 minutes, and they would have been the
   * same 11 forever. Starting each run where the last one stopped makes successive partial runs
   * ACCUMULATE coverage, which is what the union merge below was always able to support.
   *
   * Absent/invalid on an older cache file → 0, i.e. the previous behaviour.
   */
  nextBatch?: number
  data: ConstructedData
}

let userDataDir: string | null = null
let notesDirProvider: () => string | null = () => null
let inMemory: ConstructedData | null = null
// The dirKey() the in-memory copy was built/hydrated for. Guards getConstruction()
// against returning a STALE construction after the notes dir is re-pointed mid-
// session (notes dir is read live, so without this the old vault's entities bleed
// into the new one). Kept in lockstep with EVERY `inMemory` assignment.
let inMemoryKey: string | null = null

/** Wire the userData path + a notes-dir reader at boot (mirrors the injection
 *  pattern used by index-store / operator-model so this module needs no
 *  electron import in tests). */
export function setConstructPaths(userData: string, notesDir: () => string | null): void {
  userDataDir = userData
  notesDirProvider = notesDir
}

// Cache location: PREFER `<notesDir>/.brain/state/brain-construction.json` when
// a `.brain/` root exists, so the constructed graph travels with the vault (the
// harness-root contract). Fall back to the legacy `<userData>/brain-construction.json`
// when there's no notes dir / `.brain/` root — keeps existing installs working
// and unchanged. Reads check BOTH (brain-root first) so an install that gains a
// `.brain/` root mid-life still finds a legacy cache until the next build.
function brainStateCachePath(): string | null {
  const root = brainRootPath(notesDirProvider())
  if (!root) return null
  return join(root, BRAIN_STATE_DIR, 'brain-construction.json')
}

function legacyCachePath(): string | null {
  if (!userDataDir) return null
  return join(userDataDir, 'brain-construction.json')
}

/** Path to WRITE the cache to: brain-root state if available, else legacy. */
function cachePath(): string | null {
  return brainStateCachePath() ?? legacyCachePath()
}

/** Existing cache paths to READ from, in priority order (brain-root first). */
function readCachePaths(): string[] {
  return [brainStateCachePath(), legacyCachePath()].filter((p): p is string => !!p)
}

/** `<brain root>/.brain/state/construction-exclude.json` → `{ "folders": [...] }`. Missing or
 *  malformed = no fence. Read per build; it is one small file. */
export function readConstructionFence(): string[] {
  try {
    const root = brainRootPath(notesDirProvider())
    if (!root) return []
    const p = join(root, BRAIN_STATE_DIR, 'construction-exclude.json')
    if (!existsSync(p)) return []
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as { folders?: unknown }
    return Array.isArray(raw.folders) ? raw.folders.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : []
  } catch {
    return []
  }
}

/**
 * The cache file, parsed once per (path, size, mtime). Three helpers used to `JSON.parse` the whole
 * store independently — 28.6 MB on the live brain — and one of them ran on the main thread every
 * 15 minutes for the construction floor check. Same bytes, one parse.
 */
const _cacheMemo = new Map<string, { size: bigint; mtimeNs: bigint; raw: ConstructionCacheFile }>()
function readCacheFile(p: string): ConstructionCacheFile {
  // Nanosecond mtime, not milliseconds: two rewrites of a same-size file inside one tick (the
  // tests do exactly that) must not be served from the memo. This module's own writers also
  // clear it, so a value written here is never read back stale.
  const st = statSync(p, { bigint: true })
  const hit = _cacheMemo.get(p)
  if (hit && hit.size === st.size && hit.mtimeNs === st.mtimeNs) return hit.raw
  const raw = JSON.parse(readFileSync(p, 'utf-8')) as ConstructionCacheFile
  _cacheMemo.set(p, { size: st.size, mtimeNs: st.mtimeNs, raw })
  return raw
}

function dirKey(): string {
  const dir = notesDirProvider() ?? ''
  return createHash('sha1').update(dir).digest('hex').slice(0, 16)
}

/**
 * When the persisted construction for the CURRENT notes dir was built, or null when
 * there is none. Exported so a caller can tell whether the typed-extraction layer
 * has gone stale.
 *
 * It needs to be askable because construction is purely EDIT-DRIVEN: the only
 * producer is the notes watcher's reindex tail. On 2026-07-30 the cache was 10 days
 * old — not because the extractor was broken, but because nothing had edited a vault
 * file, so nothing ever scheduled a rebuild. One missing clock explained three
 * symptoms at once: a stalled construction, a frozen Brain Health (which fires only
 * after a construction rebuild), and a graph whose 63% `entity`-kind share could not
 * decay because typed kinds only arrive from here.
 */
/** The persisted coverage cursor for the CURRENT notes dir — which batch the next run starts on. */
function persistedNextBatch(): number {
  for (const p of readCachePaths()) {
    if (!existsSync(p)) continue
    try {
      const raw = readCacheFile(p)
      if (raw.key !== dirKey()) continue
      const n = Number(raw.nextBatch)
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
    } catch {
      /* corrupt cache — try the next path */
    }
  }
  return 0
}

export function constructionBuiltAtMs(): number | null {
  for (const p of readCachePaths()) {
    if (!existsSync(p)) continue
    try {
      const raw = readCacheFile(p)
      if (raw.key !== dirKey()) continue
      const ms = Date.parse(raw.builtAt)
      if (Number.isFinite(ms)) return ms
    } catch {
      /* corrupt cache — try the next path */
    }
  }
  return null
}

/** The currently-active constructed structure (in-memory, hydrated from cache
 *  on first read). Null when nothing has been built for the current notes dir. */
/**
 * Does a construction cache for the CURRENT notes dir exist on disk but fail to load?
 *
 * `getConstruction()` returns null for four different situations: no cache at all, a cache built
 * for a different vault, JSON that would not parse, and a shape that failed validation. The last
 * two are "I have a prior and cannot read it right now" — a Windows file lock or a partial write —
 * and they are NOT the same as "there is nothing to protect". They shared a representation with it,
 * so the clobber guards below read an unreadable-but-good cache as zero prior entities, declined to
 * fire, and let a 0-entity run persist over it. That is the one outcome those guards exist to
 * prevent, reachable through the signal they consult.
 */
export function constructionCacheUnreadable(): boolean {
  for (const p of readCachePaths()) {
    if (!existsSync(p)) continue
    try {
      const raw = readCacheFile(p)
      if (raw.key !== dirKey()) continue // a different vault's cache is not ours to protect
      const ok =
        raw.data &&
        Array.isArray(raw.data.entities) &&
        Array.isArray(raw.data.edges) &&
        Array.isArray(raw.data.classifications)
      if (!ok) return true // present, ours, and malformed
    } catch {
      return true // present, and unreadable right now
    }
  }
  return false
}

export function getConstruction(): ConstructedData | null {
  // Honor the in-memory copy ONLY when it was built for the CURRENT notes dir;
  // a re-point (dirKey changes) must fall through to re-hydrate from the new
  // vault's cache (or return null) rather than serving the old vault's data.
  if (inMemory && inMemoryKey === dirKey()) return inMemory
  for (const p of readCachePaths()) {
    if (!existsSync(p)) continue
    try {
      const raw = readCacheFile(p)
      // Only honor the cache if it matches the current notes dir.
      if (raw.key !== dirKey()) continue
      if (
        raw.data &&
        Array.isArray(raw.data.entities) &&
        Array.isArray(raw.data.edges) &&
        Array.isArray(raw.data.classifications)
      ) {
        // Migrate retired entity kinds BEFORE anything sees this cache. convergeConstruction
        // retains on `kind + label`, so an un-migrated `project|X` and a freshly extracted
        // `topic|X` are different keys and BOTH survive — permanently. Idempotent, and a no-op
        // once the migrated shape has been persisted. See construct-kind-migration.ts.
        const mig = migrateRetiredKinds(raw.data)
        if (mig.migrated > 0) {
          console.log(
            `[construct] migrated ${mig.migrated} retired-kind entit(ies)` +
              (mig.folded > 0 ? `, folding ${mig.folded} onto an existing id` : '')
          )
        }
        inMemory = mig.data
        inMemoryKey = dirKey()
        return inMemory
      }
    } catch {
      /* corrupt cache — try the next path */
    }
  }
  return null
}

// ── Resolved-construction accessor (identity-spine P6) ───────────────────────
// The identity resolver (entity-resolver.resolveEntityIdentity) collapses the LLM's
// churning duplicate `kind:slug` ids onto their stable canonical id. It was applied
// PER-CALLER (MAP, retrieval, benchmark) while ONE caller — mergedGraph()/applyConstruction
// — fed the RAW construction to four surfaces (/graph, graphCommunities, graph-report,
// graph-snapshot), so fragment ids (`project:projecta`) leaked onto those surfaces while the
// MAP/retrieval showed canonical (`project:ProjectA`). P6 makes "resolved" a property of the
// construction READ, not each caller: every graph-ASSEMBLY consumer calls this one accessor.
//
// MEMOIZED on the getConstruction() REFERENCE identity. getConstruction() returns the SAME
// `inMemory` object for a whole construction generation (a rebuild / notes-dir re-point mints
// a NEW object), so reference-equality is a precise, zero-cost cache signal — the pure,
// idempotent resolver runs at most ONCE per generation instead of on every call. Respects the
// SAME `entityResolverEnabled()` kill-switch (DUIN_ENTITY_RESOLVER, default-ON) so
// DUIN_ENTITY_RESOLVER=0 yields a byte-identical raw passthrough uniformly on every surface.
let _resolvedKey: ConstructedData | null = null
let _resolvedVal: ConstructedData | null = null

/** The construction with whitelisted duplicate entity ids collapsed onto their stable
 *  canonical id (entity-resolver), memoized per construction generation. When
 *  DUIN_ENTITY_RESOLVER=0 this is exactly getConstruction() (raw passthrough — no resolve,
 *  no memo write), so the RESOLVER step is uniformly off across every graph-assembly surface.
 *  NOTE: this flag disables only id-collapse. The home-MAP's construction overlay AND the
 *  product-seam fold ride a SEPARATE flag (DUIN_MAP_ENTITY_OVERLAY) and still run over the
 *  raw construction when only the resolver is off (still existence-gated + whitelist-bounded,
 *  so no over-merge). A full pre-P6 MAP revert needs BOTH flags set to '0'. */
export function getResolvedConstruction(): ConstructedData | null {
  const raw = getConstruction()
  if (!entityResolverEnabled()) return raw // kill-switch: raw passthrough, memo untouched
  if (raw === _resolvedKey) return _resolvedVal // same generation → reuse (resolver is pure)
  // Cold-start A1 moved the alias whitelist out of source and into per-vault state
  // (`.duin/_state/entity-aliases.json`). This is the one place that knows BOTH the vault and
  // that a resolve is about to happen, so it is where the vault's whitelist becomes active —
  // without this the loader added by A1 was never called and the resolver merged nothing, ever.
  // Once per construction generation (the memo above short-circuits repeat calls).
  loadAliasGroups(notesDirProvider())
  const resolved = resolveEntityIdentity(raw)
  _resolvedKey = raw
  _resolvedVal = resolved
  return resolved
}

/**
 * Drop the resolved-construction memo so the NEXT call re-reads the alias whitelist.
 *
 * The memo above is keyed on the construction generation, not on the whitelist — which is correct
 * while only a rebuild changes identity, and wrong the moment something appends alias groups at
 * runtime. Without this, a group written by entity-kind-collapse or the containment-spine
 * automerge has no effect on the running app until the next construction rebuild, which the
 * 24-hour floor can defer by a full day: the file changes, the graph does not, and the pass looks
 * like it silently did nothing.
 *
 * Deliberately not folded into `loadAliasGroups` — that is called on the read path, once per
 * generation, and busting the memo from inside it would defeat the memo entirely.
 */
export function invalidateResolvedConstruction(): void {
  _resolvedKey = null
  _resolvedVal = null
}

/**
 * Update ONLY the coverage cursor, leaving the cached data and `builtAt` untouched.
 *
 * The cursor and the cache answer different questions — "where do I read next" versus "what do I
 * know" — and a run can legitimately advance the first while having nothing to write to the second.
 * `builtAt` must NOT move here: no build landed, and the construction floor keys its staleness
 * check on that timestamp.
 */
function advanceCursorOnly(nextBatch: number): void {
  _cacheMemo.clear()
  const p = cachePath()
  if (!p || !existsSync(p)) return
  try {
    const raw = readCacheFile(p)
    if (raw.key !== dirKey()) return // a different vault's cache — never touch it
    writeFileSync(p, JSON.stringify({ ...raw, nextBatch }), 'utf-8')
  } catch (err) {
    console.warn('[construct] cursor write failed:', (err as Error)?.message)
  }
}

/** Returns whether the cache was ACTUALLY written.
 *
 *  It returned `void` — identically when it wrote, when it skipped (no resolvable cache path), and
 *  when writeFileSync threw. `constructBrain` then reported `status: 'built'` regardless, while the
 *  status doc promises "'built' when a model ran, the build succeeded, AND THE CACHE WAS WRITTEN".
 *  So a full disk or a read-only vault produced a cheerful 'built', callers broadcast
 *  `brain:updated`, and the 24h construction floor kept keying staleness on a `builtAt` that had
 *  never moved — the exact stall shape this campaign spent a night on, one layer down. */
function persistConstruction(data: ConstructedData, nextBatch = 0): boolean {
  _cacheMemo.clear()
  const p = cachePath()
  if (!p) return false
  try {
    mkdirSync(dirname(p), { recursive: true })
    const file: ConstructionCacheFile = { key: dirKey(), builtAt: new Date().toISOString(), nextBatch, data }
    // atomicWriteDurable, not a bare writeFileSync. This is the SOLE copy of
    // brain-construction.json: a bare write truncates the existing file first, so a crash
    // or a full disk mid-write leaves a truncated JSON that parses as corrupt on next
    // boot and the whole construction is lost rather than merely stale. self-improve-loop
    // in this same codebase already uses atomicWriteDurable for equivalent cache state —
    // write-to-temp then rename, so the old copy survives until the new one is complete.
    atomicWriteDurable(p, JSON.stringify(file))
    return true
  } catch (err) {
    console.warn('[construct] cache write failed:', (err as Error)?.message)
    return false
  }
}

/**
 * P3 OBSERVABILITY: surface dropped/truncated construction batches to the failure ledger (whose
 * recordFailure ALSO emits a `failure_ledger.recorded/repeated` event) instead of console.warn-only,
 * so a flaky extraction run is VISIBLE — this churn went unnoticed precisely because batch failures
 * were invisible to events/ledger. Grouped by reason so a chronically-flaky provider accrues a
 * greppable count. Lazy import (keeps this module vitest-safe / no better-sqlite3 at load) + fully
 * FAILURE-ISOLATED (a telemetry error can NEVER break or delay a rebuild). No-op when nothing dropped.
 */
function reportConstructionBatchFailures(
  model: string,
  totalBatches: number,
  dropped: { index: number; reason: string; message: string }[]
): void {
  if (dropped.length === 0) return
  const byReason = new Map<string, number>()
  for (const d of dropped) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1)
  // ONE durable summary line (replaces the old per-batch console.warn-only signal).
  const summary = [...byReason].map(([r, n]) => `${n} ${r}`).join(', ')
  console.warn(
    `[construct] extraction flaky: ${dropped.length}/${totalBatches} batch(es) dropped (${summary}) on ${model}`
  )
  void import('../failure-ledger')
    .then(({ recordFailure }) => {
      for (const [reason, n] of byReason) {
        try {
          recordFailure({
            kind: 'runtime_failed',
            fingerprint: `construct:extraction:${reason}`,
            command: 'constructBrain',
            message: `construction extraction: ${n}/${totalBatches} batch(es) ${reason} on ${model}`
          })
        } catch {
          /* best-effort: a ledger write must never break a rebuild */
        }
      }
    })
    .catch(() => {
      /* ledger module unavailable (headless) — telemetry is advisory only */
    })
}

/** Test/reset hook — clears in-memory + injected paths. */
export function __resetConstructionForTest(): void {
  inMemory = null
  inMemoryKey = null
  userDataDir = null
  notesDirProvider = () => null
  _resolvedKey = null
  _resolvedVal = null
}

// ── Orchestration (NOT unit-tested — needs a callable model: a BYO key or a
//    local Ollama). Mirrors extractTemporal. ──

export interface ConstructResult {
  entities: number
  edges: number
  /** 'built' when a model ran, the build succeeded, and the cache WAS WRITTEN;
   *  'kept-cache' when a clobber guard declined to persist and the previous
   *  construction still stands;
   *  'no-model' when key-gated off (no BYO key + no Ollama — structural-only);
   *  'model-error' when a model WAS routed but every batch failed (truncation,
   *  quota/billing 402/429, refusal, or provider error) — distinct from
   *  'no-model' so the UI can prompt "check your provider balance/quota" instead
   *  of "connect a model you already have".
   *
   *  'kept-cache' used to be reported as 'built', which made a protected no-op
   *  indistinguishable from a real build that found nothing: same status, same
   *  zeroes. That ambiguity is not academic — it cost an evening of diagnosis on
   *  2026-07-30, and it reached the user as a SUCCESS toast reading "Built 0
   *  entities, 0 links" every time a guard fired. A caller that needs "did the
   *  graph change?" (broadcast `brain:updated`, log a rebuild) must test for
   *  'built' alone; 'kept-cache' means nothing moved. */
  status: 'built' | 'kept-cache' | 'no-model' | 'model-error'
  /** Batches this run gave up on for a PROVIDER-side reason (quota/billing), and how many
   *  batches there were. 'model-error' only fires when EVERY batch fails, so a run where most
   *  batches died on quota still reported 'built' — and the extraction breaker, which watches
   *  status alone, never saw the doomed paid calls it exists to stop. */
  providerDropped?: number
  totalBatches?: number
}

/**
 * Run the construction LLM pass over the indexed notes, parse, cache, and return
 * a small summary. Returns null when no callable model is available (no BYO key
 * AND no local Ollama) or on any failure — structural-only, unchanged.
 */
export async function constructBrain(): Promise<ConstructResult | null> {
  const model = routeModel('extraction') // cheap/fast model for structured JSON
  if (!model) return null
  const chunks = allChunks()
  if (chunks.length === 0) {
    // GUARD (data-loss fix): a transient/partial empty read must NOT clobber a good cache.
    // allChunks() returns [] whenever notes_chunks is momentarily empty during a boot reindex's
    // prune→re-embed window (pruneToKeep([]) after a self-heal ledger clear). Treat 0 chunks as
    // ground truth ONLY when no reindex is in flight AND there is no existing non-empty construction
    // to preserve; otherwise no-op and keep the persisted cache. `isReindexing()` spans the whole
    // dangerous window (set synchronously in startReindex, cleared in .finally).
    // `constructionCacheUnreadable()` is the third arm: a prior we cannot READ right now is still
    // a prior worth protecting, and it used to be indistinguishable from having none.
    if (isReindexing() || constructionCacheUnreadable() || (getConstruction()?.entities?.length ?? 0) > 0) {
      return { entities: 0, edges: 0, status: 'kept-cache' } // no-op: keep the good cache
    }
    // Genuinely empty vault, index settled, no prior construction → clear the cache to reality.
    inMemory = { entities: [], edges: [], classifications: [], triples: [] }
    inMemoryKey = dirKey()
    persistConstruction(inMemory)
    return { entities: 0, edges: 0, status: 'built' }
  }
  // Documents only. The index holds DUIN's own memory projections, machine state, archives and
  // code so retrieval can reach them; extraction must not read them (isConstructionCorpusPath):
  // it was turning the brain's own memory files into "knowledge" and code files into topics.
  const fence = readConstructionFence()
  const notes = groupChunksByFile(chunks)
    .filter(({ file, text }) => isConstructionCorpusPath(file) && !pathUnderFence(file, fence) && !noteOptsOutOfExtraction(text))
    .map(({ file, text }) => ({ id: file, text }))

  // Batch over the WHOLE vault: one construction LLM call per MAX_NOTES-note
  // window, results merged with de-dup (entities by id, edges by src/tgt/type,
  // classifications by note, triples by subject/relation/object/note). A single
  // 40-note pass only ever metabolized a sliver of a large vault; looping covers
  // all of it. A bad batch is tolerated (skipped) rather than failing the build.
  const entities: ConstructedEntity[] = []
  const edges: ConstructedEdge[] = []
  const classifications: ConstructedClassification[] = []
  const triples: ConstructedTriple[] = []
  const seenE = new Set<string>()
  const seenEd = new Set<string>()
  const seenC = new Set<string>()
  const seenT = new Set<string>()
  const NUL = '\0'
  const batchCount = Math.min(Math.ceil(notes.length / MAX_NOTES), MAX_BATCHES)
  const allBatches: { id: string; text: string }[][] = []
  for (let b = 0; b < batchCount; b++) {
    const batch = notes.slice(b * MAX_NOTES, (b + 1) * MAX_NOTES)
    if (batch.length === 0) break
    allBatches.push(batch)
  }
  // ROTATE to the persisted coverage cursor. Batch order is identical on every run (allChunks
  // orders by file+chunk_index, the worker pool starts at 0), so a run cut short by the wall-clock
  // deadline always re-extracted the SAME leading batches and the tail of the vault was never
  // reached — 11 of 31 batches completed on 2026-07-31, and they would have been the same 11 every
  // time. Starting where the last run stopped makes successive partial runs accumulate coverage,
  // which the union merge below has always been able to absorb.
  const startBatch = allBatches.length ? persistedNextBatch() % allBatches.length : 0
  const batchList = startBatch === 0 ? allBatches : [...allBatches.slice(startBatch), ...allBatches.slice(0, startBatch)]
  if (startBatch !== 0) {
    console.log(`[construct] resuming coverage at batch ${startBatch}/${allBatches.length}`)
  }

  // The batches are INDEPENDENT LLM calls (results merged with de-dup afterward), so run them with
  // bounded CONCURRENCY instead of strictly sequentially — 24 sequential glm-4-flash calls took
  // ~40min and kept stalling on a contended instance. A wall-clock deadline bounds a build: past it,
  // no new batch starts (in-flight ones finish), so a build can be slow but never hangs. Env-tunable.
  // Default 3 (was 5): many API tiers rate-limit concurrent requests (Zhipu returned
  // "您的账户已达到速率限制" at 5), and the account rate-limit failure is confusing on a fresh
  // operator's first build. 3 is a safe cross-provider default; the per-batch retry/backoff absorbs
  // the occasional 429, and generous tiers can raise it via DUIN_CONSTRUCT_CONCURRENCY.
  const CONCURRENCY = Math.max(1, Number(process.env.DUIN_CONSTRUCT_CONCURRENCY) || 3) // signal-lint-ignore: 0 workers cannot run a batch; Math.max(1) clamps it anyway
  const rawDeadline = Number(process.env.DUIN_CONSTRUCT_DEADLINE_MS)
  const deadlineMs = Number.isFinite(rawDeadline) && rawDeadline > 0 ? rawDeadline : 600_000
  const deadline = Date.now() + deadlineMs
  const results: (ConstructedData | null)[] = new Array(batchList.length).fill(null)
  /** Highest `batchList` index any worker actually started. -1 = the run consumed nothing. */
  let lastConsumedIdx = -1
  /** Where the NEXT run should start, given how far this one travelled. */
  const cursorAfter = (consumedIdx: number): number =>
    allBatches.length ? (startBatch + consumedIdx + 1) % allBatches.length : 0

  // P3 per-batch retry/backoff (a real reliability win independent of which model routeModel picks):
  // the extraction stream is flaky (stalls / 5xx / partial bodies), so a transient batch failure gets
  // bounded in-place retries BEFORE it is dropped — fewer dropped batches ⇒ fewer degraded runs ⇒
  // less churn. Quota errors short-circuit (a same-provider retry can't refill quota; the distinct-
  // provider fallback handles those). Both runtime-tunable so tests/operators can adjust.
  const maxBatchAttempts = Math.max(1, Number(process.env.DUIN_CONSTRUCT_BATCH_ATTEMPTS) || 3) // signal-lint-ignore: 0 attempts means the batch never runs; Math.max(1) clamps it anyway
  // 0 is MEANINGFUL here — `sleep` above documents that 0 disables the backoff, and the test
  // suite sets this to '0' for instant retries. The old `|| 500` made that unreachable.
  const batchBackoffMs = envNum('DUIN_CONSTRUCT_BATCH_BACKOFF_MS', 500, { min: 0 })
  // Last-known failure reason per still-dropped batch (final null results), for P3 observability.
  const batchFailReason = new Map<number, { reason: string; message: string }>()

  /** One construction call over `noteList`. Returns the raw body and how it ended. */
  const callConstruction = async (
    noteList: { id: string; text: string }[],
    activeModel: string
  ): Promise<{ text: string; finishReason: string | null }> => {
    // Ollama reasoning models (qwen3 et al.) "think" silently before emitting — the
    // /v1 stream sends no chunks during that phase and trips the inactivity timeout,
    // failing EVERY batch ("Stream stalled — no chunks for 60s"). The `/no_think`
    // directive (honored via Ollama's OpenAI-compat endpoint) disables it so extraction
    // starts streaming immediately. Harmless for non-reasoning Ollama models; only
    // applied to the local Ollama path so hosted models are byte-identical.
    const cPrompt = buildConstructionPrompt(noteList)
    const messages: ChatCompletionMessageParam[] = [
      { role: 'user', content: activeModel.startsWith('ollama:') ? `${cPrompt}\n\n/no_think` : cPrompt }
    ]
    // maxTokens 8192: a 40-note batch's construction JSON runs ~4k tokens; WITHOUT this the
    // provider default (glm-4-flash = 1024) TRUNCATES it mid-object (finish_reason:'length') →
    // parseConstruction can't extract a complete {…} → ~0 entities/batch. This one param is the
    // difference between a build yielding a handful of entities and the full graph. It is a
    // ceiling, not a guarantee: a dense batch can still exceed it, which is what the caller's
    // split-on-truncation path exists to absorb.
    return await new Promise<{ text: string; finishReason: string | null }>((resolve, reject) => {
      let acc = ''
      chatStream(
        messages,
        activeModel,
        undefined,
        {
          onChunk: (c: string) => {
            acc += c
          },
          onDone: (_full, _tools, _reasoning, completion) =>
            resolve({ text: acc, finishReason: completion?.finishReason ?? null }),
          onError: (e: string) => reject(new Error(e))
        },
        undefined,
        { maxTokens: 8192, temperature: 0 }
      ).catch(reject)
    })
  }

  // Splitting is bounded by a CALL budget, not just by depth. Depth alone is the wrong bound:
  // if a batch truncates for a reason that has nothing to do with size (a malformed prompt, a
  // model emitting unbounded garbage), halving never converges and a pure depth cap of 4 would
  // fire 1+2+4+8+16 = 31 full-budget calls where the old blind retry fired 3. That would have
  // traded a bug for a bigger bill. The budget caps the downside at roughly the old cost while
  // still letting the common case — one or two levels — succeed on 2 to 6 calls.
  // NOT `Number(env) || 8`: 0 is a meaningful value here (disable splitting) and it is falsy, so
  // that idiom silently resurrects the default and makes the off switch a no-op — the same trap
  // DUIN_CONSTRUCTION_FLOOR_HOURS documents in notes-watcher.ts.
  const splitCallBudget = ((): number => {
    const raw = process.env.DUIN_CONSTRUCT_SPLIT_CALLS
    if (raw === undefined || raw.trim() === '') return 8
    const n = Number(raw)
    return Number.isFinite(n) ? Math.max(0, n) : 8
  })()
  // Secondary guard: stop subdividing once the batch is small enough that size is clearly not
  // the binding constraint. A single note that still overruns is a prompt problem, not a
  // batching one, and no amount of further splitting can help it.
  const minSplitNotes = 2

  /**
   * Halve a batch that overran the output budget and extract each half, recursing while a half
   * still truncates. Returns the concatenated result, or null when nothing survived.
   *
   * Concatenation (not de-dup) is deliberate: the caller merges every batch through the
   * kind+label / edge-triple dedup sets below, so duplicates across halves collapse there and
   * this stays a pure gathering step.
   *
   * A half that ERRORS is dropped while its sibling still counts — a partial batch is strictly
   * better than the whole batch being dropped, which is what happened before.
   */
  const extractBySplitting = async (
    noteList: { id: string; text: string }[],
    activeModel: string,
    budget: { left: number }
  ): Promise<ConstructedData | null> => {
    if (noteList.length < minSplitNotes || budget.left <= 0) return null
    const mid = Math.ceil(noteList.length / 2)
    const halves = [noteList.slice(0, mid), noteList.slice(mid)]
    const gathered: ConstructedData[] = []
    for (const half of halves) {
      if (Date.now() > deadline) break // wall-clock cap dominates the split budget
      if (budget.left <= 0) break
      budget.left--
      try {
        const { text, finishReason } = await callConstruction(half, activeModel)
        if (finishReason === 'length') {
          const deeper = await extractBySplitting(half, activeModel, budget)
          if (deeper) gathered.push(deeper)
        } else {
          gathered.push(parseConstruction(text))
        }
      } catch {
        /* this half is lost; its sibling can still contribute */
      }
    }
    if (gathered.length === 0) return null
    return {
      entities: gathered.flatMap((g) => g.entities),
      edges: gathered.flatMap((g) => g.edges),
      classifications: gathered.flatMap((g) => g.classifications),
      triples: gathered.flatMap((g) => g.triples ?? [])
    }
  }

  // One pass over all still-unfilled batches with `activeModel`, bounded by
  // CONCURRENCY and the wall-clock deadline. Returns how many batches failed with
  // a quota/billing error so constructBrain can decide whether a distinct-provider
  // retry is worth it. A batch is FAILED (results[i] left null) when it throws OR
  // the provider TRUNCATED it (finish_reason:'length') — a cut-off JSON body is
  // not a trustworthy extraction and must not be counted as a successful (possibly
  // empty) batch that could clobber a good cache.
  const runBatchLoop = async (activeModel: string): Promise<{ failoverErrors: number; sawStaleId: boolean }> => {
    let nextIdx = 0
    let failoverErrors = 0
    let sawStaleId = false
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = nextIdx++
        if (i >= batchList.length) return
        if (Date.now() > deadline) return // wall-clock cap: stop starting new batches
        if (results[i]) continue // already succeeded on an earlier model pass
        // How far through `batchList` this run got. NOT the same as how many batches SUCCEEDED:
        // the coverage cursor has to advance past a batch we consumed and failed, or the next run
        // re-spends a full LLM budget re-covering ground while the failure sits behind the cursor.
        lastConsumedIdx = Math.max(lastConsumedIdx, i)
        // Ollama reasoning models (qwen3 et al.) "think" silently before emitting — the
        // /v1 stream sends no chunks during that phase and trips the inactivity timeout,
        // failing EVERY batch ("Stream stalled — no chunks for 60s"). The `/no_think`
        // directive (honored via Ollama's OpenAI-compat endpoint) disables it so extraction
        // starts streaming immediately. Harmless for non-reasoning Ollama models; only
        // applied to the local Ollama path so hosted models are byte-identical.
        // Bounded per-batch retry/backoff: a transient stream stall / 5xx is retried in
        // place before the batch is abandoned. On the final failed attempt results[i] stays null (so
        // the batch counts as DROPPED — cache-preserving + observable); on success the recorded
        // failure reason (if any) is cleared so a recovered batch is not mis-reported.
        for (let attempt = 1; attempt <= maxBatchAttempts; attempt++) {
          if (Date.now() > deadline) break // wall-clock cap dominates the retry budget
          try {
            const { text, finishReason } = await callConstruction(batchList[i], activeModel)
            if (finishReason === 'length') {
              // Truncated mid-object: a partial parse would masquerade as a successful-but-empty
              // batch and could clobber a good cache.
              //
              // This used to RETRY the identical request, which cannot work: temperature is 0 and
              // the prompt, model and token budget are all unchanged, so a batch whose JSON genuinely
              // exceeds the budget truncates on every attempt. It burned the full retry allowance at
              // ~8k output tokens each and then dropped the batch anyway. Measured on the live brain
              // 2026-07-30: 3 of 4 observed streams finished `length`, every batch was ultimately
              // dropped, and construction had produced nothing for ten days.
              //
              // Halve the batch instead. Half the notes yield roughly half the JSON, which is the one
              // variable that actually moves the output under the budget, and it converges — the
              // recursion bottoms out at a single note.
              const split = await extractBySplitting(batchList[i], activeModel, { left: splitCallBudget })
              if (split) {
                results[i] = split
                batchFailReason.delete(i)
                break
              }
              batchFailReason.set(i, {
                reason: 'truncated',
                message: `finish_reason=length; nothing survived splitting (budget ${splitCallBudget} calls)`
              })
              break
            }
            results[i] = parseConstruction(text)
            batchFailReason.delete(i) // recovered → not a final failure
            break
          } catch (err) {
            const msg = (err as Error)?.message
            if (isProviderFailoverError(msg)) {
              // A same-model retry can't refill a dry account NOR fix a stale/unknown id — stop and let
              // the model-level fallback (below) RE-TARGET instead. Count it once so that fallback can be
              // decided; remember if any failure was a stale id so we prefer a within-provider hop.
              const staleId = isModelNotFoundError(msg)
              if (staleId) sawStaleId = true
              failoverErrors++
              batchFailReason.set(i, { reason: staleId ? 'unknown-model' : 'quota', message: msg ?? 'provider failover error' })
              break
            }
            batchFailReason.set(i, { reason: 'error', message: msg ?? 'unknown stream error' })
            if (attempt < maxBatchAttempts) {
              await sleep(batchBackoffMs * attempt)
              continue
            }
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batchList.length) }, () => worker()))
    return { failoverErrors, sawStaleId }
  }

  const { failoverErrors, sawStaleId } = await runBatchLoop(model)

  // Model-level fallback (mirror the /agui answer path): if EVERY batch failed and at least one was a
  // recoverable provider error, retry ONCE against another model before giving up — a dry key OR a
  // stale/unknown default id must not silently produce an empty brain. A stale id exhausts the SAME
  // provider's other catalog ids first (a single-key operator has no distinct provider to fall to); a
  // quota/billing failure jumps straight to a distinct keyed provider. The wall-clock deadline still
  // caps total work.
  if (results.every((r) => !r) && failoverErrors > 0) {
    const prov = getProviderForModel(model)
    const alt = sawStaleId
      ? routeWithinProvider(prov, 'extraction', new Set([model])) ?? routeDistinctModel(prov, 'extraction')
      : routeDistinctModel(prov, 'extraction')
    if (alt && alt !== model) {
      console.warn(`[construct] all batches failed (${sawStaleId ? 'unknown model' : 'quota'}) on ${model}; retrying once on ${alt}`)
      await runBatchLoop(alt)
    }
  }

  // Merge in batch order (dedup is order-independent, but ordered merge keeps the result stable).
  let okBatches = 0
  for (const data of results) {
    if (!data) continue
    okBatches++
    // Dedup on KIND + NORMALIZED LABEL, not on `e.id`.
    //
    // The batches are independent LLM calls, and the model mints a fresh slug each time it
    // meets the same entity — one project has come back as `project:<native-name>`,
    // `project:<romanized>` and `project:<alt-romanization>` across rebuilds. Keying on
    // `e.id` therefore deduped on the one field that is NOT stable: three batches can emit
    // one person under three ids, so all three pass the check and all three are pushed.
    //
    // That is a GENERATOR of duplicates, not a display artifact, and it compounds: every
    // rebuild re-rolls the slugs, so the entity set grows with each pass while downstream
    // dedup can only ever chase it. Measured on a real vault before this fix, single people
    // and orgs appeared 4–6 times each as exact label repeats.
    //
    // The label is what the model is actually stable about. Kind is kept in the key so a
    // genuine org-vs-person collision on the same surface form is preserved for the alias
    // whitelist to adjudicate, rather than being silently collapsed here.
    for (const e of data.entities) {
      const key = entityKey(String(e.kind), String(e.label ?? ''))
      if (!seenE.has(key)) { seenE.add(key); entities.push(e) }
    }
    for (const e of data.edges) {
      const k = e.source + NUL + e.target + NUL + e.type
      if (!seenEd.has(k)) { seenEd.add(k); edges.push(e) }
    }
    for (const c of data.classifications) if (!seenC.has(c.note)) { seenC.add(c.note); classifications.push(c) }
    for (const t of data.triples ?? []) {
      const k = t.subject + NUL + t.relation + NUL + t.object + NUL + t.note
      if (!seenT.has(k)) { seenT.add(k); triples.push(t) }
    }
  }

  // P3 observability: every batch still null after all passes (incl. the distinct-provider fallback)
  // is a DROPPED/truncated batch — the exact signal the churn hid. Emit them to the failure ledger
  // (fire-and-forget, fully isolated) whether or not the build ultimately persists, so a flaky run is
  // visible even when it produced a usable-but-shrunken graph.
  const droppedBatches: { index: number; reason: string; message: string }[] = []
  for (let i = 0; i < results.length; i++) {
    if (results[i]) continue
    const f = batchFailReason.get(i) ?? {
      reason: 'deadline_skipped',
      message: 'batch never ran (wall-clock deadline)'
    }
    droppedBatches.push({ index: i, reason: f.reason, message: f.message })
  }
  reportConstructionBatchFailures(model, batchList.length, droppedBatches)
  // Only quota counts as provider-side: it is the class that CANNOT succeed until the operator
  // acts (top up / fix the key). truncation and deadlines are wasteful but genuinely transient,
  // and treating them as a billing outage would pause background builds over ordinary flakiness.
  const providerDropped = droppedBatches.filter((d) => d.reason === 'quota').length

  if (okBatches === 0) {
    // A model WAS routed (line ~460) but no batch succeeded — truncation, a
    // quota/billing 402/429, a refusal, or a provider error. Signal 'model-error'
    // (NOT the no-model null) so the UI can prompt about provider balance/quota,
    // and DO NOT persist — the good/absent cache is preserved untouched.
    return { entities: 0, edges: 0, status: 'model-error' }
  }

  // L3 synonym bridge — offline/construction-only. Cluster the extracted entity LABELS by embedding
  // similarity (reuse claim-entities' cosine/union-find) and add 'synonym' alias edges so
  // graphNeighbors/graphExpand hop across surface-form variants ("ProjectA"↔"《ProjectA》"). Best-effort: no
  // embedder / slow load / mismatch ⇒ NO synonym edges ⇒ graph BYTE-IDENTICAL to today. The lazy
  // import + timeout race mirrors claim-extract.ts's annotateEntityKeys. NEVER embeds at retrieval.
  if (constructSynonymsEnabled() && entities.length >= 2 && entities.length <= MAX_SYNONYM_ENTITIES) {
    try {
      const { embedForRecall } = await import('../local-brain/index-store')
      const vecs = await Promise.race([
        embedForRecall(entities.map((e) => e.label)),
        new Promise<number[][]>((r) => setTimeout(() => r([]), 8000))
      ])
      if (vecs.length === entities.length) {
        for (const se of synonymEdges(entities, vecs)) {
          const k = se.source + NUL + se.target + NUL + se.type
          if (!seenEd.has(k)) {
            seenEd.add(k)
            edges.push(se)
          }
        }
      }
    } catch {
      /* no embedder / slow load → no synonym edges (today's graph) */
    }
  }

  const data: ConstructedData = { entities, edges, classifications, triples }

  // Clobber guard for the PRODUCTIVE path (mirror the chunks-empty guard at ~469):
  // batches ran and parsed without throwing, but yielded 0 entities (empty/refusal/
  // near-empty completions, or a truncated body that salvaged nothing). Overwriting
  // a good construction — or one being rebuilt by an in-flight reindex — with 0
  // entities blanks the graph/panels. No-op instead when there's something to
  // protect; a genuinely-empty vault with no prior construction still writes [] to
  // reflect reality.
  if (
    entities.length === 0 &&
    (isReindexing() || constructionCacheUnreadable() || (getConstruction()?.entities?.length ?? 0) > 0)
  ) {
    // Advance the COVERAGE cursor even though the DATA is not written. These are orthogonal: the
    // cursor records where to read next, the cache records what we know. Returning without
    // advancing meant a leading slice that yields no entities — logs, code dumps, link lists,
    // stubs — pinned every future run to that same slice forever, burning a whole LLM budget per
    // run to learn nothing. That is the exact stall the cursor was added to end, reintroduced one
    // guard higher up. Not advanced while a reindex is in flight: that run consumed nothing real.
    if (!isReindexing() && lastConsumedIdx >= 0) advanceCursorOnly(cursorAfter(lastConsumedIdx))
    return { entities: 0, edges: 0, status: 'kept-cache' } // no-op: keep the good cache
  }

  // The P3 DEGRADED-RUN CLOBBER GUARD used to sit here. It refused to persist when a run had
  // dropped batches AND produced fewer than DEGRADED_CLOBBER_FRACTION of the cached entity count.
  //
  // It is GONE because the write below cannot do the thing it was guarding against.
  // `convergeConstruction` is a UNION: it keeps every entity this run produced PLUS every prior
  // entity whose source note still exists, and it computes deletions against the FULL live note
  // set rather than the subset this run processed. The only entity it can ever drop is one whose
  // note was genuinely deleted from the vault. A partial, degraded or even mostly-broken run can
  // therefore only ADD — the 260→44 collapse this guard was written for was only reachable under
  // the REPLACE semantics convergence replaced.
  //
  // Meanwhile the count test was actively harmful, because a partial run's yield is compared
  // against a COMPLETE prior — a test no partial run can pass. Measured across three live runs on
  // 2026-07-30/31: 27/31, then 27/31, then 19/31 batches skipped on the wall clock, each refused,
  // each leaving the graph frozen at its 2026-07-20 build. Narrowing the guard to ignore
  // deadline-skipped batches was not enough: a single genuinely-truncated batch still tripped it,
  // and a run that completes 11 of 31 batches will always fall below 80% of a full prior.
  //
  // What still protects the cache: the 0-entity guard above (a run that learned nothing does not
  // touch a good cache), the `isReindexing` guard (never write mid-reindex), and the `okBatches
  // === 0` model-error return. Those key on "did this run produce anything trustworthy", which is
  // answerable; "is this count big enough" is not.

  // CONVERGENT CONSTRUCTION: union this run into the PRIOR cache so the graph has MEMORY across
  // rebuilds instead of being re-rolled (the live 44↔260 entity churn). Keeps every entity this run
  // found + prior entities it missed whose source note still exists; drops only genuine deletions. The
  // count converges to the stable superset. (temperature:0 above cuts run-to-run id variance so it
  // settles fast.) The degraded-clobber guard above still short-circuits an obviously-broken run before
  // we even merge; convergence handles the common clean-but-variant runs the guard can't touch.
  // Covered = every note in a batch that returned a parse this run (the notes actually re-read).
  const coveredNoteIds = new Set<string>()
  for (let i = 0; i < batchList.length; i++) if (results[i]) for (const n of batchList[i]) coveredNoteIds.add(n.id)
  const converged = convergeConstruction(getConstruction(), data, new Set(notes.map((n) => n.id)), coveredNoteIds)
  inMemory = converged
  inMemoryKey = dirKey()
  const persisted = persistConstruction(converged, cursorAfter(lastConsumedIdx))
  // P7b: self-policing Brain Health monitor. Fires exactly ONCE per COMPLETED rebuild,
  // AFTER the cache has persisted (this is the sole productive persist site — buildBrain →
  // constructBrain reaches here on every real rebuild, whether triggered by boot, a manual
  // reindex, or the notes-watcher's ~20-30min debounced pass). FIRE-AND-FORGET + fully
  // swallowed (runBrainHealthMonitor wraps its whole body in try/catch) so the benchmark can
  // never break or delay the rebuild; the `void` + lazy import mean the persist path's return
  // is not blocked and no import cycle (construct↔brain-health-live) is created.
  void import('./brain-health-monitor')
    .then((m) => m.runBrainHealthMonitor(notesDirProvider()))
    .catch(() => {})
  // 'built' PROMISES the cache was written. A failed write is not a successful build with a note in
  // the log — the in-memory copy is fresh but `builtAt` never moved, so the floor keeps reading the
  // graph as stale and every caller that broadcasts `brain:updated` on 'built' would be announcing
  // a persistence that did not happen. 'model-error' is the honest arm: the run produced entities
  // but the result did not survive.
  if (!persisted) {
    console.warn('[construct] build succeeded but the cache write FAILED — reporting model-error, not built')
    return { entities: 0, edges: 0, status: 'model-error' }
  }
  return {
    entities: converged.entities.length,
    edges: converged.edges.length,
    status: 'built',
    providerDropped,
    totalBatches: batchList.length
  }
}
