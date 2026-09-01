// Long-run reliability L7 — Resource guards.
//
// The 24h+ loop must not silently crash the box by exhausting disk or memory.
// Instead it SAMPLES the two resources that a runaway artifact-writing loop
// actually consumes — free disk on the artifact volume and this process's RSS
// — and returns a durable verdict the controller folds into its stop path:
//   - disk below the floor  -> PAUSE (stop-not-corrupt; L1/L2 make the last
//                              committed step durable, so pausing is safe)
//   - RSS above the ceiling -> ALERT (warn + digest, keep going; a restart is
//                              a separate opt-in recovery, not a hard stop)
//   - otherwise             -> CONTINUE.
//
// All OS reads go through injected seams (StatfsSeam / RssSeam) so the decision
// logic is pure and unit-tested with fixed readings — no real fs.statfs, no
// real process.memoryUsage in the logic path. A threshold of 0 disables that
// dimension entirely (env cap convention: DUIN_LOOP_DISK_MIN / DUIN_LOOP_RSS_MAX
// / DUIN_LOOP_RSS_RECYCLE resolve to 0 when unset).

/**
 * Injected disk-stat boundary. Production wraps `fs.statfs`; tests pass fixed
 * readings. `bavail` = blocks available to an unprivileged process, `bsize` =
 * block size in bytes.
 */
export type StatfsSeam = (path: string) => Promise<{ bavail: number; bsize: number }>

/**
 * Free bytes on the artifact volume = bavail * bsize. The single disk read the
 * L7 disk guard judges against `diskMinBytes`.
 */
export async function diskFreeBytes(path: string, statfs: StatfsSeam): Promise<number> {
  const { bavail, bsize } = await statfs(path)
  return bavail * bsize
}

/**
 * Injected RSS reader. Production wraps `process.memoryUsage().rss`; tests pass
 * a fixed number.
 */
export type RssSeam = () => number

/**
 * Current resident-set-size via the seam. A pure passthrough kept as a named
 * boundary for symmetry with `diskFreeBytes` and so tests exercise the same
 * call shape the controller uses.
 */
export function processRssBytes(seam: RssSeam): number {
  return seam()
}

/**
 * The pause/alert floors. Sourced from DUIN_LOOP_DISK_MIN / DUIN_LOOP_RSS_MAX.
 * A value of 0 disables that guard (that dimension is never allowed to pause or
 * alert), matching the env-cap "0 disables" convention.
 */
export interface ResourceThresholds {
  diskMinBytes: number
  rssMaxBytes: number
}

/** The sampled values `check()` judges. */
export interface ResourceReadings {
  diskFreeBytes: number
  rssBytes: number
}

/**
 * pause = stop before exhaustion (disk below floor — durable, not a silent
 * crash); alert = warn but proceed (RSS high); continue = healthy.
 */
export interface ResourceDecision {
  action: 'continue' | 'pause' | 'alert'
  reason?: string
}

/**
 * PURE. Judge sampled readings against the thresholds.
 *
 *   - diskFree < diskMinBytes  -> pause 'disk-low'   (checked FIRST: running
 *                                 out of disk corrupts the artifact commit, so
 *                                 it outranks a high-RSS alert)
 *   - rss > rssMaxBytes        -> alert 'rss-high'
 *   - otherwise                -> continue
 *
 * A threshold of 0 skips that dimension (0 disables). The disk guard uses `<`
 * (below the floor is unsafe) and the RSS guard uses `>` (strictly above the
 * ceiling is high) so a reading exactly AT the threshold is treated as healthy.
 */
export function check(
  thresholds: ResourceThresholds,
  readings: ResourceReadings
): ResourceDecision {
  if (thresholds.diskMinBytes > 0 && readings.diskFreeBytes < thresholds.diskMinBytes) {
    return { action: 'pause', reason: 'disk-low' }
  }
  if (thresholds.rssMaxBytes > 0 && readings.rssBytes > thresholds.rssMaxBytes) {
    return { action: 'alert', reason: 'rss-high' }
  }
  return { action: 'continue' }
}

/**
 * PURE. Opt-in periodic recycle: when RSS has climbed past the recycle
 * threshold and the loop has actually run at least one iteration, signal the
 * controller to request an app restart BETWEEN iterations. Safe ONLY because
 * L1/L2 make progress durable — a restart replays cleanly from the journal.
 *
 * threshold of 0 disables (never recycles); iterSinceStart of 0 means the loop
 * hasn't done work yet, so recycling would be a pointless restart loop.
 */
export function shouldRestartToRecover(
  rss: number,
  threshold: number,
  iterSinceStart: number
): boolean {
  return threshold > 0 && rss > threshold && iterSinceStart > 0
}
