// grounding-eval-live.ts — Foundation 1-b: the OPERATOR-ATTENDED, REAL-LABEL grounding-precision eval.
//
// Foundation 1 (grounding-eval.ts) scores the staleness signal over the REAL vault but with
// BY-CONSTRUCTION gold: an operator-PROMOTED fact is ASSUMED valid, so any flag on it counts as a false
// positive, and stale positives are TEMPLATED from resolved-decision titles. That measures over-flag
// SAFETY — it cannot answer the load-bearing question behind a flagged fact: is this fact GENUINELY
// obsolete, or a still-VALID operator preference that merely MENTIONS a resolved topic? A promoted
// preference ("ship on Fridays") that happens to name a now-resolved project would be flagged AND is a
// real false positive; a promoted note that describes a decision that truly resolved is a real true
// positive. By-construction gold conflates the two.
//
// This module closes that gap with option-(b): an LLM-JUDGE supplies REAL labels for flagged facts, so
// precision is measured against independent judgment instead of an assumption. The judge is INJECTED
// (JudgeDeps) — the module stays PURE + electron-free (mirrors grounding-eval.ts + judgment-measure-live.ts),
// so it unit-tests headless and the /debug route supplies the real facts + matchFn + local-first judge.
//
// OPERATOR-ATTENDED: every judge label is persisted to an adjudication QUEUE (grounding-eval-labels.jsonl);
// the operator can append an operatorLabel that OVERRIDES the judge (the human is the higher authority).
// The eval's precision/false-positive-rate is also recorded as a first-class calibration domain
// (grounding-staleness.jsonl) so retrieval precision becomes a MEASURED signal with a Wilson lower bound,
// exactly like reveal-outcomes.ts's per-source trust.
//
// KEYLESS-SAFE + FAIL-OPEN: no model ⇒ the judge abstains (null) on everything ⇒ the result is marked
// `labeled: 0` with null metrics — never a fabricated label, never a false precision claim, never a crash.

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { wilson, CAL_MIN_N } from './calibration-resolve-native'

export type JudgeLabel = 'stale' | 'valid'

/** A fact to score — the ACTIVE grounding row (promoted | provisional). */
export interface JudgedFact {
  id: string
  text: string
}

/** The injected LLM-JUDGE (reuses the MeasureDeps-style keyless-safe chat pattern). For a fact the
 *  real matchStale signal FLAGGED, `judgeStale` decides the load-bearing question: is the fact
 *  GENUINELY obsolete ('stale') or a still-VALID operator preference that merely mentions a resolved
 *  topic ('valid')? Returns null to ABSTAIN (no engine / undecidable) — null is NEVER coerced to a
 *  label, so a keyless run produces no precision claim. `matchedTopic` is '' for an unflagged fact
 *  (asked for recall — did the signal MISS a genuinely-stale fact). */
export interface JudgeDeps {
  judgeStale(factText: string, matchedTopic: string): Promise<JudgeLabel | null>
}

/** One row of the operator-adjudication queue (persisted append-only to grounding-eval-labels.jsonl).
 *  `judgeLabel` is the machine label; `operatorLabel` (when the operator later appends it) OVERRIDES it. */
export interface LabelRow {
  id: string
  factText: string
  matchedTopic: string
  judgeLabel: JudgeLabel
  operatorLabel?: JudgeLabel
  ts: number
}

/** The merged, authority-resolved label for a fact (operatorLabel wins over judgeLabel). */
export interface AdjudicatedLabel {
  id: string
  factText: string
  matchedTopic: string
  judgeLabel: JudgeLabel | null
  operatorLabel?: JudgeLabel
  /** the effective label = operatorLabel ?? judgeLabel. */
  label: JudgeLabel | null
  ts: number
}

export interface StalenessJudgedScore {
  /** facts fed to the scorer. */
  total: number
  /** facts the real matchStale signal flagged. */
  flagged: number
  /** facts the judge actually LABELED (non-null) — the metric denominator. 0 ⇒ keyless / no engine. */
  labeled: number
  tp: number // flagged & judged 'stale' — a correct staleness flag
  fp: number // flagged & judged 'valid' — a BURIED valid preference (the false positive that matters)
  fn: number // NOT flagged & judged 'stale' — a genuinely-stale fact the signal MISSED
  tn: number // NOT flagged & judged 'valid' — correctly left alone
  /** facts the judge abstained (null) on — excluded from every count above. */
  abstained: number
  /** of flagged+labeled facts, the fraction genuinely stale (tp/(tp+fp)); null when none labeled. */
  precision: number | null
  /** of judged-stale facts, the fraction the signal flagged (tp/(tp+fn)); null when none. */
  recall: number | null
  /** of judged-VALID facts, the fraction WRONGLY flagged (fp/(fp+tn)) — the buried-preference RATE;
   *  null when none. Mirrors grounding-eval.ts's headline fpRate, now on REAL labels. */
  fpRate: number | null
  /** the buried valid preferences themselves, for inspection (which real preferences would be down-weighted). */
  flaggedValid: { id: string; text: string; topic: string }[]
  /** per-FLAGGED-fact judge rows (labeled only) — the adjudication-queue payload. */
  labels: LabelRow[]
}

