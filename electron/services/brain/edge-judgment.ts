// edge-judgment.ts — the operator-judgment fan-out for a reveal.
//
// When the operator ENDORSES or VETOES a proposed edge (or CONFIRMS/REJECTS a merge), that one action
// must feed several engines at once (design doc, "Engine wiring"):
//   - edge-verdicts overlay  → a vetoed edge is suppressed on the next graph read / replay
//   - reveal-outcomes        → a per-(source,edge-type) calibration sample (trust)
//   - the learning loop       → a /learn/correction payload (endorse = positive+rule; veto = correction)
//
// buildEdgeJudgment is PURE (returns the payloads; clock injected via `ts`); applyEdgeJudgment performs
// the two vault writes it owns (edge-verdict + reveal-outcome) and hands the learn payload to an INJECTED
// poster (the route wires it to POST /learn/correction — which also mints the governed endorsement-fact).
//
// NOT yet wired here (flagged in the design doc's remaining list): markUseful reinforcement of the
// underlying claim (no production caller today) and the governance recordFeedback(ratify|dismiss) call
// (needs the duin-edge-promotion capability). Those hang off the same action once built.

import { recordEdgeVerdict, type EdgeVerdictRecord } from './edge-verdicts'
import { registerRevealOutcome, revealKind, type RevealOutcomeRecord, type EdgeSource } from './reveal-outcomes'
import { recordAliasVerdict, type AliasVerdictRecord } from './operator-alias-overlay'

export type EdgeVerdictInput = 'endorse' | 'veto'

export interface EdgeJudgmentInput {
  from: string
  to: string
  edgeType: string
  /** where the proposed edge came from (drives the calibration kind) */
  source: EdgeSource
  /** the confidence the edge was proposed at (0..1) */
  confidence: number
  verdict: EdgeVerdictInput
  /** the operator's reason (optional) */
  why?: string
  /** the rule an ENDORSE implies (e.g. "a pricing memo supersedes prior pricing"); required to GOVERN
   *  the endorsement as an operator rule — a bare endorse (no rule) still records taste but isn't governed. */
  candidateRule?: string
  /** injected clock (keeps buildEdgeJudgment pure/deterministic) */
  ts: string
}

/** A /learn/correction payload — the operator-only learning stream (never carries `source`). */
export interface LearnCorrectionPayload {
  polarity: 'positive' | 'correction'
  skill: string
  why?: string
  /** endorse: the distilled rule to govern */
  candidate_rule?: string
  /** veto: the thing that was wrong */
  correction?: string
}

export interface EdgeJudgmentEffects {
  edgeVerdict: EdgeVerdictRecord
  revealOutcome: RevealOutcomeRecord
  learn: LearnCorrectionPayload
}

/** PURE — the three effects an edge judgment produces. */
export function buildEdgeJudgment(input: EdgeJudgmentInput): EdgeJudgmentEffects {
  const endorsed = input.verdict === 'endorse'
  const edgeVerdict: EdgeVerdictRecord = {
    from: input.from,
    to: input.to,
    edgeType: input.edgeType,
    verdict: endorsed ? 'endorsed' : 'vetoed',
    ts: input.ts,
    why: input.why
  }
  const revealOutcome: RevealOutcomeRecord = {
    kind: revealKind(input.source, input.edgeType),
    source: input.source,
    edgeType: input.edgeType,
    confidence: input.confidence,
    verdict: endorsed ? 'materialized' : 'refuted',
    ts: input.ts,
    from: input.from,
    to: input.to
  }
  const learn: LearnCorrectionPayload = endorsed
    ? { polarity: 'positive', skill: 'live-node-reveal', candidate_rule: input.candidateRule, why: input.why }
    : { polarity: 'correction', skill: 'live-node-reveal', correction: `${input.from} --${input.edgeType}--> ${input.to}`, why: input.why }
  return { edgeVerdict, revealOutcome, learn }
}

export interface EdgeJudgmentDeps {
  /** wire to POST /learn/correction (server-side: appendCorrection + endorsementFact->recordFacts) */
  postLearn?: (payload: LearnCorrectionPayload) => void
}

/** Apply an edge judgment: write the edge-verdict + reveal-outcome (owned here), and hand the learn
 *  payload to the injected poster. Best-effort per side effect — one failure must not swallow the others. */
export function applyEdgeJudgment(vault: string, input: EdgeJudgmentInput, deps: EdgeJudgmentDeps = {}): EdgeJudgmentEffects {
  const eff = buildEdgeJudgment(input)
  try {
    recordEdgeVerdict(vault, eff.edgeVerdict)
  } catch (e) {
    console.warn('[edge-judgment] edge-verdict write failed:', (e as Error)?.message)
  }
  try {
    registerRevealOutcome(vault, eff.revealOutcome)
  } catch (e) {
    console.warn('[edge-judgment] reveal-outcome write failed:', (e as Error)?.message)
  }
  try {
    deps.postLearn?.(eff.learn)
  } catch (e) {
    console.warn('[edge-judgment] learn post failed:', (e as Error)?.message)
  }
  return eff
}

// ── Merge judgment (confirm/reject a proposed entity merge) ──

export interface MergeJudgmentInput {
  /** the label the model emitted for the candidate */
  label: string
  /** the existing canonical entity the operator says it IS (confirm) or is NOT (reject) */
  canonicalId: string
  verdict: 'confirm' | 'reject'
  ts: string
}

/** Record an operator merge decision into the operator-alias overlay (a confirm folds into resolution
 *  next reveal; a reject prevents the same fuzzy pair being re-proposed). */
export function applyMergeJudgment(vault: string, input: MergeJudgmentInput): AliasVerdictRecord {
  const rec: AliasVerdictRecord = { label: input.label, canonicalId: input.canonicalId, verdict: input.verdict, ts: input.ts }
  recordAliasVerdict(vault, rec)
  return rec
}
