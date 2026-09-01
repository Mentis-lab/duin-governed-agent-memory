// entity-kind-collapse-tick — the IO half of the cross-kind collapse.
//
// The policy lives in entity-kind-collapse.ts (pure, tested). This reads the construction census,
// decides, and APPENDS the approved groups to `<vault>/.duin/_state/entity-aliases.json` — the same
// per-vault whitelist loadAliasGroups reads and the containment-spine automerge writes. Nothing
// here is a new merge mechanism: it writes the rows a human would have pasted.
//
// ORDERING, deliberately: this runs BEFORE runEntityAutoMergeTick on the same pass. Both write the
// same file, and the cross-kind pass is the exact/deterministic one — letting it establish the
// canonical ids first means the cosine-and-containment pass sees an already-collapsed census and
// cannot propose a group that fights one. (Until 2026-08-04 the automerge was absent from every
// packaged build, so this file had exactly one writer; it is about to have two.)
//
// Idempotent by construction rather than by a version marker: once a label is in the whitelist,
// `decideKindCollapse` skips it as `already-in-whitelist`, so a second run is a no-op.

import { aliasWhitelistUnreadable, loadAliasGroups, type AliasGroup } from './entity-resolver'
import { aliasFilePath, writeAliasGroups } from './entity-automerge-tick'
import { decideKindCollapse, type CollapseEntity, type CollapseGroup } from './entity-kind-collapse'

export interface KindCollapseResult {
  /** cross-kind labels found this run */
  proposed: number
  /** groups written */
  merged: number
  /** refused, by reason — a skipped duplicate must be explainable */
  skipped: Record<string, number>
  /** the groups written, for the log and for a dry run */
  groups: CollapseGroup[]
}

const EMPTY: KindCollapseResult = { proposed: 0, merged: 0, skipped: {}, groups: [] }

/**
 * Own kill switch, DEFAULT ON (`!== '0'`), and the reason it exists.
 *
 * Until 2026-08-04 the only way to stop this pass was `DUIN_CLAIM_METABOLISM_TICK_MS=0`, which is
 * the whole metabolism tick's switch — it also stops claim metabolism, write-time relink, graph
 * sync and the tombstone re-apply. That is what the incident mitigation had to reach for, so a
 * cost defect in ONE pass silenced four unrelated ones. This narrows the blast radius to the pass
 * that earned it.
 *
 * A dry run is deliberately NOT gated: an operator turning this off still needs to see what it
 * would have done, and a dry run writes nothing.
 */
export function kindCollapseEnabled(): boolean {
  return process.env.DUIN_ENTITY_KIND_COLLAPSE !== '0'
}

/** Narrow an untyped construction into the shape the policy needs. A malformed census yields no
 *  entities rather than throwing on a background tick. */
export function entitiesFromConstruction(construction: unknown): CollapseEntity[] {
  const ents = (construction as { entities?: unknown } | null | undefined)?.entities
  if (!Array.isArray(ents)) return []
  const out: CollapseEntity[] = []
  for (const e of ents) {
    if (!e || typeof e !== 'object') continue
    const { id, label, kind } = e as Record<string, unknown>
    if (typeof label !== 'string' || !label.trim()) continue
    if (typeof kind !== 'string' || !kind) continue
    out.push({ id: typeof id === 'string' ? id : '', label, kind })
  }
  return out
}

/**
 * Run one collapse pass. `dryRun` computes and returns without writing — used by the debug
 * surface so the operator can see exactly what would change before it changes.
 */
export function runKindCollapseTick(
  vaultDir: string | null | undefined,
  construction: unknown,
  opts: { dryRun?: boolean } = {}
): KindCollapseResult {
  if (!vaultDir) return EMPTY
  if (!opts.dryRun && !kindCollapseEnabled()) return EMPTY
  const entities = entitiesFromConstruction(construction)
  if (entities.length === 0) return EMPTY

  // ABSTAIN when the whitelist is on disk but unreadable, BEFORE deciding anything. `existing`
  // would come back empty (loadAliasGroups swallows the parse error), so every already-governed
  // label would be re-proposed and the append at the bottom would write `[...[], ...groups]` over
  // the operator's hand-authored rows. Skipping a tick costs 15 minutes; the overwrite is
  // permanent. Gated for a dry run too — not for safety, since that writes nothing, but because a
  // dry run computed from a phantom-empty whitelist would report a collapse of the whole census
  // and quietly tell the operator the opposite of the truth.
  if (aliasWhitelistUnreadable(vaultDir)) {
    console.warn(
      `[entity-alias-guard] ${aliasFilePath(vaultDir)} exists but did not parse — kind-collapse abstained (nothing written; fix or remove the file)`
    )
    return { proposed: 0, merged: 0, skipped: { 'whitelist-unreadable': 1 }, groups: [] }
  }

  const existing = loadAliasGroups(vaultDir)
  const { groups, skipped } = decideKindCollapse(entities, existing)
  if (groups.length === 0) return { proposed: 0, merged: 0, skipped, groups: [] }

  if (opts.dryRun) {
    return { proposed: groups.length, merged: 0, skipped, groups }
  }

  // Append, never replace: the hand-authored rows and the automerge's rows both stay.
  const next: AliasGroup[] = [...existing, ...groups]
  writeAliasGroups(vaultDir, next)
  return { proposed: groups.length, merged: groups.length, skipped, groups }
}

export { aliasFilePath }
