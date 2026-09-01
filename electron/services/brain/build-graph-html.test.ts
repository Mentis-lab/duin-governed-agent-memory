import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildGraph } from './build-graph-native'

// Phase 2: authored HTML as a first-class brain-graph node, gated behind
// DUIN_GRAPH_INCLUDE_HTML (default off → byte-identical to the .md-only Python parity port).
let vault: string
const prev = process.env.DUIN_GRAPH_INCLUDE_HTML
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-graph-'))
  writeFileSync(join(vault, 'note-a.md'), '# A\nlinks to [[note-b]]\n')
  writeFileSync(join(vault, 'note-b.md'), '# B\n')
  writeFileSync(join(vault, 'report.html'), '<html><body><h1>Report</h1><a href="note-b.md">see B</a></body></html>')
})
afterEach(() => {
  rmSync(vault, { recursive: true, force: true })
  if (prev === undefined) delete process.env.DUIN_GRAPH_INCLUDE_HTML
  else process.env.DUIN_GRAPH_INCLUDE_HTML = prev
})

describe('buildGraph — HTML-node gap (Phase 2)', () => {
  it('default OFF: HTML is absent, .md graph is exactly as before', () => {
    delete process.env.DUIN_GRAPH_INCLUDE_HTML
    const g = buildGraph(vault)
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['note-a.md', 'note-b.md'])
    expect(g.nodes.some((n) => HTML(n.id))).toBe(false)
    // the existing wikilink edge is intact
    expect(g.links).toContainEqual({ source: 'note-a.md', target: 'note-b.md' })
  })

  it('opt-in ON: HTML becomes a first-class node', () => {
    process.env.DUIN_GRAPH_INCLUDE_HTML = '1'
    const g = buildGraph(vault)
    const report = g.nodes.find((n) => n.id === 'report.html')
    expect(report).toBeDefined()
    expect(report!.label).toBe('report') // extension stripped for the label
  })

  it('opt-in ON: <a href> resolves so the HTML node is not isolated', () => {
    process.env.DUIN_GRAPH_INCLUDE_HTML = '1'
    const g = buildGraph(vault)
    expect(g.links).toContainEqual({ source: 'report.html', target: 'note-b.md' })
    const report = g.nodes.find((n) => n.id === 'report.html')!
    expect(report.deg).toBeGreaterThan(0)
    // note-b now has degree from both note-a (wikilink) and report.html (href)
    expect(g.nodes.find((n) => n.id === 'note-b.md')!.deg).toBe(2)
  })

  it('a bare HTML file with no local refs lands as a node (degree 0), never crashes', () => {
    writeFileSync(join(vault, 'standalone.html'), '<html><body>no links here</body></html>')
    process.env.DUIN_GRAPH_INCLUDE_HTML = 'true'
    const g = buildGraph(vault)
    const s = g.nodes.find((n) => n.id === 'standalone.html')!
    expect(s.deg).toBe(0)
  })
})

const HTML = (id: string): boolean => /\.html?$/i.test(id)
