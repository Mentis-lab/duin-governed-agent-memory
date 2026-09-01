// decision-outcomes-native — the READER for .duin/_state/decision-outcomes.jsonl.
//
// Phase 2 of the judgment loop-closure: decision verdicts (right/wrong/partial/unobserved)
// were captured + stored + exported by decision-verdict-native.ts but had ZERO consumers in
// production — the decision-quality loop was open (graded, never applied). This closes it by
// folding the operator's decision track record into grounding, so how the operator's past
// calls actually turned out shapes how their judgment is weighted on the next turn.
//
// It also delivers the deferred Phase 0.4 dedup: the writer is append-only with a date-only
// `ts` (parity-locked to the Python routine + a golden test), so dedup belongs HERE, where the
// data is read. The ledger's append order IS chronological, so the LAST row per id is the
// current verdict — compaction = latest-per-id by file order. PURE read; no clock, no writes.
import { readFileSync } from 'fs'
import { join } from 'path'

export interface DecisionOutcomeRow {
  ts: string
  id: string
  title: string
  surfaced_by: string
  reversibility: string
  review_on: string
  verdict: string
  note: string
}

export interface DecisionTrackRecord {
  total: number
  right: number
  wrong: number
  partial: number
  unobserved: number
  /** right + wrong + partial — decisions with a substantive outcome (excludes unobserved). */
  graded: number
  /** A few decisions for context (compaction order). */
  recent: { title: string; verdict: string }[]
}

const VALID = new Set(['right', 'wrong', 'partial', 'unobserved'])

/** Load + COMPACT the ledger: latest row per id wins. Append-only + date-only ts means file
 *  order is chronological, so the last occurrence of an id is its current verdict. Malformed
 *  lines and rows with an unknown verdict are skipped. Returns compacted rows in first-seen order. */
export function loadDecisionOutcomes(vaultDir: string | null): DecisionOutcomeRow[] {
  if (!vaultDir) return []
  let text: string
  try {
    text = readFileSync(join(vaultDir, '.duin', '_state', 'decision-outcomes.jsonl'), 'utf-8')
  } catch {
    return []
  }
  const byId = new Map<string, DecisionOutcomeRow>()
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(s) as Record<string, unknown>
    } catch {
      continue
    }
    const id = typeof row.id === 'string' ? row.id : ''
    const verdict = typeof row.verdict === 'string' ? row.verdict.trim().toLowerCase() : ''
    if (!id || !VALID.has(verdict)) continue
    // A later line for the same id overwrites the earlier one (latest-per-id); the Map keeps
    // the key's first-seen position, which is fine for a compacted summary.
    byId.set(id, {
      ts: String(row.ts ?? ''),
      id,
      title: typeof row.title === 'string' && row.title.trim() ? row.title : id,
      surfaced_by: String(row.surfaced_by ?? ''),
      reversibility: String(row.reversibility ?? ''),
      review_on: String(row.review_on ?? ''),
      verdict,
      note: String(row.note ?? '')
    })
  }
  return [...byId.values()]
}

/** Aggregate the compacted ledger into a track record. */
export function decisionTrackRecord(vaultDir: string | null): DecisionTrackRecord {
  const rows = loadDecisionOutcomes(vaultDir)
  const rec: DecisionTrackRecord = { total: rows.length, right: 0, wrong: 0, partial: 0, unobserved: 0, graded: 0, recent: [] }
  for (const r of rows) {
    if (r.verdict === 'right') rec.right++
    else if (r.verdict === 'wrong') rec.wrong++
    else if (r.verdict === 'partial') rec.partial++
    else if (r.verdict === 'unobserved') rec.unobserved++
  }
  rec.graded = rec.right + rec.wrong + rec.partial
  rec.recent = rows
    .filter((r) => r.verdict !== 'unobserved')
    .slice(-3)
    .reverse()
    .map((r) => ({ title: r.title, verdict: r.verdict }))
  return rec
}

/** Compact grounding block — the operator's decision track record. Empty when nothing is graded
 *  yet, so the prompt is byte-identical when there is no signal. A prompt string (not UI copy). */
export function renderDecisionTrackRecord(rec: DecisionTrackRecord): string {
  if (rec.graded === 0) return ''
  const parts = [`${rec.right} right`, `${rec.wrong} wrong`]
  if (rec.partial) parts.push(`${rec.partial} partial`)
  const recent = rec.recent.length
    ? ' Recent: ' + rec.recent.map((r) => `"${r.title}" (${r.verdict})`).join(', ') + '.'
    : ''
  return (
    `OPERATOR DECISION TRACK RECORD — of ${rec.graded} resolved decisions: ${parts.join(', ')}.` +
    recent +
    ' Weight the operator\'s judgment accordingly: a strong record on a topic warrants more deference, a wrong-heavy one more scrutiny.'
  )
}
