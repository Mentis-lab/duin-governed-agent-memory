// entity-resolver — Phase P2 (①) of the DUIN identity-spine fix, the DEDUP KEYSTONE.
// See PLANNING/DUIN_BRAIN_GRAPH_ARCHITECTURE_AND_IDENTITY_SPINE.md §5 ①.
//
// PROBLEM. The construction LLM mints a DIFFERENT `kind:slug` id for the SAME real
// entity every ~30-min rebuild (non-determinism): one project surfaces as project:<label> /
// project:<romanization> / project:<translation>; one company as org:<name> / org:<name-variant> /
// project:<name>. Today's dedup is EXACT-STRING on id, so all the
// churning slug variants survive as separate nodes — the graph fragments, degree splits,
// labels drop out, and multi-hop retrieval decays.
//
// FIX. A PURE, label-keyed id-collapse. For each entity whose NORMALIZED LABEL is in a
// curated `ENTITY_ALIAS` whitelist group, rewrite its id → the group's STABLE canonical id
// (`<kind>:<slug>`, derived once from the canonical label — NEVER a churning LLM slug), and
// rewire every edge endpoint referencing a rewritten id → the canonical id. buildDuinGraph's
// base-wins `byId` then folds the duplicates into ONE node (which inherits the union of edges).
//
// WHY IDEMPOTENT UNDER SLUG CHURN. We key the match on the STABLE LABEL, not on any specific
// slug id. So two rebuilds that mint DIFFERENT slug ids for the same labels resolve to the
// SAME canonical ids — and running the resolver twice is a no-op (an entity already at its
// canonical id is skipped). The label is the invariant; the slug is disposable.
//
// SAFETY (zero-over-merge design):
//   - The whitelist is HAND-AUDITED (each group is a census-confirmed duplicate set) and, since
//     cold-start A1, loaded from the VAULT rather than compiled in.
//     It is the ONLY merge gate. The embedding clusterer (claim-entities.clusterAliases) is
//     repurposed here ONLY as a candidate SURFACER (`proposeAliasGroups`) into a human review
//     queue — it PROPOSES groups by cosine ≥ 0.86, it NEVER auto-merges.
//   - A DISJOINT-SUBGRAPH TRIPWIRE blocks even a whitelisted merge when the ids being folded
//     each carry a high-degree, edge-DISJOINT neighbourhood (the heuristic signature of two
//     genuinely distinct entities that share a label) — so one bad whitelist entry can't
//     silently collapse two real entities.
//
// PURE: resolveEntityIdentity returns a NEW ConstructedData; no input is mutated.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConstructedData, ConstructedEntity, ConstructedEdge } from './types'
import { clusterAliases, cosine } from './claim-entities'

// ──────────────────── the curated alias whitelist ────────────────────

/** One census-confirmed duplicate group. `canonicalId` is the STABLE target id every
 *  alias entity is rewritten to — `<kind>:<slug>` derived ONCE from the canonical label,
 *  NOT any churning LLM slug. The chosen kind is the canonical kind for the group (cross-
 *  kind duplicates, e.g. a company appearing as both org: and project:, collapse onto one id). */
export interface AliasGroup {
  /** Stable canonical id `<kind>:<slug>` — the merge target. */
  canonicalId: string
  /** Human canonical label (logs + the review queue). */
  canonical: string
  /** Surface-form labels (any case/spacing/CJK) that denote the SAME real entity.
   *  normName'd when the lookup index is built. */
  aliases: string[]
  /** WHO merged this group.
   *  `'auto'`      = written unattended by runEntityAutoMergeTick under the containment-spine
   *                  policy (embedding cosine + lexical containment — "are these two DIFFERENT
   *                  labels the same thing?").
   *  `'auto-kind'` = written by entity-kind-collapse: the SAME normalized label recorded under
   *                  several kinds. Exact and deterministic, so it needs no embedder and runs
   *                  over the whole census rather than the cosine clusterer's capped prefix.
   *                  Kept distinct from `'auto'` precisely because the two carry different
   *                  evidence, and a later reader auditing a merge needs to know which.
   *  anything else = a human confirming a candidate.
   *
   *  Absent on every row written before 2026-08-03, and that is deliberately NOT back-inferred to
   *  `'human'`: we do not know, and inventing a provenance is exactly the failure this field exists
   *  to prevent (property 3 — provenance is recorded, never inferred). Treat `undefined` as
   *  unknown. Entity identity is the one place a wrong merge is not cleanly recoverable, so being
   *  able to ask "did a human agree to this?" is the difference between an auditable merge and an
   *  anonymous one. */
  source?: 'auto' | 'auto-kind' | 'human'
}

