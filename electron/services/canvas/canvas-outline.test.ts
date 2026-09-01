import { describe, expect, it } from 'vitest'
import { bindingOf, canvasToOutline, parseCanvas, type CanvasNode } from './canvas-outline'

const node = (over: Partial<CanvasNode> & { id: string; type: string }): CanvasNode => ({
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  ...over
})

describe('parseCanvas', () => {
  it('reads a minimal spec-shaped document', () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 100, text: 'Ship it' }],
        edges: []
      })
    )
    expect(doc.nodes).toHaveLength(1)
    expect(doc.nodes[0].text).toBe('Ship it')
  })

  it('treats both arrays as optional — the spec makes them so', () => {
    const doc = parseCanvas('{}')
    expect(doc.nodes).toEqual([])
    expect(doc.edges).toEqual([])
  })

  it('throws on non-JSON, so a wrong-file pick surfaces instead of silently emptying', () => {
    expect(() => parseCanvas('not json at all')).toThrow(/Not valid JSON/)
  })

  it('throws when the top level is an array rather than an object', () => {
    expect(() => parseCanvas('[]')).toThrow(/must be an object/)
  })

  it('drops nodes with no id or no type — nothing can reference them', () => {
    const doc = parseCanvas(
      JSON.stringify({ nodes: [{ type: 'text' }, { id: 'x' }, { id: 'ok', type: 'text' }] })
    )
    expect(doc.nodes.map((n) => n.id)).toEqual(['ok'])
  })

  it('drops dangling edges rather than reporting a connection to a deleted block', () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [{ id: 'a', type: 'text' }],
        edges: [
          { id: 'e1', fromNode: 'a', toNode: 'ghost' },
          { id: 'e2', fromNode: 'ghost', toNode: 'a' }
        ]
      })
    )
    expect(doc.edges).toEqual([])
  })

  it('defaults missing geometry to 0 instead of NaN, so ordering still works', () => {
    const doc = parseCanvas(JSON.stringify({ nodes: [{ id: 'a', type: 'text' }] }))
    expect(doc.nodes[0].x).toBe(0)
    expect(doc.nodes[0].width).toBe(0)
  })
})

describe('bindingOf', () => {
  it('binds a file node to a vault note', () => {
    expect(bindingOf(node({ id: 'a', type: 'file', file: '05 Decisions/x.md' }))).toEqual({
      kind: 'note',
      path: '05 Decisions/x.md',
      subpath: undefined
    })
  })

  it('carries a heading subpath through', () => {
    expect(
      bindingOf(node({ id: 'a', type: 'file', file: 'note.md', subpath: '#Decision' }))
    ).toMatchObject({ kind: 'note', subpath: '#Decision' })
  })

  it('decodes duin://skill, duin://tool and duin://node', () => {
    expect(bindingOf(node({ id: 'a', type: 'link', url: 'duin://skill/meeting-note' }))).toEqual({
      kind: 'skill',
      name: 'meeting-note'
    })
    expect(bindingOf(node({ id: 'a', type: 'link', url: 'duin://tool/web_search' }))).toEqual({
      kind: 'tool',
      id: 'web_search'
    })
    expect(bindingOf(node({ id: 'a', type: 'link', url: 'duin://node/decision:gam' }))).toEqual({
      kind: 'entity',
      id: 'decision:gam'
    })
  })

  it('is case-insensitive on the scheme and host', () => {
    expect(bindingOf(node({ id: 'a', type: 'link', url: 'DUIN://Skill/foo' }))).toEqual({
      kind: 'skill',
      name: 'foo'
    })
  })

  it('falls back to a plain link for an unknown duin host rather than throwing', () => {
    const b = bindingOf(node({ id: 'a', type: 'link', url: 'duin://future/thing' }))
    expect(b).toEqual({ kind: 'url', url: 'duin://future/thing' })
  })

  it('falls back to a plain link when the duin URL has no value', () => {
    expect(bindingOf(node({ id: 'a', type: 'link', url: 'duin://skill' }))).toMatchObject({
      kind: 'url'
    })
  })

  it('returns null for prose blocks and for groups', () => {
    expect(bindingOf(node({ id: 'a', type: 'text', text: 'hello' }))).toBeNull()
    expect(bindingOf(node({ id: 'g', type: 'group', label: 'Phase 1' }))).toBeNull()
  })
})

