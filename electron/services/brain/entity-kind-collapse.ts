// entity-kind-collapse — the CROSS-KIND half of the duplicate-entity problem.
//
// Entity identity in the construction/retrieval graph is `<kind>:<slug>`, so the kind is part of
// the primary key. The extractor is allowed six kinds with no definitions distinguishing them
// (construct.ts:58), and it is not deterministic about which one a thing gets. When it calls
// `bilibili` an `org` on one pass and a `project` on the next it does not REVISE an entity — it
// mints a second one. Measured on the live vault 2026-08-04: 635 labels exist under more than one
// kind, as 635 SEPARATE nodes (zero of them share an id), accounting for ~784 redundant entities.
//
// WHY THIS IS NOT THE EXISTING AUTOMERGE. entity-automerge.ts gates on embedding cosine plus
// lexical containment, to answer "are these two DIFFERENT labels the same thing?" — a genuinely
// uncertain question that deserves a conservative, expensive test. This module answers a much
// easier one: "is this the SAME label, recorded under two kinds?" That needs no embedder, no
// O(N^2) pass, and no cap. It is exact, deterministic, and cheap, which is why it can run over
// the whole census while the cosine clusterer is capped at the first 1,500 labels.
//
// THE COLLAPSE KEY IS THE NORMALIZED LABEL, NOT THE SLUG. This is load-bearing. The slugifier is
// also unstable on CJK: 端午试玩会 exists live as `event:duanwu-trial`, `project:duan-wu-shi-wan-hui`
// AND `topic:端午试玩会` — pinyin, a different pinyin segmentation, and raw CJK. Keying on the slug
// would treat those as three different things and collapse nothing. Keying on the label collapses
// all three AND fixes the slug churn for that label, because every alias resolves to one stable
// canonicalId.
//
// `project` IS DELIBERATELY ABSENT from the precedence list below. It is a catch-all — the live
// 1,470 construction `project` entities include games, companies, platforms, a resort and several
// documents — and it is slated for removal from the extractor vocabulary entirely. A canonical id
// minted as `project:<slug>` would carry a retired kind forever, and `resolveNodeId` reconstructs
// the persisted `kind` column from that prefix. So `project` can only ever LOSE here.

import { normName, slugifyLabel, type AliasGroup } from './entity-resolver'

/** The entity shape this policy needs — structurally compatible with ConstructedData['entities']. */
export interface CollapseEntity {
  id: string
  label: string
  kind: string
}

/**
 * Which kind wins when one label carries several. Ordered most- to least-specific: the more
 * specific the kind, the more evidence it took the extractor to assign it, and `topic` is the
 * weakest claim so it loses to everything.
 *
 * A kind NOT in this list can never win. That is how `project` is excluded, and it also means a
 * future extractor kind is safe-by-default: it will be treated as a loser until someone
 * deliberately ranks it.
 */
export const KIND_PRECEDENCE: readonly string[] = ['person', 'org', 'event', 'decision', 'topic']

export interface CollapseGroup extends AliasGroup {
  source: 'auto-kind'
  /** The kinds this label was found under, for the log and the review queue. */
  kinds: string[]
}

export interface CollapseDecision {
  groups: CollapseGroup[]
  /** Labels examined but not collapsed, by reason — a skipped duplicate must be explainable. */
  skipped: Record<string, number>
}

function bump(m: Record<string, number>, k: string): void {
  m[k] = (m[k] ?? 0) + 1
}

/**
 * Decide the cross-kind collapses for a construction census.
 *
 * Pure: no IO, no clock, no embedder. `existing` is the whitelist already in force — a label it
 * already governs is left alone, because a human (or the containment-spine automerge) has already
 * ruled on that identity and this pass must not overrule it.
 */
export function decideKindCollapse(
  entities: readonly CollapseEntity[],
  existing: readonly AliasGroup[] = []
): CollapseDecision {
  const skipped: Record<string, number> = {}

  // Labels the active whitelist already speaks for, and ids it already targets.
  const governed = new Set<string>()
  for (const g of existing) for (const a of g.aliases) governed.add(normName(a))
  const takenIds = new Set(existing.map((g) => g.canonicalId))

  // normalized label -> its surface forms and the kinds it was seen under
  const byLabel = new Map<string, { surfaces: Set<string>; kinds: Set<string> }>()
  for (const e of entities) {
    const key = normName(e.label ?? '')
    if (!key) continue
    let slot = byLabel.get(key)
    if (!slot) { slot = { surfaces: new Set(), kinds: new Set() }; byLabel.set(key, slot) }
    slot.surfaces.add(String(e.label).trim())
    slot.kinds.add(String(e.kind))
  }

  const groups: CollapseGroup[] = []
  for (const [key, slot] of byLabel) {
    if (slot.kinds.size < 2) continue // one kind — nothing to collapse
    if (governed.has(key)) { bump(skipped, 'already-in-whitelist'); continue }

    const winner = KIND_PRECEDENCE.find((k) => slot.kinds.has(k))
    if (!winner) { bump(skipped, 'no-rankable-kind'); continue }

    // Prefer the surface form the winning kind actually used; fall back to the longest, which is
    // the most informative rendering (`B站` vs `bilibili` — keep whichever the winner carried).
    const canonical =
      Array.from(slot.surfaces).find((s) => normName(s) === key) ??
      Array.from(slot.surfaces).sort((a, b) => b.length - a.length)[0]

    const canonicalId = `${winner}:${slugifyLabel(canonical)}`
    if (takenIds.has(canonicalId)) { bump(skipped, 'canonical-id-already-used'); continue }
    if (!slugifyLabel(canonical)) { bump(skipped, 'empty-slug'); continue }

    takenIds.add(canonicalId)
    groups.push({
      canonicalId,
      canonical,
      aliases: Array.from(slot.surfaces),
      source: 'auto-kind',
      kinds: Array.from(slot.kinds).sort()
    })
  }

  groups.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId))
  return { groups, skipped }
}