// Every group is a CONFIRMED duplicate set; zero speculative merges. Keyed by LABEL surface
// forms, never by slug id, so it survives the ~30-min rebuild slug churn. Extensible: new groups
// are added when a human confirms a `proposeAliasGroups` candidate, OR by runEntityAutoMergeTick
// under the conservative containment-spine policy (entity-automerge.ts) — everything outside that
// policy still requires a human.
//
// COLD-START A1 (2026-07-25): the shipped default is EMPTY, and real alias groups live in
// per-vault state at `.duin/_state/entity-aliases.json`.
//
// This table used to be 14 hand-audited groups of the AUTHOR's real people, orgs and projects,
// compiled into the binary. Two problems, both load-bearing rather than cosmetic: the groups
// shipped to every user (a leak), and because the resolver is default-ON, a second operator's
// common first name was silently collapsed onto the author's person. An identity spine keyed on
// someone else's identities is worse than no spine.
//
// The whitelist is still the SOLE merge authority — it just now comes from the vault it describes.
// Rows reach it two ways: hand-confirmed by the operator, or machine-appended by the automerge tick
// under the containment-spine policy. `proposeAliasGroups` keeps emitting candidates either way;
// confirmation writes to the vault file instead of to source.
export const ENTITY_ALIAS: AliasGroup[] = []

/** Alias groups for the CURRENTLY loaded vault. Empty until a vault is loaded — a fresh install
 *  merges nothing, which is the safe direction (an unmerged duplicate is recoverable; a wrong
 *  merge onto a stranger's identity is not). */
let _activeAliasGroups: AliasGroup[] = ENTITY_ALIAS

export function activeAliasGroups(): ReadonlyArray<AliasGroup> {
  return _activeAliasGroups
}

/** The one place the whitelist's path is spelled. Shared with `aliasWhitelistUnreadable` below so
 *  the guard and the loader can never drift onto different files — a guard that probes a path
 *  nothing reads is inert. (entity-automerge-tick exports the same join for its callers; it cannot
 *  be imported here, it imports this module.) */
function aliasStatePath(vaultDir: string): string {
  return join(vaultDir, '.duin', '_state', 'entity-aliases.json')
}

/** Read `.duin/_state/entity-aliases.json` and make it the active whitelist. Best-effort: a
 *  missing or malformed file leaves the whitelist EMPTY rather than falling back to anything
 *  built in — there is no longer anything built in to fall back to. */
export function loadAliasGroups(vaultDir: string | null | undefined): ReadonlyArray<AliasGroup> {
  let groups: AliasGroup[] = []
  if (vaultDir) {
    try {
      const raw = JSON.parse(readFileSync(aliasStatePath(vaultDir), 'utf-8')) as unknown
      if (Array.isArray(raw)) {
        groups = raw.filter(
          (g): g is AliasGroup =>
            !!g &&
            typeof (g as AliasGroup).canonicalId === 'string' &&
            typeof (g as AliasGroup).canonical === 'string' &&
            Array.isArray((g as AliasGroup).aliases)
        )
      }
    } catch {
      groups = []
    }
  }
  setActiveAliasGroups(groups)
  return groups
}

/**
 * Does the whitelist exist on disk but fail to load? The distinction `loadAliasGroups` erases.
 *
 * `loadAliasGroups` returns `[]` for BOTH "no whitelist yet" and "a whitelist I cannot read right
 * now", and collapsing those is correct on the READ path — an unparseable file must not take the
 * resolver down. It is destructive on the WRITE path. Both append sites compute
 * `[...existing, ...proposed]` and rewrite the file WHOLE; with `existing` wrongly empty, one
 * background tick writes every hand-authored group out of existence. There is no `.corrupt`
 * sidecar, and the loss is silent in both directions — the parse error is swallowed here, and the
 * overwrite looks like an ordinary append there. moat-backup DOES snapshot this file (it is named
 * there as one of the two least reproducible artifacts), but that is a recovery path, not a
 * guard: snapshots are taken at the top of reindexImpl, rotate 10 deep per label, and restore only
 * when an operator invokes it — none of which happens if nobody notices the groups are gone.
 *
 * The reachable cause is mundane: the file is pretty-printed precisely BECAUSE a human edits it by
 * hand (see writeAliasGroups), so a trailing comma is a normal Tuesday.
 *
 * Same shape and same reason as construct.ts's `constructionCacheUnreadable()`: a prior we cannot
 * READ is not the same as no prior. A read error (a Windows lock, a partial write) counts as
 * unreadable too — it has the same empty-`existing` consequence as a parse error.
 */