describe('canvasToOutline', () => {
  it('names an empty canvas rather than emitting a bare heading', () => {
    const out = canvasToOutline(parseCanvas('{}'), { title: 'plan.canvas' })
    expect(out).toContain('# Canvas: plan.canvas')
    expect(out).toContain('(empty canvas — no blocks)')
  })

  it('numbers blocks in reading order — top to bottom, then left to right', () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: 'c', type: 'text', x: 0, y: 500, text: 'last' },
          { id: 'b', type: 'text', x: 300, y: 0, text: 'second' },
          { id: 'a', type: 'text', x: 0, y: 0, text: 'first' }
        ]
      })
    )
    const out = canvasToOutline(doc)
    expect(out).toContain('- [1] first')
    expect(out).toContain('- [2] second')
    expect(out).toContain('- [3] last')
  })

  it('is byte-stable across key order, so an unchanged canvas re-chunks identically', () => {
    const a = canvasToOutline(
      parseCanvas(
        JSON.stringify({
          nodes: [
            { id: 'a', type: 'text', x: 0, y: 0, text: 'one' },
            { id: 'b', type: 'text', x: 0, y: 100, text: 'two' }
          ],
          edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: 'then' }]
        })
      )
    )
    const b = canvasToOutline(
      parseCanvas(
        JSON.stringify({
          edges: [{ toNode: 'b', fromNode: 'a', label: 'then', id: 'e' }],
          nodes: [
            { type: 'text', id: 'b', text: 'two', y: 100, x: 0 },
            { type: 'text', id: 'a', text: 'one', y: 0, x: 0 }
          ]
        })
      )
    )
    expect(a).toBe(b)
  })

  it('renders connections with their labels using block handles', () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: 'a', type: 'text', x: 0, y: 0, text: 'draft' },
          { id: 'b', type: 'text', x: 0, y: 100, text: 'review' }
        ],
        edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: 'blocks' }]
      })
    )
    expect(canvasToOutline(doc)).toContain('- [1] → — blocks — [2]')
  })

  it('disambiguates two blocks with identical text via their handles', () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: 'a', type: 'text', x: 0, y: 0, text: 'same' },
          { id: 'b', type: 'text', x: 0, y: 100, text: 'same' }
        ],
        edges: [{ id: 'e', fromNode: 'b', toNode: 'a' }]
      })
    )
    const out = canvasToOutline(doc)
    expect(out).toContain('- [1] same')
    expect(out).toContain('- [2] same')
    expect(out).toContain('- [2] → [1]')
  })

  it('lists bound material under References so retrieval sees the paths', () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: 'a', type: 'file', x: 0, y: 0, file: '05 Decisions/gam.md' },
          { id: 'b', type: 'link', x: 0, y: 100, url: 'duin://skill/meeting-note' },
          { id: 'c', type: 'link', x: 0, y: 200, url: 'https://example.com' }
        ]
      })
    )
    const out = canvasToOutline(doc)
    expect(out).toContain('## References')
    expect(out).toContain('- note 05 Decisions/gam.md')
    expect(out).toContain('- skill meeting-note')
    // A plain web link is not "referenced material" the retriever should index
    // as a vault pointer; it still appears as a block label above.
    expect(out).not.toContain('- link https://example.com\n- ')
  })

  it('attributes a block to the group that spatially contains it', () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: 'g', type: 'group', x: -10, y: -10, width: 400, height: 400, label: 'Phase 1' },
          { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'inside' },
          { id: 'b', type: 'text', x: 900, y: 900, width: 100, height: 50, text: 'outside' }
        ]
      })
    )
    const out = canvasToOutline(doc)
    expect(out).toMatch(/- \[\d\] inside\s+\(in group "Phase 1"\)/)
    expect(out).not.toMatch(/- \[\d\] outside\s+\(in group/)
  })

  it('excludes groups from block numbering — they are containers, not steps', () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: 'g', type: 'group', x: 0, y: 0, width: 500, height: 500, label: 'Phase 1' },
          { id: 'a', type: 'text', x: 10, y: 10, width: 50, height: 50, text: 'only block' }
        ]
      })
    )
    const out = canvasToOutline(doc)
    expect(out).toContain('1 block, 0 connections, 1 group.')
    expect(out).toContain('- [1] only block')
  })

  it('truncates a long prose block to a label rather than inlining the body', () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [{ id: 'a', type: 'text', x: 0, y: 0, text: 'x'.repeat(500) }]
      })
    )
    const out = canvasToOutline(doc)
    expect(out).toContain('…')
    expect(out.length).toBeLessThan(400)
  })

  it('survives an unknown node type from a newer editor', () => {
    const doc = parseCanvas(
      JSON.stringify({ nodes: [{ id: 'a', type: 'sticker', x: 0, y: 0 }] })
    )
    expect(canvasToOutline(doc)).toContain('- [1] (sticker)')
  })
})
