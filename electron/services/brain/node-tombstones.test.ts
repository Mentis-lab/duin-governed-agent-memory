import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Phase 1.5 of PLANNING/DUIN_GAP_BRIDGE_PLAN.md — constitution property 2.
//
// `POST /state/node/delete` stamped valid_to on entity_nodes and wrote nowhere
// else. That table has no rebuild path, is absent from DURABLE_TABLES, and is
// absent from moat-backup — so the operator's deletion lived in exactly one place
// and a rebuild would silently resurrect it. Nothing can recompute a judgement
// like "this node is garbage."

const live = vi.hoisted(() => new Set<string>())
const retired = vi.hoisted(() => [] as string[])

vi.mock('./entity-graph-store', () => ({
  isNodeLive: (id: string) => live.has(id),
  retireNode: (id: string) => {
    live.delete(id)
    retired.push(id)
  }
}))

import {
  recordNodeTombstone,
  readTombstones,
  reapplyNodeTombstones,
  parseTombstones,
  tombstonePath
} from './node-tombstones'

let vault: string

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-tombstone-'))
  live.clear()
  retired.length = 0
})

describe('the ledger', () => {
  it('round-trips a retirement', () => {
    expect(recordNodeTombstone(vault, 'entity:decided', 'decided')).toBe(true)
    const stones = readTombstones(vault)
    expect(stones).toHaveLength(1)
    expect(stones[0]).toMatchObject({ id: 'entity:decided', label: 'decided' })
    expect(typeof stones[0].at).toBe('string')
    expect(existsSync(tombstonePath(vault)!)).toBe(true)
  })

  it('appends rather than replacing', () => {
    recordNodeTombstone(vault, 'entity:a')
    recordNodeTombstone(vault, 'entity:b')
    expect(readTombstones(vault).map((s) => s.id)).toEqual(['entity:a', 'entity:b'])
  })

  it('is a no-op without a vault or an id', () => {
    expect(recordNodeTombstone(null, 'entity:a')).toBe(false)
    expect(recordNodeTombstone(vault, '   ')).toBe(false)
    expect(tombstonePath(null)).toBeNull()
    expect(readTombstones(null)).toEqual([])
  })

  it('survives a truncated final line', () => {
    // A crash mid-append must not poison the whole ledger.
    const body = '{"id":"entity:a","at":"2026-07-30T00:00:00Z"}\n{"id":"entity:b","at'
    expect(parseTombstones(body).map((s) => s.id)).toEqual(['entity:a'])
  })

  it('ignores rows with no usable id', () => {
    expect(parseTombstones('{"at":"x"}\n{"id":"   "}\n{"id":"ok","at":"y"}')).toHaveLength(1)
  })
})

describe('reapply — what keeps this from being a write-only file', () => {
  it('re-retires a tombstoned node that came back', () => {
    recordNodeTombstone(vault, 'entity:decided')
    live.add('entity:decided') // a rebuild resurrected it
    expect(reapplyNodeTombstones(vault)).toBe(1)
    expect(retired).toEqual(['entity:decided'])
    expect(live.has('entity:decided')).toBe(false)
  })

  it('does nothing when the deletions are still honoured', () => {
    recordNodeTombstone(vault, 'entity:decided')
    expect(reapplyNodeTombstones(vault)).toBe(0)
    expect(retired).toEqual([])
  })

  it('is a cheap no-op with an empty or missing ledger', () => {
    expect(reapplyNodeTombstones(vault)).toBe(0)
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    writeFileSync(tombstonePath(vault)!, '', 'utf8')
    expect(reapplyNodeTombstones(vault)).toBe(0)
  })

  it('keeps going when one id fails', () => {
    recordNodeTombstone(vault, 'entity:a')
    recordNodeTombstone(vault, 'entity:b')
    live.add('entity:a')
    live.add('entity:b')
    expect(reapplyNodeTombstones(vault)).toBe(2)
    expect(retired.sort()).toEqual(['entity:a', 'entity:b'])
  })
})
