// realistic-store.ts — test fixtures whose SHAPE is derived from the live vault, with SYNTHETIC content.
//
// Why this exists: the `verifyPool` data-loss defect was initially assessed as a theoretical risk, and
// the live store said otherwise. The six candidates it asks a model to echo back VERBATIM measure
// 83/112/81/162/111/109 characters — long sentences, under exact normalized matching. Fixtures built
// from short toy strings ("Operator uses VSCode") make that class of bug look survivable; fixtures built
// to the real length distribution make it look inevitable. Toy fixtures are how a destructive path
// passes its tests and still eats real data.
//
// Measured 2026-07-19 from %APPDATA%/DUIN/operator-model.json (52 facts) and the Sample-brain vault
// (979 notes; .duin/_state/claim-ledger.jsonl = 1183 rows, 212 retired):
//   - fact length: min 19, median 38, max 280 (the store's own cap is 300 — real data crowds it)
//   - distribution: 37 under 50 chars, 5 at 50-100, 7 at 100-200, 3 over 200
//   - the CANDIDATE pool specifically (what verifyPool prunes): 83, 112, 81, 162, 111, 109
//   - 1 fact contains quotes or newlines; 0 contain CJK in this store, though the vault is bilingual,
//     so CJK is included below as a deliberate stressor rather than an observed frequency
//   - claim ledger: 18 keys per row, 212/1183 retired (validTo set), 0 with lastUsefulAt
//     (DUIN_CLAIM_REINFORCE has never run on this machine)
//
// CONTENT IS SYNTHETIC BY DESIGN. These are the operator's real private facts' *shape*, never their
// text: fixtures get committed, and a test file is a bad place to leak someone's second brain.

/** Sentence-length synthetic facts matching the live CANDIDATE pool's character lengths exactly.
 *  Use these anywhere a model is asked to echo, match, or preserve candidate text. */
export const REALISTIC_CANDIDATES: string[] = [
  'Operator prefers release notes grouped by workstream rather than chronologically', // 79
  'Operator asks for the failure mode stated before the fix when reviewing a defect report', // 87
  'Operator treats an unverified claim as unusable regardless of how confident it sounds', // 85
  'Operator wants cost and rollback stated explicitly before approving any migration that touches live data', // 105
  'Operator reviews partner commitments against the release calendar before agreeing to a date', // 92
  'Operator expects a correction to name what was wrong, not only what the new answer is' // 85
]

/** The full observed length distribution — 37 short, 5 medium, 7 long, 3 very long. Use when a test
 *  needs a store that behaves like the real one under caps, truncation, or serialization. */
export function realisticFacts(n = 52): { fact: string; kind: string }[] {
  const out: { fact: string; kind: string }[] = []
  const pad = (base: string, target: number): string =>
    base.length >= target ? base.slice(0, target) : base + ' ' + 'and the same holds for adjacent work'.repeat(Math.ceil(target / 36)).slice(0, target - base.length - 1)
  for (let i = 0; i < n; i++) {
    const r = i / n
    const target = r < 0.71 ? 19 + (i % 30) : r < 0.81 ? 50 + (i % 50) : r < 0.94 ? 100 + (i % 100) : 200 + (i % 80)
    out.push({ fact: pad(`Operator fact ${i} about an ongoing workstream`, target), kind: 'context' })
  }
  return out
}

/** Deliberate stressors for anything that round-trips, matches, or persists fact text. Each is a real
 *  shape present in or adjacent to the live data, and each has broken something in this codebase's
 *  history: exact-match pruning, JSON round-trips, normalization, and length caps. */
export const EDGE_CASE_FACTS: { label: string; fact: string }[] = [
  { label: 'quotes + newline (1 such row live)', fact: 'Operator said "ship it" then added:\nonly after the partner sign-off' },
  { label: 'CJK (vault is bilingual)', fact: '负责人希望发行节点确认后再对外释放版本信息' },
  { label: 'mixed CJK + latin', fact: 'Operator tracks 项目 release gates in English but reviews 发行 docs in Chinese' },
  { label: 'at the 300-char store cap', fact: 'Operator '.padEnd(300, 'x') },
  { label: 'one char over the cap (must be rejected)', fact: 'Operator '.padEnd(301, 'x') },
  { label: 'leading/trailing whitespace', fact: '   Operator prefers concise confirmations   ' },
  { label: 'markdown that a model may reformat', fact: 'Operator wants **bold** headers and `code` spans preserved verbatim' },
  { label: 'json-significant characters', fact: 'Operator uses {curly} and [square] brackets in note titles, e.g. {2026-07} plan' }
]

/** Model replies that a destructive path must survive. The seed defect (`verifyPool`) hard-deleted the
 *  entire candidate pool on several of these. Any code that deletes based on a model reply should be
 *  tested against ALL of them, not just the well-formed case. */
export const HOSTILE_MODEL_REPLIES: { label: string; content: string }[] = [
  { label: 'empty string', content: '' },
  { label: 'empty JSON array', content: '[]' },
  { label: 'refusal prose', content: 'I cannot help with that request.' },
  { label: 'unterminated JSON (truncated mid-reply)', content: '["Operator prefers release notes grouped by works' },
  { label: 'fenced but empty', content: '```json\n[]\n```' },
  { label: 'prose wrapper around valid JSON', content: 'Sure! Here you go:\n["a"]\nLet me know if you need more.' },
  { label: 'paraphrase — approves everything but echoes nothing verbatim', content: '["Likes grouped release notes","States failure modes first"]' },
  { label: 'reordered + reworded', content: '["operator prefers RELEASE NOTES grouped by workstream"]' },
  { label: 'a single unrelated string', content: '["unrelated"]' },
  { label: 'null literal', content: 'null' },
  { label: 'object instead of array', content: '{"keep":["a"]}' }
]
