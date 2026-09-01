// vault-version — a monotonic counter bumped whenever the vault's grounding inputs change: a note
// mutation (fs-watcher add/change/unlink or a direct write → scheduleReindex), a completed reindex (the
// chunk index is now fresh), or a completed construction rebuild (the entity/edge layer is now fresh).
//
// Cheap grounding caches (liveWholeNotes / liveGraph, previously a full-vault disk read + graph rebuild on
// EVERY turn — the dominant TTFT tax) key on this counter so they invalidate in O(1) instead of statting
// the whole vault per turn. Bumping is intentionally COARSE (any of the three events bumps once): a cache
// keyed on it can never serve data older than the last mutation, at the cost of an occasional redundant
// rebuild — the safe direction. No deps, so both brain/ (readers) and local-brain/ (the watcher, the
// bumper) import it without a cycle.
let version = 0

/** Invalidate all vault-version-keyed caches. Call on any note mutation / reindex / construction rebuild. */
export function bumpVaultVersion(): void {
  version++
}

/** The current vault version — a cache is fresh iff its stored version equals this. */
export function vaultVersion(): number {
  return version
}
