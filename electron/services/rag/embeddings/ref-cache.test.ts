import { describe, expect, it, vi } from 'vitest'

import { createRefCache } from './ref-cache'

// These tests pin the ONE property the embeddings worker's model caches got
// wrong: a REJECTED load must self-evict so the same ref can be retried. Before
// the fix the worker cached the loader promise unconditionally, so a first-use
// load that rejected (offline) latched a permanently-rejected promise and every
// retry — probeModel → setActive → ensurePipeline — returned that dead promise
// and failed instantly with the ORIGINAL error until app restart.

describe('createRefCache', () => {
  it('retries the SAME ref after a rejected load (the offline-then-reconnect fix)', async () => {
    const cache = createRefCache<string>()

    // First load fails, as an offline model download would.
    const failing = vi.fn(async () => {
      throw new Error('fetch failed — offline')
    })
    await expect(cache.get('model-a', failing)).rejects.toThrow('fetch failed — offline')

    // User reconnects and retries the SAME ref. A naive cache would return the
    // cached rejected promise here and never call the second loader; the fix
    // evicts on rejection so this load actually runs and resolves.
    const succeeding = vi.fn(async () => 'loaded')
    await expect(cache.get('model-a', succeeding)).resolves.toBe('loaded')
    expect(succeeding).toHaveBeenCalledTimes(1)
  })

  it('caches a resolved load — the loader runs once per ref', async () => {
    const cache = createRefCache<string>()
    const load = vi.fn(async () => 'v')

    const a = cache.get('m', load)
    const b = cache.get('m', load)
    expect(a).toBe(b) // same in-flight promise, not a second load
    await a
    await cache.get('m', load) // still cached after resolution
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('re-loads when the ref changes', async () => {
    const cache = createRefCache<string>()
    const loadA = vi.fn(async () => 'a')
    const loadB = vi.fn(async () => 'b')

    await expect(cache.get('a', loadA)).resolves.toBe('a')
    await expect(cache.get('b', loadB)).resolves.toBe('b')
    expect(loadA).toHaveBeenCalledTimes(1)
    expect(loadB).toHaveBeenCalledTimes(1)
  })

  it('peek() reports the loaded promise and null before any load / after clear', async () => {
    const cache = createRefCache<string>()
    expect(cache.peek()).toBeNull()

    const p = cache.get('m', async () => 'x')
    expect(cache.peek()).toBe(p)
    await p

    cache.clear()
    expect(cache.peek()).toBeNull()
  })

  it('a rejection for a superseded ref does not evict the newer healthy load', async () => {
    const cache = createRefCache<string>()

    // Slow, ultimately-rejecting load for ref A.
    let rejectA!: (e: Error) => void
    const slowFailing = () =>
      new Promise<string>((_, reject) => {
        rejectA = reject
      })
    const pA = cache.get('a', slowFailing)
    pA.catch(() => {}) // avoid an unhandled rejection in the test

    // Before A settles, switch to ref B, which loads fine.
    const pB = cache.get('b', async () => 'b-loaded')
    await expect(pB).resolves.toBe('b-loaded')

    // Now A rejects. Its late failure must NOT clear B's cache entry.
    rejectA(new Error('a failed late'))
    await expect(pA).rejects.toThrow('a failed late')

    // B is still cached and healthy; peek returns it, no re-load needed.
    expect(cache.peek()).toBe(pB)
    await expect(cache.peek() as Promise<string>).resolves.toBe('b-loaded')
  })

  it('at capacity 2, alternating refs do NOT re-load (the embedder-thrash fix)', async () => {
    // The brain and a RAG collection can name different models in one chat turn, and
    // at capacity 1 every alternation was a full model load, serialized.
    let loads = 0
    const cache = createRefCache<string>(2)
    const load = (ref: string) => async (): Promise<string> => {
      loads++
      return `${ref}-loaded`
    }
    await cache.get('a', load('a'))
    await cache.get('b', load('b'))
    expect(loads).toBe(2)
    for (let i = 0; i < 5; i++) {
      await cache.get('a', load('a'))
      await cache.get('b', load('b'))
    }
    expect(loads).toBe(2)
  })

  it('evicts the LEAST recently used once a third ref arrives', async () => {
    let loads = 0
    const cache = createRefCache<string>(2)
    const load = (ref: string) => async (): Promise<string> => {
      loads++
      return `${ref}-loaded`
    }
    await cache.get('a', load('a'))
    await cache.get('b', load('b'))
    await cache.get('a', load('a')) // 'a' is now the most recent, 'b' the oldest
    await cache.get('c', load('c')) // evicts 'b'
    expect(loads).toBe(3)
    await cache.get('a', load('a')) // still resident
    expect(loads).toBe(3)
    await cache.get('b', load('b')) // was evicted
    expect(loads).toBe(4)
  })

})
