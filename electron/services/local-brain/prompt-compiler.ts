// prompt-compiler.ts — whole-prompt context-compiler (Foundation 2, DUIN judgment loop). Given the
// grounding prompt as an ORDERED list of tiered ContextUnits, assemble it within a token budget:
//   - FLOOR   units are always kept in full, in place (identity, brain grounding, the pinned note).
//   - COMPRESS units are relevance-truncated to the query (delegated to boundToBudget) when over budget.
//   - DROP    units are whole-unit dropped least-relevant-first (cosine to the query) until it fits.
//
// BYTE-PARITY INVARIANT: when nothing is dropped/compressed, the output is byte-identical to the legacy
//   `units.filter(u => u.text).map(u => u.text).join('\n\n')` concat — so flag-on with headroom == today.
//
// FAIL-OPEN by construction — any throw, a cold/empty embedder, or a non-positive budget → the plain
//   in-order join (never worse than today's un-compiled prompt). Never throws.
//
// PURE + electron-free (cosine + boundToBudget + an injected EmbedFn, like output-bound.ts) so it
// unit-tests headless.

import { cosine, type EmbedFn } from '../brain/claim-entities'
import { boundToBudget } from './output-bound'

/** Chars-per-token estimate — matches context-compressor.estimateTokens (`Math.ceil(len/4)`). */
const CHARS_PER_TOKEN = 4

/** Default whole-prompt budget when the caller does not thread a model context window. */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 24_000

export interface ContextUnit {
  kind: string
  /** The block's FULLY-RENDERED form exactly as it appears in the legacy concat (header included).
   *  Empty string = absent block (filtered out of the join). */
  text: string
  tier: 'floor' | 'compress' | 'drop'
}

/** Token estimate over a string — `Math.ceil(len/4)`, the shared house pattern. PURE. */
function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** The legacy concat: present units, original order, joined by a blank line. PURE. */
function plainJoin(units: { text: string }[]): string {
  return units.filter((u) => u.text).map((u) => u.text).join('\n\n')
}

/**
 * Compile `units` into the grounding system string within `budgetTokens`. Byte-identical to the legacy
 * join when under budget (or budget <= 0); otherwise compresses `compress` units and drops the
 * least-relevant `drop` units until it fits. Fail-open to the plain join on any uncertainty. Never throws.
 */
export async function compilePrompt(
  units: ContextUnit[],
  query: string,
  budgetTokens: number,
  embed: EmbedFn
): Promise<string> {
  try {
    const base = plainJoin(units)
    // Under budget (or budget disabled) → the plain in-order join, byte-identical to the legacy concat.
    if (budgetTokens <= 0 || estimateTokens(base) <= budgetTokens) return base

    // Present units only, original order preserved, as a mutable working copy (compress mutates `text`).
    const present = units
      .filter((u) => u.text)
      .map((u) => ({ kind: u.kind, text: u.text, tier: u.tier }))
    const dropUnits = present.filter((u) => u.tier === 'drop')

    // Warm-embedder probe + drop-unit vectors in a single batch: vecs[0] = query, vecs[i+1] = dropUnit i.
    // A throw, an empty result, or an empty query vector ⇒ cold/broken embedder ⇒ FAIL-OPEN to the join.
    let vecs: number[][]
    try {
      vecs = await embed([query, ...dropUnits.map((u) => u.text)])
    } catch {
      return base
    }
    if (!vecs || !vecs.length || !vecs[0] || !vecs[0].length) return base
    const qVec = vecs[0]

    // DROP-FIRST, then COMPRESS (order matters). Freeing budget by dropping whole low-value `drop`
    // units preserves the `compress` units (esp. CONTEXT — the answer material) whenever dropping alone
    // suffices, and makes the compress budget reflect only what actually SURVIVES, never blocks that are
    // about to be dropped (which would over-squeeze CONTEXT against soon-to-be-freed space).

    // Phase 1 — drop whole `drop` units, least-relevant (lowest cosine to the query) first, until the
    // estimate fits or no drop units remain. Survivors keep their original order (present is in order).
    const ranked = dropUnits
      .map((u, i) => ({ u, score: cosine(qVec, vecs[i + 1] ?? []) }))
      .sort((a, b) => a.score - b.score)
    const dropped = new Set<{ text: string }>()
    for (const { u } of ranked) {
      if (estimateTokens(plainJoin(present.filter((p) => !dropped.has(p)))) <= budgetTokens) break
      dropped.add(u)
    }
    const survivors = present.filter((p) => !dropped.has(p))
    // Dropping alone brought us under budget → keep every survivor (incl. CONTEXT) in FULL.
    if (estimateTokens(plainJoin(survivors)) <= budgetTokens) return plainJoin(survivors)

    // Phase 2 — still over budget after dropping every droppable block: relevance-compress the
    // `compress` units (CONTEXT) toward the query, against the budget left over after the SURVIVING
    // units only, so CONTEXT is squeezed by what actually remains — not by already-dropped blocks.
    // boundToBudget keeps the query-relevant chunks within that char budget (fail-open to head-slice).
    const compressUnits = survivors.filter((u) => u.tier === 'compress')
    if (compressUnits.length) {
      const budgetChars = budgetTokens * CHARS_PER_TOKEN
      const nonCompressChars = survivors
        .filter((u) => u.tier !== 'compress')
        .reduce((s, u) => s + u.text.length, 0)
      const sepOverhead = Math.max(0, survivors.length - 1) * 2 // the '\n\n' between blocks
      const perUnit = Math.floor(
        (budgetChars - nonCompressChars - sepOverhead) / compressUnits.length
      )
      // FAIL OPEN when the floor blocks alone have already eaten the budget.
      //
      // perUnit was clamped with Math.max(0, ...), and boundToBudget(text, query, 0)
      // keeps nothing — so the moment the fixed blocks exceeded the budget, the ENTIRE
      // retrieved CONTEXT was deleted. That does not rescue the budget (the floor blocks
      // are what blew it, and they are not compressible), it just silently removes the
      // grounding while still shipping an over-budget prompt.
      //
      // Gated on `> 0` precisely: any positive budget still yields real grounding, so a
      // genuinely tight budget keeps compressing exactly as before. Only the
      // nothing-left-to-give case fails open, and it lets the prompt run long. An
      // over-budget prompt with its context is recoverable; a prompt that quietly lost
      // its grounding looks fine and answers worse.
      if (perUnit > 0) {
        for (const u of compressUnits) {
          u.text = await boundToBudget(u.text, query, perUnit, embed)
        }
      }
    }
    return plainJoin(survivors)
  } catch {
    // Any unexpected throw → today's un-compiled prompt.
    return plainJoin(units)
  }
}
