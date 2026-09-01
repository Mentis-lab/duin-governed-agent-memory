// CALL-SITE coverage for the degraded-mode fields on `rag:status`.
//
// THE GAP these tests close: 42e9eb7 added memoryFallback / memoryFallbackReason
// / memoryFallbackSince to the `rag:status` handler and justified them in the
// commit message as making degraded mode "renderable instead of looking like
// deletion". Nothing tested them, and reverting the electron/ipc/rag.ts hunk left
// the suite green — so the claim was unverified.
//
// HONEST STATUS OF THE FIELD (recorded here rather than papered over): NO
// renderer reads it. `rag:status` is exposed through preload.ts:1208
// (`status: () => ipcRenderer.invoke('rag:status')`) but has zero call sites in
// src/. That is true of the PRE-EXISTING `vecAvailable` field beside it too —
// rag:status is a read-only diagnostic channel in this repo, not a
// renderer-driven feature, and rag.test.ts already pins vecAvailable on exactly
// that basis. So the field is not dead code to delete; it is the only structured
// trace of a latch that otherwise leaves one console.warn behind while the
// Library renders an empty list indistinguishable from "your collections were
// deleted". It is machine-reachable and unpinned, which is what these tests fix.
// Making it USER-reaching is a renderer change and is deliberately not done here.
//
// POWER CONTROL: reverting the rag.ts hunk fails these tests.
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

import {
  __forceMemoryFallback as forceCollectionMemory,
  __resetCollectionStore,
  getMemoryFallbackState
} from '../services/rag/store'
import { __forceMemoryFallback as forceEventMemory, __resetEventLog } from '../services/event-log'
import { registerRagHandlers } from './rag'

function status(): Promise<any> {
  return ipcRegistered.get('rag:status')!({})
}

beforeEach(() => {
  __resetEventLog()
  forceEventMemory()
  ipcRegistered.clear()
  registerRagHandlers()
  // Reset AFTER registration: the boot-recovery block runs real store calls, and
  // with no database in the test process those latch the fallback. The handler
  // reads getMemoryFallbackState() at invoke time, so clearing the latch here
  // gives each test a known starting state without stubbing the store.
  __resetCollectionStore()
})

describe('rag:status degraded-mode fields (real handler)', () => {
  it('reports memoryFallback:false on a healthy store', async () => {
    // __resetCollectionStore clears the latch; nothing has forced it since.
    expect(getMemoryFallbackState().active).toBe(false)

    const res = await status()

    expect(res.success).toBe(true)
    expect(res.data.memoryFallback).toBe(false)
    expect(res.data.memoryFallbackReason).toBeNull()
    expect(res.data.memoryFallbackSince).toBeNull()
  })

  it('surfaces the latch, its reason and its timestamp once fallback engages', async () => {
    const before = Date.now()
    forceCollectionMemory()

    const res = await status()

    // Degraded mode is legible over IPC instead of being a single console.warn.
    expect(res.data.memoryFallback).toBe(true)
    expect(typeof res.data.memoryFallbackReason).toBe('string')
    expect(String(res.data.memoryFallbackReason).length).toBeGreaterThan(0)
    expect(typeof res.data.memoryFallbackSince).toBe('number')
    expect(res.data.memoryFallbackSince).toBeGreaterThanOrEqual(before)
  })

  it('reports the SAME state the store holds, not a recomputed guess', async () => {
    forceCollectionMemory()
    const state = getMemoryFallbackState()

    const res = await status()

    expect(res.data.memoryFallback).toBe(state.active)
    expect(res.data.memoryFallbackReason).toBe(state.reason)
    expect(res.data.memoryFallbackSince).toBe(state.since)
  })

  it('keeps the pre-existing vec fields alongside the new ones', async () => {
    const res = await status()

    // The degraded-mode fields are additive — the vec surface rag.test.ts pins
    // must still be there.
    expect(res.data).toHaveProperty('vecAvailable')
    expect(res.data).toHaveProperty('vecError')
  })
})
