// entity-automerge — the CLOSING ARROW for duplicate entities.
//
// proposeAliasGroups has always worked: it clusters entity labels by embedding cosine and
// proposes near-duplicate groups. What it never had was a consumer. Its only reader is
// GET /debug/alias-candidates, whose own note ends:
//
//   "Nothing is merged. Confirm each group by eye, paste its `pasteSnippet` into ENTITY_ALIAS
//    in electron/services/brain/entity-resolver.ts, and ship."
//
// So the merge gate was: a human pastes a code snippet into a SOURCE FILE, rebuilds, and
// deploys — per duplicate. That is why duplicates accumulate forever next to a detector that
// finds them correctly. Measured on the live vault 2026-07-27: 987 entities, 773 distinct
// labels, 7 proposed groups, 0 merged.
//
// Cold-start P0-A incidentally made automation possible. ENTITY_ALIAS moved out of source into
// `<vault>/.duin/_state/entity-aliases.json`, so the whitelist is now per-vault DATA. A merge
// can be a file append on a tick instead of a code change and a release.
//
// WHAT MAKES THIS SAFE, and why it is not just "lower the threshold":
//
// Embedding cosine alone is the wrong gate for an unattended merge. "John Smith" and "Jane
// Smith" sit very close in embedding space and are different people; merging them is
// destructive and near-invisible afterwards. So a high cosine is necessary here but NOT
// sufficient — a candidate must also show LEXICAL CONTAINMENT: one member's normalized token
// set must be a subset of another's. That is the difference between "these read alike" and
// "this is literally the short form of that":
//
//   kepano                ⊂ steve kepano gordon    → merge (containment + cosine 0.885)
//   john smith  vs  jane smith                     → refuse (neither contains the other)
//
// Containment is evidence; similarity is a hint. Same discipline as decision-loop: act on the
// unambiguous cases, leave the rest surfaced for a human rather than guessing.
import { normName, type AliasGroup } from './entity-resolver'
import type { AliasCandidate } from './entity-resolver'

/** Cosine floor for an UNATTENDED merge. Deliberately well above proposeAliasGroups' 0.86
 *  surfacing threshold — that one feeds human eyes, this one feeds a write. */
export const AUTOMERGE_MIN_COSINE = 0.9

/** Largest group size to auto-merge. Two or three surface forms of one entity is the normal
 *  shape; a big cluster is more often a topical blob (several real people who share a company
 *  or a title) and belongs in review. */
export const AUTOMERGE_MAX_MEMBERS = 3

/** Tokens of a normalized label, for the containment test. */
export function tokensOf(label: string): Set<string> {
  return new Set(
    normName(label)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
  )
}

/** Is `a` lexically contained in `b`? EVERY token of `a` must appear in `b` —
 *  "kepano" ⊂ "steve kepano gordon".
 *
 *  Note what is deliberately NOT done: short tokens are not filtered out before the test. An
 *  earlier version dropped 1-character tokens on the theory that an initial carries no
 *  identity, which made "J Smith" contained in "Jane Smith" — the filter discarded the `j` and
 *  left a bare surname match, precisely the weak evidence this function exists to reject.
 *  Keeping every token means an unmatched initial correctly fails the test. */
export function isContained(a: string, b: string): boolean {
  const ta = [...tokensOf(a)]
  const tb = tokensOf(b)
  if (ta.length === 0) return false
  return ta.every((t) => tb.has(t))
}

/** Does the group have a member every other member is contained in (or that contains them)?
 *  Chains through the LONGEST label, which is also what clusterAliases picks as canonical. */
export function hasContainmentSpine(members: readonly string[]): boolean {
  if (members.length < 2) return false
  const longest = [...members].sort((a, b) => normName(b).length - normName(a).length)[0]
  return members.every((m) => m === longest || isContained(m, longest))
}

