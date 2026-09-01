// reveal-persist maps reveal frames to durable graph writes. The governance decision (which frames
// become edges) is PURE and tested here without a DB: only auto-accepted, fully-specified links are
// applied; 'review' links, merges, and control frames are not. Plus the DUIN_AUTO_REVEAL gate.

import { describe, it, expect, afterEach } from 'vitest'
import { revealFrameAction, autoRevealEnabled, autoRevealPersist } from './reveal-persist'
import type { GraphFrame } from './reveal-frames'

describe('revealFrameAction — only auto-accepted edges + nodes persist', () => {
  it('node-created / entity-found → a node upsert', () => {
    const a = revealFrameAction({ type: 'graph', op: 'node-created', id: 'n1', kind: 'note', label: 'Drop' })
    expect(a).toEqual({ kind: 'node', node: { id: 'n1', kind: 'note', label: 'Drop' } })
    const b = revealFrameAction({ type: 'graph', op: 'entity-found', id: 'e1', kind: 'person', label: 'Ana' })
    expect(b).toEqual({ kind: 'node', node: { id: 'e1', kind: 'person', label: 'Ana' } })
  })

  it('an AUTO link-formed → an edge upsert', () => {
    const a = revealFrameAction({
      type: 'graph', op: 'link-formed', from: 'n1', to: 'e1', edgeType: 'mentions', src: 'alias', accept: 'auto'
    })
    expect(a).toEqual({ kind: 'edge', edge: { src: 'n1', dst: 'e1', type: 'mentions' } })
  })

  it('a REVIEW link-formed → NOT applied (no human queue, no write)', () => {
    const a = revealFrameAction({
      type: 'graph', op: 'link-formed', from: 'n1', to: 'e1', edgeType: 'mentions', src: 'llm', accept: 'review'
    })
    expect(a).toBeNull()
  })

  it('entity-merged is never auto-applied (merge authority stays with entity-resolver)', () => {
    expect(revealFrameAction({ type: 'graph', op: 'entity-merged', rawId: 'x', into: 'y' })).toBeNull()
  })

  it('reveal-complete and incomplete frames map to nothing', () => {
    expect(revealFrameAction({ type: 'graph', op: 'reveal-complete', counts: { entities: 0, edges: 0, merges: 0 } })).toBeNull()
    expect(revealFrameAction({ type: 'graph', op: 'link-formed', accept: 'auto' } as GraphFrame)).toBeNull()
    expect(revealFrameAction({ type: 'graph', op: 'node-created' } as GraphFrame)).toBeNull()
  })
})

describe('autoRevealEnabled — default ON, explicit opt-out', () => {
  const prev = process.env.DUIN_AUTO_REVEAL
  afterEach(() => {
    if (prev === undefined) delete process.env.DUIN_AUTO_REVEAL
    else process.env.DUIN_AUTO_REVEAL = prev
  })
  it('defaults ON when unset', () => {
    delete process.env.DUIN_AUTO_REVEAL
    expect(autoRevealEnabled()).toBe(true)
  })
  it('is OFF for 0 / false / off', () => {
    for (const v of ['0', 'false', 'off', 'OFF']) {
      process.env.DUIN_AUTO_REVEAL = v
      expect(autoRevealEnabled()).toBe(false)
    }
  })
  it('is ON for 1 / true', () => {
    for (const v of ['1', 'true']) {
      process.env.DUIN_AUTO_REVEAL = v
      expect(autoRevealEnabled()).toBe(true)
    }
  })
})

// The 2026-07-25 evaluation caught the writer and its readers on DIFFERENT gates: every reader of
// the persisted entity graph sits behind DUIN_ENTITY_GRAPH, while this writer sat behind
// DUIN_AUTO_REVEAL alone — so a capture could spend a full governed reveal pass, model calls
// included, filling a store nothing would ever read. Keeping the writer on the READERS' gate is
// what makes that impossible, and it still matters after world-model Stage 1 flipped the gate's
// default ON (kg-query now reads the graph back): an operator who opts out with
// DUIN_ENTITY_GRAPH=0 must stop paying for the pass immediately.
describe('autoRevealPersist follows the READERS gate (DUIN_ENTITY_GRAPH)', () => {
  const prevGraph = process.env.DUIN_ENTITY_GRAPH
  const prevReveal = process.env.DUIN_AUTO_REVEAL
  afterEach(() => {
    if (prevGraph === undefined) delete process.env.DUIN_ENTITY_GRAPH
    else process.env.DUIN_ENTITY_GRAPH = prevGraph
    if (prevReveal === undefined) delete process.env.DUIN_AUTO_REVEAL
    else process.env.DUIN_AUTO_REVEAL = prevReveal
  })

  it('does not run the reveal pass when the entity graph is explicitly off', async () => {
    process.env.DUIN_ENTITY_GRAPH = '0'
    process.env.DUIN_AUTO_REVEAL = '1'

    // A chat dep that would throw if the pass got as far as calling a model — proof the model
    // calls are what we are saving, not just the DB writes.
    const chat = () => {
      throw new Error('reveal ran a model call while the entity graph was disabled')
    }
    const r = await autoRevealPersist('/tmp/duin-vault', { id: 'capture:1', text: 'a thought' }, { chat })

    expect(r.ran).toBe(false)
    expect(r.status).toBe('entity-graph-disabled')
    expect(r.nodes).toBe(0)
    expect(r.edges).toBe(0)
  })

  it('still refuses when auto-reveal is off, whatever the graph flag says', async () => {
    process.env.DUIN_ENTITY_GRAPH = '1'
    process.env.DUIN_AUTO_REVEAL = '0'

    const r = await autoRevealPersist('/tmp/duin-vault', { id: 'capture:1', text: 'a thought' })
    expect(r.ran).toBe(false)
    expect(r.status).toBe('disabled')
  })

  it('gets past both gates when the graph is armed (empty source still short-circuits)', async () => {
    process.env.DUIN_ENTITY_GRAPH = '1'
    process.env.DUIN_AUTO_REVEAL = '1'

    // 'empty' proves control reached the checks AFTER both gates rather than being turned away.
    const r = await autoRevealPersist('/tmp/duin-vault', { id: 'capture:1', text: '   ' })
    expect(r.status).toBe('empty')
  })
})
