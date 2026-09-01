import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyAliasOverlay, recordAliasVerdict, loadAliasOverlay } from './operator-alias-overlay'
import type { ConstructedData } from './types'

const dirs: string[] = []
function tmpVault(): string {
  const d = mkdtempSync(join(tmpdir(), 'alias-overlay-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const DATA: ConstructedData = {
  entities: [
    { id: 'topic:usage-based', kind: 'topic', label: 'usage based', note: 'a.md' },
    { id: 'topic:usage-based-pricing', kind: 'topic', label: 'usage-based pricing', note: 'b.md' },
    { id: 'person:jon', kind: 'person', label: 'Jon Reyes', note: 'a.md' }
  ],
  edges: [
    { source: 'person:jon', target: 'topic:usage-based', type: 'mentions' },
    { source: 'topic:usage-based', target: 'topic:usage-based-pricing', type: 'about' }
  ],
  classifications: [],
  triples: []
}

describe('applyAliasOverlay (pure)', () => {
  it('rewrites a matched entity onto the operator canonical id, rewires edges, drops the self-loop, dedups', () => {
    // operator confirmed: the label "usage based" IS topic:usage-based-pricing
    const overlay = new Map([['usage based', 'topic:usage-based-pricing']])
    const out = applyAliasOverlay(DATA, overlay)
    // the two usage-based entities collapse to one
    expect(out.entities.map((e) => e.id).sort()).toEqual(['person:jon', 'topic:usage-based-pricing'])
    // jon->usage-based rewired to jon->usage-based-pricing; the about-edge became a self-loop and was dropped
    expect(out.edges).toEqual([{ source: 'person:jon', target: 'topic:usage-based-pricing', type: 'mentions' }])
  })
  it('returns the input unchanged for an empty overlay or no label match', () => {
    expect(applyAliasOverlay(DATA, new Map())).toBe(DATA)
    expect(applyAliasOverlay(DATA, new Map([['nonexistent label', 'x']]))).toBe(DATA)
  })
})

describe('record / load roundtrip', () => {
  it('loads confirmed aliases; a later reject undoes the confirm', () => {
    const vault = tmpVault()
    recordAliasVerdict(vault, { label: 'usage based', canonicalId: 'topic:usage-based-pricing', verdict: 'confirm', ts: 't1' })
    expect(loadAliasOverlay(vault).get('usage based')).toBe('topic:usage-based-pricing')
    recordAliasVerdict(vault, { label: 'Usage Based', canonicalId: 'topic:usage-based-pricing', verdict: 'reject', ts: 't2' })
    expect(loadAliasOverlay(vault).has('usage based')).toBe(false) // normalized, so the reject matches
  })
})
