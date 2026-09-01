// CALL-SITE coverage for the RAG boot-recovery block in registerRagHandlers().
//
// THE GAP these tests close: eb174f2 added reconcileOrphanVecRows() — the repair
// that purges rag_chunk_vec rows whose chunks were cascaded away by the pre-fix
// deleteCollection — and WIRED it into the boot-recovery block in
// electron/ipc/rag.ts. store-delete-collection-vec-node.test.ts proves the
// function works (via the DeleteCollectionDeps seam over node:sqlite), but
// nothing covered the wire: deleting the `reconcileOrphanVecRows()` call from
// registerRagHandlers left 18/18 green. That call is the ONLY thing that repairs
// an already-damaged DB on disk — without it the orphan rowids survive every
// launch and keep killing the next ingest, which is precisely the "reproducing it
// every launch" half of the defect. Un-wired == un-repaired.
//
// These tests drive the REAL startup path — registerRagHandlers() itself, the
// function main.ts calls at boot. The store module is WRAPPED, not replaced
// (importOriginal), so the real repair still runs; the spy only makes the call
// observable.
//
// POWER CONTROL: deleting the reconcileOrphanVecRows() call from the boot block
// fails these tests.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcRegistered = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('electron app not available in test environment')
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      ipcRegistered.set(channel, handler)
    }
  }
}))

const reconcileSpy = vi.fn()
// Records interleaving so we can assert the repair happens on the BOOT path
// (before any handler is registered), not lazily inside some handler.
let reconciledAtRegistrationCount = -1
let reconcileShouldThrow = false

vi.mock('../services/rag/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/rag/store')>()
  return {
    ...actual,
    reconcileOrphanVecRows: (...args: unknown[]) => {
      reconcileSpy(...args)
      reconciledAtRegistrationCount = ipcRegistered.size
      if (reconcileShouldThrow) throw new Error('vec table missing')
      return (actual.reconcileOrphanVecRows as (...a: any[]) => number)(...(args as []))
    }
  }
})

import {
  __forceMemoryFallback as forceCollectionMemory,
  __resetCollectionStore
} from '../services/rag/store'
import { __forceMemoryFallback as forceEventMemory, __resetEventLog } from '../services/event-log'
import { registerRagHandlers } from './rag'

beforeEach(() => {
  __resetEventLog()
  forceEventMemory()
  __resetCollectionStore()
  forceCollectionMemory()
  ipcRegistered.clear()
  reconcileSpy.mockClear()
  reconciledAtRegistrationCount = -1
  reconcileShouldThrow = false
})

describe('registerRagHandlers boot repair (real startup path)', () => {
  it('runs reconcileOrphanVecRows() once at startup', () => {
    registerRagHandlers()

    // The repair for an already-damaged DB actually executes on the path main.ts
    // calls — not merely exported and available.
    expect(reconcileSpy).toHaveBeenCalledTimes(1)
  })

  it('runs the repair on the BOOT path, before any handler is registered', () => {
    registerRagHandlers()

    // A damaged DB must be repaired before the first ingest can reclaim a stale
    // rowid, so the call belongs in the boot block, not inside a handler.
    expect(reconciledAtRegistrationCount).toBe(0)
    expect(ipcRegistered.size).toBeGreaterThan(0)
  })

  it('calls it with no injected deps, so it repairs the REAL store', () => {
    registerRagHandlers()

    // The DeleteCollectionDeps seam is for tests only; production must hit the
    // real DB. Passing a stub here would repair nothing on disk.
    expect(reconcileSpy).toHaveBeenCalledWith()
  })

  it('is best-effort: a failing repair does not block boot or handler registration', () => {
    reconcileShouldThrow = true

    expect(() => registerRagHandlers()).not.toThrow()

    expect(reconcileSpy).toHaveBeenCalledTimes(1)
    expect(ipcRegistered.has('rag:collection:delete')).toBe(true)
    expect(ipcRegistered.has('rag:status')).toBe(true)
  })
})
