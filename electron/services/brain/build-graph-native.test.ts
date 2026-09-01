import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildGraph } from './build-graph-native'

describe('buildGraph', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-bg-'))
    mkdirSync(join(vault, 'Notes'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('nodes grouped by top folder, resolved [[wikilinks]] → edges + degree', () => {
    writeFileSync(join(vault, 'a.md'), 'links [[b]] and [[missing]]\n#topic')
    writeFileSync(join(vault, 'Notes', 'b.md'), 'hi')
    const g = buildGraph(vault)
    expect(g.nodes.find((n) => n.id === 'a.md')).toEqual({ id: 'a.md', label: 'a', group: '(root)', deg: 1 })
    expect(g.nodes.find((n) => n.id === 'Notes/b.md')).toMatchObject({ group: 'Notes', deg: 1 })
    expect(g.links).toEqual([{ source: 'a.md', target: 'Notes/b.md' }]) // [[missing]] unresolved → no edge
    expect(g.folders).toEqual(['(root)', 'Notes'])
    expect(g.note_refs['a.md']).toEqual(['b', 'missing']) // ALL targets kept, sorted
    expect(g.note_tags['a.md']).toEqual(['topic'])
  })

  it('frontmatter block-list tags capture only the FIRST item (Python \\s* quirk)', () => {
    writeFileSync(join(vault, 'p.md'), '---\ntags:\n  - orbis-inc\n  - 日本\n  - m&a-ops\n---\nbody')
    expect(buildGraph(vault).note_tags['p.md']).toEqual(['orbis-inc'])
  })

  it('inline frontmatter tags: [a, b] captured fully', () => {
    writeFileSync(join(vault, 'q.md'), '---\ntags: [alpha, 跨境/x]\n---\nbody')
    expect(buildGraph(vault).note_tags['q.md']).toEqual(['alpha', '跨境/x'])
  })

  it('null vault → empty', () => {
    expect(buildGraph(null)).toEqual({ nodes: [], links: [], folders: [], note_refs: {}, note_tags: {} })
  })

  it('P5 "machine files only": `_`-basename files are NOT graph nodes; DUIN/Meta cards + `_`-DIR notes ARE', () => {
    // A `_`-prefixed machine FILE (log/index/dashboard) — must NOT become a graph node.
    writeFileSync(join(vault, '_concept-index.md'), '# machine index\n')
    writeFileSync(join(vault, 'Notes', '_dashboard.md'), '# machine dashboard\n')
    // A DUIN/Meta design card (normal basename) — REAL knowledge, KEPT as a node.
    mkdirSync(join(vault, 'DUIN', 'Meta'), { recursive: true })
    writeFileSync(join(vault, 'DUIN', 'Meta', 'design-card.md'), '# a design card\n')
    // A real note inside a `_`-prefixed content DIR (normal filename) — KEPT.
    mkdirSync(join(vault, '北澜', '_原始转录'), { recursive: true })
    writeFileSync(join(vault, '北澜', '_原始转录', 'transcript.md'), '# a transcript\n')

    const g = buildGraph(vault)
    const ids = g.nodes.map((n) => n.id)
    // `_`-basename FILES excluded from the MAP note cloud.
    expect(ids).not.toContain('_concept-index.md')
    expect(ids).not.toContain('Notes/_dashboard.md')
    // DUIN/Meta design cards KEPT (not scaffolding).
    expect(ids).toContain('DUIN/Meta/design-card.md')
    // A normal file inside a `_`-DIR is KEPT (scoping is the FILE basename, not the dir).
    expect(ids).toContain('北澜/_原始转录/transcript.md')
  })

  it('structural plumbing (README / index / .gitkeep) is NOT a graph node; real notes survive', () => {
    // Structural folder/git files — titled but bodyless — must NOT mint graph nodes.
    writeFileSync(join(vault, 'README.md'), '# repo readme\n')
    writeFileSync(join(vault, 'INDEX.md'), '# toc\n')
    mkdirSync(join(vault, 'DUIN', 'Knowledge'), { recursive: true })
    writeFileSync(join(vault, 'DUIN', 'Knowledge', 'README.md'), '# section readme\n') // was typed as a `card`
    writeFileSync(join(vault, 'DUIN', 'Knowledge', 'README-2.md'), '# dedup-renamed readme\n')
    mkdirSync(join(vault, 'DUIN', 'Meta'), { recursive: true })
    writeFileSync(join(vault, 'DUIN', 'Meta', '.gitkeep.md'), '')
    writeFileSync(join(vault, 'DUIN', 'Meta', '.gitkeep-2.md'), '')
    writeFileSync(join(vault, 'DUIN', 'Knowledge', 'index.md'), '# folder index\n')
    // Real notes whose names merely START with those stems — MUST be kept (no false positive).
    writeFileSync(join(vault, 'Notes', 'index-of-terms.md'), '# a real MOC\n')
    writeFileSync(join(vault, 'Notes', 'readme-driven-design.md'), '# a real essay\n')

    const ids = buildGraph(vault).nodes.map((n) => n.id)
    for (const s of [
      'README.md', 'INDEX.md', 'DUIN/Knowledge/README.md', 'DUIN/Knowledge/README-2.md',
      'DUIN/Meta/.gitkeep.md', 'DUIN/Meta/.gitkeep-2.md', 'DUIN/Knowledge/index.md'
    ]) {
      expect(ids).not.toContain(s)
    }
    expect(ids).toContain('Notes/index-of-terms.md')
    expect(ids).toContain('Notes/readme-driven-design.md')
  })
})
