// output-bound.ts — relevance-ranked truncation (bounded-context, Foundation 2). Instead of a blind
// slice(0, maxChars) that drops the whole tail, keep the chunks most RELEVANT to the current query, in
// document order, within the char budget. This is the small-build primitive for the 6 tool-output
// truncation sites AND the overflow-compressor the whole-prompt context-compiler delegates to.
//
// FAIL-OPEN by construction — every uncertainty falls back to today's exact head-slice, so it can only
// ever IMPROVE a truncation, never regress one:
//   - already under budget            → text untouched
//   - no query / no embedder / throw  → head-slice (byte-identical to today)
//   - single chunk / nothing fits     → head-slice
//
// PURE + electron-free (cosine + an injected EmbedFn, like surprise-gate) so it unit-tests headless.

import { cosine, type EmbedFn } from '../brain/claim-entities'

const TRUNC_TAG = '\n\n[…truncated…]'
const ELIDE_TAG = '\n\n[…]'

/** Head-slice fallback — exactly today's blind truncation. */
export function headSlice(text: string, maxChars: number): string {
  return text.slice(0, maxChars) + TRUNC_TAG
}

/** Split text into coherent chunks for ranking: paragraph blocks (blank-line separated), falling back
 *  to lines when there are no paragraph breaks. Blank chunks dropped. PURE. */
export function chunkText(text: string): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  if (paras.length > 1) return paras
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}

/**
 * Bound `text` to `maxChars` by keeping the chunks most relevant to `query` (cosine over an injected
 * embedder), preserving document order. Fail-open to head-slice on any uncertainty (see file header).
 * Never throws.
 */
export async function boundToBudget(text: string, query: string, maxChars: number, embed: EmbedFn): Promise<string> {
  if (!text || text.length <= maxChars) return text // under budget → untouched
  if (!query || !query.trim()) return headSlice(text, maxChars)
  const chunks = chunkText(text)
  if (chunks.length <= 1) return headSlice(text, maxChars)

  let vecs: number[][]
  try {
    vecs = await embed([query, ...chunks])
  } catch {
    return headSlice(text, maxChars)
  }
  if (!vecs || vecs.length !== chunks.length + 1 || !vecs.every((v) => v && v.length)) {
    return headSlice(text, maxChars) // cold/broken embedder → fallback
  }
  const qv = vecs[0]
  const cv = vecs.slice(1)
  // Rank chunks by query relevance, greedily keep highest-scoring until the budget is full, then emit
  // the kept chunks in ORIGINAL document order (relevance decides membership, not order).
  const scored = chunks.map((c, i) => ({ i, len: c.length, score: cosine(qv, cv[i]) }))
  scored.sort((a, b) => b.score - a.score)
  const keep = new Set<number>()
  let used = 0
  for (const s of scored) {
    if (used + s.len + ELIDE_TAG.length > maxChars) continue // skip a chunk that would overflow; try smaller ones
    keep.add(s.i)
    used += s.len + 2
  }
  if (keep.size === 0) return headSlice(text, maxChars) // nothing fit (all chunks huge) → fallback
  const elided = keep.size < chunks.length
  return chunks.filter((_, i) => keep.has(i)).join('\n\n') + (elided ? ELIDE_TAG : '')
}