const empty = (total: number, flagged: number, abstained: number): StalenessJudgedScore => ({
  total,
  flagged,
  labeled: 0,
  tp: 0,
  fp: 0,
  fn: 0,
  tn: 0,
  abstained,
  precision: null,
  recall: null,
  fpRate: null,
  flaggedValid: [],
  labels: []
})

/**
 * REAL-LABEL staleness scorer. For every fact: run `matchFn` (the real matchStale) to decide FLAGGED +
 * the matched topic, then ask the injected `judge` for its true label. Cross the two into a full
 * confusion matrix — precision/recall/fpRate on JUDGE labels, the independent precision option-(a)
 * lacked. A fact flagged AND judged 'valid' is a FALSE POSITIVE (a buried preference); flagged AND
 * judged 'stale' is a true positive. PURE (judge injected). Async (the judge is async). KEYLESS-SAFE:
 * a judge that abstains (null) everywhere ⇒ labeled:0, all metrics null, no fabricated precision. Any
 * judge throw is caught → that fact abstains (fail-open, never a crash). `ts` is injectable for
 * deterministic tests. Only FLAGGED + labeled facts emit a LabelRow (the operator adjudicates the
 * buried-preference question, not clearly-unrelated facts).
 */
export async function scoreStalenessJudged(
  facts: JudgedFact[],
  matchFn: (text: string) => { label: string } | null,
  judge: JudgeDeps,
  ts: number = Date.now()
): Promise<StalenessJudgedScore> {
  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0
  let flaggedCount = 0
  let abstained = 0
  const flaggedValid: StalenessJudgedScore['flaggedValid'] = []
  const labels: LabelRow[] = []

  for (const f of facts) {
    const hit = matchFn(f.text)
    const flagged = hit !== null
    const topic = hit?.label ?? ''
    if (flagged) flaggedCount++
    let label: JudgeLabel | null
    try {
      label = await judge.judgeStale(f.text, topic)
    } catch {
      label = null // fail-open: a broken judge abstains, never crashes the eval
    }
    if (label == null) {
      abstained++
      continue
    }
    if (flagged) {
      // A flagged fact is what the operator adjudicates → queue a row.
      labels.push({ id: f.id, factText: f.text, matchedTopic: topic, judgeLabel: label, ts })
      if (label === 'stale') tp++
      else {
        fp++
        flaggedValid.push({ id: f.id, text: f.text, topic })
      }
    } else {
      if (label === 'stale') fn++
      else tn++
    }
  }

  const labeled = tp + fp + fn + tn
  if (labeled === 0) return { ...empty(facts.length, flaggedCount, abstained), labels }
  return {
    total: facts.length,
    flagged: flaggedCount,
    labeled,
    tp,
    fp,
    fn,
    tn,
    abstained,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    fpRate: fp + tn ? fp / (fp + tn) : null,
    flaggedValid,
    labels
  }
}

// ──────────────────── operator-adjudication queue (grounding-eval-labels.jsonl) ────────────────────

const labelsPath = (vault: string): string => join(vault, '.duin', '_state', 'grounding-eval-labels.jsonl')

/** WRITER — append judge label rows to the adjudication queue (append-only; ensures the state dir).
 *  Best-effort: a write failure never crashes the eval (fail-open). Returns rows written. */
export function appendJudgeLabels(vault: string, rows: LabelRow[]): number {
  if (!vault || rows.length === 0) return 0
  try {
    const path = labelsPath(vault)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
    return rows.length
  } catch {
    return 0
  }
}

/** WRITER — append an OPERATOR adjudication (the human override). A row carrying only {id, operatorLabel}
 *  is enough; loadAdjudicatedLabels merges it onto the fact's judge row with the operatorLabel WINNING. */
