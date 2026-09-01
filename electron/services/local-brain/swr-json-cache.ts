// Stale-while-revalidate cache for the expensive derived-graph JSON.
//
// The graph routes already had a memo with a content-derived key
// (`vault:nativeGraphMtime(vault)`), which is the hard part and it was correct.
// Two things around it were not:
//
//   1. The memo lived in a module-level variable, so every launch started empty
//      and the first request paid the full rebuild with no window on screen.
//   2. A 30s TTL discarded entries the key said were still valid. The TTL was
//      there to backstop an in-place nested edit that a directory mtime alone
//      would miss, but it made the rebuild recur every 30 seconds of idle. So
//      the stall was not a cold-start cost; it was an all-day cost.
//
// Measured on the live dogfood vault against the running app, /state/brain-graph
// (1.54MB): 3347ms cold, 8-33ms while warm, and 1762ms again after 35s of idle
// versus 9ms after 10s — the TTL boundary, reproduced. /graph was checked the same
// way and rebuilt in 71ms after expiry, which is why only this route got the
// surgery. Scripts: Documents/duin/perf-bench/{ttl,bench,sweep}.py.
//
// This keeps the backstop and drops the waiting. A request is served from
// whatever we have, immediately; if the key moved or the entry is old enough to
// be worth re-checking, the rebuild is scheduled instead of awaited. The only
// request that blocks is the very first one on a machine with no cache file.
//
// The tradeoff is explicit within one ownership scope: a request that arrives
// just after the graph key changed gets the previous graph while the new one is
// built. Scope changes are never stale-served; they block on the first build so
// bytes from one operator vault cannot cross into another.
//
// THE INVARIANT: a caller minting an ETag must read the key off the RESULT, not
// off its own request. On a stale serve those are different keys, and using the
// request's would file the previous graph under the current graph's identity —
// the client caches the old body under the new name, then gets told 304 for it
// on every subsequent request. `SwrResult.servedKey` exists to make that
// impossible to get wrong.
//
// A related subtlety, recorded because it invites a plausible wrong "fix": an
// entry is labelled with the key sampled BEFORE its build, never after. The
// vault can move mid-build, so a post-build key would claim the bytes are
// current when they may be a torn read spanning the change — and since the key
// then matches, nothing would ever rebuild it. Sampling first under-claims
// instead: the next request sees a mismatch and rebuilds. Stale-but-converging
// beats fresh-looking-but-wrong.

export interface SwrEntry {
  key: string
  json: string
  builtAt: number
  /** Ownership boundary for persisted entries. Callers that provide a scope
   * never receive an entry written for another scope, even when its key is stale. */
  scope?: string
}

export interface SwrJsonCacheOptions {
  /**
   * How old an entry may get before a request also triggers a rebuild. This is
   * the missed-invalidation backstop, NOT the correctness mechanism — the key
   * is. It can therefore be generous; the cost of it being long is only that a
   * change no key input reflects takes longer to appear.
   */
  revalidateAfterMs: number
  /** Injected for tests. */
  now?: () => number
  /** Injected for tests; defaults to a macrotask so a rebuild never runs inside the request. */
  schedule?: (fn: () => void) => void
  /** Persistence hooks. Omit for a memory-only cache. */
  readDisk?: () => SwrEntry | null
  writeDisk?: (entry: SwrEntry) => void
  deleteDisk?: () => void
}

export interface SwrResult {
  json: string
  /**
   * The key of the entry actually returned. On a stale serve this is the OLD
   * key, not the one asked for — callers minting an ETag must use this, or they
   * would label the previous graph with the current graph's identity and hand
   * the client a 304 for a body it never received.
   */
  servedKey: string
  /** True when what we returned did not match the requested key, or was past revalidate age. */
  stale: boolean
  /** True when this call had to build synchronously (nothing was cached at all). */
  blocked: boolean
}

export interface SwrGetOptions {
  /** Optional ownership boundary, such as an absolute vault path. A mismatch
   * is a cache miss, not ordinary stale-while-revalidate. */
  scope?: string
}

export class SwrJsonCache {
  private entry: SwrEntry | null = null
  private rebuilding = false
  private generation = 0
  private skipDiskHydration = false
  private readonly opts: SwrJsonCacheOptions