export function aliasWhitelistUnreadable(vaultDir: string | null | undefined): boolean {
  if (!vaultDir) return false
  const p = aliasStatePath(vaultDir)
  if (!existsSync(p)) return false // absent — there is nothing to protect
  try {
    // Not an array ⇒ present and malformed: loadAliasGroups yields `[]` from it just the same.
    return !Array.isArray(JSON.parse(readFileSync(p, 'utf-8')))
  } catch {
    return true // present, and unreadable right now
  }
}

/** Replace the active whitelist (vault load, or a test). Invalidates the derived caches. */
export function setActiveAliasGroups(groups: ReadonlyArray<AliasGroup>): void {
  _activeAliasGroups = [...groups]
  _aliasIndexCache = null
  _aliasCanonicalIds = null
}

// ──────────────────── flag + normalization ────────────────────

/** Whether the entity resolver runs. Default ON (P3 flip) — the identity spine is now the
 *  cornerstone of the brain graph, so it runs unless EXPLICITLY disabled. `DUIN_ENTITY_RESOLVER=0`
 *  is the opt-OUT kill-switch (returns byte-identical passthrough output); unset / any other
 *  value ⇒ ENABLED. It SUBSUMES `DUIN_PERSON_RESOLVER`: person/org exact-name collapse is a
 *  subcase of the label-keyed whitelist, and the person→profile-note fold is composed after the
 *  alias collapse in retrieve-agent.resolveConstructionIdentity so person resolution still fires
 *  under this single flag. Matches the `!== '0'` opt-out polarity of DUIN_MAP_ENTITY_OVERLAY. */
export function entityResolverEnabled(): boolean {
  return process.env.DUIN_ENTITY_RESOLVER !== '0'
}

/** Normalized-label key: trim, collapse internal whitespace, lowercase. CJK is kept
 *  verbatim (lowercasing is a no-op on it). This is the ONLY normalization — matching is
 *  exact on the normalized surface form, never fuzzy, so a bare first name only matches an
 *  alias group that literally lists it. */
