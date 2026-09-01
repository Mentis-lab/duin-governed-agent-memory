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

function brainGraphCachePath(): string | null {
  const base = getLocalBrainUserDataPath()
  return base ? join(base, 'cache', 'brain-graph.json') : null
}

export const brainGraphCache = new SwrJsonCache({
  revalidateAfterMs: BRAIN_GRAPH_REVALIDATE_MS,
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
