// reveal-service.ts — the single composition a route calls to run a governed live reveal for a drop.
//
// Ties the pieces together: load the operator overlays (edge-verdicts suppress vetoed edges; the alias
// overlay folds operator-confirmed merges into resolution), read per-(source,edge-type) calibration
// TRUST, and annotate each proposed edge with a governance ACCEPT decision (auto vs review) via
// shouldAutoAccept. Frames go through the INJECTED sink (the route wires it to sseFrame over /agui), so
// this is unit-tested without a server or a key.
//
// The route wiring (the only remaining app-integration) is minimal:
//   revealForSource(vault, { id, text }, { emit: (f) => sseFrame(res, f), rootLabel, ... })
// invoked where the capture/ingest birth happens (captureWork return / runIngest onEvent).

import { runReveal, type GraphFrame, type RunRevealResult } from './reveal-frames'
import type { ScopedSource, ExtractionChat } from './construct-one-source'
import { loadEdgeVerdicts } from './edge-verdicts'
import { loadAliasOverlay } from './operator-alias-overlay'
import { revealTrust, revealKind, type EdgeSource } from './reveal-outcomes'
import { shouldAutoAccept, type AutoAcceptPolicy, type AcceptDecision } from './reveal-governance'
import { getConstruction } from './construct'
import { matchExistingEntities, wave1Frames, type ExistingEntity } from './reveal-wave1'

// Per-source prior confidence. The LLM extraction emits no per-edge confidence yet, so these priors
// stand in: wiki/alias are STRUCTURAL (a real link / a whitelist hit) so high; similarity medium; a
// pure LLM inference lower. These are exactly the floors the RSI edge-confidence knob would later tune.
export const SOURCE_CONFIDENCE: Record<EdgeSource, number> = { wiki: 0.95, alias: 0.9, sim: 0.75, llm: 0.6 }

export interface RevealServiceOptions {
  emit: (frame: GraphFrame) => void
  chat?: ExtractionChat
  model?: string | null
  rootLabel?: string
  rootKind?: string
  wave1?: GraphFrame[]
  policy?: AutoAcceptPolicy
  /** existing entities to name-match for deterministic Wave-1 (default: the cached construction) */
  existingEntities?: ExistingEntity[]
}

/** Run a governed live reveal for one dropped source (loads overlays + trust, applies auto-accept). */
export async function revealForSource(
  vault: string,
  source: ScopedSource,
  opts: RevealServiceOptions
): Promise<RunRevealResult> {
  const edgeVerdicts = loadEdgeVerdicts(vault)
  const aliasOverlay = loadAliasOverlay(vault)
  const trust = revealTrust(vault)
  const annotateEdge = (_from: string, _to: string, edgeType: string, src: EdgeSource): { accept: AcceptDecision; confidence: number } => {
    const confidence = SOURCE_CONFIDENCE[src] ?? 0.6
    return { accept: shouldAutoAccept(trust.get(revealKind(src, edgeType)), confidence, opts.policy), confidence }
  }
  // Deterministic Wave-1: existing entities name-dropped in the text → instant alias edges to real nodes.
  const existing = opts.existingEntities ?? getConstruction()?.entities ?? []
  const matches = matchExistingEntities(source.text, existing)
  const wave1 = [...(opts.wave1 ?? []), ...wave1Frames(matches, source.id, annotateEdge)]

  // Cross-wave reconciliation: let Wave-2's LLM entities FUSE onto the SAME existing nodes Wave-1
  // matched (keyed by label), so a fresh 'concept:walled-data-garden' merges onto the existing
  // 'topic:walled-data-garden' instead of duplicating it. Scoped to this drop's matched nodes (not the
  // whole vault) to bound over-merge; operator-confirmed aliases still win over the auto-reconcile.
  const reconcileOverlay = new Map<string, string>()
  for (const m of matches) reconcileOverlay.set(m.label.trim().toLowerCase(), m.id)
  for (const [k, v] of aliasOverlay) reconcileOverlay.set(k, v)

  return runReveal(source, {
    emit: opts.emit,
    chat: opts.chat,
    model: opts.model,
    rootLabel: opts.rootLabel,
    rootKind: opts.rootKind,
    wave1,
    edgeVerdicts,
    aliasOverlay: reconcileOverlay,
    annotateEdge
  })
}
