import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import BetterSqlite3, { type Database } from 'better-sqlite3'

vi.mock('electron', () => ({
  app: { getPath: () => { throw new Error('electron app not available in test environment') } },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { ENTITY_GRAPH_SCHEMA_SQL } from './brain-schema'
import { __setEntityGraphDbForTests, upsertNode, upsertEdge, neighborsOf, isNodeLive } from './entity-graph-store'
import {
  entityGraphEnabled,
  resolveNodeId,
  relinkNeighbors,
  writeTimeRelink,
  barrierRepair,
  cascadeInvalidate,
  syncGraphFromConstruction
} from './entity-graph-relink'
import { setActiveAliasGroups } from './entity-resolver'
import type { Claim } from './claim-metabolism'
import type { ConstructedData } from './types'

// See entity-graph-store.test.ts — skip (never fail) sqlite-backed describes when the native
// better-sqlite3 ABI doesn't match this runner. The flag-gate describe below needs no real DB.
const HAS_NATIVE_SQLITE: boolean = (() => {
  try { new BetterSqlite3(':memory:').close(); return true } catch { return false }
})()

function freshDb(): Database {
  const db = new BetterSqlite3(':memory:')
  db.exec(ENTITY_GRAPH_SCHEMA_SQL)
  return db
}

const T = '2026-07-18T00:00:00.000Z'

function claim(subject: string, relation: string, object: string, validTo: number | null = null): Claim {
  return {
    id: `c:${subject}:${relation}:${object}`,
    chunkId: '',
    notePath: '',
    subject,
    relation,
    object,
    validFrom: 0,
    validTo,
    observedAt: 0,
    supersededBy: null,
    mutability: 'mutable',
    justifications: [],
    verdict: 'current',
    verdictBy: null
  } as Claim
}

// Stage 1 flipped the default to ON, so "off" must now be an EXPLICIT '0' — deleting the var
// enables it. The off-path assertions below are unchanged in intent: they still prove that a
// disabled graph touches nothing.
function setFlag(on: boolean): void {
  process.env.DUIN_ENTITY_GRAPH = on ? '1' : '0'
}


// The alias whitelist these tests assert against. It used to be COMPILED IN as
// `entity-resolver.ENTITY_ALIAS` (14 hand-audited groups of the author's real people), so the tests
// got it for free. Cold-start A1 (2026-07-25) emptied that table on purpose — shipping it leaked the
// author's identities to every user and silently collapsed a second operator's common first name
// onto them — and real groups now load per-vault from `.duin/_state/entity-aliases.json`.
//
// The tests were never updated, so they ran against an EMPTY whitelist and every lookup fell through
// to the `entity:<slug>` default: `resolveNodeId('theo quill')` returned `entity:theo-quill` instead of
// `person:theo-quill`. That is a stale test, not a resolver defect and nothing to do with the
// split-on-colon parsers. Seed the whitelist explicitly here — a test must not depend on whatever
// happens to be in the operator's vault.
const TEST_ALIAS_GROUPS = [
  { canonicalId: 'person:theo-quill', canonical: 'Theo', aliases: ['theo', 'theo quill', 'theoquill'] },
  { canonicalId: 'project:北澜', canonical: '北澜', aliases: ['北澜', 'beilan', 'hokuran'] }
]

beforeEach(() => setActiveAliasGroups(TEST_ALIAS_GROUPS))

describe('entity-graph-relink — flag gate', () => {
  afterEach(() => { setFlag(false); __setEntityGraphDbForTests(null) })

  it('entityGraphEnabled is default ON (unset) and only an explicit "0" disables it', () => {
    delete process.env.DUIN_ENTITY_GRAPH
    expect(entityGraphEnabled()).toBe(true) // unset => on, now that kg-query reads the graph back
    process.env.DUIN_ENTITY_GRAPH = '0'
    expect(entityGraphEnabled()).toBe(false) // explicit opt-out is still honoured
    process.env.DUIN_ENTITY_GRAPH = '1'
    expect(entityGraphEnabled()).toBe(true)
  })

  it('flag-OFF is byte-identical: every mutation entrypoint is a zero-DB-access no-op', () => {
    setFlag(false)
    // A poisoned handle: ANY store access throws. Flag-off must never reach it.
    __setEntityGraphDbForTests({ prepare: () => { throw new Error('must not touch DB when flag off') } } as unknown as Database)
    expect(relinkNeighbors([claim('Alice', 'knows', 'Bob')], T)).toEqual({ claims: 0, nodes: 0, edges: 0, skipped: true })
    expect(writeTimeRelink('/some/vault', T)).toEqual({ claims: 0, nodes: 0, edges: 0, skipped: true })
    expect(cascadeInvalidate('entity:x', T)).toEqual({ retired: [], orphaned: [], skipped: true })
    const con: ConstructedData = { entities: [], edges: [], classifications: [] }
    // `created` was added when the sync gained a new-node trigger for duplicate detection.
    // The invariant this test exists for is unchanged and still enforced by the poisoned
    // handle above: the flag check returns BEFORE the liveNodeIds() snapshot, so flag-off
    // still reaches zero DB access.
    expect(syncGraphFromConstruction(con, T)).toEqual({ nodes: 0, merges: 0, deferred: 0, skipped: true, created: [] })
  })
})

describe.skipIf(!HAS_NATIVE_SQLITE)('resolveNodeId — whitelist is the sole identity authority', () => {
  let db: Database
  beforeEach(() => { db = freshDb(); __setEntityGraphDbForTests(db) })
  afterEach(() => { __setEntityGraphDbForTests(null); db.close() })

  it('non-whitelisted label → its own derived entity:<slug> id (never merged)', () => {
    expect(resolveNodeId('Some Random Thing')).toMatchObject({ id: 'entity:some-random-thing', kind: 'entity' })
  })
  it('whitelisted alias label → the group canonical id + kind', () => {
    expect(resolveNodeId('theo quill')).toMatchObject({ id: 'person:theo-quill', kind: 'person' })
    expect(resolveNodeId('beilan')).toMatchObject({ id: 'project:北澜', kind: 'project' })
  })
  it('empty/unsluggable label → null', () => {
    expect(resolveNodeId('   ')).toBeNull()
  })
})

describe.skipIf(!HAS_NATIVE_SQLITE)('relinkNeighbors — write-time relink (flag ON)', () => {
  let db: Database
  beforeEach(() => { setFlag(true); db = freshDb(); __setEntityGraphDbForTests(db) })
  afterEach(() => { setFlag(false); __setEntityGraphDbForTests(null); db.close() })

  it('adds subject→object edges + nodes for live claims', () => {
    const res = relinkNeighbors([claim('Alice', 'knows', 'Bob'), claim('Bob', 'likes', 'Cake')], T)
    expect(res.skipped).toBe(false)
    expect(res.edges).toBe(2)
    expect(neighborsOf('entity:alice')).toEqual(['entity:bob'])
    expect(neighborsOf('entity:bob').sort()).toEqual(['entity:alice', 'entity:cake'])
  })

  it('is incremental: a re-run adds no new edges (neighborsOf gate + ON CONFLICT)', () => {
    relinkNeighbors([claim('Alice', 'knows', 'Bob')], T)
    const second = relinkNeighbors([claim('Alice', 'knows', 'Bob')], T)
    expect(second.edges).toBe(0)
    const n = db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number }
    expect(n.n).toBe(1)
  })

  it('skips retired (validTo set) claims', () => {
    const res = relinkNeighbors([claim('Alice', 'knows', 'Bob', 123)], T)
    expect(res.edges).toBe(0)
    expect(neighborsOf('entity:alice')).toEqual([])
  })

  it('writeTimeRelink(null vault) is a clean no-op (empty ledger)', () => {
    expect(writeTimeRelink(null, T)).toEqual({ claims: 0, nodes: 0, edges: 0, skipped: false })
  })
})

describe.skipIf(!HAS_NATIVE_SQLITE)('cascadeInvalidate + barrierRepair — .every orphan walk (flag ON)', () => {
  let db: Database
  beforeEach(() => { setFlag(true); db = freshDb(); __setEntityGraphDbForTests(db) })
  afterEach(() => { setFlag(false); __setEntityGraphDbForTests(null); db.close() })

  function node(id: string): void { upsertNode({ id, kind: 'entity', label: id }, T) }

  it('a node with a SINGLE live parent is orphaned when that parent is retired (.every)', () => {
    node('entity:p'); node('entity:c'); node('entity:g')
    upsertEdge('entity:p', 'entity:c', 'related', T) // p -> c
    upsertEdge('entity:c', 'entity:g', 'related', T) // c -> g (grandchild — cascades)
    const res = cascadeInvalidate('entity:p', T) // removal of p
    expect(res.retired).toEqual(['entity:p'])
    expect(res.orphaned.sort()).toEqual(['entity:c', 'entity:g']) // fixpoint cascade
    expect(isNodeLive('entity:c')).toBe(false)
    expect(isNodeLive('entity:g')).toBe(false)
  })

  it('shared-entity exclusion: a node with TWO live parents is NOT orphaned when one is retired', () => {
    node('entity:p1'); node('entity:p2'); node('entity:c')
    upsertEdge('entity:p1', 'entity:c', 'related', T)
    upsertEdge('entity:p2', 'entity:c', 'related', T)
    const res = cascadeInvalidate('entity:p1', T)
    expect(res.retired).toEqual(['entity:p1'])
    expect(res.orphaned).toEqual([]) // p2 still live ⇒ c is shared, not orphaned
    expect(isNodeLive('entity:c')).toBe(true)
  })

  it('roots (no parents) are never orphaned', () => {
    node('entity:root'); node('entity:p'); node('entity:c')
    upsertEdge('entity:p', 'entity:c', 'related', T)
    cascadeInvalidate('entity:p', T)
    expect(isNodeLive('entity:root')).toBe(true)
  })

  it('no-auto-merge: a merge whose target is NOT a whitelist canonical id is REFUSED', () => {
    node('entity:old')
    const res = cascadeInvalidate('entity:old', T, { mergedInto: 'entity:not-canonical' })
    expect(res.skipped).toBe(true)
    expect(res.refused).toBe('not-whitelisted')
    expect(isNodeLive('entity:old')).toBe(true) // nothing retired
  })

  it('a whitelist-sanctioned merge rekeys edges to the canonical then retires the merged-away node', () => {
    node('entity:old'); node('entity:friend')
    upsertEdge('entity:old', 'entity:friend', 'related', T)
    const res = cascadeInvalidate('entity:old', T, { mergedInto: 'project:北澜' }) // a real whitelist canonical id
    expect(res.skipped).toBe(false)
    expect(isNodeLive('entity:old')).toBe(false)
    // the edge was rewired onto the canonical id
    expect(neighborsOf('project:北澜')).toEqual(['entity:friend'])
  })

  it('barrierRepair alone is idempotent on a healthy graph (nothing to orphan)', () => {
    node('entity:p'); node('entity:c')
    upsertEdge('entity:p', 'entity:c', 'related', T)
    expect(barrierRepair(T)).toEqual([])
    expect(isNodeLive('entity:c')).toBe(true)
  })
})

describe.skipIf(!HAS_NATIVE_SQLITE)('syncGraphFromConstruction — shadow-sync (flag ON)', () => {
  let db: Database
  beforeEach(() => { setFlag(true); db = freshDb(); __setEntityGraphDbForTests(db) })
  afterEach(() => { setFlag(false); __setEntityGraphDbForTests(null); db.close() })

  it('mirrors construction node existence + entity-entity edges through the whitelist id space', () => {
    const con: ConstructedData = {
      entities: [
        { id: 'org:foo', kind: 'org', label: 'Foo Corp', note: 'n1' },
        { id: 'person:bar', kind: 'person', label: 'Bar', note: 'n1' }
      ],
      edges: [{ source: 'org:foo', target: 'person:bar', type: 'mentions' }],
      classifications: []
    }
    const res = syncGraphFromConstruction(con, T)
    expect(res.nodes).toBe(2)
    expect(isNodeLive('entity:foo-corp')).toBe(true)
    expect(neighborsOf('entity:foo-corp')).toEqual(['entity:bar'])
  })

  it('folds a live raw node the whitelist now covers (a human-confirmed merge consequence)', () => {
    // A pre-existing raw node whose label is a whitelist alias for person:theo-quill.
    upsertNode({ id: 'entity:theo-quill', kind: 'entity', label: 'theo quill' }, T)
    upsertEdge('entity:theo-quill', 'entity:friend', 'related', T)
    // Construction now carries the canonical node (as it would after resolveEntityIdentity).
    const con: ConstructedData = {
      entities: [{ id: 'person:theo-quill', kind: 'person', label: 'Theo', note: 'n1' }],
      edges: [],
      classifications: []
    }
    const res = syncGraphFromConstruction(con, T)
    expect(res.merges).toBe(1)
    expect(isNodeLive('entity:theo-quill')).toBe(false) // merged away
    expect(neighborsOf('person:theo-quill')).toEqual(['entity:friend']) // edge rewired to canonical
  })
})

// ─────────────── the 2026-08-04 memory incident: cost, not correctness ───────────────
//
// A deploy landed the cross-kind collapse, which took the alias whitelist from 14 groups to 489 in
// one pass. That made hundreds of live raw nodes foldable at once, and the fold loop called
// cascadeInvalidate per node — each of which ran barrierRepair, a to-fixpoint sweep over the WHOLE
// graph. M folds therefore cost M × O(graph): a synchronous loop that grew the working set ~450 MB
// per 15s, folded ~18 nodes per two minutes against 11,688, and had to be killed with free physical
// memory at 251 MB. Nothing about the fold was WRONG; it was unaffordable.
//
// These tests pin the two properties that make it affordable, so a future refactor that re-inlines
// the sweep fails here instead of on the operator's machine.
describe.skipIf(!HAS_NATIVE_SQLITE)('syncGraphFromConstruction — bounded, one sweep per batch', () => {
  let db: Database
  let scans: () => number

  // The exact SQL liveNodeIds issues. barrierRepair re-runs it on every iteration of its
  // `while (changed)` loop, so counting it counts full-graph scans — the thing that must not
  // scale with the number of folds.
  const LIVE_IDS_SQL = 'SELECT id FROM entity_nodes WHERE valid_to IS NULL'

  beforeEach(() => {
    setFlag(true)
    const real = freshDb()
    let n = 0
    // Count prepares without changing behaviour: every other member passes straight through.
    const counting = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql === LIVE_IDS_SQL) n++
            return target.prepare(sql)
          }
        }
        const v = Reflect.get(target, prop, receiver)
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      }
    })
    db = real
    scans = () => n
    __setEntityGraphDbForTests(counting as Database)
  })
  afterEach(() => {
    setFlag(false)
    __setEntityGraphDbForTests(null)
    delete process.env.DUIN_GRAPH_MAX_FOLDS_PER_PASS
    db.close()
  })

  const EMPTY_CON: ConstructedData = { entities: [], edges: [], classifications: [] }

  /** `count` live canonical nodes, each with one live raw node whose label the whitelist folds. */
  function seedFoldable(count: number): void {
    setActiveAliasGroups(
      Array.from({ length: count }, (_, i) => ({
        canonicalId: `org:c${i}`,
        canonical: `C${i}`,
        aliases: [`alias ${i}`]
      }))
    )
    for (let i = 0; i < count; i++) {
      upsertNode({ id: `org:c${i}`, kind: 'org', label: `C${i}` }, T) // the fold target, live
      upsertNode({ id: `entity:alias-${i}`, kind: 'entity', label: `alias ${i}` }, T) // folds onto it
    }
  }

  it('full-graph sweeps do NOT scale with the number of folds — the incident invariant', () => {
    seedFoldable(8)
    const before = scans()
    const res = syncGraphFromConstruction(EMPTY_CON, T)
    const eight = scans() - before
    expect(res.merges).toBe(8)

    // Same measurement, one fold. Pre-fix this was ~2 sweeps per fold, so eight folds cost ~8×
    // what one costs. The sweep is now hoisted, so the two are IDENTICAL.
    __setEntityGraphDbForTests(null)
    db.close()
    const real2 = freshDb()
    let m = 0
    __setEntityGraphDbForTests(new Proxy(real2, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => { if (sql === LIVE_IDS_SQL) m++; return target.prepare(sql) }
        }
        const v = Reflect.get(target, prop, receiver)
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      }
    }) as Database)
    db = real2
    seedFoldable(1)
    const m0 = m
    expect(syncGraphFromConstruction(EMPTY_CON, T).merges).toBe(1)
    expect(eight).toBe(m - m0)
  })

  it('a pass that folds nothing pays for no sweep at all', () => {
    setActiveAliasGroups([])
    upsertNode({ id: 'entity:lonely', kind: 'entity', label: 'lonely' }, T)
    const before = scans()
    const res = syncGraphFromConstruction(EMPTY_CON, T)
    expect(res.merges).toBe(0)
    // Exactly the two bookkeeping reads (idsBefore + created) and no barrierRepair sweep.
    expect(scans() - before).toBe(2)
  })

  it('caps folds per pass and reports the remainder rather than dropping it', () => {
    process.env.DUIN_GRAPH_MAX_FOLDS_PER_PASS = '3'
    seedFoldable(5)
    const first = syncGraphFromConstruction(EMPTY_CON, T)
    expect(first.merges).toBe(3)
    expect(first.deferred).toBe(2)

    // The deferred folds are re-found by the next pass's identical scan — a backlog, not a loss.
    const second = syncGraphFromConstruction(EMPTY_CON, T)
    expect(second.merges).toBe(2)
    expect(second.deferred).toBe(0)
    for (let i = 0; i < 5; i++) expect(isNodeLive(`entity:alias-${i}`)).toBe(false)
  })

  // rebuildEntityGraph purges the graph and syncs ONCE — there is no next tick to re-find a
  // deferred fold, so the throttle that is correct for the repeating tick is wrong there. If this
  // ever regresses, a rebuild silently returns a half-folded graph and reports it as finished.
  it('a one-shot caller can opt out of the cap entirely, however low the env sets it', () => {
    process.env.DUIN_GRAPH_MAX_FOLDS_PER_PASS = '1'
    seedFoldable(5)
    const res = syncGraphFromConstruction(EMPTY_CON, T, { maxFolds: Infinity })
    expect(res.merges).toBe(5) // all of them, not the env's 1
    expect(res.deferred).toBe(0) // nothing left behind for a tick that will never come
    for (let i = 0; i < 5; i++) expect(isNodeLive(`entity:alias-${i}`)).toBe(false)
  })

  it('an explicit cap still binds when one is passed', () => {
    seedFoldable(4)
    const res = syncGraphFromConstruction(EMPTY_CON, T, { maxFolds: 2 })
    expect(res.merges).toBe(2)
    expect(res.deferred).toBe(2)
  })

  it('an invalid or absent cap falls back to the default rather than folding zero', () => {
    process.env.DUIN_GRAPH_MAX_FOLDS_PER_PASS = 'not-a-number'
    seedFoldable(2)
    expect(syncGraphFromConstruction(EMPTY_CON, T).merges).toBe(2)
  })
})