export function appendOperatorLabel(vault: string, id: string, operatorLabel: JudgeLabel, ts: number = Date.now()): boolean {
  if (!vault || !id) return false
  try {
    const path = labelsPath(vault)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify({ id, operatorLabel, ts }) + '\n', 'utf-8')
    return true
  } catch {
    return false
  }
}

interface RawLabelRow {
  id?: unknown
  factText?: unknown
  matchedTopic?: unknown
  judgeLabel?: unknown
  operatorLabel?: unknown
  ts?: unknown
}
const asLabel = (v: unknown): JudgeLabel | undefined => (v === 'stale' || v === 'valid' ? v : undefined)

/**
 * READER — merge the append-only queue into one AdjudicatedLabel per id, with the operatorLabel
 * OVERRIDING the judgeLabel (operator = higher authority — the "operator-attended" contract). Later
 * rows update earlier fields (so a judge row followed by an operator-only row yields the operator's
 * verdict). Follows the jsonl-reader precedent (reveal-outcomes.ts / corrections.jsonl): missing file ⇒
 * [], corrupt line ⇒ skipped. The effective `label` = operatorLabel ?? judgeLabel.
 */
export function loadAdjudicatedLabels(vault: string): Map<string, AdjudicatedLabel> {
  const out = new Map<string, AdjudicatedLabel>()
  if (!vault) return out
  const path = labelsPath(vault)
  if (!existsSync(path)) return out
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return out
  }
  for (const raw of text.split(/\r?\n/)) {
    const ln = raw.trim()
    if (!ln) continue
    let o: RawLabelRow
    try {
      o = JSON.parse(ln) as RawLabelRow
    } catch {
      continue // skip a corrupt row
    }
    const id = typeof o.id === 'string' ? o.id : ''
    if (!id) continue
    const prev = out.get(id) ?? {
      id,
      factText: '',
      matchedTopic: '',
      judgeLabel: null as JudgeLabel | null,
      label: null as JudgeLabel | null,
      ts: 0
    }
    const judgeLabel = asLabel(o.judgeLabel)
    const operatorLabel = asLabel(o.operatorLabel)
    const merged: AdjudicatedLabel = {
      id,
      factText: typeof o.factText === 'string' && o.factText ? o.factText : prev.factText,
      matchedTopic: typeof o.matchedTopic === 'string' && o.matchedTopic ? o.matchedTopic : prev.matchedTopic,
      judgeLabel: judgeLabel ?? prev.judgeLabel,
      // operatorLabel is sticky once set; a later row only replaces it with another operator verdict.
      ...(operatorLabel ?? prev.operatorLabel ? { operatorLabel: operatorLabel ?? prev.operatorLabel } : {}),
      label: null,
      ts: typeof o.ts === 'number' ? o.ts : prev.ts
    }
    merged.label = merged.operatorLabel ?? merged.judgeLabel // operator OVERRIDES judge
    out.set(id, merged)
  }
  return out
}

// ──────────────────── retrieval-precision calibration domain (grounding-staleness) ────────────────────
//
// A first-class MEASURED signal for retrieval precision — the gap option-(a) named ("no calibration
// domain for retrieval"). Each FLAGGED + labeled fact is one calibration sample, mirroring
// reveal-outcomes.ts exactly: verdict 'materialized' = the staleness flag was CORRECT (judged stale);
// 'refuted' = a FALSE ALARM (judged valid — a buried preference). The Wilson lower bound of the
// materialized-rate is the conservative, gated retrieval-precision the govern loop can act on.

export const GROUNDING_STALENESS_DOMAIN = 'grounding-staleness'

export interface GroundingStalenessOutcome {
  /** the calibration kind (constant domain key — one signal, unlike reveal's per-source kinds). */
  kind: string
  /** 'materialized' = flag correct (judged stale); 'refuted' = false alarm (judged valid). */
  verdict: 'materialized' | 'refuted'
  id: string
  ts: number
}

const stalenessPath = (vault: string): string => join(vault, '.duin', '_state', 'grounding-staleness.jsonl')

/** Derive calibration outcomes from a judged score's flagged labels. When an `adjudicated` map is
 *  supplied (from loadAdjudicatedLabels), an OPERATOR verdict OVERRIDES the judge label for that id —
 *  so an operator's confirm/veto flows into the recorded precision signal (the operator-attended loop
 *  becomes load-bearing, not a dangling queue). Omitted ⇒ raw judge labels (unchanged). */
