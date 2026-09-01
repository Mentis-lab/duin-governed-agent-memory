// person-resolver — Phase R of the DUIN store consolidation
// (PLANNING/DUIN_STORE_CONSOLIDATION_BUILD_PLAN.md § Phase R).
//
// PROBLEM. In liveGraph() the SAME human appears TWICE:
//   (i)  a construction `person:<slug>` entity — mention-anchored, the CONNECTED
//        copy (~83 edges lifted from prose), and
//   (ii) the profile-note relpath node (`ProjectB/a contact.md`) — the file that IS
//        that person, but structurally an island vs the mention graph.
// They never merge, so the profile note can't reach the person's mention graph and
// vice-versa. Same story for orgs.
//
// RESOLVER. For each construction `person:`/`org:` entity, find the PROFILE note whose
// person/org NAME matches the entity `label` EXACTLY (case/whitespace-normalized — but
// NOT fuzzy: over-merge is the risk we design against). On a confident match, rewrite
// the entity's `id` to the profile relpath and rewrite EVERY construction edge endpoint
// that referenced the old slug id to the relpath. buildDuinGraph then folds the rewritten
// entity onto the base note node (base wins the id collision) — so the profile note
// INHERITS the mention graph's edges. Unmatched entities are left untouched.
//
// The bridge (name → profile relpath) comes from entities-native's listVaultEntities:
// each profile carries `id = 'vault:/<relpath>'` and a `name`. Strip `vault:/` → relpath.
//
// PURE: resolveEntityIdentity returns a NEW ConstructedData; no input is mutated.

import { listVaultEntities } from './entities-native'
import type { ConstructedData, ConstructedEntity, ConstructedEdge } from './types'

/** Normalized-name → profile-note relpath. Built from the vault's person/org profiles. */
export type ProfileIndex = ReadonlyMap<string, string>

/** Whether liveGraph() reconciles construction `person:`/`org:` entities onto their
 *  profile-note relpath. Default OFF — unset / empty / any-other value ⇒ NO resolution,
 *  so default retrieval output is UNCHANGED. `DUIN_PERSON_RESOLVER=1` enables it.
 *  Matches the `=== '1'` polarity of the other opt-in DUIN_* retrieval flags. */
export function personResolverEnabled(): boolean {
  return process.env.DUIN_PERSON_RESOLVER === '1'
}

/** Exact-match key: trim, collapse internal whitespace, lowercase. NOT fuzzy — this is
 *  the ONLY normalization the resolver applies, so `Devin` never matches `a contact`. */
export function normName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Strip the `vault:/` prefix off a profile entity id → the note relpath. */
function relpathOf(id: string | undefined): string {
  if (!id) return ''
  return id.startsWith('vault:/') ? id.slice('vault:/'.length) : id
}

/**
 * Build the name→relpath index from the vault's person + org PROFILE notes
 * (entities-native.listVaultEntities). Keyed by normName(name); first-wins on a
 * normalized-name collision (mirrors listVaultEntities' own first-wins walk order).
 * People and orgs share one index — construction entity ids are already kind-prefixed
 * (`person:` / `org:`), and an exact name shared by a person AND an org profile is
 * vanishingly rare; first-wins keeps it deterministic.
 */
export function buildProfileIndex(vault: string): ProfileIndex {
  const index = new Map<string, string>()
  if (!vault) return index
  const { people, orgs } = listVaultEntities(vault)
  for (const ent of [...people, ...orgs]) {
    const key = normName(ent.name)
    const rel = relpathOf(ent.id)
    if (!key || !rel) continue
    if (!index.has(key)) index.set(key, rel)
  }
  return index
}

/**
 * Reconcile construction `person:`/`org:` entities with their profile-note relpath.
 * PURE — returns a NEW ConstructedData (or null when `construction` is null).
 *
 * For each `person:`/`org:` entity whose normName(label) EXACTLY matches a profile in
 * `index`, rewrite its id → the profile relpath, and rewire every construction edge
 * endpoint referencing the old slug id → the relpath. Conservative guards:
 *   - exact normalized-name match only (no fuzzy) — over-merge is the failure mode;
 *   - if TWO entities would map to the SAME relpath, the FIRST claims it; later ones are
 *     left UNTOUCHED (kept as their slug) so no duplicate relpath id is minted. The count
 *     of skipped collisions is returned for observability.
 * Non-person/org entities, and person/org entities with no exact match, pass through
 * unchanged. Classifications and triples are untouched (they key on note relpath / prose,
 * not entity ids).
 */
export function resolveEntityIdentity(
  construction: ConstructedData | null | undefined,
  index: ProfileIndex
): ConstructedData | null {
  if (!construction) return construction ?? null

  // oldSlugId → profile relpath, for the entities we confidently resolve.
  const remap = new Map<string, string>()
  const claimed = new Set<string>() // relpaths already taken (first-wins)
  let collisions = 0

  for (const e of construction.entities) {
    if (e.kind !== 'person' && e.kind !== 'org') continue
    const rel = index.get(normName(e.label))
    if (!rel) continue // no exact profile match → leave untouched
    if (e.id === rel) continue // already the relpath (idempotent)
    if (claimed.has(rel) || remap.has(e.id)) {
      // A different entity already claimed this relpath (or this id already resolved):
      // dropping-to-untouched avoids minting a duplicate relpath id.
      collisions++
      continue
    }
    claimed.add(rel)
    remap.set(e.id, rel)
  }

  if (remap.size === 0) {
    // Nothing resolved — return an equivalent NEW object (pure; no aliasing of input).
    return { ...construction }
  }

  const entities: ConstructedEntity[] = construction.entities.map((e) =>
    remap.has(e.id) ? { ...e, id: remap.get(e.id) as string } : e
  )
  const edges: ConstructedEdge[] = construction.edges.map((ed) => {
    const source = remap.get(ed.source) ?? ed.source
    const target = remap.get(ed.target) ?? ed.target
    return source === ed.source && target === ed.target ? ed : { ...ed, source, target }
  })

  void collisions // counted for future telemetry; not surfaced in the pure return shape

  return {
    ...construction,
    entities,
    edges
  }
}
