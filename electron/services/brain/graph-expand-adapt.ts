// Adapter: DUIN's live brain graph (retrieve-agent's GraphView — deriveGraph() ⨝ getConstruction())
// → the entity co-mention EntityGraph the MODEL-FREE graphExpandRetrieve consumes.
//
// WHY an adapter and not a direct reuse: the two shapes do NOT align. GraphView is a typed
// NODE/EDGE graph (entity + note nodes; owns/depends/blocks/… edges), while EntityGraph is a
// co-mention INDEX (per-note entity lists + entity→[noteIds]). The retriever hops seed-note → its
// entities → entityIndex → co-mentioning notes, so it needs entities that span MULTIPLE notes to
// form note↔note bridges. DUIN's construction dedups each entity to ONE source note, so the entity
// membership that makes bridges comes from the graph EDGES: an entity linked (by an owns/blocks/…
// edge) to a second note is "co-mentioned" by both — exactly the multi-hop bridge the retriever
// was validated to recover. This is a PURE transformation of the existing graph: it reads structure
// only (node.note provenance + edges), never re-parses note text and never embeds anything.
//
// Deterministic: sorted entity lists + sorted note memberships → same (graph, noteIds) → same output.

import { graphExpandRetrieve, type EntityGraph, type GraphExpandOpts } from './graph-expand-retrieve'
import { assembleWholeNoteContext, type WNNote, type WholeNoteContext } from './wholenote-ground'
import type { GraphView } from './retrieve-agent'

/** Normalize an entity/token to the entityIndex key convention — IDENTICAL to graphExpandRetrieve's
 *  internal normEntity (lowercase, whitespace-collapsed, trimmed). Tokens are stored pre-normalized
 *  so `entityIndex[key]` matches `normEntity(node.entity)` at lookup time (normEntity is idempotent). */
function norm(s: string): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Map a GraphView → EntityGraph over the given note-id corpus (the notes the retriever ranks).
 *
 * - A node whose id is a corpus note id is a NOTE (anchors to itself); every other node is an ENTITY
 *   whose source note is `node.note` (when that note is in the corpus).
 * - Each entity contributes its own source note under its normalized-label token.
 * - Each EDGE propagates membership so an entity that links two notes bridges them: an entity
 *   endpoint's token gains the note on the OTHER end of the edge (entity↔note and entity↔entity).
 *   A direct note↔note structural edge (no entity between) synthesizes a stable `__link__` bridge
 *   token so wikilink/structural connectivity isn't lost.
 *
 * Only corpus notes survive into the index (a stale graph may reference dropped notes). PURE.
 */
export function adaptGraphViewToEntityGraph(graph: GraphView, noteIds: string[]): EntityGraph {
  const noteSet = new Set(noteIds)

  // Resolve each node → its note anchor (the corpus note it represents / was found in), and whether
  // it is an entity (vs a corpus-note node).
  const anchorOf = new Map<string, string | undefined>()
  const isEntity = new Map<string, boolean>()
  const labelOf = new Map<string, string>()
  for (const n of graph.nodes) {
    labelOf.set(n.id, n.label ?? n.id)
    if (noteSet.has(n.id)) {
      anchorOf.set(n.id, n.id)
      isEntity.set(n.id, false)
    } else {
      anchorOf.set(n.id, n.note && noteSet.has(n.note) ? n.note : undefined)
      isEntity.set(n.id, true)
    }
  }

  // token → set of member note ids.
  const members = new Map<string, Set<string>>()
  const add = (token: string, note: string | undefined): void => {
    if (!note) return
    const s = members.get(token)
    if (s) s.add(note)
    else members.set(token, new Set([note]))
  }

  // 1) Each entity contributes its own source note under its label token.
  for (const n of graph.nodes) {
    if (isEntity.get(n.id)) add(norm(labelOf.get(n.id)!), anchorOf.get(n.id))
  }

  // 2) Edges propagate cross-note membership (the bridge signal).
  for (const e of graph.edges) {
    const uNote = anchorOf.get(e.source)
    const vNote = anchorOf.get(e.target)
    const uEnt = isEntity.get(e.source)
    const vEnt = isEntity.get(e.target)
    if (uEnt) {
      const t = norm(labelOf.get(e.source)!)
      add(t, uNote)
      add(t, vNote)
    }
    if (vEnt) {
      const t = norm(labelOf.get(e.target)!)
      add(t, vNote)
      add(t, uNote)
    }
    // Direct note↔note structural link (both endpoints are corpus notes): synthesize a bridge token.
    if (!uEnt && !vEnt && uNote && vNote && uNote !== vNote) {
      const [a, b] = uNote < vNote ? [uNote, vNote] : [vNote, uNote]
      const t = norm(`__link__:${a}|${b}`)
      add(t, a)
      add(t, b)
    }
  }

  // Build entityIndex (corpus notes only, sorted for determinism) and the per-note entity lists.
  const entityIndex: Record<string, string[]> = {}
  for (const [token, set] of members) {
    const ids = [...set].filter((id) => noteSet.has(id)).sort()
    if (ids.length) entityIndex[token] = ids
  }
  const byNote = new Map<string, Set<string>>()
  for (const [token, ids] of Object.entries(entityIndex)) {
    for (const id of ids) {
      const s = byNote.get(id)
      if (s) s.add(token)
      else byNote.set(id, new Set([token]))
    }
  }
  const nodes = noteIds.map((id) => ({ note: id, entities: [...(byNote.get(id) ?? [])].sort() }))
  return { nodes, entityIndex }
}