export function outcomesFromScore(
  score: StalenessJudgedScore,
  adjudicated?: Map<string, AdjudicatedLabel>
): GroundingStalenessOutcome[] {
  return score.labels.map((r) => {
    const label = adjudicated?.get(r.id)?.label ?? r.judgeLabel
    return {
      kind: GROUNDING_STALENESS_DOMAIN,
      verdict: label === 'stale' ? ('materialized' as const) : ('refuted' as const),
      id: r.id,
      ts: r.ts
    }
  })
}

/** WRITER — append staleness-precision outcomes to the calibration domain ledger (append-only; ensures
 *  the state dir). Best-effort (fail-open). Returns rows written. */
export function recordGroundingStalenessOutcomes(vault: string, outcomes: GroundingStalenessOutcome[]): number {
  if (!vault || outcomes.length === 0) return 0
  try {
    const path = stalenessPath(vault)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, outcomes.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf-8')
    return outcomes.length
  } catch {
    return 0
  }
}

/** READER — the calibration domain ledger (missing ⇒ []; corrupt line ⇒ skipped). */
export function readGroundingStalenessOutcomes(vault: string): GroundingStalenessOutcome[] {
  if (!vault) return []
  const path = stalenessPath(vault)
  if (!existsSync(path)) return []
  const out: GroundingStalenessOutcome[] = []
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return out
  }
  for (const raw of text.split(/\r?\n/)) {
    const ln = raw.trim()
    if (!ln) continue
    try {
      const o = JSON.parse(ln) as { verdict?: unknown; id?: unknown; kind?: unknown; ts?: unknown }
      const verdict = o.verdict === 'materialized' || o.verdict === 'refuted' ? o.verdict : null
      if (!verdict) continue
      out.push({
        kind: typeof o.kind === 'string' && o.kind ? o.kind : GROUNDING_STALENESS_DOMAIN,
        verdict,
        id: typeof o.id === 'string' ? o.id : '',
        ts: typeof o.ts === 'number' ? o.ts : 0
      })
    } catch {
      continue
    }
  }
  return out
}

export interface StalenessTrust {
  /** flag-precision rate, Beta(1,1)-smoothed like the other calibration domains. */
  rate: number
  /** Wilson 95% lower bound — the conservative retrieval-precision the govern loop should act on. */
  wilson_lo: number
  n: number
  /** true until n >= CAL_MIN_N — not enough evidence to act on yet. */
  gated: boolean
}

/** PURE — the staleness-signal precision (materialized-rate) + Wilson lower bound from outcome records.
 *  Same smoothing + gate as reveal-outcomes.ts / the rest of calibration. null when there are no samples. */
export function groundingStalenessTrust(records: GroundingStalenessOutcome[]): StalenessTrust | null {
  let k = 0
  let n = 0
  for (const r of records) {
    if (r.verdict !== 'materialized' && r.verdict !== 'refuted') continue
    n++
    if (r.verdict === 'materialized') k++
  }
  if (n === 0) return null
  return { rate: (k + 1) / (n + 2), wilson_lo: wilson(k, n)[0] ?? 0, n, gated: n < CAL_MIN_N }
}

/** Direct per-vault read for the govern loop / debug route. null when no samples. */
export function stalenessTrust(vault: string): StalenessTrust | null {
  return groundingStalenessTrust(readGroundingStalenessOutcomes(vault))
}

/** The staleness-fusion trust floor. Down-weighting operator facts as "currency-stale" is only
 *  justified once the staleness signal's MEASURED precision (the grounding-staleness calibration
 *  domain) clears a majority bar. Set BELOW reveal-governance's auto-accept floor (0.8) because
 *  fusion is fail-safe — it down-weights (fact text is retained), it does not silently mutate the
 *  graph — so a strong-majority precision bar is the right gate, not the silent-mutation bar. */
export const STALENESS_TRUST_FLOOR = 0.7

/** PURE — should the LIVE grounding path apply staleness down-weighting on this vault? Mirrors
 *  reveal-governance.shouldAutoAccept: an under-sampled (gated) or absent signal NEVER fuses (cold
 *  start grounds with the full operator block), and a well-sampled signal fuses only once its Wilson
 *  lower-bound precision clears the floor. This is what makes the grounding-staleness calibration
 *  domain LOAD-BEARING on the real grounding decision — fail-safe: an unproven signal suppresses
 *  nothing, so a valid operator preference is never buried on weak evidence. */
export function shouldFuseStaleness(
  trust: StalenessTrust | null,
  floor = STALENESS_TRUST_FLOOR
): boolean {
  if (!trust || trust.gated) return false
  return trust.wilson_lo >= floor
}
