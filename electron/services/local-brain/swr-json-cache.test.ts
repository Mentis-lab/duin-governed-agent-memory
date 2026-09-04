// The gap this closes: SwrJsonCache is what stands between the operator and a
// full derived-graph rebuild on the request path, and every way it can go wrong
// is silent. A stale serve that reports the wrong key produces a WRONG PAGE, not
// a slow one — the /state/brain-graph route mints its ETag from the key, so a
// result that claims the requested key while carrying the previous body makes
// the client cache the old graph under the new name and then take a 304 for it
// on every later request. It never recovers on its own. Nothing in the suite
// exercised this file before; the route it serves has no behavioural test at
// all (server-load.test.ts only asserts the module evaluates).
//
// POWER CONTROL: revert `servedKey` in get() to the requested `key` and
// "a stale serve reports the key it actually served" fails. Move the disk read
// into the constructor and "reads the disk entry lazily" fails.

import { describe, it, expect } from 'vitest'
import { SwrJsonCache, type SwrEntry } from './swr-json-cache'

const NOW = 1800000000000 // fixed clock; never Date.now() in assertions
const REVALIDATE_MS = 60_000

/** Holds the scheduled rebuilds so a test decides when — and whether — they run. */
function manualScheduler(): {
  schedule: (fn: () => void) => void
  run: () => number
  pending: () => number
} {
  const queue: Array<() => void> = []
  return {
    schedule: (fn: () => void): void => {
      queue.push(fn)
    },
    run: (): number => {
      const n = queue.length
      while (queue.length) queue.shift()!()
      return n
    },
    pending: (): number => queue.length
  }
}

function makeCache(
  opts: {
    now?: () => number
    readDisk?: () => SwrEntry | null
    writeDisk?: (e: SwrEntry) => void
    deleteDisk?: () => void
    minRebuildIntervalMs?: number
  } = {}
): { cache: SwrJsonCache; run: () => number; pending: () => number } {
  const sched = manualScheduler()
  const cache = new SwrJsonCache({
    revalidateAfterMs: REVALIDATE_MS,
    minRebuildIntervalMs: opts.minRebuildIntervalMs,
    now: opts.now ?? ((): number => NOW),
    schedule: sched.schedule,
    readDisk: opts.readDisk,
    writeDisk: opts.writeDisk,
    deleteDisk: opts.deleteDisk
  })
  return { cache, run: sched.run, pending: sched.pending }
}

