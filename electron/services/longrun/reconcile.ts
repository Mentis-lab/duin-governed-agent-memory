import type { JournalEntry } from './run-journal'

// Long-run L2 — idempotent resumability. On restart, reconcile the durable run
// journal against the artifact's git HEAD to decide, WITHOUT re-running work
// that already landed, which backlog item to resume and whether the journal
// tail is consistent with git (else escalate).
//
// PURE: the only inputs are the parsed journal + the current git sha. The
// caller (runLoopIteration step 1.5) fetches those via the injected seams and
// applies the verdict.

/**
 * The restart verdict:
 *  - `resumeItemId`   advisory backlog item to resume (the pending-queue order
 *                     yields the same item; this is a cross-check).
 *  - `alreadyCommitted`  the last journaled commit's sha IS the current HEAD, so
 *                     that step is durably done and must be skipped (a step
 *                     whose gitSha is already HEAD is a no-op).
 *  - `replaySafe`     the journal tail is consistent with HEAD — safe to resume
 *                     forward. False ⇒ divergence, the caller pauses+escalates.
 *  - `lastCommittedSha`  the sha of the last journaled commit (the reconcile
 *                     anchor), or null when nothing was ever committed.
 */
export interface ReconcileResult {
  resumeItemId: string | null
  alreadyCommitted: boolean
  replaySafe: boolean
  lastCommittedSha: string | null
}

/** The itemId of the first entry after `fromIdx` that carries one, else null —
 *  the next item the loop had started working after the last commit. */
function firstStartedItemAfter(journal: JournalEntry[], fromIdx: number): string | null {
  for (let i = fromIdx + 1; i < journal.length; i++) {
    if (journal[i].itemId != null) return journal[i].itemId
  }
  return null
}

/** The itemId of the first entry that carries one — the in-progress item when
 *  nothing has been committed yet. */
function firstStartedItem(journal: JournalEntry[]): string | null {
  for (const e of journal) {
    if (e.itemId != null) return e.itemId
  }
  return null
}

/**
 * PURE. Walk the journal, find the last `kind:'commit'` entry, and compare its
 * sha to the current git HEAD:
 *
 *  - last commit sha === HEAD  → that step is durably done (`alreadyCommitted`),
 *    resume the NEXT started item (or null → pull the next from the queue).
 *  - last commit sha !== HEAD but HEAD is one of the journaled shas → the last
 *    commit did not land as HEAD but we are at a KNOWN earlier point →
 *    `replaySafe` forward, redo the last commit's item.
 *  - HEAD is unknown to the journal → divergence (`replaySafe:false`); the
 *    caller pauses + escalates rather than corrupting forward.
 *
 * With no commit entries at all there is nothing to diverge from: resume the
 * in-progress item safely (a fresh loop, or a crash before the first commit).
 */
export function reconcile(input: {
  loopId: string
  journal: JournalEntry[]
  gitSha: string | null
}): ReconcileResult {
  const { journal, gitSha } = input

  // Index of the last commit entry, if any.
  let lastCommitIdx = -1
  for (let i = journal.length - 1; i >= 0; i--) {
    if (journal[i].kind === 'commit') {
      lastCommitIdx = i
      break
    }
  }

  // No commit was ever journaled — nothing durable to reconcile against, so
  // there is no divergence. Resume whatever item was in flight.
  if (lastCommitIdx === -1) {
    return {
      resumeItemId: firstStartedItem(journal),
      alreadyCommitted: false,
      replaySafe: true,
      lastCommittedSha: null
    }
  }

  const lastCommittedSha = journal[lastCommitIdx].gitSha

  // The last commit's sha is exactly HEAD → that step landed. It is a no-op to
  // redo; resume the next started item (or defer to the pending queue).
  if (lastCommittedSha != null && lastCommittedSha === gitSha) {
    return {
      resumeItemId: firstStartedItemAfter(journal, lastCommitIdx),
      alreadyCommitted: true,
      replaySafe: true,
      lastCommittedSha
    }
  }

  // HEAD differs from the last journaled commit. If HEAD is a sha the journal
  // knows (an earlier commit), we are at a consistent earlier point → resume
  // forward and redo the last commit's item. If HEAD is unknown (or null while
  // commits were journaled), git and the journal have diverged → not replay-safe.
  const journaledShas = new Set<string>()
  for (const e of journal) {
    if (e.gitSha != null) journaledShas.add(e.gitSha)
  }
  const headKnown = gitSha != null && journaledShas.has(gitSha)

  return {
    resumeItemId: journal[lastCommitIdx].itemId,
    alreadyCommitted: false,
    replaySafe: headKnown,
    lastCommittedSha
  }
}
