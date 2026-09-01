// contrast-extraction.ts — Capture: MetaEvo Contrastive Delta Abstraction (CDA). Learn from the
// DIFFERENCE between a GOOD trace (an endorsed answer) and a BAD trace (a correction), not only from
// the positive. Two stages, deliberately split so the un-gameable part is the LLM's:
//   1. PAIRING (pure, lexical): which success is ABOUT THE SAME THING as which correction — a
//      significant-token overlap join (mirrors consolidation's clusterByCohesion). Deterministic.
//   2. ABSTRACTION (key-gated LLM): given a matched good+bad pair, the model states the DELTA that
//      made one right and the other wrong as ONE durable rule. A heuristic token-diff here would be
//      weak and the verifier would reject it — so the delta→rule step is the injected LLM's job.
// Rules land as human-gated CANDIDATE facts (the caller recordFacts them), never auto-grounded.
//
// PURE + electron-free (only imports synthTokens from consolidation-synthesis) so it unit-tests
// headless with a fake chat. The production LLM + recordFacts + trace readers are wired by the
// /debug/contrast route (brain-native-routes-2.ts), the same un-inert pattern as /debug/reveal.

import { synthTokens } from './consolidation-synthesis'
import { contentLanguageDirective } from './content-language'

/** A GOOD trace: an endorsed (query, answer). Mirrors success-miner.SuccessTrace's used fields. */
export interface SuccessTraceLike {
  query: string
  answer: string
}
/** A BAD trace: what the model produced, what the operator corrected it to, and why. From
 *  corrections.jsonl (learn-bridge CorrectionRow). */
export interface CorrectionTraceLike {
  aiOutput: string
  correction: string
  why: string
}
/** The injected LLM seam (same shape as construct-one-source.ExtractionChat) — a fake in tests, a
 *  chatStream/chatOnce wrapper in prod. */
export type ContrastChat = (prompt: string, model: string) => Promise<{ text: string; finishReason: string | null }>

export interface ContrastPair {
  good: SuccessTraceLike
  bad: CorrectionTraceLike
  /** count of significant tokens the two traces share (the pairing strength). */
  overlap: number
}

/** Pair each success with the ONE correction it shares the most significant tokens with (≥ minOverlap),
 *  so the contrast is genuinely about the SAME topic. Pure lexical join (reuses consolidation's
 *  synthTokens: >3-char / CJK words, stopword-stripped). A success with no ≥minOverlap correction is
 *  dropped — there's nothing to contrast it against. PURE. */
export function contrastPair(
  successes: SuccessTraceLike[],
  corrections: CorrectionTraceLike[],
  minOverlap = 2
): ContrastPair[] {
  if (successes.length === 0 || corrections.length === 0) return []
  const badToks = corrections.map((b) => synthTokens(`${b.aiOutput} ${b.correction} ${b.why}`))
  const pairs: ContrastPair[] = []
  for (const g of successes) {
    const gToks = synthTokens(`${g.query} ${g.answer}`)
    let best = -1
    let bestJ = -1
    for (let j = 0; j < corrections.length; j++) {
      let n = 0
      for (const t of gToks) if (badToks[j].has(t)) n++
      if (n > best) {
        best = n
        bestJ = j
      }
    }
    if (best >= minOverlap && bestJ >= 0) pairs.push({ good: g, bad: corrections[bestJ], overlap: best })
  }
  return pairs
}

/** PURE: the contrast prompt — show the GOOD (what worked) and the BAD (what the model produced, the
 *  operator's correction, and their reasoning), ask for ONE durable imperative rule capturing the
 *  DELTA. JSON-only for robust parsing. */
export function buildContrastPrompt(pair: ContrastPair): string {
  // Pin the synthesized rule to the language of the operator's correction/reasoning — the traces
  // that actually carry the lesson — so a CN/JP operator's rules stay in their language and keep
  // matching the notes they came from. '' for English → prompt unchanged.
  const langPin = contentLanguageDirective(`${pair.bad.correction} ${pair.bad.why} ${pair.good.answer}`)
  return [
    'A GOOD interaction and a BAD one (that the operator later corrected) are shown. Identify the',
    'DIFFERENCE that made the good one right and the bad one wrong, and state it as ONE durable,',
    'general imperative rule (a single sentence, no preamble). Reply ONLY with JSON:',
    '{"rule":"..."} — or {"rule":null} if there is no generalizable lesson.',
    '',
    'GOOD — request:',
    pair.good.query,
    'GOOD — endorsed answer:',
    pair.good.answer,
    '',
    'BAD — what the model produced:',
    pair.bad.aiOutput,
    "BAD — the operator's correction:",
    pair.bad.correction,
    "BAD — why (the operator's reasoning):",
    pair.bad.why,
    ...(langPin ? ['', langPin] : [])
  ].join('\n')
}

export interface ContrastResult {
  /** Durable candidate rules abstracted from the contrasts (one per pair that yielded a real rule). */
  rules: string[]
  /** How many pairs were run. */
  consumed: number
  status: 'ok' | 'no-model'
}

/** Run the key-gated LLM contrast over each pair → durable rules. `model` null ⇒ no-model no-op
 *  (key-gated off, never throws). Best-effort per pair: a declined/truncated/throwing pair is skipped.
 *  Does NOT write — the caller recordFacts the rules as human-gated candidates. */
export async function contrastiveAbstraction(
  pairs: ContrastPair[],
  opts: { chat: ContrastChat; model: string | null }
): Promise<ContrastResult> {
  if (!opts.model) return { rules: [], consumed: 0, status: 'no-model' }
  const rules: string[] = []
  for (const p of pairs) {
    try {
      const r = await opts.chat(buildContrastPrompt(p), opts.model)
      if (r.finishReason === 'length') continue // a truncated JSON body is not trustworthy
      const rule = parseRule(r.text)
      if (rule) rules.push(rule)
    } catch {
      // skip this pair; the others still run
    }
  }
  return { rules, consumed: pairs.length, status: 'ok' }
}

/** Extract the `rule` string from a `{"rule":"..."}` reply (tolerant of surrounding prose). Returns
 *  null for a missing/null/"NONE" rule or unparseable JSON. PURE. */
export function parseRule(text: string): string | null {
  const m = (text ?? '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as { rule?: unknown }
    const rule = typeof o.rule === 'string' ? o.rule.trim() : ''
    return rule && !/^none\b/i.test(rule) ? rule : null
  } catch {
    return null
  }
}
