// reveal-reducer.ts — the pure, framework-agnostic core of the live-node-reveal renderer.
//
// The backend streams graph frames ({type:'graph', op, ...}); this reduces them into an animated graph
// state the canvas draws: nodes carry a bornAt (entrance animation), edges carry a trust STATE
// (proposed=dashed / endorsed=solid / vetoed=faded) + the governance accept annotation. It also applies
// the operator's optimistic endorse/veto locally (the backend /reveal/judge call persists it). This is
// the exact state model the proven harness (scratchpad/live-node-reveal.html) embodies, extracted so it
// is UNIT-TESTED and the React overlay is a thin canvas-render + fetch shell over it.
//
// Renderer-side types (structurally matching the backend frames, which arrive as JSON) so this module
// does not import main-process code across the electron-vite boundary.

export type EdgeSource = 'wiki' | 'alias' | 'sim' | 'llm'
export type AcceptDecision = 'auto' | 'review'
export type GraphFrameOp = 'node-created' | 'entity-found' | 'entity-merged' | 'link-formed' | 'reveal-complete'

export interface GraphFrame {
  type: 'graph'
  op: GraphFrameOp
  id?: string
  kind?: string
  label?: string
  from?: string
  to?: string
  edgeType?: string
  src?: EdgeSource
  accept?: AcceptDecision
  confidence?: number
  rawId?: string
  into?: string
  counts?: { entities: number; edges: number; merges: number }
}

export type EdgeState = 'proposed' | 'endorsed' | 'vetoed'

export interface RevealNode {
  id: string
  label: string
  kind: string
  /** the dropped node (the reveal's focal point) */
  focal: boolean
  /** ms clock stamped when it entered — drives the pop-in animation */
  bornAt: number
}

export interface RevealEdge {
  from: string
  to: string
  edgeType: string
  src: EdgeSource
  confidence?: number
  accept?: AcceptDecision
  /** trust state → dashed (proposed) / solid (endorsed) / faded (vetoed) */
  state: EdgeState
  bornAt: number
  /** ms clock when `state` last changed — drives the dashed→solid transition */
  stateAt: number
}

export interface RevealState {
  nodes: Map<string, RevealNode>
  edges: RevealEdge[]
  rootId: string | null
  complete: boolean
  counts: { entities: number; edges: number; merges: number } | null
}

export function initialRevealState(): RevealState {
  return { nodes: new Map(), edges: [], rootId: null, complete: false, counts: null }
}

export function edgeKey(from: string, to: string, edgeType: string): string {
  return from + '' + to + '' + edgeType
}

/** Ingest one backend graph frame, stamping bornAt=now for entrance animation. Returns a NEW state
 *  wrapper (inner Map/array mutated in place — the caller re-renders on the new reference, the same
 *  pattern react-force-graph uses for incremental adds). Pure of clocks (now injected). */
export function reduceFrame(state: RevealState, frame: GraphFrame, now: number): RevealState {
  switch (frame.op) {
    case 'node-created':
      if (frame.id) {
        state.nodes.set(frame.id, { id: frame.id, label: frame.label || frame.id, kind: frame.kind || 'note', focal: true, bornAt: now })
        state.rootId = frame.id
      }
      break
    case 'entity-found':
      if (frame.id && !state.nodes.has(frame.id)) {
        state.nodes.set(frame.id, { id: frame.id, label: frame.label || frame.id, kind: frame.kind || 'topic', focal: false, bornAt: now })
      }
      break
    case 'entity-merged':
      // a duplicate fused onto `into` — drop the raw node and rewire its edges to the canonical id
      if (frame.rawId && frame.into) {
        state.nodes.delete(frame.rawId)
        for (const e of state.edges) {
          if (e.from === frame.rawId) e.from = frame.into
          if (e.to === frame.rawId) e.to = frame.into
        }
      }
      break
    case 'link-formed':
      if (frame.from && frame.to) {
        const k = edgeKey(frame.from, frame.to, frame.edgeType || '')
        if (!state.edges.some((e) => edgeKey(e.from, e.to, e.edgeType) === k)) {
          state.edges.push({
            from: frame.from,
            to: frame.to,
            edgeType: frame.edgeType || 'mentions',
            src: frame.src || 'llm',
            confidence: frame.confidence,
            accept: frame.accept,
            state: 'proposed',
            bornAt: now,
            stateAt: now
          })
        }
      }
      break
    case 'reveal-complete':
      state.complete = true
      state.counts = frame.counts || null
      break
  }
  return { ...state }
}

/** Local optimistic verdict on an edge (operator endorse/veto). The backend /reveal/judge call
 *  persists it; this flips the visual immediately (proposed→endorsed solid / →vetoed faded). */
export function applyEdgeVerdict(
  state: RevealState,
  from: string,
  to: string,
  edgeType: string,
  verdict: EdgeState,
  now: number
): RevealState {
  const k = edgeKey(from, to, edgeType)
  for (const e of state.edges) {
    if (edgeKey(e.from, e.to, e.edgeType) === k) {
      e.state = verdict
      e.stateAt = now
    }
  }
  return { ...state }
}

/** The proposed edges incident to a node — the ones that get ✓/✕ handles when it's hovered. */
export function pendingEdgesFor(state: RevealState, nodeId: string): RevealEdge[] {
  return state.edges.filter((e) => e.state === 'proposed' && (e.from === nodeId || e.to === nodeId))
}