describe.skipIf(!HAS_NATIVE_SQLITE)('cascadeInvalidate — deferBarrier reaches the same fixpoint', () => {
  let db: Database
  beforeEach(() => { setFlag(true); db = freshDb(); __setEntityGraphDbForTests(db) })
  afterEach(() => { setFlag(false); __setEntityGraphDbForTests(null); db.close() })

  function node(id: string): void { upsertNode({ id, kind: 'entity', label: id }, T) }

  // The paired assertion to 'a node with a SINGLE live parent is orphaned…' above: that test runs
  // the sweep inside the cascade and expects ['entity:c','entity:g']. Deferring it and sweeping
  // once afterwards must retire exactly the same set — orphanhood is monotone in the retirement
  // set, which is what makes hoisting a cost change and not a semantics change.
  it('defers the orphan walk, and one later sweep retires exactly the same nodes', () => {
    node('entity:p'); node('entity:c'); node('entity:g')
    upsertEdge('entity:p', 'entity:c', 'related', T)
    upsertEdge('entity:c', 'entity:g', 'related', T)

    const res = cascadeInvalidate('entity:p', T, { deferBarrier: true })
    expect(res.retired).toEqual(['entity:p'])
    expect(res.orphaned).toEqual([]) // deferred to the caller
    expect(isNodeLive('entity:c')).toBe(true) // not swept yet

    expect(barrierRepair(T).sort()).toEqual(['entity:c', 'entity:g']) // same fixpoint
    expect(isNodeLive('entity:g')).toBe(false)
  })

  it('the default is unchanged — an unqualified cascade still sweeps inline', () => {
    node('entity:p'); node('entity:c')
    upsertEdge('entity:p', 'entity:c', 'related', T)
    expect(cascadeInvalidate('entity:p', T).orphaned).toEqual(['entity:c'])
  })
})