describe('SwrJsonCache', () => {
  it('blocks only when nothing is cached anywhere, and reports that it blocked', () => {
    const { cache } = makeCache()
    let builds = 0
    const r = cache.get('k1', () => {
      builds++
      return '{"v":1}'
    })
    expect(r).toEqual({ json: '{"v":1}', servedKey: 'k1', stale: false, blocked: true })
    expect(builds).toBe(1)

    // Second request for the same key is a straight memo hit — no build, no wait.
    const r2 = cache.get('k1', () => {
      builds++
      return '{"v":2}'
    })
    expect(r2).toEqual({ json: '{"v":1}', servedKey: 'k1', stale: false, blocked: false })
    expect(builds).toBe(1)
  })

  it('a stale serve reports the key it actually served, not the one asked for', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. The caller turns servedKey into an
    // ETag; if this returns 'k2' while handing back k1's body, the client caches
    // the old graph under the new graph's identity and is then 304'd into it
    // permanently.
    const { cache, run } = makeCache()
    cache.get('k1', () => '{"v":1}')

    const stale = cache.get('k2', () => '{"v":2}')
    expect(stale.json).toBe('{"v":1}')
    expect(stale.servedKey).toBe('k1')
    expect(stale.stale).toBe(true)
    expect(stale.blocked).toBe(false)

    // The rebuild was scheduled, not awaited — and once it lands the next
    // request is a clean, non-stale hit on the new key.
    expect(run()).toBe(1)
    expect(cache.get('k2', () => '{"v":2}')).toEqual({
      json: '{"v":2}',
      servedKey: 'k2',
      stale: false,
      blocked: false
    })
  })

  it('revalidates an entry that aged past the backstop without making anyone wait', () => {
    let clock = NOW
    const { cache, run } = makeCache({ now: () => clock })
    cache.get('k1', () => '{"v":1}')

    clock = NOW + REVALIDATE_MS + 1
    const aged = cache.get('k1', () => '{"v":2}')
    // Same key, so the body is still served immediately; only the age flags it.
    expect(aged.json).toBe('{"v":1}')
    expect(aged.servedKey).toBe('k1')
    expect(aged.stale).toBe(true)
    expect(aged.blocked).toBe(false)

    run()
    expect(cache.get('k1', () => '{"v":3}').json).toBe('{"v":2}')
  })

  it('coalesces concurrent rebuilds instead of stacking them', () => {
    const { cache, run, pending } = makeCache()
    cache.get('k1', () => '{"v":1}')

    let builds = 0
    const build = (): string => {
      builds++
      return '{"v":2}'
    }
    cache.get('k2', build)
    cache.get('k2', build)
    cache.get('k2', build)
    expect(pending()).toBe(1)

    run()
    expect(builds).toBe(1)
  })

  it('keeps serving the previous entry when a rebuild throws, and retries later', () => {
    const { cache, run } = makeCache()
    cache.get('k1', () => '{"v":1}')

    cache.get('k2', () => {
      throw new Error('vault vanished mid-build')
    })
    run()

    // The failed rebuild must not have poisoned or emptied the cache.
    const afterFailure = cache.get('k2', () => '{"v":2}')
    expect(afterFailure.json).toBe('{"v":1}')
    expect(afterFailure.servedKey).toBe('k1')
    expect(afterFailure.blocked).toBe(false)

    // ...and the failure did not leave `rebuilding` stuck, which would wedge the
    // cache on the old entry for the life of the process.
    run()
    expect(cache.get('k2', () => 'unused').json).toBe('{"v":2}')
  })

  describe('persistence', () => {
    it('invalidates memory and disk without allowing an old queued rebuild to repopulate it', () => {
      const deleted: number[] = []
      const sched = manualScheduler()
      const cache = new SwrJsonCache({
        revalidateAfterMs: REVALIDATE_MS,
        now: () => NOW,
        schedule: sched.schedule,
        readDisk: () => ({ key: 'demo', json: '{"demo":true}', builtAt: NOW }),
        deleteDisk: () => void deleted.push(1)
      })

      expect(cache.get('demo', () => 'unused').json).toBe('{"demo":true}')
      cache.get('operator', () => '{"stale-build":true}')
      cache.invalidate()

      const fresh = cache.get('operator', () => '{"demo":false}')
      expect(fresh).toMatchObject({ json: '{"demo":false}', servedKey: 'operator', blocked: true })
      expect(deleted).toHaveLength(1)

      sched.run()
      expect(cache.get('operator', () => 'unused').json).toBe('{"demo":false}')
    })

    it('never stale-serves another scope after restart when invalidation could not delete disk', () => {
      let disk: SwrEntry | null = {
        key: 'demo:1000',
        json: '{"demo":true}',
        builtAt: NOW,
        scope: 'demo-vault'
      }
      const persistent = {
        readDisk: (): SwrEntry | null => disk,
        writeDisk: (entry: SwrEntry): void => { disk = entry },
        deleteDisk: (): void => { throw new Error('cache file locked') }
      }

      const beforeRestart = makeCache(persistent).cache
      expect(
        beforeRestart.get('demo:1000', () => 'unused', { scope: 'demo-vault' }).json
      ).toBe('{"demo":true}')
      beforeRestart.invalidate()

      // A new instance models the next process: the undeleted demo entry is
      // hydrated from disk, but explicit ownership makes it a blocking miss.
      const afterRestart = makeCache(persistent).cache
      let builds = 0
      const result = afterRestart.get(
        'operator:2000',
        () => {
          builds++
          return '{"demo":false}'
        },
        { scope: 'operator-vault' }
      )

      expect(result).toEqual({
        json: '{"demo":false}',
        servedKey: 'operator:2000',
        stale: false,
        blocked: true
      })
      expect(builds).toBe(1)
      expect(disk).toMatchObject({ scope: 'operator-vault', json: '{"demo":false}' })
    })

    it('serves a disk entry without building, so a launch is not a cold start', () => {
      const disk: SwrEntry = { key: 'k1', json: '{"from":"disk"}', builtAt: NOW }
      const { cache } = makeCache({ readDisk: () => disk })

      const r = cache.get('k1', () => {
        throw new Error('must not build — the disk entry covers this key')
      })
      expect(r).toEqual({
        json: '{"from":"disk"}',
        servedKey: 'k1',
        stale: false,
        blocked: false
      })
    })

    it('reads the disk entry lazily, so a cache built before boot wiring still finds it', () => {
      // The cache is a module singleton, constructed at import time — before
      // boot wires the userData path the cache file lives under. Reading at
      // construction would read from nowhere and the entry would be lost for
      // the life of the process, which is the cold start it exists to remove.
      let available: SwrEntry | null = null
      const { cache } = makeCache({ readDisk: () => available })

      // The path gets wired only after construction.
      available = { key: 'k1', json: '{"from":"disk"}', builtAt: NOW }

      const r = cache.get('k1', () => {
        throw new Error('must not build — the disk entry covers this key')
      })
      expect(r).toEqual({
        json: '{"from":"disk"}',
        servedKey: 'k1',
        stale: false,
        blocked: false
      })
    })

    it('survives a corrupt or unreadable cache file by rebuilding', () => {
      const { cache } = makeCache({
        readDisk: () => {
          throw new Error('unexpected end of JSON input')
        }
      })
      const r = cache.get('k1', () => '{"v":1}')
      expect(r.json).toBe('{"v":1}')
      expect(r.servedKey).toBe('k1')
      expect(r.blocked).toBe(true)
    })

    it('persists what it builds, and a failing write costs nothing but the next cold start', () => {
      const written: SwrEntry[] = []
      const { cache, run } = makeCache({ writeDisk: (e) => void written.push(e) })

      cache.get('k1', () => '{"v":1}')
      expect(written).toEqual([{ key: 'k1', json: '{"v":1}', builtAt: NOW }])

      cache.get('k2', () => '{"v":2}')
      run()
      expect(written).toEqual([
        { key: 'k1', json: '{"v":1}', builtAt: NOW },
        { key: 'k2', json: '{"v":2}', builtAt: NOW }
      ])

      const exploding = makeCache({
        writeDisk: () => {
          throw new Error('disk full')
        }
      }).cache
      expect(exploding.get('k1', () => '{"v":1}').json).toBe('{"v":1}')
    })
  })
})