export function normName(s: string): string {
  return (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Build normLabel → canonicalId from the whitelist. First group wins a duplicate alias key
 *  (deterministic); a duplicate is a whitelist authoring bug, surfaced by the assert-once. */
function buildAliasIndex(groups: ReadonlyArray<AliasGroup>): Map<string, string> {
  const index = new Map<string, string>()
  for (const g of groups) {
    // the canonical label is itself a valid surface form.
    for (const surface of [g.canonical, ...g.aliases]) {
      const key = normName(surface)
      if (!key) continue
      if (!index.has(key)) index.set(key, g.canonicalId)
    }
  }
  return index
}

// ──────────────── whitelist reuse (the SOLE merge authority, shared with the entity graph) ────────────────
//
// Foundation 3's persistent store (entity-graph-store.ts) and its write-time relink must key node
// identity on the SAME whitelist that governs construction merges — never a second merge gate. These
// helpers expose the whitelist as a read-only lookup so the store REUSES it rather than re-deriving.

let _aliasIndexCache: Map<string, string> | null = null
function aliasIndex(): Map<string, string> {
  return (_aliasIndexCache ??= buildAliasIndex(_activeAliasGroups))
}

// Derived from the ACTIVE groups, so it must be recomputed when a vault loads — not a module
// constant frozen at import time (it was, while the whitelist was compiled in).
let _aliasCanonicalIds: Set<string> | null = null
function aliasCanonicalIdSet(): Set<string> {
  return (_aliasCanonicalIds ??= new Set(_activeAliasGroups.map((g) => g.canonicalId)))
}

/** The whitelist canonical id for a surface label, or null when the label is not a known alias.
 *  This is the SOLE identity-merge authority the entity graph consults — a label absent here is
 *  NEVER merged (it keys on its own derived id). */
export function aliasCanonicalId(label: string): string | null {
  return aliasIndex().get(normName(label)) ?? null
}

/** Whether `id` is one of the whitelist's canonical merge-target ids. cascadeInvalidate uses this to
 *  refuse any retirement whose claimed merge target is NOT a human-confirmed whitelist group — so the
 *  cascade can only ever be a CONSEQUENCE of a sanctioned merge, never an autonomous decision. */
export function isAliasCanonicalId(id: string): boolean {
  return aliasCanonicalIdSet().has(id)
}

// ──────────────────── the disjoint-subgraph tripwire ────────────────────

const EMPTY: ReadonlySet<string> = new Set<string>()

/** SHARED tripwire predicate (exported so the entity graph's relink reuses the SAME over-merge guard,
 *  not a copy): true when `a`'s neighbours and `b`'s neighbours share NOTHING (excluding each other) —
 *  the signature of two genuinely-separate subgraphs that happen to share a label. */
export function neighboursDisjointSets(
  na: ReadonlySet<string>,
  nb: ReadonlySet<string>,
  a: string,
  b: string
): boolean {
  return neighboursDisjoint(na, nb, a, b)
}

/** Blocked-merge diagnostic (logged + optionally injected in tests). */
export interface BlockedMerge {
  canonicalId: string
  /** The source ids whose merge was vetoed. */
  ids: string[]
  reason: 'disjoint-high-degree'
}

function defaultOnBlocked(info: BlockedMerge): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[entity-resolver] BLOCKED merge → ${info.canonicalId}: ids ${info.ids.join(', ')} have ` +
      `high-degree, edge-DISJOINT neighbourhoods (likely distinct entities); left unmerged.`
  )
}

/** True when `a`'s neighbours and `b`'s neighbours share NOTHING (excluding each other) —
 *  the signature of two genuinely-separate subgraphs that happen to share a label. */
function neighboursDisjoint(
  na: ReadonlySet<string>,
  nb: ReadonlySet<string>,
  a: string,
  b: string
): boolean {
  for (const x of na) {
    if (x === b) continue // the direct a↔b edge is not a SHARED third neighbour
    if (x !== a && nb.has(x)) return false
  }
  return true
}

// ──────────────────── options ────────────────────

export interface EntityResolverOpts {
  /** Override the whitelist (tests). Defaults to ENTITY_ALIAS. */
  groups?: ReadonlyArray<AliasGroup>
  /** Disjoint-subgraph tripwire: a group's merge is BLOCKED when two of its source ids each
   *  have degree ≥ highDegree AND their neighbourhoods are edge-disjoint. Default 6 — high
   *  enough that low-degree LLM fragments (the real duplicates) never trip it. */
  highDegree?: number
  /** Sink for blocked-merge diagnostics. Default console.warn. */
  onBlocked?: (info: BlockedMerge) => void
}

// ──────────────────── the resolver ────────────────────

/**
 * Collapse whitelisted duplicate entities to ONE canonical id and rewire edges. PURE —
 * returns a NEW ConstructedData (or null when `construction` is null).
 *
 * Steps:
 *   1. LABEL-keyed match: every entity whose normName(label) is in a whitelist group is a
 *      merge candidate targeting the group's stable canonical id. An entity already AT its
 *      canonical id is a no-op (idempotence).
 *   2. Disjoint-subgraph tripwire: for each canonical group, if two source ids each carry a
 *      high-degree, edge-disjoint neighbourhood, the WHOLE group's merge is vetoed + logged.
 *   3. Rewrite surviving candidates' ids → canonical, and rewire every edge endpoint.
 */
export function resolveEntityIdentity(
  construction: ConstructedData | null | undefined,
  opts: EntityResolverOpts = {}
): ConstructedData | null {
  if (!construction) return construction ?? null

  const groups = opts.groups ?? _activeAliasGroups
  const highDegree = opts.highDegree ?? 6
  const aliasIndex = buildAliasIndex(groups)

  // (1) label-keyed candidates: entityId → canonicalId (only where they differ).
  const wanted = new Map<string, string>()
  const canonToIds = new Map<string, Set<string>>()
  for (const e of construction.entities) {
    const canon = aliasIndex.get(normName(e.label))
    if (!canon) continue // label not whitelisted → leave untouched
    if (e.id === canon) continue // already canonical → idempotent no-op
    wanted.set(e.id, canon)
    ;(canonToIds.get(canon) ?? canonToIds.set(canon, new Set()).get(canon)!).add(e.id)
  }
  if (wanted.size === 0) return { ...construction } // pure: NEW object, no input aliasing

  // (2) tripwire — adjacency over construction edges (undirected, self-safe).
  const adj = new Map<string, Set<string>>()
  const addAdj = (a: string, b: string): void => {
    ;(adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b)
  }
  for (const ed of construction.edges) {
    if (ed.source === ed.target) continue
    addAdj(ed.source, ed.target)
    addAdj(ed.target, ed.source)
  }
  const degOf = (id: string): number => adj.get(id)?.size ?? 0
  const neighOf = (id: string): ReadonlySet<string> => adj.get(id) ?? EMPTY
  const onBlocked = opts.onBlocked ?? defaultOnBlocked

  const blocked = new Set<string>() // canonicalIds whose merge is vetoed
  for (const [canon, idSet] of canonToIds) {
    const ids = [...idSet]
    let veto = false
    for (let i = 0; i < ids.length && !veto; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]
        const b = ids[j]
        if (
          degOf(a) >= highDegree &&
          degOf(b) >= highDegree &&
          neighboursDisjoint(neighOf(a), neighOf(b), a, b)
        ) {
          veto = true
          onBlocked({ canonicalId: canon, ids, reason: 'disjoint-high-degree' })
          break
        }
      }
    }
    if (veto) blocked.add(canon)
  }

  // (3) final remap — drop vetoed groups.
  const remap = new Map<string, string>()
  for (const [oldId, canon] of wanted) if (!blocked.has(canon)) remap.set(oldId, canon)
  if (remap.size === 0) return { ...construction }

  const entities: ConstructedEntity[] = construction.entities.map((e) =>
    remap.has(e.id) ? { ...e, id: remap.get(e.id) as string } : e
  )
  const edges: ConstructedEdge[] = construction.edges.map((ed) => {
    const source = remap.get(ed.source) ?? ed.source
    const target = remap.get(ed.target) ?? ed.target
    return source === ed.source && target === ed.target ? ed : { ...ed, source, target }
  })

  return { ...construction, entities, edges }
}

// ──────────────────── candidate SURFACER (proposes, never merges) ────────────────────

/** A PROPOSED alias group for the human review queue. Never applied automatically. */
export interface AliasCandidate {
  /** clusterAliases' chosen canonical label (longest form). */
  canonical: string
  /** ≥2 distinct labels the embedder clustered as the same real thing. */
  members: string[]
}

/**
 * Repurpose the embedding clusterer (claim-entities.clusterAliases) as a candidate SURFACER:
 * given entity labels + their aligned vectors, PROPOSE new alias groups (cosine ≥ threshold)
 * that are NOT already covered by the whitelist. This feeds a HUMAN review queue — it never
 * auto-merges. PURE.
 */
export function proposeAliasGroups(
  labels: string[],
  vecs: number[][],
  opts: { threshold?: number; groups?: ReadonlyArray<AliasGroup> } = {}
): AliasCandidate[] {
  if (labels.length < 2 || vecs.length !== labels.length) return []
  const threshold = opts.threshold ?? 0.86
  const known = buildAliasIndex(opts.groups ?? _activeAliasGroups)
  const map = clusterAliases(labels, vecs, threshold)

  const byCanon = new Map<string, Set<string>>()
  for (const [label, canon] of map) {
    ;(byCanon.get(canon) ?? byCanon.set(canon, new Set()).get(canon)!).add(label)
  }

  const out: AliasCandidate[] = []
  for (const [canon, memberSet] of byCanon) {
    if (memberSet.size < 2) continue // a singleton isn't a merge proposal
    const members = [...memberSet]
    // skip groups already fully covered by the whitelist (no new information to review).
    if (members.every((m) => known.has(normName(m)))) continue
    out.push({ canonical: canon, members: members.sort() })
  }
  return out.sort((a, b) => (a.canonical < b.canonical ? -1 : 1))
}

// ──────────────── enriched review report (for the /debug/alias-candidates surface) ────────────────

/** A construction entity node reduced to what the review surface needs. */
export interface EntityRef {
  id: string
  label: string
  kind: string
}

/** One enriched alias-merge PROPOSAL for the human review surface. Never applied automatically —
 *  a confirmed group is HAND-ADDED to ENTITY_ALIAS below and shipped (the over-merge safety gate). */
export interface AliasCandidateReport {
  /** clusterAliases' chosen canonical label (longest/fullest surface form). */
  suggestedCanonicalLabel: string
  /** A STABLE `<kind>:<slug>` id derived from the canonical LABEL (never a churning LLM slug) —
   *  the id a human would use as the group's `canonicalId`. */
  suggestedCanonicalId: string
  /** The actual construction nodes (id/label/kind) this proposal would fold — includes every
   *  entity whose trimmed label matches a clustered member, so exact-dup ids surface too. */
  members: EntityRef[]
  /** Minimum pairwise cosine among the clustered member vectors — the group's confidence floor
   *  (higher ⇒ tighter cluster). Results are sorted by this, descending. */
  cosineMin: number
  /** Copy-paste-ready ENTITY_ALIAS literal — drop straight into entity-resolver.ts after a human
   *  confirms the group is a true duplicate set. */
  pasteSnippet: string
}

/** Stable `<slug>` from a label: lowercased, non-alphanumeric runs → '-', trimmed. CJK letters are
 *  kept verbatim (they are `\p{L}`), matching the whitelist convention (a CJK label stays verbatim, a mixed name
 *  → its hyphenated slug). Deterministic — the same label always yields the same slug across rebuilds. */
export function slugifyLabel(label: string): string {
  return (label ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/** Minimum pairwise cosine over a set of aligned vectors (1 when <2 vectors). */
function minPairwiseCosine(vecs: number[][]): number {
  if (vecs.length < 2) return 1
  let min = 1
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const c = cosine(vecs[i], vecs[j])
      if (c < min) min = c
    }
  }
  return min
}

/**
 * Enrich `proposeAliasGroups` output into human-review-ready reports: map each clustered member
 * label back to the actual construction nodes (id/label/kind), derive a stable suggested canonical
 * id + a copy-paste ENTITY_ALIAS snippet, compute the cluster's cosine floor, and sort by confidence
 * (cosineMin desc). PURE — no I/O; the caller supplies the entities, labels and their aligned vecs.
 *
 * `labels[i]` must be embedded as `vecs[i]` (the DISTINCT entity labels). SURFACES only — the output
 * is never applied; a confirmed group is hand-added to ENTITY_ALIAS and shipped.
 */
export function buildAliasCandidates(
  entities: ReadonlyArray<EntityRef>,
  labels: string[],
  vecs: number[][],
  opts: { threshold?: number; groups?: ReadonlyArray<AliasGroup> } = {}
): AliasCandidateReport[] {
  const candidates = proposeAliasGroups(labels, vecs, opts)
  if (candidates.length === 0) return []

  // label (exact, as passed) → its aligned vector, for the cosine floor.
  const vecByLabel = new Map<string, number[]>()
  for (let i = 0; i < labels.length; i++) vecByLabel.set(labels[i], vecs[i])

  // normName(label) → construction nodes carrying it (surfaces exact-dup ids under one member).
  const nodesByNorm = new Map<string, EntityRef[]>()
  for (const e of entities) {
    const key = normName(e.label)
    ;(nodesByNorm.get(key) ?? nodesByNorm.set(key, []).get(key)!).push({ id: e.id, label: e.label, kind: e.kind })
  }

  const reports: AliasCandidateReport[] = []
  for (const cand of candidates) {
    const members: EntityRef[] = []
    for (const m of cand.members) {
      const nodes = nodesByNorm.get(normName(m))
      if (nodes) members.push(...nodes)
      else members.push({ id: '(unmapped)', label: m, kind: 'unknown' }) // clustered label with no live node (defensive)
    }
    // canonical kind = the kind of the node matching the canonical label, else the most common kind.
    const canonNodes = nodesByNorm.get(normName(cand.canonical)) ?? []
    const kind =
      canonNodes[0]?.kind ??
      [...members].sort((a, b) =>
        members.filter((m) => m.kind === b.kind).length - members.filter((m) => m.kind === a.kind).length
      )[0]?.kind ??
      'topic'
    const suggestedCanonicalId = `${kind}:${slugifyLabel(cand.canonical)}`
    const aliasLabels = [...new Set(cand.members.map((m) => m.toLowerCase()))].sort()
    const pasteSnippet =
      `{ canonicalId: '${suggestedCanonicalId}', canonical: '${cand.canonical.replace(/'/g, "\\'")}', ` +
      `aliases: [${aliasLabels.map((a) => `'${a.replace(/'/g, "\\'")}'`).join(', ')}] }`
    const cosineMin = minPairwiseCosine(cand.members.map((m) => vecByLabel.get(m) ?? []).filter((v) => v.length))
    reports.push({ suggestedCanonicalLabel: cand.canonical, suggestedCanonicalId, members, cosineMin, pasteSnippet })
  }
  // confidence sort: tightest clusters first.
  return reports.sort((a, b) => b.cosineMin - a.cosineMin)
}

