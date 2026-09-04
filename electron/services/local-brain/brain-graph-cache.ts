import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import { runWhenIdle } from '../idle-scheduler'
import { getLocalBrainUserDataPath } from './index-store'
import { SwrJsonCache, type SwrEntry } from './swr-json-cache'

const BRAIN_GRAPH_REVALIDATE_MS = 5 * 60_000
// Floor between rebuilds. The rebuild costs 2.8-3.5s of blocked main thread (measured
// at /debug/stalls, 2026-09-02) and the cache key folds in `.duin/_state`'s mtime, so a
// single channel-ingest write makes the next request rebuild the whole 1.5MB graph.
// Three rebuilds landed in 40 seconds that way. 60s bounds it to one; requests in
// between are served instantly from the previous entry, which is what SWR is for.
// See minRebuildIntervalMs in swr-json-cache.ts for why the key is not narrowed instead.
// `DUIN_BRAIN_GRAPH_MIN_REBUILD_MS=0` removes the floor (every key change may schedule
// again — the pre-2026-09-02 behaviour). Read at construction; the route's ETag/SWR
// suite sets it so it can keep pinning the ROUTE contract without this instance's
// rate-limiting policy in the way.
function minRebuildMs(): number {
  const raw = process.env.DUIN_BRAIN_GRAPH_MIN_REBUILD_MS
  if (raw == null || raw === '') return 60_000
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 60_000
}

function brainGraphCachePath(): string | null {
  const base = getLocalBrainUserDataPath()
  return base ? join(base, 'cache', 'brain-graph.json') : null
}

export const brainGraphCache = new SwrJsonCache({
  revalidateAfterMs: BRAIN_GRAPH_REVALIDATE_MS,
  minRebuildIntervalMs: minRebuildMs(),
  schedule: (fn) =>
    runWhenIdle('brain-graph-rebuild', fn, { idleMs: 3_000, maxDelayMs: 120_000, pollMs: 1_000 }),
  readDisk: () => {
    const path = brainGraphCachePath()
    if (!path || !existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8')) as SwrEntry
  },
  writeDisk: (entry) => {
    const path = brainGraphCachePath()
    if (!path) return
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(entry), 'utf-8')
    renameSync(tmp, path)
  },
  deleteDisk: () => {
    const path = brainGraphCachePath()
    if (path) rmSync(path, { force: true })
  }
})

/** A vault switch changes the cache's ownership scope, so stale-while-revalidate
 * is not acceptable: the old graph may contain another vault's data. */
export function invalidateBrainGraphCache(): void {
  brainGraphCache.invalidate()
}
