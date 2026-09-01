// entity-automerge-tick — runs the duplicate-entity closing arrow unattended.
//
// The policy lives in entity-automerge.ts (pure, tested). This is the IO half: read the
// candidate report the /debug/alias-candidates route already computes, decide, and append the
// approved groups to `<vault>/.duin/_state/entity-aliases.json` — the same per-vault whitelist
// loadAliasGroups reads. Nothing here is a new merge mechanism: it writes the row a human
// would have pasted, into the file P0-A moved the whitelist into.
import { readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from '../atomic-write'
import { aliasWhitelistUnreadable, loadAliasGroups, type AliasGroup, type AliasCandidate } from './entity-resolver'
import { decideAutoMerges, applyAutoMerges, type AutoMergeDecision } from './entity-automerge'

export interface AutoMergeTickResult {
  /** groups proposed by the clusterer this run */
  proposed: number
  /** approved and written */
  merged: number
  /** refused, by reason — surfaced so a skipped duplicate is explainable */
  refused: Record<string, number>
}

const EMPTY: AutoMergeTickResult = { proposed: 0, merged: 0, refused: {} }

export function aliasFilePath(vaultDir: string): string {
  return join(vaultDir, '.duin', '_state', 'entity-aliases.json')
}

/** Persist the whitelist. Written whole, pretty-printed, because a human still edits this file
 *  by hand — an auto-merge must not turn it into a minified blob they cannot review.
 *
 *  ATOMIC, not a bare writeFileSync: this rewrites the WHOLE file in place, so a crash, a full
 *  disk, or an editor holding the file mid-write left a truncated entity-aliases.json — which
 *  loadAliasGroups then reads as an empty whitelist, i.e. this function was the supplier of the
 *  corrupt input the two append sites now have to guard against. Temp-write + fsync + rename means
 *  a failed write leaves the previous whitelist intact instead. 0o644 because it stays hand-
 *  editable; nothing in it is secret. */
export function writeAliasGroups(vaultDir: string, groups: readonly AliasGroup[]): void {
  atomicWriteFileSync(aliasFilePath(vaultDir), JSON.stringify(groups, null, 2) + '\n', 0o644)
}

/** Read the report's candidates + their cosineMin into the shape the policy expects. The route
 *  returns an untyped record, so this narrows defensively — a malformed report yields no
 *  candidates rather than throwing on a background tick. */
export function candidatesFromReport(
  report: Record<string, unknown> | null | undefined
): { candidate: AliasCandidate; cosineMin?: number }[] {
  const raw = (report as { candidates?: unknown } | null)?.candidates
  if (!Array.isArray(raw)) return []
  const out: { candidate: AliasCandidate; cosineMin?: number }[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const canonical =
      typeof o.suggestedCanonicalLabel === 'string'
        ? o.suggestedCanonicalLabel
        : typeof o.canonical === 'string'
          ? o.canonical
          : null
    const membersRaw = Array.isArray(o.members) ? o.members : []
    const members = membersRaw
      .map((m) =>
        typeof m === 'string' ? m : m && typeof m === 'object' ? String((m as { label?: unknown }).label ?? '') : ''
      )
      .filter((s) => s.length > 0)
    if (!canonical || members.length < 2) continue
    out.push({
      candidate: { canonical, members },
      cosineMin: typeof o.cosineMin === 'number' ? o.cosineMin : undefined
    })
  }
  return out
}

/**
 * One pass. Best-effort: any failure returns zeros rather than throwing, because this runs on a
 * background tick and must never take the tick down. Idempotent — applyAutoMerges skips a
 * canonicalId already present, so a repeat run writes nothing.
 *
 * `report` is injected rather than fetched here so the caller owns the (expensive, async,
 * embedding-backed) computation and this stays unit-testable without a vault or a model.
 */
export function runEntityAutoMergeTick(
  vaultDir: string | null,
  report: Record<string, unknown> | null | undefined
): AutoMergeTickResult {
  if (!vaultDir) return { ...EMPTY }
  try {
    const pairs = candidatesFromReport(report)
    if (pairs.length === 0) return { ...EMPTY }
    // Same abstention as the kind-collapse pass, which runs just before this one on the same tick
    // and over the same file: an unreadable whitelist reads as `[]`, and `applyAutoMerges` would
    // then hand back a `groups` array containing only this run's rows — written WHOLE over the
    // operator's hand-authored ones. The `added.length > 0` guard below does not help, because a
    // phantom-empty `existing` is exactly what makes `added` non-empty.
    if (aliasWhitelistUnreadable(vaultDir)) {
      console.warn(
        `[entity-alias-guard] ${aliasFilePath(vaultDir)} exists but did not parse — automerge abstained (nothing written; fix or remove the file)`
      )
      return { proposed: 0, merged: 0, refused: { 'whitelist-unreadable': 1 } }
    }
    const existing = loadAliasGroups(vaultDir)
    const cosineByCanonical = new Map(pairs.map((p) => [p.candidate.canonical, p.cosineMin]))
    const decisions: AutoMergeDecision[] = decideAutoMerges(
      pairs.map((p) => p.candidate),
      existing,
      (c) => cosineByCanonical.get(c.canonical)
    )
    const { groups, added } = applyAutoMerges(existing, decisions)

    const refused: Record<string, number> = {}
    for (const d of decisions) {
      if (d.merged || !d.reason) continue
      refused[d.reason] = (refused[d.reason] ?? 0) + 1
    }
    // Only touch the file when something actually changed — a no-op tick must not rewrite a
    // file the operator may have open, nor churn its mtime.
    if (added.length > 0) writeAliasGroups(vaultDir, groups)
    return { proposed: pairs.length, merged: added.length, refused }
  } catch {
    return { ...EMPTY }
  }
}

/** Read the whitelist back — used by the tick's caller to re-arm the resolver after a write. */
export function reloadAliasGroups(vaultDir: string): ReadonlyArray<AliasGroup> {
  try {
    JSON.parse(readFileSync(aliasFilePath(vaultDir), 'utf-8'))
  } catch {
    // fall through — loadAliasGroups is itself best-effort
  }
  return loadAliasGroups(vaultDir)
}
