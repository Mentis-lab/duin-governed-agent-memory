// Canonical DUIN-native id normalization — Phase 0 of the store consolidation.
// See PLANNING/DUIN_STORE_CONSOLIDATION_BUILD_PLAN.md.
//
// TWO id surfaces (this resolves the B2 store-parity-vs-retrieval-collision split):
//  - STORE surface (`/state/store-graph`, the home-MAP `buildBrainGraph`): keeps
//    the BARE product-store ids for byte-parity. Do NOT normalize those.
//  - RETRIEVAL surface (`liveGraph`'s shared `byId` merge): calls
//    `normalizeStoreId` so a product-store node lands in the DUIN-native canonical
//    id space and MERGES with the note/entity graph instead of forming a
//    disconnected island. Kind-prefixing lives here (not in the store graph),
//    because bare 8-hex move/insight ids collide cross-kind only when they enter a
//    shared map.

import { readFileSync } from 'fs'
import { migrateId } from './construct-kind-migration'
import { join } from 'path'

// Bare cascade kinds whose raw ids collide cross-kind (8-hex hashes, short slugs,
// `R##`/`P#`) and so MUST be kind-prefixed before entering a shared `byId` map.
const CASCADE_KINDS = new Set([
  'track',
  'move',
  'insight',
  'risk',
  'issue',
  'action',
  'milestone',
  'event',
  'release'
])

// Hand-audited (2026-07-16) bare-store-project-name -> construction `project:<slug>`
// aliases. Only UNAMBIGUOUS exact-label matches against the live construction cache
// are listed — an unaudited alias silently over-merges a folder onto the wrong
// project. Unmapped store projects normalize to `folder:<name>` and island cleanly.
//
// COLD-START A3 (2026-07-25): the shipped default is EMPTY.
//
// This mapped the AUTHOR's store folder names onto their construction canonical ids. Like the
// alias whitelist it is a per-operator fact, not a product fact, so it now ships empty and is
// supplied per vault (`.duin/_state/store-project-alias.json`, see loadStoreProjectAlias). An
// unmapped store project normalizes to `folder:<name>` and islands cleanly — the safe fallback
// this table already documented.
export const STORE_PROJECT_ALIAS: Record<string, string> = {}

/** The vault's bare-store-project → construction-id aliases. Best-effort: a missing or malformed
 *  file yields the empty built-in, i.e. every store project islands as `folder:<name>`. Callers
 *  that hold a vault dir pass the result into `normalizeStoreId`. */
export function loadStoreProjectAlias(vaultDir: string | null | undefined): Record<string, string> {
  if (!vaultDir) return STORE_PROJECT_ALIAS
  try {
    const raw = JSON.parse(
      readFileSync(join(vaultDir, '.duin', '_state', 'store-project-alias.json'), 'utf-8')
    ) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return STORE_PROJECT_ALIAS
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      // Migrate a retired entity kind in the TARGET id. This table is hand-maintained per vault
      // and its values are construction ids, so a kind retirement silently points every affected
      // entry at a node that no longer exists — and the fold then declines with no signal, because
      // brain-graph-native gates it on `constructionIds.has(canon)`. Migrating on read keeps the
      // operator's file valid without asking them to edit it. See construct-kind-migration.ts.
      if (typeof v === 'string' && v) out[k] = migrateId(v)
    }
    return out
  } catch {
    return STORE_PROJECT_ALIAS
  }
}

/**
 * Map a PRODUCT-STORE node id (with its store `kind`) into the DUIN-native
 * canonical id space used by the retrieval graph's shared `byId` map. Pure.
 *
 * Rules:
 *  - `vault:/<rel>.md` (person/org)         -> `<rel>.md`  (merge onto the note node)
 *  - already-namespaced (`goal:x`, `project:x`, any `ns:...`) -> identity
 *  - bare `project` name                    -> alias `project:<slug>` if audited,
 *                                              else `folder:<name>` (islands cleanly)
 *  - bare `card` id (`C260618-...`)          -> identity (globally-unique prefix)
 *  - bare cascade (track/move/insight/risk/issue/action/milestone/event/release)
 *                                            -> `<kind>:<id>` (prevents cross-kind over-merge)
 *  - anything else                          -> identity
 *
 * Returns '' for an empty/whitespace id (caller should skip).
 */
export function normalizeStoreId(
  rawId: string,
  kind: string,
  projectAlias: Record<string, string> = STORE_PROJECT_ALIAS
): string {
  const id = String(rawId ?? '').trim()
  if (!id) return ''
  // person/org: the same note as the retrieval graph, prefixed by the entities
  // producer. Strip to the bare relpath so it collides-and-merges. Byte-safe on
  // CJK ids (verified 65/65 filesystem-resolve on the live vault).
  if (id.startsWith('vault:/')) return id.slice('vault:/'.length)
  // Already in a native namespace (`goal:`, construction `kind:slug`, or a
  // previously-normalized id). Note relpaths never contain ':' on Windows.
  if (id.includes(':')) return id
  if (kind === 'project') return projectAlias[id] ?? `folder:${id}`
  if (kind === 'card') return id
  if (CASCADE_KINDS.has(kind)) return `${kind}:${id}`
  return id
}

/**
 * Normalize a store EDGE endpoint using a precomputed rawId -> normalizedId map
 * (built while normalizing nodes, so endpoint kind never has to be re-inferred).
 * An endpoint absent from the map is a dangling reference -> returns '' so the
 * caller drops the edge.
 */
export function normalizeEdgeEndpoint(rawEndpoint: string, nodeIdMap: Map<string, string>): string {
  return nodeIdMap.get(String(rawEndpoint ?? '')) ?? ''
}