// ──────────────── /debug/alias-candidates report core (deps injected; unit-testable) ────────────────

const ALIAS_SURFACE_NOTE =
  'SURFACE-ONLY: these are PROPOSED duplicate groups (embedding cosine ≥ 0.86, excluding labels ' +
  'already in ENTITY_ALIAS). Nothing is merged. Confirm each group by eye, paste its `pasteSnippet` ' +
  'into ENTITY_ALIAS in electron/services/brain/entity-resolver.ts, and ship — the whitelist edit is ' +
  'the human over-merge gate.'

// O(N²) cosine guard: cluster at most this many distinct labels (~150 live; the cap only bites a
// pathological census). Beyond it we cluster the first N and flag `capped`.
export const ALIAS_CANDIDATES_MAX_LABELS = 1500

/** Injected embedder — the SAME shape as claim-entities' EmbedFn (index-store.embedForRecall). */
export type EmbedFn = (texts: string[]) => Promise<number[][]>

/**
 * Core of the /debug/alias-candidates surface (deps injected so it unit-tests without HTTP or the
 * electron module graph): take the RAW construction (NOT-yet-collapsed dups are exactly the target),
 * embed its distinct entity labels via the SAME embedder the live pipeline uses (embedForRecall),
 * run the enriched surfacer, and return a copy-paste-friendly review payload. Returns a clear
 * `{error,reason}` (never fabricated data) when there's no construction or the embedder isn't warm
 * in this context. SURFACES only — nothing is ever merged here.
 */
