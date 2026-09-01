// Native port of resources/brain/server.py :: _sig_tokens (910) + _STOP_TOK (907).
//
// The significant-token set of a string, used for subject-overlap / convergence
// ranking in the futures workstream (§4b). MUST byte-match the Python tokenizer or
// convergence rankings silently reorder. Two token sources, unioned then minus the
// stopword set:
//   - maximal runs of >=4 [a-z0-9] (whole "words", greedy/non-overlapping)
//   - CJK (U+4E00–U+9FFF) runs of >=2 ideographs decomposed into OVERLAPPING 2-char
//     bigrams (CJK has no spaces, so 工美周边 ∩ 工美 must intersect on 工美)
// Pure + reusable leaf — no fs, no side-effects. Golden-locked.

import { CJK_CLASS } from './cjk-tokens'

// CJK runs of >=2. The class is the tokenizer's full CJK set (kanji + KANA), not the bare
// ideograph range — kana bounded a run, so a Japanese subject yielded no bigrams and could
// never converge with another. Additive: every ideograph run that matched before still does.
const CJK_RUN_RE = new RegExp(`[${CJK_CLASS}]{2,}`, 'g')

const STOP_TOK = new Set([
  'task',
  'risk',
  'with',
  'that',
  'this',
  'from',
  'into',
  'biweekly',
  'report',
  'project',
  'delivery'
])

/** Port of _sig_tokens. Returns the significant-token SET (deduped, stopwords removed). */
export function sigTokens(s: string): Set<string> {
  const lower = (s || '').toLowerCase()
  const toks = new Set<string>()
  for (const w of lower.match(/[a-z0-9]{4,}/g) || []) toks.add(w)
  for (const run of lower.match(CJK_RUN_RE) || []) {
    for (let i = 0; i < run.length - 1; i++) toks.add(run.slice(i, i + 2))
  }
  for (const stop of STOP_TOK) toks.delete(stop)
  return toks
}
