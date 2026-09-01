// vault-dirs — the SINGLE source of truth for which directories count as user-vault
// content when walking the vault tree. THREE independent walkers must agree on this or
// a node/link resolves into a directory the graph never treated as vault content:
//   • build-graph-native  (note-walk → graph nodes)
//   • workflows-native     (method-walk → capability chips)
//   • doc-native           (wikilink resolve → doc body)
// When their hand-maintained skip-lists drifted, `.duin/_eval-fixtures/` snapshot vaults
// shadowed real notes (a `[[personal]]`/`[[inbox]]` link resolved into a stale fixture).
// Import isVaultWalkDir instead of re-deriving a skip-list per walker.

/**
 * App-managed state/config dirs whose `.md` files are NEVER user vault notes and must
 * never satisfy a [[wikilink]] / graph-node resolve. `.duin` bundles machine state incl.
 * `.duin/_eval-fixtures/` snapshot vaults; `.brain` is the OKF concept bundle. Mirrors
 * index-store's SKIP_DIRS so graph + resolver + method-walk can never diverge.
 */
export const APP_STATE_DIRS = new Set(['.brain', '.duin'])

/** Infra dirs (VCS / editor / trash / deps) skipped by every vault walker. */
export const INFRA_SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules'])

/**
 * True iff a directory entry should be DESCENDED INTO when walking the vault for content
 * (notes / methods / link targets). Skips infra + app-state dirs and `_agui*` agent-output
 * dirs. Deliberately KEEPS other tooling dot-folders (`.claude`, `.smart-env`) — the graph
 * indexes those as knowledge (see build-graph-native header); this rule only prunes what is
 * provably NOT vault content, so it changes graph composition by nothing on a real vault.
 */
export function isVaultWalkDir(name: string): boolean {
  return !INFRA_SKIP_DIRS.has(name) && !APP_STATE_DIRS.has(name) && !name.startsWith('_agui')
}