export async function computeAliasCandidatesReport(
  construction: ConstructedData | null | undefined,
  embed: EmbedFn
): Promise<Record<string, unknown>> {
  if (!construction || !construction.entities?.length) {
    return { error: 'no-construction', reason: 'getConstruction() returned no entities — run "Build my brain" first, then retry.' }
  }
  const entities: EntityRef[] = construction.entities.map((e) => ({ id: e.id, label: e.label, kind: String(e.kind) }))
  let distinctLabels = Array.from(new Set(entities.map((e) => e.label.trim()).filter((s) => s.length > 0)))
  let capped = false
  if (distinctLabels.length > ALIAS_CANDIDATES_MAX_LABELS) {
    capped = true
    // eslint-disable-next-line no-console
    console.warn(
      `[alias-candidates] ${distinctLabels.length} distinct labels > cap ${ALIAS_CANDIDATES_MAX_LABELS}; ` +
        `clustering the first ${ALIAS_CANDIDATES_MAX_LABELS} (O(N²) embedding-cluster guard).`
    )
    distinctLabels = distinctLabels.slice(0, ALIAS_CANDIDATES_MAX_LABELS)
  }
  if (distinctLabels.length < 2) {
    return { note: ALIAS_SURFACE_NOTE, entityCount: entities.length, distinctLabels: distinctLabels.length, capped, candidateCount: 0, candidates: [] }
  }
  const vecs = await embed(distinctLabels)
  if (!vecs || vecs.length !== distinctLabels.length || !vecs.every((v) => v && v.length)) {
    return {
      error: 'embeddings-unavailable',
      reason:
        'embedForRecall returned [] or a length mismatch — the on-device embedder (transformers ' +
        'utilityProcess) is not warm in this context. It needs a userData path and an embedder that ' +
        'has run at least once (index some notes first), then retry.'
    }
  }
  const candidates = buildAliasCandidates(entities, distinctLabels, vecs)
  return { note: ALIAS_SURFACE_NOTE, entityCount: entities.length, distinctLabels: distinctLabels.length, capped, candidateCount: candidates.length, candidates }
}
