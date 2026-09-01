// reveal-persist — run a governed reveal AUTOMATICALLY on the capture/ingest birth and PERSIST the
// auto-accepted edges into the durable entity graph, instead of streaming frames to a manual overlay.
//
// The "Reveal" surface used to be a place the operator visited: drop a thought, watch the brain connect
// it, then endorse/veto each proposed link. That manual surface is gone. reveal-service already carried
// the governance (shouldAutoAccept marks each edge 'auto' vs 'review'); this module supplies the missing
// half its own header named ("invoked where the capture/ingest birth happens"): a persistence SINK that
// applies only the auto-accepted edges to entity-graph-store (upsertNode/upsertEdge) and drops the rest.
// There is NO human queue — a 'review' edge is simply not applied (the operator's calibration TRUST is
// what decides auto vs review, and that is tuned by the same edge-judgment path as before).
//
// Conservative by construction:
//   - only 'link-formed' frames with accept === 'auto' become edges; 'review'/incomplete are skipped;
//   - 'entity-merged' frames are NEVER auto-applied — merging identities is entity-resolver's sole
//     authority (entity-graph-store's own contract), so an auto-reveal only ADDS nodes/edges;
//   - every write is best-effort (entity-graph-store is fail-open) and the whole pass never throws.
//
// Gated by DUIN_AUTO_REVEAL (default ON — set '0'/'false'/'off' to disable) AND by
// DUIN_ENTITY_GRAPH, the same flag its readers use.
//
// The second gate closes an asymmetry the 2026-07-25 evaluation caught: every READER of the
// persisted entity graph (write-time relink, the retirement cascade, the sync pass in
// entity-graph-relink) is gated behind DUIN_ENTITY_GRAPH, while this WRITER was gated only behind
// DUIN_AUTO_REVEAL. On any install that hasn't set the flag — the default — each capture therefore
// spent a full governed reveal pass, model calls included, filling a store nothing would ever read.
// Matching the gates makes the flag mean one coherent thing: off is the feature off end to end; on
// is writes plus the relink and retirement passes that consume them.
//
// This is the write-gating branch of that finding. The other branch — giving the accumulated graph a
// read-back surface outside the relink cascade (grounding, or the brain-graph UI) — is a capability
// change with retrieval and UI quality at stake, and this repo's own convention is that such a path
// ships flag-gated until it is measured better. NOTE the cautionary case: graph-expand grounding was
// defaulted ON on a "+8pp" bench that did not reproduce, and was reverted to opt-in on 2026-07-25
// after measuring −9.0pp recall@5 on the real vault — flag-gate AND measure at real corpus size.
// This is deliberately NOT bundled into a wiring fix.

import { revealForSource, type RevealServiceOptions } from './reveal-service'
import { entityGraphEnabled } from './entity-graph-relink'
import type { GraphFrame } from './reveal-frames'
import type { ScopedSource } from './construct-one-source'
import { upsertNode, upsertEdge, type EntityNode } from './entity-graph-store'

/** The persistence action a single reveal frame maps to (PURE — no DB, unit-testable). `null` = the
 *  frame carries nothing to durably apply (a 'review' edge, a merge, reveal-complete, or an incomplete
 *  frame). */
export type PersistAction =
  | { kind: 'node'; node: EntityNode }
  | { kind: 'edge'; edge: { src: string; dst: string; type: string } }
  | null

export function revealFrameAction(f: GraphFrame): PersistAction {
  if (f.op === 'node-created' || f.op === 'entity-found') {
    if (!f.id) return null
    return { kind: 'node', node: { id: f.id, kind: f.kind ?? 'note', label: f.label ?? f.id } }
  }
  if (f.op === 'link-formed') {
    // ONLY auto-accepted, fully-specified edges are applied. 'review' (or any non-auto) is dropped —
    // there is no human queue; the calibration TRUST that produced 'review' is the gate.
    if (f.accept === 'auto' && f.from && f.to && f.edgeType) {
      return { kind: 'edge', edge: { src: f.from, dst: f.to, type: f.edgeType } }
    }
  }
  // entity-merged / reveal-complete / non-auto link → not durably applied here.
  return null
}

/** True unless DUIN_AUTO_REVEAL is explicitly disabled. Default ON (the feature replaces a surface the
 *  operator used to have to open, so it must run without configuration). */
export function autoRevealEnabled(): boolean {
  const v = (process.env.DUIN_AUTO_REVEAL ?? '').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}

export interface AutoRevealResult {
  ran: boolean
  nodes: number
  edges: number
  skipped: number
  status: string
}

/** Run a governed reveal for one dropped source and persist its auto-accepted graph. Best-effort +
 *  never throws; safe to call fire-and-forget from a capture/ingest handler. */
export async function autoRevealPersist(
  vault: string,
  source: ScopedSource,
  opts: Partial<Pick<RevealServiceOptions, 'chat' | 'model' | 'rootLabel' | 'rootKind' | 'existingEntities'>> = {}
): Promise<AutoRevealResult> {
  if (!autoRevealEnabled()) return { ran: false, nodes: 0, edges: 0, skipped: 0, status: 'disabled' }
  // Refuse BEFORE revealForSource, not just before the writes: the expensive part of a reveal pass
  // is the model calls it makes, and there is nothing to spend them on when no reader is armed.
  if (!entityGraphEnabled())
    return { ran: false, nodes: 0, edges: 0, skipped: 0, status: 'entity-graph-disabled' }
  if (!vault || !source?.text?.trim()) return { ran: false, nodes: 0, edges: 0, skipped: 0, status: 'empty' }

  let nodes = 0
  let edges = 0
  let skipped = 0
  const now = new Date().toISOString()
  const emit = (f: GraphFrame): void => {
    try {
      const action = revealFrameAction(f)
      if (!action) {
        if (f.op === 'link-formed') skipped++ // a proposed link we declined to auto-apply
        return
      }
      if (action.kind === 'node') {
        upsertNode(action.node, now, 'operator')
        nodes++
      } else {
        upsertEdge(action.edge.src, action.edge.dst, action.edge.type, now)
        edges++
      }
    } catch {
      /* best-effort per frame — a single bad frame never aborts the pass */
    }
  }

  try {
    const result = await revealForSource(vault, source, { emit, ...opts })
    return { ran: true, nodes, edges, skipped, status: result.status }
  } catch {
    return { ran: true, nodes, edges, skipped, status: 'error' }
  }
}
