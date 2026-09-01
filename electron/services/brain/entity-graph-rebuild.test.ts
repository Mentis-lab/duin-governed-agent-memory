import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// The entity graph's only DELETE path. It is the one operation in this subsystem that can destroy
// operator state, so what is pinned here is the GUARDS — each one exists because of a specific
// hazard the gap map names, and each is the difference between a rebuild and an incident.
//
// The DB seam is mocked rather than exercised against real sqlite: better-sqlite3's native binding
// is built for the ELECTRON ABI and will not load under a plain-node vitest run, and every decision
// worth pinning here is made BEFORE any SQL executes.

const h = vi.hoisted(() => ({
  calls: [] as string[],
  counts: { nodes: 6124, edges: 7783, genericKind: 3999, edgeTypes: 701 },
  entities: 2000,
  graphOn: true,
  backupOk: true
}))

vi.mock('electron', () => ({
  app: { getPath: () => { throw new Error('electron app not available in test environment') } },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../database', () => ({
  withWriteRetry: (fn: () => unknown) => fn(),
  getDb: () => ({
    exec: (sql: string) => { h.calls.push(`exec:${sql.trim()}`) },
    prepare: (sql: string) => ({
      get: () => {
        if (sql.includes("kind = 'entity'")) return { n: h.counts.genericKind }
        if (sql.includes('DISTINCT type')) return { n: h.counts.edgeTypes }
        if (sql.includes('entity_edges')) return { n: h.counts.edges }
        return { n: h.counts.nodes }
      },
      all: () => (h.backupOk ? [] : (() => { throw new Error('read failed') })())
    })
  })
}))
vi.mock('./construct', () => ({
  getResolvedConstruction: () => ({
    entities: Array.from({ length: h.entities }, (_, i) => ({ id: `e${i}`, kind: 'org', label: `L${i}`, note: 'n' })),
    edges: [],
    classifications: [],
    triples: []
  })
}))
vi.mock('./entity-graph-relink', () => ({
  entityGraphEnabled: () => h.graphOn,
  syncGraphFromConstruction: () => {
    h.calls.push('sync')
    // The rebuild re-populates from a CLEAN construction, so the post-sync shape is clean.
    h.counts = { nodes: 2000, edges: 2600, genericKind: 0, edgeTypes: 8 }
    return { nodes: 2000, merges: 0, skipped: false, created: [] }
  }
}))
vi.mock('./node-tombstones', () => ({
  reapplyNodeTombstones: () => { h.calls.push('tombstones'); return 1 }
}))

import { rebuildEntityGraph } from './entity-graph-rebuild'

let vault: string
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'graph-rebuild-'))
  h.calls = []
  h.counts = { nodes: 6124, edges: 7783, genericKind: 3999, edgeTypes: 701 }
  h.entities = 2000
  h.graphOn = true
  h.backupOk = true
})

describe('rebuildEntityGraph — the drain the graph never had', () => {
  it('purges and rebuilds, and reports the shape it actually changed', () => {
    const r = rebuildEntityGraph(vault, { stamp: 'T' })

    expect(r.ok).toBe(true)
    expect(r.before).toMatchObject({ nodes: 6124, genericKind: 3999, edgeTypes: 701 })
    expect(r.after).toMatchObject({ nodes: 2000, genericKind: 0, edgeTypes: 8 })
  })

  // Order is load-bearing, not incidental. The sync UPSERTS nodes, so an operator deletion is
  // resurrected by it — tombstones must be re-applied AFTER, which is exactly what the metabolism
  // tick already does after its own upserts.
  it('re-applies operator tombstones AFTER the sync, never before', () => {
    const r = rebuildEntityGraph(vault, { stamp: 'T' })

    expect(h.calls).toEqual([
      'exec:DELETE FROM entity_edges',
      'exec:DELETE FROM entity_nodes',
      'sync',
      'tombstones'
    ])
    expect(r.tombstonesReapplied).toBe(1)
  })

  // The failure this campaign spent a night on was a construction that was stale while looking
  // healthy. Purging and re-syncing from one blanks the graph.
  it('REFUSES on a thin construction, and touches nothing', () => {
    h.entities = 3

    const r = rebuildEntityGraph(vault, { stamp: 'T' })

    expect(r.ok).toBe(false)
    expect(r.reason).toBe('thin-construction')
    expect(h.calls).toEqual([]) // no DELETE, no sync — nothing happened at all
  })

  it('REFUSES to purge a graph it could not back up first', () => {
    h.backupOk = false // the snapshot read throws

    const r = rebuildEntityGraph(vault, { stamp: 'T' })

    expect(r.ok).toBe(false)
    expect(r.reason).toBe('backup-failed')
    expect(h.calls).toEqual([]) // the gap map's words: the graph "is in no backup"
  })

  it('REFUSES without a vault, because there is nowhere to put the backup', () => {
    expect(rebuildEntityGraph(null, { stamp: 'T' }).reason).toBe('backup-failed')
    expect(h.calls).toEqual([])
  })

  it('is a no-op when the entity graph is switched off', () => {
    h.graphOn = false

    const r = rebuildEntityGraph(vault, { stamp: 'T' })

    expect(r.ok).toBe(false)
    expect(r.reason).toBe('graph-disabled')
    expect(h.calls).toEqual([])
  })
})