/** Whether the graph-expansion grounding branch is enabled. DEFAULT **OFF** (opt-IN): set
 *  `DUIN_GRAPH_EXPAND_GROUND=1` to enable; unset / any other value → OFF.
 *
 *  WHY the default was flipped back (2026-07-25, measured — do NOT re-flip without new numbers):
 *  P1 shipped this default-ON on a "+8pp recall@gold on multi-hop" claim that does NOT reproduce on
 *  a real vault. An offline evaluation over the operator's index (25 probes, 12,793 chunks, 100%
 *  vector coverage, exact brute-force KNN, verbatim ports of the production scoring functions)
 *  measured, against the RRF 2:1 fusion this branch REPLACES:
 *
 *      arm                  recall@5    MRR
 *      RRF 2:1 (fusion)      0.408     0.636
 *      graph-expand          0.318     0.533     →  −9.0pp recall@5, −10.3pp MRR
 *
 *  The multi-hop justification also fails: at k=5 it is an exact TIE with BM25 (0.450 vs 0.450), and
 *  at the production window `DUIN_WHOLENOTE_TOPK=12` it is −28.4pp (0.483 vs 0.767). Measured twice —
 *  once on wikilink structure only, once against the fully-populated 987-entity construction — and
 *  every recall slice was byte-identical, with multi-hop MRR getting WORSE with the real graph
 *  (0.555 → 0.385). Root causes: `beta=1.2 > alpha=1.0` promotes weakly-activated reached notes over
 *  genuine BM25 hits, and the hub brake computes hubDfCap = max(4, ⌊1130·0.4⌋) = 452 on this vault,
 *  pruning essentially nothing. Both constants were tuned on 10–20-note corpora (see
 *  graph-expand-retrieve.ts).
 *
 *  COST OF LEAVING IT ON, beyond the fusion loss: when this branch yields context it sets
 *  `contextOverride`, and FOUR downstream ranking stages in server.ts are gated on `!contextOverride`
 *  and are therefore skipped entirely — the 1-hop graph-neighbour merge, the cross-encoder rerank,
 *  taste-rerank, and claim-freshness demotion. Default-OFF restores all four on the default path.
 *
 *  The feature itself is unchanged and fully functional when explicitly enabled. When ON it still
 *  takes PRECEDENCE over the BM25 whole-note branch, with whole-note as the fallback and the agentic
 *  retriever as the final fallback. */
export function graphExpandGroundEnabled(): boolean {
  return process.env.DUIN_GRAPH_EXPAND_GROUND === '1'
}

/**
 * End-to-end graph-expansion grounding: adapt the live graph → run the model-free multi-hop
 * retriever (frontier/density cap ON by default) → assemble the whole-note context block from the
 * ranked ids, REUSING wholenote-ground's assembly (stripFrontmatter / windowAroundMatch / budgeted
 * concatenation) so the context format is identical to the BM25 whole-note branch. PURE given
 * (query, notes, graphView). The retriever sees only (query, notes, graph) — never gold ids/answers.
 */
export function buildGraphExpandContext(
  query: string,
  notes: WNNote[],
  graphView: GraphView,
  opts: { topK?: number; perNoteBudget?: number; charBudget?: number; expand?: GraphExpandOpts } = {}
): WholeNoteContext & { hopsUsed: number } {
  const graph = adaptGraphViewToEntityGraph(graphView, notes.map((n) => n.id))
  const { ranked, hopsUsed } = graphExpandRetrieve(query, notes, graph, opts.expand ?? {})
  const asm = assembleWholeNoteContext(ranked, notes, query, {
    topK: opts.topK,
    perNoteBudget: opts.perNoteBudget,
    charBudget: opts.charBudget
  })
  return { ...asm, hopsUsed }
}
