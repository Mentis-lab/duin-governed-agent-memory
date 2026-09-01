// derivation-cascade.ts — reasoning-trace provenance STAGE 2: the forward cascade.
//
// Stage 1 recorded verified DEPENDS_ON edges (a fold-rule depends_on its input claims). This is the
// consequence: when a premise is RETIRED (superseded/vetoed), the derived rules that rested on it must
// ALSO fall — but ONLY those that lose their last support. This is FOUNDATIONAL belief-base contraction
// (a belief survives iff a justification survives; AGM/Hansson), implemented as the cheap ℕ-semiring /
// counting end of the DRed spectrum: a rule with an alternate intact derivation SURVIVES (no
// over-deletion), and the walk is a forward reachability over the derivation DAG. Nobody in LLM agent
// memory ships this — production systems do newest-wins contradiction supersession only; the derivation-
// dependency cascade is the 40-year-old TMS move (Doyle 1979 / de Kleer 1986) the 2026 provenance cluster
// re-imports (see PLANNING/DUIN_SIA_REASONING_TRACE_FRONTIER.md). PURE: no store, no clock — the caller
// (operator-model) resolves the ids to soft-deletes (invalidatedAt, never hard-delete: bi-temporal audit).

export interface CascadeFact {
  id: string
  /** already soft-deleted (bi-temporal valid-TO). A retired premise. */
  invalidatedAt?: number
  /** candidate | provisional | promoted | reverted | vetoed — human-CONFIRMED rules are protected. */
  status?: string
  /** Stage-1 derivation edges: each is one justification (the premise ids it was folded from). */
  dependsOn?: { depends_on: string[] }[]
}

/** A human-CONFIRMED rule earned independent merit through the govern gate, so a retired premise must
 *  NOT auto-retract it (the operator retires it explicitly if they disagree). Only un-confirmed derived
 *  facts cascade. This is the governance-safe answer to the frontier "knowledge entanglement" risk. */
const isProtected = (status?: string): boolean => status === 'promoted' || status === 'provisional'

/** PURE forward cascade. Given the current facts + a set of just-RETIRED premise ids, return the ids of
 *  DERIVED facts that must ALSO be invalidated — those that lose their LAST support. Recursive: an
 *  invalidated rule becomes a retired premise for higher-order rules (reflection folds rules→principles),
 *  propagated by a worklist with a visited-guard so it TERMINATES on any graph (cycles included).
 *  Over-retraction-safe: a fact survives if ANY one derivation is fully intact (alternate support), a
 *  MISSING premise (evicted, never retired) counts as LIVE so eviction never cascades, and a human-
 *  confirmed rule is never cascaded. Returns ids in cascade order (a fact appears at most once). */
export function cascadeTargets(facts: CascadeFact[], retired: Iterable<string>): string[] {
  const dead = new Set<string>() // retired ∪ already-invalidated/vetoed ∪ cascaded-this-pass — "not live"
  for (const id of retired) dead.add(id)
  for (const f of facts) if (f.invalidatedAt != null || f.status === 'vetoed') dead.add(f.id)

  // A premise is LIVE unless it is in `dead`. A missing id (not in the store) is treated as live —
  // eviction is not retraction, so an evicted premise must not knock out a rule that cited it.
  const isLive = (pid: string): boolean => !dead.has(pid)
  // A derived fact is SUPPORTED iff at least one of its derivations has ALL premises live (foundational).
  const supported = (f: CascadeFact): boolean =>
    !!f.dependsOn &&
    f.dependsOn.some((e) => e.depends_on.length > 0 && e.depends_on.every(isLive))

  const out: string[] = []
  const work: string[] = [...retired]
  const seen = new Set<string>()
  while (work.length) {
    const p = work.shift()!
    if (seen.has(p)) continue
    seen.add(p)
    for (const f of facts) {
      if (dead.has(f.id)) continue // already dead (retired / invalidated / cascaded)
      if (isProtected(f.status)) continue // human-confirmed → earned merit, never auto-cascaded
      // Only reconsider facts that actually DEPEND on the just-fallen premise p.
      if (!f.dependsOn || !f.dependsOn.some((e) => e.depends_on.includes(p))) continue
      if (!supported(f)) {
        dead.add(f.id) // lost its last support → cascade out
        out.push(f.id)
        work.push(f.id) // propagate: f is now a fallen premise for ITS dependents
      }
    }
  }
  return out
}
