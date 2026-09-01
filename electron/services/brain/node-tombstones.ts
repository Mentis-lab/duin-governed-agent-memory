// NODE TOMBSTONES — the operator's graph deletions, kept where they survive.
//
// Phase 1.5 of PLANNING/DUIN_GAP_BRIDGE_PLAN.md, and a constitution property-2
// violation: "what is earned is never derived away."
//
// `POST /state/node/delete` stamped `valid_to` on `entity_nodes` and wrote nowhere
// else. That table has no rebuild path, is absent from `DURABLE_TABLES`, and is
// absent from `moat-backup`'s sources — so a retirement lived in exactly one place
// and a rebuild or reinstall would silently resurrect the node. Deleting a junk
// node is a pure operator judgement: nothing can recompute it, which is precisely
// the class of state the Vault side of `.duin/_state/` exists to hold.
//
// The ledger has a READER, deliberately. A tombstone file nobody replays is
// WRITTEN_NEVER_READ — the same defect one level over — so `reapplyNodeTombstones`
// runs on the metabolism tick and re-retires anything that came back.

import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'fs'
import { join, dirname } from 'path'
import { isNodeLive, retireNode } from './entity-graph-store'

export interface NodeTombstone {
  /** Graph node id that the operator retired. */
  id: string
  /** Label at the time of retirement — for a human reading the ledger. */
  label?: string
  /** ISO timestamp of the retirement. */
  at: string
}

/** Ledger path for a vault, or null when no vault is configured. */
export function tombstonePath(vaultDir: string | null | undefined): string | null {
  if (typeof vaultDir !== 'string' || !vaultDir.trim()) return null
  return join(vaultDir, '.duin', '_state', 'node-tombstones.jsonl')
}

/** PURE: parse a ledger body, skipping malformed lines rather than throwing. */
export function parseTombstones(body: string): NodeTombstone[] {
  const out: NodeTombstone[] = []
  for (const line of (body || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t) as NodeTombstone
      if (o && typeof o.id === 'string' && o.id.trim()) out.push(o)
    } catch {
      // A truncated final line (crash mid-append) must not poison the whole ledger.
    }
  }
  return out
}

export function readTombstones(vaultDir: string | null | undefined): NodeTombstone[] {
  const p = tombstonePath(vaultDir)
  if (!p || !existsSync(p)) return []
  try {
    return parseTombstones(readFileSync(p, 'utf8'))
  } catch {
    return []
  }
}

/** Append one retirement. Best-effort: the graph write is the operator's action, and
 *  failing to journal it must not make a successful deletion look like an error. */
export function recordNodeTombstone(
  vaultDir: string | null | undefined,
  id: string,
  label?: string
): boolean {
  const p = tombstonePath(vaultDir)
  const trimmed = (id ?? '').trim()
  if (!p || !trimmed) return false
  try {
    mkdirSync(dirname(p), { recursive: true })
    const row: NodeTombstone = {
      id: trimmed,
      ...(label && label.trim() ? { label: label.trim() } : {}),
      at: new Date().toISOString()
    }
    appendFileSync(p, `${JSON.stringify(row)}\n`, 'utf8')
    return true
  } catch (err) {
    console.warn('[node-tombstones] append failed (non-fatal):', (err as Error)?.message)
    return false
  }
}

/**
 * Re-retire any tombstoned node that is live again. Returns how many were
 * re-applied — normally 0, and a non-zero result means something resurrected an
 * operator deletion (a rebuild, a restore, or a re-observation path that does not
 * preserve `valid_to`).
 *
 * This is what stops the ledger being write-only.
 */
export function reapplyNodeTombstones(vaultDir: string | null | undefined): number {
  const stones = readTombstones(vaultDir)
  if (stones.length === 0) return 0
  const now = new Date().toISOString()
  let reapplied = 0
  for (const s of stones) {
    try {
      if (!isNodeLive(s.id)) continue
      retireNode(s.id, now)
      reapplied++
    } catch {
      // Best-effort per id; a store error must never break the caller's tick.
    }
  }
  if (reapplied > 0) {
    console.warn(
      `[node-tombstones] re-retired ${reapplied} node(s) the operator had deleted — ` +
        'something resurrected them.'
    )
  }
  return reapplied
}
