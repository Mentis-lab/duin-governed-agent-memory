// Track 0 — the single unified graph builder: the file-level structural graph
// (deriveGraph) MERGED with the cached LLM "construction" (entities/edges/
// classifications) via applyConstruction, so every reader (provenance, community,
// insight, brain-graph route) sees ONE world graph instead of bare deriveGraph().

import { deriveGraph } from '../local-brain/graph-derive'
import { getResolvedConstruction, applyConstruction } from './construct'
import type { CausalGraph } from './types'

/**
 * The structural graph from the indexed notes, MERGED with the cached "Build my
 * brain" construction (LLM-inferred entities + edges + note classifications)
 * when one exists for the current notes dir. Union/dedup is handled by
 * applyConstruction; absent a construction this is just deriveGraph().
 *
 * Identity-spine P6: reads getResolvedConstruction() (not raw getConstruction()) so the four
 * surfaces this feeds — /graph, brain:graphCommunities, buildGraphReport, buildGraphSnapshot —
 * see the SAME canonical, alias-collapsed ids as the MAP and retrieval. Before P6 this caller
 * fed RAW construction, so those surfaces carried fragment ids (`project:projecta`) while the
 * MAP showed canonical (`project:ProjectA`) — the community-color lens keyed on the mismatch.
 * getResolvedConstruction() is a byte-identical passthrough under the DUIN_ENTITY_RESOLVER=0
 * kill-switch, so the disabled path is unchanged.
 */
export function mergedGraph(): CausalGraph {
  const base = deriveGraph() as unknown as CausalGraph
  const construction = getResolvedConstruction()
  return construction ? applyConstruction(base, construction) : base
}
