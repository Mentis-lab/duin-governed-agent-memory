// binding-ledger — FINISH (self-evolution Move 3, WS3.1+WS3.2): the recurrence→bind closing arrow,
// the legacy-harness binding-ledger analog. learn-native.reflect() SURFACES a binding_candidate when a
// correction theme recurs ≥MIN_BIND; today it is surfaced but never bound. This is the bind step:
// on HUMAN-CONFIRM (the /state/bind-candidate route — nothing auto-binds), a candidate becomes a
// durable rule row carrying a FALSIFIABLE earned-autonomy guarantee ("this theme will not recur").
// A later correction whose tokens overlap the bound theme FAILS that guarantee (checkRecurrence) —
// the objective held-out test that keeps the bind honest. Reversible (revertBinding).
//
// PURE — no I/O, no clock; callers pass `now`. Text-rule only: this ledger RECORDS + FALSIFIES; it
// does NOT auto-apply the rule to grounding (that stays a separate, gated step — WS3.3 + beyond).

export interface BindingPrediction {
  claim: string
  openedAt: number
  status: 'open' | 'failed'
  failedAt?: number
}

export interface BindingRow {
  id: string
  theme: string[]
  rule: string
  members: number
  boundAt: number
  prediction: BindingPrediction
  reverted: number | null
}

/** Deterministic id from theme + seed — no Date.now/Math.random, so it is reproducible + testable. */
function bindingId(theme: string[], now: number, idSeed?: string): string {
  const base = idSeed ?? `${[...theme].sort().join('-')}-${now}`
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `bind-${slug || String(now)}`
}

/** Mint a binding row from a HUMAN-CONFIRMED candidate + the rule text. Opens a falsifiable
 *  "won't recur" prediction (the earned-autonomy guarantee). PURE. */
export function bindCandidate(
  candidate: { theme: string[]; count: number; sample: string },
  rule: string,
  now: number,
  idSeed?: string
): BindingRow {
  const theme = [...(candidate.theme ?? [])].filter((t): t is string => typeof t === 'string' && t.length > 0)
  return {
    id: bindingId(theme, now, idSeed),
    theme,
    rule: (rule ?? '').trim(),
    members: typeof candidate.count === 'number' ? candidate.count : theme.length,
    boundAt: now,
    prediction: { claim: 'this theme will not recur', openedAt: now, status: 'open' },
    reverted: null
  }
}

/** How many of the binding's theme tokens appear in a new correction's tokens. */
function themeOverlap(theme: string[], correctionTokens: Set<string>): number {
  let n = 0
  for (const t of theme) if (correctionTokens.has(t)) n++
  return n
}

/** The held-out test: a new correction whose tokens overlap an OPEN binding's theme by ≥2 tokens
 *  FAILS that binding's guarantee (the bound failure-class recurred). Skips reverted + already-
 *  failed rows. Mutates in place; returns the rows newly marked failed. PURE. */
export function checkRecurrence(bindings: BindingRow[], correctionTokens: Set<string>, now: number): BindingRow[] {
  const failed: BindingRow[] = []
  for (const b of bindings) {
    if (b.reverted !== null || b.prediction.status !== 'open') continue
    if (themeOverlap(b.theme, correctionTokens) >= 2) {
      b.prediction.status = 'failed'
      b.prediction.failedAt = now
      failed.push(b)
    }
  }
  return failed
}

/** Bridge a correction row to the recurrence test: concatenate the row's judgment fields, tokenize
 *  with the INJECTED tokenizer (pass learn-native's `toks` so tokens match the bound themes), and
 *  run checkRecurrence. Returns the newly-failed bindings. PURE — tokenizer injected, `now` an arg,
 *  no I/O. The caller owns operator-only filtering + persistence. */
export function correctionFailsBindings(
  bindings: BindingRow[],
  row: { why?: string; correction?: string; candidate_rule?: string },
  tokenize: (s: string) => Set<string>,
  now: number
): BindingRow[] {
  const text = [row.why ?? '', row.correction ?? '', row.candidate_rule ?? ''].join(' ')
  return checkRecurrence(bindings, tokenize(text), now)
}

/** Reverse a binding (un-bind): set `reverted`. Returns whether an un-reverted row matched.
 *  Idempotent-safe — a second call on an already-reverted id is a no-op returning false. PURE. */
export function revertBinding(bindings: BindingRow[], id: string, now: number): boolean {
  let hit = false
  for (const b of bindings) {
    if (b.id === id && b.reverted === null) {
      b.reverted = now
      hit = true
    }
  }
  return hit
}
