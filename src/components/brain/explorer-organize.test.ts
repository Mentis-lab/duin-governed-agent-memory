import { describe, expect, it } from 'vitest'
import { applyOrganizeToGraph, folderOf, isNoteId, topFolderOf } from './ExplorerOrganize'
import type { BrainGraphData } from '@/stores/brain-store'

const graph = (): BrainGraphData => ({
  nodes: [
    { id: 'Notes/Old.md', kind: 'note', label: 'Old', layer: 'vault', group: 'Notes' },
    { id: 'Notes/Sub/Deep.md', kind: 'note', label: 'Deep', layer: 'vault', group: 'Notes' },
    { id: 'Other.md', kind: 'note', label: 'Other', layer: 'vault', group: '' },
    { id: 'topic:launch', kind: 'topic', label: 'launch', layer: 'construction' }
  ],
  links: [
    { source: 'Other.md', target: 'Notes/Old.md', type: 'wikilink' },
    { source: 'topic:launch', target: 'Notes/Sub/Deep.md', type: 'mentions' }
  ]
})

describe('path helpers', () => {
  it('reads folders off a vault-relative id', () => {
    expect(folderOf('Notes/Sub/Deep.md')).toBe('Notes/Sub')
    expect(topFolderOf('Notes/Sub/Deep.md')).toBe('Notes')
    expect(folderOf('Other.md')).toBe('')
    expect(isNoteId('Notes/x.md')).toBe(true)
    expect(isNoteId('topic:launch')).toBe(false)
  })
})

describe('applyOrganizeToGraph', () => {
  it('renames a note: new id, new label, links follow', () => {
    const g = applyOrganizeToGraph(graph(), { kind: 'rename-note', from: 'Notes/Old.md', to: 'Notes/New.md', label: 'New', linksUpdated: 1, notesTouched: 1 })
    expect(g.nodes[0]).toMatchObject({ id: 'Notes/New.md', label: 'New', group: 'Notes' })
    expect(g.links[0]).toMatchObject({ source: 'Other.md', target: 'Notes/New.md' })
  })
  it('moves a note: new id and top folder, label kept, links follow', () => {
    const g = applyOrganizeToGraph(graph(), { kind: 'move-note', from: 'Notes/Old.md', to: 'Archive/2026/Old.md', linksUpdated: 0, notesTouched: 0 })
    expect(g.nodes[0]).toMatchObject({ id: 'Archive/2026/Old.md', label: 'Old', group: 'Archive' })
    expect(g.links[0]).toMatchObject({ target: 'Archive/2026/Old.md' })
  })
  it('renames a folder: every note under it moves, nested included, links follow', () => {
    const g = applyOrganizeToGraph(graph(), { kind: 'rename-folder', from: 'Notes', to: 'Journal', linksUpdated: 0, notesTouched: 0 })
    expect(g.nodes.map((n) => n.id)).toEqual(['Journal/Old.md', 'Journal/Sub/Deep.md', 'Other.md', 'topic:launch'])
    expect(g.nodes[1]).toMatchObject({ group: 'Journal' })
    expect(g.links[1]).toMatchObject({ target: 'Journal/Sub/Deep.md' })
  })
  it('adds a new note as a vault node in its folder', () => {
    const g = applyOrganizeToGraph(graph(), { kind: 'new-note', path: 'Notes/Fresh.md', label: 'Fresh' })
    expect(g.nodes.at(-1)).toEqual({ id: 'Notes/Fresh.md', kind: 'note', label: 'Fresh', layer: 'vault', group: 'Notes' })
  })
  it('labels a node in place with operator provenance', () => {
    const g = applyOrganizeToGraph(graph(), { kind: 'label-node', id: 'topic:launch', label: 'Launch plan' })
    expect(g.nodes[3]).toMatchObject({ id: 'topic:launch', label: 'Launch plan', labelBy: 'operator' })
    expect(g.links).toEqual(graph().links)
  })
  it('tolerates links whose endpoints are node objects (d3 mutates them)', () => {
    const g = graph()
    const objLinks = g.links.map((l) => ({ ...l, source: { id: l.source }, target: { id: l.target } })) as unknown as BrainGraphData['links']
    const out = applyOrganizeToGraph({ ...g, links: objLinks }, { kind: 'rename-note', from: 'Notes/Old.md', to: 'Notes/New.md', label: 'New', linksUpdated: 0, notesTouched: 0 })
    expect(out.links[0]).toMatchObject({ source: 'Other.md', target: 'Notes/New.md' })
  })
})
