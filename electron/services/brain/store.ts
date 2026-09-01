// Brain Store — the decoupling seam.
//
// Every engine reads its inputs through a Store, never from a folder path. This
// is the mechanism that lets DUIN's intelligence run for a stranger: today a
// `DemoStore` (bundled fixture) backs it; later a notes-derived store and then
// a SQLite-backed store drop in behind the SAME interface, with engines
// unchanged. Inferred (engine-generated) vs declared (user-confirmed) state is
// distinguished here so the inferred scratchpad stays disposable.
//
// Phase A only needs the causal slice; the interface is intentionally small and
// grows as the other engines land. The contract — not the source — is what the
// engines bind to.

import type { CausalNode, CausalEdge } from './types'

// The concrete Stores (DemoStore/SeedStore/NotesStore-as-active) were retired in the two-brain fuse —
// the brain reads the fs-native Stack-B substrate now. This interface stays as the decoupling seam:
// causal-engine + the RAG layer + test fixtures still bind to it (a fixture object, not a class).
export interface Store {
  /** Causal-field nodes (streams, gates, drivers, anchors, risks, …). */
  causalNodes(): CausalNode[]
  /** Directed, lag-carrying causal edges between those nodes. */
  causalEdges(): CausalEdge[]
  /** ISO date treated as "now". */
  today(): string
}