  constructor(opts: SwrJsonCacheOptions) {
    this.opts = opts
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  private schedule(fn: () => void): void {
    if (this.opts.schedule) {
      this.opts.schedule(fn)
      return
    }
    setTimeout(fn, 0).unref?.()
  }

  /**
   * Pull the persisted entry in. Deliberately lazy rather than done at
   * construction: the cache is a module singleton and the userData path is
   * wired later in boot, so reading at construction would read from nowhere.
   *
   * "Do we already hold something" is the whole guard — there is no once-only
   * flag. A read that comes back empty because the path is not wired yet should
   * be retried, not remembered, or the persisted entry would be dropped for the
   * life of the process and the cold start would return one boot later. Holding
   * an entry is what stops the retrying, and `get` always leaves one behind.
   */
  private hydrateFromDisk(): void {
    if (this.entry || this.skipDiskHydration || !this.opts.readDisk) return
    try {
      const loaded = this.opts.readDisk()
      if (loaded && typeof loaded.json === 'string' && typeof loaded.key === 'string') {
        this.entry = loaded
      }
    } catch {
      /* a corrupt or absent cache file is not an error — we just rebuild */
    }
  }

  private persist(entry: SwrEntry): void {
    if (!this.opts.writeDisk) return
    try {
      this.opts.writeDisk(entry)
    } catch {
      /* best-effort: failing to persist costs us the next cold start, nothing more */
    }
  }

  private store(key: string, json: string, scope?: string): SwrEntry {
    const entry: SwrEntry = { key, json, builtAt: this.now(), scope }
    this.entry = entry
    this.skipDiskHydration = false
    this.persist(entry)
    return entry
  }

  /**
   * One rebuild at a time. A second request arriving mid-rebuild is dropped
   * rather than queued: it would build the same thing, and if the vault moved
   * again the first request after this one lands schedules a fresh rebuild.
   */
  private rebuild(key: string, build: () => string, scope?: string): void {
    if (this.rebuilding) return
    this.rebuilding = true
    const generation = this.generation
    this.schedule(() => {
      try {
        const json = build()
        if (generation === this.generation) this.store(key, json, scope)
      } catch {
        /* keep serving the previous entry; the next request schedules another try */
      } finally {
        if (generation === this.generation) this.rebuilding = false
      }
    })
  }

  private discardEntry(): void {
    this.generation++
    this.entry = null
    this.rebuilding = false
    // Do not immediately rehydrate the entry this call invalidated if disk
    // removal fails. The next successful build persists the new scope.
    this.skipDiskHydration = true
    try {
      this.opts.deleteDisk?.()
    } catch {
      /* best-effort: current-process correctness is enforced by skipDiskHydration */
    }
  }

  /** Drop memory and persisted state when the cache's ownership scope changes. */
  invalidate(): void {
    this.discardEntry()
  }

  get(key: string, build: () => string, options: SwrGetOptions = {}): SwrResult {
    this.hydrateFromDisk()

    // A key mismatch within one vault is ordinary staleness and may be served
    // while revalidating. A scope mismatch is different: the cached bytes may
    // belong to another operator vault, so discard them and block on this
    // scope's first build. This also rejects legacy persisted entries that do
    // not identify their scope.
    if (this.entry && options.scope !== undefined && this.entry.scope !== options.scope) {
      this.discardEntry()
    }

    if (!this.entry) {
      // Nothing anywhere. This is the one path that makes the caller wait, and
      // it happens once per machine rather than once per launch.
      const entry = this.store(key, build(), options.scope)
      return { json: entry.json, servedKey: entry.key, stale: false, blocked: true }
    }

    const matches = this.entry.key === key
    const fresh = this.now() - this.entry.builtAt < this.opts.revalidateAfterMs
    if (matches && fresh) {
      return { json: this.entry.json, servedKey: this.entry.key, stale: false, blocked: false }
    }

    this.rebuild(key, build, options.scope)
    return { json: this.entry.json, servedKey: this.entry.key, stale: true, blocked: false }
  }

  /** Test seam. */
  primeForTest(entry: SwrEntry | null): void {
    this.entry = entry
    this.skipDiskHydration = false
  }
}
