import type { Edge, Node } from '@xyflow/react'
import type { CanvasDoc, CanvasEdge, CanvasNode } from '../../electron/services/canvas/canvas-outline'

// JSON Canvas ⇄ xyflow. The editor works in xyflow's shape; the FILE stays
// JSON Canvas 1.0 so it remains readable by the outline serializer, the
// retriever, and any other JSON Canvas tool.
//
// ROUND-TRIP FIDELITY IS THE CONTRACT. A user who opens a canvas, drags one
// block and saves must not lose colours, subpaths, group labels, or anything
// else the file carried. Every canvas field therefore rides along on the flow
// node's `data` and is written back verbatim — the editor only ever
// authoritatively changes geometry, text, and the edge set.

export const BLOCK_NODE = 'canvasBlock'
export const GROUP_NODE = 'canvasGroup'

/** Everything from the source node that the editor does not own, carried
 *  through the round trip untouched. */
export interface FlowNodeData extends Record<string, unknown> {
  canvasType: string
  text?: string
  file?: string
  subpath?: string
  url?: string
  label?: string
  color?: string
}

const DEFAULT_W = 260
const DEFAULT_H = 120

export function toFlowNodes(doc: CanvasDoc): Node<FlowNodeData>[] {
  return doc.nodes.map((n) => ({
    id: n.id,
    type: n.type === 'group' ? GROUP_NODE : BLOCK_NODE,
    position: { x: n.x, y: n.y },
    // Groups sit behind blocks. xyflow paints by array order within a zIndex,
    // so this is what keeps a group from covering its own contents.
    zIndex: n.type === 'group' ? 0 : 1,
    style: { width: n.width || DEFAULT_W, height: n.height || DEFAULT_H },
    data: {
      canvasType: n.type,
      text: n.text,
      file: n.file,
      subpath: n.subpath,
      url: n.url,
      label: n.label,
      color: n.color
    }
  }))
}

export function toFlowEdges(doc: CanvasDoc): Edge[] {
  return doc.edges.map((e) => ({
    id: e.id,
    source: e.fromNode,
    target: e.toNode,
    label: e.label,
    // Labels are the blueprint's verbs ("blocks", "then") — worth seeing.
    labelStyle: { fill: '#b9b9d0', fontSize: 12 }
  }))
}

/** Read a node's on-screen size, preferring what xyflow measured after render
 *  over the style we seeded it with. */
function sizeOf(n: Node<FlowNodeData>): { width: number; height: number } {
  const measured = (n as unknown as { measured?: { width?: number; height?: number } }).measured
  const styleW = typeof n.style?.width === 'number' ? (n.style.width as number) : undefined
  const styleH = typeof n.style?.height === 'number' ? (n.style.height as number) : undefined
  return {
    width: Math.round(measured?.width ?? styleW ?? DEFAULT_W),
    height: Math.round(measured?.height ?? styleH ?? DEFAULT_H)
  }
}

export function fromFlow(nodes: Node<FlowNodeData>[], edges: Edge[]): CanvasDoc {
  const outNodes: CanvasNode[] = nodes.map((n) => {
    const { width, height } = sizeOf(n)
    const d = n.data
    const node: CanvasNode = {
      id: n.id,
      type: d.canvasType || (n.type === GROUP_NODE ? 'group' : 'text'),
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      width,
      height
    }
    // Only emit fields the node actually has — a JSON Canvas file littered with
    // `"url": undefined` round-trips badly through other editors.
    if (d.text !== undefined) node.text = d.text
    if (d.file !== undefined) node.file = d.file
    if (d.subpath !== undefined) node.subpath = d.subpath
    if (d.url !== undefined) node.url = d.url
    if (d.label !== undefined) node.label = d.label
    if (d.color !== undefined) node.color = d.color
    return node
  })

  const outEdges: CanvasEdge[] = edges.map((e) => {
    const edge: CanvasEdge = { id: e.id, fromNode: e.source, toNode: e.target }
    const label = typeof e.label === 'string' ? e.label : undefined
    if (label) edge.label = label
    return edge
  })

  return { nodes: outNodes, edges: outEdges }
}

/** Serialize for disk. Two-space JSON matches what Obsidian writes, so a file
 *  edited in either tool produces a small, readable diff rather than a
 *  whole-file rewrite. */
export function serializeCanvas(doc: CanvasDoc): string {
  return JSON.stringify({ nodes: doc.nodes, edges: doc.edges }, null, 2)
}

/** A fresh canvas with one block, so a new blueprint opens with something to
 *  type into rather than an empty void. */
export function blankCanvas(): CanvasDoc {
  return {
    nodes: [
      {
        id: newId('n'),
        type: 'text',
        x: 0,
        y: 0,
        width: DEFAULT_W,
        height: DEFAULT_H,
        text: 'New block'
      }
    ],
    edges: []
  }
}

let counter = 0
/** Ids only need to be unique within one file. A time+counter id keeps them
 *  short and readable in the JSON, unlike a UUID. */
export function newId(prefix: string): string {
  counter += 1
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`
}