export interface AutoMergeDecision {
  candidate: AliasCandidate
  merged: boolean
  /** Why it was refused — surfaced so a skipped group is explainable, not silent. */
  reason?: 'below-cosine' | 'too-many-members' | 'no-containment' | 'conflicts-with-whitelist'
}

/** Normalized surface forms already claimed by an existing group, → its canonicalId. */
function claimedBy(groups: readonly AliasGroup[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const g of groups) {
    for (const a of [g.canonical, ...g.aliases]) out.set(normName(a), g.canonicalId)
  }
  return out
}

/**
 * Decide which proposed groups are safe to merge unattended. PURE — no IO, so the whole policy
 * is testable without a vault.
 *
 * `cosineOf` supplies each candidate's minimum pairwise cosine (the report already computes it
 * as `cosineMin`); a candidate with no score is refused rather than assumed good.
 */
export function decideAutoMerges(
  candidates: readonly AliasCandidate[],
  existing: readonly AliasGroup[],
  cosineOf: (c: AliasCandidate) => number | undefined,
  opts: { minCosine?: number; maxMembers?: number } = {}
): AutoMergeDecision[] {
  const minCosine = opts.minCosine ?? AUTOMERGE_MIN_COSINE
  const maxMembers = opts.maxMembers ?? AUTOMERGE_MAX_MEMBERS
  const claimed = claimedBy(existing)

  return candidates.map((candidate) => {
    const cos = cosineOf(candidate)
    if (typeof cos !== 'number' || !(cos >= minCosine)) {
      return { candidate, merged: false, reason: 'below-cosine' as const }
    }
    if (candidate.members.length > maxMembers) {
      return { candidate, merged: false, reason: 'too-many-members' as const }
    }
    // A member already whitelisted to a DIFFERENT canonical id means the whitelist and the
    // clusterer disagree. The whitelist is hand-audited, so it wins and the group is refused —
    // silently re-pointing an entity a human already placed would be the worst failure here.
    const owners = new Set(
      candidate.members.map((m) => claimed.get(normName(m))).filter((x): x is string => !!x)
    )
    if (owners.size > 1) {
      return { candidate, merged: false, reason: 'conflicts-with-whitelist' as const }
    }
    if (!hasContainmentSpine(candidate.members)) {
      return { candidate, merged: false, reason: 'no-containment' as const }
    }
    return { candidate, merged: true }
  })
}

/** Turn an approved candidate into the whitelist row shape. The canonical id mirrors what the
 *  review report suggests, so an auto-merge and a hand-pasted merge produce the same row —
 *  EXCEPT for `source`, which is the one thing that must differ. Everything reaching this function
 *  is by definition machine-decided (decideAutoMerges is its only real caller), so the stamp is
 *  unconditional here rather than a parameter a future caller could forget to pass. */
export function toAliasGroup(candidate: AliasCandidate, kindHint = 'person'): AliasGroup {
  const canonical = candidate.canonical
  const slug = normName(canonical).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  return {
    canonicalId: `${kindHint}:${slug}`,
    canonical,
    aliases: [...new Set(candidate.members.map((m) => normName(m)))].sort(),
    source: 'auto'
  }
}

/** Append approved groups to the existing whitelist, skipping any whose canonicalId is already
 *  present. Returns the merged list — the caller persists it. Idempotent by construction, so a
 *  repeat tick is a no-op. */
export function applyAutoMerges(
  existing: readonly AliasGroup[],
  decisions: readonly AutoMergeDecision[],
  kindHint = 'person'
): { groups: AliasGroup[]; added: AliasGroup[] } {
  const byId = new Map(existing.map((g) => [g.canonicalId, g]))
  const added: AliasGroup[] = []
  for (const d of decisions) {
    if (!d.merged) continue
    const g = toAliasGroup(d.candidate, kindHint)
    if (byId.has(g.canonicalId)) continue
    byId.set(g.canonicalId, g)
    added.push(g)
  }
  return { groups: [...byId.values()], added }
}
