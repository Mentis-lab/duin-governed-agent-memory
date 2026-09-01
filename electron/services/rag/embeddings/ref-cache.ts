// ref-cache.ts — a ref-keyed async memo for the embeddings worker's lazily-loaded
// models (embedder pipeline, reranker, NLI). Load a heavy model ONCE per ref and
// reuse the resulting promise; a change of ref re-loads.
//
// Extracted from worker.ts — which reads `process.parentPort` and registers a
// message listener at import time and therefore cannot be imported under vitest —
// so the contract below can actually be tested.
//
// THE CONTRACT THAT MATTERS: a REJECTED load must NOT stay cached. The original
// inline caches did `if (p && ref === last) return p` and assigned the loader
// promise unconditionally, so a load that rejected (e.g. the model download failed
// while offline) left behind a permanently-rejected promise with the ref still
// latched. Every later call for the same ref returned that dead promise, so the
// documented retry path (service.probeModel clears downloadFailure → setActive
// re-sends `load` → worker ensurePipeline) failed INSTANTLY with the original
// offline error and the worker stayed broken until app restart. The defect was
// invisible because on the happy path a resolved-and-cached promise and a
// rejected-and-cached promise are structurally identical — you only see the
// difference on the retry after a failure. Self-eviction on rejection is the fix.

export interface RefCache<T> {
  /** Return the cached promise for `ref`, or run `load()` and cache it. A
   *  rejection self-evicts, so the NEXT call for that ref re-runs `load`. */
  get(ref: string, load: () => Promise<T>): Promise<T>
  /** The currently-cached promise (resolved or in-flight), or null if nothing is
   *  loaded. With capacity > 1 this is the MOST RECENTLY used entry. */
  peek(): Promise<T> | null
  /** Drop the cache (worker `dispose`). */
  clear(): void
}

/**
 * @param capacity how many refs stay resident. Default 1 — one model at a time,
 *   which is right for the reranker and NLI caches (one model each, no alternation).
 *
 *   The EMBEDDER pipeline needs more than one. Its consumers no longer share a single
 *   process-global embedder: the brain names its own index's model and the RAG library
 *   names each collection's stamp, which is what stops them silently writing into each
 *   other's embedding space. The cost of that correctness is alternation — a chat turn
 *   that grounds from the brain AND augments from a differently-stamped collection asks
 *   for two models — and at capacity 1 each alternation is a full model load (seconds),
 *   serialized, on every turn. Holding both resident makes the correct behaviour also
 *   the fast one. LRU, so a third model evicts rather than growing without bound.
 */
export function createRefCache<T>(capacity = 1): RefCache<T> {
  const cap = Math.max(1, capacity)
  // Insertion order IS the LRU order: oldest first, and a hit re-inserts to refresh it.
  const entries = new Map<string, Promise<T>>()
  return {
    get(ref, load) {
      const hit = entries.get(ref)
      if (hit) {
        entries.delete(ref)
        entries.set(ref, hit)
        return hit
      }
      const loading = load()
      entries.set(ref, loading)
      while (entries.size > cap) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
      // Self-evict on rejection so a failed load can be retried with the SAME
      // ref. Guard on identity: a later get() for a different ref may have already
      // replaced `cached`; only evict if THIS promise is still the cached one, so
      // we never clobber a newer, healthy load. The empty catch here does not
      // swallow the error for the caller — `loading` is returned unchanged and
      // still rejects for whoever awaits it; this handler only manages the cache.
      loading.catch(() => {
        if (entries.get(ref) === loading) entries.delete(ref)
      })
      return loading
    },
    peek() {
      let last: Promise<T> | null = null
      for (const v of entries.values()) last = v
      return last
    },
    clear() {
      entries.clear()
    }
  }
}
