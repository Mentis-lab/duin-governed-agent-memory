// NotesStore — the de-Obsidian Store. Runs the brain engines on the user's
// ACTUAL indexed notes folder (any markdown), with ZERO folder taxonomy or
// vault-path coupling: it wraps the existing notes→causal derivation
// (local-brain/graph-derive). This is the keystone of the fusion — the same
// engines (causal · prediction · world-state) that run on the bundled demo now
// run on a stranger's real notes, because they only ever touch the Store.
//
// Honest limits (by design, not omission): a plain notes folder has no dated
// commitments / decide-by gates, so the temporal layers (propagation lag,
// decision-window risks) stay quiet until a later phase derives dates/decisions
// from the notes (LLM extraction). The structural graph, drivers, lanes and
// per-track situation all light up immediately.

import type { Store } from './store'
import type { CausalNode, CausalEdge, CausalGraph, ExtractedData } from './types'
import { deriveGraph } from '../local-brain/graph-derive'
import { indexedCount } from '../local-brain/index-store'
import { applyExtraction } from './notes-extract'
import { applyConstruction, getConstruction } from './construct'

// Cached temporal enrichment from the last LLM extraction pass (key-gated;
// null = structural-only). Set by the reindex flow; read by every NotesStore.
let extractionCache: ExtractedData | null = null

export function setNotesExtraction(data: ExtractedData | null): void {
  extractionCache = data
}

export class NotesStore implements Store {
  // Derive (+ enrich) once per instance (a fresh instance per brain call), so
  // causalNodes() + causalEdges() within one call share a single graph.
  private cached: CausalGraph | null = null
  private graph(): CausalGraph {
    if (!this.cached) {
      let g = deriveGraph() as unknown as CausalGraph
      // "Build my brain" — merge the LLM-constructed entities + edges from raw
      // prose (key-gated; null = none) so the engines see the inferred field.
      const construction = getConstruction()
      if (construction) g = applyConstruction(g, construction)
      // Temporal enrichment (dates / decisions / risks) on top.
      if (extractionCache) g = applyExtraction(g, extractionCache)
      this.cached = g
    }
    return this.cached
  }
  causalNodes(): CausalNode[] {
    return this.graph().nodes.map((n) => ({ ...n }))
  }
  causalEdges(): CausalEdge[] {
    return this.graph().edges.map((e) => ({ ...e }))
  }
  today(): string {
    return new Date().toISOString().slice(0, 10)
  }
}

/** Whether the local brain has any notes indexed — decides demo vs real brain. */
export function hasIndexedNotes(): boolean {
  return indexedCount() > 0
}
