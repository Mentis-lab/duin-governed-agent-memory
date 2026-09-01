// entity-graph-rebuild — the missing DELETE path for the persistent entity graph.
//
// `entity-graph-store` is RETIRE-NOT-DELETE by design, and that is right for incremental identity
// work: a merge or a removal must stay reversible. But it left the table with no way to ever shed
// anything, so every defect the graph accumulated is permanent. Measured 2026-07-31: 3,999 of 6,124
// nodes still carry the generic `entity` kind and `entity_edges` holds 701 distinct types — both
// WORSE than when first measured, because the polluter was fixed (7f6f7bc, 067ebc3) but the junk it
// had already written was frozen and the table kept growing around it.
//
// The construction layer is now clean (0% generic kind, 0 duplicate labels), so the input needed to
// rebuild correctly finally exists. This is the drain.
//
// THREE GUARDS, because a rebuild is the one operation here that can destroy operator state:
//
//  1. REFUSE ON A THIN CONSTRUCTION. Purging and re-syncing from an empty or barely-populated
//     construction blanks the graph. The whole failure mode this campaign spent a night on was a
//     stale construction that looked healthy, so "the input is present" is not assumed — it is
//     required to be non-trivial, and to be at least as rich as `minEntities`.
//  2. BACK UP FIRST. The gap map's own words: the graph "is in no backup". A destructive path
//     without one is how a rebuild becomes an incident. The snapshot is written before the DELETE
//     and its path is returned, so a bad rebuild is recoverable by hand.
//  3. RE-APPLY OPERATOR TOMBSTONES LAST. The graph holds operator deletions that exist nowhere
//     else, and a naive rebuild silently reverses them — the specific hazard the gap map names.
//     `reapplyNodeTombstones` is the same mechanism the metabolism tick already uses after its own
//     upserts, so this reuses the owner of that concept rather than re-deriving it.
//
// Operator-triggered ONLY (POST /state/graph/rebuild). Never called from a tick: a destructive
// rebuild on a timer is exactly the kind of unattended machinery the constitution's property 7
// warns about.

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import type { Database } from 'better-sqlite3'
import { getDb, withWriteRetry } from '../database'
import { getResolvedConstruction } from './construct'
import { syncGraphFromConstruction, entityGraphEnabled } from './entity-graph-relink'
import { reapplyNodeTombstones } from './node-tombstones'
import { brainRootPath } from './brain-root'

export interface GraphRebuildResult {
  ok: boolean
  reason?: 'graph-disabled' | 'thin-construction' | 'backup-failed' | 'error'
  detail?: string
  backupPath?: string
  before?: { nodes: number; edges: number; genericKind: number; edgeTypes: number }
  after?: { nodes: number; edges: number; genericKind: number; edgeTypes: number }
  tombstonesReapplied?: number
}

/** Node/edge shape counts — the numbers the gap table is written in. */
function snapshotCounts(db: Database): { nodes: number; edges: number; genericKind: number; edgeTypes: number } {
  const one = (sql: string): number => {
    try {
      return Number((db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0)
    } catch {
      return 0
    }
  }
  return {
    nodes: one('SELECT COUNT(*) AS n FROM entity_nodes'),
    edges: one('SELECT COUNT(*) AS n FROM entity_edges'),
    genericKind: one("SELECT COUNT(*) AS n FROM entity_nodes WHERE kind = 'entity'"),
    edgeTypes: one('SELECT COUNT(DISTINCT type) AS n FROM entity_edges')
  }
}

/** Dump both tables to a timestamped JSON snapshot under `.brain/_backups/`. Returns its path. */
function backupGraph(db: Database, vaultDir: string | null, stamp: string): string | null {
  const root = brainRootPath(vaultDir)
  if (!root) return null
  const p = join(root, '_backups', `entity-graph-${stamp}.json`)
  try {
    const nodes = db.prepare('SELECT * FROM entity_nodes').all()
    const edges = db.prepare('SELECT * FROM entity_edges').all()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ takenAt: new Date().toISOString(), nodes, edges }), 'utf-8')
    return existsSync(p) ? p : null
  } catch {
    return null
  }
}

/**
 * Purge the entity graph and rebuild it from the current construction.
 *
 * `minEntities` is the thin-construction floor. It defaults deliberately high relative to a fresh
 * vault: the cost of refusing a legitimate rebuild is one error message, and the cost of accepting
 * an illegitimate one is the operator's graph.
 */
export function rebuildEntityGraph(
  vaultDir: string | null,
  opts: { minEntities?: number; stamp?: string } = {}
): GraphRebuildResult {
  if (!entityGraphEnabled()) {
    return { ok: false, reason: 'graph-disabled', detail: 'DUIN_ENTITY_GRAPH is off; nothing to rebuild.' }
  }
  const minEntities = opts.minEntities ?? 50
  const construction = getResolvedConstruction()
  const entityCount = construction?.entities?.length ?? 0
  if (entityCount < minEntities) {
    return {
      ok: false,
      reason: 'thin-construction',
      detail:
        `construction holds ${entityCount} entities (< ${minEntities}); refusing to rebuild. ` +
        'A purge re-synced from a thin construction blanks the graph — build the construction first.'
    }
  }

  let db: Database
  try {
    db = getDb() as unknown as Database
  } catch (e) {
    return { ok: false, reason: 'error', detail: (e as Error)?.message ?? 'no database' }
  }

  const before = snapshotCounts(db)
  const stamp = opts.stamp ?? new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = backupGraph(db, vaultDir, stamp)
  if (!backupPath) {
    return {
      ok: false,
      reason: 'backup-failed',
      detail: 'could not write the pre-rebuild snapshot; refusing to purge an unbacked graph.'
    }
  }

  try {
    withWriteRetry(() => {
      db.exec('DELETE FROM entity_edges')
      db.exec('DELETE FROM entity_nodes')
    })
  } catch (e) {
    return { ok: false, reason: 'error', detail: `purge failed: ${(e as Error)?.message}`, backupPath, before }
  }

  // UNBOUNDED, deliberately. The per-pass fold cap is a throttle for the REPEATING metabolism tick,
  // where a deferred fold is re-found 15 minutes later. This path purged the graph one line above and
  // syncs exactly once, so a cap here would leave the rebuild half-folded with nothing to drain the
  // rest — and the `after` counts below would report that partial state as the finished rebuild.
  syncGraphFromConstruction(construction, undefined, { maxFolds: Infinity })
  // LAST, for the same reason the metabolism tick does it last: the sync above upserts nodes, so
  // this is the point at which an operator deletion could have been resurrected.
  const tombstonesReapplied = reapplyNodeTombstones(vaultDir)

  return { ok: true, backupPath, before, after: snapshotCounts(db), tombstonesReapplied }
}
