import { describe, expect, it } from 'vitest'
import { parseCanvas } from './canvas-outline'
import { boundsOf, canvasToHtmlFragment, esc } from './canvas-render'

const doc = (obj: unknown) => parseCanvas(JSON.stringify(obj))

describe('esc', () => {
  it('neutralises every character that could break out of markup or an attribute', () => {
    expect(esc(`<script>alert("x")</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
    )
    expect(esc("it's & more")).toBe('it&#39;s &amp; more')
  })

  it('escapes the ampersand first so entities are not double-broken', () => {
    expect(esc('&lt;')).toBe('&amp;lt;')
  })
})

describe('boundsOf', () => {
  it('derives the viewport from content, including negative coordinates', () => {
    const b = boundsOf(
      doc({
        nodes: [
          { id: 'a', type: 'text', x: -400, y: -200, width: 100, height: 50 },
          { id: 'b', type: 'text', x: 100, y: 100, width: 200, height: 80 }
        ]
      }).nodes
    )
    expect(b).toEqual({ x: -400, y: -200, width: 700, height: 380 })
  })

  it('returns a zero rect for no nodes rather than Infinity', () => {
    expect(boundsOf([])).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

describe('canvasToHtmlFragment', () => {
  it('says so plainly when the canvas is empty', () => {
    expect(canvasToHtmlFragment(doc({}))).toContain('This canvas is empty')
  })

  it('escapes block text — vault content must never reach the DOM as markup', () => {
    const html = canvasToHtmlFragment(
      doc({ nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 60, text: '<img src=x onerror=alert(1)>' }] })
    )
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('escapes edge labels and group names too', () => {
    const html = canvasToHtmlFragment(
      doc({
        nodes: [
          { id: 'g', type: 'group', x: 0, y: 0, width: 500, height: 500, label: '<b>g</b>' },
          { id: 'a', type: 'text', x: 10, y: 10, width: 100, height: 40, text: 'a' },
          { id: 'b', type: 'text', x: 10, y: 200, width: 100, height: 40, text: 'b' }
        ],
        edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: '<i>x</i>' }]
      })
    )
    expect(html).not.toContain('<b>g</b>')
    expect(html).not.toContain('<i>x</i>')
    expect(html).toContain('&lt;b&gt;g&lt;/b&gt;')
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;')
  })

  it('shifts negative coordinates into the positive viewport', () => {
    const html = canvasToHtmlFragment(
      doc({ nodes: [{ id: 'a', type: 'text', x: -1000, y: -1000, width: 100, height: 50, text: 'x' }] })
    )
    // Padding is 48, so the sole block lands at exactly the padding offset.
    expect(html).toContain('left:48px;top:48px')
    expect(html).not.toContain('left:-')
  })

  it('draws the edge layer before the blocks so lines paint underneath', () => {
    const html = canvasToHtmlFragment(
      doc({
        nodes: [
          { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 40, text: 'a' },
          { id: 'b', type: 'text', x: 0, y: 200, width: 100, height: 40, text: 'b' }
        ],
        edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }]
      })
    )
    expect(html.indexOf('<svg')).toBeLessThan(html.indexOf('cv-block'))
    expect(html).toContain('<line')
    expect(html).toContain('marker-end="url(#cv-arrow)"')
  })

  it('renders groups behind blocks', () => {
    const html = canvasToHtmlFragment(
      doc({
        nodes: [
          { id: 'a', type: 'text', x: 10, y: 10, width: 100, height: 40, text: 'inner' },
          { id: 'g', type: 'group', x: 0, y: 0, width: 400, height: 400, label: 'Phase 1' }
        ]
      })
    )
    expect(html.indexOf('cv-group')).toBeLessThan(html.indexOf('cv-block'))
  })

  it('maps the canvas colour presets and passes hex through', () => {
    const html = canvasToHtmlFragment(
      doc({
        nodes: [
          { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, color: '4', text: 'green' },
          { id: 'b', type: 'text', x: 0, y: 50, width: 10, height: 10, color: '#abcdef', text: 'hex' }
        ]
      })
    )
    expect(html).toContain('border-color:#4bb563')
    expect(html).toContain('border-color:#abcdef')
  })

  it('rejects a colour that is neither a preset nor a hex, so nothing arbitrary reaches a style attribute', () => {
    const html = canvasToHtmlFragment(
      doc({
        nodes: [
          { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, color: 'red;background:url(x)', text: 'x' }
        ]
      })
    )
    expect(html).not.toContain('background:url')
    expect(html).toContain('border-color:#5a5a7a')
  })

  it('tags a bound block with what it points at', () => {
    const html = canvasToHtmlFragment(
      doc({
        nodes: [
          { id: 'a', type: 'file', x: 0, y: 0, width: 200, height: 60, file: '05 Decisions/x.md' },
          { id: 'b', type: 'link', x: 0, y: 100, width: 200, height: 60, url: 'duin://skill/meeting-note' }
        ]
      })
    )
    expect(html).toContain('>note<')
    expect(html).toContain('>skill<')
    expect(html).toContain('note 05 Decisions/x.md')
  })

  it('reports truncation rather than silently clipping a large canvas', () => {
    const nodes = Array.from({ length: 340 }, (_, i) => ({
      id: `n${i}`,
      type: 'text',
      x: (i % 20) * 120,
      y: Math.floor(i / 20) * 90,
      width: 100,
      height: 60,
      text: `block ${i}`
    }))
    const html = canvasToHtmlFragment(doc({ nodes }))
    expect(html).toContain('Showing 300 of 340 blocks')
  })

  it('drops an edge whose endpoint was truncated away instead of drawing to nowhere', () => {
    const nodes = Array.from({ length: 320 }, (_, i) => ({
      id: `n${i}`,
      type: 'text',
      x: 0,
      y: i * 70,
      width: 100,
      height: 60,
      text: `b${i}`
    }))
    const html = canvasToHtmlFragment(
      doc({ nodes, edges: [{ id: 'e', fromNode: 'n0', toNode: 'n319' }] })
    )
    expect(html).not.toContain('<line')
  })

  it('is deterministic — the same document renders byte-identically', () => {
    const input = {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 40, text: 'a' },
        { id: 'b', type: 'text', x: 0, y: 100, width: 100, height: 40, text: 'b' }
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: 'then' }]
    }
    expect(canvasToHtmlFragment(doc(input))).toBe(canvasToHtmlFragment(doc(input)))
  })

  it('renders CJK text without mangling it', () => {
    const html = canvasToHtmlFragment(
      doc({ nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 60, text: '中国BD双周报' }] })
    )
    expect(html).toContain('中国BD双周报')
  })
})
