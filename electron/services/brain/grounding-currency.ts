// grounding-currency.ts — tell the model WHICH of two conflicting notes is current.
//
// THE GAP (measured 2026-09-03 on the STALE benchmark, bench/stale — 4 read failures, all four
// checked by hand). DUIN is BETTER than a naive BM25 baseline at NOTICING that a remembered fact has
// gone stale (state resolution 68.8 vs 50.0, paired 5W-2L) and WORSE at ACTING on it (implicit policy
// adaptation 56.2 vs 72.2, paired 1W-4L). Two distinct causes, about half each:
//
//   (a) GROUNDING is blind to supersession. In 2 of 4 failures the superseding note was retrieved at
//       RANK 1 and the answer still came from the older one. The prompt hands the model both versions
//       flat, with nothing saying which is current, so it is left to infer supersession from prose —
//       and it doesn't. The claim ledger ALREADY knows: those instances carried 13-23 `contradicted`
//       verdicts. The verdict simply never reached the prompt.
//   (b) RETRIEVAL is blind to supersession. In the other 2, the superseding note never entered the
//       top-8 at all, while an older note on the same topic did — ranking scores topical similarity,
//       and a long-winded stale note beats a brief update.
//
// Real failures: recommending a wrist wearable to a user who had said they stopped wearing one
// (superseder at rank 1, ignored); opening with "given what you've described before about the morning
// haze" after the user reported the haze had gone (superseder never retrieved).
//
// THIS MODULE FIXES BOTH, additively and fail-safe:
//   • `supersessionsIn`  — the ledger's retired/contradicted claims whose source note is in play,
//                          paired with the claim that replaced them.
//   • `buildCurrencyBlock` — a short block naming those, appended AFTER the notes. It SUPPRESSES
//                          NOTHING: the stale text stays in context, it is merely labelled. That is
//                          deliberate — a wrong supersession verdict must never be able to hide a
//                          valid statement, only to annotate it. (Same doctrine as the staleness
//                          fusion gate, which down-weights rather than drops.)
//   • `superseders`     — note ids that CARRY the replacement for a stale note already retrieved, so
//                          the caller can co-retrieve the update. Fixes (b) narrowly: it never
//                          reorders general search, it only guarantees that when a stale note is
//                          shown, what replaced it is shown too.
//
// PURE. No I/O, no clock, no model. The caller supplies the ledger.
import type { Claim } from './claim-metabolism'

export interface Supersession {
  /** the statement that is no longer current */
  stale: string
  /** what replaced it, when the ledger names a superseding claim */
  replacement: string | null
  /** note the stale statement came from */
  noteId: string
  /** note the replacement came from, when known */
  replacementNoteId: string | null
}

const statement = (c: Claim): string => `${c.subject} ${c.relation} ${c.object}`.replace(/\s+/g, ' ').trim()

/** A claim is no longer current if the metabolism retired it (validTo set) or judged it contradicted. */
export function isRetired(c: Claim): boolean {
  return c.validTo !== null || c.verdict === 'contradicted' || c.verdict === 'stale'
}

/**
 * Supersessions among `usedNoteIds` — retired claims sourced from a note the prompt is about to show.
 *
 * Operator-authored claims are EXCLUDED: the metabolism treats a deliberately-taught fact as
 * evergreen (claim-metabolism §11), so labelling one "superseded" in the prompt would contradict the
 * rest of the system. Claims with no readable statement are skipped rather than rendered blank.
 */
export function supersessionsIn(usedNoteIds: readonly string[], claims: readonly Claim[]): Supersession[] {
  if (usedNoteIds.length === 0 || claims.length === 0) return []
  const used = new Set(usedNoteIds)
  const byId = new Map(claims.map((c) => [c.id, c]))
  const out: Supersession[] = []
  const seen = new Set<string>()
  for (const c of claims) {
    if (!isRetired(c) || c.operatorAuthored === true) continue
    if (!c.notePath || !used.has(c.notePath)) continue
    const text = statement(c)
    if (!text || seen.has(text)) continue
    seen.add(text)
    const rep = c.supersededBy ? byId.get(c.supersededBy) ?? null : null
    out.push({
      stale: text,
      replacement: rep ? statement(rep) : null,
      noteId: c.notePath,
      replacementNoteId: rep?.notePath ?? null
    })
  }
  return out
}

/**
 * Note ids carrying the REPLACEMENT for a stale claim in a note already being shown, minus the ones
 * already there. The caller co-retrieves these so a stale note is never shown without its update.
 */
export function superseders(usedNoteIds: readonly string[], claims: readonly Claim[]): string[] {
  const used = new Set(usedNoteIds)
  const byId = new Map(claims.map((c) => [c.id, c]))
  const extra: string[] = []
  for (const s of supersessionsIn(usedNoteIds, claims)) {
    const rep = s.replacementNoteId
    if (rep && !used.has(rep) && !extra.includes(rep)) extra.push(rep)
  }
  void byId
  return extra
}

/** Cap so a pathological ledger cannot flood the prompt. */
export const MAX_CURRENCY_LINES = 12

/**
 * The block appended after the notes. Empty string when there is nothing to say — so a vault with no
 * ledger, no construction graph, or no contradictions gets a byte-identical prompt to before.
 */
export function buildCurrencyBlock(items: readonly Supersession[], max = MAX_CURRENCY_LINES): string {
  if (items.length === 0) return ''
  const lines = items.slice(0, max).map((s) =>
    s.replacement
      ? `- NO LONGER CURRENT: "${s.stale}" (${s.noteId}) — superseded by: "${s.replacement}" (${s.replacementNoteId ?? 'later note'})`
      : `- NO LONGER CURRENT: "${s.stale}" (${s.noteId}) — a later note supersedes this`
  )
  const more = items.length > max ? `\n- (${items.length - max} more not shown)` : ''
  return (
    '\n\n=== CURRENCY OF THE ABOVE NOTES ===\n' +
    'These statements appear in the notes above but are NO LONGER CURRENT. Where they conflict with a\n' +
    'newer statement, answer from the newer one and do not act on the superseded version.\n' +
    lines.join('\n') +
    more +
    '\n'
  )
}
