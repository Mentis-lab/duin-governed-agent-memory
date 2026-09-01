// Governor 4a — the RATIFY flow for held (staged) loop output. A staged iteration
// left three things behind: the backlog item at `awaiting-ratification`, its git
// output parked on the side ref refs/duin/staged/<backlogId>, and the capability at
// the `stage` rung. This module is the human's decision on that held work:
//   - ratify  → LAND the output (ff-only merge the side ref) + mark the item done +
//               recordFeedback('ratify'). The capability earns ratify credit.
//   - revert  → DISCARD the output (drop the side ref; the tree was already reset at
//               stage time, so it stays untouched) + re-queue the item (pending) +
//               recordFeedback('revert'). A revert is the governor's demote signal.
//   - dismiss → keep the work held; recordFeedback('dismiss') (the human looked, deferred).
//
// PURE-CORE-friendly: all I/O is injected (store getters/mutators, the git apply/discard
// primitives, recordFeedback, clock), so the whole decision is unit-tested with fakes and
// never needs Electron. The IPC handler in ipc/loops.ts is a thin wrapper over this.
//
// IDEMPOTENT + TIED: the verb only applies to an item that is genuinely
// `awaiting-ratification`; any other status (already ratified/reverted, never staged)
// is rejected. So a replayed ratify can neither double-land nor inflate the ratify
// count — the second call sees `done`/`pending`, not `awaiting-ratification`.

import type { ExecSeam } from './longrun/artifact-checkpoint'
import type { BacklogItem, BacklogStatus, Loop } from './loop-store'

export type RatifyVerb = 'ratify' | 'revert' | 'dismiss'

export function isRatifyVerb(v: unknown): v is RatifyVerb {
  return v === 'ratify' || v === 'revert' || v === 'dismiss'
}

/** The capability whose rung the loop autonomy is gated on. Mirrors loop-controller's
 *  LOOP_CAP_ID; duplicated as a constant here to avoid importing the controller (and its
 *  heavy transitive graph) into the ratify path. */
export const RATIFY_CAP_ID = 'autonomous-loop'

export interface RatifyDeps {
  getBacklogItem: (id: string) => BacklogItem | null
  getLoop: (id: string) => Loop | null
  updateBacklogItem: (
    id: string,
    patch: Partial<{ status: BacklogStatus; result: string | null; startedAt: number | null; finishedAt: number | null }>
  ) => BacklogItem | null
  recordFeedback: (capId: string, verb: RatifyVerb) => boolean
  applyStaged: (dir: string, key: string, exec: ExecSeam) => Promise<string>
  discardStaged: (dir: string, key: string, exec: ExecSeam) => Promise<void>
  /** Present in production; absent in a no-artifact test. When absent, git steps are
   *  skipped (a loop with no artifactDir has no git output to land/discard). */
  exec?: ExecSeam
  now?: () => number
}

export interface RatifyResult {
  ok: boolean
  error?: string
  /** Resulting backlog status on success. */
  status?: BacklogStatus
  /** For a ratify that landed git output, the new HEAD sha. */
  landedSha?: string | null
}

// Concurrency claim: the status guard and the status mutation straddle an awaited git
// op, so two in-flight calls for the SAME backlogId (a double-click / UI retry) could
// both pass the guard and each recordFeedback → count inflation, or ratify-then-revert
// the same item. The main process is single-threaded, so a synchronous in-process claim
// set serializes them: the second concurrent call rejects immediately. (Ratify is
// main-process-only, so an in-process lock is sufficient — there is no cross-process ratify.)
const inFlight = new Set<string>()

/**
 * Apply a human's ratify decision to a staged backlog item. See module header for the
 * per-verb semantics + the idempotency contract. Never throws for a "wrong state"
 * (returns { ok:false, error }); only a genuine git failure during a ratify's
 * apply-then-mark propagates as a rejected promise so the caller can surface it —
 * crucially, the item is left `awaiting-ratification` in that case (nothing marked
 * done), so a retry is safe.
 */
export async function ratifyStagedItem(
  backlogId: string,
  verb: RatifyVerb,
  deps: RatifyDeps
): Promise<RatifyResult> {
  const now = deps.now ?? Date.now

  // Claim the item for the duration of this decision so a concurrent call for the same
  // id can't also pass the guard below (which straddles an await). Rejected, not queued.
  if (inFlight.has(backlogId)) {
    return { ok: false, error: `item ${backlogId} is already being ratified` }
  }
  inFlight.add(backlogId)
  try {
    const item = deps.getBacklogItem(backlogId)
    if (!item) return { ok: false, error: `no backlog item ${backlogId}` }
    if (item.status !== 'awaiting-ratification') {
      // The tie + idempotency guard: only genuinely-held work can be decided.
      return { ok: false, error: `item ${backlogId} is '${item.status}', not awaiting-ratification` }
    }

    const loop = deps.getLoop(item.loopId)
    const artifactDir = loop?.artifactDir ?? null
    const hasGit = !!(artifactDir && deps.exec)

    if (verb === 'ratify') {
      // LAND FIRST (may throw), then mark done. If the apply throws, we have NOT
      // touched the item status → it stays awaiting-ratification → a retry is safe.
      let landedSha: string | null = null
      if (hasGit) {
        landedSha = await deps.applyStaged(artifactDir as string, backlogId, deps.exec as ExecSeam)
      }
      deps.updateBacklogItem(backlogId, { status: 'done', finishedAt: now() })
      deps.recordFeedback(RATIFY_CAP_ID, 'ratify')
      return { ok: true, status: 'done', landedSha }
    }

    if (verb === 'revert') {
      // DISCARD the held output (idempotent; tree already reset at stage time), then
      // re-queue the item so a future (possibly-demoted) run can retry it.
      if (hasGit) {
        await deps.discardStaged(artifactDir as string, backlogId, deps.exec as ExecSeam)
      }
      deps.updateBacklogItem(backlogId, { status: 'pending', startedAt: null, finishedAt: null })
      deps.recordFeedback(RATIFY_CAP_ID, 'revert')
      return { ok: true, status: 'pending' }
    }

    // dismiss — keep the work held; just record that the human looked and deferred.
    deps.recordFeedback(RATIFY_CAP_ID, 'dismiss')
    return { ok: true, status: 'awaiting-ratification' }
  } finally {
    inFlight.delete(backlogId)
  }
}
