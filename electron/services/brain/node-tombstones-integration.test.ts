import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import BetterSqlite3, { type Database } from 'better-sqlite3'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// The operator-deletion guard, END TO END against real SQL.
//
// Both halves were already tested — and each against a MOCK of the other. `node-tombstones.test.ts`
// exercises the ledger with `entity-graph-store` mocked; `entity-graph-rebuild.test.ts` exercises
// the rebuild with `node-tombstones` mocked, proving only that the call happens LAST. So the thing
// the gap map actually warns about — "the graph holds one operator deletion that exists nowhere
// else, and a rebuild would silently reverse it" — was never demonstrated to be prevented. Every
// component correct, nobody owning the seam, which is this codebase's signature failure.
//
// When the live rebuild ran on 2026-07-31 it reported `tombstonesReapplied: 0` and the single
// retired node was not resurrected — but only because it was a junk `entity:` row the clean
// construction no longer produces. The guard was never exercised. This exercises it.

vi.mock('electron', () => ({
  app: { getPath: () => { throw new Error('electron app not available in test environment') } },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { ENTITY_GRAPH_SCHEMA_SQL } from './brain-schema'
import { __setEntityGraphDbForTests, upsertNode, isNodeLive, retireNode } from './entity-graph-store'
import { recordNodeTombstone, reapplyNodeTombstones, readTombstones } from './node-tombstones'

// better-sqlite3's native binding is built for the ELECTRON ABI; probe once and skip (never fail)
// when a plain-node vitest run cannot load it.
const HAS_NATIVE_SQLITE: boolean = (() => {
  try { new BetterSqlite3(':memory:').close(); return true } catch { return false }
})()

const T = '2026-08-01T00:00:00.000Z'

describe.skipIf(!HAS_NATIVE_SQLITE)('operator deletions survive a rebuild (real store + real ledger)', () => {
  let db: Database
  let vault: string

  beforeEach(() => {
    db = new BetterSqlite3(':memory:')
    db.exec(ENTITY_GRAPH_SCHEMA_SQL)
    __setEntityGraphDbForTests(db)
    vault = mkdtempSync(join(tmpdir(), 'tombstone-int-'))
  })
  afterEach(() => {
    __setEntityGraphDbForTests(null)
    db.close()
    rmSync(vault, { recursive: true, force: true })
  })

  // THE hazard, reproduced: the operator deletes a node that construction STILL EXTRACTS. A rebuild
  // re-syncs it from construction — genuinely resurrecting it — and the tombstone must put it back
  // in the ground. The live run never hit this because its one retired node was junk construction
  // no longer produces.
  it('re-retires a node the rebuild resurrected from construction', () => {
    upsertNode({ id: 'org:acme', kind: 'org', label: 'Acme' }, T, 'construction')
    retireNode('org:acme', T) // the operator deletes it
    expect(recordNodeTombstone(vault, 'org:acme', 'Acme')).toBe(true)
    expect(isNodeLive('org:acme')).toBe(false)

    // A rebuild purges and re-syncs. Construction still extracts Acme, so the node comes back LIVE
    // with valid_to cleared — this is the silent reversal the gap map names.
    db.exec('DELETE FROM entity_nodes')
    upsertNode({ id: 'org:acme', kind: 'org', label: 'Acme' }, T, 'construction')
    expect(isNodeLive('org:acme')).toBe(true) // resurrected, as feared

    const reapplied = reapplyNodeTombstones(vault)

    expect(reapplied).toBe(1)
    expect(isNodeLive('org:acme')).toBe(false) // the operator's deletion held
  })

  it('does not re-retire anything when the deletion was already honoured', () => {
    upsertNode({ id: 'org:acme', kind: 'org', label: 'Acme' }, T, 'construction')
    retireNode('org:acme', T)
    recordNodeTombstone(vault, 'org:acme', 'Acme')

    // A rebuild whose construction NO LONGER produces the node: it simply never comes back.
    db.exec('DELETE FROM entity_nodes')

    expect(reapplyNodeTombstones(vault)).toBe(0)
    expect(isNodeLive('org:acme')).toBe(false)
  })

  it('survives repeated rebuilds — the deletion is durable, not one-shot', () => {
    upsertNode({ id: 'org:acme', kind: 'org', label: 'Acme' }, T, 'construction')
    retireNode('org:acme', T)
    recordNodeTombstone(vault, 'org:acme', 'Acme')

    for (let i = 0; i < 3; i++) {
      db.exec('DELETE FROM entity_nodes')
      upsertNode({ id: 'org:acme', kind: 'org', label: 'Acme' }, T, 'construction')
      expect(reapplyNodeTombstones(vault)).toBe(1)
      expect(isNodeLive('org:acme')).toBe(false)
    }
    // And the ledger did not grow: re-applying is not re-recording.
    expect(readTombstones(vault)).toHaveLength(1)
  })

  it('holds several deletions at once', () => {
    for (const id of ['org:a', 'org:b', 'org:c']) {
      upsertNode({ id, kind: 'org', label: id }, T, 'construction')
      retireNode(id, T)
      recordNodeTombstone(vault, id)
    }
    db.exec('DELETE FROM entity_nodes')
    for (const id of ['org:a', 'org:b', 'org:c']) upsertNode({ id, kind: 'org', label: id }, T, 'construction')

    expect(reapplyNodeTombstones(vault)).toBe(3)
    for (const id of ['org:a', 'org:b', 'org:c']) expect(isNodeLive(id)).toBe(false)
  })

  // The ledger is the only durable record of the deletion — the graph row itself is purged by a
  // rebuild. If the journal write silently failed, the deletion would be lost with no signal.
  it('reports a failed journal write rather than returning a false success', () => {
    expect(recordNodeTombstone(null, 'org:acme')).toBe(false)
    expect(recordNodeTombstone(vault, '   ')).toBe(false)
  })
})
