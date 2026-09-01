import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import BetterSqlite3, { type Database } from 'better-sqlite3'

// getDb() is never reached in these tests — a handle is injected via __setEntityGraphDbForTests, so
// the store's REAL SQL runs against an in-memory better-sqlite3. We still mock electron (mirrors the
// rag/store.test.ts precedent) so an accidental getDb() fails loudly rather than opening a real DB.
vi.mock('electron', () => ({
  app: { getPath: () => { throw new Error('electron app not available in test environment') } },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { ENTITY_GRAPH_SCHEMA_SQL } from './brain-schema'
import {
  __setEntityGraphDbForTests,
  upsertNode,
  upsertEdge,
  neighborsOf,
  parentsOf,
  liveNodeIds,
  liveNodes,
  isNodeLive,
  retireNode,
  rekeyNode,
  edgesOf,
  nodesByIds,
  findNodeIdByLabel,
  nodeCountsByPlane
} from './entity-graph-store'

// Mirror db-migrations.test.ts: better-sqlite3's native binding is built for the ELECTRON ABI, so a
// plain-node vitest run whose NODE_MODULE_VERSION differs cannot load it. Probe once and skip (never
// fail) when it can't load — the store's SQL is exercised wherever the ABI matches (CI/electron).
const HAS_NATIVE_SQLITE: boolean = (() => {
  try { new BetterSqlite3(':memory:').close(); return true } catch { return false }
})()

function freshDb(): Database {
  const db = new BetterSqlite3(':memory:')
  db.exec(ENTITY_GRAPH_SCHEMA_SQL)
  return db
}

const T = '2026-07-18T00:00:00.000Z'

describe.skipIf(!HAS_NATIVE_SQLITE)('entity-graph-store', () => {
  let db: Database
  beforeEach(() => {
    db = freshDb()
    __setEntityGraphDbForTests(db)
  })
  afterEach(() => {
    __setEntityGraphDbForTests(null)
    db.close()
  })

  it('upsertNode is idempotent on id (ON CONFLICT updates, one row)', () => {
    upsertNode({ id: 'entity:a', kind: 'entity', label: 'A' }, T)
    upsertNode({ id: 'entity:a', kind: 'person', label: 'A2' }, T)
    const rows = db.prepare('SELECT id, kind, label FROM entity_nodes').all() as Array<{ id: string; kind: string; label: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'entity:a', kind: 'person', label: 'A2' })
  })

  it('upsertEdge is idempotent on (src,dst,type)', () => {
    upsertEdge('entity:a', 'entity:b', 'related', T)
    upsertEdge('entity:a', 'entity:b', 'related', T)
    const n = db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number }
    expect(n.n).toBe(1)
  })

  it('neighborsOf returns indexed neighbours in BOTH directions', () => {
    upsertEdge('entity:a', 'entity:b', 'related', T) // a -> b
    upsertEdge('entity:c', 'entity:a', 'related', T) // c -> a
    expect(neighborsOf('entity:a').sort()).toEqual(['entity:b', 'entity:c'])
    expect(neighborsOf('entity:b')).toEqual(['entity:a'])
    expect(neighborsOf('entity:c')).toEqual(['entity:a'])
  })

  it('parentsOf returns only incoming (dst) edges', () => {
    upsertEdge('entity:p1', 'entity:child', 'related', T)
    upsertEdge('entity:p2', 'entity:child', 'related', T)
    upsertEdge('entity:child', 'entity:down', 'related', T)
    expect(parentsOf('entity:child').sort()).toEqual(['entity:p1', 'entity:p2'])
    expect(parentsOf('entity:down')).toEqual(['entity:child'])
  })

  it('retireNode sets valid_to (retire-not-delete); the row survives and drops from live reads', () => {
    upsertNode({ id: 'entity:a', kind: 'entity', label: 'A' }, T)
    retireNode('entity:a', T)
    // row still present
    const row = db.prepare('SELECT id, valid_to FROM entity_nodes WHERE id = ?').get('entity:a') as { id: string; valid_to: string | null }
    expect(row.id).toBe('entity:a')
    expect(row.valid_to).toBe(T)
    // but no longer live
    expect(isNodeLive('entity:a')).toBe(false)
    expect(liveNodeIds()).not.toContain('entity:a')
    expect(liveNodes().map((n) => n.id)).not.toContain('entity:a')
  })

  it('retired edges drop out of neighborsOf', () => {
    upsertEdge('entity:a', 'entity:b', 'related', T)
    expect(neighborsOf('entity:a')).toEqual(['entity:b'])
    db.prepare('UPDATE entity_edges SET valid_to = ? WHERE src = ?').run(T, 'entity:a')
    expect(neighborsOf('entity:a')).toEqual([])
  })

  it('rekeyNode rewires every edge endpoint old->new and records the fold', () => {
    upsertNode({ id: 'entity:old', kind: 'entity', label: 'Old' }, T)
    upsertEdge('entity:old', 'entity:b', 'related', T) // old -> b
    upsertEdge('entity:c', 'entity:old', 'related', T) // c -> old
    rekeyNode('entity:old', 'project:canon', T)
    // edges now hang off the canonical id
    expect(neighborsOf('project:canon').sort()).toEqual(['entity:b', 'entity:c'])
    // no edge references the old id anymore
    const stray = db.prepare('SELECT COUNT(*) AS n FROM entity_edges WHERE src = ? OR dst = ?').get('entity:old', 'entity:old') as { n: number }
    expect(stray.n).toBe(0)
    // fold recorded on the old node (reversible bookkeeping)
    const old = db.prepare('SELECT canonical_id FROM entity_nodes WHERE id = ?').get('entity:old') as { canonical_id: string | null }
    expect(old.canonical_id).toBe('project:canon')
  })

  it('fail-safe: a DB error is swallowed (no throw) and reads return empty', () => {
    // Inject a handle whose prepare() throws — every store call must no-op / return [].
    __setEntityGraphDbForTests({ prepare: () => { throw new Error('boom') } } as unknown as Database)
    expect(() => upsertNode({ id: 'x', kind: 'entity', label: 'X' }, T)).not.toThrow()
    expect(() => upsertEdge('x', 'y', 'r', T)).not.toThrow()
    expect(() => retireNode('x', T)).not.toThrow()
    expect(() => rekeyNode('x', 'y', T)).not.toThrow()
    expect(neighborsOf('x')).toEqual([])
    expect(parentsOf('x')).toEqual([])
    expect(liveNodeIds()).toEqual([])
    expect(isNodeLive('x')).toBe(false)
  })

  // PROVENANCE (v46). `kind='entity'` means two different things depending on the plane that wrote
  // it: from `construction` a FAILED typed extraction, from `claim` honest ignorance — that path
  // resolves a label and has no kind to assign. Reported as one number, 3,630 of 5,776 live nodes
  // read as "63% carry a defect marker" when almost none of them did. These tests hold the split.
  describe('node provenance', () => {
    it('records which plane minted each node', () => {
      upsertNode({ id: 'org:acme', kind: 'org', label: 'Acme' }, T, 'construction')
      upsertNode({ id: 'entity:thing', kind: 'entity', label: 'thing' }, T, 'claim')

      const byPlane = nodeCountsByPlane()
      expect(byPlane.construction).toEqual({ total: 1, untyped: 0 })
      expect(byPlane.claim).toEqual({ total: 1, untyped: 1 }) // untyped, and correctly so
    })

    // The regression that matters. The claim path re-observes labels on every 15-minute tick; if a
    // re-observation could rewrite provenance, the two populations would merge back into one number
    // within the hour — which is exactly how the graph looked before this column existed.
    it('a CLAIM re-observation never overwrites construction provenance', () => {
      upsertNode({ id: 'org:acme', kind: 'org', label: 'Acme' }, T, 'construction')
      upsertNode({ id: 'org:acme', kind: 'entity', label: 'Acme' }, T, 'claim') // the tick

      const byPlane = nodeCountsByPlane()
      expect(byPlane.construction.total).toBe(1)
      expect(byPlane.claim.total).toBe(0)
      expect(byPlane.construction.untyped).toBe(0) // kind survived too
    })

    it('defaults to unknown rather than guessing a plane', () => {
      upsertNode({ id: 'x:1', kind: 'topic', label: 'X' }, T)
      expect(nodeCountsByPlane().unknown).toEqual({ total: 1, untyped: 0 })
    })

    it('a retired node leaves the counts', () => {
      upsertNode({ id: 'org:acme', kind: 'org', label: 'Acme' }, T, 'construction')
      retireNode('org:acme', T)
      expect(nodeCountsByPlane().construction.total).toBe(0)
    })
  })
})

// ─────────────── Relations-surface read primitives (edgesOf / nodesByIds / findNodeIdByLabel) ───────────────
describe.skipIf(!HAS_NATIVE_SQLITE)('entity-graph-store read primitives (relations surface)', () => {
  let db: Database
  beforeEach(() => {
    db = freshDb()
    __setEntityGraphDbForTests(db)
    upsertNode({ id: 'project:wy', kind: 'project', label: '北澜' }, T, 'construction')
    upsertNode({ id: 'org:bili', kind: 'org', label: 'Bilibili' }, T, 'construction')
    upsertNode({ id: 'person:dana', kind: 'person', label: 'Dana' }, T, 'construction')
    upsertEdge('org:bili', 'project:wy', 'publishes', T)
    upsertEdge('project:wy', 'person:dana', 'employs', T)
  })
  afterEach(() => {
    __setEntityGraphDbForTests(null)
    db.close()
  })

  it('edgesOf returns typed edges in BOTH directions, live only', () => {
    const edges = edgesOf('project:wy')
    expect(edges).toHaveLength(2)
    expect(edges).toContainEqual({ src: 'org:bili', dst: 'project:wy', type: 'publishes' })
    expect(edges).toContainEqual({ src: 'project:wy', dst: 'person:dana', type: 'employs' })
    db.prepare(`UPDATE entity_edges SET valid_to = @t WHERE src = 'org:bili'`).run({ t: T })
    expect(edgesOf('project:wy')).toHaveLength(1)
  })

  it('nodesByIds hydrates live nodes, preserves ask order, drops unknown ids', () => {
    const rows = nodesByIds(['person:dana', 'nope:x', 'project:wy'])
    expect(rows.map((r) => r.id)).toEqual(['person:dana', 'project:wy'])
    expect(rows[0]).toMatchObject({ label: 'Dana', kind: 'person' })
  })

  it('findNodeIdByLabel matches case-insensitively and returns null on miss', () => {
    expect(findNodeIdByLabel('bilibili')).toBe('org:bili')
    expect(findNodeIdByLabel('北澜')).toBe('project:wy')
    expect(findNodeIdByLabel('unknown thing')).toBeNull()
  })
})
