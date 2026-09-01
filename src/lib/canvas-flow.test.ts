import { describe, expect, it } from 'vitest'
import { parseCanvas } from '../../electron/services/canvas/canvas-outline'
import {
  BLOCK_NODE,
  GROUP_NODE,
  blankCanvas,
  fromFlow,
  newId,
  serializeCanvas,
  toFlowEdges,
  toFlowNodes
} from './canvas-flow'

const doc = (o: unknown) => parseCanvas(JSON.stringify(o))

const FULL = {
  nodes: [
    { id: 'g', type: 'group', x: -20, y: -20, width: 600, height: 400, label: 'Phase 1', color: '5' },
    { id: 'a', type: 'text', x: 0, y: 0, width: 240, height: 90, text: 'Draft', color: '4' },
    { id: 'b', type: 'file', x: 300, y: 0, width: 220, height: 90, file: 'notes/x.md', subpath: '#Decision' },
    { id: 'c', type: 'link', x: 0, y: 200, width: 200, height: 80, url: 'duin://skill/meeting-note' }
  ],
  edges: [
    { id: 'e1', fromNode: 'a', toNode: 'b', label: 'grounds' },
    { id: 'e2', fromNode: 'c', toNode: 'a' }
  ]
}

describe('toFlow', () => {
  it('maps groups and blocks to distinct node types', () => {
    const nodes = toFlowNodes(doc(FULL))
    expect(nodes.find((n) => n.id === 'g')?.type).toBe(GROUP_NODE)
    expect(nodes.find((n) => n.id === 'a')?.type).toBe(BLOCK_NODE)
  })

  it('puts groups behind blocks so a group cannot cover its own contents', () => {
    const nodes = toFlowNodes(doc(FULL))
    expect(nodes.find((n) => n.id === 'g')?.zIndex).toBeLessThan(
      nodes.find((n) => n.id === 'a')?.zIndex as number
    )
  })

  it('carries every canvas-only field through on data', () => {
    const nodes = toFlowNodes(doc(FULL))
    const b = nodes.find((n) => n.id === 'b')
    expect(b?.data).toMatchObject({ canvasType: 'file', file: 'notes/x.md', subpath: '#Decision' })
    const c = nodes.find((n) => n.id === 'c')
    expect(c?.data).toMatchObject({ canvasType: 'link', url: 'duin://skill/meeting-note' })
  })

  it('maps edges with labels', () => {
    const edges = toFlowEdges(doc(FULL))
    expect(edges[0]).toMatchObject({ id: 'e1', source: 'a', target: 'b', label: 'grounds' })
    expect(edges[1].label).toBeUndefined()
  })
})

describe('round trip', () => {
  it('preserves every field through load → edit → save', () => {
    const original = doc(FULL)
    const back = fromFlow(toFlowNodes(original), toFlowEdges(original))
    expect(back).toEqual(original)
  })

  it('writes a moved block back at its new position', () => {
    const original = doc(FULL)
    const nodes = toFlowNodes(original)
    const moved = nodes.map((n) => (n.id === 'a' ? { ...n, position: { x: 999, y: 555 } } : n))
    const back = fromFlow(moved, toFlowEdges(original))
    expect(back.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 999, y: 555 })
    // and nothing else moved
    expect(back.nodes.find((n) => n.id === 'b')).toMatchObject({ x: 300, y: 0 })
  })

  it('prefers the measured size over the seeded style once xyflow has laid out', () => {
    const original = doc(FULL)
    const nodes = toFlowNodes(original).map((n) =>
      n.id === 'a' ? ({ ...n, measured: { width: 333, height: 111 } } as typeof n) : n
    )
    const back = fromFlow(nodes, [])
    expect(back.nodes.find((n) => n.id === 'a')).toMatchObject({ width: 333, height: 111 })
  })

  it('omits absent fields rather than emitting undefined', () => {
    const original = doc({ nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'x' }] })
    const back = fromFlow(toFlowNodes(original), [])
    expect(Object.keys(back.nodes[0])).not.toContain('url')
    expect(Object.keys(back.nodes[0])).not.toContain('file')
    expect(JSON.stringify(back)).not.toContain('undefined')
  })

  it('keeps a new edge drawn in the editor', () => {
    const original = doc(FULL)
    const edges = [...toFlowEdges(original), { id: 'e3', source: 'b', target: 'c' }]
    const back = fromFlow(toFlowNodes(original), edges)
    expect(back.edges).toHaveLength(3)
    expect(back.edges[2]).toEqual({ id: 'e3', fromNode: 'b', toNode: 'c' })
  })

  it('drops a deleted edge', () => {
    const original = doc(FULL)
    const back = fromFlow(toFlowNodes(original), toFlowEdges(original).filter((e) => e.id !== 'e1'))
    expect(back.edges.map((e) => e.id)).toEqual(['e2'])
  })
})

describe('serializeCanvas', () => {
  it('emits two-space JSON with only nodes and edges at the top level', () => {
    const s = serializeCanvas(doc(FULL))
    expect(s.startsWith('{\n  "nodes"')).toBe(true)
    expect(Object.keys(JSON.parse(s))).toEqual(['nodes', 'edges'])
  })

  it('re-parses to the same document', () => {
    const d = doc(FULL)
    expect(parseCanvas(serializeCanvas(d))).toEqual(d)
  })
})

describe('blankCanvas / newId', () => {
  it('starts with one editable block rather than an empty void', () => {
    const b = blankCanvas()
    expect(b.nodes).toHaveLength(1)
    expect(b.nodes[0].type).toBe('text')
    expect(b.edges).toEqual([])
  })

  it('mints unique ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newId('n')))
    expect(ids.size).toBe(50)
  })
})
