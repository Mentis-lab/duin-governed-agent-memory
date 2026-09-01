// reveal-frames.ts — the graph-frame contract for "live node reveal" + the two-wave orchestrator.
//
// A reveal streams granular graph mutations to the renderer over the EXISTING /agui SSE, as
// { type:'graph', op, ... } frames (the frame schema is open — sseFrame JSON.stringifies any object —
// so no server-schema change is needed). This module is the PURE frame-builder + a thin async
// orchestrator that runs constructOneSource and emits frames via an INJECTED sink, so it is
// unit-tested without a server or a key. See PLANNING/DUIN_LIVE_NODE_REVEAL_DESIGN.md.
//
// Two waves: the focal node is emitted immediately; deterministic Wave-1 frames (wiki/alias/similarity,
// supplied by the caller) go out next; then the LLM extraction (Wave 2) streams entities/merges/edges.

import type { ConstructedData } from './types'
import { constructOneSource, type ScopedSource, type ExtractionChat, type RevealMerge } from './construct-one-source'
import { applyEdgeVerdicts, type EdgeVerdict } from './edge-verdicts'
import type { AliasOverlay } from './operator-alias-overlay'
import type { AcceptDecision } from './reveal-governance'

export type GraphFrameOp = 'node-created' | 'entity-found' | 'entity-merged' | 'link-formed' | 'reveal-complete'
/** Where a proposed edge came from — drives the two-wave ordering AND the per-source calibration key. */
export type EdgeSource = 'wiki' | 'alias' | 'sim' | 'llm'

export interface GraphFrame {
  type: 'graph'
  op: GraphFrameOp
  // node-created (the dropped source) / entity-found (an extracted entity)
  id?: string
  kind?: string
  label?: string
  // link-formed
  from?: string
  to?: string
  edgeType?: string
  src?: EdgeSource
  /** governance verdict: 'auto' = auto-accepted (calibrated+trusted+confident), 'review' = dashed pending */
  accept?: AcceptDecision
  /** the confidence the edge was proposed at (drives accept + the calibration sample) */
  confidence?: number
  // entity-merged (a duplicate fused onto an existing canonical node)
  rawId?: string
  into?: string
  // reveal-complete
  counts?: { entities: number; edges: number; merges: number }
}

export interface RevealRoot {
  id: string
  label: string
  kind?: string
}

/** PURE: the full ordered frame list for a resolved construction — focal node, merges, entities,
 *  typed edges (all `src:'llm'`, since these come from the extraction pass), then reveal-complete.
 *  Used for tests and for the "replay how this connected" surface; runReveal() streams live instead. */
export function buildRevealFrames(root: RevealRoot, data: ConstructedData, merges: RevealMerge[] = []): GraphFrame[] {
  const frames: GraphFrame[] = [{ type: 'graph', op: 'node-created', id: root.id, label: root.label, kind: root.kind ?? 'note' }]
  for (const m of merges) frames.push({ type: 'graph', op: 'entity-merged', rawId: m.rawId, into: m.into })
  for (const e of data.entities) frames.push({ type: 'graph', op: 'entity-found', id: e.id, kind: e.kind, label: e.label })
  for (const e of data.edges) frames.push({ type: 'graph', op: 'link-formed', from: e.source, to: e.target, edgeType: e.type, src: 'llm' })
  frames.push({ type: 'graph', op: 'reveal-complete', counts: { entities: data.entities.length, edges: data.edges.length, merges: merges.length } })
  return frames
}

export interface RunRevealOptions {
  /** the sink — real impl calls sseFrame(res, frame); tests capture frames */
  emit: (frame: GraphFrame) => void
  chat?: ExtractionChat
  model?: string | null
  resolve?: boolean
  rootKind?: string
  rootLabel?: string
  /** deterministic Wave-1 frames (wiki/alias/similarity), emitted right after the focal node and
   *  before the LLM extraction wave. Injected by the caller (the cheap deterministic pass is upstream). */
  wave1?: GraphFrame[]
  /** operator edge verdicts (loadEdgeVerdicts(vault)) — a previously-vetoed edge is NOT re-proposed. */
  edgeVerdicts?: Map<string, EdgeVerdict>
  /** operator-confirmed merges (loadAliasOverlay(vault)) — folded into the scoped extraction's resolution */
  aliasOverlay?: AliasOverlay
  /** per-edge governance annotation (accept + confidence), applied to each link-formed frame */
  annotateEdge?: (from: string, to: string, edgeType: string, src: EdgeSource) => { accept?: AcceptDecision; confidence?: number }
}

export interface RunRevealResult {
  status: 'built' | 'no-model' | 'model-error'
  emitted: number
}

/**
 * Orchestrate a live reveal for one dropped source: emit the focal node IMMEDIATELY (before the LLM
 * await, so the UI pops it at once), then deterministic Wave-1 frames, then run the scoped extraction
 * (Wave 2) and stream its merges/entities/edges, then reveal-complete. Emits via the injected sink;
 * never throws (a failed extraction still closes the reveal so the focal node + Wave-1 stand).
 */
export async function runReveal(source: ScopedSource, opts: RunRevealOptions): Promise<RunRevealResult> {
  let emitted = 0
  const emit = (f: GraphFrame): void => {
    emitted++
    opts.emit(f)
  }
  const rootKind = opts.rootKind ?? 'note'
  emit({ type: 'graph', op: 'node-created', id: source.id, label: opts.rootLabel ?? source.id, kind: rootKind })
  for (const f of opts.wave1 ?? []) emit(f)

  const r = await constructOneSource(source, { chat: opts.chat, model: opts.model, resolve: opts.resolve, aliasOverlay: opts.aliasOverlay })
  if (r.status !== 'built' || !r.data) {
    emit({ type: 'graph', op: 'reveal-complete', counts: { entities: 0, edges: 0, merges: 0 } })
    return { status: r.status, emitted }
  }
  // Suppress edges the operator already vetoed so a re-drop / replay doesn't re-propose them.
  const edges = opts.edgeVerdicts ? applyEdgeVerdicts(r.data.edges, opts.edgeVerdicts) : r.data.edges
  for (const m of r.merges ?? []) emit({ type: 'graph', op: 'entity-merged', rawId: m.rawId, into: m.into })
  for (const e of r.data.entities) emit({ type: 'graph', op: 'entity-found', id: e.id, kind: e.kind, label: e.label })
  for (const e of edges) {
    const ann = opts.annotateEdge?.(e.source, e.target, e.type, 'llm') ?? {}
    emit({ type: 'graph', op: 'link-formed', from: e.source, to: e.target, edgeType: e.type, src: 'llm', accept: ann.accept, confidence: ann.confidence })
  }
  emit({
    type: 'graph',
    op: 'reveal-complete',
    counts: { entities: r.data.entities.length, edges: edges.length, merges: (r.merges ?? []).length }
  })
  return { status: 'built', emitted }
}
