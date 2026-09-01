import { describe, it, expect, vi } from 'vitest'
import {
  diskFreeBytes,
  processRssBytes,
  check,
  shouldRestartToRecover,
  type StatfsSeam,
  type RssSeam,
  type ResourceThresholds,
  type ResourceReadings
} from './resource-monitor'

// L7 Resource guards. All OS reads go through injected seams, so every test
// here is deterministic with fixed readings — no real fs.statfs, no real
// process.memoryUsage. Covers: happy path (healthy -> continue), the failures
// the invariant kills (disk exhaustion -> durable pause instead of a silent
// crash; RSS blowup -> alert), and the boundaries / disabled-guard edges.

const GB = 1024 * 1024 * 1024

describe('diskFreeBytes', () => {
  it('multiplies bavail * bsize from the seam', async () => {
    const statfs: StatfsSeam = async () => ({ bavail: 1000, bsize: 4096 })
    expect(await diskFreeBytes('/artifact', statfs)).toBe(1000 * 4096)
  })

  it('passes the path through to the seam', async () => {
    const seam = vi.fn<StatfsSeam>(async () => ({ bavail: 1, bsize: 1 }))
    await diskFreeBytes('D:/work/repo', seam)
    expect(seam).toHaveBeenCalledWith('D:/work/repo')
  })

  it('returns 0 when the volume is full (bavail = 0)', async () => {
    const statfs: StatfsSeam = async () => ({ bavail: 0, bsize: 4096 })
    expect(await diskFreeBytes('/x', statfs)).toBe(0)
  })
})

describe('processRssBytes', () => {
  it('returns the seam reading verbatim', () => {
    const seam: RssSeam = () => 512 * 1024 * 1024
    expect(processRssBytes(seam)).toBe(512 * 1024 * 1024)
  })

  it('invokes the seam each call (fresh sample)', () => {
    let n = 0
    const seam: RssSeam = () => ++n
    expect(processRssBytes(seam)).toBe(1)
    expect(processRssBytes(seam)).toBe(2)
  })
})

describe('check', () => {
  const thresholds: ResourceThresholds = { diskMinBytes: 1 * GB, rssMaxBytes: 2 * GB }

  it('continues when both resources are healthy (happy path)', () => {
    const readings: ResourceReadings = { diskFreeBytes: 5 * GB, rssBytes: 1 * GB }
    expect(check(thresholds, readings)).toEqual({ action: 'continue' })
  })

  it('pauses on disk below the floor — the crash the invariant prevents', () => {
    const readings: ResourceReadings = { diskFreeBytes: 0.5 * GB, rssBytes: 1 * GB }
    expect(check(thresholds, readings)).toEqual({ action: 'pause', reason: 'disk-low' })
  })

  it('alerts on RSS above the ceiling but does not stop', () => {
    const readings: ResourceReadings = { diskFreeBytes: 5 * GB, rssBytes: 3 * GB }
    expect(check(thresholds, readings)).toEqual({ action: 'alert', reason: 'rss-high' })
  })

  it('pause outranks alert when BOTH disk and RSS breach', () => {
    // disk exhaustion corrupts the commit, so it wins over a high-RSS warning.
    const readings: ResourceReadings = { diskFreeBytes: 0.1 * GB, rssBytes: 9 * GB }
    expect(check(thresholds, readings)).toEqual({ action: 'pause', reason: 'disk-low' })
  })

  // --- boundary conditions ---

  it('treats disk exactly AT the floor as healthy (uses <, not <=)', () => {
    const readings: ResourceReadings = { diskFreeBytes: 1 * GB, rssBytes: 1 * GB }
    expect(check(thresholds, readings)).toEqual({ action: 'continue' })
  })

  it('treats RSS exactly AT the ceiling as healthy (uses >, not >=)', () => {
    const readings: ResourceReadings = { diskFreeBytes: 5 * GB, rssBytes: 2 * GB }
    expect(check(thresholds, readings)).toEqual({ action: 'continue' })
  })

  it('pauses just one byte below the disk floor', () => {
    const readings: ResourceReadings = { diskFreeBytes: 1 * GB - 1, rssBytes: 1 * GB }
    expect(check(thresholds, readings)).toEqual({ action: 'pause', reason: 'disk-low' })
  })

  it('alerts just one byte above the RSS ceiling', () => {
    const readings: ResourceReadings = { diskFreeBytes: 5 * GB, rssBytes: 2 * GB + 1 }
    expect(check(thresholds, readings)).toEqual({ action: 'alert', reason: 'rss-high' })
  })

  // --- disabled guards (0 disables that dimension) ---

  it('disk threshold of 0 disables the disk guard even at 0 free bytes', () => {
    const t: ResourceThresholds = { diskMinBytes: 0, rssMaxBytes: 2 * GB }
    expect(check(t, { diskFreeBytes: 0, rssBytes: 1 * GB })).toEqual({ action: 'continue' })
  })

  it('rss threshold of 0 disables the rss guard even at huge RSS', () => {
    const t: ResourceThresholds = { diskMinBytes: 1 * GB, rssMaxBytes: 0 }
    expect(check(t, { diskFreeBytes: 5 * GB, rssBytes: 999 * GB })).toEqual({ action: 'continue' })
  })

  it('both thresholds 0 -> always continue', () => {
    const t: ResourceThresholds = { diskMinBytes: 0, rssMaxBytes: 0 }
    expect(check(t, { diskFreeBytes: 0, rssBytes: 999 * GB })).toEqual({ action: 'continue' })
  })

  it('disk guard still fires when only the rss guard is disabled', () => {
    const t: ResourceThresholds = { diskMinBytes: 1 * GB, rssMaxBytes: 0 }
    expect(check(t, { diskFreeBytes: 0.5 * GB, rssBytes: 999 * GB })).toEqual({
      action: 'pause',
      reason: 'disk-low'
    })
  })
})

describe('shouldRestartToRecover', () => {
  it('recycles when RSS is above threshold and the loop has run', () => {
    expect(shouldRestartToRecover(3 * GB, 2 * GB, 5)).toBe(true)
  })

  it('does not recycle before any iteration has run (iterSinceStart = 0)', () => {
    // restart-midway edge: recycling at iter 0 would be a pointless restart loop.
    expect(shouldRestartToRecover(9 * GB, 2 * GB, 0)).toBe(false)
  })

  it('threshold of 0 disables recycling', () => {
    expect(shouldRestartToRecover(999 * GB, 0, 100)).toBe(false)
  })

  it('does not recycle at exactly the threshold (uses >, not >=)', () => {
    expect(shouldRestartToRecover(2 * GB, 2 * GB, 5)).toBe(false)
  })

  it('does not recycle below the threshold', () => {
    expect(shouldRestartToRecover(1 * GB, 2 * GB, 5)).toBe(false)
  })

  it('recycles one byte above the threshold with iterSinceStart = 1', () => {
    expect(shouldRestartToRecover(2 * GB + 1, 2 * GB, 1)).toBe(true)
  })
})