// ── The rebuild floor ────────────────────────────────────────────────────────────
//
// What this guards: the brain-graph key folds in `.duin/_state`'s mtime, so any
// channel-ingest write changes it and the next request rebuilds. Measured on the live
// vault 2026-09-02: three rebuilds in 40 seconds, 2.8-3.5s of blocked main thread each.
// Serving stale is the cache's whole purpose; rebuilding at the key's rate was not.
//
// POWER CONTROL: delete the `floor > 0 && ...` early return in rebuild() and
// "a second key change inside the floor does not schedule another rebuild" fails.
describe('SwrJsonCache — rebuild floor', () => {
  const FLOOR = 60_000

  it('a second key change inside the floor does not schedule another rebuild', () => {
    let clock = NOW
    const { cache, run, pending } = makeCache({
      minRebuildIntervalMs: FLOOR,
      now: () => clock
    })
    cache.get('k1', () => '{"v":1}') // blocking first build; starts the floor clock
    expect(run()).toBe(0)

    clock += 1_000
    cache.get('k2', () => '{"v":2}')
    expect(pending(), 'inside the floor, a key change must not schedule').toBe(0)

    clock += 5_000
    cache.get('k3', () => '{"v":3}')
    expect(pending()).toBe(0)
  })

  it('serves the previous entry instantly while the floor holds — stale, never blocked', () => {
    let clock = NOW
    const { cache } = makeCache({ minRebuildIntervalMs: FLOOR, now: () => clock })
    cache.get('k1', () => '{"v":1}')

    clock += 1_000
    const r = cache.get('k2', () => '{"v":2}')
    expect(r.json, 'the point of the floor is that the request is still answered').toBe('{"v":1}')
    expect(r.servedKey).toBe('k1')
    expect(r.stale).toBe(true)
    expect(r.blocked, 'a suppressed rebuild must never turn into a blocking build').toBe(false)
  })

  it('the first request after the floor lapses rebuilds — suppressed is not lost', () => {
    let clock = NOW
    const { cache, run } = makeCache({ minRebuildIntervalMs: FLOOR, now: () => clock })
    cache.get('k1', () => '{"v":1}')

    clock += 1_000
    cache.get('k2', () => '{"v":2}')

    clock += FLOOR
    cache.get('k3', () => '{"v":3}')
    expect(run(), 'content must still converge once the floor lapses').toBe(1)
    expect(cache.get('k3', () => '{"v":9}').json).toBe('{"v":3}')
  })

  it('a scope change is not held off by a floor earned under the previous scope', () => {
    // Ownership, not freshness: serving vault A's bytes to vault B is a correctness
    // failure, so invalidate() must clear the floor along with the entry.
    let clock = NOW
    const { cache } = makeCache({ minRebuildIntervalMs: FLOOR, now: () => clock })
    cache.get('k1', () => '{"v":1}', { scope: '/vault/a' })

    clock += 1_000
    const r = cache.get('k1', () => '{"v":2}', { scope: '/vault/b' })
    expect(r.blocked, 'a new scope blocks on its own first build, floor or not').toBe(true)
    expect(r.json).toBe('{"v":2}')
  })

  it('without the option every key change may still schedule — the floor is opt-in', () => {
    let clock = NOW
    const { cache, run } = makeCache({ now: () => clock })
    cache.get('k1', () => '{"v":1}')
    clock += 1_000
    cache.get('k2', () => '{"v":2}')
    expect(run(), 'omitting minRebuildIntervalMs must preserve the original behaviour').toBe(1)
  })
})
