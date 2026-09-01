// aggregation-grading — the grader for the aggregation eval, split out of the probe fixture so the
// grading rules (which are product-neutral) can be unit-tested in the blocking suite without the
// probe set (which is written against one operator's corpus and does not ship).
//
// A grader bug does not announce itself — it silently changes a measurement in someone's favour and
// the run still looks green. Both cases guarded in `aggregation-grading.test.ts` were REAL false
// positives observed on 2026-08-02.

export interface AggContext {
  /** noteId -> full markdown text. The same map handed to the grep/code arms. */
  notes: Record<string, string>
  claims: Record<string, unknown>[]
  turnBeats: Record<string, unknown>[]
  corrections: Record<string, unknown>[]
}

export interface AggProbe {
  id: string
  /** 'agg' needs whole-corpus computation; 'lookup' is a control that any working arm should get. */
  type: 'agg' | 'lookup'
  q: string
  /** 'count' grades on the first integer, exactly. 'text' grades on EXACT match after
   *  normalisation, with a suffix allowance for paths — NOT containment. It was containment until
   *  2026-08-02, which scored a gold folder name as a hit for a DIFFERENT folder whose name merely
   *  contained it; see gradeAnswer. */
  kind: 'count' | 'text'
  gold: (c: AggContext) => number | string
}

/** A reply that echoed the answer TEMPLATE rather than answering. On 2026-08-02 arm D emitted the
 *  literal placeholder in 8 of 15 runs because the prompt said `ANSWER: <the value>` — a harness
 *  bug, not a model failure, and one that made a broken arm look like a confabulating one. These
 *  must be counted as NO-ANSWER, distinct from a wrong answer (property 8: do not collapse "it
 *  didn't answer" into "it answered wrongly"). */
export function isPlaceholder(a: string): boolean {
  return /^<.*>$/.test(a.trim()) || /\bthe value\b/i.test(a) || /^\[.*\]$/.test(a.trim())
}

/** Pull the graded value out of a model reply. The arms are told to end with `ANSWER: …`;
 *  fall back to the last line so a well-formed answer in the wrong shape still scores. */
export function extractAnswer(reply: string): string {
  const m = [...(reply ?? '').matchAll(/ANSWER:\s*(.+)/gi)]
  if (m.length) {
    // take the last NON-placeholder ANSWER line if there is one
    for (let i = m.length - 1; i >= 0; i--) {
      const v = m[i][1].trim()
      if (!isPlaceholder(v)) return v
    }
    return m[m.length - 1][1].trim()
  }
  const lines = (reply ?? '').trim().split('\n').filter((l) => l.trim())
  return lines.length ? lines[lines.length - 1].trim() : ''
}

/** Grade one answer. Counts must match EXACTLY — a near-miss on a count is a wrong answer, and
 *  tolerance here would let a plausible guess score. */
export function gradeAnswer(probe: AggProbe, raw: string, gold: number | string): boolean {
  const a = extractAnswer(raw)
  if (!a || isPlaceholder(a)) return false
  if (probe.kind === 'count') {
    const nums = a.replace(/,/g, '').match(/-?\d+/g)
    if (!nums) return false
    // take the FIRST integer: "277 claims" grades, "about 200 to 300" does not silently pass on 300
    return Number(nums[0]) === Number(gold)
  }
  // TEXT grading is EXACT after normalisation, with one allowance: a note path may be answered
  // with a longer path that ENDS in the gold path (a leading vault prefix is not a wrong answer).
  //
  // It used to be plain substring containment, and that was a false-positive machine: on
  // 2026-08-02 a gold folder name scored 3/3 for an answer naming a DIFFERENT folder whose name
  // contained it — which was the D30 arm's only aggregation win. Substring matching flatters
  // whichever arm emits longer strings, so it silently rewards verbosity rather than correctness.
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[`"'*\s]/g, '')
      .replace(/[.,;:!?]+$/, '')
  const A = norm(a)
  const G = norm(String(gold))
  if (A === G) return true
  if (G.includes('/') && A.endsWith(G)) return true
  return false
}
