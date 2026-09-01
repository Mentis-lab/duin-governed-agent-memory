// Thin eval hook for the MODEL-FREE depth-adaptive multi-hop retriever
// (../graph-expand-retrieve.ts) — an ISOLATED arm the harness can score alongside the BM25 arm.
//
// It does NOT touch the default grounding route (server.ts) or the agentic retrieve-agent loop.
// Given a MultiHopInstance and its cached entity graph, it runs graphExpandRetrieve and reports the
// same supporting-fact recall@k the factorized bench uses — so a run can compare arms on ONE ruler.
//
// The gold ids are read HERE (the scorer's job) and passed only to the recall metric, never into
// the retriever, which sees just (query, notes, graph).

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { graphExpandRetrieve, type EntityGraph, type GraphExpandOpts } from '../graph-expand-retrieve'
import { bm25Rank, type WNNote } from '../wholenote-ground'
import { supportingFactRecallAtK } from './metrics'
import type { MultiHopInstance } from './fixtures'

/** Load a cached per-instance entity graph by id from a graphs dir. Returns null when absent. */
export function loadEntityGraph(graphsDir: string, id: string): EntityGraph | null {
  const path = join(graphsDir, `${id}.json`)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<EntityGraph>
    if (!Array.isArray(raw.nodes) || typeof raw.entityIndex !== 'object' || raw.entityIndex == null) return null
    return { nodes: raw.nodes, entityIndex: raw.entityIndex as Record<string, string[]> }
  } catch {
    return null
  }
}

/** The instance corpus as the retriever's note shape ({id,text}). */
export function instanceNotes(inst: MultiHopInstance): WNNote[] {
  return inst.corpus.map((c) => ({ id: c.file, text: c.text }))
}

export interface ArmScores {
  id: string
  hopsUsed: number
  ranked: string[]
  /** sp-recall@k for the graph-expand arm at k ∈ {gold.length, 5, 10}. */
  recall: { atGold: number; at5: number; at10: number }
  /** Same three recalls for the BM25-only arm — the baseline this arm must beat. */
  bm25Recall: { atGold: number; at5: number; at10: number }
}

/**
 * Run the graph-expand arm on one instance and score supporting-fact recall@k against gold, next to
 * the fixed BM25 baseline. `graph` is injected (loaded via loadEntityGraph) so the harness controls
 * where cached graphs live and the retriever stays I/O-free.
 */
export function runGraphExpandArm(
  inst: MultiHopInstance,
  graph: EntityGraph,
  opts: GraphExpandOpts = {}
): ArmScores {
  const notes = instanceNotes(inst)
  const { ranked, hopsUsed } = graphExpandRetrieve(inst.question, notes, graph, opts)
  const gold = inst.goldNotes
  const kGold = Math.max(1, gold.length)
  const bm25 = bm25Rank(inst.question, notes).map((r) => r.id)
  return {
    id: inst.id,
    hopsUsed,
    ranked,
    recall: {
      atGold: supportingFactRecallAtK(ranked, gold, kGold),
      at5: supportingFactRecallAtK(ranked, gold, 5),
      at10: supportingFactRecallAtK(ranked, gold, 10)
    },
    bm25Recall: {
      atGold: supportingFactRecallAtK(bm25, gold, kGold),
      at5: supportingFactRecallAtK(bm25, gold, 5),
      at10: supportingFactRecallAtK(bm25, gold, 10)
    }
  }
}
