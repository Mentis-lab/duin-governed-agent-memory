// derivation-verify.ts — the NLI VERIFIER for reasoning-trace provenance (Stage 1).
//
// A consolidation/reflection FOLD collapses several input claims into one higher-order rule. That fold
// is a DERIVATION: the rule DEPENDS_ON its input claims. But a stored reasoning trace is TESTIMONY, not
// proof — models verbalize their true reasoning a minority of the time (Turpin et al., NeurIPS 2023,
// arXiv:2305.04388; Chen et al./Anthropic 2025, arXiv:2505.05410, reveal rate often <20%). So we must
// NOT trust a fold's "why" on the model's say-so. This independently VERIFIES each derivation edge by
// NLI entailment — do the premises (input claims) JOINTLY entail the hypothesis (the folded rule)? —
// mirroring operator-govern's independent jury. Key-gated + abstain-on-miss: no key / parse-miss ⇒ null
// (the edge is recorded UNVERIFIED, never a false 'entails'). The prompt/parse are PURE; the model call
// is injected (defaultVerifyDeps) so the fold stays unit-testable without a key or the electron registry.
import { chatOnce, routeModel } from '../providers/registry'

export type EntailmentLabel = 'entails' | 'neutral' | 'contradicts'

/** The independent NLI verdict on a derivation edge. `verifier: null` = abstained (no key / parse-miss)
 *  — the honest "couldn't verify ≠ verified false" convention, mirroring operator-govern's jury. */
export interface VerifyVerdict {
  label: EntailmentLabel
  score: number
  rationale: string
  verifier: string | null
}

export interface VerifyDeps {
  /** Do the premises JOINTLY entail the hypothesis? null ⇒ abstained (no engine / parse-miss). */
  verify(premises: string[], hypothesis: string): Promise<VerifyVerdict | null>
}

/** One fold's output, carrying the provenance the return type used to discard: the folded rule text,
 *  the input-claim ids it collapsed (the DEPENDS_ON targets), and the independent NLI verdict. */
export interface DerivedFold {
  rule: string
  from: string[]
  verify: VerifyVerdict | null
}

export const VERIFY_SYSTEM =
  'You are an NLI verifier, NOT an extractor. Given numbered PREMISES (an operator\'s input claims) and ' +
  'a HYPOTHESIS (a rule folded from them), decide whether the premises JOINTLY entail the hypothesis. ' +
  'Reply with ONLY compact JSON: {"label":"entails"|"neutral"|"contradicts","score":0..1,"rationale":"one clause"}. ' +
  'entails = the hypothesis follows from the premises; neutral = under-supported; contradicts = conflicts with them.'

/** PURE — the entailment prompt (numbered premises + the hypothesis). */
export function entailmentPrompt(premises: string[], hypothesis: string): string {
  return premises.map((p, i) => `PREMISE ${i + 1}. ${p}`).join('\n') + `\n\nHYPOTHESIS. ${hypothesis}`
}

/** PURE — parse the judge reply → verdict, or null on ANY miss (abstain, never a false positive). */
export function parseVerifyReply(raw: string, verifier: string | null): VerifyVerdict | null {
  try {
    const m = /\{[\s\S]*\}/.exec(raw)
    if (!m) return null
    const o = JSON.parse(m[0]) as { label?: unknown; score?: unknown; rationale?: unknown }
    const label = o.label === 'entails' || o.label === 'neutral' || o.label === 'contradicts' ? o.label : null
    if (!label) return null
    const score = typeof o.score === 'number' && o.score >= 0 && o.score <= 1 ? o.score : 0.5
    const rationale = typeof o.rationale === 'string' ? o.rationale.slice(0, 200) : ''
    return { label, score, rationale, verifier }
  } catch {
    return null
  }
}

/** The live, key-gated verifier (mirrors reflection-rollup / consolidation-synthesis defaults). */
export const defaultVerifyDeps: VerifyDeps = {
  async verify(premises, hypothesis) {
    if (premises.length === 0 || !hypothesis.trim()) return null
    let m: string | null
    try {
      m = routeModel('extraction')
    } catch {
      return null
    }
    if (!m) return null // no API key ⇒ abstain (edge recorded unverified, fail-safe)
    try {
      const r = await chatOnce(
        [
          { role: 'system', content: VERIFY_SYSTEM },
          { role: 'user', content: entailmentPrompt(premises, hypothesis) }
        ],
        m,
        undefined,
        { purpose: 'other', role: 'derivation-verify' }
      )
      return parseVerifyReply(r.content, m)
    } catch {
      return null
    }
  }
}
