import { beforeEach, describe, expect, it, vi } from 'vitest'

// Regression guard for the DB-resident degrade-to-memory defect: a contract
// created while the DB is healthy lives in `change_contracts` but NOT in the
// in-memory mirror. When a later write fails (read-only persistence mode,
// SQLITE_FULL/IOERR, or a post-busy_timeout SQLITE_BUSY), close/waive/update
// must degrade to memory — not throw a misleading "not found" for a row the
// SELECT just returned.
//
// Unlike change-contract-store.test.ts (which forces memory fallback so
// getStoreDb() never yields a handle), this suite must keep getStoreDb()
// returning a LIVE handle whose SELECT works but whose UPDATE throws. So we
// stub `./database` with a controllable fake DB: INSERT/SELECT are backed by a
// Map; UPDATE throws once `readonly` is flipped, reproducing the exact wire
// behaviour of a DB reopened with { readonly: true }.

const h = vi.hoisted(() => {
  interface Row {
    id: string
    [k: string]: unknown
  }
  const store = new Map<string, Row>()
  const state = { readonly: false }
  const insertCols = [
    'id',
    'conversation_id',
    'correlation_id',
    'status',
    'implicit',
    'source',
    'goal',
    'acceptance_criteria_json',
    'expected_files_json',
    'non_goals_json',
    'verification_commands_json',
    'required_receipt_kinds_json',
    'created_at',
    'updated_at',
    'closed_at',
    'waiver_reason',
    'waived_by',
    'waived_at'
  ]
  const db = {
    prepare(sql: string) {
      return {
        run: (...args: unknown[]) => {
          if (/^\s*INSERT/i.test(sql)) {
            const row: Row = { id: String(args[0]) }
            insertCols.forEach((col, i) => {
              row[col] = args[i]
            })
            store.set(row.id, row)
            return { changes: 1 }
          }
          if (/^\s*UPDATE/i.test(sql)) {
            // Faithful to better-sqlite3 on a { readonly: true } handle: the
            // SELECT above succeeds, but any write .run() throws synchronously.
            if (state.readonly) {
              throw new Error('attempt to write a readonly database')
            }
            return { changes: 1 }
          }
          return { changes: 0 }
        },
        get: (...args: unknown[]) => store.get(String(args[0])),
        all: () => [...store.values()]
      }
    }
  }
  return { db, state, store }
})

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('electron app not available in test environment')
    }
  }
}))

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return { ...actual, getDb: () => h.db as unknown as ReturnType<typeof actual.getDb> }
})

import {
  __resetChangeContractStore,
  closeChangeContract,
  createChangeContract,
  getActiveChangeContract,
  getChangeContract,
  updateChangeContract,
  waiveChangeContract
} from './change-contract-store'
import { __forceMemoryFallback, __resetEventLog } from './event-log'

beforeEach(() => {
  __resetChangeContractStore()
  h.store.clear()
  h.state.readonly = false
  // Keep the event spine off the fake DB so waive() side-effects don't touch it.
  __resetEventLog()
  __forceMemoryFallback()
})

describe('change contract store — DB-resident degrade-to-memory on write failure', () => {
  it('closes a DB-resident contract when the UPDATE fails (read-only), instead of throwing "not found"', () => {
    // Created while the DB is healthy: the row lands in the fake DB only, never
    // in the in-memory mirror.
    const contract = createChangeContract({
      conversationId: 'conv-1',
      goal: 'Close me after read-only flips'
    })
    expect(h.store.has(contract.id)).toBe(true)

    // Persistence goes read-only (or the disk fills): SELECT still works, the
    // UPDATE .run() throws.
    h.state.readonly = true

    // Before the fix this threw `change contract "<id>" not found`.
    const closed = closeChangeContract(contract.id)
    expect(closed.status).toBe('closed')
    expect(closed.closedAt).toBeGreaterThan(0)

    // Cascade check: after activateFallback flips useFallback globally, reads
    // route to memory. The contract must now be visible+closed there — proving
    // the transition was preserved, not dropped.
    expect(getChangeContract(contract.id)?.status).toBe('closed')
    expect(getActiveChangeContract('conv-1')).toBeNull()
  })

  it('waives a DB-resident contract when the UPDATE fails, instead of throwing "not found"', () => {
    const contract = createChangeContract({
      conversationId: 'conv-2',
      goal: 'Waive me after read-only flips'
    })
    h.state.readonly = true

    const waived = waiveChangeContract({
      id: contract.id,
      reason: 'manual smoke covered this',
      waivedBy: 'user'
    })
    expect(waived.status).toBe('waived')
    expect(waived.waiverReason).toBe('manual smoke covered this')
    expect(getChangeContract(contract.id)?.status).toBe('waived')
  })

  it('updates a DB-resident contract when the UPDATE fails, instead of throwing "not found"', () => {
    const contract = createChangeContract({
      conversationId: 'conv-3',
      goal: 'Original goal'
    })
    h.state.readonly = true

    const updated = updateChangeContract(contract.id, { goal: 'Revised goal' })
    expect(updated.goal).toBe('Revised goal')
    expect(getChangeContract(contract.id)?.goal).toBe('Revised goal')
  })
})
